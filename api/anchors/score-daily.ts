import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createClient } from '@supabase/supabase-js'

export const maxDuration = 300

// ─── ENVIRONMENT ──────────────────────────────────────────────────────────────
const SUPABASE_URL              = process.env.SUPABASE_URL!
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!
const CRON_SECRET               = process.env.CRON_SECRET

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('[supabase] Missing env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY')
}

const getSupabase = () => createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

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

// ─── DEFAULTS ─────────────────────────────────────────────────────────────────
type ScoringProfile = 'balanced' | 'emerging_topics' | 'deep_concepts' | 'active_focus' | 'well_evidenced'

const AUTO_CONFIRM_THRESHOLD       = 0.50
const QUIET_AUTO_CONFIRM_THRESHOLD = 0.38

const DEFAULT_CONFIG = {
  suggestionThreshold:         0.38,
  dormantAfterDays:            60,
  resurfaceCooldownDays:       30,
  autoDismissAfterDays:        14,
  scoringProfile:              'balanced' as ScoringProfile,
  autoArchiveDormantAfterDays: null as number | null,
}

// ─── Five scoring signals (documented here, mirrored in PIPELINE-IMPLEMENTATION-LOG.md)
// Signal 1 — Momentum (velocity gate): 7-day exponential-decay edge-presence score.
//            DAY_WEIGHTS[i] = MOMENTUM_DECAY^i (day 0 = most recent = weight 1.0).
//            Streak bonus multiplier (consecutive recent days × STREAK_BONUS_PER_DAY).
//            Stored as velocity_score. Acts as a gate: nodes below MOMENTUM_THRESHOLD
//            are excluded from Phase 2 entirely.
//            Formula: momentumScore = min(rawMomentum * streakMult / (MAX_MOMENTUM * MAX_STREAK_BONUS), 1.0)
//
// Signal 2 — Centrality: structural importance in the graph.
//            Formula: (min(totalEdges / 20, 1.0) * 0.6) + (min(uniqueNeighbourTypes / 5, 1.0) * 0.4)
//            Stored as centrality_score.
//
// Signal 3 — Diversity: cross-source coverage.
//            Formula: (min(uniqueSources / 4, 1.0) * 0.65) + (min(uniqueSourceTypes / 3, 1.0) * 0.35)
//            Stored as diversity_score.
//
// Signal 4 — Richness: relationship-type variety.
//            Formula: min(uniqueRelationTypes / 6, 1.0)
//            Stored as richness_score.
//
// Signal 5 — Behavioural: reserved for future click/open/query signals.
//            Currently always 0.  Stored as behavioural_score.
//
// Composite: (centrality * w.centrality) + (diversity * w.diversity) + (richness * w.richness)
//            with an overlap penalty (-25% when >70% neighbours are anchors)
//            and a momentum amplifier (0.70 + momentumScore * 0.30, applied last).

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
const MOMENTUM_WINDOW_DAYS  = 7
const MOMENTUM_DECAY        = 0.6
const DAY_WEIGHTS           = Array.from({ length: MOMENTUM_WINDOW_DAYS }, (_, i) =>
  Math.pow(MOMENTUM_DECAY, i)
)
const MAX_MOMENTUM          = DAY_WEIGHTS.reduce((s, w) => s + w, 0) // ≈ 2.44
const MIN_ACTIVE_DAYS       = 1
const MOMENTUM_THRESHOLD    = 0.06
const STREAK_BONUS_PER_DAY  = 0.1
const MAX_STREAK_BONUS      = 1.5

// ─── PHASE 1: MOMENTUM COMPUTATION ───────────────────────────────────────────

interface MomentumResult {
  nodeId: string
  momentumScore: number
  activeDays: number
  consecutiveStreak: number
  edgeCount7d: number
  dayDistribution: number[]
}

