import { supabase } from './supabase'
import type { ClusterData, CrossClusterEdge, TypeDistributionEntry, EntityNode, EntityWithConnections } from '../types/explore'

// ─── fetchClusterData ─────────────────────────────────────────────────────────

export interface ClusterDataResult {
  clusters: ClusterData[]
  clusteredNodeIds: Set<string>
}

export async function fetchClusterData(userId: string): Promise<ClusterDataResult> {
  // 1. Fetch anchors
  const { data: anchors, error: ancErr } = await supabase
    .from('knowledge_nodes')
    .select('id, label, entity_type, description, parent_anchor_id')
    .eq('user_id', userId)
    .eq('is_anchor', true)
    .eq('is_merged', false)
    .order('label')

  if (ancErr) throw new Error(ancErr.message)
  if (!anchors?.length) return { clusters: [], clusteredNodeIds: new Set() }

  // 2. Fetch all non-anchor nodes (paginated to avoid Supabase 1000-row default limit)
  const allNodes: Array<{ id: string; entity_type: string; source_id: string | null }> = []
  {
    let offset = 0
    const PAGE = 1000
    while (true) {
      const { data, error } = await supabase
        .from('knowledge_nodes')
        .select('id, entity_type, source_id')
        .eq('user_id', userId)
        .eq('is_anchor', false)
        .eq('is_merged', false)
        .range(offset, offset + PAGE - 1)
      if (error) throw new Error(error.message)
      if (!data || data.length === 0) break
      allNodes.push(...(data as Array<{ id: string; entity_type: string; source_id: string | null }>))
      if (data.length < PAGE) break
      offset += PAGE
    }
  }

  // 3. Fetch all edges (paginated — graphs can exceed 1000 edges)
  const allEdges: Array<{ source_node_id: string; target_node_id: string; is_inherited: boolean }> = []
  {
    let offset = 0
    const PAGE = 1000
    while (true) {
      const { data, error } = await supabase
        .from('knowledge_edges')
        .select('source_node_id, target_node_id, is_inherited')
        .eq('user_id', userId)
        .range(offset, offset + PAGE - 1)
      if (error) throw new Error(error.message)
      if (!data || data.length === 0) break
      allEdges.push(...(data as Array<{ source_node_id: string; target_node_id: string; is_inherited: boolean }>))
      if (data.length < PAGE) break
      offset += PAGE
    }
  }

  // Compute cluster membership: node belongs to anchor's cluster
  // if it has a direct edge to/from that anchor
  const anchorIds = new Set(anchors.map(a => a.id))
  const nodeClusterMap = new Map<string, Set<string>>()

  for (const edge of allEdges) {
    const src = edge.source_node_id as string
    const tgt = edge.target_node_id as string
    if (anchorIds.has(src) && !anchorIds.has(tgt)) {
      if (!nodeClusterMap.has(tgt)) nodeClusterMap.set(tgt, new Set())
      nodeClusterMap.get(tgt)!.add(src)
    }
    if (anchorIds.has(tgt) && !anchorIds.has(src)) {
      if (!nodeClusterMap.has(src)) nodeClusterMap.set(src, new Set())
      nodeClusterMap.get(src)!.add(tgt)
    }
  }

  // Collect all clustered node IDs
  const allClusteredNodeIds = new Set<string>()
  for (const [nid] of nodeClusterMap) {
    allClusteredNodeIds.add(nid)
  }

  // Build sub-anchor map: parent_anchor_id → sub-anchor IDs
  const subAnchorMap = new Map<string, string[]>()
  for (const anchor of anchors ?? []) {
    const a = anchor as { id: string; parent_anchor_id: string | null }
    if (a.parent_anchor_id) {
      const existing = subAnchorMap.get(a.parent_anchor_id) ?? []
      existing.push(a.id)
      subAnchorMap.set(a.parent_anchor_id, existing)
    }
  }

  const clusters = anchors.map(anchor => {
    const a = anchor as { id: string; label: string; entity_type: string; description: string | null; parent_anchor_id: string | null }
    const clusterNodeIds = [...nodeClusterMap.entries()]
      .filter(([, set]) => set.has(a.id))
      .map(([nid]) => nid)
    const clusterNodes = (allNodes).filter(n => clusterNodeIds.includes((n as { id: string }).id))

    // Type distribution
    const typeCounts: Record<string, number> = {}
    for (const n of clusterNodes) {
      const entityType = (n as { entity_type: string }).entity_type
      typeCounts[entityType] = (typeCounts[entityType] || 0) + 1
    }
    const total = clusterNodes.length || 1
    const typeDistribution: TypeDistributionEntry[] = Object.entries(typeCounts)
      .map(([entityType, count]) => ({ entityType, count, percentage: count / total }))
      .sort((a, b) => b.count - a.count)

    // Cross-cluster edges
    const crossClusterEdges: CrossClusterEdge[] = []
    for (const other of anchors) {
      const o = other as { id: string }
      if (o.id === a.id) continue
      const otherIds = new Set(
        [...nodeClusterMap.entries()]
          .filter(([, s]) => s.has(o.id))
          .map(([nid]) => nid)
      )
      const shared = clusterNodeIds.filter(id => otherIds.has(id))
      const crossEdges = (allEdges).filter(e => {
        const src = e.source_node_id as string
        const tgt = e.target_node_id as string
        return (
          (clusterNodeIds.includes(src) && otherIds.has(tgt)) ||
          (clusterNodeIds.includes(tgt) && otherIds.has(src))
        )
      })
      const weight = shared.length + crossEdges.length
      if (weight > 0) {
        crossClusterEdges.push({
          targetClusterId: o.id,
          sharedEntityCount: shared.length,
          crossEdgeCount: crossEdges.length,
          totalWeight: weight,
        })
      }
    }

    // PRD-23: Count inherited entities for this anchor
    const inheritedNodeIds = new Set<string>()
    for (const edge of allEdges) {
      if (edge.is_inherited && edge.source_node_id === a.id) {
        inheritedNodeIds.add(edge.target_node_id)
      }
    }
    // Remove direct entities from inherited count (avoid double-counting)
    for (const directId of clusterNodeIds) {
      inheritedNodeIds.delete(directId)
    }

    const directEntityCount    = clusterNodes.length
    const inheritedEntityCount = inheritedNodeIds.size

    return {
      anchor: {
        id: a.id,
        label: a.label,
        entityType: a.entity_type,
        description: a.description,
        entityCount: directEntityCount + inheritedEntityCount,
        parentAnchorId: a.parent_anchor_id ?? null,
        isSubAnchor: !!a.parent_anchor_id,
      },
      entityCount: directEntityCount + inheritedEntityCount,
      directEntityCount,
      inheritedEntityCount,
      typeDistribution,
      position: { cx: 0, cy: 0, r: 0 }, // Computed by useClusterLayout
      crossClusterEdges,
      subAnchorIds: subAnchorMap.get(a.id) ?? [],
    }
  })

  return { clusters, clusteredNodeIds: allClusteredNodeIds }
}

