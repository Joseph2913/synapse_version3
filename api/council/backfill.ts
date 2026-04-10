import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

// Allow up to 300s (Vercel Pro max) — backfill touches all playlists + Gemini calls
export const maxDuration = 300;

// ─── ENVIRONMENT ───────────────────────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY!;
const CRON_SECRET = process.env.CRON_SECRET;

const getSupabase = () => createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const GEMINI_CONCURRENCY = 3;

// ─── TYPES ─────────────────────────────────────────────────────────────────────

interface Playlist {
  id: string;
  user_id: string;
  playlist_id: string;
  playlist_name: string | null;
  linked_anchor_ids: string[] | null;
  domain_agent_id: string | null;
}

interface DomainAgent {
  id: string;
  user_id: string;
  playlist_id: string;
  name: string;
  linked_anchor_ids: string[];
  source_count: number;
  entity_count: number;
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

interface StandingQuestion {
  question: string;
  question_type: 'gap_driven' | 'frontier' | 'cross_domain' | 'user_defined';
  priority: number;
  trigger_description: string;
}

interface Gap {
  gap_type: 'structural' | 'orphan' | 'recency';
  topic: string;
  description: string;
  severity: 'minor' | 'moderate' | 'significant';
  content_suggestion: string;
}

interface Insight {
  insight_type: 'tension' | 'convergence' | 'novel_connection';
  claim: string;
  evidence_summary: string;
  confidence: number;
}

interface StepResult {
  step: string;
  success: boolean;
  detail: string;
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

// ─── GEMINI HELPER ─────────────────────────────────────────────────────────────

async function callGemini<T>(systemPrompt: string, userContent: string, timeoutMs = 120000, model = 'gemini-2.0-flash'): Promise<T> {
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
    if (response.status === 429) {
      throw new Error(`RATE_LIMITED: Gemini rate limit hit`);
    }
    throw new Error(`Gemini call failed: ${response.status} ${errText.slice(0, 300)}`);
  }

