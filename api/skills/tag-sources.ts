/**
 * api/skills/tag-sources.ts
 *
 * Vercel serverless function — retroactive backfill endpoint that evaluates
 * and tags all existing sources with skill_candidate metadata.
 * CRITICAL: Fully self-contained. No local imports. All helpers defined inline.
 *
 * PRD: PRD-25b — Skill Detection Infrastructure
 */

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createClient } from '@supabase/supabase-js'

export const maxDuration = 60

// ─── ENVIRONMENT ──────────────────────────────────────────────────────────────

const SUPABASE_URL = process.env.SUPABASE_URL!
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
  entityTypeCounts: Record<string, number>,
  chunkCount: number,
): { isCandidate: boolean; checks: CandidacyChecks } {
  const check1 = SOURCE_TYPE_SCORES[sourceType] ?? 0.3
  const check1Pass = check1 >= 0.5

  let totalEntities = 0
  let instructionalCount = 0
  for (const [type, count] of Object.entries(entityTypeCounts)) {
    totalEntities += count
    if (INSTRUCTIONAL_TYPES.has(type)) instructionalCount += count
  }
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

  const startTime = Date.now()
  const body = req.body ?? {}
  const force = body.force === true
  const dryRun = body.dry_run === true
  const batchSize = Math.min(body.batch_size ?? 20, 50)

  const supabase = getSupabase()

  try {
    // Step 1: Fetch sources needing tagging
    let sourceQuery = supabase
      .from('knowledge_sources')
      .select('id, title, source_type, metadata, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })

    if (!force) {
      // Only untagged sources — filter where skill_candidate is not set
      // Since we can't do IS NULL on JSONB paths easily with PostgREST,
      // we fetch all and filter in code
    }

    const { data: allSources, error: sourcesError } = await sourceQuery

    if (sourcesError) {
      return res.status(500).json({ error: 'Failed to fetch sources', detail: sourcesError.message })
    }

    const sources = force
      ? (allSources ?? [])
      : (allSources ?? []).filter(s => {
          const meta = s.metadata as Record<string, unknown> | null
          return !meta?.skill_candidate_evaluated_at
        })

    const skippedAlreadyTagged = (allSources?.length ?? 0) - sources.length

    // Process in batches
    const results: Array<{
      id: string
      title: string
      source_type: string
      is_candidate: boolean
      checks: CandidacyChecks
    }> = []

    for (let i = 0; i < sources.length; i += batchSize) {
      const batch = sources.slice(i, i + batchSize)

      const batchResults = await Promise.all(batch.map(async (source) => {
        // Fetch entity type counts
        const { data: nodeRows } = await supabase
          .from('knowledge_nodes')
          .select('entity_type')
          .eq('source_id', source.id)
          .eq('user_id', userId)

        const entityTypeCounts: Record<string, number> = {}
        for (const row of nodeRows ?? []) {
          const t = row.entity_type as string
          entityTypeCounts[t] = (entityTypeCounts[t] ?? 0) + 1
        }

        // Fetch chunk count
        const { count: chunkCount } = await supabase
          .from('source_chunks')
          .select('id', { count: 'exact', head: true })
          .eq('source_id', source.id)
          .eq('user_id', userId)

        const { isCandidate, checks } = evaluateCandidacy(
          source.source_type ?? 'Note',
          entityTypeCounts,
          chunkCount ?? 0,
        )

        // Write tag (unless dry run)
        if (!dryRun) {
          const existingMetadata = (source.metadata as Record<string, unknown>) ?? {}
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
            .eq('id', source.id)
            .eq('user_id', userId)
        }

        return {
          id: source.id,
          title: source.title ?? 'Untitled',
          source_type: source.source_type ?? 'Unknown',
          is_candidate: isCandidate,
          checks,
        }
      }))

      results.push(...batchResults)

      // Delay between batches to avoid rate limiting
      if (i + batchSize < sources.length) {
        await new Promise(resolve => setTimeout(resolve, 200))
      }
    }

    // Compute summary
    const taggedTrue = results.filter(r => r.is_candidate).length
    const taggedFalse = results.filter(r => !r.is_candidate).length

    const bySourceType: Record<string, { true: number; false: number }> = {}
    for (const r of results) {
      if (!bySourceType[r.source_type]) bySourceType[r.source_type] = { true: 0, false: 0 }
      bySourceType[r.source_type][r.is_candidate ? 'true' : 'false']++
    }

    let failedCheck1Only = 0
    let failedCheck2Only = 0
    let failedCheck3Only = 0
    let failedMultiple = 0
    for (const r of results.filter(r => !r.is_candidate)) {
      const failed = [!r.checks.check1Pass, !r.checks.check2Pass, !r.checks.check3Pass]
      const failCount = failed.filter(Boolean).length
      if (failCount > 1) failedMultiple++
      else if (!r.checks.check1Pass) failedCheck1Only++
      else if (!r.checks.check2Pass) failedCheck2Only++
      else if (!r.checks.check3Pass) failedCheck3Only++
    }

    return res.status(200).json({
      processed: results.length,
      tagged_true: taggedTrue,
      tagged_false: taggedFalse,
      skipped_already_tagged: skippedAlreadyTagged,
      dry_run: dryRun,
      duration_ms: Date.now() - startTime,
      breakdown: {
        by_source_type: bySourceType,
        check_failure_reasons: {
          failed_check1_only: failedCheck1Only,
          failed_check2_only: failedCheck2Only,
          failed_check3_only: failedCheck3Only,
          failed_multiple: failedMultiple,
        },
      },
      sources: results,
    })
  } catch (err) {
    console.error('[tag-sources] Fatal error:', err)
    return res.status(500).json({
      error: 'Backfill failed',
      detail: err instanceof Error ? err.message : 'Unknown error',
    })
  }
}
