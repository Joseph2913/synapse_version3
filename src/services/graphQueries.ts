import { supabase } from './supabase'
import { getEntityColor } from '../config/entityTypes'
import { getSourceConfig } from '../config/sourceTypes'
import type {
  AnchorLevelData,
  AnchorGraphNode,
  AnchorEdge,
  AllSourcesLevelData,
  SourceLevelData,
  SourceGraphNode,
  SourceEdge,
  GhostAnchorNode,
  GravityAnchor,
  AnchorLink,
  EntityLevelData,
  EntityGraphNode,
  IntraSourceEdge,
  CrossSourceEdge,
  GhostSourceNode,
  TypeDistSegment,
} from '../types/graph'

// ─── Level 1: Anchor Landscape ───────────────────────────────────────────────

export async function fetchAnchorLevelData(userId: string): Promise<AnchorLevelData> {
  // Server-side computation via Postgres RPC.
  // See: supabase/migrations/20260331_get_anchor_graph.sql
  // To modify anchor graph logic, update the Postgres function — NOT this file.
  const { data, error } = await supabase.rpc('get_anchor_graph', { p_user_id: userId })
  if (error) throw new Error(error.message)

  const result = data as {
    anchors: Array<{
      id: string; kind: string; label: string; entityType: string
      entityCount: number; sourceCount: number; connectionCount: number
      description: string | null; confidence: number | null
      anchorStatus: string; lastActivity: string | null; isQuiet: boolean
    }>
    edges: AnchorEdge[]
    stats: { anchorCount: number; sourceCount: number; entityCount: number }
  } | null

  if (!result) return { anchors: [], edges: [], stats: { anchorCount: 0, sourceCount: 0, entityCount: 0 } }

  // Add client-side color (UI concern — not in database)
  const anchors: AnchorGraphNode[] = (result.anchors ?? []).map(a => ({
    ...a,
    kind: 'anchor' as const,
    color: getEntityColor(a.entityType),
    anchorStatus: (a.anchorStatus ?? 'manual') as AnchorGraphNode['anchorStatus'],
  }))

  return {
    anchors,
    edges: result.edges ?? [],
    stats: result.stats ?? { anchorCount: 0, sourceCount: 0, entityCount: 0 },
  }
}

// ─── All Sources (full DB view) ──────────────────────────────────────────────

export async function fetchAllSourcesLevelData(userId: string): Promise<AllSourcesLevelData> {
  // Server-side computation via Postgres RPC.
  // See: supabase/migrations/20260331_get_all_sources_graph.sql
  // To modify sources graph logic, update the Postgres function — NOT this file.
  const { data, error } = await supabase.rpc('get_all_sources_graph', { p_user_id: userId })
  if (error) throw new Error(error.message)

  const result = data as {
    sources: Array<{
      id: string; kind: string; label: string; sourceType: string
      entityCount: number; anchorRelevance: number
      typeDistribution: TypeDistSegment[]; bridgeAnchorIds: string[]
      anchorLinks?: AnchorLink[]
      createdAt: string; metadata: Record<string, unknown>
    }>
    edges: SourceEdge[]
    gravityAnchors?: Array<{ id: string; label: string; entityType: string; connectionCount: number }>
    stats: { sourceCount: number; entityCount: number; connectionCount: number }
  } | null

  if (!result) return { sources: [], edges: [], gravityAnchors: [], stats: { sourceCount: 0, entityCount: 0, connectionCount: 0 } }

  // Debug: check what the RPC returned
  console.log('[AllSourcesGraph] RPC returned gravityAnchors:', result.gravityAnchors?.length ?? 'MISSING', result.gravityAnchors)
  console.log('[AllSourcesGraph] First source anchorLinks:', result.sources?.[0]?.anchorLinks)

  // Add client-side color/icon (UI concern — not in database)
  const sources: SourceGraphNode[] = (result.sources ?? []).map(s => {
    const cfg = getSourceConfig(s.sourceType)
    return {
      ...s,
      kind: 'source' as const,
      color: cfg.color,
      icon: cfg.icon,
      typeDistribution: s.typeDistribution ?? [],
      bridgeAnchorIds: s.bridgeAnchorIds ?? [],
      anchorLinks: s.anchorLinks ?? [],
      metadata: s.metadata ?? {},
    }
  })

  // Add entity type colors to gravity anchors
  const gravityAnchors: GravityAnchor[] = (result.gravityAnchors ?? []).map(a => ({
    ...a,
    color: getEntityColor(a.entityType),
  }))

  return {
    sources,
    edges: result.edges ?? [],
    gravityAnchors,
    stats: result.stats ?? { sourceCount: 0, entityCount: 0, connectionCount: 0 },
  }
}

