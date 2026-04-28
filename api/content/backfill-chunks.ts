import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// Allow up to 300s on Vercel Pro (batch embedding can be slow)
export const maxDuration = 300;

// ─── Supabase env + factories ────────────────────────────────────────────────

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY!;
const CRON_SECRET = process.env.CRON_SECRET;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('[supabase] Missing env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY');
}
if (!GEMINI_API_KEY) {
  throw new Error('[gemini] Missing env var: GEMINI_API_KEY');
}

function getServiceSupabase(): SupabaseClient {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
}

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const GEMINI_EMBEDDING_MODEL = 'gemini-embedding-001';
const EMBEDDING_BATCH_SIZE = 100;

// ─── Structured logging ─────────────────────────────────────────────────────

type LogStatus = 'ok' | 'failed' | 'partial' | 'skipped';

interface LogFields {
  stage: string;
  user_id?: string;
  source_id?: string;
  duration_ms?: number;
  status?: LogStatus;
  error?: string;
  [k: string]: unknown;
}

function log(fields: LogFields): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...fields }));
}

function logError(fields: LogFields & { error: string }): void {
  console.error(JSON.stringify({ ts: new Date().toISOString(), level: 'error', ...fields }));
}

function verifyAuth(req: VercelRequest): boolean {
  if (req.headers['x-vercel-signature']) return true;
  if (!CRON_SECRET) return true;
  const auth = req.headers['authorization'];
  return !!(auth && auth === `Bearer ${CRON_SECRET}`);
}

// ─── CHUNKING (paste-in copy of src/utils/chunking.ts) ─────────────────────
// If this changes, also update src/utils/chunking.ts and api/pipeline/extract-pipeline.ts.

const CHUNK_TARGET_CHARS = 2000;
const CHUNK_OVERLAP_CHARS = 100;
const CHUNK_MAX_CHARS = 3000;

const ABBREVIATIONS = [
  'Dr', 'Mr', 'Mrs', 'Ms', 'Prof', 'Sr', 'Jr', 'St',
  'vs', 'etc', 'e.g', 'i.e', 'U.S', 'U.K', 'U.N',
  'No', 'Inc', 'Ltd', 'Co', 'Corp', 'Fig', 'cf', 'al',
];
const DOT_SENTINEL = String.fromCharCode(0xE000);
const ABBREV_RE = new RegExp(
  '\\b(' + ABBREVIATIONS.map(a => a.replace(/\./g, '\\.')).join('|') + ')\\.',
  'g',
);

