import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// ─── Supabase env + factories ────────────────────────────────────────────────

const SUPABASE_URL = process.env.SUPABASE_URL!
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY!

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  throw new Error('[capture/url] Missing env vars: SUPABASE_URL, SUPABASE_ANON_KEY')
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

// ─── Gemini env + helpers ────────────────────────────────────────────────────

const GEMINI_API_KEY = process.env.GEMINI_API_KEY!
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models'
const GEMINI_MODEL = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash'

if (!GEMINI_API_KEY) {
  throw new Error('[capture/url] Missing env var: GEMINI_API_KEY')
}

interface GeminiUsage {
  promptTokenCount?: number
  candidatesTokenCount?: number
  totalTokenCount?: number
}

async function geminiFetch(
  endpoint: string,
  body: unknown,
  timeoutMs: number,
  stage: string,
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
            stage,
            model: endpoint.split(':')[0],
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

// ─── Capture contract types (mirror src/types/capture.ts to avoid local imports) ─

const URL_MAX_CHARS = 400_000

interface CapturedSource {
  content: string
  title: string
  source_type: 'url'
  source_url: string | null
  metadata: Record<string, unknown>
}

// ─── Prompt for Gemini URL Context extraction ─────────────────────────────────

const URL_EXTRACTION_PROMPT = `You are a content extraction assistant. The user will give you a URL.
Use the urlContext tool to fetch the page, then return ONE JSON object with:
- "title": the most natural human title for the page. Prefer og:title, then <title>, then <h1>, then the URL hostname.
- "content": the main readable article or page text. Strip navigation, ads, footers, cookie banners, and boilerplate. Keep paragraph breaks. Plain text only, no HTML.
- "language": ISO-639-1 code (e.g. "en") or null if uncertain.
- "fetched": true if you successfully read the page, false otherwise.
- "fetch_error": a short reason if fetched is false, otherwise null.
Return ONLY the JSON object. No commentary.`

interface UrlExtractionResult {
  title?: string
  content?: string
  language?: string | null
  fetched?: boolean
  fetch_error?: string | null
}

// ─── Handler ──────────────────────────────────────────────────────────────────

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

  let parsedUrl: URL
  try {
    parsedUrl = new URL(rawUrl.startsWith('http') ? rawUrl : `https://${rawUrl}`)
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      return res.status(400).json({ error: 'Only HTTP and HTTPS URLs are supported.' })
    }
  } catch {
    return res.status(400).json({ error: 'Invalid URL.' })
  }

  const startedAt = Date.now()

  let extracted: UrlExtractionResult
  try {
    const { json } = await geminiFetch(
      `${GEMINI_MODEL}:generateContent`,
      {
        system_instruction: { parts: [{ text: URL_EXTRACTION_PROMPT }] },
        contents: [{ parts: [{ text: parsedUrl.href }] }],
        tools: [{ urlContext: {} }],
        generationConfig: { temperature: 0.1, responseMimeType: 'application/json' },
      },
      60_000,
      'capture/url',
    )

    const data = json as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> }
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text
    if (!text) {
      console.warn('[capture/url] empty response from Gemini', { url: parsedUrl.href })
      return res.status(502).json({ error: 'Could not read this URL. The page may require sign-in or block automated readers.' })
    }
    extracted = JSON.parse(text) as UrlExtractionResult
  } catch (err) {
    console.error('[capture/url] Gemini call failed', { url: parsedUrl.href, error: err instanceof Error ? err.message : String(err) })
    return res.status(502).json({ error: 'Could not read this URL. The page may require sign-in or block automated readers.' })
  }

  if (extracted.fetched === false || !extracted.content || !extracted.content.trim()) {
    const reason = extracted.fetch_error ?? 'No readable content found at this URL.'
    return res.status(422).json({ error: reason })
  }

  let content = extracted.content
  if (content.length > URL_MAX_CHARS) {
    return res.status(413).json({
      error: `Page is too large. The extracted text is ${content.length.toLocaleString()} characters; maximum is ${URL_MAX_CHARS.toLocaleString()}.`,
    })
  }

  const title = (extracted.title?.trim() || parsedUrl.hostname).slice(0, 200)

  const captured: CapturedSource = {
    content,
    title,
    source_type: 'url',
    source_url: parsedUrl.href,
    metadata: {
      hostname: parsedUrl.hostname,
      char_count: content.length,
      language: extracted.language ?? null,
      duration_ms: Date.now() - startedAt,
    },
  }

  console.info(JSON.stringify({
    log: 'capture',
    adapter: 'url',
    source_type: 'url',
    content_size: content.length,
    duration_ms: Date.now() - startedAt,
    status: 'ok',
  }))

  return res.status(200).json(captured)
}