// ─── Level 2: Sources Within an Anchor ───────────────────────────────────────

export async function fetchSourceLevelData(
  userId: string,
  anchorId: string
): Promise<SourceLevelData> {
  // Fetch the anchor node itself
  const { data: anchorRaw, error: ancErr } = await supabase
    .from('knowledge_nodes')
    .select('id, label, entity_type, description')
    .eq('id', anchorId)
    .single()

  if (ancErr) throw new Error(ancErr.message)

  // Fetch edges connected to this anchor
  const { data: anchorEdges, error: aeErr } = await supabase
    .from('knowledge_edges')
    .select('source_node_id, target_node_id')
    .or(`source_node_id.eq.${anchorId},target_node_id.eq.${anchorId}`)

  if (aeErr) throw new Error(aeErr.message)

  // Get all connected non-anchor entity IDs
  const connectedNodeIds = new Set<string>()
  for (const edge of anchorEdges ?? []) {
    if (edge.source_node_id !== anchorId) connectedNodeIds.add(edge.source_node_id)
    if (edge.target_node_id !== anchorId) connectedNodeIds.add(edge.target_node_id)
  }

  if (connectedNodeIds.size === 0) {
    const color = getEntityColor(anchorRaw.entity_type)
    return {
      sources: [],
      edges: [],
      ghostAnchors: [],
      ghostEdges: [],
      parentAnchor: { id: anchorRaw.id, label: anchorRaw.label, entityType: anchorRaw.entity_type, color },
      stats: { sourceCount: 0, entityCount: 0, bridgeCount: 0 },
    }
  }

  // Fetch those nodes to get source_id + entity_type
  const { data: connectedNodes, error: cnErr } = await supabase
    .from('knowledge_nodes')
    .select('id, source_id, entity_type, is_anchor')
    .in('id', [...connectedNodeIds])
    .eq('user_id', userId)

  if (cnErr) throw new Error(cnErr.message)

  // Map entity → source
  const entityToSource: Record<string, string> = {}
  const entityTypes: Record<string, string> = {}
  const sourceEntityIds: Record<string, string[]> = {} // sourceId → entityIds in this anchor
  const relevantEntityIds = new Set<string>()

  for (const node of connectedNodes ?? []) {
    if (node.source_id && !node.is_anchor) {
      entityToSource[node.id] = node.source_id
      entityTypes[node.id] = node.entity_type
      if (!sourceEntityIds[node.source_id]) sourceEntityIds[node.source_id] = []
      sourceEntityIds[node.source_id]!.push(node.id)
      relevantEntityIds.add(node.id)
    }
  }

  const sourceIds = Object.keys(sourceEntityIds)
  if (sourceIds.length === 0) {
    const color = getEntityColor(anchorRaw.entity_type)
    return {
      sources: [],
      edges: [],
      ghostAnchors: [],
      ghostEdges: [],
      parentAnchor: { id: anchorRaw.id, label: anchorRaw.label, entityType: anchorRaw.entity_type, color },
      stats: { sourceCount: 0, entityCount: connectedNodeIds.size, bridgeCount: 0 },
    }
  }

  // Fetch source metadata
  const { data: sourcesRaw, error: srcErr } = await supabase
    .from('knowledge_sources')
    .select('id, title, source_type, metadata, created_at')
    .in('id', sourceIds)

  if (srcErr) throw new Error(srcErr.message)

  // Fetch ALL entities per source (not just anchor-connected) for entity counts + type distribution
  const { data: allSourceEntities, error: aseErr } = await supabase
    .from('knowledge_nodes')
    .select('id, label, source_id, entity_type')
    .in('source_id', sourceIds)
    .eq('user_id', userId)
    .eq('is_anchor', false)

  if (aseErr) throw new Error(aseErr.message)

  const totalEntitiesBySource: Record<string, number> = {}
  const typesBySource: Record<string, Record<string, number>> = {}
  for (const entity of allSourceEntities ?? []) {
    if (entity.source_id) {
      totalEntitiesBySource[entity.source_id] = (totalEntitiesBySource[entity.source_id] ?? 0) + 1
      if (!typesBySource[entity.source_id]) typesBySource[entity.source_id] = {}
      const typeBucket = typesBySource[entity.source_id]!
      typeBucket[entity.entity_type] = (typeBucket[entity.entity_type] ?? 0) + 1
    }
  }

  // Find other anchors these sources contribute to (for bridge indicators)
  const { data: allAnchors, error: allAncErr } = await supabase
    .from('knowledge_nodes')
    .select('id, label, entity_type')
    .eq('user_id', userId)
    .eq('is_anchor', true)

  if (allAncErr) throw new Error(allAncErr.message)

  const otherAnchorIds = (allAnchors ?? []).filter(a => a.id !== anchorId).map(a => a.id)
  const sourceBridgeAnchors: Record<string, string[]> = {} // sourceId → other anchor IDs
  const ghostAnchorMap = new Map<string, { id: string; label: string; entityType: string; sourceIds: string[] }>()

  if (otherAnchorIds.length > 0) {
    // For each source's entities, check if they connect to other anchors
    const entityIds = (allSourceEntities ?? []).map(e => e.id)
    if (entityIds.length > 0) {
      // Fetch edges from these entities to other anchors
      const orFilter = otherAnchorIds
        .map(id => `source_node_id.eq.${id},target_node_id.eq.${id}`)
        .join(',')
      const { data: bridgeEdges } = await supabase
        .from('knowledge_edges')
        .select('source_node_id, target_node_id')
        .or(orFilter)

      const entitySourceMap = new Map((allSourceEntities ?? []).map(e => [e.id, e.source_id]))
      const otherAnchorSet = new Set(otherAnchorIds)

      for (const edge of bridgeEdges ?? []) {
        let entityId: string | null = null
        let otherAncId: string | null = null
        if (otherAnchorSet.has(edge.source_node_id) && entitySourceMap.has(edge.target_node_id)) {
          entityId = edge.target_node_id
          otherAncId = edge.source_node_id
        } else if (otherAnchorSet.has(edge.target_node_id) && entitySourceMap.has(edge.source_node_id)) {
          entityId = edge.source_node_id
          otherAncId = edge.target_node_id
        }
        if (entityId && otherAncId) {
          const sid = entitySourceMap.get(entityId)
          if (sid) {
            if (!sourceBridgeAnchors[sid]) sourceBridgeAnchors[sid] = []
            if (!sourceBridgeAnchors[sid].includes(otherAncId)) {
              sourceBridgeAnchors[sid].push(otherAncId)
            }
            // Track ghost anchor data
            if (!ghostAnchorMap.has(otherAncId)) {
              const ancData = (allAnchors ?? []).find(a => a.id === otherAncId)
              if (ancData) {
                ghostAnchorMap.set(otherAncId, {
                  id: ancData.id,
                  label: ancData.label,
                  entityType: ancData.entity_type,
                  sourceIds: [sid],
                })
              }
            } else {
              const existing = ghostAnchorMap.get(otherAncId)!
              if (!existing.sourceIds.includes(sid)) existing.sourceIds.push(sid)
            }
          }
        }
      }
    }
  }

  // Build source nodes
  const sources: SourceGraphNode[] = (sourcesRaw ?? []).map(s => {
    const cfg = getSourceConfig(s.source_type)
    const totalEntities = totalEntitiesBySource[s.id] ?? 1
    const anchorEntities = sourceEntityIds[s.id]?.length ?? 0
    const relevance = Math.max(0.1, anchorEntities / totalEntities)

    const types = typesBySource[s.id] ?? {}
    const typeDistribution: TypeDistSegment[] = Object.entries(types)
      .map(([entityType, count]) => ({ entityType, count, fraction: count / totalEntities }))
      .sort((a, b) => b.count - a.count)

    return {
      id: s.id,
      kind: 'source' as const,
      label: s.title ?? 'Untitled',
      sourceType: s.source_type ?? 'Document',
      color: cfg.color,
      icon: cfg.icon,
      entityCount: totalEntities,
      anchorRelevance: relevance,
      typeDistribution,
      bridgeAnchorIds: sourceBridgeAnchors[s.id] ?? [],
      createdAt: s.created_at,
      metadata: s.metadata ?? {},
    }
  })

  // Compute source-to-source edges (shared entities between sources in this anchor context)
  const sourceEdges: SourceEdge[] = []
  const sourceList = sources.map(s => s.id)
  const sourceSet = new Set(sourceList)

  // Group entities by normalized label (entity_type::label) → set of source IDs
  const labelToSources: Record<string, Set<string>> = {}
  for (const entity of allSourceEntities ?? []) {
    if (entity.source_id && entity.label) {
      const key = `${entity.entity_type}::${entity.label.toLowerCase().trim()}`
      if (!labelToSources[key]) labelToSources[key] = new Set()
      labelToSources[key]!.add(entity.source_id)
    }
  }

  // Count shared entities between source pairs (same-label entities across sources)
  const pairCounts: Record<string, number> = {}
  for (const sourcesInLabel of Object.values(labelToSources)) {
    if (sourcesInLabel.size < 2) continue
    const arr = [...sourcesInLabel].filter(s => sourceSet.has(s))
    if (arr.length < 2) continue
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        const key = [arr[i], arr[j]].sort().join('::')
        pairCounts[key] = (pairCounts[key] ?? 0) + 1
      }
    }
  }

  // Top 40 strongest edges
  const sortedPairs = Object.entries(pairCounts)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 40)

  const maxShared = sortedPairs.length > 0 ? sortedPairs[0]![1] : 1
  for (const [key, count] of sortedPairs) {
    const parts = key.split('::')
    const from = parts[0] ?? ''
    const to = parts[1] ?? ''
    sourceEdges.push({
      fromSourceId: from,
      toSourceId: to,
      sharedEntityCount: count,
      strength: count / maxShared,
    })
  }

  // Build ghost anchors
  const ghostAnchors: GhostAnchorNode[] = [...ghostAnchorMap.values()].map(g => ({
    id: g.id,
    kind: 'ghost_anchor' as const,
    label: g.label,
    entityType: g.entityType,
    color: getEntityColor(g.entityType),
    contributingSourceIds: g.sourceIds,
  }))

  const ghostEdges = ghostAnchors.flatMap(ga =>
    ga.contributingSourceIds.map(sid => ({ sourceId: sid, anchorId: ga.id }))
  )

  const color = getEntityColor(anchorRaw.entity_type)
  return {
    sources,
    edges: sourceEdges,
    ghostAnchors,
    ghostEdges,
    parentAnchor: { id: anchorRaw.id, label: anchorRaw.label, entityType: anchorRaw.entity_type, color },
    stats: {
      sourceCount: sources.length,
      entityCount: relevantEntityIds.size,
      bridgeCount: ghostAnchors.length,
    },
  }
}