  const data = await response.json() as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };

  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('No response from Gemini');

  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Invalid JSON from Gemini: ${text.slice(0, 300)}`);
  }
}

// ─── CONCURRENCY HELPER ───────────────────────────────────────────────────────

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

// ─── STEP 1: CREATE DOMAIN AGENTS ─────────────────────────────────────────────

async function step1_createAgents(supabase: SupabaseClient): Promise<StepResult> {
  // Fetch all playlists
  const { data: playlists, error: plErr } = await supabase
    .from('youtube_playlists')
    .select('id, user_id, playlist_id, playlist_name, linked_anchor_ids, domain_agent_id');

  if (plErr) return { step: '1_create_agents', success: false, detail: plErr.message };
  if (!playlists || playlists.length === 0) {
    return { step: '1_create_agents', success: true, detail: 'No playlists found' };
  }

  let created = 0;
  let skipped = 0;

  for (const pl of playlists as Playlist[]) {
    // Idempotency: skip if this playlist already has a domain agent
    if (pl.domain_agent_id) {
      skipped++;
      continue;
    }

    // Also check if a domain_agents row already exists for this playlist (edge case: agent exists but playlist not linked back)
    const { data: existing } = await supabase
      .from('domain_agents')
      .select('id')
      .eq('user_id', pl.user_id)
      .eq('playlist_id', pl.id)
      .maybeSingle();

    if (existing) {
      // Link back to playlist
      await supabase
        .from('youtube_playlists')
        .update({ domain_agent_id: existing.id })
        .eq('id', pl.id);
      skipped++;
      continue;
    }

    // Create new domain agent
    const { data: agent, error: agErr } = await supabase
      .from('domain_agents')
      .insert({
        user_id: pl.user_id,
        playlist_id: pl.id,
        name: pl.playlist_name || `Playlist ${pl.playlist_id}`,
        linked_anchor_ids: pl.linked_anchor_ids || [],
        health_status: 'initialising',
      })
      .select('id')
      .single();

    if (agErr) {
      return { step: '1_create_agents', success: false, detail: `Failed for playlist ${pl.id}: ${agErr.message}` };
    }

    // Link back to playlist
    await supabase
      .from('youtube_playlists')
      .update({ domain_agent_id: agent.id })
      .eq('id', pl.id);

    created++;
  }

  return { step: '1_create_agents', success: true, detail: `Created ${created}, skipped ${skipped} (already existed)` };
}

// ─── STEP 2: POPULATE DOMAIN AGENT SOURCES ────────────────────────────────────

async function step2_populateSources(supabase: SupabaseClient): Promise<StepResult> {
  // Get all agents with their playlist IDs
  const { data: agents, error: agErr } = await supabase
    .from('domain_agents')
    .select('id, user_id, playlist_id');

  if (agErr) return { step: '2_populate_sources', success: false, detail: agErr.message };
  if (!agents || agents.length === 0) {
    return { step: '2_populate_sources', success: true, detail: 'No agents found' };
  }

  let totalInserted = 0;
  let totalSkipped = 0;

  for (const agent of agents) {
    // Find all completed videos for this playlist with a source_id
    const { data: queueItems, error: qErr } = await supabase
      .from('youtube_ingestion_queue')
      .select('source_id')
      .eq('playlist_id', agent.playlist_id)
      .eq('status', 'completed')
      .not('source_id', 'is', null);

    if (qErr) {
      return { step: '2_populate_sources', success: false, detail: `Queue query failed for agent ${agent.id}: ${qErr.message}` };
    }

    if (!queueItems || queueItems.length === 0) continue;

    // Deduplicate source_ids
    const sourceIds = Array.from(new Set(queueItems.map(q => q.source_id as string)));

    // Build upsert rows
    const rows = sourceIds.map(sid => ({
      user_id: agent.user_id,
      agent_id: agent.id,
      source_id: sid,
      association_type: 'primary',
    }));

    // Upsert with conflict on (agent_id, source_id) — idempotent
    const { data: inserted, error: insErr } = await supabase
      .from('domain_agent_sources')
      .upsert(rows, { onConflict: 'agent_id,source_id', ignoreDuplicates: true })
      .select('id');

    if (insErr) {
      return { step: '2_populate_sources', success: false, detail: `Insert failed for agent ${agent.id}: ${insErr.message}` };
    }

    totalInserted += inserted?.length || 0;
    // Count skipped = sourceIds attempted minus actually inserted
    // (ignoreDuplicates means we can't distinguish, so just report totals)
  }

  return { step: '2_populate_sources', success: true, detail: `Processed ${agents.length} agents, upserted ${totalInserted} source associations` };
}

// ─── STEP 3: GENERATE EXPERTISE INDEXES ───────────────────────────────────────

async function step3_generateExpertise(supabase: SupabaseClient): Promise<StepResult> {
  // Get all agents that need expertise indexes (index_stale = true or expertise_index is empty)
  const { data: agents, error: agErr } = await supabase
    .from('domain_agents')
    .select('id, user_id, playlist_id, name, linked_anchor_ids');

  if (agErr) return { step: '3_expertise_indexes', success: false, detail: agErr.message };
  if (!agents || agents.length === 0) {
    return { step: '3_expertise_indexes', success: true, detail: 'No agents found' };
  }

  // Build a name lookup for cross_domain_bridges
  const agentNameMap = new Map<string, string>();
  for (const a of agents) {
    agentNameMap.set(a.id, a.name);
  }

  const results = await runInBatches(agents, GEMINI_CONCURRENCY, async (agent) => {
    // Get source IDs for this agent
    const { data: sources } = await supabase
      .from('domain_agent_sources')
      .select('source_id')
      .eq('agent_id', agent.id);

    const sourceIds = (sources || []).map(s => s.source_id as string);
    if (sourceIds.length === 0) return 'no_sources';

    // Get entities for these sources (top 200 by confidence)
    const { data: entities } = await supabase
      .from('knowledge_nodes')
      .select('label, entity_type, description, confidence')
      .in('source_id', sourceIds)
      .eq('user_id', agent.user_id)
      .order('confidence', { ascending: false })
      .limit(200);

    // Get a sample of source titles/summaries for context
    const { data: sourceMeta } = await supabase
      .from('knowledge_sources')
      .select('title, summary, source_type')
      .in('id', sourceIds)
      .limit(50);

    // Other agents info for cross-domain bridge awareness
    const otherAgents = agents
      .filter(a => a.id !== agent.id)
      .map(a => ({ id: a.id, name: a.name }));

    const entityCount = entities?.length || 0;

    const systemPrompt = `You are an AI that generates structured expertise indexes for domain-specific knowledge agents.
Given a set of entities and source metadata from a knowledge domain, produce a JSON expertise index.

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

For cross_domain_bridges, identify which of the other agents listed might share conceptual overlap based on entity types and themes. Use their exact IDs and names. Leave bridge_entity_ids empty for now (will be populated later).

For strongest_areas, estimate source_count based on how many sources seem to cover each topic.
For weakest_areas, identify topics that seem underrepresented given the domain's scope.`;

