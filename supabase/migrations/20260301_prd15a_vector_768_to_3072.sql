-- ============================================================
-- PRD-15A: Vector Embedding Schema Migration (768 → 3072)
-- Run each numbered step independently in Supabase SQL Editor.
-- Verify the check query after each step before proceeding.
-- ============================================================
--
-- HISTORICAL NOTE (March 17, 2026):
-- This migration references `knowledge_source_chunks` throughout.
-- That table has since been renamed to `source_chunks` to match the
-- application codebase. See 20260317_rename_source_chunks_fix_rpcs.sql.
-- The SQL below is preserved as-is since it was already executed.
-- ============================================================


-- ────────────────────────────────────────────────────────────
-- STEP 1: Drop existing embedding indexes
-- ────────────────────────────────────────────────────────────

DROP INDEX IF EXISTS knowledge_nodes_embedding_idx;
DROP INDEX IF EXISTS chunks_embedding_idx;

-- Verify (should return 0 rows):
-- SELECT indexname FROM pg_indexes WHERE indexdef LIKE '%embedding%';


-- ────────────────────────────────────────────────────────────
-- STEP 2: Alter embedding columns from vector(768) to vector(3072)
-- PostgreSQL cannot change vector dimensions in-place; drop + recreate.
-- WARNING: This permanently deletes all existing 768-dim embeddings.
-- ────────────────────────────────────────────────────────────

ALTER TABLE knowledge_nodes DROP COLUMN IF EXISTS embedding;
ALTER TABLE knowledge_nodes ADD COLUMN embedding vector(3072);

ALTER TABLE knowledge_source_chunks DROP COLUMN IF EXISTS embedding;
ALTER TABLE knowledge_source_chunks ADD COLUMN embedding vector(3072);

-- Verify columns exist as vector type (should return 2 rows, udt_name = 'vector'):
-- SELECT table_name, column_name, udt_name
-- FROM information_schema.columns
-- WHERE table_name IN ('knowledge_nodes', 'knowledge_source_chunks')
--   AND column_name = 'embedding';

-- Verify all embeddings are NULL (has_embedding should be 0 for both):
-- SELECT
--   'knowledge_source_chunks' AS tbl, COUNT(embedding) AS has_embedding
-- FROM knowledge_source_chunks
-- UNION ALL
-- SELECT 'knowledge_nodes', COUNT(embedding) FROM knowledge_nodes;


-- ────────────────────────────────────────────────────────────
-- STEP 3: Drop old match_nodes RPC (768-dim, no user_id filter)
-- ────────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS match_nodes(vector, float, int) CASCADE;
DROP FUNCTION IF EXISTS match_nodes(vector(768), float, int) CASCADE;
DROP FUNCTION IF EXISTS match_nodes CASCADE;

-- Verify (should return 0 rows):
-- SELECT routine_name FROM information_schema.routines
-- WHERE routine_schema = 'public' AND routine_name = 'match_nodes';


-- ────────────────────────────────────────────────────────────
-- STEP 4: Create match_source_chunks RPC (3072-dim, user-scoped)
-- Used by the RAG pipeline for semantic chunk retrieval.
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
  FROM knowledge_source_chunks sc
  WHERE sc.user_id = p_user_id
    AND sc.embedding IS NOT NULL
    AND 1 - (sc.embedding <=> query_embedding) > match_threshold
  ORDER BY sc.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- Verify (should return 1 row, data_type = 'record'):
-- SELECT routine_name, data_type
-- FROM information_schema.routines
-- WHERE routine_schema = 'public' AND routine_name = 'match_source_chunks';


-- ────────────────────────────────────────────────────────────
-- STEP 5: Create match_knowledge_nodes RPC (3072-dim, user-scoped)
-- Used for semantic node retrieval in the RAG pipeline.
-- ────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION match_knowledge_nodes(
  query_embedding vector(3072),
  match_threshold float,
  match_count int,
  p_user_id uuid
)
RETURNS TABLE (
  id uuid,
  label text,
  entity_type text,
  description text,
  similarity float
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
  SELECT
    kn.id,
    kn.label,
    kn.entity_type,
    kn.description,
    1 - (kn.embedding <=> query_embedding) AS similarity
  FROM knowledge_nodes kn
  WHERE kn.user_id = p_user_id
    AND kn.embedding IS NOT NULL
    AND 1 - (kn.embedding <=> query_embedding) > match_threshold
  ORDER BY kn.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- Verify (should return 2 rows):
-- SELECT routine_name FROM information_schema.routines
-- WHERE routine_schema = 'public'
--   AND routine_name IN ('match_source_chunks', 'match_knowledge_nodes');


-- ────────────────────────────────────────────────────────────
-- STEP 6: Create HNSW indexes for 3072-dim vectors
-- HNSW is preferred over IVFFlat for high-dimensional vectors
-- (no training data required, better recall at query time).
-- Note: indexes build instantly on empty columns; they will be
-- populated automatically as PRD-15B inserts embeddings.
-- ────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_source_chunks_embedding_hnsw
  ON knowledge_source_chunks USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

CREATE INDEX IF NOT EXISTS idx_knowledge_nodes_embedding_hnsw
  ON knowledge_nodes USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- Verify (should return 2 rows, both using hnsw):
-- SELECT indexname, tablename, indexdef
-- FROM pg_indexes
-- WHERE tablename IN ('knowledge_nodes', 'knowledge_source_chunks')
--   AND indexdef LIKE '%embedding%';


-- ────────────────────────────────────────────────────────────
-- FINAL VALIDATION — Run this block after all 6 steps complete
-- ────────────────────────────────────────────────────────────

-- 1. Columns are vector type
SELECT table_name, column_name, udt_name
FROM information_schema.columns
WHERE table_name IN ('knowledge_nodes', 'knowledge_source_chunks')
  AND column_name = 'embedding';
-- Expected: 2 rows, udt_name = 'vector'

-- 2. All embeddings are NULL (ready for re-embedding via PRD-15B)
SELECT
  'knowledge_source_chunks' AS tbl,
  COUNT(*) AS total_rows,
  COUNT(embedding) AS has_embedding
FROM knowledge_source_chunks
UNION ALL
SELECT
  'knowledge_nodes',
  COUNT(*),
  COUNT(embedding)
FROM knowledge_nodes;
-- Expected: has_embedding = 0 for both

-- 3. Old match_nodes is gone
SELECT routine_name FROM information_schema.routines
WHERE routine_schema = 'public' AND routine_name = 'match_nodes';
-- Expected: 0 rows

-- 4. New RPC functions exist
SELECT routine_name FROM information_schema.routines
WHERE routine_schema = 'public'
  AND routine_name IN ('match_source_chunks', 'match_knowledge_nodes');
-- Expected: 2 rows

-- 5. HNSW indexes exist
SELECT indexname, tablename
FROM pg_indexes
WHERE tablename IN ('knowledge_nodes', 'knowledge_source_chunks')
  AND indexdef LIKE '%embedding%';
-- Expected: 2 rows, both hnsw