// ─── Level 3: Entities Within a Source ────────────────────────────────────────

export async function fetchEntityLevelData(
  userId: string,
  sourceId: string,
  anchorId: string
): Promise<EntityLevelData> {
  // Fetch parent anchor and source in parallel
  const [anchorRes, sourceRes, entitiesRes] = await Promise.all([
    supabase
      .from('knowledge_nodes')
      .select('id, label, entity_type')
      .eq('id', anchorId)
      .single(),
    supabase
      .from('knowledge_sources')
      .select('id, title, source_type')
      .eq('id', sourceId)
      .single(),
    supabase
      .from('knowledge_nodes')
      .select('id, label, entity_type, description, confidence, source_id')
      .eq('source_id', sourceId)
      .eq('user_id', userId)
      .eq('is_anchor', false)
      .order('confidence', { ascending: false }),
  ])

  if (anchorRes.error) throw new Error(anchorRes.error.message)
  if (sourceRes.error) throw new Error(sourceRes.error.message)
  if (entitiesRes.error) throw new Error(entitiesRes.error.message)

  const entityIds = (entitiesRes.data ?? []).map(e => e.id)

  // Fetch intra-source edges (between entities in this source)
  let intraEdgesRaw: Array<{ id: string; source_node_id: string; target_node_id: string; relation_type: string | null; evidence: string | null; weight: number | null }> = []
  if (entityIds.length > 0) {
    const { data, error } = await supabase
      .from('knowledge_edges')
      .select('id, source_node_id, target_node_id, relation_type, evidence, weight')
      .in('source_node_id', entityIds)
      .in('target_node_id', entityIds)

    if (error) throw new Error(error.message)
    intraEdgesRaw = data ?? []
  }

  // Find which entities exist in other sources (cross-source bridges)
  // Check by label match across sources
  const entityLabels = (entitiesRes.data ?? []).map(e => ({ id: e.id, label: e.label, entityType: e.entity_type }))

  // Find same-label entities in other sources
  const labelList = entityLabels.map(e => e.label)
  let crossSourceEntities: Array<{ id: string; label: string; source_id: string | null }> = []
  if (labelList.length > 0) {
    const { data } = await supabase
      .from('knowledge_nodes')
      .select('id, label, source_id')
      .in('label', labelList)
      .eq('user_id', userId)
      .neq('source_id', sourceId)
      .eq('is_anchor', false)

    crossSourceEntities = data ?? []
  }

  // Build entity → source count mapping
  const entityLabelToSourceIds: Record<string, Set<string>> = {}
  for (const e of crossSourceEntities) {
    if (e.source_id) {
      if (!entityLabelToSourceIds[e.label]) entityLabelToSourceIds[e.label] = new Set()
      entityLabelToSourceIds[e.label]!.add(e.source_id)
    }
  }

  // Gather ghost source IDs for cross-source edges
  const ghostSourceIds = new Set<string>()
  const crossEdges: CrossSourceEdge[] = []

  for (const entity of entitiesRes.data ?? []) {
    const otherSources = entityLabelToSourceIds[entity.label]
    if (otherSources && otherSources.size > 0) {
      // Pick first other source as ghost target (up to 5)
      let count = 0
      for (const gsId of otherSources) {
        if (count >= 5) break
        ghostSourceIds.add(gsId)
        crossEdges.push({ entityId: entity.id, ghostSourceId: gsId })
        count++
      }
    }
  }

  // Fetch ghost source metadata
  let ghostSources: GhostSourceNode[] = []
  if (ghostSourceIds.size > 0) {
    const { data } = await supabase
      .from('knowledge_sources')
      .select('id, title, source_type')
      .in('id', [...ghostSourceIds])

    ghostSources = (data ?? []).map(s => {
      const cfg = getSourceConfig(s.source_type)
      return {
        id: s.id,
        kind: 'ghost_source' as const,
        label: s.title ?? 'Untitled',
        sourceType: s.source_type ?? 'Document',
        color: cfg.color,
        icon: cfg.icon,
      }
    })
  }

  // Build entity nodes
  const bridgeLabels = new Set(Object.keys(entityLabelToSourceIds))
  const entities: EntityGraphNode[] = (entitiesRes.data ?? []).map(e => {
    const otherSources = entityLabelToSourceIds[e.label]
    const sourceCount = 1 + (otherSources?.size ?? 0)
    return {
      id: e.id,
      kind: 'entity' as const,
      label: e.label,
      entityType: e.entity_type,
      color: getEntityColor(e.entity_type),
      confidence: e.confidence,
      isBridge: bridgeLabels.has(e.label),
      sourceCount,
      description: e.description,
    }
  })

  const intraEdges: IntraSourceEdge[] = intraEdgesRaw.map(e => ({
    fromEntityId: e.source_node_id,
    toEntityId: e.target_node_id,
    relationType: e.relation_type,
    evidence: e.evidence,
    weight: e.weight ?? 1,
  }))

  const bridgeCount = entities.filter(e => e.isBridge).length

  return {
    entities,
    intraEdges,
    crossEdges,
    ghostSources,
    parentAnchor: { id: anchorRes.data.id, label: anchorRes.data.label },
    parentSource: {
      id: sourceRes.data.id,
      title: sourceRes.data.title ?? 'Untitled',
      sourceType: sourceRes.data.source_type ?? 'Document',
    },
    stats: {
      entityCount: entities.length,
      edgeCount: intraEdges.length,
      bridgeCount,
    },
  }
}

