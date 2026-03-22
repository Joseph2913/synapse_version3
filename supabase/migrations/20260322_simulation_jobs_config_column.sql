-- PRD-Simulate-C: Add config JSONB column to simulation_jobs
-- Stores the full SimulationConfig object for audit trail per SIMULATE-PRINCIPLES.md Layer 1

ALTER TABLE simulation_jobs
ADD COLUMN IF NOT EXISTS config JSONB;

COMMENT ON COLUMN simulation_jobs.config IS 'Full SimulationConfig object: mode, depth, sensitivity, source filters, external agents, etc.';
