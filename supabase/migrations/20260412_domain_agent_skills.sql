-- ============================================================
-- Domain Agent Skills — Junction table linking skills to agents
-- Enables retroactive and ongoing skill-to-agent assignment
-- ============================================================

CREATE TABLE domain_agent_skills (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id    UUID NOT NULL REFERENCES domain_agents(id) ON DELETE CASCADE,
  skill_id    UUID NOT NULL REFERENCES knowledge_skills(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES auth.users(id),
  match_method VARCHAR(50) NOT NULL
    CHECK (match_method IN ('source_overlap', 'gemini_match', 'manual')),
  relevance   FLOAT DEFAULT 1.0,
  ingested    BOOLEAN DEFAULT false,
  assigned_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (agent_id, skill_id)
);

CREATE INDEX idx_das_skills_agent ON domain_agent_skills(agent_id);
CREATE INDEX idx_das_skills_skill ON domain_agent_skills(skill_id);
CREATE INDEX idx_das_skills_user  ON domain_agent_skills(user_id);
CREATE INDEX idx_das_skills_not_ingested ON domain_agent_skills(agent_id) WHERE ingested = false;

ALTER TABLE domain_agent_skills ENABLE ROW LEVEL SECURITY;

CREATE POLICY "domain_agent_skills_select" ON domain_agent_skills
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "domain_agent_skills_insert" ON domain_agent_skills
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "domain_agent_skills_update" ON domain_agent_skills
  FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "domain_agent_skills_delete" ON domain_agent_skills
  FOR DELETE USING (auth.uid() = user_id);
