/**
 * api/council/backfill-question-embeddings.ts
 *
 * One-time backfill for agent_standing_questions.embedding. Pages through
 * rows with NULL embeddings in batches of 50, embeds sequentially with
 * gemini-embedding-001, and bulk upserts. Fully self-contained (no local imports).
 */

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

export const maxDuration = 300

const SUPABASE_URL = process.env.SUPABASE_URL!
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY!
const GEMINI_API_KEY = process.env.GEMINI_API_KEY!
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models'

if (!GEMINI_API_KEY) {
  throw new Error('[gemini] Missing env var: GEMINI_API_KEY')
}

const GEMINI_MODEL = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash'
const GEMINI_EMBEDDING_MODEL = 'gemini-embedding-001'
const BATCH_SIZE = 50

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !SUPABASE_ANON_KEY) {
  throw new Error('[supabase] Missing env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY')
}


// ─── Structured logging ─────────────────────────────────────────────────────

type LogStatus = 'ok' | 'failed' | 'partial' | 'skipped'

interface LogFields {
  stage: string
  user_id?: string
  source_id?: string
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

function getServiceSupabase(): SupabaseClient {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
}

function getAnonSupabase(): SupabaseClient {
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
}

async function getUser(req: VercelRequest): Promise<string | null> {
  const auth = req.headers.authorization
  if (!auth?.startsWith('Bearer ')) return null
  const token = auth.slice(7)
  try {
    const { data: { user } } = await getAnonSupabase().auth.getUser(token)
    return user?.id ?? null
  } catch { return null }
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

const EMBEDDING_BATCH_SIZE = 100

async function embedTexts(texts: string[], timeoutMs = 60000, stage = 'council:backfill-questions:embed'): Promise<number[][]> {
  if (texts.length === 0) return []
  const out: number[][] = []
  for (let start = 0; start < texts.length; start += EMBEDDING_BATCH_SIZE) {
    const slice = texts.slice(start, start + EMBEDDING_BATCH_SIZE)
    const { json } = await geminiFetch(
      `${GEMINI_EMBEDDING_MODEL}:batchEmbedContents`,
      { requests: slice.map(text => ({ model: `models/${GEMINI_EMBEDDING_MODEL}`, content: { parts: [{ text }] } })) },
      timeoutMs,
      stage
    )
    const data = json as { embeddings?: Array<{ values?: number[] }> }
    const vectors = (data.embeddings ?? []).map(e => e.values ?? [])
    if (vectors.length !== slice.length) throw new Error(`Batch embedding length mismatch: ${vectors.length} vs ${slice.length}`)
    out.push(...vectors)
  }
  return out
}

interface QuestionRow {
  id: string
  question: string
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<VercelResponse | void> {
  const startedAt = Date.now()
  try {
    const userId = await getUser(req)
    if (!userId) return res.status(401).json({ error: 'unauthorized' })

    const sb: SupabaseClient = getServiceSupabase()

    let totalUpdated = 0

    while (true) {
      const { data: rows, error } = await sb
        .from('agent_standing_questions')
        .select('id, question')
        .eq('user_id', userId)
        .is('embedding', null)
        .order('created_at', { ascending: true })
        .limit(BATCH_SIZE)
      if (error) throw error
      const batch = (rows ?? []) as QuestionRow[]
      if (batch.length === 0) break

      // Batch embedding: one network call per 100 questions instead of per question.
      const updates: Array<{ id: string; embedding: string }> = []
      try {
        const vectors = await embedTexts(batch.map(r => r.question))
        for (let i = 0; i < batch.length; i++) {
          const emb = vectors[i]
          if (emb && emb.length > 0) {
            updates.push({ id: batch[i]!.id, embedding: JSON.stringify(emb) })
          }
        }
      } catch (err) {
        logError({ stage: 'council:backfill', error: `batch embed failed: ${err instanceof Error ? err.message : String(err)}`, status: 'partial' })
      }

      if (updates.length > 0) {
        const { error: rpcErr } = await sb.rpc('bulk_set_question_embeddings', {
          p_user_id: userId,
          p_updates: updates,
        })
        if (rpcErr) {
          logError({ stage: 'council:backfill', error: `bulk_set_question_embeddings rpc error: ${rpcErr.message}`, status: 'failed' })
          throw new Error(`bulk_set_question_embeddings failed: ${rpcErr.message} (code=${rpcErr.code ?? 'none'}) details=${rpcErr.details ?? 'none'}`)
        }
        totalUpdated += updates.length
      }

      if (batch.length < BATCH_SIZE) break
    }

    return res.status(200).json({
      ok: true,
      updated: totalUpdated,
      duration_ms: Date.now() - startedAt,
    })
  } catch (err) {
    logError({ stage: 'council:backfill', error: err instanceof Error ? err.message : String(err), status: 'failed' })
    const message = err instanceof Error
      ? err.message
      : (typeof err === 'object' && err !== null ? JSON.stringify(err) : String(err))
    return res.status(500).json({ error: message })
  }
}
