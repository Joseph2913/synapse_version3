# PRD-26 — Persistent Skill Pipeline

**Phase:** Phase 6 — Skills Layer
**Dependencies:** PRD-7 (ingestion pipeline), PRD-25 (diagnostic tool), PRD-25b (skill detection infrastructure)
**Complexity:** Very High
**Type:** Backend pipeline + database + MCP extension. No new views (UI is PRD-27).

---

## Objective

Build the persistent, auto-updating skill pipeline that turns the validated detection logic from PRD-25 into a live skill layer in the database. Every time a new source is ingested, it is evaluated for skill signals and either creates a new skill or reinforces an existing one. A weekly cron re-scores all confirmed skills against the latest graph state. The skill library is queryable by Claude Desktop and Claude Code via a new `get_skills` MCP tool. By the end of this PRD, skills exist as real database records that compound over time — not diagnostic output that disappears after each scan run.

---

## What Gets Built

### New Files

| File | Purpose |
|---|---|
| `supabase/migrations/20240003_knowledge_skills.sql` | Creates `knowledge_skills` and `skill_sources` tables |
| `api/skills/process-source.ts` | Serverless function — evaluates a single newly ingested source for skill signals, creates or reinforces skills |
| `api/skills/rescore.ts` | Serverless function — weekly full re-score of all confirmed skills against latest graph state |
| `api/skills/get.ts` | Serverless function — returns the user's skill library, used by the MCP tool and future UI |

### Modified Files

| File | Change |
|---|---|
| `api/mcp.ts` | Add `get_skills` as the 7th tool |
| `src/hooks/useExtraction.ts` | After candidacy gate (PRD-25b), trigger `api/skills/process-source` for `skill_candidate: true` sources |
| `vercel.json` | Add weekly cron schedule for `api/skills/rescore` |

---

## Database Migration

### `supabase/migrations/20240003_knowledge_skills.sql`

```sql
-- ─────────────────────────────────────────
-- knowledge_skills
-- One row per distinct skill in the user's library
-- ─────────────────────────────────────────
CREATE TABLE knowledge_skills (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Identity
  label                 TEXT NOT NULL,
  domain                TEXT NOT NULL CHECK (domain IN (
                          'technical','consulting','strategic',
                          'interpersonal','domain_specific'
                        )),
  description           TEXT,                    -- Plain-language description of what this skill is

  -- Exposure & confidence
  exposure_level        TEXT NOT NULL DEFAULT 'novice' CHECK (exposure_level IN (
                          'novice','developing','proficient','advanced'
                        )),
  confidence            FLOAT NOT NULL DEFAULT 0.0 CHECK (confidence BETWEEN 0 AND 1),
  evidence_count        INTEGER NOT NULL DEFAULT 1,  -- Number of contributing sources

  -- Lifecycle state machine (mirrors anchor lifecycle)
  status                TEXT NOT NULL DEFAULT 'candidate' CHECK (status IN (
                          'candidate',    -- Detected, not yet confirmed
                          'confirmed',    -- Meets confidence threshold
                          'dormant',      -- Was confirmed, no recent reinforcement
                          'archived'      -- Manually dismissed or long-dormant
                        )),

  -- Scoring snapshot (stored for diagnostics and re-score comparison)
  last_relevance_score  FLOAT,
  signal_breakdown      JSONB DEFAULT '{}',      -- S1–S6 scores from last scoring run

  -- Graph relationships
  related_anchor_ids    UUID[] DEFAULT '{}',     -- Anchors this skill aligns with
  related_skill_ids     UUID[] DEFAULT '{}',     -- Sibling skills (populated by re-score)

  -- MCP retrieval fields
  when_to_apply         TEXT,                    -- Trigger conditions for MCP routing
  how_to_apply          TEXT,                    -- Practical application summary

  -- Temporal
  first_detected_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_reinforced_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_scored_at        TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX knowledge_skills_user_id_idx      ON knowledge_skills(user_id);
CREATE INDEX knowledge_skills_status_idx       ON knowledge_skills(user_id, status);
CREATE INDEX knowledge_skills_domain_idx       ON knowledge_skills(user_id, domain);
CREATE INDEX knowledge_skills_confidence_idx   ON knowledge_skills(user_id, confidence DESC);
CREATE UNIQUE INDEX knowledge_skills_label_idx ON knowledge_skills(user_id, label);

-- RLS
ALTER TABLE knowledge_skills ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own skills"
  ON knowledge_skills FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Auto-update updated_at
CREATE TRIGGER knowledge_skills_updated_at
  BEFORE UPDATE ON knowledge_skills
  FOR EACH ROW EXECUTE FUNCTION moddatetime(updated_at);


-- ─────────────────────────────────────────
-- skill_sources
-- Junction table: which sources contributed to each skill
-- ─────────────────────────────────────────
CREATE TABLE skill_sources (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  skill_id        UUID NOT NULL REFERENCES knowledge_skills(id) ON DELETE CASCADE,
  source_id       UUID NOT NULL REFERENCES knowledge_sources(id) ON DELETE CASCADE,

  contribution    TEXT NOT NULL CHECK (contribution IN (
                    'created',      -- This source triggered the skill's initial creation
                    'reinforced',   -- This source added supporting evidence
                    'upgraded',     -- This source caused an exposure level upgrade
                    'corrected'     -- This source refined or corrected the skill description
                  )),
  confidence_delta  FLOAT DEFAULT 0.0,   -- How much this source moved the confidence score
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE(skill_id, source_id)            -- Each source contributes to a skill once
);

-- Indexes
CREATE INDEX skill_sources_skill_id_idx  ON skill_sources(skill_id);
CREATE INDEX skill_sources_source_id_idx ON skill_sources(source_id);
CREATE INDEX skill_sources_user_id_idx   ON skill_sources(user_id);

-- RLS
ALTER TABLE skill_sources ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own skill sources"
  ON skill_sources FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
```

