-- ─── Stage 9: Anchor Scoring Bulk Operations ─────────────────────────────────
-- Migration: 20260428_anchor_scoring_bulk_ops
-- Purpose: Replace per-row UPDATE loops in anchor scoring with single bulk ops.
-- Removes the n-query read pattern in dormancy checks and the per-row upsert loop.

-- ─── 1. Unique constraint on anchor_candidates(user_id, node_id) ──────────────
-- Required for ON CONFLICT in bulk_upsert_anchor_candidates.
-- If it already exists (from a prior migration), this is a no-op.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'anchor_candidates'::regclass
      AND conname = 'anchor_candidates_user_id_node_id_key'
  ) THEN
    ALTER TABLE anchor_candidates
      ADD CONSTRAINT anchor_candidates_user_id_node_id_key UNIQUE (user_id, node_id);
  END IF;
END $$;

-- ─── 2. bulk_upsert_anchor_candidates ─────────────────────────────────────────
-- Accepts a JSON array of candidate rows. Upserts them all in one statement.
-- On conflict (same user_id + node_id) updates score fields but preserves status
-- for protected rows (dismissed, archived, dormant, confirmed). When a candidate
-- lands in 'confirmed' status — whether via insert or status upgrade — this
-- function also sets knowledge_nodes.is_anchor = true in the same transaction.
--
-- Returns the number of anchor_candidates rows affected.

