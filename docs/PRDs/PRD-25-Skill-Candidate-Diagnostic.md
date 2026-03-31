# PRD-25 — Skill Candidate Diagnostic Tool

**Phase:** Diagnostic / Validation (pre-Phase 6)
**Dependencies:** PRD-7 (extraction pipeline), PRD-8 (Graph RAG), PRD-24 (MCP server)
**Complexity:** Medium
**Database changes:** None — read-only against existing schema
**UI impact:** None to existing views — standalone route only

---

## Objective

Build a standalone, read-only diagnostic tool that scans the existing Synapse Supabase database and surfaces a ranked list of skill candidate topics using a two-layer detection framework (universal content evaluation + personalised user relevance scoring). The purpose is to validate whether the detection logic is accurate and well-calibrated against real data before committing to building a full persistent skill pipeline.

Nothing is written to the database. No skill documents are generated. The tool answers two questions:

1. Does the detection logic surface sensible, genuinely useful skill candidates from the existing knowledge base?
2. Is the existing database structure sufficient to support a full skill pipeline, or does it need schema additions?

---

## What Gets Built

### New Files

| File | Purpose |
|---|---|
| `api/skills/scan.ts` | Vercel serverless function — orchestrates the full scan, returns structured JSON |
| `src/views/SkillScanView.tsx` | Standalone React view rendered at `/skill-scan` |

### Modified Files

| File | Change |
|---|---|
| `src/app/Router.tsx` | Add `/skill-scan` route pointing to `SkillScanView` — one line addition only |

**No other existing files are modified.** The route is accessible only to authenticated users (same auth guard pattern as all other routes). It does not appear in the nav rail.

---

## Detection Framework

The scan runs two sequential evaluation layers per skill candidate. Both layers must produce a passing result for a candidate to appear in the output. Candidates that fail Layer 1 are dropped entirely. Candidates that pass Layer 1 but score below threshold on Layer 2 appear in a separate low-signal section for diagnostic visibility.

---

### Layer 1 — Universal Content Evaluation

Determines whether a source contains a teachable, applicable concept with a discernible method. Runs identically for every user. Uses a single Gemini API call per source cluster.

**Skill definition enforced by the evaluation prompt:**

> A skill is a concept or technique that is specific enough to be applied, general enough to be reused across contexts, and has a discernible method — meaning there is a describable way of doing it, not just knowing about it.

**Five criteria evaluated per candidate cluster:**

| Criterion | Description | Evaluation method |
|---|---|---|
| **C1 — Instructional Intent** | The source is explicitly trying to teach, explain, or demonstrate something. Signals: tutorial structure, step-by-step language, how-to framing, worked examples. A news article discussing trends fails. A walkthrough of how to build something passes. | Gemini reads source chunks and returns pass/fail + one-line rationale |
| **C2 — Specificity Threshold** | The concept is specific enough to be actionable. Test: could someone follow this to produce a concrete output? "Understanding machine learning" fails. "Fine-tuning a language model using LoRA" passes. | Gemini evaluation of procedural specificity |
| **C3 — Reusability Signal** | The technique applies in more than one context. The source frames it as transferable — "you can use this pattern whenever..." A technique specific to one product or one company only fails. | Gemini evaluation of transferability framing |
| **C4 — Method Presence** | There is a describable sequence of steps, decisions, or principles — not just a description of an outcome. The source contains enough procedural content to support a "how to apply this" description. | Gemini evaluation of procedural content density |
| **C5 — Minimum Depth** | The source spends enough substantive content on the concept. Threshold: at least 3 `source_chunks` rows contain content directly relevant to the candidate concept. | Rule-based chunk count — no Gemini call needed |

**Scoring:** Each criterion is pass (1) or fail (0). Maximum score: 5.
- Score 4–5: Strong candidate → proceeds to Layer 2
- Score 3: Marginal candidate → proceeds to Layer 2 with a `marginal` flag
- Score 0–2: Dropped → logged in diagnostic output as `failed_universal` with the failing criteria named

---

### Layer 2 — Personalised Relevance Scoring

Determines whether this skill candidate is relevant to this specific user, at what exposure level, and how confidently. Computed from six signals derived from the user's existing graph state. No Gemini generation calls — Signal 1 uses embedding similarity, Signals 2–6 are computed from database queries.