function splitSentences(text: string): string[] {
  const masked = text.replace(ABBREV_RE, (_, a) => `${a}${DOT_SENTINEL}`);
  const parts = masked.split(/(?<=[.!?])\s+(?=["'(\[]?[A-Z0-9])/g);
  return parts.map(p => p.split(DOT_SENTINEL).join('.').trim()).filter(Boolean);
}

function splitSections(text: string): string[] {
  const lines = text.split('\n');
  const sections: string[] = [];
  let buf: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    const isHeading = /^#{1,6}\s/.test(line);
    const isRule = /^[-_*]{3,}$/.test(trimmed);
    if (isHeading || isRule) {
      if (buf.length) sections.push(buf.join('\n').trim());
      buf = [line];
    } else {
      buf.push(line);
    }
  }
  if (buf.length) sections.push(buf.join('\n').trim());
  return sections.filter(s => s.length > 0);
}

function splitParagraphs(text: string): string[] {
  return text.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
}

function chunkText(
  content: string,
  targetChars: number = CHUNK_TARGET_CHARS,
  overlapChars: number = CHUNK_OVERLAP_CHARS,
  maxChars: number = CHUNK_MAX_CHARS,
): string[] {
  if (!content || !content.trim()) return [];
  const units: string[] = [];
  for (const section of splitSections(content)) {
    for (const para of splitParagraphs(section)) {
      if (para.length <= targetChars) {
        units.push(para);
        continue;
      }
      for (const sent of splitSentences(para)) {
        if (sent.length <= maxChars) {
          units.push(sent);
        } else {
          for (let i = 0; i < sent.length; i += targetChars) {
            units.push(sent.slice(i, i + targetChars));
          }
        }
      }
    }
  }
  const chunks: string[] = [];
  let current = '';
  for (const unit of units) {
    const sep = current ? '\n\n' : '';
    if (current.length + sep.length + unit.length > targetChars && current.length > 0) {
      chunks.push(current.trim());
      const overlapStart = Math.max(0, current.length - overlapChars);
      current = current.substring(overlapStart).trim() + '\n\n' + unit;
    } else {
      current += sep + unit;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  const merged: string[] = [];
  for (const c of chunks) {
    if (merged.length > 0 && c.length < 200) {
      merged[merged.length - 1] += '\n\n' + c;
    } else {
      merged.push(c);
    }
  }
  return merged.filter(c => c.length > 0);
}

function buildChunkEmbeddingInput(title: string | null | undefined, chunkContent: string): string {
  const t = (title ?? '').trim();
  return t ? `${t}\n\n${chunkContent}` : chunkContent;
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
        const json = (await resp.json()) as { usageMetadata?: GeminiUsage };
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

// ─── EMBEDDING (canonical batch helper) ────────────────────────────────────

async function embedTexts(texts: string[], timeoutMs = 60000, stage = 'content:backfill-chunks'): Promise<number[][]> {
  if (texts.length === 0) return [];
  const out: number[][] = [];
  for (let start = 0; start < texts.length; start += EMBEDDING_BATCH_SIZE) {
    const slice = texts.slice(start, start + EMBEDDING_BATCH_SIZE);
    const { json } = await geminiFetch(
      `${GEMINI_EMBEDDING_MODEL}:batchEmbedContents`,
      {
        requests: slice.map(text => ({
          model: `models/${GEMINI_EMBEDDING_MODEL}`,
          content: { parts: [{ text }] },
        })),
      },
      timeoutMs,
      stage,
    );
    const data = json as { embeddings?: Array<{ values?: number[] }> };
    const vectors = (data.embeddings ?? []).map(e => e.values ?? []);
    if (vectors.length !== slice.length) {
      throw new Error(`Batch embedding length mismatch: ${vectors.length} vs ${slice.length}`);
    }
    out.push(...vectors);
  }
  return out;
}

// ─── BACKFILL ──────────────────────────────────────────────────────────────

interface SourceRow {
  id: string;
  user_id: string;
  content: string;
  title: string | null;
  status: string | null;
}

interface BackfillResult {
  sourceId: string;
  title: string | null;
  outcome: 'backfilled' | 'no_chunks' | 'failed' | 'degraded';
  chunksCreated: number;
  error?: string;
}

async function processSource(
  source: SourceRow,
  supabase: SupabaseClient,
): Promise<BackfillResult> {
  const chunks = chunkText(source.content);
  if (chunks.length === 0) {
    return {
      sourceId: source.id,
      title: source.title,
      outcome: 'no_chunks',
      chunksCreated: 0,
    };
  }

  let embeddings: number[][];
  try {
    const inputs = chunks.map(c => buildChunkEmbeddingInput(source.title, c));
    embeddings = await embedTexts(inputs);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await supabase
      .from('knowledge_sources')
      .update({ status: 'degraded' })
      .eq('id', source.id)
      .eq('user_id', source.user_id);
    return {
      sourceId: source.id,
      title: source.title,
      outcome: 'degraded',
      chunksCreated: 0,
      error: msg,
    };
  }

  const missing = embeddings.findIndex(e => !e || e.length === 0);
  if (missing >= 0) {
    await supabase
      .from('knowledge_sources')
      .update({ status: 'degraded' })
      .eq('id', source.id)
      .eq('user_id', source.user_id);
    return {
      sourceId: source.id,
      title: source.title,
      outcome: 'degraded',
      chunksCreated: 0,
      error: `Embedding missing for chunk ${missing}`,
    };
  }

  const rows = chunks.map((content, i) => ({
    user_id: source.user_id,
    source_id: source.id,
    chunk_index: i,
    content,
    embedding: embeddings[i],
  }));

  const { error } = await supabase
    .from('source_chunks')
    .upsert(rows, { onConflict: 'source_id,chunk_index', ignoreDuplicates: true });

  if (error) {
    await supabase
      .from('knowledge_sources')
      .update({ status: 'failed' })
      .eq('id', source.id)
      .eq('user_id', source.user_id);
    return {
      sourceId: source.id,
      title: source.title,
      outcome: 'failed',
      chunksCreated: 0,
      error: error.message,
    };
  }

  // Restore source state to 'complete' if it was previously failed/degraded/pending.
  if (source.status && source.status !== 'complete') {
    await supabase
      .from('knowledge_sources')
      .update({ status: 'complete' })
      .eq('id', source.id)
      .eq('user_id', source.user_id);
  }

  return {
    sourceId: source.id,
    title: source.title,
    outcome: 'backfilled',
    chunksCreated: chunks.length,
  };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!verifyAuth(req)) return res.status(401).json({ error: 'Unauthorized' });

  const startTime = Date.now();
  const supabase = getServiceSupabase();

  const { userId, batchSize: requestedBatchSize, mode } = (req.body ?? {}) as {
    userId?: string;
    batchSize?: number;
    mode?: 'all' | 'missing-only';
  };
  const limit = Math.min(requestedBatchSize ?? 10, 50);
  const includeFailedOrDegraded = mode !== 'missing-only';

  log({ stage: 'chunk:backfill', status: 'ok', user_id: userId, batch_size: limit, mode: mode ?? 'all' });

  try {
    // Find candidate sources: chunkable content AND (no chunks OR status in failed/degraded/pending).
    let query = supabase
      .from('knowledge_sources')
      .select('id, user_id, content, title, status')
      .not('content', 'is', null)
      .order('created_at', { ascending: true })
      .limit(limit * 4); // Over-fetch since most are already complete; we filter below.

    if (userId) query = query.eq('user_id', userId);

    const { data: candidates, error: fetchError } = await query;
    if (fetchError) {
      logError({ stage: 'chunk:backfill', error: fetchError.message });
      return res.status(500).json({ error: fetchError.message });
    }

    const candidateRows = (candidates ?? []) as SourceRow[];
    const toProcess: SourceRow[] = [];

    for (const s of candidateRows) {
      if (toProcess.length >= limit) break;
      if (!s.content || s.content.length < 200) continue;

      const { count } = await supabase
        .from('source_chunks')
        .select('id', { count: 'exact', head: true })
        .eq('source_id', s.id);

      const noChunks = (count ?? 0) === 0;
      const inRetryState = includeFailedOrDegraded
        && s.status !== null
        && s.status !== 'complete';

      if (noChunks || inRetryState) {
        toProcess.push(s);
      }
    }

    if (toProcess.length === 0) {
      log({ stage: 'chunk:backfill', status: 'ok', message: 'no_candidates', duration_ms: Date.now() - startTime });
      return res.status(200).json({
        success: true,
        backfilled: 0,
        skipped: candidateRows.length,
        failed: 0,
        message: 'No candidates to process',
        duration_ms: Date.now() - startTime,
      });
    }

    const results: BackfillResult[] = [];
    for (const source of toProcess) {
      const t0 = Date.now();
      try {
        const r = await processSource(source, supabase);
        results.push(r);
        log({
          stage: 'chunk:backfill',
          source_id: source.id,
          user_id: source.user_id,
          status: r.outcome === 'backfilled' ? 'ok' : 'failed',
          outcome: r.outcome,
          chunks: r.chunksCreated,
          duration_ms: Date.now() - t0,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        results.push({
          sourceId: source.id,
          title: source.title,
          outcome: 'failed',
          chunksCreated: 0,
          error: msg,
        });
        await supabase
          .from('knowledge_sources')
          .update({ status: 'failed' })
          .eq('id', source.id)
          .eq('user_id', source.user_id);
        logError({
          stage: 'chunk:backfill',
          source_id: source.id,
          user_id: source.user_id,
          error: msg,
          duration_ms: Date.now() - t0,
        });
      }
    }

    const backfilled = results.filter(r => r.outcome === 'backfilled').length;
    const degraded = results.filter(r => r.outcome === 'degraded').length;
    const failed = results.filter(r => r.outcome === 'failed').length;
    const noChunks = results.filter(r => r.outcome === 'no_chunks').length;
    const totalChunks = results.reduce((sum, r) => sum + r.chunksCreated, 0);

    log({
      stage: 'chunk:backfill',
      status: failed > 0 ? 'partial' : 'ok',
      backfilled,
      degraded,
      failed,
      no_chunks: noChunks,
      total_chunks: totalChunks,
      duration_ms: Date.now() - startTime,
    });

    return res.status(200).json({
      success: true,
      backfilled,
      degraded,
      failed,
      no_chunks: noChunks,
      total_chunks_created: totalChunks,
      results,
      duration_ms: Date.now() - startTime,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logError({ stage: 'chunk:backfill', error: msg, duration_ms: Date.now() - startTime });
    return res.status(500).json({ success: false, error: msg, duration_ms: Date.now() - startTime });
  }
}