CREATE OR REPLACE FUNCTION bulk_upsert_anchor_candidates(
  p_user_id   UUID,
  p_candidates JSONB        -- jsonb array of candidate objects
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  WITH upserted AS (
    INSERT INTO anchor_candidates (
      user_id, node_id,
      composite_score, centrality_score, diversity_score,
      velocity_score, richness_score, behavioural_score,
      mention_count, source_count, unique_source_types,
      days_active, recent_velocity, velocity_direction,
      status, scoring_profile, reasoning_text,
      threshold_at_scoring, suggested_at, reviewed_at,
      first_scored_at, last_scored_at
    )
    SELECT
      p_user_id,
      (c->>'node_id')::UUID,
      (c->>'composite_score')::FLOAT,
      (c->>'centrality_score')::FLOAT,
      (c->>'diversity_score')::FLOAT,
      (c->>'velocity_score')::FLOAT,
      (c->>'richness_score')::FLOAT,
      COALESCE((c->>'behavioural_score')::FLOAT, 0),
      (c->>'mention_count')::INTEGER,
      (c->>'source_count')::INTEGER,
      (c->>'unique_source_types')::INTEGER,
      (c->>'days_active')::INTEGER,
      (c->>'recent_velocity')::FLOAT,
      c->>'velocity_direction',
      (c->>'status')::anchor_candidate_status,
      (c->>'scoring_profile')::anchor_scoring_profile,
      c->>'reasoning_text',
      (c->>'threshold_at_scoring')::FLOAT,
      NULLIF(c->>'suggested_at', '')::TIMESTAMPTZ,
      NULLIF(c->>'reviewed_at', '')::TIMESTAMPTZ,
      COALESCE(NULLIF(c->>'first_scored_at', '')::TIMESTAMPTZ, NOW()),
      NOW()
    FROM jsonb_array_elements(p_candidates) AS c
    ON CONFLICT (user_id, node_id) DO UPDATE SET
      composite_score      = EXCLUDED.composite_score,
      centrality_score     = EXCLUDED.centrality_score,
      diversity_score      = EXCLUDED.diversity_score,
      velocity_score       = EXCLUDED.velocity_score,
      richness_score       = EXCLUDED.richness_score,
      mention_count        = EXCLUDED.mention_count,
      source_count         = EXCLUDED.source_count,
      unique_source_types  = EXCLUDED.unique_source_types,
      days_active          = EXCLUDED.days_active,
      recent_velocity      = EXCLUDED.recent_velocity,
      velocity_direction   = EXCLUDED.velocity_direction,
      scoring_profile      = EXCLUDED.scoring_profile,
      reasoning_text       = EXCLUDED.reasoning_text,
      threshold_at_scoring = EXCLUDED.threshold_at_scoring,
      last_scored_at       = NOW(),
      -- Status rules: dismissed/archived are immutable.
      -- dormant stays dormant unless we're explicitly confirming.
      -- confirmed stays confirmed (score updates, not demotions).
      -- pending/suggested accept the new status.
      status = CASE
        WHEN anchor_candidates.status IN ('dismissed', 'archived')
          THEN anchor_candidates.status
        WHEN anchor_candidates.status = 'dormant' AND EXCLUDED.status != 'confirmed'
          THEN anchor_candidates.status
        WHEN anchor_candidates.status = 'confirmed'
          THEN anchor_candidates.status
        ELSE EXCLUDED.status
      END,
      -- suggested_at: set once when first promoted; never cleared by scoring.
      suggested_at = CASE
        WHEN anchor_candidates.suggested_at IS NULL THEN EXCLUDED.suggested_at
        ELSE anchor_candidates.suggested_at
      END,
      -- reviewed_at: set when we confirm; preserve otherwise.
      reviewed_at = CASE
        WHEN EXCLUDED.reviewed_at IS NOT NULL THEN EXCLUDED.reviewed_at
        ELSE anchor_candidates.reviewed_at
      END,
      -- first_scored_at: preserve existing value (set on first score, immutable after).
      first_scored_at = CASE
        WHEN anchor_candidates.first_scored_at IS NOT NULL THEN anchor_candidates.first_scored_at
        ELSE EXCLUDED.first_scored_at
      END
    RETURNING node_id, status
  ),
  -- Propagate is_anchor=true for any candidate that reached 'confirmed' status.
  _anchor_update AS (
    UPDATE knowledge_nodes
    SET is_anchor = true
    WHERE user_id = p_user_id
      AND id IN (SELECT node_id FROM upserted WHERE status = 'confirmed')
  )
  SELECT COUNT(*) INTO v_count FROM upserted;

  RETURN v_count;
END;
$$;

-- ─── 3. bulk_anchor_dormancy_transitions ──────────────────────────────────────
-- Replaces the two per-row loops in runLifecycleTransitions that check each
-- confirmed anchor's edge recency and each dormant anchor's re-activation.
-- Runs both transitions in a single SQL pass per user.
--
-- p_dormant_cutoff: any confirmed anchor with no edges newer than this → dormant.
-- Returns JSON: { marked_dormant, reactivated }

CREATE OR REPLACE FUNCTION bulk_anchor_dormancy_transitions(
  p_user_id        UUID,
  p_dormant_cutoff TIMESTAMPTZ
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
  v_marked_dormant INTEGER := 0;
  v_reactivated    INTEGER := 0;
BEGIN
  -- Mark confirmed anchors as dormant when they have no edges newer than cutoff.
  UPDATE anchor_candidates ac
  SET
    status       = 'dormant',
    dormant_since = NOW()
  WHERE ac.user_id = p_user_id
    AND ac.status  = 'confirmed'
    AND ac.node_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM knowledge_edges ke
      WHERE ke.user_id = p_user_id
        AND (ke.source_node_id = ac.node_id OR ke.target_node_id = ac.node_id)
        AND ke.created_at > p_dormant_cutoff
    );
  GET DIAGNOSTICS v_marked_dormant = ROW_COUNT;

  -- Re-activate dormant anchors that have received new edges since going dormant.
  UPDATE anchor_candidates ac
  SET
    status        = 'confirmed',
    dormant_since = NULL
  WHERE ac.user_id     = p_user_id
    AND ac.status      = 'dormant'
    AND ac.dormant_since IS NOT NULL
    AND ac.node_id IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM knowledge_edges ke
      WHERE ke.user_id = p_user_id
        AND (ke.source_node_id = ac.node_id OR ke.target_node_id = ac.node_id)
        AND ke.created_at > ac.dormant_since
    );
  GET DIAGNOSTICS v_reactivated = ROW_COUNT;

  RETURN json_build_object(
    'marked_dormant', v_marked_dormant,
    'reactivated',    v_reactivated
  );
END;
$$;
