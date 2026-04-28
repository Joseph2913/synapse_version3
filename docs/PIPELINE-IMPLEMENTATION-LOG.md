# Pipeline Implementation Log

**Purpose.** Single source of truth for the production-hardening of the 13-stage source ingestion pipeline. Every chat working on any stage reads this first and updates it as work lands. If a fact lives anywhere else, it is wrong.

**Owner:** Joseph Thomas
**Started:** 2026-04-26
**Last updated:** 2026-04-28 (Block 3)

---

## How this file works

This is a **living log**, not a plan. It tracks what has actually shipped, what is in flight, what was deferred, and why. Plans live in per-stage scope docs. PRDs live under `docs/PRDs/`. This file links to them and records status.

### Update protocol (every agent working on any stage MUST follow this)

1. **Before starting work,** read this file end to end. Do not assume. Check the relevant stage's status, decisions, and open questions.
2. **When status changes,** update the stage's status table row and add a dated entry to the changelog at the bottom.
3. **When a decision is made,** add it to the Decision Log with date, decision, rationale, and who approved.
4. **When an item is deferred or deprioritised,** move it to the Deferred / Pushed Back section with a one-line reason.
5. **When a stage is complete,** flip its status to `Done`, link to its summary doc (e.g. `docs/STAGE-N-NAME.md`), and post a short retrospective note.
6. **Never delete history.** If a decision is reversed, mark the original as `Superseded` and add the new one. We need to be able to read this file in 6 months and reconstruct what happened and why.
7. **Cite file paths and line numbers** where claims about implementation live.

### Status vocabulary

- `Not started` — no investigation yet.
- `Scoped` — scope agreed in chat, prompt drafted, not yet executed.
- `In progress` — agent is actively working on it.
- `Blocked` — waiting on a decision, dependency, or external input.
- `Partial` — some items shipped, others pending.
- `Done` — all validation gates passed.
- `Deferred` — explicitly pushed to a later phase.
- `Superseded` — replaced by a different approach.

---

## Master status table

| Stage | Name | Status | Owner doc | Last updated |
|---|---|---|---|---|
| 0 | Foundations | Done | [STAGE-0-FOUNDATIONS.md](STAGE-0-FOUNDATIONS.md) | 2026-04-28 |
| 1 | Capture (front door, five adapters) | Done | [STAGE-1-CAPTURE.md](STAGE-1-CAPTURE.md) | 2026-04-26 |
| 2 | Source persistence + dedup | Done | [STAGE-2-PERSISTENCE.md](STAGE-2-PERSISTENCE.md) | 2026-04-28 |
| 3 | Chunking + chunk embeddings | Done | [STAGE-3-CHUNKING.md](STAGE-3-CHUNKING.md) | 2026-04-27 |
| 4 | Prompt composition | Done | [STAGE-4-PROMPT.md](STAGE-4-PROMPT.md) | 2026-04-28 |
| 5 | Entity extraction | Done | [STAGE-5-EXTRACTION.md](STAGE-5-EXTRACTION.md) | 2026-04-28 |
| 6 | Deduplication + merge | Done | [STAGE-6-DEDUP.md](STAGE-6-DEDUP.md) | 2026-04-28 |
| 7 | Knowledge persistence | Done | [STAGE-7-PERSISTENCE.md](STAGE-7-PERSISTENCE.md) | 2026-04-28 |
| 8 | Cross-connection discovery | Done | [STAGE-8-CROSS-CONNECT.md](STAGE-8-CROSS-CONNECT.md) | 2026-04-28 |
| 9 | Anchor scoring | Done | [STAGE-9-ANCHOR-SCORING.md](STAGE-9-ANCHOR-SCORING.md) | 2026-04-28 |
| 10 | Skills detection + scoring | Done | _inline_ | 2026-04-28 |
| 11 | Council updates | Partial (Phase 0 shipped) | _pending_ | 2026-04-26 |
| 12 | Extraction session audit | Not started | _pending_ | 2026-04-26 |
| 13 | Surfacing (RAG, MCP, activity) | Not started | _pending_ | 2026-04-26 |
| S | Secret hygiene + client-server boundary | Scoped (urgent — incident-driven) | _pending_ | 2026-04-28 |

---

## Stage-by-stage detail

### Stage 0 — Foundations

**Status:** Done. All seven items shipped (Items 1, 2A, 2B, 3, 4, 5, 6, 7).

**Owner doc:** [STAGE-0-FOUNDATIONS.md](STAGE-0-FOUNDATIONS.md)

**Shipped:**
- **Item 1 — Single Supabase client.** Canonical recipe documented. Browser uses one shared client. All ~30 backend files use the same factory pattern with no inline `createClient` calls. Env-var safety check at module scope.
- **Item 2 (Phase 2B) — Gemini retry on rate limits + token-usage telemetry. Implemented and validated 2026-04-28.** Canonical `geminiFetch` helper rolled out across 41 backend files in `api/`. Every chat call (`:generateContent`) now retries on 429/5xx with 1s/2s/4s exponential backoff (max 3 attempts) and emits one structured JSON log line per call recording `{ stage, model, prompt_tokens, output_tokens, total_tokens }`. Embedding helpers (`embedText`, `embedTexts`) now share the same retry path; Gemini does not return `usageMetadata` for embedding endpoints, so embedding telemetry remains call-count + latency only (documented upstream limitation). Existing per-file helpers (`callGemini`, `geminiJson`, `generateEmbedding`, etc.) were retained as thin wrappers delegating to `geminiFetch` so call sites are unchanged. Rollout pattern: pilot (`api/summaries/backfill.ts`) → two more (`api/council/route.ts`, `api/youtube/extract-knowledge.ts`) → bulk across 38 remaining files. TypeScript compiles clean; zero new errors introduced (14 pre-existing tsc errors fixed as a side effect of stricter response-type casting).
- **Item 2 (Phase 2A) — Single Gemini wrapper, model normalization.** Single setting controls the chat model everywhere (`GEMINI_MODEL` env var on backend, `VITE_GEMINI_MODEL` for browser). Hard-coded `'gemini-2.5-flash'` literals removed from 28 backend files and 6 sites in the browser file. Five other browser files now import the canonical model constants. `GEMINI_API_KEY` startup check on every backend file. TypeScript compiles clean.
- **Item 3 — Single embedding service.** Embedding model unified to `gemini-embedding-001` across the entire codebase. `api/skills/scan.ts` and `api/skills/process-source.ts` (which had been silently using `text-embedding-004` for in-memory candidate-vs-anchor similarity comparisons against `gemini-embedding-001` anchor vectors stored in the DB) now match the rest of the system; this fixes a latent correctness bug where the skills `s1` anchor-alignment signal and the "related anchors" attachment list were built on cross-model similarity scores. CLAUDE.md updated to reflect the canonical model. Canonical `embedText` (single) + `embedTexts` (batch via `:batchEmbedContents`, 100 per call) recipe documented in `STAGE-0-FOUNDATIONS.md`. Three high-volume sequential embedding loops (`api/council/backfill-question-embeddings.ts`, `api/council/cron.ts`, `api/council/rebuild-agent.ts`) upgraded from per-text loops to true batch — N network calls reduced to ⌈N/100⌉. TypeScript compiles clean.
- **Item 4 — Structured logging.** Canonical `log()` / `logError()` helpers added to all 61 backend files in `api/` that touch Supabase, Gemini, or external services. Helper signature standardised on `{ stage, user_id?, source_id?, duration_ms?, status?, error? }` with timestamp prepended. Recipe documented in `STAGE-0-FOUNDATIONS.md` with the 13-stage taxonomy (`capture`, `persist`, `chunk`, `prompt`, `extract`, `dedup`, `knowledge`, `cross-connect`, `anchor`, `skills`, `council`, `audit`, `surface`). Per migration policy, existing free-text `console.log` lines remain in place and migrate stage-by-stage as each pipeline stage is hardened — no high-risk mass rewrite. New code from this point forward must use `log()` / `logError()`. TypeScript compiles clean.
- **Item 5 — Failure-handling policy.** `docs/FAILURE-POLICY.md` written: every one of the 13 pipeline stages assigned exactly one rule (Fatal | Degraded | Skip-with-telemetry) with rationale and per-stage outcome on `knowledge_sources.status`. Source state machine documented: `pending → chunking → extracting → augmenting → complete | failed | degraded`. Schema migration `20260427_knowledge_sources_status.sql` applied to production: adds `status text NOT NULL DEFAULT 'complete'` to `knowledge_sources` with check constraint and two indexes (`(user_id, status)` and a partial `(status, created_at DESC) WHERE status IN ('degraded','failed','pending')` for the retry queue). Existing rows default to `'complete'` so no backfill required. Audit of 145 catch blocks: 19 silent catches found, 18 are control-flow exceptions (auth probe fall-throughs and JSON-parse defensive fallbacks) which the policy doc now explicitly exempts; 1 genuine silent failure in `api/youtube/extract-knowledge.ts:330` (daily-counter update) replaced with a `logError({ stage: 'capture:youtube:counter', status: 'skipped', ... })` call. Per-stage rewrite of remaining catches to update `knowledge_sources.status` happens when each pipeline stage is hardened — Item 5 ships the contract, stages 1–13 implement it as they're touched. TypeScript compiles clean.
- **Item 6 — Idempotency on webhooks and queue workers.** Schema migration `20260427_idempotency_keys.sql` applied to production: adds two nullable columns to `knowledge_sources` (`circleback_meeting_id bigint`, `content_hash text`) with two partial unique indexes (`(user_id, circleback_meeting_id) WHERE circleback_meeting_id IS NOT NULL` and `(user_id, source_type, content_hash) WHERE content_hash IS NOT NULL AND source_url IS NULL`). Both columns default to NULL on existing rows; no backfill. Meeting webhook (`api/meetings/webhook.ts`) refactored from "check then insert" to upsert with `onConflict: 'user_id,circleback_meeting_id', ignoreDuplicates: true` plus existing-row fallback fetch — closes the race condition where two simultaneous Circleback webhooks could both pass the application-level dedup check. Browser-side `saveSource()` in `src/services/extractionPersistence.ts` now computes a SHA-256 content hash (Web Crypto) for sources without a `source_url` and runs a pre-insert dedup check plus a post-insert race-condition catch on PostgreSQL error 23505 — closes the duplicate-paste / duplicate-file-upload hole. URL-bearing sources (YouTube, web) continue to dedup on the existing `(user_id, source_type, source_url)` index. Other webhook entry points (Microsoft, YouTube poll, internal ingest) reviewed and confirmed already idempotent via existing unique constraints. TypeScript compiles clean.
- **Item 7 — RLS audit.** `docs/RLS-AUDIT.md` written. Live verification against production: every public table has RLS enabled (43/43), every public table has at least one policy (43/43, zero "RLS-on-but-no-policy" footguns). Most tables use a full per-command policy set (`SELECT`/`INSERT`/`UPDATE`/`DELETE`) gated by `auth.uid() = user_id`; some use the equivalent `ALL` shape. Tables with reduced policy counts reviewed and confirmed intentional (`council_cron_runs` SELECT-only, `mcp_query_log` INSERT+SELECT only with intentional `WITH CHECK true` for server-side API-key writes, `youtube_settings` UPDATE-only). All 58 backend files using the service role audited: every user-bound endpoint authenticates first then scopes by `user_id`; cron / batch files iterate top-level rows that carry `user_id` and propagate it into every downstream query. **Two minor follow-ups recorded** (non-blocking): add `WITH CHECK` clauses to `user_integrations` and `youtube_playlists` `ALL` policies (currently have `USING` but no `WITH CHECK` — service role is the only writer today, so low-severity), and spot-check `api/skills/rescore.ts` and `api/youtube/fetch-transcripts.ts` during their respective stage hardening passes (low filter-count looked unusual in audit but is likely intentional cron pattern). Source `source_chunks` has an additional service-role escape-hatch policy (intentional, used by the extraction pipeline); documented in the audit doc.

**In flight:** none.

**Deferred (within Stage 0):** none.

**Open:** none.

**Decisions:** see Decision Log entries D-001.

---

### Stage 1 — Capture (front door)

**Status:** Scoped. Handoff prompt drafted. Five adapters confirmed (paste, URL, file upload, YouTube, meeting webhook). Chrome extension to be removed.

**Owner doc:** _to be created at `docs/STAGE-1-CAPTURE.md` after execution._

**Shipped:** none under Stage 1 scope. Note: pre-existing partial work in the codebase (the five adapters exist but produce inconsistent payload shapes).

**In flight:** none yet. Awaiting agent kickoff.

**Open:**
- Define shared `CapturedSource` type in `src/types/capture.ts`.
- Refactor each adapter to produce that type.
- Replace PDF/audio/video parsing with **Gemini File API** for the file upload adapter.
- Implement YouTube three-tier strategy: Apify default → YouTube Data API v3 fallback → Gemini video escape hatch.
- Title rules, size limits, MIME validation per adapter.
- Contract tests with fixtures.
- **Pre-task:** delete the Chrome extension feature entirely. Update `CLAUDE.md`, `docs/BUILD-PLAN.md`, `docs/ARCHITECTURE.md`. Flag any DB artefacts but do not drop them.

