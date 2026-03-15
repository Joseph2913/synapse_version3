# PRD-17 — Anchor Candidates: Data Foundation

**Phase:** 5 — Intelligence Layer  
**Dependencies:** PRD-1 through PRD-3 (Supabase client, auth, existing schema)  
**Estimated Complexity:** Low  
**Estimated Effort:** 1 session  
**Implements:** Schema, TypeScript types, and service query layer for the auto-anchor system. No UI. No serverless logic. Pure foundation.

---

## 1. Objective

The current anchor system is entirely manual — users must explicitly promote nodes to anchor status in Settings. This creates a cold-start problem: the graph's organisational layer is useless until the user completes a configuration step that most users will never do properly. This PRD lays the data foundation for a system that automatically discovers, scores, and surfaces anchor candidates based on structural signals in the knowledge graph.

By the end of this PRD, the database has a new `anchor_candidates` table that can store scored candidates with their reasoning, the full lifecycle state machine is encoded in TypeScript, and a clean service layer exists for all reads and writes. PRD-18 (the scoring engine) and PRD-19 (the Anchors page UI) both import from this foundation without making any schema changes of their own.

---

## 2. What Gets Built

### 2.1 — Database Migration

**File:** `supabase/migrations/20260315_prd17_anchor_candidates.sql`

The migration creates one new table, one custom enum type, and all necessary indexes and RLS policies. Nothing in the existing schema is modified.

### 2.2 — TypeScript Types

**File created:** `src/types/anchors.ts`

Full type definitions for the anchor candidate system: the lifecycle status enum, the candidate interface, the scoring profile enum, the user configuration interface, and all derived/utility types used by the service layer, hooks, and future UI.

### 2.3 — Service Functions

**File created:** `src/services/anchorCandidates.ts`

All Supabase query functions for the anchor candidate system. This is the single source of truth for all reads and writes to `anchor_candidates`. No component or hook should query this table directly — everything goes through this service.

### 2.4 — Type Index Export

**File modified:** `src/types/index.ts`

Adds exports for the new anchor types so they're importable from `'../types'` throughout the app.

### 2.5 — Database Types Extension

**File modified:** `src/types/database.ts`

Adds the `AnchorCandidateRow` interface representing the raw Supabase row shape, consistent with how `KnowledgeNode`, `KnowledgeEdge`, etc. are defined in this file.

---

## 3. Database Migration — Full Specification

**File:** `supabase/migrations/20260315_prd17_anchor_candidates.sql`

