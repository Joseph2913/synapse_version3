import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

// Nightly advisory council cron — runs at 2:00 AM UTC.
// Runs the Phase 0 pull-based answer check, rebuilds stale expertise
// indexes, regenerates standing questions/gaps, refreshes awareness
// registers, and updates health.
export const maxDuration = 300;

// ─── ENVIRONMENT ───────────────────────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY!;
const CRON_SECRET = process.env.CRON_SECRET;

const getSupabase = () => createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const GEMINI_CONCURRENCY = 3;

// ─── TYPES ────────────────────────────────────────────────────────────────────

interface Agent {
  id: string;
  user_id: string;
  name: string;
  description: string | null;
  expertise_index: ExpertiseIndex | Record<string, never>;
  reasoning_style: string | null;
  source_count: number;
  entity_count: number;
  last_ingestion_at: string | null;
  last_index_rebuild_at: string | null;
  index_stale: boolean;
  health_status: string;
}

interface ExpertiseIndex {
  summary: string;
  core_themes: string[];
  reasoning_approach: string;
  strongest_areas: Array<{ topic: string; source_count: number; key_entities: string[] }>;
  weakest_areas: Array<{ topic: string; reason: string }>;
  cross_domain_bridges: Array<{
    target_agent_id: string;
    target_agent_name: string;
    bridge_description: string;
    bridge_entity_ids: string[];
  }>;
  generated_at: string;
  source_count_at_generation: number;
  entity_count_at_generation: number;
}

interface PhaseResult {
  phase: string;
  success: boolean;
  detail: string;
  duration_ms: number;
}

// ─── AUTH ──────────────────────────────────────────────────────────────────────

function verifyCronAuth(req: VercelRequest): boolean {
  if (req.headers['x-vercel-signature']) return true;
  if (!CRON_SECRET) return true;
  const auth = req.headers['authorization'];
  return !!(auth && auth === `Bearer ${CRON_SECRET}`);
}

async function verifyUserAuth(
  req: VercelRequest
): Promise<{ userId: string | null; isCron: boolean }> {
  if (verifyCronAuth(req)) return { userId: null, isCron: true };

  const auth = req.headers['authorization'];
  if (auth?.startsWith('Bearer ')) {
    const token = auth.slice(7);
    const supabase = getSupabase();
    try {
      const { data: { user } } = await supabase.auth.getUser(token);
      if (user) return { userId: user.id, isCron: false };
    } catch { /* fall through */ }
  }

  return { userId: null, isCron: false };
}

// ─── GEMINI HELPER ────────────────────────────────────────────────────────────

async function callGemini<T>(
  systemPrompt: string,
  userContent: string,
  timeoutMs = 60000,
  model = 'gemini-2.5-flash'
): Promise<T> {
  const response = await fetch(
    `${GEMINI_BASE}/${model}:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents: [{ parts: [{ text: userContent }] }],
        generationConfig: {
          temperature: 0.1,
          responseMimeType: 'application/json',
        },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    }
  );

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Gemini ${response.status}: ${errText.slice(0, 300)}`);
  }

  const data = await response.json() as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };

  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('No response from Gemini');

  return JSON.parse(text) as T;
}

