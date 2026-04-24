-- Migration: Council Overview redesign RPCs
-- Two functions powering /council landing page:
--   1. get_council_overview_summary — thin top-strip counters
--   2. get_council_overview_agents  — per-agent row with this-week + lifetime stats
--
-- Called from: src/services/supabase.ts -> fetchCouncilOverviewSummary / fetchCouncilOverviewAgents

-- ============================================================================
-- 1. get_council_overview_summary
-- ============================================================================
CREATE OR REPLACE FUNCTION get_council_overview_summary(
  p_user_id UUID,
  p_days INT DEFAULT 7
)
RETURNS json
LANGUAGE sql
SECURITY INVOKER
STABLE
AS $$
  SELECT json_build_object(
    'insights_this_week', (
      SELECT COUNT(*)::INT FROM agent_insights
      WHERE user_id = p_user_id
        AND created_at >= NOW() - (p_days * INTERVAL '1 day')
        AND status = 'active'
        AND insight_type <> 'novel_connection'
    ),
    'answered_this_week', (
      SELECT COUNT(*)::INT FROM agent_standing_questions
      WHERE user_id = p_user_id
        AND status IN ('answered', 'partially_addressed')
        AND status_changed_at >= NOW() - (p_days * INTERVAL '1 day')
    ),
    'novel_this_week', (
      SELECT COUNT(*)::INT FROM agent_insights
      WHERE user_id = p_user_id
        AND insight_type = 'novel_connection'
        AND created_at >= NOW() - (p_days * INTERVAL '1 day')
        AND status = 'active'
    ),
    'new_skills_this_week', (
      SELECT COUNT(*)::INT FROM domain_agent_skills
      WHERE user_id = p_user_id
        AND assigned_at >= NOW() - (p_days * INTERVAL '1 day')
    )
  );
$$;

GRANT EXECUTE ON FUNCTION get_council_overview_summary(UUID, INT) TO authenticated;

-- ============================================================================
-- 2. get_council_overview_agents
-- ============================================================================
DROP FUNCTION IF EXISTS get_council_overview_agents(UUID, INT);