```sql
-- PRD-17: Anchor Candidates Foundation
-- Creates the anchor_candidates table, which stores system-generated anchor
-- suggestions with their scoring signals, lifecycle status, and reasoning text.
-- This table is the data foundation for the auto-anchor scoring engine (PRD-18)
-- and the Anchors management page (PRD-19).

-- ─── Enum: anchor_candidate_status ───────────────────────────────────────────
-- Encodes the full lifecycle state machine for a candidate anchor.
-- See PRD-17 for full transition documentation.

CREATE TYPE anchor_candidate_status AS ENUM (
  'pending',    -- Scored above threshold; not yet surfaced to user
  'suggested',  -- Currently visible to user in the Anchors page
  'confirmed',  -- User confirmed; knowledge_nodes.is_anchor set to true
  'dismissed',  -- User explicitly dismissed; respects cooldown before re-suggesting
  'archived',   -- User archived a confirmed anchor; hidden from graph but preserved
  'dormant'     -- Confirmed anchor with no new connected nodes for threshold period
);

-- ─── Enum: anchor_scoring_profile ────────────────────────────────────────────
-- Controls which signal weights are used when computing composite_score.
-- Maps to the four user-facing presets on the Anchors page settings panel.

CREATE TYPE anchor_scoring_profile AS ENUM (
  'balanced',        -- Default: equal weighting across all signals
  'emerging_topics', -- Emphasises velocity; surfaces fast-rising concepts
  'deep_concepts',   -- Emphasises centrality + relational_richness; structural hubs
  'active_focus',    -- Emphasises recency multiplier; what you're working on now
  'well_evidenced'   -- Emphasises source_diversity; multi-source supported concepts
);

-- ─── Table: anchor_candidates ────────────────────────────────────────────────

CREATE TABLE anchor_candidates (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Reference to the knowledge_nodes row this candidate is based on.
  -- SET NULL on cascade so candidate history is preserved if the node is deleted.
  node_id               UUID REFERENCES knowledge_nodes(id) ON DELETE SET NULL,

  -- ── Composite score ──────────────────────────────────────────────────────
  -- Final weighted score used for ranking and threshold comparisons.
  -- Range: 0.0 – 1.0. Threshold for surfacing is configurable per user.
  composite_score       NUMERIC(6, 4) NOT NULL DEFAULT 0,

  -- ── Individual signal scores (all range 0.0 – 1.0) ──────────────────────
  -- Stored individually so the UI can display a breakdown and so weights
  -- can be recomputed without re-running the full scorer.
  centrality_score      NUMERIC(6, 4) NOT NULL DEFAULT 0,
  diversity_score       NUMERIC(6, 4) NOT NULL DEFAULT 0,
  velocity_score        NUMERIC(6, 4) NOT NULL DEFAULT 0,
  richness_score        NUMERIC(6, 4) NOT NULL DEFAULT 0,
  behavioural_score     NUMERIC(6, 4) NOT NULL DEFAULT 0, -- Reserved for Phase 2

  -- ── Raw signal inputs (stored for display and debugging) ─────────────────
  mention_count         INTEGER NOT NULL DEFAULT 0,   -- Total appearances across all sources
  source_count          INTEGER NOT NULL DEFAULT 0,   -- Unique source documents
  unique_source_types   INTEGER NOT NULL DEFAULT 0,   -- e.g. Meeting + YouTube + Document = 3
  days_active           INTEGER NOT NULL DEFAULT 0,   -- Days between first and last mention
  recent_velocity       NUMERIC(6, 4) NOT NULL DEFAULT 0, -- Ratio: last-14d mentions / prior-14d

  -- 'rising' | 'stable' | 'falling' — derived from recent_velocity
  velocity_direction    TEXT NOT NULL DEFAULT 'stable'
    CHECK (velocity_direction IN ('rising', 'stable', 'falling')),

  -- ── Lifecycle ────────────────────────────────────────────────────────────
  status                anchor_candidate_status NOT NULL DEFAULT 'pending',

  -- Which weight profile was active when composite_score was last computed.
  -- Stored so the scorer can detect when a profile change requires re-scoring.
  scoring_profile       anchor_scoring_profile NOT NULL DEFAULT 'balanced',

  -- ── Human-readable reasoning ─────────────────────────────────────────────
  -- Template-generated text explaining why this candidate was surfaced.
  -- Computed at scoring time; stored to avoid regeneration on every page load.
  -- Example: "Appeared across 6 different sources over 18 days, with activity
  -- increasing sharply in the last week. Connects to 4 of your existing anchors
  -- across 7 relationship types."
  reasoning_text        TEXT,

  -- ── Timestamps ───────────────────────────────────────────────────────────
  first_scored_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_scored_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  suggested_at          TIMESTAMPTZ,   -- When status moved to 'suggested'
  reviewed_at           TIMESTAMPTZ,   -- When user confirmed, dismissed, or archived
  dormant_since         TIMESTAMPTZ,   -- When status moved to 'dormant'

  -- ── Dismissal ────────────────────────────────────────────────────────────
  -- How many times this candidate has been dismissed (to detect persistent dismissals)
  dismiss_count         INTEGER NOT NULL DEFAULT 0,
  -- Earliest datetime the scorer may re-surface this candidate after dismissal
  resurface_after       TIMESTAMPTZ,

  -- ── User configuration snapshot ──────────────────────────────────────────
  -- The threshold that was active when this candidate was first scored.
  -- Stored for auditing; not used in queries.
  threshold_at_scoring  NUMERIC(6, 4),

  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Indexes ──────────────────────────────────────────────────────────────────

-- Primary lookup: all candidates for a user, ordered by score descending
CREATE INDEX idx_anchor_candidates_user_score
  ON anchor_candidates (user_id, composite_score DESC);

-- Status-based filtering (the Anchors page always filters by status)
CREATE INDEX idx_anchor_candidates_user_status
  ON anchor_candidates (user_id, status);

-- Node lookup: check if a given node already has a candidate row
CREATE INDEX idx_anchor_candidates_node_id
  ON anchor_candidates (node_id)
  WHERE node_id IS NOT NULL;

-- Resurface scheduling: daily scorer queries for dismissed candidates ready to re-surface
CREATE INDEX idx_anchor_candidates_resurface
  ON anchor_candidates (user_id, resurface_after)
  WHERE status = 'dismissed' AND resurface_after IS NOT NULL;

-- ─── Row Level Security ───────────────────────────────────────────────────────

ALTER TABLE anchor_candidates ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own anchor candidates"
  ON anchor_candidates FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own anchor candidates"
  ON anchor_candidates FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own anchor candidates"
  ON anchor_candidates FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own anchor candidates"
  ON anchor_candidates FOR DELETE
  USING (auth.uid() = user_id);

-- ─── Updated-at trigger ───────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION update_anchor_candidates_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER anchor_candidates_updated_at
  BEFORE UPDATE ON anchor_candidates
  FOR EACH ROW
  EXECUTE FUNCTION update_anchor_candidates_updated_at();
```

---

## 4. TypeScript Types — Full Specification

**File:** `src/types/anchors.ts`