    const userContent = `Domain: ${agent.name}

Sources (${sourceIds.length} total):
${(sourceMeta || []).map(s => `- ${s.title} (${s.source_type})${s.summary ? ': ' + s.summary.slice(0, 150) : ''}`).join('\n')}

Top entities (${entityCount} total):
${(entities || []).slice(0, 100).map(e => `- ${e.label} [${e.entity_type}]${e.description ? ': ' + e.description.slice(0, 80) : ''}`).join('\n')}

Other agents in the system:
${otherAgents.map(a => `- ${a.name} (ID: ${a.id})`).join('\n')}`;

    const result = await callGemini<ExpertiseIndex & { description?: string; reasoning_style?: string }>(
      systemPrompt,
      userContent
    );

    // Construct the canonical expertise index
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

    // Update the agent
    const { error: upErr } = await supabase
      .from('domain_agents')
      .update({
        expertise_index: expertiseIndex,
        description: result.description || expertiseIndex.summary,
        reasoning_style: result.reasoning_style || expertiseIndex.reasoning_approach,
        source_count: sourceIds.length,
        entity_count: entityCount,
        last_index_rebuild_at: new Date().toISOString(),
        index_stale: false,
      })
      .eq('id', agent.id);

    if (upErr) throw new Error(`Update failed: ${upErr.message}`);
    return 'ok';
  });

  const succeeded = results.filter(r => r.result === 'ok').length;
  const noSources = results.filter(r => r.result === 'no_sources').length;
  const failed = results.filter(r => r.error).length;

  return {
    step: '3_expertise_indexes',
    success: failed === 0,
    detail: `${succeeded} generated, ${noSources} skipped (no sources), ${failed} failed${failed > 0 ? ': ' + results.filter(r => r.error).map(r => r.error).join('; ') : ''}`,
  };
}

// ─── STEP 4: GENERATE STANDING QUESTIONS + GAPS ───────────────────────────────

