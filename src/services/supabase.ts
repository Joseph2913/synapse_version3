import { createClient } from '@supabase/supabase-js'
import type { UserProfile, ExtractionSettings, KnowledgeNode, KnowledgeEdge, KnowledgeSource } from '../types/database'
import type { NodeFilters, PaginationOptions, NodeWithMeta, NodeNeighbor } from '../types/nodes'
import type { CrossConnection } from '../types/feed'
import type { ExtractionSession } from '../types/extraction'
import type { YouTubePlaylist, QueueStats, PlaylistSettings } from '../types/youtube'
import type { QueueItem, QueueStatusFilter, ScanHistoryEntry, YouTubeSettings, AutomationSummary } from '../types/automate'
import type { DigestHistoryEntry, DigestModuleInput, DigestChannelInput } from '../types/digest'
import { generateSynapseCode } from './youtube'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    'Missing Supabase environment variables. ' +
    'Ensure VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY are set in .env.local'
  )
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey)

// ─── Profile ────────────────────────────────────────────────────────────────

export async function fetchOrCreateProfile(): Promise<UserProfile | null> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null

  const { data, error } = await supabase
    .from('user_profiles')
    .select('*')
    .eq('user_id', user.id)
    .maybeSingle()

  if (data) return data as UserProfile

  if (error?.code === 'PGRST116' || !data) {
    const { data: newProfile, error: insertError } = await supabase
      .from('user_profiles')
      .insert({
        user_id: user.id,
        professional_context: {},
        personal_interests: {},
        processing_preferences: {},
      })
      .select()
      .single()

    if (insertError) {
      console.error('Failed to create user profile:', insertError)
      return null
    }
    return newProfile as UserProfile
  }

  return null
}

export async function updateProfile(
  updates: Partial<{
    professional_context: Record<string, string>
    personal_interests: Record<string, string>
    processing_preferences: Record<string, string>
  }>
): Promise<{ error: Error | null }> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: new Error('Not authenticated') }

  const { error } = await supabase
    .from('user_profiles')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('user_id', user.id)

  return { error: error ? new Error(error.message) : null }
}

// ─── Anchors ─────────────────────────────────────────────────────────────────

export async function getNodeConnectionCount(nodeId: string): Promise<number> {
  const { count, error } = await supabase
    .from('knowledge_edges')
    .select('*', { count: 'exact', head: true })
    .or(`source_node_id.eq.${nodeId},target_node_id.eq.${nodeId}`)

  if (error) return 0
  return count ?? 0
}

export async function promoteToAnchor(nodeId: string): Promise<{ error: Error | null }> {
  const { error } = await supabase
    .from('knowledge_nodes')
    .update({ is_anchor: true })
    .eq('id', nodeId)

  return { error: error ? new Error(error.message) : null }
}

export async function demoteAnchor(nodeId: string): Promise<{ error: Error | null }> {
  const { error } = await supabase
    .from('knowledge_nodes')
    .update({ is_anchor: false })
    .eq('id', nodeId)

  return { error: error ? new Error(error.message) : null }
}

export async function searchNodes(query: string, limit: number = 20): Promise<KnowledgeNode[]> {
  const { data, error } = await supabase
    .from('knowledge_nodes')
    .select('id, label, entity_type, description, is_anchor, created_at')
    .ilike('label', `%${query}%`)
    .order('label')
    .limit(limit)

  if (error) {
    console.error('Node search failed:', error)
    return []
  }
  return (data ?? []) as KnowledgeNode[]
}

export async function searchNodesByLabel(query: string, limit: number = 15): Promise<KnowledgeNode[]> {
  const { data, error } = await supabase
    .from('knowledge_nodes')
    .select('id, label, entity_type, description, is_anchor, created_at')
    .ilike('label', `%${query}%`)
    .order('is_anchor', { ascending: false, nullsFirst: false })
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error) {
    console.error('Command palette search failed:', error)
    return []
  }
  return (data ?? []) as KnowledgeNode[]
}

// ─── Node Fetching ────────────────────────────────────────────────────────────

export async function fetchNodes(
  filters: NodeFilters,
  pagination: PaginationOptions
): Promise<{ data: NodeWithMeta[]; totalCount: number }> {
  // If anchor filter is active, pre-fetch connected node IDs
  let anchorNodeIds: string[] | null = null
  if (filters.anchorIds && filters.anchorIds.length > 0) {
    const { data: edgeData } = await supabase
      .from('knowledge_edges')
      .select('source_node_id, target_node_id')
      .or(
        filters.anchorIds.map(id => `source_node_id.eq.${id},target_node_id.eq.${id}`).join(',')
      )
    if (edgeData) {
      const connected = new Set<string>()
      edgeData.forEach(edge => {
        connected.add(edge.source_node_id)
        connected.add(edge.target_node_id)
      })
      // Remove the anchor IDs themselves
      filters.anchorIds.forEach(id => connected.delete(id))
      anchorNodeIds = Array.from(connected)
    } else {
      anchorNodeIds = []
    }
  }

  let query = supabase
    .from('knowledge_nodes')
    .select('*', { count: 'exact' })
    .order('created_at', { ascending: false })

  if (filters.search) {
    query = query.or(`label.ilike.%${filters.search}%,description.ilike.%${filters.search}%`)
  }

  if (filters.entityTypes?.length) {
    query = query.in('entity_type', filters.entityTypes)
  }

  if (filters.sourceTypes?.length) {
    query = query.in('source_type', filters.sourceTypes)
  }

  if (filters.minConfidence != null && filters.minConfidence > 0) {
    query = query.gte('confidence', filters.minConfidence)
  }

  if (filters.tags?.length) {
    query = query.overlaps('tags', filters.tags)
  }

  if (anchorNodeIds !== null) {
    if (anchorNodeIds.length === 0) {
      return { data: [], totalCount: 0 }
    }
    query = query.in('id', anchorNodeIds)
  }

  const from = pagination.page * pagination.pageSize
  const to = from + pagination.pageSize - 1
  query = query.range(from, to)

  const { data, count, error } = await query

  if (error) {
    throw new Error(error.message)
  }

  const nodes = (data ?? []) as KnowledgeNode[]
  const nodeIds = nodes.map(n => n.id)

  // Batch connection count
  const connectionCounts = await batchGetConnectionCounts(nodeIds)
  // Batch anchor labels
  const anchorLabelsMap = await getNodeAnchorConnections(nodeIds)

  const result: NodeWithMeta[] = nodes.map(node => ({
    ...node,
    connectionCount: connectionCounts[node.id] ?? 0,
    anchorLabels: anchorLabelsMap[node.id] ?? [],
  }))

  return { data: result, totalCount: count ?? 0 }
}

async function batchGetConnectionCounts(nodeIds: string[]): Promise<Record<string, number>> {
  if (nodeIds.length === 0) return {}

  const countMap: Record<string, number> = {}

  // Split into batches of 50 to avoid URL length limits
  const batchSize = 50
  for (let i = 0; i < nodeIds.length; i += batchSize) {
    const batch = nodeIds.slice(i, i + batchSize)
    const orFilter = batch.map(id => `source_node_id.eq.${id},target_node_id.eq.${id}`).join(',')
    const { data: edgeCounts } = await supabase
      .from('knowledge_edges')
      .select('source_node_id, target_node_id')
      .or(orFilter)

    edgeCounts?.forEach(edge => {
      countMap[edge.source_node_id] = (countMap[edge.source_node_id] ?? 0) + 1
      countMap[edge.target_node_id] = (countMap[edge.target_node_id] ?? 0) + 1
    })
  }

  return countMap
}