```typescript
import type { EntityType } from './database'

// ─── Lifecycle Status ─────────────────────────────────────────────────────────

export type AnchorCandidateStatus =
  | 'pending'     // Scored; not yet surfaced to user
  | 'suggested'   // Visible on Anchors page; awaiting user review
  | 'confirmed'   // User confirmed; is_anchor = true on knowledge_nodes
  | 'dismissed'   // User dismissed; respects resurface_after cooldown
  | 'archived'    // User archived a confirmed anchor
  | 'dormant'     // Confirmed anchor inactive beyond dormant threshold

// ─── Scoring Profile ──────────────────────────────────────────────────────────

export type AnchorScoringProfile =
  | 'balanced'        // Default equal weighting
  | 'emerging_topics' // High velocity weight
  | 'deep_concepts'   // High centrality + richness weight
  | 'active_focus'    // High recency multiplier
  | 'well_evidenced'  // High diversity weight

export const SCORING_PROFILE_LABELS: Record<AnchorScoringProfile, string> = {
  balanced:        'Balanced',
  emerging_topics: 'Emerging Topics',
  deep_concepts:   'Deep Concepts',
  active_focus:    'Active Focus',
  well_evidenced:  'Well Evidenced',
}

export const SCORING_PROFILE_DESCRIPTIONS: Record<AnchorScoringProfile, string> = {
  balanced:        'Equal weighting across all signals. Best starting point.',
  emerging_topics: 'Surfaces concepts that are rising quickly in your recent content.',
  deep_concepts:   'Surfaces structurally important hubs with rich relationship patterns.',
  active_focus:    'Surfaces what you have been actively working on recently.',
  well_evidenced:  'Surfaces concepts supported by multiple independent sources.',
}

// ─── Signal weights per profile ───────────────────────────────────────────────
// Used by the scoring engine (PRD-18) to compute composite_score.
// Weights must sum to 1.0 for each profile.

export interface SignalWeights {
  centrality:   number  // Betweenness + degree centrality
  diversity:    number  // Source count × source type diversity
  velocity:     number  // Recency + acceleration
  richness:     number  // Unique relationship types × avg weight
  behavioural:  number  // Reserved for Phase 2; always 0 for now
}

export const SIGNAL_WEIGHTS_BY_PROFILE: Record<AnchorScoringProfile, SignalWeights> = {
  balanced: {
    centrality: 0.35, diversity: 0.25, velocity: 0.20, richness: 0.15, behavioural: 0.05,
  },
  emerging_topics: {
    centrality: 0.15, diversity: 0.15, velocity: 0.55, richness: 0.10, behavioural: 0.05,
  },
  deep_concepts: {
    centrality: 0.45, diversity: 0.15, velocity: 0.10, richness: 0.25, behavioural: 0.05,
  },
  active_focus: {
    centrality: 0.20, diversity: 0.20, velocity: 0.45, richness: 0.10, behavioural: 0.05,
  },
  well_evidenced: {
    centrality: 0.25, diversity: 0.50, velocity: 0.10, richness: 0.10, behavioural: 0.05,
  },
}

// ─── Velocity Direction ───────────────────────────────────────────────────────

export type VelocityDirection = 'rising' | 'stable' | 'falling'

// ─── Core Candidate Interface ─────────────────────────────────────────────────
// Matches the anchor_candidates table shape with camelCase field names.

export interface AnchorCandidate {
  id:                  string
  userId:              string
  nodeId:              string | null

  // Scores
  compositeScore:      number
  centralityScore:     number
  diversityScore:      number
  velocityScore:       number
  richnessScore:       number
  behaviouralScore:    number

  // Raw signal inputs
  mentionCount:        number
  sourceCount:         number
  uniqueSourceTypes:   number
  daysActive:          number
  recentVelocity:      number
  velocityDirection:   VelocityDirection

  // Lifecycle
  status:              AnchorCandidateStatus
  scoringProfile:      AnchorScoringProfile
  reasoningText:       string | null

  // Timestamps
  firstScoredAt:       string
  lastScoredAt:        string
  suggestedAt:         string | null
  reviewedAt:          string | null
  dormantSince:        string | null

  // Dismissal
  dismissCount:        number
  resurface_after:     string | null

  // Audit
  thresholdAtScoring:  number | null
  createdAt:           string
  updatedAt:           string
}

// ─── Candidate with joined node data ─────────────────────────────────────────
// Returned by fetchCandidatesWithNodes() — the primary query for the Anchors page.

export interface AnchorCandidateWithNode extends AnchorCandidate {
  node: {
    id:           string
    label:        string
    entity_type:  EntityType
    description:  string | null
    confidence:   number | null
    is_anchor:    boolean
    created_at:   string
  } | null

  // Computed connection stats — joined from knowledge_edges
  connectionCount:     number   // Total edges on the node
  anchorConnections:   number   // Edges to other anchor nodes
}

// ─── User Configuration ───────────────────────────────────────────────────────
// Persisted in user_profiles.processing_preferences.anchor_settings (JSONB).
// Loaded via useSettings(); written by the Anchors page settings panel (PRD-19).

export interface AnchorUserConfig {
  // How often the scoring engine runs
  suggestionFrequency:  'per_extraction' | 'daily' | 'weekly'
  
  // Score threshold for surfacing a candidate as 'suggested'
  // Maps to UI slider: 'conservative' ≈ 0.72, 'balanced' ≈ 0.60, 'aggressive' ≈ 0.45
  suggestionThreshold:  number
  
  // Days before an unreviewed 'suggested' candidate auto-reverts to 'pending'
  autoDismissAfterDays: number  // Default: 14, range: 7–30
  
  // Days of inactivity before a 'confirmed' anchor moves to 'dormant'
  dormantAfterDays:     number  // Default: 60, range: 30–180
  
  // Days before a dismissed candidate can be re-surfaced
  resurfaceCooldownDays: number  // Default: 30, range: 7–90
  
  // Which signal weight profile to use
  scoringProfile:       AnchorScoringProfile

  // Auto-archive dormant anchors after additional X days (opt-in)
  autoArchiveDormantAfterDays: number | null  // null = disabled
}

export const DEFAULT_ANCHOR_USER_CONFIG: AnchorUserConfig = {
  suggestionFrequency:         'per_extraction',
  suggestionThreshold:         0.60,
  autoDismissAfterDays:        14,
  dormantAfterDays:            60,
  resurfaceCooldownDays:       30,
  scoringProfile:              'balanced',
  autoArchiveDormantAfterDays: null,
}

// ─── Threshold presets ────────────────────────────────────────────────────────
// Maps to the Conservative / Balanced / Aggressive slider in the UI.

export const THRESHOLD_PRESETS = {
  conservative: 0.72,
  balanced:     0.60,
  aggressive:   0.45,
} as const

export type ThresholdPreset = keyof typeof THRESHOLD_PRESETS

// ─── Upsert payload ───────────────────────────────────────────────────────────
// Shape accepted by upsertAnchorCandidate() in the service layer.
// Used by the scoring engine (PRD-18).

export interface AnchorCandidateUpsert {
  userId:             string
  nodeId:             string
  compositeScore:     number
  centralityScore:    number
  diversityScore:     number
  velocityScore:      number
  richnessScore:      number
  mentionCount:       number
  sourceCount:        number
  uniqueSourceTypes:  number
  daysActive:         number
  recentVelocity:     number
  velocityDirection:  VelocityDirection
  scoringProfile:     AnchorScoringProfile
  reasoningText:      string
  thresholdAtScoring: number
}

// ─── Status update payload ────────────────────────────────────────────────────
// Shape accepted by updateCandidateStatus() in the service layer.

export interface AnchorCandidateStatusUpdate {
  status:          AnchorCandidateStatus
  reviewedAt?:     string   // ISO string; set when user confirms/dismisses
  dormantSince?:   string   // ISO string; set when transitioning to dormant
  resurface_after?: string  // ISO string; set when dismissing
  dismissCount?:   number   // Incremented on dismiss
}

// ─── Anchor health summary ────────────────────────────────────────────────────
// Computed by fetchAnchorHealthSummary(); displayed in the right panel
// default state of the Anchors page (PRD-19).

export interface AnchorHealthSummary {
  totalConfirmed:        number
  totalSuggested:        number
  totalDormant:          number
  avgNodesPerAnchor:     number
  mostConnectedAnchor:   { label: string; nodeCount: number } | null
  isolatedAnchors:       number   // Confirmed anchors with 0 cross-anchor connections
  staleAnchors:          Array<{  // For "Needs Attention" list
    candidateId:  string
    nodeId:       string
    label:        string
    issue:        'isolated' | 'low_nodes' | 'dormant' | 'single_source'
    detail:       string   // Human-readable: "Only 2 nodes" / "No new content in 78 days"
  }>
}
```

