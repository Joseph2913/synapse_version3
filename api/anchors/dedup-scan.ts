import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createClient } from '@supabase/supabase-js'

export const maxDuration = 60

const SUPABASE_URL = process.env.SUPABASE_URL!
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!
const CRON_SECRET = process.env.CRON_SECRET

const getSupabase = () => createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

async function resolveUserId(req: VercelRequest): Promise<string | null> {
  const auth = req.headers['authorization']
  if (!auth) return null

  if (CRON_SECRET && auth === `Bearer ${CRON_SECRET}`) {
    return (req.body as Record<string, unknown>)?.userId as string ?? null
  }

  const token = auth.replace('Bearer ', '')
  const sb = getSupabase()
  const { data: { user }, error } = await sb.auth.getUser(token)
  if (error || !user) return null
  return user.id
}

function buildReason(pair: {
  node_a_label: string; node_a_is_anchor: boolean; node_a_connection_count: number;
  node_b_label: string; node_b_is_anchor: boolean; node_b_connection_count: number;
  match_type: string;
}, winner: 'a' | 'b'): string {
  const keep = winner === 'a' ? pair.node_a_label : pair.node_b_label
  const merge = winner === 'a' ? pair.node_b_label : pair.node_a_label
  const keepIsAnchor = winner === 'a' ? pair.node_a_is_anchor : pair.node_b_is_anchor
  const keepConns = winner === 'a' ? pair.node_a_connection_count : pair.node_b_connection_count

  if (pair.match_type === 'exact') {
    return `Exact label match — keeping "${keep}" (${keepConns} connections)`
  }
  if (keepIsAnchor) {
    return `"${keep}" is an anchor with ${keepConns} connections — merging "${merge}" into it`
  }
  return `"${keep}" has more connections (${keepConns}) — merging "${merge}" into it`
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')

  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const userId = await resolveUserId(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })

  const body = (req.body ?? {}) as {
    anchorsOnly?: boolean
    semanticThreshold?: number
    dryRun?: boolean
  }
  const anchorsOnly = body.anchorsOnly !== false // default true
  const semanticThreshold = typeof body.semanticThreshold === 'number' ? body.semanticThreshold : 0.88
  const dryRun = body.dryRun === true

  const supabase = getSupabase()

  try {
    const { data: clusters, error: clusterError } = await supabase.rpc('find_duplicate_clusters', {
      p_user_id: userId,
      p_semantic_threshold: semanticThreshold,
      p_anchors_only: anchorsOnly,
      p_limit: 100,
    })

    if (clusterError) {
      return res.status(500).json({ error: `find_duplicate_clusters failed: ${clusterError.message}` })
    }

    if (!clusters || clusters.length === 0) {
      return res.status(200).json({
        success: true,
        duplicateClusters: [],
        totalClusters: 0,
        queuedForReview: 0,
      })
    }

    const recommendations = (clusters as Array<{
      node_a_id: string; node_a_label: string; node_a_entity_type: string;
      node_a_is_anchor: boolean; node_a_connection_count: number;
      node_b_id: string; node_b_label: string; node_b_entity_type: string;
      node_b_is_anchor: boolean; node_b_connection_count: number;
      match_type: string; similarity: number;
    }>).map(pair => {
      const aScore = (pair.node_a_is_anchor ? 100 : 0) + Number(pair.node_a_connection_count)
      const bScore = (pair.node_b_is_anchor ? 100 : 0) + Number(pair.node_b_connection_count)
      const winner: 'a' | 'b' = aScore >= bScore ? 'a' : 'b'

      return {
        match_type: pair.match_type,
        similarity: pair.similarity,
        nodeA: {
          id: pair.node_a_id,
          label: pair.node_a_label,
          entity_type: pair.node_a_entity_type,
          is_anchor: pair.node_a_is_anchor,
          connection_count: Number(pair.node_a_connection_count),
        },
        nodeB: {
          id: pair.node_b_id,
          label: pair.node_b_label,
          entity_type: pair.node_b_entity_type,
          is_anchor: pair.node_b_is_anchor,
          connection_count: Number(pair.node_b_connection_count),
        },
        recommendation: winner === 'a' ? 'merge_into_a' : 'merge_into_b',
        reason: buildReason(pair, winner),
      }
    })

    let queuedForReview = 0

    if (!dryRun) {
      for (const rec of recommendations) {
        const { data: existing } = await supabase
          .from('potential_duplicates')
          .select('id')
          .or(
            `and(node_a_id.eq.${rec.nodeA.id},node_b_id.eq.${rec.nodeB.id}),` +
            `and(node_a_id.eq.${rec.nodeB.id},node_b_id.eq.${rec.nodeA.id})`
          )
          .eq('status', 'pending')

        if (!existing || existing.length === 0) {
          const { error: insertErr } = await supabase.from('potential_duplicates').insert({
            user_id: userId,
            node_a_id: rec.nodeA.id,
            node_b_id: rec.nodeB.id,
            similarity: rec.similarity,
            match_type: rec.match_type,
            status: 'pending',
            metadata: {
              recommendation: rec.recommendation,
              reason: rec.reason,
              detected_at: new Date().toISOString(),
              detection_source: 'batch_scan',
            },
          })
          if (!insertErr) queuedForReview++
        }
      }
    }

    return res.status(200).json({
      success: true,
      duplicateClusters: recommendations,
      totalClusters: recommendations.length,
      queuedForReview: dryRun ? 0 : queuedForReview,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[dedup-scan] Error:', msg)
    return res.status(500).json({ success: false, error: msg })
  }
}