export async function fetchNodeById(nodeId: string): Promise<KnowledgeNode | null> {
  const { data, error } = await supabase
    .from('knowledge_nodes')
    .select('*')
    .eq('id', nodeId)
    .maybeSingle()

  if (error) {
    console.error('fetchNodeById error:', error)
    return null
  }
  return data as KnowledgeNode | null
}

export async function updateNode(
  nodeId: string,
  updates: Partial<Pick<KnowledgeNode, 'label' | 'description' | 'user_tags'>>
): Promise<KnowledgeNode> {
  const { data, error } = await supabase
    .from('knowledge_nodes')
    .update(updates)
    .eq('id', nodeId)
    .select()
    .single()

  if (error) throw new Error(error.message)
  return data as KnowledgeNode
}

// ─── Edge / Connection Fetching ───────────────────────────────────────────────

export async function getNodeNeighbors(
  nodeId: string,
  limit: number = 20
): Promise<NodeNeighbor[]> {
  // Step 1: fetch all edges connected to this node
  const { data: edges, error } = await supabase
    .from('knowledge_edges')
    .select('*')
    .or(`source_node_id.eq.${nodeId},target_node_id.eq.${nodeId}`)
    .order('weight', { ascending: false })
    .limit(limit)

  if (error || !edges) return []

  // Step 2: collect unique neighbor IDs
  const neighborIds = new Set<string>()
  edges.forEach((edge: KnowledgeEdge) => {
    if (edge.source_node_id !== nodeId) neighborIds.add(edge.source_node_id)
    if (edge.target_node_id !== nodeId) neighborIds.add(edge.target_node_id)
  })

  if (neighborIds.size === 0) return []

  // Step 3: fetch neighbor node details
  const { data: neighborNodes, error: nodeError } = await supabase
    .from('knowledge_nodes')
    .select('id, label, entity_type, description')
    .in('id', Array.from(neighborIds))

  if (nodeError || !neighborNodes) return []

  const nodeMap = new Map<string, Pick<KnowledgeNode, 'id' | 'label' | 'entity_type' | 'description'>>()
  neighborNodes.forEach((n: Pick<KnowledgeNode, 'id' | 'label' | 'entity_type' | 'description'>) => nodeMap.set(n.id, n))

  // Step 4: combine into NodeNeighbor[]
  const results: NodeNeighbor[] = []
  for (const edge of edges as KnowledgeEdge[]) {
    const neighborId = edge.source_node_id === nodeId ? edge.target_node_id : edge.source_node_id
    const neighborNode = nodeMap.get(neighborId)
    if (!neighborNode) continue

    results.push({
      node: neighborNode,
      edge: {
        id: edge.id,
        relation_type: edge.relation_type,
        evidence: edge.evidence,
        weight: edge.weight,
      },
      direction: edge.source_node_id === nodeId ? 'outgoing' : 'incoming',
    })
  }

  return results
}

// ─── Filter Options ───────────────────────────────────────────────────────────

export async function getDistinctSourceTypes(): Promise<string[]> {
  const { data, error } = await supabase
    .from('knowledge_nodes')
    .select('source_type')
    .not('source_type', 'is', null)
    .order('source_type')

  if (error || !data) return []

  const types = new Set<string>()
  data.forEach((row: { source_type: string | null }) => {
    if (row.source_type) types.add(row.source_type)
  })
  return Array.from(types)
}

export async function getAllTags(): Promise<string[]> {
  const { data, error } = await supabase
    .from('knowledge_nodes')
    .select('tags, user_tags')

  if (error || !data) return []

  const tags = new Set<string>()
  data.forEach((row: { tags: string[] | null; user_tags: string[] | null }) => {
    row.tags?.forEach(t => tags.add(t))
    row.user_tags?.forEach(t => tags.add(t))
  })
  return Array.from(tags).sort()
}

export async function getNodeAnchorConnections(nodeIds: string[]): Promise<Record<string, string[]>> {
  if (nodeIds.length === 0) return {}

  const result: Record<string, string[]> = {}
  nodeIds.forEach(id => { result[id] = [] })

  // Fetch edges connecting our nodes to anchors
  const orFilter = nodeIds.map(id => `source_node_id.eq.${id},target_node_id.eq.${id}`).join(',')
  const { data: edges } = await supabase
    .from('knowledge_edges')
    .select('source_node_id, target_node_id')
    .or(orFilter)

  if (!edges || edges.length === 0) return result

  // Collect all connected node IDs
  const connectedIds = new Set<string>()
  edges.forEach((edge: { source_node_id: string; target_node_id: string }) => {
    connectedIds.add(edge.source_node_id)
    connectedIds.add(edge.target_node_id)
  })

  // Fetch which of the connected nodes are anchors
  const { data: anchors } = await supabase
    .from('knowledge_nodes')
    .select('id, label')
    .in('id', Array.from(connectedIds))
    .eq('is_anchor', true)

  if (!anchors || anchors.length === 0) return result

  const anchorMap = new Map<string, string>()
  anchors.forEach((a: { id: string; label: string }) => anchorMap.set(a.id, a.label))

  // Map back to our nodeIds
  edges.forEach((edge: { source_node_id: string; target_node_id: string }) => {
    const { source_node_id, target_node_id } = edge
    if (nodeIds.includes(source_node_id) && anchorMap.has(target_node_id) && result[source_node_id]) {
      result[source_node_id].push(anchorMap.get(target_node_id) as string)
    }
    if (nodeIds.includes(target_node_id) && anchorMap.has(source_node_id) && result[target_node_id]) {
      result[target_node_id].push(anchorMap.get(source_node_id) as string)
    }
  })

  // Deduplicate
  Object.keys(result).forEach(id => {
    result[id] = Array.from(new Set(result[id]))
  })

  return result
}

// ─── Extraction Settings ──────────────────────────────────────────────────────

export async function fetchOrCreateExtractionSettings(): Promise<ExtractionSettings | null> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null

  const { data } = await supabase
    .from('extraction_settings')
    .select('*')
    .eq('user_id', user.id)
    .maybeSingle()

  if (data) return data as ExtractionSettings

  const { data: newSettings, error } = await supabase
    .from('extraction_settings')
    .insert({
      user_id: user.id,
      default_mode: 'comprehensive',
      default_anchor_emphasis: 'standard',
      settings: {},
    })
    .select()
    .single()

  if (error) {
    console.error('Failed to create extraction settings:', error)
    return null
  }
  return newSettings as ExtractionSettings
}

export async function updateExtractionSettings(
  updates: Partial<{ default_mode: string; default_anchor_emphasis: string }>
): Promise<{ error: Error | null }> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: new Error('Not authenticated') }

  const { error } = await supabase
    .from('extraction_settings')
    .update(updates)
    .eq('user_id', user.id)

  return { error: error ? new Error(error.message) : null }
}

