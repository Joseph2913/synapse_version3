import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// Allow up to 60s on Vercel Pro to cover Apify polling.
export const maxDuration = 60

// ─── Supabase env + factories ────────────────────────────────────────────────

const SUPABASE_URL = process.env.SUPABASE_URL!
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY!

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  throw new Error('[capture/youtube] Missing env vars: SUPABASE_URL, SUPABASE_ANON_KEY')
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

// ─── Structured logging ─────────────────────────────────────────────────────

type LogStatus = 'ok' | 'failed' | 'partial' | 'skipped'

interface LogFields {
  stage: string
  user_id?: string
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

// ─── Gemini env + helper ─────────────────────────────────────────────────────

const GEMINI_API_KEY = process.env.GEMINI_API_KEY!
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models'
const GEMINI_MODEL = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash'

if (!GEMINI_API_KEY) {
  throw new Error('[capture/youtube] Missing env var: GEMINI_API_KEY')
}

// ─── Gemini fetch + helpers (retry on 429/5xx, token-usage logging) ─────────

interface GeminiUsage {
  promptTokenCount?: number
  candidatesTokenCount?: number
  totalTokenCount?: number
}

async function geminiFetch(
  endpoint: string,
  body: unknown,
  timeoutMs: number,
  stage: string
): Promise<{ json: unknown; usage: GeminiUsage | undefined }> {
  const url = `${GEMINI_BASE}/${endpoint}?key=${GEMINI_API_KEY}`
  const maxAttempts = 3
  let lastErr: Error | null = null
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify(body),
      })
      if (resp.ok) {
        const json = await resp.json() as { usageMetadata?: GeminiUsage }
        const usage = json.usageMetadata
        if (usage) {
          console.log(JSON.stringify({
            stage, model: endpoint.split(':')[0],
            prompt_tokens: usage.promptTokenCount,
            output_tokens: usage.candidatesTokenCount,
            total_tokens: usage.totalTokenCount,
          }))
        }
        return { json, usage }
      }
      const txt = await resp.text().catch(() => '')
      lastErr = new Error(`Gemini ${resp.status}: ${txt.slice(0, 200)}`)
      if ((resp.status === 429 || resp.status >= 500) && attempt < maxAttempts - 1) {
        await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 1000))
        continue
      }
      throw lastErr
    } catch (err) {
      lastErr = err as Error
      if (attempt < maxAttempts - 1) {
        await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 1000))
        continue
      }
      throw lastErr
    } finally {
      clearTimeout(timer)
    }
  }
  throw lastErr ?? new Error('[gemini] request failed')
}

// ─── YouTube + Apify config ──────────────────────────────────────────────────

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY ?? ''
const APIFY_API_KEY = process.env.APIFY_API_KEY ?? ''
const APIFY_ACTOR_ID = 'streamers~youtube-scraper'

const TRANSCRIPT_MAX_CHARS = 400_000

// ─── Helpers ─────────────────────────────────────────────────────────────────

const YOUTUBE_PATTERN = /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/

function extractVideoId(rawUrl: string): string | null {
  const match = YOUTUBE_PATTERN.exec(rawUrl)
  if (match) return match[1]
  if (/^[a-zA-Z0-9_-]{11}$/.test(rawUrl.trim())) return rawUrl.trim()
  return null
}

function canonicalYoutubeUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`
}

function formatTranscriptText(text: string): string {
  const sentences = text.match(/[^.!?]+[.!?]+/g) ?? [text]
  const paragraphs: string[] = []
  const SENTENCES_PER_PARAGRAPH = 7
  for (let i = 0; i < sentences.length; i += SENTENCES_PER_PARAGRAPH) {
    const para = sentences.slice(i, i + SENTENCES_PER_PARAGRAPH).join('').trim()
    if (para) paragraphs.push(para)
  }
  return paragraphs.length > 1 ? paragraphs.join('\n\n') : text
}

interface VideoMetadata {
  videoId: string
  title: string | null
  channel: string | null
  duration_seconds: number | null
  published_at: string | null
  thumbnail_url: string | null
}

function parseISODuration(iso: string): number | null {
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso)
  if (!m) return null
  const h = parseInt(m[1] ?? '0', 10)
  const min = parseInt(m[2] ?? '0', 10)
  const s = parseInt(m[3] ?? '0', 10)
  return h * 3600 + min * 60 + s
}

async function fetchVideoMetadata(videoId: string): Promise<VideoMetadata> {
  const fallback: VideoMetadata = {
    videoId, title: null, channel: null, duration_seconds: null,
    published_at: null, thumbnail_url: null,
  }
  if (!YOUTUBE_API_KEY) return fallback
  try {
    const url = `https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails&id=${videoId}&key=${YOUTUBE_API_KEY}`
    const resp = await fetch(url, { signal: AbortSignal.timeout(10_000) })
    if (!resp.ok) return fallback
    const data = await resp.json() as {
      items?: Array<{
        snippet?: { title?: string; channelTitle?: string; publishedAt?: string; thumbnails?: { medium?: { url?: string }; high?: { url?: string } } }
        contentDetails?: { duration?: string }
      }>
    }
    const item = data.items?.[0]
    if (!item) return fallback
    return {
      videoId,
      title: item.snippet?.title ?? null,
      channel: item.snippet?.channelTitle ?? null,
      duration_seconds: item.contentDetails?.duration ? parseISODuration(item.contentDetails.duration) : null,
      published_at: item.snippet?.publishedAt ?? null,
      thumbnail_url: item.snippet?.thumbnails?.high?.url ?? item.snippet?.thumbnails?.medium?.url ?? null,
    }
  } catch {
    return fallback
  }
}

// ─── Tier 1: Apify (default) ─────────────────────────────────────────────────

async function tier1Apify(videoUrl: string): Promise<string | null> {
  if (!APIFY_API_KEY) return null
  try {
    const startResp = await fetch(
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
        signal: AbortSignal.timeout(15_000),
      },
    )
    if (!startResp.ok) return null
    const startData = await startResp.json() as { data?: { id?: string; defaultDatasetId?: string } }
    const runId = startData.data?.id
    if (!runId) return null

    // Poll up to 45s.
    const deadline = Date.now() + 45_000
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 3_000))
      const statusResp = await fetch(
        `https://api.apify.com/v2/actor-runs/${runId}?token=${APIFY_API_KEY}`,
        { signal: AbortSignal.timeout(8_000) },
      )
      if (!statusResp.ok) continue
      const statusData = await statusResp.json() as { data?: { status?: string; defaultDatasetId?: string } }
      const status = statusData.data?.status
      const dsId = statusData.data?.defaultDatasetId
      if (status === 'SUCCEEDED' && dsId) {
        const itemsResp = await fetch(
          `https://api.apify.com/v2/datasets/${dsId}/items?token=${APIFY_API_KEY}`,
          { signal: AbortSignal.timeout(10_000) },
        )
        if (!itemsResp.ok) return null
        const items = await itemsResp.json() as Array<{ subtitles?: Array<{ plaintext?: string }> }>
        const raw = items[0]?.subtitles?.[0]?.plaintext?.replace(/\s+/g, ' ').trim() ?? null
        return raw && raw.length > 50 ? formatTranscriptText(raw) : null
      }
      if (['FAILED', 'ABORTED', 'TIMED-OUT'].includes(status ?? '')) return null
    }
    return null
  } catch {
    return null
  }
}

// ─── Tier 2: youtube-caption-extractor (free fallback) ───────────────────────
//
// Note on tier-2 choice: the original spec wanted "YouTube Data API v3 captions"
// here. In practice that endpoint requires OAuth as the channel owner and is not
// available for third-party videos, so it cannot serve as a real fallback. We
// use youtube-caption-extractor instead — it's an unofficial scraper of YouTube's
// public timedtext endpoint, free, and reliable for videos that publish captions.

