import type { YouTubeVideo } from '../types/youtube'
import { callApi } from './apiClient'

// --- URL Parsing ---

const PLAYLIST_URL_PATTERNS = [
  /[?&]list=(PL[\w-]+)/,                    // Standard playlist URL with list param
  /youtube\.com\/playlist\?list=(PL[\w-]+)/, // Direct playlist URL
  /^(PL[\w-]{10,})$/,                        // Raw playlist ID
]

export function parsePlaylistUrl(url: string): string | null {
  const trimmed = url.trim()
  for (const pattern of PLAYLIST_URL_PATTERNS) {
    const match = trimmed.match(pattern)
    if (match?.[1]) return match[1]
  }
  return null
}

// --- SYN Code Generation ---

export function generateSynapseCode(): string {
  const chars = '0123456789ABCDEF'
  let code = 'SYN-'
  for (let i = 0; i < 4; i++) {
    code += chars[Math.floor(Math.random() * chars.length)]
  }
  return code
}

// --- Playlist Metadata ---

export async function fetchPlaylistMetadata(
  playlistId: string
): Promise<{ name: string; videoCount: number; thumbnailUrl?: string } | null> {
  try {
    const { result } = await callApi<{ result: { name: string; videoCount: number; thumbnailUrl?: string } | null }>(
      '/api/youtube/lookup',
      { kind: 'playlist-metadata', playlistId },
    )
    return result
  } catch (err) {
    console.warn('[youtube] Failed to fetch playlist metadata:', err)
    return null
  }
}

// --- Playlist Videos ---

export async function fetchPlaylistVideos(
  playlistId: string,
  maxResults: number = 50
): Promise<YouTubeVideo[]> {
  try {
    const { videos } = await callApi<{ videos: YouTubeVideo[] }>(
      '/api/youtube/lookup',
      { kind: 'playlist-videos', playlistId, maxResults },
    )
    return videos
  } catch (err) {
    console.warn('[youtube] Failed to fetch playlist videos:', err)
    return []
  }
}

// --- API Key Check ---

/**
 * Returns true. The YouTube API key now lives server-side; the browser
 * cannot meaningfully check for its presence. Kept as an export so existing
 * UI gating call sites do not need to change.
 */
export function hasYouTubeApiKey(): boolean {
  return true
}

// --- Video URL Parsing ---

const VIDEO_URL_PATTERNS = [
  /youtube\.com\/watch\?v=([\w-]{11})/,
  /youtu\.be\/([\w-]{11})/,
  /youtube\.com\/embed\/([\w-]{11})/,
  /youtube\.com\/shorts\/([\w-]{11})/,
  /^([\w-]{11})$/,
]

export function parseVideoUrl(url: string): string | null {
  const trimmed = url.trim()
  for (const pattern of VIDEO_URL_PATTERNS) {
    const match = trimmed.match(pattern)
    if (match?.[1]) return match[1]
  }
  return null
}

// --- Video Metadata ---

export async function fetchVideoTitle(videoId: string): Promise<string | null> {
  try {
    const { title } = await callApi<{ title: string | null }>(
      '/api/youtube/lookup',
      { kind: 'video-title', videoId },
    )
    return title
  } catch {
    return null
  }
}

// --- Manual Transcript Fetch ---

export async function fetchYouTubeTranscript(
  videoUrl: string,
  authToken: string
): Promise<{ transcript: string; videoId: string; language: string; tier: number }> {
  const res = await fetch('/api/youtube/transcript', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${authToken}`,
    },
    body: JSON.stringify({ videoUrl }),
  })

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Failed to fetch transcript' })) as { error?: string }
    throw new Error(err.error ?? `Transcript fetch failed: ${res.status}`)
  }

  return await res.json() as { transcript: string; videoId: string; language: string; tier: number }
}
