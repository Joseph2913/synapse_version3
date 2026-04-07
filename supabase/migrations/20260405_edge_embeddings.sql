-- Migration: Edge Embeddings (PRD-RAG-05)
-- Purpose: Makes relationships directly searchable via semantic similarity.
-- Adds embedding column to knowledge_edges, creates HNSW vector index,
-- and creates match_relationships RPC for vector search.

-- 1. Add embedding column to knowledge_edges
ALTER TABLE knowledge_edges
ADD COLUMN IF NOT EXISTS embedding VECTOR(3072);

-- 2. Partial B-tree index to quickly filter to rows that have embeddings.
-- pgvector HNSW and IVFFlat indexes are capped at 2000 dimensions; our 3072-dim
-- vectors exceed that limit. The cosine distance scan is exact (sequential over
-- non-null rows). At ~6k edges this is fast enough (<100ms); if the table grows
-- past ~50k embedded edges, consider dimensionality reduction or halfvec.
CREATE INDEX IF NOT EXISTS idx_knowledge_edges_has_embedding
ON knowledge_edges ((embedding IS NOT NULL))
WHERE embedding IS NOT NULL;

-- 3. Create match_relationships RPC function
CREATE OR REPLACE FUNCTION match_relationships(
  query_embedding VECTOR(3072),
  match_threshold FLOAT DEFAULT 0.65,
  match_count INT DEFAULT 10,
  p_user_id UUID DEFAULT auth.uid()
)
RETURNS TABLE (
  id UUID,
  source_node_id UUID,
  target_node_id UUID,
  relation_type TEXT,
  evidence TEXT,
  weight FLOAT,
  source_label TEXT,
  source_type TEXT,
  target_label TEXT,
  target_type TEXT,
  similarity FLOAT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT
    e.id,
    e.source_node_id,
    e.target_node_id,
    e.relation_type,
    e.evidence,
    e.weight,
    sn.label AS source_label,
    sn.entity_type AS source_type,
    tn.label AS target_label,
    tn.entity_type AS target_type,
    1 - (e.embedding <=> query_embedding) AS similarity
  FROM knowledge_edges e
  JOIN knowledge_nodes sn ON sn.id = e.source_node_id
  JOIN knowledge_nodes tn ON tn.id = e.target_node_id
  WHERE e.user_id = p_user_id
    AND e.embedding IS NOT NULL
    AND 1 - (e.embedding <=> query_embedding) > match_threshold
  ORDER BY e.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;
