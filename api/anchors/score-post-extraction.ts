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

  // Cron secret: for internal server-to-server calls
  if (CRON_SECRET && auth === `Bearer ${CRON_SECRET}`) {
    return (req.body as Record<string, unknown>)?.userId as string ?? null
  }

  // Supabase JWT: for calls from useExtraction hook
  const token = auth.replace('Bearer ', '')
  const sb = getSupabase()
  const { data: { user }, error } = await sb.auth.getUser(token)
  if (error || !user) return null
  return user.id
}

// ─── DEFAULTS ─────────────────────────────────────────────────────────────────
const DEFAULT_CONFIG = {
  suggestionThreshold:         0.60,
  dormantAfterDays:            60,
  resurfaceCooldownDays:       30,
  autoDismissAfterDays:        14,
  scoringProfile:              'balanced' as const,
  autoArchiveDormantAfterDays: null as number | null,
}

type ScoringProfile = 'balanced' | 'emerging_topics' | 'deep_concepts' | 'active_focus' | 'well_evidenced'

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

// ─── SIGNAL COMPUTATION ────────────────────────────────────────────────────────

interface NodeSignals {
  nodeId:               string
  totalEdges:           number
  uniqueNeighbourTypes: number
  uniqueSources:        number
  uniqueSourceTypes:    number
  daysActive:           number
  mentionsLast14d:      number
  mentionsPrior14d:     number
  uniqueRelationTypes:  number
  anchorNeighbourCount: number
  totalNeighbourCount:  number
  velocityDirection:    'rising' | 'stable' | 'falling'
  recentVelocity:       number
}

interface ComputedScores {
  centralityScore:  number
  diversityScore:   number
  velocityScore:    number
  richnessScore:    number
  compositeScore:   number
  reasoningText:    string
}

function computeScores(signals: NodeSignals, profile: ScoringProfile): ComputedScores {
  // Signal 1: Centrality
  const degreeScore     = Math.min(signals.totalEdges / 50, 1.0)
  const diversityFactor = Math.min(signals.uniqueNeighbourTypes / 8, 1.0)
  const centralityScore = (degreeScore * 0.6) + (diversityFactor * 0.4)

  // Signal 2: Diversity
  const sourceCountScore = Math.min(signals.uniqueSources / 8, 1.0)
  const typeCountScore   = Math.min(signals.uniqueSourceTypes / 3, 1.0)
  const diversityScore   = (sourceCountScore * 0.65) + (typeCountScore * 0.35)

  // Signal 3: Velocity
  const sustainedScore = Math.min(signals.daysActive / 30, 1.0)
  const recentRatio    = signals.mentionsLast14d / Math.max(signals.mentionsPrior14d, 1)
  const acceleration   = Math.min(recentRatio / 3.0, 1.0)
  const velocityScore  = (sustainedScore * 0.45) + (acceleration * 0.55)

  // Signal 4: Richness
  const richnessScore = Math.min(signals.uniqueRelationTypes / 6, 1.0)

  // Composite
  const w = SIGNAL_WEIGHTS[profile]
  let composite = (
    (centralityScore  * w.centrality)  +
    (diversityScore   * w.diversity)   +
    (velocityScore    * w.velocity)    +
    (richnessScore    * w.richness)
    // behavioural always 0 in Phase 1
  )

  // Overlap penalty: if >70% of neighbours are already anchors, reduce score
  const overlapRatio = signals.anchorNeighbourCount / Math.max(signals.totalNeighbourCount, 1)
  if (overlapRatio > 0.70) {
    composite = composite * 0.75
  }

  composite = Math.min(Math.max(composite, 0), 1.0)

  // Reasoning text
  const parts: string[] = []
  if (signals.uniqueSources >= 5)
    parts.push(`Appeared across ${signals.uniqueSources} sources`)
  else if (signals.uniqueSources >= 2)
    parts.push(`Referenced in ${signals.uniqueSources} different sources`)
  else
    parts.push(`Referenced in ${signals.uniqueSources} source`)

  if (signals.uniqueSourceTypes >= 2)
    parts.push(`spanning ${signals.uniqueSourceTypes} content types`)
  if (signals.daysActive >= 14)
    parts.push(`over ${signals.daysActive} days`)
  if (signals.velocityDirection === 'rising')
    parts.push('with activity increasing recently')
  else if (signals.velocityDirection === 'falling')
    parts.push('though activity has slowed recently')
  if (signals.uniqueRelationTypes >= 4)
    parts.push(`participates in ${signals.uniqueRelationTypes} relationship types`)
  if (signals.anchorNeighbourCount >= 2)
    parts.push(`connects to ${signals.anchorNeighbourCount} of your existing anchors`)

  const reasoningText = parts.join(', ') + '.'

  return { centralityScore, diversityScore, velocityScore, richnessScore, compositeScore: composite, reasoningText }
}

// ─── FETCH NODE SIGNALS ────────────────────────────────────────────────────────

