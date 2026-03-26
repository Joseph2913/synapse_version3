# PRD-18 — Anchor Scoring Engine: Serverless Functions

**Phase:** 5 — Intelligence Layer  
**Dependencies:** PRD-17 (anchor_candidates schema + types + service layer)  
**Estimated Complexity:** High  
**Estimated Effort:** 2–3 sessions  

---

## 1. Objective

This PRD builds the backend intelligence that makes auto-anchors work. Two Vercel serverless functions compute anchor candidate scores from structural signals in the knowledge graph, write results to `anchor_candidates`, and run the lifecycle transitions that keep the anchor layer healthy over time.

After this PRD, the system operates entirely without user input: every extraction triggers a targeted scoring pass on newly created nodes, a nightly cron scores the full graph and handles lifecycle transitions, and `anchor_candidates` is continuously populated with scored, ranked candidates ready for the Anchors page (PRD-19) to surface.

The scoring logic — five signals combined into a composite score — is the same algorithm in both functions. Because of the Vercel serverless constraint (no shared local imports), it is inlined in full in each file. This is deliberate and documented.

---

## 2. What Gets Built

### Files created
- `api/anchors/score-post-extraction.ts` — targeted scorer, called after each extraction
- `api/anchors/score-daily.ts` — full graph scorer + lifecycle engine, daily cron

### Files modified
- `api/youtube/extract-knowledge.ts` — fire-and-forget call to `score-post-extraction` after marking item completed
- `api/meetings/process.ts` — same, after `updateStatus('completed')`
- `src/hooks/useExtraction.ts` — call `score-post-extraction` via fetch after `saveExtractionSession`
- `vercel.json` — add daily cron entry for `score-daily`

### Files NOT modified
- Anything in `src/types/` or `src/services/` — PRD-17 already provides all types and service functions the UI will use. The serverless functions are self-contained and do not import from `src/`.

---

## 3. The Scoring Algorithm

Both functions implement the same five-signal algorithm. Documented here once; inlined in full in both files.

### Signal 1 — Centrality Score

Measures structural importance in the graph. A node that bridges many other nodes (high betweenness proxy) and has many edges (high degree) is likely a load-bearing concept worth anchoring.

**Inputs:** total edge count (outgoing + incoming), count of unique neighbour nodes, count of unique entity types among neighbours.

**Computation:**
```
degree_score     = min(total_edges / 50, 1.0)
diversity_factor = min(unique_neighbour_types / 8, 1.0)
centrality_score = (degree_score × 0.6) + (diversity_factor × 0.4)
```

The divisors (50 edges, 8 types) are soft normalisation targets calibrated to a mature knowledge base. A node with 25 edges and neighbours of 4 different types scores approximately 0.55 — a reasonable mid-range candidate.

---

### Signal 2 — Diversity Score

A concept that appears across many different source documents and source types has stronger evidence of genuine importance than one mentioned many times in a single document.

**Inputs:** count of unique source documents the node appears in (via `source_id` on the node row and co-occurrence of the same source in edges), count of unique source types (Meeting, YouTube, Document, etc.).

**Computation:**
```
source_count_score  = min(unique_sources / 8, 1.0)
type_count_score    = min(unique_source_types / 3, 1.0)
diversity_score     = (source_count_score × 0.65) + (type_count_score × 0.35)
```

A node appearing in 4 sources of 2 different types scores approximately 0.55.

---

### Signal 3 — Velocity Score

Two sub-signals: sustained presence over time, and recent acceleration.

**Inputs:** days between the first and most recent appearance (days_active), ratio of appearances in the last 14 days vs. the prior 14 days (recent_velocity), velocity_direction derived from the ratio.

**Computation:**
```
sustained_score   = min(days_active / 30, 1.0)   // saturates at 30 days

recent_ratio      = mentions_last_14d / max(mentions_prior_14d, 1)
acceleration      = min(recent_ratio / 3.0, 1.0)  // ratio of 3× = full score

velocity_direction:
  'rising'  if recent_ratio > 1.3
  'falling' if recent_ratio < 0.7
  'stable'  otherwise

velocity_score = (sustained_score × 0.45) + (acceleration × 0.55)
```

A concept active for 20 days with a 2× acceleration scores approximately 0.73 — strong velocity signal.

---

### Signal 4 — Richness Score

A node participating in many *types* of relationships (not just many relationships) is doing more conceptual work. A node that only ever appears in `relates_to` edges is shallow. One that appears in `leads_to`, `blocks`, `contradicts`, and `enables` is load-bearing.

**Inputs:** count of unique `relation_type` values on the node's edges.

**Computation:**
```
richness_score = min(unique_relation_types / 6, 1.0)
```

A node with 4 distinct relationship types scores 0.67.

---

### Signal 5 — Behavioural Score

Reserved for Phase 2. Always written as `0` in this PRD. The column exists in the schema and the composite formula includes it with a 0.05 weight — when Phase 2 populates it, the composite score will update naturally without any schema or algorithm change.

---

### Composite Score

```
weights = SIGNAL_WEIGHTS_BY_PROFILE[user_scoring_profile]
// From PRD-17: balanced = { centrality: 0.35, diversity: 0.25, velocity: 0.20, richness: 0.15, behavioural: 0.05 }

composite_score =
  (centrality_score  × weights.centrality)
  + (diversity_score × weights.diversity)
  + (velocity_score  × weights.velocity)
  + (richness_score  × weights.richness)
  + (0               × weights.behavioural)  // Phase 2

// Apply existing-anchor overlap penalty
// If >70% of the candidate's neighbours are already connected to a confirmed anchor,
// reduce composite_score by 25% to avoid redundant anchors.
overlap_ratio = anchor_neighbour_count / max(total_neighbour_count, 1)
if overlap_ratio > 0.70:
  composite_score = composite_score × 0.75
```

---

### Reasoning Text Generator

Produces human-readable text stored in `anchor_candidates.reasoning_text`. Template-based — no Gemini call needed.

```
function buildReasoningText(signals: SignalInputs): string {
  const parts: string[] = []

  if (signals.sourceCount >= 5)
    parts.push(`Appeared across ${signals.sourceCount} sources`)
  else if (signals.sourceCount >= 2)
    parts.push(`Referenced in ${signals.sourceCount} different sources`)
  else
    parts.push(`Referenced in ${signals.sourceCount} source`)

  if (signals.uniqueSourceTypes >= 2)
    parts.push(`spanning ${signals.uniqueSourceTypes} content types`)

  if (signals.daysActive >= 14)
    parts.push(`over ${signals.daysActive} days`)

  if (signals.velocityDirection === 'rising')
    parts.push('with activity increasing recently')
  else if (signals.velocityDirection === 'falling')
    parts.push('though activity has slowed recently')

  if (signals.uniqueRelationTypes >= 4)
    parts.push(`participates in ${signals.uniqueRelationTypes} relationship types`)

  if (signals.anchorNeighbourCount >= 2)
    parts.push(`connects to ${signals.anchorNeighbourCount} of your existing anchors`)

  return parts.join(', ') + '.'
}
```

---

## 4. User Config Resolution

Both scoring functions must respect the user's `AnchorUserConfig` when computing scores and determining whether to surface a candidate. The config lives in `user_profiles.processing_preferences.anchor_settings` (JSONB). If the field is absent, defaults from PRD-17 apply.

