import { supabase } from './supabase'
import type { AnchorCandidateRow, EntityType } from '../types/database'
import type {
  AnchorCandidate,
  AnchorCandidateWithNode,
  AnchorCandidateStatusUpdate,
  AnchorCandidateUpsert,
  AnchorCandidateStatus,
  AnchorHealthSummary,
} from '../types/anchors'

// ─── Row → camelCase mapper ───────────────────────────────────────────────────

function mapRow(row: AnchorCandidateRow): AnchorCandidate {
  return {
    id:                  row.id,
    userId:              row.user_id,
    nodeId:              row.node_id,
    compositeScore:      row.composite_score,
    centralityScore:     row.centrality_score,
    diversityScore:      row.diversity_score,
    velocityScore:       row.velocity_score,
    richnessScore:       row.richness_score,
    behaviouralScore:    row.behavioural_score,
    mentionCount:        row.mention_count,
    sourceCount:         row.source_count,
    uniqueSourceTypes:   row.unique_source_types,
    daysActive:          row.days_active,
    recentVelocity:      row.recent_velocity,
    velocityDirection:   row.velocity_direction,
    status:              row.status,
    scoringProfile:      row.scoring_profile,
    reasoningText:       row.reasoning_text,
    firstScoredAt:       row.first_scored_at,
    lastScoredAt:        row.last_scored_at,
    suggestedAt:         row.suggested_at,
    reviewedAt:          row.reviewed_at,
    dormantSince:        row.dormant_since,
    dismissCount:        row.dismiss_count,
    resurface_after:     row.resurface_after,
    thresholdAtScoring:  row.threshold_at_scoring,
    totalEdges:          row.total_edges ?? 0,
    createdAt:           row.created_at,
    updatedAt:           row.updated_at,
    suggestedParentAnchorId: row.suggested_parent_anchor_id,
  }
}

// ─── Fetch: ALL candidates via RPC (optimised for Signals/Anchors page) ──────
// Single database call that returns all candidates with pre-computed stats.
// See: supabase/migrations/20260331_get_anchor_candidates.sql
// See: docs/PERFORMANCE-PATTERNS.md

export interface AllCandidatesRpcResult {
  suggested: AnchorCandidateWithNode[]
  confirmed: AnchorCandidateWithNode[]
  archived: AnchorCandidateWithNode[]
  suggestedCount: number
}

export async function fetchAllCandidatesViaRpc(
  userId: string
): Promise<AllCandidatesRpcResult> {
  const { data, error } = await supabase.rpc('get_anchor_candidates', { p_user_id: userId })

  if (error) {
    console.error('[anchorCandidates] RPC error:', error.message)
    return { suggested: [], confirmed: [], archived: [], suggestedCount: 0 }
  }

  const result = data as {
    candidates: Array<Record<string, unknown>>
    suggestedCount: number
  } | null

  if (!result?.candidates) return { suggested: [], confirmed: [], archived: [], suggestedCount: 0 }

  // Map RPC rows to AnchorCandidateWithNode, applying live score overrides
  const all: AnchorCandidateWithNode[] = result.candidates.map(row => {
    const r = row as Record<string, unknown>
    const totalEdges = (r.connectionCount as number) ?? 0
    const srcCount = (r.sourceCount as number) ?? 0
    const srcTypes = (r.uniqueSourceTypes as number) ?? 0
    const nbTypeCount = (r.liveNeighborTypeCount as number) ?? 0
    const relTypeCount = (r.liveRelTypeCount as number) ?? 0
    const nodeCreatedAt = (r.node as Record<string, unknown> | null)?.created_at as string | undefined
    const createdMs = nodeCreatedAt ? new Date(nodeCreatedAt).getTime() : Date.now()
    const daysActive = Math.floor((Date.now() - createdMs) / 86400000)

    // Live signal scores (same algorithm as PRD-18)
    const degreeScore = Math.min(totalEdges / 50, 1.0)
    const diversityFactor = Math.min(nbTypeCount / 8, 1.0)
    const liveCentrality = (degreeScore * 0.6) + (diversityFactor * 0.4)
    const liveDiversity = (Math.min(srcCount / 8, 1.0) * 0.65) + (Math.min(srcTypes / 3, 1.0) * 0.35)
    const liveVelocity = (Math.min(daysActive / 30, 1.0) * 0.45) + 0.183
    const liveRichness = Math.min(relTypeCount / 6, 1.0)
    const liveComposite = Math.min(
      liveCentrality * 0.35 + liveDiversity * 0.25 + liveVelocity * 0.20 + liveRichness * 0.15, 1.0
    )

    // Use stored scores unless they're all zero (unscored)
    const storedCentrality = r.centralityScore as number
    const storedDiversity = r.diversityScore as number
    const storedVelocity = r.velocityScore as number
    const useStored = storedCentrality !== 0 || storedDiversity !== 0 || storedVelocity !== 0

    return {
      id: r.id as string,
      userId: r.userId as string,
      nodeId: (r.nodeId as string) ?? null,
      compositeScore: useStored ? (r.compositeScore as number) : Math.round(liveComposite * 10000) / 10000,
      centralityScore: useStored ? storedCentrality : Math.round(liveCentrality * 10000) / 10000,
      diversityScore: useStored ? storedDiversity : Math.round(liveDiversity * 10000) / 10000,
      velocityScore: useStored ? storedVelocity : Math.round(liveVelocity * 10000) / 10000,
      richnessScore: useStored ? (r.richnessScore as number) : Math.round(liveRichness * 10000) / 10000,
      behaviouralScore: (r.behaviouralScore as number) ?? 0,
      mentionCount: (r.mentionCount as number) ?? 0,
      sourceCount: srcCount,
      uniqueSourceTypes: srcTypes,
      daysActive: (r.daysActive as number) ?? 0,
      recentVelocity: (r.recentVelocity as number) ?? 0,
      velocityDirection: (r.velocityDirection as 'rising' | 'stable' | 'falling') ?? 'stable',
      status: r.status as AnchorCandidateStatus,
      scoringProfile: ((r.scoringProfile as string) ?? 'balanced') as AnchorCandidate['scoringProfile'],
      reasoningText: (r.reasoningText as string) ?? null,
      firstScoredAt: (r.firstScoredAt as string) ?? '',
      lastScoredAt: (r.lastScoredAt as string) ?? '',
      suggestedAt: (r.suggestedAt as string) ?? null,
      reviewedAt: (r.reviewedAt as string) ?? null,
      dormantSince: (r.dormantSince as string) ?? null,
      dismissCount: (r.dismissCount as number) ?? 0,
      resurface_after: (r.resurface_after as string) ?? null,
      thresholdAtScoring: (r.thresholdAtScoring as number) ?? null,
      totalEdges: totalEdges,
      createdAt: (r.createdAt as string) ?? '',
      updatedAt: (r.updatedAt as string) ?? '',
      suggestedParentAnchorId: (r.suggestedParentAnchorId as string) ?? null,
      node: r.node as AnchorCandidateWithNode['node'],
      connectionCount: totalEdges,
      anchorConnections: (r.anchorConnections as number) ?? 0,
    }
  })

  return {
    suggested: all.filter(c => c.status === 'suggested'),
    confirmed: all.filter(c => c.status === 'confirmed' || c.status === 'dormant'),
    archived: all.filter(c => c.status === 'archived'),
    suggestedCount: result.suggestedCount ?? 0,
  }
}