**Six signals:**

| Signal | Weight | Data source | Computation |
|---|---|---|---|
| **S1 — Anchor Alignment** | 0.25 | `knowledge_nodes` where `is_anchor = true` | Cosine similarity between candidate concept embedding and each anchor node embedding using `text-embedding-004`. Score = highest similarity across all anchors. |
| **S2 — Node Density** | 0.20 | `knowledge_nodes` | Count of existing nodes related to the candidate concept (label ILIKE match + entity type relevance). Normalised 0–1 against max node count per source in the user's graph. |
| **S3 — Source History Pattern** | 0.20 | `knowledge_sources` + `knowledge_nodes` | Count of distinct sources that contain nodes semantically related to this candidate. More than one prior source = higher signal that this is a genuine interest area. |
| **S4 — Graph Proximity** | 0.15 | `knowledge_edges` + `knowledge_nodes` | How many hops from the candidate concept's primary node to the user's most-connected anchor nodes. 1 hop = 1.0, 2 hops = 0.6, 3 hops = 0.3, unreachable = 0.0. |
| **S5 — Profile Context** | 0.10 | `user_profiles` | Domain relevance multiplier derived from `professional_context.role` and `personal_interests.topics`. Technical skill candidates score higher for users with technical roles. Consulting/strategic skills score higher for strategy/consulting roles. Applied as a multiplier (0.5–1.5) on the combined signal score. |
| **S6 — Velocity** | 0.10 | `knowledge_sources.created_at` | Count of related sources ingested in the last 14 days. 0 sources = 0.0, 1 source = 0.5, 2+ sources = 1.0. Indicates active current learning. |

**Relevance formula:**

```
relevance_score = (S1 × 0.25) + (S2 × 0.20) + (S3 × 0.20) + 
                  (S4 × 0.15) + (S5 × 0.10) + (S6 × 0.10)
```

All weights are defined as named constants at the top of `api/skills/scan.ts` for easy tuning:

```typescript
const SIGNAL_WEIGHTS = {
  anchorAlignment:   0.25,
  nodeDensity:       0.20,
  sourceHistory:     0.20,
  graphProximity:    0.15,
  profileContext:    0.10,
  velocity:          0.10,
} as const;
```

**Relevance thresholds:**

| Score | Status | Appears in UI |
|---|---|---|
| ≥ 0.55 | `confirmed_candidate` | Main list, full detail |
| 0.35–0.54 | `pending_reinforcement` | Main list, flagged section |
| < 0.35 | `weak_signal` | Diagnostic section only, collapsed by default |

**Exposure level derivation:**

| Condition | Level |
|---|---|
| Single YouTube source, low node density (S2 < 0.3), no anchor alignment | `novice` |
| Multiple YouTube sources OR moderate node density (S2 0.3–0.6) | `developing` |
| Meeting transcript where user describes application OR high node density (S2 > 0.6) | `proficient` |
| High node density + anchor alignment + cross-source reinforcement (S1 > 0.7 AND S3 > 0.6) | `advanced` |

---

## `api/skills/scan.ts`

Self-contained Vercel serverless function. Zero local imports. All logic inline. Uses anon Supabase key with RLS — only the authenticated user's data is accessible.

### Request

```
POST /api/skills/scan
Authorization: Bearer <supabase_jwt>
Content-Type: application/json
```

```typescript
// Request body — all fields optional
{
  source_types?: string[]      // Filter to specific types. Default: ['YouTube', 'Meeting', 'Document', 'Research']
  min_criteria_pass?: number   // Minimum universal criteria passed. Default: 3
  min_relevance?: number       // Minimum relevance score to include. Default: 0.20 (include weak signals for diagnostics)
  limit?: number               // Max candidates returned. Default: 60
  include_failed?: boolean     // Include failed universal candidates in response. Default: true (diagnostic mode)
}
```

### Processing Sequence

**Phase 1 — Data assembly (parallel Supabase queries)**