```typescript
// Inline in both serverless functions:
const DEFAULT_CONFIG = {
  suggestionThreshold:         0.60,
  dormantAfterDays:            60,
  resurfaceCooldownDays:       30,
  autoDismissAfterDays:        14,
  scoringProfile:              'balanced',
  autoArchiveDormantAfterDays: null,
}

function resolveUserConfig(processingPreferences: Record<string, unknown> | null) {
  const stored = (processingPreferences?.anchor_settings ?? {}) as Record<string, unknown>
  return { ...DEFAULT_CONFIG, ...stored }
}
```

---

## 5. `api/anchors/score-post-extraction.ts` — Full Specification

**Purpose:** Scores nodes created by a single extraction. Called immediately after extraction completes. Fast (< 10 seconds) — processes only the new nodes from that extraction, plus any existing nodes whose edge count changed.

**Trigger:** POST request from three callers:
- `api/youtube/extract-knowledge.ts` (fire-and-forget after `updateStatus('completed')`)
- `api/meetings/process.ts` (fire-and-forget after `updateStatus('completed')`)
- `src/hooks/useExtraction.ts` (fire-and-forget after `saveExtractionSession`)

**Auth:** Requires either a valid user Bearer token (`Authorization: Bearer <supabase_jwt>`) or the `CRON_SECRET` header. Uses `SUPABASE_SERVICE_ROLE_KEY` for all database operations (same pattern as other `api/` functions).

**Request body:**
```typescript
{
  userId:    string   // required
  sourceId:  string   // required — the knowledge_sources row just created
  nodeIds:   string[] // required — the knowledge_nodes rows just created
}
```

**Response:**
```typescript
{
  success:      boolean
  scored:       number   // candidates written/updated
  surfaced:     number   // candidates moved to 'suggested'
  duration_ms:  number
}
```

**maxDuration:** `30` (seconds)

---

### Full file content:

