import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// ─── Env ─────────────────────────────────────────────────────────────────────

const SUPABASE_URL = process.env.SUPABASE_URL!
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY!
const GEMINI_API_KEY = process.env.GEMINI_API_KEY!
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models'
const GEMINI_MODEL = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash'

if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !GEMINI_API_KEY) {
  throw new Error('[gemini/classify-query] Missing required env vars')
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

// ─── Handler ─────────────────────────────────────────────────────────────────

interface ClassifyBody {
  question: string
  conversationContext?: string
}

function isClassifyBody(b: unknown): b is ClassifyBody {
  if (!b || typeof b !== 'object') return false
  const obj = b as Record<string, unknown>
  if (typeof obj.question !== 'string' || obj.question.trim().length === 0) return false
  if (obj.conversationContext !== undefined && typeof obj.conversationContext !== 'string') return false
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

  if (!isClassifyBody(req.body)) {
    return res.status(400).json({ error: 'invalid_request', detail: 'Expected { question: string, conversationContext?: string }' })
  }

  const { question, conversationContext } = req.body

  const prompt = `Classify this knowledge graph query. Return ONLY valid JSON.

Query: "${question}"
${conversationContext ? `Conversation context: "${conversationContext}"` : ''}

Classify into:
- intent: factual (specific fact/date/name), analytical (why/how/implications), comparative (X vs Y), exploratory (open-ended/what exists), temporal (timeline/evolution/latest), actionable (risks/actions/decisions)
- retrieval: { chunkCount (3-20), traversalHops (1-3), prioritiseRecency (bool), needsBroadSearch (bool) }
- responseFormat: prose (default analysis), list (ranked items), comparison (structured side-by-side), timeline (chronological), summary (concise overview)
- thinkingBudget: 0 (simple fact), 1024 (moderate), 4096 (complex analysis), 8192 (deep multi-source reasoning)
- suggestFollowUp: true if the topic has natural depth to explore further
- confidence: 0-1

Return only the JSON object.`

  const startedAt = Date.now()
  try {
    const { json, usage } = await geminiFetch(
      `${GEMINI_MODEL}:generateContent`,
      {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          maxOutputTokens: 512,
          temperature: 0,
          responseMimeType: 'application/json',
          thinkingConfig: { thinkingBudget: 0 },
        },
      },
      15_000,
      'gemini:classify-query',
    )
    const data = json as {
      candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] } }[]
    }
    const parts = data.candidates?.[0]?.content?.parts ?? []
    const textPart = parts.find(p => p.thought !== true && typeof p.text === 'string')
      ?? parts.find(p => typeof p.text === 'string')
    const text = textPart?.text ?? ''

    console.log(JSON.stringify({
      stage: 'gemini:classify-query',
      user_id: userId,
      duration_ms: Date.now() - startedAt,
      status: 'ok',
      prompt_tokens: usage?.promptTokenCount,
      output_tokens: usage?.candidatesTokenCount,
    }))

    return res.status(200).json({ text })
  } catch (err) {
    console.log(JSON.stringify({
      stage: 'gemini:classify-query',
      user_id: userId,
      duration_ms: Date.now() - startedAt,
      status: 'error',
      error: (err as Error).message,
    }))
    return res.status(502).json({ error: 'vendor', detail: (err as Error).message })
  }
}
