-- Migration: add contradicts_insight_id link to agent_insights
-- Purpose: Phase 0 tension detection writes new `tension` insights that
-- directly contradict an existing active insight. This column preserves the
-- link so the Digest / UI can show "Tension: <new claim> vs. <parent claim>"
-- as a bidirectional pair.
--
-- Nullable + ON DELETE SET NULL mirrors trigger_source_id's behaviour.
-- Only populated when insight_type = 'tension' and the tension was born from
-- Phase 0 contradiction detection. Older tensions (from expertise rebuild)
-- remain with NULL here.

ALTER TABLE agent_insights
  ADD COLUMN IF NOT EXISTS contradicts_insight_id UUID
    REFERENCES agent_insights(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_ai_contradicts_insight_id
  ON agent_insights(contradicts_insight_id)
  WHERE contradicts_insight_id IS NOT NULL;