```typescript
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createClient } from '@supabase/supabase-js'

export const maxDuration = 30

// ─── ENVIRONMENT ──────────────────────────────────────────────────────────────
const SUPABASE_URL              = process.env.SUPABASE_URL!
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!
const CRON_SECRET               = process.env.CRON_SECRET

const getSupabase = () => createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

// ─── AUTH ──────────────────────────────────────────────────────────────────────
async function resolveUserId(req: VercelRequest): Promise<string | null> {
  const auth = req.headers['authorization']
  if (!auth) return null

  // Cron secret: for internal server-to-server calls
  if (CRON_SECRET && auth === `Bearer ${CRON_SECRET}`) {
    return (req.body as Record<string, unknown>)?.userId as string ?? null
  }

  // Supabase JWT: for calls from useExtraction hook
  const token = auth.replace('Bearer ', '')
  const sb = getSupabase()
  const { data: { user }, error } = await sb.auth.getUser(token)
  if (error || !user) return null
  return user.id
}

// ─── DEFAULTS ─────────────────────────────────────────────────────────────────
const DEFAULT_CONFIG = {
  suggestionThreshold:         0.60,
  dormantAfterDays:            60,
  resurfaceCooldownDays:       30,
  autoDismissAfterDays:        14,
  scoringProfile:              'balanced' as const,
  autoArchiveDormantAfterDays: null as number | null,
}

type ScoringProfile = 'balanced' | 'emerging_topics' | 'deep_concepts' | 'active_focus' | 'well_evidenced'

const SIGNAL_WEIGHTS: Record<ScoringProfile, {
  centrality: number; diversity: number; velocity: number; richness: number; behavioural: number
}> = {
  balanced:        { centrality: 0.35, diversity: 0.25, velocity: 0.20, richness: 0.15, behavioural: 0.05 },
  emerging_topics: { centrality: 0.15, diversity: 0.15, velocity: 0.55, richness: 0.10, behavioural: 0.05 },
  deep_concepts:   { centrality: 0.45, diversity: 0.15, velocity: 0.10, richness: 0.25, behavioural: 0.05 },
  active_focus:    { centrality: 0.20, diversity: 0.20, velocity: 0.45, richness: 0.10, behavioural: 0.05 },
  well_evidenced:  { centrality: 0.25, diversity: 0.50, velocity: 0.10, richness: 0.10, behavioural: 0.05 },
}

function resolveUserConfig(processingPreferences: Record<string, unknown> | null) {
  const stored = ((processingPreferences ?? {}).anchor_settings ?? {}) as Record<string, unknown>
  return { ...DEFAULT_CONFIG, ...stored }
}

// ─── SIGNAL COMPUTATION ────────────────────────────────────────────────────────

interface NodeSignals {
  nodeId:               string
  totalEdges:           number
  uniqueNeighbourTypes: number
  uniqueSources:        number
  uniqueSourceTypes:    number
  daysActive:           number
  mentionsLast14d:      number
  mentionsPrior14d:     number
  uniqueRelationTypes:  number
  anchorNeighbourCount: number
  totalNeighbourCount:  number
  velocityDirection:    'rising' | 'stable' | 'falling'
  recentVelocity:       number
}

interface ComputedScores {
  centralityScore:  number
  diversityScore:   number
  velocityScore:    number
  richnessScore:    number
  compositeScore:   number
  reasoningText:    string
}

function computeScores(signals: NodeSignals, profile: ScoringProfile): ComputedScores {
  // Signal 1: Centrality
  const degreeScore     = Math.min(signals.totalEdges / 50, 1.0)
  const diversityFactor = Math.min(signals.uniqueNeighbourTypes / 8, 1.0)
  const centralityScore = (degreeScore * 0.6) + (diversityFactor * 0.4)

  // Signal 2: Diversity
  const sourceCountScore = Math.min(signals.uniqueSources / 8, 1.0)
  const typeCountScore   = Math.min(signals.uniqueSourceTypes / 3, 1.0)
  const diversityScore   = (sourceCountScore * 0.65) + (typeCountScore * 0.35)

  // Signal 3: Velocity
  const sustainedScore = Math.min(signals.daysActive / 30, 1.0)
  const recentRatio    = signals.mentionsLast14d / Math.max(signals.mentionsPrior14d, 1)
  const acceleration   = Math.min(recentRatio / 3.0, 1.0)
  const velocityScore  = (sustainedScore * 0.45) + (acceleration * 0.55)

  // Signal 4: Richness
  const richnessScore = Math.min(signals.uniqueRelationTypes / 6, 1.0)

  // Composite
  const w = SIGNAL_WEIGHTS[profile]
  let composite = (
    (centralityScore  * w.centrality)  +
    (diversityScore   * w.diversity)   +
    (velocityScore    * w.velocity)    +
    (richnessScore    * w.richness)
    // behavioural always 0 in Phase 1
  )

  // Overlap penalty: if >70% of neighbours are already anchors, reduce score
  const overlapRatio = signals.anchorNeighbourCount / Math.max(signals.totalNeighbourCount, 1)
  if (overlapRatio > 0.70) {
    composite = composite * 0.75
  }

  composite = Math.min(Math.max(composite, 0), 1.0)

  // Reasoning text
  const parts: string[] = []
  if (signals.uniqueSources >= 5)
    parts.push(`Appeared across ${signals.uniqueSources} sources`)
  else if (signals.uniqueSources >= 2)
    parts.push(`Referenced in ${signals.uniqueSources} different sources`)
  else
    parts.push(`Referenced in ${signals.uniqueSources} source`)

  if (signals.uniqueSourceTypes >= 2)
    parts.push(`spanning ${signals.uniqueSourceTypes} content types`)
  if (signals.daysActive >= 14)
    parts.push(`over ${signals.daysActive} days`)
  if (signals.velocityDirection === 'rising')
    parts.push('with activity increasing recently')
  else if (signals.velocityDirection === 'falling')
    parts.push('though activity has slowed recently')
  if (signals.uniqueRelationTypes >= 4)
    parts.push(`participates in ${signals.uniqueRelationTypes} relationship types`)
  if (signals.anchorNeighbourCount >= 2)
    parts.push(`connects to ${signals.anchorNeighbourCount} of your existing anchors`)

  const reasoningText = parts.join(', ') + '.'

  return { centralityScore, diversityScore, velocityScore, richnessScore, compositeScore: composite, reasoningText }
}

// ─── FETCH NODE SIGNALS ────────────────────────────────────────────────────────
// Queries required to compute all five signals for a batch of node IDs.
// All queries scoped to userId for RLS-equivalent safety (service role bypasses RLS
// but we always scope to userId defensively).

async function fetchNodeSignals(
  supabase: ReturnType<typeof getSupabase>,
  userId: string,
  nodeIds: string[]
): Promise<Map<string, NodeSignals>> {
  const result = new Map<string, NodeSignals>()
  if (nodeIds.length === 0) return result

  // Initialise with defaults
  for (const id of nodeIds) {
    result.set(id, {
      nodeId: id, totalEdges: 0, uniqueNeighbourTypes: 0,
      uniqueSources: 0, uniqueSourceTypes: 0, daysActive: 0,
      mentionsLast14d: 0, mentionsPrior14d: 0, uniqueRelationTypes: 0,
      anchorNeighbourCount: 0, totalNeighbourCount: 0,
      velocityDirection: 'stable', recentVelocity: 1,
    })
  }

  const now = Date.now()
  const fourteenDaysMs  = 14 * 86400000
  const cutoff14        = new Date(now - fourteenDaysMs).toISOString()
  const cutoff28        = new Date(now - 2 * fourteenDaysMs).toISOString()

  // 1. Outgoing edges
  const { data: outEdges } = await supabase
    .from('knowledge_edges')
    .select('source_node_id, target_node_id, relation_type, created_at')
    .in('source_node_id', nodeIds)
    .eq('user_id', userId)

  // 2. Incoming edges
  const { data: inEdges } = await supabase
    .from('knowledge_edges')
    .select('source_node_id, target_node_id, relation_type, created_at')
    .in('target_node_id', nodeIds)
    .eq('user_id', userId)

  // 3. Node metadata (created_at, source_id, source_type) for all candidate nodes
  const { data: nodes } = await supabase
    .from('knowledge_nodes')
    .select('id, source_id, source_type, entity_type, is_anchor, created_at')
    .in('id', nodeIds)
    .eq('user_id', userId)

  // 4. All neighbour node IDs — to check entity_type diversity and anchor status
  const allEdges = [...(outEdges ?? []), ...(inEdges ?? [])]
  const neighbourIds = new Set<string>()
  for (const e of allEdges) {
    if (nodeIds.includes(e.source_node_id)) neighbourIds.add(e.target_node_id)
    if (nodeIds.includes(e.target_node_id)) neighbourIds.add(e.source_node_id)
  }

  const neighbourIdList = Array.from(neighbourIds)
  const { data: neighbourNodes } = neighbourIdList.length > 0
    ? await supabase
        .from('knowledge_nodes')
        .select('id, entity_type, is_anchor, source_id, source_type, created_at')
        .in('id', neighbourIdList)
        .eq('user_id', userId)
    : { data: [] }

  const neighbourMap = new Map((neighbourNodes ?? []).map(n => [n.id as string, n]))

  // 5. Build signals per node
  const nodeMap = new Map((nodes ?? []).map(n => [n.id as string, n]))

  for (const nodeId of nodeIds) {
    const signals = result.get(nodeId)!
    const nodeRow = nodeMap.get(nodeId)

    // Edges for this specific node
    const myOutEdges = (outEdges ?? []).filter(e => e.source_node_id === nodeId)
    const myInEdges  = (inEdges  ?? []).filter(e => e.target_node_id === nodeId)
    const myAllEdges = [...myOutEdges, ...myInEdges]

    signals.totalEdges = myAllEdges.length

    // Unique relation types
    const relTypes = new Set(myAllEdges.map(e => e.relation_type).filter(Boolean))
    signals.uniqueRelationTypes = relTypes.size

    // Neighbour entity type diversity + anchor count
    const neighbourTypeSet = new Set<string>()
    let anchorNeighbours = 0
    let totalNeighbours  = 0

    for (const e of myOutEdges) {
      const nb = neighbourMap.get(e.target_node_id)
      if (nb) {
        neighbourTypeSet.add(nb.entity_type as string)
        totalNeighbours++
        if (nb.is_anchor) anchorNeighbours++
      }
    }
    for (const e of myInEdges) {
      const nb = neighbourMap.get(e.source_node_id)
      if (nb) {
        neighbourTypeSet.add(nb.entity_type as string)
        totalNeighbours++
        if (nb.is_anchor) anchorNeighbours++
      }
    }

    signals.uniqueNeighbourTypes  = neighbourTypeSet.size
    signals.anchorNeighbourCount  = anchorNeighbours
    signals.totalNeighbourCount   = totalNeighbours

    // Source diversity: collect all source IDs from the node and its neighbours
    const sourceIdSet   = new Set<string>()
    const sourceTypeSet = new Set<string>()

    if (nodeRow?.source_id)   sourceIdSet.add(nodeRow.source_id as string)
    if (nodeRow?.source_type) sourceTypeSet.add(nodeRow.source_type as string)

    for (const e of myAllEdges) {
      const nbId = nodeIds.includes(e.source_node_id) ? e.target_node_id : e.source_node_id
      const nb = neighbourMap.get(nbId)
      if (nb?.source_id)   sourceIdSet.add(nb.source_id as string)
      if (nb?.source_type) sourceTypeSet.add(nb.source_type as string)
    }

    signals.uniqueSources     = sourceIdSet.size
    signals.uniqueSourceTypes = sourceTypeSet.size

    // Temporal signals
    if (nodeRow?.created_at) {
      const createdAt = new Date(nodeRow.created_at as string).getTime()
      signals.daysActive = Math.floor((now - createdAt) / 86400000)
    }

    // Velocity: count edge creations in last 14d vs prior 14d
    // (proxy for how active this concept is in recent content)
    let last14  = 0
    let prior14 = 0
    for (const e of myAllEdges) {
      const edgeTime = new Date(e.created_at as string).getTime()
      if (edgeTime > now - fourteenDaysMs) last14++
      else if (edgeTime > now - 2 * fourteenDaysMs) prior14++
    }
    signals.mentionsLast14d  = last14
    signals.mentionsPrior14d = prior14

    const ratio = last14 / Math.max(prior14, 1)
    signals.recentVelocity   = ratio
    signals.velocityDirection =
      ratio > 1.3 ? 'rising' : ratio < 0.7 ? 'falling' : 'stable'

    result.set(nodeId, signals)
  }

  return result
}

// ─── UPSERT CANDIDATE ─────────────────────────────────────────────────────────

async function upsertCandidate(
  supabase: ReturnType<typeof getSupabase>,
  userId: string,
  signals: NodeSignals,
  scores: ComputedScores,
  profile: ScoringProfile,
  threshold: number
): Promise<{ isNew: boolean; surfaced: boolean }> {
  const now = new Date().toISOString()

  // Check for existing row
  const { data: existing } = await supabase
    .from('anchor_candidates')
    .select('id, status, dismiss_count')
    .eq('user_id', userId)
    .eq('node_id', signals.nodeId)
    .maybeSingle()

  const protectedStatuses = ['confirmed', 'dismissed', 'archived', 'dormant']
  const shouldSurface = scores.compositeScore >= threshold

  if (existing) {
    const updatePayload: Record<string, unknown> = {
      composite_score:     scores.compositeScore,
      centrality_score:    scores.centralityScore,
      diversity_score:     scores.diversityScore,
      velocity_score:      scores.velocityScore,
      richness_score:      scores.richnessScore,
      behavioural_score:   0,
      mention_count:       signals.mentionsLast14d + signals.mentionsPrior14d,
      source_count:        signals.uniqueSources,
      unique_source_types: signals.uniqueSourceTypes,
      days_active:         signals.daysActive,
      recent_velocity:     signals.recentVelocity,
      velocity_direction:  signals.velocityDirection,
      scoring_profile:     profile,
      reasoning_text:      scores.reasoningText,
      last_scored_at:      now,
      threshold_at_scoring: threshold,
    }

    let surfaced = false
    // Advance pending → suggested only if not in a protected status
    if (existing.status === 'pending' && shouldSurface) {
      updatePayload.status       = 'suggested'
      updatePayload.suggested_at = now
      surfaced = true
    }

    await supabase
      .from('anchor_candidates')
      .update(updatePayload)
      .eq('id', existing.id as string)

    return { isNew: false, surfaced }
  }

  // Insert new
  const insertStatus = shouldSurface ? 'suggested' : 'pending'
  await supabase
    .from('anchor_candidates')
    .insert({
      user_id:             userId,
      node_id:             signals.nodeId,
      composite_score:     scores.compositeScore,
      centrality_score:    scores.centralityScore,
      diversity_score:     scores.diversityScore,
      velocity_score:      scores.velocityScore,
      richness_score:      scores.richnessScore,
      behavioural_score:   0,
      mention_count:       signals.mentionsLast14d + signals.mentionsPrior14d,
      source_count:        signals.uniqueSources,
      unique_source_types: signals.uniqueSourceTypes,
      days_active:         signals.daysActive,
      recent_velocity:     signals.recentVelocity,
      velocity_direction:  signals.velocityDirection,
      status:              insertStatus,
      scoring_profile:     profile,
      reasoning_text:      scores.reasoningText,
      threshold_at_scoring: threshold,
      suggested_at:        insertStatus === 'suggested' ? now : null,
      first_scored_at:     now,
      last_scored_at:      now,
    })

  return { isNew: true, surfaced: insertStatus === 'suggested' }
}

// ─── HANDLER ───────────────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')

  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const startTime = Date.now()
  const userId = await resolveUserId(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })

  const body = req.body as { userId?: string; sourceId?: string; nodeIds?: string[] }
  const { nodeIds, sourceId } = body

  if (!nodeIds || nodeIds.length === 0) {
    return res.status(400).json({ error: 'nodeIds is required and must be non-empty' })
  }

  const sb = getSupabase()

  try {
    // 1. Fetch user config
    const { data: profile } = await sb
      .from('user_profiles')
      .select('processing_preferences')
      .eq('user_id', userId)
      .maybeSingle()

    const config = resolveUserConfig(
      (profile?.processing_preferences ?? null) as Record<string, unknown> | null
    )

    // 2. Filter out existing anchors — no point scoring is_anchor = true nodes
    const { data: nodeRows } = await sb
      .from('knowledge_nodes')
      .select('id, is_anchor')
      .in('id', nodeIds)
      .eq('user_id', userId)

    const candidateIds = (nodeRows ?? [])
      .filter(n => !n.is_anchor)
      .map(n => n.id as string)

    if (candidateIds.length === 0) {
      return res.status(200).json({
        success: true, scored: 0, surfaced: 0,
        duration_ms: Date.now() - startTime,
        message: 'All nodes are already anchors — nothing to score',
      })
    }

    // 3. Compute signals for all candidate nodes
    const signalsMap = await fetchNodeSignals(sb, userId, candidateIds)

    // 4. Score and upsert each candidate
    let scored   = 0
    let surfaced = 0

    for (const [nodeId, signals] of signalsMap) {
      const scores = computeScores(signals, config.scoringProfile as ScoringProfile)
      const result = await upsertCandidate(
        sb, userId, signals, scores,
        config.scoringProfile as ScoringProfile,
        config.suggestionThreshold
      )
      scored++
      if (result.surfaced) surfaced++
    }

    console.log(
      `[score-post-extraction] userId=${userId} sourceId=${sourceId} ` +
      `scored=${scored} surfaced=${surfaced} duration=${Date.now() - startTime}ms`
    )

    return res.status(200).json({
      success: true,
      scored,
      surfaced,
      duration_ms: Date.now() - startTime,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[score-post-extraction] Error:', msg)
    return res.status(500).json({ success: false, error: msg, duration_ms: Date.now() - startTime })
  }
}
```

