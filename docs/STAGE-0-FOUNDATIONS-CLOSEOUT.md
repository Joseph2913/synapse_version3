# Stage 0 — Foundations (Close-out)

**Status:** Done. Items 1, 2A, 3, 4, 5, 6, 7 all shipped and validated. Item 2 Phase 2B explicitly deferred and tracked.
**Owner:** Joseph Thomas
**Completed:** 2026-04-26
**Validation:** `npx tsc --noEmit` clean across all changes. Two schema migrations applied to production via Supabase MCP.
**Recipes doc:** [STAGE-0-FOUNDATIONS.md](STAGE-0-FOUNDATIONS.md) — canonical recipes for each foundation primitive. New backend code starts there.

---

## Why this stage exists

Stage 0 is the shared backend plumbing every other stage depends on. Before this hardening pass, the codebase had: 60+ background-worker files each duplicating their own Supabase client, 35 hard-coded copies of the Gemini chat model name, two different embedding models running side-by-side and silently producing nonsense similarity scores, ad-hoc unstructured logs, no failure-handling policy, race conditions on webhook entry points, and an unaudited row-level security posture. Every stage that came after would have inherited all of that fragmentation.

Stage 0's job is to fix the foundations once so Stages 1–13 can rely on a single recipe for each primitive: one client, one chat wrapper, one embedding service, one log shape, one failure policy, one idempotency model, one verified RLS posture.

---

## Item 1 — Single Supabase client

**Doc:** [STAGE-0-FOUNDATIONS.md](STAGE-0-FOUNDATIONS.md) Item 1.