// ─── Fetch: candidates with joined node data (legacy per-status query) ───────
// Used by ExploreView for ghost clusters and other targeted queries.
// For the Anchors/Signals page, use fetchAllCandidatesViaRpc() instead.

export async function fetchCandidatesWithNodes(
  userId: string,
  statuses: AnchorCandidateStatus[]
): Promise<AnchorCandidateWithNode[]> {
  // Step 1: Fetch candidate rows (no join — avoids PostgREST FK detection issues)
  const { data: candidateRows, error } = await supabase
    .from('anchor_candidates')
    .select('*')
    .eq('user_id', userId)
    .in('status', statuses)
    .order('composite_score', { ascending: false })

  if (error) {
    console.error('[anchorCandidates] fetchCandidatesWithNodes error:', error.message)
    return []
  }

  if (!candidateRows || candidateRows.length === 0) return []

  // Step 2: Fetch node data separately for all node_ids
  const nodeIds = candidateRows
    .map(r => r.node_id)
    .filter((id): id is string => id !== null)

  const nodeMap = new Map<string, {
    id: string; label: string; entity_type: EntityType;
    description: string | null; quote: string | null; user_tags: string[] | null; confidence: number | null;
    is_anchor: boolean; parent_anchor_id: string | null; created_at: string
  }>()

  if (nodeIds.length > 0) {
    const { data: nodes } = await supabase
      .from('knowledge_nodes')
      .select('id, label, entity_type, description, quote, user_tags, confidence, is_anchor, parent_anchor_id, created_at')
      .in('id', nodeIds)
      .eq('is_merged', false)

    for (const n of nodes ?? []) {
      nodeMap.set(n.id as string, n as {
        id: string; label: string; entity_type: EntityType;
        description: string | null; quote: string | null; user_tags: string[] | null; confidence: number | null;
        is_anchor: boolean; parent_anchor_id: string | null; created_at: string
      })
    }
  }

  // Step 3: Fetch connection counts and source data in bulk
  const connectionCounts = await fetchConnectionCounts(nodeIds)
  const anchorConnectionCounts = await fetchAnchorConnectionCounts(userId, nodeIds)

  // Step 4: Compute live source counts + signal scores for candidates with stale data
  // Fetch all edges for these nodes (both directions) for source enrichment
  const [outEdges, inEdges] = await Promise.all([
    supabase.from('knowledge_edges').select('source_node_id, target_node_id, relation_type').in('source_node_id', nodeIds),
    supabase.from('knowledge_edges').select('source_node_id, target_node_id, relation_type').in('target_node_id', nodeIds),
  ])

  // Collect all neighbour IDs to fetch their source_id/source_type
  const allNeighbourIds = new Set<string>()
  for (const e of outEdges.data ?? []) allNeighbourIds.add(e.target_node_id)
  for (const e of inEdges.data ?? []) allNeighbourIds.add(e.source_node_id)
  const neighbourList = Array.from(allNeighbourIds)

  const neighbourSourceMap = new Map<string, { source_id: string | null; source_type: string | null; entity_type: string }>()
  if (neighbourList.length > 0) {
    // Fetch in batches of 500 to avoid Supabase row limits
    for (let i = 0; i < neighbourList.length; i += 500) {
      const batch = neighbourList.slice(i, i + 500)
      const { data: nbNodes } = await supabase
        .from('knowledge_nodes')
        .select('id, source_id, source_type, entity_type')
        .in('id', batch)
      for (const nb of nbNodes ?? []) {
        neighbourSourceMap.set(nb.id as string, {
          source_id: nb.source_id as string | null,
          source_type: nb.source_type as string | null,
          entity_type: nb.entity_type as string,
        })
      }
    }
  }

  // Build live stats per node
  const liveStats = new Map<string, {
    sourceCount: number; uniqueSourceTypes: number; connectionCount: number;
    centralityScore: number; diversityScore: number; velocityScore: number; richnessScore: number; compositeScore: number
  }>()

  for (const nid of nodeIds) {
    const myOut = (outEdges.data ?? []).filter(e => e.source_node_id === nid)
    const myIn  = (inEdges.data ?? []).filter(e => e.target_node_id === nid)
    const myAll = [...myOut, ...myIn]
    const totalEdges = myAll.length

    // Source diversity
    const srcIds = new Set<string>()
    const srcTypes = new Set<string>()
    const nodeData = nodeMap.get(nid)
    // Add self source if available via neighbour map or node map
    const selfNb = neighbourSourceMap.get(nid)
    if (selfNb?.source_id) srcIds.add(selfNb.source_id)
    if (selfNb?.source_type) srcTypes.add(selfNb.source_type)

    // Neighbour entity type diversity
    const nbEntityTypes = new Set<string>()
    for (const e of myOut) {
      const nb = neighbourSourceMap.get(e.target_node_id)
      if (nb?.source_id) srcIds.add(nb.source_id)
      if (nb?.source_type) srcTypes.add(nb.source_type)
      if (nb?.entity_type) nbEntityTypes.add(nb.entity_type)
    }
    for (const e of myIn) {
      const nb = neighbourSourceMap.get(e.source_node_id)
      if (nb?.source_id) srcIds.add(nb.source_id)
      if (nb?.source_type) srcTypes.add(nb.source_type)
      if (nb?.entity_type) nbEntityTypes.add(nb.entity_type)
    }

    // Unique relation types
    const relTypes = new Set(myAll.map(e => e.relation_type).filter(Boolean))

    // Days active
    const createdAt = nodeData?.created_at ? new Date(nodeData.created_at).getTime() : Date.now()
    const daysActive = Math.floor((Date.now() - createdAt) / 86400000)

    // Signal scores (same algorithm as PRD-18)
    const degreeScore = Math.min(totalEdges / 50, 1.0)
    const diversityFactor = Math.min(nbEntityTypes.size / 8, 1.0)
    const centralityScore = (degreeScore * 0.6) + (diversityFactor * 0.4)

    const sourceCountScore = Math.min(srcIds.size / 8, 1.0)
    const typeCountScore = Math.min(srcTypes.size / 3, 1.0)
    const diversityScore = (sourceCountScore * 0.65) + (typeCountScore * 0.35)

    const sustainedScore = Math.min(daysActive / 30, 1.0)
    const velocityScore = (sustainedScore * 0.45) + (0.183) // baseline for no temporal data

    const richnessScore = Math.min(relTypes.size / 6, 1.0)

    const compositeScore = Math.min(
      centralityScore * 0.35 + diversityScore * 0.25 + velocityScore * 0.20 + richnessScore * 0.15,
      1.0
    )

    liveStats.set(nid, {
      sourceCount: srcIds.size,
      uniqueSourceTypes: srcTypes.size,
      connectionCount: totalEdges,
      centralityScore: Math.round(centralityScore * 10000) / 10000,
      diversityScore: Math.round(diversityScore * 10000) / 10000,
      velocityScore: Math.round(velocityScore * 10000) / 10000,
      richnessScore: Math.round(richnessScore * 10000) / 10000,
      compositeScore: Math.round(compositeScore * 10000) / 10000,
    })
  }

  return candidateRows.map(row => {
    const mapped = mapRow(row as AnchorCandidateRow)
    const nid = row.node_id ?? ''
    const live = liveStats.get(nid)

    // Override stale DB values with live-computed values
    if (live) {
      mapped.sourceCount = live.sourceCount
      mapped.uniqueSourceTypes = live.uniqueSourceTypes
      // Only override signal scores if stored values are all zero (unscored)
      if (mapped.centralityScore === 0 && mapped.diversityScore === 0 && mapped.velocityScore === 0) {
        mapped.centralityScore = live.centralityScore
        mapped.diversityScore = live.diversityScore
        mapped.velocityScore = live.velocityScore
        mapped.richnessScore = live.richnessScore
        mapped.compositeScore = live.compositeScore
      }
    }

    return {
      ...mapped,
      node: nodeMap.get(nid) ?? null,
      connectionCount:   live?.connectionCount ?? connectionCounts[nid] ?? 0,
      anchorConnections: anchorConnectionCounts[nid] ?? 0,
    }
  })
}