// ─── Cross-Connection Queries ─────────────────────────────────────────────────

export async function fetchCrossConnectionsForSource(
  sourceId: string,
  limit: number = 3
): Promise<CrossConnection[]> {
  // 1. Get all node IDs that belong to this source
  const { data: sourceNodes } = await supabase
    .from('knowledge_nodes')
    .select('id, label, entity_type')
    .eq('source_id', sourceId)

  if (!sourceNodes?.length) return []

  const sourceNodeIds = sourceNodes.map(n => n.id)
  const sourceNodeMap = new Map(
    sourceNodes.map(n => [n.id, n as { id: string; label: string; entity_type: string }])
  )

  // 2. Find edges where one side is in sourceNodeIds
  const orFilter = sourceNodeIds
    .slice(0, 50) // guard against huge node lists
    .map(id => `source_node_id.eq.${id},target_node_id.eq.${id}`)
    .join(',')

  const { data: edges } = await supabase
    .from('knowledge_edges')
    .select('id, source_node_id, target_node_id, relation_type')
    .or(orFilter)
    .limit(50)

  if (!edges?.length) return []

  // 3. Collect the "other side" node IDs (not in sourceNodeIds)
  const otherNodeIds = edges
    .map(e =>
      sourceNodeIds.includes(e.source_node_id) ? e.target_node_id : e.source_node_id
    )
    .filter(id => !sourceNodeIds.includes(id))

  if (!otherNodeIds.length) return []

  const { data: otherNodes } = await supabase
    .from('knowledge_nodes')
    .select('id, label, entity_type, source_id')
    .in('id', [...new Set(otherNodeIds)])

  if (!otherNodes?.length) return []

  type OtherNodeRow = { id: string; label: string; entity_type: string; source_id: string | null }
  const otherNodeMap = new Map(
    (otherNodes as OtherNodeRow[]).map(n => [n.id, n])
  )

  // 4. Build CrossConnection[] — only edges where the other node belongs to a different source
  const results: CrossConnection[] = []

  for (const edge of edges) {
    if (results.length >= limit) break

    const fromId = edge.source_node_id
    const toId = edge.target_node_id
    const isFromInSource = sourceNodeIds.includes(fromId)
    const localId = isFromInSource ? fromId : toId
    const otherId = isFromInSource ? toId : fromId

    const otherNode = otherNodeMap.get(otherId)
    const localNode = sourceNodeMap.get(localId)

    if (otherNode && otherNode.source_id && otherNode.source_id !== sourceId && localNode) {
      results.push({
        id: edge.id,
        fromNodeId: localId,
        fromLabel: localNode.label,
        fromEntityType: localNode.entity_type,
        toNodeId: otherId,
        toLabel: otherNode.label,
        toEntityType: otherNode.entity_type,
        relationType: edge.relation_type ?? 'relates_to',
        isAnchor: false,
        toSourceId: otherNode.source_id,
        toSourceTitle: null,  // Not fetched here — use feedQueries.ts for enriched version
        toSourceType: null,
      })
    }
  }

  return results
}

// --- Extraction History ---

export async function fetchExtractionSessions(
  limit: number = 20,
  offset: number = 0
): Promise<ExtractionSession[]> {
  try {
    const { data, error } = await supabase
      .from('extraction_sessions')
      .select(
        'id, source_name, source_type, source_content_preview, extraction_mode, anchor_emphasis, user_guidance, selected_anchor_ids, entity_count, relationship_count, extraction_duration_ms, feedback_rating, feedback_text, created_at'
      )
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1)

    if (error) {
      console.warn('[supabase] Failed to fetch extraction sessions:', error.message)
      return []
    }

    return (data ?? []) as ExtractionSession[]
  } catch (err) {
    console.warn('[supabase] extraction_sessions table may not exist:', err)
    return []
  }
}

// --- Duplicate Node Detection ---

export async function checkDuplicateNodes(
  labels: string[],
  _userId: string
): Promise<Set<string>> {
  if (labels.length === 0) return new Set()

  const lowerLabels = labels.map(l => l.toLowerCase())
  const { data, error } = await supabase
    .from('knowledge_nodes')
    .select('label')
    .in('label', labels)

  if (error) {
    console.warn('[supabase] Failed to check duplicate nodes:', error.message)
    return new Set()
  }

  const existing = new Set<string>()
  for (const row of data ?? []) {
    if (lowerLabels.includes(row.label.toLowerCase())) {
      existing.add(row.label.toLowerCase())
    }
  }

  return existing
}

// ─── RAG: Graph Stats ─────────────────────────────────────────────────────────

export async function getGraphStats(userId: string): Promise<{
  nodeCount: number
  chunkCount: number
  edgeCount: number
  sourceCount: number
}> {
  const [nodes, chunks, edges, sources] = await Promise.all([
    supabase.from('knowledge_nodes').select('id', { count: 'exact', head: true }).eq('user_id', userId),
    supabase.from('knowledge_source_chunks').select('id', { count: 'exact', head: true }).eq('user_id', userId).not('embedding', 'is', null),
    supabase.from('knowledge_edges').select('id', { count: 'exact', head: true }).eq('user_id', userId),
    supabase.from('knowledge_sources').select('id', { count: 'exact', head: true }).eq('user_id', userId),
  ])

  return {
    nodeCount: nodes.count ?? 0,
    chunkCount: chunks.count ?? 0,
    edgeCount: edges.count ?? 0,
    sourceCount: sources.count ?? 0,
  }
}

// ─── RAG: Term Extraction ─────────────────────────────────────────────────────

// Common English filler words that are useless for search
const RAG_STOPWORDS = new Set([
  'what', 'can', 'you', 'the', 'are', 'how', 'tell', 'about', 'that', 'this',
  'with', 'have', 'from', 'they', 'will', 'been', 'were', 'there', 'which',
  'when', 'your', 'its', 'our', 'and', 'but', 'for', 'not', 'more', 'some',
  'all', 'any', 'was', 'has', 'had', 'may', 'who', 'why', 'did', 'does',
  'give', 'get', 'got', 'let', 'put', 'set', 'see', 'say', 'said', 'know',
  'just', 'into', 'than', 'then', 'too', 'also', 'very', 'here', 'over',
  'only', 'use', 'used', 'could', 'would', 'should', 'like', 'want', 'need',
  'help', 'make', 'made', 'show', 'take', 'think', 'look', 'find', 'time',
  'please', 'give', 'tell', 'me', 'us', 'its',
])

/**
 * Extract the most meaningful search terms from a natural-language query.
 * - Strips stopwords ("what", "can", "you", "the"…)
 * - Allows short acronyms ("AI", "ML" = 2 chars)
 * - Sorts by length descending so specific long words ("upskilling") come first
 */
function extractKeyTerms(query: string, limit: number): string[] {
  const terms = query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .map(w => w.replace(/[^a-z0-9]/g, ''))
    .filter(w => w.length >= 2 && !RAG_STOPWORDS.has(w))
    .sort((a, b) => b.length - a.length) // longer words = more specific
    .slice(0, limit)

  return terms.length > 0 ? terms : [query.trim().toLowerCase()]
}

// ─── RAG: Chunk Search ────────────────────────────────────────────────────────