async function tier2YoutubeCaptionExtractor(videoId: string): Promise<string | null> {
  try {
    const { getSubtitles } = await import('youtube-caption-extractor')
    const captions = await Promise.race([
      getSubtitles({ videoID: videoId, lang: 'en' }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Tier 2 timeout')), 10_000)),
    ])
    if (!captions?.length) return null
    const raw = (captions as Array<{ text: string }>).map(c => c.text).join(' ').replace(/\s+/g, ' ').trim()
    return raw.length > 50 ? formatTranscriptText(raw) : null
  } catch {
    return null
  }
}

// ─── Tier 3: Gemini video understanding (escape hatch) ───────────────────────

const GEMINI_VIDEO_PROMPT = `You will be given a YouTube video. Produce a clean, complete transcript of the spoken content with paragraph breaks. Return ONE JSON object:
- "transcript": full transcript text. Plain text only. No HTML, no markdown.
- "language": ISO-639-1 code or null if uncertain.
Return ONLY the JSON. No commentary.`

async function tier3GeminiVideo(videoUrl: string): Promise<{ transcript: string; language: string | null } | null> {
  try {
    const { json } = await geminiFetch(
      `${GEMINI_MODEL}:generateContent`,
      {
        system_instruction: { parts: [{ text: GEMINI_VIDEO_PROMPT }] },
        contents: [{
          parts: [
            { fileData: { mimeType: 'video/mp4', fileUri: videoUrl } },
            { text: 'Transcribe this video.' },
          ],
        }],
        generationConfig: { temperature: 0.1, responseMimeType: 'application/json' },
      },
      120_000,
      'capture:youtube:tier3',
    )
    const data = json as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> }
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text
    if (!text) return null
    const parsed = JSON.parse(text) as { transcript?: string; language?: string | null }
    if (!parsed.transcript || parsed.transcript.length < 50) return null
    return { transcript: formatTranscriptText(parsed.transcript), language: parsed.language ?? null }
  } catch {
    return null
  }
}

// ─── CapturedSource ──────────────────────────────────────────────────────────

interface CapturedSource {
  content: string
  title: string
  source_type: 'youtube'
  source_url: string | null
  metadata: Record<string, unknown>
}

// ─── Handler ─────────────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<VercelResponse> {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')

  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const userId = await getUserIdFromRequest(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })

  const body = req.body as { url?: string } | undefined
  const rawUrl = body?.url?.trim()
  if (!rawUrl) return res.status(400).json({ error: 'url is required' })

  const videoId = extractVideoId(rawUrl)
  if (!videoId) return res.status(400).json({ error: 'Not a recognised YouTube URL.' })

  const videoUrl = canonicalYoutubeUrl(videoId)
  const startedAt = Date.now()

  const meta = await fetchVideoMetadata(videoId)

  // Tier 1: Apify
  let transcript: string | null = null
  let language: string | null = 'en'
  let tierUsed: 1 | 2 | 3 | null = null

  transcript = await tier1Apify(videoUrl)
  if (transcript) tierUsed = 1
  log({ stage: 'capture:youtube:tier1', user_id: userId, video_id: videoId, status: transcript ? 'ok' : 'skipped' })

  // Tier 2: youtube-caption-extractor
  if (!transcript) {
    transcript = await tier2YoutubeCaptionExtractor(videoId)
    if (transcript) tierUsed = 2
    log({ stage: 'capture:youtube:tier2', user_id: userId, video_id: videoId, status: transcript ? 'ok' : 'skipped' })
  }

  // Tier 3: Gemini video
  if (!transcript) {
    const result = await tier3GeminiVideo(videoUrl)
    if (result) {
      transcript = result.transcript
      language = result.language ?? language
      tierUsed = 3
    }
    log({ stage: 'capture:youtube:tier3', user_id: userId, video_id: videoId, status: transcript ? 'ok' : 'skipped' })
  }

  if (!transcript) {
    logError({ stage: 'capture:youtube', user_id: userId, video_id: videoId, status: 'failed', error: 'all tiers failed' })
    return res.status(422).json({ error: 'Could not get a transcript for this video. It may have no captions and the audio could not be transcribed.' })
  }

  if (transcript.length > TRANSCRIPT_MAX_CHARS) {
    return res.status(413).json({
      error: `Transcript is too large (${transcript.length.toLocaleString()} characters; maximum ${TRANSCRIPT_MAX_CHARS.toLocaleString()}).`,
    })
  }

  const title = (meta.title?.trim() || `YouTube video ${videoId}`).slice(0, 200)

  const captured: CapturedSource = {
    content: transcript,
    title,
    source_type: 'youtube',
    source_url: videoUrl,
    metadata: {
      video_id: videoId,
      channel: meta.channel,
      duration_seconds: meta.duration_seconds,
      published_at: meta.published_at,
      thumbnail_url: meta.thumbnail_url,
      char_count: transcript.length,
      language,
      tier_used: tierUsed,
      duration_ms: Date.now() - startedAt,
    },
  }

  log({ stage: 'capture:youtube', user_id: userId, video_id: videoId, status: 'ok', duration_ms: Date.now() - startedAt, tier_used: tierUsed, char_count: transcript.length })

  return res.status(200).json(captured)
}
