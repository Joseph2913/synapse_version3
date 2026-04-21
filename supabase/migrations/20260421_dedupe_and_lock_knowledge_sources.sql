-- Migration: dedupe knowledge_sources + add UNIQUE constraint
-- Purpose: The YouTube extraction cron had a race condition + 5-minute
-- "stuck item" reset that, combined with no database-level uniqueness,
-- produced many duplicate knowledge_sources rows for the same video
-- (same user_id + same source_url inserted repeatedly). This migration:
--   1. Picks the earliest row in each duplicate group as the canonical one.
--   2. Deletes the later duplicate rows, along with their knowledge_nodes
--      and knowledge_edges (each duplicate extraction created its own
--      parallel set of nodes/edges, all redundant).
--   3. Adds a UNIQUE constraint on (user_id, source_type, source_url) so
--      a duplicate can never be inserted again — the database itself will
--      reject it regardless of any future code bug.
--
-- Scope: applies to all source_types, not just YouTube. The root cause is
-- specific to YouTube but a global uniqueness guarantee is cheap insurance.

BEGIN;

-- ── Step 1: Identify the canonical (earliest) row per duplicate group ─────
-- Only consider groups where source_url is present (NULL source_urls would
-- all collide in a unique constraint, so we exclude them from dedup and from
-- the constraint via a partial index below).

CREATE TEMP TABLE source_dedup_plan AS
SELECT
  id,
  user_id,
  source_type,
  source_url,
  ROW_NUMBER() OVER (
    PARTITION BY user_id, source_type, source_url
    ORDER BY created_at ASC, id ASC
  ) AS rn
FROM knowledge_sources
WHERE source_url IS NOT NULL;

-- Victims = every duplicate row that is NOT the earliest in its group.
CREATE TEMP TABLE duplicate_source_ids AS
SELECT id FROM source_dedup_plan WHERE rn > 1;

-- ── Step 2: Delete edges that touch nodes on victim sources ───────────────

DELETE FROM knowledge_edges
WHERE source_node_id IN (
  SELECT id FROM knowledge_nodes
  WHERE source_id IN (SELECT id FROM duplicate_source_ids)
)
OR target_node_id IN (
  SELECT id FROM knowledge_nodes
  WHERE source_id IN (SELECT id FROM duplicate_source_ids)
);

-- ── Step 3: Delete nodes belonging to victim sources ──────────────────────

DELETE FROM knowledge_nodes
WHERE source_id IN (SELECT id FROM duplicate_source_ids);

-- ── Step 4: Delete any extraction_sessions pointing at victim sources ─────
-- (best effort — ignore error if the column/table doesn't exist)

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'extraction_sessions' AND column_name = 'source_id'
  ) THEN
    EXECUTE 'DELETE FROM extraction_sessions WHERE source_id IN (SELECT id FROM duplicate_source_ids)';
  END IF;
END $$;

-- ── Step 5: Null out any youtube_ingestion_queue rows that point at victim sources ─
-- (so we don't leave dangling foreign-key-like references)

UPDATE youtube_ingestion_queue
SET source_id = NULL
WHERE source_id IN (SELECT id FROM duplicate_source_ids);

-- ── Step 6: Delete the victim sources themselves ──────────────────────────

DELETE FROM knowledge_sources
WHERE id IN (SELECT id FROM duplicate_source_ids);

-- ── Step 7: Add the uniqueness guarantee ──────────────────────────────────
-- Use a partial unique index that ignores NULL source_urls. This is the
-- "filing cabinet lock" — Postgres will reject any second insert of the
-- same (user_id, source_type, source_url) triple regardless of the code.

CREATE UNIQUE INDEX IF NOT EXISTS knowledge_sources_user_type_url_uniq
  ON knowledge_sources (user_id, source_type, source_url)
  WHERE source_url IS NOT NULL;

COMMIT;
