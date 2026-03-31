import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createClient } from '@supabase/supabase-js'

export const maxDuration = 30

// ─── ENVIRONMENT ──────────────────────────────────────────────────────────────
const SUPABASE_URL              = process.env.SUPABASE_URL!
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!
const CRON_SECRET               = process.env.CRON_SECRET

const getSupabase = () => createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

// ─── AUTH ──────────────────────────────────────────────────────────────────────
async function resolveUserId(req: VercelRequest): Promise<string | null> {
  const auth = req.headers['authorization']
  if (!auth) return null

  if (CRON_SECRET && auth === `Bearer ${CRON_SECRET}`) {
    return (req.body as Record<string, unknown>)?.userId as string ?? null
  }

  const token = auth.replace('Bearer ', '')
  const sb = getSupabase()
  const { data: { user }, error } = await sb.auth.getUser(token)
  if (error || !user) return null
  return user.id
}

// ─── DEFAULTS ─────────────────────────────────────────────────────────────────
type ScoringProfile = 'balanced' | 'emerging_topics' | 'deep_concepts' | 'active_focus' | 'well_evidenced'

const DEFAULT_CONFIG = {
  suggestionThreshold:         0.40,
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

// ─── MOMENTUM CONSTANTS (identical to score-daily — serverless constraint) ────
const MOMENTUM_WINDOW_DAYS = 7
const MOMENTUM_DECAY = 0.6
const DAY_WEIGHTS = Array.from({ length: MOMENTUM_WINDOW_DAYS }, (_, i) =>
  Math.pow(MOMENTUM_DECAY, i)
)
const MAX_MOMENTUM = DAY_WEIGHTS.reduce((s, w) => s + w, 0)
const MIN_ACTIVE_DAYS = 1
const MOMENTUM_THRESHOLD = 0.06
const STREAK_BONUS_PER_DAY = 0.1
const MAX_STREAK_BONUS = 1.5

// ─── MOMENTUM COMPUTATION (identical to score-daily — serverless constraint) ──

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
      const ageMs = now - new Date(edge.created_at).getTime()
      const dayIndex = Math.floor(ageMs / oneDayMs)
      if (dayIndex >= 0 && dayIndex < MOMENTUM_WINDOW_DAYS) {
        dayBuckets[dayIndex]++
      }
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
    const boostedMomentum = rawMomentum * streakMultiplier
    const momentumScore = Math.min(boostedMomentum / (MAX_MOMENTUM * MAX_STREAK_BONUS), 1.0)

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

// ─── Levenshtein distance (inline — serverless constraint) ────────────────────
function levenshteinDistance(a: string, b: string): number {
  const m = a.length, n = b.length
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  )
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i]![j] = a[i - 1] === b[j - 1]
        ? dp[i - 1]![j - 1]!
        : 1 + Math.min(dp[i - 1]![j]!, dp[i]![j - 1]!, dp[i - 1]![j - 1]!)
    }
  }
  return dp[m]![n]!
}

// ─── Check if anchor candidate duplicates an existing confirmed anchor ────────
async function checkAnchorCandidateDedup(
  userId: string,
  candidateNodeId: string,
  sb: ReturnType<typeof getSupabase>
): Promise<{
  isDuplicate: boolean
  duplicateOfAnchorId?: string
  duplicateOfAnchorLabel?: string
  similarity?: number
}> {
  const { data: candidate } = await sb
    .from('knowledge_nodes')
    .select('label, entity_type, embedding')
    .eq('id', candidateNodeId)
    .maybeSingle()

  if (!candidate?.embedding) return { isDuplicate: false }

  // Check via semantic similarity RPC
  const { data: similarNodes } = await sb.rpc('find_similar_nodes', {
    p_user_id:   userId,
    p_embedding: candidate.embedding,
    p_threshold: 0.85,
    p_limit:     5,
  })

  const anchorMatch = (similarNodes as Array<{ id: string; label: string; is_anchor: boolean; similarity: number }> ?? []).find(
    n => n.is_anchor === true && n.id !== candidateNodeId
  )

  if (anchorMatch) {
    return {
      isDuplicate: true,
      duplicateOfAnchorId:    anchorMatch.id,
      duplicateOfAnchorLabel: anchorMatch.label,
      similarity:             anchorMatch.similarity,
    }
  }

  // Also check Levenshtein against confirmed anchors
  const { data: anchors } = await sb
    .from('knowledge_nodes')
    .select('id, label, entity_type')
    .eq('user_id', userId)
    .eq('is_anchor', true)
    .neq('id', candidateNodeId)

  const normalizedCandidate = (candidate.label as string).toLowerCase().trim()

  for (const anchor of anchors ?? []) {
    const normalizedAnchor = (anchor.label as string).toLowerCase().trim()
    const editDist = levenshteinDistance(normalizedCandidate, normalizedAnchor)
    const maxLen = Math.max(normalizedCandidate.length, normalizedAnchor.length)
    if (maxLen === 0) continue
    const similarity = 1 - (editDist / maxLen)

    if (similarity >= 0.90) {
      return {
        isDuplicate: true,
        duplicateOfAnchorId:    anchor.id as string,
        duplicateOfAnchorLabel: anchor.label as string,
        similarity,
      }
    }
  }

  return { isDuplicate: false }
}