---

## Skill Lifecycle State Machine

Skills move through states following the same pattern as anchors. Transitions are triggered by pipeline events, not user actions (user controls are PRD-27).

```
                  ┌─────────────┐
  New detection → │  candidate  │
                  └──────┬──────┘
          confidence ≥ 0.55 │
                            ▼
                  ┌─────────────┐
                  │  confirmed  │◄── reinforced by new source
                  └──────┬──────┘
    no new evidence      │
    for 60 days          ▼
                  ┌─────────────┐
                  │   dormant   │◄── re-score drops confidence below 0.40
                  └──────┬──────┘
    90 days dormant │         │ new evidence arrives → back to confirmed
                    ▼         └──────────────────────────────────────────►
                  ┌─────────────┐
                  │  archived   │
                  └─────────────┘
```

**Transition rules:**

| From | To | Trigger |
|---|---|---|
| `candidate` | `confirmed` | `confidence >= 0.55` after scoring |
| `confirmed` | `dormant` | No `skill_sources` rows with `created_at > NOW() - INTERVAL '60 days'` |
| `dormant` | `confirmed` | New source reinforces the skill |
| `dormant` | `archived` | Status has been `dormant` for 90+ days |
| `confirmed` | `candidate` | Re-score drops confidence below 0.40 (demoted for re-evaluation) |
| Any | `archived` | Manual user action (PRD-27) |

---

## Confidence Scoring Model

Confidence is a cumulative score that compounds as more sources contribute evidence. It is bounded 0–1.

**Initial confidence** — set when skill is first created, derived from the source type weight of the creating source:

| Source type | Initial confidence |
|---|---|
| YouTube tutorial / explainer | 0.30 |
| YouTube deep-dive (>30 min) | 0.45 |
| Meeting transcript (user describing implementation) | 0.65 |
| Document / guide | 0.55 |
| Research / article | 0.40 |

**Reinforcement delta** — each additional contributing source adds:

```typescript
const REINFORCEMENT_DELTAS: Record<string, number> = {
  YouTube:  0.10,
  Meeting:  0.20,   // Higher because practical application evidence
  Document: 0.15,
  Research: 0.10,
};

// Confidence compounds with diminishing returns
newConfidence = Math.min(
  existingConfidence + (delta * (1 - existingConfidence) * 0.8),
  0.95  // Hard cap — never reaches 1.0
);
```

