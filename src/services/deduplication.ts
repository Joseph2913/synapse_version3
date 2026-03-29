import { supabase } from './supabase'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ExistingNodeMatch {
  existingNodeId: string
  existingLabel:  string
  matchType:      'exact' | 'near'
  similarity:     number
}

export interface DeduplicationResult {
  exactMatches: Map<string, string>
  nearMatches: Array<{
    incomingLabel:  string
    incomingType:   string
    existingNodeId: string
    existingLabel:  string
    similarity:     number
  }>
}

export interface PotentialDuplicatePair {
  id:         string
  similarity: number
  matchType:  'exact' | 'fuzzy' | 'semantic'
  detectedAt: string
  recommendation: 'merge_into_a' | 'merge_into_b' | null
  nodeA: {
    id: string
    label: string
    entityType: string
    isAnchor: boolean
    connectionCount: number
  }
  nodeB: {
    id: string
    label: string
    entityType: string
    isAnchor: boolean
    connectionCount: number
  }
}

// ─── Core deduplication check ─────────────────────────────────────────────────

export async function checkDeduplication(
  userId: string,
  entities: Array<{ label: string; entity_type: string; embedding?: number[] }>
): Promise<DeduplicationResult> {
  const result: DeduplicationResult = {
    exactMatches: new Map(),
    nearMatches:  [],
  }

  if (entities.length === 0) return result

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

  const entitiesNeedingNearCheck = entities.filter(
    e => !result.exactMatches.has(e.label.toLowerCase()) && e.embedding
  )

  for (const entity of entitiesNeedingNearCheck) {
    if (!entity.embedding) continue

    const { data: nearRows } = await supabase.rpc('find_similar_nodes', {
      p_user_id:   userId,
      p_embedding: entity.embedding,
      p_threshold: 0.80,
      p_limit:     5,
    })

    for (const row of nearRows ?? []) {
      const similarity = row.similarity as number
      const existingLabel = row.label as string

      if (existingLabel.toLowerCase() === entity.label.toLowerCase()) continue

      if (similarity >= 0.92) {
        result.exactMatches.set(entity.label.toLowerCase(), row.id as string)
      } else if (similarity >= 0.80) {
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

export async function savePotentialDuplicates(
  userId: string,
  nearMatches: DeduplicationResult['nearMatches'],
  newNodeIds: Map<string, string>
): Promise<void> {
  if (nearMatches.length === 0) return

  const toInsert = nearMatches
    .map(match => {
      const newNodeId = newNodeIds.get(match.incomingLabel.toLowerCase())
      if (!newNodeId) return null

      const [nodeAId, nodeBId] = newNodeId < match.existingNodeId
        ? [newNodeId, match.existingNodeId]
        : [match.existingNodeId, newNodeId]

      return {
        user_id:    userId,
        node_a_id:  nodeAId,
        node_b_id:  nodeBId,
        similarity: match.similarity,
        match_type: 'semantic',
      }
    })
    .filter(Boolean)

  if (toInsert.length === 0) return

  await supabase
    .from('potential_duplicates')
    .upsert(toInsert, { onConflict: 'user_id,node_a_id,node_b_id', ignoreDuplicates: true })
}

// ─── Edge deduplication after merge ──────────────────────────────────────────
// After repointing all edges to targetNodeId, remove duplicate edges (same
// other_node + relation_type pair), keeping the higher-weight one.
// Also removes self-edges (targetNodeId → targetNodeId).

async function deduplicateEdgesAfterMerge(
  targetNodeId: string,
  userId: string
): Promise<number> {
  const { data: edges } = await supabase
    .from('knowledge_edges')
    .select('id, source_node_id, target_node_id, relation_type, weight')
    .or(`source_node_id.eq.${targetNodeId},target_node_id.eq.${targetNodeId}`)
    .eq('user_id', userId)
    .order('weight', { ascending: false })

  const seen = new Map<string, string>()
  const toDelete: string[] = []

  for (const edge of edges ?? []) {
    const edgeId = edge.id as string
    const src = edge.source_node_id as string
    const tgt = edge.target_node_id as string

    // Delete self-edges
    if (src === targetNodeId && tgt === targetNodeId) {
      toDelete.push(edgeId)
      continue
    }

    const otherNodeId = src === targetNodeId ? tgt : src
    const key = `${otherNodeId}:${edge.relation_type as string}`

    if (seen.has(key)) {
      toDelete.push(edgeId)
    } else {
      seen.set(key, edgeId)
    }
  }

  if (toDelete.length > 0) {
    await supabase.from('knowledge_edges').delete().in('id', toDelete)
  }

  return toDelete.length
}

// ─── Merge two nodes ──────────────────────────────────────────────────────────
// Merges nodeToMerge into canonicalNode:
//   1. Repoints all edges from nodeToMerge to canonicalNode
//   2. Deduplicates edges (removes duplicate other_node+relation_type pairs)
//   3. Merges tags arrays
//   4. Updates description if canonicalNode has none or shorter one
//   5. Promotes canonicalNode to anchor if nodeToMerge was an anchor
//   6. Marks nodeToMerge as merged (soft delete)
//   7. Updates potential_duplicates status

export async function mergeNodes(
  userId: string,
  canonicalNodeId: string,
  nodeToMergeId:   string
): Promise<{ edgesRepointed: number; edgesDeduped: number }> {
  let edgesRepointed = 0

  // 0. Fetch source node metadata before we touch anything (need is_anchor)
  const { data: sourceNode } = await supabase
    .from('knowledge_nodes')
    .select('is_anchor, description, tags, user_tags')
    .eq('id', nodeToMergeId)
    .maybeSingle()

  // 1. Repoint outgoing edges from nodeToMerge → canonicalNode
  const { data: outEdges } = await supabase
    .from('knowledge_edges')
    .select('id, target_node_id')
    .eq('user_id', userId)
    .eq('source_node_id', nodeToMergeId)

  for (const edge of outEdges ?? []) {
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

  // 3. Deduplicate edges after repointing
  const edgesDeduped = await deduplicateEdgesAfterMerge(canonicalNodeId, userId)

  // 4. Fetch canonical node to merge metadata
  const { data: canonicalNode } = await supabase
    .from('knowledge_nodes')
    .select('description, tags, user_tags, is_anchor')
    .eq('id', canonicalNodeId)
    .maybeSingle()

  if (canonicalNode && sourceNode) {
    const mergedTags = Array.from(new Set([
      ...((canonicalNode.tags as string[]) ?? []),
      ...((sourceNode.tags   as string[]) ?? []),
    ]))
    const mergedUserTags = Array.from(new Set([
      ...((canonicalNode.user_tags as string[]) ?? []),
      ...((sourceNode.user_tags   as string[]) ?? []),
    ]))
    // Use longer/richer description
    const srcDesc = sourceNode.description as string | null
    const canDesc = canonicalNode.description as string | null
    const description = (srcDesc && (!canDesc || srcDesc.length > canDesc.length))
      ? srcDesc
      : (canDesc ?? null)

    // Promote to anchor if source was an anchor and canonical is not
    const promoteToAnchor = (sourceNode.is_anchor as boolean) && !(canonicalNode.is_anchor as boolean)

    const updatePayload: Record<string, unknown> = {
      tags: mergedTags,
      user_tags: mergedUserTags,
      description,
    }
    if (promoteToAnchor) {
      updatePayload.is_anchor = true
    }

    await supabase
      .from('knowledge_nodes')
      .update(updatePayload)
      .eq('id', canonicalNodeId)
  }

  // 5. Soft-delete the merged node
  await supabase
    .from('knowledge_nodes')
    .update({ is_merged: true, merged_into_node_id: canonicalNodeId })
    .eq('id', nodeToMergeId)

  // 6. Resolve any potential_duplicates entries involving these two nodes
  await supabase
    .from('potential_duplicates')
    .update({ status: 'merged', resolved_at: new Date().toISOString(), resolved_by: 'user' })
    .eq('user_id', userId)
    .or(
      `and(node_a_id.eq.${canonicalNodeId},node_b_id.eq.${nodeToMergeId}),` +
      `and(node_a_id.eq.${nodeToMergeId},node_b_id.eq.${canonicalNodeId})`
    )

  return { edgesRepointed, edgesDeduped }
}

// ─── Fetch pending potential duplicates ───────────────────────────────────────

export async function fetchPendingDuplicates(
  userId: string
): Promise<PotentialDuplicatePair[]> {
  const { data, error } = await supabase
    .from('potential_duplicates')
    .select(`
      id, similarity, detected_at, match_type, metadata,
      node_a:knowledge_nodes!node_a_id (id, label, entity_type, is_anchor),
      node_b:knowledge_nodes!node_b_id (id, label, entity_type, is_anchor)
    `)
    .eq('user_id', userId)
    .eq('status', 'pending')
    .order('similarity', { ascending: false })
    .limit(50)

  if (error || !data) return []

  // Fetch connection counts for all nodes in a single query
  interface JoinedNode { id: string; label: string; entity_type: string; is_anchor: boolean }

  const nodeIds = data.flatMap(row => {
    const a = row.node_a as unknown as JoinedNode | null
    const b = row.node_b as unknown as JoinedNode | null
    return [a?.id, b?.id].filter(Boolean) as string[]
  })

  const connCountMap = new Map<string, number>()
  if (nodeIds.length > 0) {
    const { data: edges } = await supabase
      .from('knowledge_edges')
      .select('source_node_id, target_node_id')
      .or(`source_node_id.in.(${nodeIds.join(',')}),target_node_id.in.(${nodeIds.join(',')})`)
      .eq('user_id', userId)

    for (const edge of edges ?? []) {
      const src = edge.source_node_id as string
      const tgt = edge.target_node_id as string
      connCountMap.set(src, (connCountMap.get(src) ?? 0) + 1)
      connCountMap.set(tgt, (connCountMap.get(tgt) ?? 0) + 1)
    }
  }

  return data.map(row => {
    const nodeA = row.node_a as unknown as JoinedNode
    const nodeB = row.node_b as unknown as JoinedNode
    const metadata = (row.metadata ?? {}) as Record<string, unknown>
    const rawMatchType = (row.match_type as string | null) ?? 'semantic'
    const matchType = (rawMatchType === 'exact' || rawMatchType === 'fuzzy' || rawMatchType === 'semantic')
      ? rawMatchType as 'exact' | 'fuzzy' | 'semantic'
      : 'semantic' as const

    const aConns = connCountMap.get(nodeA.id) ?? 0
    const bConns = connCountMap.get(nodeB.id) ?? 0
    const aScore = (nodeA.is_anchor ? 100 : 0) + aConns
    const bScore = (nodeB.is_anchor ? 100 : 0) + bConns
    const recommendation = (metadata.recommendation as string | undefined) ??
      (aScore >= bScore ? 'merge_into_a' : 'merge_into_b')

    return {
      id:         row.id as string,
      similarity: row.similarity as number,
      matchType,
      detectedAt: row.detected_at as string,
      recommendation: recommendation as 'merge_into_a' | 'merge_into_b',
      nodeA: {
        id:              nodeA.id,
        label:           nodeA.label,
        entityType:      nodeA.entity_type,
        isAnchor:        nodeA.is_anchor,
        connectionCount: aConns,
      },
      nodeB: {
        id:              nodeB.id,
        label:           nodeB.label,
        entityType:      nodeB.entity_type,
        isAnchor:        nodeB.is_anchor,
        connectionCount: bConns,
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
