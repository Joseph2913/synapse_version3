-- Migration: update get_activity_feed to show sources still being processed
-- Purpose: The previous version silently dropped any paginated source that had
-- zero extracted knowledge_nodes. That made freshly-ingested sources invisible
-- on the Sources page even though the chip counts included them, producing an
-- apparent "only one source shows up" bug.
--
-- Change vs 20260331_get_activity_feed.sql:
--   • Remove the `WHERE s.id IN (SELECT id FROM extracted_source_ids)` filter
--     at the end of the feed_items CTE. Every paginated source is now returned.
--   • `extracted_source_ids` CTE is no longer needed — removed.
--   • entityCount remains in the payload; the UI uses entityCount === 0 as the
--     signal to render a "Processing…" badge instead of stats.

CREATE OR REPLACE FUNCTION get_activity_feed(
  p_user_id UUID,
  p_limit INT DEFAULT 20,
  p_offset INT DEFAULT 0
)
RETURNS json
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
  result json;
BEGIN
  WITH
  page_sources AS (
    SELECT id, title, source_type, source_url, content, metadata, created_at,
           user_id, summary, summary_source
    FROM knowledge_sources
    WHERE user_id = p_user_id
    ORDER BY created_at DESC
    OFFSET p_offset
    LIMIT p_limit + 1
  ),

  trimmed_sources AS (
    SELECT * FROM page_sources
    LIMIT p_limit
  ),

  has_more AS (
    SELECT (SELECT COUNT(*) FROM page_sources) > p_limit AS val
  ),

  source_nodes AS (
    SELECT kn.id, kn.source_id, kn.label, kn.entity_type, kn.confidence, kn.is_anchor
    FROM knowledge_nodes kn
    WHERE kn.user_id = p_user_id
      AND kn.source_id IN (SELECT id FROM trimmed_sources)
  ),

  all_edges AS (
    SELECT DISTINCT e.id, e.source_node_id, e.target_node_id, e.relation_type
    FROM knowledge_edges e
    WHERE e.user_id = p_user_id
      AND (
        e.source_node_id IN (SELECT id FROM source_nodes)
        OR e.target_node_id IN (SELECT id FROM source_nodes)
      )
  ),

  other_node_ids AS (
    SELECT DISTINCT target_node_id AS id FROM all_edges
    WHERE target_node_id NOT IN (SELECT id FROM source_nodes)
    UNION
    SELECT DISTINCT source_node_id AS id FROM all_edges
    WHERE source_node_id NOT IN (SELECT id FROM source_nodes)
  ),

  other_nodes AS (
    SELECT kn.id, kn.label, kn.entity_type, kn.source_id, kn.is_anchor
    FROM knowledge_nodes kn
    WHERE kn.id IN (SELECT id FROM other_node_ids)
  ),

  other_source_meta AS (
    SELECT ks.id, ks.title, ks.source_type
    FROM knowledge_sources ks
    WHERE ks.id IN (
      SELECT DISTINCT source_id FROM other_nodes WHERE source_id IS NOT NULL
    )
  ),

  all_source_meta AS (
    SELECT id, title, source_type FROM trimmed_sources
    UNION ALL
    SELECT id, title, source_type FROM other_source_meta
  ),

  within_source_edges AS (
    SELECT
      sn1.source_id,
      e.id AS edge_id,
      e.source_node_id AS from_node_id,
      sn1.label AS from_label,
      sn1.entity_type AS from_entity_type,
      e.target_node_id AS to_node_id,
      sn2.label AS to_label,
      sn2.entity_type AS to_entity_type,
      COALESCE(e.relation_type, 'relates_to') AS relation_type,
      COALESCE(sn2.is_anchor, false) AS is_anchor,
      ROW_NUMBER() OVER (PARTITION BY sn1.source_id ORDER BY e.id) AS rn
    FROM all_edges e
    JOIN source_nodes sn1 ON sn1.id = e.source_node_id
    JOIN source_nodes sn2 ON sn2.id = e.target_node_id
    WHERE sn1.source_id = sn2.source_id
      AND sn1.source_id IS NOT NULL
  ),

  cross_source_edges_raw AS (
    SELECT
      sn.source_id,
      e.id AS edge_id,
      e.source_node_id AS from_node_id,
      sn.label AS from_label,
      sn.entity_type AS from_entity_type,
      COALESCE(on2.id, sn2.id) AS to_node_id,
      COALESCE(on2.label, sn2.label) AS to_label,
      COALESCE(on2.entity_type, sn2.entity_type) AS to_entity_type,
      COALESCE(e.relation_type, 'relates_to') AS relation_type,
      COALESCE(on2.is_anchor, sn2.is_anchor, false) AS is_anchor,
      COALESCE(on2.source_id, sn2.source_id) AS to_source_id
    FROM all_edges e
    JOIN source_nodes sn ON sn.id = e.source_node_id
    LEFT JOIN other_nodes on2 ON on2.id = e.target_node_id
    LEFT JOIN source_nodes sn2 ON sn2.id = e.target_node_id AND sn2.source_id <> sn.source_id
    WHERE sn.source_id IS NOT NULL
      AND (on2.id IS NOT NULL OR (sn2.id IS NOT NULL AND sn2.source_id <> sn.source_id))

    UNION ALL

    SELECT
      sn.source_id,
      e.id AS edge_id,
      e.target_node_id AS from_node_id,
      sn.label AS from_label,
      sn.entity_type AS from_entity_type,
      COALESCE(on2.id, sn2.id) AS to_node_id,
      COALESCE(on2.label, sn2.label) AS to_label,
      COALESCE(on2.entity_type, sn2.entity_type) AS to_entity_type,
      COALESCE(e.relation_type, 'relates_to') AS relation_type,
      COALESCE(on2.is_anchor, sn2.is_anchor, false) AS is_anchor,
      COALESCE(on2.source_id, sn2.source_id) AS to_source_id
    FROM all_edges e
    JOIN source_nodes sn ON sn.id = e.target_node_id
    LEFT JOIN other_nodes on2 ON on2.id = e.source_node_id
    LEFT JOIN source_nodes sn2 ON sn2.id = e.source_node_id AND sn2.source_id <> sn.source_id
    WHERE sn.source_id IS NOT NULL
      AND (on2.id IS NOT NULL OR (sn2.id IS NOT NULL AND sn2.source_id <> sn.source_id))
  ),

  cross_source_edges AS (
    SELECT DISTINCT ON (source_id, edge_id)
      source_id, edge_id, from_node_id, from_label, from_entity_type,
      to_node_id, to_label, to_entity_type, relation_type, is_anchor, to_source_id,
      ROW_NUMBER() OVER (PARTITION BY source_id ORDER BY edge_id) AS rn
    FROM cross_source_edges_raw
  ),

  relation_counts AS (
    SELECT source_id, COUNT(*) AS cnt
    FROM (
      SELECT sn.source_id, e.id
      FROM all_edges e
      JOIN source_nodes sn ON sn.id = e.source_node_id OR sn.id = e.target_node_id
      WHERE sn.source_id IS NOT NULL
    ) sub
    GROUP BY source_id
  ),

  feed_items AS (
    SELECT
      s.id AS source_id,
      s.created_at,
      json_build_object(
        'source', json_build_object(
          'id', s.id,
          'user_id', s.user_id,
          'title', s.title,
          'content', s.content,
          'source_type', s.source_type,
          'source_url', s.source_url,
          'metadata', s.metadata,
          'summary', s.summary,
          'summary_source', s.summary_source,
          'created_at', s.created_at
        ),
        'entityCount', (SELECT COUNT(*) FROM source_nodes sn WHERE sn.source_id = s.id),
        'relationCount', COALESCE((SELECT cnt FROM relation_counts rc WHERE rc.source_id = s.id), 0),
        'entities', COALESCE(
          (SELECT json_agg(json_build_object(
            'id', sn.id,
            'label', sn.label,
            'entityType', sn.entity_type,
            'confidence', sn.confidence
          ) ORDER BY sn.confidence DESC NULLS LAST)
          FROM source_nodes sn WHERE sn.source_id = s.id),
          '[]'::json
        ),
        'withinSourceConnections', COALESCE(
          (SELECT json_agg(json_build_object(
            'id', w.edge_id,
            'fromNodeId', w.from_node_id,
            'fromLabel', w.from_label,
            'fromEntityType', w.from_entity_type,
            'toNodeId', w.to_node_id,
            'toLabel', w.to_label,
            'toEntityType', w.to_entity_type,
            'relationType', w.relation_type,
            'isAnchor', w.is_anchor
          ) ORDER BY w.edge_id)
          FROM within_source_edges w WHERE w.source_id = s.id AND w.rn <= 500),
          '[]'::json
        ),
        'crossConnections', COALESCE(
          (SELECT json_agg(json_build_object(
            'id', c.edge_id,
            'fromNodeId', c.from_node_id,
            'fromLabel', c.from_label,
            'fromEntityType', c.from_entity_type,
            'toNodeId', c.to_node_id,
            'toLabel', c.to_label,
            'toEntityType', c.to_entity_type,
            'relationType', c.relation_type,
            'isAnchor', c.is_anchor,
            'toSourceId', c.to_source_id,
            'toSourceTitle', (SELECT asm.title FROM all_source_meta asm WHERE asm.id = c.to_source_id LIMIT 1),
            'toSourceType', (SELECT asm.source_type FROM all_source_meta asm WHERE asm.id = c.to_source_id LIMIT 1)
          ) ORDER BY c.edge_id)
          FROM cross_source_edges c WHERE c.source_id = s.id AND c.rn <= 500),
          '[]'::json
        ),
        'summary', COALESCE(
          s.summary,
          (s.metadata::json->>'summary'),
          CASE WHEN s.content IS NOT NULL AND length(s.content) > 0
            THEN substring(regexp_replace(regexp_replace(s.content, E'\\n+', ' ', 'g'), E'\\s+', ' ', 'g') FROM 1 FOR 180) || '...'
            ELSE NULL
          END
        ),
        'isFallbackSummary', (s.summary IS NULL AND (s.metadata IS NULL OR s.metadata::json->>'summary' IS NULL))
      ) AS item_json
    FROM trimmed_sources s
    ORDER BY s.created_at DESC
  )

  SELECT json_build_object(
    'items', COALESCE((SELECT json_agg(item_json ORDER BY created_at DESC) FROM feed_items), '[]'::json),
    'hasMore', (SELECT val FROM has_more)
  ) INTO result;

  RETURN result;
END;
$$;