**Anchor alignment bonus** — if the skill's `related_anchor_ids` is non-empty (at least one anchor aligns), apply a one-time +0.05 bonus at creation and +0.03 per reinforcement. Cap at 0.95.

**Re-score adjustment** — during weekly re-score, confidence is adjusted by comparing current graph state signals against the last scoring snapshot. If node density or source history has grown (more nodes and sources now relate to this skill), confidence can increase. If the skill's contributing sources have been deleted, confidence decreases proportionally.

---

## `api/skills/process-source.ts`

Called from `src/hooks/useExtraction.ts` after a source is successfully ingested and tagged `skill_candidate: true`. Evaluates the source for skill signals, then creates new skills or reinforces existing ones.

**Self-contained. Zero local imports. All logic inline.**

### Request

```
POST /api/skills/process-source
Authorization: Bearer <supabase_jwt>
Content-Type: application/json

{
  source_id: string     // ID of the newly ingested source
}
```

### Processing Sequence

**Step 1 — Fetch source data**

```sql
-- Source
SELECT id, title, source_type, metadata, created_at
FROM knowledge_sources
WHERE id = $1 AND user_id = $2

-- Extracted nodes for this source
SELECT id, label, entity_type, confidence, description, embedding
FROM knowledge_nodes
WHERE source_id = $1 AND user_id = $2

-- Source chunks (top 8 for Gemini context)
SELECT content, chunk_index
FROM source_chunks
WHERE source_id = $1 AND user_id = $2
ORDER BY chunk_index ASC
LIMIT 8

-- User anchors (for S1 signal)
SELECT id, label, entity_type, embedding
FROM knowledge_nodes
WHERE user_id = $2 AND is_anchor = true

-- User profile (for S5 signal)
SELECT professional_context
FROM user_profiles
WHERE user_id = $2
LIMIT 1
```

**Step 2 — Form concept clusters**

Same clustering logic as PRD-25. Group eligible nodes by semantic proximity and shared edge relationships. Eligible entity types: `Topic`, `Technology`, `Concept`, `Insight`, `Idea`, `Hypothesis`, `Lesson`, `Takeaway`.

Cap at 5 clusters per source.

**Step 3 — Universal layer evaluation (Gemini)**

Batch all clusters from this source into a single Gemini call. Same prompt structure as PRD-25 — evaluates C1 through C5, returns `criteriaPassedCount` and `suggestedSkillLabel` per cluster. Temperature: 0.1.

Clusters with `criteriaPassedCount < 3` are dropped. Remaining clusters proceed to Step 4.

**Step 4 — Deduplication against existing skills**

For each surviving cluster, check whether a skill with a similar label already exists in `knowledge_skills` for this user. Use a two-pass check:

**Pass 1 — Exact label match:**
```sql
SELECT id, label, confidence, status, exposure_level
FROM knowledge_skills
WHERE user_id = $1
  AND LOWER(label) = LOWER($2)
LIMIT 1
```

**Pass 2 — Semantic similarity (if no exact match):**
Generate an embedding for `suggestedSkillLabel` using `text-embedding-004`. Query existing skill labels for cosine similarity > 0.85. If a match is found above this threshold, treat it as the same skill.

Batch all embedding generation calls (collect all labels first, then generate in one batch) to avoid rate limiting.

**If existing skill found:** Route to reinforcement path (Step 6).
**If no existing skill found:** Route to creation path (Step 5).

**Step 5 — Skill creation**

For clusters that passed deduplication (no existing match):

**5a — Compute personalised relevance score**

Run the six-signal scoring from PRD-25b:
- S1: cosine similarity of skill embedding against anchor embeddings (use already-generated embedding from Step 4)
- S2: node density count for this skill's concept
- S3: source history count across existing sources
- S4: BFS graph proximity to nearest anchor (cap depth at 4)
- S5: domain match using `professional_context.domain` (structured field from PRD-25b)
- S6: velocity (related sources in last 14 days)

Combine using `SIGNAL_WEIGHTS` constants (same as PRD-25).

