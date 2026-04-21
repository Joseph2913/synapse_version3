-- Migration: atomic-claim RPC for the YouTube extraction queue
-- Purpose: The previous flow was "SELECT rows where status=transcript_ready,
-- then UPDATE each to status=extracting." Two overlapping cron invocations
-- could both SELECT the same rows before either UPDATEd, so both ran
-- extraction on the same video and (before the unique constraint) produced
-- duplicate knowledge_sources rows.
--
-- This function does both steps in a single statement using
-- `FOR UPDATE SKIP LOCKED`, so a row can be claimed by exactly one worker.
-- The stuck-item reset also lives here (bumped from 5 min to 30 min because
-- legitimate Gemini extractions of long videos regularly exceed 5 min).

CREATE OR REPLACE FUNCTION claim_youtube_extraction_batch(
  p_user_id UUID,
  p_limit INT DEFAULT 3,
  p_stuck_timeout_seconds INT DEFAULT 1800
)
RETURNS SETOF youtube_ingestion_queue
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
BEGIN
  -- Reset items that have been in 'extracting' longer than the timeout.
  -- 30 minutes is safely longer than a normal Gemini extraction.
  UPDATE youtube_ingestion_queue
  SET status = 'transcript_ready',
      error_message = 'Reset: stuck in extracting',
      started_at = NULL
  WHERE status = 'extracting'
    AND started_at IS NOT NULL
    AND started_at < (NOW() - make_interval(secs => p_stuck_timeout_seconds));

  -- Atomically claim a batch. SKIP LOCKED means concurrent callers
  -- will step over already-claimed rows instead of blocking or double-picking.
  RETURN QUERY
  WITH next_ids AS (
    SELECT id
    FROM youtube_ingestion_queue
    WHERE status = 'transcript_ready'
      AND (p_user_id IS NULL OR user_id = p_user_id)
    ORDER BY priority ASC NULLS LAST, created_at ASC
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  )
  UPDATE youtube_ingestion_queue q
  SET status = 'extracting',
      started_at = NOW()
  FROM next_ids
  WHERE q.id = next_ids.id
  RETURNING q.*;
END;
$$;