---

## 5. Database Types Extension

**File modified:** `src/types/database.ts`

Add the following interface at the end of the file, after the existing `ExtractionSettings` interface. This represents the raw row shape as returned by Supabase (snake_case), consistent with the other interfaces in this file.

```typescript
// ─── anchor_candidates (PRD-17) ───────────────────────────────────────────────

export interface AnchorCandidateRow {
  id:                    string
  user_id:               string
  node_id:               string | null
  composite_score:       number
  centrality_score:      number
  diversity_score:       number
  velocity_score:        number
  richness_score:        number
  behavioural_score:     number
  mention_count:         number
  source_count:          number
  unique_source_types:   number
  days_active:           number
  recent_velocity:       number
  velocity_direction:    'rising' | 'stable' | 'falling'
  status:                'pending' | 'suggested' | 'confirmed' | 'dismissed' | 'archived' | 'dormant'
  scoring_profile:       'balanced' | 'emerging_topics' | 'deep_concepts' | 'active_focus' | 'well_evidenced'
  reasoning_text:        string | null
  first_scored_at:       string
  last_scored_at:        string
  suggested_at:          string | null
  reviewed_at:           string | null
  dormant_since:         string | null
  dismiss_count:         number
  resurface_after:       string | null
  threshold_at_scoring:  number | null
  created_at:            string
  updated_at:            string
}
```

---

## 6. Service Layer — Full Specification

**File:** `src/services/anchorCandidates.ts`

