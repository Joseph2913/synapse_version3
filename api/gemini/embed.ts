import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL!
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY!
const GEMINI_API_KEY = process.env.GEMINI_API_KEY!
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models'
const EMBED_MODEL = 'gemini-embedding-001'
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

async function embedSingle(text: string): Promise<number[] | null> {
  const url = `${GEMINI_BASE}/${EMBED_MODEL}:embedContent?key=${GEMINI_API_KEY}`
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: `models/${EMBED_MODEL}`,
          content: { parts: [{ text }] },
        }),
      })
      if (resp.ok) {
        const data = await resp.json() as { embedding?: { values?: number[] } }
        return data.embedding?.values ?? null
      }
      if (resp.status === 429 || resp.status >= 500) {
        if (attempt < 2) {
          await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)))
          continue
        }
      }
      return null
    } catch {
      if (attempt < 2) {
        await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)))
        continue
      }
      return null
    }
  }
  return null
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
  for (let i = 0; i < texts.length; i += concurrency) {
    const slice = texts.slice(i, i + concurrency)
    const results = await Promise.all(slice.map(t => embedSingle(t)))
    results.forEach((v, j) => { embeddings[i + j] = v })
  }

  console.log(JSON.stringify({
    stage: 'gemini:embed',
    user_id: userId,
    count: texts.length,
    successes: embeddings.filter(e => e !== null).length,
    duration_ms: Date.now() - startedAt,
    status: 'ok',
  }))

  return res.status(200).json({ embeddings })
}