---

## 6. `api/anchors/score-daily.ts` — Full Specification

**Purpose:** Full graph scorer and lifecycle engine. Runs nightly. Scores all non-anchor nodes, surfaces new candidates, and runs all lifecycle transitions (auto-dismiss stale suggestions, mark dormant anchors, re-surface eligible dismissed candidates, heal is_anchor inconsistencies).

**Trigger:** Vercel cron at `0 3 * * *` (3am UTC daily). Also callable via POST with `CRON_SECRET` for manual runs.

**maxDuration:** `300` (Vercel Pro limit for cron functions)

**Batch processing:** Processes nodes in batches of 100 to stay within memory limits and avoid Supabase query timeouts.

---

### Full file content:

```typescript
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createClient } from '@supabase/supabase-js'

export const maxDuration = 300

// ─── ENVIRONMENT ──────────────────────────────────────────────────────────────
const SUPABASE_URL              = process.env.SUPABASE_URL!
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!
const CRON_SECRET               = process.env.CRON_SECRET

const getSupabase = () => createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

// ─── AUTH ──────────────────────────────────────────────────────────────────────
function verifyCronAuth(req: VercelRequest): boolean {
  if (req.headers['x-vercel-signature']) return true
  if (!CRON_SECRET) return true
  const auth = req.headers['authorization']
  return !!(auth && auth === `Bearer ${CRON_SECRET}`)
}

// ─── DEFAULTS (identical copy to score-post-extraction — required by serverless constraint) ──
const DEFAULT_CONFIG = {
  suggestionThreshold:         0.60,
  dormantAfterDays:            60,
  resurfaceCooldownDays:       30,
  autoDismissAfterDays:        14,
  scoringProfile:              'balanced' as ScoringProfile,
  autoArchiveDormantAfterDays: null as number | null,
}

type ScoringProfile = 'balanced' | 'emerging_topics' | 'deep_concepts' | 'active_focus' | 'well_evidenced'

const SIGNAL_WEIGHTS: Record<ScoringProfile, {
  centrality: number; diversity: number; velocity: number; richness: number; behavioural: number
}> = {
  balanced:        { centrality: 0.35, diversity: 0.25, velocity: 0.20, richness: 0.15, behavioural: 0.05 },
  emerging_topics: { centrality: 0.15, diversity: 0.15, velocity: 0.55, richness: 0.10, behavioural: 0.05 },
  deep_concepts:   { centrality: 0.45, diversity: 0.15, velocity: 0.10, richness: 0.25, behavioural: 0.05 },
  active_focus:    { centrality: 0.20, diversity: 0.20, velocity: 0.45, richness: 0.10, behavioural: 0.05 },
  well_evidenced:  { centrality: 0.25, diversity: 0.50, velocity: 0.10, richness: 0.10, behavioural: 0.05 },
}

function resolveUserConfig(processingPreferences: Record<string, unknown> | null) {
  const stored = ((processingPreferences ?? {}).anchor_settings ?? {}) as Record<string, unknown>
  return { ...DEFAULT_CONFIG, ...stored }
}

// ─── SIGNAL COMPUTATION (identical copy — required by serverless constraint) ──

interface NodeSignals {
  nodeId: string; totalEdges: number; uniqueNeighbourTypes: number
  uniqueSources: number; uniqueSourceTypes: number; daysActive: number
  mentionsLast14d: number; mentionsPrior14d: number; uniqueRelationTypes: number
  anchorNeighbourCount: number; totalNeighbourCount: number
  velocityDirection: 'rising' | 'stable' | 'falling'; recentVelocity: number
}

interface ComputedScores {
  centralityScore: number; diversityScore: number; velocityScore: number
  richnessScore: number; compositeScore: number; reasoningText: string
}

function computeScores(signals: NodeSignals, profile: ScoringProfile): ComputedScores {
  const degreeScore     = Math.min(signals.totalEdges / 50, 1.0)
  const diversityFactor = Math.min(signals.uniqueNeighbourTypes / 8, 1.0)
  const centralityScore = (degreeScore * 0.6) + (diversityFactor * 0.4)

  const sourceCountScore = Math.min(signals.uniqueSources / 8, 1.0)
  const typeCountScore   = Math.min(signals.uniqueSourceTypes / 3, 1.0)
  const diversityScore   = (sourceCountScore * 0.65) + (typeCountScore * 0.35)

  const sustainedScore = Math.min(signals.daysActive / 30, 1.0)
  const recentRatio    = signals.mentionsLast14d / Math.max(signals.mentionsPrior14d, 1)
  const acceleration   = Math.min(recentRatio / 3.0, 1.0)
  const velocityScore  = (sustainedScore * 0.45) + (acceleration * 0.55)

  const richnessScore = Math.min(signals.uniqueRelationTypes / 6, 1.0)

  const w = SIGNAL_WEIGHTS[profile]
  let composite = (centralityScore * w.centrality) + (diversityScore * w.diversity) +
    (velocityScore * w.velocity) + (richnessScore * w.richness)

  const overlapRatio = signals.anchorNeighbourCount / Math.max(signals.totalNeighbourCount, 1)
  if (overlapRatio > 0.70) composite *= 0.75

  composite = Math.min(Math.max(composite, 0), 1.0)

  const parts: string[] = []
  if (signals.uniqueSources >= 5)       parts.push(`Appeared across ${signals.uniqueSources} sources`)
  else if (signals.uniqueSources >= 2)  parts.push(`Referenced in ${signals.uniqueSources} different sources`)
  else                                  parts.push(`Referenced in ${signals.uniqueSources} source`)
  if (signals.uniqueSourceTypes >= 2)   parts.push(`spanning ${signals.uniqueSourceTypes} content types`)
  if (signals.daysActive >= 14)         parts.push(`over ${signals.daysActive} days`)
  if (signals.velocityDirection === 'rising')  parts.push('with activity increasing recently')
  else if (signals.velocityDirection === 'falling') parts.push('though activity has slowed recently')
  if (signals.uniqueRelationTypes >= 4) parts.push(`participates in ${signals.uniqueRelationTypes} relationship types`)
  if (signals.anchorNeighbourCount >= 2) parts.push(`connects to ${signals.anchorNeighbourCount} of your existing anchors`)

  return {
    centralityScore, diversityScore, velocityScore, richnessScore,
    compositeScore: composite, reasoningText: parts.join(', ') + '.',
  }
}

// ─── BATCH SIGNAL FETCH (same logic as score-post-extraction, accepts any nodeIds) ──

async function fetchNodeSignalsBatch(
  supabase: ReturnType<typeof getSupabase>,
  userId: string,
  nodeIds: string[]
): Promise<Map<string, NodeSignals>> {
  const result = new Map<string, NodeSignals>()
  if (nodeIds.length === 0) return result

  for (const id of nodeIds) {
    result.set(id, {
      nodeId: id, totalEdges: 0, uniqueNeighbourTypes: 0,
      uniqueSources: 0, uniqueSourceTypes: 0, daysActive: 0,
      mentionsLast14d: 0, mentionsPrior14d: 0, uniqueRelationTypes: 0,
      anchorNeighbourCount: 0, totalNeighbourCount: 0,
      velocityDirection: 'stable', recentVelocity: 1,
    })
  }

  const now = Date.now()
  const fourteenDaysMs = 14 * 86400000

  const [outEdgesRes, inEdgesRes, nodesRes] = await Promise.all([
    supabase.from('knowledge_edges').select('source_node_id, target_node_id, relation_type, created_at')
      .in('source_node_id', nodeIds).eq('user_id', userId),
    supabase.from('knowledge_edges').select('source_node_id, target_node_id, relation_type, created_at')
      .in('target_node_id', nodeIds).eq('user_id', userId),
    supabase.from('knowledge_nodes').select('id, source_id, source_type, entity_type, is_anchor, created_at')
      .in('id', nodeIds).eq('user_id', userId),
  ])

  const outEdges = outEdgesRes.data ?? []
  const inEdges  = inEdgesRes.data ?? []
  const nodes    = nodesRes.data ?? []

  const neighbourIds = new Set<string>()
  for (const e of [...outEdges, ...inEdges]) {
    if (nodeIds.includes(e.source_node_id)) neighbourIds.add(e.target_node_id)
    if (nodeIds.includes(e.target_node_id)) neighbourIds.add(e.source_node_id)
  }

  const nbList = Array.from(neighbourIds)
  const { data: nbNodes } = nbList.length > 0
    ? await supabase.from('knowledge_nodes').select('id, entity_type, is_anchor, source_id, source_type, created_at')
        .in('id', nbList).eq('user_id', userId)
    : { data: [] }

  const neighbourMap = new Map((nbNodes ?? []).map(n => [n.id as string, n]))
  const nodeMap      = new Map(nodes.map(n => [n.id as string, n]))

  for (const nodeId of nodeIds) {
    const signals   = result.get(nodeId)!
    const nodeRow   = nodeMap.get(nodeId)
    const myOut     = outEdges.filter(e => e.source_node_id === nodeId)
    const myIn      = inEdges.filter(e => e.target_node_id === nodeId)
    const myAll     = [...myOut, ...myIn]

    signals.totalEdges = myAll.length
    const relTypes = new Set(myAll.map(e => e.relation_type).filter(Boolean))
    signals.uniqueRelationTypes = relTypes.size

    const nbTypeSet = new Set<string>()
    let anchorNb = 0, totalNb = 0
    for (const e of myOut) {
      const nb = neighbourMap.get(e.target_node_id)
      if (nb) { nbTypeSet.add(nb.entity_type as string); totalNb++; if (nb.is_anchor) anchorNb++ }
    }
    for (const e of myIn) {
      const nb = neighbourMap.get(e.source_node_id)
      if (nb) { nbTypeSet.add(nb.entity_type as string); totalNb++; if (nb.is_anchor) anchorNb++ }
    }
    signals.uniqueNeighbourTypes = nbTypeSet.size
    signals.anchorNeighbourCount = anchorNb
    signals.totalNeighbourCount  = totalNb

    const srcIdSet = new Set<string>()
    const srcTypeSet = new Set<string>()
    if (nodeRow?.source_id)   srcIdSet.add(nodeRow.source_id as string)
    if (nodeRow?.source_type) srcTypeSet.add(nodeRow.source_type as string)
    for (const e of myAll) {
      const nbId = nodeIds.includes(e.source_node_id) ? e.target_node_id : e.source_node_id
      const nb = neighbourMap.get(nbId)
      if (nb?.source_id)   srcIdSet.add(nb.source_id as string)
      if (nb?.source_type) srcTypeSet.add(nb.source_type as string)
    }
    signals.uniqueSources     = srcIdSet.size
    signals.uniqueSourceTypes = srcTypeSet.size

    if (nodeRow?.created_at) {
      signals.daysActive = Math.floor((now - new Date(nodeRow.created_at as string).getTime()) / 86400000)
    }
    let last14 = 0, prior14 = 0
    for (const e of myAll) {
      const t = new Date(e.created_at as string).getTime()
      if (t > now - fourteenDaysMs) last14++
      else if (t > now - 2 * fourteenDaysMs) prior14++
    }
    signals.mentionsLast14d  = last14
    signals.mentionsPrior14d = prior14
    const ratio = last14 / Math.max(prior14, 1)
    signals.recentVelocity   = ratio
    signals.velocityDirection = ratio > 1.3 ? 'rising' : ratio < 0.7 ? 'falling' : 'stable'
  }

  return result
}

// ─── LIFECYCLE TRANSITIONS ─────────────────────────────────────────────────────

async function runLifecycleTransitions(
  supabase: ReturnType<typeof getSupabase>,
  userId: string,
  config: ReturnType<typeof resolveUserConfig>
): Promise<{ autoDismissed: number; markedDormant: number; resurfaced: number; healed: number }> {
  const now = new Date()
  let autoDismissed = 0, markedDormant = 0, resurfaced = 0, healed = 0

  // 1. Auto-dismiss: 'suggested' candidates past autoDismissAfterDays with no user action
  const autoDismissCutoff = new Date(now.getTime() - config.autoDismissAfterDays * 86400000).toISOString()
  const { data: stale } = await supabase
    .from('anchor_candidates')
    .select('id, dismiss_count')
    .eq('user_id', userId)
    .eq('status', 'suggested')
    .lt('suggested_at', autoDismissCutoff)

  for (const row of stale ?? []) {
    const resurface = new Date(now.getTime() + config.resurfaceCooldownDays * 86400000).toISOString()
    await supabase.from('anchor_candidates').update({
      status:          'dismissed',
      reviewed_at:     now.toISOString(),
      resurface_after: resurface,
      dismiss_count:   (row.dismiss_count as number ?? 0) + 1,
    }).eq('id', row.id as string)
    autoDismissed++
  }

  // 2. Mark dormant: 'confirmed' anchors with no new edges in dormantAfterDays
  const dormantCutoff = new Date(now.getTime() - config.dormantAfterDays * 86400000).toISOString()
  const { data: confirmedCandidates } = await supabase
    .from('anchor_candidates')
    .select('id, node_id')
    .eq('user_id', userId)
    .eq('status', 'confirmed')

  for (const row of confirmedCandidates ?? []) {
    if (!row.node_id) continue
    // Check most recent edge on this node
    const { data: recentEdge } = await supabase
      .from('knowledge_edges')
      .select('created_at')
      .or(`source_node_id.eq.${row.node_id},target_node_id.eq.${row.node_id}`)
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    const lastActivity = recentEdge?.created_at as string | undefined
    if (!lastActivity || lastActivity < dormantCutoff) {
      await supabase.from('anchor_candidates').update({
        status:       'dormant',
        dormant_since: now.toISOString(),
      }).eq('id', row.id as string)
      markedDormant++
    }
  }

  // 3. Re-activate dormant anchors that have received new content
  const { data: dormantCandidates } = await supabase
    .from('anchor_candidates')
    .select('id, node_id, dormant_since')
    .eq('user_id', userId)
    .eq('status', 'dormant')

  for (const row of dormantCandidates ?? []) {
    if (!row.node_id || !row.dormant_since) continue
    const { data: recentEdge } = await supabase
      .from('knowledge_edges')
      .select('created_at')
      .or(`source_node_id.eq.${row.node_id},target_node_id.eq.${row.node_id}`)
      .eq('user_id', userId)
      .gt('created_at', row.dormant_since as string)
      .limit(1)
      .maybeSingle()

    if (recentEdge) {
      await supabase.from('anchor_candidates').update({
        status:       'confirmed',
        dormant_since: null,
      }).eq('id', row.id as string)
      // Note: no need to re-set is_anchor on knowledge_nodes — it was never unset
    }
  }

  // 4. Re-surface dismissed candidates past resurface_after
  const { data: readyToResurface } = await supabase
    .from('anchor_candidates')
    .select('id, composite_score')
    .eq('user_id', userId)
    .eq('status', 'dismissed')
    .lt('resurface_after', now.toISOString())

  for (const row of readyToResurface ?? []) {
    // Only re-surface if score is still above threshold
    if ((row.composite_score as number) >= config.suggestionThreshold) {
      await supabase.from('anchor_candidates').update({
        status:          'suggested',
        suggested_at:    now.toISOString(),
        resurface_after: null,
      }).eq('id', row.id as string)
      resurfaced++
    } else {
      // Score dropped below threshold — move back to pending for re-scoring
      await supabase.from('anchor_candidates').update({
        status: 'pending',
      }).eq('id', row.id as string)
    }
  }

  // 5. Heal: any is_anchor=true node with no corresponding confirmed candidate row
  // This catches manual anchors set before PRD-17 or partial failures in confirmAnchorCandidate
  const { data: anchorNodes } = await supabase
    .from('knowledge_nodes')
    .select('id, label')
    .eq('user_id', userId)
    .eq('is_anchor', true)

  for (const node of anchorNodes ?? []) {
    const { data: existingCandidate } = await supabase
      .from('anchor_candidates')
      .select('id, status')
      .eq('user_id', userId)
      .eq('node_id', node.id as string)
      .in('status', ['confirmed', 'dormant'])
      .maybeSingle()

    if (!existingCandidate) {
      // Create a confirmed candidate row for this orphaned anchor
      const nowStr = now.toISOString()
      await supabase.from('anchor_candidates').upsert({
        user_id: userId, node_id: node.id as string,
        composite_score: 1.0, centrality_score: 0, diversity_score: 0,
        velocity_score: 0, richness_score: 0, behavioural_score: 0,
        mention_count: 0, source_count: 0, unique_source_types: 0,
        days_active: 0, recent_velocity: 0, velocity_direction: 'stable',
        status: 'confirmed', scoring_profile: 'balanced',
        reasoning_text: 'Existing anchor — automatically registered by healing pass.',
        suggested_at: nowStr, reviewed_at: nowStr,
        first_scored_at: nowStr, last_scored_at: nowStr,
      }, { onConflict: 'user_id,node_id', ignoreDuplicates: true })
      healed++
    }
  }

  // 6. Auto-archive dormant anchors (if user has enabled this opt-in feature)
  if (config.autoArchiveDormantAfterDays !== null) {
    const archiveCutoff = new Date(
      now.getTime() - config.autoArchiveDormantAfterDays * 86400000
    ).toISOString()

    const { data: archiveCandidates } = await supabase
      .from('anchor_candidates')
      .select('id, node_id')
      .eq('user_id', userId)
      .eq('status', 'dormant')
      .lt('dormant_since', archiveCutoff)

    for (const row of archiveCandidates ?? []) {
      await supabase.from('anchor_candidates').update({ status: 'archived' }).eq('id', row.id as string)
      if (row.node_id) {
        await supabase.from('knowledge_nodes').update({ is_anchor: false }).eq('id', row.node_id as string)
      }
    }
  }

  return { autoDismissed, markedDormant, resurfaced, healed }
}

// ─── HANDLER ───────────────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')

  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  if (!verifyCronAuth(req)) return res.status(401).json({ error: 'Unauthorized' })

  const startTime = Date.now()
  const sb = getSupabase()
  const BATCH_SIZE = 100

  const results: Record<string, {
    scored: number; surfaced: number; lifecycle: ReturnType<typeof runLifecycleTransitions> extends Promise<infer T> ? T : never
  }> = {}

  try {
    // Fetch all distinct user IDs with knowledge_nodes
    const { data: userRows } = await sb
      .from('knowledge_nodes')
      .select('user_id')
      .neq('user_id', null)

    if (!userRows || userRows.length === 0) {
      return res.status(200).json({ success: true, users: 0, duration_ms: Date.now() - startTime })
    }

    const userIds = [...new Set((userRows as { user_id: string }[]).map(r => r.user_id))]

    for (const userId of userIds) {
      // 1. Load user config
      const { data: profileRow } = await sb
        .from('user_profiles')
        .select('processing_preferences')
        .eq('user_id', userId)
        .maybeSingle()

      const config = resolveUserConfig(
        (profileRow?.processing_preferences ?? null) as Record<string, unknown> | null
      )

      // 2. Lifecycle transitions first
      const lifecycle = await runLifecycleTransitions(sb, userId, config)

      // 3. Fetch all non-anchor nodes for this user (batched)
      let offset = 0
      let scored = 0, surfaced = 0

      while (true) {
        const { data: batch } = await sb
          .from('knowledge_nodes')
          .select('id')
          .eq('user_id', userId)
          .eq('is_anchor', false)
          .order('created_at', { ascending: false })
          .range(offset, offset + BATCH_SIZE - 1)

        if (!batch || batch.length === 0) break

        const batchIds = (batch as { id: string }[]).map(n => n.id)
        const signalsMap = await fetchNodeSignalsBatch(sb, userId, batchIds)

        for (const [nodeId, signals] of signalsMap) {
          const scores = computeScores(signals, config.scoringProfile)

          // Check existing status
          const { data: existing } = await sb
            .from('anchor_candidates')
            .select('id, status, dismiss_count')
            .eq('user_id', userId)
            .eq('node_id', nodeId)
            .maybeSingle()

          const protectedStatuses = ['confirmed', 'dismissed', 'archived', 'dormant']
          const shouldSurface = scores.compositeScore >= config.suggestionThreshold
          const now = new Date().toISOString()

          if (existing) {
            const updatePayload: Record<string, unknown> = {
              composite_score: scores.compositeScore,
              centrality_score: scores.centralityScore,
              diversity_score: scores.diversityScore,
              velocity_score: scores.velocityScore,
              richness_score: scores.richnessScore,
              mention_count: signals.mentionsLast14d + signals.mentionsPrior14d,
              source_count: signals.uniqueSources,
              unique_source_types: signals.uniqueSourceTypes,
              days_active: signals.daysActive,
              recent_velocity: signals.recentVelocity,
              velocity_direction: signals.velocityDirection,
              scoring_profile: config.scoringProfile,
              reasoning_text: scores.reasoningText,
              last_scored_at: now,
            }
            if (!protectedStatuses.includes(existing.status as string) && shouldSurface && existing.status === 'pending') {
              updatePayload.status = 'suggested'
              updatePayload.suggested_at = now
              surfaced++
            }
            await sb.from('anchor_candidates').update(updatePayload).eq('id', existing.id as string)
          } else {
            const insertStatus = shouldSurface ? 'suggested' : 'pending'
            await sb.from('anchor_candidates').insert({
              user_id: userId, node_id: nodeId,
              composite_score: scores.compositeScore, centrality_score: scores.centralityScore,
              diversity_score: scores.diversityScore, velocity_score: scores.velocityScore,
              richness_score: scores.richnessScore, behavioural_score: 0,
              mention_count: signals.mentionsLast14d + signals.mentionsPrior14d,
              source_count: signals.uniqueSources, unique_source_types: signals.uniqueSourceTypes,
              days_active: signals.daysActive, recent_velocity: signals.recentVelocity,
              velocity_direction: signals.velocityDirection, status: insertStatus,
              scoring_profile: config.scoringProfile, reasoning_text: scores.reasoningText,
              threshold_at_scoring: config.suggestionThreshold,
              suggested_at: insertStatus === 'suggested' ? now : null,
              first_scored_at: now, last_scored_at: now,
            })
            if (insertStatus === 'suggested') surfaced++
          }
          scored++
        }

        offset += BATCH_SIZE
        if (batch.length < BATCH_SIZE) break
      }

      results[userId] = { scored, surfaced, lifecycle }
      console.log(`[score-daily] userId=${userId} scored=${scored} surfaced=${surfaced}`)
    }

    const totalScored   = Object.values(results).reduce((s, r) => s + r.scored,   0)
    const totalSurfaced = Object.values(results).reduce((s, r) => s + r.surfaced, 0)

    return res.status(200).json({
      success:      true,
      users:        userIds.length,
      totalScored,
      totalSurfaced,
      duration_ms:  Date.now() - startTime,
      results,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[score-daily] Fatal error:', msg)
    return res.status(500).json({ success: false, error: msg, duration_ms: Date.now() - startTime })
  }
}
```

