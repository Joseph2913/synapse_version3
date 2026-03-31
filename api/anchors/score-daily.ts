import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createClient } from '@supabase/supabase-js'

export const maxDuration = 300

// ─── ENVIRONMENT ──────────────────────────────────────────────────────────────
const SUPABASE_URL              = process.env.SUPABASE_URL!
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!
const CRON_SECRET               = process.env.CRON_SECRET

const getSupabase = () => createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

// ─── AUTH ──────────────────────────────────────────────────────────────────────
function verifyCronAuth(req: VercelRequest): boolean {
  if (req.headers['x-vercel-signature']) return true
  if (!CRON_SECRET) return true
  const auth = req.headers['authorization']
  return !!(auth && auth === `Bearer ${CRON_SECRET}`)
}

// ─── DEFAULTS ─────────────────────────────────────────────────────────────────
type ScoringProfile = 'balanced' | 'emerging_topics' | 'deep_concepts' | 'active_focus' | 'well_evidenced'

const AUTO_CONFIRM_THRESHOLD = 0.45

const DEFAULT_CONFIG = {
  suggestionThreshold:         0.25,
  dormantAfterDays:            60,
  resurfaceCooldownDays:       30,
  autoDismissAfterDays:        14,
  scoringProfile:              'balanced' as ScoringProfile,
  autoArchiveDormantAfterDays: null as number | null,
}

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
  return { ...DEFAULT_CONFIG, ...stored }
}

// ─── MOMENTUM CONSTANTS ───────────────────────────────────────────────────────
// Exponential decay weights for the 7-day window.
// Day 0 (last 24h) = 1.0, each prior day decays by ~0.6×.
const MOMENTUM_WINDOW_DAYS = 7
const MOMENTUM_DECAY = 0.6
const DAY_WEIGHTS = Array.from({ length: MOMENTUM_WINDOW_DAYS }, (_, i) =>
  Math.pow(MOMENTUM_DECAY, i)
)
// DAY_WEIGHTS = [1.0, 0.6, 0.36, 0.216, 0.1296, 0.0778, 0.0467]

// Maximum possible momentum if a node had edges on every day (for normalisation)
const MAX_MOMENTUM = DAY_WEIGHTS.reduce((s, w) => s + w, 0) // ≈ 2.44

// Minimum distinct active days to even be considered a pattern
const MIN_ACTIVE_DAYS = 1

// Minimum momentum score (normalised 0–1) to proceed to Phase 2
const MOMENTUM_THRESHOLD = 0.06

// Streak bonus: consecutive recent days multiply momentum
// 2 consecutive = 1.1×, 3 = 1.2×, 4 = 1.3×, etc.
const STREAK_BONUS_PER_DAY = 0.1
const MAX_STREAK_BONUS = 1.5

// ─── PHASE 1: MOMENTUM COMPUTATION ───────────────────────────────────────────
// Given all edges from the last 7 days, compute a momentum score per node.
// Returns only nodes that pass the momentum gate.

interface MomentumResult {
  nodeId: string
  momentumScore: number     // 0–1, normalised
  activeDays: number        // How many of the 7 days had activity
  consecutiveStreak: number // Longest recent streak ending at day 0 or 1
  edgeCount7d: number       // Total edges in the 7-day window
  dayDistribution: number[] // Edge count per day bucket (index 0 = today)
}

