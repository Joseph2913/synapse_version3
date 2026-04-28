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

// 300s ceiling to cover map-reduce + dedup + chunk persistence on long sources.
export const maxDuration = 300;

// ─── ENVIRONMENT ───────────────────────────────────────────────────────────────

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY!;

if (!GEMINI_API_KEY) {
  throw new Error('[gemini] Missing env var: GEMINI_API_KEY')
}
const INGEST_SECRET = process.env.INGEST_SECRET;

const getSupabase = () => createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const GEMINI_MODEL = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash'
const GEMINI_EMBEDDING_MODEL = 'gemini-embedding-001'
const MAX_CONTENT_CHARS = 100_000;

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
    if (error) {
      logError({ stage: 'audit-session', error: error.message });
    }
  } catch (e) {
    logError({ stage: 'audit-session', error: String(e) });
  }
}

// ─── Stage 2 — persistSource (GitHub session variant, inlined) ────────────────
// MCP / Claude Code session captures are URL-less. Identity is the SHA-256
// content_hash of the trimmed sliced content; the partial unique index
// `(user_id, source_type, content_hash) WHERE content_hash IS NOT NULL
// AND source_url IS NULL` catches concurrent inserts.

async function gh_sha256Hex(input: string): Promise<string> {
  const enc = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest('SHA-256', enc);
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

interface GithubPersistResult {
  sourceId: string;
  status: 'inserted' | 'skipped-duplicate';
}

async function persistGithubSessionSource(
  supabase: ReturnType<typeof getSupabase>,
  userId: string,
  insertRow: Record<string, unknown>,
  content: string,
): Promise<GithubPersistResult> {
  const contentHash = await gh_sha256Hex(content.trim());

  const { data: existing } = await supabase
    .from('knowledge_sources')
    .select('id')
    .eq('user_id', userId)
    .eq('source_type', 'github')
    .eq('content_hash', contentHash)
    .maybeSingle();
  if (existing) return { sourceId: existing.id as string, status: 'skipped-duplicate' };

  const fullRow = {
    ...insertRow,
    user_id: userId,
    source_type: 'github',
    source_url: null,
    content_hash: contentHash,
    status: 'pending',
  };
  const { data: inserted, error } = await supabase
    .from('knowledge_sources')
    .insert(fullRow)
    .select('id')
    .single();
  if (error) {
    const isRace = error.code === '23505' || /duplicate key/i.test(error.message);
    if (isRace) {
      const { data: fallback } = await supabase
        .from('knowledge_sources')
        .select('id')
        .eq('user_id', userId)
        .eq('source_type', 'github')
        .eq('content_hash', contentHash)
        .maybeSingle();
      if (fallback) return { sourceId: fallback.id as string, status: 'skipped-duplicate' };
    }
    throw new Error(`Github session insert failed: ${error.message}`);
  }
  return { sourceId: inserted.id as string, status: 'inserted' };
}

function verifyIngestSecret(req: VercelRequest): boolean {
  if (!INGEST_SECRET) return false;
  const secret = req.headers['x-ingest-secret'] as string | undefined;
  return secret === INGEST_SECRET;
}

// ─── Gemini fetch + helpers (retry on 429/5xx, token-usage logging) ─────────

interface GeminiUsage {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
}

async function geminiFetch(
  endpoint: string,
  body: unknown,
  timeoutMs: number,
  stage: string,
): Promise<{ json: unknown; usage: GeminiUsage | undefined }> {
  const url = `${GEMINI_BASE}/${endpoint}?key=${GEMINI_API_KEY}`;
  const maxAttempts = 3;
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify(body),
      });
      if (resp.ok) {
        const json = await resp.json() as { usageMetadata?: GeminiUsage };
        const usage = json.usageMetadata;
        if (usage) {
          console.log(JSON.stringify({
            stage, model: endpoint.split(':')[0],
            prompt_tokens: usage.promptTokenCount,
            output_tokens: usage.candidatesTokenCount,
            total_tokens: usage.totalTokenCount,
          }));
        }
        return { json, usage };
      }
      const txt = await resp.text().catch(() => '');
      lastErr = new Error(`Gemini ${resp.status}: ${txt.slice(0, 200)}`);
      if ((resp.status === 429 || resp.status >= 500) && attempt < maxAttempts - 1) {
        await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 1000));
        continue;
      }
      throw lastErr;
    } catch (err) {
      lastErr = err as Error;
      if (attempt < maxAttempts - 1) {
        await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 1000));
        continue;
      }
      throw lastErr;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr ?? new Error('[gemini] request failed');
}

