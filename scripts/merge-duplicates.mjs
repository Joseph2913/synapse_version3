#!/usr/bin/env node
/**
 * One-time retroactive merge of exact-label duplicate nodes.
 * Run with: node scripts/merge-duplicates.mjs
 */
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY environment variables')
  process.exit(1)
}

const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

async function mergeNodesInline(userId, canonicalId, mergeId) {
  let edgesRepointed = 0

  const { data: outEdges } = await sb
    .from('knowledge_edges')
    .select('id, target_node_id')
    .eq('user_id', userId)
    .eq('source_node_id', mergeId)

  for (const edge of outEdges ?? []) {
    if (edge.target_node_id === canonicalId) {
      await sb.from('knowledge_edges').delete().eq('id', edge.id)
    } else {
      await sb.from('knowledge_edges').update({ source_node_id: canonicalId }).eq('id', edge.id)
      edgesRepointed++
    }
  }

  const { data: inEdges } = await sb
    .from('knowledge_edges')
    .select('id, source_node_id')
    .eq('user_id', userId)
    .eq('target_node_id', mergeId)

  for (const edge of inEdges ?? []) {
    if (edge.source_node_id === canonicalId) {
      await sb.from('knowledge_edges').delete().eq('id', edge.id)
    } else {
      await sb.from('knowledge_edges').update({ target_node_id: canonicalId }).eq('id', edge.id)
      edgesRepointed++
    }
  }

  const { data: nodes } = await sb
    .from('knowledge_nodes')
    .select('id, description, tags, user_tags')
    .in('id', [canonicalId, mergeId])

  const canonical = nodes?.find(n => n.id === canonicalId)
  const toMerge = nodes?.find(n => n.id === mergeId)

  if (canonical && toMerge) {
    const mergedTags = [...new Set([...(canonical.tags ?? []), ...(toMerge.tags ?? [])])]
    const mergedUserTags = [...new Set([...(canonical.user_tags ?? []), ...(toMerge.user_tags ?? [])])]
    await sb.from('knowledge_nodes').update({
      tags: mergedTags,
      user_tags: mergedUserTags,
      description: canonical.description || toMerge.description || null,
    }).eq('id', canonicalId)
  }

  await sb.from('knowledge_nodes').update({
    is_merged: true,
    merged_into_node_id: canonicalId,
  }).eq('id', mergeId)

  return edgesRepointed
}

async function main() {
  console.log('Finding exact duplicate groups...')

  const { data: duplicateGroups, error } = await sb.rpc('find_exact_duplicate_nodes')

  if (error) {
    console.error('Failed to find duplicates:', error.message)
    process.exit(1)
  }

  if (!duplicateGroups || duplicateGroups.length === 0) {
    console.log('No exact duplicates found. Graph is clean!')
    return
  }

  console.log(`Found ${duplicateGroups.length} duplicate groups`)

  let nodesMerged = 0
  let edgesRepointed = 0
  const usersSeen = new Set()

  for (const group of duplicateGroups) {
    usersSeen.add(group.user_id)

    const edgeCounts = await Promise.all(
      group.node_ids.map(async (nodeId) => {
        const { count } = await sb
          .from('knowledge_edges')
          .select('id', { count: 'exact', head: true })
          .or(`source_node_id.eq.${nodeId},target_node_id.eq.${nodeId}`)
        return { nodeId, count: count ?? 0 }
      })
    )

    edgeCounts.sort((a, b) => b.count - a.count)
    const canonicalId = edgeCounts[0].nodeId
    const toMergeIds = edgeCounts.slice(1).map(e => e.nodeId)

    console.log(`  Merging "${group.label}" (${group.entity_type}): keeping ${canonicalId} (${edgeCounts[0].count} edges), merging ${toMergeIds.length} duplicate(s)`)

    for (const mergeId of toMergeIds) {
      const repointed = await mergeNodesInline(group.user_id, canonicalId, mergeId)
      edgesRepointed += repointed
      nodesMerged++
    }
  }

  console.log('\n=== MERGE COMPLETE ===')
  console.log(`Users processed: ${usersSeen.size}`)
  console.log(`Groups found: ${duplicateGroups.length}`)
  console.log(`Nodes merged: ${nodesMerged}`)
  console.log(`Edges repointed: ${edgesRepointed}`)
}

main().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})
