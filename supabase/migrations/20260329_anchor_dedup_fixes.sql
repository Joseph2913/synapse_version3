-- ============================================================
-- Part 1A: Fix vector(768) → vector(3072) in existing RPCs
-- ============================================================

CREATE OR REPLACE FUNCTION find_similar_nodes(
  p_user_id UUID,
  p_embedding VECTOR(3072),
  p_threshold FLOAT DEFAULT 0.80,
  p_limit INT DEFAULT 20
)
RETURNS TABLE (
  id UUID,
  label TEXT,
  entity_type TEXT,
  description TEXT,
  is_anchor BOOLEAN,
  similarity FLOAT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
BEGIN
  RETURN QUERY
  SELECT
    kn.id,
    kn.label,
    kn.entity_type,
    kn.description,
    kn.is_anchor,
    1 - (kn.embedding <=> p_embedding) AS similarity
  FROM public.knowledge_nodes kn
  WHERE kn.user_id = p_user_id
    AND kn.embedding IS NOT NULL
    AND kn.is_merged IS NOT TRUE
    AND 1 - (kn.embedding <=> p_embedding) > p_threshold
  ORDER BY kn.embedding <=> p_embedding
  LIMIT p_limit;
END;
$$;

CREATE OR REPLACE FUNCTION find_similar_anchors(
  p_user_id UUID,
  p_threshold FLOAT DEFAULT 0.85,
  p_limit INT DEFAULT 50
)
RETURNS TABLE (
  anchor_id UUID,
  anchor_label TEXT,
  similar_id UUID,
  similar_label TEXT,
  similar_entity_type TEXT,
  similarity FLOAT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
BEGIN
  RETURN QUERY
  SELECT
    a.id AS anchor_id,
    a.label AS anchor_label,
    b.id AS similar_id,
    b.label AS similar_label,
    b.entity_type AS similar_entity_type,
    1 - (a.embedding <=> b.embedding) AS similarity
  FROM public.knowledge_nodes a
  INNER JOIN public.knowledge_nodes b
    ON a.user_id = b.user_id
    AND a.id < b.id
    AND b.embedding IS NOT NULL
    AND b.is_merged IS NOT TRUE
  WHERE a.user_id = p_user_id
    AND a.is_anchor = true
    AND a.embedding IS NOT NULL
    AND a.is_merged IS NOT TRUE
    AND 1 - (a.embedding <=> b.embedding) > p_threshold
  ORDER BY similarity DESC
  LIMIT p_limit;
END;
$$;


-- ============================================================
-- Part 1B: New RPC — Find all duplicate clusters across nodes
-- ============================================================

CREATE OR REPLACE FUNCTION find_duplicate_clusters(
  p_user_id UUID,
  p_semantic_threshold FLOAT DEFAULT 0.88,
  p_entity_type TEXT DEFAULT NULL,
  p_anchors_only BOOLEAN DEFAULT false,
  p_limit INT DEFAULT 100
)
RETURNS TABLE (
  node_a_id UUID,
  node_a_label TEXT,
  node_a_entity_type TEXT,
  node_a_is_anchor BOOLEAN,
  node_a_connection_count BIGINT,
  node_b_id UUID,
  node_b_label TEXT,
  node_b_entity_type TEXT,
  node_b_is_anchor BOOLEAN,
  node_b_connection_count BIGINT,
  match_type TEXT,
  similarity FLOAT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
BEGIN
  RETURN QUERY
  SELECT * FROM (

    SELECT
      a.id, a.label, a.entity_type, a.is_anchor,
      (SELECT COUNT(*) FROM public.knowledge_edges e
       WHERE e.source_node_id = a.id OR e.target_node_id = a.id) AS a_conns,
      b.id, b.label, b.entity_type, b.is_anchor,
      (SELECT COUNT(*) FROM public.knowledge_edges e
       WHERE e.source_node_id = b.id OR e.target_node_id = b.id) AS b_conns,
      'exact'::TEXT AS mt,
      1.0::FLOAT AS sim
    FROM public.knowledge_nodes a
    INNER JOIN public.knowledge_nodes b
      ON a.user_id = b.user_id
      AND a.id < b.id
      AND LOWER(TRIM(a.label)) = LOWER(TRIM(b.label))
      AND a.entity_type = b.entity_type
      AND b.is_merged IS NOT TRUE
    WHERE a.user_id = p_user_id
      AND a.is_merged IS NOT TRUE
      AND (p_entity_type IS NULL OR a.entity_type = p_entity_type)
      AND (p_anchors_only IS FALSE OR (a.is_anchor = true OR b.is_anchor = true))

    UNION ALL

    SELECT
      a.id, a.label, a.entity_type, a.is_anchor,
      (SELECT COUNT(*) FROM public.knowledge_edges e
       WHERE e.source_node_id = a.id OR e.target_node_id = a.id) AS a_conns,
      b.id, b.label, b.entity_type, b.is_anchor,
      (SELECT COUNT(*) FROM public.knowledge_edges e
       WHERE e.source_node_id = b.id OR e.target_node_id = b.id) AS b_conns,
      'semantic'::TEXT AS mt,
      (1 - (a.embedding <=> b.embedding))::FLOAT AS sim
    FROM public.knowledge_nodes a
    INNER JOIN public.knowledge_nodes b
      ON a.user_id = b.user_id
      AND a.id < b.id
      AND LOWER(TRIM(a.label)) != LOWER(TRIM(b.label))
      AND b.embedding IS NOT NULL
      AND b.is_merged IS NOT TRUE
    WHERE a.user_id = p_user_id
      AND a.is_merged IS NOT TRUE
      AND a.embedding IS NOT NULL
      AND (p_entity_type IS NULL OR a.entity_type = p_entity_type)
      AND (p_anchors_only IS FALSE OR (a.is_anchor = true OR b.is_anchor = true))
      AND 1 - (a.embedding <=> b.embedding) > p_semantic_threshold

  ) AS combined
  ORDER BY combined.sim DESC
  LIMIT p_limit;
END;
$$;


-- ============================================================
-- Part 1C: New RPC — Check if a specific label has near-matches
-- ============================================================

CREATE OR REPLACE FUNCTION check_node_duplicate(
  p_user_id UUID,
  p_label TEXT,
  p_entity_type TEXT,
  p_embedding VECTOR(3072),
  p_exact_threshold FLOAT DEFAULT 0.92,
  p_semantic_threshold FLOAT DEFAULT 0.88
)
RETURNS TABLE (
  match_id UUID,
  match_label TEXT,
  match_entity_type TEXT,
  match_is_anchor BOOLEAN,
  match_type TEXT,
  similarity FLOAT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
BEGIN
  RETURN QUERY

  SELECT
    kn.id, kn.label, kn.entity_type, kn.is_anchor,
    'exact'::TEXT,
    1.0::FLOAT
  FROM public.knowledge_nodes kn
  WHERE kn.user_id = p_user_id
    AND LOWER(TRIM(kn.label)) = LOWER(TRIM(p_label))
    AND kn.entity_type = p_entity_type
    AND kn.is_merged IS NOT TRUE

  UNION ALL

  SELECT
    kn.id, kn.label, kn.entity_type, kn.is_anchor,
    'fuzzy'::TEXT,
    1.0 - (public.levenshtein(LOWER(TRIM(kn.label)), LOWER(TRIM(p_label)))::FLOAT
           / GREATEST(LENGTH(kn.label), LENGTH(p_label))::FLOAT)
  FROM public.knowledge_nodes kn
  WHERE kn.user_id = p_user_id
    AND kn.is_merged IS NOT TRUE
    AND kn.entity_type = p_entity_type
    AND LENGTH(kn.label) BETWEEN LENGTH(p_label) - 3 AND LENGTH(p_label) + 3
    AND 1.0 - (public.levenshtein(LOWER(TRIM(kn.label)), LOWER(TRIM(p_label)))::FLOAT
               / GREATEST(LENGTH(kn.label), LENGTH(p_label))::FLOAT) >= p_exact_threshold
    AND LOWER(TRIM(kn.label)) != LOWER(TRIM(p_label))

  UNION ALL

  SELECT
    kn.id, kn.label, kn.entity_type, kn.is_anchor,
    'semantic'::TEXT,
    1 - (kn.embedding <=> p_embedding)
  FROM public.knowledge_nodes kn
  WHERE kn.user_id = p_user_id
    AND kn.is_merged IS NOT TRUE
    AND kn.embedding IS NOT NULL
    AND 1 - (kn.embedding <=> p_embedding) > p_semantic_threshold
    AND LOWER(TRIM(kn.label)) != LOWER(TRIM(p_label))

  ORDER BY similarity DESC
  LIMIT 10;
END;
$$;


-- ============================================================
-- Part 1D: Enable fuzzystrmatch extension for Levenshtein
-- ============================================================

CREATE EXTENSION IF NOT EXISTS fuzzystrmatch;
