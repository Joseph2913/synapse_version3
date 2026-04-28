-- Stage 0 Item 5 — Failure-handling policy
-- Adds a `status` column to knowledge_sources reflecting the source state machine
-- defined in docs/FAILURE-POLICY.md.
--
-- State machine:
--   pending → chunking → extracting → augmenting → complete | failed | degraded
--
-- Default for existing rows is 'complete' so the migration is non-destructive:
-- every source already in the table is treated as having reached the terminal
-- success state. New sources start at 'pending' and progress as the pipeline
-- writes status updates.

BEGIN;

-- 1. Add the column with a permissive default for existing rows.
ALTER TABLE knowledge_sources
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'complete';

-- 2. Constrain valid values. Failure to add this constraint should not block
--    deployment; if a future state needs to be added, drop and recreate this
--    constraint in a follow-up migration.
ALTER TABLE knowledge_sources
  DROP CONSTRAINT IF EXISTS knowledge_sources_status_check;

ALTER TABLE knowledge_sources
  ADD CONSTRAINT knowledge_sources_status_check
  CHECK (status IN ('pending', 'chunking', 'extracting', 'augmenting', 'complete', 'failed', 'degraded'));

-- 3. Index for fast filtering by status (e.g. retry-degraded job, health snapshots).
CREATE INDEX IF NOT EXISTS idx_knowledge_sources_status_user
  ON knowledge_sources (user_id, status);

-- 4. Index for ordering degraded/failed sources by recency (retry queue).
CREATE INDEX IF NOT EXISTS idx_knowledge_sources_status_created_at
  ON knowledge_sources (status, created_at DESC)
  WHERE status IN ('degraded', 'failed', 'pending');

COMMIT;

-- Verification (run manually after applying):
--   SELECT status, count(*) FROM knowledge_sources GROUP BY status;
--   -- Expected: all rows show status='complete' on first run.
