-- 20260426_drop_agent_signals.sql
-- Retire the signal system. Cross-agent connections now flow through
-- novel_connection insights produced by Phase 0 of the cron.

BEGIN;

DROP INDEX IF EXISTS idx_as_target_status;
DROP INDEX IF EXISTS idx_as_source_agent;
DROP INDEX IF EXISTS idx_as_bridge_edge;
DROP TABLE IF EXISTS agent_signals CASCADE;

COMMIT;
