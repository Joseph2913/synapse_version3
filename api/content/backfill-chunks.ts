import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

// Allow up to 300s on Vercel Pro (batch embedding can be slow)
export const maxDuration = 300;

// ─── ENVIRONMENT ───────────────────────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY!;
const CRON_SECRET = process.env.CRON_SECRET;

const getSupabase = () => createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

const BATCH_SIZE = 5; // Sources per invocation (to stay within time limits)
const EMBEDDING_CONCURRENCY = 5;

// ─── AUTH ──────────────────────────────────────────────────────────────────────

function verifyAuth(req: VercelRequest): boolean {
  if (req.headers['x-vercel-signature']) return true;
  if (!CRON_SECRET) return true;
  const auth = req.headers['authorization'];
  return !!(auth && auth === `Bearer ${CRON_SECRET}`);
}

// ─── CHUNKING (mirrors src/utils/chunking.ts) ─────────────────────────────────

function chunkText(content: string, targetTokens: number = 500): string[] {
  if (!content || !content.trim()) return [];

  const targetChars = targetTokens * 4;
  const overlapChars = 100;

  const sentences = content.match(/[^.!?]+[.!?]+/g);
  if (!sentences) {
    const trimmed = content.trim();
    return trimmed.length >= 50 ? [trimmed] : [];
  }

  const chunks: string[] = [];
  let currentChunk = '';

  for (const sentence of sentences) {
    if (currentChunk.length + sentence.length > targetChars && currentChunk.length > 0) {
      chunks.push(currentChunk.trim());
      const overlapStart = Math.max(0, currentChunk.length - overlapChars);
      currentChunk = currentChunk.substring(overlapStart) + sentence;
    } else {
      currentChunk += sentence;
    }
  }

  if (currentChunk.trim()) {
    chunks.push(currentChunk.trim());
  }

  // Merge very small chunks
  const merged: string[] = [];
  for (const chunk of chunks) {
    if (merged.length > 0 && chunk.length < 100) {
      merged[merged.length - 1] += ' ' + chunk;
    } else {
      merged.push(chunk);
    }
  }

  return merged.filter(c => c.length > 0);
}

// ─── EMBEDDING ─────────────────────────────────────────────────────────────────

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

// ─── HANDLER ───────────────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!verifyAuth(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const startTime = Date.now();
  const supabase = getSupabase();

  // Optional: target a specific user
  const { userId, batchSize: requestedBatchSize } = (req.body ?? {}) as {
    userId?: string;
    batchSize?: number;
  };
  const limit = Math.min(requestedBatchSize ?? BATCH_SIZE, 20);

  try {
    // ── Find sources missing chunks ──────────────────────────────────────────
    let query = supabase
      .from('knowledge_sources')
      .select('id, user_id, content, source_type, title')
      .not('content', 'is', null)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (userId) {
      query = query.eq('user_id', userId);
    }

    const { data: candidates, error: fetchError } = await query;

    if (fetchError) {
      return res.status(500).json({ error: fetchError.message });
    }

    if (!candidates || candidates.length === 0) {
      return res.status(200).json({
        success: true,
        backfilled: 0,
        skipped: 0,
        failed: 0,
        message: 'No candidate sources found',
        duration_ms: Date.now() - startTime,
      });
    }

    // Filter to only sources that actually need backfill (no existing chunks + content >= 200 chars)
    const sourcesToBackfill: Array<{
      id: string;
      user_id: string;
      content: string;
      source_type: string;
      title: string;
    }> = [];

    for (const source of candidates) {
      const s = source as { id: string; user_id: string; content: string | null; source_type: string; title: string };
      if (!s.content || s.content.length < 200) continue;

      const { count } = await supabase
        .from('source_chunks')
        .select('id', { count: 'exact', head: true })
        .eq('source_id', s.id);

      if (count === 0) {
        sourcesToBackfill.push({
          id: s.id,
          user_id: s.user_id,
          content: s.content,
          source_type: s.source_type,
          title: s.title,
        });
      }
    }

    if (sourcesToBackfill.length === 0) {
      return res.status(200).json({
        success: true,
        backfilled: 0,
        skipped: candidates.length,
        failed: 0,
        message: 'All candidate sources already have chunks',
        duration_ms: Date.now() - startTime,
      });
    }

    // ── Backfill each source ─────────────────────────────────────────────────
    const results: Array<{
      sourceId: string;
      title: string;
      status: 'backfilled' | 'failed';
      chunksCreated: number;
      chunksWithEmbeddings: number;
      error?: string;
    }> = [];

    for (const source of sourcesToBackfill) {
      try {
        const chunks = chunkText(source.content);
        if (chunks.length === 0) {
          results.push({
            sourceId: source.id,
            title: source.title,
            status: 'failed',
            chunksCreated: 0,
            chunksWithEmbeddings: 0,
            error: 'No chunks produced from content',
          });
          continue;
        }

        // Generate embeddings in batches
        const embeddings: (number[] | null)[] = new Array(chunks.length).fill(null);

        for (let i = 0; i < chunks.length; i += EMBEDDING_CONCURRENCY) {
          const batch = chunks.slice(i, i + EMBEDDING_CONCURRENCY);
          const batchResults = await Promise.allSettled(
            batch.map(text => generateEmbedding(text))
          );

          batchResults.forEach((result, j) => {
            if (result.status === 'fulfilled' && result.value.length > 0) {
              embeddings[i + j] = result.value;
            }
          });
        }

        // Insert chunks
        const toInsert = chunks.map((content, i) => {
          const row: Record<string, unknown> = {
            user_id: source.user_id,
            source_id: source.id,
            chunk_index: i,
            content,
          };
          if (embeddings[i]) {
            row.embedding = embeddings[i];
          }
          return row;
        });

        const { error: insertError } = await supabase
          .from('source_chunks')
          .insert(toInsert);

        if (insertError) {
          results.push({
            sourceId: source.id,
            title: source.title,
            status: 'failed',
            chunksCreated: 0,
            chunksWithEmbeddings: 0,
            error: insertError.message,
          });
          continue;
        }

        const withEmbeddings = embeddings.filter(e => e !== null).length;
        results.push({
          sourceId: source.id,
          title: source.title,
          status: 'backfilled',
          chunksCreated: chunks.length,
          chunksWithEmbeddings: withEmbeddings,
        });

        console.log(
          `[backfill-chunks] ${source.title}: ${chunks.length} chunks (${withEmbeddings} with embeddings)`
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        results.push({
          sourceId: source.id,
          title: source.title,
          status: 'failed',
          chunksCreated: 0,
          chunksWithEmbeddings: 0,
          error: msg,
        });
      }
    }

    const backfilled = results.filter(r => r.status === 'backfilled').length;
    const failed = results.filter(r => r.status === 'failed').length;
    const totalChunks = results.reduce((sum, r) => sum + r.chunksCreated, 0);

    return res.status(200).json({
      success: true,
      backfilled,
      failed,
      skipped: candidates.length - sourcesToBackfill.length,
      totalChunksCreated: totalChunks,
      results,
      duration_ms: Date.now() - startTime,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[backfill-chunks] Fatal error:', err);
    return res.status(500).json({ success: false, error: msg, duration_ms: Date.now() - startTime });
  }
}
