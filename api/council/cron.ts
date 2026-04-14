import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

// Nightly advisory council cron — runs at 2:00 AM UTC.
// Processes pending signals, rebuilds stale expertise indexes, regenerates
// standing questions/gaps, refreshes awareness registers, updates health.
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

interface SignalRow {
  id: string;
  source_agent_id: string;
  target_agent_id: string;
  trigger_source_id: string | null;
  bridge_entity_ids: string[];
  bridge_edge_id: string | null;
  reason: string;
  user_id: string;
}

interface SignalDecision {
  signal_id: string;
  action: 'acknowledge_only' | 'targeted_extraction' | 'full_ingestion';
  reason: string;
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
// PHASE 1: PROCESS PENDING SIGNALS
// ═══════════════════════════════════════════════════════════════════════════════

async function phase1_processSignals(supabase: SupabaseClient): Promise<PhaseResult> {
  const phaseStart = Date.now();

  // Get all agents that have pending signals addressed to them
  const { data: pendingSignals, error: sigErr } = await supabase
    .from('agent_signals')
    .select('id, source_agent_id, target_agent_id, trigger_source_id, bridge_entity_ids, bridge_edge_id, reason, user_id')
    .eq('status', 'pending')
    .limit(200);

  if (sigErr) {
    return { phase: '1_signals', success: false, detail: sigErr.message, duration_ms: Date.now() - phaseStart };
  }
  if (!pendingSignals || pendingSignals.length === 0) {
    return { phase: '1_signals', success: true, detail: '0 pending signals', duration_ms: Date.now() - phaseStart };
  }

  const signals = pendingSignals as SignalRow[];

  // Mark all as processing (prevents reprocessing on double-fire)
  const signalIds = signals.map(s => s.id);
  await supabase
    .from('agent_signals')
    .update({ status: 'processing' })
    .in('id', signalIds);

  // Group signals by target agent
  const byTargetAgent = new Map<string, SignalRow[]>();
  for (const sig of signals) {
    const arr = byTargetAgent.get(sig.target_agent_id) ?? [];
    arr.push(sig);
    byTargetAgent.set(sig.target_agent_id, arr);
  }

  let acknowledged = 0;
  let extracted = 0;
  let fullIngested = 0;
  let failed = 0;

  const agentBatches = Array.from(byTargetAgent.entries());

  const results = await runInBatches(agentBatches, GEMINI_CONCURRENCY, async ([agentId, agentSignals]) => {
    // Get the target agent's expertise index
    const { data: agent } = await supabase
      .from('domain_agents')
      .select('id, user_id, name, description, expertise_index')
      .eq('id', agentId)
      .single();

    if (!agent) throw new Error(`Agent ${agentId} not found`);

    const expertise = agent.expertise_index as ExpertiseIndex | null;

    // Gather trigger source info for each signal
    const triggerSourceIds = agentSignals
      .map(s => s.trigger_source_id)
      .filter((id): id is string => !!id);

    let sourceMeta: Array<{ id: string; title: string; content: string }> = [];
    if (triggerSourceIds.length > 0) {
      const { data: sources } = await supabase
        .from('knowledge_sources')
        .select('id, title, content')
        .in('id', Array.from(new Set(triggerSourceIds)));
      sourceMeta = (sources ?? []) as Array<{ id: string; title: string; content: string }>;
    }

    const sourceMap = new Map(sourceMeta.map(s => [s.id, s]));

    // Get bridge entity details (label, type, description) for quality assessment
    const allBridgeEntityIds = agentSignals.flatMap(s => s.bridge_entity_ids ?? []);
    let entityMap = new Map<string, string>();
    let entityDetailMap = new Map<string, { label: string; entity_type: string; description: string | null }>();
    if (allBridgeEntityIds.length > 0) {
      const { data: entities } = await supabase
        .from('knowledge_nodes')
        .select('id, label, entity_type, description')
        .in('id', Array.from(new Set(allBridgeEntityIds)).slice(0, 100));
      for (const e of (entities ?? []) as Array<{ id: string; label: string; entity_type: string; description: string | null }>) {
        entityMap.set(e.id, e.label);
        entityDetailMap.set(e.id, { label: e.label, entity_type: e.entity_type, description: e.description });
      }
    }

    // Compute quality tier for each signal based on bridge entity specificity
    const GENERIC_TYPES = new Set(['Topic', 'Concept', 'Document', 'Event', 'Location']);
    const GENERIC_LABELS = new Set(['AI', 'Technology', 'Document', 'documents', 'API', 'APIs']);

    function getSignalQuality(bridgeEntityIds: string[]): 'high' | 'medium' | 'low' {
      const details = bridgeEntityIds.map(id => entityDetailMap.get(id)).filter(Boolean);
      if (details.length < 2) return 'low';

      let specificCount = 0;
      for (const d of details) {
        if (!d) continue;
        const isGenericType = GENERIC_TYPES.has(d.entity_type);
        const isGenericLabel = GENERIC_LABELS.has(d.label);
        const hasDescription = !!d.description && d.description.length > 10;
        if (!isGenericType && !isGenericLabel && hasDescription) specificCount++;
        else if (hasDescription && !isGenericLabel) specificCount += 0.5;
      }

      if (specificCount >= 2) return 'high';
      if (specificCount >= 1) return 'medium';
      return 'low';
    }

    // Build the signal descriptions for the prompt, including quality tier
    const signalDescriptions = agentSignals.map(sig => {
      const source = sig.trigger_source_id ? sourceMap.get(sig.trigger_source_id) : null;
      const bridgeDetails = (sig.bridge_entity_ids ?? []).map(id => {
        const d = entityDetailMap.get(id);
        return d ? `${d.label} (${d.entity_type}${d.description ? ': ' + d.description.slice(0, 80) : ''})` : id;
      }).join(' ↔ ');
      const quality = getSignalQuality(sig.bridge_entity_ids ?? []);
      const qualityLabel = quality === 'high' ? '⬆ HIGH QUALITY' : quality === 'medium' ? '➡ MEDIUM QUALITY' : '⬇ LOW QUALITY';
      return `- Signal ${sig.id} [${qualityLabel}]: Bridge: [${bridgeDetails}]. Reason: ${sig.reason}. Source: "${source?.title ?? 'unknown'}" (${source?.content?.slice(0, 500) ?? 'no content'})`;
    }).join('\n');

    // One Gemini call for all signals to this agent
    const systemPrompt = `You are a domain advisor deciding how to handle cross-domain signals from other domain experts.

For each signal, decide:
- "acknowledge_only": The connection is noted but no new extraction is needed.
- "targeted_extraction": The trigger source has specific relevant content worth extracting through your domain lens.
- "full_ingestion": The entire trigger source is deeply relevant — treat it as domain content.

Each signal has a quality indicator:
- ⬆ HIGH QUALITY: Both bridge entities are specific, named concepts with descriptions. These are strong cross-domain connections. Lean towards targeted_extraction if the trigger source content offers a perspective your domain doesn't already have.
- ➡ MEDIUM QUALITY: One bridge entity is specific, one is generic. Choose targeted_extraction only if the evidence text demonstrates a substantive insight beyond a shared mention.
- ⬇ LOW QUALITY: Both bridge entities are generic types (e.g. "AI", "Technology", "Document"). These are usually vocabulary overlaps, not real insights. Prefer acknowledge_only unless the evidence clearly contains a novel cross-domain finding.

Return JSON:
{
  "decisions": [
    { "signal_id": "uuid", "action": "acknowledge_only | targeted_extraction | full_ingestion", "reason": "brief justification" }
  ]
}`;

    const userContent = `Your domain: ${agent.name}
Description: ${agent.description ?? ''}
Expertise: ${expertise?.summary ?? 'No expertise index yet'}
Core themes: ${expertise?.core_themes?.join(', ') ?? 'None'}

Pending signals (${agentSignals.length}):
${signalDescriptions}`;

    const geminiResult = await callGemini<{ decisions: SignalDecision[] }>(systemPrompt, userContent);

    // Execute each decision
    for (const decision of (geminiResult.decisions ?? [])) {
      const signal = agentSignals.find(s => s.id === decision.signal_id);
      if (!signal) continue;

      try {
        if (decision.action === 'acknowledge_only') {
          await supabase
            .from('agent_signals')
            .update({
              status: 'acknowledged',
              processing_result: 'acknowledge_only',
              processed_at: new Date().toISOString(),
            })
            .eq('id', signal.id);
          acknowledged++;

        } else if (decision.action === 'targeted_extraction') {
          // Find relevant chunks from the trigger source using semantic similarity to bridge entities
          const bridgeLabels = (signal.bridge_entity_ids ?? []).map(id => entityMap.get(id) ?? '').filter(Boolean);
          const bridgeText = bridgeLabels.join(' ');

          let extractedEntityIds: string[] = [];

          if (bridgeText && signal.trigger_source_id) {
            // Generate embedding for bridge entity text
            const embedding = await generateEmbedding(bridgeText);

            if (embedding.length > 0) {
              // Find relevant chunks from the trigger source
              const { data: chunks } = await supabase.rpc('match_source_chunks', {
                query_embedding: embedding,
                match_threshold: 0.4,
                match_count: 10,
                p_user_id: signal.user_id,
              });

              // Filter to only chunks from the trigger source
              const relevantChunks = ((chunks ?? []) as Array<{ source_id: string; content: string }>)
                .filter(c => c.source_id === signal.trigger_source_id);

              if (relevantChunks.length > 0) {
                const chunkContent = relevantChunks.map(c => c.content).join('\n---\n');

                // Domain-scoped extraction
                const extractionResult = await callGemini<{
                  entities: Array<{ label: string; entity_type: string; description: string; confidence: number }>;
                  relationships: Array<{ source: string; target: string; relation_type: string; evidence: string }>;
                }>(
                  `You are a knowledge extraction system for the "${agent.name}" domain.
Extract entities and relationships relevant to this domain from the provided content.
Return JSON: { "entities": [{ "label": "...", "entity_type": "...", "description": "...", "confidence": 0.0-1.0 }], "relationships": [{ "source": "entity label", "target": "entity label", "relation_type": "...", "evidence": "..." }] }
Only extract entities relevant to: ${expertise?.core_themes?.join(', ') ?? agent.name}`,
                  chunkContent
                );

                // Save extracted entities
                if (extractionResult.entities?.length > 0) {
                  const nodeRows = extractionResult.entities.map(e => ({
                    user_id: signal.user_id,
                    source_id: signal.trigger_source_id,
                    label: e.label,
                    entity_type: e.entity_type,
                    description: e.description,
                    confidence: e.confidence,
                  }));

                  const { data: inserted } = await supabase
                    .from('knowledge_nodes')
                    .insert(nodeRows)
                    .select('id');

                  extractedEntityIds = (inserted ?? []).map(n => (n as { id: string }).id);

                  // Save edges if we have nodes
                  if (extractedEntityIds.length > 0 && extractionResult.relationships?.length > 0) {
                    const labelToId = new Map<string, string>();
                    extractionResult.entities.forEach((e, idx) => {
                      if (extractedEntityIds[idx]) {
                        labelToId.set(e.label.toLowerCase(), extractedEntityIds[idx]!);
                      }
                    });

                    const edgeRows = extractionResult.relationships
                      .map(r => {
                        const srcId = labelToId.get(r.source.toLowerCase());
                        const tgtId = labelToId.get(r.target.toLowerCase());
                        if (!srcId || !tgtId) return null;
                        return {
                          user_id: signal.user_id,
                          source_node_id: srcId,
                          target_node_id: tgtId,
                          relation_type: r.relation_type,
                          evidence: r.evidence,
                          weight: 0.7,
                        };
                      })
                      .filter((r): r is NonNullable<typeof r> => r !== null);

                    if (edgeRows.length > 0) {
                      await supabase.from('knowledge_edges').insert(edgeRows);
                    }
                  }
                }
              }
            }
          }

          await supabase
            .from('agent_signals')
            .update({
              status: 'extracted',
              processing_result: 'targeted_extraction',
              extracted_entity_ids: extractedEntityIds,
              processed_at: new Date().toISOString(),
            })
            .eq('id', signal.id);
          extracted++;

        } else if (decision.action === 'full_ingestion') {
          // Add the trigger source to this agent's scope
          if (signal.trigger_source_id) {
            await supabase
              .from('domain_agent_sources')
              .upsert(
                {
                  user_id: signal.user_id,
                  agent_id: agentId,
                  source_id: signal.trigger_source_id,
                  association_type: 'cross_domain',
                },
                { onConflict: 'agent_id,source_id' }
              );
          }

          await supabase
            .from('agent_signals')
            .update({
              status: 'extracted',
              processing_result: 'full_ingestion',
              processed_at: new Date().toISOString(),
            })
            .eq('id', signal.id);
          fullIngested++;
        }
      } catch (err) {
        console.warn(`[council-cron] Signal ${signal.id} processing failed:`, err);
        // Revert to pending so it can be retried next run
        await supabase
          .from('agent_signals')
          .update({ status: 'pending' })
          .eq('id', signal.id);
        failed++;
      }
    }

    return 'ok';
  });

  const batchFailed = results.filter(r => r.error).length;

  return {
    phase: '1_signals',
    success: batchFailed === 0 && failed === 0,
    detail: `${signals.length} signals: ${acknowledged} acknowledged, ${extracted} targeted, ${fullIngested} full, ${failed} failed`,
    duration_ms: Date.now() - phaseStart,
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

    // Insert new questions
    if (result.standing_questions?.length > 0) {
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

  // Phase 1: Process pending signals
  try {
    const p1 = await phase1_processSignals(supabase);
    phaseResults.push(p1);
    console.log(`[council-cron] Phase 1 complete: ${p1.detail} (${p1.duration_ms}ms)`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[council-cron] Phase 1 failed:', msg);
    phaseResults.push({ phase: '1_signals', success: false, detail: msg, duration_ms: Date.now() - startTime });
  }

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

  console.log(`[council-cron] Complete in ${totalDuration}ms — ${allSuccess ? 'ALL PASSED' : 'SOME FAILED'}`);

  return res.status(200).json({
    success: allSuccess,
    duration_ms: totalDuration,
    phases: phaseResults,
  });
}