function computeMomentum(
  nodeEdgeMap: Map<string, Array<{ created_at: string }>>,
  now: number
): MomentumResult[] {
  const oneDayMs = 86400000
  const results: MomentumResult[] = []

  for (const [nodeId, edges] of nodeEdgeMap) {
    const dayBuckets = new Array(MOMENTUM_WINDOW_DAYS).fill(0)
    for (const edge of edges) {
      const ageMs   = now - new Date(edge.created_at).getTime()
      const dayIndex = Math.floor(ageMs / oneDayMs)
      if (dayIndex >= 0 && dayIndex < MOMENTUM_WINDOW_DAYS) dayBuckets[dayIndex]++
    }

    const activeDays = dayBuckets.filter(c => c > 0).length
    if (activeDays < MIN_ACTIVE_DAYS) continue

    let rawMomentum = 0
    for (let i = 0; i < MOMENTUM_WINDOW_DAYS; i++) {
      if (dayBuckets[i] > 0) rawMomentum += DAY_WEIGHTS[i]
    }

    let streak = 0
    const startDay = dayBuckets[0] > 0 ? 0 : (dayBuckets[1] > 0 ? 1 : -1)
    if (startDay >= 0) {
      for (let i = startDay; i < MOMENTUM_WINDOW_DAYS; i++) {
        if (dayBuckets[i] > 0) streak++
        else break
      }
    }

    const streakMultiplier = Math.min(
      1 + Math.max(streak - 1, 0) * STREAK_BONUS_PER_DAY,
      MAX_STREAK_BONUS
    )
    const momentumScore = Math.min(
      rawMomentum * streakMultiplier / (MAX_MOMENTUM * MAX_STREAK_BONUS),
      1.0
    )

    if (momentumScore >= MOMENTUM_THRESHOLD) {
      results.push({
        nodeId, momentumScore, activeDays, consecutiveStreak: streak,
        edgeCount7d: edges.length, dayDistribution: dayBuckets,
      })
    }
  }

  results.sort((a, b) => b.momentumScore - a.momentumScore)
  return results
}

// ─── PHASE 2: FULL SIGNAL SCORING ────────────────────────────────────────────

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
    const degreeScore      = Math.min(signals.totalEdges / 20, 1.0)
    const diversityFactor  = Math.min(signals.uniqueNeighbourTypes / 5, 1.0)
    const centralityScore  = (degreeScore * 0.6) + (diversityFactor * 0.4)

    const sourceCountScore = Math.min(signals.uniqueSources / 4, 1.0)
    const typeCountScore   = Math.min(signals.uniqueSourceTypes / 3, 1.0)
    const diversityScore   = (sourceCountScore * 0.65) + (typeCountScore * 0.35)

    const richnessScore = Math.min(signals.uniqueRelationTypes / 6, 1.0)

    let composite = (centralityScore * w.centrality) +
      (diversityScore * w.diversity) + (richnessScore * w.richness)

    const overlapRatio = signals.anchorNeighbourCount / Math.max(signals.totalNeighbourCount, 1)
    if (overlapRatio > 0.70) composite *= 0.75

    const momentumBoost = 0.70 + (signals.momentum.momentumScore * 0.30)
    composite = Math.min(Math.max(composite * momentumBoost, 0), 1.0)

    const parts: string[] = []
    const m = signals.momentum
    if (m.consecutiveStreak >= 3)  parts.push(`Active ${m.consecutiveStreak} days in a row`)
    else                            parts.push(`Appeared on ${m.activeDays} of the last 7 days`)
    if (signals.uniqueSources >= 5) parts.push(`across ${signals.uniqueSources} sources`)
    else if (signals.uniqueSources >= 2) parts.push(`in ${signals.uniqueSources} different sources`)
    if (signals.uniqueSourceTypes >= 2)  parts.push(`spanning ${signals.uniqueSourceTypes} content types`)
    if (signals.uniqueRelationTypes >= 4) parts.push(`with ${signals.uniqueRelationTypes} relationship types`)
    if (signals.anchorNeighbourCount >= 2) parts.push(`connects to ${signals.anchorNeighbourCount} existing anchors`)
    if (m.consecutiveStreak >= 2 && m.dayDistribution[0] > 0) parts.push('and still active today')

    return { signals, centralityScore, diversityScore, richnessScore, compositeScore: composite, reasoningText: parts.join(', ') + '.' }
  })
}

// ─── LIFECYCLE TRANSITIONS ─────────────────────────────────────────────────────
// Lifecycle rules (documented here, mirrored in PIPELINE-IMPLEMENTATION-LOG.md):
//   - Scope: runs once per day for ALL anchors of the user. Not per-source.
//   - Steps:
//     1. Legacy 'suggested' cleanup (pre-two-zone system): auto-confirm if score>=0.38, else demote to 'pending'.
//     2. Confirmed→dormant: any confirmed anchor with no edges newer than dormantAfterDays → 'dormant'.
//        Handled server-side via bulk_anchor_dormancy_transitions RPC (single SQL, no per-row reads).
//     3. Dormant→confirmed: any dormant anchor that received new edges since going dormant → re-confirmed.
//        Also handled in the same RPC call.
//     4. Dismissed→resurfaced: dismissed candidates whose resurface_after has passed, auto-confirm if score>=0.38.
//     5. Heal: is_anchor=true nodes without a corresponding confirmed candidate row get one inserted.
//     6. Auto-archive (opt-in): dormant anchors past autoArchiveDormantAfterDays → 'archived'.

