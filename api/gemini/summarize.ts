import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// ─── Env ─────────────────────────────────────────────────────────────────────

const SUPABASE_URL = process.env.SUPABASE_URL!
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY!
const GEMINI_API_KEY = process.env.GEMINI_API_KEY!
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models'
const GEMINI_MODEL = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash'

if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !GEMINI_API_KEY) {
  throw new Error('[gemini/summarize] Missing required env vars')
}

// ─── Auth ────────────────────────────────────────────────────────────────────

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

// ─── Gemini ──────────────────────────────────────────────────────────────────

interface GeminiUsage {
  promptTokenCount?: number
  candidatesTokenCount?: number
  totalTokenCount?: number
}

async function geminiFetch(
  endpoint: string,
  body: unknown,
  timeoutMs: number,
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
        return { json, usage: json.usageMetadata }
      }
      const txt = await resp.text().catch(() => '')
      lastErr = new Error(`Gemini ${resp.status}: ${txt.slice(0, 200)}`)
      if ((resp.status === 429 || resp.status >= 500) && attempt < maxAttempts - 1) {
        await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)))
        continue
      }
      throw lastErr
    } catch (err) {
      lastErr = err as Error
      if (attempt < maxAttempts - 1 && (err as Error).name === 'AbortError') {
        continue
      }
      if (attempt >= maxAttempts - 1) throw lastErr
    } finally {
      clearTimeout(timer)
    }
  }
  throw lastErr ?? new Error('Gemini request failed')
}

// ─── Handler ─────────────────────────────────────────────────────────────────

interface SummarizeBody {
  content: string
  sourceType?: string | null
}

function isSummarizeBody(b: unknown): b is SummarizeBody {
  if (!b || typeof b !== 'object') return false
  const obj = b as Record<string, unknown>
  if (typeof obj.content !== 'string' || obj.content.trim().length === 0) return false
  if (obj.sourceType !== undefined && obj.sourceType !== null && typeof obj.sourceType !== 'string') return false
  return true
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method_not_allowed' })
  }

  const userId = await getUserIdFromRequest(req)
  if (!userId) {
    return res.status(401).json({ error: 'unauthenticated' })
  }

  if (!isSummarizeBody(req.body)) {
    return res.status(400).json({ error: 'invalid_request', detail: 'Expected { content: string, sourceType?: string|null }' })
  }

  const { content, sourceType } = req.body
  const truncatedContent = content.length > 8000
    ? content.slice(0, 8000) + '\n\n[Content truncated for summarization]'
    : content

  const sourceLabel = (sourceType ?? 'content').toLowerCase()

  const systemPrompt = `You are a concise summarizer. Given a piece of ${sourceLabel}, produce a 2–3 sentence summary that describes what this content contains. Rules:
- Be factual and descriptive, not analytical or evaluative.
- Describe the topics covered, not what the reader should take away.
- Use plain, professional language.
- Do not start with "This ${sourceLabel}..." — vary your openings.
- Do not reference the format ("this transcript", "this document") — summarize the substance.
- Maximum 300 characters.
- Return ONLY the summary text, no preamble, no quotes, no formatting.`

  const startedAt = Date.now()
  try {
    const { json, usage } = await geminiFetch(
      `${GEMINI_MODEL}:generateContent`,
      {
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents: [{ parts: [{ text: truncatedContent }] }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 150 },
      },
      30_000,
    )
    const data = json as { candidates?: { content?: { parts?: { text?: string }[] } }[] }
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? ''

    console.log(JSON.stringify({
      stage: 'gemini:summarize',
      user_id: userId,
      duration_ms: Date.now() - startedAt,
      status: 'ok',
      prompt_tokens: usage?.promptTokenCount,
      output_tokens: usage?.candidatesTokenCount,
    }))

    return res.status(200).json({ text })
  } catch (err) {
    console.log(JSON.stringify({
      stage: 'gemini:summarize',
      user_id: userId,
      duration_ms: Date.now() - startedAt,
      status: 'error',
      error: (err as Error).message,
    }))
    return res.status(502).json({ error: 'vendor', detail: (err as Error).message })
  }
}