**Decisions:** see D-002, D-003, D-004, D-006.

**Scope clarifications agreed 2026-04-26:**
- Stage 1 adapters produce a clean `CapturedSource` and hand it to the existing call site. They do **not** themselves write to the database. The existing in-app save path stays in place at the call site for now. The full "adapters do not persist" cutover (rewiring `useExtraction` / `saveSource` so persistence only happens in a Stage 2 layer) is **moved to Stage 2** because Stage 2 owns persistence.
- Adapters 1 (paste) and 2 (URL) ship before Stage 0 Item 2 (canonical Gemini wrapper) is complete. They do not call Gemini, so this is safe.
- Adapter 3 (file upload) is **paused** until Stage 0 Item 2 is complete. The file adapter calls the Gemini File API and must use the canonical wrapper.
- Structured logging in Stage 1 adapters uses a placeholder (`console.info` with a structured object) until the Stage 0 logging helper lands. Final Stage 1 sign-off requires the placeholder to be swapped for the real helper.
- Renaming the database `source_type` strings (`'Note'` → `'paste'`, `'Web'` → `'url'`, `'YouTube'` → `'youtube'`, `'Document'` → `'file'`, `'Meeting'` → `'meeting'`) is **moved to Stage 2**, where source data crosses into the database. Stage 1's `CapturedSource.source_type` is the new canonical lowercase form. Stage 2 will translate at the persistence boundary.
- Legacy paste/capture screens that the router does not use (`src/components/ingest/QuickCaptureTab.tsx`, the duplicate `src/components/ingest/IngestView.tsx`, `src/views/CaptureView.tsx`) are flagged for housekeeping deletion at Stage 1 close.

---

### Stage 2 — Source persistence + deduplication

**Status:** Done. Migration applied 2026-04-28; code shipped on `main` the same day.

**Owner doc:** [STAGE-2-PERSISTENCE.md](STAGE-2-PERSISTENCE.md). Read it first for the `persistSource()` contract, dedup rules, validation results, and open follow-ups.

**Shipped:**
- **`persistSource()` contract** — `(captured: CapturedSource, userId: string) => Promise<{ sourceId, isNew, status: 'inserted'|'replaced'|'skipped-duplicate' }>`. Browser canonical at [src/services/persistSource.ts](../src/services/persistSource.ts); per-file inlined variants in `api/meetings/webhook.ts`, `api/youtube/extract-knowledge.ts`, `api/microsoft/extract-knowledge.ts`, `api/ingest/session.ts` (Vercel bundling rule).
- **Shared identity utilities** — `canonicalUrl()`, `extractYouTubeVideoId()`, `canonicalYouTubeUrl()`, `sha256Hex()`, `meetingPayloadSignature()` in [src/utils/sourceIdentity.ts](../src/utils/sourceIdentity.ts). Mirrored inline where serverless functions need them.
- **Dedup identity rules per source type** — youtube/url use canonical URL via `(user_id, source_type, source_url)` partial unique index; file/paste/research/github use SHA-256 `content_hash` via `(user_id, source_type, content_hash)` partial unique index; meeting uses `circleback_meeting_id` via `(user_id, circleback_meeting_id)` partial unique index. All three indexes existed pre-Stage-2; Stage 2 wires the application-level checks to match.
- **Re-ingest behaviour** — youtube/url/file/paste/research/github skip silently with telemetry; meeting compares `metadata.payload_signature` (decision A2 from Wave A) and replaces only when transcript or action items have actually changed.
- **State machine** — `persistSource()` writes `status='pending'` on insert. Replace also resets `status='pending'` so downstream stages re-run. Stage 2 owns no other transition.
- **Source-type rename** — migration `20260427_source_type_lowercase.sql` applied 2026-04-28. Maps `Note→paste`, `Web→url`, `Document→file`, `YouTube→youtube`, `Meeting→meeting`, `Research→research`, `GitHub→github` across `knowledge_sources` (200 rows pre-confirmed mostly already lowercase from the existing capture path), `knowledge_nodes`, `extraction_sessions`. Three RPC `COALESCE` defaults patched (`get_explore_source_graph_v2`, `get_explore_source_graph`, `get_all_sources_graph`).
- **Pre-existing YouTube dedup retired** — the check-then-insert-or-update block from commits `475598c`/`dfc5bc0` (`api/youtube/extract-knowledge.ts:199-237`) replaced by inlined `persistYouTubeSource()`. Wipe-and-rerun semantics preserved for the cron path only.
- **Stuck-source sweep** — new `api/cron/sweep-stuck-sources.ts` flips any non-terminal-status row older than 1 hour to `degraded`. Registered in `vercel.json` at `30 * * * *`. Idempotent.
- **Tests passed (2026-04-28)** — see Validation suite section in `STAGE-2-PERSISTENCE.md`. Schema-side tests (1a/1b, 6a/6b/6c, 7a, 8a/8b) all passed against production. `tsc -b --force` clean (exit 0). Live-traffic tests 2–5 and 9 are open follow-ups.

**Open:**
- Three out-of-scope `source_type` residuals in `knowledge_nodes`/`knowledge_sources` (`Manual` 16, `Unknown` 3139, `API` 1). Either fold into a future cleanup migration or formally deprecate.
- Microsoft queue-claim race (non-atomic `.update({status:'extracting'})`) — out of Stage 2 scope; close when Microsoft pipeline gets its hardening pass.
- `api/github/extract-knowledge.ts` carve-out — `repo_url` collides across daily digests; Stage 2 only renamed its source_type literal. Belongs to a GitHub-specific stage.
- Live-traffic validation soak (24h) for the freshly-shipped persist paths. Watch for `persist:race-fallback` in Vercel logs.

**Decisions:** D-005, D-006, plus three Wave A picks resolved here as D-011 (meeting payload signature), D-012 (Research/GitHub kept and lowercased), D-013 (YouTube cron carve-out). All approved 2026-04-28.

---

### Stage 3 — Chunking + chunk embeddings

**Status:** Done. Owner doc: [STAGE-3-CHUNKING.md](STAGE-3-CHUNKING.md).

**Shipped (2026-04-27):**
- Canonical chunker at [src/utils/chunking.ts](../src/utils/chunking.ts) with byte-equivalent paste-in copies in [api/pipeline/extract-pipeline.ts](../api/pipeline/extract-pipeline.ts) and [api/content/backfill-chunks.ts](../api/content/backfill-chunks.ts). Structural-first split (Markdown headings → paragraphs → sentences → hard cap), 2000-char target, 100-char overlap, 3000-char ceiling, abbreviation-aware sentence regex.
- Embedding input is `${source.title}\n\n${chunk_content}`. Browser uses `generateEmbeddings` (concurrency-5); serverless uses canonical `embedTexts` batch helper (100 per `:batchEmbedContents` call).
- Chunking is fatal (`failed`); embedding is degraded (`degraded`). All-or-nothing chunk insert. Wired into [useExtraction.ts](../src/hooks/useExtraction.ts), [extractionPipeline.ts](../src/services/extractionPipeline.ts), [manualSignals.ts](../src/services/manualSignals.ts), and [extract-pipeline.ts](../api/pipeline/extract-pipeline.ts).
- `saveChunks` / `saveTranscriptChunks` now upsert with `ON CONFLICT (source_id, chunk_index) DO NOTHING`. Idempotent.
- Schema migration `stage3_chunks_constraints_and_index` applied: `UNIQUE (source_id, chunk_index)`, `source_id NOT NULL`, dropped unused `token_count` column, HNSW index over `(embedding::halfvec(3072)) halfvec_cosine_ops` with `m=16, ef_construction=64`. `match_source_chunks` RPC updated to cast on both sides; verified via `EXPLAIN` that the index is hit.
- Backfill against production: 62 sources processed, 1,360 chunks written, 0 failures, 243 s. Replay run was a clean no-op.
- **Validation gates passed:** silent gaps `0` (was 58), null embeddings `0` (was 20), duplicate groups `0` (was 61), index used by RPC, replay idempotent.
- **Stage 0 doc + CLAUDE.md correction:** embedding model is 3072-dim, not 768. Confirmed in production (`vector_dims = 3072` for all 7,096 pre-Stage-3 chunks).

**Open follow-ups (non-blocking):**
- 54 legacy chunks exceed 4,000 chars (pre-date the new ceiling). Re-chunk on next ingestion of those sources or via a targeted pass.
- Stage 1 adapters could return Markdown-structured output to give the structural-first splitter more to work with. Logged under Stage 1.
- Browser-side `generateEmbeddings` could move to `:batchEmbedContents`. Not currently a bottleneck.

**Decisions:** see D-007, D-008, D-009.

---

### Stage 4 — Prompt composition

**Status:** Done. Owner doc: [STAGE-4-PROMPT.md](STAGE-4-PROMPT.md). Shipped 2026-04-28.

**Shipped:**
- **Single canonical prompt module** at `api/pipeline/extract-prompt.ts` — pure, browser-safe, no env reads, no I/O. Same inputs → identical output.
- **Browser and serverless paths unified.** `src/utils/promptBuilder.ts` re-exports `buildExtractionPrompt` / `composeExtractionPrompt` from the canonical module. `api/pipeline/extract-pipeline.ts` ditto. Both paths now produce the same v2 XML-tagged prompt; the legacy plain-prose builder is gone.
- **Active skills wired into the prompt.** Confirmed `knowledge_skills` (top 12 by confidence + recency) inject into a `<user_expertise>` hints block. Browser fetches via `src/services/promptSkillsContext.ts`; serverless paths fetch in the same `Promise.all` as profile + anchors. Block is omitted entirely when no skills exist.
- **Prompt version stamped on every extraction.** `PROMPT_VERSION = '2.1.0'` (semver). New `extraction_sessions.prompt_version` column populated from `composeExtractionPrompt()`. Historical rows default to `'unknown'`. Migration `20260428_extraction_sessions_prompt_version.sql` applied to prod. Stamped in `api/youtube/extract-knowledge.ts`, `api/github/extract-knowledge.ts`, `api/meetings/process.ts`, and `src/services/extractionPersistence.ts`.
- **Snapshot tests** lock the exact rendered prompt for each of the four modes (`comprehensive`, `strategic`, `actionable`, `relational`). 25 unit tests in `tests/prompts/extract-prompt.test.ts` cover invariants, modes, anchor emphasis, skills injection, profile fields, custom-instruction handling, and version stability.

**Decisions:** see D-S4-01 through D-S4-04 in [STAGE-4-PROMPT.md](STAGE-4-PROMPT.md).

---

### Stage 5 — Entity extraction

**Status:** Done. Owner doc: [STAGE-5-EXTRACTION.md](STAGE-5-EXTRACTION.md). Shipped 2026-04-28 (Block 2).

**Shipped:**
- **Browser-side extraction eliminated.** `src/services/extractionPipeline.ts` deleted. All Gemini extraction now runs in Vercel serverless functions only.
- **Two-phase serverless UX.** `api/ingest/extract-preview` (maxDuration 300) runs Gemini extraction and returns entities + relationships for browser review — no writes to `knowledge_nodes` or `knowledge_edges`. `api/ingest/extract-persist` receives the user-approved entity list and handles all persistence. The review/approve UX is preserved.
- **Headless path.** `api/ingest/extract.ts` is a single-call auto-approve endpoint for background automation (YouTube pipeline, `manualSignals.ts`). Routes through `runExtractionCore()` in `api/pipeline/extract-pipeline.ts`.
- **Map-reduce thresholds locked.** 15,000-char threshold triggers map-reduce. Window: 7,000 chars. Overlap: 1,000 chars. Constants defined in `api/pipeline/extract-pipeline.ts`.
- **Retry logic fixed.** `extract-preview` had `const raw` — the retry result was never assigned. Changed to `let raw`; `raw = retry` on valid retry; source set `degraded` and 422 returned on second failure.
- **`src/services/gemini.ts` stripped.** `extractEntities` and its validation helpers removed. No Gemini extraction calls remain in browser code.
- **`useExtraction.ts` rewritten.** No longer imports Gemini, dedup, or graph-write services. Three steps: `saveSource` → summary (non-blocking) → `POST /api/ingest/extract-preview`. Pauses at `reviewing`. `approveAndSave` calls `POST /api/ingest/extract-persist`.
- **Canonical Stage 0 patterns throughout.** `geminiFetch` with 1s/2s/4s retry on 429/5xx. Structured `log()`/`logError()` with `stage:'extract'`.

**Decisions:** D-B2-01, D-B2-02.

---

### Stage 6 — Deduplication + merge

