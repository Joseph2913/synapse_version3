/**
 * Direct skill scan runner — no HTTP, no timeouts.
 * Runs the same logic as api/skills/scan.ts directly against Supabase + Gemini.
 * Outputs results to scripts/skill-scan-results.json
 */
import { readFileSync, writeFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { createClient } from '@supabase/supabase-js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Load env
const envContent = readFileSync(resolve(__dirname, '..', '.env.local'), 'utf-8')
for (const line of envContent.split('\n')) {
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith('#')) continue
  const eqIdx = trimmed.indexOf('=')
  if (eqIdx === -1) continue
  const key = trimmed.slice(0, eqIdx).trim()
  let val = trimmed.slice(eqIdx + 1).trim()
  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1)
  if (!process.env[key]) process.env[key] = val
}

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const GEMINI_API_KEY = process.env.GEMINI_API_KEY
const GEMINI_MODEL = process.env.GEMINI_MODEL ?? 'gemini-2.0-flash'

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const SOURCE_TYPES = ['YouTube', 'Meeting', 'Document', 'Research']
const MIN_CRITERIA_PASS = 3
const MIN_RELEVANCE = 0.20
const LIMIT = 60
const CONCURRENCY = 5 // parallel Gemini calls

const SIGNAL_WEIGHTS = {
  anchorAlignment: 0.25, nodeDensity: 0.20, sourceHistory: 0.20,
  graphProximity: 0.15, profileContext: 0.10, velocity: 0.10,
}

const SKILL_ELIGIBLE_TYPES = new Set([
  'Topic', 'Technology', 'Concept', 'Insight', 'Idea',
  'Hypothesis', 'Lesson', 'Takeaway', 'Methodology',
])

const DOMAIN_ROLE_MAP = {
  technical: ['engineer', 'developer', 'architect', 'cto', 'technical'],
  consulting: ['consultant', 'advisor', 'partner', 'director', 'strategy'],
  strategic: ['founder', 'ceo', 'vp', 'head of', 'lead'],
}

const EVAL_SYSTEM_PROMPT = `You are evaluating content from a personal knowledge graph tool to determine whether it contains teachable, applicable skills.

A skill is defined as: a concept or technique that is specific enough to be applied, general enough to be reused across contexts, and has a discernible method — meaning there is a describable way of doing it, not just knowing about it.

For each candidate concept cluster provided, evaluate it against the following five criteria:

C1 — Instructional Intent: Is this source explicitly teaching, explaining, or demonstrating something?
C2 — Specificity Threshold: Is the concept specific enough to be actionable?
C3 — Reusability Signal: Does this technique apply across more than one context?
C4 — Method Presence: Is there a describable sequence of steps, decisions, or principles?
C5 — Minimum Depth: Does the source spend substantial time on this concept?

Respond ONLY with a JSON array. No preamble, no markdown, no explanation outside the JSON.`

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function log(msg) { console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`) }

async function callGemini(systemPrompt, userPrompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [{ parts: [{ text: userPrompt }] }],
      generationConfig: { temperature: 0.1, maxOutputTokens: 2048 },
    }),
  })
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${await res.text().catch(() => '')}`)
  const data = await res.json()
  return data.candidates?.[0]?.content?.parts?.[0]?.text ?? ''
}

