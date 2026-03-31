-- Migration: get_home_dashboard RPC function
-- Purpose: Collapses 12-15 separate Supabase requests into a single server-side call
-- for the Home dashboard page. Previously the browser fired 8 COUNT queries, fetched
-- recent sources/anchors/skills separately, then made N+1 queries for entity counts
-- and connection counts. This function does it all in one pass.
--
-- Called from: src/hooks/useHomeDashboard.ts
-- See: docs/PERFORMANCE-PATTERNS.md for the full decision record.

CREATE OR REPLACE FUNCTION get_home_dashboard(p_user_id UUID)
RETURNS json
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
  result json;
BEGIN
  WITH
  -- ─── STATS: Total counts + 7-day deltas (replaces 8 parallel COUNT queries) ───
  seven_day_cutoff AS (
    SELECT (now() - interval '7 days') AS ts
  ),

  stats AS (
    SELECT json_build_object(
      'totalSources',   (SELECT COUNT(*) FROM knowledge_sources WHERE user_id = p_user_id),
      'totalNodes',      (SELECT COUNT(*) FROM knowledge_nodes WHERE user_id = p_user_id),
      'activeAnchors',   (SELECT COUNT(*) FROM knowledge_nodes WHERE user_id = p_user_id AND is_anchor = true),
      'activeSkills',    (SELECT COUNT(*) FROM knowledge_skills WHERE user_id = p_user_id),
      'sourcesDelta7d',  (SELECT COUNT(*) FROM knowledge_sources WHERE user_id = p_user_id AND created_at >= (SELECT ts FROM seven_day_cutoff)),
      'nodesDelta7d',    (SELECT COUNT(*) FROM knowledge_nodes WHERE user_id = p_user_id AND created_at >= (SELECT ts FROM seven_day_cutoff)),
      'anchorsDelta7d',  (SELECT COUNT(*) FROM knowledge_nodes WHERE user_id = p_user_id AND is_anchor = true AND created_at >= (SELECT ts FROM seven_day_cutoff)),
      'skillsDelta7d',   (SELECT COUNT(*) FROM knowledge_skills WHERE user_id = p_user_id AND created_at >= (SELECT ts FROM seven_day_cutoff))
    ) AS val
  ),

  -- ─── RECENT SOURCES: 5 most recent with entity counts pre-joined ──────────
  recent_sources_raw AS (
    SELECT s.id, s.title, s.source_type, s.source_url, s.metadata, s.summary, s.created_at
    FROM knowledge_sources s
    WHERE s.user_id = p_user_id
    ORDER BY s.created_at DESC
    LIMIT 5
  ),

  source_entity_counts AS (
    SELECT kn.source_id, COUNT(*) AS entity_count
    FROM knowledge_nodes kn
    WHERE kn.user_id = p_user_id
      AND kn.source_id IN (SELECT id FROM recent_sources_raw)
    GROUP BY kn.source_id
  ),

  recent_sources AS (
    SELECT json_agg(
      json_build_object(
        'id', rs.id,
        'title', rs.title,
        'source_type', rs.source_type,
        'source_url', rs.source_url,
        'metadata', rs.metadata,
        'summary', rs.summary,
        'created_at', rs.created_at,
        'entityCount', COALESCE(sec.entity_count, 0)
      ) ORDER BY rs.created_at DESC
    ) AS val
    FROM recent_sources_raw rs
    LEFT JOIN source_entity_counts sec ON sec.source_id = rs.id
  ),

  -- ─── RECENT ANCHORS: 5 most recent with connection counts via lateral ─────
  recent_anchors_raw AS (
    SELECT id, label, entity_type, description, is_anchor, created_at, user_id, source_id
    FROM knowledge_nodes
    WHERE user_id = p_user_id
      AND is_anchor = true
    ORDER BY created_at DESC
    LIMIT 5
  ),

  anchor_conn_counts AS (
    SELECT ra.id AS anchor_id, COUNT(*) AS connection_count
    FROM recent_anchors_raw ra
    JOIN knowledge_edges e
      ON e.user_id = p_user_id
      AND (e.source_node_id = ra.id OR e.target_node_id = ra.id)
    GROUP BY ra.id
  ),

  recent_anchors AS (
    SELECT json_agg(
      json_build_object(
        'id', ra.id,
        'label', ra.label,
        'entity_type', ra.entity_type,
        'description', ra.description,
        'is_anchor', ra.is_anchor,
        'created_at', ra.created_at,
        'user_id', ra.user_id,
        'source_id', ra.source_id,
        'connectionCount', COALESCE(acc.connection_count, 0)
      ) ORDER BY ra.created_at DESC
    ) AS val
    FROM recent_anchors_raw ra
    LEFT JOIN anchor_conn_counts acc ON acc.anchor_id = ra.id
  ),

  -- ─── RECENT SKILLS: 5 most used ──────────────────────────────────────────
  recent_skills AS (
    SELECT json_agg(
      json_build_object(
        'id', ks.id,
        'name', ks.name,
        'title', ks.title,
        'description', ks.description,
        'domain', ks.domain,
        'status', ks.status,
        'confidence', ks.confidence,
        'created_at', ks.created_at,
        'user_id', ks.user_id,
        'tags', ks.tags,
        'source_count', ks.source_count,
        'usage_count', ks.usage_count,
        'last_used_at', ks.last_used_at,
        'updated_at', ks.updated_at
      ) ORDER BY ks.usage_count DESC NULLS LAST, ks.confidence DESC NULLS LAST
    ) AS val
    FROM (
      SELECT *
      FROM knowledge_skills
      WHERE user_id = p_user_id
      ORDER BY usage_count DESC NULLS LAST, confidence DESC NULLS LAST
      LIMIT 5
    ) ks
  ),

  -- ─── CROSS-CONNECTIONS: 5 most recent cross-source edges ──────────────────
  recent_edges AS (
    SELECT e.id, e.relation_type, e.created_at,
           e.source_node_id, e.target_node_id
    FROM knowledge_edges e
    WHERE e.user_id = p_user_id
    ORDER BY e.created_at DESC
    LIMIT 15  -- fetch extra to filter for cross-source
  ),

  edge_nodes AS (
    SELECT kn.id, kn.label, kn.entity_type, kn.source_id
    FROM knowledge_nodes kn
    WHERE kn.id IN (
      SELECT source_node_id FROM recent_edges
      UNION
      SELECT target_node_id FROM recent_edges
    )
  ),

  cross_edges AS (
    SELECT
      re.id, re.relation_type, re.created_at,
      sn.id AS sn_id, sn.label AS sn_label, sn.entity_type AS sn_entity_type, sn.source_id AS sn_source_id,
      tn.id AS tn_id, tn.label AS tn_label, tn.entity_type AS tn_entity_type, tn.source_id AS tn_source_id
    FROM recent_edges re
    JOIN edge_nodes sn ON sn.id = re.source_node_id
    JOIN edge_nodes tn ON tn.id = re.target_node_id
    WHERE sn.source_id IS NOT NULL
      AND tn.source_id IS NOT NULL
      AND sn.source_id <> tn.source_id
    LIMIT 5
  ),

  cross_source_titles AS (
    SELECT ks.id, ks.title
    FROM knowledge_sources ks
    WHERE ks.id IN (
      SELECT sn_source_id FROM cross_edges
      UNION
      SELECT tn_source_id FROM cross_edges
    )
  ),

  cross_connections AS (
    SELECT json_agg(
      json_build_object(
        'id', ce.id,
        'sourceNode', json_build_object(
          'id', ce.sn_id,
          'label', ce.sn_label,
          'entity_type', ce.sn_entity_type,
          'source_id', ce.sn_source_id
        ),
        'targetNode', json_build_object(
          'id', ce.tn_id,
          'label', ce.tn_label,
          'entity_type', ce.tn_entity_type,
          'source_id', ce.tn_source_id
        ),
        'relation_type', COALESCE(ce.relation_type, 'relates_to'),
        'sourceTitles', (
          SELECT json_build_array(
            COALESCE((SELECT title FROM cross_source_titles WHERE id = ce.sn_source_id), 'Untitled'),
            COALESCE((SELECT title FROM cross_source_titles WHERE id = ce.tn_source_id), 'Untitled')
          )
        ),
        'created_at', ce.created_at
      ) ORDER BY ce.created_at DESC
    ) AS val
    FROM cross_edges ce
  ),

  -- ─── PIPELINE STATUS ──────────────────────────────────────────────────────
  -- Note: youtube_scan_history and youtube_ingestion_queue may not exist for all
  -- deployments. Since this function runs server-side where the tables DO exist
  -- (they're part of the Supabase schema), we query them directly.
  last_scan AS (
    SELECT created_at, videos_found
    FROM youtube_scan_history
    WHERE user_id = p_user_id
    ORDER BY created_at DESC
    LIMIT 1
  ),

  pipeline_status AS (
    SELECT json_build_object(
      'lastScanAt', (SELECT created_at FROM last_scan),
      'lastScanVideosFound', COALESCE((SELECT videos_found FROM last_scan), 0),
      'pendingQueueCount', (
        SELECT COUNT(*) FROM youtube_ingestion_queue
        WHERE user_id = p_user_id AND status = 'pending'
      ),
      'failedQueueCount', (
        SELECT COUNT(*) FROM youtube_ingestion_queue
        WHERE user_id = p_user_id AND status = 'failed'
          AND created_at >= (now() - interval '7 days')
      ),
      'lastProcessedSource', (
        SELECT json_build_object(
          'title', COALESCE(title, 'Untitled'),
          'created_at', created_at
        )
        FROM knowledge_sources
        WHERE user_id = p_user_id
        ORDER BY created_at DESC
        LIMIT 1
      )
    ) AS val
  ),

  -- ─── SNAPSHOT: Entity type + source type distributions ────────────────────
  entity_type_counts AS (
    SELECT entity_type, COUNT(*) AS cnt
    FROM knowledge_nodes
    WHERE user_id = p_user_id
    GROUP BY entity_type
    ORDER BY cnt DESC
    LIMIT 5
  ),

  source_type_counts AS (
    SELECT COALESCE(source_type, 'Other') AS source_type, COUNT(*) AS cnt
    FROM knowledge_sources
    WHERE user_id = p_user_id
    GROUP BY 1
    ORDER BY cnt DESC
  ),

  top_anchors_raw AS (
    SELECT kn.id, kn.label, kn.entity_type
    FROM knowledge_nodes kn
    WHERE kn.user_id = p_user_id AND kn.is_anchor = true
    LIMIT 8
  ),

  top_anchor_counts AS (
    SELECT ta.id, ta.label, ta.entity_type, COUNT(e.id) AS connection_count
    FROM top_anchors_raw ta
    LEFT JOIN knowledge_edges e
      ON e.user_id = p_user_id
      AND (e.source_node_id = ta.id OR e.target_node_id = ta.id)
    GROUP BY ta.id, ta.label, ta.entity_type
    ORDER BY connection_count DESC
    LIMIT 4
  ),

  snapshot AS (
    SELECT json_build_object(
      'entityTypeCounts', COALESCE(
        (SELECT json_agg(json_build_object('entity_type', entity_type, 'count', cnt))
         FROM entity_type_counts),
        '[]'::json
      ),
      'sourceTypeCounts', COALESCE(
        (SELECT json_agg(json_build_object('source_type', source_type, 'count', cnt))
         FROM source_type_counts),
        '[]'::json
      ),
      'topAnchors', COALESCE(
        (SELECT json_agg(json_build_object(
          'id', id, 'label', label, 'entity_type', entity_type,
          'connectionCount', connection_count
        ) ORDER BY connection_count DESC)
         FROM top_anchor_counts),
        '[]'::json
      )
    ) AS val
  )

  -- ─── FINAL ASSEMBLY ───────────────────────────────────────────────────────
  SELECT json_build_object(
    'stats', (SELECT val FROM stats),
    'recentSources', COALESCE((SELECT val FROM recent_sources), '[]'::json),
    'recentAnchors', COALESCE((SELECT val FROM recent_anchors), '[]'::json),
    'recentSkills', COALESCE((SELECT val FROM recent_skills), '[]'::json),
    'crossConnections', COALESCE((SELECT val FROM cross_connections), '[]'::json),
    'pipelineStatus', (SELECT val FROM pipeline_status),
    'snapshot', (SELECT val FROM snapshot)
  ) INTO result;

  RETURN result;
END;
$$;
