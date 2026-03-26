-- PRD-Simulate-A: simulation_jobs table
CREATE TABLE simulation_jobs (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  status                TEXT NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending','preparing','running','completed','failed')),
  title                 TEXT NOT NULL,
  scope_anchor_ids      UUID[] NOT NULL DEFAULT '{}',
  scope_time_window_days INTEGER NOT NULL DEFAULT 90,
  scope_node_count      INTEGER,
  scope_edge_count      INTEGER,
  scope_source_count    INTEGER,
  prediction_question   TEXT NOT NULL,
  what_if_variables     TEXT[] NOT NULL DEFAULT '{}',
  excluded_node_ids     UUID[] NOT NULL DEFAULT '{}',
  seed_graph            JSONB,
  progress              INTEGER NOT NULL DEFAULT 0,
  progress_message      TEXT,
  result                JSONB,
  ingested_source_id    UUID REFERENCES knowledge_sources(id),
  error_message         TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at          TIMESTAMPTZ
);

-- RLS
ALTER TABLE simulation_jobs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can manage own simulation jobs"
  ON simulation_jobs FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Index for polling
CREATE INDEX idx_simulation_jobs_user_status
  ON simulation_jobs(user_id, status, created_at DESC);
