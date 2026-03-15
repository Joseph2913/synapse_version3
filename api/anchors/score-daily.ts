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

// ─── DEFAULTS (identical copy to score-post-extraction — required by serverless constraint) ──
type ScoringProfile = 'balanced' | 'emerging_topics' | 'deep_concepts' | 'active_focus' | 'well_evidenced'

const DEFAULT_CONFIG = {
  suggestionThreshold:         0.60,
  dormantAfterDays:            60,
  resurfaceCooldownDays:       30,
  autoDismissAfterDays:        14,
  scoringProfile:              'balanced' as ScoringProfile,
  autoArchiveDormantAfterDays: null as number | null,
}

const SIGNAL_WEIGHTS: Record<ScoringProfile, {
  centrality: number; diversity: number; velocity: number; richness: number; behavioural: number
}> = {
  balanced:        { centrality: 0.35, diversity: 0.25, velocity: 0.20, richness: 0.15, behavioural: 0.05 },
  emerging_topics: { centrality: 0.15, diversity: 0.15, velocity: 0.55, richness: 0.10, behavioural: 0.05 },
  deep_concepts:   { centrality: 0.45, diversity: 0.15, velocity: 0.10, richness: 0.25, behavioural: 0.05 },
  active_focus:    { centrality: 0.20, diversity: 0.20, velocity: 0.45, richness: 0.10, behavioural: 0.05 },
  well_evidenced:  { centrality: 0.25, diversity: 0.50, velocity: 0.10, richness: 0.10, behavioural: 0.05 },
}

function resolveUserConfig(processingPreferences: Record<string, unknown> | null) {
  const stored = ((processingPreferences ?? {}).anchor_settings ?? {}) as Record<string, unknown>
  return { ...DEFAULT_CONFIG, ...stored }
}

// ─── SIGNAL COMPUTATION (identical copy — required by serverless constraint) ──

interface NodeSignals {
  nodeId: string; totalEdges: number; uniqueNeighbourTypes: number
  uniqueSources: number; uniqueSourceTypes: number; daysActive: number
  mentionsLast14d: number; mentionsPrior14d: number; uniqueRelationTypes: number
  anchorNeighbourCount: number; totalNeighbourCount: number
  velocityDirection: 'rising' | 'stable' | 'falling'; recentVelocity: number
}

interface ComputedScores {
  centralityScore: number; diversityScore: number; velocityScore: number
  richnessScore: number; compositeScore: number; reasoningText: string
}

function computeScores(signals: NodeSignals, profile: ScoringProfile): ComputedScores {
  const degreeScore     = Math.min(signals.totalEdges / 50, 1.0)
  const diversityFactor = Math.min(signals.uniqueNeighbourTypes / 8, 1.0)
  const centralityScore = (degreeScore * 0.6) + (diversityFactor * 0.4)

  const sourceCountScore = Math.min(signals.uniqueSources / 8, 1.0)
  const typeCountScore   = Math.min(signals.uniqueSourceTypes / 3, 1.0)
  const diversityScore   = (sourceCountScore * 0.65) + (typeCountScore * 0.35)

  const sustainedScore = Math.min(signals.daysActive / 30, 1.0)
  const recentRatio    = signals.mentionsLast14d / Math.max(signals.mentionsPrior14d, 1)
  const acceleration   = Math.min(recentRatio / 3.0, 1.0)
  const velocityScore  = (sustainedScore * 0.45) + (acceleration * 0.55)

  const richnessScore = Math.min(signals.uniqueRelationTypes / 6, 1.0)

  const w = SIGNAL_WEIGHTS[profile]
  let composite = (centralityScore * w.centrality) + (diversityScore * w.diversity) +
    (velocityScore * w.velocity) + (richnessScore * w.richness)

  const overlapRatio = signals.anchorNeighbourCount / Math.max(signals.totalNeighbourCount, 1)
  if (overlapRatio > 0.70) composite *= 0.75

  composite = Math.min(Math.max(composite, 0), 1.0)

  const parts: string[] = []
  if (signals.uniqueSources >= 5)       parts.push(`Appeared across ${signals.uniqueSources} sources`)
  else if (signals.uniqueSources >= 2)  parts.push(`Referenced in ${signals.uniqueSources} different sources`)
  else                                  parts.push(`Referenced in ${signals.uniqueSources} source`)
  if (signals.uniqueSourceTypes >= 2)   parts.push(`spanning ${signals.uniqueSourceTypes} content types`)
  if (signals.daysActive >= 14)         parts.push(`over ${signals.daysActive} days`)
  if (signals.velocityDirection === 'rising')  parts.push('with activity increasing recently')
  else if (signals.velocityDirection === 'falling') parts.push('though activity has slowed recently')
  if (signals.uniqueRelationTypes >= 4) parts.push(`participates in ${signals.uniqueRelationTypes} relationship types`)
  if (signals.anchorNeighbourCount >= 2) parts.push(`connects to ${signals.anchorNeighbourCount} of your existing anchors`)

  return {
    centralityScore, diversityScore, velocityScore, richnessScore,
    compositeScore: composite, reasoningText: parts.join(', ') + '.',
  }
}