CREATE OR REPLACE FUNCTION get_council_overview_agents(
  p_user_id UUID,
  p_days INT DEFAULT 7
)
RETURNS TABLE (
  id UUID,
  name TEXT,
  description TEXT,
  health_status TEXT,
  source_count INT,
  entity_count INT,
  insights_this_week INT,
  answered_this_week INT,
  novel_this_week INT,
  new_skills_this_week INT,
  total_insights INT,
  total_novel INT,
  total_skills INT,
  last_activity_at TIMESTAMPTZ,
  significant_gap_count INT,
  novel_peers JSONB,
  top_skills JSONB
)
LANGUAGE sql
SECURITY INVOKER
STABLE
AS $$
  WITH
    window_start AS (
      SELECT (NOW() - (p_days * INTERVAL '1 day'))::TIMESTAMPTZ AS ts
    ),
    base AS (
      SELECT a.id, a.name, a.description, a.health_status, a.source_count, a.entity_count
      FROM domain_agents a
      WHERE a.user_id = p_user_id
        AND a.is_active = true
    ),
    ins_week AS (
      SELECT agent_id, COUNT(*)::INT AS cnt
      FROM agent_insights
      WHERE user_id = p_user_id
        AND created_at >= (SELECT ts FROM window_start)
        AND status = 'active'
        AND insight_type <> 'novel_connection'
      GROUP BY agent_id
    ),
    novel_week AS (
      SELECT agent_id, COUNT(*)::INT AS cnt
      FROM agent_insights
      WHERE user_id = p_user_id
        AND created_at >= (SELECT ts FROM window_start)
        AND status = 'active'
        AND insight_type = 'novel_connection'
      GROUP BY agent_id
    ),
    answered_week AS (
      SELECT agent_id, COUNT(*)::INT AS cnt
      FROM agent_standing_questions
      WHERE user_id = p_user_id
        AND status IN ('answered', 'partially_addressed')
        AND status_changed_at >= (SELECT ts FROM window_start)
      GROUP BY agent_id
    ),
    skills_week AS (
      SELECT agent_id, COUNT(*)::INT AS cnt
      FROM domain_agent_skills
      WHERE user_id = p_user_id
        AND assigned_at >= (SELECT ts FROM window_start)
      GROUP BY agent_id
    ),
    ins_total AS (
      SELECT agent_id, COUNT(*)::INT AS cnt
      FROM agent_insights
      WHERE user_id = p_user_id AND status = 'active'
      GROUP BY agent_id
    ),
    novel_total AS (
      SELECT agent_id, COUNT(*)::INT AS cnt
      FROM agent_insights
      WHERE user_id = p_user_id
        AND status = 'active'
        AND insight_type = 'novel_connection'
      GROUP BY agent_id
    ),
    skills_total AS (
      SELECT agent_id, COUNT(*)::INT AS cnt
      FROM domain_agent_skills
      WHERE user_id = p_user_id
      GROUP BY agent_id
    ),
    last_ins AS (
      SELECT agent_id, MAX(created_at) AS ts
      FROM agent_insights
      WHERE user_id = p_user_id AND status = 'active'
      GROUP BY agent_id
    ),
    last_ans AS (
      SELECT agent_id, MAX(status_changed_at) AS ts
      FROM agent_standing_questions
      WHERE user_id = p_user_id
        AND status IN ('answered', 'partially_addressed')
      GROUP BY agent_id
    ),
    gap_sig AS (
      SELECT agent_id, COUNT(*)::INT AS cnt
      FROM agent_gaps
      WHERE user_id = p_user_id
        AND status = 'active'
        AND severity = 'significant'
      GROUP BY agent_id
    ),
    -- novel_peers derivation:
    -- For each novel_connection insight owned by an agent, unnest related_source_ids,
    -- join to domain_agent_sources (association_type='primary') for OTHER agents,
    -- group by (owner_agent, peer_agent), count connections, rank desc, top 5.
    novel_peer_rows AS (
      SELECT
        i.agent_id AS owner_agent_id,
        das.agent_id AS peer_agent_id,
        COUNT(*)::INT AS connection_count
      FROM agent_insights i
      CROSS JOIN LATERAL unnest(i.related_source_ids) AS src_id
      JOIN domain_agent_sources das
        ON das.source_id = src_id
       AND das.user_id = p_user_id
       AND das.association_type = 'primary'
       AND das.agent_id <> i.agent_id
      WHERE i.user_id = p_user_id
        AND i.status = 'active'
        AND i.insight_type = 'novel_connection'
      GROUP BY i.agent_id, das.agent_id
    ),
    novel_peer_ranked AS (
      SELECT
        npr.owner_agent_id,
        npr.peer_agent_id,
        a.name AS peer_name,
        npr.connection_count,
        row_number() OVER (
          PARTITION BY npr.owner_agent_id
          ORDER BY npr.connection_count DESC, a.name ASC
        ) AS rn
      FROM novel_peer_rows npr
      JOIN domain_agents a ON a.id = npr.peer_agent_id
    ),
    novel_peers_agg AS (
      SELECT
        owner_agent_id,
        jsonb_agg(
          jsonb_build_object(
            'peer_agent_id', peer_agent_id,
            'peer_name', peer_name,
            'connection_count', connection_count
          )
          ORDER BY connection_count DESC, peer_name ASC
        ) AS peers
      FROM novel_peer_ranked
      WHERE rn <= 5
      GROUP BY owner_agent_id
    ),
    skill_ranked AS (
      SELECT
        das.agent_id,
        COALESCE(NULLIF(ks.title, ''), ks.name) AS skill_title,
        das.relevance,
        row_number() OVER (
          PARTITION BY das.agent_id
          ORDER BY das.relevance DESC NULLS LAST, ks.title ASC
        ) AS rn
      FROM domain_agent_skills das
      JOIN knowledge_skills ks ON ks.id = das.skill_id
      WHERE das.user_id = p_user_id
    ),
    top_skills_agg AS (
      SELECT
        agent_id,
        jsonb_agg(
          jsonb_build_object(
            'skill_title', skill_title,
            'relevance', relevance
          )
          ORDER BY relevance DESC NULLS LAST, skill_title ASC
        ) AS skills
      FROM skill_ranked
      WHERE rn <= 3
      GROUP BY agent_id
    )
  SELECT
    b.id,
    b.name::TEXT,
    b.description::TEXT,
    b.health_status::TEXT,
    b.source_count,
    b.entity_count,
    COALESCE(iw.cnt, 0) AS insights_this_week,
    COALESCE(aw.cnt, 0) AS answered_this_week,
    COALESCE(nw.cnt, 0) AS novel_this_week,
    COALESCE(sw.cnt, 0) AS new_skills_this_week,
    COALESCE(it.cnt, 0) AS total_insights,
    COALESCE(nt.cnt, 0) AS total_novel,
    COALESCE(st.cnt, 0) AS total_skills,
    GREATEST(li.ts, la.ts) AS last_activity_at,
    COALESCE(gs.cnt, 0) AS significant_gap_count,
    COALESCE(npa.peers, '[]'::jsonb) AS novel_peers,
    COALESCE(tsk.skills, '[]'::jsonb) AS top_skills
  FROM base b
  LEFT JOIN ins_week iw        ON iw.agent_id = b.id
  LEFT JOIN answered_week aw   ON aw.agent_id = b.id
  LEFT JOIN novel_week nw      ON nw.agent_id = b.id
  LEFT JOIN skills_week sw     ON sw.agent_id = b.id
  LEFT JOIN ins_total it       ON it.agent_id = b.id
  LEFT JOIN novel_total nt     ON nt.agent_id = b.id
  LEFT JOIN skills_total st    ON st.agent_id = b.id
  LEFT JOIN last_ins li        ON li.agent_id = b.id
  LEFT JOIN last_ans la        ON la.agent_id = b.id
  LEFT JOIN gap_sig gs         ON gs.agent_id = b.id
  LEFT JOIN novel_peers_agg npa ON npa.owner_agent_id = b.id
  LEFT JOIN top_skills_agg tsk  ON tsk.agent_id = b.id
  ORDER BY b.name ASC;
$$;

GRANT EXECUTE ON FUNCTION get_council_overview_agents(UUID, INT) TO authenticated;