// ─── Fetch: single candidate by node ID ──────────────────────────────────────
// Used by the scoring engine to check if a candidate already exists
// before deciding whether to insert or update.

export async function fetchCandidateByNodeId(
  userId: string,
  nodeId: string
): Promise<AnchorCandidate | null> {
  const { data, error } = await supabase
    .from('anchor_candidates')
    .select('*')
    .eq('user_id', userId)
    .eq('node_id', nodeId)
    .maybeSingle()

  if (error || !data) return null
  return mapRow(data as AnchorCandidateRow)
}

// ─── Fetch: single candidate with node data (for graph detail panels) ────────
// Lightweight fetch of one candidate by ID, with node and connection counts.

export async function fetchSingleCandidateWithNode(
  userId: string,
  candidateId: string
): Promise<AnchorCandidateWithNode | null> {
  const { data: row, error } = await supabase
    .from('anchor_candidates')
    .select('*')
    .eq('id', candidateId)
    .eq('user_id', userId)
    .maybeSingle()

  if (error || !row) return null

  const mapped = mapRow(row as AnchorCandidateRow)
  const nid = (row as AnchorCandidateRow).node_id

  // Fetch node data
  let node: AnchorCandidateWithNode['node'] = null
  if (nid) {
    const { data: nodeData } = await supabase
      .from('knowledge_nodes')
      .select('id, label, entity_type, description, quote, user_tags, confidence, is_anchor, parent_anchor_id, created_at')
      .eq('id', nid)
      .maybeSingle()

    if (nodeData) {
      node = nodeData as AnchorCandidateWithNode['node']
    }
  }

  // Fetch connection counts
  const [outRes, inRes] = await Promise.all([
    supabase.from('knowledge_edges').select('id', { count: 'exact', head: true }).eq('source_node_id', nid ?? ''),
    supabase.from('knowledge_edges').select('id', { count: 'exact', head: true }).eq('target_node_id', nid ?? ''),
  ])
  const connectionCount = (outRes.count ?? 0) + (inRes.count ?? 0)

  // Count anchor-to-anchor connections
  const { count: anchorConnCount } = await supabase
    .from('knowledge_edges')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .or(`source_node_id.eq.${nid},target_node_id.eq.${nid}`)

  return {
    ...mapped,
    node,
    connectionCount,
    anchorConnections: anchorConnCount ?? 0,
  }
}

