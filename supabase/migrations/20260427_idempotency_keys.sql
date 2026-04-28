-- Stage 0 Item 6 — Idempotency on webhooks and queue workers
-- Adds two idempotency keys to knowledge_sources:
--   1. circleback_meeting_id — closes the meeting-webhook race condition
--      where two simultaneous Circleback webhooks could both pass the
--      application-level dedup check and insert two rows.
--   2. content_hash — covers sources without a source_url (paste, file
--      upload) where the existing partial unique index on
--      (user_id, source_type, source_url) does not apply.
--
-- Both columns are nullable. Existing rows default to NULL for both. The
-- partial unique indexes only apply to rows where the key is set, so the
-- migration is non-destructive.

BEGIN;

-- 1. Circleback meeting ID
ALTER TABLE knowledge_sources
  ADD COLUMN IF NOT EXISTS circleback_meeting_id bigint;

CREATE UNIQUE INDEX IF NOT EXISTS knowledge_sources_user_circleback_uniq
  ON knowledge_sources (user_id, circleback_meeting_id)
  WHERE circleback_meeting_id IS NOT NULL;

-- 2. Content hash (SHA-256 hex string, 64 chars) for paste/file inputs
ALTER TABLE knowledge_sources
  ADD COLUMN IF NOT EXISTS content_hash text;

CREATE UNIQUE INDEX IF NOT EXISTS knowledge_sources_user_type_content_hash_uniq
  ON knowledge_sources (user_id, source_type, content_hash)
  WHERE content_hash IS NOT NULL AND source_url IS NULL;

COMMIT;

-- Verification (run manually after applying):
--   SELECT count(*) FROM knowledge_sources WHERE circleback_meeting_id IS NOT NULL;
--   -- Expected: 0 immediately after migration; grows as new meeting webhooks fire.
--   SELECT count(*) FROM knowledge_sources WHERE content_hash IS NOT NULL;
--   -- Expected: 0 immediately after migration; grows as new pastes/files are saved.