// ─── fetchGraphStats ──────────────────────────────────────────────────────────

export interface GraphStats {
  nodeCount: number
  edgeCount: number
  sourceCount: number
  anchorCount: number
}

export async function fetchGraphStats(userId: string): Promise<GraphStats> {
  const [nodes, edges, sources, anchors] = await Promise.all([
    supabase.from('knowledge_nodes').select('id', { count: 'exact', head: true }).eq('user_id', userId).eq('is_merged', false),
    supabase.from('knowledge_edges').select('id', { count: 'exact', head: true }).eq('user_id', userId),
    supabase.from('knowledge_sources').select('id', { count: 'exact', head: true }).eq('user_id', userId),
    supabase.from('knowledge_nodes').select('id', { count: 'exact', head: true }).eq('user_id', userId).eq('is_anchor', true).eq('is_merged', false),
  ])
  return {
    nodeCount: nodes.count ?? 0,
    edgeCount: edges.count ?? 0,
    sourceCount: sources.count ?? 0,
    anchorCount: anchors.count ?? 0,
  }
}

// ─── fetchUnclusteredNodes ────────────────────────────────────────────────────

export interface UnclusteredEntity {
  id: string
  label: string
  entityType: string
}

export async function fetchUnclusteredNodes(
  userId: string,
  clusteredNodeIds: Set<string>
): Promise<UnclusteredEntity[]> {
  const { data, error } = await supabase
    .from('knowledge_nodes')
    .select('id, label, entity_type')
    .eq('user_id', userId)
    .eq('is_anchor', false)
    .eq('is_merged', false)
    .limit(500)

  if (error) throw new Error(error.message)

  return (data ?? [])
    .filter(n => !clusteredNodeIds.has((n as { id: string }).id))
    .slice(0, 30) // Cap unclustered display
    .map(n => {
      const node = n as { id: string; label: string; entity_type: string }
      return { id: node.id, label: node.label, entityType: node.entity_type }
    })
}

