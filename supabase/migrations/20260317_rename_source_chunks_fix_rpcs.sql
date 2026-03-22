-- ============================================================
-- Hotfix: Rename knowledge_source_chunks → source_chunks + fix RPCs
-- Date: March 17, 2026
-- ============================================================
--
-- ROOT CAUSE:
-- The database table was named `knowledge_source_chunks` but the entire
-- application codebase referenced `source_chunks`. Supabase PostgREST
-- silently returns empty results when querying a nonexistent table through
-- the client SDK with RLS enabled, so no errors surfaced.
--
-- IMPACT (Feb 22 – March 17, 2026):
-- - All chunk writes during Quick Capture ingestion silently failed
-- - All RAG chunk retrieval queries returned empty arrays
-- - 102 sources ingested during this period have zero chunks
-- - The `match_source_chunks` and `match_chunks` RPCs referenced the old name
--
-- TIMELINE:
-- - Jan 12 – Feb 15: 100% chunk coverage (names aligned)
-- - Feb 22 – Feb 27: Intermittent failures (~50% success)
-- - March 1 – March 17: 0% chunk coverage (complete failure)
--
-- RESOLUTION:
-- 1. Table renamed (this migration)
-- 2. RPC functions updated to reference new name (this migration)
-- 3. 102 sources backfilled with chunks and embeddings (backfill script)
-- 4. Ingestion pipeline hardened to save chunks even if embedding fails
--    (src/hooks/useExtraction.ts)
-- ============================================================


-- ────────────────────────────────────────────────────────────
-- STEP 1: Rename table
-- RLS policies auto-migrate with the rename.
-- ────────────────────────────────────────────────────────────

ALTER TABLE IF EXISTS knowledge_source_chunks RENAME TO source_chunks;


-- ────────────────────────────────────────────────────────────
-- STEP 2: Fix match_source_chunks RPC
-- Used by semanticSearchChunks() in the RAG pipeline.
-- ────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION match_source_chunks(
  query_embedding vector(3072),
  match_threshold float,
  match_count int,
  p_user_id uuid
)
RETURNS TABLE (
  id uuid,
  source_id uuid,
  chunk_index int,
  content text,
  similarity float
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
  SELECT
    sc.id,
    sc.source_id,
    sc.chunk_index,
    sc.content,
    1 - (sc.embedding <=> query_embedding) AS similarity
  FROM source_chunks sc
  WHERE sc.user_id = p_user_id
    AND sc.embedding IS NOT NULL
    AND 1 - (sc.embedding <=> query_embedding) > match_threshold
  ORDER BY sc.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;


-- ────────────────────────────────────────────────────────────
-- STEP 3: Fix match_chunks RPC
-- Secondary vector search function.
-- ────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION match_chunks(
  query_embedding vector(3072),
  match_threshold float,
  match_count int,
  filter_source_ids uuid[] DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  source_id uuid,
  chunk_index int,
  content text,
  similarity float
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
  SELECT ksc.id, ksc.source_id, ksc.chunk_index, ksc.content,
    1 - (ksc.embedding <=> query_embedding) AS similarity
  FROM source_chunks ksc
  WHERE 1 - (ksc.embedding <=> query_embedding) > match_threshold
    AND (filter_source_ids IS NULL OR ksc.source_id = ANY(filter_source_ids))
  ORDER BY ksc.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;


-- ────────────────────────────────────────────────────────────
-- VALIDATION
-- ────────────────────────────────────────────────────────────

-- 1. Table exists with new name
-- SELECT table_name FROM information_schema.tables
-- WHERE table_schema = 'public' AND table_name = 'source_chunks';
-- Expected: 1 row

-- 2. Old table name is gone
-- SELECT table_name FROM information_schema.tables
-- WHERE table_schema = 'public' AND table_name = 'knowledge_source_chunks';
-- Expected: 0 rows

-- 3. RLS policies migrated
-- SELECT policyname, tablename FROM pg_policies WHERE tablename = 'source_chunks';
-- Expected: 4 rows

-- 4. RPCs reference correct table
-- SELECT routine_name, routine_definition FROM information_schema.routines
-- WHERE routine_schema = 'public'
-- AND routine_name IN ('match_source_chunks', 'match_chunks');
-- Expected: neither definition contains 'knowledge_source_chunks'