```typescript
import { supabase } from './supabase'
import type { AnchorCandidateRow } from '../types/database'
import type {
  AnchorCandidate,
  AnchorCandidateWithNode,
  AnchorCandidateStatusUpdate,
  AnchorCandidateUpsert,
  AnchorCandidateStatus,
  AnchorHealthSummary,
} from '../types/anchors'

// ─── Row → camelCase mapper ───────────────────────────────────────────────────

function mapRow(row: AnchorCandidateRow): AnchorCandidate {
  return {
    id:                  row.id,
    userId:              row.user_id,
    nodeId:              row.node_id,
    compositeScore:      row.composite_score,
    centralityScore:     row.centrality_score,
    diversityScore:      row.diversity_score,
    velocityScore:       row.velocity_score,
    richnessScore:       row.richness_score,
    behaviouralScore:    row.behavioural_score,
    mentionCount:        row.mention_count,
    sourceCount:         row.source_count,
    uniqueSourceTypes:   row.unique_source_types,
    daysActive:          row.days_active,
    recentVelocity:      row.recent_velocity,
    velocityDirection:   row.velocity_direction,
    status:              row.status,
    scoringProfile:      row.scoring_profile,
    reasoningText:       row.reasoning_text,
    firstScoredAt:       row.first_scored_at,
    lastScoredAt:        row.last_scored_at,
    suggestedAt:         row.suggested_at,
    reviewedAt:          row.reviewed_at,
    dormantSince:        row.dormant_since,
    dismissCount:        row.dismiss_count,
    resurface_after:     row.resurface_after,
    thresholdAtScoring:  row.threshold_at_scoring,
    createdAt:           row.created_at,
    updatedAt:           row.updated_at,
  }
}

// ─── Fetch: candidates with joined node data ──────────────────────────────────
// Primary query for the Anchors page. Returns candidates filtered by status,
// joined with the knowledge_nodes row and connection count stats.

export async function fetchCandidatesWithNodes(
  userId: string,
  statuses: AnchorCandidateStatus[]
): Promise<AnchorCandidateWithNode[]> {
  const { data, error } = await supabase
    .from('anchor_candidates')
    .select(`
      *,
      node:knowledge_nodes (
        id,
        label,
        entity_type,
        description,
        confidence,
        is_anchor,
        created_at
      )
    `)
    .eq('user_id', userId)
    .in('status', statuses)
    .order('composite_score', { ascending: false })

  if (error) {
    console.error('[anchorCandidates] fetchCandidatesWithNodes error:', error.message)
    return []
  }

  if (!data) return []

  // Fetch connection counts for all node IDs in a single query
  const nodeIds = data
    .map(r => r.node_id)
    .filter((id): id is string => id !== null)

  const connectionCounts = await fetchConnectionCounts(nodeIds)
  const anchorConnectionCounts = await fetchAnchorConnectionCounts(userId, nodeIds)

  return data.map(row => ({
    ...mapRow(row as AnchorCandidateRow),
    node: row.node ?? null,
    connectionCount:   connectionCounts[row.node_id ?? ''] ?? 0,
    anchorConnections: anchorConnectionCounts[row.node_id ?? ''] ?? 0,
  }))
}

// ─── Fetch: single candidate by node ID ──────────────────────────────────────
// Used by the scoring engine to check if a candidate already exists
// before deciding whether to insert or update.

export async function fetchCandidateByNodeId(
  userId: string,
  nodeId: string
): Promise<AnchorCandidate | null> {
  const { data, error } = await supabase
    .from('anchor_candidates')
    .select('*')
    .eq('user_id', userId)
    .eq('node_id', nodeId)
    .maybeSingle()

  if (error || !data) return null
  return mapRow(data as AnchorCandidateRow)
}

// ─── Fetch: confirmed anchors (for Anchors page "Your Anchors" section) ───────
// Returns all confirmed and dormant candidates, ordered by composite_score desc.

export async function fetchConfirmedCandidates(
  userId: string
): Promise<AnchorCandidateWithNode[]> {
  return fetchCandidatesWithNodes(userId, ['confirmed', 'dormant'])
}

// ─── Fetch: suggested candidates (for Anchors page "Suggested" section) ───────

export async function fetchSuggestedCandidates(
  userId: string
): Promise<AnchorCandidateWithNode[]> {
  return fetchCandidatesWithNodes(userId, ['suggested'])
}

// ─── Fetch: pending candidate count ──────────────────────────────────────────
// Used by the nav rail badge to show how many suggestions await review.

export async function fetchSuggestedCount(userId: string): Promise<number> {
  const { count, error } = await supabase
    .from('anchor_candidates')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('status', 'suggested')

  if (error) return 0
  return count ?? 0
}

// ─── Upsert: insert or update a scored candidate ─────────────────────────────
// Called by the scoring engine (PRD-18) after computing signals.
// If a row exists for this node_id, updates scores and reasoning.
// If not, inserts a new pending candidate.
// Does NOT modify status if the existing status is 'confirmed', 'dismissed',
// 'archived', or 'dormant' — only updates scores on those rows.

export async function upsertAnchorCandidate(
  payload: AnchorCandidateUpsert
): Promise<{ id: string } | null> {
  const existing = await fetchCandidateByNodeId(payload.userId, payload.nodeId)

  const protectedStatuses: AnchorCandidateStatus[] = [
    'confirmed', 'dismissed', 'archived', 'dormant',
  ]

  const now = new Date().toISOString()

  if (existing) {
    // Always update scores and reasoning
    const updatePayload: Record<string, unknown> = {
      composite_score:    payload.compositeScore,
      centrality_score:   payload.centralityScore,
      diversity_score:    payload.diversityScore,
      velocity_score:     payload.velocityScore,
      richness_score:     payload.richnessScore,
      mention_count:      payload.mentionCount,
      source_count:       payload.sourceCount,
      unique_source_types: payload.uniqueSourceTypes,
      days_active:        payload.daysActive,
      recent_velocity:    payload.recentVelocity,
      velocity_direction: payload.velocityDirection,
      scoring_profile:    payload.scoringProfile,
      reasoning_text:     payload.reasoningText,
      last_scored_at:     now,
    }

    // Only advance status to 'suggested' if currently 'pending'
    if (existing.status === 'pending' && payload.compositeScore >= payload.thresholdAtScoring) {
      updatePayload.status = 'suggested'
      updatePayload.suggested_at = now
    }

    const { data, error } = await supabase
      .from('anchor_candidates')
      .update(updatePayload)
      .eq('id', existing.id)
      .select('id')
      .single()

    if (error) {
      console.error('[anchorCandidates] upsert update error:', error.message)
      return null
    }
    return data
  }

  // Insert new candidate
  const insertStatus: AnchorCandidateStatus =
    payload.compositeScore >= payload.thresholdAtScoring ? 'suggested' : 'pending'

  const { data, error } = await supabase
    .from('anchor_candidates')
    .insert({
      user_id:             payload.userId,
      node_id:             payload.nodeId,
      composite_score:     payload.compositeScore,
      centrality_score:    payload.centralityScore,
      diversity_score:     payload.diversityScore,
      velocity_score:      payload.velocityScore,
      richness_score:      payload.richnessScore,
      behavioural_score:   0,
      mention_count:       payload.mentionCount,
      source_count:        payload.sourceCount,
      unique_source_types: payload.uniqueSourceTypes,
      days_active:         payload.daysActive,
      recent_velocity:     payload.recentVelocity,
      velocity_direction:  payload.velocityDirection,
      status:              insertStatus,
      scoring_profile:     payload.scoringProfile,
      reasoning_text:      payload.reasoningText,
      threshold_at_scoring: payload.thresholdAtScoring,
      suggested_at:        insertStatus === 'suggested' ? now : null,
      first_scored_at:     now,
      last_scored_at:      now,
    })
    .select('id')
    .single()

  if (error) {
    console.error('[anchorCandidates] upsert insert error:', error.message)
    return null
  }
  return data
}

// ─── Update: status transition ────────────────────────────────────────────────
// Called by the Anchors page (PRD-19) when user confirms, dismisses, or archives.
// Also called by the daily scorer (PRD-18) for lifecycle transitions.

export async function updateCandidateStatus(
  candidateId: string,
  update: AnchorCandidateStatusUpdate
): Promise<boolean> {
  const payload: Record<string, unknown> = {
    status: update.status,
  }

  if (update.reviewedAt)     payload.reviewed_at    = update.reviewedAt
  if (update.dormantSince)   payload.dormant_since  = update.dormantSince
  if (update.resurface_after) payload.resurface_after = update.resurface_after
  if (update.dismissCount !== undefined) payload.dismiss_count = update.dismissCount

  const { error } = await supabase
    .from('anchor_candidates')
    .update(payload)
    .eq('id', candidateId)

  if (error) {
    console.error('[anchorCandidates] updateCandidateStatus error:', error.message)
    return false
  }
  return true
}

// ─── Confirm: promote node to anchor ─────────────────────────────────────────
// Atomically: sets candidate status to 'confirmed' AND sets
// knowledge_nodes.is_anchor = true for the associated node.
// Returns false if either operation fails (does not partially commit).

export async function confirmAnchorCandidate(
  candidateId: string,
  nodeId: string
): Promise<boolean> {
  const now = new Date().toISOString()

  // Step 1: Update knowledge_nodes
  const { error: nodeError } = await supabase
    .from('knowledge_nodes')
    .update({ is_anchor: true })
    .eq('id', nodeId)

  if (nodeError) {
    console.error('[anchorCandidates] confirmAnchorCandidate node update error:', nodeError.message)
    return false
  }

  // Step 2: Update candidate status
  const { error: candidateError } = await supabase
    .from('anchor_candidates')
    .update({
      status:      'confirmed',
      reviewed_at: now,
    })
    .eq('id', candidateId)

  if (candidateError) {
    console.error('[anchorCandidates] confirmAnchorCandidate status update error:', candidateError.message)
    // Attempt to roll back node update — best effort
    await supabase
      .from('knowledge_nodes')
      .update({ is_anchor: false })
      .eq('id', nodeId)
    return false
  }

  return true
}

// ─── Dismiss: mark as dismissed with cooldown ─────────────────────────────────

export async function dismissAnchorCandidate(
  candidateId: string,
  currentDismissCount: number,
  cooldownDays: number
): Promise<boolean> {
  const now = new Date()
  const resurface = new Date(now)
  resurface.setDate(resurface.getDate() + cooldownDays)

  return updateCandidateStatus(candidateId, {
    status:          'dismissed',
    reviewedAt:      now.toISOString(),
    resurface_after: resurface.toISOString(),
    dismissCount:    currentDismissCount + 1,
  })
}

// ─── Archive: move confirmed anchor to archived ───────────────────────────────
// Also sets knowledge_nodes.is_anchor = false.

export async function archiveAnchorCandidate(
  candidateId: string,
  nodeId: string
): Promise<boolean> {
  const now = new Date().toISOString()

  const { error: nodeError } = await supabase
    .from('knowledge_nodes')
    .update({ is_anchor: false })
    .eq('id', nodeId)

  if (nodeError) {
    console.error('[anchorCandidates] archiveAnchorCandidate node update error:', nodeError.message)
    return false
  }

  const { error } = await supabase
    .from('anchor_candidates')
    .update({ status: 'archived', reviewed_at: now })
    .eq('id', candidateId)

  if (error) {
    console.error('[anchorCandidates] archiveAnchorCandidate error:', error.message)
    return false
  }
  return true
}

// ─── Create: manual anchor (user-created, no candidate row exists) ────────────
// For when users create an anchor from scratch via the Anchors page form.
// Creates both the candidate row (in 'confirmed' status) and sets is_anchor
// on the knowledge_nodes row.

export async function createManualAnchor(
  userId: string,
  nodeId: string
): Promise<boolean> {
  const now = new Date().toISOString()

  // Set is_anchor on the node
  const { error: nodeError } = await supabase
    .from('knowledge_nodes')
    .update({ is_anchor: true })
    .eq('id', nodeId)

  if (nodeError) {
    console.error('[anchorCandidates] createManualAnchor node error:', nodeError.message)
    return false
  }

  // Create candidate row in confirmed status
  // manual anchors get composite_score = 1.0 — they're explicitly user-chosen
  const { error } = await supabase
    .from('anchor_candidates')
    .insert({
      user_id:           userId,
      node_id:           nodeId,
      composite_score:   1.0,
      centrality_score:  0,
      diversity_score:   0,
      velocity_score:    0,
      richness_score:    0,
      behavioural_score: 0,
      mention_count:     0,
      source_count:      0,
      unique_source_types: 0,
      days_active:       0,
      recent_velocity:   0,
      velocity_direction: 'stable',
      status:            'confirmed',
      scoring_profile:   'balanced',
      reasoning_text:    'Manually created by user.',
      suggested_at:      now,
      reviewed_at:       now,
      first_scored_at:   now,
      last_scored_at:    now,
    })

  if (error) {
    console.error('[anchorCandidates] createManualAnchor insert error:', error.message)
    return false
  }
  return true
}

// ─── Fetch: anchor health summary ─────────────────────────────────────────────
// Computed summary for the Anchors page right panel default state (PRD-19).

export async function fetchAnchorHealthSummary(
  userId: string
): Promise<AnchorHealthSummary> {
  const empty: AnchorHealthSummary = {
    totalConfirmed: 0,
    totalSuggested: 0,
    totalDormant: 0,
    avgNodesPerAnchor: 0,
    mostConnectedAnchor: null,
    isolatedAnchors: 0,
    staleAnchors: [],
  }

  // Fetch all confirmed + dormant candidates with node data
  const confirmed = await fetchCandidatesWithNodes(userId, ['confirmed', 'dormant'])
  const suggested = await fetchCandidatesWithNodes(userId, ['suggested'])

  if (confirmed.length === 0 && suggested.length === 0) return empty

  const dormant = confirmed.filter(c => c.status === 'dormant')
  const active  = confirmed.filter(c => c.status === 'confirmed')

  // Compute average nodes per confirmed anchor
  const totalNodes = confirmed.reduce((sum, c) => sum + c.connectionCount, 0)
  const avgNodes = confirmed.length > 0
    ? Math.round((totalNodes / confirmed.length) * 10) / 10
    : 0

  // Most connected anchor
  const sorted = [...confirmed].sort((a, b) => b.connectionCount - a.connectionCount)
  const topAnchor = sorted[0]
  const mostConnected = topAnchor?.node
    ? { label: topAnchor.node.label, nodeCount: topAnchor.connectionCount }
    : null

  // Isolated anchors: confirmed with 0 cross-anchor connections
  const isolated = confirmed.filter(c => c.anchorConnections === 0).length

  // Stale anchors: collect items needing attention
  const stale: AnchorHealthSummary['staleAnchors'] = []

  for (const c of confirmed) {
    if (!c.node) continue
    if (c.anchorConnections === 0 && c.connectionCount > 0) {
      stale.push({
        candidateId: c.id,
        nodeId: c.node.id,
        label: c.node.label,
        issue: 'isolated',
        detail: 'Not connected to any other anchors',
      })
    } else if (c.connectionCount < 3) {
      stale.push({
        candidateId: c.id,
        nodeId: c.node.id,
        label: c.node.label,
        issue: 'low_nodes',
        detail: `Only ${c.connectionCount} node${c.connectionCount === 1 ? '' : 's'} connected`,
      })
    } else if (c.status === 'dormant') {
      const dormantDays = c.dormantSince
        ? Math.floor((Date.now() - new Date(c.dormantSince).getTime()) / 86400000)
        : 0
      stale.push({
        candidateId: c.id,
        nodeId: c.node.id,
        label: c.node.label,
        issue: 'dormant',
        detail: `No new content in ${dormantDays} days`,
      })
    } else if (c.sourceCount === 1) {
      stale.push({
        candidateId: c.id,
        nodeId: c.node.id,
        label: c.node.label,
        issue: 'single_source',
        detail: 'Only referenced in one source',
      })
    }
  }

  return {
    totalConfirmed: active.length,
    totalSuggested: suggested.length,
    totalDormant:   dormant.length,
    avgNodesPerAnchor: avgNodes,
    mostConnectedAnchor: mostConnected,
    isolatedAnchors: isolated,
    staleAnchors: stale.slice(0, 8), // Cap at 8 items for the UI
  }
}

// ─── Helpers: connection count queries ────────────────────────────────────────
// Fetches edge counts for a batch of node IDs in two queries.

async function fetchConnectionCounts(
  nodeIds: string[]
): Promise<Record<string, number>> {
  if (nodeIds.length === 0) return {}

  const [outgoing, incoming] = await Promise.all([
    supabase
      .from('knowledge_edges')
      .select('source_node_id')
      .in('source_node_id', nodeIds),
    supabase
      .from('knowledge_edges')
      .select('target_node_id')
      .in('target_node_id', nodeIds),
  ])

  const counts: Record<string, number> = {}
  for (const id of nodeIds) counts[id] = 0

  for (const row of outgoing.data ?? []) {
    counts[row.source_node_id] = (counts[row.source_node_id] ?? 0) + 1
  }
  for (const row of incoming.data ?? []) {
    counts[row.target_node_id] = (counts[row.target_node_id] ?? 0) + 1
  }

  return counts
}

async function fetchAnchorConnectionCounts(
  userId: string,
  nodeIds: string[]
): Promise<Record<string, number>> {
  if (nodeIds.length === 0) return {}

  // Get all anchor node IDs for this user
  const { data: anchorNodes } = await supabase
    .from('knowledge_nodes')
    .select('id')
    .eq('user_id', userId)
    .eq('is_anchor', true)

  const anchorIds = new Set((anchorNodes ?? []).map(n => n.id))

  const [outgoing, incoming] = await Promise.all([
    supabase
      .from('knowledge_edges')
      .select('source_node_id, target_node_id')
      .in('source_node_id', nodeIds),
    supabase
      .from('knowledge_edges')
      .select('source_node_id, target_node_id')
      .in('target_node_id', nodeIds),
  ])

  const counts: Record<string, number> = {}
  for (const id of nodeIds) counts[id] = 0

  for (const row of outgoing.data ?? []) {
    if (anchorIds.has(row.target_node_id)) {
      counts[row.source_node_id] = (counts[row.source_node_id] ?? 0) + 1
    }
  }
  for (const row of incoming.data ?? []) {
    if (anchorIds.has(row.source_node_id)) {
      counts[row.target_node_id] = (counts[row.target_node_id] ?? 0) + 1
    }
  }

  return counts
}
```

