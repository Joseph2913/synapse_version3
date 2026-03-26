import { supabase } from './supabase'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ExistingNodeMatch {
  existingNodeId: string
  existingLabel:  string
  matchType:      'exact' | 'near'
  similarity:     number  // 1.0 for exact, 0.80–0.92 for near
}

export interface DeduplicationResult {
  // Map from incoming entity label (lowercase) → existing node ID
  // For exact matches: use this ID instead of creating a new node
  exactMatches: Map<string, string>

  // Near matches (0.80–0.92 similarity) — surface for review, don't auto-merge
  nearMatches: Array<{
    incomingLabel:  string
    incomingType:   string
    existingNodeId: string
    existingLabel:  string
    similarity:     number
  }>
}

// ─── Core deduplication check ─────────────────────────────────────────────────
// Called before saveNodes. Returns exact matches (reuse these IDs) and
// near matches (surface for review). Does NOT modify the database.

export async function checkDeduplication(
  userId: string,
  entities: Array<{ label: string; entity_type: string; embedding?: number[] }>
): Promise<DeduplicationResult> {
  const result: DeduplicationResult = {
    exactMatches: new Map(),
    nearMatches:  [],
  }

  if (entities.length === 0) return result

  // ── Step 1: Exact label match (case-insensitive, same entity_type) ──────────
  const labels = entities.map(e => e.label)

  const { data: exactRows } = await supabase
    .from('knowledge_nodes')
    .select('id, label, entity_type')
    .eq('user_id', userId)
    .eq('is_merged', false)
    .in('label', labels)

  for (const row of exactRows ?? []) {
    const matchingEntity = entities.find(
      e => e.label.toLowerCase() === (row.label as string).toLowerCase()
        && e.entity_type === row.entity_type
    )
    if (matchingEntity) {
      result.exactMatches.set(matchingEntity.label.toLowerCase(), row.id as string)
    }
  }

  // ── Step 2: Embedding-based near match for entities with embeddings ─────────
  // Only run for entities that didn't get an exact match and have embeddings.
  // Uses pgvector cosine similarity via a direct RPC call.
  const entitiesNeedingNearCheck = entities.filter(
    e => !result.exactMatches.has(e.label.toLowerCase()) && e.embedding
  )

  for (const entity of entitiesNeedingNearCheck) {
    if (!entity.embedding) continue

    // Find top candidates by embedding similarity, same entity_type, not merged
    const { data: nearRows } = await supabase.rpc('find_similar_nodes', {
      p_user_id:      userId,
      p_embedding:    entity.embedding,
      p_entity_type:  entity.entity_type,
      p_limit:        5,
      p_min_similarity: 0.80,
    })

    for (const row of nearRows ?? []) {
      const similarity = row.similarity as number
      const existingLabel = row.label as string

      // Skip if it's an exact label match already handled above
      if (existingLabel.toLowerCase() === entity.label.toLowerCase()) continue

      if (similarity >= 0.92) {
        // High confidence: treat as exact match (auto-deduplicate)
        result.exactMatches.set(entity.label.toLowerCase(), row.id as string)
      } else if (similarity >= 0.80) {
        // Medium confidence: surface for human review
        result.nearMatches.push({
          incomingLabel:  entity.label,
          incomingType:   entity.entity_type,
          existingNodeId: row.id as string,
          existingLabel,
          similarity,
        })
      }
    }
  }

  return result
}

// ─── Save potential duplicates to review queue ────────────────────────────────
// Called after extraction to persist near matches for Pipeline review.

export async function savePotentialDuplicates(
  userId: string,
  nearMatches: DeduplicationResult['nearMatches'],
  newNodeIds: Map<string, string>  // label.toLowerCase() → new node ID
): Promise<void> {
  if (nearMatches.length === 0) return

  const toInsert = nearMatches
    .map(match => {
      const newNodeId = newNodeIds.get(match.incomingLabel.toLowerCase())
      if (!newNodeId) return null

      // Enforce node_a_id < node_b_id convention for the unique constraint
      const [nodeAId, nodeBId] = newNodeId < match.existingNodeId
        ? [newNodeId, match.existingNodeId]
        : [match.existingNodeId, newNodeId]

      return {
        user_id:    userId,
        node_a_id:  nodeAId,
        node_b_id:  nodeBId,
        similarity: match.similarity,
      }
    })
    .filter(Boolean)

  if (toInsert.length === 0) return

  // Insert, ignoring conflicts (same pair already in queue from previous extraction)
  await supabase
    .from('potential_duplicates')
    .upsert(toInsert, { onConflict: 'user_id,node_a_id,node_b_id', ignoreDuplicates: true })
}

// ─── Merge two nodes ──────────────────────────────────────────────────────────
// Merges nodeToMerge into canonicalNode:
//   1. Repoints all edges from nodeToMerge to canonicalNode
//   2. Merges tags arrays
//   3. Updates description if canonicalNode has none
//   4. Marks nodeToMerge as merged (soft delete)
//   5. Updates potential_duplicates status