// ─── Fetch: confirmed anchors (for Anchors page "Your Anchors" section) ───────
// Returns all confirmed and dormant candidates, ordered by composite_score desc.

export async function fetchConfirmedCandidates(
  userId: string
): Promise<AnchorCandidateWithNode[]> {
  return fetchCandidatesWithNodes(userId, ['confirmed', 'dormant'])
}

// ─── Fetch: suggested candidates (for Anchors page "Suggested" section) ───────

export async function fetchSuggestedCandidates(
  userId: string
): Promise<AnchorCandidateWithNode[]> {
  return fetchCandidatesWithNodes(userId, ['suggested'])
}

// ─── Fetch: pending candidate count ──────────────────────────────────────────
// Used by the nav rail badge to show how many suggestions await review.

export async function fetchSuggestedCount(userId: string): Promise<number> {
  const { count, error } = await supabase
    .from('anchor_candidates')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('status', 'suggested')

  if (error) return 0
  return count ?? 0
}

// ─── Upsert: insert or update a scored candidate ─────────────────────────────
// Called by the scoring engine (PRD-18) after computing signals.
// If a row exists for this node_id, updates scores and reasoning.
// If not, inserts a new pending candidate.
// Does NOT modify status if the existing status is 'confirmed', 'dismissed',
// 'archived', or 'dormant' — only updates scores on those rows.

export async function upsertAnchorCandidate(
  payload: AnchorCandidateUpsert
): Promise<{ id: string } | null> {
  const existing = await fetchCandidateByNodeId(payload.userId, payload.nodeId)

  const now = new Date().toISOString()

  if (existing) {
    // Always update scores and reasoning
    const updatePayload: Record<string, unknown> = {
      composite_score:    payload.compositeScore,
      centrality_score:   payload.centralityScore,
      diversity_score:    payload.diversityScore,
      velocity_score:     payload.velocityScore,
      richness_score:     payload.richnessScore,
      mention_count:      payload.mentionCount,
      source_count:       payload.sourceCount,
      unique_source_types: payload.uniqueSourceTypes,
      days_active:        payload.daysActive,
      recent_velocity:    payload.recentVelocity,
      velocity_direction: payload.velocityDirection,
      scoring_profile:    payload.scoringProfile,
      reasoning_text:     payload.reasoningText,
      last_scored_at:     now,
    }

    // Only advance status to 'suggested' if currently 'pending'
    if (existing.status === 'pending' && payload.compositeScore >= payload.thresholdAtScoring) {
      updatePayload.status = 'suggested'
      updatePayload.suggested_at = now
    }

    const { data, error } = await supabase
      .from('anchor_candidates')
      .update(updatePayload)
      .eq('id', existing.id)
      .select('id')
      .single()

    if (error) {
      console.error('[anchorCandidates] upsert update error:', error.message)
      return null
    }
    return data
  }

  // Insert new candidate
  const insertStatus: AnchorCandidateStatus =
    payload.compositeScore >= payload.thresholdAtScoring ? 'suggested' : 'pending'

  const { data, error } = await supabase
    .from('anchor_candidates')
    .insert({
      user_id:             payload.userId,
      node_id:             payload.nodeId,
      composite_score:     payload.compositeScore,
      centrality_score:    payload.centralityScore,
      diversity_score:     payload.diversityScore,
      velocity_score:      payload.velocityScore,
      richness_score:      payload.richnessScore,
      behavioural_score:   0,
      mention_count:       payload.mentionCount,
      source_count:        payload.sourceCount,
      unique_source_types: payload.uniqueSourceTypes,
      days_active:         payload.daysActive,
      recent_velocity:     payload.recentVelocity,
      velocity_direction:  payload.velocityDirection,
      status:              insertStatus,
      scoring_profile:     payload.scoringProfile,
      reasoning_text:      payload.reasoningText,
      threshold_at_scoring: payload.thresholdAtScoring,
      suggested_at:        insertStatus === 'suggested' ? now : null,
      first_scored_at:     now,
      last_scored_at:      now,
    })
    .select('id')
    .single()

  if (error) {
    console.error('[anchorCandidates] upsert insert error:', error.message)
    return null
  }
  return data
}