```typescript
// 1. All sources
SELECT id, title, source_type, created_at, metadata
FROM knowledge_sources
WHERE user_id = $1
ORDER BY created_at DESC

// 2. All nodes with source associations
SELECT id, label, entity_type, confidence, source_id, is_anchor, description, embedding
FROM knowledge_nodes
WHERE user_id = $1

// 3. All edges (for graph proximity computation)
SELECT source_node_id, target_node_id, relation_type, weight
FROM knowledge_edges
WHERE user_id = $1

// 4. Chunk counts per source (for C5 minimum depth)
SELECT source_id, COUNT(*) as chunk_count
FROM source_chunks
WHERE user_id = $1
GROUP BY source_id

// 5. Anchor nodes only (for S1 anchor alignment)
SELECT id, label, entity_type, description, embedding
FROM knowledge_nodes
WHERE user_id = $1 AND is_anchor = true

// 6. User profile
SELECT professional_context, personal_interests, processing_preferences
FROM user_profiles
WHERE user_id = $1
LIMIT 1
```

**Phase 2 — Concept cluster formation**

Group nodes by source. Within each source, identify concept clusters: groups of 2+ nodes that share direct edge connections or belong to the same entity type family (Topic, Technology, Concept, Insight cluster together; Person, Organization cluster together but are excluded from skill candidates — skills are about capabilities, not people).

Entity types eligible for skill clustering: `Topic`, `Technology`, `Concept`, `Insight`, `Idea`, `Hypothesis`, `Lesson`, `Takeaway`, `Methodology` (mapped from existing ontology types).

Entity types excluded from skill clustering: `Person`, `Organization`, `Team`, `Location`, `Event`, `Metric`, `Document`, `Action`, `Blocker`, `Risk`, `Question`, `Goal`, `Decision`, `Anchor`.

Each cluster is represented by its most prominent node (highest confidence score) as the candidate label. A single source may yield 1–5 clusters. Cap at 5 clusters per source to prevent noise from large comprehensive extractions.

**Phase 3 — C5 pre-filter (rule-based, no API call)**

Before any Gemini calls, apply the minimum depth criterion:

```typescript
const chunkCount = chunkCountsBySourceId[cluster.sourceId] ?? 0;
if (chunkCount < 3) {
  candidate.failedCriteria.push('C5_minimum_depth');
  // Still proceed to Gemini evaluation — chunk count is one signal, not disqualifying alone
  // But flag it so the UI can show it
}
```

**Phase 4 — Universal layer evaluation (Gemini call per source)**

Rather than one Gemini call per cluster (expensive), batch all clusters from the same source into a single call. Pass the top 6 chunks from that source as context.

**Prompt structure:**

```
System:
You are evaluating content from a personal knowledge graph tool to determine whether it contains teachable, applicable skills.

A skill is defined as: a concept or technique that is specific enough to be applied, 
general enough to be reused across contexts, and has a discernible method — meaning 
there is a describable way of doing it, not just knowing about it.

For each candidate concept cluster provided, evaluate it against the following five criteria:

C1 — Instructional Intent: Is this source explicitly teaching, explaining, or demonstrating 
something? Does it have tutorial structure, step-by-step language, or worked examples?

C2 — Specificity Threshold: Is the concept specific enough to be actionable? Could someone 
follow this to produce a concrete output?

C3 — Reusability Signal: Does this technique apply across more than one context? 
Is it framed as transferable?

C4 — Method Presence: Is there a describable sequence of steps, decisions, or principles? 
Does the content contain enough procedural detail to explain how to apply this?

C5 — Minimum Depth: Does the source spend substantial time on this concept, 
or is it a passing mention?

Respond ONLY with a JSON array. No preamble, no markdown, no explanation outside the JSON.

User:
Source title: {source.title}
Source type: {source.source_type}

Source content (top chunks):
{chunks.map(c => c.content).join('\n\n---\n\n')}

Candidate clusters to evaluate:
{clusters.map((c, i) => `${i+1}. "${c.label}" (entity types: ${c.entityTypes.join(', ')})`).join('\n')}

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
]
```

**Gemini call parameters:**
- Model: `process.env.GEMINI_MODEL ?? 'gemini-2.0-flash'`
- Temperature: `0.1` (low — this is evaluation, not generation)
- Max output tokens: `2048`
- Response: parse as JSON array, strip any markdown fences before parsing

**Error handling for Gemini call:**
- If the call fails or returns unparseable JSON: mark all clusters from that source as `evaluation_failed`, include them in the diagnostic output with the error noted, continue processing remaining sources. Do not abort the entire scan.

