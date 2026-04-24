-- 20260425_pull_rpcs.sql
-- Phase 0 RPCs: question-answer matching across ALL new sources + bulk verdict writeback.
--
-- Design note: get_council_pull_candidates intentionally does NOT filter new_sources by
-- domain_agent_sources.agent_id = p_agent_id. Agent A's pull must be able to discover
-- matches in sources primarily assigned to agent B — that's the "novel connection" signal
-- that replaces the retired agent_signals pipeline. Phase 0 decides whether to write a
-- cross_domain association based on source_primary_agent_ids in the response.

BEGIN;

CREATE OR REPLACE FUNCTION get_council_pull_candidates(
  p_user_id UUID,
  p_agent_id UUID,
  p_since TIMESTAMPTZ,
  p_similarity_threshold FLOAT DEFAULT 0.55,
  p_top_k INT DEFAULT 3
)
RETURNS TABLE (
  question_id UUID,
  question_text TEXT,
  question_type VARCHAR(50),
  question_status VARCHAR(50),
  existing_addressing_source_ids UUID[],
  source_id UUID,
  chunk_id UUID,
  chunk_content TEXT,
  similarity FLOAT,
  source_primary_agent_ids UUID[]
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
AS $$
#variable_conflict use_column
BEGIN
  RETURN QUERY
  WITH new_sources AS (
    SELECT DISTINCT das.source_id
    FROM domain_agent_sources das
    WHERE das.user_id = p_user_id
      AND das.created_at >= p_since
  ),
  source_agents AS (
    SELECT das.source_id,
           array_agg(das.agent_id) FILTER (WHERE das.association_type = 'primary') AS agent_ids
    FROM domain_agent_sources das
    WHERE das.user_id = p_user_id
      AND das.source_id IN (SELECT source_id FROM new_sources)
    GROUP BY das.source_id
  ),
  open_questions AS (
    SELECT asq.id, asq.question, asq.question_type, asq.status,
           asq.addressing_source_ids, asq.embedding
    FROM agent_standing_questions asq
    WHERE asq.agent_id = p_agent_id
      AND asq.user_id = p_user_id
      AND asq.status IN ('open', 'partially_addressed')
      AND asq.embedding IS NOT NULL
  )
  SELECT
    oq.id AS question_id,
    oq.question AS question_text,
    oq.question_type,
    oq.status AS question_status,
    oq.addressing_source_ids AS existing_addressing_source_ids,
    c.source_id,
    c.id AS chunk_id,
    c.content AS chunk_content,
    1 - (c.embedding <=> oq.embedding) AS similarity,
    COALESCE(sa.agent_ids, ARRAY[]::UUID[]) AS source_primary_agent_ids
  FROM open_questions oq
  CROSS JOIN LATERAL (
    SELECT sc.id, sc.source_id, sc.content, sc.embedding
    FROM source_chunks sc
    WHERE sc.source_id IN (SELECT source_id FROM new_sources)
      AND sc.user_id = p_user_id
      AND sc.embedding IS NOT NULL
      AND 1 - (sc.embedding <=> oq.embedding) > p_similarity_threshold
    ORDER BY sc.embedding <=> oq.embedding
    LIMIT p_top_k
  ) c
  LEFT JOIN source_agents sa ON sa.source_id = c.source_id
  ORDER BY oq.id, (1 - (c.embedding <=> oq.embedding)) DESC;
END;
$$;


CREATE OR REPLACE FUNCTION bulk_apply_question_addressing(
  p_user_id UUID,
  p_updates JSONB
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  -- p_updates is a JSONB array of:
  -- {
  --   "question_id": "uuid",
  --   "new_source_ids": ["uuid", ...],         -- appended to addressing_source_ids, dedup'd
  --   "evidence_entries": [                    -- appended to addressing_evidence jsonb array
  --     {"source_id": "uuid", "verdict": "...", "snippet": "...", "confidence": 0.82,
  --      "checked_at": "2026-04-25T02:00:00Z"}
  --   ],
  --   "new_status": "answered|partially_addressed|null"
  -- }
  -- Status monotonic: never downgrades (answered stays answered).

  WITH updates AS (
    SELECT
      (elem->>'question_id')::UUID AS question_id,
      COALESCE(
        ARRAY(SELECT jsonb_array_elements_text(elem->'new_source_ids'))::UUID[],
        ARRAY[]::UUID[]
      ) AS new_source_ids,
      COALESCE(elem->'evidence_entries', '[]'::jsonb) AS evidence_entries,
      NULLIF(elem->>'new_status', '') AS new_status
    FROM jsonb_array_elements(p_updates) AS elem
  )
  UPDATE agent_standing_questions asq
  SET
    addressing_source_ids = ARRAY(
      SELECT DISTINCT unnest(
        COALESCE(asq.addressing_source_ids, ARRAY[]::UUID[]) || u.new_source_ids
      )
    ),
    addressing_evidence = COALESCE(asq.addressing_evidence, '[]'::jsonb) || u.evidence_entries,
    status = CASE
      WHEN u.new_status IS NULL THEN asq.status
      WHEN asq.status = 'answered' THEN asq.status
      WHEN asq.status = 'partially_addressed' AND u.new_status = 'partially_addressed' THEN asq.status
      ELSE u.new_status
    END,
    status_changed_at = CASE
      WHEN u.new_status IS NULL THEN asq.status_changed_at
      WHEN asq.status = 'answered' THEN asq.status_changed_at
      WHEN asq.status = u.new_status THEN asq.status_changed_at
      ELSE NOW()
    END
  FROM updates u
  WHERE asq.id = u.question_id
    AND asq.user_id = p_user_id;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

COMMIT;