// ─── Update: status transition ────────────────────────────────────────────────
// Called by the Anchors page (PRD-19) when user confirms, dismisses, or archives.
// Also called by the daily scorer (PRD-18) for lifecycle transitions.

export async function updateCandidateStatus(
  candidateId: string,
  update: AnchorCandidateStatusUpdate
): Promise<boolean> {
  const payload: Record<string, unknown> = {
    status: update.status,
  }

  if (update.reviewedAt)     payload.reviewed_at    = update.reviewedAt
  if (update.dormantSince)   payload.dormant_since  = update.dormantSince
  if (update.resurface_after) payload.resurface_after = update.resurface_after
  if (update.dismissCount !== undefined) payload.dismiss_count = update.dismissCount

  const { error } = await supabase
    .from('anchor_candidates')
    .update(payload)
    .eq('id', candidateId)

  if (error) {
    console.error('[anchorCandidates] updateCandidateStatus error:', error.message)
    return false
  }
  return true
}

// ─── Confirm: promote node to anchor ─────────────────────────────────────────
// Atomically: sets candidate status to 'confirmed' AND sets
// knowledge_nodes.is_anchor = true for the associated node.
// Returns false if either operation fails (does not partially commit).

export async function confirmAnchorCandidate(
  candidateId: string,
  nodeId: string
): Promise<boolean> {
  const now = new Date().toISOString()

  // Step 1: Update knowledge_nodes
  const { error: nodeError } = await supabase
    .from('knowledge_nodes')
    .update({ is_anchor: true })
    .eq('id', nodeId)

  if (nodeError) {
    console.error('[anchorCandidates] confirmAnchorCandidate node update error:', nodeError.message)
    return false
  }

  // Step 2: Update candidate status
  const { error: candidateError } = await supabase
    .from('anchor_candidates')
    .update({
      status:      'confirmed',
      reviewed_at: now,
    })
    .eq('id', candidateId)

  if (candidateError) {
    console.error('[anchorCandidates] confirmAnchorCandidate status update error:', candidateError.message)
    // Attempt to roll back node update — best effort
    await supabase
      .from('knowledge_nodes')
      .update({ is_anchor: false })
      .eq('id', nodeId)
    return false
  }

  // Fire-and-forget: trigger retroactive edge scan for the new anchor
  const { data: { session } } = await supabase.auth.getSession()
  if (session?.access_token) {
    fetch('/api/anchors/on-confirm', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({ nodeId, userId: session.user.id }),
    }).catch(err => {
      console.warn('[confirmAnchorCandidate] on-confirm trigger failed (non-fatal):', err)
    })
  }

  return true
}

// ─── Dismiss: mark as dismissed with cooldown ─────────────────────────────────

export async function dismissAnchorCandidate(
  candidateId: string,
  currentDismissCount: number,
  cooldownDays: number
): Promise<boolean> {
  const now = new Date()
  const resurface = new Date(now)
  resurface.setDate(resurface.getDate() + cooldownDays)

  return updateCandidateStatus(candidateId, {
    status:          'dismissed',
    reviewedAt:      now.toISOString(),
    resurface_after: resurface.toISOString(),
    dismissCount:    currentDismissCount + 1,
  })
}

// ─── Archive: move confirmed anchor to archived ───────────────────────────────
// Also sets knowledge_nodes.is_anchor = false.

export async function archiveAnchorCandidate(
  candidateId: string,
  nodeId: string
): Promise<boolean> {
  const now = new Date().toISOString()

  const { error: nodeError } = await supabase
    .from('knowledge_nodes')
    .update({ is_anchor: false })
    .eq('id', nodeId)

  if (nodeError) {
    console.error('[anchorCandidates] archiveAnchorCandidate node update error:', nodeError.message)
    return false
  }

  const { error } = await supabase
    .from('anchor_candidates')
    .update({ status: 'archived', reviewed_at: now })
    .eq('id', candidateId)

  if (error) {
    console.error('[anchorCandidates] archiveAnchorCandidate error:', error.message)
    return false
  }
  return true
}

