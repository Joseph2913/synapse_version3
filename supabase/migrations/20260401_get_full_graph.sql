-- Migration: get_full_graph RPC function
-- Purpose: Fetches all nodes (with pre-computed positions) and all edges for the
-- full graph view. Avoids pagination issues with large datasets.
--
-- Called from: src/services/graphQueries.ts -> fetchFullGraph()
-- See: docs/PERFORMANCE-PATTERNS.md

CREATE OR REPLACE FUNCTION get_full_graph(p_user_id UUID)
RETURNS json
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
  result json;
BEGIN
  SELECT json_build_object(
    'nodes', COALESCE((
      SELECT json_agg(json_build_object(
        'id', kn.id,
        'label', kn.label,
        'entityType', kn.entity_type,
        'graphX', kn.graph_x,
        'graphY', kn.graph_y,
        'isAnchor', kn.is_anchor,
        'sourceId', kn.source_id,
        'confidence', kn.confidence,
        'createdAt', kn.created_at
      ))
      FROM knowledge_nodes kn
      WHERE kn.user_id = p_user_id
        AND kn.is_merged = false
    ), '[]'::json),

    'edges', COALESCE((
      SELECT json_agg(json_build_object(
        'sourceNodeId', ke.source_node_id,
        'targetNodeId', ke.target_node_id,
        'relationType', ke.relation_type,
        'weight', ke.weight
      ))
      FROM knowledge_edges ke
      WHERE ke.user_id = p_user_id
    ), '[]'::json),

    'stats', json_build_object(
      'totalNodes', (
        SELECT COUNT(*) FROM knowledge_nodes
        WHERE user_id = p_user_id AND is_merged = false
      ),
      'totalEdges', (
        SELECT COUNT(*) FROM knowledge_edges
        WHERE user_id = p_user_id
      ),
      'positionedNodes', (
        SELECT COUNT(*) FROM knowledge_nodes
        WHERE user_id = p_user_id AND is_merged = false
          AND graph_x IS NOT NULL AND graph_y IS NOT NULL
      )
    )
  ) INTO result;

  RETURN result;
END;
$$;