| Property | Value |
|---|---|
| Browser side | One canonical client at [src/services/supabase.ts](../src/services/supabase.ts). |
| Backend side | Vercel forces independent bundling, so each `api/*.ts` file declares its own factory using a single canonical recipe (env vars + `getServiceSupabase()` + `getAnonSupabase()` + safety check). |
| What changed | ~10 deviating backend files that called `createClient` inline inside handlers were refactored to use the factory. `getAnonSupabase().auth.getUser(token)` is now the canonical JWT-verification path, replacing inconsistent custom-header patterns in `api/keys/*` and `api/digest/send.ts`. |
| Safety check | Every backend file fails loudly at startup if `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, or `SUPABASE_ANON_KEY` is missing — instead of crashing on first request. |
| Validation | `grep -rn "createClient" src/` returns one canonical match. `grep -rn "createClient" api/` returns only factory definitions, no inline calls inside handlers. |

---

## Item 2 (Phase 2A) — Single Gemini wrapper, model normalization

**Doc:** [STAGE-0-FOUNDATIONS.md](STAGE-0-FOUNDATIONS.md) Item 2.

| Property | Value |
|---|---|
| Browser side | Two exported constants in [src/services/gemini.ts](../src/services/gemini.ts) — `GEMINI_CHAT_MODEL` (overridable via `VITE_GEMINI_MODEL`) and `GEMINI_EMBEDDING_MODEL`. Six hard-coded literals replaced with constants. Five other browser files (`summarize`, `queryClassifier`, `simulate`, `crossConnections`, `reranker`) and one config (`queryMindsets`) now import the constants. |
| Backend side | Each `api/*.ts` file that calls Gemini declares `GEMINI_MODEL = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash'` and `GEMINI_EMBEDDING_MODEL = 'gemini-embedding-001'`. 35 inline literals replaced. |
| Operational outcome | Setting `GEMINI_MODEL` in Vercel + redeploy now changes the chat model for every backend call. Setting `VITE_GEMINI_MODEL` + rebuild changes it for every browser call. One env var, full coverage. |
| Safety check | `if (!GEMINI_API_KEY) throw ...` at module scope on every backend file that previously lacked it (~23 files). |

---

## Item 2 (Phase 2B) — DEFERRED

Retry-on-rate-limits + token-usage telemetry across both chat and embedding helpers. The canonical `geminiFetch` / `geminiJson` / `embedText` / `embedTexts` helpers are documented and ready to paste; rollout deferred at owner's request.

**Tracked in:** [PIPELINE-IMPLEMENTATION-LOG.md](PIPELINE-IMPLEMENTATION-LOG.md) "Deferred / Pushed Back" section. Four-step pilot rollout plan recorded there.

---

## Item 3 — Single embedding service

**Doc:** [STAGE-0-FOUNDATIONS.md](STAGE-0-FOUNDATIONS.md) Item 3.

| Property | Value |
|---|---|
| Canonical embedding model | `gemini-embedding-001` (768-dim) across the entire codebase. |
| Bug fixed | [api/skills/scan.ts](../api/skills/scan.ts) and [api/skills/process-source.ts](../api/skills/process-source.ts) had been silently using `text-embedding-004` to compute candidate embeddings, then comparing them against `gemini-embedding-001` anchor vectors stored in the database. Different model = different vector space = meaningless similarity scores. Fixed by switching the constant; this corrects the skills `s1` anchor-alignment signal and the "related anchors" attachment list. |
| CLAUDE.md correction | Tech-stack table and Gemini AI section in [CLAUDE.md](../CLAUDE.md) had documented `text-embedding-004` as the standard. Updated to match reality. |
| Canonical helpers | `embedText(text)` for one text, `embedTexts(texts)` for many. The batch helper uses Gemini's `:batchEmbedContents` endpoint (up to 100 texts per network call). |
| Performance fix | Three high-volume sequential embedding loops migrated to true batch: [api/council/backfill-question-embeddings.ts](../api/council/backfill-question-embeddings.ts), [api/council/cron.ts](../api/council/cron.ts), [api/council/rebuild-agent.ts](../api/council/rebuild-agent.ts). N network calls → ⌈N/100⌉. |

---

## Item 4 — Structured logging

**Doc:** [STAGE-0-FOUNDATIONS.md](STAGE-0-FOUNDATIONS.md) Item 4.

| Property | Value |
|---|---|
| Helper signature | `log(fields)` and `logError(fields)` where `fields` is `{ stage, user_id?, source_id?, duration_ms?, status?, error?, ...arbitrary }`. Output is one JSON line with `ts` prepended. |
| Coverage | Helpers added to all **61 backend files** in `api/` that touch Supabase, Gemini, or external services. |
| Stage taxonomy | The `stage` field uses one of: `capture`, `persist`, `chunk`, `prompt`, `extract`, `dedup`, `knowledge`, `cross-connect`, `anchor`, `skills`, `council`, `audit`, `surface`. Sub-stages allowed via colon (e.g. `capture:youtube:counter`). |
| Migration policy | New code uses `log()` / `logError()` from now on. Existing free-text `console.log` calls remain in place and migrate stage-by-stage as each pipeline stage is hardened — no high-risk mass rewrite. |
| Vercel queries unlocked | Filter by `stage`, `user_id`, `source_id`, `level=error`, `duration_ms>X`, etc. |

---

## Item 5 — Failure-handling policy

**Doc:** [FAILURE-POLICY.md](FAILURE-POLICY.md). Schema in [supabase/migrations/20260427_knowledge_sources_status.sql](../supabase/migrations/20260427_knowledge_sources_status.sql).

| Property | Value |
|---|---|
| Three rules | **Fatal** (throw out the source), **Degraded** (keep partial work, mark for retry), **Skip-with-telemetry** (log loudly, source still complete). |
| Per-stage assignment | Every one of the 13 pipeline stages assigned exactly one rule, with rationale. See `FAILURE-POLICY.md` for the full table. |
| Source state machine | `pending → chunking → extracting → augmenting → complete \| failed \| degraded`. |
| Schema change | `knowledge_sources.status text NOT NULL DEFAULT 'complete'` with check constraint and two indexes (one for user-scoped status filtering, one partial index optimised for the retry queue: `(status, created_at DESC) WHERE status IN ('degraded','failed','pending')`). Existing rows default to `'complete'` so no backfill required. |
| Catch-block audit | 145 catch blocks reviewed. 19 silent. 18 of those were intentional control flow (auth probe fall-throughs trying multiple methods, defensive JSON-parse fallbacks where empty default is the documented behaviour) — policy doc explicitly exempts these patterns and requires marker comments. 1 genuine silent failure (YouTube daily-counter update) replaced with structured `logError()`. |
| What this unlocks | Operational queries like "what percentage of meetings reach `complete` vs `degraded` this week?", an automated nightly retry job for `degraded` sources, honest user-facing UI badges. |

---

## Item 6 — Idempotency on webhooks and queue workers

**Schema:** [supabase/migrations/20260427_idempotency_keys.sql](../supabase/migrations/20260427_idempotency_keys.sql).

| Property | Value |
|---|---|
| New columns | `knowledge_sources.circleback_meeting_id bigint` and `knowledge_sources.content_hash text`. Both nullable; existing rows default to NULL. |
| New indexes | Partial unique index on `(user_id, circleback_meeting_id) WHERE circleback_meeting_id IS NOT NULL`. Partial unique index on `(user_id, source_type, content_hash) WHERE content_hash IS NOT NULL AND source_url IS NULL`. |
| Meeting webhook fix | [api/meetings/webhook.ts](../api/meetings/webhook.ts) refactored from "check then insert" (race-prone) to upsert with `onConflict: 'user_id,circleback_meeting_id', ignoreDuplicates: true` plus an existing-row fetch when ignoreDuplicates returns null. Two simultaneous Circleback webhooks for the same meeting now produce exactly one row. |
| Paste / file dedup | [src/services/extractionPersistence.ts](../src/services/extractionPersistence.ts) now computes a SHA-256 (Web Crypto) of content for sources without a `source_url`, runs a pre-insert dedup check, and falls back to an existing-row fetch on PostgreSQL error 23505 (unique violation). Same paste twice = one row. Same file uploaded twice = one row. |
| Other entry points | YouTube poll (`youtube_ingestion_queue` already has `(user_id, video_id)` unique constraint), Microsoft sync (`microsoft_ingestion_queue` has `(user_id, microsoft_resource_id)` unique constraint), and the internal `/api/ingest/session` endpoint were reviewed and confirmed already idempotent. |
| URL-bearing sources | Continue to dedup via the pre-existing `(user_id, source_type, source_url) WHERE source_url IS NOT NULL` partial unique index from migration 20260421. |

---

## Item 7 — Row-level security audit

**Doc:** [RLS-AUDIT.md](RLS-AUDIT.md).

| Property | Value |
|---|---|
| Tables with RLS enabled | **43 of 43** (100%). Verified live via `pg_tables.rowsecurity = true`. |
| Tables with at least one policy | **43 of 43** (100%). Zero "RLS-on-but-no-policy" footguns. Verified live via `pg_policies`. |
| Policy shape | Most tables have a full per-command set (`SELECT`/`INSERT`/`UPDATE`/`DELETE`) gated by `auth.uid() = user_id`. Some use the equivalent compact `ALL` shape. |
| Reduced-coverage tables | `council_cron_runs` (SELECT only — server-only writes), `mcp_query_log` (server-side INSERT with intentional `WITH CHECK true` for API-key-validated paths), `youtube_settings` (no DELETE), `youtube_ingestion_queue` (DELETE is service-role only). All reviewed and confirmed intentional. |
| Service-role file audit | All **58 backend files** using `SUPABASE_SERVICE_ROLE_KEY` reviewed. User-bound endpoints authenticate first then scope by `user_id`. Cron / batch files iterate top-level rows that carry `user_id` and propagate it into every downstream query. Webhook entry points resolve `user_id` from server-controlled lookups (API key hash, OAuth state, subscription ID). |
| Source `source_chunks` exception | Has an additional `ALL` policy with `auth.role() = 'service_role'` — intentional escape hatch for the extraction pipeline. Documented. |

---

## Required environment variables (Stage 0)

| Variable | Used by | Required? |
|---|---|---|
| `SUPABASE_URL` | All backend | Yes |
| `SUPABASE_SERVICE_ROLE_KEY` | All backend writes | Yes |
| `SUPABASE_ANON_KEY` | JWT verification on backend | Yes |
| `GEMINI_API_KEY` | Every Gemini-using backend file | Yes |
| `GEMINI_MODEL` | Backend chat-model override | Optional. Defaults to `gemini-2.5-flash`. |
| `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` | Browser | Yes |
| `VITE_GEMINI_API_KEY` | Browser | Yes |
| `VITE_GEMINI_MODEL` | Browser chat-model override | Optional. Defaults to `gemini-2.5-flash`. |

---

## Schema migrations applied

| Migration | What it does |
|---|---|
| [20260427_knowledge_sources_status.sql](../supabase/migrations/20260427_knowledge_sources_status.sql) | Adds `status` column to `knowledge_sources` with check constraint and two indexes. Item 5. |
| [20260427_idempotency_keys.sql](../supabase/migrations/20260427_idempotency_keys.sql) | Adds `circleback_meeting_id` and `content_hash` columns with partial unique indexes. Item 6. |

Both migrations are additive and non-destructive. No backfill required.

---

## Known follow-ups (deliberately out of Stage 0 scope)

1. **Item 2 Phase 2B — chat + embedding retry/telemetry rollout.** Recipe documented; pilot-first rollout plan recorded in `PIPELINE-IMPLEMENTATION-LOG.md` Deferred section. Kicks off after Stage 1–13 hardening or earlier if a production rate-limit incident makes it urgent.
2. **`WITH CHECK` clauses on `user_integrations` and `youtube_playlists`.** Both have `USING` but no `WITH CHECK` on their `ALL` policies. Low-severity (service role is the only writer today) but tightens before a second user joins. One small migration when convenient.
3. **Stage-by-stage status writes.** Item 5 ships the contract (`knowledge_sources.status`); each pipeline stage's hardening pass implements the status transitions for that stage. Stages 1–13 own the per-stage wiring.
4. **Stage-by-stage log migration.** Item 4 ships the helpers; existing free-text `console.log` calls migrate as each stage is hardened.
5. **Spot-check on `api/skills/rescore.ts` and `api/youtube/fetch-transcripts.ts`.** Low filter-count flagged in the RLS audit; almost certainly intentional cron pattern, but confirm during stage hardening.

---

## Validation gate

Stage 0 is considered complete because:

1. ✅ Single Supabase client — browser singleton + canonical backend factory recipe applied across all files.
2. ✅ Single Gemini wrapper — chat model normalised to one env-driven constant; safety checks added.
3. ✅ Single embedding service — model unified; canonical batch helper documented; cross-model bug fixed.
4. ✅ Structured logging — helpers in 61 backend files; recipe + 13-stage taxonomy documented.
5. ✅ Failure-handling policy — per-stage rules written; schema column + retry-queue index applied; catch audit complete.
6. ✅ Idempotency — meeting webhook race condition closed; paste/file dedup via content hash; URL-bearing sources already covered.
7. ✅ RLS audit — 43/43 tables verified; all 58 service-role files reviewed; two non-blocking follow-ups recorded.
8. ✅ TypeScript strict-mode build is clean (`npx tsc --noEmit`).
9. ✅ Two schema migrations applied to production via Supabase MCP, both additive and non-destructive.

**Stage 0 is complete and validated.**