**Phase 5 — Personalised layer scoring**

For each candidate that passed Layer 1 (criteriaPassedCount ≥ min_criteria_pass):

**S1 — Anchor Alignment:**
Generate an embedding for the candidate's `suggestedSkillLabel` using Gemini `text-embedding-004`. Compute cosine similarity against each anchor node's stored `embedding`. Take the maximum similarity score as S1. If no anchors exist, S1 = 0.

```typescript
// Cosine similarity helper (inline)
function cosineSimilarity(a: number[], b: number[]): number {
  const dot = a.reduce((sum, val, i) => sum + val * b[i], 0);
  const magA = Math.sqrt(a.reduce((sum, val) => sum + val * val, 0));
  const magB = Math.sqrt(b.reduce((sum, val) => sum + val * val, 0));
  return magA && magB ? dot / (magA * magB) : 0;
}
```

**S2 — Node Density:**
Count nodes in the user's graph where:
- `label ILIKE '%{keyword}%'` where keyword is the primary term from suggestedSkillLabel
- OR `entity_type IN ('Topic', 'Technology', 'Concept')` AND the node's source_id matches a source that also contains the candidate cluster

Normalise by dividing by the maximum node count per source in the user's graph (to prevent large sources from dominating).

**S3 — Source History Pattern:**
Count distinct `source_id` values among nodes related to this candidate (same keyword matching as S2). Score: `min(relatedSourceCount / 3, 1.0)` — 3 or more related sources = maximum score.

**S4 — Graph Proximity:**
BFS from the candidate's primary node through `knowledge_edges`. Find the shortest path to any anchor node. Map to score: 1 hop = 1.0, 2 hops = 0.6, 3 hops = 0.3, 4+ hops or unreachable = 0.0. Cap BFS at depth 4 to prevent performance issues on large graphs.

**S5 — Profile Context:**
Parse `user_profiles.professional_context.role` (if present). Apply domain multiplier:

```typescript
const DOMAIN_ROLE_MAP: Record<string, string[]> = {
  technical:   ['engineer', 'developer', 'architect', 'cto', 'technical'],
  consulting:  ['consultant', 'advisor', 'partner', 'director', 'strategy'],
  strategic:   ['founder', 'ceo', 'vp', 'head of', 'lead'],
};

// If candidate domain matches user role domain: multiplier = 1.3
// If neutral match: multiplier = 1.0  
// If mismatch (e.g. technical skill for non-technical user): multiplier = 0.7
```

S5 score = base score of 0.5 × multiplier, capped at 1.0.

**S6 — Velocity:**
Count sources related to this candidate with `created_at >= NOW() - INTERVAL '14 days'`. Score: 0 sources = 0.0, 1 source = 0.5, 2+ sources = 1.0.

**Combine into final relevance score** using the SIGNAL_WEIGHTS formula. Determine status and exposure level per the thresholds defined above.

**Phase 6 — Response assembly**

Sort all candidates by `relevance_score` descending. Return structured JSON.

### Response Shape

