import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL!
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY!
const GEMINI_API_KEY = process.env.GEMINI_API_KEY!
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models'
const GEMINI_EMBEDDING_MODEL = 'gemini-embedding-001'
const MAX_BATCH = 100

if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !GEMINI_API_KEY) {
  throw new Error('[gemini/embed] Missing required env vars')
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

async function embedText(text: string, timeoutMs = 30000, stage = 'gemini:embed'): Promise<number[]> {
  const { json } = await geminiFetch(
    `${GEMINI_EMBEDDING_MODEL}:embedContent`,
    { model: `models/${GEMINI_EMBEDDING_MODEL}`, content: { parts: [{ text }] } },
    timeoutMs,
    stage,
  )
  const data = json as { embedding?: { values?: number[] } }
  if (!data.embedding?.values) throw new Error('No embedding in Gemini response')
  return data.embedding.values
}

interface EmbedBody {
  texts: string[]
}

function isEmbedBody(b: unknown): b is EmbedBody {
  if (!b || typeof b !== 'object') return false
  const o = b as Record<string, unknown>
  if (!Array.isArray(o.texts)) return false
  if (o.texts.length === 0 || o.texts.length > MAX_BATCH) return false
  return o.texts.every(t => typeof t === 'string')
}

async function embedSingle(text: string): Promise<{ values: number[] | null; error?: string }> {
  try {
    const values = await embedText(text, 30_000, 'gemini:embed')
    return { values }
  } catch (err) {
    return { values: null, error: (err as Error).message || 'unknown' }
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' })

  const userId = await getUserIdFromRequest(req)
  if (!userId) return res.status(401).json({ error: 'unauthenticated' })

  if (!isEmbedBody(req.body)) {
    return res.status(400).json({ error: 'invalid_request', detail: `Expected { texts: string[] (1-${MAX_BATCH}) }` })
  }

  const { texts } = req.body
  const startedAt = Date.now()

  // Embed in parallel with concurrency cap
  const concurrency = 5
  const embeddings: (number[] | null)[] = new Array(texts.length).fill(null)
  const errors: string[] = []
  for (let i = 0; i < texts.length; i += concurrency) {
    const slice = texts.slice(i, i + concurrency)
    const results = await Promise.all(slice.map(t => embedSingle(t)))
    results.forEach((r, j) => {
      embeddings[i + j] = r.values
      if (r.error) errors.push(r.error)
    })
  }

  const successes = embeddings.filter(e => e !== null).length
  const allFailed = successes === 0
  const firstError = errors[0]

  console.log(JSON.stringify({
    stage: 'gemini:embed',
    user_id: userId,
    count: texts.length,
    successes,
    duration_ms: Date.now() - startedAt,
    status: allFailed ? 'error' : (successes < texts.length ? 'partial' : 'ok'),
    error: firstError,
  }))

  // If every embedding failed, surface a 502 instead of a misleading 200 with
  // an array of nulls — this makes runtime errors (referrer restriction, bad
  // key, vendor outage) visible to the browser instead of looking like
  // "embedding service is temporarily unavailable" further up the stack.
  if (allFailed) {
    return res.status(502).json({ error: 'vendor', detail: firstError ?? 'unknown' })
  }

  return res.status(200).json({ embeddings })
}
