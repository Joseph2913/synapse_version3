import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';
import { waitUntil } from '@vercel/functions';
import {
  runExtractionCore,
  stripMarkdown,
  PIPELINE_MODEL,
  PIPELINE_EMBEDDING_MODEL,
  PROMPT_VERSION,
  type Anchor,
  type UserProfile,
  type PromptSkillHint,
  type TokenAccumulator,
} from '../pipeline/extract-pipeline.js';

export const maxDuration = 300;

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY!;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY!;
const INGEST_SECRET = process.env.INGEST_SECRET;

if (!GEMINI_API_KEY) throw new Error('[retry-source] Missing GEMINI_API_KEY');

const getSupabase = () => createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const GEMINI_MODEL = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash';

// Returns userId from JWT auth, or null if ingest secret auth is used (userId resolved later from source row)
async function resolveAuth(req: VercelRequest): Promise<{ userId: string | null; isIngestSecret: boolean }> {
  const secret = req.headers['x-ingest-secret'] as string | undefined;
  if (INGEST_SECRET && secret === INGEST_SECRET) return { userId: null, isIngestSecret: true };
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return { userId: null, isIngestSecret: false };
  const token = auth.slice(7);
  try {
    const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    const { data: { user } } = await anon.auth.getUser(token);
    return { userId: user?.id ?? null, isIngestSecret: false };
  } catch {
    return { userId: null, isIngestSecret: false };
  }
}

// ─── AUDIT HELPERS ────────────────────────────────────────────────────────────

const COST_INPUT_PER_TOKEN = 0.075 / 1_000_000;
const COST_OUTPUT_PER_TOKEN = 0.30 / 1_000_000;

function estimateCost(promptTokens: number, outputTokens: number): number {
  return promptTokens * COST_INPUT_PER_TOKEN + outputTokens * COST_OUTPUT_PER_TOKEN;
}

async function writeAuditSession(
  supabase: ReturnType<typeof getSupabase>,
  fields: {
    userId: string;
    sourceName: string;
    sourceType: string;
    sourceId?: string | null;
    contentPreview: string;
    extractionMode: string;
    anchorEmphasis: string;
    userGuidance?: string | null;
    selectedAnchorIds?: string[];
    entityCount: number;
    relationshipCount: number;
    chunkCount: number;
    crossConnectionCount: number;
    durationMs: number;
    promptVersion: string;
    model: string;
    embeddingModel: string;
    promptTokens: number;
    outputTokens: number;
    totalTokens: number;
    costEstimateUsd: number;
    sessionStatus: 'success' | 'failed' | 'degraded';
    errorReason?: string | null;
  }
): Promise<void> {
  try {
    const { error } = await supabase.from('extraction_sessions').insert({
      user_id: fields.userId,
      source_name: fields.sourceName,
      source_type: fields.sourceType,
      source_id: fields.sourceId ?? null,
      source_content_preview: fields.contentPreview,
      extraction_mode: fields.extractionMode,
      anchor_emphasis: fields.anchorEmphasis,
      user_guidance: fields.userGuidance ?? null,
      selected_anchor_ids: fields.selectedAnchorIds ?? [],
      entity_count: fields.entityCount,
      relationship_count: fields.relationshipCount,
      chunk_count: fields.chunkCount,
      cross_connection_count: fields.crossConnectionCount,
      extraction_duration_ms: fields.durationMs,
      prompt_version: fields.promptVersion,
      model: fields.model,
      embedding_model: fields.embeddingModel,
      prompt_tokens: fields.promptTokens,
      output_tokens: fields.outputTokens,
      total_tokens: fields.totalTokens,
      cost_estimate_usd: fields.costEstimateUsd,
      session_status: fields.sessionStatus,
      error_reason: fields.errorReason ?? null,
    });
    if (error) console.error('[retry-source] audit-session insert failed:', error.message);
  } catch (e) {
    console.error('[retry-source] audit-session insert threw:', String(e));
  }
}