// ─── HANDLER ───────────────────────────────────────────────────────────────────
// Post-extraction scoring: given newly created nodeIds, check if any of them
// (combined with their recent edge history) now have enough momentum to surface.
// This is a targeted version of the daily scorer — it only looks at the nodes
// from this extraction, but evaluates them with the same momentum-first pipeline.

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')

  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const startTime = Date.now()
  const userId = await resolveUserId(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })

  const body = req.body as { userId?: string; sourceId?: string; nodeIds?: string[] }
  const { nodeIds, sourceId } = body

  if (!nodeIds || nodeIds.length === 0) {
    return res.status(400).json({ error: 'nodeIds is required and must be non-empty' })
  }

  const sb = getSupabase()
  const now = Date.now()
  const sevenDaysAgo = new Date(now - MOMENTUM_WINDOW_DAYS * 86400000).toISOString()

  try {
    // 1. Fetch user config
    const { data: profile } = await sb
      .from('user_profiles')
      .select('processing_preferences')
      .eq('user_id', userId)
      .maybeSingle()

    const config = resolveUserConfig(
      (profile?.processing_preferences ?? null) as Record<string, unknown> | null
    )

    // 2. Filter out existing anchors
    const { data: nodeRows } = await sb
      .from('knowledge_nodes')
      .select('id, is_anchor, source_id, source_type, entity_type, created_at')
      .in('id', nodeIds)
      .eq('user_id', userId)

    const candidateNodes = (nodeRows ?? []).filter(n => !n.is_anchor)
    const candidateIds = candidateNodes.map(n => n.id as string)

    if (candidateIds.length === 0) {
      return res.status(200).json({
        success: true, scored: 0, surfaced: 0,
        duration_ms: Date.now() - startTime,
        message: 'All nodes are already anchors — nothing to score',
      })
    }

    // 3. Fetch all edges in the 7-day window for these nodes (both directions)
    const [outEdgesRes, inEdgesRes] = await Promise.all([
      sb.from('knowledge_edges')
        .select('source_node_id, target_node_id, relation_type, created_at')
        .in('source_node_id', candidateIds)
        .eq('user_id', userId)
        .gte('created_at', sevenDaysAgo),
      sb.from('knowledge_edges')
        .select('source_node_id, target_node_id, relation_type, created_at')
        .in('target_node_id', candidateIds)
        .eq('user_id', userId)
        .gte('created_at', sevenDaysAgo),
    ])

    const recentEdges = [...(outEdgesRes.data ?? []), ...(inEdgesRes.data ?? [])]

    // Build node → edges map for momentum
    const nodeEdgeMap = new Map<string, Array<{ created_at: string }>>()
    for (const id of candidateIds) nodeEdgeMap.set(id, [])
    for (const edge of recentEdges) {
      const src = edge.source_node_id as string
      const tgt = edge.target_node_id as string
      if (nodeEdgeMap.has(src)) nodeEdgeMap.get(src)!.push({ created_at: edge.created_at as string })
      if (nodeEdgeMap.has(tgt)) nodeEdgeMap.get(tgt)!.push({ created_at: edge.created_at as string })
    }

    // 4. Phase 1: Momentum gate
    const momentumResults = computeMomentum(nodeEdgeMap, now)

    // For post-extraction, also include nodes that just got created today
    // even if they only have 1 active day — they're brand new.
    // We create a "seed" entry for them so the daily cron can track them.
    const momentumNodeIds = new Set(momentumResults.map(m => m.nodeId))
    const seedNodes = candidateIds.filter(id => !momentumNodeIds.has(id))

    // 5. Phase 2: Full signals for momentum-qualified nodes
    // Fetch ALL edges (not just 7-day) for structural signals
    const qualifiedIds = momentumResults.map(m => m.nodeId)
    let scored = 0
    let surfaced = 0

    if (qualifiedIds.length > 0) {
      const [allOutRes, allInRes] = await Promise.all([
        sb.from('knowledge_edges')
          .select('source_node_id, target_node_id, relation_type')
          .in('source_node_id', qualifiedIds)
          .eq('user_id', userId),
        sb.from('knowledge_edges')
          .select('source_node_id, target_node_id, relation_type')
          .in('target_node_id', qualifiedIds)
          .eq('user_id', userId),
      ])

      const allOut = allOutRes.data ?? []
      const allIn  = allInRes.data ?? []
      const allEdges = [...allOut, ...allIn]

      // Neighbour metadata
      const neighbourIds = new Set<string>()
      const qualifiedIdSet = new Set(qualifiedIds)
      for (const e of allEdges) {
        if (qualifiedIdSet.has(e.source_node_id as string)) neighbourIds.add(e.target_node_id as string)
        if (qualifiedIdSet.has(e.target_node_id as string)) neighbourIds.add(e.source_node_id as string)
      }
      for (const id of qualifiedIds) neighbourIds.delete(id)

      const nbList = Array.from(neighbourIds)
      const { data: nbNodes } = nbList.length > 0
        ? await sb.from('knowledge_nodes')
            .select('id, entity_type, is_anchor, source_id, source_type')
            .in('id', nbList).eq('user_id', userId)
        : { data: [] }

      const neighbourMap = new Map((nbNodes ?? []).map(n => [n.id as string, n]))
      const nodeMap = new Map(candidateNodes.map(n => [n.id as string, n]))

      // Batch-fetch existing candidates
      const { data: existingCandidates } = await sb
        .from('anchor_candidates')
        .select('id, node_id, status, dismiss_count')
        .eq('user_id', userId)
        .in('node_id', qualifiedIds)

      const existingMap = new Map(
        (existingCandidates ?? []).map(c => [c.node_id as string, c])
      )

      const w = SIGNAL_WEIGHTS[config.scoringProfile as ScoringProfile]
      const nowStr = new Date().toISOString()
      const protectedStatuses = ['confirmed', 'dismissed', 'archived', 'dormant']

      for (const m of momentumResults) {
        const nodeRow = nodeMap.get(m.nodeId)
        const myOut = allOut.filter(e => e.source_node_id === m.nodeId)
        const myIn  = allIn.filter(e => e.target_node_id === m.nodeId)
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

        // Compute scores
        const degreeScore     = Math.min(myAll.length / 20, 1.0)
        const diversityFactor = Math.min(nbTypeSet.size / 5, 1.0)
        const centralityScore = (degreeScore * 0.6) + (diversityFactor * 0.4)

        const sourceCountScore = Math.min(srcIdSet.size / 4, 1.0)
        const typeCountScore   = Math.min(srcTypeSet.size / 3, 1.0)
        const diversityScore   = (sourceCountScore * 0.65) + (typeCountScore * 0.35)

        const richnessScore = Math.min(relTypes.size / 6, 1.0)

        let composite = (centralityScore * w.centrality) +
          (diversityScore * w.diversity) + (richnessScore * w.richness)

        const overlapRatio = anchorNb / Math.max(totalNb, 1)
        if (overlapRatio > 0.70) composite *= 0.75

        const momentumBoost = 0.70 + (m.momentumScore * 0.30)
        composite = Math.min(Math.max(composite * momentumBoost, 0), 1.0)

        // Reasoning
        const parts: string[] = []
        if (m.consecutiveStreak >= 3) parts.push(`Active ${m.consecutiveStreak} days in a row`)
        else if (m.activeDays >= 2) parts.push(`Appeared on ${m.activeDays} of the last 7 days`)
        if (srcIdSet.size >= 2) parts.push(`in ${srcIdSet.size} different sources`)
        if (srcTypeSet.size >= 2) parts.push(`spanning ${srcTypeSet.size} content types`)
        if (relTypes.size >= 4) parts.push(`with ${relTypes.size} relationship types`)
        if (anchorNb >= 2) parts.push(`connects to ${anchorNb} existing anchors`)

        // Check if this candidate duplicates an existing confirmed anchor
        let isDupCandidate = false
        try {
          const dupCheck = await checkAnchorCandidateDedup(userId, m.nodeId, sb)
          if (dupCheck.isDuplicate && dupCheck.duplicateOfAnchorId) {
            isDupCandidate = true
            // Boost the existing anchor's score
            await sb.from('anchor_candidates')
              .update({
                composite_score: Math.min(composite * 1.15, 1.0),
                last_scored_at: nowStr,
                reasoning_text: (parts.join(', ') + `. Validated by duplicate candidate.`).trim(),
              })
              .eq('node_id', dupCheck.duplicateOfAnchorId)
              .eq('user_id', userId)
            // Queue a merge suggestion
            try {
              await sb.from('potential_duplicates').insert({
                user_id: userId,
                node_a_id: dupCheck.duplicateOfAnchorId,
                node_b_id: m.nodeId,
                similarity: dupCheck.similarity ?? 0.9,
                match_type: 'semantic',
                status: 'pending',
                metadata: {
                  detected_at: nowStr,
                  detection_source: 'anchor_scoring',
                  anchor_label: dupCheck.duplicateOfAnchorLabel,
                },
              })
            } catch { /* ignore duplicate constraint violations */ }
            console.log(`[score-post-extraction] Skipped candidate ${m.nodeId} — duplicates anchor ${dupCheck.duplicateOfAnchorLabel}`)
          }
        } catch (err) {
          console.warn(`[score-post-extraction] Anchor dedup check failed for ${m.nodeId} (non-fatal):`, err)
        }

        if (isDupCandidate) { scored++; continue }

        const shouldSurface = composite >= (config.suggestionThreshold as number)
        const existing = existingMap.get(m.nodeId)

        if (existing) {
          const updatePayload: Record<string, unknown> = {
            composite_score: composite, centrality_score: centralityScore,
            diversity_score: diversityScore, velocity_score: m.momentumScore,
            richness_score: richnessScore, mention_count: m.edgeCount7d,
            source_count: srcIdSet.size, unique_source_types: srcTypeSet.size,
            days_active: nodeRow?.created_at
              ? Math.floor((now - new Date(nodeRow.created_at as string).getTime()) / 86400000) : 0,
            recent_velocity: m.momentumScore,
            velocity_direction: m.consecutiveStreak >= 2 ? 'rising' : 'stable',
            scoring_profile: config.scoringProfile, reasoning_text: parts.join(', ') + '.',
            last_scored_at: nowStr, threshold_at_scoring: config.suggestionThreshold,
          }
          if (!protectedStatuses.includes(existing.status as string) && shouldSurface && existing.status === 'pending') {
            updatePayload.status = 'suggested'
            updatePayload.suggested_at = nowStr
            surfaced++
          }
          await sb.from('anchor_candidates').update(updatePayload).eq('id', existing.id as string)
        } else {
          const insertStatus = shouldSurface ? 'suggested' : 'pending'
          await sb.from('anchor_candidates').insert({
            user_id: userId, node_id: m.nodeId,
            composite_score: composite, centrality_score: centralityScore,
            diversity_score: diversityScore, velocity_score: m.momentumScore,
            richness_score: richnessScore, behavioural_score: 0,
            mention_count: m.edgeCount7d, source_count: srcIdSet.size,
            unique_source_types: srcTypeSet.size,
            days_active: nodeRow?.created_at
              ? Math.floor((now - new Date(nodeRow.created_at as string).getTime()) / 86400000) : 0,
            recent_velocity: m.momentumScore,
            velocity_direction: m.consecutiveStreak >= 2 ? 'rising' : 'stable',
            status: insertStatus, scoring_profile: config.scoringProfile,
            reasoning_text: parts.join(', ') + '.',
            threshold_at_scoring: config.suggestionThreshold,
            suggested_at: insertStatus === 'suggested' ? nowStr : null,
            first_scored_at: nowStr, last_scored_at: nowStr,
          })
          if (insertStatus === 'suggested') surfaced++
        }
        scored++
      }
    }

    // 6. Seed entries for brand-new nodes (no momentum yet, but track them)
    if (seedNodes.length > 0) {
      const { data: existingSeedCandidates } = await sb
        .from('anchor_candidates')
        .select('node_id')
        .eq('user_id', userId)
        .in('node_id', seedNodes)

      const existingSeedSet = new Set(
        (existingSeedCandidates ?? []).map(c => c.node_id as string)
      )
      const nowStr = new Date().toISOString()

      for (const nodeId of seedNodes) {
        if (existingSeedSet.has(nodeId)) continue
        await sb.from('anchor_candidates').insert({
          user_id: userId, node_id: nodeId,
          composite_score: 0, centrality_score: 0, diversity_score: 0,
          velocity_score: 0, richness_score: 0, behavioural_score: 0,
          mention_count: 0, source_count: 0, unique_source_types: 0,
          days_active: 0, recent_velocity: 0, velocity_direction: 'stable',
          status: 'pending', scoring_profile: config.scoringProfile,
          reasoning_text: 'Newly extracted — tracking for momentum.',
          threshold_at_scoring: config.suggestionThreshold,
          first_scored_at: nowStr, last_scored_at: nowStr,
        })
      }
    }

    console.log(
      `[score-post-extraction] userId=${userId} sourceId=${sourceId} ` +
      `candidates=${candidateIds.length} momentum_qualified=${qualifiedIds.length} ` +
      `scored=${scored} surfaced=${surfaced} seeds=${seedNodes.length} ` +
      `duration=${Date.now() - startTime}ms`
    )

    return res.status(200).json({
      success: true, scored, surfaced, seeds: seedNodes.length,
      duration_ms: Date.now() - startTime,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[score-post-extraction] Error:', msg)
    return res.status(500).json({ success: false, error: msg, duration_ms: Date.now() - startTime })
  }
}