// ─── Create: manual anchor (user-created, no candidate row exists) ────────────
// For when users create an anchor from scratch via the Anchors page form.
// Creates both the candidate row (in 'confirmed' status) and sets is_anchor
// on the knowledge_nodes row.

export async function createManualAnchor(
  userId: string,
  nodeId: string
): Promise<boolean> {
  const now = new Date().toISOString()

  // Set is_anchor on the node
  const { error: nodeError } = await supabase
    .from('knowledge_nodes')
    .update({ is_anchor: true })
    .eq('id', nodeId)

  if (nodeError) {
    console.error('[anchorCandidates] createManualAnchor node error:', nodeError.message)
    return false
  }

  // Create candidate row in confirmed status
  // manual anchors get composite_score = 1.0 — they're explicitly user-chosen
  const { error } = await supabase
    .from('anchor_candidates')
    .insert({
      user_id:           userId,
      node_id:           nodeId,
      composite_score:   1.0,
      centrality_score:  0,
      diversity_score:   0,
      velocity_score:    0,
      richness_score:    0,
      behavioural_score: 0,
      mention_count:     0,
      source_count:      0,
      unique_source_types: 0,
      days_active:       0,
      recent_velocity:   0,
      velocity_direction: 'stable',
      status:            'confirmed',
      scoring_profile:   'balanced',
      reasoning_text:    'Manually created by user.',
      suggested_at:      now,
      reviewed_at:       now,
      first_scored_at:   now,
      last_scored_at:    now,
    })

  if (error) {
    console.error('[anchorCandidates] createManualAnchor insert error:', error.message)
    return false
  }
  return true
}

// ─── Fetch: anchor health summary ─────────────────────────────────────────────
// Computed summary for the Anchors page right panel default state (PRD-19).

export async function fetchAnchorHealthSummary(
  userId: string
): Promise<AnchorHealthSummary> {
  const empty: AnchorHealthSummary = {
    totalConfirmed: 0,
    totalSuggested: 0,
    totalDormant: 0,
    avgNodesPerAnchor: 0,
    mostConnectedAnchor: null,
    isolatedAnchors: 0,
    staleAnchors: [],
  }

  // Fetch all confirmed + dormant candidates with node data
  const confirmed = await fetchCandidatesWithNodes(userId, ['confirmed', 'dormant'])
  const suggested = await fetchCandidatesWithNodes(userId, ['suggested'])

  if (confirmed.length === 0 && suggested.length === 0) return empty

  const dormant = confirmed.filter(c => c.status === 'dormant')
  const active  = confirmed.filter(c => c.status === 'confirmed')

  // Compute average nodes per confirmed anchor
  const totalNodes = confirmed.reduce((sum, c) => sum + c.connectionCount, 0)
  const avgNodes = confirmed.length > 0
    ? Math.round((totalNodes / confirmed.length) * 10) / 10
    : 0

  // Most connected anchor
  const sorted = [...confirmed].sort((a, b) => b.connectionCount - a.connectionCount)
  const topAnchor = sorted[0]
  const mostConnected = topAnchor?.node
    ? { label: topAnchor.node.label, nodeCount: topAnchor.connectionCount }
    : null

  // Isolated anchors: confirmed with 0 cross-anchor connections
  const isolated = confirmed.filter(c => c.anchorConnections === 0).length

  // Stale anchors: collect items needing attention
  const stale: AnchorHealthSummary['staleAnchors'] = []

  for (const c of confirmed) {
    if (!c.node) continue
    if (c.anchorConnections === 0 && c.connectionCount > 0) {
      stale.push({
        candidateId: c.id,
        nodeId: c.node.id,
        label: c.node.label,
        issue: 'isolated',
        detail: 'Not connected to any other anchors',
      })
    } else if (c.connectionCount < 3) {
      stale.push({
        candidateId: c.id,
        nodeId: c.node.id,
        label: c.node.label,
        issue: 'low_nodes',
        detail: `Only ${c.connectionCount} node${c.connectionCount === 1 ? '' : 's'} connected`,
      })
    } else if (c.status === 'dormant') {
      const dormantDays = c.dormantSince
        ? Math.floor((Date.now() - new Date(c.dormantSince).getTime()) / 86400000)
        : 0
      stale.push({
        candidateId: c.id,
        nodeId: c.node.id,
        label: c.node.label,
        issue: 'dormant',
        detail: `No new content in ${dormantDays} days`,
      })
    } else if (c.sourceCount === 1) {
      stale.push({
        candidateId: c.id,
        nodeId: c.node.id,
        label: c.node.label,
        issue: 'single_source',
        detail: 'Only referenced in one source',
      })
    }
  }

  return {
    totalConfirmed: active.length,
    totalSuggested: suggested.length,
    totalDormant:   dormant.length,
    avgNodesPerAnchor: avgNodes,
    mostConnectedAnchor: mostConnected,
    isolatedAnchors: isolated,
    staleAnchors: stale.slice(0, 8), // Cap at 8 items for the UI
  }
}

