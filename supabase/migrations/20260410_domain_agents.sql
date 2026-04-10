-- ============================================================
-- Domain Agents (Advisory Council) — Full Schema Migration
-- 6 new tables, 1 column addition, 1 RPC function
-- ============================================================

-- ============================================================
-- 1. domain_agents
-- ============================================================
CREATE TABLE domain_agents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id),
  playlist_id UUID REFERENCES youtube_playlists(id) ON DELETE SET NULL,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  reasoning_style TEXT,
  expertise_index JSONB DEFAULT '{}',
  awareness_register JSONB DEFAULT '{}',
  health_status VARCHAR(50) DEFAULT 'initialising'
    CHECK (health_status IN ('initialising', 'thin', 'growing', 'strong', 'stale')),
  linked_anchor_ids UUID[] DEFAULT '{}',
  source_count INTEGER DEFAULT 0,
  entity_count INTEGER DEFAULT 0,
  last_ingestion_at TIMESTAMPTZ,
  last_index_rebuild_at TIMESTAMPTZ,
  index_stale BOOLEAN DEFAULT true,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (user_id, playlist_id)
);

CREATE INDEX idx_domain_agents_user_id ON domain_agents(user_id);
CREATE INDEX idx_domain_agents_playlist_id ON domain_agents(playlist_id);

ALTER TABLE domain_agents ENABLE ROW LEVEL SECURITY;

CREATE POLICY "domain_agents_select" ON domain_agents
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "domain_agents_insert" ON domain_agents
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "domain_agents_update" ON domain_agents
  FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "domain_agents_delete" ON domain_agents
  FOR DELETE USING (auth.uid() = user_id);

-- ============================================================
-- 2. domain_agent_sources
-- ============================================================
CREATE TABLE domain_agent_sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id),
  agent_id UUID NOT NULL REFERENCES domain_agents(id) ON DELETE CASCADE,
  source_id UUID NOT NULL REFERENCES knowledge_sources(id) ON DELETE CASCADE,
  association_type VARCHAR(50) DEFAULT 'primary'
    CHECK (association_type IN ('primary', 'associated', 'cross_domain')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (agent_id, source_id)
);

CREATE INDEX idx_das_agent_id ON domain_agent_sources(agent_id);
CREATE INDEX idx_das_source_id ON domain_agent_sources(source_id);

ALTER TABLE domain_agent_sources ENABLE ROW LEVEL SECURITY;

CREATE POLICY "domain_agent_sources_select" ON domain_agent_sources
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "domain_agent_sources_insert" ON domain_agent_sources
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "domain_agent_sources_update" ON domain_agent_sources
  FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "domain_agent_sources_delete" ON domain_agent_sources
  FOR DELETE USING (auth.uid() = user_id);

-- ============================================================
-- 3. agent_standing_questions
-- ============================================================
CREATE TABLE agent_standing_questions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id),
  agent_id UUID NOT NULL REFERENCES domain_agents(id) ON DELETE CASCADE,
  question TEXT NOT NULL,
  question_type VARCHAR(50) NOT NULL
    CHECK (question_type IN ('gap_driven', 'frontier', 'cross_domain', 'user_defined')),
  status VARCHAR(50) DEFAULT 'open'
    CHECK (status IN ('open', 'partially_addressed', 'answered', 'dismissed')),
  priority INTEGER DEFAULT 5,
  trigger_description TEXT,
  trigger_source_id UUID REFERENCES knowledge_sources(id) ON DELETE SET NULL,
  addressing_source_ids UUID[] DEFAULT '{}',
  addressing_evidence TEXT,
  generated_at TIMESTAMPTZ DEFAULT NOW(),
  status_changed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_asq_agent_id ON agent_standing_questions(agent_id);
CREATE INDEX idx_asq_agent_status ON agent_standing_questions(agent_id, status);

ALTER TABLE agent_standing_questions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "agent_standing_questions_select" ON agent_standing_questions
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "agent_standing_questions_insert" ON agent_standing_questions
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "agent_standing_questions_update" ON agent_standing_questions
  FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "agent_standing_questions_delete" ON agent_standing_questions
  FOR DELETE USING (auth.uid() = user_id);

