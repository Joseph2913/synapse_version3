-- Add integration_id to domain_agents so non-playlist agents can be linked to specific integrations
ALTER TABLE domain_agents
  ADD COLUMN IF NOT EXISTS integration_id UUID;

CREATE INDEX IF NOT EXISTS idx_domain_agents_integration ON domain_agents(integration_id) WHERE integration_id IS NOT NULL;

-- Add domain_agent_id to user_integrations (back-reference, like youtube_playlists.domain_agent_id)
ALTER TABLE user_integrations
  ADD COLUMN IF NOT EXISTS domain_agent_id UUID;

-- Support multiple integrations feeding one agent via a junction table
CREATE TABLE IF NOT EXISTS agent_integration_links (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id        UUID NOT NULL REFERENCES domain_agents(id) ON DELETE CASCADE,
  integration_id  UUID NOT NULL REFERENCES user_integrations(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES auth.users(id),
  source_types    TEXT[] DEFAULT '{}',
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (agent_id, integration_id)
);

CREATE INDEX IF NOT EXISTS idx_ail_agent ON agent_integration_links(agent_id);
CREATE INDEX IF NOT EXISTS idx_ail_integration ON agent_integration_links(integration_id);

ALTER TABLE agent_integration_links ENABLE ROW LEVEL SECURITY;

CREATE POLICY "ail_select" ON agent_integration_links FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "ail_insert" ON agent_integration_links FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "ail_update" ON agent_integration_links FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "ail_delete" ON agent_integration_links FOR DELETE USING (auth.uid() = user_id);
