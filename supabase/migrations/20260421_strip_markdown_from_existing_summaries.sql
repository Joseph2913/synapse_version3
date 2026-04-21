-- Migration: one-time backfill to strip markdown from existing summaries
-- Purpose: Before fix #3, ingestion paths stored raw markdown in
-- knowledge_sources.summary (e.g. Circleback notes saved as
-- "#### Overview * Scope is confirmed..."). UI cards that rendered summary
-- directly leaked the raw characters. Going forward, all ingestion paths
-- strip markdown at write time; this migration brings existing rows in line.
--
-- This is idempotent: running it twice produces the same result.

UPDATE knowledge_sources
SET summary = regexp_replace(
  regexp_replace(
    regexp_replace(
      regexp_replace(
        regexp_replace(
          regexp_replace(
            regexp_replace(
              regexp_replace(
                regexp_replace(
                  regexp_replace(summary,
                    '#{1,6}\s+', '', 'g'),           -- ATX headings
                  E'\\*\\*(.+?)\\*\\*', '\\1', 'g'), -- bold **
                E'\\*(.+?)\\*', '\\1', 'g'),         -- italic *
              '__(.+?)__', '\\1', 'g'),              -- bold __
            '_(.+?)_', '\\1', 'g'),                  -- italic _
          '`(.+?)`', '\\1', 'g'),                    -- inline code
        E'\\[(.+?)\\]\\(.+?\\)', '\\1', 'g'),        -- [text](url)
      E'(?m)^\\s*[-*+]\\s+', '', 'g'),               -- bullet list markers
    E'(?m)^\\s*\\d+\\.\\s+', '', 'g'),               -- ordered list markers
  E'\\n{2,}', ' ', 'g')                              -- collapse blank lines
WHERE summary IS NOT NULL
  AND (
    summary ~ '#{1,6}\s+'
    OR summary LIKE '%**%'
    OR summary ~ E'(?m)^\\s*[-*+]\\s+'
    OR summary ~ E'(?m)^\\s*\\d+\\.\\s+'
    OR summary LIKE '%`%'
    OR summary ~ E'\\[.+?\\]\\(.+?\\)'
  );

-- Collapse leftover whitespace runs introduced by the strip.
UPDATE knowledge_sources
SET summary = regexp_replace(summary, E'\\s+', ' ', 'g')
WHERE summary IS NOT NULL
  AND summary ~ E'\\s{2,}';

UPDATE knowledge_sources
SET summary = trim(summary)
WHERE summary IS NOT NULL
  AND (summary LIKE ' %' OR summary LIKE '% ');
