-- Migration: get_playlist_graph RPC function
-- Purpose: Computes playlist-level and video-level graph data for the Explore Playlists tab.
-- Returns playlists, cross-playlist edges, videos (completed only), and video-to-video edges.
--
-- Join path:
--   youtube_playlists → youtube_ingestion_queue (playlist_id + source_id)
--   → knowledge_nodes (source_id) → knowledge_edges → knowledge_nodes (source_id)
--   → knowledge_sources → youtube_ingestion_queue → youtube_playlists
--
-- Called from: src/services/exploreQueries.ts -> fetchPlaylistGraph()

CREATE OR REPLACE FUNCTION get_playlist_graph(p_user_id UUID)
RETURNS json
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
  result json;
BEGIN
  WITH playlists AS (
    SELECT id, playlist_id, playlist_name, playlist_url, synapse_code, is_active
    FROM youtube_playlists
    WHERE user_id = p_user_id
  ),

  -- Completed videos with source_id and playlist_id
  videos AS (
    SELECT
      q.id AS queue_id,
      q.video_id,
      q.video_title,
      q.video_url,
      q.thumbnail_url,
      q.published_at,
      q.source_id,
      q.playlist_id,
      q.nodes_created
    FROM youtube_ingestion_queue q
    WHERE q.user_id = p_user_id
      AND q.status = 'completed'
      AND q.source_id IS NOT NULL
      AND q.playlist_id IS NOT NULL
  ),

  -- Video count per playlist
  playlist_video_counts AS (
    SELECT playlist_id, COUNT(*) AS video_count
    FROM videos
    GROUP BY playlist_id
  ),

  -- Non-anchor entities belonging to video sources
  video_entities AS (
    SELECT kn.id AS entity_id, kn.source_id, v.playlist_id
    FROM knowledge_nodes kn
    JOIN videos v ON kn.source_id = v.source_id
    WHERE kn.user_id = p_user_id
      AND kn.is_anchor = false
      AND kn.is_merged = false
      AND kn.source_id IS NOT NULL
  ),

  -- Entity count per video (source)
  video_entity_counts AS (
    SELECT source_id, COUNT(*) AS entity_count
    FROM video_entities
    GROUP BY source_id
  ),

  -- Cross-source entity edges (edges between entities from different sources)
  -- Both directions normalized via LEAST/GREATEST
  cross_source_edges AS (
    SELECT
      LEAST(ve1.source_id, ve2.source_id) AS source_a,
      GREATEST(ve1.source_id, ve2.source_id) AS source_b,
      LEAST(ve1.playlist_id, ve2.playlist_id) AS playlist_a,
      GREATEST(ve1.playlist_id, ve2.playlist_id) AS playlist_b,
      COUNT(*) AS edge_count
    FROM knowledge_edges ke
    JOIN video_entities ve1 ON ke.source_node_id = ve1.entity_id
    JOIN video_entities ve2 ON ke.target_node_id = ve2.entity_id
    WHERE ke.user_id = p_user_id
      AND ve1.source_id != ve2.source_id
    GROUP BY
      LEAST(ve1.source_id, ve2.source_id),
      GREATEST(ve1.source_id, ve2.source_id),
      LEAST(ve1.playlist_id, ve2.playlist_id),
      GREATEST(ve1.playlist_id, ve2.playlist_id)
  ),

  -- Aggregate to playlist-level edges
  playlist_edges AS (
    SELECT
      playlist_a,
      playlist_b,
      SUM(edge_count) AS connection_count,
      COUNT(DISTINCT source_a || ':' || source_b) AS video_pair_count
    FROM cross_source_edges
    WHERE playlist_a != playlist_b
    GROUP BY playlist_a, playlist_b
  ),

  -- Video-to-video edges (all cross-source, regardless of playlist)
  video_edges AS (
    SELECT
      source_a,
      source_b,
      edge_count AS shared_entity_count
    FROM cross_source_edges
  )

  SELECT json_build_object(
    'playlists', COALESCE((
      SELECT json_agg(json_build_object(
        'id', p.id,
        'playlistName', COALESCE(p.playlist_name, 'Untitled Playlist'),
        'playlistUrl', p.playlist_url,
        'synapseCode', p.synapse_code,
        'isActive', p.is_active,
        'videoCount', COALESCE(pvc.video_count, 0)
      ) ORDER BY COALESCE(pvc.video_count, 0) DESC)
      FROM playlists p
      LEFT JOIN playlist_video_counts pvc ON pvc.playlist_id = p.id
    ), '[]'::json),

    'playlistEdges', COALESCE((
      SELECT json_agg(json_build_object(
        'fromPlaylistId', pe.playlist_a,
        'toPlaylistId', pe.playlist_b,
        'connectionCount', pe.connection_count,
        'videoPairCount', pe.video_pair_count
      ))
      FROM playlist_edges pe
      WHERE pe.connection_count > 0
    ), '[]'::json),

    'videos', COALESCE((
      SELECT json_agg(json_build_object(
        'sourceId', v.source_id,
        'videoTitle', COALESCE(v.video_title, 'Untitled'),
        'videoUrl', v.video_url,
        'thumbnailUrl', v.thumbnail_url,
        'playlistId', v.playlist_id,
        'entityCount', COALESCE(vec.entity_count, 0),
        'publishedAt', v.published_at
      ) ORDER BY v.published_at DESC)
      FROM videos v
      LEFT JOIN video_entity_counts vec ON vec.source_id = v.source_id
    ), '[]'::json),

    'videoEdges', COALESCE((
      SELECT json_agg(json_build_object(
        'fromSourceId', ve.source_a,
        'toSourceId', ve.source_b,
        'sharedEntityCount', ve.shared_entity_count
      ))
      FROM video_edges ve
      WHERE ve.shared_entity_count > 0
    ), '[]'::json)
  ) INTO result;

  RETURN result;
END;
$$;