export interface SemanticChunkResult {
  id: string
  source_id: string
  chunk_index: number
  content: string
  similarity: number
}

/** Keyword search on source_chunks.content — no embedding/RPC dependency */
export async function keywordSearchChunks(
  query: string,
  userId: string,
  options: { limit?: number } = {}
): Promise<SemanticChunkResult[]> {
  const { limit = 12 } = options
  if (!query.trim()) return []

  const terms = extractKeyTerms(query, 6)
  const orFilter = terms.map(term => `content.ilike.%${term}%`).join(',')

  const { data, error } = await supabase
    .from('knowledge_source_chunks')
    .select('id, source_id, chunk_index, content')
    .eq('user_id', userId)
    .or(orFilter)
    .limit(limit)

  if (error) {
    console.warn('[supabase] Keyword chunk search failed:', error.message)
    return []
  }

  type RawChunk = { id: string; source_id: string; chunk_index: number; content: string }
  return (data ?? []).map((chunk: RawChunk) => ({
    id: chunk.id,
    source_id: chunk.source_id,
    chunk_index: chunk.chunk_index,
    content: chunk.content,
    similarity: 1.0,
  }))
}

/** Fetch chunks for specific source IDs (source-first retrieval) */
export async function fetchChunksForSources(
  sourceIds: string[],
  _userId: string,
  options: { limit?: number } = {}
): Promise<SemanticChunkResult[]> {
  if (sourceIds.length === 0) return []
  const { limit = 15 } = options

  const { data, error } = await supabase
    .from('knowledge_source_chunks')
    .select('id, source_id, chunk_index, content')
    .in('source_id', sourceIds)
    .order('chunk_index', { ascending: true })
    .limit(limit)

  if (error) {
    console.warn('[supabase] fetchChunksForSources failed:', error.message)
    return []
  }

  type RawChunk = { id: string; source_id: string; chunk_index: number; content: string }
  return (data ?? []).map((chunk: RawChunk) => ({
    id: chunk.id,
    source_id: chunk.source_id,
    chunk_index: chunk.chunk_index,
    content: chunk.content,
    similarity: 1.0,
  }))
}

/** Semantic search over source chunks using vector cosine similarity (match_source_chunks RPC). */
export async function semanticSearchChunks(
  embedding: number[],
  userId: string,
  options: { matchThreshold?: number; matchCount?: number } = {}
): Promise<SemanticChunkResult[]> {
  if (!embedding || embedding.length === 0) return []
  const { matchThreshold = 0.4, matchCount = 15 } = options

  const { data, error } = await supabase.rpc('match_source_chunks', {
    query_embedding: embedding,
    match_threshold: matchThreshold,
    match_count: matchCount,
    p_user_id: userId,
  })

  if (error) {
    console.warn('[semanticSearchChunks] RPC failed:', error.message)
    return []
  }

  return (data ?? []) as SemanticChunkResult[]
}

// ─── RAG: Semantic Search on Nodes ────────────────────────────────────────────

export interface SemanticNodeResult {
  id: string
  label: string
  entity_type: string
  description: string | null
  similarity: number
}

/** Semantic search over knowledge nodes using vector cosine similarity (match_knowledge_nodes RPC). */
export async function semanticSearchNodes(
  embedding: number[],
  userId: string,
  options: { matchThreshold?: number; matchCount?: number } = {}
): Promise<SemanticNodeResult[]> {
  if (!embedding || embedding.length === 0) return []
  const { matchThreshold = 0.4, matchCount = 20 } = options

  const { data, error } = await supabase.rpc('match_knowledge_nodes', {
    query_embedding: embedding,
    match_threshold: matchThreshold,
    match_count: matchCount,
    p_user_id: userId,
  })

  if (error) {
    console.warn('[semanticSearchNodes] RPC failed:', error.message)
    return []
  }

  return (data ?? []) as SemanticNodeResult[]
}

// ─── RAG: Keyword Search on Nodes ────────────────────────────────────────────

export interface KeywordNodeResult {
  id: string
  label: string
  entity_type: string
  description: string | null
  source: string | null
  source_type: string | null
  source_id: string | null
  confidence: number | null
  is_anchor: boolean
  tags: string[] | null
  created_at: string
}

export async function keywordSearchNodes(
  query: string,
  userId: string,
  options: { limit?: number } = {}
): Promise<KeywordNodeResult[]> {
  const { limit = 10 } = options
  if (!query.trim()) return []

  const terms = extractKeyTerms(query, 6)
  const orFilter = terms
    .flatMap(term => [`label.ilike.%${term}%`, `description.ilike.%${term}%`])
    .join(',')

  const { data, error } = await supabase
    .from('knowledge_nodes')
    .select('id, label, entity_type, description, source, source_type, source_id, confidence, is_anchor, tags, created_at')
    .eq('user_id', userId)
    .or(orFilter)
    .order('is_anchor', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error) {
    console.warn('[supabase] Keyword node search failed:', error.message)
    return []
  }
  return (data ?? []) as KeywordNodeResult[]
}

// ─── RAG: Keyword Search on Sources ──────────────────────────────────────────

export interface KeywordSourceResult {
  id: string
  title: string | null
  source_type: string | null
  source_url: string | null
  created_at: string
}

export async function keywordSearchSources(
  query: string,
  userId: string,
  options: { limit?: number } = {}
): Promise<KeywordSourceResult[]> {
  const { limit = 5 } = options
  if (!query.trim()) return []

  const terms = extractKeyTerms(query, 6)
  const orFilter = terms.map(term => `title.ilike.%${term}%`).join(',')

  const { data, error } = await supabase
    .from('knowledge_sources')
    .select('id, title, source_type, source_url, created_at, summary, summary_source')
    .eq('user_id', userId)
    .or(orFilter)
    .order('created_at', { ascending: false }) // most recent first — handles "latest" queries
    .limit(limit)

  if (error) {
    console.warn('[supabase] Keyword source search failed:', error.message)
    return []
  }
  return (data ?? []) as KeywordSourceResult[]
}

// ─── RAG: Graph Traversal ─────────────────────────────────────────────────────

export async function traverseGraphFromNodes(
  nodeIds: string[],
  userId: string,
  depth: number = 2
): Promise<{ nodes: KnowledgeNode[]; edges: KnowledgeEdge[] }> {
  if (nodeIds.length === 0) return { nodes: [], edges: [] }

  const visitedNodeIds = new Set<string>(nodeIds)
  const allEdges: KnowledgeEdge[] = []
  let currentFrontier = [...nodeIds]

  for (let hop = 0; hop < depth; hop++) {
    if (currentFrontier.length === 0) break

    // Cap frontier to avoid expensive queries
    const cappedFrontier = currentFrontier.slice(0, 20)

    const orFilter = cappedFrontier
      .map(id => `source_node_id.eq.${id},target_node_id.eq.${id}`)
      .join(',')

    const { data: edges, error } = await supabase
      .from('knowledge_edges')
      .select('id, user_id, source_node_id, target_node_id, relation_type, evidence, weight, created_at')
      .eq('user_id', userId)
      .or(orFilter)

    if (error || !edges || edges.length === 0) break

    allEdges.push(...(edges as KnowledgeEdge[]))

    const nextFrontier: string[] = []
    for (const edge of edges as KnowledgeEdge[]) {
      for (const neighborId of [edge.source_node_id, edge.target_node_id]) {
        if (!visitedNodeIds.has(neighborId)) {
          visitedNodeIds.add(neighborId)
          nextFrontier.push(neighborId)
        }
      }
    }
    // Cap next frontier
    currentFrontier = nextFrontier.slice(0, 20)
  }

  const allNodeIds = Array.from(visitedNodeIds)
  if (allNodeIds.length === 0) return { nodes: [], edges: allEdges }

  const { data: nodes, error: nodeError } = await supabase
    .from('knowledge_nodes')
    .select('id, user_id, label, entity_type, description, source, source_type, source_url, source_id, confidence, is_anchor, tags, user_tags, quote, created_at')
    .in('id', allNodeIds)

  if (nodeError) {
    console.warn('[supabase] Node fetch in traversal failed:', nodeError.message)
    return { nodes: [], edges: allEdges }
  }

  return {
    nodes: (nodes ?? []) as KnowledgeNode[],
    edges: allEdges,
  }
}

