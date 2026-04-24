-- Migration: get_recent_source_relation_counts RPC function
-- Purpose: For Home "Recent Sources" panel — returns, per recent source,
-- the count of cross-source edges (edges linking entities from this source
-- to entities from other sources) and the count of distinct other sources
-- those edges reach. Computed server-side for the N most recent sources
-- to keep Home fast.
--
-- Called from: src/services/supabase.ts -> fetchRecentSourceRelationCounts()

CREATE OR REPLACE FUNCTION get_recent_source_relation_counts(
  p_user_id UUID,
  p_limit INT DEFAULT 5
)
RETURNS json
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
  result json;
BEGIN
  WITH recent_sources AS (
    SELECT id
    FROM knowledge_sources
    WHERE user_id = p_user_id
    ORDER BY created_at DESC
    LIMIT p_limit
  ),
  source_entities AS (
    SELECT rs.id AS source_id, kn.id AS entity_id
    FROM recent_sources rs
    JOIN knowledge_nodes kn ON kn.source_id = rs.id AND kn.user_id = p_user_id
  ),
  edge_hits AS (
    SELECT
      se.source_id,
      e.id AS edge_id,
      CASE
        WHEN e.source_node_id = se.entity_id THEN e.target_node_id
        ELSE e.source_node_id
      END AS other_node_id
    FROM source_entities se
    JOIN knowledge_edges e
      ON (e.source_node_id = se.entity_id OR e.target_node_id = se.entity_id)
    WHERE e.user_id = p_user_id
  ),
  edge_hits_with_other AS (
    SELECT
      eh.source_id,
      eh.edge_id,
      other.source_id AS other_source_id
    FROM edge_hits eh
    JOIN knowledge_nodes other ON other.id = eh.other_node_id AND other.user_id = p_user_id
    WHERE other.source_id IS NOT NULL
      AND other.source_id <> eh.source_id
  ),
  counts AS (
    SELECT
      rs.id AS source_id,
      COUNT(DISTINCT ehw.edge_id)::INT AS cross_connection_count,
      COUNT(DISTINCT ehw.other_source_id)::INT AS related_source_count
    FROM recent_sources rs
    LEFT JOIN edge_hits_with_other ehw ON ehw.source_id = rs.id
    GROUP BY rs.id
  )
  SELECT COALESCE(json_agg(
    json_build_object(
      'source_id', source_id,
      'cross_connection_count', cross_connection_count,
      'related_source_count', related_source_count
    )
  ), '[]'::json) INTO result FROM counts;

  RETURN result;
END;
$$;

GRANT EXECUTE ON FUNCTION get_recent_source_relation_counts(UUID, INT) TO authenticated;
