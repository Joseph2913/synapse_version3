import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

// ─── ENVIRONMENT ───────────────────────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const YOUTUBE_API_KEY_ENV = process.env.YOUTUBE_API_KEY;

const getSupabase = () => createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// ─── FETCH PLAYLIST VIDEO IDS ─────────────────────────────────────────────────


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

async function fetchPlaylistVideoIds(
  ytPlaylistId: string,
  apiKey: string
): Promise<string[]> {
  const videoIds: string[] = [];
  let pageToken: string | undefined;

  for (let page = 0; page < 4; page++) {
    const params = new URLSearchParams({
      part: 'contentDetails',
      playlistId: ytPlaylistId,
      maxResults: '50',
      key: apiKey,
    });
    if (pageToken) params.set('pageToken', pageToken);

    const res = await fetch(
      `https://www.googleapis.com/youtube/v3/playlistItems?${params}`,
      { signal: AbortSignal.timeout(10000) }
    );

    if (!res.ok) {
      console.warn(`[playlist-ingested] YouTube API error ${res.status} for playlist ${ytPlaylistId}`);
      break;
    }

    const data = await res.json() as {
      items?: Array<{ contentDetails?: { videoId?: string } }>;
      nextPageToken?: string;
    };

    for (const item of data.items ?? []) {
      const videoId = item.contentDetails?.videoId;
      if (videoId) videoIds.push(videoId);
    }

    pageToken = data.nextPageToken;
    if (!pageToken) break;
  }

  return videoIds;
}

// ─── HANDLER ──────────────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Auth
  const auth = req.headers['authorization'];
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  const token = auth.slice(7);

  const supabase = getSupabase();

  let userId: string;
  try {
    const { data: { user } } = await supabase.auth.getUser(token);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    userId = user.id;
  } catch {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { playlist_uuid } = req.body as { playlist_uuid?: string };
  if (!playlist_uuid) return res.status(400).json({ error: 'playlist_uuid required' });

  // Look up playlist's YouTube playlist ID
  const { data: plRow } = await supabase
    .from('youtube_playlists')
    .select('playlist_id')
    .eq('id', playlist_uuid)
    .eq('user_id', userId)
    .maybeSingle();

  if (!plRow) return res.status(404).json({ error: 'Playlist not found' });

  const ytPlaylistId = (plRow as { playlist_id: string }).playlist_id;

  // Resolve YouTube API key (env-level first, then per-user)
  let apiKey: string | null = YOUTUBE_API_KEY_ENV ?? null;
  if (!apiKey) {
    const { data: settings } = await supabase
      .from('youtube_settings')
      .select('youtube_api_key')
      .eq('user_id', userId)
      .maybeSingle();
    apiKey = (settings as { youtube_api_key: string | null } | null)?.youtube_api_key ?? null;
  }

  if (!apiKey) {
    // No API key — fall back to playlist_id column only (new rows post-migration)
    const { data: newRows } = await supabase
      .from('youtube_ingestion_queue')
      .select('id, video_title, created_at, nodes_created, edges_created')
      .eq('user_id', userId)
      .eq('playlist_id', playlist_uuid)
      .eq('status', 'completed')
      .order('created_at', { ascending: false })
      .limit(50);

    return res.status(200).json({
      items: ((newRows ?? []) as Record<string, unknown>[]).map(row => ({
        id: row.id,
        title: row.video_title || 'Untitled Video',
        ingestedAt: row.created_at,
        nodes: row.nodes_created || undefined,
        edges: row.edges_created || undefined,
      })),
    });
  }

  // Fetch video IDs belonging to this playlist from YouTube API
  const videoIds = await fetchPlaylistVideoIds(ytPlaylistId, apiKey);

  if (videoIds.length === 0) {
    return res.status(200).json({ items: [] });
  }

  // Backfill playlist_id on existing queue rows for this playlist's videos
  await supabase
    .from('youtube_ingestion_queue')
    .update({ playlist_id: playlist_uuid })
    .eq('user_id', userId)
    .in('video_id', videoIds)
    .is('playlist_id', null);

  // Fetch completed ingested videos for this playlist
  const { data: queueRows } = await supabase
    .from('youtube_ingestion_queue')
    .select('id, video_title, created_at, nodes_created, edges_created')
    .eq('user_id', userId)
    .in('video_id', videoIds)
    .eq('status', 'completed')
    .order('created_at', { ascending: false })
    .limit(50);

  return res.status(200).json({
    items: ((queueRows ?? []) as Record<string, unknown>[]).map(row => ({
      id: row.id,
      title: row.video_title || 'Untitled Video',
      ingestedAt: row.created_at,
      nodes: row.nodes_created || undefined,
      edges: row.edges_created || undefined,
    })),
  });
}
