/**
 * api/anchors/rescore-backfill.ts
 *
 * One-time (or periodic) retroactive backfill — rescores ALL non-anchor nodes
 * across ALL users using the full edge history (not just 7-day window).
 * Bypasses the momentum gate since historical nodes won't have recent activity
 * but may still be structurally important anchors.
 *
 * CRITICAL: Fully self-contained. No local imports (serverless constraint).
 *
 * Trigger manually:
 *   curl -X POST https://<domain>/api/anchors/rescore-backfill \
 *     -H "Authorization: Bearer $CRON_SECRET"
 *
 * Optional query params:
 *   ?dry_run=true        — compute scores but don't write (returns stats only)
 *   ?user_id=<uuid>      — limit to a single user
 *   ?max_users=10        — limit number of users processed (default: all)
 *   ?min_edges=2         — minimum total edges for a node to be scored (default: 2)
 */

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createClient } from '@supabase/supabase-js'

export const maxDuration = 300

// ─── ENVIRONMENT ──────────────────────────────────────────────────────────────
const SUPABASE_URL              = process.env.SUPABASE_URL!
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!
const CRON_SECRET               = process.env.CRON_SECRET

const getSupabase = () => createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

// ─── AUTH ─────────────────────────────────────────────────────────────────────

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

function verifyCronAuth(req: VercelRequest): boolean {
  if (req.headers['x-vercel-signature']) return true
  if (!CRON_SECRET) return true
  const auth = req.headers['authorization']
  return !!(auth && auth === `Bearer ${CRON_SECRET}`)
}

// ─── SCORING CONFIG (mirrors score-daily.ts with new lowered thresholds) ─────
type ScoringProfile = 'balanced' | 'emerging_topics' | 'deep_concepts' | 'active_focus' | 'well_evidenced'

const DEFAULT_SUGGESTION_THRESHOLD = 0.25
const AUTO_CONFIRM_THRESHOLD = 0.45

const SIGNAL_WEIGHTS: Record<ScoringProfile, {
  centrality: number; diversity: number; richness: number
}> = {
  balanced:        { centrality: 0.50, diversity: 0.30, richness: 0.20 },
  emerging_topics: { centrality: 0.25, diversity: 0.25, richness: 0.50 },
  deep_concepts:   { centrality: 0.55, diversity: 0.20, richness: 0.25 },
  active_focus:    { centrality: 0.35, diversity: 0.25, richness: 0.40 },
  well_evidenced:  { centrality: 0.30, diversity: 0.50, richness: 0.20 },
}

function resolveUserConfig(processingPreferences: Record<string, unknown> | null) {
  const stored = ((processingPreferences ?? {}).anchor_settings ?? {}) as Record<string, unknown>
  return {
    suggestionThreshold: (stored.suggestionThreshold as number) ?? DEFAULT_SUGGESTION_THRESHOLD,
    scoringProfile:      (stored.scoringProfile as ScoringProfile) ?? 'balanced',
  }
}

