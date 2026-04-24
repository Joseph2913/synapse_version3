-- 20260425_extend_council_digest.sql
-- Extend get_council_digest to include recently_answered_questions — questions whose
-- status transitioned to 'answered' or 'partially_addressed' within the digest window,
-- surfacing Phase 0 activity on the Home digest card.

CREATE OR REPLACE FUNCTION public.get_council_digest(p_user_id uuid, p_days integer DEFAULT 7)
RETURNS json
LANGUAGE plpgsql
AS $function$
DECLARE
  v_window_start TIMESTAMPTZ := NOW() - (p_days * INTERVAL '1 day');
  v_insights_count INT;
  v_questions_count INT;
  v_gaps_count INT;
  v_active_agents_count INT;
  v_top_tensions json;
  v_top_frontier_questions json;
  v_top_gaps json;
  v_active_agents json;
  v_recently_answered json;
BEGIN
  SELECT COUNT(*) INTO v_insights_count
  FROM agent_insights
  WHERE user_id = p_user_id
    AND created_at >= v_window_start
    AND status = 'active';

  SELECT COUNT(*) INTO v_questions_count
  FROM agent_standing_questions
  WHERE user_id = p_user_id
    AND created_at >= v_window_start
    AND status = 'open';

  SELECT COUNT(*) INTO v_gaps_count
  FROM agent_gaps
  WHERE user_id = p_user_id
    AND created_at >= v_window_start
    AND status = 'active';

  SELECT COUNT(DISTINCT agent_id) INTO v_active_agents_count
  FROM (
    SELECT agent_id FROM agent_insights
      WHERE user_id = p_user_id AND created_at >= v_window_start AND status = 'active'
    UNION ALL
    SELECT agent_id FROM agent_standing_questions
      WHERE user_id = p_user_id AND created_at >= v_window_start AND status = 'open'
    UNION ALL
    SELECT agent_id FROM agent_gaps
      WHERE user_id = p_user_id AND created_at >= v_window_start AND status = 'active'
  ) AS all_activity;

  SELECT COALESCE(json_agg(row_json ORDER BY ord), '[]'::json) INTO v_top_tensions
  FROM (
    SELECT
      row_number() OVER () AS ord,
      json_build_object(
        'id', i.id,
        'agent_id', i.agent_id,
        'agent_name', a.name,
        'claim', i.claim,
        'evidence_summary', i.evidence_summary,
        'confidence', i.confidence,
        'created_at', i.created_at
      ) AS row_json
    FROM agent_insights i
    JOIN domain_agents a ON a.id = i.agent_id
    WHERE i.user_id = p_user_id
      AND i.created_at >= v_window_start
      AND i.insight_type = 'tension'
      AND i.status = 'active'
    ORDER BY i.confidence DESC NULLS LAST, i.created_at DESC
    LIMIT 3
  ) t;

  SELECT COALESCE(json_agg(row_json ORDER BY ord), '[]'::json) INTO v_top_frontier_questions
  FROM (
    SELECT
      row_number() OVER () AS ord,
      json_build_object(
        'id', q.id,
        'agent_id', q.agent_id,
        'agent_name', a.name,
        'question', q.question,
        'priority', q.priority,
        'created_at', q.created_at
      ) AS row_json
    FROM agent_standing_questions q
    JOIN domain_agents a ON a.id = q.agent_id
    WHERE q.user_id = p_user_id
      AND q.created_at >= v_window_start
      AND q.question_type = 'frontier'
      AND q.status = 'open'
    ORDER BY q.priority DESC NULLS LAST, q.created_at DESC
    LIMIT 3
  ) t;

  SELECT COALESCE(json_agg(row_json ORDER BY ord), '[]'::json) INTO v_top_gaps
  FROM (
    SELECT
      row_number() OVER () AS ord,
      json_build_object(
        'id', g.id,
        'agent_id', g.agent_id,
        'agent_name', a.name,
        'topic', g.topic,
        'description', g.description,
        'severity', g.severity,
        'gap_type', g.gap_type,
        'created_at', g.created_at
      ) AS row_json
    FROM agent_gaps g
    JOIN domain_agents a ON a.id = g.agent_id
    WHERE g.user_id = p_user_id
      AND g.created_at >= v_window_start
      AND g.status = 'active'
      AND g.severity IN ('significant', 'moderate')
    ORDER BY
      CASE g.severity WHEN 'significant' THEN 0 WHEN 'moderate' THEN 1 ELSE 2 END,
      g.created_at DESC
    LIMIT 3
  ) t;

  SELECT COALESCE(json_agg(row_json ORDER BY ord), '[]'::json) INTO v_active_agents
  FROM (
    SELECT
      row_number() OVER (ORDER BY (new_insights + new_questions + new_gaps) DESC, agent_name) AS ord,
      json_build_object(
        'agent_id', agent_id,
        'agent_name', agent_name,
        'health_status', health_status,
        'new_insights', new_insights,
        'new_questions', new_questions,
        'new_gaps', new_gaps
      ) AS row_json
    FROM (
      SELECT
        a.id AS agent_id,
        a.name AS agent_name,
        a.health_status,
        COALESCE(i_counts.cnt, 0) AS new_insights,
        COALESCE(q_counts.cnt, 0) AS new_questions,
        COALESCE(g_counts.cnt, 0) AS new_gaps
      FROM domain_agents a
      LEFT JOIN (
        SELECT agent_id, COUNT(*)::INT AS cnt
        FROM agent_insights
        WHERE user_id = p_user_id AND created_at >= v_window_start AND status = 'active'
        GROUP BY agent_id
      ) i_counts ON i_counts.agent_id = a.id
      LEFT JOIN (
        SELECT agent_id, COUNT(*)::INT AS cnt
        FROM agent_standing_questions
        WHERE user_id = p_user_id AND created_at >= v_window_start AND status = 'open'
        GROUP BY agent_id
      ) q_counts ON q_counts.agent_id = a.id
      LEFT JOIN (
        SELECT agent_id, COUNT(*)::INT AS cnt
        FROM agent_gaps
        WHERE user_id = p_user_id AND created_at >= v_window_start AND status = 'active'
        GROUP BY agent_id
      ) g_counts ON g_counts.agent_id = a.id
      WHERE a.user_id = p_user_id
        AND (COALESCE(i_counts.cnt, 0) + COALESCE(q_counts.cnt, 0) + COALESCE(g_counts.cnt, 0)) > 0
      ORDER BY (COALESCE(i_counts.cnt, 0) + COALESCE(q_counts.cnt, 0) + COALESCE(g_counts.cnt, 0)) DESC, a.name
      LIMIT 5
    ) ranked
  ) t;

  -- NEW: questions closed or partially closed by Phase 0 pull within the window.
  SELECT COALESCE(json_agg(row_json ORDER BY ord), '[]'::json) INTO v_recently_answered
  FROM (
    SELECT
      row_number() OVER () AS ord,
      json_build_object(
        'id', q.id,
        'agent_id', q.agent_id,
        'agent_name', a.name,
        'question', q.question,
        'question_type', q.question_type,
        'status', q.status,
        'status_changed_at', q.status_changed_at,
        'addressing_source_ids', q.addressing_source_ids,
        'addressing_evidence', q.addressing_evidence
      ) AS row_json
    FROM agent_standing_questions q
    JOIN domain_agents a ON a.id = q.agent_id
    WHERE q.user_id = p_user_id
      AND q.status IN ('answered', 'partially_addressed')
      AND q.status_changed_at IS NOT NULL
      AND q.status_changed_at >= v_window_start
    ORDER BY q.status_changed_at DESC
    LIMIT 10
  ) t;

  RETURN json_build_object(
    'summary', json_build_object(
      'insights_count', v_insights_count,
      'questions_count', v_questions_count,
      'gaps_count', v_gaps_count,
      'active_agents_count', v_active_agents_count,
      'window_days', p_days
    ),
    'top_tensions', v_top_tensions,
    'top_frontier_questions', v_top_frontier_questions,
    'top_gaps', v_top_gaps,
    'active_agents', v_active_agents,
    'recently_answered_questions', v_recently_answered
  );
END;
$function$;
