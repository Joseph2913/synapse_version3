import { supabase } from './supabase'
import type { KnowledgeSource } from '../types/database'
import type { FeedItem, FeedEntityBadge, CrossConnection, WithinSourceConnection, DailyStats } from '../types/feed'

type PartialNode = {
  id: string
  source_id: string | null
  label: string
  entity_type: string
  confidence: number | null
  is_anchor: boolean | null
}

type PartialEdge = {
  id: string
  source_node_id: string
  target_node_id: string
  relation_type: string | null
}

type OtherNode = {
  id: string
  label: string
  entity_type: string
  source_id: string | null
  is_anchor: boolean | null
}

type SourceMeta = {
  id: string
  title: string | null
  source_type: string | null
}

export async function fetchDailyStats(): Promise<DailyStats> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()

  const [sourcesRes, entitiesRes, relationsRes] = await Promise.all([
    supabase
      .from('knowledge_sources')
      .select('*', { count: 'exact', head: true })
      .gte('created_at', since),
    supabase
      .from('knowledge_nodes')
      .select('*', { count: 'exact', head: true })
      .gte('created_at', since),
    supabase
      .from('knowledge_edges')
      .select('*', { count: 'exact', head: true })
      .gte('created_at', since),
  ])

  return {
    sourcesProcessed: sourcesRes.count ?? 0,
    newEntities: entitiesRes.count ?? 0,
    relationshipsDiscovered: relationsRes.count ?? 0,
  }
}

