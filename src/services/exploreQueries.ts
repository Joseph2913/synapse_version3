import { supabase } from './supabase'
import type { ClusterData, CrossClusterEdge, TypeDistributionEntry, EntityNode, EntityWithConnections, PlaylistNode, PlaylistEdge, PlaylistVideoNode, PlaylistVideoEdge, PlaylistGraphAnchor, PlaylistGraphSkill } from '../types/explore'

// ─── fetchClusterData (via Supabase RPC) ──────────────────────────────────────
// Cluster summaries are computed server-side in Postgres (get_cluster_summaries).
// See: supabase/migrations/20260331_get_cluster_summaries.sql
// See: docs/PERFORMANCE-PATTERNS.md
//
// To modify cluster logic (membership, cross-cluster edges, inherited counts),
// update the Postgres function — NOT this file.

export interface ClusterDataResult {
  clusters: ClusterData[]
  clusteredNodeIds: Set<string>
}

/** Raw shape returned by the get_cluster_summaries RPC */
interface RpcClusterRow {
  anchor: {
    id: string
    label: string
    entityType: string
    description: string | null
    entityCount: number
    parentAnchorId: string | null
    isSubAnchor: boolean
  }
  entityCount: number
  directEntityCount: number
  inheritedEntityCount: number
  typeDistribution: TypeDistributionEntry[]
  position: { cx: number; cy: number; r: number }
  crossClusterEdges: CrossClusterEdge[]
  subAnchorIds: string[]
}

