-- Agent proposals: suggested domain experts based on unassigned skill clusters
CREATE TABLE agent_proposals (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES auth.users(id),
  proposed_name TEXT NOT NULL,
  proposed_description TEXT,
  domain_cluster TEXT NOT NULL,
  skill_ids   UUID[] NOT NULL DEFAULT '{}',
  source_ids  UUID[] NOT NULL DEFAULT '{}',
  skill_count INTEGER DEFAULT 0,
  status      VARCHAR(50) DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'dismissed')),
  approved_agent_id UUID REFERENCES domain_agents(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);

CREATE INDEX idx_agent_proposals_user ON agent_proposals(user_id);
CREATE INDEX idx_agent_proposals_status ON agent_proposals(user_id, status);

ALTER TABLE agent_proposals ENABLE ROW LEVEL SECURITY;

CREATE POLICY "agent_proposals_select" ON agent_proposals FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "agent_proposals_insert" ON agent_proposals FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "agent_proposals_update" ON agent_proposals FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "agent_proposals_delete" ON agent_proposals FOR DELETE USING (auth.uid() = user_id);
