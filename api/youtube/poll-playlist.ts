import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

// ─── ENVIRONMENT ───────────────────────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const CRON_SECRET = process.env.CRON_SECRET;
const YOUTUBE_API_KEY_ENV = process.env.YOUTUBE_API_KEY;

const getSupabase = () => createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// ─── TYPES ─────────────────────────────────────────────────────────────────────

interface YouTubePlaylist {
  id: string;
  user_id: string;
  playlist_id: string;
  playlist_url: string;
  playlist_name: string | null;
  status: string;
  extraction_mode: string;
  anchor_emphasis: string;
  linked_anchor_ids: string[];
  custom_instructions: string | null;
  known_video_count: number;
}

interface YouTubeSettings {
  youtube_api_key: string | null;
}

interface PlaylistItem {
  video_id: string;
  title: string;
  url: string;
  thumbnail_url: string;
  published_at: string;
  description: string | null;
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

function verifyCronAuth(req: VercelRequest): boolean {
  if (req.headers['x-vercel-signature']) return true;
  if (!CRON_SECRET) return true;
  const auth = req.headers['authorization'];
  return !!(auth && auth === `Bearer ${CRON_SECRET}`);
}

async function verifyUserAuth(
  req: VercelRequest
): Promise<{ userId: string | null; isCron: boolean }> {
  // Check cron first
  if (verifyCronAuth(req)) return { userId: null, isCron: true };

  // Try Supabase JWT
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

// ─── PLAYLIST API ──────────────────────────────────────────────────────────────

async function fetchPlaylistItems(
  playlistId: string,
  apiKey: string,
  maxPages: number = 4
): Promise<{ items: PlaylistItem[]; totalCount: number }> {
  const items: PlaylistItem[] = [];
  let pageToken: string | undefined;
  let totalCount = 0;

  for (let page = 0; page < maxPages; page++) {
    const params = new URLSearchParams({
      part: 'snippet,contentDetails',
      playlistId,
      maxResults: '50',
      key: apiKey,
    });
    if (pageToken) params.set('pageToken', pageToken);

    const response = await fetch(
      `https://www.googleapis.com/youtube/v3/playlistItems?${params}`,
      { signal: AbortSignal.timeout(15000) }
    );

    if (!response.ok) {
      console.error(`[poll-playlist] API error: ${response.status} for playlist ${playlistId}`);
      break;
    }

    const data = await response.json() as {
      items?: Array<{
        contentDetails?: { videoId?: string };
        snippet?: {
          title?: string;
          publishedAt?: string;
          description?: string;
          thumbnails?: { high?: { url?: string } };
          videoOwnerChannelId?: string;
        };
      }>;
      nextPageToken?: string;
      pageInfo?: { totalResults?: number };
    };

    totalCount = data.pageInfo?.totalResults ?? totalCount;

    for (const item of data.items ?? []) {
      const videoId = item.contentDetails?.videoId;
      if (!videoId) continue;

      items.push({
        video_id: videoId,
        title: item.snippet?.title ?? 'Untitled',
        url: `https://www.youtube.com/watch?v=${videoId}`,
        thumbnail_url:
          item.snippet?.thumbnails?.high?.url ??
          `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
        published_at: item.snippet?.publishedAt ?? new Date().toISOString(),
        description: item.snippet?.description
          ? item.snippet.description.substring(0, 500)
          : null,
      });
    }

    pageToken = data.nextPageToken;
    if (!pageToken) break;
  }

  return { items, totalCount };
}

// ─── HANDLER ───────────────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { userId, isCron } = await verifyUserAuth(req);
  if (!isCron && !userId) return res.status(401).json({ error: 'Unauthorized' });

  const startTime = Date.now();
  const supabase = getSupabase();

  const summary = {
    playlistsPolled: 0,
    newVideosQueued: 0,
    errors: [] as string[],
  };

  try {
    // Fetch active playlists — scope to requesting user when user-triggered
    let playlistQuery = supabase
      .from('youtube_playlists')
      .select('*')
      .eq('is_active', true);
    if (!isCron && userId) {
      playlistQuery = playlistQuery.eq('user_id', userId);
    }
    const { data: playlists, error: playlistsError } = await playlistQuery;

    if (playlistsError) {
      return res.status(500).json({ error: playlistsError.message });
    }

    if (!playlists || playlists.length === 0) {
      return res.status(200).json({
        success: true,
        playlistsPolled: 0,
        newVideosQueued: 0,
        errors: [],
        duration_ms: Date.now() - startTime,
      });
    }

    // Group by user_id
    const playlistsByUser = new Map<string, YouTubePlaylist[]>();
    for (const pl of playlists as YouTubePlaylist[]) {
      const list = playlistsByUser.get(pl.user_id) ?? [];
      list.push(pl);
      playlistsByUser.set(pl.user_id, list);
    }

    for (const [userId, userPlaylists] of playlistsByUser) {
      // Resolve YouTube API key
      let youtubeApiKey: string | null = YOUTUBE_API_KEY_ENV ?? null;
      if (!youtubeApiKey) {
        const { data: settings } = await supabase
          .from('youtube_settings')
          .select('youtube_api_key')
          .eq('user_id', userId)
          .maybeSingle();
        youtubeApiKey = (settings as YouTubeSettings | null)?.youtube_api_key ?? null;
      }

      if (!youtubeApiKey) {
        const errMsg = `User ${userId}: No YouTube API key configured — playlist polling requires a key`;
        console.warn(`[poll-playlist] ${errMsg}`);
        summary.errors.push(errMsg);
        continue;
      }

      // Get existing queue video IDs for deduplication
      const { data: existingQueue } = await supabase
        .from('youtube_ingestion_queue')
        .select('video_id')
        .eq('user_id', userId);

      const existingVideoIds = new Set(
        (existingQueue ?? []).map((q: { video_id: string }) => q.video_id)
      );

      for (const playlist of userPlaylists) {
        let videosAdded = 0;

        try {
          // Fetch playlist items from YouTube API
          const { items, totalCount } = await fetchPlaylistItems(
            playlist.playlist_id,
            youtubeApiKey
          );

          // Update known_video_count
          await supabase
            .from('youtube_playlists')
            .update({ known_video_count: totalCount })
            .eq('id', playlist.id);

          // Backfill playlist_id on existing rows for this playlist's videos
          // (handles rows inserted before the playlist_id column was added)
          if (items.length > 0) {
            await supabase
              .from('youtube_ingestion_queue')
              .update({ playlist_id: playlist.id })
              .eq('user_id', userId)
              .in('video_id', items.map(v => v.video_id))
              .is('playlist_id', null);
          }

          // Filter out already-queued videos
          const newItems = items.filter(v => !existingVideoIds.has(v.video_id));

          if (newItems.length > 0) {
            const queueItems = newItems.map(item => ({
              user_id: userId,
              video_id: item.video_id,
              video_title: item.title,
              video_url: item.url,
              thumbnail_url: item.thumbnail_url,
              published_at: item.published_at,
              status: 'pending',
              priority: 5,
              playlist_id: playlist.id,
            }));

            const { data: inserted, error: insertError } = await supabase
              .from('youtube_ingestion_queue')
              .upsert(queueItems, { onConflict: 'user_id,video_id', ignoreDuplicates: true })
              .select('id');

            if (insertError) {
              console.error(`[poll-playlist] Insert error for playlist ${playlist.playlist_id}:`, insertError);
              summary.errors.push(`Playlist ${playlist.playlist_name ?? playlist.playlist_id}: ${insertError.message}`);
            } else {
              videosAdded = inserted?.length ?? 0;
              summary.newVideosQueued += videosAdded;
              newItems.forEach(v => existingVideoIds.add(v.video_id));
            }
          }

          summary.playlistsPolled++;

        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[poll-playlist] Playlist ${playlist.playlist_id} error:`, err);
          summary.errors.push(`Playlist ${playlist.playlist_name ?? playlist.playlist_id}: ${msg}`);

          // Mark playlist as inactive on repeated failures
          await supabase
            .from('youtube_playlists')
            .update({ is_active: false, connection_error: msg })
            .eq('id', playlist.id)
            .eq('is_active', true); // only update if still active
        }
      }
    }

    return res.status(200).json({
      success: true,
      ...summary,
      duration_ms: Date.now() - startTime,
    });

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[poll-playlist] Fatal error:', err);
    return res.status(500).json({ success: false, error: msg, duration_ms: Date.now() - startTime });
  }
}