**5b — Write skill record**

```typescript
const initialConfidence = SOURCE_TYPE_CONFIDENCE[source.source_type] ?? 0.35;
const anchorBonus = relatedAnchorIds.length > 0 ? 0.05 : 0;

await supabase.from('knowledge_skills').insert({
  user_id: userId,
  label: suggestedSkillLabel,
  domain: evaluatedDomain,
  confidence: Math.min(initialConfidence + anchorBonus, 0.95),
  exposure_level: deriveExposureLevel(source.source_type, nodeCount),
  status: (initialConfidence + anchorBonus) >= 0.55 ? 'confirmed' : 'candidate',
  last_relevance_score: relevanceScore,
  signal_breakdown: signalBreakdown,
  related_anchor_ids: relatedAnchorIds,
  when_to_apply: null,    // Populated by weekly re-score (Gemini generation)
  how_to_apply: null,     // Populated by weekly re-score (Gemini generation)
  first_detected_at: new Date().toISOString(),
  last_reinforced_at: new Date().toISOString(),
});
```

**5c — Write skill_sources junction row**

```typescript
await supabase.from('skill_sources').insert({
  user_id: userId,
  skill_id: newSkillId,
  source_id: sourceId,
  contribution: 'created',
  confidence_delta: initialConfidence + anchorBonus,
});
```

**5d — Update skill_scan_state**

```typescript
await supabase
  .from('skill_scan_state')
  .upsert({
    user_id: userId,
    last_incremental_at: new Date().toISOString(),
    candidates_confirmed: confirmedCount,  // updated count
  }, { onConflict: 'user_id' });
```

**Step 6 — Skill reinforcement**

For clusters where an existing skill was found:

**6a — Check if this source has already contributed**
```sql
SELECT id FROM skill_sources
WHERE skill_id = $1 AND source_id = $2
LIMIT 1
```
If already present, skip — idempotent. This prevents double-counting if the function is called twice for the same source.

**6b — Compute confidence delta and new confidence**

```typescript
const delta = REINFORCEMENT_DELTAS[source.source_type] ?? 0.10;
const anchorBonus = relatedAnchorIds.length > 0 ? 0.03 : 0;
const newConfidence = Math.min(
  existingSkill.confidence + (delta * (1 - existingSkill.confidence) * 0.8) + anchorBonus,
  0.95
);
```

**6c — Determine new exposure level**

```typescript
function upgradeExposureLevel(
  current: ExposureLevel,
  sourceType: string,
  newEvidenceCount: number
): ExposureLevel {
  if (sourceType === 'Meeting' && current === 'developing') return 'proficient';
  if (sourceType === 'Meeting' && current === 'novice') return 'developing';
  if (newEvidenceCount >= 5 && current === 'developing') return 'proficient';
  if (newEvidenceCount >= 8 && current === 'proficient') return 'advanced';
  return current;  // No change
}
```

**6d — Update skill record**

```typescript
await supabase
  .from('knowledge_skills')
  .update({
    confidence: newConfidence,
    exposure_level: newExposureLevel,
    status: newConfidence >= 0.55 ? 'confirmed' : existingSkill.status,
    evidence_count: existingSkill.evidence_count + 1,
    last_reinforced_at: new Date().toISOString(),
  })
  .eq('id', existingSkill.id);
```

**6e — Write skill_sources junction row**

```typescript
await supabase.from('skill_sources').insert({
  user_id: userId,
  skill_id: existingSkill.id,
  source_id: sourceId,
  contribution: newExposureLevel !== existingSkill.exposure_level ? 'upgraded' : 'reinforced',
  confidence_delta: newConfidence - existingSkill.confidence,
});
```

### Response

```typescript
interface ProcessSourceResponse {
  source_id: string;
  skills_created: number;
  skills_reinforced: number;
  clusters_evaluated: number;
  clusters_passed_universal: number;
  duration_ms: number;
  created: Array<{ label: string; confidence: number; status: string }>;
  reinforced: Array<{ label: string; confidence_before: number; confidence_after: number }>;
}
```

### Integration into `src/hooks/useExtraction.ts`

