import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

// Allow up to 60s on Vercel Pro (transcript fetching with fallback tiers)
export const maxDuration = 60;

// ─── ENVIRONMENT ───────────────────────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const APIFY_API_KEY = process.env.APIFY_API_KEY ?? '';
const CRON_SECRET = process.env.CRON_SECRET;

const getSupabase = () => createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const APIFY_ACTOR_ID = 'streamers~youtube-scraper';

const MAX_ITEMS_PER_BATCH = 5;
const PARALLEL_LIMIT = 3;
const TRANSCRIPT_COLUMN_LIMIT = 50_000;
const APIFY_RUN_PREFIX = 'APIFY_RUN:';

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

// ─── TRANSCRIPT FORMATTING ─────────────────────────────────────────────────────

function formatTranscriptText(text: string): string {
  const sentences = text.match(/[^.!?]+[.!?]+/g) ?? [text];
  const paragraphs: string[] = [];
  const SENTENCES_PER_PARAGRAPH = 7;
  for (let i = 0; i < sentences.length; i += SENTENCES_PER_PARAGRAPH) {
    const para = sentences.slice(i, i + SENTENCES_PER_PARAGRAPH).join('').trim();
    if (para) paragraphs.push(para);
  }
  return paragraphs.length > 1 ? paragraphs.join('\n\n') : text;
}

// ─── TIER 1: youtube-caption-extractor ──────────────────────────────────────────

async function tryTier1(videoId: string): Promise<string | null> {
  try {
    const { getSubtitles } = await import('youtube-caption-extractor');
    const captions = await Promise.race([
      getSubtitles({ videoID: videoId, lang: 'en' }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Tier 1 timeout')), 15000)),
    ]);
    if (!captions?.length) return null;
    const raw = (captions as Array<{ text: string }>).map(c => c.text).join(' ').replace(/\s+/g, ' ').trim();
    return raw.length > 50 ? formatTranscriptText(raw) : null;
  } catch {
    return null;
  }
}

// ─── TIER 2: Innertube API ──────────────────────────────────────────────────────

async function tryTier2(videoId: string): Promise<string | null> {
  try {
    const response = await Promise.race([
      fetch('https://www.youtube.com/youtubei/v1/get_transcript', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          context: {
            client: { clientName: 'WEB', clientVersion: '2.20240101.00.00' },
          },
          params: Buffer.from(`\n\x0b${videoId}`).toString('base64'),
        }),
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Tier 2 timeout')), 15000)),
    ]);

    if (!response.ok) return null;
    const data = await response.json() as Record<string, unknown>;

    // Navigate the nested Innertube response structure
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const segments = (data as any)?.actions?.[0]?.updateEngagementPanelAction
      ?.content?.transcriptRenderer?.body?.transcriptBodyRenderer
      ?.cueGroups;

    if (!segments?.length) return null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw = (segments as any[])
      .map(g => g.transcriptCueGroupRenderer?.cues?.[0]
        ?.transcriptCueRenderer?.cue?.simpleText || '')
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();

    return raw.length > 50 ? formatTranscriptText(raw) : null;
  } catch {
    return null;
  }
}

// ─── TIER 3: Apify (fire-and-forget) ───────────────────────────────────────────

async function startApifyRun(videoUrl: string): Promise<string | null> {
  if (!APIFY_API_KEY) return null;

  try {
    const startResponse = await fetch(
      `https://api.apify.com/v2/acts/${APIFY_ACTOR_ID}/runs?token=${APIFY_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          startUrls: [{ url: videoUrl }],
          maxResults: 1,
          maxResultsShorts: 0,
          maxResultStreams: 0,
          downloadSubtitles: true,
          subtitlesLanguage: 'en',
          preferAutoGeneratedSubtitles: true,
          subtitlesFormat: 'plaintext',
        }),
        signal: AbortSignal.timeout(15000),
      }
    );

    if (!startResponse.ok) return null;

    const startData = await startResponse.json() as {
      data?: { id?: string };
    };
    return startData.data?.id ?? null;
  } catch {
    return null;
  }
}

async function checkApifyRun(
  runId: string,
  datasetId?: string
): Promise<{ transcript: string | null; done: boolean }> {
  if (!APIFY_API_KEY) return { transcript: null, done: true };

  try {
    const statusRes = await fetch(
      `https://api.apify.com/v2/actor-runs/${runId}?token=${APIFY_API_KEY}`,
      { signal: AbortSignal.timeout(10000) }
    );
    if (!statusRes.ok) return { transcript: null, done: false };

    const statusData = await statusRes.json() as {
      data?: { status?: string; defaultDatasetId?: string };
    };
    const status = statusData.data?.status;
    const dsId = datasetId ?? statusData.data?.defaultDatasetId;

    if (status === 'SUCCEEDED' && dsId) {
      const resultsRes = await fetch(
        `https://api.apify.com/v2/datasets/${dsId}/items?token=${APIFY_API_KEY}`,
        { signal: AbortSignal.timeout(10000) }
      );
      if (!resultsRes.ok) return { transcript: null, done: true };

      const items = await resultsRes.json() as Array<{
        subtitles?: Array<{ plaintext?: string; language?: string }>;
      }>;
      const sub = items[0]?.subtitles?.[0];
      const raw = sub?.plaintext?.replace(/\s+/g, ' ').trim() || null;

      return {
        transcript: raw && raw.length > 50 ? formatTranscriptText(raw) : null,
        done: true,
      };
    }

    if (['FAILED', 'ABORTED', 'TIMED-OUT'].includes(status ?? '')) {
      return { transcript: null, done: true };
    }

    // Still running
    return { transcript: null, done: false };
  } catch {
    return { transcript: null, done: false };
  }
}