```typescript
interface ScanResponse {
  meta: {
    scannedAt: string;               // ISO timestamp
    sourcesScanned: number;
    clustersEvaluated: number;
    confirmedCandidates: number;
    pendingCandidates: number;
    weakSignalCandidates: number;
    failedUniversal: number;
    evaluationErrors: number;
    durationMs: number;
  };
  candidates: SkillCandidate[];
  failedCandidates: FailedCandidate[];  // Only if include_failed = true
  diagnosticNotes: string[];            // Plain-language observations about the scan
}

interface SkillCandidate {
  id: string;                          // Deterministic: sha256(userId + sourceId + clusterLabel).slice(0,16)
  suggestedSkillLabel: string;         // From Gemini evaluation
  domain: 'technical' | 'consulting' | 'strategic' | 'interpersonal' | 'domain_specific';
  status: 'confirmed_candidate' | 'pending_reinforcement' | 'weak_signal';
  exposureLevel: 'novice' | 'developing' | 'proficient' | 'advanced';
  
  // Universal layer
  criteriaPassedCount: number;
  criteria: {
    C1: { pass: boolean; rationale: string };
    C2: { pass: boolean; rationale: string };
    C3: { pass: boolean; rationale: string };
    C4: { pass: boolean; rationale: string };
    C5: { pass: boolean; rationale: string };
  };

  // Personalised layer
  relevanceScore: number;              // 0–1, two decimal places
  signalBreakdown: {
    anchorAlignment:  { score: number; matchedAnchor: string | null };
    nodeDensity:      { score: number; relatedNodeCount: number };
    sourceHistory:    { score: number; relatedSourceCount: number };
    graphProximity:   { score: number; hopsToNearestAnchor: number | null };
    profileContext:   { score: number; multiplierApplied: number };
    velocity:         { score: number; recentSourceCount: number };
  };

  // Source attribution
  primarySource: {
    id: string;
    title: string;
    source_type: string;
    created_at: string;
  };
  contributingSources: Array<{
    id: string;
    title: string;
    source_type: string;
  }>;
  relatedAnchors: Array<{
    label: string;
    entity_type: string;
    similarityScore: number;
  }>;

  // Diagnostic aids
  whatWouldUpgradeIt: string;          // Rule-based string, e.g. "A meeting transcript discussing application would raise exposure to Proficient"
  primaryNodeLabel: string;            // The most prominent node from the cluster
  clusterNodeLabels: string[];         // All node labels in the cluster
}

interface FailedCandidate {
  clusterLabel: string;
  sourceTitle: string;
  source_type: string;
  failReason: 'insufficient_criteria' | 'evaluation_error' | 'excluded_entity_type';
  criteriaPassedCount?: number;
  failedCriteria?: string[];
}
```

---

## `src/views/SkillScanView.tsx`

Standalone React view. Uses only existing design system tokens and Lucide icons — no new dependencies.

### Layout

Full-page view (no nav rail, no right panel). Centred content column, max-width 900px. Light gray background (`--bg-content`).

```
┌─────────────────────────────────────────────┐
│  SYNAPSE SKILL DIAGNOSTIC                   │
│  Read-only · No data written                │
│                                             │
│  [Scan Configuration]  [Run Scan]           │
├─────────────────────────────────────────────┤
│  Scan Summary Bar (after scan)              │
├─────────────────────────────────────────────┤
│  Filter Pills                               │
├─────────────────────────────────────────────┤
│  Candidate Cards (sorted by relevance)      │
│  ...                                        │
│  ── Low Signal (collapsed by default) ──    │
│  Failed Universal (collapsed by default)    │
└─────────────────────────────────────────────┘
```

### Scan Configuration Panel

Shown before the scan is run. White card, 16px 22px padding.

Fields (all optional — defaults shown):

| Control | Type | Default |
|---|---|---|
| Source types to include | Multi-select checkboxes | All (YouTube, Meeting, Document, Research) |
| Minimum criteria pass | Number input (1–5) | 3 |
| Minimum relevance score | Slider (0.0–1.0, step 0.05) | 0.20 |
| Maximum candidates | Number input (10–100) | 60 |
| Show failed universal candidates | Toggle | On |

"Run Scan" button: primary accent-500, full-width, 40px height, Cabinet Grotesk 14px weight-700. Disabled while scan is in progress.

### Loading State

While the scan is running (typically 15–45 seconds depending on database size):

- Button shows spinner + "Scanning..." label
- A progress narrative updates every 3 seconds with plain-language status:
  - "Assembling your knowledge graph data..."
  - "Evaluating concept clusters across {n} sources..."
  - "Scoring personalised relevance..."
  - "Finalising results..."

### Scan Summary Bar

Rendered after scan completes. Horizontal row of stat pills:

`{n} sources scanned` · `{n} clusters evaluated` · `{n} confirmed candidates` · `{n} pending` · `{n} weak signal` · `{n} failed` · `Completed in {n}s`

Each stat in Cabinet Grotesk 13px weight-700, separated by `·` in `--text-secondary`. "Re-run Scan" link (ghost style, accent colour) at the far right.

### Filter Bar

Filter pills (20px radius, 11px DM Sans weight-600):
- All
- Technical
- Consulting
- Strategic
- Domain Specific
- Confirmed only
- Advanced / Proficient only

Active pill: `--accent-50` background, `--accent-500` border and text.

Search input: `--bg-inset` background, placeholder "Search skill candidates...", filters by `suggestedSkillLabel` and `primaryNodeLabel` in real-time (no API call — client-side filter on the response data).