After the candidacy gate call (PRD-25b), add:

```typescript
// Fire-and-forget — do not await, do not block the ingestion UI
if (candidacy.isCandidate) {
  fetch('/api/skills/process-source', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${session.access_token}`,
    },
    body: JSON.stringify({ source_id: savedSourceId }),
  }).catch(err => {
    console.warn('Skill processing failed silently:', err);
    // Never surface this error to the user — skill processing is background infrastructure
  });
}
```

Skill processing must never block or error the ingestion flow. It is background infrastructure — if it fails, ingestion succeeds regardless.

---

## `api/skills/rescore.ts`

Weekly cron function. Runs every Sunday at 02:00 UTC. Re-scores all non-archived skills against the latest graph state. Generates `when_to_apply` and `how_to_apply` fields for confirmed skills that don't yet have them. Applies lifecycle transitions (confirmed → dormant, dormant → archived).

### Cron Schedule (add to `vercel.json`)

```json
{
  "crons": [
    {
      "path": "/api/skills/rescore",
      "schedule": "0 2 * * 0"
    }
  ]
}
```

### Processing Sequence

**Step 1 — Fetch all non-archived skills**

```sql
SELECT ks.*, 
       array_agg(ss.source_id) as contributing_source_ids,
       MAX(ss.created_at) as last_source_at
FROM knowledge_skills ks
LEFT JOIN skill_sources ss ON ss.skill_id = ks.id
WHERE ks.user_id = $1 AND ks.status != 'archived'
GROUP BY ks.id
```

**Step 2 — Apply lifecycle transitions**

For each skill, check transition conditions before re-scoring:

```typescript
// confirmed → dormant
if (skill.status === 'confirmed') {
  const daysSinceReinforcement = daysBetween(skill.last_reinforced_at, now);
  if (daysSinceReinforcement > 60) {
    await updateSkillStatus(skill.id, 'dormant');
    continue;  // Skip re-score for newly dormant skills
  }
}

// dormant → archived
if (skill.status === 'dormant') {
  const daysDormant = daysBetween(skill.last_reinforced_at, now);
  if (daysDormant > 90) {
    await updateSkillStatus(skill.id, 'archived');
    continue;
  }
}
```

**Step 3 — Re-score each active skill**

Re-run the six-signal scoring for each non-archived, non-transitioning skill. Compare new `relevance_score` against `last_relevance_score`. If score has changed by more than 0.05, update `signal_breakdown` and `last_relevance_score`.

Process in batches of 10 to avoid Supabase connection limits on large skill libraries.

**Step 4 — Generate `when_to_apply` and `how_to_apply` (Gemini)**

For confirmed skills that have `when_to_apply = null` OR were last scored more than 30 days ago, run a single batched Gemini call to generate these fields.

This is the **only generative Gemini call** in the entire PRD-26 pipeline. Everything else is evaluative or rule-based.

Batch up to 10 skills per Gemini call:

```
System:
You are generating structured descriptions for skills in a personal knowledge graph.
Each skill has been detected from real content the user has ingested.
Be concise, specific, and practical. Write for an AI assistant that needs to know 
when and how to apply each skill on behalf of the user.

Respond ONLY with a JSON array. No preamble or markdown.

User:
Generate when_to_apply and how_to_apply descriptions for these skills:

[
  {
    "label": "Implementing RAG with pgvector",
    "domain": "technical",
    "exposure_level": "proficient",
    "evidence_count": 4,
    "contributing_sources": ["Building a RAG Pipeline", "pgvector Tutorial", ...]
  },
  ...
]

