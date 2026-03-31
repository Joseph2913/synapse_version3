-- Migration: get_all_sources_graph RPC function
-- Purpose: Replaces fetchAllSourcesLevelData() client-side computation.
-- Previously downloaded ALL sources + ALL entities to compute source landscape.
-- Now returns source nodes, source-to-source edges, and stats in one call.
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
BEGIN
  WITH sources AS (
    SELECT id, title, source_type, metadata, created_at
    FROM knowledge_sources
    WHERE user_id = p_user_id
  ),

  -- Non-anchor entities with source_id
  entities AS (
    SELECT id, label, source_id, entity_type
    FROM knowledge_nodes
    WHERE user_id = p_user_id
      AND is_anchor = false
      AND is_merged = false
      AND source_id IS NOT NULL
  ),

  -- Entity count per source
  entity_counts AS (
    SELECT source_id, COUNT(*) AS cnt
    FROM entities
    GROUP BY source_id
  ),

  -- Type distribution per source
  type_dist AS (
    SELECT source_id, entity_type, COUNT(*) AS cnt
    FROM entities
    GROUP BY source_id, entity_type
  ),

  -- Normalized entity labels for edge computation
  entity_labels AS (
    SELECT source_id, entity_type || '::' || lower(trim(label)) AS norm_label
    FROM entities
    WHERE label IS NOT NULL
  ),

  -- Find shared entities between source pairs (same normalized label)
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

  -- Rank and keep top 80 strongest edges
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
        'metadata', COALESCE(s.metadata, '{}'::jsonb)
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

    'stats', json_build_object(
      'sourceCount', (SELECT COUNT(*) FROM sources),
      'entityCount', (SELECT COUNT(*) FROM entities),
      'connectionCount', (SELECT COUNT(*) FROM top_edges)
    )
  ) INTO result;

  RETURN result;
END;
$$;