### Skill Candidate Card

One card per candidate. White background, `--border-subtle` border, 12px radius, 16px 20px padding, 8px gap between cards.

**Card header row:**
- Left: `suggestedSkillLabel` in Cabinet Grotesk 14px weight-700 `--text-primary`
- Left sub: Domain badge (small pill, entity-type colour pattern) + Exposure level badge (same style)
- Right: Relevance score as a large number — Cabinet Grotesk 20px weight-800, colour mapped: ≥0.7 green, 0.5–0.69 amber, <0.5 `--text-secondary`
- Right sub: Status label in 11px DM Sans weight-600

**Collapsed default view shows:**
- Header row
- Source: `[source_type emoji] {primarySource.title}` — DM Sans 12px `--text-secondary`
- Criteria passed: `{n}/5 criteria passed` with 5 small dot indicators (filled = pass, empty = fail) in a row
- Related anchors (if any): up to 2 anchor badges using existing entity badge pattern
- Expand chevron (Lucide `ChevronDown`) right-aligned

**Expanded view reveals (on chevron click):**

Section: **WHY IT WAS CHOSEN**
Plain-language summary of which criteria passed and what evidence triggered the candidate. Derived from the criteria rationale strings — not generated, assembled programmatically from pass/fail rationale values.

Section: **UNIVERSAL CRITERIA BREAKDOWN**
Table of all 5 criteria. Each row: criterion name, pass/fail icon (Lucide `Check` in green / `X` in `--text-secondary`), rationale text in DM Sans 12px `--text-body`.

Section: **RELEVANCE SIGNAL BREAKDOWN**
Six signal rows. Each: signal name, score as a small progress bar (0–1, accent colour fill), score value, and a one-line explanation of what drove it.

Example row:
```
Anchor Alignment    [████████░░]  0.81    Closely matches your "RAG Architecture" anchor
Node Density        [████░░░░░░]  0.42    12 related nodes across 3 sources
```

Section: **CONTRIBUTING SOURCES**
List of all sources that contributed to this candidate. Each: source type emoji, title, ingestion date. DM Sans 12px.

Section: **RELATED ANCHORS**
Anchor entity badges with similarity percentage shown. "No anchor alignment" state if none.

Section: **WHAT WOULD UPGRADE THIS**
The `whatWouldUpgradeIt` string rendered as a highlighted note block. `--bg-inset` background, 8px padding, 8px radius, DM Sans 12px `--text-body`. Lucide `ArrowUp` icon prefix.

Section: **CLUSTER NODES**
All node labels from this cluster as small gray pills. Shows what the underlying entities are. Useful for diagnosing whether the cluster formation logic is grouping things sensibly.

### Failed Universal Section

Collapsed by default. Toggle to expand. Shows a compact table:

| Cluster Label | Source | Type | Criteria Passed | Failed Criteria |
|---|---|---|---|---|
| ... | ... | ... | 2/5 | C1, C4 |

Purpose: lets you see what was rejected and why — critical for calibrating whether the thresholds are too strict or too loose.

### Diagnostic Notes Section

At the bottom of the page. Renders the `diagnosticNotes` array from the scan response as a simple bulleted list. These are programmatically generated observations such as:

- "78% of confirmed candidates came from YouTube sources — Meeting sources are underrepresented and may contain additional skill signals"
- "Anchor alignment was the dominant scoring signal — users with more anchors will see better personalised scoring"
- "3 sources returned evaluation errors — check Vercel logs for Gemini API issues"
- "No user profile found — S5 Profile Context scored as neutral (0.5) for all candidates. Add a profile in Settings to improve personalisation"

---

## Interaction & State

All state is local to `SkillScanView` — no context, no persistence.

```typescript
type ScanState = 'idle' | 'loading' | 'complete' | 'error';

const [scanState, setScanState] = useState<ScanState>('idle');
const [config, setConfig] = useState<ScanConfig>(DEFAULT_CONFIG);
const [results, setResults] = useState<ScanResponse | null>(null);
const [expandedCardId, setExpandedCardId] = useState<string | null>(null);
const [activeFilter, setActiveFilter] = useState<string>('all');
const [searchQuery, setSearchQuery] = useState('');
const [showFailed, setShowFailed] = useState(false);
```