// ─── fetchClusterEntities ─────────────────────────────────────────────────────

export async function fetchClusterEntities(
  userId: string,
  anchorId: string,
  clusterData?: ClusterData[],
  subAnchorIds?: string[]          // PRD-23: include sub-anchor entities in parent mode
): Promise<EntityNode[]> {
  // Build the set of anchor IDs to fetch for
  const anchorIdsToFetch = [anchorId, ...(subAnchorIds ?? [])]

  // Get edges involving this anchor OR any of its sub-anchors
  const orFilter = anchorIdsToFetch
    .map(id => `source_node_id.eq.${id},target_node_id.eq.${id}`)
    .join(',')

  const { data: anchorEdges, error: edgeErr } = await supabase
    .from('knowledge_edges')
    .select('source_node_id, target_node_id')
    .eq('user_id', userId)
    .or(orFilter)

  if (edgeErr) throw new Error(edgeErr.message)

  const anchorIdSet = new Set(anchorIdsToFetch)
  const nodeIds = new Set<string>()
  // Track which anchor each entity primarily connects to
  const entityOriginMap = new Map<string, string>()
  for (const e of anchorEdges ?? []) {
    const src = e.source_node_id as string
    const tgt = e.target_node_id as string
    if (!anchorIdSet.has(src)) {
      nodeIds.add(src)
      if (!entityOriginMap.has(src)) {
        // Primary anchor = the anchor end of this edge
        entityOriginMap.set(src, tgt)
      }
    }
    if (!anchorIdSet.has(tgt)) {
      nodeIds.add(tgt)
      if (!entityOriginMap.has(tgt)) {
        entityOriginMap.set(tgt, src)
      }
    }
  }
  if (nodeIds.size === 0) return []

  // Fetch full node details (includes other anchor nodes connected to this anchor)
  const { data: nodes, error: nodeErr } = await supabase
    .from('knowledge_nodes')
    .select('id, label, entity_type, description, confidence, source, source_type, source_id, tags, created_at, is_anchor')
    .in('id', Array.from(nodeIds))
    .eq('user_id', userId)

  if (nodeErr) throw new Error(nodeErr.message)

  // Connection counts — fetch all edges (paginated)
  const allEdges2: Array<{ source_node_id: string; target_node_id: string }> = []
  {
    let offset = 0
    const PAGE = 1000
    while (true) {
      const { data, error } = await supabase
        .from('knowledge_edges')
        .select('source_node_id, target_node_id')
        .eq('user_id', userId)
        .range(offset, offset + PAGE - 1)
      if (error) break
      if (!data || data.length === 0) break
      allEdges2.push(...(data as Array<{ source_node_id: string; target_node_id: string }>))
      if (data.length < PAGE) break
      offset += PAGE
    }
  }

  const counts: Record<string, number> = {}
  for (const e of allEdges2) {
    const src = e.source_node_id as string
    const tgt = e.target_node_id as string
    counts[src] = (counts[src] || 0) + 1
    counts[tgt] = (counts[tgt] || 0) + 1
  }

  // Determine cluster membership for bridge/unclustered detection
  // Build a quick lookup: nodeId → set of anchor IDs it belongs to
  const anchorIds = new Set<string>()
  if (clusterData) {
    for (const c of clusterData) anchorIds.add(c.anchor.id)
  }
  const nodeClusterMembership = new Map<string, string[]>()
  if (clusterData && allEdges2.length > 0) {
    for (const e of allEdges2) {
      const src = e.source_node_id as string
      const tgt = e.target_node_id as string
      if (anchorIds.has(src) && !anchorIds.has(tgt)) {
        const existing = nodeClusterMembership.get(tgt) ?? []
        if (!existing.includes(src)) existing.push(src)
        nodeClusterMembership.set(tgt, existing)
      }
      if (anchorIds.has(tgt) && !anchorIds.has(src)) {
        const existing = nodeClusterMembership.get(src) ?? []
        if (!existing.includes(tgt)) existing.push(tgt)
        nodeClusterMembership.set(src, existing)
      }
    }
  }

  return (nodes ?? []).map(n => {
    const node = n as {
      id: string; label: string; entity_type: string; description: string | null
      confidence: number | null; source: string | null; source_type: string | null
      source_id: string | null; tags: string[] | null; created_at: string
      is_anchor: boolean
    }
    const clusters = nodeClusterMembership.get(node.id) ?? []
    return {
      id: node.id,
      label: node.label,
      entityType: node.entity_type,
      description: node.description,
      confidence: node.confidence,
      connectionCount: counts[node.id] || 0,
      clusters,
      sourceId: node.source_id,
      sourceName: node.source,
      sourceType: node.source_type,
      tags: node.tags ?? [],
      createdAt: node.created_at,
      isBridge: clusters.length >= 2,
      isUnclustered: clusters.length === 0,
      isAnchor: node.is_anchor ?? false,
      originAnchorId: entityOriginMap.get(node.id) ?? anchorId,
    }
  })
}

