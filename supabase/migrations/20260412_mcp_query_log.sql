-- ============================================================
-- MCP Query Log — tracks all search queries for demand signal detection
-- ============================================================

CREATE TABLE mcp_query_log (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES auth.users(id),
  tool_name      TEXT NOT NULL,
  query_text     TEXT NOT NULL,
  result_count   INTEGER NOT NULL DEFAULT 0,
  top_relevance  FLOAT,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_mcp_query_log_user ON mcp_query_log(user_id);
CREATE INDEX idx_mcp_query_log_created ON mcp_query_log(created_at DESC);
CREATE INDEX idx_mcp_query_log_empty ON mcp_query_log(user_id, created_at DESC) WHERE result_count = 0;

ALTER TABLE mcp_query_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "mcp_query_log_select" ON mcp_query_log FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "mcp_query_log_insert" ON mcp_query_log FOR INSERT WITH CHECK (true);

-- ============================================================
-- Add 'demand' to agent_gaps gap_type check constraint
-- ============================================================

ALTER TABLE agent_gaps DROP CONSTRAINT IF EXISTS agent_gaps_gap_type_check;
ALTER TABLE agent_gaps ADD CONSTRAINT agent_gaps_gap_type_check
  CHECK (gap_type IN ('structural', 'orphan', 'recency', 'demand'));

-- Add demand-specific fields to agent_gaps
ALTER TABLE agent_gaps
  ADD COLUMN IF NOT EXISTS demand_count INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_demanded_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS query_log_ids UUID[] DEFAULT '{}';
