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

const BATCH_SIZE = 50

async function getUser(req: VercelRequest): Promise<string | null> {
  const auth = req.headers.authorization
  if (!auth?.startsWith('Bearer ')) return null
  const token = auth.slice(7)
  const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
  try {
    const { data: { user } } = await sb.auth.getUser(token)
    return user?.id ?? null
  } catch { return null }
}

async function embedText(text: string): Promise<number[]> {
  const resp = await fetch(
    `${GEMINI_BASE}/gemini-embedding-001:embedContent?key=${GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'models/gemini-embedding-001', content: { parts: [{ text }] } }),
    }
  )
  const data = await resp.json()
  if (!data.embedding?.values) throw new Error('No embedding')
  return data.embedding.values as number[]
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

    const sb: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    })

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

      // Sequential embedding calls inside a batch to avoid Gemini rate limits.
      const updates: Array<{ id: string; embedding: string }> = []
      for (const row of batch) {
        try {
          const emb = await embedText(row.question)
          updates.push({ id: row.id, embedding: JSON.stringify(emb) })
        } catch (err) {
          console.error('[backfill-question-embeddings] embed failed for', row.id, err instanceof Error ? err.message : err)
        }
      }

      if (updates.length > 0) {
        const { error: upsertErr } = await sb
          .from('agent_standing_questions')
          .upsert(updates, { onConflict: 'id' })
        if (upsertErr) throw upsertErr
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
    console.error('[backfill-question-embeddings]', err)
    const message = err instanceof Error ? err.message : 'unknown'
    return res.status(500).json({ error: message })
  }
}
