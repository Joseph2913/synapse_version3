-- Migration: get_all_sources_graph RPC function
-- Purpose: Replaces fetchAllSourcesLevelData() client-side computation.
-- Returns source nodes, source-to-source edges, top 10 gravity anchors, and
-- per-source anchor links for gravity well clustering in the graph view.
--
-- Called from: src/services/graphQueries.ts -> fetchAllSourcesLevelData()
-- See: docs/PERFORMANCE-PATTERNS.md

CREATE OR REPLACE FUNCTION get_all_sources_graph(p_user_id UUID)
RETURNS json
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
  result json;
  gravity_json json;
  anchor_links_map json;
BEGIN
  -- ─── Step 1: Compute gravity anchors separately to avoid CTE complexity ───
  -- Top 10 anchors by edge connection count
  SELECT COALESCE(json_agg(row_to_json(t) ORDER BY t.connection_count DESC), '[]'::json)
  INTO gravity_json
  FROM (
    SELECT kn.id, kn.label, kn.entity_type AS "entityType",
           COUNT(DISTINCT e.id) AS "connectionCount"
    FROM knowledge_nodes kn
    JOIN knowledge_edges e
      ON (e.source_node_id = kn.id OR e.target_node_id = kn.id)
      AND e.user_id = p_user_id
    WHERE kn.user_id = p_user_id
      AND kn.is_anchor = true
      AND kn.is_merged = false
    GROUP BY kn.id, kn.label, kn.entity_type
    ORDER BY COUNT(DISTINCT e.id) DESC
    LIMIT 10
  ) t;

  -- ─── Step 2: Build source-to-anchor link map ─────────────────────────────
  -- For each source, find which top anchors its entities connect to via edges
  SELECT COALESCE(json_object_agg(source_id, links), '{}'::json)
  INTO anchor_links_map
  FROM (
    SELECT
      sub.source_id,
      json_agg(json_build_object(
        'anchorId', sub.anchor_id,
        'strength', sub.link_count::float / GREATEST(sub.max_count, 1)
      ) ORDER BY sub.link_count DESC) AS links
    FROM (
      SELECT
        ent.source_id,
        ta.id AS anchor_id,
        COUNT(*) AS link_count,
        MAX(COUNT(*)) OVER () AS max_count
      FROM knowledge_nodes ent
      JOIN knowledge_edges e
        ON (e.source_node_id = ent.id OR e.target_node_id = ent.id)
        AND e.user_id = p_user_id
      JOIN (
        SELECT kn.id
        FROM knowledge_nodes kn
        JOIN knowledge_edges e2
          ON (e2.source_node_id = kn.id OR e2.target_node_id = kn.id)
          AND e2.user_id = p_user_id
        WHERE kn.user_id = p_user_id
          AND kn.is_anchor = true
          AND kn.is_merged = false
        GROUP BY kn.id
        ORDER BY COUNT(DISTINCT e2.id) DESC
        LIMIT 10
      ) ta ON (ta.id = e.source_node_id OR ta.id = e.target_node_id)
      WHERE ent.user_id = p_user_id
        AND ent.is_anchor = false
        AND ent.is_merged = false
        AND ent.source_id IS NOT NULL
      GROUP BY ent.source_id, ta.id
    ) sub
    GROUP BY sub.source_id
  ) agg;

  -- ─── Step 3: Main query (sources, edges, stats) ──────────────────────────
  WITH sources AS (
    SELECT id, title, source_type, metadata, created_at
    FROM knowledge_sources
    WHERE user_id = p_user_id
  ),

  entities AS (
    SELECT id, label, source_id, entity_type
    FROM knowledge_nodes
    WHERE user_id = p_user_id
      AND is_anchor = false
      AND is_merged = false
      AND source_id IS NOT NULL
  ),

  entity_counts AS (
    SELECT source_id, COUNT(*) AS cnt
    FROM entities
    GROUP BY source_id
  ),

  type_dist AS (
    SELECT source_id, entity_type, COUNT(*) AS cnt
    FROM entities
    GROUP BY source_id, entity_type
  ),

  entity_labels AS (
    SELECT source_id, entity_type || '::' || lower(trim(label)) AS norm_label
    FROM entities
    WHERE label IS NOT NULL
  ),

  shared_entity_pairs AS (
    SELECT
      el1.source_id AS source_a,
      el2.source_id AS source_b,
      COUNT(*) AS shared_count
    FROM entity_labels el1
    JOIN entity_labels el2
      ON el1.norm_label = el2.norm_label
      AND el1.source_id < el2.source_id
    GROUP BY el1.source_id, el2.source_id
  ),

  ranked_edges AS (
    SELECT *,
      ROW_NUMBER() OVER (ORDER BY shared_count DESC) AS rn
    FROM shared_entity_pairs
  ),

  top_edges AS (
    SELECT * FROM ranked_edges WHERE rn <= 80
  ),

  max_shared AS (
    SELECT COALESCE(MAX(shared_count), 1) AS val FROM top_edges
  )

  SELECT json_build_object(
    'sources', COALESCE((
      SELECT json_agg(json_build_object(
        'id', s.id,
        'kind', 'source',
        'label', COALESCE(s.title, 'Untitled'),
        'sourceType', COALESCE(s.source_type, 'Document'),
        'entityCount', COALESCE(ec.cnt, 0),
        'anchorRelevance', 1,
        'typeDistribution', COALESCE(
          (SELECT json_agg(json_build_object(
            'entityType', td.entity_type,
            'count', td.cnt,
            'fraction', CASE WHEN COALESCE(ec.cnt, 0) > 0
              THEN td.cnt::float / ec.cnt
              ELSE 0 END
          ) ORDER BY td.cnt DESC)
          FROM type_dist td WHERE td.source_id = s.id),
          '[]'::json
        ),
        'bridgeAnchorIds', '[]'::json,
        'createdAt', s.created_at,
        'metadata', COALESCE(s.metadata, '{}'::jsonb),
        'anchorLinks', COALESCE(
          anchor_links_map->s.id::text,
          '[]'::json
        )
      ) ORDER BY s.created_at DESC)
      FROM sources s
      LEFT JOIN entity_counts ec ON ec.source_id = s.id
    ), '[]'::json),

    'edges', COALESCE((
      SELECT json_agg(json_build_object(
        'fromSourceId', te.source_a,
        'toSourceId', te.source_b,
        'sharedEntityCount', te.shared_count,
        'strength', te.shared_count::float / ms.val
      ))
      FROM top_edges te
      CROSS JOIN max_shared ms
    ), '[]'::json),

    'gravityAnchors', gravity_json,

    'stats', json_build_object(
      'sourceCount', (SELECT COUNT(*) FROM sources),
      'entityCount', (SELECT COUNT(*) FROM entities),
      'connectionCount', (SELECT COUNT(*) FROM top_edges)
    )
  ) INTO result;

  RETURN result;
END;
$$;