---

## 7. Type Index Update

**File modified:** `src/types/index.ts`

Add the following exports:

```typescript
export type {
  AnchorCandidateStatus,
  AnchorScoringProfile,
  VelocityDirection,
  AnchorCandidate,
  AnchorCandidateWithNode,
  AnchorUserConfig,
  AnchorCandidateUpsert,
  AnchorCandidateStatusUpdate,
  AnchorHealthSummary,
  SignalWeights,
  ThresholdPreset,
} from './anchors'

export {
  SCORING_PROFILE_LABELS,
  SCORING_PROFILE_DESCRIPTIONS,
  SIGNAL_WEIGHTS_BY_PROFILE,
  DEFAULT_ANCHOR_USER_CONFIG,
  THRESHOLD_PRESETS,
} from './anchors'

export type { AnchorCandidateRow } from './database'
```

---

## 8. Forward-Compatible Decisions

- **`node_id` is nullable** (`ON DELETE SET NULL`) so candidate history is preserved if the underlying node is deleted. PRD-18 and PRD-19 must always null-check `candidate.node` before rendering.

- **`behavioural_score` column exists but is always 0.** PRD-18 will write zeros here. The column is present so Phase 2 (behavioural signals from click tracking) requires no schema migration — just start populating it.

- **`scoring_profile` is stored per-row**, not just in user config. This allows the daily scorer (PRD-18) to detect when a user has changed their profile and re-score all candidates using the new weights without needing to re-run the full signal computation.

