import { supabase, semanticSearchNodes } from './supabase'
import { fetchWithRetry, GEMINI_CHAT_MODEL } from './gemini'
import type { DiscoveredEdge } from '../types/extraction'

const GEMINI_API_KEY = import.meta.env.VITE_GEMINI_API_KEY
const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models'
const MAX_GEMINI_CALLS = 5
const CANDIDATES_PER_NODE = 30
const BATCH_SIZE = 25
const SIMILARITY_THRESHOLD = 0.55

// Synthetic similarity scores for non-semantic candidate sources.
// These are assigned to anchor-neighborhood and tag-overlap candidates so they
// participate in the same priority sort as embedding-similarity candidates.
//
// ANCHOR_NEIGHBORHOOD_SIMILARITY = 0.65
//   Set above SIMILARITY_THRESHOLD (0.55) and above TAG_OVERLAP_SIMILARITY so
//   anchor-cluster candidates rank ahead of pure keyword matches. The rationale:
//   an anchor represents a user's highest-priority entity; everything connected
//   to it is already proven to be thematically relevant. In practice this should
//   be tuned down if the anchor graph becomes very dense (many low-quality edges
//   inflate the neighborhood), or up if users report missing anchor-cluster links.
//
// TAG_OVERLAP_SIMILARITY = 0.52
//   Just below semantic threshold but above the discard floor (0.0). Tags are a
//   weak-but-real signal: two nodes sharing "compliance" or "machine-learning"
//   are plausibly related but not certainly so. Setting this lower than semantic
//   results ensures that tag-only candidates are processed last (if at all under
//   the MAX_GEMINI_CALLS cap) and Gemini can filter them aggressively. Raise
//   toward 0.60 if tag-sourced connections prove high-quality in production.
const ANCHOR_NEIGHBORHOOD_SIMILARITY = 0.65
const TAG_OVERLAP_SIMILARITY = 0.52

interface NodeWithEmbedding {
  id: string
  label: string
  entity_type: string
  description: string | null
  embedding: number[] | null
  tags?: string[] | null
}

interface CandidatePair {
  newNode: NodeWithEmbedding
  existingNode: NodeWithEmbedding
  similarity: number
}

/**
 * Discovers cross-connections between newly extracted entities and the existing graph.
 *
 * Candidate sources (in priority order):
 *   1. Semantic similarity via match_knowledge_nodes RPC
 *   2. Anchor neighborhood — nodes connected to the user's anchors share a thematic cluster
 *   3. Tag / keyword overlap — shared tags are a strong domain signal
 *
 * Gemini inference is run on the highest-similarity candidates first.
 * This function never throws — failures return an empty array.
 */
export async function discoverCrossConnections(
  newNodeIds: string[],
  userId: string
): Promise<DiscoveredEdge[]> {
  if (newNodeIds.length === 0) return []

  try {
    // Fetch new nodes with embeddings and tags (needed for all three candidate sources)
    const { data: newNodesRaw, error: fetchError } = await supabase
      .from('knowledge_nodes')
      .select('id, label, entity_type, description, embedding, tags')
      .in('id', newNodeIds)

    if (fetchError || !newNodesRaw?.length) {
      console.warn('[crossConnections] Failed to fetch new nodes:', fetchError?.message)
      return []
    }

    const newNodes = newNodesRaw as NodeWithEmbedding[]
    const candidates = await findCandidates(newNodes, newNodeIds, userId)

    if (candidates.length === 0) {
      console.warn('[crossConnections] No candidates found — graph may be too sparse or embeddings missing')
      return []
    }

    console.info(`[crossConnections] ${candidates.length} candidate pairs found for ${newNodes.length} new nodes`)
    return await inferRelationships(newNodes, candidates)
  } catch (err) {
    console.warn('[crossConnections] Discovery failed:', err)
    return []
  }
}

// ─── Candidate Gathering ──────────────────────────────────────────────────────

