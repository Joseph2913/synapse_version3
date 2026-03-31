-- Migration: get_cluster_summaries RPC function
-- Purpose: Moves expensive anchor cluster computation from client-side JS to Postgres.
-- Previously the browser downloaded ALL nodes (~5000+) and ALL edges (~6000+) just to
-- compute 187 cluster summary objects. This function does it server-side and returns
-- only the final summaries.
--
-- Called from: src/services/exploreQueries.ts -> fetchClusterData()
-- See: docs/PERFORMANCE-PATTERNS.md for the full decision record.

CREATE OR REPLACE FUNCTION get_cluster_summaries(p_user_id UUID)
RETURNS json
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
  result json;
BEGIN
  WITH anchors AS (
    SELECT id, label, entity_type, description, parent_anchor_id
    FROM knowledge_nodes
    WHERE user_id = p_user_id
      AND is_anchor = true
      AND is_merged = false
    ORDER BY label
  ),

  anchor_ids AS (
    SELECT id FROM anchors
  ),

  -- Map non-anchor nodes to anchor clusters via direct edges.
  -- A node belongs to anchor A's cluster if there is an edge between them.
  cluster_membership AS (
    SELECT DISTINCT
      a_end.id AS anchor_id,
      CASE
        WHEN a_end.id = e.source_node_id THEN e.target_node_id
        ELSE e.source_node_id
      END AS node_id
    FROM knowledge_edges e
    JOIN anchors a_end
      ON a_end.id = e.source_node_id OR a_end.id = e.target_node_id
    WHERE e.user_id = p_user_id
      -- Exclude anchor-to-anchor edges
      AND NOT (
        EXISTS (SELECT 1 FROM anchor_ids WHERE id = e.source_node_id)
        AND EXISTS (SELECT 1 FROM anchor_ids WHERE id = e.target_node_id)
      )
  ),

  -- Attach entity_type to each cluster member
  cluster_nodes AS (
    SELECT cm.anchor_id, cm.node_id, kn.entity_type
    FROM cluster_membership cm
    JOIN knowledge_nodes kn ON kn.id = cm.node_id
    WHERE kn.user_id = p_user_id
      AND kn.is_anchor = false
      AND kn.is_merged = false
  ),

  -- Direct entity count per anchor
  direct_counts AS (
    SELECT anchor_id, COUNT(DISTINCT node_id) AS direct_count
    FROM cluster_nodes
    GROUP BY anchor_id
  ),

  -- Type distribution per anchor
  type_dist AS (
    SELECT anchor_id, entity_type, COUNT(DISTINCT node_id) AS cnt
    FROM cluster_nodes
    GROUP BY anchor_id, entity_type
  ),

  -- Inherited entities: nodes connected via is_inherited edges, minus direct members
  inherited_counts AS (
    SELECT
      e.source_node_id AS anchor_id,
      COUNT(DISTINCT e.target_node_id) FILTER (
        WHERE NOT EXISTS (
          SELECT 1 FROM cluster_membership cm
          WHERE cm.anchor_id = e.source_node_id AND cm.node_id = e.target_node_id
        )
      ) AS inherited_count
    FROM knowledge_edges e
    JOIN anchor_ids a ON a.id = e.source_node_id
    WHERE e.user_id = p_user_id
      AND e.is_inherited = true
    GROUP BY e.source_node_id
  ),

  -- Cross-cluster: shared entities (nodes belonging to multiple anchor clusters)
  shared_entities AS (
    SELECT
      cm1.anchor_id AS anchor_a,
      cm2.anchor_id AS anchor_b,
      COUNT(*) AS shared_count
    FROM cluster_membership cm1
    JOIN cluster_membership cm2
      ON cm1.node_id = cm2.node_id
      AND cm1.anchor_id < cm2.anchor_id
    GROUP BY cm1.anchor_id, cm2.anchor_id
  ),

  -- Cross-cluster: direct edges between nodes in different clusters
  cross_edges AS (
    SELECT
      cm1.anchor_id AS anchor_a,
      cm2.anchor_id AS anchor_b,
      COUNT(*) AS cross_count
    FROM knowledge_edges e
    JOIN cluster_membership cm1 ON e.source_node_id = cm1.node_id
    JOIN cluster_membership cm2 ON e.target_node_id = cm2.node_id
    WHERE e.user_id = p_user_id
      AND cm1.anchor_id < cm2.anchor_id
    GROUP BY cm1.anchor_id, cm2.anchor_id
  ),

  -- Merge shared + cross into unified cross-cluster weights (both directions)
  cross_cluster_merged AS (
    SELECT
      anchor_a,
      anchor_b,
      COALESCE(se.shared_count, 0) AS shared_count,
      COALESCE(ce.cross_count, 0) AS cross_count
    FROM shared_entities se
    FULL OUTER JOIN cross_edges ce USING (anchor_a, anchor_b)
    WHERE COALESCE(se.shared_count, 0) + COALESCE(ce.cross_count, 0) > 0
  ),

  -- Sub-anchors: anchors whose parent_anchor_id points to another anchor
  sub_anchors AS (
    SELECT parent_anchor_id, array_agg(id ORDER BY label) AS sub_ids
    FROM anchors
    WHERE parent_anchor_id IS NOT NULL
    GROUP BY parent_anchor_id
  ),

  -- All clustered node IDs (for unclustered computation downstream)
  all_clustered AS (
    SELECT DISTINCT node_id FROM cluster_membership
  )

  SELECT json_build_object(
    'clusters', COALESCE((
      SELECT json_agg(cluster_json ORDER BY label)
      FROM (
        SELECT
          a.label,
          json_build_object(
            'anchor', json_build_object(
              'id', a.id,
              'label', a.label,
              'entityType', a.entity_type,
              'description', a.description,
              'entityCount', COALESCE(dc.direct_count, 0) + COALESCE(ic.inherited_count, 0),
              'parentAnchorId', a.parent_anchor_id,
              'isSubAnchor', (a.parent_anchor_id IS NOT NULL)
            ),
            'entityCount', COALESCE(dc.direct_count, 0) + COALESCE(ic.inherited_count, 0),
            'directEntityCount', COALESCE(dc.direct_count, 0),
            'inheritedEntityCount', COALESCE(ic.inherited_count, 0),
            'typeDistribution', COALESCE(
              (SELECT json_agg(json_build_object(
                'entityType', td.entity_type,
                'count', td.cnt,
                'percentage', CASE WHEN COALESCE(dc.direct_count, 0) > 0
                  THEN td.cnt::float / dc.direct_count
                  ELSE 0 END
              ) ORDER BY td.cnt DESC)
              FROM type_dist td WHERE td.anchor_id = a.id),
              '[]'::json
            ),
            'position', json_build_object('cx', 0, 'cy', 0, 'r', 0),
            'crossClusterEdges', COALESCE(
              (SELECT json_agg(json_build_object(
                'targetClusterId', other_id,
                'sharedEntityCount', shared_count,
                'crossEdgeCount', cross_count,
                'totalWeight', shared_count + cross_count
              ))
              FROM (
                SELECT anchor_b AS other_id, shared_count, cross_count
                FROM cross_cluster_merged WHERE anchor_a = a.id
                UNION ALL
                SELECT anchor_a AS other_id, shared_count, cross_count
                FROM cross_cluster_merged WHERE anchor_b = a.id
              ) cc),
              '[]'::json
            ),
            'subAnchorIds', COALESCE(sa.sub_ids, ARRAY[]::uuid[])
          ) AS cluster_json
        FROM anchors a
        LEFT JOIN direct_counts dc ON dc.anchor_id = a.id
        LEFT JOIN inherited_counts ic ON ic.anchor_id = a.id
        LEFT JOIN sub_anchors sa ON sa.parent_anchor_id = a.id
      ) sub
    ), '[]'::json),
    'clusteredNodeIds', COALESCE(
      (SELECT json_agg(node_id) FROM all_clustered),
      '[]'::json
    )
  ) INTO result;

  RETURN result;
END;
$$;
