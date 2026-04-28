import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL!
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY!
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY!
const YT_BASE = 'https://www.googleapis.com/youtube/v3'

if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !YOUTUBE_API_KEY) {
  throw new Error('[youtube/lookup] Missing required env vars')
}

function getAnonSupabase(): SupabaseClient {
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
}

async function getUserIdFromRequest(req: VercelRequest): Promise<string | null> {
  const auth = req.headers.authorization
  if (!auth?.startsWith('Bearer ')) return null
  const token = auth.slice(7)
  try {
    const { data: { user } } = await getAnonSupabase().auth.getUser(token)
    return user?.id ?? null
  } catch {
    return null
  }
}

interface PlaylistMetaBody { kind: 'playlist-metadata'; playlistId: string }
interface PlaylistVideosBody { kind: 'playlist-videos'; playlistId: string; maxResults?: number }
interface VideoTitleBody { kind: 'video-title'; videoId: string }
type LookupBody = PlaylistMetaBody | PlaylistVideosBody | VideoTitleBody

function isLookupBody(b: unknown): b is LookupBody {
  if (!b || typeof b !== 'object') return false
  const o = b as Record<string, unknown>
  if (o.kind === 'playlist-metadata' || o.kind === 'playlist-videos') {
    if (typeof o.playlistId !== 'string' || o.playlistId.length === 0 || o.playlistId.length > 64) return false
    if (o.kind === 'playlist-videos' && o.maxResults !== undefined && (typeof o.maxResults !== 'number' || o.maxResults < 1 || o.maxResults > 200)) return false
    return true
  }
  if (o.kind === 'video-title') {
    return typeof o.videoId === 'string' && /^[\w-]{11}$/.test(o.videoId)
  }
  return false
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' })

  const userId = await getUserIdFromRequest(req)
  if (!userId) return res.status(401).json({ error: 'unauthenticated' })

  if (!isLookupBody(req.body)) {
    return res.status(400).json({ error: 'invalid_request', detail: 'Expected { kind: "playlist-metadata" | "playlist-videos" | "video-title", ... }' })
  }

  const body = req.body
  const startedAt = Date.now()

  try {
    if (body.kind === 'playlist-metadata') {
      const url = `${YT_BASE}/playlists?part=snippet,contentDetails&id=${encodeURIComponent(body.playlistId)}&key=${YOUTUBE_API_KEY}`
      const resp = await fetch(url)
      if (!resp.ok) throw new Error(`YouTube ${resp.status}`)
      const data = await resp.json() as {
        items?: { snippet?: { title?: string; thumbnails?: { medium?: { url?: string } } }; contentDetails?: { itemCount?: number } }[]
      }
      const item = data.items?.[0]
      const result = item ? {
        name: item.snippet?.title ?? '',
        videoCount: item.contentDetails?.itemCount ?? 0,
        thumbnailUrl: item.snippet?.thumbnails?.medium?.url,
      } : null
      console.log(JSON.stringify({ stage: 'youtube:lookup', kind: body.kind, user_id: userId, duration_ms: Date.now() - startedAt, status: 'ok' }))
      return res.status(200).json({ result })
    }

    if (body.kind === 'playlist-videos') {
      const max = body.maxResults ?? 50
      const videos: { video_id: string; video_title: string; video_url: string; thumbnail_url: string | null; published_at: string | null }[] = []
      let pageToken: string | undefined
      do {
        const params = new URLSearchParams({
          part: 'snippet,contentDetails',
          playlistId: body.playlistId,
          maxResults: '50',
          key: YOUTUBE_API_KEY,
        })
        if (pageToken) params.set('pageToken', pageToken)
        const resp = await fetch(`${YT_BASE}/playlistItems?${params.toString()}`)
        if (!resp.ok) break
        const data = await resp.json() as {
          items?: {
            snippet?: { title?: string; thumbnails?: { medium?: { url?: string } } }
            contentDetails?: { videoId?: string; videoPublishedAt?: string }
          }[]
          nextPageToken?: string
        }
        for (const item of data.items ?? []) {
          const videoId = item.contentDetails?.videoId
          if (!videoId) continue
          videos.push({
            video_id: videoId,
            video_title: item.snippet?.title ?? '',
            video_url: `https://www.youtube.com/watch?v=${videoId}`,
            thumbnail_url: item.snippet?.thumbnails?.medium?.url ?? null,
            published_at: item.contentDetails?.videoPublishedAt ?? null,
          })
        }
        pageToken = data.nextPageToken
      } while (pageToken && videos.length < max)
      console.log(JSON.stringify({ stage: 'youtube:lookup', kind: body.kind, user_id: userId, count: videos.length, duration_ms: Date.now() - startedAt, status: 'ok' }))
      return res.status(200).json({ videos: videos.slice(0, max) })
    }

    // video-title
    const url = `${YT_BASE}/videos?part=snippet&id=${encodeURIComponent(body.videoId)}&key=${YOUTUBE_API_KEY}`
    const resp = await fetch(url)
    if (!resp.ok) throw new Error(`YouTube ${resp.status}`)
    const data = await resp.json() as { items?: { snippet?: { title?: string } }[] }
    const title = data.items?.[0]?.snippet?.title ?? null
    console.log(JSON.stringify({ stage: 'youtube:lookup', kind: body.kind, user_id: userId, duration_ms: Date.now() - startedAt, status: 'ok' }))
    return res.status(200).json({ title })
  } catch (err) {
    console.log(JSON.stringify({ stage: 'youtube:lookup', kind: body.kind, user_id: userId, duration_ms: Date.now() - startedAt, status: 'error', error: (err as Error).message }))
    return res.status(502).json({ error: 'vendor', detail: (err as Error).message })
  }
}
