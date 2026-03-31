/**
 * One-time script: retroactively score anchor candidates for a specific user.
 * Usage: npx tsx scripts/backfill-user-anchors.ts [--dry-run] [--user-name "Name"]
 *
 * Loads env from .env.local, finds the user, scores all their non-anchor nodes,
 * and upserts anchor_candidates.
 */

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'fs'
import { resolve } from 'path'

// Load .env.local manually (no dotenv dependency)
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

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local')
  process.exit(1)
}

const sb = createClient(SUPABASE_URL, SUPABASE_KEY)

// ─── Args ─────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const allUsers = args.includes('--all-users')
const nameIdx = args.indexOf('--user-name')
const userName = nameIdx >= 0 ? args[nameIdx + 1] : 'Marisha Boyd'

// ─── Scoring config (matches new lowered thresholds) ──────────────────────────
type ScoringProfile = 'balanced' | 'emerging_topics' | 'deep_concepts' | 'active_focus' | 'well_evidenced'

const DEFAULT_SUGGESTION_THRESHOLD = 0.25
const AUTO_CONFIRM_THRESHOLD = 0.45

const SIGNAL_WEIGHTS: Record<ScoringProfile, { centrality: number; diversity: number; richness: number }> = {
  balanced:        { centrality: 0.50, diversity: 0.30, richness: 0.20 },
  emerging_topics: { centrality: 0.25, diversity: 0.25, richness: 0.50 },
  deep_concepts:   { centrality: 0.55, diversity: 0.20, richness: 0.25 },
  active_focus:    { centrality: 0.35, diversity: 0.25, richness: 0.40 },
  well_evidenced:  { centrality: 0.30, diversity: 0.50, richness: 0.20 },
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function resolveUserThreshold(userId: string): Promise<{ scoringProfile: ScoringProfile; threshold: number }> {
  const { data: profileRow } = await sb
    .from('user_profiles')
    .select('processing_preferences')
    .eq('user_id', userId)
    .maybeSingle()

  const prefs = ((profileRow?.processing_preferences ?? {}) as Record<string, unknown>)
  const anchorSettings = ((prefs.anchor_settings ?? {}) as Record<string, unknown>)
  const scoringProfile = (anchorSettings.scoringProfile as ScoringProfile) ?? 'balanced'
  const thresholdIdx = args.indexOf('--threshold')
  const threshold = thresholdIdx >= 0 ? parseFloat(args[thresholdIdx + 1]!) : ((anchorSettings.suggestionThreshold as number) ?? DEFAULT_SUGGESTION_THRESHOLD)
  return { scoringProfile, threshold }
}

async function main() {
  console.log(`\n   Mode: ${dryRun ? 'DRY RUN (no writes)' : 'LIVE (will write to DB)'}`)
  console.log(`   Auto-confirm threshold: ${AUTO_CONFIRM_THRESHOLD}`)
  console.log('')

  // 1. List all users
  const { data: { users }, error: authErr } = await sb.auth.admin.listUsers()
  if (authErr) {
    console.error('Failed to list auth users:', authErr.message)
    process.exit(1)
  }

  if (allUsers) {
    // Run for ALL users with data
    console.log(`🔍 Running backfill for ALL users (${(users ?? []).length} total)`)
    console.log('')

    // Find users who have nodes
    const { data: userRows } = await sb.from('knowledge_nodes').select('user_id')
    const uniqueUserIds = [...new Set((userRows ?? []).map(r => r.user_id as string))]
    console.log(`   Users with data: ${uniqueUserIds.length}`)
    console.log('')

    for (const uid of uniqueUserIds) {
      const user = (users ?? []).find(u => u.id === uid)
      const label = user?.email ?? uid
      console.log(`\n${'═'.repeat(70)}`)
      console.log(`  USER: ${label}`)
      console.log(`${'═'.repeat(70)}`)

      const { scoringProfile, threshold } = await resolveUserThreshold(uid)
      console.log(`   Profile: ${scoringProfile}, threshold: ${threshold}`)
      await runBackfill(uid, scoringProfile, threshold)
    }
  } else {
    // Single user mode
    console.log(`🔍 Looking up user: "${userName}"`)

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
      console.error(`   Could not find user matching "${userName}"`)
      console.log('\n   All platform users:')
      for (const u of (users ?? [])) {
        const name = (u.user_metadata?.full_name ?? u.user_metadata?.name ?? '') as string
        console.log(`     - ${name || '(no name)'} | ${u.email ?? '(no email)'} | ${u.id}`)
      }
      process.exit(1)
    }

    const userId = match.id
    const displayName = (match.user_metadata?.full_name ?? match.user_metadata?.name ?? match.email) as string
    console.log(`   Found: ${displayName} (${match.email}) — ${userId}`)
    console.log(`   Total platform users: ${(users ?? []).length}`)

    const { scoringProfile, threshold } = await resolveUserThreshold(userId)
    console.log(`   Scoring profile: ${scoringProfile}, threshold: ${threshold}`)
    console.log('')

    await runBackfill(userId, scoringProfile, threshold)
  }
}