async function findCandidates(
  newNodes: NodeWithEmbedding[],
  newNodeIds: string[],
  userId: string
): Promise<CandidatePair[]> {
  const newNodeIdSet = new Set(newNodeIds)
  const allCandidates: CandidatePair[] = []

  // ── Source 1: Semantic similarity (per new node, RPC-based) ──────────────
  for (const newNode of newNodes) {
    if (!newNode.embedding) {
      console.warn(`[crossConnections] Skipping "${newNode.label}" — no embedding stored yet`)
      continue
    }

    const similar = await semanticSearchNodes(newNode.embedding, userId, {
      matchThreshold: SIMILARITY_THRESHOLD,
      matchCount: CANDIDATES_PER_NODE + newNodeIds.length,
    })

    for (const s of similar.filter(s => !newNodeIdSet.has(s.id)).slice(0, CANDIDATES_PER_NODE)) {
      allCandidates.push({
        newNode,
        existingNode: {
          id: s.id,
          label: s.label,
          entity_type: s.entity_type,
          description: s.description,
          embedding: null,
        },
        similarity: s.similarity,
      })
    }
  }

  // ── Source 2: Anchor neighborhood (user-level, thematic cluster) ─────────
  // Entities connected to the user's anchor nodes share a strategic theme even
  // when their embedding vectors diverge significantly from the new entities.
  const anchorNeighbors = await fetchAnchorNeighborhood(userId, newNodeIdSet)
  for (const newNode of newNodes) {
    for (const neighbor of anchorNeighbors) {
      allCandidates.push({
        newNode,
        existingNode: { ...neighbor, embedding: null },
        similarity: ANCHOR_NEIGHBORHOOD_SIMILARITY,
      })
    }
  }

  // ── Source 3: Tag / keyword overlap (per new node) ───────────────────────
  // Shared tags are a strong domain signal that embedding similarity can miss
  // when the same concept is described in very different linguistic contexts.
  if (newNodeIds.length > 0) {
    for (const newNode of newNodes) {
      const tags = newNode.tags?.filter(Boolean) ?? []
      if (tags.length === 0) continue

      const { data: tagMatches } = await supabase
        .from('knowledge_nodes')
        .select('id, label, entity_type, description')
        .eq('user_id', userId)
        .filter('tags', 'ov', `{${tags.map(t => `"${t}"`).join(',')}}`)
        .not('id', 'in', `(${newNodeIds.join(',')})`)
        .limit(15)

      for (const match of tagMatches ?? []) {
        allCandidates.push({
          newNode,
          existingNode: { ...match, embedding: null },
          similarity: TAG_OVERLAP_SIMILARITY,
        })
      }
    }
  }

  return allCandidates
}

async function fetchAnchorNeighborhood(
  userId: string,
  newNodeIdSet: Set<string>
): Promise<{ id: string; label: string; entity_type: string; description: string | null }[]> {
  // Find the user's anchor nodes (promoted via is_anchor = true — any entity type)
  const { data: anchorNodes } = await supabase
    .from('knowledge_nodes')
    .select('id')
    .eq('user_id', userId)
    .eq('is_anchor', true)
    .limit(10)

  if (!anchorNodes?.length) return []

  const anchorIds = anchorNodes.map(a => a.id)
  const anchorIdSet = new Set(anchorIds)

  // Find all nodes connected to any anchor
  const { data: anchorEdges } = await supabase
    .from('knowledge_edges')
    .select('source_node_id, target_node_id')
    .or(`source_node_id.in.(${anchorIds.join(',')}),target_node_id.in.(${anchorIds.join(',')})`)

  const neighborIds = new Set<string>()
  for (const edge of anchorEdges ?? []) {
    if (!newNodeIdSet.has(edge.source_node_id) && !anchorIdSet.has(edge.source_node_id)) {
      neighborIds.add(edge.source_node_id)
    }
    if (!newNodeIdSet.has(edge.target_node_id) && !anchorIdSet.has(edge.target_node_id)) {
      neighborIds.add(edge.target_node_id)
    }
  }

  if (neighborIds.size === 0) return []

  const { data: neighbors } = await supabase
    .from('knowledge_nodes')
    .select('id, label, entity_type, description')
    .in('id', [...neighborIds])
    .limit(20)

  return neighbors ?? []
}

// ─── Relationship Inference ───────────────────────────────────────────────────

