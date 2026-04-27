import { CaptureError, type CapturedSource } from '../../types/capture'

const YOUTUBE_PATTERN = /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/

export interface CaptureYoutubeInput {
  url: string
  authToken: string
}

/**
 * YouTube adapter — Stage 1.
 * Calls the three-tier serverless endpoint:
 *   Tier 1 — Apify (default)
 *   Tier 2 — youtube-caption-extractor (free fallback)
 *   Tier 3 — Gemini video understanding (escape hatch)
 */
export async function captureYoutube({ url, authToken }: CaptureYoutubeInput): Promise<CapturedSource> {
  const trimmed = url.trim()
  if (!trimmed) throw new CaptureError('YOUTUBE_EMPTY', 'Enter a YouTube URL.')
  if (!YOUTUBE_PATTERN.test(trimmed) && !/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) {
    throw new CaptureError('YOUTUBE_INVALID', 'That does not look like a YouTube URL.')
  }

  const resp = await fetch('/api/capture/youtube', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${authToken}`,
    },
    body: JSON.stringify({ url: trimmed }),
  })

  if (!resp.ok) {
    const body = await resp.json().catch(() => ({})) as { error?: string }
    const code = resp.status === 413 ? 'YOUTUBE_OVERSIZE'
      : resp.status === 422 ? 'YOUTUBE_NO_TRANSCRIPT'
      : resp.status === 401 ? 'YOUTUBE_UNAUTHORIZED'
      : resp.status === 400 ? 'YOUTUBE_INVALID'
      : 'YOUTUBE_CAPTURE_FAILED'
    throw new CaptureError(code, body.error ?? 'Could not capture YouTube video.')
  }

  return await resp.json() as CapturedSource
}
