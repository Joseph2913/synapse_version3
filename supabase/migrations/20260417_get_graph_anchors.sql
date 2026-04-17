-- get_graph_anchors: Fetch top N confirmed anchors with their connected source IDs
-- for the playlist graph view. Does server-side what previously required 4 sequential
-- client-side queries: candidate fetch, node lookup, edge traversal, source resolution.
--
-- Returns JSON array of objects matching PlaylistGraphAnchor type.

CREATE OR REPLACE FUNCTION get_graph_anchors(p_user_id UUID, p_limit INT DEFAULT 200)
RETURNS JSON
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
  result JSON;
BEGIN
  WITH
  -- 1. Top confirmed anchors by composite score
  top_anchors AS (
    SELECT ac.id AS candidate_id,
           ac.node_id,
           ac.composite_score
    FROM anchor_candidates ac
    WHERE ac.user_id = p_user_id
      AND ac.status = 'confirmed'
    ORDER BY ac.composite_score DESC
    LIMIT p_limit
  ),
  -- 2. Node labels and metadata
  anchor_nodes AS (
    SELECT ta.candidate_id,
           ta.node_id,
           ta.composite_score,
           kn.label,
           kn.entity_type,
           kn.description
    FROM top_anchors ta
    JOIN knowledge_nodes kn ON kn.id = ta.node_id
  ),
  -- 3. Find all entities connected to these anchor nodes via edges
  connected_entities AS (
    SELECT an.candidate_id,
           an.node_id,
           CASE
             WHEN ke.source_node_id = an.node_id THEN ke.target_node_id
             ELSE ke.source_node_id
           END AS entity_id
    FROM anchor_nodes an
    JOIN knowledge_edges ke ON (ke.source_node_id = an.node_id OR ke.target_node_id = an.node_id)
    WHERE ke.user_id = p_user_id
      -- Exclude self-edges and edges between anchors
      AND CASE
            WHEN ke.source_node_id = an.node_id THEN ke.target_node_id
            ELSE ke.source_node_id
          END NOT IN (SELECT node_id FROM top_anchors)
  ),
  -- 4. Resolve entity → source_id
  entity_sources AS (
    SELECT DISTINCT ce.candidate_id,
           ce.node_id,
           kn.source_id
    FROM connected_entities ce
    JOIN knowledge_nodes kn ON kn.id = ce.entity_id
    WHERE kn.source_id IS NOT NULL
  ),
  -- 5. Aggregate per anchor
  anchor_results AS (
    SELECT an.candidate_id,
           an.node_id,
           an.composite_score,
           an.label,
           an.entity_type,
           an.description,
           (SELECT COUNT(DISTINCT ce.entity_id) FROM connected_entities ce WHERE ce.candidate_id = an.candidate_id) AS entity_count,
           COALESCE(
             (SELECT json_agg(DISTINCT es.source_id)
              FROM entity_sources es
              WHERE es.candidate_id = an.candidate_id),
             '[]'::json
           ) AS connected_source_ids
    FROM anchor_nodes an
  )
  SELECT json_agg(
    json_build_object(
      'id', ar.candidate_id,
      'nodeId', ar.node_id,
      'compositeScore', ar.composite_score,
      'label', ar.label,
      'entityType', ar.entity_type,
      'description', ar.description,
      'entityCount', ar.entity_count,
      'connectedSourceIds', ar.connected_source_ids
    )
    ORDER BY ar.composite_score DESC
  )
  INTO result
  FROM anchor_results ar;

  RETURN COALESCE(result, '[]'::json);
END;
$$;