// ─── RAG: Fetch Source Metadata Batch ────────────────────────────────────────

export async function fetchSourcesByIds(
  sourceIds: string[]
): Promise<Map<string, { id: string; title: string | null; source_type: string | null; created_at: string; summary: string | null; summary_source: string | null }>> {
  if (sourceIds.length === 0) return new Map()

  const uniqueIds = [...new Set(sourceIds)]
  const { data, error } = await supabase
    .from('knowledge_sources')
    .select('id, title, source_type, created_at, summary, summary_source')
    .in('id', uniqueIds)

  if (error || !data) return new Map()

  return new Map(
    (data as { id: string; title: string | null; source_type: string | null; created_at: string; summary: string | null; summary_source: string | null }[])
      .map(s => [s.id, s])
  )
}

export async function fetchSourceById(sourceId: string): Promise<KnowledgeSource | null> {
  const { data, error } = await supabase
    .from('knowledge_sources')
    .select('*')
    .eq('id', sourceId)
    .single()
  if (error || !data) return null
  return data as KnowledgeSource
}

// ─── RAG: Fetch Nodes by IDs ──────────────────────────────────────────────────

export async function fetchNodesByIds(nodeIds: string[]): Promise<KnowledgeNode[]> {
  if (nodeIds.length === 0) return []
  const uniqueIds = [...new Set(nodeIds)]
  const { data, error } = await supabase
    .from('knowledge_nodes')
    .select('*')
    .in('id', uniqueIds)

  if (error) {
    console.warn('[supabase] fetchNodesByIds failed:', error.message)
    return []
  }
  return (data ?? []) as KnowledgeNode[]
}

// ─── RAG: Top Anchor ─────────────────────────────────────────────────────────

export async function fetchTopAnchor(userId: string): Promise<string | null> {
  // Get anchor with most connections
  const { data: anchors } = await supabase
    .from('knowledge_nodes')
    .select('id, label')
    .eq('user_id', userId)
    .eq('is_anchor', true)
    .limit(20)

  if (!anchors?.length) return null

  // For simplicity, return the first anchor's label
  // A more thorough implementation would sort by edge count
  return anchors[0]?.label ?? null
}

// ─── RAG: Fallback Context Nodes ─────────────────────────────────────────────

/** Fetch anchor nodes (or most-recent nodes) to seed context when search returns empty */
export async function fetchTopNodes(
  userId: string,
  options: { limit?: number; anchorsOnly?: boolean } = {}
): Promise<KeywordNodeResult[]> {
  const { limit = 15, anchorsOnly = false } = options

  let query = supabase
    .from('knowledge_nodes')
    .select('id, label, entity_type, description, source, source_type, source_id, confidence, is_anchor, tags, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(limit)

  if (anchorsOnly) {
    query = query.eq('is_anchor', true)
  }

  const { data, error } = await query
  if (error) {
    console.warn('[supabase] fetchTopNodes failed:', error.message)
    return []
  }
  return (data ?? []) as KeywordNodeResult[]
}

// ─── YouTube Playlists ───────────────────────────────────────────────────────

export async function connectPlaylist(
  userId: string,
  playlistId: string,
  playlistUrl: string,
  metadata?: { name?: string; videoCount?: number; thumbnailUrl?: string }
): Promise<YouTubePlaylist> {
  const synapseCode = generateSynapseCode()

  // Load default extraction settings
  const { data: settings } = await supabase
    .from('extraction_settings')
    .select('default_mode, default_anchor_emphasis')
    .eq('user_id', userId)
    .maybeSingle()

  const payload: Record<string, unknown> = {
    user_id: userId,
    playlist_id: playlistId,
    playlist_url: playlistUrl,
    synapse_code: synapseCode,
    extraction_mode: settings?.default_mode ?? 'comprehensive',
    anchor_emphasis: settings?.default_anchor_emphasis ?? 'standard',
    is_active: true,
  }

  if (metadata?.name) payload.playlist_name = metadata.name
  if (metadata?.videoCount) payload.known_video_count = metadata.videoCount

  const { data, error } = await supabase
    .from('youtube_playlists')
    .insert(payload)
    .select()
    .single()

  if (error) {
    if (error.code === '23505') {
      throw new Error('This playlist is already connected.')
    }
    throw new Error(`Failed to connect playlist: ${error.message}`)
  }

  return data as YouTubePlaylist
}

export async function getConnectedPlaylists(userId: string): Promise<YouTubePlaylist[]> {
  const { data, error } = await supabase
    .from('youtube_playlists')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })

  if (error) {
    console.warn('[supabase] Failed to fetch playlists:', error.message)
    return []
  }
  return (data ?? []) as YouTubePlaylist[]
}

export async function updatePlaylistSettings(
  playlistId: string,
  settings: Partial<PlaylistSettings>
): Promise<void> {
  const payload: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  }
  if (settings.extraction_mode) payload.extraction_mode = settings.extraction_mode
  if (settings.anchor_emphasis) payload.anchor_emphasis = settings.anchor_emphasis
  if (settings.linked_anchor_ids !== undefined) payload.linked_anchor_ids = settings.linked_anchor_ids
  if (settings.custom_instructions !== undefined) payload.custom_instructions = settings.custom_instructions

  const { error } = await supabase
    .from('youtube_playlists')
    .update(payload)
    .eq('id', playlistId)

  if (error) {
    console.warn('[supabase] Failed to update playlist settings:', error.message)
  }
}

export async function disconnectPlaylist(playlistId: string): Promise<void> {
  const { error } = await supabase
    .from('youtube_playlists')
    .delete()
    .eq('id', playlistId)

  if (error) {
    throw new Error(`Failed to disconnect playlist: ${error.message}`)
  }
}

export async function togglePlaylistStatus(
  playlistId: string,
  isActive: boolean
): Promise<void> {
  const { error } = await supabase
    .from('youtube_playlists')
    .update({ is_active: isActive, updated_at: new Date().toISOString() })
    .eq('id', playlistId)

  if (error) {
    throw new Error(`Failed to update playlist status: ${error.message}`)
  }
}

// ─── YouTube Queue ───────────────────────────────────────────────────────────