Return:
[
  {
    "label": "Implementing RAG with pgvector",
    "when_to_apply": "2-3 sentences: the specific situations, questions, or tasks where this skill is relevant",
    "how_to_apply": "2-3 sentences: the practical approach, key steps, or principles to apply this skill"
  },
  ...
]
```

**Temperature: 0.2. Max output tokens: 2048.**

After generation, write `when_to_apply` and `how_to_apply` to each matching skill record. Add 500ms delay between batches.

**Step 5 — Update related_skill_ids**

Find sibling skills — skills with `relevance_score > 0.6` that share anchor alignment or domain. Write bidirectional `related_skill_ids` arrays.

```typescript
// For each skill pair (A, B):
// If cosineSimilarity(A.embedding, B.embedding) > 0.75 OR
//    A.related_anchor_ids intersects B.related_anchor_ids:
//   Add B.id to A.related_skill_ids and vice versa
```

**Step 6 — Update `skill_scan_state`**

```typescript
await supabase
  .from('skill_scan_state')
  .upsert({
    user_id: userId,
    last_full_scan_at: new Date().toISOString(),
    candidates_confirmed: confirmedCount,
    scan_version: CURRENT_SCAN_VERSION,
    metadata: {
      last_rescore_summary: {
        skills_rescored: n,
        skills_transitioned_dormant: n,
        skills_archived: n,
        when_to_apply_generated: n,
        duration_ms: n,
      }
    }
  }, { onConflict: 'user_id' });
```

---

## `api/skills/get.ts`

Returns the user's skill library. Called by the MCP `get_skills` tool and (in PRD-27) by the Skills tab in Explore.

### Request

```
GET /api/skills/get
Authorization: Bearer <supabase_jwt>

Query params (all optional):
  domain?: string          // Filter by domain
  status?: string          // Filter by status. Default: 'confirmed'
  min_confidence?: number  // Default: 0.0
  exposure_level?: string  // Filter by level
  limit?: number           // Default: 50
  include_sources?: boolean // Include contributing source titles. Default: false
```

### Query

```sql
SELECT 
  ks.id,
  ks.label,
  ks.domain,
  ks.exposure_level,
  ks.confidence,
  ks.status,
  ks.evidence_count,
  ks.when_to_apply,
  ks.how_to_apply,
  ks.related_anchor_ids,
  ks.last_reinforced_at,
  ks.signal_breakdown,
  -- Anchor labels (denormalized for MCP readability)
  (
    SELECT array_agg(label)
    FROM knowledge_nodes
    WHERE id = ANY(ks.related_anchor_ids)
    AND user_id = ks.user_id
  ) as related_anchor_labels,
  -- Contributing source titles (optional)
  CASE WHEN $include_sources THEN (
    SELECT array_agg(kso.title)
    FROM skill_sources ss
    JOIN knowledge_sources kso ON kso.id = ss.source_id
    WHERE ss.skill_id = ks.id
  ) ELSE NULL END as contributing_source_titles
FROM knowledge_skills ks
WHERE ks.user_id = $1
  AND ks.status = ANY($status_filter)
  AND ks.confidence >= $min_confidence
