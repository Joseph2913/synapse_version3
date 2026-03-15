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