export async function queueVideosForProcessing(
  videos: { video_id: string; video_title: string; video_url: string; thumbnail_url?: string; published_at?: string }[],
  _playlistId: string,
  userId: string
): Promise<number> {
  const items = videos.map(v => ({
    user_id: userId,
    video_id: v.video_id,
    video_title: v.video_title,
    video_url: v.video_url,
    thumbnail_url: v.thumbnail_url ?? null,
    published_at: v.published_at ?? null,
    status: 'pending',
    priority: 5,
  }))

  const { data, error } = await supabase
    .from('youtube_ingestion_queue')
    .upsert(items, { onConflict: 'user_id,video_id', ignoreDuplicates: true })
    .select('id')

  if (error) {
    console.warn('[supabase] Failed to queue videos:', error.message)
    return 0
  }
  return data?.length ?? 0
}

export async function getQueueStats(userId: string): Promise<QueueStats> {
  const statuses = ['pending', 'fetching_transcript', 'transcript_ready', 'extracting', 'completed', 'failed'] as const

  const counts = await Promise.all(
    statuses.map(async status => {
      const { count } = await supabase
        .from('youtube_ingestion_queue')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', userId)
        .eq('status', status)
      return { status, count: count ?? 0 }
    })
  )

  const results: Record<string, number> = {}
  for (const c of counts) {
    results[c.status] = c.count
  }

  return {
    pending: results['pending'] ?? 0,
    processing: (results['fetching_transcript'] ?? 0) + (results['transcript_ready'] ?? 0) + (results['extracting'] ?? 0),
    completed: results['completed'] ?? 0,
    failed: results['failed'] ?? 0,
  }
}

// ─── Enhanced Extraction History ─────────────────────────────────────────────

export async function getExtractionHistory(
  userId: string,
  filters?: { sourceType?: string; status?: 'completed' | 'failed' },
  pagination?: { offset: number; limit: number }
): Promise<{ sessions: ExtractionSession[]; totalCount: number }> {
  let query = supabase
    .from('extraction_sessions')
    .select(
      'id, source_name, source_type, source_content_preview, extraction_mode, anchor_emphasis, user_guidance, selected_anchor_ids, entity_count, relationship_count, extraction_duration_ms, feedback_rating, feedback_text, created_at',
      { count: 'exact' }
    )
    .eq('user_id', userId)

  if (filters?.sourceType && filters.sourceType !== 'all') {
    query = query.eq('source_type', filters.sourceType)
  }

  if (filters?.status === 'completed') {
    query = query.gt('entity_count', 0)
  } else if (filters?.status === 'failed') {
    query = query.eq('entity_count', 0)
  }

  const offset = pagination?.offset ?? 0
  const limit = pagination?.limit ?? 20

  query = query
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1)

  const { data, error, count } = await query

  if (error) {
    console.warn('[supabase] Failed to fetch extraction history:', error.message)
    return { sessions: [], totalCount: 0 }
  }

  return {
    sessions: (data ?? []) as ExtractionSession[],
    totalCount: count ?? 0,
  }
}

// ─── Automate: YouTube Settings ──────────────────────────────────────────────

export async function getYouTubeSettings(userId: string): Promise<YouTubeSettings | null> {
  try {
    const { data, error } = await supabase
      .from('youtube_settings')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle()

    if (error) throw error
    return data as YouTubeSettings | null
  } catch (err) {
    console.warn('[supabase] youtube_settings fetch failed (table may not exist):', err)
    return null
  }
}

// ─── Automate: Queue Items ───────────────────────────────────────────────────

export async function getQueueItems(
  userId: string,
  filter: QueueStatusFilter = 'all',
  pagination: { offset: number; limit: number } = { offset: 0, limit: 20 }
): Promise<{ items: QueueItem[]; totalCount: number }> {
  try {
    let query = supabase
      .from('youtube_ingestion_queue')
      .select('*', { count: 'exact' })
      .eq('user_id', userId)

    switch (filter) {
      case 'pending':
        query = query.eq('status', 'pending')
        break
      case 'processing':
        query = query.in('status', ['fetching_transcript', 'extracting'])
        break
      case 'completed':
        query = query.eq('status', 'completed')
        break
      case 'failed':
        query = query.eq('status', 'failed')
        break
    }

    query = query
      .order('created_at', { ascending: false })
      .range(pagination.offset, pagination.offset + pagination.limit - 1)

    const { data, error, count } = await query

    if (error) throw error

    return {
      items: (data ?? []) as QueueItem[],
      totalCount: count ?? 0,
    }
  } catch (err) {
    console.warn('[supabase] Queue items fetch failed:', err)
    return { items: [], totalCount: 0 }
  }
}

// ─── Automate: Queue Actions ─────────────────────────────────────────────────

export async function retryQueueItem(itemId: string): Promise<void> {
  // Check if item already has a transcript — skip re-fetching if so
  const { data: item } = await supabase
    .from('youtube_ingestion_queue')
    .select('transcript')
    .eq('id', itemId)
    .eq('status', 'failed')
    .maybeSingle()

  if (!item) throw new Error('Item not found or not in failed state')

  const newStatus = item.transcript ? 'transcript_ready' : 'pending'

  const { error } = await supabase
    .from('youtube_ingestion_queue')
    .update({
      status: newStatus,
      error_message: null,
      started_at: null,
      completed_at: null,
    })
    .eq('id', itemId)
    .eq('status', 'failed')

  if (error) throw new Error(`Failed to retry item: ${error.message}`)
}

export async function cancelQueueItem(itemId: string): Promise<void> {
  const { error } = await supabase
    .from('youtube_ingestion_queue')
    .update({ status: 'skipped' })
    .eq('id', itemId)
    .eq('status', 'pending')

  if (error) throw new Error(`Failed to cancel item: ${error.message}`)
}

export async function reQueueItem(itemId: string): Promise<void> {
  const { error } = await supabase
    .from('youtube_ingestion_queue')
    .update({
      status: 'pending',
      error_message: null,
      started_at: null,
      completed_at: null,
    })
    .eq('id', itemId)
    .eq('status', 'skipped')

  if (error) throw new Error(`Failed to re-queue item: ${error.message}`)
}

export async function clearCompletedItems(userId: string): Promise<number> {
  try {
    const { data, error } = await supabase
      .from('youtube_ingestion_queue')
      .delete()
      .eq('user_id', userId)
      .eq('status', 'completed')
      .select('id')

    if (error) throw error
    return data?.length ?? 0
  } catch (err) {
    console.warn('[supabase] clearCompletedItems failed:', err)
    return 0
  }
}

// ─── Automate: Scan History ──────────────────────────────────────────────────

export async function getScanHistory(
  userId: string,
  limit: number = 10
): Promise<ScanHistoryEntry[]> {
  try {
    const { data, error } = await supabase
      .from('youtube_scan_history')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(limit)

    if (error) throw error
    return (data ?? []) as ScanHistoryEntry[]
  } catch (err) {
    console.warn('[supabase] youtube_scan_history fetch failed (table may not exist):', err)
    return []
  }
}

// ─── Automate: Automation Summary ────────────────────────────────────────────