export async function mergeNodes(
  userId: string,
  canonicalNodeId: string,
  nodeToMergeId:   string
): Promise<{ edgesRepointed: number }> {
  let edgesRepointed = 0

  // 1. Repoint outgoing edges from nodeToMerge → canonicalNode
  const { data: outEdges } = await supabase
    .from('knowledge_edges')
    .select('id, target_node_id')
    .eq('user_id', userId)
    .eq('source_node_id', nodeToMergeId)

  for (const edge of outEdges ?? []) {
    // Skip self-loops that would be created
    if ((edge.target_node_id as string) === canonicalNodeId) {
      await supabase.from('knowledge_edges').delete().eq('id', edge.id as string)
    } else {
      await supabase
        .from('knowledge_edges')
        .update({ source_node_id: canonicalNodeId })
        .eq('id', edge.id as string)
      edgesRepointed++
    }
  }

  // 2. Repoint incoming edges to nodeToMerge → canonicalNode
  const { data: inEdges } = await supabase
    .from('knowledge_edges')
    .select('id, source_node_id')
    .eq('user_id', userId)
    .eq('target_node_id', nodeToMergeId)

  for (const edge of inEdges ?? []) {
    if ((edge.source_node_id as string) === canonicalNodeId) {
      await supabase.from('knowledge_edges').delete().eq('id', edge.id as string)
    } else {
      await supabase
        .from('knowledge_edges')
        .update({ target_node_id: canonicalNodeId })
        .eq('id', edge.id as string)
      edgesRepointed++
    }
  }

  // 3. Fetch both nodes to merge metadata
  const { data: nodes } = await supabase
    .from('knowledge_nodes')
    .select('id, description, tags, user_tags')
    .in('id', [canonicalNodeId, nodeToMergeId])

  const canonical = nodes?.find(n => n.id === canonicalNodeId)
  const toMerge   = nodes?.find(n => n.id === nodeToMergeId)

  if (canonical && toMerge) {
    const mergedTags = Array.from(new Set([
      ...((canonical.tags as string[]) ?? []),
      ...((toMerge.tags    as string[]) ?? []),
    ]))
    const mergedUserTags = Array.from(new Set([
      ...((canonical.user_tags as string[]) ?? []),
      ...((toMerge.user_tags   as string[]) ?? []),
    ]))
    const description = canonical.description || toMerge.description || null

    await supabase
      .from('knowledge_nodes')
      .update({ tags: mergedTags, user_tags: mergedUserTags, description })
      .eq('id', canonicalNodeId)
  }

  // 4. Soft-delete the merged node
  await supabase
    .from('knowledge_nodes')
    .update({ is_merged: true, merged_into_node_id: canonicalNodeId })
    .eq('id', nodeToMergeId)

  // 5. Resolve any potential_duplicates entries involving these two nodes
  await supabase
    .from('potential_duplicates')
    .update({ status: 'merged', resolved_at: new Date().toISOString(), resolved_by: 'user' })
    .eq('user_id', userId)
    .or(
      `and(node_a_id.eq.${canonicalNodeId},node_b_id.eq.${nodeToMergeId}),` +
      `and(node_a_id.eq.${nodeToMergeId},node_b_id.eq.${canonicalNodeId})`
    )

  return { edgesRepointed }
}

// ─── Fetch pending potential duplicates ───────────────────────────────────────
// Used by the Pipeline page right panel.

export interface PotentialDuplicatePair {
  id:         string
  similarity: number
  detectedAt: string
  nodeA: { id: string; label: string; entityType: string; connectionCount: number }
  nodeB: { id: string; label: string; entityType: string; connectionCount: number }
}

export async function fetchPendingDuplicates(
  userId: string
): Promise<PotentialDuplicatePair[]> {
  const { data, error } = await supabase
    .from('potential_duplicates')
    .select(`
      id, similarity, detected_at,
      node_a:knowledge_nodes!node_a_id (id, label, entity_type),
      node_b:knowledge_nodes!node_b_id (id, label, entity_type)
    `)
    .eq('user_id', userId)
    .eq('status', 'pending')
    .order('similarity', { ascending: false })
    .limit(20)

  if (error || !data) return []

  interface JoinedNode { id: string; label: string; entity_type: string }

  return data.map(row => {
    const nodeA = row.node_a as unknown as JoinedNode
    const nodeB = row.node_b as unknown as JoinedNode
    return {
      id:         row.id as string,
      similarity: row.similarity as number,
      detectedAt: row.detected_at as string,
      nodeA: {
        id:              nodeA.id,
        label:           nodeA.label,
        entityType:      nodeA.entity_type,
        connectionCount: 0,
      },
      nodeB: {
        id:              nodeB.id,
        label:           nodeB.label,
        entityType:      nodeB.entity_type,
        connectionCount: 0,
      },
    }
  })
}

// ─── Keep separate (dismiss a potential duplicate pair) ───────────────────────

export async function keepSeparate(
  userId: string,
  pairId: string
): Promise<void> {
  await supabase
    .from('potential_duplicates')
    .update({
      status:      'kept_separate',
      resolved_at: new Date().toISOString(),
      resolved_by: 'user',
    })
    .eq('id', pairId)
    .eq('user_id', userId)
}