ORDER BY ks.confidence DESC, ks.evidence_count DESC
LIMIT $limit
```

---

## MCP Extension — `api/mcp.ts`

Add `get_skills` as the 7th tool. This is the only modification to `api/mcp.ts` in this PRD. Add it to the `tools/list` array and the `tools/call` dispatcher.

### Tool Descriptor

```typescript
{
  name: "get_skills",
  description: `Return the user's personal skill library — capabilities they have accumulated 
from ingested content (YouTube tutorials, meeting transcripts, documents). Each skill includes 
what it is, when to apply it, how to apply it, and the confidence level based on evidence count. 
Use this at the start of any technical, strategic, or consulting task to understand what the user 
already knows how to do and at what depth — so you can calibrate your response accordingly. 
Do NOT use for general knowledge questions. Use when you need to understand the user's 
personal capability level in a specific domain.`,
  inputSchema: {
    type: "object",
    properties: {
      domain: {
        type: "string",
        description: "Optional filter: technical, consulting, strategic, interpersonal, domain_specific"
      },
      min_confidence: {
        type: "number",
        description: "Minimum confidence threshold 0-1. Default 0.5 (confirmed skills only).",
        default: 0.5
      },
      include_application_guidance: {
        type: "boolean",
        description: "Include when_to_apply and how_to_apply fields. Default true.",
        default: true
      }
    }
  }
}
```

### Tool Handler

```typescript
case 'get_skills': {
  const { domain, min_confidence = 0.5, include_application_guidance = true } = params.input ?? {};

  // Call api/skills/get logic inline (self-contained — no import)
  const query = supabaseServiceClient
    .from('knowledge_skills')
    .select(`
      label, domain, exposure_level, confidence, evidence_count, status,
      when_to_apply, how_to_apply, related_anchor_ids, last_reinforced_at
    `)
    .eq('user_id', userId)
    .eq('status', 'confirmed')
    .gte('confidence', min_confidence)
    .order('confidence', { ascending: false })
    .limit(40);

  if (domain) query.eq('domain', domain);

  const { data: skills } = await query;

  if (!skills || skills.length === 0) {
    return {
      content: [{
        type: 'text',
        text: 'No confirmed skills found in your knowledge graph yet. Skills are built up as you ingest more content — particularly YouTube tutorials and meeting transcripts where you describe applying techniques.'
      }]
    };
  }

  // Format for MCP readability
  const grouped = skills.reduce((acc, skill) => {
    const d = skill.domain;
    if (!acc[d]) acc[d] = [];
    acc[d].push(skill);
    return acc;
  }, {} as Record<string, typeof skills>);

  const lines: string[] = [
    `**Your Skill Library** (${skills.length} confirmed skills)\n`
  ];

  for (const [domain, domainSkills] of Object.entries(grouped)) {
    lines.push(`\n## ${domain.charAt(0).toUpperCase() + domain.slice(1)}`);
    for (const skill of domainSkills) {
      lines.push(
        `\n**${skill.label}** · ${skill.exposure_level} · confidence: ${Math.round(skill.confidence * 100)}%`
      );
      if (include_application_guidance && skill.when_to_apply) {
        lines.push(`*When to apply:* ${skill.when_to_apply}`);
      }
      if (include_application_guidance && skill.how_to_apply) {
        lines.push(`*How to apply:* ${skill.how_to_apply}`);
      }
    }
  }

  // Update last_used_at on the API key
  await supabaseServiceClient
    .from('synapse_api_keys')
    .update({ last_used_at: new Date().toISOString() })
    .eq('key_hash', keyHash);

  return {
    content: [{ type: 'text', text: lines.join('\n') }]
  };
}
```

---

## Signal Weights Constants

Define at the top of both `api/skills/process-source.ts` and `api/skills/rescore.ts`. Identical values — do not diverge.

```typescript
const SIGNAL_WEIGHTS = {
  anchorAlignment: 0.25,
  nodeDensity:     0.20,
  sourceHistory:   0.20,
  graphProximity:  0.15,
  profileContext:  0.10,
  velocity:        0.10,
} as const;

const SOURCE_TYPE_CONFIDENCE: Record<string, number> = {
  YouTube:  0.35,
  Meeting:  0.65,
  Document: 0.55,
  Research: 0.40,
  Note:     0.25,
  Web:      0.30,
} as const;

const REINFORCEMENT_DELTAS: Record<string, number> = {
  YouTube:  0.10,
  Meeting:  0.20,
  Document: 0.15,
  Research: 0.10,
  Note:     0.05,
  Web:      0.08,
} as const;

const CURRENT_SCAN_VERSION = '1.0';