---

## 7. Modifications to Existing Files

### 7.1 `api/youtube/extract-knowledge.ts`

**Location:** After `await supabase.from('youtube_ingestion_queue').update({ status: 'completed' ...})` at line ~555, before `return { success: true, nodesCreated, edgesCreated }`.

Add the following block — fire-and-forget, never awaited, never allowed to surface errors to the caller:

```typescript
// ── TRIGGER ANCHOR SCORING (fire-and-forget) ────────────────────────────────
// Non-fatal: if scoring fails, extraction is still considered successful.
if (savedNodeIds.length > 0) {
  const appUrl = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : 'http://localhost:3000'

  fetch(`${appUrl}/api/anchors/score-post-extraction`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${CRON_SECRET ?? ''}`,
    },
    body: JSON.stringify({
      userId:   item.user_id,
      sourceId: sourceId,
      nodeIds:  savedNodeIds,
    }),
  }).catch(err => {
    console.warn('[extract-knowledge] Anchor scoring trigger failed (non-fatal):', err)
  })
}
```

**Note:** `savedNodeIds` must be collected during Step 4 (Save Nodes). Verify that the existing code already accumulates saved node IDs into an array — if it uses `savedNodeMap` as the accumulator, derive `savedNodeIds` from `Array.from(savedNodeMap.values())` at this point.

---

### 7.2 `api/meetings/process.ts`

**Location:** After `await updateStatus('completed')` (~line 555), before `return { success: true, nodesCreated, edgesCreated }`.

Same fire-and-forget block as above, using `meeting.user_id`, `sourceId`, and the accumulated `savedNodeIds` array. The meetings pipeline already tracks created node IDs — verify the variable name in that function and use it directly.

```typescript
// ── TRIGGER ANCHOR SCORING (fire-and-forget) ────────────────────────────────
if (savedNodeIds.length > 0) {
  const appUrl = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : 'http://localhost:3000'

  fetch(`${appUrl}/api/anchors/score-post-extraction`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${CRON_SECRET ?? ''}`,
    },
    body: JSON.stringify({
      userId:   meeting.user_id,
      sourceId: sourceId,
      nodeIds:  savedNodeIds,
    }),
  }).catch(err => {
    console.warn('[meetings/process] Anchor scoring trigger failed (non-fatal):', err)
  })
}
```

---

### 7.3 `src/hooks/useExtraction.ts`

**Location:** In the `approveAndSave` callback, immediately after `await saveExtractionSession(...)` and before `update({ step: 'complete' ... })`.

Add a fire-and-forget fetch using the Supabase session token for auth:

```typescript
// Trigger anchor scoring — fire-and-forget, never blocks the UI
if (savedNodes.length > 0 && state.sourceId) {
  const { data: { session: currentSession } } = await supabase.auth.getSession()
  if (currentSession?.access_token) {
    fetch('/api/anchors/score-post-extraction', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${currentSession.access_token}`,
      },
      body: JSON.stringify({
        userId:   user.id,
        sourceId: state.sourceId,
        nodeIds:  savedNodes.map(n => n.id),
      }),
    }).catch(err => {
      console.warn('[useExtraction] Anchor scoring trigger failed (non-fatal):', err)
    })
  }
}
```

Import `supabase` from `'../services/supabase'` if not already imported in this hook. The `state.sourceId` is already tracked in `PipelineState` — confirm it is set correctly by the time `approveAndSave` runs (it is set during the `saving_nodes` step).

---

### 7.4 `vercel.json`

Add one cron entry:

```json
{
  "path": "/api/anchors/score-daily",
  "schedule": "0 3 * * *"
}
```

Final `vercel.json` crons array:

```json
"crons": [
  { "path": "/api/youtube/poll-playlist",              "schedule": "*/5 * * * *" },
  { "path": "/api/youtube/fetch-transcripts",          "schedule": "*/2 * * * *" },
  { "path": "/api/youtube/extract-knowledge",          "schedule": "1-59/2 * * * *" },
  { "path": "/api/summaries/backfill?batch_size=10",   "schedule": "*/5 * * * *" },
  { "path": "/api/meetings/process",                   "schedule": "*/2 * * * *" },
  { "path": "/api/anchors/score-daily",                "schedule": "0 3 * * *" }
]
```

---

## 8. Environment Variables

No new environment variables required. Both functions use:

- `SUPABASE_URL` — already set
- `SUPABASE_SERVICE_ROLE_KEY` — already set
- `CRON_SECRET` — already set
- `VERCEL_URL` — automatically set by Vercel at runtime; used to construct the self-call URL in `extract-knowledge.ts` and `meetings/process.ts`

---

## 9. Forward-Compatible Decisions

- **`behaviouralScore` is always written as `0`** and the weight column is already in the schema. Phase 2 (click tracking, Ask query frequency) requires zero schema or algorithm changes — just start populating the column and the composite score adjusts automatically.

- **The scoring algorithm is parameterised by `ScoringProfile`** — all weight maps are in one place per file. Adjusting weights in a future iteration requires changing exactly one constant object.

- **Scoring is fire-and-forget from all callers** — it never blocks extraction, never surfaces errors to users, and its failure never causes an extraction to be marked failed. This is intentional: scoring is enrichment, not a core pipeline step.

- **`score-daily` runs per-user loops** — the handler fetches all distinct user IDs from `knowledge_nodes` and scores each independently. This means multi-tenant correctness is preserved and individual user failures don't abort other users' scoring.

- **The `VERCEL_URL` env var** is used for the self-call URL in the fire-and-forget trigger. In local development this falls back to `localhost:3000`. If `score-post-extraction` cannot be reached (e.g. during local dev without the function running), the `.catch()` silently absorbs the error — local development is unaffected.

---

## 10. Edge Cases and Error Handling

- **Node with zero edges:** Scores 0 on centrality and richness. Will not surface unless velocity or diversity is very high. This is correct behaviour — isolated nodes shouldn't be anchors.

- **Extraction creates only 1 node:** `score-post-extraction` runs with a single-item `nodeIds` array. All queries handle single-item arrays correctly. No special case needed.

- **User has no `processing_preferences` or no `anchor_settings`:** `resolveUserConfig` merges with `DEFAULT_CONFIG` — all missing fields use defaults. Never throws.

- **Race between `score-post-extraction` and `score-daily`:** Both use the same upsert logic that checks existing status before writing. A `confirmed` or `dismissed` row is never overwritten by either function. At worst, scores are computed twice for the same node on the same day — both writes are idempotent.

- **`VERCEL_URL` not set in production:** Vercel sets this automatically for all deployments. If somehow absent, the URL falls back to `localhost:3000` and the fetch fails silently (`.catch()` absorbs it). The `score-daily` cron runs independently and will score those nodes on the next nightly pass.

- **Score-daily exceeds `maxDuration = 300`:** If a user has an extremely large graph (10,000+ nodes), the batched loop may approach the limit. Mitigation: the 100-node batch size keeps individual Supabase queries fast. If timeout occurs, Vercel returns a 504 — the function logs what it completed, and the next nightly run continues from where it left off (idempotent upserts mean no data corruption).

- **`score-daily` upsert conflict on `user_id, node_id`:** The schema intentionally does not have a unique constraint on `(user_id, node_id)` (see PRD-17 edge cases). The daily scorer checks for existing rows via `maybeSingle()` before inserting, providing the same de-duplication guarantee without a DB constraint.

---

## 11. Acceptance Criteria

- [ ] `api/anchors/score-post-extraction.ts` exists and compiles with `tsconfig.serverless.json` — zero TypeScript errors
- [ ] `api/anchors/score-daily.ts` exists and compiles with zero TypeScript errors
- [ ] Both files contain zero local imports — all helpers are defined inline
- [ ] Running an extraction (via Capture UI) causes a new row to appear in `anchor_candidates` within 30 seconds
- [ ] The new row has `composite_score > 0`, `reasoning_text` is a readable sentence, and all five score columns are populated
- [ ] Nodes where `is_anchor = true` are excluded from scoring — no confirmed anchor node produces a new candidate row
- [ ] A node with `composite_score >= 0.60` (default threshold) gets `status = 'suggested'` on first score
- [ ] A node with `composite_score < 0.60` gets `status = 'pending'`
- [ ] Calling `score-post-extraction` twice for the same `nodeIds` produces one row per node (no duplicates), with the second call updating `last_scored_at`
- [ ] `score-daily` cron entry appears in `vercel.json` at `0 3 * * *`
- [ ] Manually POSTing to `/api/anchors/score-daily` with `CRON_SECRET` auth returns `{ success: true }` and processes all users
- [ ] Lifecycle: a `suggested` candidate older than `autoDismissAfterDays` (14 days by default) is moved to `dismissed` by the daily scorer with `resurface_after` set correctly
- [ ] Lifecycle: a `confirmed` anchor with no new edges in 60+ days is moved to `dormant`
- [ ] Lifecycle: any `is_anchor = true` node with no corresponding confirmed candidate row gets a healed row created by the daily scorer
- [ ] No extraction failure is introduced — if `score-post-extraction` returns a 500, the extraction is still marked `complete` in the UI
- [ ] `vercel.json` is valid JSON and all existing cron paths remain unchanged
