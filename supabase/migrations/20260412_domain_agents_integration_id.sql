-- Add integration_id to domain_agents so meeting agents can be linked to specific integrations
ALTER TABLE domain_agents
  ADD COLUMN integration_id UUID REFERENCES user_integrations(id) ON DELETE SET NULL;

CREATE INDEX idx_domain_agents_integration ON domain_agents(integration_id) WHERE integration_id IS NOT NULL;

-- Add integration_id to user_integrations back-reference (like youtube_playlists.domain_agent_id)
ALTER TABLE user_integrations
  ADD COLUMN domain_agent_id UUID REFERENCES domain_agents(id) ON DELETE SET NULL;
