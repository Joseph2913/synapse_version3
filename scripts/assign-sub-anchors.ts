/**
 * Retroactive sub-anchor assignment: for each user, take all suggested
 * anchor candidates and assign them as sub-anchors under the most
 * closely related root anchor (by edge affinity).
 *
 * Usage:
 *   npx tsx scripts/assign-sub-anchors.ts --all-users
 *   npx tsx scripts/assign-sub-anchors.ts --user-name "joseph2000may"
 *   npx tsx scripts/assign-sub-anchors.ts --all-users --dry-run
 */

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const envPath = resolve(import.meta.dirname ?? '.', '../.env.local')
try {
  const envContent = readFileSync(envPath, 'utf-8')
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx < 0) continue
    if (!process.env[trimmed.slice(0, eqIdx).trim()]) {
      process.env[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1).trim()
    }
  }
} catch { /* */ }

const sb = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const allUsers = args.includes('--all-users')
const nameIdx = args.indexOf('--user-name')
const userName = nameIdx >= 0 ? args[nameIdx + 1] : 'joseph2000may'
const affinityIdx = args.indexOf('--min-affinity')
const MIN_AFFINITY = affinityIdx >= 0 ? parseFloat(args[affinityIdx + 1]!) : 0.35

// ─── Affinity computation ─────────────────────────────────────────────────────

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

  if (hasDirect) { affinity += 0.40; reasons.push('direct edge') }

  const intersection = [...candidateNeighbors].filter(n => anchorNeighbors.has(n))
  const unionSize = new Set([...candidateNeighbors, ...anchorNeighbors]).size
  if (unionSize > 0) {
    affinity += Math.min((intersection.length / unionSize) * 4, 0.40)
    if (intersection.length > 0) reasons.push(`${intersection.length} shared neighbors`)
  }

  if (sameSource) { affinity += 0.10; reasons.push('same source') }

  const nodeWords = new Set(candidateLabel.toLowerCase().split(/\s+/).filter(w => w.length > 2))
  const anchorWords = new Set(anchorLabel.toLowerCase().split(/\s+/).filter(w => w.length > 2))
  const wordOverlap = [...nodeWords].filter(w => anchorWords.has(w)).length
  if (wordOverlap > 0) {
    affinity += Math.min(wordOverlap * 0.08, 0.20)
    reasons.push(`${wordOverlap} shared label words`)
  }

  return { affinity: Math.min(affinity, 1.0), shared: intersection.length, reasons }
}

// ─── Inheritance propagation ──────────────────────────────────────────────────

async function propagateInheritance(userId: string, subId: string, parentId: string): Promise<number> {
  const { data: subEdges } = await sb.from('knowledge_edges')
    .select('source_node_id, target_node_id')
    .eq('user_id', userId).eq('is_inherited', false)
    .or(`source_node_id.eq.${subId},target_node_id.eq.${subId}`)

  const entityIds = new Set<string>()
  for (const e of subEdges ?? []) {
    const eid = (e.source_node_id as string) === subId ? (e.target_node_id as string) : (e.source_node_id as string)
    if (eid !== parentId) entityIds.add(eid)
  }
  if (entityIds.size === 0) return 0

  const { data: parentEdges } = await sb.from('knowledge_edges')
    .select('source_node_id, target_node_id')
    .eq('user_id', userId)
    .or(`source_node_id.eq.${parentId},target_node_id.eq.${parentId}`)

  const connected = new Set<string>()
  for (const e of parentEdges ?? []) {
    connected.add((e.source_node_id as string) === parentId ? (e.target_node_id as string) : (e.source_node_id as string))
  }

  const toInsert = [...entityIds].filter(id => !connected.has(id)).map(entityId => ({
    user_id: userId, source_node_id: parentId, target_node_id: entityId,
    relation_type: 'inherited_from', evidence: `Inherited from sub-anchor: ${subId}`,
    weight: 0.5, is_inherited: true, inherited_from_anchor_id: subId,
  }))

  if (toInsert.length === 0) return 0
  const { error } = await sb.from('knowledge_edges').insert(toInsert)
  if (error) { console.warn(`  Inheritance error: ${error.message}`); return 0 }
  return toInsert.length
}

