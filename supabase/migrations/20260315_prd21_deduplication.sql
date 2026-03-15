-- PRD-21: Node Deduplication Engine
-- Adds merged_into_node_id for soft-delete tracking and creates the
-- potential_duplicates table for near-match review queue.

-- ── 1. Soft-delete tracking on knowledge_nodes ────────────────────────────────
-- When a duplicate node is merged into a canonical node, it is NOT hard-deleted
-- (that would cascade-delete edges). Instead it is soft-deleted: its
-- merged_into_node_id is set and is_merged = true. The merge function
-- re-routes all edges to the canonical node first, then sets these flags.

ALTER TABLE knowledge_nodes
  ADD COLUMN IF NOT EXISTS merged_into_node_id UUID
    REFERENCES knowledge_nodes(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS is_merged BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_knowledge_nodes_is_merged
  ON knowledge_nodes (user_id, is_merged)
  WHERE is_merged = false;

-- ── 2. potential_duplicates table ─────────────────────────────────────────────
-- Stores near-match pairs (similarity 0.80–0.92) for human review.
-- Created by the deduplication service during extraction.
-- Reviewed and resolved via the Pipeline page right panel.

CREATE TABLE IF NOT EXISTS potential_duplicates (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  node_a_id       UUID NOT NULL REFERENCES knowledge_nodes(id) ON DELETE CASCADE,
  node_b_id       UUID NOT NULL REFERENCES knowledge_nodes(id) ON DELETE CASCADE,
  similarity      NUMERIC(5, 4) NOT NULL,  -- cosine similarity 0.0–1.0
  detected_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Resolution
  status          TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'merged', 'kept_separate', 'auto_resolved')),
  resolved_at     TIMESTAMPTZ,
  resolved_by     TEXT,  -- 'user' | 'system'
  -- Ensure each pair is stored once (node_a_id < node_b_id by convention)
  UNIQUE (user_id, node_a_id, node_b_id)
);

CREATE INDEX IF NOT EXISTS idx_potential_duplicates_user_status
  ON potential_duplicates (user_id, status)
  WHERE status = 'pending';

-- RLS
ALTER TABLE potential_duplicates ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own potential duplicates"
  ON potential_duplicates FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own potential duplicates"
  ON potential_duplicates FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own potential duplicates"
  ON potential_duplicates FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own potential duplicates"
  ON potential_duplicates FOR DELETE USING (auth.uid() = user_id);

-- ── 3. RPC function for embedding similarity search ───────────────────────────
CREATE OR REPLACE FUNCTION find_similar_nodes(
  p_user_id      UUID,
  p_embedding    vector(768),
  p_entity_type  TEXT,
  p_limit        INT DEFAULT 5,
  p_min_similarity FLOAT DEFAULT 0.80
)
RETURNS TABLE (
  id         UUID,
  label      TEXT,
  similarity FLOAT
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    id,
    label,
    1 - (embedding <=> p_embedding) AS similarity
  FROM knowledge_nodes
  WHERE user_id       = p_user_id
    AND entity_type   = p_entity_type
    AND is_merged     = false
    AND embedding     IS NOT NULL
    AND 1 - (embedding <=> p_embedding) >= p_min_similarity
  ORDER BY embedding <=> p_embedding
  LIMIT p_limit;
$$;

-- ── 4. Helper for finding exact duplicate groups ───────────────────────────────
CREATE OR REPLACE FUNCTION find_exact_duplicate_nodes()
RETURNS TABLE (
  user_id     UUID,
  label       TEXT,
  entity_type TEXT,
  node_ids    UUID[]
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    user_id,
    LOWER(label) AS label,
    entity_type,
    array_agg(id ORDER BY created_at) AS node_ids
  FROM knowledge_nodes
  WHERE is_merged = false
  GROUP BY user_id, LOWER(label), entity_type
  HAVING COUNT(*) > 1;
$$;
