-- PRD-Skills-E: Add usage tracking columns to knowledge_skills
-- Tracks how many times each skill is retrieved via MCP get_skill_content

ALTER TABLE knowledge_skills
  ADD COLUMN IF NOT EXISTS usage_count integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_used_at timestamptz DEFAULT NULL;

-- Index for sorting by usage
CREATE INDEX IF NOT EXISTS idx_skills_usage ON knowledge_skills(user_id, usage_count DESC);