export async function fetchClusterData(userId: string): Promise<ClusterDataResult> {
  const { data, error } = await supabase.rpc('get_cluster_summaries', {
    p_user_id: userId,
  })

  if (error) throw new Error(error.message)

  const result = data as { clusters: RpcClusterRow[]; clusteredNodeIds: string[] } | null

  if (!result || !result.clusters || result.clusters.length === 0) {
    return { clusters: [], clusteredNodeIds: new Set() }
  }

  // Map RPC result to ClusterData[] — the shape already matches, just ensure types
  const clusters: ClusterData[] = result.clusters.map((row) => ({
    anchor: {
      id: row.anchor.id,
      label: row.anchor.label,
      entityType: row.anchor.entityType,
      description: row.anchor.description,
      entityCount: row.anchor.entityCount,
      parentAnchorId: row.anchor.parentAnchorId,
      isSubAnchor: row.anchor.isSubAnchor,
    },
    entityCount: row.entityCount,
    directEntityCount: row.directEntityCount,
    inheritedEntityCount: row.inheritedEntityCount,
    typeDistribution: row.typeDistribution ?? [],
    position: { cx: 0, cy: 0, r: 0 }, // Computed by useClusterLayout
    crossClusterEdges: row.crossClusterEdges ?? [],
    subAnchorIds: row.subAnchorIds ?? [],
  }))

  const clusteredNodeIds = new Set<string>(result.clusteredNodeIds ?? [])

  return { clusters, clusteredNodeIds }
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

// ─── fetchSourceGraph (via Supabase RPC) ────────────────────────────────────
// Source graph computed server-side. No anchor data — sources and their
// entity-based cross-connections only.
// See: supabase/migrations/20260331_get_explore_source_graph.sql
// See: docs/PERFORMANCE-PATTERNS.md

export interface SourceGraphResult {
  sources: import('../types/explore').SourceNode[]
  edges: import('../types/explore').SourceEdge[]
}

export async function fetchSourceGraph(userId: string): Promise<SourceGraphResult> {
  const { data, error } = await supabase.rpc('get_explore_source_graph', { p_user_id: userId })
  if (error) throw new Error(error.message)

  const result = data as {
    sources: Array<{
      id: string; title: string; sourceType: string
      entityIds: string[]; entityCount: number
      createdAt: string; tags: string[]
    }>
    edges: import('../types/explore').SourceEdge[]
  } | null

  if (!result) return { sources: [], edges: [] }

  const sources: import('../types/explore').SourceNode[] = (result.sources ?? []).map(s => ({
    id: s.id,
    title: s.title,
    sourceType: s.sourceType,
    entityIds: s.entityIds ?? [],
    entityCount: s.entityCount ?? 0,
    createdAt: s.createdAt,
    tags: s.tags ?? [],
    anchorIds: [], // anchors removed from source graph view
  }))

  return { sources, edges: result.edges ?? [] }
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

// ─── fetchSourceCardDetail ───────────────────────────────────────────────────
// Fetches rich detail for a single source: summary, entities, connections,
// and related sources (for the SourceDetailCard in the source graph).

export interface SourceCardEntity {
  id: string
  label: string
  entityType: string
  isAnchor: boolean
}

export interface SourceCardConnection {
  id: string
  fromLabel: string
  fromEntityType: string
  toLabel: string
  toEntityType: string
  relationType: string
}

export interface SourceCardCrossConnection {
  id: string
  localLabel: string
  localEntityType: string
  remoteLabel: string
  remoteEntityType: string
  relationType: string
}

export interface SourceCardRelatedSource {
  sourceId: string
  title: string
  sourceType: string
  sharedEntityCount: number
  crossConnections: SourceCardCrossConnection[]
}

export interface SourceCardDetail {
  sourceId: string
  title: string
  sourceType: string
  summary: string | null
  entities: SourceCardEntity[]
  connections: SourceCardConnection[]
  relatedSources: SourceCardRelatedSource[]
  anchorLabels: string[]
  createdAt: string
}

export async function fetchSourceCardDetail(
  userId: string,
  sourceId: string
): Promise<SourceCardDetail | null> {
  // 1. Fetch the source itself (for summary + metadata)
  const { data: source, error: srcErr } = await supabase
    .from('knowledge_sources')
    .select('id, title, source_type, summary, summary_source, content, metadata, created_at')
    .eq('id', sourceId)
    .eq('user_id', userId)
    .single()

  if (srcErr || !source) return null

  // 2. Fetch all entities belonging to this source
  const { data: rawNodes } = await supabase
    .from('knowledge_nodes')
    .select('id, label, entity_type, is_anchor')
    .eq('source_id', sourceId)
    .eq('user_id', userId)
    .eq('is_merged', false)
    .order('confidence', { ascending: false, nullsFirst: false })

  const nodes = (rawNodes ?? []) as Array<{
    id: string; label: string; entity_type: string; is_anchor: boolean
  }>
  const nodeIds = nodes.map(n => n.id)
  const nodeIdSet = new Set(nodeIds)
  const nodeMap = new Map(nodes.map(n => [n.id, n]))

  const entities: SourceCardEntity[] = nodes.map(n => ({
    id: n.id,
    label: n.label,
    entityType: n.entity_type,
    isAnchor: n.is_anchor,
  }))

  // Build summary early
  const s = source as { id: string; title: string | null; source_type: string | null; summary: string | null; content: string | null; metadata: Record<string, unknown> | null; created_at: string }
  const summary = s.summary ?? (s.metadata?.summary as string | null) ?? (s.content ? s.content.replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 180) + '...' : null)

  // 3. Early return if no entities
  if (nodeIds.length === 0) {
    return {
      sourceId: s.id,
      title: s.title || 'Untitled',
      sourceType: s.source_type || 'Note',
      summary,
      entities: [],
      connections: [],
      relatedSources: [],
      anchorLabels: [],
      createdAt: s.created_at,
    }
  }

  // 4. Fetch edges involving these nodes
  const batchSize = 50
  let allEdges: Array<{ id: string; source_node_id: string; target_node_id: string; relation_type: string | null }> = []
  for (let i = 0; i < nodeIds.length; i += batchSize) {
    const batch = nodeIds.slice(i, i + batchSize)
    const orFilter = batch.map(id => `source_node_id.eq.${id},target_node_id.eq.${id}`).join(',')
    const { data: edgeBatch } = await supabase
      .from('knowledge_edges')
      .select('id, source_node_id, target_node_id, relation_type')
      .eq('user_id', userId)
      .or(orFilter)
    if (edgeBatch) allEdges = [...allEdges, ...(edgeBatch as typeof allEdges)]
  }

  // Deduplicate edges
  const edgeMap = new Map<string, typeof allEdges[number]>()
  for (const e of allEdges) edgeMap.set(e.id, e)
  const uniqueEdges = Array.from(edgeMap.values())

  // 5. Separate within-source vs cross-source edges
  const withinConnections: SourceCardConnection[] = []
  const otherNodeIds = new Set<string>()
  // Store cross-source edges with their local/remote node IDs for later grouping
  const crossEdges: Array<{ id: string; localNodeId: string; remoteNodeId: string; relationType: string }> = []

  for (const e of uniqueEdges) {
    const fromIn = nodeIdSet.has(e.source_node_id)
    const toIn = nodeIdSet.has(e.target_node_id)
    if (fromIn && toIn) {
      const fromNode = nodeMap.get(e.source_node_id)
      const toNode = nodeMap.get(e.target_node_id)
      if (fromNode && toNode && withinConnections.length < 30) {
        withinConnections.push({
          id: e.id,
          fromLabel: fromNode.label,
          fromEntityType: fromNode.entity_type,
          toLabel: toNode.label,
          toEntityType: toNode.entity_type,
          relationType: e.relation_type ?? 'relates_to',
        })
      }
    } else {
      const localId = fromIn ? e.source_node_id : e.target_node_id
      const remoteId = fromIn ? e.target_node_id : e.source_node_id
      otherNodeIds.add(remoteId)
      crossEdges.push({
        id: e.id,
        localNodeId: localId,
        remoteNodeId: remoteId,
        relationType: e.relation_type ?? 'relates_to',
      })
    }
  }

  // 6. Fetch other nodes (with label, entity_type, source_id)
  type OtherNodeRow = { id: string; label: string; entity_type: string; source_id: string | null; is_anchor: boolean }
  const otherNodeMap = new Map<string, OtherNodeRow>()
  if (otherNodeIds.size > 0) {
    const otherIdArr = Array.from(otherNodeIds).slice(0, 300)
    const { data: otherNodes } = await supabase
      .from('knowledge_nodes')
      .select('id, label, entity_type, source_id, is_anchor')
      .in('id', otherIdArr)
      .eq('user_id', userId)

    for (const n of (otherNodes ?? []) as OtherNodeRow[]) {
      otherNodeMap.set(n.id, n)
    }
  }

  // 7. Group cross-source edges by related source, building connection details
  const relatedMap = new Map<string, {
    count: number
    connections: SourceCardCrossConnection[]
  }>()

  for (const ce of crossEdges) {
    const remoteNode = otherNodeMap.get(ce.remoteNodeId)
    if (!remoteNode || !remoteNode.source_id || remoteNode.source_id === sourceId) continue

    const rSourceId = remoteNode.source_id
    if (!relatedMap.has(rSourceId)) relatedMap.set(rSourceId, { count: 0, connections: [] })
    const entry = relatedMap.get(rSourceId)!
    entry.count++

    const localNode = nodeMap.get(ce.localNodeId)
    if (localNode && entry.connections.length < 15) {
      entry.connections.push({
        id: ce.id,
        localLabel: localNode.label,
        localEntityType: localNode.entity_type,
        remoteLabel: remoteNode.label,
        remoteEntityType: remoteNode.entity_type,
        relationType: ce.relationType,
      })
    }
  }

  // Also count anchor connections (entities in this source that connect to anchor nodes)
  const anchorConnections: SourceCardConnection[] = []
  for (const ce of crossEdges) {
    const remoteNode = otherNodeMap.get(ce.remoteNodeId)
    if (!remoteNode || !remoteNode.is_anchor) continue
    const localNode = nodeMap.get(ce.localNodeId)
    if (localNode && anchorConnections.length < 10) {
      anchorConnections.push({
        id: ce.id,
        fromLabel: localNode.label,
        fromEntityType: localNode.entity_type,
        toLabel: remoteNode.label,
        toEntityType: remoteNode.entity_type,
        relationType: ce.relationType,
      })
    }
  }

  // Merge within-source + anchor connections into the connections list
  const connections = [...withinConnections, ...anchorConnections]

  // 8. Fetch related source titles
  const sortedRelated = Array.from(relatedMap.entries())
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 10)

  let relatedSources: SourceCardRelatedSource[] = []
  const relatedSourceIds = sortedRelated.map(([id]) => id)

  if (relatedSourceIds.length > 0) {
    const { data: relSources } = await supabase
      .from('knowledge_sources')
      .select('id, title, source_type')
      .in('id', relatedSourceIds)

    const titleMap = new Map(
      (relSources ?? []).map(rs => {
        const r = rs as { id: string; title: string | null; source_type: string | null }
        return [r.id, r] as const
      })
    )

    relatedSources = sortedRelated.map(([rsId, data]) => {
      const meta = titleMap.get(rsId)
      return {
        sourceId: rsId,
        title: meta?.title || 'Untitled',
        sourceType: meta?.source_type || 'Note',
        sharedEntityCount: data.count,
        crossConnections: data.connections,
      }
    })
  }

  // Anchor labels connected to this source's entities
  const anchorLabels = entities.filter(e => e.isAnchor).map(e => e.label)

  return {
    sourceId: s.id,
    title: s.title || 'Untitled',
    sourceType: s.source_type || 'Note',
    summary,
    entities: entities.filter(e => !e.isAnchor),
    connections,
    relatedSources,
    anchorLabels,
    createdAt: s.created_at,
  }
}

