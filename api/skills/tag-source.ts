/**
 * api/skills/tag-source.ts
 *
 * Vercel serverless function — single-source tagging called inline
 * during the ingestion pipeline.
 * CRITICAL: Fully self-contained. No local imports. All helpers defined inline.
 *
 * PRD: PRD-25b — Skill Detection Infrastructure
 */

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createClient } from '@supabase/supabase-js'

export const maxDuration = 10

// ─── ENVIRONMENT ──────────────────────────────────────────────────────────────

const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? ''
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''

// ─── CANDIDACY GATE (inline — no local imports) ──────────────────────────────

const SOURCE_TYPE_SCORES: Record<string, number> = {
  YouTube: 1.0,
  Document: 0.7,
  Research: 0.7,
  Meeting: 0.4,
  Note: 0.2,
  Web: 0.5,
}

const INSTRUCTIONAL_TYPES = new Set([
  'Topic', 'Technology', 'Concept', 'Insight',
  'Idea', 'Hypothesis', 'Lesson', 'Takeaway',
])

interface CandidacyChecks {
  sourceTypeScore: number
  instructionalRatio: number
  chunkCount: number
  check1Pass: boolean
  check2Pass: boolean
  check3Pass: boolean
  passCount: number
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

function evaluateCandidacy(
  sourceType: string,
  entityTypes: string[],
  chunkCount: number,
): { isCandidate: boolean; checks: CandidacyChecks } {
  const check1 = SOURCE_TYPE_SCORES[sourceType] ?? 0.3
  const check1Pass = check1 >= 0.5

  const totalEntities = entityTypes.length
  const instructionalCount = entityTypes.filter(t => INSTRUCTIONAL_TYPES.has(t)).length
  const instructionalRatio = totalEntities > 0 ? instructionalCount / totalEntities : 0
  const check2Pass = instructionalRatio >= 0.35

  const check3Pass = chunkCount >= 3

  const passCount = [check1Pass, check2Pass, check3Pass].filter(Boolean).length
  const isCandidate = passCount >= 2

  return {
    isCandidate,
    checks: {
      sourceTypeScore: check1,
      instructionalRatio: Math.round(instructionalRatio * 100) / 100,
      chunkCount,
      check1Pass,
      check2Pass,
      check3Pass,
      passCount,
    },
  }
}

// ─── AUTH ─────────────────────────────────────────────────────────────────────

function getSupabase() {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
}

async function getUserFromToken(req: VercelRequest): Promise<string | null> {
  const auth = req.headers['authorization']
  if (!auth?.startsWith('Bearer ')) return null
  const token = auth.slice(7)
  const supabase = getSupabase()
  const { data } = await supabase.auth.getUser(token)
  return data?.user?.id ?? null
}

// ─── MAIN HANDLER ─────────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: 'Supabase not configured' })
  }

  const userId = await getUserFromToken(req)
  if (!userId) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const { source_id, source_type, entity_types, chunk_count } = req.body ?? {}

  if (!source_id || !source_type) {
    return res.status(400).json({ error: 'Missing required fields: source_id, source_type' })
  }

  const supabase = getSupabase()

  try {
    const { isCandidate, checks } = evaluateCandidacy(
      source_type,
      entity_types ?? [],
      chunk_count ?? 0,
    )

    // Fetch existing metadata to avoid overwriting
    const { data: source } = await supabase
      .from('knowledge_sources')
      .select('metadata')
      .eq('id', source_id)
      .eq('user_id', userId)
      .maybeSingle()

    const existingMetadata = (source?.metadata as Record<string, unknown>) ?? {}

    await supabase
      .from('knowledge_sources')
      .update({
        metadata: {
          ...existingMetadata,
          skill_candidate: isCandidate,
          skill_candidate_evaluated_at: new Date().toISOString(),
          skill_candidate_checks: checks,
        },
      })
      .eq('id', source_id)
      .eq('user_id', userId)

    return res.status(200).json({
      source_id,
      is_candidate: isCandidate,
      checks,
    })
  } catch (err) {
    console.error('[tag-source] Error:', err)
    return res.status(500).json({
      error: 'Tagging failed',
      detail: err instanceof Error ? err.message : 'Unknown error',
    })
  }
}
