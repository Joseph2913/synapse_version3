-- PRD-22: Anchor Hierarchy
-- Adds parent_anchor_id to knowledge_nodes for confirmed sub-anchor relationships.
-- Adds suggested_parent_anchor_id to anchor_candidates for system suggestions.

-- ── 1. Parent anchor relationship on knowledge_nodes ─────────────────────────
-- A sub-anchor is an anchor node with parent_anchor_id pointing to another anchor.
-- One level deep only — parent_anchor_id always points to a root anchor (never a sub-anchor).
-- ON DELETE SET NULL: if the parent is demoted from anchor, sub-anchors become root anchors.

ALTER TABLE knowledge_nodes
  ADD COLUMN IF NOT EXISTS parent_anchor_id UUID
    REFERENCES knowledge_nodes(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_knowledge_nodes_parent_anchor
  ON knowledge_nodes (parent_anchor_id)
  WHERE parent_anchor_id IS NOT NULL;

-- ── 2. Suggested parent on anchor_candidates ──────────────────────────────────
-- When the scoring engine detects a strong semantic relationship between a candidate
-- and an existing anchor (similarity > 0.85), it writes the anchor's ID here.
-- The user sees "Add as sub-anchor of [parent]" in the confirmation UI.

ALTER TABLE anchor_candidates
  ADD COLUMN IF NOT EXISTS suggested_parent_anchor_id UUID
    REFERENCES knowledge_nodes(id) ON DELETE SET NULL;

-- ── 3. Prevent circular references (root anchor cannot be its own sub-anchor) ─

CREATE OR REPLACE FUNCTION prevent_circular_anchor_hierarchy()
RETURNS TRIGGER AS $$
BEGIN
  -- A node cannot be its own parent
  IF NEW.parent_anchor_id = NEW.id THEN
    RAISE EXCEPTION 'An anchor cannot be its own parent';
  END IF;
  -- A parent anchor cannot itself have a parent (one level deep only)
  IF NEW.parent_anchor_id IS NOT NULL THEN
    PERFORM 1 FROM knowledge_nodes
    WHERE id = NEW.parent_anchor_id
      AND parent_anchor_id IS NOT NULL;
    IF FOUND THEN
      RAISE EXCEPTION 'Sub-anchors cannot be parents (maximum one level of hierarchy)';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER anchor_hierarchy_check
  BEFORE INSERT OR UPDATE OF parent_anchor_id ON knowledge_nodes
  FOR EACH ROW
  WHEN (NEW.parent_anchor_id IS NOT NULL)
  EXECUTE FUNCTION prevent_circular_anchor_hierarchy();

-- ── 4. RPC for finding similar anchors (cross-type, for parent suggestion) ────

CREATE OR REPLACE FUNCTION find_similar_anchors(
  p_user_id        UUID,
  p_embedding      vector(768),
  p_limit          INT DEFAULT 3,
  p_min_similarity FLOAT DEFAULT 0.85
)
RETURNS TABLE (id UUID, label TEXT, similarity FLOAT)
LANGUAGE sql STABLE AS $$
  SELECT
    id, label,
    1 - (embedding <=> p_embedding) AS similarity
  FROM knowledge_nodes
  WHERE user_id     = p_user_id
    AND is_anchor   = true
    AND is_merged   = false
    AND embedding   IS NOT NULL
    AND 1 - (embedding <=> p_embedding) >= p_min_similarity
  ORDER BY embedding <=> p_embedding
  LIMIT p_limit;
$$;
