import { supabase } from './supabase'
import type { ClusterCandidate } from '../types/graph'

// ─── Scoring weights ─────────────────────────────────────────────────────────

const WEIGHTS = {
  sourceDiversity: 0.25,
  sourceTypeDiversity: 0.15,
  growthRate: 0.20,
  entityTypeSubstance: 0.15,
  relationshipDensity: 0.15,
  recency: 0.10,
}

const CONFIDENCE_THRESHOLD = 0.35
const MIN_SOURCE_DIVERSITY = 2

// Entity types that score higher for substance
const HIGH_SUBSTANCE_TYPES = new Set([
  'Topic', 'Project', 'Concept', 'Technology', 'Product', 'Goal', 'Hypothesis',
])

// ─── Detection pipeline ──────────────────────────────────────────────────────

export async function detectAutoAnchors(
  userId: string,
  _newEntityIds?: string[]
): Promise<ClusterCandidate[]> {
  // Step 1: Get all non-anchor entities with source info
  const { data: entities, error: entErr } = await supabase
    .from('knowledge_nodes')
    .select('id, label, entity_type, source_id, created_at, embedding')
    .eq('user_id', userId)
    .eq('is_anchor', false)
    .not('source_id', 'is', null)

  if (entErr) throw new Error(entErr.message)
  if (!entities || entities.length < 10) return [] // too few to cluster

  // Step 2: Get all edges between these entities
  const entityIds = entities.map(e => e.id)
  const { data: edges, error: edgeErr } = await supabase
    .from('knowledge_edges')
    .select('source_node_id, target_node_id')
    .in('source_node_id', entityIds)
    .in('target_node_id', entityIds)

  if (edgeErr) throw new Error(edgeErr.message)

  // Step 3: Get source metadata for diversity scoring
  const sourceIds = [...new Set(entities.map(e => e.source_id).filter(Boolean))] as string[]
  const { data: sources } = await supabase
    .from('knowledge_sources')
    .select('id, source_type, created_at')
    .in('id', sourceIds)

  const sourceTypeMap = new Map((sources ?? []).map(s => [s.id, s.source_type ?? 'Document']))
  const sourceCreatedMap = new Map((sources ?? []).map(s => [s.id, s.created_at]))

  // Step 4: Get existing anchors to exclude already-anchored clusters
  const { data: existingAnchors } = await supabase
    .from('knowledge_nodes')
    .select('id, label')
    .eq('user_id', userId)
    .eq('is_anchor', true)

  const anchorLabels = new Set((existingAnchors ?? []).map(a => a.label.toLowerCase()))

  // Step 5: Build entity co-occurrence clusters
  // Group entities by label (dedup across sources)
  const labelToEntities: Record<string, typeof entities> = {}
  for (const entity of entities) {
    const key = entity.label.toLowerCase().trim()
    if (!labelToEntities[key]) labelToEntities[key] = []
    labelToEntities[key].push(entity)
  }

  // Find cross-source entity labels (appear in 3+ distinct sources)
  const crossSourceLabels: Array<{ label: string; entities: typeof entities }> = []
  for (const [label, ents] of Object.entries(labelToEntities)) {
    const distinctSources = new Set(ents.map(e => e.source_id))
    if (distinctSources.size >= MIN_SOURCE_DIVERSITY && !anchorLabels.has(label)) {
      crossSourceLabels.push({ label, entities: ents })
    }
  }

  // Step 6: Expand each cross-source entity into a cluster
  // using relationship edges to find co-occurring neighbors
  const edgeMap = new Map<string, Set<string>>()
  for (const edge of edges ?? []) {
    if (!edgeMap.has(edge.source_node_id)) edgeMap.set(edge.source_node_id, new Set())
    edgeMap.get(edge.source_node_id)!.add(edge.target_node_id)
    if (!edgeMap.has(edge.target_node_id)) edgeMap.set(edge.target_node_id, new Set())
    edgeMap.get(edge.target_node_id)!.add(edge.source_node_id)
  }

  const entityById = new Map(entities.map(e => [e.id, e]))

  const candidates: ClusterCandidate[] = []
  const now = Date.now()
  const FOURTEEN_DAYS = 14 * 24 * 60 * 60 * 1000

  for (const { label, entities: seedEntities } of crossSourceLabels) {
    // Expand: include all directly connected entities
    const clusterIds = new Set(seedEntities.map(e => e.id))
    for (const seedEntity of seedEntities) {
      const neighbors = edgeMap.get(seedEntity.id)
      if (neighbors) {
        for (const nid of neighbors) {
          clusterIds.add(nid)
        }
      }
    }

    // Gather cluster data
    const clusterEntities = [...clusterIds].map(id => entityById.get(id)).filter(Boolean) as typeof entities
    const clusterSourceIds = [...new Set(clusterEntities.map(e => e.source_id).filter(Boolean))] as string[]
    const clusterSourceTypes = new Set(clusterSourceIds.map(sid => sourceTypeMap.get(sid) ?? 'Document'))

    // Score: source diversity (0-1)
    const sourceDiversityScore = Math.min(1, clusterSourceIds.length / 4)

    // Score: source type diversity (0-1)
    const sourceTypeDiversityScore = Math.min(1, clusterSourceTypes.size / 3)

    // Score: growth rate (entities added in last 14 days)
    const recentEntities = clusterEntities.filter(e =>
      now - new Date(e.created_at).getTime() < FOURTEEN_DAYS
    )
    const growthScore = Math.min(1, recentEntities.length / 3)

    // Score: entity type substance
    const typeDistribution: Record<string, number> = {}
    for (const e of clusterEntities) {
      typeDistribution[e.entity_type] = (typeDistribution[e.entity_type] ?? 0) + 1
    }
    const substantiveCount = clusterEntities.filter(e => HIGH_SUBSTANCE_TYPES.has(e.entity_type)).length
    const substanceScore = Math.min(1, substantiveCount / Math.max(1, clusterEntities.length * 0.5))

    // Score: relationship density
    let internalEdges = 0
    for (const edge of edges ?? []) {
      if (clusterIds.has(edge.source_node_id) && clusterIds.has(edge.target_node_id)) {
        internalEdges++
      }
    }
    const maxPossibleEdges = clusterEntities.length * (clusterEntities.length - 1) / 2
    const densityScore = maxPossibleEdges > 0 ? Math.min(1, internalEdges / (maxPossibleEdges * 0.15)) : 0

    // Score: recency
    const latestSourceDate = clusterSourceIds.reduce((latest, sid) => {
      const created = sourceCreatedMap.get(sid) ?? ''
      return created > latest ? created : latest
    }, '')
    const recencyMs = latestSourceDate ? now - new Date(latestSourceDate).getTime() : Infinity
    const recencyScore = recencyMs < FOURTEEN_DAYS ? 1 : recencyMs < 30 * 24 * 60 * 60 * 1000 ? 0.5 : 0.1

    // Composite confidence
    const confidence =
      sourceDiversityScore * WEIGHTS.sourceDiversity +
      sourceTypeDiversityScore * WEIGHTS.sourceTypeDiversity +
      growthScore * WEIGHTS.growthRate +
      substanceScore * WEIGHTS.entityTypeSubstance +
      densityScore * WEIGHTS.relationshipDensity +
      recencyScore * WEIGHTS.recency

    if (confidence >= CONFIDENCE_THRESHOLD) {
      candidates.push({
        centroidLabel: label.charAt(0).toUpperCase() + label.slice(1),
        entityIds: [...clusterIds],
        sourceIds: clusterSourceIds,
        sourceDiversity: clusterSourceIds.length,
        sourceTypeDiversity: clusterSourceTypes.size,
        avgSimilarity: 0, // Would require embedding comparison
        growthRate: recentEntities.length,
        entityTypeDistribution: typeDistribution,
        confidence,
      })
    }
  }

  // Sort by confidence descending
  candidates.sort((a, b) => b.confidence - a.confidence)

  return candidates
}

