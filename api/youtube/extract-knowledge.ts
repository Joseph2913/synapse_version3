import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';
import {
  MAX_TRANSCRIPT_CHARS,
  runExtractionCore,
  PROMPT_VERSION,
  PIPELINE_MODEL,
  PIPELINE_EMBEDDING_MODEL,
  type Anchor,
  type UserProfile,
  type PromptSkillHint,
  type TokenAccumulator,
} from '../pipeline/extract-pipeline.js';

// 300s — map-reduce extraction runs windows in parallel but dedup + chunk
// saves + cross-connection discovery still add time. 300s is the Vercel Pro
// ceiling and matches rescore-backfill / nodes/merge-duplicates / compute-layout.
export const maxDuration = 300;

// ─── ENVIRONMENT ───────────────────────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY!;

if (!GEMINI_API_KEY) {
  throw new Error('[gemini] Missing env var: GEMINI_API_KEY')
}
const CRON_SECRET = process.env.CRON_SECRET;

const getSupabase = () => createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

const GEMINI_MODEL = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash'
const GEMINI_EMBEDDING_MODEL = 'gemini-embedding-001'
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


// ─── Structured logging ─────────────────────────────────────────────────────

type LogStatus = 'ok' | 'failed' | 'partial' | 'skipped'

interface LogFields {
  stage: string
  user_id?: string
  source_id?: string
  duration_ms?: number
  status?: LogStatus
  error?: string
  [k: string]: unknown
}

function log(fields: LogFields): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...fields }))
}

function logError(fields: LogFields & { error: string }): void {
  console.error(JSON.stringify({ ts: new Date().toISOString(), level: 'error', ...fields }))
}

// ─── Gemini fetch helper (retry on 429/5xx, token-usage logging) ────────────

interface GeminiUsage {
  promptTokenCount?: number
  candidatesTokenCount?: number
  totalTokenCount?: number
}

async function geminiFetch(
  endpoint: string,
  body: unknown,
  timeoutMs: number,
  stage: string
): Promise<{ json: unknown; usage: GeminiUsage | undefined }> {
  const url = `${GEMINI_BASE}/${endpoint}?key=${GEMINI_API_KEY}`
  const maxAttempts = 3
  let lastErr: Error | null = null
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify(body),
      })
      if (resp.ok) {
        const json = await resp.json() as { usageMetadata?: GeminiUsage }
        const usage = json.usageMetadata
        if (usage) {
          console.log(JSON.stringify({
            stage, model: endpoint.split(':')[0],
            prompt_tokens: usage.promptTokenCount,
            output_tokens: usage.candidatesTokenCount,
            total_tokens: usage.totalTokenCount,
          }))
        }
        return { json, usage }
      }
      const txt = await resp.text().catch(() => '')
      lastErr = new Error(`Gemini ${resp.status}: ${txt.slice(0, 200)}`)
      if ((resp.status === 429 || resp.status >= 500) && attempt < maxAttempts - 1) {
        await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 1000))
        continue
      }
      throw lastErr
    } catch (err) {
      lastErr = err as Error
      if (attempt < maxAttempts - 1) {
        await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 1000))
        continue
      }
      throw lastErr
    } finally {
      clearTimeout(timer)
    }
  }
  throw lastErr ?? new Error('[gemini] request failed')
}

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

// ─── Stage 2 — persistSource (YouTube variant, inlined) ────────────────────
//
// Identity rule for YouTube sources is the canonical watch URL
// `https://www.youtube.com/watch?v=<videoId>` written to source_url. The
// existing partial unique index `(user_id, source_type, source_url) WHERE
// source_url IS NOT NULL` is the safety net against concurrent inserts. The
// cron's wipe-and-rerun semantics live in extractKnowledgeForItem() and are
// kept outside persistSource() — Stage 2 only owns the row identity.

const YT_VIDEO_ID = /^[a-zA-Z0-9_-]{11}$/;
const YT_HOST_RE = /(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)$/i;