// ─── Per-user processing ──────────────────────────────────────────────────────

async function processUser(userId: string, label: string) {
  console.log('')
  console.log('═'.repeat(70))
  console.log(`  ${label}`)
  console.log(`  Mode: ${dryRun ? 'DRY RUN' : 'LIVE'} | Min affinity: ${MIN_AFFINITY}`)
  console.log('═'.repeat(70))

  // Root anchors
  const rootAnchors: Array<{ id: string; label: string; entity_type: string; source_id: string | null }> = []
  let offset = 0
  while (true) {
    const { data } = await sb.from('knowledge_nodes')
      .select('id, label, entity_type, source_id')
      .eq('user_id', userId).eq('is_anchor', true).is('parent_anchor_id', null)
      .range(offset, offset + 999)
    if (!data || data.length === 0) break
    rootAnchors.push(...(data as typeof rootAnchors))
    if (data.length < 1000) break
    offset += 1000
  }
  console.log(`  Root anchors: ${rootAnchors.length}`)
  if (rootAnchors.length === 0) { console.log('  Skipping — no root anchors.'); return }

  // Suggested candidates
  const { data: candRows } = await sb.from('anchor_candidates')
    .select('id, node_id, composite_score').eq('user_id', userId).eq('status', 'suggested')
    .order('composite_score', { ascending: false })
  const candidates = (candRows ?? []) as Array<{ id: string; node_id: string; composite_score: number }>
  console.log(`  Suggested candidates: ${candidates.length}`)
  if (candidates.length === 0) { console.log('  Skipping — no candidates.'); return }

  // Candidate node metadata
  const nodeIds = candidates.map(c => c.node_id).filter(Boolean)
  const nodeMap = new Map<string, { id: string; label: string; entity_type: string; source_id: string | null }>()
  for (let c = 0; c < nodeIds.length; c += 500) {
    const chunk = nodeIds.slice(c, c + 500)
    const { data } = await sb.from('knowledge_nodes')
      .select('id, label, entity_type, source_id, is_anchor').in('id', chunk).eq('user_id', userId)
    for (const n of (data ?? [])) {
      if (!n.is_anchor) nodeMap.set(n.id as string, n as typeof nodeMap extends Map<string, infer V> ? V : never)
    }
  }

  // All edges
  console.log('  Loading edges...')
  type EdgeRow = { source_node_id: string; target_node_id: string }
  const allEdges: EdgeRow[] = []
  offset = 0
  while (true) {
    const { data } = await sb.from('knowledge_edges')
      .select('source_node_id, target_node_id').eq('user_id', userId).range(offset, offset + 999)
    if (!data || data.length === 0) break
    allEdges.push(...(data as EdgeRow[]))
    if (data.length < 1000) break
    offset += 1000
  }

  // Neighbor maps
  const neighborMap = new Map<string, Set<string>>()
  for (const e of allEdges) {
    if (!neighborMap.has(e.source_node_id)) neighborMap.set(e.source_node_id, new Set())
    neighborMap.get(e.source_node_id)!.add(e.target_node_id)
    if (!neighborMap.has(e.target_node_id)) neighborMap.set(e.target_node_id, new Set())
    neighborMap.get(e.target_node_id)!.add(e.source_node_id)
  }

  // Score and assign
  const nowStr = new Date().toISOString()
  let promoted = 0, inheritedTotal = 0

  for (const cand of candidates) {
    const node = nodeMap.get(cand.node_id)
    if (!node) continue

    const candNeighbors = neighborMap.get(cand.node_id) ?? new Set()
    let best: { anchor: typeof rootAnchors[0]; affinity: number; reasons: string[] } | null = null

    for (const anchor of rootAnchors) {
      const anchorNeighbors = neighborMap.get(anchor.id) ?? new Set()
      const hasDirect = candNeighbors.has(anchor.id)
      const sameSource = !!(node.source_id && anchor.source_id && node.source_id === anchor.source_id)
      const result = computeAffinity(candNeighbors, anchorNeighbors, hasDirect, sameSource, node.label, anchor.label)
      if (result.affinity > (best?.affinity ?? 0)) {
        best = { anchor, affinity: result.affinity, reasons: result.reasons }
      }
    }

    if (!best || best.affinity < MIN_AFFINITY) continue

    const reasonStr = `Auto sub-anchor: ${best.reasons.join(', ')}. Affinity: ${best.affinity.toFixed(2)}`

    if (dryRun) {
      console.log(`  [${best.affinity.toFixed(2)}] "${node.label}" → sub of "${best.anchor.label}" (${best.reasons.join(', ')})`)
      promoted++
    } else {
      // 1) Set is_anchor + parent
      const { error: nodeErr } = await sb.from('knowledge_nodes')
        .update({ is_anchor: true, parent_anchor_id: best.anchor.id }).eq('id', cand.node_id)
      if (nodeErr) { console.warn(`  Node error: ${nodeErr.message}`); continue }

      // 2) Update candidate
      const { error: candErr } = await sb.from('anchor_candidates')
        .update({
          status: 'confirmed', reviewed_at: nowStr,
          suggested_parent_anchor_id: best.anchor.id,
          reasoning_text: reasonStr + '.',
        }).eq('id', cand.id)

      if (candErr) {
        await sb.from('knowledge_nodes').update({ is_anchor: false, parent_anchor_id: null }).eq('id', cand.node_id)
        console.warn(`  Candidate error: ${candErr.message}`)
        continue
      }

      // 3) Propagate inheritance
      const edgesCreated = await propagateInheritance(userId, cand.node_id, best.anchor.id)
      inheritedTotal += edgesCreated

      console.log(`  ✓ "${node.label}" → sub of "${best.anchor.label}" (aff=${best.affinity.toFixed(2)}, inherited=${edgesCreated})`)
      promoted++
    }
  }

  // Final counts
  const { count: rootCount } = await sb.from('knowledge_nodes')
    .select('id', { count: 'exact', head: true }).eq('user_id', userId).eq('is_anchor', true).is('parent_anchor_id', null)
  const { count: subCount } = await sb.from('knowledge_nodes')
    .select('id', { count: 'exact', head: true }).eq('user_id', userId).eq('is_anchor', true).not('parent_anchor_id', 'is', null)

  console.log('')
  console.log(`  SUMMARY: ${promoted} sub-anchors ${dryRun ? 'would be ' : ''}created, ${inheritedTotal} inherited edges`)
  console.log(`  Final state: ${rootCount} root anchors, ${subCount} sub-anchors`)
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n  Sub-Anchor Assignment | ${dryRun ? 'DRY RUN' : 'LIVE'} | Min affinity: ${MIN_AFFINITY}`)

  const { data: { users } } = await sb.auth.admin.listUsers()

  if (allUsers) {
    // Get all users with data (paginated)
    const allNodeUserIds = new Set<string>()
    let offset = 0
    while (true) {
      const { data } = await sb.from('knowledge_nodes').select('user_id').range(offset, offset + 4999)
      if (!data || data.length === 0) break
      for (const r of data) allNodeUserIds.add(r.user_id as string)
      if (data.length < 5000) break
      offset += 5000
    }
    // Also include Marisha explicitly
    allNodeUserIds.add('fd34f26f-714a-4807-ab67-c1ef212c8ff9')

    for (const uid of allNodeUserIds) {
      const user = (users ?? []).find(u => u.id === uid)
      await processUser(uid, user?.email ?? uid)
    }
  } else {
    const searchLower = userName.toLowerCase()
    const searchParts = searchLower.split(/\s+/)
    const match = (users ?? []).find(u => {
      const meta = (u.user_metadata?.full_name as string ?? '') + ' ' + (u.user_metadata?.name as string ?? '')
      const email = (u.email ?? '').toLowerCase()
      if (meta.toLowerCase().includes(searchLower)) return true
      if (searchParts.every(part => email.includes(part))) return true
      return false
    })
    if (!match) { console.error(`User "${userName}" not found`); process.exit(1) }
    await processUser(match.id, match.email ?? match.id)
  }
}

main().catch(err => { console.error('Fatal:', err); process.exit(1) })