function computeMomentum(
  nodeEdgeMap: Map<string, Array<{ created_at: string }>>,
  now: number
): MomentumResult[] {
  const oneDayMs = 86400000
  const results: MomentumResult[] = []

  for (const [nodeId, edges] of nodeEdgeMap) {
    // Bucket edges into 7 day slots
    const dayBuckets = new Array(MOMENTUM_WINDOW_DAYS).fill(0)
    for (const edge of edges) {
      const ageMs = now - new Date(edge.created_at).getTime()
      const dayIndex = Math.floor(ageMs / oneDayMs)
      if (dayIndex >= 0 && dayIndex < MOMENTUM_WINDOW_DAYS) {
        dayBuckets[dayIndex]++
      }
    }

    // Count active days
    const activeDays = dayBuckets.filter(c => c > 0).length
    if (activeDays < MIN_ACTIVE_DAYS) continue

    // Weighted momentum: sum of (has_activity_on_day × day_weight)
    // We use presence (0 or 1) not count, so a day with 10 edges
    // doesn't dominate — the pattern is about recurring, not volume.
    let rawMomentum = 0
    for (let i = 0; i < MOMENTUM_WINDOW_DAYS; i++) {
      if (dayBuckets[i] > 0) rawMomentum += DAY_WEIGHTS[i]
    }

    // Consecutive streak starting from today (day 0) or yesterday (day 1)
    let streak = 0
    const startDay = dayBuckets[0] > 0 ? 0 : (dayBuckets[1] > 0 ? 1 : -1)
    if (startDay >= 0) {
      for (let i = startDay; i < MOMENTUM_WINDOW_DAYS; i++) {
        if (dayBuckets[i] > 0) streak++
        else break
      }
    }

    // Apply streak bonus
    const streakMultiplier = Math.min(
      1 + Math.max(streak - 1, 0) * STREAK_BONUS_PER_DAY,
      MAX_STREAK_BONUS
    )
    const boostedMomentum = rawMomentum * streakMultiplier

    // Normalise to 0–1
    const momentumScore = Math.min(boostedMomentum / (MAX_MOMENTUM * MAX_STREAK_BONUS), 1.0)

    if (momentumScore >= MOMENTUM_THRESHOLD) {
      results.push({
        nodeId,
        momentumScore,
        activeDays,
        consecutiveStreak: streak,
        edgeCount7d: edges.length,
        dayDistribution: dayBuckets,
      })
    }
  }

  // Sort by momentum descending
  results.sort((a, b) => b.momentumScore - a.momentumScore)
  return results
}

// ─── PHASE 2: FULL SIGNAL SCORING (centrality, diversity, richness) ──────────
// Only runs for momentum-qualified nodes. Computed from data already fetched.

interface QualifiedNodeSignals {
  nodeId: string
  momentum: MomentumResult
  totalEdges: number
  uniqueNeighbourTypes: number
  uniqueSources: number
  uniqueSourceTypes: number
  uniqueRelationTypes: number
  anchorNeighbourCount: number
  totalNeighbourCount: number
  daysActive: number
}

interface ScoredCandidate {
  signals: QualifiedNodeSignals
  centralityScore: number
  diversityScore: number
  richnessScore: number
  compositeScore: number
  reasoningText: string
}

function scoreQualifiedNodes(
  qualifiedSignals: QualifiedNodeSignals[],
  profile: ScoringProfile
): ScoredCandidate[] {
  const w = SIGNAL_WEIGHTS[profile]

  return qualifiedSignals.map(signals => {
    // Centrality: structural importance
    const degreeScore     = Math.min(signals.totalEdges / 20, 1.0)
    const diversityFactor = Math.min(signals.uniqueNeighbourTypes / 5, 1.0)
    const centralityScore = (degreeScore * 0.6) + (diversityFactor * 0.4)

    // Diversity: cross-source coverage
    const sourceCountScore = Math.min(signals.uniqueSources / 4, 1.0)
    const typeCountScore   = Math.min(signals.uniqueSourceTypes / 3, 1.0)
    const diversityScore   = (sourceCountScore * 0.65) + (typeCountScore * 0.35)

    // Richness: relationship type variety
    const richnessScore = Math.min(signals.uniqueRelationTypes / 6, 1.0)

    // Composite: momentum is the gatekeeper, these three determine ranking
    let composite = (centralityScore * w.centrality) +
      (diversityScore * w.diversity) +
      (richnessScore * w.richness)

    // Overlap penalty: avoid clustering anchors together
    const overlapRatio = signals.anchorNeighbourCount / Math.max(signals.totalNeighbourCount, 1)
    if (overlapRatio > 0.70) composite *= 0.75

    // Momentum amplifier: scale composite by momentum (0.70–1.0 range)
    // so momentum still influences ranking among qualified nodes
    const momentumBoost = 0.70 + (signals.momentum.momentumScore * 0.30)
    composite *= momentumBoost

    composite = Math.min(Math.max(composite, 0), 1.0)

    // Reasoning text
    const parts: string[] = []
    const m = signals.momentum
    if (m.consecutiveStreak >= 3)
      parts.push(`Active ${m.consecutiveStreak} days in a row`)
    else if (m.activeDays >= 3)
      parts.push(`Appeared on ${m.activeDays} of the last 7 days`)
    else
      parts.push(`Appeared on ${m.activeDays} of the last 7 days`)

    if (signals.uniqueSources >= 5)
      parts.push(`across ${signals.uniqueSources} sources`)
    else if (signals.uniqueSources >= 2)
      parts.push(`in ${signals.uniqueSources} different sources`)

    if (signals.uniqueSourceTypes >= 2)
      parts.push(`spanning ${signals.uniqueSourceTypes} content types`)
    if (signals.uniqueRelationTypes >= 4)
      parts.push(`with ${signals.uniqueRelationTypes} relationship types`)
    if (signals.anchorNeighbourCount >= 2)
      parts.push(`connects to ${signals.anchorNeighbourCount} existing anchors`)
    if (m.consecutiveStreak >= 2 && m.dayDistribution[0] > 0)
      parts.push('and still active today')

    return {
      signals,
      centralityScore,
      diversityScore,
      richnessScore,
      compositeScore: composite,
      reasoningText: parts.join(', ') + '.',
    }
  })
}