async function inferRelationships(
  newNodes: NodeWithEmbedding[],
  candidates: CandidatePair[]
): Promise<DiscoveredEdge[]> {
  if (!GEMINI_API_KEY) return []

  // Deduplicate by pair, keeping highest similarity score
  const pairMap = new Map<string, CandidatePair>()
  for (const c of candidates) {
    const key = `${c.newNode.id}:${c.existingNode.id}`
    const existing = pairMap.get(key)
    if (!existing || c.similarity > existing.similarity) {
      pairMap.set(key, c)
    }
  }

  // Sort highest-similarity first — best candidates are processed before the call cap
  const sorted = [...pairMap.values()].sort((a, b) => b.similarity - a.similarity)

  const batches: CandidatePair[][] = []
  for (let i = 0; i < sorted.length; i += BATCH_SIZE) {
    batches.push(sorted.slice(i, i + BATCH_SIZE))
  }

  const newNodeMap = new Map(newNodes.map(n => [n.label.toLowerCase(), n.id]))
  const existingNodeMap = new Map(sorted.map(c => [c.existingNode.label.toLowerCase(), c.existingNode.id]))

  const allEdges: DiscoveredEdge[] = []
  for (const batch of batches.slice(0, MAX_GEMINI_CALLS)) {
    try {
      const edges = await inferBatch(batch, newNodeMap, existingNodeMap)
      allEdges.push(...edges)
    } catch (err) {
      console.warn('[crossConnections] Batch inference failed:', err)
    }
  }

  return allEdges
}