async function step4_generateQuestionsAndGaps(supabase: SupabaseClient): Promise<StepResult> {
  // Get agents that have expertise indexes
  const { data: agents, error: agErr } = await supabase
    .from('domain_agents')
    .select('id, user_id, name, expertise_index')
    .not('expertise_index', 'eq', '{}');

  if (agErr) return { step: '4_questions_gaps', success: false, detail: agErr.message };
  if (!agents || agents.length === 0) {
    return { step: '4_questions_gaps', success: true, detail: 'No agents with expertise indexes' };
  }

  const results = await runInBatches(agents, GEMINI_CONCURRENCY, async (agent) => {
    const expertise = agent.expertise_index as ExpertiseIndex;
    if (!expertise?.summary) return 'skipped';

    // Idempotency: check if this agent already has standing questions
    const { count: existingQCount } = await supabase
      .from('agent_standing_questions')
      .select('id', { count: 'exact', head: true })
      .eq('agent_id', agent.id);

    const { count: existingGCount } = await supabase
      .from('agent_gaps')
      .select('id', { count: 'exact', head: true })
      .eq('agent_id', agent.id);

    if ((existingQCount || 0) > 0 && (existingGCount || 0) > 0) {
      return 'already_exists';
    }

    const systemPrompt = `You are an AI that generates research questions and knowledge gaps for a domain-specific advisor.
Given an expertise index, produce:
1. Standing questions (3-6) the advisor should actively seek answers to
2. Knowledge gaps (2-5) representing areas where the domain's coverage is thin

Output JSON:
{
  "standing_questions": [
    {
      "question": "The research question",
      "question_type": "gap_driven" | "frontier",
      "priority": 1-10,
      "trigger_description": "Why this question matters for this domain"
    }
  ],
  "gaps": [
    {
      "gap_type": "structural" | "orphan" | "recency",
      "topic": "The gap topic",
      "description": "What's missing and why it matters",
      "severity": "minor" | "moderate" | "significant",
      "content_suggestion": "What kind of content would fill this gap"
    }
  ]
}

Question types:
- gap_driven: Questions arising from identified weak areas or missing knowledge
- frontier: Questions at the cutting edge of what this domain knows

Gap types:
- structural: Expected knowledge that's entirely absent
- orphan: Isolated entities with few connections
- recency: Topics that haven't been updated recently`;

    const userContent = `Domain: ${agent.name}

Expertise Index:
${JSON.stringify(expertise, null, 2)}`;

    const result = await callGemini<{
      standing_questions: StandingQuestion[];
      gaps: Gap[];
    }>(systemPrompt, userContent);

    // Insert standing questions (only if none exist yet)
    if ((existingQCount || 0) === 0 && result.standing_questions?.length > 0) {
      const qRows = result.standing_questions.map(q => ({
        user_id: agent.user_id,
        agent_id: agent.id,
        question: q.question,
        question_type: q.question_type,
        priority: q.priority,
        trigger_description: q.trigger_description,
        status: 'open',
        generated_at: new Date().toISOString(),
      }));

      const { error: qErr } = await supabase
        .from('agent_standing_questions')
        .insert(qRows);

      if (qErr) throw new Error(`Questions insert failed: ${qErr.message}`);
    }

    // Insert gaps (only if none exist yet)
    if ((existingGCount || 0) === 0 && result.gaps?.length > 0) {
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

      const { error: gErr } = await supabase
        .from('agent_gaps')
        .insert(gRows);

      if (gErr) throw new Error(`Gaps insert failed: ${gErr.message}`);
    }

    return 'ok';
  });

  const succeeded = results.filter(r => r.result === 'ok').length;
  const skipped = results.filter(r => r.result === 'skipped' || r.result === 'already_exists').length;
  const failed = results.filter(r => r.error).length;

  return {
    step: '4_questions_gaps',
    success: failed === 0,
    detail: `${succeeded} generated, ${skipped} skipped, ${failed} failed`,
  };
}

// ─── STEP 5: GENERATE AWARENESS REGISTERS ─────────────────────────────────────