async function fetchNodeSignals(
  supabase: ReturnType<typeof getSupabase>,
  userId: string,
  nodeIds: string[]
): Promise<Map<string, NodeSignals>> {
  const result = new Map<string, NodeSignals>()
  if (nodeIds.length === 0) return result

  // Initialise with defaults
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
  const fourteenDaysMs  = 14 * 86400000

  // 1. Outgoing edges
  const { data: outEdges } = await supabase
    .from('knowledge_edges')
    .select('source_node_id, target_node_id, relation_type, created_at')
    .in('source_node_id', nodeIds)
    .eq('user_id', userId)

  // 2. Incoming edges
  const { data: inEdges } = await supabase
    .from('knowledge_edges')
    .select('source_node_id, target_node_id, relation_type, created_at')
    .in('target_node_id', nodeIds)
    .eq('user_id', userId)

  // 3. Node metadata (created_at, source_id, source_type) for all candidate nodes
  const { data: nodes } = await supabase
    .from('knowledge_nodes')
    .select('id, source_id, source_type, entity_type, is_anchor, created_at')
    .in('id', nodeIds)
    .eq('user_id', userId)

  // 4. All neighbour node IDs — to check entity_type diversity and anchor status
  const allEdges = [...(outEdges ?? []), ...(inEdges ?? [])]
  const neighbourIds = new Set<string>()
  for (const e of allEdges) {
    if (nodeIds.includes(e.source_node_id)) neighbourIds.add(e.target_node_id)
    if (nodeIds.includes(e.target_node_id)) neighbourIds.add(e.source_node_id)
  }

  const neighbourIdList = Array.from(neighbourIds)
  const { data: neighbourNodes } = neighbourIdList.length > 0
    ? await supabase
        .from('knowledge_nodes')
        .select('id, entity_type, is_anchor, source_id, source_type, created_at')
        .in('id', neighbourIdList)
        .eq('user_id', userId)
    : { data: [] }

  const neighbourMap = new Map((neighbourNodes ?? []).map(n => [n.id as string, n]))

  // 5. Build signals per node
  const nodeMap = new Map((nodes ?? []).map(n => [n.id as string, n]))

  for (const nodeId of nodeIds) {
    const signals = result.get(nodeId)!
    const nodeRow = nodeMap.get(nodeId)

    // Edges for this specific node
    const myOutEdges = (outEdges ?? []).filter(e => e.source_node_id === nodeId)
    const myInEdges  = (inEdges  ?? []).filter(e => e.target_node_id === nodeId)
    const myAllEdges = [...myOutEdges, ...myInEdges]

    signals.totalEdges = myAllEdges.length

    // Unique relation types
    const relTypes = new Set(myAllEdges.map(e => e.relation_type).filter(Boolean))
    signals.uniqueRelationTypes = relTypes.size

    // Neighbour entity type diversity + anchor count
    const neighbourTypeSet = new Set<string>()
    let anchorNeighbours = 0
    let totalNeighbours  = 0

    for (const e of myOutEdges) {
      const nb = neighbourMap.get(e.target_node_id)
      if (nb) {
        neighbourTypeSet.add(nb.entity_type as string)
        totalNeighbours++
        if (nb.is_anchor) anchorNeighbours++
      }
    }
    for (const e of myInEdges) {
      const nb = neighbourMap.get(e.source_node_id)
      if (nb) {
        neighbourTypeSet.add(nb.entity_type as string)
        totalNeighbours++
        if (nb.is_anchor) anchorNeighbours++
      }
    }

    signals.uniqueNeighbourTypes  = neighbourTypeSet.size
    signals.anchorNeighbourCount  = anchorNeighbours
    signals.totalNeighbourCount   = totalNeighbours

    // Source diversity: collect all source IDs from the node and its neighbours
    const sourceIdSet   = new Set<string>()
    const sourceTypeSet = new Set<string>()

    if (nodeRow?.source_id)   sourceIdSet.add(nodeRow.source_id as string)
    if (nodeRow?.source_type) sourceTypeSet.add(nodeRow.source_type as string)

    for (const e of myAllEdges) {
      const nbId = nodeIds.includes(e.source_node_id) ? e.target_node_id : e.source_node_id
      const nb = neighbourMap.get(nbId)
      if (nb?.source_id)   sourceIdSet.add(nb.source_id as string)
      if (nb?.source_type) sourceTypeSet.add(nb.source_type as string)
    }

    signals.uniqueSources     = sourceIdSet.size
    signals.uniqueSourceTypes = sourceTypeSet.size

    // Temporal signals
    if (nodeRow?.created_at) {
      const createdAt = new Date(nodeRow.created_at as string).getTime()
      signals.daysActive = Math.floor((now - createdAt) / 86400000)
    }

    // Velocity: count edge creations in last 14d vs prior 14d
    let last14  = 0
    let prior14 = 0
    for (const e of myAllEdges) {
      const edgeTime = new Date(e.created_at as string).getTime()
      if (edgeTime > now - fourteenDaysMs) last14++
      else if (edgeTime > now - 2 * fourteenDaysMs) prior14++
    }
    signals.mentionsLast14d  = last14
    signals.mentionsPrior14d = prior14

    const ratio = last14 / Math.max(prior14, 1)
    signals.recentVelocity   = ratio
    signals.velocityDirection =
      ratio > 1.3 ? 'rising' : ratio < 0.7 ? 'falling' : 'stable'

    result.set(nodeId, signals)
  }

  return result
}

