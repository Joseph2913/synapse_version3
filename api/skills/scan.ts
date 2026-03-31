/**
 * api/skills/scan.ts
 *
 * Vercel serverless function — orchestrates a full skill candidate scan.
 * CRITICAL: Fully self-contained. No local imports. All helpers defined inline.
 *
 * PRD: PRD-25 — Skill Candidate Diagnostic Tool
 * Read-only — nothing is written to the database.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createClient } from '@supabase/supabase-js'

export const maxDuration = 60

// ─── ENVIRONMENT ──────────────────────────────────────────────────────────────

const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? ''
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''
const GEMINI_API_KEY = process.env.GEMINI_API_KEY ?? process.env.VITE_GEMINI_API_KEY ?? ''
const GEMINI_MODEL = process.env.GEMINI_MODEL ?? 'gemini-2.0-flash'

// ─── SIGNAL WEIGHTS (named constants for easy tuning) ─────────────────────────

const SIGNAL_WEIGHTS = {
  anchorAlignment:   0.25,
  nodeDensity:       0.20,
  sourceHistory:     0.20,
  graphProximity:    0.15,
  profileContext:    0.10,
  velocity:          0.10,
} as const

// ─── EVALUATION PROMPT ────────────────────────────────────────────────────────

const EVALUATION_SYSTEM_PROMPT = `You are evaluating content from a personal knowledge graph tool to determine whether it contains teachable, applicable skills.

A skill is defined as: a concept or technique that is specific enough to be applied, general enough to be reused across contexts, and has a discernible method — meaning there is a describable way of doing it, not just knowing about it.

For each candidate concept cluster provided, evaluate it against the following five criteria:

C1 — Instructional Intent: Is this source explicitly teaching, explaining, or demonstrating something? Does it have tutorial structure, step-by-step language, or worked examples?

C2 — Specificity Threshold: Is the concept specific enough to be actionable? Could someone follow this to produce a concrete output?

C3 — Reusability Signal: Does this technique apply across more than one context? Is it framed as transferable?

C4 — Method Presence: Is there a describable sequence of steps, decisions, or principles? Does the content contain enough procedural detail to explain how to apply this?

C5 — Minimum Depth: Does the source spend substantial time on this concept, or is it a passing mention?

Respond ONLY with a JSON array. No preamble, no markdown, no explanation outside the JSON.`

// ─── ENTITY TYPE SETS ─────────────────────────────────────────────────────────

const SKILL_ELIGIBLE_TYPES = new Set([
  'Topic', 'Technology', 'Concept', 'Insight', 'Idea',
  'Hypothesis', 'Lesson', 'Takeaway', 'Methodology',
])

const SKILL_EXCLUDED_TYPES = new Set([
  'Person', 'Organization', 'Team', 'Location', 'Event',
  'Metric', 'Document', 'Action', 'Blocker', 'Risk',
  'Question', 'Goal', 'Decision', 'Anchor',
])

// ─── DOMAIN / ROLE MAPPING ────────────────────────────────────────────────────

const DOMAIN_ROLE_MAP: Record<string, string[]> = {
  technical:   ['engineer', 'developer', 'architect', 'cto', 'technical'],
  consulting:  ['consultant', 'advisor', 'partner', 'director', 'strategy'],
  strategic:   ['founder', 'ceo', 'vp', 'head of', 'lead'],
}

// ─── TYPE DEFINITIONS ─────────────────────────────────────────────────────────

interface ScanRequest {
  source_types?: string[]
  min_criteria_pass?: number
  min_relevance?: number
  limit?: number
  include_failed?: boolean
}

interface CriterionResult {
  pass: boolean
  rationale: string
}

interface GeminiEvaluation {
  candidateLabel: string
  C1: CriterionResult
  C2: CriterionResult
  C3: CriterionResult
  C4: CriterionResult
  C5: CriterionResult
  criteriaPassedCount: number
  suggestedSkillLabel: string
  domain: 'technical' | 'consulting' | 'strategic' | 'interpersonal' | 'domain_specific'
}

interface SignalBreakdown {
  anchorAlignment:  { score: number; matchedAnchor: string | null }
  nodeDensity:      { score: number; relatedNodeCount: number }
  sourceHistory:    { score: number; relatedSourceCount: number }
  graphProximity:   { score: number; hopsToNearestAnchor: number | null }
  profileContext:   { score: number; multiplierApplied: number }
  velocity:         { score: number; recentSourceCount: number }
}

interface SkillCandidate {
  id: string
  suggestedSkillLabel: string
  domain: string
  status: 'confirmed_candidate' | 'pending_reinforcement' | 'weak_signal'
  exposureLevel: 'novice' | 'developing' | 'proficient' | 'advanced'
  criteriaPassedCount: number
  criteria: {
    C1: CriterionResult
    C2: CriterionResult
    C3: CriterionResult
    C4: CriterionResult
    C5: CriterionResult
  }
  relevanceScore: number
  signalBreakdown: SignalBreakdown
  primarySource: {
    id: string
    title: string
    source_type: string
    created_at: string
  }
  contributingSources: Array<{
    id: string
    title: string
    source_type: string
  }>
  relatedAnchors: Array<{
    label: string
    entity_type: string
    similarityScore: number
  }>
  whatWouldUpgradeIt: string
  primaryNodeLabel: string
  clusterNodeLabels: string[]
}

interface FailedCandidate {
  clusterLabel: string
  sourceTitle: string
  source_type: string
  failReason: 'insufficient_criteria' | 'evaluation_error' | 'excluded_entity_type'
  criteriaPassedCount?: number
  failedCriteria?: string[]
}

interface ScanResponse {
  meta: {
    scannedAt: string
    sourcesScanned: number
    clustersEvaluated: number
    confirmedCandidates: number
    pendingCandidates: number
    weakSignalCandidates: number
    failedUniversal: number
    evaluationErrors: number
    durationMs: number
  }
  candidates: SkillCandidate[]
  failedCandidates: FailedCandidate[]
  diagnosticNotes: string[]
}

// ─── DB ROW TYPES ─────────────────────────────────────────────────────────────

interface DBSource {
  id: string
  title: string
  source_type: string
  created_at: string
  metadata: Record<string, unknown> | null
}

interface DBNode {
  id: string
  label: string
  entity_type: string
  confidence: number | null
  source_id: string | null
  is_anchor: boolean | null
  description: string | null
  embedding: number[] | null
}

interface DBEdge {
  source_node_id: string
  target_node_id: string
  relation_type: string | null
  weight: number | null
}

interface DBChunkCount {
  source_id: string
  chunk_count: number
}

interface DBProfile {
  professional_context: Record<string, unknown> | null
  personal_interests: Record<string, unknown> | null
  processing_preferences: Record<string, unknown> | null
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

// ─── INLINE HELPERS ───────────────────────────────────────────────────────────

function parseEmbedding(raw: unknown): number[] {
  if (Array.isArray(raw)) return raw as number[]
  if (typeof raw === 'string') return JSON.parse(raw) as number[]
  return []
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0
  let dot = 0, magA = 0, magB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    magA += a[i] * a[i]
    magB += b[i] * b[i]
  }
  magA = Math.sqrt(magA)
  magB = Math.sqrt(magB)
  return magA && magB ? dot / (magA * magB) : 0
}

function sha256Hex(input: string): string {
  // Simple deterministic hash using djb2 variant — not crypto-grade, but deterministic and collision-resistant enough for IDs
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507)
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507)
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  const combined = (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0')
  return combined.slice(0, 16)
}

function parseJSON<T>(text: string): T | null {
  const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
  try {
    return JSON.parse(cleaned) as T
  } catch {
    return null
  }
}

// ─── GEMINI HELPERS ───────────────────────────────────────────────────────────

async function callGemini(systemPrompt: string, userPrompt: string, maxTokens: number = 2048): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [{ parts: [{ text: userPrompt }] }],
      generationConfig: { temperature: 0.1, maxOutputTokens: maxTokens },
    }),
  })
  if (!response.ok) {
    throw new Error(`Gemini API error: ${response.status} ${response.statusText}`)
  }
  const data = await response.json()
  return data.candidates?.[0]?.content?.parts?.[0]?.text ?? ''
}

async function generateEmbedding(text: string): Promise<number[]> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent?key=${GEMINI_API_KEY}`
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'models/text-embedding-004',
      content: { parts: [{ text }] },
    }),
  })
  if (!response.ok) {
    throw new Error(`Embedding API error: ${response.status}`)
  }
  const data = await response.json()
  return data.embedding?.values ?? []
}

// ─── AUTH ─────────────────────────────────────────────────────────────────────

function getSupabase() {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
}

async function getUserFromToken(req: VercelRequest): Promise<string | null> {
  const auth = req.headers['authorization']
  if (!auth?.startsWith('Bearer ')) return null
  const token = auth.slice(7)
  const supabase = getSupabase()
  const { data } = await supabase.auth.getUser(token)
  return data?.user?.id ?? null
}

// ─── CLUSTER FORMATION ────────────────────────────────────────────────────────

function formClusters(
  sourceId: string,
  nodes: DBNode[],
  edges: DBEdge[],
): ConceptCluster[] {
  // Filter to skill-eligible nodes for this source
  const eligible = nodes.filter(n =>
    n.source_id === sourceId && SKILL_ELIGIBLE_TYPES.has(n.entity_type)
  )
  if (eligible.length === 0) return []

  // Build adjacency for nodes in this source
  const nodeIdSet = new Set(eligible.map(n => n.id))
  const adjacency: Record<string, Set<string>> = {}
  for (const n of eligible) adjacency[n.id] = new Set()

  for (const e of edges) {
    if (nodeIdSet.has(e.source_node_id) && nodeIdSet.has(e.target_node_id)) {
      adjacency[e.source_node_id]?.add(e.target_node_id)
      adjacency[e.target_node_id]?.add(e.source_node_id)
    }
  }

  // Connected components via BFS
  const visited = new Set<string>()
  const clusters: ConceptCluster[] = []

  for (const node of eligible) {
    if (visited.has(node.id)) continue
    const component: DBNode[] = []
    const queue = [node.id]
    while (queue.length > 0) {
      const current = queue.shift()!
      if (visited.has(current)) continue
      visited.add(current)
      const n = eligible.find(e => e.id === current)
      if (n) component.push(n)
      for (const neighbor of adjacency[current] ?? []) {
        if (!visited.has(neighbor)) queue.push(neighbor)
      }
    }

    // Also merge singletons of same entity type family
    // (handled implicitly — singletons form their own cluster)
    if (component.length > 0) {
      // Pick the most prominent node (highest confidence)
      const primary = component.reduce((best, n) =>
        (n.confidence ?? 0) > (best.confidence ?? 0) ? n : best
      , component[0])

      clusters.push({
        sourceId,
        label: primary.label,
        primaryNodeId: primary.id,
        entityTypes: [...new Set(component.map(n => n.entity_type))],
        nodeIds: component.map(n => n.id),
        nodeLabels: component.map(n => n.label),
        confidence: primary.confidence ?? 0.5,
      })
    }
  }

  // Cap at 5 clusters per source
  return clusters
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 5)
}

// ─── GRAPH BFS (for S4) ──────────────────────────────────────────────────────

function bfsToAnchor(
  startNodeId: string,
  anchorIds: Set<string>,
  adjacency: Record<string, string[]>,
): number | null {
  if (anchorIds.has(startNodeId)) return 0
  const visited = new Set<string>([startNodeId])
  let frontier = [startNodeId]
  for (let depth = 1; depth <= 4; depth++) {
    const next: string[] = []
    for (const nodeId of frontier) {
      for (const neighbor of adjacency[nodeId] ?? []) {
        if (visited.has(neighbor)) continue
        if (anchorIds.has(neighbor)) return depth
        visited.add(neighbor)
        next.push(neighbor)
      }
    }
    frontier = next
    if (frontier.length === 0) break
  }
  return null
}

// ─── EXPOSURE LEVEL DERIVATION ────────────────────────────────────────────────

function deriveExposureLevel(
  source: DBSource,
  s1Score: number,
  s2Score: number,
  s3Score: number,
): 'novice' | 'developing' | 'proficient' | 'advanced' {
  if (s1Score > 0.7 && s3Score > 0.6 && s2Score > 0.6) return 'advanced'
  if (source.source_type === 'Meeting' && s2Score > 0.6) return 'proficient'
  if (s2Score > 0.6) return 'proficient'
  if (s2Score >= 0.3 || s3Score >= 0.5) return 'developing'
  return 'novice'
}

// ─── UPGRADE PATH ─────────────────────────────────────────────────────────────

function computeUpgradePath(
  candidate: { exposureLevel: string; signalBreakdown: SignalBreakdown; domain: string },
): string {
  const parts: string[] = []
  const { signalBreakdown, exposureLevel } = candidate

  if (exposureLevel === 'novice') {
    parts.push('A meeting transcript discussing application would raise exposure to Proficient.')
  }
  if (exposureLevel === 'developing') {
    parts.push('Additional sources or a discussion of practical application would raise exposure.')
  }
  if (signalBreakdown.anchorAlignment.score < 0.5) {
    parts.push('Creating an anchor node related to this topic would increase personalised relevance.')
  }
  if (signalBreakdown.sourceHistory.relatedSourceCount < 2) {
    parts.push('Ingesting additional sources on this topic would strengthen cross-source reinforcement.')
  }
  if (signalBreakdown.velocity.recentSourceCount === 0) {
    parts.push('No recent activity on this topic — re-engaging would boost the velocity signal.')
  }

  return parts.length > 0 ? parts.join(' ') : 'This candidate is well-established across multiple signals.'
}

// ─── DIAGNOSTIC NOTE GENERATION ───────────────────────────────────────────────

function generateDiagnosticNotes(
  candidates: SkillCandidate[],
  failedCount: number,
  errorCount: number,
  hasAnchors: boolean,
  hasProfile: boolean,
  sourcesScanned: number,
): string[] {
  const notes: string[] = []

  if (sourcesScanned === 0) {
    notes.push('No sources found. Ingest content in the Capture view first.')
    return notes
  }

  if (candidates.length > 0) {
    const byType: Record<string, number> = {}
    for (const c of candidates) {
      const t = c.primarySource.source_type
      byType[t] = (byType[t] ?? 0) + 1
    }
    const total = candidates.length
    for (const [type, count] of Object.entries(byType)) {
      const pct = Math.round((count / total) * 100)
      if (pct > 60) {
        notes.push(`${pct}% of confirmed candidates came from ${type} sources — other source types may be underrepresented and could contain additional skill signals.`)
      }
    }
  }

  if (!hasAnchors) {
    notes.push('No anchor nodes found — S1 Anchor Alignment scored 0 for all candidates. Designate anchors in the Explore view to improve personalised scoring.')
  } else {
    const anchorDominant = candidates.filter(c => c.signalBreakdown.anchorAlignment.score > 0.6).length
    if (anchorDominant > candidates.length * 0.5) {
      notes.push('Anchor alignment was the dominant scoring signal — users with more anchors will see better personalised scoring.')
    }
  }

  if (errorCount > 0) {
    notes.push(`${errorCount} source(s) returned evaluation errors — check Vercel logs for Gemini API issues.`)
  }

  if (!hasProfile) {
    notes.push('No user profile found — S5 Profile Context scored as neutral (0.5) for all candidates. Add a profile in Settings to improve personalisation.')
  }

  if (candidates.length === 0 && failedCount > 0) {
    notes.push('No candidates passed both layers. Consider lowering min_criteria_pass to 2 and re-running.')
  }

  return notes
}

// ─── MAIN HANDLER ─────────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: 'Supabase not configured' })
  }

  if (!GEMINI_API_KEY) {
    return res.status(500).json({ error: 'GEMINI_API_KEY not configured' })
  }

  const userId = await getUserFromToken(req)
  if (!userId) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const startTime = Date.now()

  const body = (req.body ?? {}) as ScanRequest
  const sourceTypes = body.source_types ?? ['YouTube', 'Meeting', 'Document', 'Research']
  const minCriteriaPass = body.min_criteria_pass ?? 3
  const minRelevance = body.min_relevance ?? 0.20
  const limit = Math.min(body.limit ?? 60, 100)
  const includeFailed = body.include_failed ?? true

  const supabase = getSupabase()
  const diagnosticNotes: string[] = []
  let evaluationErrors = 0

  try {
    // ─── Phase 1: Data assembly (parallel queries) ───────────────────────

    const [sourcesRes, nodesRes, edgesRes, chunksRes, anchorsRes, profileRes] = await Promise.all([
      supabase
        .from('knowledge_sources')
        .select('id, title, source_type, created_at, metadata')
        .eq('user_id', userId)
        .in('source_type', sourceTypes)
        .order('created_at', { ascending: false }),

      supabase
        .from('knowledge_nodes')
        .select('id, label, entity_type, confidence, source_id, is_anchor, description, embedding')
        .eq('user_id', userId),

      supabase
        .from('knowledge_edges')
        .select('source_node_id, target_node_id, relation_type, weight')
        .eq('user_id', userId),

      supabase
        .rpc('get_chunk_counts_by_source', { p_user_id: userId })
        .then(result => {
          // Fallback: if RPC doesn't exist, query directly
          if (result.error) {
            return supabase
              .from('source_chunks')
              .select('source_id')
              .eq('user_id', userId)
          }
          return result
        }),

      supabase
        .from('knowledge_nodes')
        .select('id, label, entity_type, description, embedding')
        .eq('user_id', userId)
        .eq('is_anchor', true),

      supabase
        .from('user_profiles')
        .select('professional_context, personal_interests, processing_preferences')
        .eq('user_id', userId)
        .maybeSingle(),
    ])

    const sources: DBSource[] = (sourcesRes.data ?? []) as DBSource[]
    const allNodes: DBNode[] = (nodesRes.data ?? []) as DBNode[]
    const allEdges: DBEdge[] = (edgesRes.data ?? []) as DBEdge[]
    const anchors: DBNode[] = (anchorsRes.data ?? []) as DBNode[]
    const profile: DBProfile | null = profileRes.data as DBProfile | null

    // Build chunk counts manually from source_chunks query
    const chunkCountsBySourceId: Record<string, number> = {}
    if (chunksRes.data) {
      // If RPC worked, it returns {source_id, chunk_count}
      // If fallback, it returns individual rows
      for (const row of chunksRes.data as Array<Record<string, unknown>>) {
        const sid = row.source_id as string
        if (row.chunk_count !== undefined) {
          chunkCountsBySourceId[sid] = row.chunk_count as number
        } else {
          chunkCountsBySourceId[sid] = (chunkCountsBySourceId[sid] ?? 0) + 1
        }
      }
    }

    const hasAnchors = anchors.length > 0
    const hasProfile = !!profile

    if (sources.length === 0) {
      const response: ScanResponse = {
        meta: {
          scannedAt: new Date().toISOString(),
          sourcesScanned: 0,
          clustersEvaluated: 0,
          confirmedCandidates: 0,
          pendingCandidates: 0,
          weakSignalCandidates: 0,
          failedUniversal: 0,
          evaluationErrors: 0,
          durationMs: Date.now() - startTime,
        },
        candidates: [],
        failedCandidates: [],
        diagnosticNotes: ['No sources found. Ingest content in the Capture view first.'],
      }
      return res.status(200).json(response)
    }

    // ─── Phase 2: Concept cluster formation ──────────────────────────────

    const allClusters: ConceptCluster[] = []
    for (const source of sources) {
      const clusters = formClusters(source.id, allNodes, allEdges)
      allClusters.push(...clusters)
    }

    // ─── Phase 3: C5 pre-filter ──────────────────────────────────────────

    const c5Flags: Record<string, boolean> = {}
    for (const cluster of allClusters) {
      const chunkCount = chunkCountsBySourceId[cluster.sourceId] ?? 0
      if (chunkCount < 3) {
        c5Flags[cluster.primaryNodeId] = true
      }
    }

    // ─── Phase 4: Universal layer evaluation (Gemini batched per source) ─

    // Group clusters by source
    const clustersBySource = new Map<string, ConceptCluster[]>()
    for (const cluster of allClusters) {
      const existing = clustersBySource.get(cluster.sourceId) ?? []
      existing.push(cluster)
      clustersBySource.set(cluster.sourceId, existing)
    }

    // Fetch top 6 chunks per source for context
    const sourceChunkMap = new Map<string, string[]>()
    const sourceIdsForChunks = [...clustersBySource.keys()]

    // Batch fetch chunks for all sources that have clusters
    if (sourceIdsForChunks.length > 0) {
      const { data: chunkRows } = await supabase
        .from('source_chunks')
        .select('source_id, chunk_index, content')
        .eq('user_id', userId)
        .in('source_id', sourceIdsForChunks)
        .order('chunk_index', { ascending: true })

      if (chunkRows) {
        for (const row of chunkRows as Array<{ source_id: string; chunk_index: number; content: string }>) {
          const existing = sourceChunkMap.get(row.source_id) ?? []
          if (existing.length < 6) {
            existing.push(row.content)
            sourceChunkMap.set(row.source_id, existing)
          }
        }
      }
    }

    // Evaluate each source's clusters with Gemini
    const evaluationResults = new Map<string, GeminiEvaluation>() // key = primaryNodeId
    const failedCandidates: FailedCandidate[] = []

    // Process sources sequentially to avoid rate limits, but could parallelize in batches
    for (const [sourceId, clusters] of clustersBySource) {
      const source = sources.find(s => s.id === sourceId)
      if (!source) continue

      const chunks = sourceChunkMap.get(sourceId) ?? []
      const chunkContext = chunks.length > 0
        ? chunks.join('\n\n---\n\n')
        : `Source title: ${source.title ?? 'Untitled'}`

      const candidateList = clusters
        .map((c, i) => `${i + 1}. "${c.label}" (entity types: ${c.entityTypes.join(', ')})`)
        .join('\n')

      const userPrompt = `Source title: ${source.title ?? 'Untitled'}
Source type: ${source.source_type ?? 'Unknown'}

Source content (top chunks):
${chunkContext}

Candidate clusters to evaluate:
${candidateList}

Return a JSON array with one object per candidate:
[
  {
    "candidateLabel": "string",
    "C1": { "pass": boolean, "rationale": "one sentence" },
    "C2": { "pass": boolean, "rationale": "one sentence" },
    "C3": { "pass": boolean, "rationale": "one sentence" },
    "C4": { "pass": boolean, "rationale": "one sentence" },
    "C5": { "pass": boolean, "rationale": "one sentence" },
    "criteriaPassedCount": number,
    "suggestedSkillLabel": "string — a clean, precise, actionable skill name",
    "domain": "technical | consulting | strategic | interpersonal | domain_specific"
  }
]`

      try {
        const rawResponse = await callGemini(EVALUATION_SYSTEM_PROMPT, userPrompt, 2048)
        const evaluations = parseJSON<GeminiEvaluation[]>(rawResponse)

        if (!evaluations || !Array.isArray(evaluations)) {
          console.error(`[skill-scan] Failed to parse Gemini response for source ${sourceId}:`, rawResponse.slice(0, 200))
          evaluationErrors++
          for (const cluster of clusters) {
            failedCandidates.push({
              clusterLabel: cluster.label,
              sourceTitle: source.title ?? 'Untitled',
              source_type: source.source_type ?? 'Unknown',
              failReason: 'evaluation_error',
            })
          }
          continue
        }

        // Match evaluations to clusters
        for (let i = 0; i < clusters.length; i++) {
          const cluster = clusters[i]
          const evaluation = evaluations[i] ?? evaluations.find(e => e.candidateLabel === cluster.label)

          if (!evaluation) {
            failedCandidates.push({
              clusterLabel: cluster.label,
              sourceTitle: source.title ?? 'Untitled',
              source_type: source.source_type ?? 'Unknown',
              failReason: 'evaluation_error',
            })
            evaluationErrors++
            continue
          }

          // Override C5 with rule-based check if flagged
          if (c5Flags[cluster.primaryNodeId] && evaluation.C5.pass) {
            evaluation.C5 = { pass: false, rationale: 'Source has fewer than 3 chunks — insufficient depth.' }
            evaluation.criteriaPassedCount = [evaluation.C1, evaluation.C2, evaluation.C3, evaluation.C4, evaluation.C5]
              .filter(c => c.pass).length
          }

          if (evaluation.criteriaPassedCount >= minCriteriaPass) {
            evaluationResults.set(cluster.primaryNodeId, evaluation)
          } else {
            const failedCriteria: string[] = []
            if (!evaluation.C1.pass) failedCriteria.push('C1')
            if (!evaluation.C2.pass) failedCriteria.push('C2')
            if (!evaluation.C3.pass) failedCriteria.push('C3')
            if (!evaluation.C4.pass) failedCriteria.push('C4')
            if (!evaluation.C5.pass) failedCriteria.push('C5')

            failedCandidates.push({
              clusterLabel: cluster.label,
              sourceTitle: source.title ?? 'Untitled',
              source_type: source.source_type ?? 'Unknown',
              failReason: 'insufficient_criteria',
              criteriaPassedCount: evaluation.criteriaPassedCount,
              failedCriteria,
            })
          }
        }
      } catch (err) {
        console.error(`[skill-scan] Gemini call failed for source ${sourceId}:`, err)
        evaluationErrors++
        for (const cluster of clusters) {
          failedCandidates.push({
            clusterLabel: cluster.label,
            sourceTitle: source.title ?? 'Untitled',
            source_type: source.source_type ?? 'Unknown',
            failReason: 'evaluation_error',
          })
        }
      }
    }

    // ─── Phase 5: Personalised layer scoring ─────────────────────────────

    // Build graph adjacency for BFS
    const graphAdj: Record<string, string[]> = {}
    for (const edge of allEdges) {
      if (!graphAdj[edge.source_node_id]) graphAdj[edge.source_node_id] = []
      if (!graphAdj[edge.target_node_id]) graphAdj[edge.target_node_id] = []
      graphAdj[edge.source_node_id].push(edge.target_node_id)
      graphAdj[edge.target_node_id].push(edge.source_node_id)
    }

    const anchorIds = new Set(anchors.map(a => a.id))

    // Compute max node count per source for normalisation
    const nodeCountBySource: Record<string, number> = {}
    for (const node of allNodes) {
      if (node.source_id) {
        nodeCountBySource[node.source_id] = (nodeCountBySource[node.source_id] ?? 0) + 1
      }
    }
    const maxNodeCountPerSource = Math.max(1, ...Object.values(nodeCountBySource))

    // Parse user role for S5
    const userRole = ((profile?.professional_context as Record<string, unknown>)?.role as string ?? '').toLowerCase()

    // Determine role domain
    function getUserDomain(): string | null {
      for (const [domain, keywords] of Object.entries(DOMAIN_ROLE_MAP)) {
        if (keywords.some(kw => userRole.includes(kw))) return domain
      }
      return null
    }
    const userDomain = getUserDomain()

    // Compute 14-day window for velocity
    const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString()

    const candidates: SkillCandidate[] = []

    // Generate embeddings for all candidate skill labels in one batch
    const passingClusters = allClusters.filter(c => evaluationResults.has(c.primaryNodeId))

    for (const cluster of passingClusters) {
      const evaluation = evaluationResults.get(cluster.primaryNodeId)!
      const source = sources.find(s => s.id === cluster.sourceId)!
      const skillLabel = evaluation.suggestedSkillLabel || cluster.label
      const keyword = skillLabel.split(/\s+/).slice(0, 3).join(' ').toLowerCase()

      // S1 — Anchor Alignment
      let s1Score = 0
      let matchedAnchorLabel: string | null = null
      if (anchors.length > 0 && skillLabel) {
        try {
          const candidateEmbedding = await generateEmbedding(skillLabel)
          for (const anchor of anchors) {
            const anchorEmb = parseEmbedding(anchor.embedding)
            if (!anchorEmb.length) continue
            const sim = cosineSimilarity(candidateEmbedding, anchorEmb)
            if (sim > s1Score) {
              s1Score = sim
              matchedAnchorLabel = anchor.label
            }
          }
        } catch {
          // Embedding failed — S1 stays 0
        }
      }

      // S2 — Node Density
      const relatedNodes = allNodes.filter(n => {
        const labelMatch = n.label.toLowerCase().includes(keyword)
        const sameSourceType = n.source_id === cluster.sourceId &&
          ['Topic', 'Technology', 'Concept'].includes(n.entity_type)
        return labelMatch || sameSourceType
      })
      const s2Score = Math.min(relatedNodes.length / maxNodeCountPerSource, 1.0)

      // S3 — Source History Pattern
      const relatedSourceIds = new Set(relatedNodes.filter(n => n.source_id).map(n => n.source_id!))
      const s3Score = Math.min(relatedSourceIds.size / 3, 1.0)

      // S4 — Graph Proximity
      const hops = bfsToAnchor(cluster.primaryNodeId, anchorIds, graphAdj)
      let s4Score = 0
      if (hops !== null) {
        if (hops === 0) s4Score = 1.0
        else if (hops === 1) s4Score = 1.0
        else if (hops === 2) s4Score = 0.6
        else if (hops === 3) s4Score = 0.3
      }

      // S5 — Profile Context
      let multiplier = 1.0
      if (userDomain && evaluation.domain) {
        if (evaluation.domain === userDomain) multiplier = 1.3
        else if (evaluation.domain !== userDomain &&
                 userDomain !== null &&
                 !SKILL_EXCLUDED_TYPES.has(evaluation.domain)) {
          multiplier = 0.7
        }
      }
      const s5Score = Math.min(0.5 * multiplier, 1.0)

      // S6 — Velocity
      const recentSources = [...relatedSourceIds].filter(sid => {
        const s = sources.find(src => src.id === sid)
        return s && s.created_at >= fourteenDaysAgo
      })
      const s6Score = recentSources.length === 0 ? 0 : recentSources.length === 1 ? 0.5 : 1.0

      // Compute final relevance score
      const relevanceScore = Number((
        s1Score * SIGNAL_WEIGHTS.anchorAlignment +
        s2Score * SIGNAL_WEIGHTS.nodeDensity +
        s3Score * SIGNAL_WEIGHTS.sourceHistory +
        s4Score * SIGNAL_WEIGHTS.graphProximity +
        s5Score * SIGNAL_WEIGHTS.profileContext +
        s6Score * SIGNAL_WEIGHTS.velocity
      ).toFixed(2))

      if (relevanceScore < minRelevance) continue

      // Determine status
      let status: 'confirmed_candidate' | 'pending_reinforcement' | 'weak_signal'
      if (relevanceScore >= 0.55) status = 'confirmed_candidate'
      else if (relevanceScore >= 0.35) status = 'pending_reinforcement'
      else status = 'weak_signal'

      // Derive exposure level
      const exposureLevel = deriveExposureLevel(source, s1Score, s2Score, s3Score)

      const signalBreakdown: SignalBreakdown = {
        anchorAlignment:  { score: Number(s1Score.toFixed(2)), matchedAnchor: matchedAnchorLabel },
        nodeDensity:      { score: Number(s2Score.toFixed(2)), relatedNodeCount: relatedNodes.length },
        sourceHistory:    { score: Number(s3Score.toFixed(2)), relatedSourceCount: relatedSourceIds.size },
        graphProximity:   { score: Number(s4Score.toFixed(2)), hopsToNearestAnchor: hops },
        profileContext:   { score: Number(s5Score.toFixed(2)), multiplierApplied: multiplier },
        velocity:         { score: Number(s6Score.toFixed(2)), recentSourceCount: recentSources.length },
      }

      // Related anchors
      const relatedAnchors: SkillCandidate['relatedAnchors'] = []
      if (anchors.length > 0 && s1Score > 0) {
        try {
          const candidateEmbedding = await generateEmbedding(skillLabel)
          for (const anchor of anchors) {
            const anchorEmb = parseEmbedding(anchor.embedding)
            if (!anchorEmb.length) continue
            const sim = cosineSimilarity(candidateEmbedding, anchorEmb)
            if (sim > 0.3) {
              relatedAnchors.push({
                label: anchor.label,
                entity_type: anchor.entity_type,
                similarityScore: Number(sim.toFixed(2)),
              })
            }
          }
          relatedAnchors.sort((a, b) => b.similarityScore - a.similarityScore)
        } catch {
          // Skip
        }
      }

      // Contributing sources
      const contributingSources = [...relatedSourceIds]
        .filter(sid => sid !== source.id)
        .map(sid => {
          const s = sources.find(src => src.id === sid)
          return s ? { id: s.id, title: s.title ?? 'Untitled', source_type: s.source_type ?? 'Unknown' } : null
        })
        .filter((s): s is NonNullable<typeof s> => s !== null)
        .slice(0, 5)

      const candidateObj: SkillCandidate = {
        id: sha256Hex(userId + cluster.sourceId + cluster.label),
        suggestedSkillLabel: skillLabel,
        domain: evaluation.domain,
        status,
        exposureLevel,
        criteriaPassedCount: evaluation.criteriaPassedCount,
        criteria: {
          C1: evaluation.C1,
          C2: evaluation.C2,
          C3: evaluation.C3,
          C4: evaluation.C4,
          C5: evaluation.C5,
        },
        relevanceScore,
        signalBreakdown,
        primarySource: {
          id: source.id,
          title: source.title ?? 'Untitled',
          source_type: source.source_type ?? 'Unknown',
          created_at: source.created_at,
        },
        contributingSources,
        relatedAnchors,
        whatWouldUpgradeIt: '', // computed below
        primaryNodeLabel: cluster.label,
        clusterNodeLabels: cluster.nodeLabels,
      }

      candidateObj.whatWouldUpgradeIt = computeUpgradePath(candidateObj)
      candidates.push(candidateObj)
    }

    // ─── Phase 6: Response assembly ──────────────────────────────────────

    candidates.sort((a, b) => b.relevanceScore - a.relevanceScore)
    const trimmed = candidates.slice(0, limit)

    const confirmed = trimmed.filter(c => c.status === 'confirmed_candidate').length
    const pending = trimmed.filter(c => c.status === 'pending_reinforcement').length
    const weak = trimmed.filter(c => c.status === 'weak_signal').length

    const notes = generateDiagnosticNotes(
      trimmed,
      failedCandidates.length,
      evaluationErrors,
      hasAnchors,
      hasProfile,
      sources.length,
    )

    const response: ScanResponse = {
      meta: {
        scannedAt: new Date().toISOString(),
        sourcesScanned: sources.length,
        clustersEvaluated: allClusters.length,
        confirmedCandidates: confirmed,
        pendingCandidates: pending,
        weakSignalCandidates: weak,
        failedUniversal: failedCandidates.length,
        evaluationErrors,
        durationMs: Date.now() - startTime,
      },
      candidates: trimmed,
      failedCandidates: includeFailed ? failedCandidates : [],
      diagnosticNotes: notes,
    }

    return res.status(200).json(response)
  } catch (err) {
    console.error('[skill-scan] Fatal error:', err)
    return res.status(500).json({
      error: 'Scan failed',
      detail: err instanceof Error ? err.message : 'Unknown error',
    })
  }
}