// ─── fetchPlaylistGraph (via Supabase RPC) ──────────────────────────────────
// Playlist graph computed server-side. Returns playlists, cross-playlist edges,
// videos, and video-to-video edges.
// See: supabase/migrations/20260405_get_playlist_graph.sql

export interface PlaylistGraphResult {
  playlists: PlaylistNode[]
  playlistEdges: PlaylistEdge[]
  videos: PlaylistVideoNode[]
  videoEdges: PlaylistVideoEdge[]
}

export async function fetchPlaylistGraph(userId: string): Promise<PlaylistGraphResult> {
  const { data, error } = await supabase.rpc('get_playlist_graph', { p_user_id: userId })
  if (error) throw new Error(error.message)

  const result = data as {
    playlists: PlaylistNode[]
    playlistEdges: PlaylistEdge[]
    videos: PlaylistVideoNode[]
    videoEdges: PlaylistVideoEdge[]
  } | null

  if (!result) return { playlists: [], playlistEdges: [], videos: [], videoEdges: [] }

  return {
    playlists: result.playlists ?? [],
    playlistEdges: result.playlistEdges ?? [],
    videos: result.videos ?? [],
    videoEdges: result.videoEdges ?? [],
  }
}

// ─── fetchGraphAnchors ──────────────────────────────────────────────────────
// Fetch top N confirmed anchors with connected source IDs for the playlist graph.