export async function getAutomationSummary(userId: string): Promise<AutomationSummary> {
  const [
    playlistData,
    meetingCount,
    extensionCount,
    queueStatsResult,
    lastCompletedAt,
  ] = await Promise.all([
    (async () => {
      try {
        const { data } = await supabase
          .from('youtube_playlists')
          .select('is_active, known_video_count')
          .eq('user_id', userId)
        return (data ?? []) as { is_active: boolean; known_video_count: number }[]
      } catch { return [] as { is_active: boolean; known_video_count: number }[] }
    })(),
    (async () => {
      try {
        const { count } = await supabase
          .from('knowledge_sources')
          .select('id', { count: 'exact', head: true })
          .eq('user_id', userId)
          .eq('source_type', 'Meeting')
        return count ?? 0
      } catch { return 0 }
    })(),
    (async () => {
      try {
        const { count } = await supabase
          .from('knowledge_sources')
          .select('id', { count: 'exact', head: true })
          .eq('user_id', userId)
          .contains('metadata', { source: 'chrome_extension' })
        return count ?? 0
      } catch { return 0 }
    })(),
    getQueueStats(userId).catch(() => ({ pending: 0, processing: 0, completed: 0, failed: 0 })),
    (async () => {
      try {
        const { data } = await supabase
          .from('youtube_ingestion_queue')
          .select('completed_at')
          .eq('user_id', userId)
          .eq('status', 'completed')
          .order('completed_at', { ascending: false })
          .limit(1)
          .maybeSingle()
        return (data?.completed_at as string) ?? null
      } catch { return null }
    })(),
  ])

  return {
    youtube: {
      playlistCount: playlistData.length,
      activePlaylistCount: playlistData.filter(p => p.is_active).length,
      totalPlaylistVideos: playlistData.reduce((sum, p) => sum + (p.known_video_count ?? 0), 0),
    },
    meetings: {
      totalMeetings: meetingCount,
      circlebackConnected: meetingCount > 0,
    },
    extension: {
      captureCount: extensionCount,
      connected: extensionCount > 0,
    },
    queue: {
      ...queueStatsResult,
      lastCompletedAt: lastCompletedAt,
    },
  }
}

// ─── Digest History ────────────────────────────────────────────────────────────

export async function fetchDigestHistory(
  profileId: string,
  limit = 5
): Promise<DigestHistoryEntry[]> {
  const { data, error } = await supabase
    .from('digest_history')
    .select('*')
    .eq('digest_profile_id', profileId)
    .order('generated_at', { ascending: false })
    .limit(limit)

  if (error) {
    console.warn('fetchDigestHistory error:', error)
    return []
  }
  return (data ?? []) as DigestHistoryEntry[]
}

export async function saveDigestHistory(
  entry: Omit<DigestHistoryEntry, 'id' | 'created_at'>
): Promise<void> {
  const { error } = await supabase.from('digest_history').insert(entry)
  if (error) throw new Error(error.message)
}

// ─── Digest Profile CRUD ───────────────────────────────────────────────────────

export async function createDigestProfile(
  profile: {
    title: string
    frequency: 'daily' | 'weekly' | 'monthly'
    density: 'brief' | 'standard' | 'comprehensive'
    schedule_time: string
    schedule_timezone: string
    is_active?: boolean
  },
  modules: DigestModuleInput[],
  channels: DigestChannelInput[]
): Promise<string> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')

  const { data: profileData, error: profileError } = await supabase
    .from('digest_profiles')
    .insert({ ...profile, user_id: user.id })
    .select('id')
    .single()

  if (profileError) throw new Error(profileError.message)
  const profileId = profileData.id

  if (modules.length > 0) {
    const moduleRows = modules.map((m, i) => ({
      digest_profile_id: profileId,
      user_id: user.id,
      template_id: m.template_id,
      custom_context: m.custom_context ?? null,
      sort_order: m.sort_order ?? i,
      is_active: true,
    }))
    const { error: modulesError } = await supabase.from('digest_modules').insert(moduleRows)
    if (modulesError) throw new Error(modulesError.message)
  }

  if (channels.length > 0) {
    const channelRows = channels.map(c => ({
      digest_profile_id: profileId,
      user_id: user.id,
      channel_type: c.channel_type,
      config: c.config,
      density_override: c.density_override ?? null,
      is_active: true,
    }))
    const { error: channelsError } = await supabase.from('digest_channels').insert(channelRows)
    if (channelsError) throw new Error(channelsError.message)
  }

  return profileId
}

export async function updateDigestProfile(
  profileId: string,
  profile: {
    title: string
    frequency: 'daily' | 'weekly' | 'monthly'
    density: 'brief' | 'standard' | 'comprehensive'
    schedule_time: string
    schedule_timezone: string
    is_active?: boolean
  },
  modules: DigestModuleInput[],
  channels: DigestChannelInput[]
): Promise<void> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')

  const { error: profileError } = await supabase
    .from('digest_profiles')
    .update({ ...profile, updated_at: new Date().toISOString() })
    .eq('id', profileId)
    .eq('user_id', user.id)

  if (profileError) throw new Error(profileError.message)

  // Replace modules: delete then re-insert
  await supabase.from('digest_modules').delete().eq('digest_profile_id', profileId)
  if (modules.length > 0) {
    const moduleRows = modules.map((m, i) => ({
      digest_profile_id: profileId,
      user_id: user.id,
      template_id: m.template_id,
      custom_context: m.custom_context ?? null,
      sort_order: m.sort_order ?? i,
      is_active: true,
    }))
    const { error: modulesError } = await supabase.from('digest_modules').insert(moduleRows)
    if (modulesError) throw new Error(modulesError.message)
  }

  // Replace channels: delete then re-insert
  await supabase.from('digest_channels').delete().eq('digest_profile_id', profileId)
  if (channels.length > 0) {
    const channelRows = channels.map(c => ({
      digest_profile_id: profileId,
      user_id: user.id,
      channel_type: c.channel_type,
      config: c.config,
      density_override: c.density_override ?? null,
      is_active: true,
    }))
    const { error: channelsError } = await supabase.from('digest_channels').insert(channelRows)
    if (channelsError) throw new Error(channelsError.message)
  }
}

export async function deleteDigestProfile(profileId: string): Promise<void> {
  const { error } = await supabase
    .from('digest_profiles')
    .delete()
    .eq('id', profileId)
  if (error) throw new Error(error.message)
  // digest_modules, digest_channels, digest_history cascade-delete via FK
}

// ─── Pipeline: History ───────────────────────────────────────────────────────

export interface PipelineSession {
  id: string
  source_name: string | null
  source_type: string | null
  source_content_preview: string | null
  extraction_mode: string
  anchor_emphasis: string
  user_guidance: string | null
  selected_anchor_ids: string[] | null
  entity_count: number
  relationship_count: number
  chunk_count: number
  cross_connection_count: number
  extraction_duration_ms: number | null
  feedback_rating: number | null
  feedback_text: string | null
  created_at: string
  extracted_node_ids: string[] | null
  extracted_edge_ids: string[] | null
  _provider?: string | null
}