// ─── Helpers: connection count queries ────────────────────────────────────────
// Fetches edge counts for a batch of node IDs in two queries.

async function fetchConnectionCounts(
  nodeIds: string[]
): Promise<Record<string, number>> {
  if (nodeIds.length === 0) return {}

  const [outgoing, incoming] = await Promise.all([
    supabase
      .from('knowledge_edges')
      .select('source_node_id')
      .in('source_node_id', nodeIds),
    supabase
      .from('knowledge_edges')
      .select('target_node_id')
      .in('target_node_id', nodeIds),
  ])

  const counts: Record<string, number> = {}
  for (const id of nodeIds) counts[id] = 0

  for (const row of outgoing.data ?? []) {
    counts[row.source_node_id] = (counts[row.source_node_id] ?? 0) + 1
  }
  for (const row of incoming.data ?? []) {
    counts[row.target_node_id] = (counts[row.target_node_id] ?? 0) + 1
  }

  return counts
}

// ─── PRD-22: Promote to sub-anchor ──────────────────────────────────────────
// Called when user confirms a candidate as a sub-anchor of a specific parent.

export async function promoteToSubAnchor(
  candidateId:    string,
  nodeId:         string,
  parentAnchorId: string
): Promise<boolean> {
  const now = new Date().toISOString()

  // Verify parent is actually an anchor
  const { data: parentCheck } = await supabase
    .from('knowledge_nodes')
    .select('id, is_anchor, parent_anchor_id')
    .eq('id', parentAnchorId)
    .maybeSingle()

  if (!parentCheck?.is_anchor) {
    console.error('[anchorCandidates] promoteToSubAnchor: parent is not an anchor')
    return false
  }

  // Parent cannot itself be a sub-anchor (one level deep only)
  if (parentCheck.parent_anchor_id) {
    console.error('[anchorCandidates] promoteToSubAnchor: parent is already a sub-anchor')
    return false
  }

  // Set is_anchor = true AND parent_anchor_id on the node
  const { error: nodeError } = await supabase
    .from('knowledge_nodes')
    .update({ is_anchor: true, parent_anchor_id: parentAnchorId })
    .eq('id', nodeId)

  if (nodeError) {
    console.error('[anchorCandidates] promoteToSubAnchor node error:', nodeError.message)
    return false
  }

  // Update candidate to confirmed status
  const { error: candidateError } = await supabase
    .from('anchor_candidates')
    .update({ status: 'confirmed', reviewed_at: now })
    .eq('id', candidateId)

  if (candidateError) {
    // Rollback
    await supabase.from('knowledge_nodes').update({ is_anchor: false, parent_anchor_id: null }).eq('id', nodeId)
    return false
  }

  // PRD-23: Propagate inheritance (fire-and-forget)
  propagateInheritanceToParent(nodeId, parentAnchorId).catch(err => {
    console.warn('[anchorCandidates] Inheritance propagation failed (non-fatal):', err)
  })

  return true
}

// ─── PRD-23: Propagate sub-anchor entities to parent anchor ─────────────────
// Creates inherited_from edges between parent anchor and sub-anchor's entities.

export async function propagateInheritanceToParent(
  subAnchorId:    string,
  parentAnchorId: string
): Promise<{ edgesCreated: number }> {
  const { data: subAnchorNode } = await supabase
    .from('knowledge_nodes')
    .select('user_id')
    .eq('id', subAnchorId)
    .maybeSingle()

  if (!subAnchorNode) return { edgesCreated: 0 }
  const userId = subAnchorNode.user_id as string

  // Fetch entities directly connected to sub-anchor (non-inherited edges only)
  const { data: subEdges } = await supabase
    .from('knowledge_edges')
    .select('source_node_id, target_node_id')
    .eq('user_id', userId)
    .eq('is_inherited', false)
    .or(`source_node_id.eq.${subAnchorId},target_node_id.eq.${subAnchorId}`)

  const entityIds = new Set<string>()
  for (const edge of subEdges ?? []) {
    const src = edge.source_node_id as string
    const tgt = edge.target_node_id as string
    const entityId = src === subAnchorId ? tgt : src
    if (entityId !== parentAnchorId) entityIds.add(entityId)
  }

  if (entityIds.size === 0) return { edgesCreated: 0 }

  // Find which entities are already connected to parent
  const { data: existingParentEdges } = await supabase
    .from('knowledge_edges')
    .select('source_node_id, target_node_id')
    .eq('user_id', userId)
    .or(`source_node_id.eq.${parentAnchorId},target_node_id.eq.${parentAnchorId}`)

  const alreadyConnected = new Set<string>()
  for (const edge of existingParentEdges ?? []) {
    const src = edge.source_node_id as string
    const tgt = edge.target_node_id as string
    alreadyConnected.add(src === parentAnchorId ? tgt : src)
  }

  // Create inherited edges for entities not already connected
  const toInsert = Array.from(entityIds)
    .filter(id => !alreadyConnected.has(id))
    .map(entityId => ({
      user_id:                  userId,
      source_node_id:           parentAnchorId,
      target_node_id:           entityId,
      relation_type:            'inherited_from',
      evidence:                 `Inherited from sub-anchor: ${subAnchorId}`,
      weight:                   0.5,
      is_inherited:             true,
      inherited_from_anchor_id: subAnchorId,
    }))

  if (toInsert.length === 0) return { edgesCreated: 0 }

  const { error } = await supabase.from('knowledge_edges').insert(toInsert)

  if (error) {
    console.error('[anchorCandidates] propagateInheritanceToParent error:', error.message)
    throw error
  }

  console.log(`[anchorCandidates] Created ${toInsert.length} inherited edges: ${subAnchorId} → ${parentAnchorId}`)
  return { edgesCreated: toInsert.length }
}