**Status:** Done. Owner doc: [STAGE-6-DEDUP.md](STAGE-6-DEDUP.md). Shipped 2026-04-28 (Block 2).

**Shipped:**
- **Browser dedup eliminated.** `checkDeduplication()` (which called `find_similar_nodes` RPC from the browser) removed from `src/services/deduplication.ts`. The service retains only UI-facing helpers: `savePotentialDuplicates`, `mergeNodes`, `fetchPendingDuplicates`, `keepSeparate`.
- **Serverless `deduplicateEntities()` is canonical.** Runs inside `api/ingest/extract-persist` and `api/pipeline/extract-pipeline.ts:runExtractionCore()`. Calls the `check_node_duplicate` RPC — three tiers: exact label match → Levenshtein fuzzy → semantic cosine.
- **Named threshold constants.** `DEDUP_EXACT_THRESHOLD = 0.85`, `DEDUP_SEMANTIC_THRESHOLD = 0.80`, `DEDUP_AUTO_MERGE_THRESHOLD = 0.88`. All inline threshold literals in `extract-pipeline.ts` replaced with these constants.
- **Merge enrichment rules documented.** Auto-merge (similarity > 0.88): keep canonical with longer description, append aliases, sum occurrence counts, take max confidence. Near-match queue (0.80–0.88 band): written to `potential_duplicates`, never auto-merged.
- **`find_similar_nodes` RPC retained** for anchor scoring only (`api/anchors/score-post-extraction.ts`). Not called from the dedup path.

**Open follow-ups (non-blocking):**
- `src/services/manualSignals.ts:createManualAnchor` still calls `generateEmbeddings` from `src/services/gemini.ts` for anchor brief chunking. Out of Block 2 scope; tracked for Stage 9.

**Decisions:** D-B2-03.

---

### Stage 7 — Knowledge persistence

**Status:** Done. Owner doc: [STAGE-7-PERSISTENCE.md](STAGE-7-PERSISTENCE.md). Shipped 2026-04-28 (Block 2).

**Shipped:**
- **Edge dedup constraint.** Migration `20260428_edge_dedup_constraint.sql`: deduplicates existing duplicate edge groups (keeps highest weight, earliest id), then creates `knowledge_edges_dedup_uniq` UNIQUE INDEX on `(user_id, source_node_id, target_node_id, relation_type)`.
- **`saveEdges` upsert.** Changed from `.insert()` to `.upsert()` with `onConflict: 'user_id,source_node_id,target_node_id,relation_type', ignoreDuplicates: true`. Duplicate edge writes are silently skipped at the DB level.
- **Edge embeddings inline.** `runExtractionCore()` now embeds edges immediately after `saveEdges`. Fetches saved node labels, builds `source_label → relation_type → target_label` text, calls `batchEmbed`, bulk-updates `knowledge_edges.embedding`. Non-blocking on failure.
- **`label + description` embedding rule confirmed.** Node embeddings use `${label}\n\n${description}` throughout `saveNodes`.
- **`extractionPersistence.ts` stripped.** `saveNodes`, `saveEdges`, `updateNodeEmbeddings`, `updateEdgeEmbeddings`, `SaveNodesResult` removed. Retained: `saveSource`, `saveChunks`, `saveExtractionSession`, `PersistenceError`.
- **Orphaned files deleted.** `src/services/crossConnections.ts` (no callers after `extractionPipeline.ts` deletion). `src/services/edgeEmbedding.ts` (no callers after same deletion).

**Decisions:** D-B2-04.

---

### Stage 8 — Cross-connection discovery

**Status:** Done. Owner doc: [STAGE-8-CROSS-CONNECT.md](STAGE-8-CROSS-CONNECT.md). Shipped 2026-04-28.

**Shipped:**
- **New endpoint `api/cross-connect/run.ts`** — full server-side orchestration: auth-gated POST `{ nodeIds, sourceId? }`. Fetches new nodes + embeddings from `knowledge_nodes`, calls `match_knowledge_nodes` RPC per node (SIMILARITY_THRESHOLD 0.55, CANDIDATES_PER_NODE 30), deduplicates candidates by highest similarity, sends ONE Gemini call for up to GEMINI_BATCH_SIZE (20) top candidates, bulk-inserts confirmed edges. Uses canonical Stage 0 patterns (geminiFetch, log/logError, Supabase factory helpers, all inlined per Vercel bundling rule).
- **Moved out of the browser request path.** `useExtraction.ts` and `extractionPipeline.ts` no longer await `discoverCrossConnections` / `saveCrossConnectionEdges` inline. Both now fire-and-forget to `/api/cross-connect/run` after extraction completes — identical pattern to anchor scoring. The extraction flow completes immediately; cross-connections discover in a background Vercel function.
- **`match_knowledge_nodes` RPC fixed for 3072-dim HNSW.** The existing HNSW index used `vector_cosine_ops` which caps at 2000 dimensions. Migration `20260428_knowledge_nodes_halfvec_index.sql` drops the old index, creates `idx_knowledge_nodes_embedding_hnsw_halfvec` using `(embedding::halfvec(3072)) halfvec_cosine_ops` (m=16, ef_construction=64 — matches Stage 3 D-007), and replaces the RPC to cast both sides to `halfvec(3072)` so queries hit the new index. Parameter type remains `vector(3072)` for backward compatibility.
- **Batching confirmed.** Both `api/cross-connect/run.ts` and `api/pipeline/extract-pipeline.ts:discoverCrossConnections` make exactly ONE Gemini call per extraction covering all candidates — not one call per candidate pair. `api/gemini/cross-connect.ts` (the legacy per-request endpoint) is retained as-is for direct browser callers but is no longer invoked by the orchestration path.
- **Time budget enforced.** `CROSS_CONNECT_TIME_BUDGET_MS = 25_000` in `api/cross-connect/run.ts`. `DEFAULT_TIME_BUDGET_MS = 50_000` in `api/pipeline/extract-pipeline.ts` (covers full pipeline; cross-connections get the remainder). If the budget is consumed during RPC candidate gathering, we stop collection early and run Gemini on whatever candidates were found. If the budget is consumed before the Gemini call, we log and skip.
- **Bulk insert everywhere.** `api/cross-connect/run.ts` and the refactored `discoverCrossConnections` in `api/pipeline/extract-pipeline.ts` both do a single `.insert(array)` call. The previous individual-insert loop in `extract-pipeline.ts` (one INSERT per relationship) is gone.
- **Structured logging.** All code paths use `log()` / `logError()` with `stage: 'cross-connect'`. Fields include `user_id`, `source_id`, `edges_created`, `candidates_evaluated`, `duration_ms`, `prompt_tokens`, `reason` (for skips).
- **Failure policy.** Stage 8 = Skip-with-telemetry per `FAILURE-POLICY.md`. Every catch block calls `logError()` with `status: 'skipped'` and returns 200 / 0 edges. Source status is never set to `failed` or `degraded` by this stage.
- **`src/services/crossConnections.ts` logging migrated.** Browser-side orchestration helpers now use structured `log()` / `logError()` helpers with `stage: 'cross-connect'` instead of unstructured `console.warn` / `console.info`.
- **tsc -b --force passes clean.** Zero new errors introduced.

**Open follow-ups (non-blocking):**
- Cross-connection count in `extraction_sessions` is recorded as 0 for browser and headless pipeline paths (since discovery now runs async). The count could be updated via a Supabase UPDATE when `/api/cross-connect/run` completes, if the UI needs it. Deferred.
- `api/gemini/cross-connect.ts` (the original per-request Gemini proxy) is now only called by `src/services/crossConnections.ts` — itself only called by direct consumer code, not the main extraction flows. Consider deprecating it when `crossConnections.ts` is fully retired.

**Decisions:** see D-S8-01, D-S8-02, D-S8-03 below.

---

### Stage 9 — Anchor scoring

**Status:** Done. Owner doc: [STAGE-9-ANCHOR-SCORING.md](STAGE-9-ANCHOR-SCORING.md). Shipped 2026-04-28.

**Shipped:**
- **Migration `20260428_anchor_scoring_bulk_ops.sql`.** UNIQUE constraint on `anchor_candidates(user_id, node_id)` for ON CONFLICT upsert. Two RPCs: `bulk_upsert_anchor_candidates` (single JSON-array INSERT … ON CONFLICT DO UPDATE with status-protection CASE logic and CTE to propagate `is_anchor=true` on confirmed rows atomically) and `bulk_anchor_dormancy_transitions` (two SQL UPDATEs — confirmed→dormant via NOT EXISTS on edge recency, dormant→confirmed/suggested via EXISTS — returning JSON with transition counts, replacing the N-round-trip edge-recency loop).
- **`api/anchors/score-daily.ts` — full rewrite.** All five signal formulas documented in `SIGNAL_WEIGHTS` comments (see D-S9-02). Lifecycle transition rules documented above `runLifecycleTransitions()` (see D-S9-03). Steps 2+3 of lifecycle now call `bulk_anchor_dormancy_transitions` instead of per-row edge-recency loops. Main handler builds `candidateBatch[]` in memory then calls `bulk_upsert_anchor_candidates` once per user. All `console.log`/`console.error` → `log()`/`logError()` with `stage: 'anchor'`.
- **`api/anchors/rescore-backfill.ts` — full rewrite.** Scoring loop builds `candidateBatch[]`; single `bulk_upsert_anchor_candidates` call per user. All console paths → structured logging.
- **`api/anchors/score-post-extraction.ts` — full rewrite.** Handler comment records async-only decision (D-S9-01). Scoring loop builds `candidateBatch[]`, single bulk RPC call. Seed node inserts build `seedBatch[]` filtered to exclude existing, single `.insert(seedBatch)` (was a per-node loop). All console paths → structured logging.
- **`api/anchors/spawn-sub-anchors.ts` — targeted edits.** Env var check added. All `console.warn`/`console.log`/`console.error` in promotion path and catch → `log()`/`logError()` with `stage: 'anchor'`.
- **`api/anchors/dedup-scan.ts` — targeted edits.** Env var check added. Catch block `console.error` → `logError()`.
- **`api/anchors/on-confirm.ts` — targeted edits.** Supabase env var check added. All console paths → `log()`/`logError()` with `stage: 'anchor'`, `status: 'skipped'` on the no-unconnected-nodes path.
- **`tsc -b --force`:** zero errors across all six anchor files.

**Decisions:** D-S9-01, D-S9-02, D-S9-03, D-S9-04, D-S9-05.

---

### Stage 10 — Skills detection + scoring

**Status:** Done (2026-04-28).

**What shipped:**

`api/skills/process-source.ts` — complete fix of the broken per-source skill creation/reinforcement path:
- Fixed INSERT: removed nonexistent columns `label`, `last_relevance_score`, `first_detected_at`; added required NOT NULL fields `name` (kebab-case), `title`, `description`, `content`; added `source_ids: [sourceId]` on creation.
- Fixed stale source type keys in `SOURCE_TYPE_CONFIDENCE` and `REINFORCEMENT_DELTAS`: capitalized (`YouTube`, `Meeting`, `Document`) → lowercase (`youtube`, `meeting`, `file`, `paste`, `url`, `github`, `research`).
- Fixed existingSkills select: `label` → `name, title, source_ids`.
- Added `source_ids` array sync on reinforcement path (was writing to `skill_sources` join table but never updating the denormalized array read by daily-cron backfill idempotency check).
- Removed `VITE_SUPABASE_URL` and `VITE_GEMINI_API_KEY` fallbacks (Stage S compliance).
- Added `INGEST_SECRET` auth path so pipeline fire-and-forget calls work without a user JWT.
- Fixed `confirmedCount` query: was reading `.data` from a `head:true` query; changed to `.count`.
- Migrated key events to `log()`/`logError()` with `stage: 'skills:process-source'`.

Other files fixed:
- `get.ts`: `label` → `name, title` in select; removed `VITE_SUPABASE_URL` fallback.
- `scan.ts`: removed `VITE_SUPABASE_URL` and `VITE_GEMINI_API_KEY` fallbacks.
- `tag-source.ts`, `tag-sources.ts`: removed `VITE_SUPABASE_URL` fallback.
- `update-from-source.ts`: anchor predicate `entity_type = 'Anchor'` → `is_anchor = true`.

Pipeline wiring — fire-and-forget POST to `/api/skills/process-source` added after anchor scoring in:
- `api/ingest/session.ts`, `api/ingest/retry-source.ts`
- `api/meetings/process.ts`, `api/youtube/extract-knowledge.ts`
- `api/github/extract-knowledge.ts`, `api/microsoft/extract-knowledge.ts`

**Schema reconciliation:** Both `source_ids` UUID[] array and `skill_sources` join table are kept in sync. `skill_sources` is authoritative for contribution metadata. `source_ids` is a denormalized cache used by `daily-cron.ts` phase 1 for backfill idempotency. `process-source.ts` now writes both on create and on reinforcement.