// ─── LIFECYCLE TRANSITIONS ─────────────────────────────────────────────────────

async function runLifecycleTransitions(
  supabase: ReturnType<typeof getSupabase>,
  userId: string,
  config: ReturnType<typeof resolveUserConfig>
): Promise<{ autoDismissed: number; markedDormant: number; resurfaced: number; healed: number }> {
  const now = new Date()
  let autoDismissed = 0, markedDormant = 0, resurfaced = 0, healed = 0

  // 1. Auto-dismiss: 'suggested' candidates past autoDismissAfterDays with no user action
  const autoDismissCutoff = new Date(now.getTime() - (config.autoDismissAfterDays as number) * 86400000).toISOString()
  const { data: stale } = await supabase
    .from('anchor_candidates')
    .select('id, dismiss_count')
    .eq('user_id', userId)
    .eq('status', 'suggested')
    .lt('suggested_at', autoDismissCutoff)

  if (stale && stale.length > 0) {
    for (const row of stale) {
      const resurface = new Date(now.getTime() + (config.resurfaceCooldownDays as number) * 86400000).toISOString()
      await supabase.from('anchor_candidates').update({
        status:          'dismissed',
        reviewed_at:     now.toISOString(),
        resurface_after: resurface,
        dismiss_count:   (row.dismiss_count as number ?? 0) + 1,
      }).eq('id', row.id as string)
      autoDismissed++
    }
  }

  // 2. Mark dormant: 'confirmed' anchors with no new edges in dormantAfterDays
  const dormantCutoff = new Date(now.getTime() - (config.dormantAfterDays as number) * 86400000).toISOString()
  const { data: confirmedCandidates } = await supabase
    .from('anchor_candidates')
    .select('id, node_id')
    .eq('user_id', userId)
    .eq('status', 'confirmed')

  for (const row of confirmedCandidates ?? []) {
    if (!row.node_id) continue
    const { data: recentEdge } = await supabase
      .from('knowledge_edges')
      .select('created_at')
      .or(`source_node_id.eq.${row.node_id},target_node_id.eq.${row.node_id}`)
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    const lastActivity = recentEdge?.created_at as string | undefined
    if (!lastActivity || lastActivity < dormantCutoff) {
      await supabase.from('anchor_candidates').update({
        status:        'dormant',
        dormant_since: now.toISOString(),
      }).eq('id', row.id as string)
      markedDormant++
    }
  }

  // 3. Re-activate dormant anchors that have received new content
  const { data: dormantCandidates } = await supabase
    .from('anchor_candidates')
    .select('id, node_id, dormant_since')
    .eq('user_id', userId)
    .eq('status', 'dormant')

  for (const row of dormantCandidates ?? []) {
    if (!row.node_id || !row.dormant_since) continue
    const { data: recentEdge } = await supabase
      .from('knowledge_edges')
      .select('created_at')
      .or(`source_node_id.eq.${row.node_id},target_node_id.eq.${row.node_id}`)
      .eq('user_id', userId)
      .gt('created_at', row.dormant_since as string)
      .limit(1)
      .maybeSingle()

    if (recentEdge) {
      await supabase.from('anchor_candidates').update({
        status:        'confirmed',
        dormant_since: null,
      }).eq('id', row.id as string)
    }
  }

  // 4. Re-surface dismissed candidates past resurface_after
  const { data: readyToResurface } = await supabase
    .from('anchor_candidates')
    .select('id, composite_score')
    .eq('user_id', userId)
    .eq('status', 'dismissed')
    .lt('resurface_after', now.toISOString())

  for (const row of readyToResurface ?? []) {
    if ((row.composite_score as number) >= (config.suggestionThreshold as number)) {
      await supabase.from('anchor_candidates').update({
        status:          'suggested',
        suggested_at:    now.toISOString(),
        resurface_after: null,
      }).eq('id', row.id as string)
      resurfaced++
    } else {
      await supabase.from('anchor_candidates').update({
        status: 'pending',
      }).eq('id', row.id as string)
    }
  }

  // 5. Heal: any is_anchor=true node with no corresponding confirmed candidate row
  const { data: anchorNodes } = await supabase
    .from('knowledge_nodes')
    .select('id, label')
    .eq('user_id', userId)
    .eq('is_anchor', true)

  for (const node of anchorNodes ?? []) {
    const { data: existingCandidate } = await supabase
      .from('anchor_candidates')
      .select('id, status')
      .eq('user_id', userId)
      .eq('node_id', node.id as string)
      .in('status', ['confirmed', 'dormant'])
      .maybeSingle()

    if (!existingCandidate) {
      const nowStr = now.toISOString()
      await supabase.from('anchor_candidates').insert({
        user_id: userId, node_id: node.id as string,
        composite_score: 1.0, centrality_score: 0, diversity_score: 0,
        velocity_score: 0, richness_score: 0, behavioural_score: 0,
        mention_count: 0, source_count: 0, unique_source_types: 0,
        days_active: 0, recent_velocity: 0, velocity_direction: 'stable',
        status: 'confirmed', scoring_profile: 'balanced',
        reasoning_text: 'Existing anchor — automatically registered by healing pass.',
        suggested_at: nowStr, reviewed_at: nowStr,
        first_scored_at: nowStr, last_scored_at: nowStr,
      })
      healed++
    }
  }

  // 6. Auto-archive dormant anchors (opt-in)
  if (config.autoArchiveDormantAfterDays !== null) {
    const archiveCutoff = new Date(
      now.getTime() - (config.autoArchiveDormantAfterDays as number) * 86400000
    ).toISOString()

    const { data: archiveCandidates } = await supabase
      .from('anchor_candidates')
      .select('id, node_id')
      .eq('user_id', userId)
      .eq('status', 'dormant')
      .lt('dormant_since', archiveCutoff)

    for (const row of archiveCandidates ?? []) {
      await supabase.from('anchor_candidates').update({ status: 'archived' }).eq('id', row.id as string)
      if (row.node_id) {
        await supabase.from('knowledge_nodes').update({ is_anchor: false }).eq('id', row.node_id as string)
      }
    }
  }

  return { autoDismissed, markedDormant, resurfaced, healed }
}