async function generateSummary(content: string): Promise<string> {
  try {
    const { json } = await geminiFetch(
      `${GEMINI_MODEL}:generateContent`,
      {
        system_instruction: { parts: [{ text: 'You are a concise summarizer. Produce a 2-3 sentence summary of the following content. Focus on what was accomplished, decided, or discovered.' }] },
        contents: [{ parts: [{ text: content.slice(0, 30000) }] }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 256 },
      },
      15000,
      'ingest:session:summary',
    );
    const data = json as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    return data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  } catch {
    return '';
  }
}
// ─── BACKGROUND PIPELINE ──────────────────────────────────────────────────────

async function runExtractionPipeline(params: {
  sourceId: string;
  userId: string;
  title: string;
  content: string;
  guidance?: string;
  metadata: Record<string, unknown>;
}): Promise<void> {
  const { sourceId, userId, title, content, guidance, metadata } = params;
  const startTime = Date.now();
  const supabase = getSupabase();
  let anchorIds: string[] = [];
  let tokenUsage: TokenAccumulator = { promptTokens: 0, outputTokens: 0, totalTokens: 0 };

  const updateStatus = async (status: string, extra?: Record<string, unknown>) => {
    const meta = { ...metadata, extraction_status: status, ...extra };
    const topLevelStatus = status === 'completed' ? 'complete' : status === 'error' ? 'failed' : undefined;
    const update: Record<string, unknown> = { metadata: meta };
    if (topLevelStatus) update.status = topLevelStatus;
    await supabase.from('knowledge_sources').update(update).eq('id', sourceId);
  };

  try {
    await updateStatus('processing', { processing_started_at: new Date().toISOString() });

    // ── STEP 2: GENERATE SUMMARY ────────────────────────────────────────────
    const rawSummary = await generateSummary(content);
    const summary = rawSummary ? stripMarkdown(rawSummary) : '';
    if (summary) {
      await supabase
        .from('knowledge_sources')
        .update({ summary, summary_source: 'generated' })
        .eq('id', sourceId);
    }

    // ── STEPS 3-9: SHARED EXTRACTION PIPELINE ───────────────────────────────
    // Entity extraction, dedup, node+edge persistence, chunking, and cross-
    // connection discovery all live in api/_shared/extract-pipeline.ts.
    const [profileResult, anchorsResult, skillsResult] = await Promise.all([
      supabase.from('user_profiles').select('*').eq('user_id', userId).maybeSingle(),
      supabase
        .from('knowledge_nodes')
        .select('id, label, entity_type, description')
        .eq('user_id', userId)
        .eq('is_anchor', true)
        .limit(10),
      supabase
        .from('knowledge_skills')
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

    // Manual capture sessions always run the most aggressive mode because
    // the user deliberately invoked ingestion — they want everything pulled
    // out and connected back to their anchors.
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
        // The HTTP handler hardcodes source_type 'GitHub' when it inserts
        // the knowledge_sources row (these are Claude Code sessions routed
        // through a GitHub-tagged endpoint). Mirror that on nodes so
        // source_type is consistent between source row and its nodes.
        sourceType: 'github',
        sourceUrl: (metadata['source_url'] as string | null) ?? null,
        sourceLabel: title,
      },
      userId,
      supabase,
    });

    const { savedNodeMap, nodesCreated, edgesCreated, crossConnectionCount, chunksCreated } = coreResult;
    tokenUsage = coreResult.tokenUsage;


    // ── STEP 10: TRIGGER ANCHOR SCORING (fire-and-forget) ───────────────────
    const savedNodeIds = Array.from(savedNodeMap.values());
    if (savedNodeIds.length > 0) {
      const appUrl = process.env.VERCEL_URL
        ? `https://${process.env.VERCEL_URL}`
        : 'http://localhost:3000';
      const CRON_SECRET = process.env.CRON_SECRET;

      fetch(`${appUrl}/api/anchors/score-post-extraction`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${CRON_SECRET ?? ''}`,
        },
        body: JSON.stringify({ userId, sourceId, nodeIds: savedNodeIds }),
      }).catch(err => {
        console.warn('[ingest/session] Anchor scoring trigger failed (non-fatal):', err);
      });
    }

    // ── STEP 10: TRIGGER SKILLS DETECTION (fire-and-forget) ─────────────────
    {
      const appUrl = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000';
      fetch(`${appUrl}/api/skills/process-source`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.INGEST_SECRET ?? ''}` },
        body: JSON.stringify({ user_id: userId, source_id: sourceId }),
      }).catch(err => { console.warn('[ingest/session] Skills detection trigger failed (non-fatal):', err); });
    }

    // ── COMPLETE ────────────────────────────────────────────────────────────
    const durationMs = Date.now() - startTime;
    await updateStatus('completed', {
      processing_completed_at: new Date().toISOString(),
      duration_ms: durationMs,
    });

    // Stage 12: write success session (skip-with-telemetry).
    await writeAuditSession(supabase, {
      userId,
      sourceName: title,
      sourceType: 'github',
      sourceId,
      contentPreview: content.slice(0, 300),
      extractionMode: 'comprehensive',
      anchorEmphasis: 'aggressive',
      userGuidance: guidance ?? null,
      selectedAnchorIds: anchorIds,
      entityCount: nodesCreated,
      relationshipCount: edgesCreated,
      chunkCount: chunksCreated,
      crossConnectionCount,
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

    console.log(`[ingest/session] Complete: ${nodesCreated} nodes, ${edgesCreated} edges (${crossConnectionCount} cross), ${chunksCreated} chunks in ${durationMs}ms`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[ingest/session] Pipeline error:', err);
    await updateStatus('error', {
      error: msg,
      failed_at: new Date().toISOString(),
    }).catch(() => { /* best-effort status update */ });

    // Stage 12: write failure session (skip-with-telemetry — never rethrows).
    await writeAuditSession(supabase, {
      userId,
      sourceName: title,
      sourceType: 'github',
      sourceId,
      contentPreview: content.slice(0, 300),
      extractionMode: 'comprehensive',
      anchorEmphasis: 'aggressive',
      userGuidance: guidance ?? null,
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

// ─── HANDLER ───────────────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-ingest-secret');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!verifyIngestSecret(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const {
    userId,
    title,
    content,
    repo,
    branch,
    guidance,
  } = req.body as {
    userId: string;
    title: string;
    content: string;
    repo?: string;
    branch?: string;
    guidance?: string;
  };

  if (!userId || !title || !content) {
    return res.status(400).json({ error: 'Missing required fields: userId, title, content' });
  }

  const supabase = getSupabase();

  try {
    // ── STEP 1: SAVE SOURCE ──────────────────────────────────────────────────
    const metadata: Record<string, unknown> = {
      ingested_via: 'mcp_session',
      extraction_status: 'accepted',
      repo: repo ?? null,
      branch: branch ?? null,
      guidance: guidance ?? null,
      session_date: new Date().toISOString(),
    };

    const slicedContent = content.slice(0, MAX_CONTENT_CHARS);
    let persistResult: GithubPersistResult;
    try {
      persistResult = await persistGithubSessionSource(
        supabase,
        userId,
        { title, content: slicedContent, metadata },
        slicedContent,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to save source: ${msg}`);
    }
    const sourceId = persistResult.sourceId;
    log({
      stage: 'persist',
      user_id: userId,
      source_id: sourceId,
      source_type: 'github',
      result: persistResult.status,
      status: persistResult.status === 'skipped-duplicate' ? 'skipped' : 'ok',
    });
    console.log(`[ingest/session] Saved source "${title}" (${sourceId}) for user ${userId}, dispatching background pipeline`);

    // Fire extraction pipeline in background via waitUntil
    waitUntil(runExtractionPipeline({
      sourceId,
      userId,
      title,
      content: content.slice(0, MAX_CONTENT_CHARS),
      guidance,
      metadata,
    }));

    return res.status(202).json({
      source_id: sourceId,
      title,
      status: 'processing',
      message: 'Source accepted. Extraction pipeline running in background.',
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[ingest/session] Error:', err);
    return res.status(500).json({
      success: false,
      error: msg,
    });
  }
}