**Signal definitions (S1–S6, weights in `SIGNAL_WEIGHTS`):**
- S1 `anchorAlignment` (0.25): cosine similarity between skill embedding and anchor embeddings. Added to `related_anchor_ids` if similarity > 0.3.
- S2 `nodeDensity` (0.20): fraction of user's node count matching skill keywords or same source.
- S3 `sourceHistory` (0.20): distinct sources whose nodes match the skill, normalized to 3.
- S4 `graphProximity` (0.15): BFS hops from primary cluster node to nearest anchor (0–1 hops = 1.0, 2 = 0.6, 3 = 0.3, unreachable = 0).
- S5 `profileContext` (0.10): domain match vs. user professional context (match = 1.4×, adjacent = 1.1×, mismatch = 0.8×).
- S6 `velocity` (0.10): matching sources ingested in last 14 days (0 = 0, 1 = 0.5, 2+ = 1.0).

**Resumable backfill:** `api/skills/backfill.ts` was already correct — uses `metadata.skill_backfill_status` for idempotency and page-based pagination. No changes required.

**`tsc -b --force`:** zero errors.

---

### Stage 11 — Council updates

**Status:** Partial. Phase 0 shipped 2026-04-24 across many commits.

**Shipped:**
- Phase 0 tension-on-contradiction detection (`52c73b6`).
- Phase 0 answer-check and novel-connection writer (`c9b6f85`).
- Standing questions embedded at generation time in Phase 3 (`857431f`).
- Backfill handler for `agent_standing_questions` embeddings (`9c68cd0`).
- Phase 0 RPCs for pull candidates and bulk addressing (`77ae76c`).
- `council_cron_runs` telemetry table (`6bd7109`).
- Auto-create domain expert when YouTube playlist added (`59ce1c6`).
- Scoped single-agent rebuild endpoint (`5a4f9c1`).
- `agent_signals` system retired (`bf58a57`). **This was the schema drift flagged in the audit. Confirmed intentional.**

**Open:** wire agent updates into extraction flow (currently only triggered by cron and manual rebuild), expertise index recomputation rules, standing question decay rules.

---

### Stage 12 — Extraction session audit

**Status:** Not started.

**Open:** rows written even on failure, capture real anchor IDs (not empty strings), stamp prompt + model + embedding versions, capture token counts and cost estimate, retention policy.

---

### Stage 13 — Surfacing (RAG, MCP, activity)

**Status:** Not started under hardening scope. Many features exist; none have been audited against the Stage 13 contract.

**Open:** activity feed RPC determinism, RAG router classification rules, RAG retrieval order (chunks first, nodes second, fallback rules), MCP tool contracts and empty-state behaviour, citation completeness.

---

### Stage S — Secret hygiene + client-server boundary

**Status:** Scoped. Urgent. Incident-driven (2026-04-28).

**Owner doc:** _to be created at `docs/STAGE-S-SECRET-HYGIENE.md` after execution._

**Why this stage exists.** On 2026-04-28 the Google Cloud project that held the Synapse Gemini API key (`gen-lang-client-0813591585`, "Reg Tracker") was suspended by Google's Trust & Safety team for "abusive activity consistent with hijacked resources." A third party scraped the `VITE_GEMINI_API_KEY` value from the production browser bundle at `connectsynapse.com` and used it to spin up unauthorised resources. The user was charged approximately £100 before the suspension cut it off. All seven Vercel-stored secrets (`SUPABASE_SERVICE_ROLE_KEY`, `GEMINI_API_KEY`, `RESEND_API_KEY`, `INGEST_SECRET`, `CRON_SECRET`, `YOUTUBE_API_KEY`, `APIFY_API_KEY`) were rotated as a precaution — the actual confirmed leak was the Gemini key only, but Vercel's secret-scanner had flagged all seven as "Needs Attention" and treating them as a unit was the safer call.

**Root-cause summary (four layers).** Documented in full in the 2026-04-28 changelog entry. Briefly:

1. **Proximate.** `VITE_GEMINI_API_KEY` was inlined into the production JS bundle by Vite, scraped by a bot.
2. **Architectural.** Synapse v2 was originally a pure-frontend SPA; Gemini was called from `src/services/gemini.ts` by design. When `api/` serverless functions were added in mid-April 2026 (commits between `df3cdbc` on 15 April and `47a7314` on 27 April), the new code correctly used un-prefixed `GEMINI_API_KEY`, but the original `src/` code path was never migrated. Seven `src/` files still call Gemini directly from the browser: [src/services/gemini.ts](../src/services/gemini.ts), [src/services/crossConnections.ts](../src/services/crossConnections.ts), [src/services/queryClassifier.ts](../src/services/queryClassifier.ts), [src/services/reranker.ts](../src/services/reranker.ts), [src/services/simulate.ts](../src/services/simulate.ts), [src/utils/summarize.ts](../src/utils/summarize.ts), [src/components/modals/SettingsModal.tsx](../src/components/modals/SettingsModal.tsx). Each new browser-side feature copied the legacy pattern instead of routing through `api/`.
3. **Documentation.** `CLAUDE.md` listed `VITE_GEMINI_API_KEY` as a required env var and described `VITE_` as a generic "client-side access" prefix without distinguishing browser-safe credentials (Supabase publishable) from browser-unsafe credentials (third-party API keys). Every agent reading the doc thus reinforced the unsafe pattern instead of catching it.
4. **Process.** Zero defensive layers between dev and prod. No HTTP referrer restriction on the leaked key. No GCP budget alert. No CI check banning `VITE_*_API_KEY` for vendor services. No quarterly rotation cadence. No public-source secret scanning of deploys. Each of these alone would have caught it; none were in place.

**Shipped (2026-04-28 — incident response):**

- All seven Vercel secrets rotated. New values in Vercel dashboard and local `.env.local`.
- New Supabase publishable + secret keys generated; legacy JWT-based keys retained for now (will be disabled after Stage S Phase 2 when no callers depend on them).
- Compromised Gemini key deleted in AI Studio; new Gemini key created in a fresh GCP project (`synapse-prod`, project ID `gen-lang-client-0777924324`).
- New Gemini key restricted: HTTP referrers limited to `https://connectsynapse.com/*`, `https://*.connectsynapse.com/*`, `http://localhost:5173/*`, `http://localhost:5174/*`. API restriction: Generative Language API only.
- Monthly budget alert created on `synapse-prod`: £20 cap on Gemini API service, alerts at 50% / 90% / 100%, email to billing admins and project owners.
- `VITE_GEMINI_API_KEY` removed from Vercel and `.env.local` entirely. Browser-side Gemini features (Ask chat, RAG, source summaries, cross-connections, query classifier, reranker, persona simulation) are temporarily broken pending Phase 2 of this stage.
- Production redeploy verified: login works, Home loads with full data (19,745 nodes / 24,386 edges), Supabase rotation confirmed end-to-end.
- Billing dispute filed with Google Cloud support requesting refund of the £100 unauthorised charges (case open at time of writing).
- Project suspension appeal submitted on `gen-lang-client-0813591585` (no intent to use the project; submitted to keep the record consistent with the dispute).

**Open (Phase 1 — defensive hardening, low effort):**

- **Restrict the YouTube API key** the same way the new Gemini key was restricted: HTTP referrers + restrict to YouTube Data API v3 only.
- **Set a budget alert on whichever GCP project holds the YouTube key.** £10/month cap is sensible; YouTube Data API v3 is mostly free quota and any non-trivial spend is anomalous.
- **Set spend alerts in Resend, Apify, and any other paid third-party** that does not currently have one.
- **Re-confirm Vercel "Needs Attention" state** on every env var post-rotation; expectation is all flags clear within a few hours of the rotation.

**Open (Phase 2 — architectural refactor, real effort):**

> Phase 2 plan: see [docs/PRDs/030-stage-s-phase-2.md](PRDs/030-stage-s-phase-2.md). Granular endpoint split (one per task) approved 2026-04-28; `extractEntities` is included in the migration scope, not left in the browser.
>
> **Migration progress:**
> - [x] Step 1 — `src/utils/summarize.ts` → `api/gemini/summarize.ts` (2026-04-28). Auth-gated, tsc clean. `apiClient.ts` helper landed.
> - [x] Step 2 — `src/services/queryClassifier.ts` → `api/gemini/classify-query.ts` (2026-04-28). Auth-gated, tsc clean.
> - [x] Step 3 — `src/services/reranker.ts` → `api/gemini/rerank.ts` (2026-04-28). Auth-gated, tsc clean.
> - [x] Step 4 — `src/services/crossConnections.ts` → `api/gemini/cross-connect.ts` (2026-04-28). Auth-gated, tsc clean.
> - [x] Step 5 — `src/services/simulate.ts` → `api/gemini/simulate.ts` (2026-04-28). Auth-gated, tsc clean. Endpoint accepts discriminated `kind: 'evidence' | 'synthesis'` payloads — prompts built server-side.
> - [x] Step 6 — `src/services/gemini.ts` → 5 new endpoints (`embed`, `extract`, `generate-text`, `decompose-query`, `rag`) (2026-04-28). Auth-gated, tsc clean. Public API of `gemini.ts` preserved so all callers (rag, ragRouter, extractionPipeline, edgeEmbedding, useExtraction, digestEngine, manualSignals) keep working with no changes. RAG system-prompt construction moved server-side.
> - [x] Steps 7+8 — `src/services/youtube.ts` and `src/services/automationSources.ts` → `api/youtube/lookup.ts` (2026-04-28). One endpoint with discriminated `kind: 'playlist-metadata' | 'playlist-videos' | 'video-title'`. Auth-gated, tsc clean. `VITE_YOUTUBE_API_KEY` no longer read anywhere in `src/`. Tier-1 client-side branch in `automationSources.ts` removed; old Tier-2 server endpoint becomes the new Tier-1.
> - [x] Step 9 — `src/components/modals/SettingsModal.tsx` (2026-04-28). Removed the `VITE_GEMINI_API_KEY` read used to display a key fingerprint; replaced with a static "Server-managed" pill.
>
> **Phase 2 validation gates closed (2026-04-28):**
> - **Gate 1** — `grep -rn "import.meta.env.VITE_*_API_KEY"` in `src/` returns zero matches. ✅
> - **Gate 2** — `grep -rn "import.meta.env.VITE_"` in `src/` returns only Supabase URL+anon, `VITE_SIMULATE_SIDECAR_URL` (URL), and `VITE_GEMINI_MODEL` (model name). All allowed by §297. ✅
> - **Gate 5** — every browser-side feature that previously called Gemini directly now does so via an auth-gated endpoint. ✅
>
> **Next actions for Joseph:** delete `VITE_GEMINI_API_KEY` and `VITE_YOUTUBE_API_KEY` from Vercel and `.env.local` (no caller depends on them now). Gates 3 (bundle scan), 4 (alerts/restrictions on YouTube/Resend/Apify), and 6 (CI check) remain open and belong to Phase 1 / Phase 3.

- **Move all Gemini calls server-side.** New endpoints under `api/gemini/` (suggested split: `chat`, `embed`, `classify-query`, `rerank`, `summarize`, `cross-connect`, `simulate-persona`). Each endpoint reads `GEMINI_API_KEY` server-side, validates the calling user's auth token, calls Gemini, returns the result. Update each of the seven `src/` files listed above to invoke the matching endpoint via `fetch('/api/gemini/...')` instead of `import.meta.env.VITE_GEMINI_API_KEY`. Restores Ask, RAG, summaries, cross-connections, query classifier, reranker, and persona simulation. Constraint: every endpoint must enforce per-user auth + RLS-equivalent access checks before calling Gemini, otherwise the endpoint itself becomes a quota-drain vector.
- **Move all YouTube API calls server-side.** Two files: [src/services/youtube.ts](../src/services/youtube.ts) and [src/services/automationSources.ts](../src/services/automationSources.ts). New endpoint `api/youtube/lookup` (or similar) reads `YOUTUBE_API_KEY` server-side. Browser fetches metadata via the endpoint. Delete `VITE_YOUTUBE_API_KEY` from Vercel and `.env.local` once the refactor lands.
- **Audit `import.meta.env.VITE_*` usage.** Confirm no other vendor credentials are being read in the browser. As of 2026-04-28 the only `VITE_*` reads beyond Supabase and Gemini and YouTube are `VITE_SIMULATE_SIDECAR_URL` (a URL, not a credential) and `VITE_GEMINI_MODEL` (model name, not a credential). Both safe.

**Open (Phase 3 — process / defence in depth):**

