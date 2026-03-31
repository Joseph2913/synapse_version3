-- ─────────────────────────────────────────
-- knowledge_skills
-- One row per distinct skill in the user's library
-- ─────────────────────────────────────────
CREATE TABLE knowledge_skills (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Identity
  label                 TEXT NOT NULL,
  domain                TEXT NOT NULL CHECK (domain IN (
                          'technical','consulting','strategic',
                          'interpersonal','domain_specific'
                        )),
  description           TEXT,

  -- Exposure & confidence
  exposure_level        TEXT NOT NULL DEFAULT 'novice' CHECK (exposure_level IN (
                          'novice','developing','proficient','advanced'
                        )),
  confidence            FLOAT NOT NULL DEFAULT 0.0 CHECK (confidence BETWEEN 0 AND 1),
  evidence_count        INTEGER NOT NULL DEFAULT 1,

  -- Lifecycle state machine
  status                TEXT NOT NULL DEFAULT 'candidate' CHECK (status IN (
                          'candidate',
                          'confirmed',
                          'dormant',
                          'archived'
                        )),

  -- Scoring snapshot
  last_relevance_score  FLOAT,
  signal_breakdown      JSONB DEFAULT '{}',

  -- Graph relationships
  related_anchor_ids    UUID[] DEFAULT '{}',
  related_skill_ids     UUID[] DEFAULT '{}',

  -- MCP retrieval fields
  when_to_apply         TEXT,
  how_to_apply          TEXT,

  -- Temporal
  first_detected_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_reinforced_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_scored_at        TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX knowledge_skills_user_id_idx      ON knowledge_skills(user_id);
CREATE INDEX knowledge_skills_status_idx       ON knowledge_skills(user_id, status);
CREATE INDEX knowledge_skills_domain_idx       ON knowledge_skills(user_id, domain);
CREATE INDEX knowledge_skills_confidence_idx   ON knowledge_skills(user_id, confidence DESC);
CREATE UNIQUE INDEX knowledge_skills_label_idx ON knowledge_skills(user_id, label);

-- RLS
ALTER TABLE knowledge_skills ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own skills"
  ON knowledge_skills FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Auto-update updated_at via plain trigger function
CREATE OR REPLACE FUNCTION update_knowledge_skills_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER knowledge_skills_updated_at
  BEFORE UPDATE ON knowledge_skills
  FOR EACH ROW EXECUTE FUNCTION update_knowledge_skills_updated_at();


-- ─────────────────────────────────────────
-- skill_sources
-- Junction table: which sources contributed to each skill
-- ─────────────────────────────────────────
CREATE TABLE skill_sources (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  skill_id        UUID NOT NULL REFERENCES knowledge_skills(id) ON DELETE CASCADE,
  source_id       UUID NOT NULL REFERENCES knowledge_sources(id) ON DELETE CASCADE,

  contribution    TEXT NOT NULL CHECK (contribution IN (
                    'created',
                    'reinforced',
                    'upgraded',
                    'corrected'
                  )),
  confidence_delta  FLOAT DEFAULT 0.0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE(skill_id, source_id)
);

-- Indexes
CREATE INDEX skill_sources_skill_id_idx  ON skill_sources(skill_id);
CREATE INDEX skill_sources_source_id_idx ON skill_sources(source_id);
CREATE INDEX skill_sources_user_id_idx   ON skill_sources(user_id);

-- RLS
ALTER TABLE skill_sources ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own skill sources"
  ON skill_sources FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