// ─── PRD-22: Remove sub-anchor relationship ─────────────────────────────────
// Called from AnchorDetailPanel when user demotes a sub-anchor back to root.

export async function removeSubAnchorRelationship(
  nodeId: string
): Promise<boolean> {
  // 1. Find current parent before clearing
  const { data: nodeData } = await supabase
    .from('knowledge_nodes')
    .select('parent_anchor_id')
    .eq('id', nodeId)
    .maybeSingle()

  // 2. Clear the parent relationship
  const { error } = await supabase
    .from('knowledge_nodes')
    .update({ parent_anchor_id: null })
    .eq('id', nodeId)

  if (error) {
    console.error('[anchorCandidates] removeSubAnchorRelationship error:', error.message)
    return false
  }

  // 3. PRD-23: Remove inherited edges that came from this sub-anchor
  if (nodeData?.parent_anchor_id) {
    const { error: cleanupError } = await supabase
      .from('knowledge_edges')
      .delete()
      .eq('inherited_from_anchor_id', nodeId)
      .eq('is_inherited', true)

    if (cleanupError) {
      console.warn('[anchorCandidates] Failed to clean up inherited edges:', cleanupError.message)
    }
  }

  return true
}

// ─── PRD-22: Fetch anchor hierarchy info ────────────────────────────────────
// Used by AnchorDetailPanel to show parent and sibling sub-anchors.

export async function fetchAnchorHierarchyInfo(
  userId: string,
  nodeId: string
): Promise<{ parentAnchorId: string | null; parentLabel: string | null; parentEntityType: string | null; subAnchors: Array<{ id: string; label: string; entityType: string; entityCount: number }> }> {
  // Get this node's parent_anchor_id
  const { data: thisNode } = await supabase
    .from('knowledge_nodes')
    .select('id, parent_anchor_id')
    .eq('id', nodeId)
    .eq('user_id', userId)
    .maybeSingle()

  const parentAnchorId = (thisNode?.parent_anchor_id as string | null) ?? null

  // Get parent details if it exists
  let parentLabel: string | null = null
  let parentEntityType: string | null = null
  if (parentAnchorId) {
    const { data: parent } = await supabase
      .from('knowledge_nodes')
      .select('label, entity_type')
      .eq('id', parentAnchorId)
      .maybeSingle()
    parentLabel      = parent?.label as string ?? null
    parentEntityType = parent?.entity_type as string ?? null
  }

  // Get sub-anchors (nodes that have this node as parent)
  const { data: subAnchors } = await supabase
    .from('knowledge_nodes')
    .select('id, label, entity_type')
    .eq('user_id', userId)
    .eq('parent_anchor_id', nodeId)
    .eq('is_anchor', true)

  const subAnchorList = await Promise.all(
    (subAnchors ?? []).map(async sa => {
      const { count } = await supabase
        .from('knowledge_edges')
        .select('id', { count: 'exact', head: true })
        .or(`source_node_id.eq.${sa.id},target_node_id.eq.${sa.id}`)
      return {
        id:          sa.id as string,
        label:       sa.label as string,
        entityType:  sa.entity_type as string,
        entityCount: count ?? 0,
      }
    })
  )

  return { parentAnchorId, parentLabel, parentEntityType, subAnchors: subAnchorList }
}

async function fetchAnchorConnectionCounts(
  userId: string,
  nodeIds: string[]
): Promise<Record<string, number>> {
  if (nodeIds.length === 0) return {}

  // Get all anchor node IDs for this user
  const { data: anchorNodes } = await supabase
    .from('knowledge_nodes')
    .select('id')
    .eq('user_id', userId)
    .eq('is_anchor', true)

  const anchorIds = new Set((anchorNodes ?? []).map(n => n.id))

  const [outgoing, incoming] = await Promise.all([
    supabase
      .from('knowledge_edges')
      .select('source_node_id, target_node_id')
      .in('source_node_id', nodeIds),
    supabase
      .from('knowledge_edges')
      .select('source_node_id, target_node_id')
      .in('target_node_id', nodeIds),
  ])

  const counts: Record<string, number> = {}
  for (const id of nodeIds) counts[id] = 0

  for (const row of outgoing.data ?? []) {
    if (anchorIds.has(row.target_node_id)) {
      counts[row.source_node_id] = (counts[row.source_node_id] ?? 0) + 1
    }
  }
  for (const row of incoming.data ?? []) {
    if (anchorIds.has(row.source_node_id)) {
      counts[row.target_node_id] = (counts[row.target_node_id] ?? 0) + 1
    }
  }

  return counts
}
