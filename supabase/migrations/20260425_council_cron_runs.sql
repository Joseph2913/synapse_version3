-- 20260425_council_cron_runs.sql
-- Telemetry: one row per Council cron invocation.

BEGIN;

CREATE TABLE IF NOT EXISTS council_cron_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  status VARCHAR(20) NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'ok', 'partial_failure', 'failed')),
  phase_counts JSONB NOT NULL DEFAULT '{}'::jsonb,
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_ccr_user_started
  ON council_cron_runs (user_id, started_at DESC);

ALTER TABLE council_cron_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY council_cron_runs_select_own
  ON council_cron_runs FOR SELECT
  USING (auth.uid() = user_id);

-- No insert/update policy: writes only happen from the cron with the service-role key,
-- which bypasses RLS. Clients are read-only.

COMMIT;
