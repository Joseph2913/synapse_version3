import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL!
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY!
const GEMINI_API_KEY = process.env.GEMINI_API_KEY!
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models'
const GEMINI_MODEL = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash'

if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !GEMINI_API_KEY) {
  throw new Error('[gemini/decompose-query] Missing required env vars')
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

interface DecomposeBody {
  question: string
}

function isBody(b: unknown): b is DecomposeBody {
  if (!b || typeof b !== 'object') return false
  const o = b as Record<string, unknown>
  return typeof o.question === 'string' && o.question.length > 0 && o.question.length <= 2000
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' })

  const userId = await getUserIdFromRequest(req)
  if (!userId) return res.status(401).json({ error: 'unauthenticated' })

  if (!isBody(req.body)) {
    return res.status(400).json({ error: 'invalid_request', detail: 'Expected { question: string (1-2000 chars) }' })
  }

  const { question } = req.body

  const prompt = `You are a search query decomposer. Break the following query into 2-3 focused noun-phrase sub-queries that together cover its full intent. Return ONLY a JSON array of strings.

Query: "${question}"

Rules:
- If the query is already focused on one topic, return it as a single-element array
- Return 2-3 sub-queries only when there are clearly distinct concepts ("AI research AND consulting" → two sub-queries)
- Each sub-query should be 3-8 words, focused on retrievable nouns/topics
- Do NOT include question words (what, how, who) — just the searchable concepts
- Example: "What connections between my AI research and consulting work?" → ["AI research projects", "consulting opportunities", "AI consulting connections"]

Return only the JSON array, nothing else.`

  const url = `${GEMINI_BASE}/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`
  const startedAt = Date.now()
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 15_000)
    let resp: Response
    try {
      resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0, responseMimeType: 'application/json' },
        }),
      })
    } finally {
      clearTimeout(timer)
    }
    if (!resp.ok) {
      const txt = await resp.text().catch(() => '')
      throw new Error(`Gemini ${resp.status}: ${txt.slice(0, 200)}`)
    }
    const data = await resp.json() as {
      candidates?: { content?: { parts?: { text?: string }[] } }[]
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number }
    }
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? ''

    console.log(JSON.stringify({
      stage: 'gemini:decompose-query',
      user_id: userId,
      duration_ms: Date.now() - startedAt,
      status: 'ok',
      prompt_tokens: data.usageMetadata?.promptTokenCount,
      output_tokens: data.usageMetadata?.candidatesTokenCount,
    }))

    return res.status(200).json({ text })
  } catch (err) {
    console.log(JSON.stringify({
      stage: 'gemini:decompose-query',
      user_id: userId,
      duration_ms: Date.now() - startedAt,
      status: 'error',
      error: (err as Error).message,
    }))
    return res.status(502).json({ error: 'vendor', detail: (err as Error).message })
  }
}