async function generateEmbedding(text) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent?key=${GEMINI_API_KEY}`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'models/text-embedding-004', content: { parts: [{ text }] } }),
  })
  if (!res.ok) throw new Error(`Embedding ${res.status}`)
  const data = await res.json()
  return data.embedding?.values ?? []
}

function parseJSON(text) {
  const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
  try { return JSON.parse(cleaned) } catch { return null }
}

function parseEmbedding(raw) {
  if (Array.isArray(raw)) return raw
  if (typeof raw === 'string') return JSON.parse(raw)
  return []
}

function cosineSim(a, b) {
  if (a.length !== b.length || !a.length) return 0
  let dot = 0, ma = 0, mb = 0
  for (let i = 0; i < a.length; i++) { dot += a[i]*b[i]; ma += a[i]*a[i]; mb += b[i]*b[i] }
  ma = Math.sqrt(ma); mb = Math.sqrt(mb)
  return ma && mb ? dot / (ma * mb) : 0
}

function hashId(input) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507); h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507); h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return ((h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0')).slice(0, 16)
}

function bfsToAnchor(startId, anchorIds, adj) {
  if (anchorIds.has(startId)) return 0
  const visited = new Set([startId])
  let frontier = [startId]
  for (let depth = 1; depth <= 4; depth++) {
    const next = []
    for (const id of frontier) {
      for (const nb of adj[id] ?? []) {
        if (visited.has(nb)) continue
        if (anchorIds.has(nb)) return depth
        visited.add(nb); next.push(nb)
      }
    }
    frontier = next
    if (!frontier.length) break
  }
  return null
}

// Run N promises with concurrency limit
async function pMap(items, fn, concurrency) {
  const results = []
  let idx = 0
  async function worker() {
    while (idx < items.length) {
      const i = idx++
      results[i] = await fn(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()))
  return results
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  const startTime = Date.now()
  log('Starting skill scan...')

  // Target user
  const userId = 'b9264b41-bee4-49a7-a141-c37764f60216' // joseph2000may@gmail.com
  log(`User: ${userId}`)

  // Phase 1: Data assembly
  log('Phase 1: Loading data...')
  const [sourcesRes, nodesRes, edgesRes, anchorsRes, profileRes] = await Promise.all([
    supabase.from('knowledge_sources').select('id, title, source_type, created_at, metadata')
      .eq('user_id', userId).in('source_type', SOURCE_TYPES).order('created_at', { ascending: false }),
    supabase.from('knowledge_nodes').select('id, label, entity_type, confidence, source_id, is_anchor, description, embedding')
      .eq('user_id', userId),
    supabase.from('knowledge_edges').select('source_node_id, target_node_id, relation_type, weight')
      .eq('user_id', userId),
    supabase.from('knowledge_nodes').select('id, label, entity_type, description, embedding')
      .eq('user_id', userId).eq('is_anchor', true),
    supabase.from('user_profiles').select('professional_context, personal_interests, processing_preferences')
      .eq('user_id', userId).maybeSingle(),
  ])

  const sources = sourcesRes.data ?? []
  const allNodes = nodesRes.data ?? []
  const allEdges = edgesRes.data ?? []
  const anchors = anchorsRes.data ?? []
  const profile = profileRes.data

  log(`${sources.length} sources, ${allNodes.length} nodes, ${allEdges.length} edges, ${anchors.length} anchors`)

  if (!sources.length) { log('No sources found. Exiting.'); process.exit(0) }

  // Chunk counts
  const { data: chunkRows } = await supabase.from('source_chunks').select('source_id').eq('user_id', userId)
  const chunkCounts = {}
  for (const r of chunkRows ?? []) { chunkCounts[r.source_id] = (chunkCounts[r.source_id] ?? 0) + 1 }

  // Phase 2: Cluster formation
  log('Phase 2: Forming clusters...')
  const allClusters = []
  for (const source of sources) {
    const eligible = allNodes.filter(n => n.source_id === source.id && SKILL_ELIGIBLE_TYPES.has(n.entity_type))
    if (!eligible.length) continue

    const nodeIdSet = new Set(eligible.map(n => n.id))
    const adj = {}
    for (const n of eligible) adj[n.id] = new Set()
    for (const e of allEdges) {
      if (nodeIdSet.has(e.source_node_id) && nodeIdSet.has(e.target_node_id)) {
        adj[e.source_node_id]?.add(e.target_node_id)
        adj[e.target_node_id]?.add(e.source_node_id)
      }
    }

    const visited = new Set()
    const clusters = []
    for (const node of eligible) {
      if (visited.has(node.id)) continue
      const component = []
      const queue = [node.id]
      while (queue.length) {
        const cur = queue.shift()
        if (visited.has(cur)) continue
        visited.add(cur)
        const n = eligible.find(e => e.id === cur)
        if (n) component.push(n)
        for (const nb of adj[cur] ?? []) { if (!visited.has(nb)) queue.push(nb) }
      }
      if (component.length) {
        const primary = component.reduce((best, n) => (n.confidence ?? 0) > (best.confidence ?? 0) ? n : best, component[0])
        clusters.push({
          sourceId: source.id, label: primary.label, primaryNodeId: primary.id,
          entityTypes: [...new Set(component.map(n => n.entity_type))],
          nodeIds: component.map(n => n.id), nodeLabels: component.map(n => n.label),
          confidence: primary.confidence ?? 0.5,
        })
      }
    }
    allClusters.push(...clusters.sort((a, b) => b.confidence - a.confidence).slice(0, 5))
  }
  log(`${allClusters.length} clusters formed`)

  // Group clusters by source
  const clustersBySource = new Map()
  for (const c of allClusters) {
    if (!clustersBySource.has(c.sourceId)) clustersBySource.set(c.sourceId, [])
    clustersBySource.get(c.sourceId).push(c)
  }

  // Fetch chunks
  log('Fetching source chunks...')
  const sourceIds = [...clustersBySource.keys()]
  const sourceChunkMap = new Map()
  if (sourceIds.length) {
    // Batch in groups of 50 to avoid query limits
    for (let i = 0; i < sourceIds.length; i += 50) {
      const batch = sourceIds.slice(i, i + 50)
      const { data: chunks } = await supabase.from('source_chunks')
        .select('source_id, chunk_index, content').eq('user_id', userId)
        .in('source_id', batch).order('chunk_index', { ascending: true })
      for (const row of chunks ?? []) {
        if (!sourceChunkMap.has(row.source_id)) sourceChunkMap.set(row.source_id, [])
        const arr = sourceChunkMap.get(row.source_id)
        if (arr.length < 6) arr.push(row.content)
      }
    }
  }

  // Phase 4: Gemini evaluation (parallel batches)
  log('Phase 4: Evaluating with Gemini...')
  const evaluationResults = new Map()
  const failedCandidates = []
  let evalErrors = 0

  const sourceEntries = [...clustersBySource.entries()]

  await pMap(sourceEntries, async ([sourceId, clusters]) => {
    const source = sources.find(s => s.id === sourceId)
    if (!source) return

    const chunks = sourceChunkMap.get(sourceId) ?? []
    const chunkContext = chunks.length ? chunks.join('\n\n---\n\n') : `Source: ${source.title ?? 'Untitled'}`
    const candidateList = clusters.map((c, i) => `${i+1}. "${c.label}" (${c.entityTypes.join(', ')})`).join('\n')

    const userPrompt = `Source title: ${source.title ?? 'Untitled'}