// ─── HANDLER ──────────────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  if (req.method === 'OPTIONS') return res.status(200).end()

  if (!verifyCronAuth(req)) return res.status(401).json({ error: 'Unauthorized' })

  const startTime = Date.now()
  const sb = getSupabase()
  const now = Date.now()

  const dryRun   = req.query.dry_run === 'true'
  const limitUserId = (req.query.user_id ?? (req.body as Record<string, unknown>)?.userId) as string | undefined
  const maxUsers = parseInt(req.query.max_users as string) || 0
  const minEdges = parseInt(req.query.min_edges as string) || 2

  try {
    // ── 1. Enumerate users ────────────────────────────────────────────────────
    let userIds: string[]

    if (limitUserId) {
      userIds = [limitUserId]
    } else {
      // Get all distinct users who have knowledge nodes
      const { data: userRows, error: userErr } = await sb
        .from('knowledge_nodes')
        .select('user_id')

      if (userErr) throw new Error(`Failed to fetch users: ${userErr.message}`)

      const uniqueIds = [...new Set((userRows ?? []).map(r => r.user_id as string))]
      userIds = maxUsers > 0 ? uniqueIds.slice(0, maxUsers) : uniqueIds
    }

    const perUser: Record<string, {
      totalNodes: number
      eligibleNodes: number
      scored: number
      newCandidates: number
      updatedCandidates: number
      surfaced: number
    }> = {}

    let grandTotalScored = 0
    let grandTotalSurfaced = 0

    for (const userId of userIds) {
      // Time budget — leave 20s buffer for response
      if (Date.now() - startTime > 280_000) {
        console.warn(`[rescore-backfill] Time budget exhausted after ${Object.keys(perUser).length} users`)
        break
      }

      // ── 2. Load user config ───────────────────────────────────────────────
      const { data: profile } = await sb
        .from('user_profiles')
        .select('processing_preferences')
        .eq('user_id', userId)
        .maybeSingle()

      const config = resolveUserConfig(
        (profile?.processing_preferences ?? null) as Record<string, unknown> | null
      )
      const w = SIGNAL_WEIGHTS[config.scoringProfile]
      const threshold = config.suggestionThreshold

      // ── 3. Fetch all non-anchor nodes ─────────────────────────────────────
      const { data: nodeRows } = await sb
        .from('knowledge_nodes')
        .select('id, source_id, source_type, entity_type, is_anchor, created_at')
        .eq('user_id', userId)
        .eq('is_anchor', false)

      const nodes = (nodeRows ?? []) as Array<{
        id: string; source_id: string | null; source_type: string | null
        entity_type: string; is_anchor: boolean; created_at: string
      }>

      if (nodes.length === 0) {
        perUser[userId] = { totalNodes: 0, eligibleNodes: 0, scored: 0, newCandidates: 0, updatedCandidates: 0, surfaced: 0 }
        continue
      }

      const nodeIds = nodes.map(n => n.id)
      const nodeMap = new Map(nodes.map(n => [n.id, n]))

      // ── 4. Fetch ALL edges for these nodes (both directions) ──────────────
      // Process in chunks to avoid hitting Supabase row limits
      const chunkSize = 500
      const allOutEdges: Array<{ source_node_id: string; target_node_id: string; relation_type: string }> = []
      const allInEdges: Array<{ source_node_id: string; target_node_id: string; relation_type: string }> = []

      for (let c = 0; c < nodeIds.length; c += chunkSize) {
        const chunk = nodeIds.slice(c, c + chunkSize)
        const [outRes, inRes] = await Promise.all([
          sb.from('knowledge_edges')
            .select('source_node_id, target_node_id, relation_type')
            .in('source_node_id', chunk)
            .eq('user_id', userId),
          sb.from('knowledge_edges')
            .select('source_node_id, target_node_id, relation_type')
            .in('target_node_id', chunk)
            .eq('user_id', userId),
        ])
        allOutEdges.push(...(outRes.data ?? []) as typeof allOutEdges)
        allInEdges.push(...(inRes.data ?? []) as typeof allInEdges)
      }

      // Build per-node edge counts
      const nodeEdgeCounts = new Map<string, number>()
      for (const e of [...allOutEdges, ...allInEdges]) {
        const src = e.source_node_id
        const tgt = e.target_node_id
        if (nodeMap.has(src)) nodeEdgeCounts.set(src, (nodeEdgeCounts.get(src) ?? 0) + 1)
        if (nodeMap.has(tgt)) nodeEdgeCounts.set(tgt, (nodeEdgeCounts.get(tgt) ?? 0) + 1)
      }

      // Filter to nodes with enough edges
      const eligibleIds = nodeIds.filter(id => (nodeEdgeCounts.get(id) ?? 0) >= minEdges)

      if (eligibleIds.length === 0) {
        perUser[userId] = { totalNodes: nodes.length, eligibleNodes: 0, scored: 0, newCandidates: 0, updatedCandidates: 0, surfaced: 0 }
        continue
      }

      // ── 5. Fetch neighbour metadata ─────────────────────────────────────────
      const eligibleSet = new Set(eligibleIds)
      const neighbourIds = new Set<string>()
      for (const e of [...allOutEdges, ...allInEdges]) {
        if (eligibleSet.has(e.source_node_id)) neighbourIds.add(e.target_node_id)
        if (eligibleSet.has(e.target_node_id)) neighbourIds.add(e.source_node_id)
      }
      for (const id of eligibleIds) neighbourIds.delete(id)

      const nbList = Array.from(neighbourIds)
      const neighbourMap = new Map<string, { entity_type: string; is_anchor: boolean; source_id: string | null; source_type: string | null }>()

      for (let c = 0; c < nbList.length; c += chunkSize) {
        const chunk = nbList.slice(c, c + chunkSize)
        const { data: nbNodes } = await sb
          .from('knowledge_nodes')
          .select('id, entity_type, is_anchor, source_id, source_type')
          .in('id', chunk)
          .eq('user_id', userId)

        for (const n of (nbNodes ?? [])) {
          neighbourMap.set(n.id as string, n as { entity_type: string; is_anchor: boolean; source_id: string | null; source_type: string | null })
        }
      }

      // ── 6. Fetch existing candidates for upsert logic ───────────────────────
      const { data: existingCandidates } = await sb
        .from('anchor_candidates')
        .select('id, node_id, status, dismiss_count, composite_score')
        .eq('user_id', userId)
        .in('node_id', eligibleIds)

      const existingMap = new Map(
        (existingCandidates ?? []).map(c => [c.node_id as string, c])
      )

      // ── 7. Score each eligible node ─────────────────────────────────────────
      const protectedStatuses = ['confirmed', 'dismissed', 'archived', 'dormant']
      const nowStr = new Date().toISOString()
      let scored = 0, newCandidates = 0, updatedCandidates = 0, surfaced = 0

      for (const nodeId of eligibleIds) {
        const nodeRow = nodeMap.get(nodeId)
        if (!nodeRow) continue

        const myOut = allOutEdges.filter(e => e.source_node_id === nodeId)
        const myIn  = allInEdges.filter(e => e.target_node_id === nodeId)
        const myAll = [...myOut, ...myIn]

        const relTypes = new Set(myAll.map(e => e.relation_type).filter(Boolean))
        const nbTypeSet = new Set<string>()
        let anchorNb = 0, totalNb = 0

        const srcIdSet = new Set<string>()
        const srcTypeSet = new Set<string>()
        if (nodeRow.source_id) srcIdSet.add(nodeRow.source_id)
        if (nodeRow.source_type) srcTypeSet.add(nodeRow.source_type)

        for (const e of myOut) {
          const nb = neighbourMap.get(e.target_node_id)
          if (nb) {
            nbTypeSet.add(nb.entity_type)
            totalNb++
            if (nb.is_anchor) anchorNb++
            if (nb.source_id) srcIdSet.add(nb.source_id)
            if (nb.source_type) srcTypeSet.add(nb.source_type)
          }
        }
        for (const e of myIn) {
          const nb = neighbourMap.get(e.source_node_id)
          if (nb) {
            nbTypeSet.add(nb.entity_type)
            totalNb++
            if (nb.is_anchor) anchorNb++
            if (nb.source_id) srcIdSet.add(nb.source_id)
            if (nb.source_type) srcTypeSet.add(nb.source_type)
          }
        }

        // Compute scores (same formulas as score-daily with new saturation points)
        const degreeScore     = Math.min(myAll.length / 20, 1.0)
        const diversityFactor = Math.min(nbTypeSet.size / 5, 1.0)
        const centralityScore = (degreeScore * 0.6) + (diversityFactor * 0.4)

        const sourceCountScore = Math.min(srcIdSet.size / 4, 1.0)
        const typeCountScore   = Math.min(srcTypeSet.size / 3, 1.0)
        const diversityScore   = (sourceCountScore * 0.65) + (typeCountScore * 0.35)

        const richnessScore = Math.min(relTypes.size / 6, 1.0)

        let composite = (centralityScore * w.centrality) +
          (diversityScore * w.diversity) + (richnessScore * w.richness)

        // Overlap penalty
        const overlapRatio = anchorNb / Math.max(totalNb, 1)
        if (overlapRatio > 0.70) composite *= 0.75

        // For backfill: no momentum gate, but apply a mild historical activity bonus
        // Nodes with more edges relative to their age get a small boost
        const daysActive = Math.max(1, Math.floor((now - new Date(nodeRow.created_at).getTime()) / 86400000))
        const edgeDensity = Math.min(myAll.length / Math.max(daysActive, 1), 1.0)
        const historyBoost = 0.80 + (edgeDensity * 0.20)  // 0.80–1.0 range
        composite = Math.min(Math.max(composite * historyBoost, 0), 1.0)

        // Build reasoning
        const parts: string[] = []
        if (myAll.length >= 10) parts.push(`${myAll.length} total connections`)
        else parts.push(`${myAll.length} connections`)
        if (srcIdSet.size >= 2) parts.push(`across ${srcIdSet.size} sources`)
        if (srcTypeSet.size >= 2) parts.push(`spanning ${srcTypeSet.size} content types`)
        if (relTypes.size >= 3) parts.push(`with ${relTypes.size} relationship types`)
        if (anchorNb >= 1) parts.push(`connects to ${anchorNb} existing anchor${anchorNb > 1 ? 's' : ''}`)

        const reasoningText = parts.join(', ') + '. (Retroactive backfill)'
        const shouldAutoConfirm = composite >= AUTO_CONFIRM_THRESHOLD
        const shouldSurface = composite >= threshold

        if (!dryRun) {
          const existing = existingMap.get(nodeId)

          if (existing) {
            const updatePayload: Record<string, unknown> = {
              composite_score:     composite,
              centrality_score:    centralityScore,
              diversity_score:     diversityScore,
              velocity_score:      0,
              richness_score:      richnessScore,
              mention_count:       myAll.length,
              source_count:        srcIdSet.size,
              unique_source_types: srcTypeSet.size,
              days_active:         daysActive,
              recent_velocity:     0,
              velocity_direction:  'stable',
              scoring_profile:     config.scoringProfile,
              reasoning_text:      reasoningText,
              last_scored_at:      nowStr,
              threshold_at_scoring: threshold,
            }

            // Auto-confirm: upgrade pending/suggested → confirmed
            if (shouldAutoConfirm && !['confirmed', 'archived', 'dormant'].includes(existing.status as string)) {
              updatePayload.status = 'confirmed'
              updatePayload.reviewed_at = nowStr
              updatePayload.suggested_at = updatePayload.suggested_at ?? nowStr
              surfaced++
              await sb.from('knowledge_nodes').update({ is_anchor: true }).eq('id', nodeId)
            } else if (!protectedStatuses.includes(existing.status as string) && shouldSurface && existing.status === 'pending') {
              updatePayload.status = 'suggested'
              updatePayload.suggested_at = nowStr
              surfaced++
            }

            await sb.from('anchor_candidates').update(updatePayload).eq('id', existing.id as string)
            updatedCandidates++
          } else {
            const insertStatus = shouldAutoConfirm ? 'confirmed' : (shouldSurface ? 'suggested' : 'pending')
            await sb.from('anchor_candidates').insert({
              user_id: userId, node_id: nodeId,
              composite_score:     composite,
              centrality_score:    centralityScore,
              diversity_score:     diversityScore,
              velocity_score:      0,
              richness_score:      richnessScore,
              behavioural_score:   0,
              mention_count:       myAll.length,
              source_count:        srcIdSet.size,
              unique_source_types: srcTypeSet.size,
              days_active:         daysActive,
              recent_velocity:     0,
              velocity_direction:  'stable',
              status:              insertStatus,
              scoring_profile:     config.scoringProfile,
              reasoning_text:      reasoningText,
              threshold_at_scoring: threshold,
              suggested_at:        insertStatus !== 'pending' ? nowStr : null,
              reviewed_at:         insertStatus === 'confirmed' ? nowStr : null,
              first_scored_at:     nowStr,
              last_scored_at:      nowStr,
            })
            newCandidates++
            if (insertStatus === 'confirmed') {
              await sb.from('knowledge_nodes').update({ is_anchor: true }).eq('id', nodeId)
              surfaced++
            } else if (insertStatus === 'suggested') {
              surfaced++
            }
          }
        } else {
          // Dry run — just count what would happen
          const existing = existingMap.get(nodeId)
          if (!existing) newCandidates++
          else updatedCandidates++
          if (shouldAutoConfirm || shouldSurface) surfaced++
        }

        scored++
      }

      perUser[userId] = {
        totalNodes: nodes.length,
        eligibleNodes: eligibleIds.length,
        scored,
        newCandidates,
        updatedCandidates,
        surfaced,
      }
      grandTotalScored += scored
      grandTotalSurfaced += surfaced

      console.log(
        `[rescore-backfill] userId=${userId} nodes=${nodes.length} eligible=${eligibleIds.length} ` +
        `scored=${scored} new=${newCandidates} updated=${updatedCandidates} surfaced=${surfaced}`
      )
    }

    return res.status(200).json({
      success: true,
      dryRun,
      totalUsers: userIds.length,
      processedUsers: Object.keys(perUser).length,
      grandTotalScored,
      grandTotalSurfaced,
      duration_ms: Date.now() - startTime,
      perUser,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[rescore-backfill] Fatal error:', msg)
    return res.status(500).json({ success: false, error: msg, duration_ms: Date.now() - startTime })
  }
}
