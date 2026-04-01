-- Migration: bulk_update_graph_positions RPC
-- Purpose: Accepts a JSON array of {id, x, y} and updates all positions in one call.
-- Used by api/graph/compute-layout.ts to save 5,000+ positions efficiently.

CREATE OR REPLACE FUNCTION bulk_update_graph_positions(
  p_user_id UUID,
  p_positions json
)
RETURNS json
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
  updated_count integer := 0;
BEGIN
  UPDATE knowledge_nodes kn
  SET
    graph_x = (pos->>'x')::double precision,
    graph_y = (pos->>'y')::double precision
  FROM json_array_elements(p_positions) AS pos
  WHERE kn.id = (pos->>'id')::uuid
    AND kn.user_id = p_user_id;

  GET DIAGNOSTICS updated_count = ROW_COUNT;

  RETURN json_build_object('updated', updated_count);
END;
$$;