// ─── HANDLER ───────────────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')

  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  if (!verifyCronAuth(req)) return res.status(401).json({ error: 'Unauthorized' })

  const startTime = Date.now()
  const sb = getSupabase()
  const now = Date.now()
  const sevenDaysAgo = new Date(now - MOMENTUM_WINDOW_DAYS * 86400000).toISOString()

  const results: Record<string, {
    momentumCandidates: number; qualifiedForPhase2: number; scored: number; surfaced: number
    lifecycle: { autoDismissed: number; markedDormant: number; resurfaced: number; healed: number }
  }> = {}

  try {
    // ── Query 1: All edges created in the last 7 days ────────────────────────
    // This is the ONLY large query. Everything else is derived from this.
    const { data: recentEdges, error: edgesError } = await sb
      .from('knowledge_edges')
      .select('source_node_id, target_node_id, relation_type, created_at, user_id')
      .gte('created_at', sevenDaysAgo)

    if (edgesError) throw new Error(`Failed to fetch recent edges: ${edgesError.message}`)
    if (!recentEdges || recentEdges.length === 0) {
      return res.status(200).json({
        success: true, users: 0, message: 'No edge activity in last 7 days',
        duration_ms: Date.now() - startTime,
      })
    }

    // Group edges by user_id
    const edgesByUser = new Map<string, typeof recentEdges>()
    for (const edge of recentEdges) {
      const uid = edge.user_id as string
      if (!edgesByUser.has(uid)) edgesByUser.set(uid, [])
      edgesByUser.get(uid)!.push(edge)
    }

    for (const [userId, userEdges] of edgesByUser) {
      // ── Phase 1: Compute momentum per node from edge timestamps ──────────
      // Build map: nodeId → edges touching that node
      const nodeEdgeMap = new Map<string, Array<{ created_at: string }>>()
      for (const edge of userEdges) {
        const src = edge.source_node_id as string
        const tgt = edge.target_node_id as string
        if (!nodeEdgeMap.has(src)) nodeEdgeMap.set(src, [])
        if (!nodeEdgeMap.has(tgt)) nodeEdgeMap.set(tgt, [])
        nodeEdgeMap.get(src)!.push({ created_at: edge.created_at as string })
        nodeEdgeMap.get(tgt)!.push({ created_at: edge.created_at as string })
      }

      const momentumResults = computeMomentum(nodeEdgeMap, now)

      if (momentumResults.length === 0) {
        results[userId] = {
          momentumCandidates: nodeEdgeMap.size, qualifiedForPhase2: 0,
          scored: 0, surfaced: 0,
          lifecycle: { autoDismissed: 0, markedDormant: 0, resurfaced: 0, healed: 0 },
        }
        continue
      }

      // Load user config
      const { data: profileRow } = await sb
        .from('user_profiles')
        .select('processing_preferences')
        .eq('user_id', userId)
        .maybeSingle()

      const config = resolveUserConfig(
        (profileRow?.processing_preferences ?? null) as Record<string, unknown> | null
      )

      // Run lifecycle transitions
      const lifecycle = await runLifecycleTransitions(sb, userId, config)

      // ── Phase 2: Full signal scoring for momentum-qualified nodes ────────
      const qualifiedIds = momentumResults.map(m => m.nodeId)

      // Query 2: Node metadata for qualified nodes only
      const [nodesRes, outEdgesRes, inEdgesRes] = await Promise.all([
        sb.from('knowledge_nodes')
          .select('id, source_id, source_type, entity_type, is_anchor, created_at')
          .in('id', qualifiedIds)
          .eq('user_id', userId),
        sb.from('knowledge_edges')
          .select('source_node_id, target_node_id, relation_type')
          .in('source_node_id', qualifiedIds)
          .eq('user_id', userId),
        sb.from('knowledge_edges')
          .select('source_node_id, target_node_id, relation_type')
          .in('target_node_id', qualifiedIds)
          .eq('user_id', userId),
      ])

      const nodes = nodesRes.data ?? []
      const outEdges = outEdgesRes.data ?? []
      const inEdges = inEdgesRes.data ?? []
      const nodeMap = new Map(nodes.map(n => [n.id as string, n]))

      // Filter out nodes that are already anchors
      const nonAnchorMomentum = momentumResults.filter(m => {
        const node = nodeMap.get(m.nodeId)
        return node && !node.is_anchor
      })

      if (nonAnchorMomentum.length === 0) {
        results[userId] = {
          momentumCandidates: nodeEdgeMap.size, qualifiedForPhase2: 0,
          scored: 0, surfaced: 0, lifecycle,
        }
        continue
      }

      // Collect all neighbour IDs
      const allEdges = [...outEdges, ...inEdges]
      const neighbourIds = new Set<string>()
      const qualifiedIdSet = new Set(qualifiedIds)
      for (const e of allEdges) {
        if (qualifiedIdSet.has(e.source_node_id as string)) neighbourIds.add(e.target_node_id as string)
        if (qualifiedIdSet.has(e.target_node_id as string)) neighbourIds.add(e.source_node_id as string)
      }
      // Remove qualified nodes themselves from neighbour set
      for (const id of qualifiedIds) neighbourIds.delete(id)

      // Query 3: Neighbour metadata
      const nbList = Array.from(neighbourIds)
      const { data: nbNodes } = nbList.length > 0
        ? await sb.from('knowledge_nodes')
            .select('id, entity_type, is_anchor, source_id, source_type')
            .in('id', nbList)
            .eq('user_id', userId)
        : { data: [] }

      const neighbourMap = new Map((nbNodes ?? []).map(n => [n.id as string, n]))

      // Build full signals per qualified node
      const qualifiedSignals: QualifiedNodeSignals[] = []
      for (const m of nonAnchorMomentum) {
        const nodeRow = nodeMap.get(m.nodeId)
        const myOut = outEdges.filter(e => e.source_node_id === m.nodeId)
        const myIn  = inEdges.filter(e => e.target_node_id === m.nodeId)
        const myAll = [...myOut, ...myIn]

        const relTypes = new Set(myAll.map(e => e.relation_type).filter(Boolean))

        const nbTypeSet = new Set<string>()
        let anchorNb = 0, totalNb = 0
        for (const e of myOut) {
          const nb = neighbourMap.get(e.target_node_id as string)
          if (nb) { nbTypeSet.add(nb.entity_type as string); totalNb++; if (nb.is_anchor) anchorNb++ }
        }
        for (const e of myIn) {
          const nb = neighbourMap.get(e.source_node_id as string)
          if (nb) { nbTypeSet.add(nb.entity_type as string); totalNb++; if (nb.is_anchor) anchorNb++ }
        }

        const srcIdSet = new Set<string>()
        const srcTypeSet = new Set<string>()
        if (nodeRow?.source_id) srcIdSet.add(nodeRow.source_id as string)
        if (nodeRow?.source_type) srcTypeSet.add(nodeRow.source_type as string)
        for (const e of myAll) {
          const nbId = qualifiedIdSet.has(e.source_node_id as string) ? e.target_node_id : e.source_node_id
          const nb = neighbourMap.get(nbId as string)
          if (nb?.source_id) srcIdSet.add(nb.source_id as string)
          if (nb?.source_type) srcTypeSet.add(nb.source_type as string)
        }

        let daysActive = 0
        if (nodeRow?.created_at) {
          daysActive = Math.floor((now - new Date(nodeRow.created_at as string).getTime()) / 86400000)
        }

        qualifiedSignals.push({
          nodeId: m.nodeId,
          momentum: m,
          totalEdges: myAll.length,
          uniqueNeighbourTypes: nbTypeSet.size,
          uniqueSources: srcIdSet.size,
          uniqueSourceTypes: srcTypeSet.size,
          uniqueRelationTypes: relTypes.size,
          anchorNeighbourCount: anchorNb,
          totalNeighbourCount: totalNb,
          daysActive,
        })
      }

      // Score all qualified nodes
      const scored = scoreQualifiedNodes(qualifiedSignals, config.scoringProfile as ScoringProfile)

      // ── Query 4: Batch-fetch existing candidates for all qualified nodes ──
      const scoredNodeIds = scored.map(s => s.signals.nodeId)
      const { data: existingCandidates } = await sb
        .from('anchor_candidates')
        .select('id, node_id, status, dismiss_count')
        .eq('user_id', userId)
        .in('node_id', scoredNodeIds)

      const existingMap = new Map(
        (existingCandidates ?? []).map(c => [c.node_id as string, c])
      )

      // ── Query 5: Bulk upsert all results ──────────────────────────────────
      const nowStr = new Date().toISOString()
      let surfaced = 0
      let autoConfirmed = 0
      const protectedStatuses = ['confirmed', 'dismissed', 'archived', 'dormant']

      for (const candidate of scored) {
        const nodeId = candidate.signals.nodeId
        const existing = existingMap.get(nodeId)
        const shouldAutoConfirm = candidate.compositeScore >= AUTO_CONFIRM_THRESHOLD
        const shouldSurface = candidate.compositeScore >= (config.suggestionThreshold as number)

        // Determine target status
        let targetStatus: string
        if (shouldAutoConfirm) targetStatus = 'confirmed'
        else if (shouldSurface) targetStatus = 'suggested'
        else targetStatus = 'pending'

        if (existing) {
          const updatePayload: Record<string, unknown> = {
            composite_score:     candidate.compositeScore,
            centrality_score:    candidate.centralityScore,
            diversity_score:     candidate.diversityScore,
            velocity_score:      candidate.signals.momentum.momentumScore,
            richness_score:      candidate.richnessScore,
            mention_count:       candidate.signals.momentum.edgeCount7d,
            source_count:        candidate.signals.uniqueSources,
            unique_source_types: candidate.signals.uniqueSourceTypes,
            days_active:         candidate.signals.daysActive,
            recent_velocity:     candidate.signals.momentum.momentumScore,
            velocity_direction:  candidate.signals.momentum.consecutiveStreak >= 2 ? 'rising'
              : candidate.signals.momentum.activeDays <= 2 ? 'stable' : 'rising',
            scoring_profile:     config.scoringProfile,
            reasoning_text:      candidate.reasoningText,
            last_scored_at:      nowStr,
            threshold_at_scoring: config.suggestionThreshold,
          }

          // Auto-confirm: upgrade pending/suggested → confirmed
          if (shouldAutoConfirm && !['confirmed', 'archived', 'dormant'].includes(existing.status as string)) {
            updatePayload.status = 'confirmed'
            updatePayload.reviewed_at = nowStr
            updatePayload.suggested_at = updatePayload.suggested_at ?? nowStr
            autoConfirmed++
            // Set is_anchor on the node
            await sb.from('knowledge_nodes').update({ is_anchor: true }).eq('id', nodeId)
          } else if (!protectedStatuses.includes(existing.status as string) && shouldSurface && existing.status === 'pending') {
            updatePayload.status = 'suggested'
            updatePayload.suggested_at = nowStr
            surfaced++
          }

          await sb.from('anchor_candidates').update(updatePayload).eq('id', existing.id as string)
        } else {
          const insertStatus = shouldAutoConfirm ? 'confirmed' : (shouldSurface ? 'suggested' : 'pending')
          await sb.from('anchor_candidates').insert({
            user_id: userId, node_id: nodeId,
            composite_score:     candidate.compositeScore,
            centrality_score:    candidate.centralityScore,
            diversity_score:     candidate.diversityScore,
            velocity_score:      candidate.signals.momentum.momentumScore,
            richness_score:      candidate.richnessScore,
            behavioural_score:   0,
            mention_count:       candidate.signals.momentum.edgeCount7d,
            source_count:        candidate.signals.uniqueSources,
            unique_source_types: candidate.signals.uniqueSourceTypes,
            days_active:         candidate.signals.daysActive,
            recent_velocity:     candidate.signals.momentum.momentumScore,
            velocity_direction:  candidate.signals.momentum.consecutiveStreak >= 2 ? 'rising' : 'stable',
            status:              insertStatus,
            scoring_profile:     config.scoringProfile,
            reasoning_text:      candidate.reasoningText,
            threshold_at_scoring: config.suggestionThreshold,
            suggested_at:        insertStatus !== 'pending' ? nowStr : null,
            reviewed_at:         insertStatus === 'confirmed' ? nowStr : null,
            first_scored_at:     nowStr,
            last_scored_at:      nowStr,
          })
          if (insertStatus === 'confirmed') {
            autoConfirmed++
            await sb.from('knowledge_nodes').update({ is_anchor: true }).eq('id', nodeId)
          } else if (insertStatus === 'suggested') {
            surfaced++
          }
        }
      }

      results[userId] = {
        momentumCandidates: nodeEdgeMap.size,
        qualifiedForPhase2: nonAnchorMomentum.length,
        scored: scored.length,
        surfaced,
        autoConfirmed,
        lifecycle,
      }
      console.log(
        `[score-daily] userId=${userId} momentum_candidates=${nodeEdgeMap.size} ` +
        `qualified=${nonAnchorMomentum.length} scored=${scored.length} surfaced=${surfaced} auto_confirmed=${autoConfirmed}`
      )
    }

    const totalScored   = Object.values(results).reduce((s, r) => s + r.scored, 0)
    const totalSurfaced = Object.values(results).reduce((s, r) => s + r.surfaced, 0)

    return res.status(200).json({
      success: true,
      users: edgesByUser.size,
      totalScored,
      totalSurfaced,
      duration_ms: Date.now() - startTime,
      results,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[score-daily] Fatal error:', msg)
    return res.status(500).json({ success: false, error: msg, duration_ms: Date.now() - startTime })
  }
}
