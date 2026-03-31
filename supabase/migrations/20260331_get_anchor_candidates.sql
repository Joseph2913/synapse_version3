-- Migration: get_anchor_candidates RPC function
-- Purpose: Replaces 15-25 separate queries in fetchCandidatesWithNodes() with one call.
-- Fetches all candidates with node data, pre-computed connection counts,
-- anchor connections, source diversity, and live signal scores.
--
-- Called from: src/services/anchorCandidates.ts -> fetchCandidatesWithNodes()
-- See: docs/PERFORMANCE-PATTERNS.md

CREATE OR REPLACE FUNCTION get_anchor_candidates(p_user_id UUID)
RETURNS json
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
  result json;
BEGIN
  WITH candidates AS (
    SELECT *
    FROM anchor_candidates
    WHERE user_id = p_user_id
    ORDER BY composite_score DESC
  ),

  -- Join node data
  candidate_nodes AS (
    SELECT
      c.*,
      kn.id AS n_id,
      kn.label AS n_label,
      kn.entity_type AS n_entity_type,
      kn.description AS n_description,
      kn.quote AS n_quote,
      kn.user_tags AS n_user_tags,
      kn.confidence AS n_confidence,
      kn.is_anchor AS n_is_anchor,
      kn.parent_anchor_id AS n_parent_anchor_id,
      kn.created_at AS n_created_at
    FROM candidates c
    LEFT JOIN knowledge_nodes kn
      ON kn.id = c.node_id AND kn.is_merged = false
  ),

  -- All candidate node IDs
  node_ids AS (
    SELECT DISTINCT node_id FROM candidates WHERE node_id IS NOT NULL
  ),

  -- Connection counts: total edges per candidate node
  connection_counts AS (
    SELECT node_id, COUNT(*) AS total_edges
    FROM (
      SELECT source_node_id AS node_id FROM knowledge_edges
      WHERE user_id = p_user_id AND source_node_id IN (SELECT node_id FROM node_ids)
      UNION ALL
      SELECT target_node_id AS node_id FROM knowledge_edges
      WHERE user_id = p_user_id AND target_node_id IN (SELECT node_id FROM node_ids)
    ) edges
    GROUP BY node_id
  ),

  -- Anchor connection counts: edges to other anchor nodes
  anchor_nodes AS (
    SELECT id FROM knowledge_nodes
    WHERE user_id = p_user_id AND is_anchor = true AND is_merged = false
  ),

  anchor_connections AS (
    SELECT node_id, COUNT(DISTINCT anchor_id) AS anchor_count
    FROM (
      SELECT e.source_node_id AS node_id, e.target_node_id AS anchor_id
      FROM knowledge_edges e
      WHERE e.user_id = p_user_id
        AND e.source_node_id IN (SELECT node_id FROM node_ids)
        AND e.target_node_id IN (SELECT id FROM anchor_nodes)
        AND e.target_node_id != e.source_node_id
      UNION ALL
      SELECT e.target_node_id AS node_id, e.source_node_id AS anchor_id
      FROM knowledge_edges e
      WHERE e.user_id = p_user_id
        AND e.target_node_id IN (SELECT node_id FROM node_ids)
        AND e.source_node_id IN (SELECT id FROM anchor_nodes)
        AND e.source_node_id != e.target_node_id
    ) sub
    GROUP BY node_id
  ),

  -- Source diversity: distinct sources and source types per candidate node
  neighbor_edges AS (
    SELECT source_node_id AS node_id, target_node_id AS neighbor_id
    FROM knowledge_edges
    WHERE user_id = p_user_id AND source_node_id IN (SELECT node_id FROM node_ids)
    UNION ALL
    SELECT target_node_id AS node_id, source_node_id AS neighbor_id
    FROM knowledge_edges
    WHERE user_id = p_user_id AND target_node_id IN (SELECT node_id FROM node_ids)
  ),

  neighbor_sources AS (
    SELECT
      ne.node_id,
      kn.source_id,
      kn.source_type,
      kn.entity_type AS neighbor_entity_type
    FROM neighbor_edges ne
    JOIN knowledge_nodes kn ON kn.id = ne.neighbor_id
    WHERE kn.source_id IS NOT NULL
  ),

  source_diversity AS (
    SELECT
      node_id,
      COUNT(DISTINCT source_id) AS source_count,
      COUNT(DISTINCT source_type) AS unique_source_types,
      COUNT(DISTINCT neighbor_entity_type) AS neighbor_type_count
    FROM neighbor_sources
    GROUP BY node_id
  ),

  -- Relation type diversity per node
  relation_diversity AS (
    SELECT node_id, COUNT(DISTINCT relation_type) AS rel_type_count
    FROM (
      SELECT source_node_id AS node_id, relation_type
      FROM knowledge_edges
      WHERE user_id = p_user_id AND source_node_id IN (SELECT node_id FROM node_ids) AND relation_type IS NOT NULL
      UNION ALL
      SELECT target_node_id AS node_id, relation_type
      FROM knowledge_edges
      WHERE user_id = p_user_id AND target_node_id IN (SELECT node_id FROM node_ids) AND relation_type IS NOT NULL
    ) sub
    GROUP BY node_id
  ),

  -- Suggested count
  suggested_count AS (
    SELECT COUNT(*) AS cnt FROM candidates WHERE status = 'suggested'
  )

  SELECT json_build_object(
    'candidates', COALESCE((
      SELECT json_agg(json_build_object(
        'id', cn.id,
        'userId', cn.user_id,
        'nodeId', cn.node_id,
        'compositeScore', cn.composite_score,
        'centralityScore', cn.centrality_score,
        'diversityScore', cn.diversity_score,
        'velocityScore', cn.velocity_score,
        'richnessScore', cn.richness_score,
        'behaviouralScore', cn.behavioural_score,
        'mentionCount', cn.mention_count,
        'sourceCount', COALESCE(sd.source_count, cn.source_count),
        'uniqueSourceTypes', COALESCE(sd.unique_source_types, cn.unique_source_types),
        'daysActive', cn.days_active,
        'recentVelocity', cn.recent_velocity,
        'velocityDirection', cn.velocity_direction,
        'status', cn.status,
        'scoringProfile', cn.scoring_profile,
        'reasoningText', cn.reasoning_text,
        'firstScoredAt', cn.first_scored_at,
        'lastScoredAt', cn.last_scored_at,
        'suggestedAt', cn.suggested_at,
        'reviewedAt', cn.reviewed_at,
        'dormantSince', cn.dormant_since,
        'dismissCount', cn.dismiss_count,
        'resurface_after', cn.resurface_after,
        'thresholdAtScoring', cn.threshold_at_scoring,
        'totalEdges', COALESCE(cc.total_edges, cn.total_edges, 0),
        'createdAt', cn.created_at,
        'updatedAt', cn.updated_at,
        'suggestedParentAnchorId', cn.suggested_parent_anchor_id,
        'connectionCount', COALESCE(cc.total_edges, 0),
        'anchorConnections', COALESCE(ac.anchor_count, 0),
        'node', CASE WHEN cn.n_id IS NOT NULL THEN json_build_object(
          'id', cn.n_id,
          'label', cn.n_label,
          'entity_type', cn.n_entity_type,
          'description', cn.n_description,
          'quote', cn.n_quote,
          'user_tags', cn.n_user_tags,
          'confidence', cn.n_confidence,
          'is_anchor', cn.n_is_anchor,
          'parent_anchor_id', cn.n_parent_anchor_id,
          'created_at', cn.n_created_at
        ) ELSE NULL END,
        -- Live signal inputs for client-side score override
        'liveNeighborTypeCount', COALESCE(sd.neighbor_type_count, 0),
        'liveRelTypeCount', COALESCE(rd.rel_type_count, 0)
      ) ORDER BY cn.composite_score DESC)
      FROM candidate_nodes cn
      LEFT JOIN connection_counts cc ON cc.node_id = cn.node_id
      LEFT JOIN anchor_connections ac ON ac.node_id = cn.node_id
      LEFT JOIN source_diversity sd ON sd.node_id = cn.node_id
      LEFT JOIN relation_diversity rd ON rd.node_id = cn.node_id
    ), '[]'::json),
    'suggestedCount', (SELECT cnt FROM suggested_count)
  ) INTO result;

  RETURN result;
END;
$$;