async function generateEmbedding(text: string): Promise<number[]> {
  const response = await fetch(
    `${GEMINI_BASE}/gemini-embedding-001:embedContent?key=${GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'models/gemini-embedding-001',
        content: { parts: [{ text }] },
      }),
      signal: AbortSignal.timeout(15000),
    }
  );
  if (!response.ok) return [];
  const data = await response.json() as { embedding?: { values?: number[] } };
  return data.embedding?.values ?? [];
}

// ─── CONCURRENCY HELPER ──────────────────────────────────────────────────────

async function runInBatches<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>
): Promise<Array<{ item: T; result?: R; error?: string }>> {
  const results: Array<{ item: T; result?: R; error?: string }> = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const settled = await Promise.allSettled(batch.map(fn));
    for (let j = 0; j < batch.length; j++) {
      const outcome = settled[j]!;
      if (outcome.status === 'fulfilled') {
        results.push({ item: batch[j]!, result: outcome.value });
      } else {
        results.push({ item: batch[j]!, error: String(outcome.reason) });
      }
    }
  }
  return results;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 0: PULL-BASED ANSWER CHECK + NOVEL-CONNECTION WRITER
// ═══════════════════════════════════════════════════════════════════════════════

// Phase 0 local types. Kept inline to honour the "no shared local imports in
// api/ files" rule.
type QuestionVerdictValue = 'answered' | 'partially_addressed' | 'no_real_answer';

interface AddressingEvidenceEntry {
  source_id: string | null;
  verdict: QuestionVerdictValue | 'legacy';
  snippet: string;
  confidence: number | null;
  checked_at: string | null;
  legacy?: boolean;
}

interface PullCandidateRow {
  question_id: string;
  question_text: string;
  question_type: 'gap_driven' | 'frontier' | 'cross_domain' | 'user_defined';
  question_status: 'open' | 'partially_addressed';
  existing_addressing_source_ids: string[] | null;
  source_id: string;
  chunk_id: string;
  chunk_content: string;
  similarity: number;
  source_primary_agent_ids: string[] | null;
}

interface VerdictNovelConnection {
  bridge_claim?: string;
}

interface VerdictResponse {
  question_id: string;
  verdict: QuestionVerdictValue;
  primary_source_id: string | null;
  snippet: string;
  confidence: number | null;
  novel_connection?: VerdictNovelConnection;
}

interface Phase0Counters {
  agents_scanned: number;
  questions_checked: number;
  questions_answered: number;
  questions_partially_addressed: number;
  novel_connections_written: number;
  gemini_calls: number;
}

interface Phase0AgentLite {
  id: string;
  user_id: string;
  name: string;
  description: string | null;
  expertise_index: ExpertiseIndex | Record<string, never> | null;
}

interface NovelInsightRow {
  user_id: string;
  agent_id: string;
  insight_type: 'novel_connection';
  claim: string;
  evidence_summary: string;
  trigger_source_id: string;
  related_source_ids: string[];
  related_entity_ids: string[];
  confidence: number;
  status: 'active';
}

interface BulkUpdateRow {
  question_id: string;
  new_source_ids: string[];
  evidence_entries: AddressingEvidenceEntry[];
  new_status: QuestionVerdictValue | null;
}

function emptyPhase0Counters(): Phase0Counters {
  return {
    agents_scanned: 0,
    questions_checked: 0,
    questions_answered: 0,
    questions_partially_addressed: 0,
    novel_connections_written: 0,
    gemini_calls: 0,
  };
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

function groupPullCandidatesByQuestion(rows: PullCandidateRow[]): Map<string, PullCandidateRow[]> {
  const map = new Map<string, PullCandidateRow[]>();
  for (const r of rows) {
    const arr = map.get(r.question_id) ?? [];
    arr.push(r);
    map.set(r.question_id, arr);
  }
  return map;
}

function pickPrimaryRow(
  group: PullCandidateRow[],
  primarySourceId: string | null
): PullCandidateRow | null {
  if (group.length === 0) return null;
  if (primarySourceId) {
    const matches = group.filter(r => r.source_id === primarySourceId);
    if (matches.length > 0) {
      return matches.reduce((best, r) => (r.similarity > best.similarity ? r : best), matches[0]!);
    }
  }
  return group.reduce((best, r) => (r.similarity > best.similarity ? r : best), group[0]!);
}

async function resolveSinceForUser(supabase: SupabaseClient, userId: string): Promise<string> {
  const { data } = await supabase
    .from('council_cron_runs')
    .select('started_at')
    .eq('user_id', userId)
    .in('status', ['ok', 'partial_failure'])
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (data && (data as { started_at: string }).started_at) {
    return (data as { started_at: string }).started_at;
  }
  // Fallback: 2 days ago
  return new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
}

async function gemini_judgeQuestionAnswers(
  agent: Phase0AgentLite,
  batch: PullCandidateRow[][]
): Promise<VerdictResponse[]> {
  const expertise = agent.expertise_index as ExpertiseIndex | null;
  const coreThemes = expertise && 'core_themes' in expertise && Array.isArray(expertise.core_themes)
    ? (expertise.core_themes as string[]).join(', ')
    : '(not yet indexed)';

  const systemPrompt = `You are judging whether new source content answers a set of standing questions for a domain expert agent.

Agent: ${agent.name}
Agent focus: ${agent.description ?? ''}
Agent core themes: ${coreThemes}

For each question, you are given top-matching chunks from sources newly added to this user's knowledge graph. Some of these sources are outside this agent's primary domain — treat them as potential cross-domain connections.

Return strict JSON matching this schema — no prose, no code fences:
{
  "verdicts": [
    {
      "question_id": "<uuid>",
      "verdict": "answered" | "partially_addressed" | "no_real_answer",
      "primary_source_id": "<uuid of the most relevant chunk's source, or null>",
      "snippet": "<=280 chars quote or paraphrase showing why, or empty>",
      "confidence": <0.0 to 1.0>,
      "novel_connection": {
        "bridge_claim": "<one sentence explaining how this source connects to the agent's domain, or empty string if not a bridge>"
      }
    }
  ]
}

Rules:
- "answered" only if the source directly resolves the question. Be conservative.
- "partially_addressed" if it gives meaningful evidence toward the question but leaves gaps.
- "no_real_answer" if the chunks merely mention related topics without answering.
- bridge_claim: fill only when the source comes from a domain that is not obviously this agent's — it's the cross-domain insight. Otherwise leave empty.`;

  const payload = batch.map(group => {
    const first = group[0]!;
    return {
      question_id: first.question_id,
      question_text: first.question_text,
      chunks: group.map(row => ({
        source_id: row.source_id,
        similarity: Number(row.similarity?.toFixed?.(3) ?? row.similarity),
        content: (row.chunk_content ?? '').slice(0, 600),
      })),
    };
  });

  const userContent = JSON.stringify({ questions: payload });

  const result = await callGemini<{ verdicts: VerdictResponse[] }>(systemPrompt, userContent);
  return Array.isArray(result?.verdicts) ? result.verdicts : [];
}

async function phase0_answerCheckAndLink(
  supabase: SupabaseClient
): Promise<{
  result: PhaseResult;
  perUserCounters: Map<string, Phase0Counters>;
  runIds: Map<string, string>;
}> {
  const phaseStart = Date.now();
  const perUserCounters = new Map<string, Phase0Counters>();
  const runIds = new Map<string, string>();

  // 1. Fetch all agents (multi-tenant).
  const { data: agentsRaw, error: agErr } = await supabase
    .from('domain_agents')
    .select('id, user_id, name, description, expertise_index');

  if (agErr) {
    return {
      result: { phase: '0_answer_check', success: false, detail: agErr.message, duration_ms: Date.now() - phaseStart },
      perUserCounters,
      runIds,
    };
  }
  const agents = (agentsRaw ?? []) as Phase0AgentLite[];
  if (agents.length === 0) {
    return {
      result: { phase: '0_answer_check', success: true, detail: '0 agents', duration_ms: Date.now() - phaseStart },
      perUserCounters,
      runIds,
    };
  }

  // 2. Identify distinct users and open a council_cron_runs row per user.
  const userIds = Array.from(new Set(agents.map(a => a.user_id)));
  const sinceByUser = new Map<string, string>();
  for (const userId of userIds) {
    perUserCounters.set(userId, emptyPhase0Counters());
    sinceByUser.set(userId, await resolveSinceForUser(supabase, userId));
    const { data: runRow, error: runErr } = await supabase
      .from('council_cron_runs')
      .insert({ user_id: userId, status: 'running', phase_counts: {} })
      .select('id')
      .maybeSingle();
    if (runErr) {
      console.warn(`[council-cron] phase0: failed to create run row for user ${userId}:`, runErr.message);
      continue;
    }
    if (runRow && (runRow as { id: string }).id) {
      runIds.set(userId, (runRow as { id: string }).id);
    }
  }

  // 3. Iterate agents sequentially (Gemini rate limits).
  let perAgentFailures = 0;

  for (const agent of agents) {
    const counters = perUserCounters.get(agent.user_id)!;
    const sinceIso = sinceByUser.get(agent.user_id)!;

    try {
      counters.agents_scanned += 1;

      const { data: candidates, error: rpcErr } = await supabase.rpc('get_council_pull_candidates', {
        p_user_id: agent.user_id,
        p_agent_id: agent.id,
        p_since: sinceIso,
        p_similarity_threshold: 0.55,
        p_top_k: 3,
      });

      if (rpcErr) {
        console.warn(`[council-cron] phase0: pull candidates failed for agent ${agent.id}:`, rpcErr.message);
        perAgentFailures++;
        continue;
      }

      const rows = (candidates ?? []) as PullCandidateRow[];
      if (rows.length === 0) continue;

      const byQuestion = groupPullCandidatesByQuestion(rows);
      counters.questions_checked += byQuestion.size;

      const questionGroups = Array.from(byQuestion.values());
      const batches = chunkArray(questionGroups, 30);

      const allVerdicts: VerdictResponse[] = [];
      for (const batch of batches) {
        try {
          const verdicts = await gemini_judgeQuestionAnswers(agent, batch);
          counters.gemini_calls += 1;
          allVerdicts.push(...verdicts);
        } catch (gErr) {
          const msg = gErr instanceof Error ? gErr.message : String(gErr);
          console.warn(`[council-cron] phase0: Gemini batch failed for agent ${agent.id}:`, msg);
        }
      }

      const updates: BulkUpdateRow[] = [];
      const novelInsights: NovelInsightRow[] = [];
      const nowIso = new Date().toISOString();

      for (const verdict of allVerdicts) {
        if (!verdict || verdict.verdict === 'no_real_answer') continue;
        const group = byQuestion.get(verdict.question_id);
        if (!group || group.length === 0) continue;

        const primaryRow = pickPrimaryRow(group, verdict.primary_source_id);
        if (!primaryRow) continue;

        const snippet = (verdict.snippet ?? '').slice(0, 280);
        const confidence = typeof verdict.confidence === 'number' ? verdict.confidence : null;

        updates.push({
          question_id: verdict.question_id,
          new_source_ids: [primaryRow.source_id],
          evidence_entries: [{
            source_id: primaryRow.source_id,
            verdict: verdict.verdict,
            snippet,
            confidence,
            checked_at: nowIso,
          }],
          new_status: verdict.verdict,
        });

        if (verdict.verdict === 'answered') counters.questions_answered += 1;
        else counters.questions_partially_addressed += 1;

        const primaryAgentIds = primaryRow.source_primary_agent_ids ?? [];
        const bridgeClaim = verdict.novel_connection?.bridge_claim?.trim() ?? '';
        if (!primaryAgentIds.includes(agent.id) && bridgeClaim) {
          novelInsights.push({
            user_id: agent.user_id,
            agent_id: agent.id,
            insight_type: 'novel_connection',
            claim: bridgeClaim,
            evidence_summary: snippet,
            trigger_source_id: primaryRow.source_id,
            related_source_ids: [primaryRow.source_id],
            related_entity_ids: [],
            confidence: confidence ?? 0.5,
            status: 'active',
          });
          counters.novel_connections_written += 1;
        }
      }

      if (updates.length > 0) {
        const { error: applyErr } = await supabase.rpc('bulk_apply_question_addressing', {
          p_user_id: agent.user_id,
          p_updates: updates,
        });
        if (applyErr) {
          console.warn(`[council-cron] phase0: bulk_apply_question_addressing failed for agent ${agent.id}:`, applyErr.message);
          perAgentFailures++;
        }
      }

      if (novelInsights.length > 0) {
        const { error: insErr } = await supabase.from('agent_insights').insert(novelInsights);
        if (insErr) {
          console.warn(`[council-cron] phase0: novel_connection insert failed for agent ${agent.id}:`, insErr.message);
          perAgentFailures++;
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[council-cron] phase0: agent ${agent.id} failed:`, msg);
      perAgentFailures++;
    }
  }

  // Aggregate totals for the phase detail line.
  let totalAnswered = 0;
  let totalPartial = 0;
  let totalNovel = 0;
  let totalChecked = 0;
  let totalGemini = 0;
  for (const c of perUserCounters.values()) {
    totalAnswered += c.questions_answered;
    totalPartial += c.questions_partially_addressed;
    totalNovel += c.novel_connections_written;
    totalChecked += c.questions_checked;
    totalGemini += c.gemini_calls;
  }

  return {
    result: {
      phase: '0_answer_check',
      success: perAgentFailures === 0,
      detail: `${agents.length} agents, ${totalChecked} questions checked, ${totalAnswered} answered, ${totalPartial} partial, ${totalNovel} novel connections, ${totalGemini} Gemini calls${perAgentFailures > 0 ? `, ${perAgentFailures} agent failures` : ''}`,
      duration_ms: Date.now() - phaseStart,
    },
    perUserCounters,
    runIds,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 2: REBUILD STALE EXPERTISE INDEXES
// ═══════════════════════════════════════════════════════════════════════════════

async function phase2_rebuildExpertise(supabase: SupabaseClient): Promise<{ result: PhaseResult; rebuiltAgentIds: string[] }> {
  const phaseStart = Date.now();
  const rebuiltAgentIds: string[] = [];

  const { data: staleAgents, error: agErr } = await supabase
    .from('domain_agents')
    .select('id, user_id, name, description, expertise_index, reasoning_style')
    .eq('index_stale', true);

  if (agErr) {
    return {
      result: { phase: '2_expertise', success: false, detail: agErr.message, duration_ms: Date.now() - phaseStart },
      rebuiltAgentIds,
    };
  }
  if (!staleAgents || staleAgents.length === 0) {
    return {
      result: { phase: '2_expertise', success: true, detail: '0 stale agents', duration_ms: Date.now() - phaseStart },
      rebuiltAgentIds,
    };
  }

  // Get all agents for cross-domain bridge awareness
  const { data: allAgents } = await supabase
    .from('domain_agents')
    .select('id, name');
  const agentNameMap = new Map((allAgents ?? []).map(a => [(a as { id: string; name: string }).id, (a as { id: string; name: string }).name]));

  const results = await runInBatches(staleAgents as Agent[], GEMINI_CONCURRENCY, async (agent) => {
    // Get source IDs
    const { data: sources } = await supabase
      .from('domain_agent_sources')
      .select('source_id')
      .eq('agent_id', agent.id);

    const sourceIds = (sources ?? []).map(s => (s as { source_id: string }).source_id);
    if (sourceIds.length === 0) return 'no_sources';

    // Get entities (top 200 by confidence)
    const { data: entities } = await supabase
      .from('knowledge_nodes')
      .select('label, entity_type, description, confidence')
      .in('source_id', sourceIds)
      .eq('user_id', agent.user_id)
      .order('confidence', { ascending: false })
      .limit(200);

    // Get source metadata (titles + summaries)
    const { data: sourceMeta } = await supabase
      .from('knowledge_sources')
      .select('title, summary, source_type')
      .in('id', sourceIds)
      .limit(50);

    // Representative chunks (recent, by entity density)
    const { data: recentSources } = await supabase
      .from('knowledge_sources')
      .select('id')
      .in('id', sourceIds)
      .order('created_at', { ascending: false })
      .limit(10);

    const recentSourceIds = (recentSources ?? []).map(s => (s as { id: string }).id);
    let chunks: Array<{ content: string }> = [];
    if (recentSourceIds.length > 0) {
      const { data: chunkData } = await supabase
        .from('source_chunks')
        .select('content')
        .in('source_id', recentSourceIds)
        .eq('user_id', agent.user_id)
        .limit(30);
      chunks = (chunkData ?? []) as Array<{ content: string }>;
    }

    const otherAgents = Array.from(agentNameMap.entries())
      .filter(([id]) => id !== agent.id)
      .map(([id, name]) => ({ id, name }));

    const entityCount = entities?.length ?? 0;

    const systemPrompt = `You are an AI that generates structured expertise indexes for domain-specific knowledge agents.
Given a set of entities, source metadata, and representative content chunks, produce a JSON expertise index.

The output MUST conform to this exact JSON schema:
{
  "summary": "One paragraph overview of what this domain covers",
  "core_themes": ["array of 3-8 core themes"],
  "reasoning_approach": "How this domain reasons — extracted from content style",
  "strongest_areas": [
    { "topic": "string", "source_count": number, "key_entities": ["entity labels"] }
  ],
  "weakest_areas": [
    { "topic": "string", "reason": "string" }
  ],
  "cross_domain_bridges": [
    { "target_agent_id": "uuid", "target_agent_name": "string", "bridge_description": "string", "bridge_entity_ids": [] }
  ],
  "description": "A 2-3 sentence description of this advisor's domain expertise",
  "reasoning_style": "A sentence describing how this advisor reasons and approaches problems"
}

For cross_domain_bridges, identify which of the other agents listed might share conceptual overlap.
For strongest_areas, estimate source_count based on how many sources seem to cover each topic.
For weakest_areas, identify topics that seem underrepresented given the domain's scope.`;

    const userContent = `Domain: ${agent.name}
Previous description: ${agent.description ?? 'None'}

Sources (${sourceIds.length} total):
${(sourceMeta ?? []).map(s => `- ${(s as { title: string }).title} (${(s as { source_type: string }).source_type})`).join('\n')}

Top entities (${entityCount} total):
${(entities ?? []).slice(0, 100).map(e => `- ${(e as { label: string }).label} [${(e as { entity_type: string }).entity_type}]${(e as { description: string | null }).description ? ': ' + ((e as { description: string }).description).slice(0, 80) : ''}`).join('\n')}

Representative content chunks:
${chunks.slice(0, 15).map(c => c.content.slice(0, 300)).join('\n---\n')}

Other agents in the system:
${otherAgents.map(a => `- ${a.name} (ID: ${a.id})`).join('\n')}`;

    const result = await callGemini<ExpertiseIndex & { description?: string; reasoning_style?: string }>(
      systemPrompt,
      userContent,
      120000
    );

    const expertiseIndex: ExpertiseIndex = {
      summary: result.summary || '',
      core_themes: result.core_themes || [],
      reasoning_approach: result.reasoning_approach || '',
      strongest_areas: result.strongest_areas || [],
      weakest_areas: result.weakest_areas || [],
      cross_domain_bridges: result.cross_domain_bridges || [],
      generated_at: new Date().toISOString(),
      source_count_at_generation: sourceIds.length,
      entity_count_at_generation: entityCount,
    };

    await supabase
      .from('domain_agents')
      .update({
        expertise_index: expertiseIndex,
        description: result.description || expertiseIndex.summary,
        reasoning_style: result.reasoning_style || expertiseIndex.reasoning_approach,
        source_count: sourceIds.length,
        entity_count: entityCount,
        last_index_rebuild_at: new Date().toISOString(),
        index_stale: false,
        updated_at: new Date().toISOString(),
      })
      .eq('id', agent.id);

    rebuiltAgentIds.push(agent.id);
    return 'ok';
  });

  const succeeded = results.filter(r => r.result === 'ok').length;
  const noSources = results.filter(r => r.result === 'no_sources').length;
  const failedCount = results.filter(r => r.error).length;

  return {
    result: {
      phase: '2_expertise',
      success: failedCount === 0,
      detail: `${succeeded} rebuilt, ${noSources} skipped (no sources), ${failedCount} failed`,
      duration_ms: Date.now() - phaseStart,
    },
    rebuiltAgentIds,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 3: REGENERATE STANDING QUESTIONS AND GAPS
// ═══════════════════════════════════════════════════════════════════════════════

async function phase3_regenerateQuestionsAndGaps(
  supabase: SupabaseClient,
  rebuiltAgentIds: string[]
): Promise<PhaseResult> {
  const phaseStart = Date.now();

  if (rebuiltAgentIds.length === 0) {
    return { phase: '3_questions_gaps', success: true, detail: 'No agents rebuilt — skipped', duration_ms: Date.now() - phaseStart };
  }

  const { data: agents, error: agErr } = await supabase
    .from('domain_agents')
    .select('id, user_id, name, expertise_index')
    .in('id', rebuiltAgentIds);

  if (agErr) {
    return { phase: '3_questions_gaps', success: false, detail: agErr.message, duration_ms: Date.now() - phaseStart };
  }
  if (!agents || agents.length === 0) {
    return { phase: '3_questions_gaps', success: true, detail: 'No agents found', duration_ms: Date.now() - phaseStart };
  }

  const results = await runInBatches(agents as Agent[], GEMINI_CONCURRENCY, async (agent) => {
    const expertise = agent.expertise_index as ExpertiseIndex;
    if (!expertise?.summary) return 'skipped';

    // Get existing questions (need to preserve user_defined ones)
    const { data: existingQuestions } = await supabase
      .from('agent_standing_questions')
      .select('id, question_type, status')
      .eq('agent_id', agent.id);

    const existing = (existingQuestions ?? []) as Array<{ id: string; question_type: string; status: string }>;

    // Archive old gap_driven/frontier open questions that may be stale
    const toArchive = existing
      .filter(q => (q.question_type === 'gap_driven' || q.question_type === 'frontier') && q.status === 'open')
      .map(q => q.id);

    if (toArchive.length > 0) {
      await supabase
        .from('agent_standing_questions')
        .update({ status: 'dismissed', status_changed_at: new Date().toISOString() })
        .in('id', toArchive);
    }

    // Get existing gaps to resolve stale ones
    const { data: existingGaps } = await supabase
      .from('agent_gaps')
      .select('id')
      .eq('agent_id', agent.id)
      .eq('status', 'active');

    const systemPrompt = `You are an AI that generates research questions and knowledge gaps for a domain-specific advisor.
Given an updated expertise index, produce fresh standing questions and gaps.

Output JSON:
{
  "standing_questions": [
    {
      "question": "The research question",
      "question_type": "gap_driven | frontier",
      "priority": 1-10,
      "trigger_description": "Why this question matters for this domain"
    }
  ],
  "gaps": [
    {
      "gap_type": "structural | orphan | recency",
      "topic": "The gap topic",
      "description": "What's missing and why it matters",
      "severity": "minor | moderate | significant",
      "content_suggestion": "What kind of content would fill this gap"
    }
  ],
  "resolved_gap_topics": ["topics from existing gaps that the expertise index now covers adequately"]
}

Generate 3-6 questions and 2-5 gaps. Be specific to the domain's current state.
Question types: gap_driven (from weak areas), frontier (cutting edge of domain knowledge).
Gap types: structural (expected knowledge absent), orphan (isolated entities), recency (stale topics).`;

    const userContent = `Domain: ${agent.name}\n\nExpertise Index:\n${JSON.stringify(expertise, null, 2)}`;

    const result = await callGemini<{
      standing_questions: Array<{ question: string; question_type: string; priority: number; trigger_description: string }>;
      gaps: Array<{ gap_type: string; topic: string; description: string; severity: string; content_suggestion: string }>;
      resolved_gap_topics: string[];
    }>(systemPrompt, userContent);

    // Insert new questions. Embed each one so Phase 0 can match them against new
    // source chunks on subsequent runs. Embedding is best-effort: on failure the
    // question still inserts (with NULL embedding) and simply skips pull matching.
    if (result.standing_questions?.length > 0) {
      const qRows: Array<Record<string, unknown>> = [];
      for (const q of result.standing_questions) {
        const emb = await generateEmbedding(q.question);
        qRows.push({
          user_id: agent.user_id,
          agent_id: agent.id,
          question: q.question,
          question_type: q.question_type,
          priority: q.priority,
          trigger_description: q.trigger_description,
          status: 'open',
          generated_at: new Date().toISOString(),
          embedding: emb.length > 0 ? JSON.stringify(emb) : null,
        });
      }
      await supabase.from('agent_standing_questions').insert(qRows);
    }

    // Resolve gaps whose topics are now covered
    if (result.resolved_gap_topics?.length > 0 && existingGaps && existingGaps.length > 0) {
      // Mark all active gaps as resolved (Gemini determines which topics are covered)
      const gapIds = (existingGaps as Array<{ id: string }>).map(g => g.id);
      await supabase
        .from('agent_gaps')
        .update({ status: 'resolved', updated_at: new Date().toISOString() })
        .in('id', gapIds);
    }

    // Insert new gaps
    if (result.gaps?.length > 0) {
      const gRows = result.gaps.map(g => ({
        user_id: agent.user_id,
        agent_id: agent.id,
        gap_type: g.gap_type,
        topic: g.topic,
        description: g.description,
        severity: g.severity,
        content_suggestion: g.content_suggestion,
        status: 'active',
      }));
      await supabase.from('agent_gaps').insert(gRows);
    }

    return 'ok';
  });

  const succeeded = results.filter(r => r.result === 'ok').length;
  const failedCount = results.filter(r => r.error).length;

  return {
    phase: '3_questions_gaps',
    success: failedCount === 0,
    detail: `${succeeded} agents updated, ${failedCount} failed`,
    duration_ms: Date.now() - phaseStart,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 4: REFRESH AWARENESS REGISTERS
// ═══════════════════════════════════════════════════════════════════════════════

async function phase4_refreshAwareness(
  supabase: SupabaseClient,
  rebuiltAgentIds: string[]
): Promise<PhaseResult> {
  const phaseStart = Date.now();

  if (rebuiltAgentIds.length === 0) {
    return { phase: '4_awareness', success: true, detail: 'No agents rebuilt — skipped', duration_ms: Date.now() - phaseStart };
  }

  // When any agent's expertise changes, ALL agents need updated awareness registers
  const { data: allAgents, error: agErr } = await supabase
    .from('domain_agents')
    .select('id, user_id, name, expertise_index')
    .not('expertise_index', 'eq', '{}');

  if (agErr) {
    return { phase: '4_awareness', success: false, detail: agErr.message, duration_ms: Date.now() - phaseStart };
  }
  if (!allAgents || allAgents.length === 0) {
    return { phase: '4_awareness', success: true, detail: 'No agents with indexes', duration_ms: Date.now() - phaseStart };
  }

  const agents = allAgents as Agent[];
  const agentSummaries = agents.map(a => {
    const exp = a.expertise_index as ExpertiseIndex;
    return { id: a.id, name: a.name, summary: exp?.summary ?? '', core_themes: exp?.core_themes ?? [] };
  });

  const results = await runInBatches(agents, GEMINI_CONCURRENCY, async (agent) => {
    const siblings = agentSummaries.filter(a => a.id !== agent.id);
    const exp = agent.expertise_index as ExpertiseIndex;

    const systemPrompt = `You are an AI that generates an awareness register for a domain-specific advisor.
This advisor needs to know what its sibling advisors cover, so it can recognise when content might be relevant to another domain.

Output JSON:
{
  "awareness": [
    {
      "sibling_agent_id": "uuid",
      "sibling_name": "string",
      "relevance_summary": "1-2 sentences on what this sibling covers that might overlap",
      "watch_topics": ["topics from the sibling to watch for"]
    }
  ]
}`;

    const userContent = `This advisor: ${agent.name}
Summary: ${exp?.summary ?? ''}
Themes: ${(exp?.core_themes ?? []).join(', ')}

Sibling advisors:
${siblings.map(s => `- ${s.name} (ID: ${s.id})\n  Themes: ${s.core_themes.slice(0, 5).join(', ')}`).join('\n')}`;

    const result = await callGemini<{
      awareness: Array<{
        sibling_agent_id: string;
        sibling_name: string;
        relevance_summary: string;
        watch_topics: string[];
      }>;
    }>(systemPrompt, userContent);

    await supabase
      .from('domain_agents')
      .update({ awareness_register: result.awareness, updated_at: new Date().toISOString() })
      .eq('id', agent.id);

    return 'ok';
  });

  const succeeded = results.filter(r => r.result === 'ok').length;
  const failedCount = results.filter(r => r.error).length;

  return {
    phase: '4_awareness',
    success: failedCount === 0,
    detail: `${succeeded}/${agents.length} registers updated, ${failedCount} failed`,
    duration_ms: Date.now() - phaseStart,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 5: UPDATE HEALTH STATUSES
// ═══════════════════════════════════════════════════════════════════════════════

async function phase5_updateHealth(supabase: SupabaseClient): Promise<PhaseResult> {
  const phaseStart = Date.now();

  const { data: agents, error: agErr } = await supabase
    .from('domain_agents')
    .select('id, user_id, expertise_index, source_count, last_ingestion_at, last_index_rebuild_at, health_status, index_stale');

  if (agErr) {
    return { phase: '5_health', success: false, detail: agErr.message, duration_ms: Date.now() - phaseStart };
  }
  if (!agents || agents.length === 0) {
    return { phase: '5_health', success: true, detail: 'No agents', duration_ms: Date.now() - phaseStart };
  }

  const now = Date.now();
  const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
  const FOURTEEN_DAYS = 14 * 24 * 60 * 60 * 1000;
  const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;

  let updated = 0;

  for (const agent of agents as Agent[]) {
    const expertise = agent.expertise_index as ExpertiseIndex | Record<string, never>;
    const hasExpertise = expertise && 'summary' in expertise && !!expertise.summary;
    const sourceCount = agent.source_count ?? 0;
    const lastIngestion = agent.last_ingestion_at ? new Date(agent.last_ingestion_at).getTime() : 0;
    const lastRebuild = agent.last_index_rebuild_at ? new Date(agent.last_index_rebuild_at).getTime() : 0;

    // Count significant gaps for "strong" evaluation
    const { count: significantGaps } = await supabase
      .from('agent_gaps')
      .select('id', { count: 'exact', head: true })
      .eq('agent_id', agent.id)
      .eq('status', 'active')
      .eq('severity', 'significant');

    // Refresh denormalised counts first — the stored source_count may be stale/zero
    const { count: freshSourceCount } = await supabase
      .from('domain_agent_sources')
      .select('id', { count: 'exact', head: true })
      .eq('agent_id', agent.id);

    const { count: entityCount } = await supabase
      .from('knowledge_nodes')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', agent.user_id)
      .in('source_id',
        await supabase
          .from('domain_agent_sources')
          .select('source_id')
          .eq('agent_id', agent.id)
          .then(r => ((r.data ?? []) as Array<{ source_id: string }>).map(d => d.source_id))
      );

    const actualSourceCount = freshSourceCount ?? sourceCount;

    let newHealth: string;

    if (!hasExpertise) {
      newHealth = 'initialising';
      // Re-flag for rebuild if stuck in Init with sources assigned
      if (actualSourceCount > 0 && !agent.index_stale) {
        await supabase
          .from('domain_agents')
          .update({ index_stale: true })
          .eq('id', agent.id);
      }
    } else if ((lastIngestion > 0 && now - lastIngestion > THIRTY_DAYS) || (lastRebuild > 0 && now - lastRebuild > FOURTEEN_DAYS)) {
      newHealth = 'stale';
    } else if (actualSourceCount > 15 && (significantGaps ?? 0) <= 1) {
      newHealth = 'strong';
    } else if (actualSourceCount >= 5 || (actualSourceCount > 15 && lastRebuild > 0 && now - lastRebuild < SEVEN_DAYS)) {
      newHealth = 'growing';
    } else {
      newHealth = 'thin';
    }

    await supabase
      .from('domain_agents')
      .update({
        health_status: newHealth,
        source_count: actualSourceCount,
        entity_count: entityCount ?? 0,
        updated_at: new Date().toISOString(),
      })
      .eq('id', agent.id);

    updated++;
  }

  return {
    phase: '5_health',
    success: true,
    detail: `${updated} agents health updated`,
    duration_ms: Date.now() - phaseStart,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// HANDLER
// ═══════════════════════════════════════════════════════════════════════════════

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const { isCron, userId } = await verifyUserAuth(req);
  if (!isCron && !userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const startTime = Date.now();
  const supabase = getSupabase();
  const phaseResults: PhaseResult[] = [];

  console.log('[council-cron] Starting nightly advisory council cron');

  // Phase 0: Pull-based answer check + novel-connection insights.
  // Opens a council_cron_runs row per user; finalised at the end of the handler.
  let phase0PerUserCounters = new Map<string, Phase0Counters>();
  let phase0RunIds = new Map<string, string>();
  let phase0Duration = 0;
  try {
    const p0 = await phase0_answerCheckAndLink(supabase);
    phaseResults.push(p0.result);
    phase0PerUserCounters = p0.perUserCounters;
    phase0RunIds = p0.runIds;
    phase0Duration = p0.result.duration_ms;
    console.log(`[council-cron] Phase 0 complete: ${p0.result.detail} (${p0.result.duration_ms}ms)`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[council-cron] Phase 0 failed:', msg);
    phaseResults.push({ phase: '0_answer_check', success: false, detail: msg, duration_ms: Date.now() - startTime });
  }

  // Phase 1 (signal processing) retired — agent_signals table removed.

  // Phase 2: Rebuild stale expertise indexes
  let rebuiltAgentIds: string[] = [];
  try {
    const p2 = await phase2_rebuildExpertise(supabase);
    phaseResults.push(p2.result);
    rebuiltAgentIds = p2.rebuiltAgentIds;
    console.log(`[council-cron] Phase 2 complete: ${p2.result.detail} (${p2.result.duration_ms}ms)`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[council-cron] Phase 2 failed:', msg);
    phaseResults.push({ phase: '2_expertise', success: false, detail: msg, duration_ms: Date.now() - startTime });
  }

  // Phase 3: Regenerate standing questions and gaps
  try {
    const p3 = await phase3_regenerateQuestionsAndGaps(supabase, rebuiltAgentIds);
    phaseResults.push(p3);
    console.log(`[council-cron] Phase 3 complete: ${p3.detail} (${p3.duration_ms}ms)`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[council-cron] Phase 3 failed:', msg);
    phaseResults.push({ phase: '3_questions_gaps', success: false, detail: msg, duration_ms: Date.now() - startTime });
  }

  // Phase 4: Refresh awareness registers
  try {
    const p4 = await phase4_refreshAwareness(supabase, rebuiltAgentIds);
    phaseResults.push(p4);
    console.log(`[council-cron] Phase 4 complete: ${p4.detail} (${p4.duration_ms}ms)`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[council-cron] Phase 4 failed:', msg);
    phaseResults.push({ phase: '4_awareness', success: false, detail: msg, duration_ms: Date.now() - startTime });
  }

  // Phase 5: Update health statuses
  try {
    const p5 = await phase5_updateHealth(supabase);
    phaseResults.push(p5);
    console.log(`[council-cron] Phase 5 complete: ${p5.detail} (${p5.duration_ms}ms)`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[council-cron] Phase 5 failed:', msg);
    phaseResults.push({ phase: '5_health', success: false, detail: msg, duration_ms: Date.now() - startTime });
  }

  // Phase 6: Detect demand gaps from MCP query logs (fire-and-forget)
  try {
    const appUrl = process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : 'http://localhost:3000';

    fetch(`${appUrl}/api/council/detect-demand-gaps`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${CRON_SECRET ?? ''}`,
      },
      body: JSON.stringify({ lookbackHours: 24 }),
    }).catch(err => {
      console.warn('[council-cron] Demand gap detection trigger failed (non-fatal):', err);
    });
    console.log('[council-cron] Phase 6: demand gap detection triggered (fire-and-forget)');
  } catch {
    // Non-fatal
  }

  const totalDuration = Date.now() - startTime;
  const allSuccess = phaseResults.every(p => p.success);

  // Finalise per-user council_cron_runs rows created in Phase 0. One row per
  // user; phase_counts.phase0 carries that user's Phase 0 counters.
  const finishedAtIso = new Date().toISOString();
  const runStatus: 'ok' | 'partial_failure' = allSuccess ? 'ok' : 'partial_failure';
  const errorSummary = allSuccess
    ? null
    : phaseResults.filter(p => !p.success).map(p => `${p.phase}: ${p.detail}`).join('\n');

  for (const [userId, runId] of phase0RunIds.entries()) {
    const counters = phase0PerUserCounters.get(userId) ?? emptyPhase0Counters();
    const phaseCounts = {
      phase0: {
        agents_scanned: counters.agents_scanned,
        questions_checked: counters.questions_checked,
        questions_answered: counters.questions_answered,
        questions_partially_addressed: counters.questions_partially_addressed,
        novel_connections_written: counters.novel_connections_written,
        gemini_calls: counters.gemini_calls,
        duration_ms: phase0Duration,
      },
    };
    const { error: updErr } = await supabase
      .from('council_cron_runs')
      .update({
        finished_at: finishedAtIso,
        status: runStatus,
        phase_counts: phaseCounts,
        error: errorSummary,
      })
      .eq('id', runId);
    if (updErr) {
      console.warn(`[council-cron] Failed to finalise council_cron_runs row ${runId}:`, updErr.message);
    }
  }

  console.log(`[council-cron] Complete in ${totalDuration}ms — ${allSuccess ? 'ALL PASSED' : 'SOME FAILED'}`);

  return res.status(200).json({
    success: allSuccess,
    duration_ms: totalDuration,
    phases: phaseResults,
  });
}
