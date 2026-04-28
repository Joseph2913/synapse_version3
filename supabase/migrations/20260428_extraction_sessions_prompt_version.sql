-- Stage 4 — Prompt composition.
-- Stamp the canonical PROMPT_VERSION onto every extraction_sessions row so we
-- can correlate extraction quality with prompt revisions over time. Default
-- 'unknown' applies to historical rows; new rows are written by the canonical
-- composeExtractionPrompt() helper, which always supplies a value.

ALTER TABLE extraction_sessions
  ADD COLUMN IF NOT EXISTS prompt_version text NOT NULL DEFAULT 'unknown';

CREATE INDEX IF NOT EXISTS extraction_sessions_prompt_version_idx
  ON extraction_sessions (prompt_version);

COMMENT ON COLUMN extraction_sessions.prompt_version IS
  'Stage 4 canonical PROMPT_VERSION (semver) used to compose the extraction system prompt. See docs/STAGE-4-PROMPT.md.';
