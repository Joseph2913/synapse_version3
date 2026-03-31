-- Migration: get_explore_source_graph RPC function
-- Purpose: Replaces fetchSourceGraph() client-side computation for the Explore Sources tab.
-- Previously downloaded ALL nodes + ALL edges to compute source relationships.
-- Now returns sources and source-to-source edges (entity cross-references only, no anchors).
--
-- Called from: src/services/exploreQueries.ts -> fetchSourceGraph()
-- See: docs/PERFORMANCE-PATTERNS.md

CREATE OR REPLACE FUNCTION get_explore_source_graph(p_user_id UUID)
RETURNS json
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
  result json;
BEGIN
  WITH sources AS (
    SELECT id, title, source_type, created_at
    FROM knowledge_sources
    WHERE user_id = p_user_id
  ),

  -- Non-anchor entities with source_id
  entities AS (
    SELECT id, source_id, entity_type, tags
    FROM knowledge_nodes
    WHERE user_id = p_user_id
      AND is_anchor = false
      AND is_merged = false
      AND source_id IS NOT NULL
  ),

  -- Entity count per source
  entity_counts AS (
    SELECT source_id, COUNT(*) AS cnt,
           array_agg(id) AS entity_ids
    FROM entities
    GROUP BY source_id
  ),

  -- Tags per source (union of all entity tags)
  source_tags AS (
    SELECT source_id, array_agg(DISTINCT tag) AS tags
    FROM (
      SELECT source_id, unnest(tags) AS tag
      FROM entities
      WHERE tags IS NOT NULL AND array_length(tags, 1) > 0
    ) sub
    GROUP BY source_id
  ),

  -- Cross-source entity edges: edges where source and target belong to different sources
  cross_source_edges AS (
    SELECT
      n1.source_id AS source_a,
      n2.source_id AS source_b,
      COUNT(*) AS entity_edge_count
    FROM knowledge_edges e
    JOIN entities n1 ON e.source_node_id = n1.id
    JOIN entities n2 ON e.target_node_id = n2.id
    WHERE e.user_id = p_user_id
      AND n1.source_id != n2.source_id
      AND n1.source_id < n2.source_id
    GROUP BY n1.source_id, n2.source_id
  ),

  -- Also count reverse direction and merge
  cross_source_edges_both AS (
    SELECT
      LEAST(n1.source_id, n2.source_id) AS source_a,
      GREATEST(n1.source_id, n2.source_id) AS source_b,
      COUNT(*) AS entity_edge_count
    FROM knowledge_edges e
    JOIN entities n1 ON e.source_node_id = n1.id
    JOIN entities n2 ON e.target_node_id = n2.id
    WHERE e.user_id = p_user_id
      AND n1.source_id != n2.source_id
    GROUP BY LEAST(n1.source_id, n2.source_id), GREATEST(n1.source_id, n2.source_id)
  )

  SELECT json_build_object(
    'sources', COALESCE((
      SELECT json_agg(json_build_object(
        'id', s.id,
        'title', COALESCE(s.title, 'Untitled'),
        'sourceType', COALESCE(s.source_type, 'Note'),
        'entityIds', COALESCE(ec.entity_ids, ARRAY[]::uuid[]),
        'entityCount', COALESCE(ec.cnt, 0),
        'createdAt', s.created_at,
        'tags', COALESCE(st.tags, ARRAY[]::text[])
      ) ORDER BY s.created_at DESC)
      FROM sources s
      LEFT JOIN entity_counts ec ON ec.source_id = s.id
      LEFT JOIN source_tags st ON st.source_id = s.id
    ), '[]'::json),

    'edges', COALESCE((
      SELECT json_agg(json_build_object(
        'fromSourceId', cse.source_a,
        'toSourceId', cse.source_b,
        'totalWeight', cse.entity_edge_count,
        'connections', json_build_array(
          json_build_object(
            'type', 'entity',
            'count', cse.entity_edge_count,
            'labels', '[]'::json
          )
        )
      ))
      FROM cross_source_edges_both cse
      WHERE cse.entity_edge_count > 0
    ), '[]'::json)
  ) INTO result;

  RETURN result;
END;
$$;