- **`upsertAnchorCandidate` never downgrades status from confirmed/dismissed/archived/dormant.** This is enforced in the service layer, not in SQL, so PRD-18 can call upsert freely without worrying about accidentally overwriting a user decision.

- **`createManualAnchor` sets `composite_score = 1.0`** so manually created anchors sort to the top of any score-ordered query and are never auto-dismissed by the lifecycle engine.

- **`AnchorUserConfig` lives in `user_profiles.processing_preferences`** (existing JSONB column). No new column needed. PRD-19 will read/write `processing_preferences.anchor_settings` using the existing `updateProfile` service function. PRD-18 reads this config at scoring time to get the active threshold and profile.

---

## 9. Edge Cases and Error Handling

- **Node deleted after candidate created**: `node_id` becomes null via `ON DELETE SET NULL`. Service functions must null-check `candidate.node`. The Anchors page (PRD-19) renders these as "orphaned" candidates with a "Source node was deleted" note and a Dismiss action.

- **Duplicate candidates for same node**: The `fetchCandidateByNodeId` check in `upsertAnchorCandidate` prevents duplicates. However, if two scoring runs fire concurrently (post-extraction + daily cron at same time), there is a race window. A `UNIQUE (user_id, node_id)` constraint is intentionally omitted from the migration because candidates with `node_id = null` (orphaned) would violate it. The service-layer check is sufficient.