// ─── Promote candidate to auto-anchor ────────────────────────────────────────

export async function createAutoAnchor(
  userId: string,
  candidate: ClusterCandidate
): Promise<string | null> {
  // Check if an anchor with this label already exists
  const { data: existing } = await supabase
    .from('knowledge_nodes')
    .select('id')
    .eq('user_id', userId)
    .eq('label', candidate.centroidLabel)
    .eq('is_anchor', true)
    .maybeSingle()

  if (existing) return existing.id

  // Create the anchor node
  const { data: newNode, error } = await supabase
    .from('knowledge_nodes')
    .insert({
      user_id: userId,
      label: candidate.centroidLabel,
      entity_type: getMajorityType(candidate.entityTypeDistribution),
      description: `Auto-detected cluster across ${candidate.sourceDiversity} sources`,
      is_anchor: true,
      confidence: candidate.confidence,
    })
    .select('id')
    .single()

  if (error) {
    console.error('Failed to create auto-anchor:', error)
    return null
  }

  // Create edges from the new anchor to cluster member entities
  const edgeInserts = candidate.entityIds.slice(0, 50).map(entityId => ({
    user_id: userId,
    source_node_id: newNode.id,
    target_node_id: entityId,
    relation_type: 'connected_to',
    weight: candidate.confidence,
  }))

  if (edgeInserts.length > 0) {
    await supabase.from('knowledge_edges').insert(edgeInserts)
  }

  return newNode.id
}

function getMajorityType(distribution: Record<string, number>): string {
  let maxType = 'Topic'
  let maxCount = 0
  for (const [type, count] of Object.entries(distribution)) {
    if (count > maxCount) {
      maxCount = count
      maxType = type
    }
  }
  return maxType
}
