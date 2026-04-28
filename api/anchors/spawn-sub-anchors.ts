/**
 * api/anchors/spawn-sub-anchors.ts
 *
 * Automatically assigns suggested anchor candidates as sub-anchors
 * under confirmed root anchors when they have strong edge affinity.
 *
 * Triggered:
 *   - Fire-and-forget from score-post-extraction after scoring completes
 *   - Manually via POST with CRON_SECRET auth
 *
 * For each suggested candidate:
 *   1. Compute edge affinity to every root anchor (direct edges + shared neighbors)
 *   2. If best affinity >= MIN_AFFINITY, promote as sub-anchor under that parent
 *   3. Set is_anchor=true, parent_anchor_id, propagate inherited edges
 *
 * CRITICAL: Fully self-contained. No local imports (serverless constraint).
 */

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createClient } from '@supabase/supabase-js'

export const maxDuration = 120

// ─── ENVIRONMENT ──────────────────────────────────────────────────────────────
const SUPABASE_URL              = process.env.SUPABASE_URL!
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!
const CRON_SECRET               = process.env.CRON_SECRET

const getSupabase = () => createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

// ─── AUTH ─────────────────────────────────────────────────────────────────────

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

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const MIN_AFFINITY = 0.35          // Minimum affinity to auto-assign as sub-anchor
const DIRECT_EDGE_WEIGHT = 0.40    // Affinity boost for direct edge to parent
const MAX_SHARED_WEIGHT  = 0.40    // Max affinity from shared neighbors (Jaccard-based)
const SAME_SOURCE_WEIGHT = 0.10    // Bonus for sharing a source
const LABEL_WORD_WEIGHT  = 0.08    // Per shared word in label (max 0.20)

// ─── INLINE HELPERS ───────────────────────────────────────────────────────────

function computeAffinity(
  candidateNeighbors: Set<string>,
  anchorNeighbors: Set<string>,
  hasDirect: boolean,
  sameSource: boolean,
  candidateLabel: string,
  anchorLabel: string
): { affinity: number; shared: number; reasons: string[] } {
  let affinity = 0
  const reasons: string[] = []

  if (hasDirect) {
    affinity += DIRECT_EDGE_WEIGHT
    reasons.push('direct edge')
  }

  const intersection = [...candidateNeighbors].filter(n => anchorNeighbors.has(n))
  const unionSize = new Set([...candidateNeighbors, ...anchorNeighbors]).size
  if (unionSize > 0) {
    const jaccard = intersection.length / unionSize
    const sharedScore = Math.min(jaccard * 4, MAX_SHARED_WEIGHT)
    affinity += sharedScore
    if (intersection.length > 0) reasons.push(`${intersection.length} shared neighbors`)
  }

  if (sameSource) {
    affinity += SAME_SOURCE_WEIGHT
    reasons.push('same source')
  }

  const nodeWords = new Set(candidateLabel.toLowerCase().split(/\s+/).filter(w => w.length > 2))
  const anchorWords = new Set(anchorLabel.toLowerCase().split(/\s+/).filter(w => w.length > 2))
  const wordOverlap = [...nodeWords].filter(w => anchorWords.has(w)).length
  if (wordOverlap > 0) {
    affinity += Math.min(wordOverlap * LABEL_WORD_WEIGHT, 0.20)
    reasons.push(`${wordOverlap} shared label words`)
  }

  return { affinity: Math.min(affinity, 1.0), shared: intersection.length, reasons }
}