async function runLifecycleTransitions(
  supabase: ReturnType<typeof getSupabase>,
  userId: string,
  config: ReturnType<typeof resolveUserConfig>
): Promise<{ autoDismissed: number; markedDormant: number; resurfaced: number; healed: number; reactivated: number }> {
  const now = new Date()
  let autoDismissed = 0, resurfaced = 0, healed = 0

  // Step 1: Legacy 'suggested' cleanup (small set — legacy status no longer written)
  const { data: legacySuggested } = await supabase
    .from('anchor_candidates')
    .select('id, composite_score, node_id')
    .eq('user_id', userId)
    .eq('status', 'suggested')

  if (legacySuggested && legacySuggested.length > 0) {
    for (const row of legacySuggested) {
      const score = row.composite_score as number
      if (score >= QUIET_AUTO_CONFIRM_THRESHOLD) {
        await supabase.from('anchor_candidates').update({
          status: 'confirmed', reviewed_at: now.toISOString(),
        }).eq('id', row.id as string)
        if (row.node_id) {
          await supabase.from('knowledge_nodes').update({ is_anchor: true }).eq('id', row.node_id as string)
        }
      } else {
        await supabase.from('anchor_candidates').update({
          status: 'pending', suggested_at: null,
        }).eq('id', row.id as string)
        autoDismissed++
      }
    }
  }

  // Steps 2+3: Dormancy and re-activation via single RPC (replaces per-row edge-recency loops)
  const dormantCutoff = new Date(now.getTime() - (config.dormantAfterDays as number) * 86400000).toISOString()
  const { data: dormancyResult, error: dormancyErr } = await supabase.rpc(
    'bulk_anchor_dormancy_transitions',
    { p_user_id: userId, p_dormant_cutoff: dormantCutoff }
  )
  if (dormancyErr) {
    logError({ stage: 'anchor:lifecycle:dormancy', user_id: userId, error: dormancyErr.message })
  }
  const markedDormant  = (dormancyResult as { marked_dormant?: number } | null)?.marked_dormant ?? 0
  const reactivated    = (dormancyResult as { reactivated?: number } | null)?.reactivated ?? 0

  // Step 4: Re-surface dismissed candidates past resurface_after (typically small)
  const { data: readyToResurface } = await supabase
    .from('anchor_candidates')
    .select('id, composite_score, node_id')
    .eq('user_id', userId)
    .eq('status', 'dismissed')
    .lt('resurface_after', now.toISOString())

  for (const row of readyToResurface ?? []) {
    if ((row.composite_score as number) >= QUIET_AUTO_CONFIRM_THRESHOLD) {
      await supabase.from('anchor_candidates').update({
        status: 'confirmed', reviewed_at: now.toISOString(), resurface_after: null,
      }).eq('id', row.id as string)
      if (row.node_id) {
        await supabase.from('knowledge_nodes').update({ is_anchor: true }).eq('id', row.node_id as string)
      }
      resurfaced++
    } else {
      await supabase.from('anchor_candidates').update({ status: 'pending' }).eq('id', row.id as string)
    }
  }

  // Step 5: Heal — is_anchor=true nodes without a confirmed candidate row
  const { data: anchorNodes } = await supabase
    .from('knowledge_nodes')
    .select('id, label')
    .eq('user_id', userId)
    .eq('is_anchor', true)

  const nowStr = now.toISOString()
  for (const node of anchorNodes ?? []) {
    const { data: existing } = await supabase
      .from('anchor_candidates')
      .select('id')
      .eq('user_id', userId)
      .eq('node_id', node.id as string)
      .in('status', ['confirmed', 'dormant'])
      .maybeSingle()

    if (!existing) {
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

  // Step 6: Auto-archive dormant anchors (opt-in; most users have autoArchiveDormantAfterDays = null)
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

  return { autoDismissed, markedDormant, resurfaced, healed, reactivated }
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
  log({ stage: 'anchor', status: 'ok', message: 'score-daily started' })

  const sb = getSupabase()
  const now = Date.now()
  const sevenDaysAgo = new Date(now - MOMENTUM_WINDOW_DAYS * 86400000).toISOString()

  const results: Record<string, {
    momentumCandidates: number
    qualifiedForPhase2: number
    scored: number
    surfaced: number
    autoConfirmed: number
    lifecycle: { autoDismissed: number; markedDormant: number; resurfaced: number; healed: number; reactivated: number }
  }> = {}

  try {
    // Query 1: All edges from the last 7 days across all users
    const { data: recentEdges, error: edgesError } = await sb
      .from('knowledge_edges')
      .select('source_node_id, target_node_id, relation_type, created_at, user_id')
      .gte('created_at', sevenDaysAgo)

    if (edgesError) throw new Error(`Failed to fetch recent edges: ${edgesError.message}`)
    if (!recentEdges || recentEdges.length === 0) {
      log({ stage: 'anchor', status: 'skipped', message: 'No edge activity in last 7 days', duration_ms: Date.now() - startTime })
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
      // Phase 1: Momentum gate
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
          scored: 0, surfaced: 0, autoConfirmed: 0,
          lifecycle: { autoDismissed: 0, markedDormant: 0, resurfaced: 0, healed: 0, reactivated: 0 },
        }
        continue
      }

      const { data: profileRow } = await sb
        .from('user_profiles')
        .select('processing_preferences')
        .eq('user_id', userId)
        .maybeSingle()

      const config = resolveUserConfig(
        (profileRow?.processing_preferences ?? null) as Record<string, unknown> | null
      )

      const lifecycle = await runLifecycleTransitions(sb, userId, config)

      // Phase 2: Full signal scoring for momentum-qualified nodes
      const qualifiedIds = momentumResults.map(m => m.nodeId)

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

      const nodes     = nodesRes.data ?? []
      const outEdges  = outEdgesRes.data ?? []
      const inEdges   = inEdgesRes.data ?? []
      const nodeMap   = new Map(nodes.map(n => [n.id as string, n]))

      const nonAnchorMomentum = momentumResults.filter(m => {
        const node = nodeMap.get(m.nodeId)
        return node && !node.is_anchor
      })

      if (nonAnchorMomentum.length === 0) {
        results[userId] = {
          momentumCandidates: nodeEdgeMap.size, qualifiedForPhase2: 0,
          scored: 0, surfaced: 0, autoConfirmed: 0, lifecycle,
        }
        continue
      }

      // Collect neighbour IDs
      const allEdges      = [...outEdges, ...inEdges]
      const qualifiedIdSet = new Set(qualifiedIds)
      const neighbourIds  = new Set<string>()
      for (const e of allEdges) {
        if (qualifiedIdSet.has(e.source_node_id as string)) neighbourIds.add(e.target_node_id as string)
        if (qualifiedIdSet.has(e.target_node_id as string)) neighbourIds.add(e.source_node_id as string)
      }
      for (const id of qualifiedIds) neighbourIds.delete(id)

      const nbList = Array.from(neighbourIds)
      const { data: nbNodes } = nbList.length > 0
        ? await sb.from('knowledge_nodes')
            .select('id, entity_type, is_anchor, source_id, source_type')
            .in('id', nbList)
            .eq('user_id', userId)
        : { data: [] }

      const neighbourMap = new Map((nbNodes ?? []).map(n => [n.id as string, n]))

      // Build signal structs for qualified nodes
      const qualifiedSignals: QualifiedNodeSignals[] = []
      for (const m of nonAnchorMomentum) {
        const nodeRow = nodeMap.get(m.nodeId)
        const myOut   = outEdges.filter(e => e.source_node_id === m.nodeId)
        const myIn    = inEdges.filter(e => e.target_node_id === m.nodeId)
        const myAll   = [...myOut, ...myIn]

        const relTypes   = new Set(myAll.map(e => e.relation_type).filter(Boolean))
        const nbTypeSet  = new Set<string>()
        let anchorNb = 0, totalNb = 0

        for (const e of myOut) {
          const nb = neighbourMap.get(e.target_node_id as string)
          if (nb) { nbTypeSet.add(nb.entity_type as string); totalNb++; if (nb.is_anchor) anchorNb++ }
        }
        for (const e of myIn) {
          const nb = neighbourMap.get(e.source_node_id as string)
          if (nb) { nbTypeSet.add(nb.entity_type as string); totalNb++; if (nb.is_anchor) anchorNb++ }
        }

        const srcIdSet   = new Set<string>()
        const srcTypeSet = new Set<string>()
        if (nodeRow?.source_id)   srcIdSet.add(nodeRow.source_id as string)
        if (nodeRow?.source_type) srcTypeSet.add(nodeRow.source_type as string)
        for (const e of myAll) {
          const nbId = qualifiedIdSet.has(e.source_node_id as string) ? e.target_node_id : e.source_node_id
          const nb   = neighbourMap.get(nbId as string)
          if (nb?.source_id)   srcIdSet.add(nb.source_id as string)
          if (nb?.source_type) srcTypeSet.add(nb.source_type as string)
        }

        const daysActive = nodeRow?.created_at
          ? Math.floor((now - new Date(nodeRow.created_at as string).getTime()) / 86400000)
          : 0

        qualifiedSignals.push({
          nodeId: m.nodeId, momentum: m,
          totalEdges: myAll.length, uniqueNeighbourTypes: nbTypeSet.size,
          uniqueSources: srcIdSet.size, uniqueSourceTypes: srcTypeSet.size,
          uniqueRelationTypes: relTypes.size,
          anchorNeighbourCount: anchorNb, totalNeighbourCount: totalNb, daysActive,
        })
      }

      const scored = scoreQualifiedNodes(qualifiedSignals, config.scoringProfile as ScoringProfile)

      // Bulk upsert all candidates via RPC (replaces per-row INSERT/UPDATE loop)
      const nowStr = new Date().toISOString()
      let autoConfirmed = 0

      const candidateBatch = scored.map(candidate => {
        const shouldConfirm  = candidate.compositeScore >= AUTO_CONFIRM_THRESHOLD ||
                               candidate.compositeScore >= QUIET_AUTO_CONFIRM_THRESHOLD
        const status         = shouldConfirm ? 'confirmed' : 'pending'
        if (shouldConfirm) autoConfirmed++

        return {
          node_id:             candidate.signals.nodeId,
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
          scoring_profile:     config.scoringProfile,
          reasoning_text:      candidate.reasoningText,
          threshold_at_scoring: config.suggestionThreshold,
          status,
          suggested_at:        status === 'confirmed' ? nowStr : null,
          reviewed_at:         status === 'confirmed' ? nowStr : null,
          first_scored_at:     nowStr,
          last_scored_at:      nowStr,
        }
      })

      if (candidateBatch.length > 0) {
        const { error: upsertErr } = await sb.rpc('bulk_upsert_anchor_candidates', {
          p_user_id:    userId,
          p_candidates: candidateBatch,
        })
        if (upsertErr) {
          logError({ stage: 'anchor', user_id: userId, error: `bulk_upsert_anchor_candidates: ${upsertErr.message}` })
        }
      }

      results[userId] = {
        momentumCandidates: nodeEdgeMap.size,
        qualifiedForPhase2: nonAnchorMomentum.length,
        scored:             scored.length,
        surfaced:           scored.filter(s => s.compositeScore >= QUIET_AUTO_CONFIRM_THRESHOLD).length,
        autoConfirmed,
        lifecycle,
      }

      log({
        stage: 'anchor', user_id: userId, status: 'ok',
        momentum_candidates: nodeEdgeMap.size,
        qualified:           nonAnchorMomentum.length,
        scored:              scored.length,
        auto_confirmed:      autoConfirmed,
      })
    }

    const totalScored   = Object.values(results).reduce((s, r) => s + r.scored, 0)
    const totalSurfaced = Object.values(results).reduce((s, r) => s + r.surfaced, 0)

    log({
      stage: 'anchor', status: 'ok',
      users:          edgesByUser.size,
      total_scored:   totalScored,
      total_surfaced: totalSurfaced,
      duration_ms:    Date.now() - startTime,
    })

    return res.status(200).json({
      success: true, users: edgesByUser.size, totalScored, totalSurfaced,
      duration_ms: Date.now() - startTime, results,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logError({ stage: 'anchor', error: msg, duration_ms: Date.now() - startTime })
    return res.status(500).json({ success: false, error: msg, duration_ms: Date.now() - startTime })
  }
}