// ─── BATCH SIGNAL FETCH (same logic as score-post-extraction, accepts any nodeIds) ──

async function fetchNodeSignalsBatch(
  supabase: ReturnType<typeof getSupabase>,
  userId: string,
  nodeIds: string[]
): Promise<Map<string, NodeSignals>> {
  const result = new Map<string, NodeSignals>()
  if (nodeIds.length === 0) return result

  for (const id of nodeIds) {
    result.set(id, {
      nodeId: id, totalEdges: 0, uniqueNeighbourTypes: 0,
      uniqueSources: 0, uniqueSourceTypes: 0, daysActive: 0,
      mentionsLast14d: 0, mentionsPrior14d: 0, uniqueRelationTypes: 0,
      anchorNeighbourCount: 0, totalNeighbourCount: 0,
      velocityDirection: 'stable', recentVelocity: 1,
    })
  }

  const now = Date.now()
  const fourteenDaysMs = 14 * 86400000

  const [outEdgesRes, inEdgesRes, nodesRes] = await Promise.all([
    supabase.from('knowledge_edges').select('source_node_id, target_node_id, relation_type, created_at')
      .in('source_node_id', nodeIds).eq('user_id', userId),
    supabase.from('knowledge_edges').select('source_node_id, target_node_id, relation_type, created_at')
      .in('target_node_id', nodeIds).eq('user_id', userId),
    supabase.from('knowledge_nodes').select('id, source_id, source_type, entity_type, is_anchor, created_at')
      .in('id', nodeIds).eq('user_id', userId),
  ])

  const outEdges = outEdgesRes.data ?? []
  const inEdges  = inEdgesRes.data ?? []
  const nodes    = nodesRes.data ?? []

  const neighbourIds = new Set<string>()
  for (const e of [...outEdges, ...inEdges]) {
    if (nodeIds.includes(e.source_node_id)) neighbourIds.add(e.target_node_id)
    if (nodeIds.includes(e.target_node_id)) neighbourIds.add(e.source_node_id)
  }

  const nbList = Array.from(neighbourIds)
  const { data: nbNodes } = nbList.length > 0
    ? await supabase.from('knowledge_nodes').select('id, entity_type, is_anchor, source_id, source_type, created_at')
        .in('id', nbList).eq('user_id', userId)
    : { data: [] }

  const neighbourMap = new Map((nbNodes ?? []).map(n => [n.id as string, n]))
  const nodeMap      = new Map(nodes.map(n => [n.id as string, n]))

  for (const nodeId of nodeIds) {
    const signals   = result.get(nodeId)!
    const nodeRow   = nodeMap.get(nodeId)
    const myOut     = outEdges.filter(e => e.source_node_id === nodeId)
    const myIn      = inEdges.filter(e => e.target_node_id === nodeId)
    const myAll     = [...myOut, ...myIn]

    signals.totalEdges = myAll.length
    const relTypes = new Set(myAll.map(e => e.relation_type).filter(Boolean))
    signals.uniqueRelationTypes = relTypes.size

    const nbTypeSet = new Set<string>()
    let anchorNb = 0, totalNb = 0
    for (const e of myOut) {
      const nb = neighbourMap.get(e.target_node_id)
      if (nb) { nbTypeSet.add(nb.entity_type as string); totalNb++; if (nb.is_anchor) anchorNb++ }
    }
    for (const e of myIn) {
      const nb = neighbourMap.get(e.source_node_id)
      if (nb) { nbTypeSet.add(nb.entity_type as string); totalNb++; if (nb.is_anchor) anchorNb++ }
    }
    signals.uniqueNeighbourTypes = nbTypeSet.size
    signals.anchorNeighbourCount = anchorNb
    signals.totalNeighbourCount  = totalNb

    const srcIdSet = new Set<string>()
    const srcTypeSet = new Set<string>()
    if (nodeRow?.source_id)   srcIdSet.add(nodeRow.source_id as string)
    if (nodeRow?.source_type) srcTypeSet.add(nodeRow.source_type as string)
    for (const e of myAll) {
      const nbId = nodeIds.includes(e.source_node_id) ? e.target_node_id : e.source_node_id
      const nb = neighbourMap.get(nbId)
      if (nb?.source_id)   srcIdSet.add(nb.source_id as string)
      if (nb?.source_type) srcTypeSet.add(nb.source_type as string)
    }
    signals.uniqueSources     = srcIdSet.size
    signals.uniqueSourceTypes = srcTypeSet.size

    if (nodeRow?.created_at) {
      signals.daysActive = Math.floor((now - new Date(nodeRow.created_at as string).getTime()) / 86400000)
    }
    let last14 = 0, prior14 = 0
    for (const e of myAll) {
      const t = new Date(e.created_at as string).getTime()
      if (t > now - fourteenDaysMs) last14++
      else if (t > now - 2 * fourteenDaysMs) prior14++
    }
    signals.mentionsLast14d  = last14
    signals.mentionsPrior14d = prior14
    const ratio = last14 / Math.max(prior14, 1)
    signals.recentVelocity   = ratio
    signals.velocityDirection = ratio > 1.3 ? 'rising' : ratio < 0.7 ? 'falling' : 'stable'
  }

  return result
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

  for (const row of stale ?? []) {
    const resurface = new Date(now.getTime() + (config.resurfaceCooldownDays as number) * 86400000).toISOString()
    await supabase.from('anchor_candidates').update({
      status:          'dismissed',
      reviewed_at:     now.toISOString(),
      resurface_after: resurface,
      dismiss_count:   (row.dismiss_count as number ?? 0) + 1,
    }).eq('id', row.id as string)
    autoDismissed++
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
    // Check most recent edge on this node
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
        status:       'dormant',
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
        status:       'confirmed',
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
    // Only re-surface if score is still above threshold
    if ((row.composite_score as number) >= (config.suggestionThreshold as number)) {
      await supabase.from('anchor_candidates').update({
        status:          'suggested',
        suggested_at:    now.toISOString(),
        resurface_after: null,
      }).eq('id', row.id as string)
      resurfaced++
    } else {
      // Score dropped below threshold — move back to pending for re-scoring
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
      // Create a confirmed candidate row for this orphaned anchor
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

  // 6. Auto-archive dormant anchors (if user has enabled this opt-in feature)
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
  const BATCH_SIZE = 100

  const results: Record<string, {
    scored: number; surfaced: number; lifecycle: { autoDismissed: number; markedDormant: number; resurfaced: number; healed: number }
  }> = {}

  try {
    // Fetch all distinct user IDs with knowledge_nodes
    const { data: userRows } = await sb
      .from('knowledge_nodes')
      .select('user_id')
      .neq('user_id', null)

    if (!userRows || userRows.length === 0) {
      return res.status(200).json({ success: true, users: 0, duration_ms: Date.now() - startTime })
    }

    const userIds = [...new Set((userRows as { user_id: string }[]).map(r => r.user_id))]

    for (const userId of userIds) {
      // 1. Load user config
      const { data: profileRow } = await sb
        .from('user_profiles')
        .select('processing_preferences')
        .eq('user_id', userId)
        .maybeSingle()

      const config = resolveUserConfig(
        (profileRow?.processing_preferences ?? null) as Record<string, unknown> | null
      )

      // 2. Lifecycle transitions first
      const lifecycle = await runLifecycleTransitions(sb, userId, config)

      // 3. Fetch all non-anchor nodes for this user (batched)
      let offset = 0
      let scored = 0, surfaced = 0

      while (true) {
        const { data: batch } = await sb
          .from('knowledge_nodes')
          .select('id')
          .eq('user_id', userId)
          .eq('is_anchor', false)
          .order('created_at', { ascending: false })
          .range(offset, offset + BATCH_SIZE - 1)

        if (!batch || batch.length === 0) break

        const batchIds = (batch as { id: string }[]).map(n => n.id)
        const signalsMap = await fetchNodeSignalsBatch(sb, userId, batchIds)

        for (const [nodeId, signals] of signalsMap) {
          const scores = computeScores(signals, config.scoringProfile as ScoringProfile)

          // Check existing status
          const { data: existing } = await sb
            .from('anchor_candidates')
            .select('id, status, dismiss_count')
            .eq('user_id', userId)
            .eq('node_id', nodeId)
            .maybeSingle()

          const protectedStatuses = ['confirmed', 'dismissed', 'archived', 'dormant']
          const shouldSurface = scores.compositeScore >= (config.suggestionThreshold as number)
          const now = new Date().toISOString()

          if (existing) {
            const updatePayload: Record<string, unknown> = {
              composite_score: scores.compositeScore,
              centrality_score: scores.centralityScore,
              diversity_score: scores.diversityScore,
              velocity_score: scores.velocityScore,
              richness_score: scores.richnessScore,
              mention_count: signals.mentionsLast14d + signals.mentionsPrior14d,
              source_count: signals.uniqueSources,
              unique_source_types: signals.uniqueSourceTypes,
              days_active: signals.daysActive,
              recent_velocity: signals.recentVelocity,
              velocity_direction: signals.velocityDirection,
              scoring_profile: config.scoringProfile,
              reasoning_text: scores.reasoningText,
              last_scored_at: now,
            }
            if (!protectedStatuses.includes(existing.status as string) && shouldSurface && existing.status === 'pending') {
              updatePayload.status = 'suggested'
              updatePayload.suggested_at = now
              surfaced++
            }
            await sb.from('anchor_candidates').update(updatePayload).eq('id', existing.id as string)
          } else {
            const insertStatus = shouldSurface ? 'suggested' : 'pending'
            await sb.from('anchor_candidates').insert({
              user_id: userId, node_id: nodeId,
              composite_score: scores.compositeScore, centrality_score: scores.centralityScore,
              diversity_score: scores.diversityScore, velocity_score: scores.velocityScore,
              richness_score: scores.richnessScore, behavioural_score: 0,
              mention_count: signals.mentionsLast14d + signals.mentionsPrior14d,
              source_count: signals.uniqueSources, unique_source_types: signals.uniqueSourceTypes,
              days_active: signals.daysActive, recent_velocity: signals.recentVelocity,
              velocity_direction: signals.velocityDirection, status: insertStatus,
              scoring_profile: config.scoringProfile, reasoning_text: scores.reasoningText,
              threshold_at_scoring: config.suggestionThreshold,
              suggested_at: insertStatus === 'suggested' ? now : null,
              first_scored_at: now, last_scored_at: now,
            })
            if (insertStatus === 'suggested') surfaced++
          }
          scored++
        }

        offset += BATCH_SIZE
        if (batch.length < BATCH_SIZE) break
      }

      results[userId] = { scored, surfaced, lifecycle }
      console.log(`[score-daily] userId=${userId} scored=${scored} surfaced=${surfaced}`)
    }

    const totalScored   = Object.values(results).reduce((s, r) => s + r.scored,   0)
    const totalSurfaced = Object.values(results).reduce((s, r) => s + r.surfaced, 0)

    return res.status(200).json({
      success:      true,
      users:        userIds.length,
      totalScored,
      totalSurfaced,
      duration_ms:  Date.now() - startTime,
      results,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[score-daily] Fatal error:', msg)
    return res.status(500).json({ success: false, error: msg, duration_ms: Date.now() - startTime })
  }
}