async function propagateInheritance(
  sb: ReturnType<typeof getSupabase>,
  userId: string,
  subAnchorId: string,
  parentAnchorId: string
): Promise<number> {
  // Fetch entities connected to sub-anchor (non-inherited)
  const { data: subEdges } = await sb
    .from('knowledge_edges')
    .select('source_node_id, target_node_id')
    .eq('user_id', userId)
    .eq('is_inherited', false)
    .or(`source_node_id.eq.${subAnchorId},target_node_id.eq.${subAnchorId}`)

  const entityIds = new Set<string>()
  for (const edge of subEdges ?? []) {
    const src = edge.source_node_id as string
    const tgt = edge.target_node_id as string
    const entityId = src === subAnchorId ? tgt : src
    if (entityId !== parentAnchorId) entityIds.add(entityId)
  }

  if (entityIds.size === 0) return 0

  // Find which are already connected to parent
  const { data: parentEdges } = await sb
    .from('knowledge_edges')
    .select('source_node_id, target_node_id')
    .eq('user_id', userId)
    .or(`source_node_id.eq.${parentAnchorId},target_node_id.eq.${parentAnchorId}`)

  const alreadyConnected = new Set<string>()
  for (const edge of parentEdges ?? []) {
    const src = edge.source_node_id as string
    const tgt = edge.target_node_id as string
    alreadyConnected.add(src === parentAnchorId ? tgt : src)
  }

  const toInsert = Array.from(entityIds)
    .filter(id => !alreadyConnected.has(id))
    .map(entityId => ({
      user_id:                  userId,
      source_node_id:           parentAnchorId,
      target_node_id:           entityId,
      relation_type:            'inherited_from',
      evidence:                 `Inherited from sub-anchor: ${subAnchorId}`,
      weight:                   0.5,
      is_inherited:             true,
      inherited_from_anchor_id: subAnchorId,
    }))

  if (toInsert.length === 0) return 0

  const { error } = await sb.from('knowledge_edges').insert(toInsert)
  if (error) {
    console.warn(`[spawn-sub-anchors] Inheritance propagation error: ${error.message}`)
    return 0
  }
  return toInsert.length
}