- Only one card is expanded at a time. Clicking an expanded card's chevron collapses it.
- Filter and search operate on the client-side results data — no re-scan triggered.
- Re-run scan resets results and re-calls the API with current config values.
- The scan can take 15–45 seconds. The loading state must not timeout prematurely — set a 90-second fetch timeout on the client.

---

## Forward-Compatible Decisions

- **`SIGNAL_WEIGHTS` as named constants** at the top of `api/skills/scan.ts` means recalibrating the scoring model is a single-line change per weight, not a search-and-replace.
- **`SkillCandidate.id` is deterministic** (derived from userId + sourceId + clusterLabel, not random) so that re-running the scan with different config produces the same IDs for the same candidates — enabling future comparison between scan runs.
- **The `ScanResponse` shape** is designed to be directly writable to a future `skill_candidates` table without transformation. When the full skill pipeline is built (PRD-26), it reads this same structure.
- **The scan endpoint accepts `source_types` as a filter** so future source types (web pages, notes) automatically become available by adding them to the filter options without touching the core logic.
- **The Gemini evaluation prompt** is defined as a named constant string at the top of `api/skills/scan.ts`, not inline. Future PRDs can modify the prompt without touching the processing logic.
- **The `whatWouldUpgradeIt` field** is computed from rule-based logic in this PRD. In PRD-26 it becomes the reinforcement trigger — the system watches for new sources that match these conditions and automatically re-evaluates the candidate.

---

## Edge Cases & Error Handling

| Scenario | Behaviour |
|---|---|
| User has no sources | Return empty results with diagnostic note: "No sources found. Ingest content in the Capture view first." |
| User has sources but no chunks | C5 pre-filter flags all candidates. Diagnostic note: "source_chunks table appears empty — run the backfill endpoint before scanning for best results." |
| User has no anchors | S1 scores 0 for all candidates. Diagnostic note surfaced. Scan still runs and returns results. |
| User has no profile | S5 applies neutral multiplier (1.0) for all candidates. Diagnostic note surfaced. |
| Gemini evaluation call fails for a source | That source's clusters marked as `evaluation_error`, included in failedCandidates. Scan continues with remaining sources. |
| Gemini returns malformed JSON | Strip markdown fences, attempt `JSON.parse`. If still fails, mark as `evaluation_error`. Log raw response to console for debugging. |
| Scan returns 0 confirmed candidates | Show empty state with diagnostic notes prominent. Suggest lowering `min_criteria_pass` to 2 and re-running. |
| Scan takes longer than 60 seconds | Vercel Pro allows 60s functions. If on free tier (10s limit), the scan will time out for large databases. Show a clear error: "Scan timed out — your database may be too large for the free Vercel tier. Upgrade to Vercel Pro or reduce the source limit in scan configuration." |
| Network error during scan | Show error state with "Retry" button. Do not clear previous results if a prior scan completed. |
| User not authenticated | 401 from API, redirect to login. Same pattern as all other protected routes. |

---

## Acceptance Criteria

- Navigating to `/skill-scan` renders the diagnostic tool without affecting any other view or route.
- The configuration panel renders with correct defaults and all controls are functional.
- Clicking "Run Scan" calls `POST /api/skills/scan` with the configured parameters and shows the loading state with progressive status messages.
- The scan completes and renders a summary bar with accurate counts.
- Skill candidate cards render in relevance score order, with correct domain badges, exposure levels, and criteria pass counts.
- Expanding a card reveals all six sections: why it was chosen, criteria breakdown, signal breakdown, contributing sources, related anchors, upgrade path, and cluster nodes.
- The signal breakdown shows individual scores with progress bars and explanations for all six signals.
- The filter pills correctly filter the candidate list client-side. The search input filters by label in real-time.
- The Failed Universal section is present, collapsed by default, and expands to show a table of failed candidates with their failing criteria named.
- The Diagnostic Notes section renders all notes returned by the scan.
- Re-running the scan with different configuration produces updated results.
- No data is written to the database at any point — verified by checking all Supabase tables before and after a scan run.
- The tool works correctly on a database with 0 sources, sparse data, and a full production database.
- TypeScript compiles with zero errors in strict mode.
- `api/skills/scan.ts` has zero local imports — fully self-contained per Vercel constraint.
