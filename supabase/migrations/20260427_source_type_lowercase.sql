-- Stage 2: rename source_type values to lowercase across all three tables that
-- carry the column (knowledge_sources, knowledge_nodes, extraction_sessions).
--
-- Rationale (D-006 + Stage 2 plan): Stage 1 adapters produce a lowercase
-- CaptureSourceType (paste|url|file|youtube|meeting). Stage 2 owns the
-- persistence boundary and is the natural home for retiring the legacy
-- mixed-case strings ('Note', 'Web', 'Document', 'YouTube', 'Meeting',
-- 'Research', 'GitHub'). After this migration, every row has a lowercase
-- source_type and every read/write site in the codebase uses the lowercase
-- form. No schema changes — data only — except for three RPC bodies whose
-- COALESCE defaults were 'Note' / 'Document' and now have to be 'paste' /
-- 'file' to match.
--
-- Mapping:
--   'Note'      → 'paste'
--   'Web'       → 'url'      (no rows expected; safety statement only)
--   'Document'  → 'file'
--   'YouTube'   → 'youtube'
--   'Meeting'   → 'meeting'
--   'Research'  → 'research'
--   'GitHub'    → 'github'

-- ── knowledge_sources ────────────────────────────────────────────────────────
UPDATE knowledge_sources SET source_type = 'paste'    WHERE source_type = 'Note';
UPDATE knowledge_sources SET source_type = 'url'      WHERE source_type = 'Web';
UPDATE knowledge_sources SET source_type = 'file'     WHERE source_type = 'Document';
UPDATE knowledge_sources SET source_type = 'youtube'  WHERE source_type = 'YouTube';
UPDATE knowledge_sources SET source_type = 'meeting'  WHERE source_type = 'Meeting';
UPDATE knowledge_sources SET source_type = 'research' WHERE source_type = 'Research';
UPDATE knowledge_sources SET source_type = 'github'   WHERE source_type = 'GitHub';

-- ── knowledge_nodes ──────────────────────────────────────────────────────────
UPDATE knowledge_nodes SET source_type = 'paste'    WHERE source_type = 'Note';
UPDATE knowledge_nodes SET source_type = 'url'      WHERE source_type = 'Web';
UPDATE knowledge_nodes SET source_type = 'file'     WHERE source_type = 'Document';
UPDATE knowledge_nodes SET source_type = 'youtube'  WHERE source_type = 'YouTube';
UPDATE knowledge_nodes SET source_type = 'meeting'  WHERE source_type = 'Meeting';
UPDATE knowledge_nodes SET source_type = 'research' WHERE source_type = 'Research';
UPDATE knowledge_nodes SET source_type = 'github'   WHERE source_type = 'GitHub';

-- ── extraction_sessions ──────────────────────────────────────────────────────
UPDATE extraction_sessions SET source_type = 'paste'    WHERE source_type = 'Note';
UPDATE extraction_sessions SET source_type = 'url'      WHERE source_type = 'Web';
UPDATE extraction_sessions SET source_type = 'file'     WHERE source_type = 'Document';
UPDATE extraction_sessions SET source_type = 'youtube'  WHERE source_type = 'YouTube';
UPDATE extraction_sessions SET source_type = 'meeting'  WHERE source_type = 'Meeting';
UPDATE extraction_sessions SET source_type = 'research' WHERE source_type = 'Research';
UPDATE extraction_sessions SET source_type = 'github'   WHERE source_type = 'GitHub';

-- ── RPC defaults ─────────────────────────────────────────────────────────────
-- The three explore/graph RPCs use COALESCE(source_type, '<default>') to fill
-- in NULL. Update the defaults to the lowercase form so a missing source_type
-- doesn't reintroduce mixed-case into the output JSON. We re-issue each
-- function via a thin patch (UPDATE pg_proc would be brittle).

-- get_explore_source_graph_v2: was 'Note', now 'paste'
DO $$
DECLARE
  src text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO src
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'get_explore_source_graph_v2';
  IF src IS NOT NULL THEN
    src := replace(src, 'COALESCE(s.source_type, ''Note'')', 'COALESCE(s.source_type, ''paste'')');
    EXECUTE src;
  END IF;
END $$;

-- get_explore_source_graph: was 'Note', now 'paste'
DO $$
DECLARE
  src text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO src
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'get_explore_source_graph';
  IF src IS NOT NULL THEN
    src := replace(src, 'COALESCE(s.source_type, ''Note'')', 'COALESCE(s.source_type, ''paste'')');
    EXECUTE src;
  END IF;
END $$;

-- get_all_sources_graph: was 'Document', now 'file'
DO $$
DECLARE
  src text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO src
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'get_all_sources_graph';
  IF src IS NOT NULL THEN
    src := replace(src, 'COALESCE(s.source_type, ''Document'')', 'COALESCE(s.source_type, ''file'')');
    EXECUTE src;
  END IF;
END $$;

-- ── Verification (raises notice with remaining mixed-case row counts) ────────
DO $$
DECLARE
  rem_sources   int;
  rem_nodes     int;
  rem_sessions  int;
BEGIN
  SELECT count(*) INTO rem_sources  FROM knowledge_sources    WHERE source_type IN ('Note','Web','Document','YouTube','Meeting','Research','GitHub');
  SELECT count(*) INTO rem_nodes    FROM knowledge_nodes      WHERE source_type IN ('Note','Web','Document','YouTube','Meeting','Research','GitHub');
  SELECT count(*) INTO rem_sessions FROM extraction_sessions  WHERE source_type IN ('Note','Web','Document','YouTube','Meeting','Research','GitHub');
  RAISE NOTICE 'source_type rename: knowledge_sources remaining mixed-case = %, knowledge_nodes = %, extraction_sessions = %',
    rem_sources, rem_nodes, rem_sessions;
END $$;
