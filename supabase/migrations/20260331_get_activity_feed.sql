-- Migration: get_activity_feed RPC function
-- Purpose: Collapses 6-10 sequential Supabase requests into a single server-side call
-- for the Sources/Activity Feed page. Previously the browser fetched sources, then all
-- nodes, then batched edges in 50-node chunks, then "other" nodes, then other source
-- metadata — all with heavy client-side Map building and edge classification.
--
-- Called from: src/services/feedQueries.ts -> fetchActivityFeed()
-- See: docs/PERFORMANCE-PATTERNS.md for the full decision record.

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
  -- ─── Step 1: Paginated sources (fetch limit+1 to detect hasMore) ──────
  page_sources AS (
    SELECT id, title, source_type, source_url, content, metadata, created_at,
           user_id, summary, summary_source
    FROM knowledge_sources
    WHERE user_id = p_user_id
    ORDER BY created_at DESC
    OFFSET p_offset
    LIMIT p_limit + 1
  ),

  -- Trim to the actual page (keep first p_limit)
  trimmed_sources AS (
    SELECT * FROM page_sources
    LIMIT p_limit
  ),

  has_more AS (
    SELECT (SELECT COUNT(*) FROM page_sources) > p_limit AS val
  ),

  -- ─── Step 2: All nodes belonging to these sources ─────────────────────
  source_nodes AS (
    SELECT kn.id, kn.source_id, kn.label, kn.entity_type, kn.confidence, kn.is_anchor
    FROM knowledge_nodes kn
    WHERE kn.user_id = p_user_id
      AND kn.source_id IN (SELECT id FROM trimmed_sources)
  ),

  -- Only include sources that have at least one extracted node
  extracted_source_ids AS (
    SELECT DISTINCT source_id AS id FROM source_nodes WHERE source_id IS NOT NULL
  ),

  -- ─── Step 3: All edges touching any source node (single query, no batching) ─
  all_edges AS (
    SELECT DISTINCT e.id, e.source_node_id, e.target_node_id, e.relation_type
    FROM knowledge_edges e
    WHERE e.user_id = p_user_id
      AND (
        e.source_node_id IN (SELECT id FROM source_nodes)
        OR e.target_node_id IN (SELECT id FROM source_nodes)
      )
  ),

  -- ─── Step 4: Identify "other" nodes (external to the page sources) ────
  -- These are nodes on the far end of edges that don't belong to any page source
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

  -- ─── Step 5: Source titles for cross-connected sources ────────────────
  other_source_meta AS (
    SELECT ks.id, ks.title, ks.source_type
    FROM knowledge_sources ks
    WHERE ks.id IN (
      SELECT DISTINCT source_id FROM other_nodes WHERE source_id IS NOT NULL
    )
  ),

  -- Combined source meta: page sources + other sources
  all_source_meta AS (
    SELECT id, title, source_type FROM trimmed_sources
    UNION ALL
    SELECT id, title, source_type FROM other_source_meta
  ),

  -- ─── Step 6: Classify edges per source ────────────────────────────────
  -- For each source, classify each edge as within-source or cross-source

  -- Within-source: both endpoints belong to the same source
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

  -- Cross-source: one endpoint in this source, other is external or in a different page source
  -- Direction: "from" = internal node, "to" = external node (normalized)
  cross_source_edges_raw AS (
    -- Case 1: source_node_id is in source, target_node_id is external
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

    -- Case 2: target_node_id is in source, source_node_id is external
    -- Normalize: from = internal, to = external
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

  -- Deduplicate cross edges (same edge can appear from both directions)
  cross_source_edges AS (
    SELECT DISTINCT ON (source_id, edge_id)
      source_id, edge_id, from_node_id, from_label, from_entity_type,
      to_node_id, to_label, to_entity_type, relation_type, is_anchor, to_source_id,
      ROW_NUMBER() OVER (PARTITION BY source_id ORDER BY edge_id) AS rn
    FROM cross_source_edges_raw
  ),

  -- ─── Step 7: Count relations per source ───────────────────────────────
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

  -- ─── Step 8: Assemble per-source JSON ─────────────────────────────────
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
    WHERE s.id IN (SELECT id FROM extracted_source_ids)
    ORDER BY s.created_at DESC
  )

  -- ─── Final assembly ───────────────────────────────────────────────────
  SELECT json_build_object(
    'items', COALESCE((SELECT json_agg(item_json ORDER BY created_at DESC) FROM feed_items), '[]'::json),
    'hasMore', (SELECT val FROM has_more)
  ) INTO result;

  RETURN result;
END;
$$;