// ─── Full Graph (all nodes + edges with pre-computed positions) ─────────────
// See: supabase/migrations/20260401_get_full_graph.sql
// See: api/graph/compute-layout.ts for position computation

export interface FullGraphNode {
  id: string
  label: string
  entityType: string
  graphX: number | null
  graphY: number | null
  isAnchor: boolean
  sourceId: string | null
  confidence: number | null
  createdAt: string
}

export interface FullGraphEdge {
  sourceNodeId: string
  targetNodeId: string
  relationType: string | null
  weight: number
}

export interface FullGraphData {
  nodes: FullGraphNode[]
  edges: FullGraphEdge[]
  stats: { totalNodes: number; totalEdges: number; positionedNodes: number }
}

export async function fetchFullGraph(userId: string): Promise<FullGraphData> {
  const { data, error } = await supabase.rpc('get_full_graph', { p_user_id: userId })
  if (error) throw new Error(error.message)

  const result = data as {
    nodes: FullGraphNode[]
    edges: FullGraphEdge[]
    stats: { totalNodes: number; totalEdges: number; positionedNodes: number }
  } | null

  if (!result) return { nodes: [], edges: [], stats: { totalNodes: 0, totalEdges: 0, positionedNodes: 0 } }

  return {
    nodes: result.nodes ?? [],
    edges: result.edges ?? [],
    stats: result.stats ?? { totalNodes: 0, totalEdges: 0, positionedNodes: 0 },
  }
}

export async function triggerLayoutComputation(accessToken: string, userId: string): Promise<boolean> {
  try {
    const res = await fetch('/api/graph/compute-layout', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ userId }),
    })
    return res.ok
  } catch {
    return false
  }
}
