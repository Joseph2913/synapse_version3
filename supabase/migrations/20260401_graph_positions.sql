-- Migration: Add graph_x / graph_y position columns to knowledge_nodes
-- Purpose: Stores pre-computed layout positions for the full graph view.
-- Positions are computed by the Vercel function api/graph/compute-layout.ts
-- after each ingestion, so the browser can render instantly without simulation.
--
-- NULL means the node hasn't been positioned yet (newly created or first run).
-- See: docs/PERFORMANCE-PATTERNS.md

ALTER TABLE knowledge_nodes
  ADD COLUMN IF NOT EXISTS graph_x double precision,
  ADD COLUMN IF NOT EXISTS graph_y double precision;

-- Index for quick retrieval of positioned nodes
CREATE INDEX IF NOT EXISTS idx_knowledge_nodes_graph_positioned
  ON knowledge_nodes (user_id)
  WHERE graph_x IS NOT NULL AND graph_y IS NOT NULL AND is_merged = false;
