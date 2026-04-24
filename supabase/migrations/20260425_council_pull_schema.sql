-- 20260425_council_pull_schema.sql
-- Council question lifecycle (Step 2): extend agent_standing_questions for pull-based answer matching.

BEGIN;

-- 1. Add embedding column for semantic matching of questions against source chunks.
--    pgvector 0.8.0 caps HNSW/IVFFlat indexes at 2000 dims, so no ANN index here.
--    With ~400 questions total, sequential scan over cosine similarity is fast enough.
ALTER TABLE agent_standing_questions
  ADD COLUMN IF NOT EXISTS embedding VECTOR(3072);

-- 2. Convert addressing_evidence from TEXT to JSONB.
--    54 rows today have legacy prose evidence (written by an earlier experiment) but none
--    have populated addressing_source_ids, so we preserve the prose as a single legacy entry
--    in a JSONB array. Going forward, Phase 0 appends structured entries per source.
ALTER TABLE agent_standing_questions
  ALTER COLUMN addressing_evidence TYPE JSONB
  USING CASE
    WHEN addressing_evidence IS NULL THEN NULL
    ELSE jsonb_build_array(jsonb_build_object(
      'source_id', NULL,
      'verdict', 'legacy',
      'snippet', addressing_evidence,
      'confidence', NULL,
      'checked_at', NULL,
      'legacy', TRUE
    ))
  END;

-- 3. Partial index for pull-path lookups: fetching open/partially_addressed questions per agent.
CREATE INDEX IF NOT EXISTS idx_asq_agent_open
  ON agent_standing_questions (agent_id)
  WHERE status IN ('open', 'partially_addressed');

COMMIT;