async function inferBatch(
  batch: CandidatePair[],
  newNodeMap: Map<string, string>,
  existingNodeMap: Map<string, string>
): Promise<DiscoveredEdge[]> {
  const newEntitiesSet = new Map(batch.map(c => [c.newNode.id, c.newNode]))
  const existingEntitiesSet = new Map(batch.map(c => [c.existingNode.id, c.existingNode]))

  // Fetch graph context: top 3 existing connections per candidate entity.
  // Gives Gemini topology context — it can see the cluster an existing entity belongs to.
  const edgeContext = await fetchEdgeContext([...existingEntitiesSet.keys()])

  const newList = [...newEntitiesSet.values()].map(
    n => `- [${n.entity_type}] ${n.label}: ${n.description || 'No description'}`
  )

  const existingList = [...existingEntitiesSet.values()].map(n => {
    const connections = edgeContext.get(n.id)?.slice(0, 3) ?? []
    const ctx = connections.length > 0 ? `\n    Connected to: ${connections.join('; ')}` : ''
    return `- [${n.entity_type}] ${n.label}: ${n.description || 'No description'}${ctx}`
  })

  const prompt = `You are building a knowledge graph. Identify meaningful cross-source relationships between new and existing entities.

New entities (just ingested from a new source):
${newList.join('\n')}

Existing entities (already in the user's knowledge graph, with their current connections):
${existingList.join('\n')}

Rules:
- Determine the natural direction of each relationship. Default to the new entity as the subject (source), but REVERSE the direction when the relationship naturally flows from the existing entity to the new one (e.g., "Existing Entity leads_to New Entity" is valid if that is the true direction).
- Use specific directional types: leads_to, enables, supports, blocks, part_of, contradicts.
- Use relates_to ONLY when the relationship is genuinely bidirectional and no more specific type fits.
- Do NOT connect entities simply because they share a label or topic — the relationship must add knowledge.
- Use the "Connected to" context on existing entities to identify cluster membership and avoid redundant connections.
- Skip connections between entities that appear to be the same concept described differently.

Return JSON:
{
  "connections": [
    {
      "source_entity": "exact label of the relationship subject — can be from EITHER the new or existing list",
      "target_entity": "exact label of the relationship object — can be from EITHER the new or existing list",
      "relation_type": "one of: leads_to, supports, enables, blocks, contradicts, part_of, relates_to, mentions, associated_with",
      "evidence": "one sentence explaining why this direction is correct and what knowledge the connection adds"
    }
  ]
}

Return an empty connections array if no genuine cross-source connections exist.`

  const response = await fetchWithRetry(
    `${GEMINI_BASE_URL}/${GEMINI_CHAT_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: {
          parts: [{ text: 'You are a knowledge graph relationship expert. Find non-obvious, cross-source connections between entities from different content sources. Prioritise directional, specific relationship types over generic ones.' }],
        },
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.1,
          responseMimeType: 'application/json',
        },
      }),
    }
  )

  const data = await response.json()
  const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text
  if (!rawText) return []

  let parsed: { connections?: Array<{ source_entity: string; target_entity: string; relation_type: string; evidence: string }> }
  try {
    parsed = JSON.parse(rawText)
  } catch {
    console.warn('[crossConnections] Failed to parse Gemini response')
    return []
  }

  if (!Array.isArray(parsed.connections)) return []

  // Combined map covers both new and existing labels — Gemini can set direction freely
  const combinedMap = new Map([...newNodeMap, ...existingNodeMap])

  const edges: DiscoveredEdge[] = []
  for (const conn of parsed.connections) {
    const sourceId = combinedMap.get(conn.source_entity?.toLowerCase())
    const targetId = combinedMap.get(conn.target_entity?.toLowerCase())

    if (sourceId && targetId && sourceId !== targetId && conn.relation_type) {
      edges.push({
        sourceNodeId: sourceId,
        targetNodeId: targetId,
        relationType: conn.relation_type,
        evidence: conn.evidence || '',
        weight: 0.8,
      })
    }
  }

  return edges
}

/**
 * Fetches the top 3 existing connections for each of the given node IDs.
 * Used to give Gemini cluster topology context in the inference prompt.
 * Returns a map of nodeId → string[] of connection descriptions.
 */
async function fetchEdgeContext(nodeIds: string[]): Promise<Map<string, string[]>> {
  const contextMap = new Map<string, string[]>()
  if (nodeIds.length === 0) return contextMap

  // Fetch edges involving these nodes
  const { data: edges } = await supabase
    .from('knowledge_edges')
    .select('source_node_id, target_node_id, relation_type')
    .or(`source_node_id.in.(${nodeIds.join(',')}),target_node_id.in.(${nodeIds.join(',')})`)
    .limit(nodeIds.length * 4)

  if (!edges?.length) return contextMap

  // Collect all referenced node IDs to fetch labels in one query
  const referencedIds = new Set<string>()
  const nodeIdSet = new Set(nodeIds)
  for (const edge of edges) {
    if (!nodeIdSet.has(edge.source_node_id)) referencedIds.add(edge.source_node_id)
    if (!nodeIdSet.has(edge.target_node_id)) referencedIds.add(edge.target_node_id)
  }

  if (referencedIds.size === 0) return contextMap

  const { data: refNodes } = await supabase
    .from('knowledge_nodes')
    .select('id, label, entity_type')
    .in('id', [...referencedIds])

  const labelMap = new Map((refNodes ?? []).map(n => [n.id, `${n.label} (${n.entity_type})`]))

  // Build context strings: "ConnectedLabel (Type) via relation_type"
  for (const edge of edges) {
    if (nodeIdSet.has(edge.source_node_id)) {
      const target = labelMap.get(edge.target_node_id)
      if (target) {
        const list = contextMap.get(edge.source_node_id) ?? []
        list.push(`${target} via ${edge.relation_type}`)
        contextMap.set(edge.source_node_id, list)
      }
    }
    if (nodeIdSet.has(edge.target_node_id)) {
      const source = labelMap.get(edge.source_node_id)
      if (source) {
        const list = contextMap.get(edge.target_node_id) ?? []
        list.push(`${source} via ${edge.relation_type}`)
        contextMap.set(edge.target_node_id, list)
      }
    }
  }

  return contextMap
}

// ─── Persistence ──────────────────────────────────────────────────────────────

/**
 * Saves discovered cross-connection edges to the database.
 */
export async function saveCrossConnectionEdges(
  userId: string,
  edges: DiscoveredEdge[]
): Promise<string[]> {
  if (edges.length === 0) return []

  const toInsert = edges.map(e => ({
    user_id: userId,
    source_node_id: e.sourceNodeId,
    target_node_id: e.targetNodeId,
    relation_type: e.relationType,
    evidence: e.evidence || null,
    weight: e.weight,
  }))

  const { data, error } = await supabase
    .from('knowledge_edges')
    .insert(toInsert)
    .select('id')

  if (error) {
    console.warn('[crossConnections] Failed to save cross-connection edges:', error.message)
    return []
  }

  return (data ?? []).map(d => d.id)
}