export async function fetchGraphAnchors(userId: string, limit: number): Promise<PlaylistGraphAnchor[]> {
  // 1. Get top confirmed anchors by composite score
  const { data: candidates, error: candErr } = await supabase
    .from('anchor_candidates')
    .select(`
      id,
      node_id,
      composite_score,
      knowledge_nodes!inner (
        id, label, entity_type, description
      )
    `)
    .eq('user_id', userId)
    .eq('status', 'confirmed')
    .order('composite_score', { ascending: false })
    .limit(limit)

  if (candErr) throw new Error(candErr.message)
  if (!candidates || candidates.length === 0) return []

  // 2. For each anchor's node_id, find connected source IDs via edges
  const nodeIds = candidates.map((c: Record<string, unknown>) => (c.node_id as string))

  // Get all edges involving these anchor nodes
  const { data: edges, error: edgeErr } = await supabase
    .from('knowledge_edges')
    .select('source_node_id, target_node_id')
    .eq('user_id', userId)
    .or(`source_node_id.in.(${nodeIds.join(',')}),target_node_id.in.(${nodeIds.join(',')})`)

  if (edgeErr) throw new Error(edgeErr.message)

  // Build nodeId → set of connected entity IDs
  const nodeIdSet = new Set(nodeIds)
  const anchorToEntityIds = new Map<string, Set<string>>()
  for (const nid of nodeIds) anchorToEntityIds.set(nid, new Set())

  for (const e of edges ?? []) {
    const src = e.source_node_id as string
    const tgt = e.target_node_id as string
    if (nodeIdSet.has(src) && !nodeIdSet.has(tgt)) {
      anchorToEntityIds.get(src)!.add(tgt)
    }
    if (nodeIdSet.has(tgt) && !nodeIdSet.has(src)) {
      anchorToEntityIds.get(tgt)!.add(src)
    }
  }

  // 3. Resolve entity IDs → source IDs
  const allEntityIds = new Set<string>()
  for (const set of anchorToEntityIds.values()) {
    for (const eid of set) allEntityIds.add(eid)
  }

  // Batch fetch source_id for all connected entities
  const entityIdArray = Array.from(allEntityIds)
  const entityToSource = new Map<string, string>()

  // Fetch in batches of 500 to avoid URL length limits
  for (let i = 0; i < entityIdArray.length; i += 500) {
    const batch = entityIdArray.slice(i, i + 500)
    const { data: entityRows, error: entityErr } = await supabase
      .from('knowledge_nodes')
      .select('id, source_id')
      .in('id', batch)

    if (entityErr) throw new Error(entityErr.message)
    for (const row of entityRows ?? []) {
      const r = row as { id: string; source_id: string | null }
      if (r.source_id) entityToSource.set(r.id, r.source_id)
    }
  }

  // Build final result
  return candidates.map((c: Record<string, unknown>) => {
    const node = c.knowledge_nodes as { id: string; label: string; entity_type: string; description: string | null }
    const entityIds = anchorToEntityIds.get(c.node_id as string) ?? new Set<string>()
    const sourceIds = new Set<string>()
    for (const eid of entityIds) {
      const sid = entityToSource.get(eid)
      if (sid) sourceIds.add(sid)
    }

    return {
      id: c.id as string,
      nodeId: c.node_id as string,
      label: node.label,
      entityType: node.entity_type,
      description: node.description,
      compositeScore: (c.composite_score as number) ?? 0,
      entityCount: entityIds.size,
      connectedSourceIds: Array.from(sourceIds),
    }
  })
}

