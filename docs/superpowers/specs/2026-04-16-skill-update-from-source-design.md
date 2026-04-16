# Skill Update from Source - Design Spec

**Date:** 2026-04-16
**Status:** Implemented

## Problem

When the skill backfill cron fires (every 5 minutes), it sometimes runs before the content chunking pipeline has finished for a newly ingested source. When this happens, the backfill finds no chunks, stamps the source as `skill_backfill_status: 'processed'` with `skill_backfill_result: 'skipped_no_chunks'`, and moves on permanently. Neither the 5-minute cron nor the daily cron will re-evaluate this source, because both skip sources already marked as "processed."

This means follow-up meetings on the same topic never update the relevant skill, even when they contain directly applicable new methodology.

Additionally, there is no manual way for users to say "update this skill based on this source" from the UI.

## Solution

### Fix 1: Backend retry for skipped_no_chunks

**Files changed:**
- `api/skills/backfill.ts` - `markSource()` now stamps `skill_backfill_status: 'pending_retry'` (instead of `'processed'`) when the result is `skipped_no_chunks`. The source query also now picks up sources with `pending_retry` status.
- `api/skills/daily-cron.ts` - The candidate source filter now includes sources with `skill_backfill_status === 'pending_retry'` in addition to sources with no status.

**Behavior:** When the 5-minute cron finds no chunks for a source, it marks it as `pending_retry`. On the next cron pass (5 minutes later), chunks will almost certainly exist, and the source will be properly evaluated.

### Fix 2: Manual "Add Source" in skill detail panel

**New file:**
- `api/skills/update-from-source.ts` - Serverless endpoint that takes a `skillId` and `sourceId`, fetches both records, runs the Gemini assessment pipeline, generates updated skill content via `generateUpdateContent`, updates the skill in the database, and re-embeds the description.

**Modified files:**
- `src/components/skills/SkillDetailPanel.tsx` - Added "Add Source" button in the Contributing Sources section header. Opens a dropdown with a search input that queries existing sources. Selecting a source triggers the update.
- `src/hooks/useKnowledgeSkills.ts` - Added `updateSkillFromSource(skillId, sourceId)` (calls the new API endpoint) and `searchSources(query)` (searches `knowledge_sources` by title).
- `src/views/SignalsView.tsx` - Wired new props to `SkillDetailPanel`.
- `src/views/SkillsView.tsx` - Wired new props to `SkillDetailPanel`.

**UI flow:**
1. User opens a skill in the Signals or Skills view
2. In the Contributing Sources section, clicks "Add Source"
3. A dropdown appears with a search input
4. User types to search their ingested sources by title
5. Selecting a source shows a loading state while the API processes
6. On completion, the skill detail refreshes with updated content and the new source listed

## Architecture notes

- The new endpoint is fully self-contained (Vercel serverless rule - no local imports)
- Reuses the same Gemini assessment and content generation prompts as `backfill.ts`
- Auth is via Bearer token (user's Supabase session)
- Both the skill and source must belong to the authenticated user (RLS-compatible)
- The source is marked with `skill_backfill_status: 'processed'` and `skill_backfill_result: 'updated'` after successful update, preventing the cron from double-processing it
