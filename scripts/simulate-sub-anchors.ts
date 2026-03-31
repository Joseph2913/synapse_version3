/**
 * Simulate sub-anchor creation: for each suggested anchor candidate,
 * determine which confirmed root anchor it most closely relates to,
 * and propose it as a sub-anchor under that parent.
 *
 * Uses edge proximity (shared neighbors) and label similarity to match.
 *
 * Usage: npx tsx scripts/simulate-sub-anchors.ts [--user-name "Name"] [--all-users]
 */

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'fs'
import { resolve } from 'path'

// Load .env.local
const envPath = resolve(import.meta.dirname ?? '.', '../.env.local')
try {
  const envContent = readFileSync(envPath, 'utf-8')
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx < 0) continue
    const key = trimmed.slice(0, eqIdx).trim()
    const val = trimmed.slice(eqIdx + 1).trim()
    if (!process.env[key]) process.env[key] = val
  }
} catch { /* env already set */ }

const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL!
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!
const sb = createClient(SUPABASE_URL, SUPABASE_KEY)

const args = process.argv.slice(2)
const allUsers = args.includes('--all-users')
const nameIdx = args.indexOf('--user-name')
const userName = nameIdx >= 0 ? args[nameIdx + 1] : 'joseph2000may'

// ─── Types ────────────────────────────────────────────────────────────────────

interface AnchorNode {
  id: string
  label: string
  entity_type: string
  is_anchor: boolean
  parent_anchor_id: string | null
  source_id: string | null
}

interface CandidateRow {
  id: string
  node_id: string
  composite_score: number
  status: string
  reasoning_text: string | null
}

interface SubAnchorProposal {
  candidateId: string
  nodeId: string
  nodeLabel: string
  nodeType: string
  score: number
  parentId: string
  parentLabel: string
  parentType: string
  affinity: number        // 0-1: how strongly this relates to the parent
  sharedNeighbors: number // direct edge overlap
  reasoning: string
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const { data: { users } } = await sb.auth.admin.listUsers()