// ─── fetchGraphSkills ───────────────────────────────────────────────────────
// Fetch top N active skills ranked by relevance for the playlist graph.

export async function fetchGraphSkills(userId: string, limit: number): Promise<PlaylistGraphSkill[]> {
  const { data, error } = await supabase
    .from('knowledge_skills')
    .select('id, name, title, description, domain, confidence, source_ids, usage_count, source_count, tags')
    .eq('user_id', userId)
    .eq('status', 'active')

  if (error) throw new Error(error.message)
  if (!data || data.length === 0) return []

  // Compute relevance scores
  const maxUsage = Math.max(...data.map((s: Record<string, unknown>) => (s.usage_count as number) ?? 0), 1)
  const maxSources = Math.max(...data.map((s: Record<string, unknown>) => (s.source_count as number) ?? 0), 1)

  const scored = data.map((s: Record<string, unknown>) => {
    const confidence = (s.confidence as number) ?? 0
    const usageCount = (s.usage_count as number) ?? 0
    const sourceCount = (s.source_count as number) ?? 0
    const relevanceScore =
      confidence * 0.4 +
      (usageCount / maxUsage) * 0.3 +
      (sourceCount / maxSources) * 0.3

    return {
      id: s.id as string,
      name: s.name as string,
      title: s.title as string,
      description: (s.description as string) ?? '',
      domain: (s.domain as string | null),
      confidence,
      sourceIds: (s.source_ids as string[]) ?? [],
      usageCount,
      sourceCount,
      tags: (s.tags as string[]) ?? [],
      relevanceScore,
    }
  })

  // Sort by relevance and take top N
  scored.sort((a, b) => b.relevanceScore - a.relevanceScore)
  return scored.slice(0, limit)
}
