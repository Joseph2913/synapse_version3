/**
 * api/skills/process-source.ts
 *
 * Evaluates a single newly ingested source for skill signals.
 * Creates new skills or reinforces existing ones.
 * CRITICAL: Fully self-contained. No local imports.
 *
 * PRD-26 — Persistent Skill Pipeline
 */

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createClient } from '@supabase/supabase-js'

export const maxDuration = 60

// ─── ENVIRONMENT ──────────────────────────────────────────────────────────────

const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? ''
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''
const GEMINI_API_KEY = process.env.GEMINI_API_KEY ?? process.env.VITE_GEMINI_API_KEY ?? ''
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models'
const GEMINI_MODEL = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash'
const GEMINI_EMBEDDING_MODEL = 'gemini-embedding-001'

// ─── CONSTANTS ────────────────────────────────────────────────────────────────

const SIGNAL_WEIGHTS = {
  anchorAlignment: 0.25,
  nodeDensity:     0.20,
  sourceHistory:   0.20,
  graphProximity:  0.15,
  profileContext:  0.10,
  velocity:        0.10,
} as const

const SOURCE_TYPE_CONFIDENCE: Record<string, number> = {
  YouTube:  0.35,
  Meeting:  0.65,
  Document: 0.55,
  Research: 0.40,
  Note:     0.25,
  Web:      0.30,
}

const REINFORCEMENT_DELTAS: Record<string, number> = {
  YouTube:  0.10,
  Meeting:  0.20,
  Document: 0.15,
  Research: 0.10,
  Note:     0.05,
  Web:      0.08,
}

const CURRENT_SCAN_VERSION = '1.0'
const DEDUP_SIMILARITY_THRESHOLD = 0.85

const SKILL_ELIGIBLE_TYPES = new Set([
  'Topic', 'Technology', 'Concept', 'Insight', 'Idea',
  'Hypothesis', 'Lesson', 'Takeaway', 'Methodology',
])

const ADJACENT_DOMAINS: Record<string, string[]> = {
  technical:       ['domain_specific'],
  consulting:      ['strategic', 'interpersonal'],
  strategic:       ['consulting'],
  domain_specific: ['technical', 'consulting'],
  interpersonal:   ['consulting', 'strategic'],
}

const DOMAIN_ROLE_MAP: Record<string, string[]> = {
  technical:       ['engineer', 'developer', 'architect', 'cto', 'technical'],
  consulting:      ['consultant', 'advisor', 'partner', 'director', 'strategy'],
  strategic:       ['founder', 'ceo', 'vp', 'head of', 'lead'],
  domain_specific: ['specialist', 'expert', 'analyst'],
  interpersonal:   ['people', 'hr', 'talent', 'coach'],
}

const MIN_RELEVANCE_TO_CREATE = 0.20

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

function getSupabase() {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
}

async function getUserFromToken(req: VercelRequest): Promise<string | null> {
  const auth = req.headers['authorization']
  if (!auth?.startsWith('Bearer ')) return null
  const token = auth.slice(7)
  const sb = getSupabase()
  const { data } = await sb.auth.getUser(token)
  return data?.user?.id ?? null
}

function parseJSON<T>(text: string): T | null {
  const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
  try { return JSON.parse(cleaned) as T } catch { return null }
}

function parseEmbedding(raw: unknown): number[] {
  if (Array.isArray(raw)) return raw as number[]
  if (typeof raw === 'string') { try { return JSON.parse(raw) as number[] } catch { return [] } }
  return []
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0
  let dot = 0, ma = 0, mb = 0
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; ma += a[i] * a[i]; mb += b[i] * b[i] }
  ma = Math.sqrt(ma); mb = Math.sqrt(mb)
  return ma && mb ? dot / (ma * mb) : 0
}

// ─── Gemini fetch + helpers (retry on 429/5xx, token-usage logging) ─────────

interface GeminiUsage {
  promptTokenCount?: number
  candidatesTokenCount?: number
  totalTokenCount?: number
}

