-- ─────────────────────────────────────────────────────────────────────────────
-- Stage 8 — Cross-connection discovery: fix match_knowledge_nodes for 3072-dim
--
-- Problem: the existing HNSW index on knowledge_nodes.embedding was created
-- with vector_cosine_ops (standard pgvector). pgvector's HNSW implementation
-- caps standard vector ops at 2000 dimensions. Our embeddings are 3072-dim
-- (gemini-embedding-001). The index therefore cannot be used by the planner
-- and every match_knowledge_nodes call falls back to a sequential scan.
--
-- Fix: drop the undersized index, create a halfvec expression index (same
-- pattern applied to source_chunks in Stage 3 migration
-- stage3_chunks_constraints_and_index), and update the RPC to cast both sides
-- to halfvec(3072) so the planner hits the new index.
--
-- halfvec stores each dimension as float16 (vs float32 for vector). For ANN
-- at 3072 dims the recall difference is negligible; storage is halved.
-- halfvec_cosine_ops supports HNSW up to 4000 dims.
-- ─────────────────────────────────────────────────────────────────────────────

-- STEP 1: Drop the existing index (wrong op class for 3072-dim vectors)
DROP INDEX IF EXISTS idx_knowledge_nodes_embedding_hnsw;

-- STEP 2: Create HNSW index on halfvec(3072) expression
-- m=16, ef_construction=64 matches the source_chunks index (Stage 3 D-007).
CREATE INDEX IF NOT EXISTS idx_knowledge_nodes_embedding_hnsw_halfvec
  ON knowledge_nodes
  USING hnsw ((embedding::halfvec(3072)) halfvec_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- STEP 3: Replace match_knowledge_nodes to cast both sides to halfvec(3072)
-- so queries hit the new index. Parameter type stays vector(3072) for
-- backward compatibility with all existing callers.
CREATE OR REPLACE FUNCTION match_knowledge_nodes(
  query_embedding vector(3072),
  match_threshold float,
  match_count      int,
  p_user_id        uuid
)
RETURNS TABLE (
  id          uuid,
  label       text,
  entity_type text,
  description text,
  similarity  float
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
    1 - (kn.embedding::halfvec(3072) <=> query_embedding::halfvec(3072)) AS similarity
  FROM knowledge_nodes kn
  WHERE kn.user_id = p_user_id
    AND kn.embedding IS NOT NULL
    AND 1 - (kn.embedding::halfvec(3072) <=> query_embedding::halfvec(3072)) > match_threshold
  ORDER BY kn.embedding::halfvec(3072) <=> query_embedding::halfvec(3072)
  LIMIT match_count;
END;
$$;
