import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL!
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY!
const GEMINI_API_KEY = process.env.GEMINI_API_KEY!
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models'
const GEMINI_MODEL = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash'

if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !GEMINI_API_KEY) {
  throw new Error('[gemini/rerank] Missing required env vars')
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
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify(body),
    })
    if (!resp.ok) {
      const txt = await resp.text().catch(() => '')
      throw new Error(`Gemini ${resp.status}: ${txt.slice(0, 200)}`)
    }
    const json = await resp.json() as { usageMetadata?: GeminiUsage }
    return { json, usage: json.usageMetadata }
  } finally {
    clearTimeout(timer)
  }
}

interface RerankBody {
  query: string
  passages: string[]
}

function isRerankBody(b: unknown): b is RerankBody {
  if (!b || typeof b !== 'object') return false
  const obj = b as Record<string, unknown>
  if (typeof obj.query !== 'string' || obj.query.trim().length === 0) return false
  if (!Array.isArray(obj.passages)) return false
  if (obj.passages.length === 0 || obj.passages.length > 50) return false
  return obj.passages.every(p => typeof p === 'string')
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method_not_allowed' })
  }

  const userId = await getUserIdFromRequest(req)
  if (!userId) {
    return res.status(401).json({ error: 'unauthenticated' })
  }

  if (!isRerankBody(req.body)) {
    return res.status(400).json({ error: 'invalid_request', detail: 'Expected { query: string, passages: string[] (1-50) }' })
  }

  const { query, passages } = req.body
  const candidateList = passages.map((p, i) => `[${i}] ${p.slice(0, 150)}`).join('\n')

  const prompt = `Score each passage 0-10 for relevance to the query. Return ONLY a JSON array of ${passages.length} integers, nothing else.

Query: "${query}"

${candidateList}`

  const startedAt = Date.now()
  try {
    const { json, usage } = await geminiFetch(
      `${GEMINI_MODEL}:generateContent`,
      {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          maxOutputTokens: 1024,
          temperature: 0,
          responseMimeType: 'application/json',
          thinkingConfig: { thinkingBudget: 0 },
        },
      },
      20_000,
    )
    const data = json as {
      candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] } }[]
    }
    const parts = data.candidates?.[0]?.content?.parts ?? []
    const textPart = parts.find(p => p.thought !== true && typeof p.text === 'string')
      ?? parts.find(p => typeof p.text === 'string')
    const text = textPart?.text ?? ''

    console.log(JSON.stringify({
      stage: 'gemini:rerank',
      user_id: userId,
      passages: passages.length,
      duration_ms: Date.now() - startedAt,
      status: 'ok',
      prompt_tokens: usage?.promptTokenCount,
      output_tokens: usage?.candidatesTokenCount,
    }))

    return res.status(200).json({ text })
  } catch (err) {
    console.log(JSON.stringify({
      stage: 'gemini:rerank',
      user_id: userId,
      duration_ms: Date.now() - startedAt,
      status: 'error',
      error: (err as Error).message,
    }))
    return res.status(502).json({ error: 'vendor', detail: (err as Error).message })
  }
}