async function step5_generateAwareness(supabase: SupabaseClient): Promise<StepResult> {
  const { data: agents, error: agErr } = await supabase
    .from('domain_agents')
    .select('id, user_id, name, expertise_index')
    .not('expertise_index', 'eq', '{}');

  if (agErr) return { step: '5_awareness', success: false, detail: agErr.message };
  if (!agents || agents.length === 0) {
    return { step: '5_awareness', success: true, detail: 'No agents with expertise indexes' };
  }

  // One Gemini call per agent — each produces only its own awareness register
  const agentSummaries = agents.map(a => {
    const exp = a.expertise_index as ExpertiseIndex;
    return {
      id: a.id,
      name: a.name,
      summary: exp?.summary || '',
      core_themes: exp?.core_themes || [],
    };
  });

  const results = await runInBatches(agents, GEMINI_CONCURRENCY, async (agent) => {
    const siblings = agentSummaries.filter(a => a.id !== agent.id);
    const exp = agent.expertise_index as ExpertiseIndex;

    const systemPrompt = `You are an AI that generates an awareness register for a domain-specific advisor.
This advisor needs to know what its SIBLING advisors cover, so it can recognise when incoming content might be relevant to another domain.

Given this advisor's expertise and a list of sibling advisors, produce an awareness register — a condensed map of what each sibling knows, from this advisor's perspective.

Output JSON:
{
  "awareness": [
    {
      "sibling_agent_id": "uuid",
      "sibling_name": "string",
      "relevance_summary": "1-2 sentences on what this sibling covers that might overlap or complement this advisor's domain",
      "watch_topics": ["topics from the sibling that this advisor should pay attention to"]
    }
  ]
}`;

    const userContent = `This advisor: ${agent.name}
Summary: ${exp?.summary || ''}
Themes: ${(exp?.core_themes || []).join(', ')}

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

    const { error: upErr } = await supabase
      .from('domain_agents')
      .update({ awareness_register: result.awareness })
      .eq('id', agent.id);

    if (upErr) throw new Error(`Update failed: ${upErr.message}`);
    return 'ok';
  });

  const succeeded = results.filter(r => r.result === 'ok').length;
  const failed = results.filter(r => r.error).length;

  return {
    step: '5_awareness',
    success: failed === 0,
    detail: `Updated ${succeeded}/${agents.length} awareness registers${failed > 0 ? ', ' + failed + ' failed' : ''}`,
  };
}

// ─── STEP 6: DETECT CROSS-DOMAIN SIGNALS ──────────────────────────────────────

async function step6_detectSignals(supabase: SupabaseClient): Promise<StepResult> {
  // Get all agents
  const { data: agents, error: agErr } = await supabase
    .from('domain_agents')
    .select('id, user_id');

  if (agErr) return { step: '6_signals', success: false, detail: agErr.message };
  if (!agents || agents.length === 0) {
    return { step: '6_signals', success: true, detail: 'No agents found' };
  }

  const userId = agents[0]!.user_id;

  // Build a map: node_id → set of agent_ids
  // We do this by joining domain_agent_sources → knowledge_nodes (via source_id)
  // Fetch all agent-source mappings
  const { data: agentSources, error: asErr } = await supabase
    .from('domain_agent_sources')
    .select('agent_id, source_id');

  if (asErr) return { step: '6_signals', success: false, detail: `Agent sources query: ${asErr.message}` };
  if (!agentSources || agentSources.length === 0) {
    return { step: '6_signals', success: true, detail: 'No agent-source mappings' };
  }

  // Build source_id → agent_ids map
  const sourceToAgents = new Map<string, Set<string>>();
  for (const as of agentSources) {
    const sid = as.source_id as string;
    if (!sourceToAgents.has(sid)) sourceToAgents.set(sid, new Set());
    sourceToAgents.get(sid)!.add(as.agent_id as string);
  }

  const allSourceIds = Array.from(sourceToAgents.keys());

  // Fetch all nodes that belong to agent sources, in batches of 500
  // We need node_id → source_id mapping
  const nodeToAgents = new Map<string, Set<string>>();
  for (let i = 0; i < allSourceIds.length; i += 500) {
    const batch = allSourceIds.slice(i, i + 500);
    const { data: nodes } = await supabase
      .from('knowledge_nodes')
      .select('id, source_id')
      .in('source_id', batch)
      .eq('user_id', userId)
      .limit(10000);

    for (const node of nodes || []) {
      const agents = sourceToAgents.get(node.source_id as string);
      if (agents) {
        if (!nodeToAgents.has(node.id)) nodeToAgents.set(node.id, new Set());
        for (const agId of Array.from(agents)) {
          nodeToAgents.get(node.id)!.add(agId);
        }
      }
    }
  }

  // Now scan knowledge_edges to find cross-domain ones
  // Fetch edges in batches where both source_node and target_node are in our map
  const nodeIds = Array.from(nodeToAgents.keys());

  // Check existing signals for idempotency
  const { data: existingSignals } = await supabase
    .from('agent_signals')
    .select('source_agent_id, target_agent_id, bridge_edge_id');

  const existingSignalKeys = new Set(
    (existingSignals || []).map(s =>
      `${s.source_agent_id}:${s.target_agent_id}:${s.bridge_edge_id}`
    )
  );

  let signalsCreated = 0;
  let edgesScanned = 0;
  const signalBatch: Array<{
    user_id: string;
    source_agent_id: string;
    target_agent_id: string;
    trigger_source_id: null;
    bridge_entity_ids: string[];
    bridge_edge_id: string;
    reason: string;
    status: string;
    processing_result: string;
  }> = [];

  // Process edges in batches — fetch edges where source_node_id is in our nodes
  for (let i = 0; i < nodeIds.length; i += 1000) {
    const batchNodeIds = nodeIds.slice(i, i + 1000);
    const { data: edges } = await supabase
      .from('knowledge_edges')
      .select('id, source_node_id, target_node_id, relation_type')
      .in('source_node_id', batchNodeIds)
      .eq('user_id', userId)
      .limit(10000);

    for (const edge of edges || []) {
      edgesScanned++;
      const sourceAgents = nodeToAgents.get(edge.source_node_id as string);
      const targetAgents = nodeToAgents.get(edge.target_node_id as string);

      // Skip if either node is unassigned (not in any agent's domain)
      if (!sourceAgents || !targetAgents) continue;

      // Find all unique cross-domain agent pairs
      for (const sAgent of Array.from(sourceAgents)) {
        for (const tAgent of Array.from(targetAgents)) {
          // Skip same-agent edges
          if (sAgent === tAgent) continue;

          // Idempotency: skip if signal already exists
          const key = `${sAgent}:${tAgent}:${edge.id}`;
          if (existingSignalKeys.has(key)) continue;

          signalBatch.push({
            user_id: userId,
            source_agent_id: sAgent,
            target_agent_id: tAgent,
            trigger_source_id: null,
            bridge_entity_ids: [edge.source_node_id as string, edge.target_node_id as string],
            bridge_edge_id: edge.id as string,
            reason: `Cross-domain edge: ${edge.relation_type}`,
            status: 'acknowledged',
            processing_result: 'acknowledge_only',
          });
        }
      }
    }
  }

  // Bulk insert signals
  if (signalBatch.length > 0) {
    // Insert in chunks of 500 to avoid payload limits
    for (let i = 0; i < signalBatch.length; i += 500) {
      const chunk = signalBatch.slice(i, i + 500);
      const { error: insErr } = await supabase
        .from('agent_signals')
        .insert(chunk);

      if (insErr) {
        return {
          step: '6_signals',
          success: false,
          detail: `Insert failed at chunk ${i}: ${insErr.message}. ${signalsCreated} created before failure.`,
        };
      }
      signalsCreated += chunk.length;
    }
  }

  return {
    step: '6_signals',
    success: true,
    detail: `${allSourceIds.length} source_ids, ${nodeIds.length} nodes mapped, ${edgesScanned} edges scanned, ${signalsCreated} signals created`,
  };
}

// ─── STEP 7: GENERATE INSIGHTS ────────────────────────────────────────────────

async function step7_generateInsights(supabase: SupabaseClient): Promise<StepResult> {
  const { data: agents, error: agErr } = await supabase
    .from('domain_agents')
    .select('id, user_id, name, expertise_index')
    .not('expertise_index', 'eq', '{}');

  if (agErr) return { step: '7_insights', success: false, detail: agErr.message };
  if (!agents || agents.length === 0) {
    return { step: '7_insights', success: true, detail: 'No agents with expertise indexes' };
  }

  const results = await runInBatches(agents, GEMINI_CONCURRENCY, async (agent) => {
    const expertise = agent.expertise_index as ExpertiseIndex;
    if (!expertise?.summary) return 'skipped';

    // Idempotency: check if insights already exist
    const { count: existingCount } = await supabase
      .from('agent_insights')
      .select('id', { count: 'exact', head: true })
      .eq('agent_id', agent.id);

    if ((existingCount || 0) > 0) return 'already_exists';

    // Get source IDs for this agent
    const { data: sources } = await supabase
      .from('domain_agent_sources')
      .select('source_id')
      .eq('agent_id', agent.id);

    const sourceIds = (sources || []).map(s => s.source_id as string);
    if (sourceIds.length === 0) return 'no_sources';

    // Get a sample of entities and edges for analysis
    const { data: entities } = await supabase
      .from('knowledge_nodes')
      .select('label, entity_type, description')
      .in('source_id', sourceIds.slice(0, 100))
      .eq('user_id', agent.user_id)
      .order('confidence', { ascending: false })
      .limit(100);

    const systemPrompt = `You are an AI that analyses a knowledge domain to identify insights — patterns, tensions, and novel connections.

Given an expertise index and entity list, identify 2-5 insights across three types:
- tension: Two pieces of knowledge that contradict or create productive friction
- convergence: Multiple independent sources arriving at the same conclusion
- novel_connection: Previously unrelated entities or themes that now appear linked

Output JSON:
{
  "insights": [
    {
      "insight_type": "tension" | "convergence" | "novel_connection",
      "claim": "The insight statement",
      "evidence_summary": "Brief evidence supporting this insight",
      "confidence": 0.0-1.0
    }
  ]
}`;

    const userContent = `Domain: ${agent.name}

Expertise: ${expertise.summary}
Themes: ${expertise.core_themes.join(', ')}

Entities (sample):
${(entities || []).slice(0, 60).map(e => `- ${e.label} [${e.entity_type}]`).join('\n')}`;

    const result = await callGemini<{ insights: Insight[] }>(systemPrompt, userContent);

    if (result.insights?.length > 0) {
      const rows = result.insights.map(ins => ({
        user_id: agent.user_id,
        agent_id: agent.id,
        insight_type: ins.insight_type,
        claim: ins.claim,
        evidence_summary: ins.evidence_summary,
        confidence: ins.confidence,
        status: 'active',
      }));

      const { error: insErr } = await supabase
        .from('agent_insights')
        .insert(rows);

      if (insErr) throw new Error(`Insights insert failed: ${insErr.message}`);
    }

    return 'ok';
  });

  const succeeded = results.filter(r => r.result === 'ok').length;
  const skipped = results.filter(r => r.result && r.result !== 'ok').length;
  const failed = results.filter(r => r.error).length;

  return {
    step: '7_insights',
    success: failed === 0,
    detail: `${succeeded} generated, ${skipped} skipped, ${failed} failed`,
  };
}

// ─── STEP 8: UPDATE COUNTS + HEALTH ──────────────────────────────────────────

async function step8_updateCountsAndHealth(supabase: SupabaseClient): Promise<StepResult> {
  const { data: agents, error: agErr } = await supabase
    .from('domain_agents')
    .select('id, user_id, playlist_id, source_count');

  if (agErr) return { step: '8_counts_health', success: false, detail: agErr.message };
  if (!agents || agents.length === 0) {
    return { step: '8_counts_health', success: true, detail: 'No agents found' };
  }

  let updated = 0;

  for (const agent of agents) {
    // Count sources
    const { count: srcCount } = await supabase
      .from('domain_agent_sources')
      .select('id', { count: 'exact', head: true })
      .eq('agent_id', agent.id);

    // Count entities across agent's sources
    const { data: sources } = await supabase
      .from('domain_agent_sources')
      .select('source_id')
      .eq('agent_id', agent.id);

    const sourceIds = (sources || []).map(s => s.source_id as string);
    let entCount = 0;
    if (sourceIds.length > 0) {
      const { count } = await supabase
        .from('knowledge_nodes')
        .select('id', { count: 'exact', head: true })
        .in('source_id', sourceIds)
        .eq('user_id', agent.user_id);
      entCount = count || 0;
    }

    // Find most recent ingestion
    let lastIngestion: string | null = null;
    if (sourceIds.length > 0) {
      const { data: latestSource } = await supabase
        .from('knowledge_sources')
        .select('created_at')
        .in('id', sourceIds)
        .order('created_at', { ascending: false })
        .limit(1);

      lastIngestion = latestSource?.[0]?.created_at || null;
    }

    // Compute health status based on source count thresholds
    const sc = srcCount || 0;
    let healthStatus: string;
    if (sc === 0) healthStatus = 'initialising';
    else if (sc <= 3) healthStatus = 'thin';
    else if (sc <= 10) healthStatus = 'growing';
    else if (sc <= 30) healthStatus = 'strong';
    else healthStatus = 'strong';

    // Check staleness — if no ingestion in 30 days, mark stale
    if (lastIngestion) {
      const daysSince = (Date.now() - new Date(lastIngestion).getTime()) / (1000 * 60 * 60 * 24);
      if (daysSince > 30) healthStatus = 'stale';
    }

    const { error: upErr } = await supabase
      .from('domain_agents')
      .update({
        source_count: sc,
        entity_count: entCount,
        last_ingestion_at: lastIngestion,
        health_status: healthStatus,
        updated_at: new Date().toISOString(),
      })
      .eq('id', agent.id);

    if (!upErr) updated++;
  }

  return { step: '8_counts_health', success: true, detail: `Updated ${updated}/${agents.length} agents` };
}

// ─── MAIN HANDLER ─────────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { userId, isCron } = await verifyUserAuth(req);
  if (!isCron && !userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const startTime = Date.now();
  const results: StepResult[] = [];

  // Optional: allow running a specific step range (for retry after partial failure)
  const { step: requestedStep, maxStep } = (req.body || {}) as { step?: number; maxStep?: number };

  const steps = [
    { num: 1, fn: step1_createAgents },
    { num: 2, fn: step2_populateSources },
    { num: 3, fn: step3_generateExpertise },
    { num: 4, fn: step4_generateQuestionsAndGaps },
    { num: 5, fn: step5_generateAwareness },
    { num: 6, fn: step6_detectSignals },
    { num: 7, fn: step7_generateInsights },
    { num: 8, fn: step8_updateCountsAndHealth },
  ];

  const supabase = getSupabase();

  for (const step of steps) {
    // If a specific step range was requested, only run those
    if (requestedStep && step.num < requestedStep) continue;
    if (maxStep && step.num > maxStep) break;

    try {
      const result = await step.fn(supabase);
      results.push(result);

      // If a step fails, continue to next steps rather than aborting
      // (idempotency means we can re-run safely)
    } catch (err) {
      results.push({
        step: `step_${step.num}`,
        success: false,
        detail: `Uncaught error: ${String(err)}`,
      });
    }

    // Check time budget — if we're past 270s, stop and report
    if (Date.now() - startTime > 270_000) {
      results.push({
        step: 'timeout',
        success: false,
        detail: `Stopped after step ${step.num} due to time budget (${Math.round((Date.now() - startTime) / 1000)}s)`,
      });
      break;
    }
  }

  const elapsed = Math.round((Date.now() - startTime) / 1000);
  const allSuccess = results.every(r => r.success);

  return res.status(allSuccess ? 200 : 207).json({
    success: allSuccess,
    elapsed_seconds: elapsed,
    results,
  });
}
