-- PRD-23: Anchor Knowledge Inheritance
-- Adds is_inherited flag to knowledge_edges so inherited edges can be
-- identified and removed cleanly when sub-anchor relationships are dissolved.

ALTER TABLE knowledge_edges
  ADD COLUMN IF NOT EXISTS is_inherited BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS inherited_from_anchor_id UUID
    REFERENCES knowledge_nodes(id) ON DELETE SET NULL;

-- Index for fast cleanup: "delete all inherited edges from this sub-anchor"
CREATE INDEX IF NOT EXISTS idx_knowledge_edges_inherited
  ON knowledge_edges (inherited_from_anchor_id)
  WHERE is_inherited = true;
