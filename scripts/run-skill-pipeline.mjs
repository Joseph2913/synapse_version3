/**
 * PRD-25b Skill Candidacy Backfill + Retroactive Skill Pipeline
 *
 * Runs the full pipeline in order:
 *   1. tag-sources dry run
 *   2. tag-sources commit
 *   3. Verify tags via Supabase query
 *   4. process-source for each candidate (500ms delay between calls)
 *   5. rescore (when_to_apply / how_to_apply)
 *   6. Final knowledge_skills query
 *
 * Uses service role key directly — same pattern as run-skill-scan.mjs
 */

import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { createClient } from '@supabase/supabase-js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ─── ENV LOAD ─────────────────────────────────────────────────────────────────

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
const USER_ID = 'b9264b41-bee4-49a7-a141-c37764f60216'

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

// ─── LOGGING ──────────────────────────────────────────────────────────────────

function log(msg) { console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`) }
function logSection(title) { console.log(`\n${'═'.repeat(60)}\n  ${title}\n${'═'.repeat(60)}`) }
function logJSON(label, obj) { console.log(`\n${label}:\n${JSON.stringify(obj, null, 2)}`) }

// ─── SHARED HELPERS ───────────────────────────────────────────────────────────

const SOURCE_TYPE_SCORES = { YouTube: 1.0, Document: 0.7, Research: 0.7, Meeting: 0.4, Note: 0.2, Web: 0.5 }
const INSTRUCTIONAL_TYPES = new Set(['Topic', 'Technology', 'Concept', 'Insight', 'Idea', 'Hypothesis', 'Lesson', 'Takeaway'])

function evaluateCandidacy(sourceType, entityTypeCounts, chunkCount) {
  const check1 = SOURCE_TYPE_SCORES[sourceType] ?? 0.3
  const check1Pass = check1 >= 0.5
  let totalEntities = 0, instructionalCount = 0
  for (const [type, count] of Object.entries(entityTypeCounts)) {
    totalEntities += count
    if (INSTRUCTIONAL_TYPES.has(type)) instructionalCount += count
  }
  const instructionalRatio = totalEntities > 0 ? instructionalCount / totalEntities : 0
  const check2Pass = instructionalRatio >= 0.35
  const check3Pass = chunkCount >= 3
  const passCount = [check1Pass, check2Pass, check3Pass].filter(Boolean).length
  return {
    isCandidate: passCount >= 2,
    checks: {
      sourceTypeScore: check1, instructionalRatio: Math.round(instructionalRatio * 100) / 100,
      chunkCount, check1Pass, check2Pass, check3Pass, passCount,
    },
  }
}

const SKILL_ELIGIBLE_TYPES = new Set(['Topic', 'Technology', 'Concept', 'Insight', 'Idea', 'Hypothesis', 'Lesson', 'Takeaway', 'Methodology'])
const SIGNAL_WEIGHTS = { anchorAlignment: 0.25, nodeDensity: 0.20, sourceHistory: 0.20, graphProximity: 0.15, profileContext: 0.10, velocity: 0.10 }
const SOURCE_TYPE_CONFIDENCE = { YouTube: 0.35, Meeting: 0.65, Document: 0.55, Research: 0.40, Note: 0.25, Web: 0.30 }
const REINFORCEMENT_DELTAS = { YouTube: 0.10, Meeting: 0.20, Document: 0.15, Research: 0.10, Note: 0.05, Web: 0.08 }
const ADJACENT_DOMAINS = { technical: ['domain_specific'], consulting: ['strategic', 'interpersonal'], strategic: ['consulting'], domain_specific: ['technical', 'consulting'], interpersonal: ['consulting', 'strategic'] }
const DEDUP_THRESHOLD = 0.85
const CURRENT_SCAN_VERSION = '1.0'

function parseEmbedding(raw) {
  if (Array.isArray(raw)) return raw
  if (typeof raw === 'string') { try { return JSON.parse(raw) } catch { return [] } }
  return []
}

function cosineSimilarity(a, b) {
  if (a.length !== b.length || a.length === 0) return 0
  let dot = 0, ma = 0, mb = 0
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; ma += a[i] * a[i]; mb += b[i] * b[i] }
  ma = Math.sqrt(ma); mb = Math.sqrt(mb)
  return ma && mb ? dot / (ma * mb) : 0
}

function parseJSON(text) {
  const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
  try { return JSON.parse(cleaned) } catch { return null }
}

function bfsToAnchor(startId, anchorIds, adj) {
  if (anchorIds.has(startId)) return 0
  const visited = new Set([startId])
  let frontier = [startId]
  for (let depth = 1; depth <= 4; depth++) {
    const next = []
    for (const id of frontier) for (const nb of adj[id] ?? []) { if (!visited.has(nb)) { if (anchorIds.has(nb)) return depth; visited.add(nb); next.push(nb) } }
    frontier = next; if (!frontier.length) break
  }
  return null
}

async function callGemini(systemPrompt, userPrompt, maxTokens = 2048) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [{ parts: [{ text: userPrompt }] }],
      generationConfig: { temperature: 0.1, maxOutputTokens: maxTokens },
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

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

// ─── STEP 1 & 2: TAG SOURCES ─────────────────────────────────────────────────

async function runTagSources(dryRun) {
  logSection(`STEP ${dryRun ? '1' : '2'}: tag-sources (dry_run=${dryRun})`)
  const startTime = Date.now()

  const { data: allSources, error: sourcesError } = await supabase
    .from('knowledge_sources')
    .select('id, title, source_type, metadata, created_at')
    .eq('user_id', USER_ID)
    .order('created_at', { ascending: false })

  if (sourcesError) { log(`ERROR fetching sources: ${sourcesError.message}`); return null }

  const sources = (allSources ?? []).filter(s => {
    const meta = s.metadata
    return !meta?.skill_candidate_evaluated_at
  })
  const skippedAlreadyTagged = (allSources?.length ?? 0) - sources.length
  log(`Total sources: ${allSources?.length ?? 0} | To evaluate: ${sources.length} | Already tagged: ${skippedAlreadyTagged}`)

  const results = []
  const BATCH_SIZE = 20

  for (let i = 0; i < sources.length; i += BATCH_SIZE) {
    const batch = sources.slice(i, i + BATCH_SIZE)

    const batchResults = await Promise.all(batch.map(async (source) => {
      const { data: nodeRows } = await supabase
        .from('knowledge_nodes').select('entity_type')
        .eq('source_id', source.id).eq('user_id', USER_ID)

      const entityTypeCounts = {}
      for (const row of nodeRows ?? []) {
        const t = row.entity_type
        entityTypeCounts[t] = (entityTypeCounts[t] ?? 0) + 1
      }

      const { count: chunkCount } = await supabase
        .from('source_chunks').select('id', { count: 'exact', head: true })
        .eq('source_id', source.id).eq('user_id', USER_ID)

      const { isCandidate, checks } = evaluateCandidacy(source.source_type ?? 'Note', entityTypeCounts, chunkCount ?? 0)

      if (!dryRun) {
        const existingMetadata = source.metadata ?? {}
        await supabase.from('knowledge_sources').update({
          metadata: {
            ...existingMetadata,
            skill_candidate: isCandidate,
            skill_candidate_evaluated_at: new Date().toISOString(),
            skill_candidate_checks: checks,
          },
        }).eq('id', source.id).eq('user_id', USER_ID)
      }

      return { id: source.id, title: source.title ?? 'Untitled', source_type: source.source_type ?? 'Unknown', is_candidate: isCandidate, checks }
    }))

    results.push(...batchResults)
    log(`  Processed batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(sources.length / BATCH_SIZE)} (${results.length}/${sources.length})`)

    if (i + BATCH_SIZE < sources.length) await sleep(200)
  }

  const taggedTrue = results.filter(r => r.is_candidate).length
  const taggedFalse = results.filter(r => !r.is_candidate).length

  const bySourceType = {}
  for (const r of results) {
    if (!bySourceType[r.source_type]) bySourceType[r.source_type] = { true: 0, false: 0 }
    bySourceType[r.source_type][r.is_candidate ? 'true' : 'false']++
  }

  let failedCheck1Only = 0, failedCheck2Only = 0, failedCheck3Only = 0, failedMultiple = 0
  for (const r of results.filter(r => !r.is_candidate)) {
    const failed = [!r.checks.check1Pass, !r.checks.check2Pass, !r.checks.check3Pass]
    const failCount = failed.filter(Boolean).length
    if (failCount > 1) failedMultiple++
    else if (!r.checks.check1Pass) failedCheck1Only++
    else if (!r.checks.check2Pass) failedCheck2Only++
    else if (!r.checks.check3Pass) failedCheck3Only++
  }

  const response = {
    processed: results.length,
    tagged_true: taggedTrue,
    tagged_false: taggedFalse,
    skipped_already_tagged: skippedAlreadyTagged,
    dry_run: dryRun,
    duration_ms: Date.now() - startTime,
    breakdown: {
      by_source_type: bySourceType,
      check_failure_reasons: { failed_check1_only: failedCheck1Only, failed_check2_only: failedCheck2Only, failed_check3_only: failedCheck3Only, failed_multiple: failedMultiple },
    },
  }

  logJSON(`tag-sources response (dry_run=${dryRun})`, response)
  return response
}

// ─── STEP 3: VERIFY TAGS ─────────────────────────────────────────────────────

async function verifyTags() {
  logSection('STEP 3: Verify tags (Supabase query)')

  const { data: rows, error: rowsError } = await supabase
    .from('knowledge_sources')
    .select('source_type, metadata')
    .eq('user_id', USER_ID)

  if (rowsError) { log(`ERROR: ${rowsError.message}`); return }

  const grouped = {}
  for (const row of rows ?? []) {
    const key = `${row.source_type ?? 'Unknown'}::${row.metadata?.skill_candidate ?? 'null'}`
    grouped[key] = (grouped[key] ?? 0) + 1
  }

  const table = Object.entries(grouped).map(([key, count]) => {
    const [source_type, skill_candidate] = key.split('::')
    return { source_type, skill_candidate, count }
  }).sort((a, b) => a.source_type.localeCompare(b.source_type) || String(a.skill_candidate).localeCompare(String(b.skill_candidate)))

  logJSON('Verification: source_type × skill_candidate counts', table)

  const totalTrue = table.filter(r => r.skill_candidate === 'true').reduce((sum, r) => sum + r.count, 0)
  const totalFalse = table.filter(r => r.skill_candidate === 'false').reduce((sum, r) => sum + r.count, 0)
  const totalNull = table.filter(r => r.skill_candidate === 'null').reduce((sum, r) => sum + r.count, 0)
  log(`Summary: tagged_true=${totalTrue} | tagged_false=${totalFalse} | untagged=${totalNull}`)

  return table
}

// ─── STEP 4: PROCESS-SOURCE ───────────────────────────────────────────────────

const EVAL_SYSTEM_PROMPT = `You are evaluating content from a personal knowledge graph tool to determine whether it contains teachable, applicable skills.