// ─── FETCH TRANSCRIPT FOR SINGLE ITEM ───────────────────────────────────────────

interface QueueItemRow {
  id: string;
  user_id: string;
  video_id: string;
  video_url: string;
  video_title: string | null;
  transcript: string | null;
  error_message: string | null;
  retry_count: number;
  max_retries: number;
}

async function fetchTranscriptForItem(
  item: QueueItemRow,
  supabase: ReturnType<typeof getSupabase>
): Promise<{ id: string; success: boolean; error?: string }> {
  const videoId = item.video_id;

  // Check if this item has a pending Apify run
  if (item.error_message?.startsWith(APIFY_RUN_PREFIX)) {
    const runId = item.error_message.slice(APIFY_RUN_PREFIX.length);
    const { transcript, done } = await checkApifyRun(runId);

    if (transcript) {
      await supabase
        .from('youtube_ingestion_queue')
        .update({
          status: 'transcript_ready',
          transcript: transcript.slice(0, TRANSCRIPT_COLUMN_LIMIT),
          transcript_language: 'en',
          transcript_fetched_at: new Date().toISOString(),
          error_message: null,
        })
        .eq('id', item.id);
      return { id: item.id, success: true };
    }

    if (done) {
      // Apify finished but no transcript
      const newRetryCount = (item.retry_count ?? 0) + 1;
      const maxRetries = item.max_retries ?? 3;
      await supabase
        .from('youtube_ingestion_queue')
        .update({
          status: newRetryCount >= maxRetries ? 'failed' : 'pending',
          error_message: 'Transcript fetch failed on all tiers (Apify returned no captions)',
          retry_count: newRetryCount,
        })
        .eq('id', item.id);
      return { id: item.id, success: false, error: 'Apify returned no captions' };
    }

    // Still running — leave as-is for next cron
    return { id: item.id, success: false, error: 'Apify still running' };
  }

  try {
    // Mark as fetching
    await supabase
      .from('youtube_ingestion_queue')
      .update({ status: 'fetching_transcript', started_at: new Date().toISOString() })
      .eq('id', item.id);

    // Tier order matches D-004: Apify default, youtube-caption-extractor as
    // free fallback, Innertube as last-resort. Apify is fire-and-forget for the
    // background pipeline (the cron checks back next tick), so we kick it off
    // first — if it succeeds, we never need to call the unofficial scrapers.
    let transcript: string | null = null;

    // Tier 1: Apify fire-and-forget (cron will check back next tick).
    if (APIFY_API_KEY) {
      const runId = await startApifyRun(item.video_url);
      if (runId) {
        console.log(`[fetch-transcripts] ${videoId} Tier 1: Apify run started (${runId})`);
        await supabase
          .from('youtube_ingestion_queue')
          .update({
            status: 'pending',
            error_message: `${APIFY_RUN_PREFIX}${runId}`,
            started_at: null,
          })
          .eq('id', item.id);
        return { id: item.id, success: false, error: 'Apify started (async)' };
      }
    }

    // Tier 2: youtube-caption-extractor (free, public timedtext scraper).
    transcript = await tryTier1(videoId);
    console.log(`[fetch-transcripts] ${videoId} Tier 2 (caption-extractor): ${transcript ? 'success' : 'miss'}`);

    // Tier 3: Innertube (last-resort unofficial scraper).
    if (!transcript) {
      transcript = await tryTier2(videoId);
      console.log(`[fetch-transcripts] ${videoId} Tier 3 (innertube): ${transcript ? 'success' : 'miss'}`);
    }

    // All tiers failed (no Apify or Apify start failed)
    if (!transcript) {
      const newRetryCount = (item.retry_count ?? 0) + 1;
      const maxRetries = item.max_retries ?? 3;
      await supabase
        .from('youtube_ingestion_queue')
        .update({
          status: newRetryCount >= maxRetries ? 'failed' : 'pending',
          error_message: 'Transcript fetch failed on all tiers',
          retry_count: newRetryCount,
          started_at: null,
        })
        .eq('id', item.id);
      return { id: item.id, success: false, error: 'All transcript tiers failed' };
    }

    // Success — store transcript and advance status
    await supabase
      .from('youtube_ingestion_queue')
      .update({
        status: 'transcript_ready',
        transcript: transcript.slice(0, TRANSCRIPT_COLUMN_LIMIT),
        transcript_language: 'en',
        transcript_fetched_at: new Date().toISOString(),
        error_message: null,
      })
      .eq('id', item.id);

    console.log(`[fetch-transcripts] ${videoId}: transcript ready (${transcript.length} chars)`);
    return { id: item.id, success: true };

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    await supabase
      .from('youtube_ingestion_queue')
      .update({
        status: 'pending',
        error_message: `Transcript fetch error: ${msg}`,
        started_at: null,
      })
      .eq('id', item.id);
    return { id: item.id, success: false, error: msg };
  }
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
    // ── Stuck item cleanup ─────────────────────────────────────────────────────
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    await supabase
      .from('youtube_ingestion_queue')
      .update({ status: 'pending', error_message: 'Reset: stuck in fetching_transcript', started_at: null })
      .eq('status', 'fetching_transcript')
      .lt('started_at', fiveMinAgo);

    // ── Pick pending items that need transcripts ───────────────────────────────
    let query = supabase
      .from('youtube_ingestion_queue')
      .select('id, user_id, video_id, video_url, video_title, transcript, error_message, retry_count, max_retries')
      .eq('status', 'pending')
      .order('priority', { ascending: true })
      .order('created_at', { ascending: true })
      .limit(MAX_ITEMS_PER_BATCH);

    if (!isCron && userId) {
      query = query.eq('user_id', userId);
    }

    const { data: items, error: fetchError } = await query;

    if (fetchError) {
      return res.status(500).json({ error: fetchError.message });
    }

    if (!items?.length) {
      return res.status(200).json({
        processed: 0,
        succeeded: 0,
        failed: 0,
        message: 'No items to fetch',
        duration_ms: Date.now() - startTime,
      });
    }

    // Separate: items with pending Apify runs vs items needing fresh fetch
    const apifyItems = (items as QueueItemRow[]).filter(
      i => i.error_message?.startsWith(APIFY_RUN_PREFIX)
    );
    const freshItems = (items as QueueItemRow[]).filter(
      i => !i.error_message?.startsWith(APIFY_RUN_PREFIX) && !i.transcript
    );

    // ── Process Apify checks first (lightweight, no timeout risk) ──────────────
    const apifyResults: Array<{ id: string; success: boolean; error?: string }> = [];
    for (const item of apifyItems) {
      const result = await fetchTranscriptForItem(item, supabase);
      apifyResults.push(result);
    }

    // ── Process fresh items in parallel batches ────────────────────────────────
    const freshResults: Array<{ id: string; success: boolean; error?: string }> = [];
    for (let i = 0; i < freshItems.length; i += PARALLEL_LIMIT) {
      const batch = freshItems.slice(i, i + PARALLEL_LIMIT);
      const batchResults = await Promise.allSettled(
        batch.map(item => fetchTranscriptForItem(item, supabase))
      );

      batchResults.forEach((result, idx) => {
        const item = batch[idx];
        if (!item) return;
        if (result.status === 'fulfilled') {
          freshResults.push(result.value);
        } else {
          freshResults.push({ id: item.id, success: false, error: result.reason?.message || 'Unknown error' });
        }
      });
    }

    const allResults = [...apifyResults, ...freshResults];

    return res.status(200).json({
      processed: allResults.length,
      succeeded: allResults.filter(r => r.success).length,
      failed: allResults.filter(r => !r.success).length,
      details: allResults,
      duration_ms: Date.now() - startTime,
    });

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[fetch-transcripts] Fatal error:', err);
    return res.status(500).json({ success: false, error: msg, duration_ms: Date.now() - startTime });
  }
}
