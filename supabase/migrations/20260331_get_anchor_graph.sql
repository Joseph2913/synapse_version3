-- Migration: get_anchor_graph RPC function
-- Purpose: Replaces fetchAnchorLevelData() client-side computation.
-- Previously downloaded ALL nodes + ALL edges to compute anchor landscape.
-- Now returns anchor nodes, inter-anchor edges, and stats in one call.
--
-- Called from: src/services/graphQueries.ts -> fetchAnchorLevelData()
-- See: docs/PERFORMANCE-PATTERNS.md

CREATE OR REPLACE FUNCTION get_anchor_graph(p_user_id UUID)
RETURNS json
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
  result json;
  quiet_threshold interval := interval '14 days';
BEGIN
  WITH anchors AS (
    SELECT id, label, entity_type, description, confidence, created_at
    FROM knowledge_nodes
    WHERE user_id = p_user_id
      AND is_anchor = true
      AND is_merged = false
  ),

  anchor_ids AS (
    SELECT id FROM anchors
  ),

  -- All non-anchor nodes with their source_id
  sourced_nodes AS (
    SELECT id, source_id, entity_type
    FROM knowledge_nodes
    WHERE user_id = p_user_id
      AND source_id IS NOT NULL
      AND is_anchor = false
      AND is_merged = false
  ),

  -- All sources with created_at
  sources AS (
    SELECT id, created_at
    FROM knowledge_sources
    WHERE user_id = p_user_id
  ),

  -- Total node count
  total_nodes AS (
    SELECT COUNT(*) AS cnt
    FROM knowledge_nodes
    WHERE user_id = p_user_id
      AND is_merged = false
  ),

  -- Edges connecting anchors to non-anchor nodes
  anchor_edges AS (
    SELECT
      CASE
        WHEN a.id = e.source_node_id THEN a.id
        ELSE a.id
      END AS anchor_id,
      CASE
        WHEN a.id = e.source_node_id THEN e.target_node_id
        ELSE e.source_node_id
      END AS node_id
    FROM knowledge_edges e
    JOIN anchors a ON a.id = e.source_node_id OR a.id = e.target_node_id
    WHERE e.user_id = p_user_id
      AND NOT (
        EXISTS (SELECT 1 FROM anchor_ids WHERE id = e.source_node_id)
        AND EXISTS (SELECT 1 FROM anchor_ids WHERE id = e.target_node_id)
      )
  ),

  -- Map anchor → non-anchor node → source
  anchor_node_source AS (
    SELECT DISTINCT ae.anchor_id, ae.node_id, sn.source_id
    FROM anchor_edges ae
    JOIN sourced_nodes sn ON sn.id = ae.node_id
  ),

  -- Entity count per anchor (non-anchor nodes connected via edges)
  anchor_entity_counts AS (
    SELECT anchor_id, COUNT(DISTINCT node_id) AS entity_count
    FROM anchor_edges
    GROUP BY anchor_id
  ),

  -- Source count per anchor
  anchor_source_counts AS (
    SELECT anchor_id, COUNT(DISTINCT source_id) AS source_count
    FROM anchor_node_source
    GROUP BY anchor_id
  ),

  -- Last activity per anchor (most recent source created_at)
  anchor_activity AS (
    SELECT ans.anchor_id, MAX(s.created_at) AS last_activity
    FROM anchor_node_source ans
    JOIN sources s ON s.id = ans.source_id
    GROUP BY ans.anchor_id
  ),

  -- Bridge entities: non-anchor nodes connected to 2+ anchors
  bridge_counts AS (
    SELECT
      ae1.anchor_id AS anchor_a,
      ae2.anchor_id AS anchor_b,
      COUNT(DISTINCT ae1.node_id) AS bridge_count
    FROM anchor_edges ae1
    JOIN anchor_edges ae2
      ON ae1.node_id = ae2.node_id
      AND ae1.anchor_id < ae2.anchor_id
    WHERE NOT EXISTS (SELECT 1 FROM anchor_ids WHERE id = ae1.node_id)
    GROUP BY ae1.anchor_id, ae2.anchor_id
  ),

  -- Shared sources: sources contributing to 2+ anchors
  shared_sources AS (
    SELECT
      ans1.anchor_id AS anchor_a,
      ans2.anchor_id AS anchor_b,
      COUNT(DISTINCT ans1.source_id) AS shared_count
    FROM anchor_node_source ans1
    JOIN anchor_node_source ans2
      ON ans1.source_id = ans2.source_id
      AND ans1.anchor_id < ans2.anchor_id
    GROUP BY ans1.anchor_id, ans2.anchor_id
  ),

  -- Merge bridge + shared into edges
  merged_edges AS (
    SELECT
      COALESCE(bc.anchor_a, ss.anchor_a) AS anchor_a,
      COALESCE(bc.anchor_b, ss.anchor_b) AS anchor_b,
      COALESCE(bc.bridge_count, 0) AS bridge_entity_count,
      COALESCE(ss.shared_count, 0) AS shared_source_count
    FROM bridge_counts bc
    FULL OUTER JOIN shared_sources ss
      ON bc.anchor_a = ss.anchor_a AND bc.anchor_b = ss.anchor_b
    WHERE COALESCE(bc.bridge_count, 0) + COALESCE(ss.shared_count, 0) > 0
  ),

  -- Connection count per anchor (how many other anchors it connects to)
  connection_counts AS (
    SELECT anchor_id, COUNT(*) AS conn_count
    FROM (
      SELECT anchor_a AS anchor_id FROM merged_edges
      UNION ALL
      SELECT anchor_b AS anchor_id FROM merged_edges
    ) sub
    GROUP BY anchor_id
  )

  SELECT json_build_object(
    'anchors', COALESCE((
      SELECT json_agg(json_build_object(
        'id', a.id,
        'kind', 'anchor',
        'label', a.label,
        'entityType', a.entity_type,
        'entityCount', COALESCE(aec.entity_count, 0),
        'sourceCount', COALESCE(asc2.source_count, 0),
        'connectionCount', COALESCE(cc.conn_count, 0),
        'description', a.description,
        'confidence', a.confidence,
        'anchorStatus', 'manual',
        'lastActivity', aa.last_activity,
        'isQuiet', CASE
          WHEN aa.last_activity IS NULL THEN true
          WHEN aa.last_activity < (now() - quiet_threshold) THEN true
          ELSE false
        END
      ) ORDER BY a.label)
      FROM anchors a
      LEFT JOIN anchor_entity_counts aec ON aec.anchor_id = a.id
      LEFT JOIN anchor_source_counts asc2 ON asc2.anchor_id = a.id
      LEFT JOIN anchor_activity aa ON aa.anchor_id = a.id
      LEFT JOIN connection_counts cc ON cc.anchor_id = a.id
    ), '[]'::json),

    'edges', COALESCE((
      SELECT json_agg(json_build_object(
        'fromAnchorId', me.anchor_a,
        'toAnchorId', me.anchor_b,
        'bridgeEntityCount', me.bridge_entity_count,
        'sharedSourceCount', me.shared_source_count,
        'strength', LEAST(1.0, me.shared_source_count * 0.3 + me.bridge_entity_count * 0.1)
      ))
      FROM merged_edges me
    ), '[]'::json),

    'stats', json_build_object(
      'anchorCount', (SELECT COUNT(*) FROM anchors),
      'sourceCount', (SELECT COUNT(*) FROM sources),
      'entityCount', (SELECT cnt FROM total_nodes)
    )
  ) INTO result;

  RETURN result;
END;
$$;