export async function fetchActivityFeed(
  limit = 20,
  offset = 0
): Promise<{ items: FeedItem[]; hasMore: boolean }> {
  // Step 1: Fetch sources (limit+1 to detect hasMore)
  const { data: rawSources, error: sourcesError } = await supabase
    .from('knowledge_sources')
    .select('id, title, source_type, source_url, content, metadata, created_at, user_id, summary, summary_source')
    .order('created_at', { ascending: false })
    .range(offset, offset + limit)

  if (sourcesError || !rawSources?.length) {
    return { items: [], hasMore: false }
  }

  const hasMore = rawSources.length > limit
  const pageSources = rawSources.slice(0, limit) as KnowledgeSource[]
  const sourceIds = pageSources.map(s => s.id)

  // Step 2: Batch fetch all nodes for these sources
  const { data: rawNodes } = await supabase
    .from('knowledge_nodes')
    .select('id, source_id, label, entity_type, confidence, is_anchor')
    .in('source_id', sourceIds)
    .order('confidence', { ascending: false, nullsFirst: false })

  const allNodes: PartialNode[] = (rawNodes ?? []) as PartialNode[]

  // Group nodes by source_id and build node-to-source map
  const nodesBySource = new Map<string, PartialNode[]>()
  const nodeSourceMap = new Map<string, string>()
  const allNodeIds: string[] = []
  // Comprehensive lookup for ALL page nodes (needed for cross-page-source edge resolution)
  const allNodesByIdMap = new Map<string, PartialNode>()

  for (const n of allNodes) {
    allNodesByIdMap.set(n.id, n)
    if (!n.source_id) continue
    const list = nodesBySource.get(n.source_id) ?? []
    list.push(n)
    nodesBySource.set(n.source_id, list)
    nodeSourceMap.set(n.id, n.source_id)
    allNodeIds.push(n.id)
  }

  // Step 2.5: Filter out sources that haven't been extracted yet (no nodes)
  // This prevents unprocessed sources (e.g. newly ingested meetings) from appearing
  const extractedSources = pageSources.filter(s => (nodesBySource.get(s.id)?.length ?? 0) > 0)

  // Step 3: Batch fetch edges involving any of these nodes
  let rawEdges: PartialEdge[] = []

  if (allNodeIds.length > 0) {
    const batchSize = 50
    for (let i = 0; i < allNodeIds.length; i += batchSize) {
      const batch = allNodeIds.slice(i, i + batchSize)
      const orFilter = batch
        .map(id => `source_node_id.eq.${id},target_node_id.eq.${id}`)
        .join(',')
      const { data: batchEdges } = await supabase
        .from('knowledge_edges')
        .select('id, source_node_id, target_node_id, relation_type')
        .or(orFilter)
      if (batchEdges) {
        rawEdges = [...rawEdges, ...(batchEdges as PartialEdge[])]
      }
    }
  }

  // Deduplicate edges
  const edgeMap = new Map<string, PartialEdge>()
  for (const edge of rawEdges) {
    edgeMap.set(edge.id, edge)
  }
  const uniqueEdges = Array.from(edgeMap.values())

  // Identify "other" nodes outside our source set
  const otherNodeIdSet = new Set<string>()
  for (const edge of uniqueEdges) {
    const fromIn = nodeSourceMap.has(edge.source_node_id)
    const toIn = nodeSourceMap.has(edge.target_node_id)
    if (fromIn && !toIn) otherNodeIdSet.add(edge.target_node_id)
    if (!fromIn && toIn) otherNodeIdSet.add(edge.source_node_id)
  }

  // Fetch other nodes with their source ids
  const otherNodeMap = new Map<string, OtherNode>()
  if (otherNodeIdSet.size > 0) {
    const { data: otherNodes } = await supabase
      .from('knowledge_nodes')
      .select('id, label, entity_type, source_id, is_anchor')
      .in('id', Array.from(otherNodeIdSet))
    ;(otherNodes as OtherNode[] | null)?.forEach(n => otherNodeMap.set(n.id, n))
  }

  // Step 4: Fetch source titles for cross-connected sources
  const otherSourceIds = new Set<string>()
  otherNodeMap.forEach(n => { if (n.source_id) otherSourceIds.add(n.source_id) })

  const otherSourceMap = new Map<string, SourceMeta>()
  if (otherSourceIds.size > 0) {
    const { data: otherSrcs } = await supabase
      .from('knowledge_sources')
      .select('id, title, source_type')
      .in('id', Array.from(otherSourceIds))
    ;(otherSrcs as SourceMeta[] | null)?.forEach(s => otherSourceMap.set(s.id, s))
  }

  // Combined source map: page sources + external fetched sources
  // This resolves titles for cross-page-source edges (source A node → source B node on same page)
  const combinedSourceMap = new Map<string, SourceMeta>()
  for (const s of extractedSources) {
    combinedSourceMap.set(s.id, { id: s.id, title: s.title ?? null, source_type: s.source_type ?? null })
  }
  otherSourceMap.forEach((v, k) => combinedSourceMap.set(k, v))

  // Assemble FeedItems (only extracted sources)
  const items: FeedItem[] = extractedSources.map(source => {
    const sourceNodes = nodesBySource.get(source.id) ?? []
    const sourceNodeIdSet = new Set(sourceNodes.map(n => n.id))

    const entityCount = sourceNodes.length
    const entities: FeedEntityBadge[] = sourceNodes.map(n => ({
      id: n.id,
      label: n.label,
      entityType: n.entity_type,
      confidence: n.confidence ?? null,
    }))

    // O(1) node lookup within this source
    const sourceNodeMap = new Map(sourceNodes.map(n => [n.id, n]))

    let relationCount = 0
    const withinSourceConnections: WithinSourceConnection[] = []
    const crossConnections: CrossConnection[] = []

    for (const edge of uniqueEdges) {
      const fromIn = sourceNodeIdSet.has(edge.source_node_id)
      const toIn = sourceNodeIdSet.has(edge.target_node_id)

      if (fromIn && toIn) {
        // Both endpoints in this source — internal connection
        relationCount++
        if (withinSourceConnections.length < 500) {
          const fromNode = sourceNodeMap.get(edge.source_node_id)
          const toNode = sourceNodeMap.get(edge.target_node_id)
          if (fromNode && toNode) {
            withinSourceConnections.push({
              id: edge.id,
              fromNodeId: edge.source_node_id,
              fromLabel: fromNode.label,
              fromEntityType: fromNode.entity_type,
              toNodeId: edge.target_node_id,
              toLabel: toNode.label,
              toEntityType: toNode.entity_type,
              relationType: edge.relation_type ?? 'relates_to',
              isAnchor: toNode.is_anchor === true,
            })
          }
        }
      } else if (fromIn && !toIn) {
        // Edge goes from this source to an outside node (external or another page source)
        relationCount++
        const otherNode = otherNodeMap.get(edge.target_node_id) ?? allNodesByIdMap.get(edge.target_node_id)
        if (otherNode && crossConnections.length < 500) {
          const fromNode = sourceNodeMap.get(edge.source_node_id)
          const otherSrc = otherNode.source_id ? combinedSourceMap.get(otherNode.source_id) : null
          if (fromNode) {
            crossConnections.push({
              id: edge.id,
              fromNodeId: edge.source_node_id,
              fromLabel: fromNode.label,
              fromEntityType: fromNode.entity_type,
              toNodeId: edge.target_node_id,
              toLabel: otherNode.label,
              toEntityType: otherNode.entity_type,
              relationType: edge.relation_type ?? 'relates_to',
              isAnchor: otherNode.is_anchor === true,
              toSourceId: otherNode.source_id,
              toSourceTitle: otherSrc?.title ?? null,
              toSourceType: otherSrc?.source_type ?? null,
            })
          }
        }
      } else if (!fromIn && toIn) {
        // Edge comes from an outside node (external or another page source) into this source.
        // Normalise so that `to` = the external node (consistent with the fromIn && !toIn case),
        // ensuring anchor chips always read from toNodeId/toLabel.
        relationCount++
        const otherNode = otherNodeMap.get(edge.source_node_id) ?? allNodesByIdMap.get(edge.source_node_id)
        if (otherNode && crossConnections.length < 500) {
          const internalNode = sourceNodeMap.get(edge.target_node_id)
          const otherSrc = otherNode.source_id ? combinedSourceMap.get(otherNode.source_id) : null
          if (internalNode) {
            crossConnections.push({
              id: edge.id,
              fromNodeId: edge.target_node_id,
              fromLabel: internalNode.label,
              fromEntityType: internalNode.entity_type,
              toNodeId: edge.source_node_id,
              toLabel: otherNode.label,
              toEntityType: otherNode.entity_type,
              relationType: edge.relation_type ?? 'relates_to',
              isAnchor: otherNode.is_anchor === true,
              toSourceId: otherNode.source_id,
              toSourceTitle: otherSrc?.title ?? null,
              toSourceType: otherSrc?.source_type ?? null,
            })
          }
        }
      }
    }

    // Prefer DB summary column; fall back to metadata.summary; then content truncation
    const metadata = source.metadata as Record<string, unknown> | null
    const summary =
      (source as KnowledgeSource & { summary?: string | null }).summary ??
      (metadata?.summary as string | null) ??
      (source.content ? source.content.replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 180) + '...' : null)

    const isFallbackSummary = !(source as KnowledgeSource & { summary?: string | null }).summary && !(metadata?.summary as string | null)

    return { source, entityCount, relationCount, entities, withinSourceConnections, crossConnections, summary, isFallbackSummary }
  })

  return { items, hasMore }
}
