-- Migration: get_explore_source_graph v2 — include anchor-mediated edges
-- Purpose: Previously the RPC only counted cross-source edges between
-- non-anchor entities. This caused the graph to show fewer connections
-- than the source detail panel (which counts all cross-source edges,
-- including those through anchors).
--
-- v2 separates direct cross-source edges (both endpoints non-anchor) from
-- anchor-mediated edges (one endpoint is an anchor with a different
-- source_id). The client renders anchor-mediated edges as dashed lines so
-- the visual matches the count in the right panel.
--
-- Called from: src/services/exploreQueries.ts -> fetchSourceGraph()

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

  -- Non-anchor entities (used for node rendering + direct edge counts)
  entities AS (
    SELECT id, source_id, entity_type, tags
    FROM knowledge_nodes
    WHERE user_id = p_user_id
      AND is_anchor = false
      AND is_merged = false
      AND source_id IS NOT NULL
  ),

  -- All nodes (anchor OR non-anchor) with a source_id, for anchor-mediated count
  all_nodes AS (
    SELECT id, source_id, is_anchor
    FROM knowledge_nodes
    WHERE user_id = p_user_id
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

  -- Direct cross-source edges (both endpoints non-anchor)
  direct_cross_edges AS (
    SELECT
      LEAST(n1.source_id, n2.source_id) AS source_a,
      GREATEST(n1.source_id, n2.source_id) AS source_b,
      COUNT(*) AS direct_count
    FROM knowledge_edges e
    JOIN entities n1 ON e.source_node_id = n1.id
    JOIN entities n2 ON e.target_node_id = n2.id
    WHERE e.user_id = p_user_id
      AND n1.source_id != n2.source_id
    GROUP BY LEAST(n1.source_id, n2.source_id), GREATEST(n1.source_id, n2.source_id)
  ),

  -- Anchor-mediated cross-source edges: at least one endpoint is an anchor
  -- from a different source than the other endpoint.
  anchor_cross_edges AS (
    SELECT
      LEAST(n1.source_id, n2.source_id) AS source_a,
      GREATEST(n1.source_id, n2.source_id) AS source_b,
      COUNT(*) AS anchor_count
    FROM knowledge_edges e
    JOIN all_nodes n1 ON e.source_node_id = n1.id
    JOIN all_nodes n2 ON e.target_node_id = n2.id
    WHERE e.user_id = p_user_id
      AND n1.source_id != n2.source_id
      AND (n1.is_anchor = true OR n2.is_anchor = true)
    GROUP BY LEAST(n1.source_id, n2.source_id), GREATEST(n1.source_id, n2.source_id)
  ),

  -- Merge direct + anchor counts per source pair. FULL OUTER JOIN so pairs
  -- connected only via an anchor still appear.
  combined_edges AS (
    SELECT
      COALESCE(d.source_a, a.source_a) AS source_a,
      COALESCE(d.source_b, a.source_b) AS source_b,
      COALESCE(d.direct_count, 0)      AS direct_count,
      COALESCE(a.anchor_count, 0)      AS anchor_count
    FROM direct_cross_edges d
    FULL OUTER JOIN anchor_cross_edges a
      ON d.source_a = a.source_a AND d.source_b = a.source_b
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
        'fromSourceId', ce.source_a,
        'toSourceId',   ce.source_b,
        'totalWeight',  ce.direct_count + ce.anchor_count,
        'connections',  (
          SELECT json_agg(c)
          FROM (
            SELECT json_build_object(
              'type',   'entity',
              'count',  ce.direct_count,
              'labels', '[]'::json
            ) AS c
            WHERE ce.direct_count > 0
            UNION ALL
            SELECT json_build_object(
              'type',   'anchor',
              'count',  ce.anchor_count,
              'labels', '[]'::json
            ) AS c
            WHERE ce.anchor_count > 0
          ) sub
        )
      ))
      FROM combined_edges ce
      WHERE ce.direct_count + ce.anchor_count > 0
    ), '[]'::json)
  ) INTO result;

  RETURN result;
END;
$$;