// ─── UPSERT CANDIDATE ─────────────────────────────────────────────────────────

async function upsertCandidate(
  supabase: ReturnType<typeof getSupabase>,
  userId: string,
  signals: NodeSignals,
  scores: ComputedScores,
  profile: ScoringProfile,
  threshold: number
): Promise<{ isNew: boolean; surfaced: boolean }> {
  const now = new Date().toISOString()

  // Check for existing row
  const { data: existing } = await supabase
    .from('anchor_candidates')
    .select('id, status, dismiss_count')
    .eq('user_id', userId)
    .eq('node_id', signals.nodeId)
    .maybeSingle()

  const shouldSurface = scores.compositeScore >= threshold

  if (existing) {
    const updatePayload: Record<string, unknown> = {
      composite_score:     scores.compositeScore,
      centrality_score:    scores.centralityScore,
      diversity_score:     scores.diversityScore,
      velocity_score:      scores.velocityScore,
      richness_score:      scores.richnessScore,
      behavioural_score:   0,
      mention_count:       signals.mentionsLast14d + signals.mentionsPrior14d,
      source_count:        signals.uniqueSources,
      unique_source_types: signals.uniqueSourceTypes,
      days_active:         signals.daysActive,
      recent_velocity:     signals.recentVelocity,
      velocity_direction:  signals.velocityDirection,
      scoring_profile:     profile,
      reasoning_text:      scores.reasoningText,
      last_scored_at:      now,
      threshold_at_scoring: threshold,
    }

    let surfaced = false
    // Advance pending → suggested only if not in a protected status
    if (existing.status === 'pending' && shouldSurface) {
      updatePayload.status       = 'suggested'
      updatePayload.suggested_at = now
      surfaced = true
    }

    await supabase
      .from('anchor_candidates')
      .update(updatePayload)
      .eq('id', existing.id as string)

    return { isNew: false, surfaced }
  }

  // Insert new
  const insertStatus = shouldSurface ? 'suggested' : 'pending'
  await supabase
    .from('anchor_candidates')
    .insert({
      user_id:             userId,
      node_id:             signals.nodeId,
      composite_score:     scores.compositeScore,
      centrality_score:    scores.centralityScore,
      diversity_score:     scores.diversityScore,
      velocity_score:      scores.velocityScore,
      richness_score:      scores.richnessScore,
      behavioural_score:   0,
      mention_count:       signals.mentionsLast14d + signals.mentionsPrior14d,
      source_count:        signals.uniqueSources,
      unique_source_types: signals.uniqueSourceTypes,
      days_active:         signals.daysActive,
      recent_velocity:     signals.recentVelocity,
      velocity_direction:  signals.velocityDirection,
      status:              insertStatus,
      scoring_profile:     profile,
      reasoning_text:      scores.reasoningText,
      threshold_at_scoring: threshold,
      suggested_at:        insertStatus === 'suggested' ? now : null,
      first_scored_at:     now,
      last_scored_at:      now,
    })

  return { isNew: true, surfaced: insertStatus === 'suggested' }
}

// ─── HANDLER ───────────────────────────────────────────────────────────────────

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

    // 2. Filter out existing anchors — no point scoring is_anchor = true nodes
    const { data: nodeRows } = await sb
      .from('knowledge_nodes')
      .select('id, is_anchor')
      .in('id', nodeIds)
      .eq('user_id', userId)

    const candidateIds = (nodeRows ?? [])
      .filter(n => !n.is_anchor)
      .map(n => n.id as string)

    if (candidateIds.length === 0) {
      return res.status(200).json({
        success: true, scored: 0, surfaced: 0,
        duration_ms: Date.now() - startTime,
        message: 'All nodes are already anchors — nothing to score',
      })
    }

    // 3. Compute signals for all candidate nodes
    const signalsMap = await fetchNodeSignals(sb, userId, candidateIds)

    // 4. Score and upsert each candidate
    let scored   = 0
    let surfaced = 0

    for (const [, signals] of signalsMap) {
      const scores = computeScores(signals, config.scoringProfile as ScoringProfile)
      const result = await upsertCandidate(
        sb, userId, signals, scores,
        config.scoringProfile as ScoringProfile,
        config.suggestionThreshold
      )
      scored++
      if (result.surfaced) surfaced++
    }

    console.log(
      `[score-post-extraction] userId=${userId} sourceId=${sourceId} ` +
      `scored=${scored} surfaced=${surfaced} duration=${Date.now() - startTime}ms`
    )

    return res.status(200).json({
      success: true,
      scored,
      surfaced,
      duration_ms: Date.now() - startTime,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[score-post-extraction] Error:', msg)
    return res.status(500).json({ success: false, error: msg, duration_ms: Date.now() - startTime })
  }
}
