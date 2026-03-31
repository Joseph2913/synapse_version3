CREATE TABLE skill_scan_state (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  last_full_scan_at     TIMESTAMPTZ,
  last_incremental_at   TIMESTAMPTZ,
  sources_evaluated     INTEGER DEFAULT 0,
  candidates_confirmed  INTEGER DEFAULT 0,
  scan_version          TEXT DEFAULT '1.0',
  metadata              JSONB DEFAULT '{}',
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW()
);

-- One row per user
CREATE UNIQUE INDEX skill_scan_state_user_idx ON skill_scan_state(user_id);

-- RLS
ALTER TABLE skill_scan_state ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own scan state"
  ON skill_scan_state FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
