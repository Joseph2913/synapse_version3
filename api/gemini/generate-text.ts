import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL!
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY!
const GEMINI_API_KEY = process.env.GEMINI_API_KEY!
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models'
const GEMINI_MODEL = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash'

if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !GEMINI_API_KEY) {
  throw new Error('[gemini/generate-text] Missing required env vars')
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

interface GenerateTextBody {
  systemPrompt: string
  userPrompt: string
  temperature?: number
  maxOutputTokens?: number
}

function isBody(b: unknown): b is GenerateTextBody {
  if (!b || typeof b !== 'object') return false
  const o = b as Record<string, unknown>
  if (typeof o.systemPrompt !== 'string') return false
  if (typeof o.userPrompt !== 'string') return false
  if (o.systemPrompt.length > 50_000 || o.userPrompt.length > 200_000) return false
  if (o.temperature !== undefined && typeof o.temperature !== 'number') return false
  if (o.maxOutputTokens !== undefined && typeof o.maxOutputTokens !== 'number') return false
  return true
}

interface GeminiUsage {
  promptTokenCount?: number
  candidatesTokenCount?: number
  totalTokenCount?: number
}

async function geminiFetch(body: unknown, timeoutMs: number) {
  const url = `${GEMINI_BASE}/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`
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
    } finally {
      clearTimeout(timer)
    }
  }
  throw lastErr ?? new Error('Gemini request failed')
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' })

  const userId = await getUserIdFromRequest(req)
  if (!userId) return res.status(401).json({ error: 'unauthenticated' })

  if (!isBody(req.body)) {
    return res.status(400).json({ error: 'invalid_request', detail: 'Expected { systemPrompt, userPrompt, temperature?, maxOutputTokens? }' })
  }

  const { systemPrompt, userPrompt, temperature, maxOutputTokens } = req.body
  const startedAt = Date.now()
  try {
    const { json, usage } = await geminiFetch({
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
      generationConfig: {
        temperature: temperature ?? 0.4,
        maxOutputTokens: maxOutputTokens ?? 4096,
      },
    }, 60_000)

    const data = json as { candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] } }[] }
    const parts = data.candidates?.[0]?.content?.parts ?? []
    const textPart = parts.find(p => p.thought !== true && typeof p.text === 'string')
      ?? parts.find(p => typeof p.text === 'string')
    const text = textPart?.text ?? ''

    console.log(JSON.stringify({
      stage: 'gemini:generate-text',
      user_id: userId,
      duration_ms: Date.now() - startedAt,
      status: 'ok',
      prompt_tokens: usage?.promptTokenCount,
      output_tokens: usage?.candidatesTokenCount,
    }))

    return res.status(200).json({ text })
  } catch (err) {
    console.log(JSON.stringify({
      stage: 'gemini:generate-text',
      user_id: userId,
      duration_ms: Date.now() - startedAt,
      status: 'error',
      error: (err as Error).message,
    }))
    return res.status(502).json({ error: 'vendor', detail: (err as Error).message })
  }
}
