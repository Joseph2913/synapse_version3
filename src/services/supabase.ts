import { createClient } from '@supabase/supabase-js'
import type { UserProfile, ExtractionSettings, KnowledgeNode, KnowledgeEdge, KnowledgeSource, KnowledgeSkill, DomainAgent, AgentStandingQuestion, AgentInsightRow, AgentGapRow, AgentSignalRow } from '../types/database'
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
    .eq('is_merged', false)
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
    .eq('is_merged', false)
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
    .eq('is_merged', false)
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
  userId: string
): Promise<Set<string>> {
  if (labels.length === 0) return new Set()

  const lowerLabels = labels.map(l => l.toLowerCase())
  const { data, error } = await supabase
    .from('knowledge_nodes')
    .select('label')
    .eq('user_id', userId)
    .eq('is_merged', false)
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
    supabase.from('knowledge_nodes').select('id', { count: 'exact', head: true }).eq('user_id', userId).eq('is_merged', false),
    supabase.from('source_chunks').select('id', { count: 'exact', head: true }).eq('user_id', userId).not('embedding', 'is', null),
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
    .from('source_chunks')
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
    .from('source_chunks')
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
    .eq('is_merged', false)
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

// ─── RAG: Relationship Search (edge embeddings, PRD-RAG-05) ────────────────

export interface RelationshipMatch {
  id: string
  source_node_id: string
  target_node_id: string
  relation_type: string | null
  evidence: string | null
  weight: number | null
  source_label: string
  source_type: string
  target_label: string
  target_type: string
  similarity: number
}

/** Semantic search over relationship edges using vector cosine similarity (match_relationships RPC). */
export async function searchRelationships(
  embedding: number[],
  userId: string,
  options: { matchThreshold?: number; matchCount?: number } = {}
): Promise<RelationshipMatch[]> {
  if (!embedding || embedding.length === 0) return []
  const { matchThreshold = 0.65, matchCount = 10 } = options

  const { data, error } = await supabase.rpc('match_relationships', {
    query_embedding: embedding,
    match_threshold: matchThreshold,
    match_count: matchCount,
    p_user_id: userId,
  })

  if (error) {
    console.warn('[searchRelationships] RPC failed:', error.message)
    return []
  }

  return (data ?? []) as RelationshipMatch[]
}

// ─── RAG: Chronological Entity Mentions (PRD-RAG-01) ────────────────────────

export interface EntityMention {
  chunk_content: string
  source_id: string
  source_title: string
  source_type: string
  source_created_at: string
  chunk_index: number
}

/**
 * Fetches source chunks mentioning an entity label, ordered by source creation date.
 * Used by synthesis queries to build chronological entity evolution context.
 */
export async function fetchEntitySourceMentions(
  entityLabel: string,
  userId: string,
  limit: number = 5
): Promise<EntityMention[]> {
  if (!entityLabel || entityLabel.length < 2) return []

  const { data, error } = await supabase
    .from('source_chunks')
    .select(`
      content,
      chunk_index,
      source_id,
      knowledge_sources!inner (
        title,
        source_type,
        created_at
      )
    `)
    .eq('user_id', userId)
    .ilike('content', `%${entityLabel}%`)
    .order('chunk_index', { ascending: true })
    .limit(limit)

  if (error || !data) {
    console.warn('[fetchEntitySourceMentions] Query failed:', error?.message)
    return []
  }

  return data.map(row => {
    const source = row.knowledge_sources as unknown as { title: string; source_type: string; created_at: string }
    return {
      chunk_content: row.content,
      source_id: row.source_id,
      source_title: source.title ?? 'Unknown Source',
      source_type: source.source_type ?? 'Document',
      source_created_at: source.created_at,
      chunk_index: row.chunk_index,
    }
  })
    // Sort by source creation date after fetch (can't sort by joined table in supabase-js)
    .sort((a, b) => new Date(a.source_created_at).getTime() - new Date(b.source_created_at).getTime())
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

  // Batch node fetches to avoid Supabase URL length limits with large .in() arrays
  const BATCH_SIZE = 50
  const allNodes: KnowledgeNode[] = []
  for (let i = 0; i < allNodeIds.length; i += BATCH_SIZE) {
    const batch = allNodeIds.slice(i, i + BATCH_SIZE)
    const { data: nodes, error: nodeError } = await supabase
      .from('knowledge_nodes')
      .select('id, user_id, label, entity_type, description, source, source_type, source_url, source_id, confidence, is_anchor, tags, user_tags, quote, created_at')
      .in('id', batch)

    if (nodeError) {
      console.warn('[supabase] Node fetch in traversal failed (batch):', nodeError.message)
      continue
    }
    allNodes.push(...((nodes ?? []) as KnowledgeNode[]))
  }

  return {
    nodes: allNodes,
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
    .eq('is_merged', false)
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

// ─── PRD-17: Source Content Fetch (fallback when chunks are empty) ───────────

/**
 * Fetch full source records including content for generating synthetic chunks.
 * Used when source_chunks table has no entries for a given source.
 */
export async function fetchSourcesWithContent(
  sourceIds: string[]
): Promise<Map<string, KnowledgeSource>> {
  if (sourceIds.length === 0) return new Map()
  const { data, error } = await supabase
    .from('knowledge_sources')
    .select('*')
    .in('id', sourceIds)

  if (error || !data) return new Map()
  return new Map((data as KnowledgeSource[]).map(s => [s.id, s]))
}

// ─── PRD-17: Scoped Retrieval Functions ──────────────────────────────────────

/**
 * Fetch all chunks for a single source, ordered by chunk_index.
 */
export async function fetchAllChunksForSource(
  sourceId: string,
  _userId: string,
  limit = 30
): Promise<SemanticChunkResult[]> {
  const { data, error } = await supabase
    .from('source_chunks')
    .select('id, source_id, chunk_index, content')
    .eq('source_id', sourceId)
    .order('chunk_index', { ascending: true })
    .limit(limit)

  if (error) {
    console.warn('[supabase] fetchAllChunksForSource failed:', error.message)
    return []
  }

  return (data ?? []).map(row => ({
    id: row.id,
    source_id: row.source_id,
    chunk_index: row.chunk_index,
    content: row.content,
    similarity: 1.0,
  }))
}

/**
 * Fetch all entities extracted from a specific source.
 */
export async function fetchEntitiesForSource(
  sourceId: string,
  _userId: string
): Promise<KnowledgeNode[]> {
  const { data, error } = await supabase
    .from('knowledge_nodes')
    .select('*')
    .eq('source_id', sourceId)
    .eq('is_merged', false)

  if (error) {
    console.warn('[supabase] fetchEntitiesForSource failed:', error.message)
    return []
  }

  return (data ?? []) as KnowledgeNode[]
}

/**
 * Fetch edges where BOTH endpoints are within a given entity set.
 */
export async function fetchEdgesBetweenEntities(
  entityIds: string[],
  _userId: string
): Promise<KnowledgeEdge[]> {
  if (entityIds.length === 0) return []

  const { data, error } = await supabase
    .from('knowledge_edges')
    .select('*')
    .in('source_node_id', entityIds)
    .in('target_node_id', entityIds)

  if (error) {
    console.warn('[supabase] fetchEdgesBetweenEntities failed:', error.message)
    return []
  }

  return (data ?? []) as KnowledgeEdge[]
}

/**
 * Fetch edges crossing between two entity sets (A→B or B→A).
 */
export async function fetchCrossSourceEdges(
  setA: string[],
  setB: string[],
  _userId: string
): Promise<KnowledgeEdge[]> {
  if (setA.length === 0 || setB.length === 0) return []

  const [forwardResult, reverseResult] = await Promise.all([
    supabase
      .from('knowledge_edges')
      .select('*')
      .in('source_node_id', setA)
      .in('target_node_id', setB),
    supabase
      .from('knowledge_edges')
      .select('*')
      .in('source_node_id', setB)
      .in('target_node_id', setA),
  ])

  const forward = (forwardResult.data ?? []) as KnowledgeEdge[]
  const reverse = (reverseResult.data ?? []) as KnowledgeEdge[]

  // Deduplicate
  const seen = new Set<string>()
  const result: KnowledgeEdge[] = []
  for (const edge of [...forward, ...reverse]) {
    if (!seen.has(edge.id)) {
      seen.add(edge.id)
      result.push(edge)
    }
  }
  return result
}

/**
 * Fetch edges crossing between N entity sets (all pairwise combinations).
 * For sets [A, B, C], fetches edges A↔B, A↔C, B↔C.
 */
export async function fetchCrossSourceEdgesMulti(
  entitySets: string[][],
  _userId: string
): Promise<KnowledgeEdge[]> {
  if (entitySets.length < 2) return []

  // Collect all pairwise fetch promises
  const pairs: Promise<KnowledgeEdge[]>[] = []
  for (let i = 0; i < entitySets.length; i++) {
    for (let j = i + 1; j < entitySets.length; j++) {
      pairs.push(fetchCrossSourceEdges(entitySets[i]!, entitySets[j]!, _userId))
    }
  }

  const results = await Promise.all(pairs)
  // Deduplicate across all pairs
  const seen = new Set<string>()
  const merged: KnowledgeEdge[] = []
  for (const edges of results) {
    for (const edge of edges) {
      if (!seen.has(edge.id)) {
        seen.add(edge.id)
        merged.push(edge)
      }
    }
  }
  return merged
}

/**
 * Fetch all first-degree edges for a single entity.
 */
export async function fetchEntityDirectEdges(
  entityId: string,
  _userId: string
): Promise<KnowledgeEdge[]> {
  const { data, error } = await supabase
    .from('knowledge_edges')
    .select('*')
    .or(`source_node_id.eq.${entityId},target_node_id.eq.${entityId}`)

  if (error) {
    console.warn('[supabase] fetchEntityDirectEdges failed:', error.message)
    return []
  }

  return (data ?? []) as KnowledgeEdge[]
}

/**
 * Fetch a node including its embedding vector.
 */
export async function fetchNodeWithEmbedding(
  nodeId: string,
  _userId: string
): Promise<(KnowledgeNode & { embedding: number[] | null }) | null> {
  const { data, error } = await supabase
    .from('knowledge_nodes')
    .select('*, embedding')
    .eq('id', nodeId)
    .maybeSingle()

  if (error) {
    console.warn('[supabase] fetchNodeWithEmbedding failed:', error.message)
    return null
  }

  return data as (KnowledgeNode & { embedding: number[] | null }) | null
}

/**
 * Fetch a node's stored embedding vector by ID.
 * Used by "Find Similar" to search with the entity's own vector
 * rather than generating a new embedding from the question text.
 */
export async function fetchNodeEmbedding(
  nodeId: string
): Promise<number[] | null> {
  const { data, error } = await supabase
    .from('knowledge_nodes')
    .select('embedding')
    .eq('id', nodeId)
    .maybeSingle()

  if (error) {
    console.warn('[supabase] fetchNodeEmbedding failed:', error.message)
    return null
  }

  return (data as { embedding: number[] | null } | null)?.embedding ?? null
}

/**
 * Fetch all entities extracted from a specific source, returning full node records.
 * Alias for fetchEntitiesForSource — matches PRD-A naming convention.
 */
export async function fetchNodesForSource(
  sourceId: string,
  userId: string,
  limit: number = 50
): Promise<KnowledgeNode[]> {
  const { data, error } = await supabase
    .from('knowledge_nodes')
    .select('*')
    .eq('user_id', userId)
    .eq('source_id', sourceId)
    .limit(limit)

  if (error) {
    console.warn('[supabase] fetchNodesForSource failed:', error.message)
    return []
  }

  return (data ?? []) as KnowledgeNode[]
}

/**
 * Fetch all edges directly connected to a specific node.
 * Returns edges where the node is either source or target.
 */
export async function fetchDirectEdges(
  nodeId: string,
  userId: string,
  limit: number = 20
): Promise<KnowledgeEdge[]> {
  const { data, error } = await supabase
    .from('knowledge_edges')
    .select('*')
    .eq('user_id', userId)
    .or(`source_node_id.eq.${nodeId},target_node_id.eq.${nodeId}`)
    .limit(limit)

  if (error) {
    console.warn('[supabase] fetchDirectEdges failed:', error.message)
    return []
  }

  return (data ?? []) as KnowledgeEdge[]
}

// ─── HOME DASHBOARD QUERIES ─────────────────────────────────────────────

export interface HomeDashboardStats {
  totalSources: number
  totalNodes: number
  activeAnchors: number
  activeSkills: number
  sourcesDelta7d: number
  nodesDelta7d: number
  anchorsDelta7d: number
  skillsDelta7d: number
}

export async function fetchHomeDashboardStats(): Promise<HomeDashboardStats> {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()

  const [
    sourcesTotal, nodesTotal, anchorsTotal, skillsTotal,
    sourcesDelta, nodesDelta, anchorsDelta, skillsDelta,
  ] = await Promise.all([
    supabase.from('knowledge_sources').select('id', { count: 'exact', head: true }),
    supabase.from('knowledge_nodes').select('id', { count: 'exact', head: true }),
    supabase.from('knowledge_nodes').select('id', { count: 'exact', head: true }).eq('is_anchor', true),
    supabase.from('knowledge_skills').select('id', { count: 'exact', head: true }),
    supabase.from('knowledge_sources').select('id', { count: 'exact', head: true }).gte('created_at', sevenDaysAgo),
    supabase.from('knowledge_nodes').select('id', { count: 'exact', head: true }).gte('created_at', sevenDaysAgo),
    supabase.from('knowledge_nodes').select('id', { count: 'exact', head: true }).eq('is_anchor', true).gte('created_at', sevenDaysAgo),
    supabase.from('knowledge_skills').select('id', { count: 'exact', head: true }).gte('created_at', sevenDaysAgo),
  ])

  return {
    totalSources: sourcesTotal.count ?? 0,
    totalNodes: nodesTotal.count ?? 0,
    activeAnchors: anchorsTotal.count ?? 0,
    activeSkills: skillsTotal.count ?? 0,
    sourcesDelta7d: sourcesDelta.count ?? 0,
    nodesDelta7d: nodesDelta.count ?? 0,
    anchorsDelta7d: anchorsDelta.count ?? 0,
    skillsDelta7d: skillsDelta.count ?? 0,
  }
}

export async function fetchRecentSources(limit = 5): Promise<KnowledgeSource[]> {
  const { data, error } = await supabase
    .from('knowledge_sources')
    .select('id, title, source_type, source_url, metadata, summary, created_at')
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error) {
    console.error('[supabase] fetchRecentSources failed:', error.message)
    return []
  }
  return (data ?? []) as KnowledgeSource[]
}

export async function fetchSourceEntityCounts(
  sourceIds: string[]
): Promise<Record<string, number>> {
  if (sourceIds.length === 0) return {}

  const { data, error } = await supabase
    .from('knowledge_nodes')
    .select('source_id')
    .in('source_id', sourceIds)

  if (error || !data) return {}

  const counts: Record<string, number> = {}
  for (const row of data as { source_id: string | null }[]) {
    if (row.source_id) {
      counts[row.source_id] = (counts[row.source_id] ?? 0) + 1
    }
  }
  return counts
}

export async function fetchRecentAnchors(limit = 4): Promise<KnowledgeNode[]> {
  const { data, error } = await supabase
    .from('knowledge_nodes')
    .select('id, label, entity_type, description, is_anchor, created_at, user_id, source_id')
    .eq('is_anchor', true)
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error) {
    console.error('[supabase] fetchRecentAnchors failed:', error.message)
    return []
  }
  return (data ?? []) as KnowledgeNode[]
}

export async function fetchAnchorConnectionCounts(
  anchorIds: string[]
): Promise<Record<string, number>> {
  if (anchorIds.length === 0) return {}

  const orFilter = anchorIds
    .map(id => `source_node_id.eq.${id},target_node_id.eq.${id}`)
    .join(',')

  const { data, error } = await supabase
    .from('knowledge_edges')
    .select('source_node_id, target_node_id')
    .or(orFilter)

  if (error || !data) return {}

  const counts: Record<string, number> = {}
  for (const edge of data as { source_node_id: string; target_node_id: string }[]) {
    for (const id of anchorIds) {
      if (edge.source_node_id === id || edge.target_node_id === id) {
        counts[id] = (counts[id] ?? 0) + 1
      }
    }
  }
  return counts
}

// TODO: verify skills table — if knowledge_skills doesn't exist, fall back to
// knowledge_nodes WHERE entity_type = 'Skill'
export async function fetchRecentSkills(limit = 3): Promise<KnowledgeSkill[]> {
  const { data, error } = await supabase
    .from('knowledge_skills')
    .select('id, name, title, description, domain, status, confidence, created_at, user_id, tags, content, source_ids, source_count, instructional_ratio, generalizability, structural_density, embedding, usage_count, last_used_at, updated_at')
    .order('usage_count', { ascending: false })
    .order('confidence', { ascending: false })
    .limit(limit)

  if (error) {
    console.error('[supabase] fetchRecentSkills failed:', error.message)
    return []
  }
  return (data ?? []) as KnowledgeSkill[]
}

export interface CrossConnectionEdge {
  id: string
  sourceNode: { id: string; label: string; entity_type: string; source_id: string }
  targetNode: { id: string; label: string; entity_type: string; source_id: string }
  relation_type: string
  sourceTitles: string[]
  created_at: string
}

export async function fetchCrossConnectionEdges(
  limit = 5
): Promise<CrossConnectionEdge[]> {
  // Step 1: Fetch recent edges
  const { data: edges, error: edgeError } = await supabase
    .from('knowledge_edges')
    .select('id, relation_type, created_at, source_node_id, target_node_id')
    .order('created_at', { ascending: false })
    .limit(limit * 3)

  if (edgeError || !edges || edges.length === 0) return []

  // Step 2: Collect all node IDs and fetch nodes
  const nodeIds = new Set<string>()
  for (const edge of edges as { source_node_id: string; target_node_id: string }[]) {
    nodeIds.add(edge.source_node_id)
    nodeIds.add(edge.target_node_id)
  }

  const { data: nodes, error: nodeError } = await supabase
    .from('knowledge_nodes')
    .select('id, label, entity_type, source_id')
    .in('id', Array.from(nodeIds))

  if (nodeError || !nodes) return []

  const nodeMap = new Map<string, { id: string; label: string; entity_type: string; source_id: string | null }>()
  for (const n of nodes as { id: string; label: string; entity_type: string; source_id: string | null }[]) {
    nodeMap.set(n.id, n)
  }

  // Step 3: Filter to cross-source edges (source_id on both nodes must differ)
  const crossEdges: Array<{
    id: string
    relation_type: string
    created_at: string
    sn: { id: string; label: string; entity_type: string; source_id: string }
    tn: { id: string; label: string; entity_type: string; source_id: string }
  }> = []

  for (const edge of edges as { id: string; relation_type: string | null; created_at: string; source_node_id: string; target_node_id: string }[]) {
    const sn = nodeMap.get(edge.source_node_id)
    const tn = nodeMap.get(edge.target_node_id)
    if (!sn?.source_id || !tn?.source_id) continue
    if (sn.source_id === tn.source_id) continue
    crossEdges.push({
      id: edge.id,
      relation_type: edge.relation_type ?? 'relates_to',
      created_at: edge.created_at,
      sn: { id: sn.id, label: sn.label, entity_type: sn.entity_type, source_id: sn.source_id },
      tn: { id: tn.id, label: tn.label, entity_type: tn.entity_type, source_id: tn.source_id },
    })
    if (crossEdges.length >= limit) break
  }

  if (crossEdges.length === 0) return []

  // Step 4: Fetch source titles for attribution
  const sourceIdSet = new Set<string>()
  for (const ce of crossEdges) {
    sourceIdSet.add(ce.sn.source_id)
    sourceIdSet.add(ce.tn.source_id)
  }

  const { data: sources } = await supabase
    .from('knowledge_sources')
    .select('id, title')
    .in('id', Array.from(sourceIdSet))

  const sourceMap = new Map<string, string>()
  if (sources) {
    for (const s of sources as { id: string; title: string | null }[]) {
      sourceMap.set(s.id, s.title ?? 'Untitled')
    }
  }

  return crossEdges.map(ce => ({
    id: ce.id,
    sourceNode: ce.sn,
    targetNode: ce.tn,
    relation_type: ce.relation_type,
    sourceTitles: [
      sourceMap.get(ce.sn.source_id) ?? 'Untitled',
      sourceMap.get(ce.tn.source_id) ?? 'Untitled',
    ],
    created_at: ce.created_at,
  }))
}

export interface PipelineStatus {
  lastScanAt: string | null
  lastScanVideosFound: number
  pendingQueueCount: number
  failedQueueCount: number
  lastProcessedSource: { title: string; created_at: string } | null
}

export async function fetchPipelineStatus(): Promise<PipelineStatus> {
  type ScanRow = { created_at: string; videos_found: number }
  type SourceRow = { title: string | null; created_at: string }

  let scanData: ScanRow | null = null
  let pendingCount = 0
  let failedCount = 0
  let lastSource: SourceRow | null = null

  try {
    const scanResult = await supabase
      .from('youtube_scan_history')
      .select('created_at, videos_found')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    scanData = scanResult.data as ScanRow | null
  } catch { /* youtube tables may not exist */ }

  try {
    const pendingResult = await supabase
      .from('youtube_ingestion_queue')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'pending')
    pendingCount = pendingResult.count ?? 0
  } catch { /* ignore */ }

  try {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
    const failedResult = await supabase
      .from('youtube_ingestion_queue')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'failed')
      .gte('created_at', sevenDaysAgo)
    failedCount = failedResult.count ?? 0
  } catch { /* ignore */ }

  try {
    const sourceResult = await supabase
      .from('knowledge_sources')
      .select('title, created_at')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    lastSource = sourceResult.data as SourceRow | null
  } catch { /* ignore */ }

  return {
    lastScanAt: scanData?.created_at ?? null,
    lastScanVideosFound: scanData?.videos_found ?? 0,
    pendingQueueCount: pendingCount,
    failedQueueCount: failedCount,
    lastProcessedSource: lastSource
      ? { title: lastSource.title ?? 'Untitled', created_at: lastSource.created_at }
      : null,
  }
}

