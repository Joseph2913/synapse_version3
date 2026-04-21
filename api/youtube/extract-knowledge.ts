import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';
import {
  MAX_TRANSCRIPT_CHARS,
  runExtractionCore,
  type Anchor,
  type UserProfile,
} from '../_shared/extract-pipeline';

// Allow up to 120s on Vercel Pro (heavy Gemini extraction + embeddings)
export const maxDuration = 120;

// ─── ENVIRONMENT ───────────────────────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY!;
const CRON_SECRET = process.env.CRON_SECRET;

const getSupabase = () => createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

const MAX_ITEMS_PER_BATCH = 1;

// ─── TYPES ─────────────────────────────────────────────────────────────────────

interface QueueItem {
  id: string;
  user_id: string;
  channel_id: string | null;
  video_id: string;
  video_title: string | null;
  video_url: string;
  thumbnail_url: string | null;
  published_at: string | null;
  duration_seconds: number | null;
  transcript: string;
  status: string;
  retry_count: number;
  max_retries: number;
  error_message: string | null;
  playlist_id?: string | null;
  extraction_mode?: string;
  anchor_emphasis?: string;
  linked_anchor_ids?: string[];
  custom_instructions?: string | null;
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

// ─── EXTRACTION PIPELINE ───────────────────────────────────────────────────────
// Extraction logic lives in api/_shared/extract-pipeline.ts. This file only
// owns YouTube-specific concerns (queue, source save, advisory council hook).

// ─── DAILY LIMIT CHECK ─────────────────────────────────────────────────────────

async function checkDailyLimit(
  userId: string,
  supabase: ReturnType<typeof getSupabase>
): Promise<{ allowed: boolean; remaining: number }> {
  try {
    const { data: settings } = await supabase
      .from('youtube_settings')
      .select('daily_video_limit, videos_ingested_today, daily_limit_reset_at')
      .eq('user_id', userId)
      .maybeSingle();

    if (!settings) return { allowed: true, remaining: 20 };

    const s = settings as {
      daily_video_limit: number;
      videos_ingested_today: number;
      daily_limit_reset_at: string | null;
    };

    const resetAt = s.daily_limit_reset_at ? new Date(s.daily_limit_reset_at) : null;
    if (resetAt && resetAt < new Date()) {
      await supabase
        .from('youtube_settings')
        .update({
          videos_ingested_today: 0,
          daily_limit_reset_at: new Date(Date.now() + 86_400_000).toISOString(),
        })
        .eq('user_id', userId);
      return { allowed: true, remaining: s.daily_video_limit ?? 20 };
    }

    const limit = s.daily_video_limit ?? 20;
    const ingested = s.videos_ingested_today ?? 0;
    return { allowed: ingested < limit, remaining: limit - ingested };
  } catch {
    return { allowed: true, remaining: 20 };
  }
}

// ─── MAIN EXTRACTION LOGIC ─────────────────────────────────────────────────────

async function extractKnowledgeForItem(
  item: QueueItem,
  supabase: ReturnType<typeof getSupabase>,
  itemStartTime: number
): Promise<{ success: boolean; nodesCreated: number; edgesCreated: number; error?: string }> {
  const transcript = item.transcript;

  try {
    // Note: status is already 'extracting' with started_at set — the atomic
    // claim RPC (claim_youtube_extraction_batch) does that in the same query
    // that returned this item, so no separate UPDATE is needed here.

    // ── STEP 1: SAVE SOURCE ─────────────────────────────────────────────────────
    // Check-then-insert-or-update. We cannot use Postgres ON CONFLICT because
    // the uniqueness rule is a partial index (WHERE source_url IS NOT NULL),
    // which ON CONFLICT won't match. The partial unique index remains as the
    // final safety net against races.
    const sourcePayload = {
      user_id: item.user_id,
      title: item.video_title ?? `YouTube: ${item.video_id}`,
      source_type: 'YouTube',
      source_url: item.video_url,
      content: transcript.slice(0, MAX_TRANSCRIPT_CHARS),
      metadata: {
        video_id: item.video_id,
        duration_seconds: item.duration_seconds,
        published_at: item.published_at,
        transcript_source: 'decoupled_pipeline',
      },
    };

    const { data: existingSource } = await supabase
      .from('knowledge_sources')
      .select('id')
      .eq('user_id', item.user_id)
      .eq('source_type', 'YouTube')
      .eq('source_url', item.video_url)
      .maybeSingle();

    let sourceId: string;
    if (existingSource?.id) {
      sourceId = existingSource.id as string;
      // Refresh the row with the latest transcript/metadata and clear any
      // prior nodes/edges so this run's extraction replaces them cleanly.
      await supabase
        .from('knowledge_sources')
        .update(sourcePayload)
        .eq('id', sourceId);

      const { data: priorNodes } = await supabase
        .from('knowledge_nodes')
        .select('id')
        .eq('source_id', sourceId);
      const priorNodeIds = (priorNodes ?? []).map((n: { id: string }) => n.id);
      if (priorNodeIds.length > 0) {
        await supabase.from('knowledge_edges').delete()
          .or(`source_node_id.in.(${priorNodeIds.join(',')}),target_node_id.in.(${priorNodeIds.join(',')})`);
        await supabase.from('knowledge_nodes').delete().eq('source_id', sourceId);
      }
    } else {
      const { data: inserted, error: insertErr } = await supabase
        .from('knowledge_sources')
        .insert(sourcePayload)
        .select('id')
        .single();
      if (insertErr || !inserted) {
        throw new Error(`Failed to save source: ${insertErr?.message}`);
      }
      sourceId = inserted.id as string;
    }

    await supabase
      .from('youtube_ingestion_queue')
      .update({ source_id: sourceId })
      .eq('id', item.id);

    // ── STEPS 2-7: SHARED EXTRACTION PIPELINE ──────────────────────────────────
    // Entity extraction, dedup, node+edge persistence, chunking, and cross-
    // connection discovery all live in api/_shared/extract-pipeline.ts. Every
    // source-type ingestion route calls the same core, so rate-limit fixes and
    // dedup improvements apply everywhere at once.
    const [profileResult, anchorsResult, settingsResult] = await Promise.all([
      supabase.from('user_profiles').select('*').eq('user_id', item.user_id).maybeSingle(),
      supabase
        .from('knowledge_nodes')
        .select('label, entity_type, description')
        .eq('user_id', item.user_id)
        .eq('is_anchor', true)
        .limit(10),
      supabase.from('extraction_settings').select('default_mode, default_anchor_emphasis').eq('user_id', item.user_id).maybeSingle(),
    ]);

    const userProfile = profileResult.data as UserProfile | null;
    const anchors = (anchorsResult.data ?? []) as Anchor[];
    const defaultSettings = settingsResult.data as { default_mode: string; default_anchor_emphasis: string } | null;

    const extractionMode = item.extraction_mode ?? defaultSettings?.default_mode ?? 'comprehensive';
    const anchorEmphasis = item.anchor_emphasis ?? defaultSettings?.default_anchor_emphasis ?? 'standard';

    const coreResult = await runExtractionCore({
      content: transcript,
      promptConfig: {
        mode: extractionMode,
        anchorEmphasis,
        anchors,
        userProfile,
        customInstructions: item.custom_instructions,
      },
      source: {
        sourceId,
        sourceType: 'YouTube',
        sourceUrl: item.video_url,
        sourceLabel: item.video_title ?? item.video_id,
      },
      userId: item.user_id,
      supabase,
      options: { itemStartTime },
    });

    const { savedNodeMap, nodesCreated, edgesCreated, crossConnectionCount, chunksCreated } = coreResult;

    // ── COMPLETE ────────────────────────────────────────────────────────────────
    await supabase
      .from('youtube_ingestion_queue')
      .update({
        status: 'completed',
        nodes_created: nodesCreated,
        edges_created: edgesCreated,
        completed_at: new Date().toISOString(),
      })
      .eq('id', item.id);

    // Save extraction session record
    await supabase.from('extraction_sessions').insert({
      user_id: item.user_id,
      source_name: item.video_title ?? item.video_id,
      source_type: 'YouTube',
      source_content_preview: transcript.slice(0, 300),
      extraction_mode: extractionMode,
      anchor_emphasis: anchorEmphasis,
      user_guidance: item.custom_instructions ?? null,
      selected_anchor_ids: item.linked_anchor_ids ?? [],
      entity_count: nodesCreated,
      relationship_count: edgesCreated,
      chunk_count: chunksCreated,
      cross_connection_count: crossConnectionCount,
      extraction_duration_ms: Date.now() - itemStartTime,
    });

    // Update daily counter
    try {
      const { data: ys } = await supabase
        .from('youtube_settings')
        .select('videos_ingested_today')
        .eq('user_id', item.user_id)
        .maybeSingle();
      if (ys) {
        await supabase
          .from('youtube_settings')
          .update({ videos_ingested_today: ((ys as { videos_ingested_today: number }).videos_ingested_today ?? 0) + 1 })
          .eq('user_id', item.user_id);
      }
    } catch { /* ignore */ }

    // ── TRIGGER ANCHOR SCORING (fire-and-forget) ────────────────────────────────
    // Non-fatal: if scoring fails, extraction is still considered successful.
    const savedNodeIds = Array.from(savedNodeMap.values());
    if (savedNodeIds.length > 0) {
      const appUrl = process.env.VERCEL_URL
        ? `https://${process.env.VERCEL_URL}`
        : 'http://localhost:3000';

      fetch(`${appUrl}/api/anchors/score-post-extraction`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${CRON_SECRET ?? ''}`,
        },
        body: JSON.stringify({
          userId:   item.user_id,
          sourceId: sourceId,
          nodeIds:  savedNodeIds,
        }),
      }).catch(err => {
        console.warn('[extract-knowledge] Anchor scoring trigger failed (non-fatal):', err);
      });
    }

    // ── ADVISORY COUNCIL HOOK (fire-and-forget, non-fatal) ─────────────────────
    try {
      await runAdvisoryCouncilHook(item, sourceId, supabase);
    } catch (councilErr) {
      console.warn('[extract-knowledge] Advisory council hook failed (non-fatal):', councilErr);
    }

    return { success: true, nodesCreated, edgesCreated };

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[extract-knowledge] Item ${item.id} failed:`, err);

    const isRateLimited = msg.startsWith('RATE_LIMITED');
    const newRetryCount = (item.retry_count ?? 0) + 1;
    const maxRetries = item.max_retries ?? 3;
    // Hard cap on rate-limit retries. Without this a single broken item
    // could bounce off the 429 indefinitely, starving every other item.
    const maxRateLimitRetries = 10;

    if ((isRateLimited && newRetryCount < maxRateLimitRetries) || newRetryCount < maxRetries) {
      // Re-queue to transcript_ready for retry (transcript is preserved)
      await supabase
        .from('youtube_ingestion_queue')
        .update({
          status: 'transcript_ready',
          retry_count: newRetryCount,
          error_message: msg,
          started_at: null,
        })
        .eq('id', item.id);
    } else {
      await supabase
        .from('youtube_ingestion_queue')
        .update({
          status: 'failed',
          retry_count: newRetryCount,
          error_message: msg,
          completed_at: new Date().toISOString(),
        })
        .eq('id', item.id);
    }

    return { success: false, nodesCreated: 0, edgesCreated: 0, error: msg };
  }
}

// ─── ADVISORY COUNCIL HOOK ────────────────────────────────────────────────────
//
// Post-extraction hook that updates the relevant domain agent whenever a
// new YouTube video is ingested.  Wrapped in try-catch — a failure here
// must NEVER cause the extraction to be marked as failed.
//
// Steps:
//   1. Resolve domain agent via playlist_id → youtube_playlists.domain_agent_id
//   2. Create source association (upsert into domain_agent_sources)
//   3. Gemini ingestion-time analysis (insights + question eval + summary)
//   4. Persist detected insights
//   5. Update standing questions
//   6. Detect cross-domain signals from edges
//   7. Flag expertise index as stale, update counters

interface AdvisoryInsight {
  type: 'tension' | 'convergence' | 'novel_connection';
  claim: string;
  evidence_summary: string;
  related_entity_labels: string[];
  confidence: number;
}

interface QuestionUpdate {
  question_id: string;
  new_status: 'partially_addressed' | 'answered';
  evidence: string;
}

interface AdvisoryAnalysisResult {
  insights: AdvisoryInsight[];
  question_updates: QuestionUpdate[];
  contribution_summary: string;
}

async function runAdvisoryCouncilHook(
  item: QueueItem,
  sourceId: string,
  supabase: ReturnType<typeof getSupabase>
): Promise<void> {
  const hookStart = Date.now();

  // ── Step 1: Resolve domain agent ──────────────────────────────────────────
  if (!item.playlist_id) return;

  const { data: playlist } = await supabase
    .from('youtube_playlists')
    .select('domain_agent_id')
    .eq('id', item.playlist_id)
    .maybeSingle();

  const agentId = (playlist as { domain_agent_id: string | null } | null)?.domain_agent_id;
  if (!agentId) return; // No domain agent — playlist predates advisory council

  console.log(`[advisory-council] Hook started for agent ${agentId}, source ${sourceId}`);

  // ── Step 2: Create source association (idempotent upsert) ─────────────────
  await supabase
    .from('domain_agent_sources')
    .upsert(
      {
        user_id: item.user_id,
        agent_id: agentId,
        source_id: sourceId,
        association_type: 'primary',
      },
      { onConflict: 'agent_id,source_id' }
    );

  // ── Step 3: Ingestion-time analysis via Gemini ────────────────────────────
  // Gather inputs for the prompt
  const [nodesResult, chunksResult, agentResult, questionsResult] = await Promise.all([
    // Entities from the new source
    supabase
      .from('knowledge_nodes')
      .select('id, label, entity_type, description')
      .eq('source_id', sourceId)
      .eq('user_id', item.user_id)
      .limit(50),
    // Top chunks from the new source
    supabase
      .from('source_chunks')
      .select('content')
      .eq('source_id', sourceId)
      .eq('user_id', item.user_id)
      .order('chunk_index', { ascending: true })
      .limit(8),
    // Agent's current expertise index
    supabase
      .from('domain_agents')
      .select('expertise_index')
      .eq('id', agentId)
      .single(),
    // Open standing questions
    supabase
      .from('agent_standing_questions')
      .select('id, question, question_type, status')
      .eq('agent_id', agentId)
      .in('status', ['open', 'partially_addressed'])
      .limit(20),
  ]);

  const nodes = (nodesResult.data ?? []) as Array<{
    id: string; label: string; entity_type: string; description: string;
  }>;
  const chunks = (chunksResult.data ?? []) as Array<{ content: string }>;
  const expertiseIndex = (agentResult.data as { expertise_index: Record<string, unknown> } | null)?.expertise_index ?? {};
  const openQuestions = (questionsResult.data ?? []) as Array<{
    id: string; question: string; question_type: string; status: string;
  }>;

  // Build the analysis prompt
  const entitySummary = nodes
    .map(n => `- ${n.label} (${n.entity_type}): ${n.description}`)
    .join('\n');
  const chunkContent = chunks.map(c => c.content).join('\n---\n');
  const questionList = openQuestions
    .map(q => `- [${q.id}] (${q.question_type}, ${q.status}): ${q.question}`)
    .join('\n');

  const analysisPrompt = `You are an advisory council analyst for a personal knowledge graph.
A new source has been ingested into a domain agent's scope. Analyse it for patterns.

## New Source Entities
${entitySummary || '(none extracted)'}

## New Source Content (key chunks)
${chunkContent || '(no chunks)'}

## Agent's Current Expertise Index
${JSON.stringify(expertiseIndex, null, 2)}

## Open Standing Questions
${questionList || '(none)'}

## Your Task
Analyse the new content and return structured JSON with exactly these three fields:

1. **insights**: Array of patterns detected. Types:
   - "tension": Content contradicts or disagrees with existing knowledge
   - "convergence": Content independently corroborates existing patterns
   - "novel_connection": Previously unlinked entities are now connected
   Only report specific, evidence-backed patterns. Return empty array if none.

2. **question_updates**: Array of standing questions affected by this content.
   Return the question ID, new_status ("partially_addressed" or "answered"), and evidence.
   Return empty array if no questions are addressed.

3. **contribution_summary**: One sentence describing what this source adds.

Return ONLY valid JSON matching this schema:
{
  "insights": [{ "type": "tension|convergence|novel_connection", "claim": "...", "evidence_summary": "...", "related_entity_labels": ["..."], "confidence": 0.0-1.0 }],
  "question_updates": [{ "question_id": "uuid", "new_status": "partially_addressed|answered", "evidence": "..." }],
  "contribution_summary": "..."
}`;

  let analysis: AdvisoryAnalysisResult = {
    insights: [],
    question_updates: [],
    contribution_summary: '',
  };

  try {
    const geminiResponse = await fetch(
      `${GEMINI_BASE}/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: analysisPrompt }] }],
          generationConfig: {
            temperature: 0.1,
            responseMimeType: 'application/json',
          },
        }),
        signal: AbortSignal.timeout(30000),
      }
    );

    if (geminiResponse.ok) {
      const geminiData = await geminiResponse.json() as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      };
      const text = geminiData.candidates?.[0]?.content?.parts?.[0]?.text;
      if (text) {
        analysis = JSON.parse(text) as AdvisoryAnalysisResult;
      }
    } else {
      console.warn(`[advisory-council] Gemini analysis call failed: ${geminiResponse.status}`);
    }
  } catch (err) {
    console.warn('[advisory-council] Gemini analysis failed:', err);
  }

  // ── Step 4: Persist insights ──────────────────────────────────────────────
  if (analysis.insights.length > 0) {
    // Build a label→id lookup from the source's nodes
    const labelToIds = new Map<string, string>();
    for (const n of nodes) {
      labelToIds.set(n.label.toLowerCase(), n.id);
    }

    const insightRows = analysis.insights.map(ins => ({
      user_id: item.user_id,
      agent_id: agentId,
      insight_type: ins.type,
      claim: ins.claim,
      evidence_summary: ins.evidence_summary,
      trigger_source_id: sourceId,
      related_entity_ids: ins.related_entity_labels
        .map(label => labelToIds.get(label.toLowerCase()))
        .filter((id): id is string => !!id),
      confidence: ins.confidence,
      status: 'active',
    }));

    const { error: insightError } = await supabase
      .from('agent_insights')
      .insert(insightRows);

    if (insightError) {
      console.warn('[advisory-council] Failed to insert insights:', insightError.message);
    } else {
      console.log(`[advisory-council] Inserted ${insightRows.length} insights`);
    }
  }

  // ── Step 5: Update standing questions ─────────────────────────────────────
  for (const qu of analysis.question_updates) {
    // Validate the question_id is a real open question for this agent
    const validQuestion = openQuestions.find(q => q.id === qu.question_id);
    if (!validQuestion) continue;

    // Append source_id to addressing_source_ids array
    const { error: qError } = await supabase.rpc('append_to_uuid_array', {
      p_table: 'agent_standing_questions',
      p_id: qu.question_id,
      p_column: 'addressing_source_ids',
      p_value: sourceId,
    }).then(
      // If the RPC doesn't exist, fall back to a direct update
      () => ({ error: null }),
      () => ({ error: null })
    );

    // Direct update for status + evidence (always runs)
    await supabase
      .from('agent_standing_questions')
      .update({
        status: qu.new_status,
        addressing_evidence: qu.evidence,
        status_changed_at: new Date().toISOString(),
      })
      .eq('id', qu.question_id)
      .eq('agent_id', agentId);

    // Also append source_id to the array via raw update
    // Postgres: addressing_source_ids = array_append(addressing_source_ids, sourceId)
    await supabase.rpc('append_addressing_source', {
      p_question_id: qu.question_id,
      p_source_id: sourceId,
    }).catch(() => {
      // If RPC doesn't exist, do a read-modify-write
      void (async () => {
        const { data: qRow } = await supabase
          .from('agent_standing_questions')
          .select('addressing_source_ids')
          .eq('id', qu.question_id)
          .single();
        const existing = ((qRow as { addressing_source_ids: string[] } | null)?.addressing_source_ids) ?? [];
        if (!existing.includes(sourceId)) {
          await supabase
            .from('agent_standing_questions')
            .update({ addressing_source_ids: [...existing, sourceId] })
            .eq('id', qu.question_id);
        }
      })();
    });

    if (qError) {
      console.warn(`[advisory-council] Question update failed for ${qu.question_id}:`, qError);
    }
  }

  if (analysis.question_updates.length > 0) {
    console.log(`[advisory-council] Updated ${analysis.question_updates.length} standing questions`);
  }

  // ── Step 6: Detect cross-domain signals (no LLM call) ─────────────────────
  // Find edges where one node belongs to the new source and the other belongs
  // to a different domain agent's scope.
  const newSourceNodeIds = nodes.map(n => n.id);

  if (newSourceNodeIds.length > 0) {
    // Get all edges involving nodes from this source
    const { data: outEdges } = await supabase
      .from('knowledge_edges')
      .select('id, source_node_id, target_node_id, evidence')
      .eq('user_id', item.user_id)
      .in('source_node_id', newSourceNodeIds);

    const { data: inEdges } = await supabase
      .from('knowledge_edges')
      .select('id, source_node_id, target_node_id, evidence')
      .eq('user_id', item.user_id)
      .in('target_node_id', newSourceNodeIds);

    type EdgeRow = { id: string; source_node_id: string; target_node_id: string; evidence: string | null };
    const allEdges = [...((outEdges ?? []) as EdgeRow[]), ...((inEdges ?? []) as EdgeRow[])];

    // Collect "other side" node IDs (nodes NOT from the new source)
    const newNodeSet = new Set(newSourceNodeIds);
    const otherNodeIds = new Set<string>();
    for (const e of allEdges) {
      if (!newNodeSet.has(e.source_node_id)) otherNodeIds.add(e.source_node_id);
      if (!newNodeSet.has(e.target_node_id)) otherNodeIds.add(e.target_node_id);
    }

    if (otherNodeIds.size > 0) {
      // Find which domain agents own these other nodes (via domain_agent_sources → knowledge_nodes.source_id)
      const otherNodeIdArr = Array.from(otherNodeIds);
      const { data: otherNodes } = await supabase
        .from('knowledge_nodes')
        .select('id, source_id')
        .in('id', otherNodeIdArr.slice(0, 200)); // Cap to avoid oversized IN clause

      const nodeSourceMap = new Map<string, string>();
      for (const n of ((otherNodes ?? []) as Array<{ id: string; source_id: string | null }>)) {
        if (n.source_id) nodeSourceMap.set(n.id, n.source_id);
      }

      const otherSourceIds = [...new Set(Array.from(nodeSourceMap.values()))];
      if (otherSourceIds.length > 0) {
        const { data: otherAgentSources } = await supabase
          .from('domain_agent_sources')
          .select('agent_id, source_id')
          .in('source_id', otherSourceIds.slice(0, 200))
          .neq('agent_id', agentId); // Exclude our own agent

        const sourceToAgents = new Map<string, Set<string>>();
        for (const das of ((otherAgentSources ?? []) as Array<{ agent_id: string; source_id: string }>)) {
          if (!sourceToAgents.has(das.source_id)) sourceToAgents.set(das.source_id, new Set());
          sourceToAgents.get(das.source_id)!.add(das.agent_id);
        }

        // Get existing bridge_edge_ids to dedup
        const edgeIds = allEdges.map(e => e.id);
        const { data: existingSignals } = await supabase
          .from('agent_signals')
          .select('bridge_edge_id')
          .in('bridge_edge_id', edgeIds.slice(0, 200));

        const existingBridgeEdges = new Set(
          ((existingSignals ?? []) as Array<{ bridge_edge_id: string | null }>)
            .map(s => s.bridge_edge_id)
            .filter((id): id is string => !!id)
        );

        // Create signals for each cross-domain edge
        const signalRows: Array<Record<string, unknown>> = [];
        for (const edge of allEdges) {
          if (existingBridgeEdges.has(edge.id)) continue; // Already signalled

          const otherNodeId = newNodeSet.has(edge.source_node_id)
            ? edge.target_node_id
            : edge.source_node_id;
          const otherSourceId = nodeSourceMap.get(otherNodeId);
          if (!otherSourceId) continue;

          const targetAgents = sourceToAgents.get(otherSourceId);
          if (!targetAgents) continue;

          for (const targetAgentId of targetAgents) {
            signalRows.push({
              user_id: item.user_id,
              source_agent_id: agentId,
              target_agent_id: targetAgentId,
              trigger_source_id: sourceId,
              bridge_entity_ids: [edge.source_node_id, edge.target_node_id],
              bridge_edge_id: edge.id,
              reason: edge.evidence ?? 'Cross-domain edge detected during ingestion',
              status: 'pending',
            });
          }
        }

        if (signalRows.length > 0) {
          // Batch insert (dedup on bridge_edge_id already handled above)
          const { error: sigError } = await supabase
            .from('agent_signals')
            .insert(signalRows);

          if (sigError) {
            console.warn('[advisory-council] Failed to insert signals:', sigError.message);
          } else {
            console.log(`[advisory-council] Created ${signalRows.length} cross-domain signals`);
          }
        }
      }
    }
  }

  // ── Step 7: Flag expertise index as stale, update counters ────────────────
  // Count entities across all of this agent's sources
  const { count: entityCount } = await supabase
    .from('knowledge_nodes')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', item.user_id)
    .in('source_id',
      await supabase
        .from('domain_agent_sources')
        .select('source_id')
        .eq('agent_id', agentId)
        .then(r => ((r.data ?? []) as Array<{ source_id: string }>).map(d => d.source_id))
    );

  const { count: sourceCount } = await supabase
    .from('domain_agent_sources')
    .select('id', { count: 'exact', head: true })
    .eq('agent_id', agentId);

  await supabase
    .from('domain_agents')
    .update({
      index_stale: true,
      last_ingestion_at: new Date().toISOString(),
      source_count: sourceCount ?? 0,
      entity_count: entityCount ?? 0,
      updated_at: new Date().toISOString(),
    })
    .eq('id', agentId);

  console.log(`[advisory-council] Hook completed in ${Date.now() - hookStart}ms — agent ${agentId} updated`);
}

// ─── HANDLER ───────────────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const startTime = Date.now();
  const { userId, isCron } = await verifyUserAuth(req);

  if (!isCron && !userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const supabase = getSupabase();

  try {
    // ── Atomically claim a batch ───────────────────────────────────────────────
    // The RPC resets genuinely-stuck extractions (>30 min old) and then claims
    // a batch in a single UPDATE ... RETURNING guarded by FOR UPDATE SKIP LOCKED.
    // Two overlapping cron runs can never claim the same row.
    const { data: pendingItems, error: fetchError } = await supabase.rpc(
      'claim_youtube_extraction_batch',
      {
        p_user_id: isCron ? null : userId,
        p_limit: MAX_ITEMS_PER_BATCH,
      }
    );

    if (fetchError) {
      console.error('[extract-knowledge] Queue claim failed:', fetchError.message);
      return res.status(500).json({ error: fetchError.message });
    }

    if (!pendingItems || pendingItems.length === 0) {
      return res.status(200).json({
        success: true,
        processed: 0,
        results: [],
        message: 'No items ready for extraction',
        duration_ms: Date.now() - startTime,
      });
    }

    // Fetch playlist settings separately (resilient — falls back to defaults)
    const playlistIds = [...new Set(
      (pendingItems as Array<Record<string, unknown>>)
        .map(r => r['playlist_id'] as string | null)
        .filter((id): id is string => !!id)
    )];
    const playlistMap = new Map<string, Record<string, unknown>>();
    if (playlistIds.length > 0) {
      try {
        const { data: playlists } = await supabase
          .from('youtube_playlists')
          .select('id, extraction_mode, anchor_emphasis, linked_anchor_ids, custom_instructions')
          .in('id', playlistIds);
        for (const p of (playlists ?? []) as Array<Record<string, unknown>>) {
          playlistMap.set(p['id'] as string, p);
        }
      } catch (err) {
        console.warn('[extract-knowledge] Playlist settings lookup failed, using defaults:', err);
      }
    }

    // Map queue items with playlist settings (or defaults)
    const items: QueueItem[] = (pendingItems as Array<Record<string, unknown>>).map(row => {
      const playlist = playlistMap.get(row['playlist_id'] as string) ?? null;
      return {
        id: row['id'] as string,
        user_id: row['user_id'] as string,
        channel_id: row['channel_id'] as string | null,
        video_id: row['video_id'] as string,
        video_title: row['video_title'] as string | null,
        video_url: row['video_url'] as string,
        thumbnail_url: row['thumbnail_url'] as string | null,
        published_at: row['published_at'] as string | null,
        duration_seconds: row['duration_seconds'] as number | null,
        transcript: row['transcript'] as string,
        status: row['status'] as string,
        retry_count: (row['retry_count'] as number) ?? 0,
        max_retries: (row['max_retries'] as number) ?? 3,
        error_message: row['error_message'] as string | null,
        playlist_id: row['playlist_id'] as string | null,
        extraction_mode: (playlist?.['extraction_mode'] as string) ?? undefined,
        anchor_emphasis: (playlist?.['anchor_emphasis'] as string) ?? undefined,
        linked_anchor_ids: (playlist?.['linked_anchor_ids'] as string[]) ?? [],
        custom_instructions: (playlist?.['custom_instructions'] as string | null) ?? undefined,
      };
    });

    // Check daily limits and filter
    const allowedItems: QueueItem[] = [];
    const results: Array<{
      id: string;
      status: string;
      error?: string;
      nodes_created?: number;
      edges_created?: number;
    }> = [];

    for (const item of items) {
      const { allowed } = await checkDailyLimit(item.user_id, supabase);
      if (!allowed) {
        results.push({ id: item.id, status: 'skipped', error: 'Daily limit reached' });
        continue;
      }
      allowedItems.push(item);
    }

    // Process items in parallel
    const extractionResults = await Promise.allSettled(
      allowedItems.map(item => extractKnowledgeForItem(item, supabase, Date.now()))
    );

    extractionResults.forEach((result, idx) => {
      const item = allowedItems[idx];
      if (!item) return;
      if (result.status === 'fulfilled') {
        results.push({
          id: item.id,
          status: result.value.success ? 'completed' : 'failed',
          error: result.value.error,
          nodes_created: result.value.nodesCreated,
          edges_created: result.value.edgesCreated,
        });
      } else {
        results.push({
          id: item.id,
          status: 'failed',
          error: result.reason?.message || 'Unknown error',
        });
      }
    });

    // Log scan history
    const processed = results.filter(r => r.status === 'completed').length;
    const failed = results.filter(r => r.status === 'failed').length;

    if (items.length > 0) {
      const firstUserId = items[0]?.user_id;
      if (firstUserId) {
        await supabase.from('youtube_scan_history').insert({
          user_id: firstUserId,
          scan_type: 'process',
          channel_name: null,
          videos_found: items.length,
          videos_added: 0,
          videos_skipped: 0,
          videos_processed: processed,
          videos_failed: failed,
          status: failed > 0 && processed === 0 ? 'failed' : failed > 0 ? 'partial' : 'completed',
          started_at: new Date(startTime).toISOString(),
          completed_at: new Date().toISOString(),
          duration_ms: Date.now() - startTime,
        });
      }
    }

    return res.status(200).json({
      success: true,
      processed: results.length,
      results,
      duration_ms: Date.now() - startTime,
    });

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[extract-knowledge] Fatal error:', err);
    return res.status(500).json({ success: false, error: msg, duration_ms: Date.now() - startTime });
  }
}