// ─── HANDLER ──────────────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const startTime = Date.now()
  const userId = await resolveUserId(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })

  const sb = getSupabase()
  const nowStr = new Date().toISOString()

  try {
    // 1. Fetch confirmed root anchors (no parent)
    const { data: rootAnchorRows } = await sb
      .from('knowledge_nodes')
      .select('id, label, entity_type, source_id')
      .eq('user_id', userId)
      .eq('is_anchor', true)
      .is('parent_anchor_id', null)

    const rootAnchors = (rootAnchorRows ?? []) as Array<{
      id: string; label: string; entity_type: string; source_id: string | null
    }>

    if (rootAnchors.length === 0) {
      return res.status(200).json({ success: true, promoted: 0, message: 'No root anchors' })
    }

    // 2. Fetch suggested candidates
    const { data: candidateRows } = await sb
      .from('anchor_candidates')
      .select('id, node_id, composite_score, status')
      .eq('user_id', userId)
      .eq('status', 'suggested')
      .order('composite_score', { ascending: false })

    const candidates = (candidateRows ?? []) as Array<{
      id: string; node_id: string; composite_score: number; status: string
    }>

    if (candidates.length === 0) {
      return res.status(200).json({ success: true, promoted: 0, message: 'No suggested candidates' })
    }

    // 3. Fetch candidate node metadata
    const candidateNodeIds = candidates.map(c => c.node_id).filter(Boolean)
    const candidateNodeMap = new Map<string, { id: string; label: string; entity_type: string; source_id: string | null }>()

    for (let c = 0; c < candidateNodeIds.length; c += 500) {
      const chunk = candidateNodeIds.slice(c, c + 500)
      const { data } = await sb
        .from('knowledge_nodes')
        .select('id, label, entity_type, source_id, is_anchor')
        .in('id', chunk)
        .eq('user_id', userId)
      for (const n of (data ?? [])) {
        if (!n.is_anchor) {
          candidateNodeMap.set(n.id as string, n as { id: string; label: string; entity_type: string; source_id: string | null })
        }
      }
    }

    // 4. Fetch ALL edges (paginated)
    type EdgeRow = { source_node_id: string; target_node_id: string }
    const allEdges: EdgeRow[] = []
    let offset = 0
    while (true) {
      const { data } = await sb
        .from('knowledge_edges')
        .select('source_node_id, target_node_id')
        .eq('user_id', userId)
        .range(offset, offset + 999)
      if (!data || data.length === 0) break
      allEdges.push(...(data as EdgeRow[]))
      if (data.length < 1000) break
      offset += 1000
    }

    // 5. Build neighbor maps
    const neighborMap = new Map<string, Set<string>>()
    function addNeighbor(a: string, b: string) {
      if (!neighborMap.has(a)) neighborMap.set(a, new Set())
      neighborMap.get(a)!.add(b)
    }
    for (const e of allEdges) {
      addNeighbor(e.source_node_id, e.target_node_id)
      addNeighbor(e.target_node_id, e.source_node_id)
    }

    const rootAnchorIds = new Set(rootAnchors.map(a => a.id))

    // 6. Score each candidate against all root anchors
    let promoted = 0
    let inheritedEdgesTotal = 0

    for (const candidate of candidates) {
      // Time budget
      if (Date.now() - startTime > 100_000) break

      const nodeId = candidate.node_id
      if (!nodeId) continue
      const node = candidateNodeMap.get(nodeId)
      if (!node) continue

      const candidateNeighbors = neighborMap.get(nodeId) ?? new Set()

      let bestParent: { anchor: typeof rootAnchors[0]; affinity: number; reasons: string[] } | null = null

      for (const anchor of rootAnchors) {
        const anchorNeighbors = neighborMap.get(anchor.id) ?? new Set()
        const hasDirect = candidateNeighbors.has(anchor.id)
        const sameSource = !!(node.source_id && anchor.source_id && node.source_id === anchor.source_id)

        const result = computeAffinity(
          candidateNeighbors, anchorNeighbors, hasDirect, sameSource,
          node.label, anchor.label
        )

        if (result.affinity > (bestParent?.affinity ?? 0)) {
          bestParent = { anchor, affinity: result.affinity, reasons: result.reasons }
        }
      }

      if (!bestParent || bestParent.affinity < MIN_AFFINITY) continue

      // Promote as sub-anchor
      // 1) Set is_anchor=true + parent_anchor_id on node
      const { error: nodeErr } = await sb
        .from('knowledge_nodes')
        .update({ is_anchor: true, parent_anchor_id: bestParent.anchor.id })
        .eq('id', nodeId)

      if (nodeErr) {
        console.warn(`[spawn-sub-anchors] Node update failed for ${nodeId}: ${nodeErr.message}`)
        continue
      }

      // 2) Update candidate to confirmed
      const { error: candErr } = await sb
        .from('anchor_candidates')
        .update({
          status: 'confirmed',
          reviewed_at: nowStr,
          suggested_parent_anchor_id: bestParent.anchor.id,
          reasoning_text: `Auto sub-anchor: ${bestParent.reasons.join(', ')}. Affinity: ${bestParent.affinity.toFixed(2)} to "${bestParent.anchor.label}".`,
        })
        .eq('id', candidate.id)

      if (candErr) {
        // Rollback node
        await sb.from('knowledge_nodes').update({ is_anchor: false, parent_anchor_id: null }).eq('id', nodeId)
        console.warn(`[spawn-sub-anchors] Candidate update failed for ${candidate.id}: ${candErr.message}`)
        continue
      }

      // 3) Propagate inherited edges
      const edgesCreated = await propagateInheritance(sb, userId, nodeId, bestParent.anchor.id)
      inheritedEdgesTotal += edgesCreated

      promoted++
      console.log(
        `[spawn-sub-anchors] "${node.label}" → sub of "${bestParent.anchor.label}" ` +
        `(affinity=${bestParent.affinity.toFixed(2)}, inherited=${edgesCreated})`
      )
    }

    console.log(
      `[spawn-sub-anchors] userId=${userId} candidates=${candidates.length} ` +
      `promoted=${promoted} inheritedEdges=${inheritedEdgesTotal} duration=${Date.now() - startTime}ms`
    )

    return res.status(200).json({
      success: true,
      promoted,
      inheritedEdges: inheritedEdgesTotal,
      totalCandidates: candidates.length,
      rootAnchors: rootAnchors.length,
      duration_ms: Date.now() - startTime,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[spawn-sub-anchors] Error:', msg)
    return res.status(500).json({ success: false, error: msg, duration_ms: Date.now() - startTime })
  }
}