async function geminiFetch(
  endpoint: string,
  body: unknown,
  timeoutMs: number,
  stage: string
): Promise<{ json: unknown; usage: GeminiUsage | undefined }> {
  const url = `${GEMINI_BASE}/${endpoint}?key=${GEMINI_API_KEY}`
  const maxAttempts = 3
  let lastErr: Error | null = null
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify(body),
      })
      if (resp.ok) {
        const json = await resp.json() as { usageMetadata?: GeminiUsage }
        const usage = json.usageMetadata
        if (usage) {
          console.log(JSON.stringify({
            stage, model: endpoint.split(':')[0],
            prompt_tokens: usage.promptTokenCount,
            output_tokens: usage.candidatesTokenCount,
            total_tokens: usage.totalTokenCount,
          }))
        }
        return { json, usage }
      }
      const txt = await resp.text().catch(() => '')
      lastErr = new Error(`Gemini ${resp.status}: ${txt.slice(0, 200)}`)
      if ((resp.status === 429 || resp.status >= 500) && attempt < maxAttempts - 1) {
        await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 1000))
        continue
      }
      throw lastErr
    } catch (err) {
      lastErr = err as Error
      if (attempt < maxAttempts - 1) {
        await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 1000))
        continue
      }
      throw lastErr
    } finally {
      clearTimeout(timer)
    }
  }
  throw lastErr ?? new Error('[gemini] request failed')
}

async function embedText(text: string, timeoutMs = 30000, stage = 'skills:process-source:embed'): Promise<number[]> {
  const { json } = await geminiFetch(
    `${GEMINI_EMBEDDING_MODEL}:embedContent`,
    { model: `models/${GEMINI_EMBEDDING_MODEL}`, content: { parts: [{ text }] } },
    timeoutMs,
    stage
  )
  const data = json as { embedding?: { values?: number[] } }
  if (!data.embedding?.values) throw new Error('No embedding in Gemini response')
  return data.embedding.values
}

async function callGemini(systemPrompt: string, userPrompt: string, maxTokens = 2048): Promise<string> {
  const { json } = await geminiFetch(
    `${GEMINI_MODEL}:generateContent`,
    {
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [{ parts: [{ text: userPrompt }] }],
      generationConfig: { temperature: 0.1, maxOutputTokens: maxTokens },
    },
    30000,
    'skills:process-source'
  )
  const data = json as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> }
  return data.candidates?.[0]?.content?.parts?.[0]?.text ?? ''
}

async function generateEmbedding(text: string): Promise<number[]> {
  return embedText(text, 30000, 'skills:process-source:embed')
}