A skill is defined as: a concept or technique that is specific enough to be applied, general enough to be reused across contexts, and has a discernible method — meaning there is a describable way of doing it, not just knowing about it.

For each candidate concept cluster provided, evaluate it against the following five criteria:

C1 — Instructional Intent: Is this source explicitly teaching, explaining, or demonstrating something?
C2 — Specificity Threshold: Is the concept specific enough to be actionable?
C3 — Reusability Signal: Does this technique apply across more than one context?
C4 — Method Presence: Is there a describable sequence of steps, decisions, or principles?
C5 — Minimum Depth: Does the source spend substantial time on this concept?

Respond ONLY with a JSON array. No preamble, no markdown, no explanation outside the JSON.`

async function processSource(sourceId, sourceIndex, totalSources) {
  const startTime = Date.now()

  const [sourceRes, nodesRes, chunksRes, anchorsRes, profileRes, allEdgesRes] = await Promise.all([
    supabase.from('knowledge_sources').select('id, title, source_type, metadata, created_at').eq('id', sourceId).eq('user_id', USER_ID).maybeSingle(),
    supabase.from('knowledge_nodes').select('id, label, entity_type, confidence, description, embedding').eq('source_id', sourceId).eq('user_id', USER_ID).limit(5000),
    supabase.from('source_chunks').select('content, chunk_index').eq('source_id', sourceId).eq('user_id', USER_ID).order('chunk_index', { ascending: true }).limit(8),
    supabase.from('knowledge_nodes').select('id, label, entity_type, embedding').eq('user_id', USER_ID).eq('is_anchor', true),
    supabase.from('user_profiles').select('professional_context').eq('user_id', USER_ID).maybeSingle(),
    supabase.from('knowledge_edges').select('source_node_id, target_node_id').eq('user_id', USER_ID).limit(5000),
  ])

  const source = sourceRes.data
  if (!source) return { source_id: sourceId, error: 'Source not found', skills_created: 0, skills_reinforced: 0 }

  if (source.metadata?.skill_candidate === false) {
    return { source_id: sourceId, skipped: 'skill_candidate=false', skills_created: 0, skills_reinforced: 0 }
  }

  const sourceNodes = nodesRes.data ?? []
  const chunks = chunksRes.data ?? []
  const anchors = anchorsRes.data ?? []
  const profile = profileRes.data
  const allEdges = allEdgesRes.data ?? []

  // Form concept clusters
  const eligible = sourceNodes.filter(n => SKILL_ELIGIBLE_TYPES.has(n.entity_type))
  if (eligible.length === 0) {
    return { source_id: sourceId, skills_created: 0, skills_reinforced: 0, clusters_evaluated: 0, clusters_passed_universal: 0, duration_ms: Date.now() - startTime, created: [], reinforced: [], note: 'no eligible nodes' }
  }

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
    if (component.length > 0) {
      const primary = component.reduce((best, n) => (n.confidence ?? 0) > (best.confidence ?? 0) ? n : best, component[0])
      clusters.push({
        sourceId, label: primary.label, primaryNodeId: primary.id,
        entityTypes: [...new Set(component.map(n => n.entity_type))],
        nodeIds: component.map(n => n.id), nodeLabels: component.map(n => n.label),
        confidence: primary.confidence ?? 0.5,
      })
    }
  }
  clusters.sort((a, b) => b.confidence - a.confidence)
  const cappedClusters = clusters.slice(0, 5)

  // Universal layer evaluation via Gemini
  const chunkContext = chunks.length > 0 ? chunks.map(c => c.content).join('\n\n---\n\n') : `Source: ${source.title ?? 'Untitled'}`
  const candidateList = cappedClusters.map((c, i) => `${i + 1}. "${c.label}" (${c.entityTypes.join(', ')})`).join('\n')
  const userPrompt = `Source title: ${source.title ?? 'Untitled'}\nSource type: ${source.source_type ?? 'Unknown'}\n\nSource content (top chunks):\n${chunkContext}\n\nCandidate clusters to evaluate:\n${candidateList}\n\nReturn a JSON array with one object per candidate:\n[{"candidateLabel":"string","C1":{"pass":true,"rationale":"..."},"C2":{"pass":true,"rationale":"..."},"C3":{"pass":true,"rationale":"..."},"C4":{"pass":true,"rationale":"..."},"C5":{"pass":true,"rationale":"..."},"criteriaPassedCount":5,"suggestedSkillLabel":"string","domain":"technical|consulting|strategic|interpersonal|domain_specific"}]`

  let evaluations = []
  try {
    const raw = await callGemini(EVAL_SYSTEM_PROMPT, userPrompt)
    evaluations = parseJSON(raw) ?? []
  } catch (err) {
    return { source_id: sourceId, skills_created: 0, skills_reinforced: 0, clusters_evaluated: cappedClusters.length, clusters_passed_universal: 0, duration_ms: Date.now() - startTime, created: [], reinforced: [], error: `Gemini eval failed: ${err.message}` }
  }

  const passing = []
  for (let i = 0; i < cappedClusters.length; i++) {
    const ev = evaluations[i] ?? evaluations.find(e => e.candidateLabel === cappedClusters[i].label)
    if (ev && ev.criteriaPassedCount >= 3) passing.push({ cluster: cappedClusters[i], eval: ev })
  }

  if (passing.length === 0) {
    return { source_id: sourceId, skills_created: 0, skills_reinforced: 0, clusters_evaluated: cappedClusters.length, clusters_passed_universal: 0, duration_ms: Date.now() - startTime, created: [], reinforced: [] }
  }

  // Deduplication + skill creation/reinforcement
  const skillLabels = passing.map(p => p.eval.suggestedSkillLabel || p.cluster.label)
  const { data: existingSkills } = await supabase.from('knowledge_skills').select('id, label, confidence, status, exposure_level, evidence_count, related_anchor_ids').eq('user_id', USER_ID)
  const existingByLabel = new Map()
  for (const s of existingSkills ?? []) existingByLabel.set(s.label.toLowerCase(), s)

  const labelEmbeddings = []
  for (const label of skillLabels) {
    try { labelEmbeddings.push(await generateEmbedding(label)) } catch { labelEmbeddings.push(null) }
  }

  const graphAdj = {}
  for (const e of allEdges) {
    if (!graphAdj[e.source_node_id]) graphAdj[e.source_node_id] = []
    if (!graphAdj[e.target_node_id]) graphAdj[e.target_node_id] = []
    graphAdj[e.source_node_id].push(e.target_node_id)
    graphAdj[e.target_node_id].push(e.source_node_id)
  }

  const anchorIds = new Set(anchors.map(a => a.id))
  const userDomain = profile?.professional_context?.domain ?? null
  const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString()

  const { data: allUserSources } = await supabase.from('knowledge_sources').select('id, created_at').eq('user_id', USER_ID)
  const allSourcesList = allUserSources ?? []
  const { data: allUserNodes } = await supabase.from('knowledge_nodes').select('id, label, entity_type, source_id').eq('user_id', USER_ID).limit(5000)
  const allNodes = allUserNodes ?? []

  const nodeCountBySource = {}
  for (const n of allNodes) { if (n.source_id) nodeCountBySource[n.source_id] = (nodeCountBySource[n.source_id] ?? 0) + 1 }
  const maxNodeCount = Math.max(1, ...Object.values(nodeCountBySource))

  const created = []
  const reinforced = []

  for (let i = 0; i < passing.length; i++) {
    const { cluster, eval: ev } = passing[i]
    const skillLabel = ev.suggestedSkillLabel || cluster.label
    const embedding = labelEmbeddings[i]

    let existingSkill = existingByLabel.get(skillLabel.toLowerCase()) ?? null
    if (!existingSkill && embedding) {
      for (const s of existingSkills ?? []) {
        const simLabel = s.label.toLowerCase()
        if (simLabel.includes(skillLabel.toLowerCase().slice(0, 15)) || skillLabel.toLowerCase().includes(simLabel.slice(0, 15))) {
          existingSkill = s; break
        }
      }
    }

    if (existingSkill) {
      const { data: existingJunction } = await supabase.from('skill_sources').select('id').eq('skill_id', existingSkill.id).eq('source_id', sourceId).limit(1)
      if (existingJunction && existingJunction.length > 0) continue

      const delta = REINFORCEMENT_DELTAS[source.source_type] ?? 0.10
      const existingAnchors = existingSkill.related_anchor_ids ?? []
      const anchorBonus = existingAnchors.length > 0 ? 0.03 : 0
      const existingConf = existingSkill.confidence
      const newConfidence = Math.min(existingConf + (delta * (1 - existingConf) * 0.8) + anchorBonus, 0.95)
      const currentExposure = existingSkill.exposure_level
      const newEvidenceCount = existingSkill.evidence_count + 1
      let newExposure = currentExposure
      if (source.source_type === 'Meeting' && currentExposure === 'developing') newExposure = 'proficient'
      else if (source.source_type === 'Meeting' && currentExposure === 'novice') newExposure = 'developing'
      else if (newEvidenceCount >= 5 && currentExposure === 'developing') newExposure = 'proficient'
      else if (newEvidenceCount >= 8 && currentExposure === 'proficient') newExposure = 'advanced'

      await supabase.from('knowledge_skills').update({
        confidence: newConfidence, exposure_level: newExposure,
        status: newConfidence >= 0.55 ? 'confirmed' : existingSkill.status,
        evidence_count: newEvidenceCount, last_reinforced_at: new Date().toISOString(),
      }).eq('id', existingSkill.id)

      await supabase.from('skill_sources').insert({
        user_id: USER_ID, skill_id: existingSkill.id, source_id: sourceId,
        contribution: newExposure !== currentExposure ? 'upgraded' : 'reinforced',
        confidence_delta: newConfidence - existingConf,
      })

      reinforced.push({ label: existingSkill.label, confidence_before: existingConf, confidence_after: newConfidence })
    } else {
      const keyword = skillLabel.split(/\s+/).slice(0, 3).join(' ').toLowerCase()
      let s1 = 0
      const relatedAnchorIds = []
      if (anchors.length > 0 && embedding) {
        for (const a of anchors) {
          const aEmb = parseEmbedding(a.embedding)
          if (!aEmb.length) continue
          const sim = cosineSimilarity(embedding, aEmb)
          if (sim > s1) s1 = sim
          if (sim > 0.3) relatedAnchorIds.push(a.id)
        }
      }
      const relatedNodes = allNodes.filter(n => n.label.toLowerCase().includes(keyword) || (n.source_id === sourceId && ['Topic', 'Technology', 'Concept'].includes(n.entity_type)))
      const s2 = Math.min(relatedNodes.length / maxNodeCount, 1)
      const relatedSourceIds = new Set(relatedNodes.filter(n => n.source_id).map(n => n.source_id))
      const s3 = Math.min(relatedSourceIds.size / 3, 1)
      const hops = bfsToAnchor(cluster.primaryNodeId, anchorIds, graphAdj)
      const s4 = hops === null ? 0 : hops <= 1 ? 1.0 : hops === 2 ? 0.6 : hops === 3 ? 0.3 : 0
      let multiplier = 1.0
      if (userDomain && ev.domain) {
        if (ev.domain === userDomain) multiplier = 1.4
        else if (ADJACENT_DOMAINS[userDomain]?.includes(ev.domain)) multiplier = 1.1
        else multiplier = 0.8
      }
      const s5 = Math.min(0.5 * multiplier, 1)
      const recentSources = [...relatedSourceIds].filter(sid => { const s = allSourcesList.find(x => x.id === sid); return s && s.created_at >= fourteenDaysAgo })
      const s6 = recentSources.length === 0 ? 0 : recentSources.length === 1 ? 0.5 : 1
      const relevanceScore = +(s1 * SIGNAL_WEIGHTS.anchorAlignment + s2 * SIGNAL_WEIGHTS.nodeDensity + s3 * SIGNAL_WEIGHTS.sourceHistory + s4 * SIGNAL_WEIGHTS.graphProximity + s5 * SIGNAL_WEIGHTS.profileContext + s6 * SIGNAL_WEIGHTS.velocity).toFixed(2)

      const initialConfidence = SOURCE_TYPE_CONFIDENCE[source.source_type] ?? 0.35
      const anchorBonus = relatedAnchorIds.length > 0 ? 0.05 : 0
      const finalConfidence = Math.min(initialConfidence + anchorBonus, 0.95)

      let exposureLevel = 'novice'
      if (source.source_type === 'Meeting') exposureLevel = 'developing'
      else if (source.source_type === 'Document' && relatedNodes.length > 5) exposureLevel = 'proficient'
      else if (relatedNodes.length > 3) exposureLevel = 'developing'
      const status = finalConfidence >= 0.55 ? 'confirmed' : 'candidate'

      const { data: newSkill } = await supabase.from('knowledge_skills').insert({
        user_id: USER_ID, label: skillLabel, domain: ev.domain || 'domain_specific',
        confidence: finalConfidence, exposure_level: exposureLevel, status,
        last_relevance_score: relevanceScore,
        signal_breakdown: { anchorAlignment: s1, nodeDensity: s2, sourceHistory: s3, graphProximity: s4, profileContext: s5, velocity: s6 },
        related_anchor_ids: relatedAnchorIds.length > 0 ? relatedAnchorIds : undefined,
        first_detected_at: new Date().toISOString(), last_reinforced_at: new Date().toISOString(),
      }).select('id').single()

      if (newSkill) {
        await supabase.from('skill_sources').insert({ user_id: USER_ID, skill_id: newSkill.id, source_id: sourceId, contribution: 'created', confidence_delta: finalConfidence })
        existingByLabel.set(skillLabel.toLowerCase(), { id: newSkill.id, label: skillLabel, confidence: finalConfidence, status, exposure_level: exposureLevel, evidence_count: 1, related_anchor_ids: relatedAnchorIds })
      }
      created.push({ label: skillLabel, confidence: finalConfidence, status })
    }
  }

  const { count: confirmedCount } = await supabase.from('knowledge_skills').select('id', { count: 'exact', head: true }).eq('user_id', USER_ID).eq('status', 'confirmed')
  await supabase.from('skill_scan_state').upsert({ user_id: USER_ID, last_incremental_at: new Date().toISOString(), candidates_confirmed: confirmedCount ?? 0, scan_version: CURRENT_SCAN_VERSION }, { onConflict: 'user_id' })

  return { source_id: sourceId, skills_created: created.length, skills_reinforced: reinforced.length, clusters_evaluated: cappedClusters.length, clusters_passed_universal: passing.length, duration_ms: Date.now() - startTime, created, reinforced }
}

async function runProcessSources() {
  logSection('STEP 4: process-source for all skill_candidate=true sources')

  const { data: candidateSources, error } = await supabase
    .from('knowledge_sources')
    .select('id, title, source_type')
    .eq('user_id', USER_ID)
    .filter('metadata->>skill_candidate', 'eq', 'true')
    .order('created_at', { ascending: false })

  if (error) { log(`ERROR fetching candidates: ${error.message}`); return }

  log(`Found ${candidateSources?.length ?? 0} skill_candidate=true sources to process`)

  let totalCreated = 0, totalReinforced = 0, successCount = 0, failCount = 0

  for (let i = 0; i < (candidateSources ?? []).length; i++) {
    const source = candidateSources[i]
    log(`[${i + 1}/${candidateSources.length}] Processing: "${source.title?.slice(0, 60)}" (${source.source_type})`)

    try {
      const result = await processSource(source.id, i + 1, candidateSources.length)
      const emoji = result.error ? '✗' : result.skipped ? '→' : '✓'
      log(`  ${emoji} skills_created=${result.skills_created ?? 0} | skills_reinforced=${result.skills_reinforced ?? 0} | clusters_evaluated=${result.clusters_evaluated ?? 0} | clusters_passed=${result.clusters_passed_universal ?? 0} | ${result.duration_ms ?? 0}ms${result.error ? ` | ERROR: ${result.error}` : ''}${result.skipped ? ` | skipped: ${result.skipped}` : ''}`)
      if (result.created?.length) log(`    Created: ${result.created.map(s => `"${s.label}" (${s.confidence})`).join(', ')}`)
      if (result.reinforced?.length) log(`    Reinforced: ${result.reinforced.map(s => `"${s.label}" ${s.confidence_before.toFixed(2)}→${s.confidence_after.toFixed(2)}`).join(', ')}`)

      totalCreated += result.skills_created ?? 0
      totalReinforced += result.skills_reinforced ?? 0
      if (result.error) failCount++; else successCount++
    } catch (err) {
      log(`  ✗ EXCEPTION: ${err.message}`)
      failCount++
    }

    if (i < (candidateSources?.length ?? 0) - 1) await sleep(500)
  }

  log(`\nprocess-source complete: ${successCount} succeeded | ${failCount} failed | ${totalCreated} skills created | ${totalReinforced} skills reinforced`)
}

// ─── STEP 5: RESCORE ──────────────────────────────────────────────────────────

async function runRescore() {
  logSection('STEP 5: rescore (when_to_apply / how_to_apply generation)')
  const startTime = Date.now()

  const { data: skills } = await supabase.from('knowledge_skills').select('*').eq('user_id', USER_ID).neq('status', 'archived')
  if (!skills || skills.length === 0) { log('No skills to rescore'); return }
  log(`Rescoring ${skills.length} skills for user ${USER_ID}`)

  // Step 4: Generate when_to_apply / how_to_apply for confirmed skills needing it
  if (!GEMINI_API_KEY) { log('GEMINI_API_KEY not set — skipping when/how generation'); return }

  const needsGeneration = skills.filter(s => s.status === 'confirmed' && !s.when_to_apply)
  log(`${needsGeneration.length} confirmed skills need when_to_apply / how_to_apply generation`)

  const skillIdsForGen = needsGeneration.map(s => s.id)
  const { data: junctions } = await supabase.from('skill_sources').select('skill_id, source_id').in('skill_id', skillIdsForGen)
  const sourceIdSet = new Set((junctions ?? []).map(j => j.source_id))
  const { data: sourceRows } = await supabase.from('knowledge_sources').select('id, title').in('id', [...sourceIdSet])
  const sourceTitleMap = new Map()
  for (const s of sourceRows ?? []) sourceTitleMap.set(s.id, s.title)
  const junctionMap = new Map()
  for (const j of junctions ?? []) {
    const arr = junctionMap.get(j.skill_id) ?? []
    const title = sourceTitleMap.get(j.source_id)
    if (title) arr.push(title)
    junctionMap.set(j.skill_id, arr)
  }

  let whenGenerated = 0
  for (let i = 0; i < needsGeneration.length; i += 10) {
    const batch = needsGeneration.slice(i, i + 10)
    const payload = batch.map(s => ({
      label: s.label, domain: s.domain, exposure_level: s.exposure_level,
      evidence_count: s.evidence_count,
      contributing_sources: (junctionMap.get(s.id) ?? []).slice(0, 5),
    }))

    try {
      const raw = await callGemini(
        'You are generating structured descriptions for skills in a personal knowledge graph. Each skill has been detected from real content the user has ingested. Be concise, specific, and practical. Write for an AI assistant that needs to know when and how to apply each skill on behalf of the user.\n\nRespond ONLY with a JSON array. No preamble or markdown.',
        `Generate when_to_apply and how_to_apply descriptions for these skills:\n\n${JSON.stringify(payload, null, 2)}\n\nReturn:\n[{"label":"string","when_to_apply":"2-3 sentences","how_to_apply":"2-3 sentences"}]`,
        2048
      )
      const results = parseJSON(raw) ?? []
      for (const r of results) {
        const skill = batch.find(s => s.label.toLowerCase() === r.label.toLowerCase())
        if (skill && r.when_to_apply && r.how_to_apply) {
          await supabase.from('knowledge_skills').update({ when_to_apply: r.when_to_apply, how_to_apply: r.how_to_apply }).eq('id', skill.id)
          log(`  ✓ Generated when/how for: "${skill.label}"`)
          whenGenerated++
        }
      }
    } catch (err) {
      log(`  ✗ Gemini generation failed for batch ${Math.floor(i / 10) + 1}: ${err.message}`)
    }

    if (i + 10 < needsGeneration.length) await sleep(500)
  }

  // Lifecycle transitions + re-scoring
  let totalRescored = 0, transitionedDormant = 0, archived = 0
  const now = new Date()
  const [anchorsRes, nodesRes, edgesRes, profileRes, sourcesRes] = await Promise.all([
    supabase.from('knowledge_nodes').select('id, label, entity_type, embedding').eq('user_id', USER_ID).eq('is_anchor', true),
    supabase.from('knowledge_nodes').select('id, label, entity_type, source_id').eq('user_id', USER_ID).limit(5000),
    supabase.from('knowledge_edges').select('source_node_id, target_node_id').eq('user_id', USER_ID).limit(5000),
    supabase.from('user_profiles').select('professional_context').eq('user_id', USER_ID).maybeSingle(),
    supabase.from('knowledge_sources').select('id, created_at').eq('user_id', USER_ID),
  ])

  const anchors = anchorsRes.data ?? []
  const allNodes = nodesRes.data ?? []
  const allEdges = edgesRes.data ?? []
  const profile = profileRes.data
  const allSources = sourcesRes.data ?? []
  const anchorIds = new Set(anchors.map(a => a.id))
  const graphAdj = {}
  for (const e of allEdges) {
    if (!graphAdj[e.source_node_id]) graphAdj[e.source_node_id] = []
    if (!graphAdj[e.target_node_id]) graphAdj[e.target_node_id] = []
    graphAdj[e.source_node_id].push(e.target_node_id)
    graphAdj[e.target_node_id].push(e.source_node_id)
  }
  const nodeCountBySource = {}
  for (const n of allNodes) { if (n.source_id) nodeCountBySource[n.source_id] = (nodeCountBySource[n.source_id] ?? 0) + 1 }
  const maxNodeCount = Math.max(1, ...Object.values(nodeCountBySource))
  const userDomain = profile?.professional_context?.domain ?? null
  const fourteenDaysAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000).toISOString()

  for (const skill of skills) {
    const status = skill.status
    const lastReinforced = skill.last_reinforced_at
    const daysSince = Math.floor((now.getTime() - new Date(lastReinforced ?? skill.created_at).getTime()) / (1000 * 60 * 60 * 24))

    if (status === 'confirmed' && daysSince > 60) {
      await supabase.from('knowledge_skills').update({ status: 'dormant' }).eq('id', skill.id)
      transitionedDormant++; continue
    }
    if (status === 'dormant' && daysSince > 90) {
      await supabase.from('knowledge_skills').update({ status: 'archived' }).eq('id', skill.id)
      archived++; continue
    }

    const keyword = skill.label.split(/\s+/).slice(0, 3).join(' ').toLowerCase()
    const primaryNode = allNodes.find(n => n.label.toLowerCase().includes(keyword) && SKILL_ELIGIBLE_TYPES.has(n.entity_type))
    let s1 = 0
    if (anchors.length > 0) {
      try {
        const emb = await generateEmbedding(skill.label)
        for (const a of anchors) {
          const aEmb = parseEmbedding(a.embedding)
          if (!aEmb.length) continue
          const sim = cosineSimilarity(emb, aEmb)
          if (sim > s1) s1 = sim
        }
      } catch {}
    }
    const relatedNodes = allNodes.filter(n => n.label.toLowerCase().includes(keyword))
    const s2 = Math.min(relatedNodes.length / maxNodeCount, 1)
    const relatedSourceIds = new Set(relatedNodes.filter(n => n.source_id).map(n => n.source_id))
    const s3 = Math.min(relatedSourceIds.size / 3, 1)
    const s4 = primaryNode ? (() => { const hops = bfsToAnchor(primaryNode.id, anchorIds, graphAdj); return hops === null ? 0 : hops <= 1 ? 1.0 : hops === 2 ? 0.6 : hops === 3 ? 0.3 : 0 })() : 0
    let mult = 1.0
    if (userDomain && skill.domain) {
      if (skill.domain === userDomain) mult = 1.4
      else if (ADJACENT_DOMAINS[userDomain]?.includes(skill.domain)) mult = 1.1
      else mult = 0.8
    }
    const s5 = Math.min(0.5 * mult, 1)
    const recentSources = [...relatedSourceIds].filter(sid => { const s = allSources.find(x => x.id === sid); return s && s.created_at >= fourteenDaysAgo })
    const s6 = recentSources.length === 0 ? 0 : recentSources.length === 1 ? 0.5 : 1
    const newScore = +(s1 * SIGNAL_WEIGHTS.anchorAlignment + s2 * SIGNAL_WEIGHTS.nodeDensity + s3 * SIGNAL_WEIGHTS.sourceHistory + s4 * SIGNAL_WEIGHTS.graphProximity + s5 * SIGNAL_WEIGHTS.profileContext + s6 * SIGNAL_WEIGHTS.velocity).toFixed(2)
    const oldScore = skill.last_relevance_score ?? 0
    if (Math.abs(newScore - oldScore) > 0.05) {
      const newStatus = newScore < 0.40 && status === 'confirmed' ? 'candidate' : status
      await supabase.from('knowledge_skills').update({ last_relevance_score: newScore, signal_breakdown: { anchorAlignment: s1, nodeDensity: s2, sourceHistory: s3, graphProximity: s4, profileContext: s5, velocity: s6 }, last_scored_at: now.toISOString(), ...(newStatus !== status ? { status: newStatus } : {}) }).eq('id', skill.id)
    } else {
      await supabase.from('knowledge_skills').update({ last_scored_at: now.toISOString() }).eq('id', skill.id)
    }
    totalRescored++
  }

  const confirmedCount = skills.filter(s => s.status === 'confirmed').length
  await supabase.from('skill_scan_state').upsert({ user_id: USER_ID, last_full_scan_at: now.toISOString(), candidates_confirmed: confirmedCount, scan_version: CURRENT_SCAN_VERSION, metadata: { last_rescore_summary: { skills_rescored: totalRescored, skills_transitioned_dormant: transitionedDormant, skills_archived: archived, when_to_apply_generated: whenGenerated, duration_ms: Date.now() - startTime } } }, { onConflict: 'user_id' })

  logJSON('rescore response', { skills_rescored: totalRescored, transitioned_dormant: transitionedDormant, archived, when_to_apply_generated: whenGenerated, duration_ms: Date.now() - startTime })
}

// ─── STEP 6: FINAL QUERY ─────────────────────────────────────────────────────

async function queryFinalSkills() {
  logSection('STEP 6: Final knowledge_skills query')

  const { data, error } = await supabase
    .from('knowledge_skills')
    .select('label, domain, exposure_level, confidence, status, evidence_count')
    .eq('user_id', USER_ID)
    .order('confidence', { ascending: false })

  if (error) { log(`ERROR: ${error.message}`); return }

  if (!data || data.length === 0) {
    log('No skills found for this user.')
    return
  }

  console.log(`\n${'─'.repeat(100)}`)
  console.log(`${'LABEL'.padEnd(45)} ${'DOMAIN'.padEnd(18)} ${'EXPOSURE'.padEnd(12)} ${'CONF'.padEnd(6)} ${'STATUS'.padEnd(12)} EVD`)
  console.log('─'.repeat(100))
  for (const s of data) {
    const label = (s.label ?? '').slice(0, 44).padEnd(45)
    const domain = (s.domain ?? '').padEnd(18)
    const exposure = (s.exposure_level ?? '').padEnd(12)
    const conf = String((s.confidence ?? 0).toFixed(3)).padEnd(6)
    const status = (s.status ?? '').padEnd(12)
    const evd = s.evidence_count ?? 0
    console.log(`${label} ${domain} ${exposure} ${conf} ${status} ${evd}`)
  }
  console.log('─'.repeat(100))
  log(`Total: ${data.length} skills | confirmed=${data.filter(s => s.status === 'confirmed').length} | candidate=${data.filter(s => s.status === 'candidate').length} | dormant=${data.filter(s => s.status === 'dormant').length}`)
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  log(`Starting PRD-25b skill candidacy backfill pipeline`)
  log(`User: ${USER_ID}`)

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) { log('FATAL: Supabase env vars missing'); process.exit(1) }
  if (!GEMINI_API_KEY) { log('WARNING: GEMINI_API_KEY not set — Gemini calls will fail') }

  // Step 1: Dry run
  const dryRunResult = await runTagSources(true)
  if (!dryRunResult) { log('FATAL: Dry run failed — aborting'); process.exit(1) }

  // Sanity check
  if (dryRunResult.tagged_true === 0 && dryRunResult.processed > 0) {
    log('WARNING: Dry run returned 0 candidates — check candidacy logic before committing')
  }

  // Step 2: Commit
  await runTagSources(false)

  // Step 3: Verify
  await verifyTags()

  // Step 4: Process each candidate source
  await runProcessSources()

  // Step 5: Rescore
  await runRescore()

  // Step 6: Final results
  await queryFinalSkills()

  log('\nPipeline complete.')
}

main().catch(err => { console.error('FATAL:', err); process.exit(1) })
