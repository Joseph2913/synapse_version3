import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';
import { waitUntil } from '@vercel/functions';
import {
  runExtractionCore,
  fetchWithRetry,
  stripMarkdown,
  type Anchor,
  type UserProfile,
} from '../_pipeline/extract-pipeline';

// Allow up to 120s on Vercel Pro (Gemini extraction + embeddings)
export const maxDuration = 120;

// ─── ENVIRONMENT ───────────────────────────────────────────────────────────────

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY!;
const INGEST_SECRET = process.env.INGEST_SECRET;

const getSupabase = () => createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const MAX_CONTENT_CHARS = 100_000;

// ─── AUTH ──────────────────────────────────────────────────────────────────────

function verifyIngestSecret(req: VercelRequest): boolean {
  if (!INGEST_SECRET) return false;
  const secret = req.headers['x-ingest-secret'] as string | undefined;
  return secret === INGEST_SECRET;
}

async function generateSummary(content: string): Promise<string> {
  const response = await fetchWithRetry(
    `${GEMINI_BASE}/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: 'You are a concise summarizer. Produce a 2-3 sentence summary of the following content. Focus on what was accomplished, decided, or discovered.' }] },
        contents: [{ parts: [{ text: content.slice(0, 30000) }] }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 256 },
      }),
      signal: AbortSignal.timeout(15000),
    }
  );
  if (!response.ok) return '';
  const data = await response.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  return data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
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

  const updateStatus = async (status: string, extra?: Record<string, unknown>) => {
    const meta = { ...metadata, extraction_status: status, ...extra };
    await supabase.from('knowledge_sources').update({ metadata: meta }).eq('id', sourceId);
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
    const [profileResult, anchorsResult] = await Promise.all([
      supabase.from('user_profiles').select('*').eq('user_id', userId).maybeSingle(),
      supabase
        .from('knowledge_nodes')
        .select('label, entity_type, description')
        .eq('user_id', userId)
        .eq('is_anchor', true)
        .limit(10),
    ]);

    const userProfile = profileResult.data as UserProfile | null;
    const anchors = (anchorsResult.data ?? []) as Anchor[];

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
      },
      source: {
        sourceId,
        // The HTTP handler hardcodes source_type 'GitHub' when it inserts
        // the knowledge_sources row (these are Claude Code sessions routed
        // through a GitHub-tagged endpoint). Mirror that on nodes so
        // source_type is consistent between source row and its nodes.
        sourceType: 'GitHub',
        sourceUrl: (metadata['source_url'] as string | null) ?? null,
        sourceLabel: title,
      },
      userId,
      supabase,
    });

    const { savedNodeMap, nodesCreated, edgesCreated, crossConnectionCount, chunksCreated } = coreResult;


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

    // ── COMPLETE ────────────────────────────────────────────────────────────
    await updateStatus('completed', {
      processing_completed_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
    });

    console.log(`[ingest/session] Complete: ${nodesCreated} nodes, ${edgesCreated} edges (${crossConnectionCount} cross), ${chunksCreated} chunks in ${Date.now() - startTime}ms`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[ingest/session] Pipeline error:', err);
    await updateStatus('error', {
      error: msg,
      failed_at: new Date().toISOString(),
    }).catch(() => { /* best-effort status update */ });
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

    const { data: sourceData, error: sourceError } = await supabase
      .from('knowledge_sources')
      .insert({
        user_id: userId,
        title,
        source_type: 'GitHub',
        content: content.slice(0, MAX_CONTENT_CHARS),
        metadata,
      })
      .select('id')
      .single();

    if (sourceError) {
      throw new Error(`Failed to save source: ${sourceError.message}`);
    }

    const sourceId = (sourceData as { id: string }).id;
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