function bfsToAnchor(startId: string, anchorIds: Set<string>, adj: Record<string, string[]>): number | null {
  if (anchorIds.has(startId)) return 0
  const visited = new Set([startId])
  let frontier = [startId]
  for (let depth = 1; depth <= 4; depth++) {
    const next: string[] = []
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

interface ConceptCluster {
  sourceId: string
  label: string
  primaryNodeId: string
  entityTypes: string[]
  nodeIds: string[]
  nodeLabels: string[]
  confidence: number
}

interface GeminiEvaluation {
  candidateLabel: string
  C1: { pass: boolean; rationale: string }
  C2: { pass: boolean; rationale: string }
  C3: { pass: boolean; rationale: string }
  C4: { pass: boolean; rationale: string }
  C5: { pass: boolean; rationale: string }
  criteriaPassedCount: number
  suggestedSkillLabel: string
  domain: 'technical' | 'consulting' | 'strategic' | 'interpersonal' | 'domain_specific'
}

// ─── MAIN HANDLER ─────────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return res.status(500).json({ error: 'Supabase not configured' })
  if (!GEMINI_API_KEY) return res.status(500).json({ error: 'GEMINI_API_KEY not configured' })

  const userId = await getUserFromToken(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })

  const { source_id: sourceId } = req.body ?? {}
  if (!sourceId) return res.status(400).json({ error: 'Missing source_id' })

  const startTime = Date.now()
  const supabase = getSupabase()

  try {
    // ─── Step 1: Fetch source data ───────────────────────────────────────

    const [sourceRes, nodesRes, chunksRes, anchorsRes, profileRes, allEdgesRes] = await Promise.all([
      supabase.from('knowledge_sources').select('id, title, source_type, metadata, created_at')
        .eq('id', sourceId).eq('user_id', userId).maybeSingle(),
      supabase.from('knowledge_nodes').select('id, label, entity_type, confidence, description, embedding')
        .eq('source_id', sourceId).eq('user_id', userId).limit(5000),
      supabase.from('source_chunks').select('content, chunk_index')
        .eq('source_id', sourceId).eq('user_id', userId).order('chunk_index', { ascending: true }).limit(8),
      supabase.from('knowledge_nodes').select('id, label, entity_type, embedding')
        .eq('user_id', userId).eq('is_anchor', true),
      supabase.from('user_profiles').select('professional_context')
        .eq('user_id', userId).maybeSingle(),
      supabase.from('knowledge_edges').select('source_node_id, target_node_id')
        .eq('user_id', userId).limit(5000),
    ])

    const source = sourceRes.data as { id: string; title: string; source_type: string; metadata: Record<string, unknown> | null; created_at: string } | null
    if (!source) return res.status(404).json({ error: 'Source not found' })

    // Check candidacy flag
    if (source.metadata && (source.metadata as Record<string, unknown>).skill_candidate === false) {
      return res.status(200).json({ source_id: sourceId, skills_created: 0, skills_reinforced: 0, clusters_evaluated: 0, clusters_passed_universal: 0, duration_ms: Date.now() - startTime, created: [], reinforced: [] })
    }

    const sourceNodes = (nodesRes.data ?? []) as Array<{ id: string; label: string; entity_type: string; confidence: number | null; description: string | null; embedding: unknown }>
    const chunks = (chunksRes.data ?? []) as Array<{ content: string; chunk_index: number }>
    const anchors = (anchorsRes.data ?? []) as Array<{ id: string; label: string; entity_type: string; embedding: unknown }>
    const profile = profileRes.data as { professional_context: Record<string, unknown> | null } | null
    const allEdges = (allEdgesRes.data ?? []) as Array<{ source_node_id: string; target_node_id: string }>

    // ─── Step 2: Form concept clusters ───────────────────────────────────

    const eligible = sourceNodes.filter(n => SKILL_ELIGIBLE_TYPES.has(n.entity_type))
    if (eligible.length === 0) {
      return res.status(200).json({ source_id: sourceId, skills_created: 0, skills_reinforced: 0, clusters_evaluated: 0, clusters_passed_universal: 0, duration_ms: Date.now() - startTime, created: [], reinforced: [] })
    }

    const nodeIdSet = new Set(eligible.map(n => n.id))
    const adj: Record<string, Set<string>> = {}
    for (const n of eligible) adj[n.id] = new Set()
    for (const e of allEdges) {
      if (nodeIdSet.has(e.source_node_id) && nodeIdSet.has(e.target_node_id)) {
        adj[e.source_node_id]?.add(e.target_node_id)
        adj[e.target_node_id]?.add(e.source_node_id)
      }
    }

    const visited = new Set<string>()
    const clusters: ConceptCluster[] = []
    for (const node of eligible) {
      if (visited.has(node.id)) continue
      const component: typeof eligible = []
      const queue = [node.id]
      while (queue.length) {
        const cur = queue.shift()!
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

    // ─── Step 3: Universal layer evaluation ──────────────────────────────

    const chunkContext = chunks.length > 0 ? chunks.map(c => c.content).join('\n\n---\n\n') : `Source: ${source.title ?? 'Untitled'}`
    const candidateList = cappedClusters.map((c, i) => `${i + 1}. "${c.label}" (${c.entityTypes.join(', ')})`).join('\n')

    const userPrompt = `Source title: ${source.title ?? 'Untitled'}
Source type: ${source.source_type ?? 'Unknown'}

Source content (top chunks):
${chunkContext}

Candidate clusters to evaluate:
${candidateList}

Return a JSON array with one object per candidate:
[{"candidateLabel":"string","C1":{"pass":true,"rationale":"..."},"C2":{"pass":true,"rationale":"..."},"C3":{"pass":true,"rationale":"..."},"C4":{"pass":true,"rationale":"..."},"C5":{"pass":true,"rationale":"..."},"criteriaPassedCount":5,"suggestedSkillLabel":"string","domain":"technical|consulting|strategic|interpersonal|domain_specific"}]`

    let evaluations: GeminiEvaluation[] = []
    try {
      const raw = await callGemini(EVAL_SYSTEM_PROMPT, userPrompt)
      evaluations = parseJSON<GeminiEvaluation[]>(raw) ?? []
    } catch (err) {
      console.error('[process-source] Gemini eval failed:', err)
      return res.status(200).json({ source_id: sourceId, skills_created: 0, skills_reinforced: 0, clusters_evaluated: cappedClusters.length, clusters_passed_universal: 0, duration_ms: Date.now() - startTime, created: [], reinforced: [] })
    }

    // Match evaluations to clusters, filter by criteria threshold
    const passing: Array<{ cluster: ConceptCluster; eval: GeminiEvaluation }> = []
    for (let i = 0; i < cappedClusters.length; i++) {
      const ev = evaluations[i] ?? evaluations.find(e => e.candidateLabel === cappedClusters[i].label)
      if (ev && ev.criteriaPassedCount >= 3) {
        passing.push({ cluster: cappedClusters[i], eval: ev })
      }
    }

    if (passing.length === 0) {
      return res.status(200).json({ source_id: sourceId, skills_created: 0, skills_reinforced: 0, clusters_evaluated: cappedClusters.length, clusters_passed_universal: 0, duration_ms: Date.now() - startTime, created: [], reinforced: [] })
    }

    // ─── Step 4: Deduplication ───────────────────────────────────────────

    // Collect all skill labels for batch processing
    const skillLabels = passing.map(p => p.eval.suggestedSkillLabel || p.cluster.label)

    // Pass 1: Exact label match
    const { data: existingSkills } = await supabase.from('knowledge_skills')
      .select('id, label, confidence, status, exposure_level, evidence_count, related_anchor_ids')
      .eq('user_id', userId)

    const existingByLabel = new Map<string, typeof existingSkills extends Array<infer T> ? T : never>()
    for (const s of existingSkills ?? []) {
      existingByLabel.set((s.label as string).toLowerCase(), s)
    }

    // Pass 2: Batch generate embeddings for semantic dedup
    const labelEmbeddings: Array<number[] | null> = []
    for (const label of skillLabels) {
      try {
        const emb = await generateEmbedding(label)
        labelEmbeddings.push(emb)
      } catch {
        labelEmbeddings.push(null)
      }
    }

    // Build graph adjacency for BFS (S4)
    const graphAdj: Record<string, string[]> = {}
    for (const e of allEdges) {
      if (!graphAdj[e.source_node_id]) graphAdj[e.source_node_id] = []
      if (!graphAdj[e.target_node_id]) graphAdj[e.target_node_id] = []
      graphAdj[e.source_node_id].push(e.target_node_id)
      graphAdj[e.target_node_id].push(e.source_node_id)
    }

    const anchorIds = new Set(anchors.map(a => a.id))

    // Fix 1 — S5: derive domain from role when structured domain field is null
    const rawDomain = profile?.professional_context?.domain as string | null | undefined
    const rawRole = ((profile?.professional_context?.role as string | null | undefined) ?? '').toLowerCase()
    const userDomain: string | null = rawDomain
      ?? Object.entries(DOMAIN_ROLE_MAP).find(([, kws]) => kws.some(kw => rawRole.includes(kw)))?.[0]
      ?? null
    const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString()

    // Fetch all user sources for S3/S6
    const { data: allSources } = await supabase.from('knowledge_sources')
      .select('id, created_at').eq('user_id', userId)
    const allSourcesList = (allSources ?? []) as Array<{ id: string; created_at: string }>

    // Fetch all user nodes for S2/S3
    const { data: allUserNodes } = await supabase.from('knowledge_nodes')
      .select('id, label, entity_type, source_id').eq('user_id', userId).limit(5000)
    const allNodes = (allUserNodes ?? []) as Array<{ id: string; label: string; entity_type: string; source_id: string | null }>

    const nodeCountBySource: Record<string, number> = {}
    for (const n of allNodes) { if (n.source_id) nodeCountBySource[n.source_id] = (nodeCountBySource[n.source_id] ?? 0) + 1 }
    const maxNodeCount = Math.max(1, ...Object.values(nodeCountBySource))

    const created: Array<{ label: string; confidence: number; status: string }> = []
    const reinforced: Array<{ label: string; confidence_before: number; confidence_after: number }> = []

    for (let i = 0; i < passing.length; i++) {
      const { cluster, eval: ev } = passing[i]
      const skillLabel = ev.suggestedSkillLabel || cluster.label
      const embedding = labelEmbeddings[i]

      // Check exact match
      let existingSkill = existingByLabel.get(skillLabel.toLowerCase()) ?? null

      // Check semantic match if no exact match
      if (!existingSkill && embedding) {
        for (const s of existingSkills ?? []) {
          // Generate embedding for existing skill to compare (expensive — but needed for dedup)
          // Instead, check if any existing label is very similar textually first
          const simLabel = (s.label as string).toLowerCase()
          if (simLabel.includes(skillLabel.toLowerCase().slice(0, 15)) || skillLabel.toLowerCase().includes(simLabel.slice(0, 15))) {
            // Rough text match — skip expensive embedding comparison
            existingSkill = s
            break
          }
        }
      }

      if (existingSkill) {
        // ─── Step 6: Reinforcement ─────────────────────────────────────

        // 6a: Check idempotency
        const { data: existingJunction } = await supabase.from('skill_sources')
          .select('id').eq('skill_id', existingSkill.id as string).eq('source_id', sourceId).limit(1)
        if (existingJunction && existingJunction.length > 0) continue

        // 6b: Compute new confidence
        const delta = REINFORCEMENT_DELTAS[source.source_type] ?? 0.10
        const existingAnchors = (existingSkill.related_anchor_ids as string[] | null) ?? []
        const anchorBonus = existingAnchors.length > 0 ? 0.03 : 0
        const existingConf = existingSkill.confidence as number
        const newConfidence = Math.min(
          existingConf + (delta * (1 - existingConf) * 0.8) + anchorBonus,
          0.95
        )

        // 6c: Exposure upgrade
        const currentExposure = existingSkill.exposure_level as string
        const newEvidenceCount = (existingSkill.evidence_count as number) + 1
        let newExposure = currentExposure
        if (source.source_type === 'meeting' && currentExposure === 'developing') newExposure = 'proficient'
        else if (source.source_type === 'meeting' && currentExposure === 'novice') newExposure = 'developing'
        else if (newEvidenceCount >= 5 && currentExposure === 'developing') newExposure = 'proficient'
        else if (newEvidenceCount >= 8 && currentExposure === 'proficient') newExposure = 'advanced'

        // 6d: Update skill
        await supabase.from('knowledge_skills').update({
          confidence: newConfidence,
          exposure_level: newExposure,
          status: newConfidence >= 0.55 ? 'confirmed' : existingSkill.status as string,
          evidence_count: newEvidenceCount,
          last_reinforced_at: new Date().toISOString(),
        }).eq('id', existingSkill.id as string)

        // 6e: Write junction
        await supabase.from('skill_sources').insert({
          user_id: userId,
          skill_id: existingSkill.id as string,
          source_id: sourceId,
          contribution: newExposure !== currentExposure ? 'upgraded' : 'reinforced',
          confidence_delta: newConfidence - existingConf,
        })

        reinforced.push({ label: existingSkill.label as string, confidence_before: existingConf, confidence_after: newConfidence })
        // Fix 5 — Signal diagnostic log (reinforcement path — no per-signal breakdown available here)
        console.log(JSON.stringify({ sourceTitle: source.title, skillLabel: existingSkill.label, action: 'reinforced', confidence_before: existingConf, confidence_after: newConfidence }))
      } else {
        // ─── Step 5: Creation ──────────────────────────────────────────

        // 5a: Compute personalised relevance

        // Fix 3 — S2: individual keyword matching (not 3-word phrase)
        const keywords = skillLabel.toLowerCase().split(/\s+/).filter(w => w.length > 4)

        // Fix 2 — S1: explicit anchor embedding logging
        let s1 = 0
        const relatedAnchorIds: string[] = []
        const anchorsWithEmbedding = anchors.filter(a => {
          const emb = parseEmbedding(a.embedding)
          if (!emb.length) {
            console.warn(`[process-source] S1: anchor skipped (no/invalid embedding) — id=${a.id} label="${a.label}"`)
            return false
          }
          return true
        })
        console.log(`[process-source] S1: skill="${skillLabel}" anchors_total=${anchors.length} anchors_valid=${anchorsWithEmbedding.length}`)
        if (anchorsWithEmbedding.length > 0 && embedding) {
          for (const a of anchorsWithEmbedding) {
            const aEmb = parseEmbedding(a.embedding)
            const sim = cosineSimilarity(embedding, aEmb)
            if (sim > s1) s1 = sim
            if (sim > 0.3) relatedAnchorIds.push(a.id)
          }
        }

        // Fix 3 — S2: match any single keyword against node labels
        const relatedNodes = allNodes.filter(n => {
          const nodeLabel = n.label.toLowerCase()
          return keywords.some(kw => nodeLabel.includes(kw)) ||
            (n.source_id === sourceId && ['Topic', 'Technology', 'Concept'].includes(n.entity_type))
        })
        const s2 = Math.min(relatedNodes.length / maxNodeCount, 1)

        // S3
        const relatedSourceIds = new Set(relatedNodes.filter(n => n.source_id).map(n => n.source_id!))
        const s3 = Math.min(relatedSourceIds.size / 3, 1)

        // S4
        const hops = bfsToAnchor(cluster.primaryNodeId, anchorIds, graphAdj)
        const s4 = hops === null ? 0 : hops <= 1 ? 1.0 : hops === 2 ? 0.6 : hops === 3 ? 0.3 : 0

        // S5
        let multiplier = 1.0
        if (userDomain && ev.domain) {
          if (ev.domain === userDomain) multiplier = 1.4
          else if (ADJACENT_DOMAINS[userDomain]?.includes(ev.domain)) multiplier = 1.1
          else multiplier = 0.8
        }
        const s5 = Math.min(0.5 * multiplier, 1)

        // S6
        const recentSources = [...relatedSourceIds].filter(sid => {
          const s = allSourcesList.find(x => x.id === sid)
          return s && s.created_at >= fourteenDaysAgo
        })
        const s6 = recentSources.length === 0 ? 0 : recentSources.length === 1 ? 0.5 : 1

        const relevanceScore = +(s1 * SIGNAL_WEIGHTS.anchorAlignment + s2 * SIGNAL_WEIGHTS.nodeDensity + s3 * SIGNAL_WEIGHTS.sourceHistory + s4 * SIGNAL_WEIGHTS.graphProximity + s5 * SIGNAL_WEIGHTS.profileContext + s6 * SIGNAL_WEIGHTS.velocity).toFixed(2)

        // Fix 4 — Gate skill creation on minimum relevance score
        if (relevanceScore < MIN_RELEVANCE_TO_CREATE) {
          console.log(JSON.stringify({ sourceTitle: source.title, skillLabel, s1, s2, s3, s4, s5, s6, relevanceScore, action: 'skipped' }))
          continue
        }

        // 5b: Write skill
        const initialConfidence = SOURCE_TYPE_CONFIDENCE[source.source_type] ?? 0.35
        const anchorBonus = relatedAnchorIds.length > 0 ? 0.05 : 0
        const finalConfidence = Math.min(initialConfidence + anchorBonus, 0.95)

        // Derive exposure
        let exposureLevel: string = 'novice'
        if (source.source_type === 'meeting') exposureLevel = 'developing'
        else if (source.source_type === 'file' && relatedNodes.length > 5) exposureLevel = 'proficient'
        else if (relatedNodes.length > 3) exposureLevel = 'developing'

        const status = finalConfidence >= 0.55 ? 'confirmed' : 'candidate'

        const signalBreakdown = {
          anchorAlignment: s1, nodeDensity: s2, sourceHistory: s3,
          graphProximity: s4, profileContext: s5, velocity: s6,
        }

        const { data: newSkill } = await supabase.from('knowledge_skills').insert({
          user_id: userId,
          label: skillLabel,
          domain: ev.domain || 'domain_specific',
          confidence: finalConfidence,
          exposure_level: exposureLevel,
          status,
          last_relevance_score: relevanceScore,
          signal_breakdown: signalBreakdown,
          related_anchor_ids: relatedAnchorIds,
          first_detected_at: new Date().toISOString(),
          last_reinforced_at: new Date().toISOString(),
        }).select('id').single()

        if (newSkill) {
          // 5c: Write junction
          await supabase.from('skill_sources').insert({
            user_id: userId,
            skill_id: newSkill.id,
            source_id: sourceId,
            contribution: 'created',
            confidence_delta: finalConfidence,
          })
        }

        created.push({ label: skillLabel, confidence: finalConfidence, status })
        // Fix 5 — Signal diagnostic log
        console.log(JSON.stringify({ sourceTitle: source.title, skillLabel, s1, s2, s3, s4, s5, s6, relevanceScore, action: 'created' }))
      }
    }

    // 5d: Update skill_scan_state
    const { data: confirmedCount } = await supabase.from('knowledge_skills')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId).eq('status', 'confirmed')

    await supabase.from('skill_scan_state').upsert({
      user_id: userId,
      last_incremental_at: new Date().toISOString(),
      candidates_confirmed: confirmedCount ?? 0,
      scan_version: CURRENT_SCAN_VERSION,
    }, { onConflict: 'user_id' })

    return res.status(200).json({
      source_id: sourceId,
      skills_created: created.length,
      skills_reinforced: reinforced.length,
      clusters_evaluated: cappedClusters.length,
      clusters_passed_universal: passing.length,
      duration_ms: Date.now() - startTime,
      created,
      reinforced,
    })
  } catch (err) {
    console.error('[process-source] Fatal:', err)
    return res.status(500).json({ error: 'Processing failed', detail: err instanceof Error ? err.message : 'Unknown' })
  }
}
