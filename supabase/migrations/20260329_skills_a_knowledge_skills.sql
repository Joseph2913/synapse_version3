-- PRD-Skills-A: Knowledge Skills Table
-- Foundation table for auto-generated Claude skills derived from Synapse knowledge sources.

-- ─── Table ───────────────────────────────────────────────────────────────────

DROP TABLE IF EXISTS knowledge_skills CASCADE;

CREATE TABLE knowledge_skills (
  -- Identity
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Skill metadata
  name            TEXT NOT NULL,
  title           TEXT NOT NULL,
  description     TEXT NOT NULL,
  domain          TEXT,
  tags            TEXT[] DEFAULT '{}',

  -- Skill content
  content         TEXT NOT NULL,

  -- Source lineage
  source_ids      UUID[] DEFAULT '{}',
  source_count    INTEGER DEFAULT 1,

  -- Quality signals
  confidence          FLOAT DEFAULT 0.5,
  instructional_ratio FLOAT,
  generalizability    FLOAT,
  structural_density  FLOAT,

  -- Lifecycle
  status          TEXT NOT NULL DEFAULT 'draft',

  -- Semantic search
  embedding       VECTOR(3072),

  -- Timestamps
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Constraints
  CONSTRAINT unique_skill_per_user UNIQUE(user_id, name)
);

-- ─── Row Level Security ──────────────────────────────────────────────────────

ALTER TABLE knowledge_skills ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own skills"
  ON knowledge_skills FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can create their own skills"
  ON knowledge_skills FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own skills"
  ON knowledge_skills FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own skills"
  ON knowledge_skills FOR DELETE
  USING (auth.uid() = user_id);

-- ─── Indexes ─────────────────────────────────────────────────────────────────

CREATE INDEX idx_skills_user_status ON knowledge_skills(user_id, status);

CREATE INDEX idx_skills_domain ON knowledge_skills(user_id, domain);

-- Note: No vector index on embedding — pgvector HNSW/IVFFlat cap at 2000 dims,
-- our embeddings are 3072. Exact scan via match_skills RPC is fast enough for
-- the expected table size (tens/hundreds of skills per user). A halfvec index
-- can be added later if scale demands it.

CREATE INDEX idx_skills_source_ids ON knowledge_skills
  USING gin (source_ids);

-- ─── Semantic Search RPC ─────────────────────────────────────────────────────

-- Used by frontend (RLS context — auth.uid() available)
CREATE OR REPLACE FUNCTION match_skills(
  query_embedding VECTOR(3072),
  match_count INT DEFAULT 5,
  match_threshold FLOAT DEFAULT 0.3
)
RETURNS TABLE (
  id UUID,
  name TEXT,
  title TEXT,
  description TEXT,
  domain TEXT,
  tags TEXT[],
  confidence FLOAT,
  source_count INT,
  status TEXT,
  similarity FLOAT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RETURN QUERY
  SELECT
    ks.id,
    ks.name,
    ks.title,
    ks.description,
    ks.domain,
    ks.tags,
    ks.confidence,
    ks.source_count,
    ks.status,
    1 - (ks.embedding <=> query_embedding) AS similarity
  FROM public.knowledge_skills ks
  WHERE ks.user_id = auth.uid()
    AND ks.status = 'active'
    AND 1 - (ks.embedding <=> query_embedding) > match_threshold
  ORDER BY ks.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- Used by MCP (service-role client — no auth.uid(), explicit p_user_id)
CREATE OR REPLACE FUNCTION match_skills_for_user(
  query_embedding VECTOR(3072),
  match_count INT DEFAULT 5,
  match_threshold FLOAT DEFAULT 0.3,
  p_user_id UUID DEFAULT NULL
)
RETURNS TABLE (
  id UUID,
  name TEXT,
  title TEXT,
  description TEXT,
  domain TEXT,
  tags TEXT[],
  confidence FLOAT,
  source_count INT,
  status TEXT,
  similarity FLOAT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RETURN QUERY
  SELECT
    ks.id,
    ks.name,
    ks.title,
    ks.description,
    ks.domain,
    ks.tags,
    ks.confidence,
    ks.source_count,
    ks.status,
    1 - (ks.embedding <=> query_embedding) AS similarity
  FROM public.knowledge_skills ks
  WHERE ks.user_id = p_user_id
    AND ks.status = 'active'
    AND ks.embedding IS NOT NULL
    AND 1 - (ks.embedding <=> query_embedding) > match_threshold
  ORDER BY ks.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;