// ─── fetchEntityEdges ─────────────────────────────────────────────────────────

export interface EntityEdge {
  sourceNodeId: string
  targetNodeId: string
  relationType: string | null
  weight: number
}

export async function fetchEntityEdges(
  userId: string,
  nodeIds: string[]
): Promise<EntityEdge[]> {
  if (nodeIds.length === 0) return []

  // Fetch all user edges paginated and filter client-side.
  // A direct .or() filter over hundreds of nodeIds would exceed URL length limits
  // and silently return partial or empty results.
  const PAGE_SIZE = 1000
  const allEdges: Array<{
    source_node_id: string
    target_node_id: string
    relation_type: string | null
    weight: number
  }> = []
  let offset = 0
  while (true) {
    const { data: batch, error } = await supabase
      .from('knowledge_edges')
      .select('source_node_id, target_node_id, relation_type, weight')
      .eq('user_id', userId)
      .range(offset, offset + PAGE_SIZE - 1)
    if (error) throw new Error(error.message)
    if (!batch || batch.length === 0) break
    for (const e of batch) allEdges.push(e as typeof allEdges[number])
    if (batch.length < PAGE_SIZE) break
    offset += PAGE_SIZE
  }

  const idSet = new Set(nodeIds)
  const seen = new Set<string>()
  return allEdges
    .filter(e => {
      const src = e.source_node_id
      const tgt = e.target_node_id
      if (!idSet.has(src) || !idSet.has(tgt)) return false
      const key = `${src}::${tgt}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .map(e => ({
      sourceNodeId: e.source_node_id,
      targetNodeId: e.target_node_id,
      relationType: e.relation_type ?? null,
      weight: e.weight || 1,
    }))
}

// ─── fetchSourceGraph ────────────────────────────────────────────────────────

export interface SourceGraphResult {
  sources: import('../types/explore').SourceNode[]
  edges: import('../types/explore').SourceEdge[]
  anchors: import('../types/explore').SourceGraphAnchor[]
}

const PAGE_SIZE = 1000

export async function fetchSourceGraph(userId: string): Promise<SourceGraphResult> {
  // 1. Fetch all sources
  const { data: sources, error: srcErr } = await supabase
    .from('knowledge_sources')
    .select('id, title, source_type, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })

  if (srcErr) throw new Error(srcErr.message)

  // 2. Fetch ALL nodes with source_id, tags, is_anchor (paginated)
  type NodeRow = { id: string; source_id: string; tags: string[] | null; is_anchor: boolean; label: string; entity_type: string }
  const nodes: NodeRow[] = []
  let nodeOffset = 0
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { data: batch, error: nodeErr } = await supabase
      .from('knowledge_nodes')
      .select('id, source_id, tags, is_anchor, label, entity_type')
      .eq('user_id', userId)
      .not('source_id', 'is', null)
      .range(nodeOffset, nodeOffset + PAGE_SIZE - 1)
    if (nodeErr) throw new Error(nodeErr.message)
    if (!batch || batch.length === 0) break
    for (const n of batch) nodes.push(n as NodeRow)
    if (batch.length < PAGE_SIZE) break
    nodeOffset += PAGE_SIZE
  }

  // 3. Build lookups
  const nodeToSource = new Map<string, string>()
  const sourceEntityIds = new Map<string, string[]>()
  const sourceTags = new Map<string, Set<string>>()

  for (const n of nodes) {
    if (!n.source_id) continue
    nodeToSource.set(n.id, n.source_id)

    // Entity IDs per source
    if (!sourceEntityIds.has(n.source_id)) sourceEntityIds.set(n.source_id, [])
    sourceEntityIds.get(n.source_id)!.push(n.id)

    // Tags per source (union of all entity tags)
    if (n.tags && n.tags.length > 0) {
      if (!sourceTags.has(n.source_id)) sourceTags.set(n.source_id, new Set())
      for (const tag of n.tags) sourceTags.get(n.source_id)!.add(tag)
    }
  }

  // 4. Identify anchors and build anchor → source mapping via edges
  const anchorNodes = nodes.filter(n => n.is_anchor)
  const anchorIds = new Set(anchorNodes.map(a => a.id))

  // 5. Fetch ALL edges (paginated)
  type EdgeRow = { source_node_id: string; target_node_id: string }
  const allEdges: EdgeRow[] = []
  let edgeOffset = 0
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { data: batch, error: edgeErr } = await supabase
      .from('knowledge_edges')
      .select('source_node_id, target_node_id')
      .eq('user_id', userId)
      .range(edgeOffset, edgeOffset + PAGE_SIZE - 1)
    if (edgeErr) throw new Error(edgeErr.message)
    if (!batch || batch.length === 0) break
    for (const e of batch) allEdges.push(e as EdgeRow)
    if (batch.length < PAGE_SIZE) break
    edgeOffset += PAGE_SIZE
  }

  // 6. Build anchor → connected source IDs, and source → connected anchor IDs
  const anchorToSources = new Map<string, Set<string>>()
  const sourceToAnchors = new Map<string, Set<string>>()

  for (const e of allEdges) {
    // Check if either end is an anchor
    const aId = anchorIds.has(e.source_node_id) ? e.source_node_id
              : anchorIds.has(e.target_node_id) ? e.target_node_id
              : null
    if (!aId) continue

    const otherId = aId === e.source_node_id ? e.target_node_id : e.source_node_id
    const otherSource = nodeToSource.get(otherId)
    if (!otherSource) continue

    if (!anchorToSources.has(aId)) anchorToSources.set(aId, new Set())
    anchorToSources.get(aId)!.add(otherSource)

    if (!sourceToAnchors.has(otherSource)) sourceToAnchors.set(otherSource, new Set())
    sourceToAnchors.get(otherSource)!.add(aId)
  }

  // Build SourceGraphAnchor array
  const graphAnchors: import('../types/explore').SourceGraphAnchor[] = anchorNodes
    .filter(a => anchorToSources.has(a.id))
    .map(a => ({
      id: a.id,
      label: a.label,
      entityType: a.entity_type,
      connectedSourceIds: Array.from(anchorToSources.get(a.id)!),
    }))

  // 7. Build SourceNode array (with tags and anchorIds)
  const sourceNodes: import('../types/explore').SourceNode[] = (sources ?? []).map(s => {
    const src = s as { id: string; title: string | null; source_type: string | null; created_at: string }
    const entityIds = sourceEntityIds.get(src.id) ?? []
    const tags = sourceTags.get(src.id)
    const anchIds = sourceToAnchors.get(src.id)
    return {
      id: src.id,
      title: src.title || 'Untitled',
      sourceType: src.source_type || 'Note',
      entityIds,
      entityCount: entityIds.length,
      createdAt: src.created_at,
      tags: tags ? Array.from(tags) : [],
      anchorIds: anchIds ? Array.from(anchIds) : [],
    }
  })

  // 8. Compute source-source edges with connection type breakdown
  // Use a combined key → { entity count, shared tags, common anchors }
  type PairData = {
    entityCount: number
    sharedTags: Set<string>
    commonAnchors: Set<string>
  }
  const pairMap = new Map<string, PairData>()

  const getOrCreatePair = (a: string, b: string): PairData => {
    const key = a < b ? `${a}::${b}` : `${b}::${a}`
    if (!pairMap.has(key)) pairMap.set(key, { entityCount: 0, sharedTags: new Set(), commonAnchors: new Set() })
    return pairMap.get(key)!
  }

  // 8a. Entity edges (cross-source)
  for (const e of allEdges) {
    const srcA = nodeToSource.get(e.source_node_id)
    const srcB = nodeToSource.get(e.target_node_id)
    if (!srcA || !srcB || srcA === srcB) continue
    getOrCreatePair(srcA, srcB).entityCount++
  }

  // 8b. Shared tags between sources
  const sourceIds = sourceNodes.map(s => s.id)
  for (let i = 0; i < sourceIds.length; i++) {
    const tagsA = sourceTags.get(sourceIds[i]!)
    if (!tagsA || tagsA.size === 0) continue
    for (let j = i + 1; j < sourceIds.length; j++) {
      const tagsB = sourceTags.get(sourceIds[j]!)
      if (!tagsB || tagsB.size === 0) continue
      for (const tag of tagsA) {
        if (tagsB.has(tag)) {
          getOrCreatePair(sourceIds[i]!, sourceIds[j]!).sharedTags.add(tag)
        }
      }
    }
  }

  // 8c. Common anchors between sources
  for (let i = 0; i < sourceIds.length; i++) {
    const anchA = sourceToAnchors.get(sourceIds[i]!)
    if (!anchA || anchA.size === 0) continue
    for (let j = i + 1; j < sourceIds.length; j++) {
      const anchB = sourceToAnchors.get(sourceIds[j]!)
      if (!anchB || anchB.size === 0) continue
      for (const aId of anchA) {
        if (anchB.has(aId)) {
          getOrCreatePair(sourceIds[i]!, sourceIds[j]!).commonAnchors.add(aId)
        }
      }
    }
  }

  // Build anchor label lookup for edge labels
  const anchorLabelMap = new Map(anchorNodes.map(a => [a.id, a.label]))

  // 9. Convert pair map to SourceEdge[]
  const sourceEdges: import('../types/explore').SourceEdge[] = []
  for (const [key, data] of pairMap) {
    const [fromId, toId] = key.split('::')
    const connections: import('../types/explore').SourceEdge['connections'] = []

    if (data.entityCount > 0) {
      connections.push({ type: 'entity', count: data.entityCount, labels: [] })
    }
    if (data.sharedTags.size > 0) {
      connections.push({ type: 'tag', count: data.sharedTags.size, labels: Array.from(data.sharedTags) })
    }
    if (data.commonAnchors.size > 0) {
      connections.push({
        type: 'anchor',
        count: data.commonAnchors.size,
        labels: Array.from(data.commonAnchors).map(id => anchorLabelMap.get(id) || id),
      })
    }

    if (connections.length > 0) {
      const totalWeight = data.entityCount + data.sharedTags.size * 2 + data.commonAnchors.size * 3
      sourceEdges.push({
        fromSourceId: fromId!,
        toSourceId: toId!,
        totalWeight,
        connections,
      })
    }
  }

  return { sources: sourceNodes, edges: sourceEdges, anchors: graphAnchors }
}

// ─── fetchSourceEntities ─────────────────────────────────────────────────────

export interface SourceEntityBadge {
  id: string
  label: string
  entityType: string
}

export async function fetchSourceEntities(
  userId: string,
  entityIds: string[]
): Promise<SourceEntityBadge[]> {
  if (entityIds.length === 0) return []

  const { data, error } = await supabase
    .from('knowledge_nodes')
    .select('id, label, entity_type')
    .eq('user_id', userId)
    .in('id', entityIds)

  if (error) throw new Error(error.message)

  return (data ?? []).map(n => {
    const node = n as { id: string; label: string; entity_type: string }
    return { id: node.id, label: node.label, entityType: node.entity_type }
  })
}

// ─── fetchEntityNeighbors ─────────────────────────────────────────────────────

export interface EntityNeighbor {
  node: { id: string; label: string; entityType: string }
  relationType: string | null
  direction: 'outgoing' | 'incoming'
}

export async function fetchEntityNeighbors(
  userId: string,
  nodeId: string
): Promise<EntityNeighbor[]> {
  const { data: edges, error } = await supabase
    .from('knowledge_edges')
    .select('source_node_id, target_node_id, relation_type')
    .eq('user_id', userId)
    .or(`source_node_id.eq.${nodeId},target_node_id.eq.${nodeId}`)

  if (error) throw new Error(error.message)
  if (!edges?.length) return []

  const neighborIds = new Set<string>()
  for (const e of edges) {
    const src = e.source_node_id as string
    const tgt = e.target_node_id as string
    if (src !== nodeId) neighborIds.add(src)
    if (tgt !== nodeId) neighborIds.add(tgt)
  }

  const { data: neighbors, error: nodeErr } = await supabase
    .from('knowledge_nodes')
    .select('id, label, entity_type')
    .in('id', Array.from(neighborIds))

  if (nodeErr) throw new Error(nodeErr.message)

  const map = new Map(
    (neighbors ?? []).map(n => {
      const node = n as { id: string; label: string; entity_type: string }
      return [node.id, { id: node.id, label: node.label, entityType: node.entity_type }]
    })
  )

  return edges
    .map(e => {
      const src = e.source_node_id as string
      const tgt = e.target_node_id as string
      const outgoing = src === nodeId
      const otherId = outgoing ? tgt : src
      const other = map.get(otherId)
      if (!other) return null
      return {
        node: other,
        relationType: (e.relation_type as string | null) ?? null,
        direction: outgoing ? 'outgoing' as const : 'incoming' as const,
      }
    })
    .filter((x): x is EntityNeighbor => x !== null)
}

// ─── fetchEntitiesWithConnectionCount ────────────────────────────────────────

export async function fetchEntitiesWithConnectionCount(
  userId: string
): Promise<EntityWithConnections[]> {
  // 1. Fetch all nodes for the user
  const { data: nodes, error: nodeError } = await supabase
    .from('knowledge_nodes')
    .select('id, label, entity_type, description, confidence, source, source_type, source_id, tags, created_at')
    .eq('user_id', userId)
    .eq('is_anchor', false)
    .order('created_at', { ascending: false })

  if (nodeError) throw new Error(nodeError.message)
  if (!nodes?.length) return []

  // 2. Fetch all edges for the user (paginated)
  const BATCH = 1000
  const allEdges: Array<{ source_node_id: string; target_node_id: string; relation_type: string | null }> = []
  let offset = 0
  while (true) {
    const { data: batch, error: edgeErr } = await supabase
      .from('knowledge_edges')
      .select('source_node_id, target_node_id, relation_type')
      .eq('user_id', userId)
      .range(offset, offset + BATCH - 1)
    if (edgeErr) throw new Error(edgeErr.message)
    if (!batch?.length) break
    for (const e of batch) allEdges.push(e as typeof allEdges[number])
    if (batch.length < BATCH) break
    offset += BATCH
  }

  // 3. Build connection count map and connection list per node
  const connectionCounts: Record<string, number> = {}
  const connectionMap: Record<string, Array<{ nodeId: string; relation: string }>> = {}

  for (const edge of allEdges) {
    connectionCounts[edge.source_node_id] = (connectionCounts[edge.source_node_id] || 0) + 1
    if (!connectionMap[edge.source_node_id]) connectionMap[edge.source_node_id] = []
    connectionMap[edge.source_node_id]!.push({ nodeId: edge.target_node_id, relation: edge.relation_type || 'relates_to' })

    connectionCounts[edge.target_node_id] = (connectionCounts[edge.target_node_id] || 0) + 1
    if (!connectionMap[edge.target_node_id]) connectionMap[edge.target_node_id] = []
    connectionMap[edge.target_node_id]!.push({ nodeId: edge.source_node_id, relation: edge.relation_type || 'relates_to' })
  }

  // 4. Build node lookup for top-connection labels
  const nodeMap = new Map(
    nodes.map(n => {
      const node = n as { id: string; label: string; entity_type: string }
      return [node.id, node]
    })
  )

  // 5. Assemble results
  return nodes.map(n => {
    const node = n as {
      id: string; label: string; entity_type: string; description: string | null
      confidence: number | null; source: string | null; source_type: string | null
      source_id: string | null; tags: string[] | null; created_at: string
    }
    const conns = (connectionMap[node.id] || []).slice(0, 5)
    return {
      id: node.id,
      label: node.label,
      entityType: node.entity_type,
      description: node.description,
      confidence: node.confidence,
      sourceId: node.source_id,
      sourceName: node.source,
      sourceType: node.source_type,
      tags: node.tags ?? [],
      createdAt: node.created_at,
      connectionCount: connectionCounts[node.id] || 0,
      topConnections: conns
        .map(c => {
          const target = nodeMap.get(c.nodeId)
          if (!target) return null
          return {
            id: target.id,
            label: target.label,
            entityType: target.entity_type,
            relationType: c.relation,
          }
        })
        .filter((x): x is NonNullable<typeof x> => x !== null),
    }
  })
}