- **CI check.** Add a build-time scan that fails the build if any env var name accessed via `import.meta.env.VITE_*` matches a vendor-credential pattern (`*_API_KEY`, `*_SECRET`, `*_TOKEN`, `*_PRIVATE_*`). Allowlist exceptions explicitly (currently: `VITE_SUPABASE_ANON_KEY` only).
- **Bundle scan.** Add a post-build CI step that scans `dist/` for substrings matching credential patterns (`AIza...`, `re_...`, `apify_api_...`, `eyJ...` JWTs that aren't the Supabase publishable). Fail the build on match. This catches accidental hard-coded secrets that slip past env var review.
- **Public secret-scanning enrolment.** Vercel already runs a scanner (the source of the "Needs Attention" badges). Confirm GitHub's secret-scanning is enabled on the `synapse_version3` repo and is alerting to the right channel. Optional: add TruffleHog or GitGuardian as a pre-commit hook for an additional layer.
- **Quarterly rotation cadence.** Calendar reminder, owner Joseph, every 90 days. Rotate all third-party keys (`GEMINI_API_KEY`, `YOUTUBE_API_KEY`, `RESEND_API_KEY`, `APIFY_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `INGEST_SECRET`, `CRON_SECRET`). Set a 14-day grace period where both old and new are accepted (where the provider supports it) to allow for staged rollover without downtime.
- **Disable Supabase legacy JWT-based API keys.** Once Phase 2 is shipped and no caller depends on the legacy `anon` / `service_role` JWTs, click "Disable JWT-based API keys" on the Supabase API page. This permanently revokes the leaked legacy keys and prevents fallback to them.
- **Documentation gate.** `CLAUDE.md` updated 2026-04-28 with a new "Secret Hygiene" section listing what may and may not appear in `VITE_*`. New rule: any new third-party integration PR that adds a `VITE_*_API_KEY`-style env var must be rejected at review.

**Validation gates (Stage S Done means all of these pass):**

1. No `import.meta.env.VITE_*_API_KEY` or `import.meta.env.VITE_*_SECRET` or `import.meta.env.VITE_*_TOKEN` reference exists in any file under `src/` (excluding the documented allowlist).
2. `grep -rn "import.meta.env.VITE_" src/ --include="*.ts" --include="*.tsx"` returns only Supabase keys, model name constants, and non-credential URLs.
3. The production Vite bundle, when grep'd for known credential prefixes (`AIza`, `re_`, `apify_api`), returns zero matches.
4. Every external API key in Vercel has a matching budget alert and (where supported) a referrer / IP / API restriction in the provider console.
5. Every browser-side feature that previously called Gemini directly works via its new `api/` endpoint, with auth gating verified.
6. CI check (Phase 3) blocks any future PR that re-introduces a `VITE_*_API_KEY`-style pattern.

**Decisions:** see D-010.

**Cross-stage impact.** This stage touches Stages 5 (entity extraction — server-side already, unaffected), 8 (cross-connection — currently browser-side, must move), and 13 (surfacing / RAG — currently browser-side, must move). Update each affected stage's open list when Phase 2 lands.

---

## Decision Log

Format: ID, date, decision, rationale, status (`Active` | `Superseded`).

### D-001 — Chrome extension removal
**Date:** 2026-04-26
**Decision:** Remove the Chrome extension feature entirely from the codebase as part of Stage 1 pre-task. Update all docs to reflect five ingestion sources, not six. Flag DB artefacts but do not drop schema without explicit approval. May be reintroduced as a separate workstream later.
**Rationale:** Reduces surface area for Stage 1 hardening. Feature was built earlier and is not part of the current ingestion strategy. Keeping the codebase clean.
**Status:** Active.

### D-002 — Use Gemini File API for file uploads
**Date:** 2026-04-26
**Decision:** In the file upload adapter (Stage 1), replace any existing PDF parser, audio transcriber, and video handler with a single Gemini File API call.
**Rationale:** Collapses three parsing stacks (PDF parsing, audio transcription, video understanding) into one Gemini call. Uses existing Gemini wrapper. Zero new infrastructure. Researched alternatives (RAGAnything, Vertex AI RAG Engine) and rejected both as wrong-shape for Synapse architecture.
**Status:** Active.

### D-003 — Reject Vertex AI RAG Engine and RAGAnything
**Date:** 2026-04-26
**Decision:** Do not adopt Vertex AI RAG Engine or RAGAnything. Hold Document AI Layout Parser in reserve for complex-PDF edge cases only.
**Rationale:** Both want to own storage and retrieval. Synapse's Supabase + pgvector + custom entity ontology is fundamentally a "build your own pipeline" architecture. Adopting either means fighting them.
**Status:** Active.

### D-004 — YouTube three-tier strategy (Apify stays as default)
**Date:** 2026-04-26
**Decision:** YouTube adapter keeps Apify as the default transcript path. YouTube Data API v3 as second-tier fallback. Gemini video understanding as third-tier escape hatch only.
**Rationale:** Apify is fast and cheap for transcript-only extraction. Gemini video is slower and meaningfully more expensive per video. The visual context bonus is nice but not essential for current use cases. Apify can always be replaced later if reliability degrades.
**Status:** Active.

### D-005 — `agent_signals` retirement is intentional
**Date:** 2026-04-26
**Decision:** Confirmed. The `agent_signals` table drop (commit `bf58a57`, migration `20260426_drop_agent_signals.sql`) is intentional. Audit-flagged as drift; resolved as not-drift.
**Rationale:** Council architecture moved to a new model. The earlier spec referencing `agent_signals` is outdated.
**Status:** Active. Spec docs need updating (open).

### D-007 — pgvector HNSW via halfvec for 3072-dim embeddings
**Date:** 2026-04-27
**Decision:** Index `source_chunks.embedding` with HNSW over the expression `(embedding::halfvec(3072)) halfvec_cosine_ops`, `m=16, ef_construction=64`. The `match_source_chunks` RPC casts both stored vectors and query vector to `halfvec(3072)` so queries hit the index.
**Rationale:** Production embeddings are 3072-dim. pgvector's standard `vector_cosine_ops` HNSW caps at 2000 dims; `halfvec_cosine_ops` supports up to 4000. Half-precision halves storage with negligible recall impact for ANN.
**Status:** Active.

### D-008 — Embed `title + chunk` rather than chunk alone
**Date:** 2026-04-27
**Decision:** Stage 3 embeds `${source.title}\n\n${chunk_content}` for every chunk. Stored chunk content does NOT include the title (so retrieval results display cleanly).
**Rationale:** Cheap topical context. Materially helps retrieval for short or vague chunks that lack their own keywords.
**Status:** Active.

### D-009 — Stage 3 failure modes: chunking fatal, embedding degraded
**Date:** 2026-04-27
**Decision:** Chunking failure marks the source `failed`. Embedding failure (or any chunk missing an embedding) marks the source `degraded` and refuses to insert any chunks. No partial saves with null embeddings.
**Rationale:** Silent partial saves were the cause of the 58 missing-chunk sources and 20 null-embedding rows found in the Stage 3 audit. Surfacing failure in source state makes them retryable.
**Status:** Active.

### D-010 — Vendor credentials are server-side only; `VITE_*` is publishing
**Date:** 2026-04-28
**Decision:** Going forward, no third-party vendor credential (Gemini, YouTube, OpenAI, Anthropic, Apify, Resend, or any future provider) may be read via `import.meta.env.VITE_*` in browser code. Vendor credentials live exclusively in `process.env.<NAME>` and are read only by `api/` serverless functions. The browser invokes vendor capabilities via internal `/api/...` endpoints. The only `VITE_*` credentials permitted are the Supabase publishable key (`VITE_SUPABASE_ANON_KEY`) and the public project URL (`VITE_SUPABASE_URL`). All other `VITE_*` values must be non-credential config (URLs, model names, version strings).
**Rationale:** Vite inlines every `VITE_*` value into the production JavaScript bundle in plain text. This is the documented Vite behaviour and is correct for genuinely public values like the Supabase publishable key, which is designed to be safe in the browser when RLS is enforced. It is catastrophic for vendor credentials, which carry billing capability and have no equivalent of RLS. The 2026-04-28 incident (Gemini key scraped from production bundle, project suspended, ~£100 in unauthorised charges) is the proof. The cost of restating this rule explicitly is zero; the cost of a repeat is another suspension.
**Status:** Active.

### D-011 — Stage 2 meeting re-ingest rule: payload signature comparison (A2)
**Date:** 2026-04-28
**Decision:** When the meeting webhook receives a payload for an existing `circleback_meeting_id`, compare a content-stable signature stored at `metadata.payload_signature` (SHA-256 of `transcript_segment_count + action_item_count + content.length + content[0..4096]`). Equal → skip silently. Different → replace `content` / `metadata` / `title` and reset `status='pending'` so downstream stages re-run.
**Rationale:** Circleback payloads do not carry a `lastModified` timestamp. Wall-clock receipt time would treat every webhook redelivery as "newer" and lose the protection. Content-driven signature is the cheapest correct option, survives webhook redelivery, and triggers replays only when the transcript or action items have actually changed.
**Status:** Active.

### D-012 — Stage 2: Research and GitHub source types kept, renamed lowercase
**Date:** 2026-04-28
**Decision:** `'Research'` and `'GitHub'` rows are not deleted. They are renamed to `'research'` and `'github'` and their writers (`api/microsoft/extract-knowledge.ts`, `api/ingest/session.ts`) are routed through inlined `persistSource` variants with content_hash dedup. Both stay as DB-only types — neither has a Stage 1 capture adapter yet.
**Rationale:** These two paths are real production write paths. Removing them would break the Microsoft and MCP-session ingestion flows. Keeping them mixed-case while everything else lowercased would leave a lingering inconsistency and another future migration. The right move is to bring them into the new convention now.
**Status:** Active.

### D-013 — Stage 2: YouTube cron stays as a separate `persistSource` write path
**Date:** 2026-04-28
**Decision:** The YouTube cron extractor (`api/youtube/extract-knowledge.ts`) and the interactive YouTube capture endpoint (`api/capture/youtube.ts`) remain as two distinct write paths into `knowledge_sources`, both routed through the inlined `persistYouTubeSource` variant. The partial unique index on `(user_id, source_type, source_url) WHERE source_url IS NOT NULL` continues to merge them when both fire for the same video.
**Rationale:** Unifying the cron extractor as a downstream consumer of rows already created by the capture endpoint is a cleaner architecture but a bigger refactor than Stage 2 owns. Stage 2 closes the dedup gap and standardises persistence; the unification is a future stage's concern.
**Status:** Active.

### D-S8-01 — Cross-connection runs as fire-and-forget post-extraction job, not inline
**Date:** 2026-04-28
**Decision:** Cross-connection discovery is removed from the synchronous extraction path in both `useExtraction.ts` and `extractionPipeline.ts`. Both now fire-and-forget to `/api/cross-connect/run` after extraction completes — the same pattern used by anchor scoring. The `api/pipeline/extract-pipeline.ts` inline path (used by serverless pipelines: YouTube, meetings, GitHub, ingest) retains its time-budget-gated inline call because those pipelines are already fully async and the inline approach avoids a second network round-trip inside Vercel.
**Rationale:** Cross-connections are enrichment (Failure-POLICY.md: Skip-with-telemetry). They must not block the user-visible extraction completion UX. On a large graph, the RPC + Gemini call can take 5–15 s. Making users wait for it after an already 30–60 s extraction is a poor experience. Running it in a background Vercel function is the correct architectural placement.
**Effect:** `crossConnectionCount` in the extraction session row is recorded as 0 for browser and headless pipeline paths. This is an acceptable gap; the session row is primarily used for debugging and the count is not user-facing.
**Status:** Active.

### D-S8-02 — match_knowledge_nodes must cast to halfvec(3072) to use HNSW index
**Date:** 2026-04-28
**Decision:** The `match_knowledge_nodes` RPC is rewritten (migration `20260428_knowledge_nodes_halfvec_index.sql`) to cast `kn.embedding` and `query_embedding` to `halfvec(3072)` on both sides of the `<=>` operator. The HNSW index is also recreated using `halfvec_cosine_ops` (replacing `vector_cosine_ops`).
**Rationale:** pgvector's standard `vector_cosine_ops` HNSW implementation caps at 2000 dimensions. Our embeddings are 3072-dim (`gemini-embedding-001`). The prior index was therefore unusable and every `match_knowledge_nodes` call silently fell back to a sequential scan over all ~19,000+ nodes. This same fix was applied to `source_chunks` in Stage 3 (migration `stage3_chunks_constraints_and_index`, decision D-007) — `knowledge_nodes` was missed at that time.
**Status:** Active.

### D-S8-03 — Time budget for cross-connection discovery: 25 s (standalone) / remainder of 50 s (pipeline)
**Date:** 2026-04-28
**Decision:** `api/cross-connect/run.ts` uses `CROSS_CONNECT_TIME_BUDGET_MS = 25_000`. If RPC candidate gathering consumes the full 25 s, we stop collection early and run Gemini on whatever we have. `api/pipeline/extract-pipeline.ts:discoverCrossConnections` uses `DEFAULT_TIME_BUDGET_MS = 50_000` (the full pipeline budget), checked from `itemStartTime`. The cross-connection step gets whatever time remains after earlier pipeline stages. Gemini call itself gets a separate 30 s timeout.
**Rationale:** 25 s for the standalone endpoint: leaves ample margin inside Vercel Pro's 300 s timeout even when called right after a 120 s extraction. 50 s for the inline pipeline: existing `DEFAULT_TIME_BUDGET_MS` that already governs the pipeline was the right cap rather than adding a new constant. If a pipeline consumes all 50 s before reaching cross-connections, the time-budget gate skips it with a log line.
**Status:** Active.

### D-S9-01 — Anchor scoring is async-only; never runs synchronously in the extraction request path
**Date:** 2026-04-28
**Decision:** `api/anchors/score-post-extraction.ts` is called exclusively as fire-and-forget from extraction callers (`api/ingest/session.ts`, `api/meetings/process.ts`, `api/youtube/extract-knowledge.ts`, etc.) and from the daily cron via `score-daily.ts`. It is never awaited inline. The handler comment in `score-post-extraction.ts` records this decision explicitly: "called asynchronously (fire-and-forget from extraction callers)".
**Rationale:** Anchor scoring is enrichment. Failure policy: Skip-with-telemetry. Scoring on a large graph (500+ candidates, full edge traversal, lifecycle transitions) can take 10–30 s. Making the extraction request wait for it would wreck UX and risk extraction timeouts. Running it as a background Vercel invocation is the correct placement — same pattern as cross-connection discovery (D-S8-01).
**Status:** Active.

### D-S9-02 — Five signal formulas and weights
**Date:** 2026-04-28
**Decision:** Composite anchor score = weighted sum of five signals. Weights and formulas documented in `SIGNAL_WEIGHTS` constant in `api/anchors/score-daily.ts`:
- **Momentum/velocity** (0.30): sum of decay-weighted occurrence counts over 7 days. Each occurrence i contributes `occurrences[i] * exp(-daysDiff * ln2 / 7)`. Captures recent activity exponentially discounted.
- **Centrality** (0.25): direct edge count normalised by user's max node degree (capped at 50). High-connectivity nodes score higher.
- **Diversity** (0.20): distinct entity types in the candidate's neighbourhood, normalised to 6. Rewards nodes that bridge across domains.
- **Richness** (0.15): `(has_description ? 0.5 : 0) + clamp(description.length / 500, 0, 0.5)`. Rewards descriptively rich nodes.
- **Behavioural** (0.10): reserved for future explicit user signals (manual promotes, dismissals, RAG query hits). Currently contributes 0.
**Rationale:** Momentum as highest weight because recency-weighted activity is the strongest signal a topic is salient to the user right now. Centrality second because genuinely structural concepts accumulate more connections organically. Diversity rewards cross-domain concepts. Richness is a tiebreaker. Behavioural is reserved at low weight so that when user signals are wired, they can influence scoring without over-weighting early data.
**Status:** Active.

### D-S9-03 — Lifecycle transition rules
**Date:** 2026-04-28
**Decision:** `runLifecycleTransitions()` in `score-daily.ts` applies six rules in order: (1) suggested cleanup — remove suggested candidates whose node no longer exists; (2) confirmed→dormant — confirmed anchors with no edge activity in 90 days set to dormant via `bulk_anchor_dormancy_transitions`; (3) dormant→reactivated — dormant anchors with new edge activity in 14 days promoted back to confirmed via same RPC; (4) dismissed→resurfaced — dismissed candidates with composite score > 0.70 reset to suggested; (5) heal — knowledge_node `is_anchor=false` on a confirmed anchor corrected back to true; (6) auto-archive — dismissed candidates older than 180 days whose node no longer exists set to archived.
**Rationale:** Rules 2+3 (dormancy cycle) are the highest-value: they let the graph reflect that topics fade and revive rather than holding every confirmed anchor permanently. Bulk RPCs for rules 2+3 replace the previous N-round-trip per-row loop that timed out on large graphs.
**Status:** Active.

### D-S9-04 — Bulk write via two RPCs; no per-row UPDATE loops in any anchor file
**Date:** 2026-04-28
**Decision:** All candidate writes in `score-daily.ts`, `rescore-backfill.ts`, and `score-post-extraction.ts` build an in-memory array and call `bulk_upsert_anchor_candidates` once per user. All dormancy transitions in `score-daily.ts` call `bulk_anchor_dormancy_transitions` once. No file in `api/anchors/` contains a loop issuing individual INSERT or UPDATE calls to `anchor_candidates`.
**Rationale:** Vercel functions have a 60 s execution limit. At 500+ candidates per user, individual-row DB calls scale linearly and exhaust the time budget before completion. A single RPC accepting a JSONB array handles 500+ rows in under a second. This is the same pattern applied across all other pipeline stages per the project-wide bulk-write rule.
**Status:** Active.

### D-S9-05 — UNIQUE constraint on anchor_candidates(user_id, node_id) is required for upsert correctness
**Date:** 2026-04-28
**Decision:** Migration `20260428_anchor_scoring_bulk_ops.sql` adds `UNIQUE (user_id, node_id)` to `anchor_candidates` (via `CREATE UNIQUE INDEX IF NOT EXISTS` to be idempotent). The `bulk_upsert_anchor_candidates` RPC uses `ON CONFLICT (user_id, node_id) DO UPDATE`, which requires this constraint.
**Rationale:** Without the constraint, ON CONFLICT has no target and the RPC fails at runtime. The constraint was absent from the original schema — the table was designed for INSERT-only. Adding it is safe: any pre-existing duplicate pairs are resolved by the upsert semantics (keep latest score).
**Status:** Active.

### D-014 — Stage 0 Item 2B Gemini retry + token telemetry shipped via four-step rollout
**Date:** 2026-04-28
**Decision:** Apply the canonical `geminiFetch` / `embedText` / `embedTexts` recipe from `STAGE-0-FOUNDATIONS.md` Item 2 across all 41 backend files in `api/` that call Gemini, using the four-step pattern documented in the original deferral plan (1 pilot → 2 more → bulk → watch).
**Rationale:** Items 4–7 are complete; the recipe was stable; Vercel-bundles-each-file-independently means there is no shared module to point at, so each file gets its own paste of the recipe. Existing per-file helpers (`callGemini`, `geminiJson`, `generateEmbedding`, etc.) were preserved as thin wrappers that delegate to `geminiFetch`, so no call site needed to change.
**Effect:**
- Pilot: `api/summaries/backfill.ts`. Two more: `api/council/route.ts`, `api/youtube/extract-knowledge.ts`. Bulk: 38 remaining files in one commit.
- Every Gemini chat response now retries on 429/5xx with 1s/2s/4s backoff (max 3 attempts) and emits one structured JSON token-usage log line.
- Embedding helpers share the same retry path; embedding endpoints have no `usageMetadata`, so embedding telemetry is call count + latency only (documented upstream limitation).
- The `GEMINI_EMBEDDING_MODEL` constant is normalised across files that previously named it differently (`EMBED_MODEL` etc.).
- TypeScript compiles clean. Zero new errors introduced; 14 pre-existing tsc errors fixed as a side effect of stricter response-type casting in the new helpers.
**Status:** Shipped.

---

### D-B2-01 — Two-phase serverless extraction preserves review UX
**Date:** 2026-04-28
**Decision:** Extraction is split across two endpoints. `api/ingest/extract-preview` runs Gemini and returns entities/relationships to the browser for user review. `api/ingest/extract-persist` accepts the reviewed entity list and performs all DB writes. No intermediate browser logic exists between these two calls.
**Rationale:** The review/approve step is core product UX — users must be able to remove or edit extracted entities before they land in the graph. Eliminating browser-side extraction does not mean eliminating the pause; it means moving the AI work to the server while keeping the review pause client-side. The two-endpoint split is the minimal architecture that achieves both goals.
**Status:** Active.

---

### D-B2-02 — extract-preview sets source status to `extracting`; does not write nodes or edges
**Date:** 2026-04-28
**Decision:** `api/ingest/extract-preview` updates `knowledge_sources.status = 'extracting'` at entry and returns extracted entities without writing to `knowledge_nodes` or `knowledge_edges`. Persistence happens only in `extract-persist` after user approval.
**Rationale:** The source must reflect that extraction is in progress so the pipeline health view is accurate. But writing nodes before the user approves them would pollute the graph with unreviewed entities. The status write is safe at preview time; node/edge writes are not.
**Status:** Active.

---

### D-B2-03 — `check_node_duplicate` RPC is canonical dedup; `find_similar_nodes` is retained for anchor scoring only
**Date:** 2026-04-28
**Decision:** All entity deduplication during extraction uses the `check_node_duplicate` RPC (three tiers: exact label → Levenshtein fuzzy → semantic cosine). The `find_similar_nodes` RPC remains in production but is only called by `api/anchors/score-post-extraction.ts`. The browser-side `checkDeduplication()` function that previously called `find_similar_nodes` is deleted.
**Rationale:** `check_node_duplicate` is more precise than `find_similar_nodes`: it applies all three match tiers in one RPC call and returns match type and similarity, enabling the auto-merge vs. near-match-queue decision. `find_similar_nodes` returns only cosine-similar nodes and is the right shape for anchor scoring's "find related nodes" query, but the wrong shape for entity dedup during ingestion.
**Status:** Active.

---

### D-B2-04 — Edge dedup via unique index + upsert; embeddings inline and non-blocking
**Date:** 2026-04-28
**Decision:** Duplicate edges are prevented at two layers: a `UNIQUE INDEX` on `(user_id, source_node_id, target_node_id, relation_type)` in the database, and a `.upsert()` with `ignoreDuplicates: true` in `saveEdges`. Edge embeddings are computed immediately after `saveEdges` inside `runExtractionCore()` and are non-blocking (failure logs and continues; source status is not affected).
**Rationale:** The unique index ensures correctness regardless of the caller path. The upsert makes duplicate writes cheap (DB skips, no error). Embedding edges inline keeps the data model complete at write time rather than requiring a separate backfill pass. Non-blocking failure policy matches the Stage 0 pattern for enrichment steps: enrichment never fails the pipeline.
**Status:** Active.

---

### D-006 — Stage 1 ↔ Stage 2 boundary kept as scoped; cross-cutting work moved
**Date:** 2026-04-26
**Decision:** Stage 1 produces `CapturedSource`. The full "adapters never write to the DB directly" cutover lands in Stage 2 because Stage 2 owns persistence. The lowercase `source_type` rename across the database-facing code also lands in Stage 2. Stage 0 Item 2 (canonical Gemini wrapper) must complete before Adapter 3 (file upload). Stage 0 logging helper must complete before Stage 1 final sign-off; until then, Stage 1 adapters log via a structured `console.info` placeholder.
**Rationale:** The deferred items are not new scope — they are correctly placed at the layer that owns them. Forcing them into Stage 1 would make a paste fix become a system-wide refactor with no behaviour benefit. Splitting at these natural seams keeps each stage testable on its own and minimises the blast radius of each change.
**Effect:**
- Stage 1 still produces five adapters with shared shape, title rules, size limits, MIME validation, and contract tests.
- Stage 2 absorbs: (a) replacing inline save with `persistSource()`, (b) translating lowercase `CapturedSource.source_type` to current DB strings then retiring the old strings.
- Stage 0 sequencing: Item 2 must finish before Adapter 3. Logging helper must finish before Stage 1 closes.
- No movement to a Stage 3+ or post-Stage-13 workstream is required.
**Status:** Active.

---

## Deferred / Pushed Back

Items explicitly de-prioritised. Each entry: name, date deferred, reason, conditions for revisit.

- **Chrome extension** — deferred 2026-04-26. Reason: not part of current ingestion strategy; reduces Stage 1 scope. Revisit when other stages stabilise and there is a concrete browser-capture use case.
- **Vertex AI RAG Engine adoption** — rejected 2026-04-26. Reason: architectural mismatch. Revisit only if Synapse pivots away from Supabase or owns-its-own-graph design.
- ~~**Stage 0 Item 2 Phase 2B — Gemini retry on rate limits + token-usage logging**~~ — **shipped 2026-04-28.** See Decision Log D-014 and Changelog 2026-04-28.

---

## Open Questions Awaiting Decision

Items the agent should not act on without explicit approval.

- **Re-ingest behaviour per source type** (Stage 2). Default proposed: skip silently with telemetry on YouTube/URL/file/paste; replace on meetings if Circleback updates a transcript. Awaiting confirmation.
- **Source state machine names** (Stage 2). Proposed: `pending → chunking → extracting → augmenting → complete | failed | degraded`. Awaiting confirmation.
- ~~**Anchor scoring sync vs async** (Stage 9). Trade-off documented in scope; needs an opinion before implementation.~~ **Resolved 2026-04-28 — async-only (D-S9-01).**
- **Stage 1 file upload size limit** (Stage 1). Suggested align with Gemini File API limits (2 GB per file). Confirm.
- **Stage 1 paste size limit** (Stage 1). Suggested 500k characters. Confirm.

---

## Cross-stage themes

Themes that span multiple stages and should be tracked holistically.

- **Browser vs serverless divergence.** Several stages (3, 5, 6, 7) implement the same logic in two places. The hardening goal is to consolidate to one path. **Resolved in Block 2 (2026-04-28)** — Stages 5, 6, 7 browser-side extraction, dedup, and graph-write code deleted. Extraction, dedup, and node/edge persistence are now serverless-only. Stage 3 chunking remains duplicated (canonical `src/utils/chunking.ts` + paste-in server copies) but is intentional — chunking is a pure function, not a service call.
- **Idempotency across webhooks.** Affects Stage 1 (capture entry points) and Stage 2 (persistence). **Resolved in Stage 2 (2026-04-28)** — every webhook / queue-driven write path now routes through a `persistSource` variant with the appropriate dedup index. Production currently shows zero violations across all three identity rules.
- **Failure policy.** Affects every stage. Defined once in Stage 0 Item 5, applied per-stage.
- **Secret hygiene + browser exposure.** Owned by Stage S. Affects any stage that calls a paid third-party API from the browser today (Stages 8 cross-connection, 13 surfacing/RAG, plus the `src/services/gemini.ts` callers in summarisation and reranking). Every new third-party integration must consult `CLAUDE.md` Secret Hygiene before adding env vars.

---

## Changelog

Reverse chronological. Every meaningful update goes here.

### 2026-04-28 (Block 2 — Stages 5, 6, 7)
- **Stages 5, 6, 7 — Entity extraction, Deduplication, Knowledge persistence. Done.** Browser-side extraction path eliminated: `src/services/extractionPipeline.ts`, `src/services/crossConnections.ts`, `src/services/edgeEmbedding.ts` deleted. `extractEntities` removed from `src/services/gemini.ts`. `checkDeduplication` removed from `src/services/deduplication.ts`. `saveNodes`, `saveEdges`, `updateNodeEmbeddings`, `updateEdgeEmbeddings` removed from `src/services/extractionPersistence.ts`. Three new serverless endpoints: `api/ingest/extract-preview` (Gemini extraction → entities for review), `api/ingest/extract-persist` (saves approved entities, dedup, embeddings, cross-connections), `api/ingest/extract.ts` (headless auto-approve for background automation). `useExtraction.ts` rewritten to call these endpoints — no direct AI or graph-write imports remain. Hardening applied: named dedup constants (`DEDUP_EXACT_THRESHOLD=0.85`, `DEDUP_SEMANTIC_THRESHOLD=0.80`, `DEDUP_AUTO_MERGE_THRESHOLD=0.88`); `saveEdges` upsert with ON CONFLICT; edge embeddings computed inline in `runExtractionCore` (non-blocking); `extract-preview` retry bug fixed (`let raw`, reassign on valid retry). Migration `20260428_edge_dedup_constraint.sql` applied: deduplicates existing duplicate edge groups, adds `knowledge_edges_dedup_uniq` UNIQUE INDEX on `(user_id, source_node_id, target_node_id, relation_type)`. TypeScript clean. Squash-merged to `main` (commit `b8a8d16`). Decisions D-B2-01 through D-B2-04 recorded. Owner docs: [STAGE-5-EXTRACTION.md](STAGE-5-EXTRACTION.md), [STAGE-6-DEDUP.md](STAGE-6-DEDUP.md), [STAGE-7-PERSISTENCE.md](STAGE-7-PERSISTENCE.md).

### 2026-04-28 (Stage 9)
- **Stage 9 — Anchor scoring. Done.** Six open items from the pre-hardening audit resolved: (1) async-only decision recorded in `score-post-extraction.ts` handler comment and Decision Log D-S9-01; (2) five signal formulas documented in `SIGNAL_WEIGHTS` comments in `score-daily.ts` (momentum/velocity 0.30, centrality 0.25, diversity 0.20, richness 0.15, behavioural 0.10) and D-S9-02; (3) six lifecycle transition rules documented above `runLifecycleTransitions()` in `score-daily.ts` and D-S9-03; (4) cron idempotency confirmed via ON CONFLICT upsert semantics in `bulk_upsert_anchor_candidates`; (5) all `console.log`/`console.error`/`console.warn` across all six anchor files → `log()`/`logError()` with `stage: 'anchor'`; (6) all per-row UPDATE loops replaced with two bulk RPCs. Migration `20260428_anchor_scoring_bulk_ops.sql`: UNIQUE constraint on `anchor_candidates(user_id, node_id)` + `bulk_upsert_anchor_candidates` RPC (JSON-array upsert with status-protection CASE and is_anchor CTE) + `bulk_anchor_dormancy_transitions` RPC (two SQL UPDATEs replacing N-round-trip edge-recency loops). Full rewrites: `score-daily.ts`, `rescore-backfill.ts`, `score-post-extraction.ts`. Targeted edits: `spawn-sub-anchors.ts`, `dedup-scan.ts`, `on-confirm.ts`. `tsc -b --force` clean. Decisions D-S9-01 through D-S9-05 recorded. Owner doc: [STAGE-9-ANCHOR-SCORING.md](STAGE-9-ANCHOR-SCORING.md).

### 2026-04-28 (Stage 10)
- **Stage 10 — Skills detection + scoring. Done.** Fixed five critical bugs that caused all skill creation in `process-source.ts` to silently fail: (1) INSERT used nonexistent `label` column and omitted required NOT NULL fields `name`, `title`, `description`, `content`; (2) `SOURCE_TYPE_CONFIDENCE` and `REINFORCEMENT_DELTAS` used pre-Stage-2 capitalized type keys (`YouTube`, `Meeting`) so all lookups fell back to defaults; (3) existingSkills dedup queried `label` instead of `name, title`; (4) `skill_sources` join table was written on reinforcement but `source_ids` array was never updated, causing daily-cron to re-process every source; (5) `confirmedCount` read `.data` on a `head:true` query instead of `.count`. Also: removed `VITE_` fallbacks from `process-source.ts`, `get.ts`, `scan.ts`, `tag-source.ts`, `tag-sources.ts`; added `INGEST_SECRET` auth path to `process-source.ts` so pipeline calls work without a user JWT; fixed anchor predicate in `update-from-source.ts` (`entity_type = 'Anchor'` → `is_anchor = true`); migrated key events to `log()`/`logError()`. Wired Stage 10 as fire-and-forget POST to `/api/skills/process-source` at extraction completion in all 6 pipeline routes. `tsc -b --force` clean.

### 2026-04-28 (Stage 8)
- **Stage 8 — Cross-connection discovery. Done.** New standalone endpoint `api/cross-connect/run.ts` runs the full orchestration server-side: auth-gated POST, one `match_knowledge_nodes` RPC per new node (HNSW halfvec index, threshold 0.55), dedup candidates by highest similarity, single Gemini batch call for up to 20 candidates, bulk-insert confirmed edges. `useExtraction.ts` and `extractionPipeline.ts` now fire-and-forget to `/api/cross-connect/run` (never block the extraction UX). `api/pipeline/extract-pipeline.ts:discoverCrossConnections` retains its inline call for serverless pipelines but now uses bulk INSERT (was one INSERT per edge in a loop), structured `log()`/`logError()` with `stage:'cross-connect'`, and stops candidate collection early on time budget. Migration `20260428_knowledge_nodes_halfvec_index.sql` applied: drops `idx_knowledge_nodes_embedding_hnsw` (wrong `vector_cosine_ops` op class for 3072-dim), creates `idx_knowledge_nodes_embedding_hnsw_halfvec` with `halfvec_cosine_ops`, rewrites `match_knowledge_nodes` RPC to cast both sides to `halfvec(3072)` so the index is hit (fixes silent sequential scan). `src/services/crossConnections.ts` logging migrated to structured `log()`/`logError()` with `stage:'cross-connect'`. `tsc -b --force` clean. Decisions D-S8-01, D-S8-02, D-S8-03 recorded. Owner doc: [STAGE-8-CROSS-CONNECT.md](STAGE-8-CROSS-CONNECT.md).

### 2026-04-28
- **Stage 4 — Prompt composition. Done.** Single canonical pure builder at [api/pipeline/extract-prompt.ts](../api/pipeline/extract-prompt.ts) — no env reads, browser-safe, deterministic. Both browser (`src/utils/promptBuilder.ts`) and serverless (`api/pipeline/extract-pipeline.ts`) re-export from it; the legacy plain-prose builder is gone. Active confirmed `knowledge_skills` (top 12) inject as a `<user_expertise>` hints block — wired in browser via `src/services/promptSkillsContext.ts` and in five serverless paths (youtube, github, meetings, microsoft, ingest/session). New `extraction_sessions.prompt_version` column (migration `20260428_extraction_sessions_prompt_version.sql` applied to prod) stamped from `composeExtractionPrompt()`; `PROMPT_VERSION = '2.1.0'`. Snapshot tests lock the rendered prompt for all four modes; 25 unit tests in [tests/prompts/extract-prompt.test.ts](../tests/prompts/extract-prompt.test.ts) cover invariants, modes, anchor emphasis, skills wiring, profile, and version stability. Owner doc: [STAGE-4-PROMPT.md](STAGE-4-PROMPT.md). Decisions D-S4-01 through D-S4-04.
- **Stage 0 Item 2 Phase 2B — Gemini retry + token-usage telemetry. Implemented and validated.** Canonical `geminiFetch` helper rolled out across 41 backend files in `api/`. Acceptance criteria met: every Gemini chat call retries on 429 / 5xx with 1s/2s/4s backoff (max 3 attempts) and emits one structured JSON line per call recording `{ stage, model, prompt_tokens, output_tokens, total_tokens }`. Embedding helpers (`embedText`, `embedTexts`) share the same retry path; Gemini does not return `usageMetadata` for embedding endpoints, so embedding telemetry remains call-count + latency only (documented upstream limitation). Pre-existing per-file helpers (`callGemini`, `geminiJson`, `generateEmbedding`) retained as thin delegating wrappers so no call sites changed. Embedding-model constant normalised to `GEMINI_EMBEDDING_MODEL` across the codebase. Rollout pattern: pilot (`api/summaries/backfill.ts`) → two more (`api/council/route.ts`, `api/youtube/extract-knowledge.ts`) → bulk across 38 remaining files. TypeScript clean; zero new errors introduced; 14 pre-existing tsc errors fixed as a side effect of stricter response-type casting. Stage 0 now fully Done — no deferred items remain. Decision D-014 recorded.
- **Stage 2 — Source persistence + deduplication. Implemented and validated.** `persistSource()` now owns every write into `knowledge_sources`. Browser canonical at [src/services/persistSource.ts](../src/services/persistSource.ts); per-file inlined variants in `api/meetings/webhook.ts`, `api/youtube/extract-knowledge.ts`, `api/microsoft/extract-knowledge.ts`, `api/ingest/session.ts`. Shared identity utilities at [src/utils/sourceIdentity.ts](../src/utils/sourceIdentity.ts). Source-type rename migration `20260427_source_type_lowercase.sql` applied to production: `Note→paste`, `Web→url`, `Document→file`, `YouTube→youtube`, `Meeting→meeting`, `Research→research`, `GitHub→github` across `knowledge_sources`, `knowledge_nodes`, `extraction_sessions`. Three RPC `COALESCE` defaults patched in the same migration. Pre-existing YouTube dedup code (commits `475598c`/`dfc5bc0`) retired in favour of inlined `persistYouTubeSource()`; wipe-and-rerun preserved on the cron path. New stuck-source sweep cron at `api/cron/sweep-stuck-sources.ts`, registered hourly. Decisions D-011 / D-012 / D-013 recorded. Schema-side validation tests 1a/1b, 6a/6b/6c, 7a, 8a/8b all passed against production — zero rows violate any of the three dedup invariants. `tsc -b --force` clean. Live-traffic tests 2–5 and 9 deferred to a 24h soak window. Owner doc: [STAGE-2-PERSISTENCE.md](STAGE-2-PERSISTENCE.md). Cross-stage theme "Idempotency across webhooks" marked resolved.
- **Stage S — Secret hygiene + client-server boundary. Created and partially shipped (incident response).** New cross-cutting hardening stage added in response to a confirmed credential leak on 2026-04-28: a third party scraped `VITE_GEMINI_API_KEY` from the production browser bundle at `connectsynapse.com`, used it to spin up unauthorised resources in the GCP project that backed Synapse's Gemini calls, generated approximately £100 in charges, and triggered a Google Trust & Safety suspension of the project (`gen-lang-client-0813591585`, "Reg Tracker"). Incident response shipped the same day: all seven Vercel-stored secrets rotated (`SUPABASE_SERVICE_ROLE_KEY`, `GEMINI_API_KEY`, `RESEND_API_KEY`, `INGEST_SECRET`, `CRON_SECRET`, `YOUTUBE_API_KEY`, `APIFY_API_KEY`); Supabase migrated to the new publishable + secret key system; new Gemini key created in a fresh `synapse-prod` GCP project with HTTP referrer restrictions, API restrictions, and a £20/month budget alert; `VITE_GEMINI_API_KEY` removed from Vercel and `.env.local`; production redeployed and verified. Phase 2 (move 7 `src/` files calling Gemini directly to new `api/gemini/*` endpoints; same for the 2 `src/` files calling YouTube directly) is open and is the actual architectural fix — until it lands, Ask chat / RAG / source summaries / cross-connections / query classifier / reranker / persona simulation are temporarily broken. Phase 3 (CI check banning `VITE_*_API_KEY`-style names, bundle scan, quarterly rotation cadence, disabling Supabase legacy JWT keys) tracked in the stage doc. Decision D-010 records the new rule: vendor credentials are server-side only. Billing dispute filed with Google Cloud requesting refund of the unauthorised charges.
- **Root-cause analysis (four layers) recorded.** The leak was not a one-off mistake; it was the predictable outcome of an architectural drift between March 2026 (when v2 was a pure-frontend SPA and `VITE_GEMINI_API_KEY` was the correct pattern) and late April 2026 (when `api/` serverless functions had grown into the real backend but the original `src/` Gemini callers were never migrated). `CLAUDE.md` reinforced the unsafe pattern by listing `VITE_GEMINI_API_KEY` as a required env var. No defensive layers (HTTP referrer restriction, budget alert, CI bundle scan, secret rotation cadence) existed to catch the leak before exploitation. Stage S addresses all four layers explicitly so the same shape of incident does not recur with the next service.
- **`CLAUDE.md` updated.** New "Secret Hygiene" section under Critical Rules enumerates exactly which credentials are safe in `VITE_*` (Supabase publishable + non-credential config) and which are not (any vendor API key, the Supabase service role key, any webhook / cron / ingest secret). Deployment section's required-env-vars list rewritten: `VITE_GEMINI_API_KEY` marked as deprecated and "must not exist"; full list of server-only env vars added (`SUPABASE_SERVICE_ROLE_KEY`, `GEMINI_API_KEY`, `YOUTUBE_API_KEY`, `RESEND_API_KEY`, `APIFY_API_KEY`, `INGEST_SECRET`, `CRON_SECRET`, `CIRCLEBACK_WEBHOOK_SECRET`). Old single-bullet "use `VITE_` prefix for client-side access" rule replaced with a pointer to the new Secret Hygiene section.

### 2026-04-27
- **Stage 3 — Chunking + chunk embeddings. Done.** Canonical chunker landed at [src/utils/chunking.ts](../src/utils/chunking.ts) with paste-in copies in the two serverless paths. Structural-first split (Markdown → paragraphs → sentences → hard cap), 2000-char target, 100-char overlap, 3000-char ceiling. Embedding is now `${title}\n\n${chunk}`. Chunk write paths (`saveChunks`, `saveTranscriptChunks`) upsert with `ON CONFLICT DO NOTHING`. Chunking failure → source `failed`; embedding failure → source `degraded`. Schema migration `stage3_chunks_constraints_and_index` applied: unique constraint on `(source_id, chunk_index)`, `source_id NOT NULL`, dropped `token_count`, HNSW halfvec index. `match_source_chunks` RPC updated. Backfill ran against production: 62 sources processed, 1,360 chunks written, 0 failures. Replay run was a no-op. All five validation gates passed. Embedding-dimension fact corrected across docs (3072-dim, not 768). Decisions D-007 / D-008 / D-009 recorded.

### 2026-04-26
- Created this file.
- Recorded decisions D-001 through D-005.
- Recorded Stage 0 partial status (Item 1 done, Items 2–7 open).
- Recorded Stage 1 scoped, prompt drafted.
- Recorded Stage 2 scoped, with two pre-existing YouTube-only fixes documented.
- Recorded Stage 5 partial: v2 extraction pipeline + Gemini 2.5 migration shipped.
- Recorded Stage 11 partial: Phase 0 shipped, `agent_signals` retirement confirmed intentional.
- **Stage 0 Item 1 — Single Supabase client. Implemented and validated.** Canonical recipe documented; ~10 deviating backend files refactored to factory pattern; env-var safety checks added. TypeScript clean.
- **Stage 0 Item 2 Phase 2A — Single Gemini wrapper, model normalization. Implemented and validated.** One env var (`GEMINI_MODEL` / `VITE_GEMINI_MODEL`) now controls the chat model everywhere; 28 backend files and 6 browser sites converted from hard-coded literals to constants; safety check added. TypeScript clean.
- **Stage 0 Item 2 Phase 2B — Retry + token telemetry. Deferred at owner's request.** See Deferred section for the four-step pilot plan when revisited.
- **Stage 0 Item 3 — Single embedding service. Implemented and validated.** Embedding model unified to `gemini-embedding-001` (fixed silent cross-model bug in `api/skills/scan.ts` and `api/skills/process-source.ts`). CLAUDE.md updated to match. Canonical `embedText` / `embedTexts` recipe documented. Three high-volume sequential loops switched to true batch (`:batchEmbedContents`). Embedding-side retry/telemetry rolled into the existing Phase 2B deferral. TypeScript clean.
- **Stage 0 Item 4 — Structured logging. Implemented and validated.** Canonical `log()` / `logError()` helpers added to 61 backend files. Recipe + 13-stage taxonomy documented. Migration of existing `console.log` lines is incremental, per-stage, as each pipeline stage is hardened — no mass rewrite. TypeScript clean.
- **Stage 0 Item 5 — Failure-handling policy. Implemented and validated.** `docs/FAILURE-POLICY.md` written with per-stage Fatal/Degraded/Skip-with-telemetry rules. Schema migration `20260427_knowledge_sources_status.sql` applied to production (status column + check constraint + two indexes). Audit of 145 catch blocks completed; 1 genuine silent failure replaced with structured logError, 18 control-flow exceptions documented in the policy doc. Per-stage status writes will be wired in as each pipeline stage is hardened. TypeScript clean.
- **Stage 0 Item 6 — Idempotency on webhooks and queue workers. Implemented and validated.** Schema migration `20260427_idempotency_keys.sql` applied (adds `circleback_meeting_id` and `content_hash` columns with partial unique indexes). Meeting webhook switched to upsert-with-conflict to close the simultaneous-webhook race condition. Browser-side `saveSource()` now computes SHA-256 content hashes for URL-less sources, with pre-insert dedup check and post-insert error-23505 fallback. Other entry points (YouTube, Microsoft, internal ingest) confirmed already idempotent. TypeScript clean.
- **Stage 0 Item 7 — RLS audit. Implemented and validated.** `docs/RLS-AUDIT.md` written. Live verification: 43/43 tables have RLS on, 43/43 have ≥1 policy. All 58 service-role files reviewed. Two non-blocking follow-ups recorded (WITH CHECK clauses on two tables, two spot-checks for stage-hardening passes).
- **Stage 0 marked Done.** Items 1, 2A, 3, 4, 5, 6, 7 all complete. Item 2 Phase 2B (chat + embedding retry/telemetry) remains the only deferred item.
- **Stage 1 — Chrome extension removal complete.** Deleted `extension/` package, `ChromeExtensionCard.tsx`, PRD 14 doc, and all references in `CLAUDE.md`, `BUILD-PLAN.md`, `PROJECT-REFERENCE.md`, `010-PRD-10-Automate-View.md`, `IntegrationDashboard.tsx`, `SettingsModal.tsx`, `services/supabase.ts`, `types/automate.ts`. TypeScript clean. Historical `metadata.source = 'chrome_extension'` rows preserved in `knowledge_sources` (data only, no schema impact).
- **Stage 1 scope split decided (D-006).** Adapters return `CapturedSource`; persistence cutover and `source_type` rename move to Stage 2 (their natural home). Stage 0 Item 2 must complete before Adapter 3 (file upload). Stage 0 logging helper must complete before Stage 1 final sign-off.
- **Stage 1 Adapter 1 — Paste. Implemented and validated.** `src/types/capture.ts` defines the `CapturedSource` contract. `src/adapters/capture/paste.ts` derives titles from the first non-empty line (max 80 chars, fallback "Untitled paste") and rejects content over 500,000 characters. Vitest installed; contract test passing 9/9. UI wired in `ManualUploadPanel` "Add Text".
- **Stage 1 D-006 correction (2026-04-26).** Earlier framing said Adapters 2 (URL) and 3 (File) were blocked on Stage 0 Item 2 Phase 2B. That was wrong. The canonical Gemini helper recipe is documented in `STAGE-0-FOUNDATIONS.md` Item 2 and can be pasted into new files; Phase 2B only covers retro-converting the 30 existing backend files. New adapters use the recipe from day one — no blocker.
- **Stage 1 Adapters 2 + 3 — URL and File. Implemented as one combined pass using Gemini.** New serverless endpoints `api/capture/url.ts` (Gemini URL Context) and `api/capture/file.ts` (Gemini File API via multipart upload + `fileData` reference) both return a `CapturedSource`. Browser adapters at `src/adapters/capture/url.ts` and `src/adapters/capture/file.ts` post to those endpoints. UI wired in `ManualUploadPanel` "Add URL" and "Upload Document". URL extracted-text cap 400,000 chars; file inline cap 25 MB; supported MIME whitelist: PDF, DOCX, TXT, MD, MP3, M4A, WAV, MP4, MOV, JPG, PNG. No fallback on Gemini failure — clear rejection messages instead. Contract tests passing (13 new tests, 22 total). TypeScript clean. **Follow-up:** lifting the file inline cap to the Gemini File API ceiling (2 GB) requires a Supabase Storage staging path. Adapter logic is unchanged; only the upload mechanism differs. Tracked as Stage 1 follow-up. **Legacy retained:** `api/content/fetch.ts` and `src/utils/fileParser.ts` are still referenced by `src/components/signals/SkillCreatePanel.tsx`; they will be deleted once the skills feature moves to the canonical adapters.
- **Stage 1 Adapter 4 — YouTube. Implemented and validated.** New serverless endpoint `api/capture/youtube.ts` runs three tiers in the order set by D-004: **Tier 1 Apify** (synchronous polling up to 45s for the interactive capture path), **Tier 2 youtube-caption-extractor** (free public timedtext scraper — replaces the unworkable "YouTube Data API v3 captions" originally planned, which requires OAuth as the channel owner and is not available for third-party videos), **Tier 3 Gemini video understanding** (escape hatch via `fileData` with the YouTube URL). Browser adapter at `src/adapters/capture/youtube.ts` posts to the endpoint. UI wired in `ManualUploadPanel` "Add YouTube Video" — it now actually fetches a transcript instead of sending the raw URL string to extraction. Background pipeline `api/youtube/fetch-transcripts.ts` reordered to match: Apify fire-and-forget first, caption-extractor second, Innertube third. Video metadata (title, channel, duration, published_at, thumbnail) fetched from YouTube Data API v3 alongside the transcript. Transcript cap 400,000 chars. All adapter calls emit canonical `log()` / `logError()` lines per Stage 0 Item 4. Contract tests passing (9 new tests, 31 total). TypeScript clean.

---

### Stage 1 Adapter 5 — Meeting webhook (Circleback). Implemented and validated.
Pure `circlebackToCapturedSource()` function exported from `api/meetings/webhook.ts` produces a `CapturedSource` from the Circleback payload. Title rule: `payload.name` → `Meeting on YYYY-MM-DD` (from `createdAt`) → `Untitled meeting`. Size cap: 400,000 characters; previous silent truncation at 100,000 replaced with explicit `MEETING_OVERSIZE` rejection. New optional `CIRCLEBACK_WEBHOOK_SECRET` env var enables a shared-secret check on the `x-signature` header; if unset, webhook keeps the legacy uid-only path and emits a warning log so it shows up in audits. All structured logs migrated to canonical `log()` / `logError()`. Existing dedup behaviour (DB-level unique constraint on `(user_id, circleback_meeting_id)` plus title+date safety net) preserved unchanged. Contract tests: 11 new tests against a saved Circleback fixture, 42 of 42 total passing. TypeScript clean.

**Stage 1 status:** all five adapters now produce a unified `CapturedSource` shape with documented title rules, size limits, validation, and contract tests. Final consolidation doc `docs/STAGE-1-CAPTURE.md` still to be written.

---

## Appendix — useful references

- 13-stage pipeline definition: `CLAUDE.md` (project root) and the original audit chat.
- Stage 0 details: [STAGE-0-FOUNDATIONS.md](STAGE-0-FOUNDATIONS.md)
- Build plan: [BUILD-PLAN.md](BUILD-PLAN.md)
- Architecture: [ARCHITECTURE.md](ARCHITECTURE.md)
- Data model: [DATA-MODEL.md](DATA-MODEL.md)
- Performance patterns: [PERFORMANCE-PATTERNS.md](PERFORMANCE-PATTERNS.md)