function extractYouTubeVideoId(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (YT_VIDEO_ID.test(trimmed)) return trimmed;
  let url: URL;
  try { url = new URL(trimmed); } catch { return null; }
  if (!YT_HOST_RE.test(url.hostname)) return null;
  const v = url.searchParams.get('v');
  if (v && YT_VIDEO_ID.test(v)) return v;
  const segments = url.pathname.split('/').filter(Boolean);
  if (url.hostname.replace(/^www\./, '') === 'youtu.be') {
    const id = segments[0];
    return id && YT_VIDEO_ID.test(id) ? id : null;
  }
  if (segments.length >= 2) {
    const head = segments[0]?.toLowerCase();
    const id = segments[1];
    if ((head === 'embed' || head === 'shorts' || head === 'v') && id && YT_VIDEO_ID.test(id)) return id;
  }
  return null;
}

function canonicalYouTubeUrl(input: string): string {
  const id = extractYouTubeVideoId(input);
  return id ? `https://www.youtube.com/watch?v=${id}` : input.trim();
}

interface YoutubePersistResult {
  sourceId: string;
  status: 'inserted' | 'replaced' | 'skipped-duplicate';
}

async function persistYouTubeSource(
  supabase: ReturnType<typeof getSupabase>,
  userId: string,
  sourcePayload: {
    title: string;
    source_url: string;
    content: string;
    metadata: Record<string, unknown>;
  },
): Promise<YoutubePersistResult> {
  const canonicalUrl = canonicalYouTubeUrl(sourcePayload.source_url);

  // ── 1. Lookup by canonical URL.
  const { data: existing } = await supabase
    .from('knowledge_sources')
    .select('id')
    .eq('user_id', userId)
    .eq('source_type', 'youtube')
    .eq('source_url', canonicalUrl)
    .maybeSingle();

  if (existing) {
    // Cron re-runs intentionally refresh the row + clear prior nodes/edges so
    // re-extraction starts clean. status reset to 'pending' so downstream
    // stages re-execute.
    const { error: updErr } = await supabase
      .from('knowledge_sources')
      .update({
        title: sourcePayload.title,
        source_url: canonicalUrl,
        content: sourcePayload.content,
        metadata: sourcePayload.metadata,
        status: 'pending',
      })
      .eq('id', existing.id);
    if (updErr) throw new Error(`YouTube replace failed: ${updErr.message}`);
    return { sourceId: existing.id as string, status: 'replaced' };
  }

  // ── 2. Insert. Catch error 23505 race and re-fetch.
  const insertRow = {
    user_id: userId,
    title: sourcePayload.title,
    source_type: 'youtube',
    source_url: canonicalUrl,
    content: sourcePayload.content,
    metadata: sourcePayload.metadata,
    status: 'pending',
  };
  const { data: inserted, error } = await supabase
    .from('knowledge_sources')
    .insert(insertRow)
    .select('id')
    .single();

  if (error) {
    const isRace = error.code === '23505' || /duplicate key/i.test(error.message);
    if (isRace) {
      const { data: fallback } = await supabase
        .from('knowledge_sources')
        .select('id')
        .eq('user_id', userId)
        .eq('source_type', 'youtube')
        .eq('source_url', canonicalUrl)
        .maybeSingle();
      if (fallback) return { sourceId: fallback.id as string, status: 'skipped-duplicate' };
    }
    throw new Error(`YouTube insert failed: ${error.message}`);
  }
  return { sourceId: inserted.id as string, status: 'inserted' };
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

// ─── STAGE 12 — AUDIT SESSION HELPERS ────────────────────────────────────────
// Gemini 2.5 Flash pricing at 2026-04-28.
const COST_INPUT_PER_TOKEN = 0.075 / 1_000_000;
const COST_OUTPUT_PER_TOKEN = 0.30 / 1_000_000;

function estimateCost(promptTokens: number, outputTokens: number): number {
  return promptTokens * COST_INPUT_PER_TOKEN + outputTokens * COST_OUTPUT_PER_TOKEN;
}

/** Write an extraction session row. Never throws — Stage 12 is Skip-with-telemetry. */
async function writeAuditSession(
  supabase: ReturnType<typeof getSupabase>,
  fields: {
    userId: string;
    sourceName: string;
    sourceType: string;
    sourceId?: string;
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
    const row: Record<string, unknown> = {
      user_id: fields.userId,
      source_name: fields.sourceName,
      source_type: fields.sourceType,
      source_content_preview: fields.contentPreview.slice(0, 300),
      extraction_mode: fields.extractionMode,
      anchor_emphasis: fields.anchorEmphasis,
      entity_count: fields.entityCount,
      relationship_count: fields.relationshipCount,
      chunk_count: fields.chunkCount,
      cross_connection_count: fields.crossConnectionCount,
      extraction_duration_ms: fields.durationMs,
      prompt_version: fields.promptVersion,
      model: fields.model,
      embedding_model: fields.embeddingModel,
      prompt_tokens: fields.promptTokens || null,
      output_tokens: fields.outputTokens || null,
      total_tokens: fields.totalTokens || null,
      cost_estimate_usd: fields.costEstimateUsd || null,
      session_status: fields.sessionStatus,
    };
    if (fields.sourceId) row.source_id = fields.sourceId;
    if (fields.userGuidance) row.user_guidance = fields.userGuidance;
    if (fields.selectedAnchorIds?.length) row.selected_anchor_ids = fields.selectedAnchorIds;
    if (fields.errorReason) row.error_reason = fields.errorReason;
    const { error } = await supabase.from('extraction_sessions').insert(row);
    if (error) {
      logError({ stage: 'audit', user_id: fields.userId, status: 'skipped', error: error.message });
    }
  } catch (err) {
    logError({ stage: 'audit', user_id: fields.userId, status: 'skipped', error: String(err) });
  }
}

// ─── MAIN EXTRACTION LOGIC ─────────────────────────────────────────────────────

async function extractKnowledgeForItem(
  item: QueueItem,
  supabase: ReturnType<typeof getSupabase>,
  itemStartTime: number
): Promise<{ success: boolean; nodesCreated: number; edgesCreated: number; error?: string }> {
  const transcript = item.transcript;

  // Guard: videos that never got a usable transcript (YouTube caption API
  // returned nothing) can't be extracted. Fail them fast with a clear reason
  // instead of crashing inside the shared extractor on a null slice.
  if (!transcript || transcript.trim().length < 50) {
    await supabase
      .from('youtube_ingestion_queue')
      .update({
        status: 'failed',
        error_message: 'No usable transcript (video has no captions or transcript fetch failed)',
        completed_at: new Date().toISOString(),
      })
      .eq('id', item.id);
    return { success: false, nodesCreated: 0, edgesCreated: 0, error: 'No transcript' };
  }

  // Stage 12: declare audit vars outside try so the catch block can reference them.
  let sourceId: string | undefined;
  let extractionMode = item.extraction_mode ?? 'comprehensive';
  let anchorEmphasis = item.anchor_emphasis ?? 'standard';
  let tokenUsage: TokenAccumulator = { promptTokens: 0, outputTokens: 0, totalTokens: 0 };

  try {
    // Note: status is already 'extracting' with started_at set — the atomic
    // claim RPC (claim_youtube_extraction_batch) does that in the same query
    // that returned this item, so no separate UPDATE is needed here.

    // ── STEP 1: SAVE SOURCE (Stage 2 persistSource) ─────────────────────────
    // persistYouTubeSource() owns the canonical-URL identity and the partial
    // unique index race fallback. On a re-run for the same video it returns
    // status='replaced' and resets knowledge_sources.status to 'pending'.
    const persistResult = await persistYouTubeSource(supabase, item.user_id, {
      title: item.video_title ?? `YouTube: ${item.video_id}`,
      source_url: item.video_url,
      content: transcript.slice(0, MAX_TRANSCRIPT_CHARS),
      metadata: {
        video_id: item.video_id,
        duration_seconds: item.duration_seconds,
        published_at: item.published_at,
        transcript_source: 'decoupled_pipeline',
      },
    });
    sourceId = persistResult.sourceId;

    // For replays, wipe prior nodes/edges so re-extraction starts clean.
    if (persistResult.status === 'replaced') {
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
    }
    log({
      stage: 'persist',
      user_id: item.user_id,
      source_id: sourceId,
      source_type: 'youtube',
      result: persistResult.status,
      status: persistResult.status === 'skipped-duplicate' ? 'skipped' : 'ok',
    });

    await supabase
      .from('youtube_ingestion_queue')
      .update({ source_id: sourceId })
      .eq('id', item.id);

    // ── STEPS 2-7: SHARED EXTRACTION PIPELINE ──────────────────────────────────
    // Entity extraction, dedup, node+edge persistence, chunking, and cross-
    // connection discovery all live in api/_shared/extract-pipeline.ts. Every
    // source-type ingestion route calls the same core, so rate-limit fixes and
    // dedup improvements apply everywhere at once.
    const [profileResult, anchorsResult, settingsResult, skillsResult] = await Promise.all([
      supabase.from('user_profiles').select('*').eq('user_id', item.user_id).maybeSingle(),
      supabase
        .from('knowledge_nodes')
        .select('label, entity_type, description')
        .eq('user_id', item.user_id)
        .eq('is_anchor', true)
        .limit(10),
      supabase.from('extraction_settings').select('default_mode, default_anchor_emphasis').eq('user_id', item.user_id).maybeSingle(),
      supabase
        .from('knowledge_skills')
        .select('label, domain, exposure_level')
        .eq('user_id', item.user_id)
        .eq('status', 'confirmed')
        .order('confidence', { ascending: false })
        .limit(12),
    ]);

    const userProfile = profileResult.data as UserProfile | null;
    const anchors = (anchorsResult.data ?? []) as Anchor[];
    const defaultSettings = settingsResult.data as { default_mode: string; default_anchor_emphasis: string } | null;
    const activeSkills = (skillsResult.data ?? []) as PromptSkillHint[];

    extractionMode = item.extraction_mode ?? defaultSettings?.default_mode ?? 'comprehensive';
    anchorEmphasis = item.anchor_emphasis ?? defaultSettings?.default_anchor_emphasis ?? 'standard';

    const coreResult = await runExtractionCore({
      content: transcript,
      promptConfig: {
        mode: extractionMode,
        anchorEmphasis,
        anchors,
        userProfile,
        customInstructions: item.custom_instructions,
        activeSkills,
      },
      source: {
        sourceId,
        sourceType: 'youtube',
        sourceUrl: item.video_url,
        sourceLabel: item.video_title ?? item.video_id,
      },
      userId: item.user_id,
      supabase,
      options: { itemStartTime },
    });

    const { savedNodeMap, nodesCreated, edgesCreated, crossConnectionCount, chunksCreated } = coreResult;
    tokenUsage = coreResult.tokenUsage;

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

    // Stage 12: write audit session (skip-with-telemetry — never blocks extraction).
    await writeAuditSession(supabase, {
      userId: item.user_id,
      sourceName: item.video_title ?? item.video_id,
      sourceType: 'youtube',
      sourceId,
      contentPreview: transcript.slice(0, 300),
      extractionMode,
      anchorEmphasis,
      userGuidance: item.custom_instructions ?? null,
      selectedAnchorIds: item.linked_anchor_ids ?? [],
      entityCount: nodesCreated,
      relationshipCount: edgesCreated,
      chunkCount: chunksCreated,
      crossConnectionCount,
      durationMs: Date.now() - itemStartTime,
      promptVersion: PROMPT_VERSION,
      model: PIPELINE_MODEL,
      embeddingModel: PIPELINE_EMBEDDING_MODEL,
      promptTokens: tokenUsage.promptTokens,
      outputTokens: tokenUsage.outputTokens,
      totalTokens: tokenUsage.totalTokens,
      costEstimateUsd: estimateCost(tokenUsage.promptTokens, tokenUsage.outputTokens),
      sessionStatus: 'success',
    });

    // Update daily counter (skip-with-telemetry — counter is non-essential)
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
    } catch (err) {
      logError({
        stage: 'capture:youtube:counter',
        user_id: item.user_id,
        status: 'skipped',
        error: err instanceof Error ? err.message : String(err),
      });
    }

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

    // ── TRIGGER SKILLS DETECTION (fire-and-forget) ─────────────────────────────
    {
      const appUrl = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000';
      fetch(`${appUrl}/api/skills/process-source`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.INGEST_SECRET ?? ''}` },
        body: JSON.stringify({ user_id: item.user_id, source_id: sourceId }),
      }).catch(err => { console.warn('[extract-knowledge] Skills detection trigger failed (non-fatal):', err); });
    }

    // ── TRIGGER CROSS-CONNECTION DISCOVERY (fire-and-forget) ───────────────────
    // Stage 8 used to run inline inside runExtractionCore but blew past its 50s
    // time budget on long sources after the v2 map-reduce pipeline shipped. Now
    // it runs as an independent background job that reads embeddings from the
    // DB, so it works equally well on first-run and retried sources.
    {
      const appUrl = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000';
      fetch(`${appUrl}/api/cross-connect/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-ingest-secret': process.env.INGEST_SECRET ?? '' },
        body: JSON.stringify({ sourceId, userId: item.user_id }),
      }).catch(err => { console.warn('[extract-knowledge] Cross-connect trigger failed (non-fatal):', err); });
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

    // Stage 12: write failure session (skip-with-telemetry — never rethrows).
    await writeAuditSession(supabase, {
      userId: item.user_id,
      sourceName: item.video_title ?? item.video_id,
      sourceType: 'youtube',
      sourceId,
      contentPreview: transcript.slice(0, 300),
      extractionMode,
      anchorEmphasis,
      userGuidance: item.custom_instructions ?? null,
      selectedAnchorIds: item.linked_anchor_ids ?? [],
      entityCount: 0,
      relationshipCount: 0,
      chunkCount: 0,
      crossConnectionCount: 0,
      durationMs: Date.now() - itemStartTime,
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
//   6. (retired) Cross-domain signal detection — see Phase 0 of council cron
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
    const { json: geminiData } = await geminiFetch(
      `${GEMINI_MODEL}:generateContent`,
      {
        contents: [{ parts: [{ text: analysisPrompt }] }],
        generationConfig: {
          temperature: 0.1,
          responseMimeType: 'application/json',
        },
      },
      30000,
      'youtube:extract-knowledge:advisory'
    );
    const data = geminiData as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (text) {
      analysis = JSON.parse(text) as AdvisoryAnalysisResult;
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

  // ── Step 6: Cross-domain signal detection retired ────────────────────────
  // The `agent_signals` table has been dropped. Cross-agent connections now
  // surface as `novel_connection` insights produced by Phase 0 of the nightly
  // council cron, which re-runs answer checks against new chunks.

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

    // Fire-and-forget: trigger an immediate async rebuild of the next stale
    // council agent after the batch completes. Any stale flags were set per-item
    // inside processAdvisoryCouncilHook. Mirrors the cross-connect pattern.
    if (processed > 0) {
      const appUrl = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000'
      fetch(`${appUrl}/api/council/rebuild-agent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.CRON_SECRET ?? ''}` },
        body: JSON.stringify({ next_stale: true }),
      }).catch(() => { /* fire-and-forget */ })
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
