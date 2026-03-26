-- Add personas JSONB column to simulation_jobs
-- Stores generated SimulationPersona[] so failed jobs can resume without re-generating

ALTER TABLE simulation_jobs
ADD COLUMN IF NOT EXISTS personas JSONB;

COMMENT ON COLUMN simulation_jobs.personas IS 'Generated SimulationPersona array — persisted after persona generation to enable resume on failure.';