export interface KnowledgeSnapshot {
  entityTypeCounts: Array<{ entity_type: string; count: number }>
  topAnchors: Array<{ id: string; label: string; entity_type: string; connectionCount: number }>
  sourceTypeCounts: Array<{ source_type: string; count: number }>
}

export async function fetchKnowledgeSnapshot(): Promise<KnowledgeSnapshot> {
  // Query 1: Entity type distribution
  const { data: entityData } = await supabase
    .from('knowledge_nodes')
    .select('entity_type')

  const entityCounts: Record<string, number> = {}
  if (entityData) {
    for (const row of entityData as { entity_type: string }[]) {
      entityCounts[row.entity_type] = (entityCounts[row.entity_type] ?? 0) + 1
    }
  }
  const entityTypeCounts = Object.entries(entityCounts)
    .map(([entity_type, count]) => ({ entity_type, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5)

  // Query 2: Top anchors with connection counts
  const { data: anchorData } = await supabase
    .from('knowledge_nodes')
    .select('id, label, entity_type')
    .eq('is_anchor', true)
    .limit(8)

  let topAnchors: Array<{ id: string; label: string; entity_type: string; connectionCount: number }> = []
  if (anchorData && anchorData.length > 0) {
    const anchorIds = (anchorData as { id: string }[]).map(a => a.id)
    const connCounts = await fetchAnchorConnectionCounts(anchorIds)
    topAnchors = (anchorData as { id: string; label: string; entity_type: string }[])
      .map(a => ({ ...a, connectionCount: connCounts[a.id] ?? 0 }))
      .sort((a, b) => b.connectionCount - a.connectionCount)
      .slice(0, 4)
  }

  // Query 3: Source type distribution
  const { data: sourceData } = await supabase
    .from('knowledge_sources')
    .select('source_type')

  const sourceCounts: Record<string, number> = {}
  if (sourceData) {
    for (const row of sourceData as { source_type: string | null }[]) {
      const st = row.source_type ?? 'Other'
      sourceCounts[st] = (sourceCounts[st] ?? 0) + 1
    }
  }
  const sourceTypeCounts = Object.entries(sourceCounts)
    .map(([source_type, count]) => ({ source_type, count }))
    .sort((a, b) => b.count - a.count)

  return { entityTypeCounts, topAnchors, sourceTypeCounts }
}

// ─── Advisory Council ───────────────────────────────────────────────────────

export async function fetchDomainAgents(): Promise<DomainAgent[]> {
  const { data, error } = await supabase
    .from('domain_agents')
    .select('*')
    .eq('is_active', true)
    .order('source_count', { ascending: false })

  if (error) throw error
  return (data ?? []) as DomainAgent[]
}

export async function fetchAgentWithPlaylist(agentId: string): Promise<{ agent: DomainAgent; playlistName: string | null }> {
  const { data: agent, error } = await supabase
    .from('domain_agents')
    .select('*')
    .eq('id', agentId)
    .single()

  if (error) throw error

  let playlistName: string | null = null
  if (agent.playlist_id) {
    const { data: pl } = await supabase
      .from('youtube_playlists')
      .select('playlist_name')
      .eq('id', agent.playlist_id)
      .maybeSingle()
    playlistName = pl?.playlist_name ?? null
  }

  return { agent: agent as DomainAgent, playlistName }
}

export async function fetchAgentQuestions(agentId: string): Promise<AgentStandingQuestion[]> {
  const { data, error } = await supabase
    .from('agent_standing_questions')
    .select('*')
    .eq('agent_id', agentId)
    .order('priority', { ascending: true })

  if (error) throw error
  return (data ?? []) as AgentStandingQuestion[]
}

export async function fetchAgentInsights(agentId: string): Promise<AgentInsightRow[]> {
  const { data, error } = await supabase
    .from('agent_insights')
    .select('*')
    .eq('agent_id', agentId)
    .eq('status', 'active')
    .order('created_at', { ascending: false })

  if (error) throw error
  return (data ?? []) as AgentInsightRow[]
}

export async function fetchAgentGaps(agentId: string): Promise<AgentGapRow[]> {
  const { data, error } = await supabase
    .from('agent_gaps')
    .select('*')
    .eq('agent_id', agentId)
    .in('status', ['active', 'filling'])
    .order('severity', { ascending: true })

  if (error) throw error
  return (data ?? []) as AgentGapRow[]
}

export async function fetchAgentSignalsOut(agentId: string): Promise<AgentSignalRow[]> {
  const { data, error } = await supabase
    .from('agent_signals')
    .select('*')
    .eq('source_agent_id', agentId)
    .order('created_at', { ascending: false })
    .limit(20)

  if (error) throw error
  return (data ?? []) as AgentSignalRow[]
}

export async function fetchAgentSignalsIn(agentId: string): Promise<AgentSignalRow[]> {
  const { data, error } = await supabase
    .from('agent_signals')
    .select('*')
    .eq('target_agent_id', agentId)
    .order('created_at', { ascending: false })
    .limit(20)

  if (error) throw error
  return (data ?? []) as AgentSignalRow[]
}

export async function fetchAgentSkillAssignments(agentId: string): Promise<AgentSkillAssignment[]> {
  const { data, error } = await supabase
    .from('domain_agent_skills')
    .select(`
      id, agent_id, skill_id, match_method, relevance, ingested, assigned_at,
      skill:knowledge_skills!skill_id (id, name, title, description, domain, tags, confidence, status, usage_count, source_count)
    `)
    .eq('agent_id', agentId)
    .order('relevance', { ascending: false })

  if (error) throw error
  return (data ?? []).map((row: Record<string, unknown>) => ({
    ...row,
    skill: Array.isArray(row.skill) ? row.skill[0] : row.skill,
  })) as AgentSkillAssignment[]
}

export async function fetchTopSkillsWithAgents(limit = 5): Promise<Array<{
  id: string
  name: string
  title: string
  description: string
  source_count: number
  agent_name: string | null
}>> {
  // Get top skills by source_count
  const { data: skills, error } = await supabase
    .from('knowledge_skills')
    .select('id, name, title, description, source_count')
    .eq('status', 'active')
    .order('source_count', { ascending: false })
    .limit(limit)

  if (error || !skills) return []

  // Try to find which agent owns each skill
  const skillIds = skills.map(s => s.id)
  const { data: assignments } = await supabase
    .from('domain_agent_skills')
    .select('skill_id, agent:domain_agents!agent_id(name)')
    .in('skill_id', skillIds)

  const skillAgentMap = new Map<string, string>()
  for (const row of (assignments ?? []) as Array<{ skill_id: string; agent: { name: string } | { name: string }[] | null }>) {
    const agentData = Array.isArray(row.agent) ? row.agent[0] : row.agent
    if (agentData?.name) skillAgentMap.set(row.skill_id, agentData.name)
  }

  return skills.map(s => ({
    id: s.id,
    name: s.name,
    title: s.title,
    description: s.description,
    source_count: s.source_count,
    agent_name: skillAgentMap.get(s.id) ?? null,
  }))
}

// ─── Signal Enrichment (resolve bridge entities, edges, trigger sources) ────

export interface BridgeEntityInfo {
  id: string
  label: string
  entity_type: string
  description: string | null
}

export interface BridgeEdgeInfo {
  id: string
  relation_type: string
  evidence: string | null
  weight: number | null
}

export interface TriggerSourceInfo {
  id: string
  title: string | null
  source_type: string | null
}

export interface EnrichedSignalContext {
  bridgeEntities: BridgeEntityInfo[]
  bridgeEdge: BridgeEdgeInfo | null
  triggerSource: TriggerSourceInfo | null
}

export async function enrichSignalsContext(signals: AgentSignalRow[]): Promise<Map<string, EnrichedSignalContext>> {
  const result = new Map<string, EnrichedSignalContext>()
  if (signals.length === 0) return result

  // Collect all IDs to resolve
  const entityIds = new Set<string>()
  const edgeIds = new Set<string>()
  const sourceIds = new Set<string>()

  for (const s of signals) {
    for (const eid of (s.bridge_entity_ids || [])) entityIds.add(eid)
    if (s.bridge_edge_id) edgeIds.add(s.bridge_edge_id)
    if (s.trigger_source_id) sourceIds.add(s.trigger_source_id)
  }

  // Fetch all in parallel
  const [entitiesRes, edgesRes, sourcesRes] = await Promise.all([
    entityIds.size > 0
      ? supabase.from('knowledge_nodes').select('id, label, entity_type, description').in('id', [...entityIds].slice(0, 200))
      : Promise.resolve({ data: [], error: null }),
    edgeIds.size > 0
      ? supabase.from('knowledge_edges').select('id, relation_type, evidence, weight').in('id', [...edgeIds].slice(0, 100))
      : Promise.resolve({ data: [], error: null }),
    sourceIds.size > 0
      ? supabase.from('knowledge_sources').select('id, title, source_type').in('id', [...sourceIds].slice(0, 100))
      : Promise.resolve({ data: [], error: null }),
  ])

  const entityMap = new Map((entitiesRes.data ?? []).map((e: Record<string, unknown>) => [e.id as string, e as unknown as BridgeEntityInfo]))
  const edgeMap = new Map((edgesRes.data ?? []).map((e: Record<string, unknown>) => [e.id as string, e as unknown as BridgeEdgeInfo]))
  const sourceMap = new Map((sourcesRes.data ?? []).map((s: Record<string, unknown>) => [s.id as string, s as unknown as TriggerSourceInfo]))

  for (const s of signals) {
    const bridgeEntities = (s.bridge_entity_ids || []).map(id => entityMap.get(id)).filter((e): e is BridgeEntityInfo => !!e)
    const bridgeEdge = s.bridge_edge_id ? edgeMap.get(s.bridge_edge_id) ?? null : null
    const triggerSource = s.trigger_source_id ? sourceMap.get(s.trigger_source_id) ?? null : null

    result.set(s.id, { bridgeEntities, bridgeEdge, triggerSource })
  }

  return result
}

export async function fetchGlobalSignals(limit = 10, actionedOnly = false): Promise<(AgentSignalRow & { source_agent_name?: string; target_agent_name?: string })[]> {
  let query = supabase
    .from('agent_signals')
    .select('*')

  if (actionedOnly) {
    query = query.in('status', ['extracted', 'acknowledged', 'processing'])
  }

  const { data, error } = await query
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error) throw error
  return (data ?? []) as AgentSignalRow[]
}

export async function fetchGlobalInsights(limit = 10): Promise<(AgentInsightRow & { agent_name?: string })[]> {
  // Fetch active insights from the last 30 days, pull more than needed so we can rank client-side
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
  const { data, error } = await supabase
    .from('agent_insights')
    .select('*')
    .eq('status', 'active')
    .gte('created_at', thirtyDaysAgo)
    .limit(50)

  if (error) throw error
  const insights = (data ?? []) as AgentInsightRow[]

  // Rank by relevance: confidence + entity count + source count
  const scored = insights.map(ins => {
    const entityScore = (ins.related_entity_ids?.length ?? 0) * 2
    const sourceScore = (ins.related_source_ids?.length ?? 0) * 3
    const confidenceScore = (ins.confidence ?? 0) * 10
    return { ...ins, _score: entityScore + sourceScore + confidenceScore }
  })

  scored.sort((a, b) => b._score - a._score)
  return scored.slice(0, limit)
}

export async function fetchAgentCounts(agentId: string): Promise<{
  standingQuestions: number
  insights: number
  signalsOut: number
  gaps: number
}> {
  const [qRes, iRes, sRes, gRes] = await Promise.all([
    supabase.from('agent_standing_questions').select('id', { count: 'exact', head: true }).eq('agent_id', agentId).in('status', ['open', 'partially_addressed']),
    supabase.from('agent_insights').select('id', { count: 'exact', head: true }).eq('agent_id', agentId).eq('status', 'active'),
    supabase.from('agent_signals').select('id', { count: 'exact', head: true }).eq('source_agent_id', agentId),
    supabase.from('agent_gaps').select('id', { count: 'exact', head: true }).eq('agent_id', agentId).in('status', ['active', 'filling']),
  ])

  return {
    standingQuestions: qRes.count ?? 0,
    insights: iRes.count ?? 0,
    signalsOut: sRes.count ?? 0,
    gaps: gRes.count ?? 0,
  }
}

// ─── Agent Skills (domain_agent_skills junction) ────────────────────────────

export interface AgentSkillAssignment {
  id: string
  agent_id: string
  skill_id: string
  match_method: 'source_overlap' | 'gemini_match' | 'manual'
  relevance: number
  ingested: boolean
  assigned_at: string
  skill?: {
    id: string
    name: string
    title: string
    description: string
    domain: string | null
    tags: string[]
    confidence: number
    status: string
    usage_count: number
    source_count: number
  }
}

export async function fetchAgentSkills(): Promise<AgentSkillAssignment[]> {
  const { data, error } = await supabase
    .from('domain_agent_skills')
    .select(`
      id, agent_id, skill_id, match_method, relevance, ingested, assigned_at,
      skill:knowledge_skills!skill_id (id, name, title, description, domain, tags, confidence, status, usage_count, source_count)
    `)
    .order('relevance', { ascending: false })

  if (error) throw error
  return (data ?? []).map((row: Record<string, unknown>) => ({
    ...row,
    skill: Array.isArray(row.skill) ? row.skill[0] : row.skill,
  })) as AgentSkillAssignment[]
}

// ─── Council Briefing Data ──────────────────────────────────────────────────

export interface BriefingInsight {
  id: string
  agent_id: string
  insight_type: 'tension' | 'convergence' | 'novel_connection'
  claim: string
  evidence_summary: string | null
  confidence: number | null
  related_entity_ids: string[]
  created_at: string
}

export interface BriefingSignal {
  id: string
  source_agent_id: string
  target_agent_id: string
  reason: string
  status: string
  processing_result: string | null
  bridge_entity_ids: string[]
  extracted_entity_ids: string[]
  processed_at: string | null
  created_at: string
}

export interface BriefingSkillAssignment {
  id: string
  agent_id: string
  match_method: 'source_overlap' | 'gemini_match' | 'manual'
  relevance: number
  assigned_at: string
  skill_title: string
  skill_description: string
  skill_status: string
}

export async function fetchBriefingInsights(limit = 30): Promise<BriefingInsight[]> {
  const { data, error } = await supabase
    .from('agent_insights')
    .select('id, agent_id, insight_type, claim, evidence_summary, confidence, related_entity_ids, created_at')
    .eq('status', 'active')
    .order('confidence', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error) throw error
  return (data ?? []) as BriefingInsight[]
}

export async function fetchBriefingSignals(limit = 30): Promise<BriefingSignal[]> {
  const { data, error } = await supabase
    .from('agent_signals')
    .select('id, source_agent_id, target_agent_id, reason, status, processing_result, bridge_entity_ids, extracted_entity_ids, processed_at, created_at')
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error) throw error
  return (data ?? []) as BriefingSignal[]
}

export async function fetchBriefingSkillAssignments(limit = 30): Promise<BriefingSkillAssignment[]> {
  const { data, error } = await supabase
    .from('domain_agent_skills')
    .select('id, agent_id, match_method, relevance, assigned_at, skill:knowledge_skills!skill_id (title, description, status)')
    .order('relevance', { ascending: false })
    .order('assigned_at', { ascending: false })
    .limit(limit)

  if (error) throw error
  return (data ?? []).map((row: Record<string, unknown>) => {
    const skill = (Array.isArray(row.skill) ? row.skill[0] : row.skill) as Record<string, unknown> | null
    return {
      id: row.id as string,
      agent_id: row.agent_id as string,
      match_method: row.match_method as 'source_overlap' | 'gemini_match' | 'manual',
      relevance: row.relevance as number,
      assigned_at: row.assigned_at as string,
      skill_title: (skill?.title as string) || 'Unknown',
      skill_description: (skill?.description as string) || '',
      skill_status: (skill?.status as string) || 'draft',
    }
  })
}