async function runBackfill(userId: string, scoringProfile: ScoringProfile, threshold: number) {
  const w = SIGNAL_WEIGHTS[scoringProfile]
  const now = Date.now()

  // 2. Fetch all non-anchor nodes (paginated to avoid 1000-row limit)
  console.log('📊 Fetching nodes...')
  type NodeRow = {
    id: string; label: string; source_id: string | null; source_type: string | null
    entity_type: string; is_anchor: boolean; created_at: string
  }
  const nodes: NodeRow[] = []
  const pageSize = 1000
  let offset = 0
  while (true) {
    const { data: page, error: pageErr } = await sb
      .from('knowledge_nodes')
      .select('id, label, source_id, source_type, entity_type, is_anchor, created_at')
      .eq('user_id', userId)
      .eq('is_anchor', false)
      .range(offset, offset + pageSize - 1)

    if (pageErr) { console.error('Node fetch error:', pageErr.message); process.exit(1) }
    if (!page || page.length === 0) break
    nodes.push(...(page as NodeRow[]))
    if (page.length < pageSize) break
    offset += pageSize
  }

  // Also count anchors
  const { count: anchorCount } = await sb
    .from('knowledge_nodes')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('is_anchor', true)

  const { count: totalNodeCount } = await sb
    .from('knowledge_nodes')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)

  console.log(`   Total nodes: ${totalNodeCount}`)
  console.log(`   Current anchors: ${anchorCount}`)
  console.log(`   Non-anchor nodes: ${nodes.length}`)
  console.log('')

  if (nodes.length === 0) {
    console.log('   No non-anchor nodes to score. Done.')
    return
  }

  const nodeIds = nodes.map(n => n.id)
  const nodeMap = new Map(nodes.map(n => [n.id, n]))

  // 3. Fetch ALL edges for this user (paginated, not chunked by node ID)
  console.log('📊 Fetching edges...')
  type EdgeRow = { source_node_id: string; target_node_id: string; relation_type: string }
  const allEdgesRaw: EdgeRow[] = []
  offset = 0
  while (true) {
    const { data: page } = await sb
      .from('knowledge_edges')
      .select('source_node_id, target_node_id, relation_type')
      .eq('user_id', userId)
      .range(offset, offset + pageSize - 1)

    if (!page || page.length === 0) break
    allEdgesRaw.push(...(page as EdgeRow[]))
    if (page.length < pageSize) break
    offset += pageSize
  }

  // Split into out/in relative to our node set
  const nodeIdSet = new Set(nodeIds)
  const allOutEdges = allEdgesRaw.filter(e => nodeIdSet.has(e.source_node_id))
  const allInEdges  = allEdgesRaw.filter(e => nodeIdSet.has(e.target_node_id))

  const totalEdges = new Set([
    ...allOutEdges.map(e => `${e.source_node_id}-${e.target_node_id}`),
    ...allInEdges.map(e => `${e.source_node_id}-${e.target_node_id}`),
  ]).size
  console.log(`   Unique edges loaded: ${totalEdges}`)
  console.log('')

  // Build per-node edge counts
  const nodeEdgeCounts = new Map<string, number>()
  for (const e of [...allOutEdges, ...allInEdges]) {
    if (nodeMap.has(e.source_node_id)) nodeEdgeCounts.set(e.source_node_id, (nodeEdgeCounts.get(e.source_node_id) ?? 0) + 1)
    if (nodeMap.has(e.target_node_id)) nodeEdgeCounts.set(e.target_node_id, (nodeEdgeCounts.get(e.target_node_id) ?? 0) + 1)
  }

  const minEdgesArg = parseInt(args[args.indexOf('--min-edges') + 1] || '') || 1
  const eligibleIds = nodeIds.filter(id => (nodeEdgeCounts.get(id) ?? 0) >= minEdgesArg)
  console.log(`   Nodes with >= ${minEdgesArg} edges (eligible): ${eligibleIds.length}`)

  // 4. Fetch neighbour metadata
  console.log('📊 Fetching neighbour metadata...')
  const eligibleSet = new Set(eligibleIds)
  const neighbourIds = new Set<string>()
  for (const e of [...allOutEdges, ...allInEdges]) {
    if (eligibleSet.has(e.source_node_id)) neighbourIds.add(e.target_node_id)
    if (eligibleSet.has(e.target_node_id)) neighbourIds.add(e.source_node_id)
  }
  for (const id of eligibleIds) neighbourIds.delete(id)

  const nbList = Array.from(neighbourIds)
  const neighbourMap = new Map<string, { entity_type: string; is_anchor: boolean; source_id: string | null; source_type: string | null }>()
  const nbChunkSize = 500

  for (let c = 0; c < nbList.length; c += nbChunkSize) {
    const chunk = nbList.slice(c, c + nbChunkSize)
    const { data: nbNodes } = await sb
      .from('knowledge_nodes')
      .select('id, entity_type, is_anchor, source_id, source_type')
      .in('id', chunk)
      .eq('user_id', userId)
    for (const n of (nbNodes ?? [])) {
      neighbourMap.set(n.id as string, n as typeof neighbourMap extends Map<string, infer V> ? V : never)
    }
  }

  // 5. Fetch existing candidates
  const { data: existingCandidates } = await sb
    .from('anchor_candidates')
    .select('id, node_id, status, dismiss_count, composite_score')
    .eq('user_id', userId)
    .in('node_id', eligibleIds)

  const existingMap = new Map(
    (existingCandidates ?? []).map(c => [c.node_id as string, c])
  )
  console.log(`   Existing anchor_candidates rows: ${existingMap.size}`)
  console.log('')

  // 6. Score all eligible nodes
  console.log('⚡ Scoring...')
  const protectedStatuses = ['confirmed', 'dismissed', 'archived', 'dormant']
  const nowStr = new Date().toISOString()

  interface ScoredNode {
    nodeId: string
    label: string
    entityType: string
    composite: number
    centrality: number
    diversity: number
    richness: number
    edgeCount: number
    sourceCount: number
    wouldSurface: boolean
    isNew: boolean
    currentStatus: string | null
  }

  const results: ScoredNode[] = []

  for (const nodeId of eligibleIds) {
    const nodeRow = nodeMap.get(nodeId)
    if (!nodeRow) continue

    const myOut = allOutEdges.filter(e => e.source_node_id === nodeId)
    const myIn  = allInEdges.filter(e => e.target_node_id === nodeId)
    const myAll = [...myOut, ...myIn]

    const relTypes = new Set(myAll.map(e => e.relation_type).filter(Boolean))
    const nbTypeSet = new Set<string>()
    let anchorNb = 0, totalNb = 0

    const srcIdSet = new Set<string>()
    const srcTypeSet = new Set<string>()
    if (nodeRow.source_id) srcIdSet.add(nodeRow.source_id)
    if (nodeRow.source_type) srcTypeSet.add(nodeRow.source_type)

    for (const e of myOut) {
      const nb = neighbourMap.get(e.target_node_id)
      if (nb) {
        nbTypeSet.add(nb.entity_type); totalNb++
        if (nb.is_anchor) anchorNb++
        if (nb.source_id) srcIdSet.add(nb.source_id)
        if (nb.source_type) srcTypeSet.add(nb.source_type)
      }
    }
    for (const e of myIn) {
      const nb = neighbourMap.get(e.source_node_id)
      if (nb) {
        nbTypeSet.add(nb.entity_type); totalNb++
        if (nb.is_anchor) anchorNb++
        if (nb.source_id) srcIdSet.add(nb.source_id)
        if (nb.source_type) srcTypeSet.add(nb.source_type)
      }
    }

    const degreeScore     = Math.min(myAll.length / 20, 1.0)
    const diversityFactor = Math.min(nbTypeSet.size / 5, 1.0)
    const centralityScore = (degreeScore * 0.6) + (diversityFactor * 0.4)

    const sourceCountScore = Math.min(srcIdSet.size / 4, 1.0)
    const typeCountScore   = Math.min(srcTypeSet.size / 3, 1.0)
    const diversityScore   = (sourceCountScore * 0.65) + (typeCountScore * 0.35)

    const richnessScore = Math.min(relTypes.size / 6, 1.0)

    let composite = (centralityScore * w.centrality) +
      (diversityScore * w.diversity) + (richnessScore * w.richness)

    const overlapRatio = anchorNb / Math.max(totalNb, 1)
    if (overlapRatio > 0.70) composite *= 0.75

    const daysActive = Math.max(1, Math.floor((now - new Date(nodeRow.created_at).getTime()) / 86400000))
    const edgeDensity = Math.min(myAll.length / Math.max(daysActive, 1), 1.0)
    const historyBoost = 0.80 + (edgeDensity * 0.20)
    composite = Math.min(Math.max(composite * historyBoost, 0), 1.0)

    const shouldSurface = composite >= threshold
    const existing = existingMap.get(nodeId)

    results.push({
      nodeId,
      label: nodeRow.label,
      entityType: nodeRow.entity_type,
      composite,
      centrality: centralityScore,
      diversity: diversityScore,
      richness: richnessScore,
      edgeCount: myAll.length,
      sourceCount: srcIdSet.size,
      wouldSurface: shouldSurface,
      isNew: !existing,
      currentStatus: existing ? (existing.status as string) : null,
    })
  }

  // Sort by composite score descending
  results.sort((a, b) => b.composite - a.composite)

  // 7. Print results — tiered threshold breakdown
  const thresholds = [0.50, 0.40, 0.35, 0.30, 0.25, 0.20, 0.15, 0.10]

  console.log('')
  console.log('═══════════════════════════════════════════════════════════════════════════')
  console.log(`  ANCHOR CANDIDATE ANALYSIS FOR: ${userName}`)
  console.log(`  Total nodes: ${results.length + (nodeIds.length - eligibleIds.length)} | Scored: ${results.length} | Current anchors: ${anchorCount}`)
  console.log('═══════════════════════════════════════════════════════════════════════════')
  console.log('')

  // Summary table
  console.log('  THRESHOLD SUMMARY')
  console.log('  ─────────────────────────────────────────────────────────────')
  console.log('  Threshold │ Anchors │  % of graph │ Bar')
  console.log('  ──────────┼─────────┼─────────────┼──────────────────────────')
  for (const t of thresholds) {
    const count = results.filter(r => r.composite >= t).length
    const pct = ((count / (results.length + (nodeIds.length - eligibleIds.length))) * 100).toFixed(1)
    const bar = '█'.repeat(Math.min(Math.ceil(count / 3), 50))
    console.log(`     ${t.toFixed(2)}  │ ${String(count).padStart(7)} │ ${pct.padStart(10)}% │ ${bar}`)
  }
  console.log('')

  // Deduplicate by normalized label similarity
  const surfaceList = results.filter(r => r.composite >= threshold)

  function normalize(s: string): string {
    return s.toLowerCase().replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim()
  }

  function isSimilar(a: string, b: string): boolean {
    const na = normalize(a), nb = normalize(b)
    // Exact match after normalization
    if (na === nb) return true
    // One contains the other
    if (na.includes(nb) || nb.includes(na)) return true
    // Check if one is a subset of the other's words
    const wa = new Set(na.split(' ')), wb = new Set(nb.split(' '))
    const overlap = [...wa].filter(w => wb.has(w)).length
    const minSize = Math.min(wa.size, wb.size)
    if (minSize > 0 && overlap / minSize >= 0.8) return true
    return false
  }

  // Keep highest-scoring variant of each duplicate cluster
  const deduped: typeof surfaceList = []
  const consumed = new Set<number>()

  for (let i = 0; i < surfaceList.length; i++) {
    if (consumed.has(i)) continue
    const best = surfaceList[i]!
    // Find all duplicates of this entry
    const dupes: string[] = []
    for (let j = i + 1; j < surfaceList.length; j++) {
      if (consumed.has(j)) continue
      if (isSimilar(best.label, surfaceList[j]!.label)) {
        dupes.push(surfaceList[j]!.label)
        consumed.add(j)
      }
    }
    deduped.push({ ...best, label: best.label + (dupes.length > 0 ? `  (also: ${dupes.join(', ')})` : '') })
    consumed.add(i)
  }

  // Group by threshold tier
  const tiers = [
    { name: 'Tier 1  (score >= 0.40)', min: 0.40, max: 1.01 },
    { name: 'Tier 2  (score 0.35–0.39)', min: 0.35, max: 0.40 },
    { name: 'Tier 3  (score 0.30–0.34)', min: 0.30, max: 0.35 },
    { name: 'Tier 4  (score 0.25–0.29)', min: 0.25, max: 0.30 },
    { name: 'Tier 5  (score 0.20–0.24)', min: 0.20, max: 0.25 },
  ]

  console.log(`  UNIQUE ANCHORS AT THRESHOLD ${threshold}: ${deduped.length} (deduped from ${surfaceList.length})`)
  console.log('  ═══════════════════════════════════════════════════════════════════════════')

  let rank = 0
  for (const tier of tiers) {
    const tierItems = deduped.filter(r => r.composite >= tier.min && r.composite < tier.max)
    if (tierItems.length === 0) continue

    console.log('')
    console.log(`  ${tier.name} — ${tierItems.length} anchors`)
    console.log('  ────┼───────┼───────┼──────┼────────────────┼─────────────────────────')
    for (const r of tierItems) {
      rank++
      const rk = String(rank).padStart(3)
      const score = r.composite.toFixed(3).padStart(5)
      const edges = String(r.edgeCount).padStart(5)
      const srcs  = String(r.sourceCount).padStart(4)
      const type  = r.entityType.padEnd(14)
      console.log(`  ${rk} │ ${score} │ ${edges} │ ${srcs} │ ${type} │ ${r.label}`)
    }
  }

  console.log('')
  console.log(`  Total unique anchors: ${deduped.length}`)
  console.log('')

  // Entity type summary
  const typeBreakdown: Record<string, number> = {}
  for (const r of deduped) {
    const baseType = r.entityType
    typeBreakdown[baseType] = (typeBreakdown[baseType] ?? 0) + 1
  }
  const sortedTypes = Object.entries(typeBreakdown).sort((a, b) => b[1] - a[1])
  console.log('  ENTITY TYPE MIX:')
  console.log('  ' + sortedTypes.map(([t, c]) => `${t}(${c})`).join('  '))

  console.log('')

  // Full score distribution
  const brackets = [
    { label: '0.50+    ', min: 0.50, max: 1.01 },
    { label: '0.40–0.49', min: 0.40, max: 0.50 },
    { label: '0.35–0.39', min: 0.35, max: 0.40 },
    { label: '0.30–0.34', min: 0.30, max: 0.35 },
    { label: '0.25–0.29', min: 0.25, max: 0.30 },
    { label: '0.20–0.24', min: 0.20, max: 0.25 },
    { label: '0.15–0.19', min: 0.15, max: 0.20 },
    { label: '0.10–0.14', min: 0.10, max: 0.15 },
    { label: '<0.10    ', min: 0.00, max: 0.10 },
  ]

  console.log('  SCORE DISTRIBUTION:')
  console.log('  ─────────────────────────────────────────────────────────────')
  for (const b of brackets) {
    const count = results.filter(r => r.composite >= b.min && r.composite < b.max).length
    const bar = '█'.repeat(Math.min(Math.ceil(count / 2), 50))
    console.log(`  ${b.label}: ${String(count).padStart(4)} ${bar}`)
  }
  console.log('')

  // 8. Write if not dry run
  if (dryRun) {
    console.log('  ⚠️  DRY RUN — no changes written. Run without --dry-run to apply.')
  } else {
    console.log('  ✏️  Writing to database...')
    let written = 0, surfacedCount = 0, autoConfirmedCount = 0, updated = 0

    for (const r of results) {
      const existing = existingMap.get(r.nodeId)
      const parts: string[] = []
      if (r.edgeCount >= 10) parts.push(`${r.edgeCount} total connections`)
      else parts.push(`${r.edgeCount} connections`)
      if (r.sourceCount >= 2) parts.push(`across ${r.sourceCount} sources`)
      const reasoningText = parts.join(', ') + '. (Retroactive backfill)'

      const shouldAutoConfirm = r.composite >= AUTO_CONFIRM_THRESHOLD

      if (existing) {
        const updatePayload: Record<string, unknown> = {
          composite_score: r.composite,
          centrality_score: r.centrality,
          diversity_score: r.diversity,
          velocity_score: 0,
          richness_score: r.richness,
          mention_count: r.edgeCount,
          source_count: r.sourceCount,
          unique_source_types: 0,
          scoring_profile: 'balanced',
          reasoning_text: reasoningText,
          last_scored_at: nowStr,
          threshold_at_scoring: threshold,
        }

        if (shouldAutoConfirm && !['confirmed', 'archived', 'dormant'].includes(existing.status as string)) {
          updatePayload.status = 'confirmed'
          updatePayload.reviewed_at = nowStr
          updatePayload.suggested_at = nowStr
          autoConfirmedCount++
          await sb.from('knowledge_nodes').update({ is_anchor: true }).eq('id', r.nodeId)
        } else if (!protectedStatuses.includes(existing.status as string) && r.wouldSurface && existing.status === 'pending') {
          updatePayload.status = 'suggested'
          updatePayload.suggested_at = nowStr
          surfacedCount++
        }

        await sb.from('anchor_candidates').update(updatePayload).eq('id', existing.id as string)
        updated++
      } else {
        const insertStatus = shouldAutoConfirm ? 'confirmed' : (r.wouldSurface ? 'suggested' : 'pending')
        await sb.from('anchor_candidates').insert({
          user_id: userId, node_id: r.nodeId,
          composite_score: r.composite, centrality_score: r.centrality,
          diversity_score: r.diversity, velocity_score: 0,
          richness_score: r.richness, behavioural_score: 0,
          mention_count: r.edgeCount, source_count: r.sourceCount,
          unique_source_types: 0, days_active: 0,
          recent_velocity: 0, velocity_direction: 'stable',
          status: insertStatus, scoring_profile: 'balanced',
          reasoning_text: reasoningText,
          threshold_at_scoring: threshold,
          suggested_at: insertStatus !== 'pending' ? nowStr : null,
          reviewed_at: insertStatus === 'confirmed' ? nowStr : null,
          first_scored_at: nowStr, last_scored_at: nowStr,
        })
        written++
        if (insertStatus === 'confirmed') {
          autoConfirmedCount++
          await sb.from('knowledge_nodes').update({ is_anchor: true }).eq('id', r.nodeId)
        } else if (insertStatus === 'suggested') {
          surfacedCount++
        }
      }
    }

    console.log(`   Done! New rows: ${written}, Updated: ${updated}`)
    console.log(`   Auto-confirmed (is_anchor=true): ${autoConfirmedCount}`)
    console.log(`   Suggested (awaiting review): ${surfacedCount}`)
  }

  console.log('')
}

main().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})