-- ============================================================
-- 4. agent_insights
-- ============================================================
CREATE TABLE agent_insights (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id),
  agent_id UUID NOT NULL REFERENCES domain_agents(id) ON DELETE CASCADE,
  insight_type VARCHAR(50) NOT NULL
    CHECK (insight_type IN ('tension', 'convergence', 'novel_connection')),
  claim TEXT NOT NULL,
  evidence_summary TEXT,
  trigger_source_id UUID REFERENCES knowledge_sources(id) ON DELETE SET NULL,
  related_source_ids UUID[] DEFAULT '{}',
  related_entity_ids UUID[] DEFAULT '{}',
  related_edge_ids UUID[] DEFAULT '{}',
  confidence FLOAT,
  status VARCHAR(50) DEFAULT 'active'
    CHECK (status IN ('active', 'promoted', 'dismissed', 'superseded')),
  promoted_to VARCHAR(50)
    CHECK (promoted_to IS NULL OR promoted_to IN ('note', 'standing_question', 'anchor_candidate')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_ai_agent_id ON agent_insights(agent_id);
CREATE INDEX idx_ai_agent_status ON agent_insights(agent_id, status);
CREATE INDEX idx_ai_agent_type ON agent_insights(agent_id, insight_type);

ALTER TABLE agent_insights ENABLE ROW LEVEL SECURITY;

CREATE POLICY "agent_insights_select" ON agent_insights
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "agent_insights_insert" ON agent_insights
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "agent_insights_update" ON agent_insights
  FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "agent_insights_delete" ON agent_insights
  FOR DELETE USING (auth.uid() = user_id);

-- ============================================================
-- 5. agent_signals
-- ============================================================
CREATE TABLE agent_signals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id),
  source_agent_id UUID NOT NULL REFERENCES domain_agents(id) ON DELETE CASCADE,
  target_agent_id UUID NOT NULL REFERENCES domain_agents(id) ON DELETE CASCADE,
  trigger_source_id UUID REFERENCES knowledge_sources(id) ON DELETE SET NULL,
  bridge_entity_ids UUID[] DEFAULT '{}',
  bridge_edge_id UUID REFERENCES knowledge_edges(id) ON DELETE SET NULL,
  reason TEXT NOT NULL,
  status VARCHAR(50) DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'acknowledged', 'extracted', 'dismissed')),
  processing_result VARCHAR(50)
    CHECK (processing_result IS NULL OR processing_result IN ('acknowledge_only', 'targeted_extraction', 'full_ingestion')),
  extracted_entity_ids UUID[] DEFAULT '{}',
  processed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_as_target_status ON agent_signals(target_agent_id, status);
CREATE INDEX idx_as_source_agent ON agent_signals(source_agent_id);
CREATE INDEX idx_as_bridge_edge ON agent_signals(bridge_edge_id);

ALTER TABLE agent_signals ENABLE ROW LEVEL SECURITY;

CREATE POLICY "agent_signals_select" ON agent_signals
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "agent_signals_insert" ON agent_signals
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "agent_signals_update" ON agent_signals
  FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "agent_signals_delete" ON agent_signals
  FOR DELETE USING (auth.uid() = user_id);

-- ============================================================
-- 6. agent_gaps
-- ============================================================
CREATE TABLE agent_gaps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id),
  agent_id UUID NOT NULL REFERENCES domain_agents(id) ON DELETE CASCADE,
  gap_type VARCHAR(50) NOT NULL
    CHECK (gap_type IN ('structural', 'orphan', 'recency')),
  topic TEXT NOT NULL,
  description TEXT,
  severity VARCHAR(50) DEFAULT 'moderate'
    CHECK (severity IN ('minor', 'moderate', 'significant')),
  content_suggestion TEXT,
  related_entity_ids UUID[] DEFAULT '{}',
  status VARCHAR(50) DEFAULT 'active'
    CHECK (status IN ('active', 'filling', 'resolved', 'dismissed')),
  resolved_by_source_id UUID REFERENCES knowledge_sources(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_ag_agent_status ON agent_gaps(agent_id, status);

ALTER TABLE agent_gaps ENABLE ROW LEVEL SECURITY;

CREATE POLICY "agent_gaps_select" ON agent_gaps
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "agent_gaps_insert" ON agent_gaps
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "agent_gaps_update" ON agent_gaps
  FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "agent_gaps_delete" ON agent_gaps
  FOR DELETE USING (auth.uid() = user_id);

-- ============================================================
-- 7. Add domain_agent_id to youtube_playlists
-- ============================================================
ALTER TABLE youtube_playlists
  ADD COLUMN domain_agent_id UUID REFERENCES domain_agents(id) ON DELETE SET NULL;

-- ============================================================
-- 8. RPC: get_domain_scoped_chunks
-- ============================================================
CREATE OR REPLACE FUNCTION get_domain_scoped_chunks(
  p_agent_id UUID,
  p_query_embedding VECTOR(768),
  p_match_threshold FLOAT DEFAULT 0.7,
  p_match_count INT DEFAULT 10
)
RETURNS TABLE (
  chunk_id UUID,
  source_id UUID,
  content TEXT,
  similarity FLOAT
)
LANGUAGE sql STABLE
AS $$
  SELECT
    sc.id AS chunk_id,
    sc.source_id,
    sc.content,
    1 - (sc.embedding <=> p_query_embedding) AS similarity
  FROM source_chunks sc
  INNER JOIN domain_agent_sources das
    ON das.source_id = sc.source_id
    AND das.agent_id = p_agent_id
  WHERE sc.user_id = auth.uid()
    AND 1 - (sc.embedding <=> p_query_embedding) > p_match_threshold
  ORDER BY sc.embedding <=> p_query_embedding
  LIMIT p_match_count;
$$;