const DEDUP_SIMILARITY_THRESHOLD = 0.85;   // Cosine similarity for skill label matching
```

---

## Forward-Compatible Decisions

- **`when_to_apply` and `how_to_apply` as first-class fields** — these are what make the MCP tool genuinely useful to Claude Code. They are populated by the weekly re-score, not at creation time, so they get richer as evidence grows. PRD-27 surfaces them in the UI.
- **`related_skill_ids` array** — populated by the weekly re-score. Enables a skill graph view in PRD-27 and future cross-skill reasoning in the MCP.
- **`contribution` field on `skill_sources`** — the `created / reinforced / upgraded / corrected` taxonomy enables future analytics: "which sources have most contributed to capability growth?" This becomes a valuable signal for the PRD-28 skill-aware extraction.
- **`CURRENT_SCAN_VERSION` constant** — when signal weights are tuned after seeing real data, bumping this version allows the re-score to identify skills scored under the old model and re-evaluate them.
- **Fire-and-forget from ingestion hook** — skill processing never blocks ingestion. This is the canonical pattern for all future background enrichment (summaries, digests, etc.).
- **`api/skills/get.ts` as a shared endpoint** — both the MCP tool and the PRD-27 Skills UI call this endpoint. The MCP tool inlines the query (self-containment constraint); the frontend calls the endpoint via fetch.

---

## Edge Cases & Error Handling

| Scenario | Behaviour |
|---|---|
| `process-source` called for a non-candidate source | Fetch `metadata.skill_candidate` — if `false`, return early with `{ skills_created: 0, skills_reinforced: 0 }`. No processing. |
| Gemini universal evaluation returns unparseable JSON | Mark all clusters from this source as failed. Return gracefully — do not throw. Log to console. |
| Embedding generation rate limited during deduplication | Catch 429 errors. Wait 2 seconds and retry once. If second attempt fails, fall back to exact label matching only (skip semantic deduplication). Log warning. |
| `process-source` called twice for same source (e.g. re-extraction) | `skill_sources` unique constraint on `(skill_id, source_id)` prevents double-counting. Reinforcement check in Step 6a catches this. Idempotent. |
| Source has no chunks (chunking failed) | C5 fails. Cluster likely fails universal layer. Function returns with 0 skills created. Source's `skill_candidate: false` tag should have prevented this call — log a warning if reached. |
| `rescore` cron times out on Vercel Pro (60s limit) | Process in batches of 10 skills. For very large libraries, the cron may need to pick up where it left off. Use `skill_scan_state.metadata` to store `last_rescored_skill_id` for resume capability. |
| Skill label deduplication threshold too aggressive (0.85 creating duplicates) | The `DEDUP_SIMILARITY_THRESHOLD` constant is tunable. Lowering to 0.75 catches more near-duplicates. Raising to 0.90 allows more granular distinct skills. |
| `when_to_apply` / `how_to_apply` Gemini batch fails | Fields remain null. Skill is still created and confirmed. Next weekly re-score will retry generation. These fields are enrichment, not requirements. |
| User has 0 skills when `get_skills` MCP tool is called | Return the graceful empty-state message explaining how skills are built. Do not return an error. |
| `knowledge_nodes` or `knowledge_edges` query returns exactly 1,000 rows (Supabase cap) | Add `.limit(5000)` to node and edge queries in `process-source.ts` and `rescore.ts`. Do not rely on the default limit. |

---

## Acceptance Criteria

- The `knowledge_skills` and `skill_sources` tables exist in Supabase with RLS enabled and correct schemas.
- Ingesting a new YouTube tutorial or meeting transcript that passes the candidacy gate triggers `api/skills/process-source` in the background without blocking the ingestion UI.
- After processing, a new row exists in `knowledge_skills` with correct `label`, `domain`, `confidence`, `status`, and `exposure_level` values, and a corresponding row in `skill_sources` with `contribution: 'created'`.
- Ingesting a second source on the same topic reinforces the existing skill — `confidence` increases, `evidence_count` increments, a new `skill_sources` row is added with `contribution: 'reinforced'`. No duplicate skill row is created.
- `api/skills/rescore` runs without error on a database with existing skills, updates `last_scored_at`, and populates `when_to_apply` and `how_to_apply` for confirmed skills.
- Skills with `last_reinforced_at` older than 60 days transition to `dormant` during re-score.
- The `get_skills` MCP tool is listed in Claude Desktop when `tools/list` is called.
- Calling `get_skills` from Claude Desktop returns a formatted skill library grouped by domain.
- Calling `get_skills` with `domain: 'technical'` returns only technical skills.
- `when_to_apply` and `how_to_apply` are included in MCP responses for confirmed skills where they have been generated.
- `api/skills/process-source.ts`, `api/skills/rescore.ts`, and `api/skills/get.ts` all have zero local imports and compile with zero TypeScript errors in strict mode.
- The Vercel cron for `api/skills/rescore` appears in `vercel.json` and runs on schedule.
- Re-running `process-source` for the same source twice produces identical skill state — idempotent behaviour confirmed.
