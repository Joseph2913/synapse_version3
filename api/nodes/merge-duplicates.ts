import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createClient } from '@supabase/supabase-js'

export const maxDuration = 300

const SUPABASE_URL              = process.env.SUPABASE_URL!
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!
const CRON_SECRET               = process.env.CRON_SECRET

const getSupabase = () => createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)


// ─── Structured logging ─────────────────────────────────────────────────────

type LogStatus = 'ok' | 'failed' | 'partial' | 'skipped'

interface LogFields {
  stage: string
  user_id?: string
  source_id?: string
  duration_ms?: number
  status?: LogStatus
  error?: string
  [k: string]: unknown
}

function log(fields: LogFields): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...fields }))
}

function logError(fields: LogFields & { error: string }): void {
  console.error(JSON.stringify({ ts: new Date().toISOString(), level: 'error', ...fields }))
}

function verifyCronAuth(req: VercelRequest): boolean {
  if (req.headers['x-vercel-signature']) return true
  if (!CRON_SECRET) return true
  const auth = req.headers['authorization']
  return !!(auth && auth === `Bearer ${CRON_SECRET}`)
}

// ── INLINE merge logic (serverless constraint — no local imports) ────────────

async function mergeNodesInline(
  sb: ReturnType<typeof getSupabase>,
  userId: string,
  canonicalId: string,
  mergeId: string
): Promise<number> {
  let edgesRepointed = 0

  // Repoint outgoing edges
  const { data: outEdges } = await sb
    .from('knowledge_edges')
    .select('id, target_node_id')
    .eq('user_id', userId)
    .eq('source_node_id', mergeId)

  for (const edge of outEdges ?? []) {
    if ((edge.target_node_id as string) === canonicalId) {
      await sb.from('knowledge_edges').delete().eq('id', edge.id as string)
    } else {
      await sb.from('knowledge_edges').update({ source_node_id: canonicalId }).eq('id', edge.id as string)
      edgesRepointed++
    }
  }

  // Repoint incoming edges
  const { data: inEdges } = await sb
    .from('knowledge_edges')
    .select('id, source_node_id')
    .eq('user_id', userId)
    .eq('target_node_id', mergeId)

  for (const edge of inEdges ?? []) {
    if ((edge.source_node_id as string) === canonicalId) {
      await sb.from('knowledge_edges').delete().eq('id', edge.id as string)
    } else {
      await sb.from('knowledge_edges').update({ target_node_id: canonicalId }).eq('id', edge.id as string)
      edgesRepointed++
    }
  }

  // Merge tags
  const { data: nodes } = await sb
    .from('knowledge_nodes')
    .select('id, description, tags, user_tags')
    .in('id', [canonicalId, mergeId])

  const canonical = nodes?.find(n => n.id === canonicalId)
  const toMerge   = nodes?.find(n => n.id === mergeId)

  if (canonical && toMerge) {
    const mergedTags = Array.from(new Set([
      ...((canonical.tags as string[]) ?? []),
      ...((toMerge.tags    as string[]) ?? []),
    ]))
    await sb.from('knowledge_nodes').update({
      tags: mergedTags,
      description: canonical.description || toMerge.description || null,
    }).eq('id', canonicalId)
  }

  // Soft-delete
  await sb.from('knowledge_nodes').update({
    is_merged:            true,
    merged_into_node_id:  canonicalId,
  }).eq('id', mergeId)

  return edgesRepointed
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (!verifyCronAuth(req)) return res.status(401).json({ error: 'Unauthorized' })

  const startTime = Date.now()
  const sb = getSupabase()

  let usersProcessed = 0, groupsFound = 0, nodesMerged = 0, edgesRepointed = 0

  try {
    // Find all exact-label duplicate groups across all users
    const { data: duplicateGroups } = await sb.rpc('find_exact_duplicate_nodes')

    if (!duplicateGroups || duplicateGroups.length === 0) {
      return res.status(200).json({
        success: true, message: 'No exact duplicates found',
        duration_ms: Date.now() - startTime,
      })
    }

    const usersSeen = new Set<string>()

    for (const group of duplicateGroups as Array<{
      user_id: string; label: string; entity_type: string; node_ids: string[]
    }>) {
      usersSeen.add(group.user_id)
      groupsFound++

      // Find which node has the most edges — that becomes canonical
      const edgeCounts = await Promise.all(
        group.node_ids.map(async (nodeId: string) => {
          const { count } = await sb
            .from('knowledge_edges')
            .select('id', { count: 'exact', head: true })
            .or(`source_node_id.eq.${nodeId},target_node_id.eq.${nodeId}`)
          return { nodeId, count: count ?? 0 }
        })
      )

      edgeCounts.sort((a, b) => b.count - a.count)
      const canonicalId = edgeCounts[0]!.nodeId
      const toMergeIds  = edgeCounts.slice(1).map(e => e.nodeId)

      for (const mergeId of toMergeIds) {
        const repointed = await mergeNodesInline(sb, group.user_id, canonicalId, mergeId)
        edgesRepointed += repointed
        nodesMerged++
      }
    }

    usersProcessed = usersSeen.size

    return res.status(200).json({
      success: true,
      usersProcessed,
      groupsFound,
      nodesMerged,
      edgesRepointed,
      duration_ms: Date.now() - startTime,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[merge-duplicates] Fatal error:', msg)
    return res.status(500).json({ success: false, error: msg, duration_ms: Date.now() - startTime })
  }
}