async function generateSummary(content: string): Promise<string> {
  try {
    const url = `${GEMINI_BASE}/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: 'You are a concise summarizer. Produce a 2-3 sentence summary of the following content. Focus on what was accomplished, decided, or discovered.' }] },
        contents: [{ parts: [{ text: content.slice(0, 30000) }] }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 256 },
      }),
    });
    if (!resp.ok) return '';
    const data = await resp.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    return data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  } catch {
    return '';
  }
}

async function runRetryPipeline(
  sourceId: string,
  userId: string,
  title: string,
  content: string,
  sourceType: string,
  sourceUrl: string | null,
  guidance: string | null,
  originalMetadata: Record<string, unknown>,
): Promise<void> {
  const supabase = getSupabase();
  const startTime = Date.now();
  let anchorIds: string[] = [];
  let tokenUsage: TokenAccumulator = { promptTokens: 0, outputTokens: 0, totalTokens: 0 };

  const setStatus = async (extractionStatus: string, topLevel?: string) => {
    const meta = { ...originalMetadata, extraction_status: extractionStatus, retry_started_at: new Date().toISOString() };
    const update: Record<string, unknown> = { metadata: meta };
    if (topLevel) update.status = topLevel;
    await supabase.from('knowledge_sources').update(update).eq('id', sourceId);
  };

  try {
    await setStatus('processing', 'pending');

    const rawSummary = await generateSummary(content);
    const summary = rawSummary ? stripMarkdown(rawSummary) : '';
    if (summary) {
      await supabase.from('knowledge_sources')
        .update({ summary, summary_source: 'generated' })
        .eq('id', sourceId);
    }

    const [profileResult, anchorsResult, skillsResult] = await Promise.all([
      supabase.from('user_profiles').select('*').eq('user_id', userId).maybeSingle(),
      supabase.from('knowledge_nodes')
        .select('id, label, entity_type, description')
        .eq('user_id', userId)
        .eq('is_anchor', true)
        .limit(10),
      supabase.from('knowledge_skills')
        .select('label, domain, exposure_level')
        .eq('user_id', userId)
        .eq('status', 'confirmed')
        .order('confidence', { ascending: false })
        .limit(12),
    ]);

    const userProfile = profileResult.data as UserProfile | null;
    const anchors = (anchorsResult.data ?? []) as Anchor[];
    anchorIds = (anchorsResult.data ?? []).map(a => (a as { id: string }).id);
    const activeSkills = (skillsResult.data ?? []) as PromptSkillHint[];

    const coreResult = await runExtractionCore({
      content,
      promptConfig: {
        mode: 'comprehensive',
        anchorEmphasis: 'aggressive',
        anchors,
        userProfile,
        customInstructions: guidance ?? null,
        activeSkills,
      },
      source: {
        sourceId,
        sourceType,
        sourceUrl,
        sourceLabel: title,
      },
      userId,
      supabase,
    });

    tokenUsage = coreResult.tokenUsage;
    const savedNodeIds = Array.from(coreResult.savedNodeMap.values());
    if (savedNodeIds.length > 0) {
      const appUrl = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000';
      const CRON_SECRET = process.env.CRON_SECRET;
      fetch(`${appUrl}/api/anchors/score-post-extraction`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${CRON_SECRET ?? ''}` },
        body: JSON.stringify({ userId, sourceId, nodeIds: savedNodeIds }),
      }).catch(() => {});
    }

    // ── TRIGGER SKILLS DETECTION (fire-and-forget) ───────────────────────────
    {
      const appUrl = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000';
      fetch(`${appUrl}/api/skills/process-source`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.INGEST_SECRET ?? ''}` },
        body: JSON.stringify({ user_id: userId, source_id: sourceId }),
      }).catch(() => {});
    }

    // ── TRIGGER CROSS-CONNECTION DISCOVERY (fire-and-forget) ─────────────────
    // Critical for retries: the extraction pipeline no longer runs cross-connect
    // inline, and on a retry the in-memory savedNodeMap is mostly reused entities
    // anyway. The standalone endpoint reads embeddings from the DB so it works
    // for both first-run and retry paths.
    {
      const appUrl = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000';
      fetch(`${appUrl}/api/cross-connect/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-ingest-secret': process.env.INGEST_SECRET ?? '' },
        body: JSON.stringify({ sourceId, userId }),
      }).catch(() => {});
    }

    const durationMs = Date.now() - startTime;
    await setStatus('completed', 'complete');

    // Stage 12: write success session (skip-with-telemetry).
    await writeAuditSession(supabase, {
      userId,
      sourceName: title,
      sourceType,
      sourceId,
      contentPreview: content.slice(0, 300),
      extractionMode: 'comprehensive',
      anchorEmphasis: 'aggressive',
      userGuidance: guidance,
      selectedAnchorIds: anchorIds,
      entityCount: coreResult.nodesCreated,
      relationshipCount: coreResult.edgesCreated,
      chunkCount: coreResult.chunksCreated,
      crossConnectionCount: coreResult.crossConnectionCount,
      durationMs,
      promptVersion: PROMPT_VERSION,
      model: PIPELINE_MODEL,
      embeddingModel: PIPELINE_EMBEDDING_MODEL,
      promptTokens: tokenUsage.promptTokens,
      outputTokens: tokenUsage.outputTokens,
      totalTokens: tokenUsage.totalTokens,
      costEstimateUsd: estimateCost(tokenUsage.promptTokens, tokenUsage.outputTokens),
      sessionStatus: 'success',
    });

    console.log(`[ingest/retry-source] Done: ${coreResult.nodesCreated} nodes, ${coreResult.edgesCreated} edges, ${coreResult.chunksCreated} chunks in ${durationMs}ms`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[ingest/retry-source] Failed:', msg);
    await setStatus('error', 'failed');

    // Stage 12: write failure session (skip-with-telemetry — never rethrows).
    await writeAuditSession(supabase, {
      userId,
      sourceName: title,
      sourceType,
      sourceId,
      contentPreview: content.slice(0, 300),
      extractionMode: 'comprehensive',
      anchorEmphasis: 'aggressive',
      userGuidance: guidance,
      selectedAnchorIds: anchorIds,
      entityCount: 0,
      relationshipCount: 0,
      chunkCount: 0,
      crossConnectionCount: 0,
      durationMs: Date.now() - startTime,
      promptVersion: PROMPT_VERSION,
      model: PIPELINE_MODEL,
      embeddingModel: PIPELINE_EMBEDDING_MODEL,
      promptTokens: tokenUsage.promptTokens,
      outputTokens: tokenUsage.outputTokens,
      totalTokens: tokenUsage.totalTokens,
      costEstimateUsd: estimateCost(tokenUsage.promptTokens, tokenUsage.outputTokens),
      sessionStatus: 'failed',
      errorReason: msg.slice(0, 500),
    });
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  const { userId: jwtUserId, isIngestSecret } = await resolveAuth(req);
  if (!jwtUserId && !isIngestSecret) return res.status(401).json({ error: 'unauthenticated' });

  const { sourceId } = req.body ?? {};
  if (!sourceId || typeof sourceId !== 'string') {
    return res.status(400).json({ error: 'invalid_request', detail: 'Expected { sourceId: string }' });
  }

  const supabase = getSupabase();
  const query = supabase
    .from('knowledge_sources')
    .select('id, user_id, title, content, source_type, source_url, metadata')
    .eq('id', sourceId);

  // JWT auth: enforce ownership. Ingest secret: trust the source row's user_id.
  if (jwtUserId) query.eq('user_id', jwtUserId);

  const { data: source, error } = await query.maybeSingle();
  const userId = jwtUserId ?? (source?.user_id as string | null);

  if (error || !source || !userId) {
    return res.status(404).json({ error: 'not_found' });
  }

  if (!source.content || source.content.trim().length === 0) {
    return res.status(422).json({ error: 'no_content', detail: 'Source has no content to extract from' });
  }

  const meta = (source.metadata ?? {}) as Record<string, unknown>;
  const guidance = (meta.guidance as string | null) ?? null;

  waitUntil(runRetryPipeline(
    source.id as string,
    userId,
    source.title as string,
    source.content as string,
    source.source_type as string,
    source.source_url as string | null,
    guidance,
    meta,
  ));

  return res.status(202).json({ status: 'queued', sourceId });
}
