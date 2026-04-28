-- Migration: Add unique constraint on knowledge_edges to prevent duplicate extraction edges.
-- Deduplicates existing duplicate groups first (keeps highest weight, then earliest id),
-- then adds the constraint with ON CONFLICT support.

BEGIN;

-- Step 1: Remove duplicate edges (keep one per group: highest weight, then earliest id)
DELETE FROM knowledge_edges
WHERE id IN (
  SELECT id FROM (
    SELECT
      id,
      ROW_NUMBER() OVER (
        PARTITION BY user_id, source_node_id, target_node_id, relation_type
        ORDER BY weight DESC NULLS LAST, id ASC
      ) AS rn
    FROM knowledge_edges
  ) ranked
  WHERE rn > 1
);

-- Step 2: Add unique constraint (partial index — excludes self-edges which should never exist)
CREATE UNIQUE INDEX IF NOT EXISTS knowledge_edges_dedup_uniq
  ON knowledge_edges (user_id, source_node_id, target_node_id, relation_type);

COMMIT;