export async function fetchPipelineHistory(
  userId: string,
  limit: number = 20,
  offset: number = 0
): Promise<{ sessions: PipelineSession[]; totalCount: number }> {
  try {
    const { data, error, count } = await supabase
      .from('extraction_sessions')
      .select(
        'id, source_name, source_type, source_content_preview, extraction_mode, anchor_emphasis, user_guidance, selected_anchor_ids, entity_count, relationship_count, chunk_count, cross_connection_count, extraction_duration_ms, feedback_rating, feedback_text, created_at, extracted_node_ids, extracted_edge_ids',
        { count: 'exact' }
      )
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1)

    if (error) {
      console.warn('[supabase] fetchPipelineHistory failed:', error.message)
      return { sessions: [], totalCount: 0 }
    }

    return { sessions: (data ?? []) as PipelineSession[], totalCount: count ?? 0 }
  } catch (err) {
    console.warn('[supabase] extraction_sessions table may not exist:', err)
    return { sessions: [], totalCount: 0 }
  }
}

export async function fetchActiveQueueItems(userId: string): Promise<PipelineSession[]> {
  try {
    const { data, error } = await supabase
      .from('youtube_ingestion_queue')
      .select('id, video_title, status, created_at, started_at, channel_id')
      .eq('user_id', userId)
      .in('status', ['pending', 'fetching_transcript', 'transcript_ready', 'extracting'])
      .order('created_at', { ascending: false })

    if (error) {
      console.warn('[supabase] fetchActiveQueueItems failed:', error.message)
      return []
    }

    // Map queue items to PipelineSession shape
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (data ?? []).map((item: any) => ({
      id: item.id,
      source_name: item.video_title ?? 'Untitled Video',
      source_type: 'YouTube',
      source_content_preview: null,
      extraction_mode: 'comprehensive',
      anchor_emphasis: 'standard',
      user_guidance: null,
      selected_anchor_ids: null,
      entity_count: 0,
      relationship_count: 0,
      chunk_count: 0,
      cross_connection_count: 0,
      extraction_duration_ms: null,
      feedback_rating: null,
      feedback_text: null,
      created_at: item.created_at,
      extracted_node_ids: null,
      extracted_edge_ids: null,
      _queueStatus: item.status,
      _provider: 'youtube',
    })) as PipelineSession[]
  } catch (err) {
    console.warn('[supabase] youtube_ingestion_queue fetch failed:', err)
    return []
  }
}

export async function fetchActiveMeetingItems(userId: string): Promise<PipelineSession[]> {
  try {
    // Use proven .contains() pattern for JSONB filtering (two queries for OR)
    const [pendingRes, processingRes] = await Promise.all([
      supabase
        .from('knowledge_sources')
        .select('id, title, metadata, created_at')
        .eq('user_id', userId)
        .eq('source_type', 'Meeting')
        .contains('metadata', { extraction_status: 'pending' })
        .order('created_at', { ascending: false }),
      supabase
        .from('knowledge_sources')
        .select('id, title, metadata, created_at')
        .eq('user_id', userId)
        .eq('source_type', 'Meeting')
        .contains('metadata', { extraction_status: 'processing' })
        .order('created_at', { ascending: false }),
    ])

    if (pendingRes.error) console.warn('[supabase] fetchActiveMeetingItems (pending):', pendingRes.error.message)
    if (processingRes.error) console.warn('[supabase] fetchActiveMeetingItems (processing):', processingRes.error.message)

    const allItems = [...(pendingRes.data ?? []), ...(processingRes.data ?? [])]

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return allItems.map((item: any) => {
      const meta = item.metadata as Record<string, unknown> | null
      const extractionStatus = (meta?.extraction_status as string) ?? 'pending'
      return {
        id: item.id,
        source_name: item.title ?? 'Untitled Meeting',
        source_type: 'Meeting',
        source_content_preview: null,
        extraction_mode: 'comprehensive',
        anchor_emphasis: 'standard',
        user_guidance: null,
        selected_anchor_ids: null,
        entity_count: 0,
        relationship_count: 0,
        chunk_count: 0,
        cross_connection_count: 0,
        extraction_duration_ms: null,
        feedback_rating: null,
        feedback_text: null,
        created_at: item.created_at,
        extracted_node_ids: null,
        extracted_edge_ids: null,
        _queueStatus: extractionStatus === 'processing' ? 'extracting' : 'pending',
        _provider: (meta?.provider as string) ?? 'circleback',
      }
    }) as PipelineSession[]
  } catch (err) {
    console.warn('[supabase] fetchActiveMeetingItems failed:', err)
    return []
  }
}

// ─── Pipeline: Heatmap Data ─────────────────────────────────────────────────

export interface HeatmapRawSession {
  created_at: string
  entity_count: number
  relationship_count: number
  extraction_duration_ms: number | null
  source_type: string | null
}

export async function fetchHeatmapSessions(userId: string): Promise<HeatmapRawSession[]> {
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - 91)

  try {
    const { data, error } = await supabase
      .from('extraction_sessions')
      .select('created_at, entity_count, relationship_count, extraction_duration_ms, source_type')
      .eq('user_id', userId)
      .gte('created_at', cutoff.toISOString())
      .order('created_at', { ascending: true })

    if (error) {
      console.warn('[supabase] fetchHeatmapSessions failed:', error.message)
      return []
    }

    return (data ?? []) as HeatmapRawSession[]
  } catch (err) {
    console.warn('[supabase] heatmap sessions fetch failed:', err)
    return []
  }
}

// ─── Pipeline: Entity Breakdown ─────────────────────────────────────────────

export async function fetchEntityBreakdownByIds(
  nodeIds: string[]
): Promise<Record<string, number>> {
  if (nodeIds.length === 0) return {}

  try {
    const { data, error } = await supabase
      .from('knowledge_nodes')
      .select('entity_type')
      .in('id', nodeIds)

    if (error) {
      console.warn('[supabase] fetchEntityBreakdown failed:', error.message)
      return {}
    }

    const breakdown: Record<string, number> = {}
    for (const row of data ?? []) {
      const t = (row as { entity_type: string }).entity_type
      breakdown[t] = (breakdown[t] ?? 0) + 1
    }
    return breakdown
  } catch {
    return {}
  }
}

// ─── Pipeline: Rating ───────────────────────────────────────────────────────

export async function updateExtractionRating(
  sessionId: string,
  rating: number,
  text?: string
): Promise<void> {
  const updates: Record<string, unknown> = { feedback_rating: rating }
  if (text !== undefined) updates.feedback_text = text

  const { error } = await supabase
    .from('extraction_sessions')
    .update(updates)
    .eq('id', sessionId)

  if (error) throw new Error(`Failed to save rating: ${error.message}`)
}

// ─── Pipeline: Delete Extraction ────────────────────────────────────────────

export async function deleteExtractionSession(
  sessionId: string,
  nodeIds?: string[],
  edgeIds?: string[]
): Promise<void> {
  // Delete edges first (FK constraint)
  if (edgeIds && edgeIds.length > 0) {
    await supabase.from('knowledge_edges').delete().in('id', edgeIds)
  }

  // Delete nodes
  if (nodeIds && nodeIds.length > 0) {
    await supabase.from('knowledge_nodes').delete().in('id', nodeIds)
  }

  // Delete the session
  const { error } = await supabase
    .from('extraction_sessions')
    .delete()
    .eq('id', sessionId)

  if (error) throw new Error(`Failed to delete extraction: ${error.message}`)
}
