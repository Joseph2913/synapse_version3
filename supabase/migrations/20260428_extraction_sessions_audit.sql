-- Stage 12: Extraction session audit.
-- Adds audit columns (model versions, token usage, cost, status, source FK),
-- a retention cleanup RPC, and indexes for health queries.
--
-- All new columns default to a safe value so existing rows remain valid.
-- session_status defaults to 'success' for historical rows (they were written
-- only on success in the prior code).

-- ── 1. New audit columns ───────────────────────────────────────────────────────

ALTER TABLE extraction_sessions
  ADD COLUMN IF NOT EXISTS source_id         uuid        REFERENCES knowledge_sources(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS session_status    text        NOT NULL DEFAULT 'success',
  ADD COLUMN IF NOT EXISTS error_reason      text,
  ADD COLUMN IF NOT EXISTS model             text        NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS embedding_model   text        NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS prompt_tokens     integer,
  ADD COLUMN IF NOT EXISTS output_tokens     integer,
  ADD COLUMN IF NOT EXISTS total_tokens      integer,
  ADD COLUMN IF NOT EXISTS cost_estimate_usd numeric(10,6);

-- ── 2. Check constraint on session_status ─────────────────────────────────────
-- Guard clause prevents invalid values; applied only if not already present.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'extraction_sessions_status_check'
      AND conrelid = 'extraction_sessions'::regclass
  ) THEN
    ALTER TABLE extraction_sessions
      ADD CONSTRAINT extraction_sessions_status_check
      CHECK (session_status IN ('success', 'failed', 'degraded'));
  END IF;
END $$;

-- ── 3. Indexes ─────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS extraction_sessions_source_id_idx
  ON extraction_sessions (source_id)
  WHERE source_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS extraction_sessions_status_created_idx
  ON extraction_sessions (session_status, created_at DESC);

-- ── 4. Column comments ─────────────────────────────────────────────────────────

COMMENT ON COLUMN extraction_sessions.source_id IS
  'FK to knowledge_sources. NULL on rows written before Stage 12 or when the persist step runs after the session write.';
COMMENT ON COLUMN extraction_sessions.session_status IS
  'success | failed | degraded. Stage 12 is Skip-with-telemetry — writing this row never blocks extraction.';
COMMENT ON COLUMN extraction_sessions.error_reason IS
  'Short error message when session_status = ''failed'' or ''degraded''. NULL on success.';
COMMENT ON COLUMN extraction_sessions.model IS
  'Gemini chat model used (e.g. gemini-2.5-flash). ''unknown'' for rows predating Stage 12.';
COMMENT ON COLUMN extraction_sessions.embedding_model IS
  'Gemini embedding model used (e.g. gemini-embedding-001). ''unknown'' for rows predating Stage 12.';
COMMENT ON COLUMN extraction_sessions.prompt_tokens IS
  'Total prompt token count across all Gemini calls in this session. NULL when not captured.';
COMMENT ON COLUMN extraction_sessions.output_tokens IS
  'Total output (candidates) token count across all Gemini calls. NULL when not captured.';
COMMENT ON COLUMN extraction_sessions.total_tokens IS
  'Sum of prompt_tokens + output_tokens. NULL when not captured.';
COMMENT ON COLUMN extraction_sessions.cost_estimate_usd IS
  'Best-effort cost estimate using Gemini 2.5 Flash pricing at 2026-04-28: $0.075/1M input, $0.30/1M output. NULL when token counts are unavailable.';

-- ── 5. Retention RPC ───────────────────────────────────────────────────────────
-- Deletes extraction_sessions rows older than 90 days.
-- Called daily by api/cron/prune-sessions.ts (registered in vercel.json).
-- SECURITY DEFINER so the cron caller does not need the service role key on
-- the table directly; the function runs as its owner (postgres).

CREATE OR REPLACE FUNCTION prune_old_extraction_sessions()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  deleted_count integer;
BEGIN
  DELETE FROM extraction_sessions
  WHERE created_at < now() - interval '90 days';
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$;

COMMENT ON FUNCTION prune_old_extraction_sessions() IS
  'Stage 12 retention policy: deletes extraction_sessions rows older than 90 days. Called daily at 04:00 UTC by api/cron/prune-sessions.ts.';