- **Empty graph (new user)**: All fetch functions return empty arrays gracefully. `fetchAnchorHealthSummary` returns the `empty` object. No errors thrown.

- **Supabase RLS failure**: All service functions log the error and return `null`/`false`/`[]` — never throw. Callers (hooks in PRD-19) handle null returns by showing appropriate empty states.

- **`confirmAnchorCandidate` partial failure**: If the node update succeeds but the candidate status update fails, the function attempts to roll back `is_anchor` on the node. This is best-effort — network failures can still leave the node as an anchor without a confirmed candidate row. PRD-18's daily scorer will detect this inconsistency and heal it by creating a new confirmed candidate row for any `is_anchor = true` node that has no corresponding confirmed candidate.

---

## 10. Acceptance Criteria

- [ ] Migration file exists at `supabase/migrations/20260315_prd17_anchor_candidates.sql` and applies cleanly against the existing database without errors
- [ ] `anchor_candidates` table exists in Supabase with all columns, correct types, and correct constraints
- [ ] Both enum types (`anchor_candidate_status`, `anchor_scoring_profile`) exist in Postgres
- [ ] All four RLS policies are active on the table
- [ ] The `updated_at` trigger fires correctly on any row update
- [ ] All five indexes exist and are confirmed in the Supabase dashboard
- [ ] `src/types/anchors.ts` is created and compiles with zero TypeScript errors in strict mode
- [ ] `src/types/database.ts` contains `AnchorCandidateRow` and compiles cleanly
- [ ] `src/types/index.ts` exports all new types and constants
- [ ] `src/services/anchorCandidates.ts` is created and compiles with zero TypeScript errors
- [ ] Calling `fetchCandidatesWithNodes(userId, ['suggested'])` against the live database returns an empty array (not an error) since no candidates exist yet
- [ ] Calling `upsertAnchorCandidate` with a valid payload inserts a new row and returns `{ id: string }`
- [ ] Calling `confirmAnchorCandidate` sets both `is_anchor = true` on the node and `status = 'confirmed'` on the candidate
- [ ] Calling `dismissAnchorCandidate` sets `resurface_after` to the correct future date
- [ ] No existing tests or TypeScript files are broken by the additions to `database.ts` and `index.ts`