Source type: ${source.source_type ?? 'Unknown'}

Source content (top chunks):
${chunkContext}

Candidate clusters to evaluate:
${candidateList}

Return a JSON array with one object per candidate:
[{"candidateLabel":"string","C1":{"pass":true,"rationale":"..."},"C2":{"pass":true,"rationale":"..."},"C3":{"pass":true,"rationale":"..."},"C4":{"pass":true,"rationale":"..."},"C5":{"pass":true,"rationale":"..."},"criteriaPassedCount":5,"suggestedSkillLabel":"string","domain":"technical|consulting|strategic|interpersonal|domain_specific"}]`

    try {
      const raw = await callGemini(EVAL_SYSTEM_PROMPT, userPrompt)
      const evals = parseJSON(raw)
      if (!evals || !Array.isArray(evals)) {
        evalErrors++
        for (const c of clusters) failedCandidates.push({ clusterLabel: c.label, sourceTitle: source.title, source_type: source.source_type, failReason: 'evaluation_error' })
        log(`  FAIL (parse) ${source.title?.slice(0, 50)}`)
        return
      }

      for (let i = 0; i < clusters.length; i++) {
        const cluster = clusters[i]
        const ev = evals[i] ?? evals.find(e => e.candidateLabel === cluster.label)
        if (!ev) { failedCandidates.push({ clusterLabel: cluster.label, sourceTitle: source.title, source_type: source.source_type, failReason: 'evaluation_error' }); continue }

        // C5 override
        if ((chunkCounts[cluster.sourceId] ?? 0) < 3 && ev.C5?.pass) {
          ev.C5 = { pass: false, rationale: 'Fewer than 3 chunks.' }
          ev.criteriaPassedCount = [ev.C1, ev.C2, ev.C3, ev.C4, ev.C5].filter(c => c?.pass).length
        }

        if (ev.criteriaPassedCount >= MIN_CRITERIA_PASS) {
          evaluationResults.set(cluster.primaryNodeId, { ...ev, cluster, source })
        } else {
          const failed = ['C1','C2','C3','C4','C5'].filter(k => !ev[k]?.pass)
          failedCandidates.push({ clusterLabel: cluster.label, sourceTitle: source.title, source_type: source.source_type, failReason: 'insufficient_criteria', criteriaPassedCount: ev.criteriaPassedCount, failedCriteria: failed })
        }
      }
      log(`  OK ${source.title?.slice(0, 60)} (${clusters.length} clusters)`)
    } catch (err) {
      evalErrors++
      for (const c of clusters) failedCandidates.push({ clusterLabel: c.label, sourceTitle: source.title, source_type: source.source_type, failReason: 'evaluation_error' })
      log(`  ERR ${source.title?.slice(0, 50)}: ${err.message?.slice(0, 80)}`)
    }
  }, CONCURRENCY)

  log(`${evaluationResults.size} passed universal layer, ${failedCandidates.length} failed, ${evalErrors} errors`)

  // Phase 5: Personalised scoring
  log('Phase 5: Scoring relevance...')

  const graphAdj = {}
  for (const e of allEdges) {
    if (!graphAdj[e.source_node_id]) graphAdj[e.source_node_id] = []
    if (!graphAdj[e.target_node_id]) graphAdj[e.target_node_id] = []
    graphAdj[e.source_node_id].push(e.target_node_id)
    graphAdj[e.target_node_id].push(e.source_node_id)
  }

  const anchorIds = new Set(anchors.map(a => a.id))
  const nodeCountBySource = {}
  for (const n of allNodes) { if (n.source_id) nodeCountBySource[n.source_id] = (nodeCountBySource[n.source_id] ?? 0) + 1 }
  const maxNodeCount = Math.max(1, ...Object.values(nodeCountBySource))

  const userRole = (profile?.professional_context?.role ?? '').toLowerCase()
  let userDomain = null
  for (const [domain, kws] of Object.entries(DOMAIN_ROLE_MAP)) {
    if (kws.some(kw => userRole.includes(kw))) { userDomain = domain; break }
  }

  const fourteenDaysAgo = new Date(Date.now() - 14*24*60*60*1000).toISOString()

  const candidates = []

  for (const [nodeId, entry] of evaluationResults) {
    const { cluster, source, ...ev } = entry
    const keyword = (ev.suggestedSkillLabel ?? '').split(/\s+/).slice(0, 3).join(' ').toLowerCase()

    // S1
    let s1 = 0, matchedAnchor = null
    const skillLabel = ev.suggestedSkillLabel || cluster.label
    if (anchors.length && skillLabel) {
      try {
        const emb = await generateEmbedding(skillLabel)
        for (const a of anchors) {
          const anchorEmb = parseEmbedding(a.embedding)
          if (!anchorEmb.length) continue
          const sim = cosineSim(emb, anchorEmb)
          if (sim > s1) { s1 = sim; matchedAnchor = a.label }
        }
      } catch (err) {
        log(`  S1 error for "${skillLabel}": ${err.message?.slice(0, 80)}`)
      }
    }

    // S2
    const relatedNodes = allNodes.filter(n => {
      return n.label.toLowerCase().includes(keyword) ||
        (n.source_id === cluster.sourceId && ['Topic','Technology','Concept'].includes(n.entity_type))
    })
    const s2 = Math.min(relatedNodes.length / maxNodeCount, 1)

    // S3
    const relatedSourceIds = new Set(relatedNodes.filter(n => n.source_id).map(n => n.source_id))
    const s3 = Math.min(relatedSourceIds.size / 3, 1)

    // S4
    const hops = bfsToAnchor(cluster.primaryNodeId, anchorIds, graphAdj)
    const s4 = hops === null ? 0 : hops <= 1 ? 1.0 : hops === 2 ? 0.6 : hops === 3 ? 0.3 : 0

    // S5
    let mult = 1.0
    if (userDomain && ev.domain) {
      if (ev.domain === userDomain) mult = 1.3
      else mult = 0.7
    }
    const s5 = Math.min(0.5 * mult, 1)

    // S6
    const recentSources = [...relatedSourceIds].filter(sid => { const s = sources.find(x => x.id === sid); return s && s.created_at >= fourteenDaysAgo })
    const s6 = recentSources.length === 0 ? 0 : recentSources.length === 1 ? 0.5 : 1

    const relevance = +(s1*0.25 + s2*0.20 + s3*0.20 + s4*0.15 + s5*0.10 + s6*0.10).toFixed(2)
    if (relevance < MIN_RELEVANCE) continue

    const status = relevance >= 0.55 ? 'confirmed_candidate' : relevance >= 0.35 ? 'pending_reinforcement' : 'weak_signal'

    let exposure = 'novice'
    if (s1 > 0.7 && s3 > 0.6 && s2 > 0.6) exposure = 'advanced'
    else if (source.source_type === 'Meeting' && s2 > 0.6) exposure = 'proficient'
    else if (s2 > 0.6) exposure = 'proficient'
    else if (s2 >= 0.3 || s3 >= 0.5) exposure = 'developing'

    // Related anchors
    const relatedAnchors = []
    if (anchors.length && s1 > 0) {
      try {
        const emb = await generateEmbedding(skillLabel)
        for (const a of anchors) {
          const anchorEmb2 = parseEmbedding(a.embedding)
          if (!anchorEmb2.length) continue
          const sim = cosineSim(emb, anchorEmb2)
          if (sim > 0.3) relatedAnchors.push({ label: a.label, entity_type: a.entity_type, similarityScore: +sim.toFixed(2) })
        }
        relatedAnchors.sort((a, b) => b.similarityScore - a.similarityScore)
      } catch {}
    }

    const contributingSources = [...relatedSourceIds]
      .filter(sid => sid !== source.id)
      .map(sid => sources.find(s => s.id === sid))
      .filter(Boolean)
      .map(s => ({ id: s.id, title: s.title, source_type: s.source_type }))
      .slice(0, 5)

    candidates.push({
      id: hashId(userId + cluster.sourceId + cluster.label),
      suggestedSkillLabel: ev.suggestedSkillLabel || cluster.label,
      domain: ev.domain,
      status, exposureLevel: exposure,
      criteriaPassedCount: ev.criteriaPassedCount,
      criteria: { C1: ev.C1, C2: ev.C2, C3: ev.C3, C4: ev.C4, C5: ev.C5 },
      relevanceScore: relevance,
      signalBreakdown: {
        anchorAlignment: { score: +s1.toFixed(2), matchedAnchor },
        nodeDensity: { score: +s2.toFixed(2), relatedNodeCount: relatedNodes.length },
        sourceHistory: { score: +s3.toFixed(2), relatedSourceCount: relatedSourceIds.size },
        graphProximity: { score: +s4.toFixed(2), hopsToNearestAnchor: hops },
        profileContext: { score: +s5.toFixed(2), multiplierApplied: mult },
        velocity: { score: +s6.toFixed(2), recentSourceCount: recentSources.length },
      },
      primarySource: { id: source.id, title: source.title, source_type: source.source_type, created_at: source.created_at },
      contributingSources, relatedAnchors,
      primaryNodeLabel: cluster.label,
      clusterNodeLabels: cluster.nodeLabels,
    })
  }

  candidates.sort((a, b) => b.relevanceScore - a.relevanceScore)
  const trimmed = candidates.slice(0, LIMIT)

  const result = {
    meta: {
      scannedAt: new Date().toISOString(),
      sourcesScanned: sources.length,
      clustersEvaluated: allClusters.length,
      confirmedCandidates: trimmed.filter(c => c.status === 'confirmed_candidate').length,
      pendingCandidates: trimmed.filter(c => c.status === 'pending_reinforcement').length,
      weakSignalCandidates: trimmed.filter(c => c.status === 'weak_signal').length,
      failedUniversal: failedCandidates.length,
      evaluationErrors: evalErrors,
      durationMs: Date.now() - startTime,
    },
    candidates: trimmed,
    failedCandidates,
  }

  const outPath = resolve(__dirname, 'skill-scan-results.json')
  writeFileSync(outPath, JSON.stringify(result, null, 2))

  log(`\nDone in ${((Date.now() - startTime) / 1000).toFixed(1)}s`)
  log(`${result.meta.confirmedCandidates} confirmed, ${result.meta.pendingCandidates} pending, ${result.meta.weakSignalCandidates} weak signal`)
  log(`Results saved to ${outPath}`)

  // Print summary
  console.log('\n═══ TOP SKILL CANDIDATES ═══\n')
  for (const c of trimmed.slice(0, 20)) {
    const stars = c.status === 'confirmed_candidate' ? '***' : c.status === 'pending_reinforcement' ? '**' : '*'
    console.log(`${stars} ${c.suggestedSkillLabel} (${c.relevanceScore}) [${c.domain}] [${c.exposureLevel}]`)
    console.log(`   Source: ${c.primarySource.title?.slice(0, 70)}`)
    console.log(`   Criteria: ${c.criteriaPassedCount}/5 | Anchors: ${c.relatedAnchors.map(a => a.label).join(', ') || 'none'}`)
    console.log()
  }
}

main().catch(err => { console.error('Fatal:', err); process.exit(1) })