  if (allUsers) {
    const { data: userRows } = await sb.from('knowledge_nodes').select('user_id')
    const uniqueIds = [...new Set((userRows ?? []).map(r => r.user_id as string))]
    // Also check Marisha
    const marishaId = 'fd34f26f-714a-4807-ab67-c1ef212c8ff9'
    if (!uniqueIds.includes(marishaId)) uniqueIds.push(marishaId)

    for (const uid of uniqueIds) {
      const user = (users ?? []).find(u => u.id === uid)
      await simulateUser(uid, user?.email ?? uid)
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
    if (!match) {
      console.error(`Could not find user "${userName}"`)
      process.exit(1)
    }
    await simulateUser(match.id, match.email ?? match.id)
  }
}

async function simulateUser(userId: string, label: string) {
  console.log('')
  console.log('═'.repeat(75))
  console.log(`  SUB-ANCHOR SIMULATION: ${label}`)
  console.log('═'.repeat(75))

  // 1. Fetch confirmed root anchors (no parent)
  const rootAnchors: AnchorNode[] = []
  let offset = 0
  while (true) {
    const { data } = await sb
      .from('knowledge_nodes')
      .select('id, label, entity_type, is_anchor, parent_anchor_id, source_id')
      .eq('user_id', userId)
      .eq('is_anchor', true)
      .is('parent_anchor_id', null)
      .range(offset, offset + 999)
    if (!data || data.length === 0) break
    rootAnchors.push(...(data as AnchorNode[]))
    if (data.length < 1000) break
    offset += 1000
  }

  console.log(`  Root anchors: ${rootAnchors.length}`)

  if (rootAnchors.length === 0) {
    console.log('  No root anchors — nothing to attach sub-anchors to.')
    return
  }

  // 2. Fetch suggested candidates
  const { data: candidateRows } = await sb
    .from('anchor_candidates')
    .select('id, node_id, composite_score, status, reasoning_text')
    .eq('user_id', userId)
    .eq('status', 'suggested')
    .order('composite_score', { ascending: false })

  const candidates = (candidateRows ?? []) as CandidateRow[]
  console.log(`  Suggested candidates: ${candidates.length}`)

  if (candidates.length === 0) {
    console.log('  No suggested candidates to evaluate.')
    return
  }

  // 3. Fetch candidate node metadata
  const candidateNodeIds = candidates.map(c => c.node_id).filter(Boolean) as string[]
  const candidateNodes = new Map<string, AnchorNode>()

  for (let c = 0; c < candidateNodeIds.length; c += 500) {
    const chunk = candidateNodeIds.slice(c, c + 500)
    const { data } = await sb
      .from('knowledge_nodes')
      .select('id, label, entity_type, is_anchor, parent_anchor_id, source_id')
      .in('id', chunk)
      .eq('user_id', userId)
    for (const n of (data ?? [])) candidateNodes.set(n.id as string, n as AnchorNode)
  }

  // 4. Fetch ALL edges for this user (paginated)
  console.log('  Loading edges...')
  type EdgeRow = { source_node_id: string; target_node_id: string }
  const allEdges: EdgeRow[] = []
  offset = 0
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
  console.log(`  Edges loaded: ${allEdges.length}`)

  // 5. Build neighbor maps
  // For each node, store its direct neighbors
  const neighborMap = new Map<string, Set<string>>()
  function addNeighbor(a: string, b: string) {
    if (!neighborMap.has(a)) neighborMap.set(a, new Set())
    neighborMap.get(a)!.add(b)
  }
  for (const e of allEdges) {
    addNeighbor(e.source_node_id, e.target_node_id)
    addNeighbor(e.target_node_id, e.source_node_id)
  }

  // 6. For each candidate, compute affinity to each root anchor
  const proposals: SubAnchorProposal[] = []
  const rootAnchorIds = new Set(rootAnchors.map(a => a.id))

  for (const candidate of candidates) {
    const nodeId = candidate.node_id
    if (!nodeId) continue
    const node = candidateNodes.get(nodeId)
    if (!node) continue

    // Skip if already an anchor
    if (node.is_anchor) continue

    const candidateNeighbors = neighborMap.get(nodeId) ?? new Set()

    // Direct edge to a root anchor?
    const directParents = [...candidateNeighbors].filter(n => rootAnchorIds.has(n))

    // For each root anchor, compute affinity:
    // - Direct edge: +0.40
    // - Shared neighbors (Jaccard-like): up to +0.40
    // - Same source: +0.10
    // - Compatible entity types: +0.10

    let bestParent: { anchor: AnchorNode; affinity: number; shared: number; reasoning: string } | null = null

    for (const anchor of rootAnchors) {
      const anchorNeighbors = neighborMap.get(anchor.id) ?? new Set()
      let affinity = 0
      const reasons: string[] = []

      // Direct edge
      const hasDirect = candidateNeighbors.has(anchor.id) || directParents.includes(anchor.id)
      if (hasDirect) {
        affinity += 0.40
        reasons.push('direct edge')
      }

      // Shared neighbors (Jaccard coefficient)
      const intersection = [...candidateNeighbors].filter(n => anchorNeighbors.has(n))
      const union = new Set([...candidateNeighbors, ...anchorNeighbors])
      const jaccard = union.size > 0 ? intersection.length / union.size : 0
      const sharedScore = Math.min(jaccard * 4, 0.40) // scale up, cap at 0.40
      affinity += sharedScore
      if (intersection.length > 0) {
        reasons.push(`${intersection.length} shared neighbors`)
      }

      // Same source
      if (node.source_id && anchor.source_id && node.source_id === anchor.source_id) {
        affinity += 0.10
        reasons.push('same source')
      }

      // Label containment bonus (e.g., "AI Risk Management" contains "Risk" which relates to parent "AI upskilling platform")
      const normNode = node.label.toLowerCase()
      const normAnchor = anchor.label.toLowerCase()
      const nodeWords = new Set(normNode.split(/\s+/).filter(w => w.length > 2))
      const anchorWords = new Set(normAnchor.split(/\s+/).filter(w => w.length > 2))
      const wordOverlap = [...nodeWords].filter(w => anchorWords.has(w)).length
      if (wordOverlap > 0) {
        const labelBonus = Math.min(wordOverlap * 0.08, 0.20)
        affinity += labelBonus
        reasons.push(`${wordOverlap} shared label words`)
      }

      affinity = Math.min(affinity, 1.0)

      if (affinity > (bestParent?.affinity ?? 0)) {
        bestParent = {
          anchor,
          affinity,
          shared: intersection.length,
          reasoning: reasons.join(', '),
        }
      }
    }

    // Only propose if affinity is strong enough
    const MIN_AFFINITY = 0.15
    if (bestParent && bestParent.affinity >= MIN_AFFINITY) {
      proposals.push({
        candidateId: candidate.id,
        nodeId,
        nodeLabel: node.label,
        nodeType: node.entity_type,
        score: candidate.composite_score,
        parentId: bestParent.anchor.id,
        parentLabel: bestParent.anchor.label,
        parentType: bestParent.anchor.entity_type,
        affinity: bestParent.affinity,
        sharedNeighbors: bestParent.shared,
        reasoning: bestParent.reasoning,
      })
    }
  }

  // Sort by parent, then affinity descending
  proposals.sort((a, b) => {
    if (a.parentLabel !== b.parentLabel) return a.parentLabel.localeCompare(b.parentLabel)
    return b.affinity - a.affinity
  })

  // 7. Display grouped by parent
  const grouped = new Map<string, SubAnchorProposal[]>()
  for (const p of proposals) {
    const key = p.parentLabel
    if (!grouped.has(key)) grouped.set(key, [])
    grouped.get(key)!.push(p)
  }

  // Also track unmatched candidates
  const matchedNodeIds = new Set(proposals.map(p => p.nodeId))
  const unmatched = candidates.filter(c => c.node_id && !matchedNodeIds.has(c.node_id))

  console.log('')
  console.log(`  RESULTS: ${proposals.length} sub-anchor proposals across ${grouped.size} parent anchors`)
  console.log(`  Unmatched candidates (would stay as standalone suggestions): ${unmatched.length}`)
  console.log('')

  // Summary table
  console.log('  PARENT ANCHOR                          │ SUB-ANCHORS │ AVG AFFINITY')
  console.log('  ───────────────────────────────────────┼─────────────┼─────────────')
  const sortedGroups = [...grouped.entries()].sort((a, b) => b[1].length - a[1].length)
  for (const [parent, subs] of sortedGroups) {
    const avg = (subs.reduce((s, p) => s + p.affinity, 0) / subs.length).toFixed(2)
    console.log(`  ${parent.padEnd(39).slice(0, 39)} │ ${String(subs.length).padStart(11)} │ ${avg}`)
  }

  // Detailed breakdown per parent
  console.log('')
  for (const [parent, subs] of sortedGroups) {
    console.log(`  ┌─ ${parent} (${subs[0]!.parentType})`)
    console.log(`  │`)
    for (const s of subs.slice(0, 15)) {
      const aff = s.affinity.toFixed(2)
      const bar = '█'.repeat(Math.round(s.affinity * 20))
      console.log(`  ├── [${aff}] ${bar} ${s.nodeLabel} (${s.nodeType})`)
      console.log(`  │       ${s.reasoning}`)
    }
    if (subs.length > 15) {
      console.log(`  │   ... and ${subs.length - 15} more`)
    }
    console.log(`  │`)
  }

  // Show top unmatched (standalone suggestions)
  if (unmatched.length > 0) {
    console.log(`  ┌─ UNMATCHED (no strong parent affinity — remain as standalone suggestions)`)
    console.log(`  │`)
    for (const c of unmatched.slice(0, 10)) {
      const node = candidateNodes.get(c.node_id!)
      if (node) {
        console.log(`  ├── ${node.label} (${node.entity_type}) — score: ${c.composite_score.toFixed(3)}`)
      }
    }
    if (unmatched.length > 10) {
      console.log(`  │   ... and ${unmatched.length - 10} more`)
    }
    console.log(`  │`)
  }

  // Affinity distribution
  const brackets = [
    { label: '0.60+    ', min: 0.60, max: 1.01 },
    { label: '0.40–0.59', min: 0.40, max: 0.60 },
    { label: '0.30–0.39', min: 0.30, max: 0.40 },
    { label: '0.20–0.29', min: 0.20, max: 0.30 },
    { label: '0.15–0.19', min: 0.15, max: 0.20 },
  ]

  console.log('  AFFINITY DISTRIBUTION:')
  for (const b of brackets) {
    const count = proposals.filter(p => p.affinity >= b.min && p.affinity < b.max).length
    const bar = '█'.repeat(Math.min(count, 40))
    console.log(`  ${b.label}: ${String(count).padStart(4)} ${bar}`)
  }
  console.log('')
}

main().catch(err => {
  console.error('Fatal:', err)
  process.exit(1)
})
