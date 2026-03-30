-- PRD-Skills-D: Daily Skill Cron & Usage Tracking Loop
-- Creates skill_usage_log + skill_usage_stats tables,
-- and adds lifecycle columns to knowledge_skills.

-- ─────────────────────────────────────────
-- skill_usage_log
-- Records every MCP retrieval of a skill,
-- capturing query context for feedback loop
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS skill_usage_log (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  skill_id        UUID NOT NULL REFERENCES knowledge_skills(id) ON DELETE CASCADE,

  -- What triggered the retrieval
  tool_name       TEXT NOT NULL CHECK (tool_name IN (
                    'get_skills',
                    'get_skill_content',
                    'search_skills',
                    'ask_synapse'
                  )),
  query_text      TEXT,
  query_context   JSONB DEFAULT '{}',

  -- How the skill was used after retrieval
  was_cited       BOOLEAN DEFAULT FALSE,
  response_context TEXT,

  -- Session tracking
  session_id      TEXT,
  retrieval_rank  INTEGER,

  -- Temporal
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS skill_usage_log_user_id_idx     ON skill_usage_log(user_id);
CREATE INDEX IF NOT EXISTS skill_usage_log_skill_id_idx    ON skill_usage_log(skill_id);
CREATE INDEX IF NOT EXISTS skill_usage_log_created_at_idx  ON skill_usage_log(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS skill_usage_log_tool_name_idx   ON skill_usage_log(user_id, tool_name);
CREATE INDEX IF NOT EXISTS skill_usage_log_session_idx     ON skill_usage_log(session_id) WHERE session_id IS NOT NULL;

-- RLS
ALTER TABLE skill_usage_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own usage logs"
  ON skill_usage_log FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- ─────────────────────────────────────────
-- skill_usage_stats
-- Aggregated usage stats per skill,
-- refreshed by daily cron
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS skill_usage_stats (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  skill_id          UUID NOT NULL REFERENCES knowledge_skills(id) ON DELETE CASCADE,

  total_retrievals  INTEGER NOT NULL DEFAULT 0,
  retrievals_7d     INTEGER NOT NULL DEFAULT 0,
  retrievals_30d    INTEGER NOT NULL DEFAULT 0,
  unique_sessions   INTEGER NOT NULL DEFAULT 0,
  avg_rank          FLOAT,
  citation_rate     FLOAT DEFAULT 0.0,
  top_queries       JSONB DEFAULT '[]',
  last_used_at      TIMESTAMPTZ,

  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE(user_id, skill_id)
);

CREATE INDEX IF NOT EXISTS skill_usage_stats_user_skill_idx ON skill_usage_stats(user_id, skill_id);

ALTER TABLE skill_usage_stats ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own usage stats"
  ON skill_usage_stats FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- ─────────────────────────────────────────
-- Add lifecycle columns to knowledge_skills
-- (needed by daily cron for scoring, lifecycle, content)
-- ─────────────────────────────────────────
ALTER TABLE knowledge_skills
  ADD COLUMN IF NOT EXISTS evidence_count      INTEGER DEFAULT 1,
  ADD COLUMN IF NOT EXISTS last_reinforced_at  TIMESTAMPTZ DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS exposure_level      TEXT DEFAULT 'novice',
  ADD COLUMN IF NOT EXISTS signal_breakdown    JSONB DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS last_scored_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS when_to_apply       TEXT,
  ADD COLUMN IF NOT EXISTS how_to_apply        TEXT,
  ADD COLUMN IF NOT EXISTS related_skill_ids   UUID[] DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS related_anchor_ids  UUID[] DEFAULT '{}';
