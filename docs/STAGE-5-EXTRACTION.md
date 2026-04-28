# Stage 5 — Entity Extraction

**Status:** Done
**Shipped:** 2026-04-28 (Block 2)
**Commit:** `b8a8d16` (squash merge of `feat/block-2-extraction-consolidation`)

---

## What this stage owns

Running the Gemini extraction call on source content, applying map-reduce for long documents, consolidating duplicate labels, applying quality filters, and returning a validated entity + relationship list. Stage 5 does not write to `knowledge_nodes` or `knowledge_edges` — that is Stage 7.

---

## Architecture

### Before Block 2 (eliminated)

`src/services/extractionPipeline.ts` ran Gemini extraction directly from the browser using `src/services/gemini.ts:extractEntities`. The browser held the API key via `VITE_GEMINI_API_KEY` (since removed — see Stage S).

### After Block 2 (current)

All extraction runs in Vercel serverless functions. Two paths:

**Interactive (user-facing):**
1. `api/ingest/extract-preview` — runs Gemini, returns entities + relationships for browser review. No DB writes to nodes/edges.
2. `api/ingest/extract-persist` — called after user approves; handles dedup + persistence (Stage 6/7).

**Headless (background automation):**
- `api/ingest/extract.ts` — single-call auto-approve endpoint. Routes through `runExtractionCore()` in `api/pipeline/extract-pipeline.ts`. Used by YouTube pipeline and `manualSignals.ts`.

---

## Key files

| File | Role |
|---|---|
| `api/ingest/extract-preview.ts` | Interactive extraction endpoint — Gemini only, returns entities for review |
| `api/ingest/extract-persist.ts` | Persistence endpoint — receives approved entities, runs dedup + save |
| `api/ingest/extract.ts` | Headless auto-approve endpoint for background pipelines |
| `api/pipeline/extract-pipeline.ts` | Canonical orchestrator — `runExtractionCore()`, `extractEntities()`, `extractEntitiesMapReduce()`, `consolidateDuplicateLabels()`, `applyQualityFilters()` |
| `src/hooks/useExtraction.ts` | Browser hook — calls `/api/ingest/extract-preview` then `/api/ingest/extract-persist` |

---

## Map-reduce thresholds

| Constant | Value | Purpose |
|---|---|---|
| `MAP_REDUCE_THRESHOLD` | 15,000 chars | Content longer than this triggers map-reduce |
| Window size | 7,000 chars | Each chunk sent to Gemini |
| Overlap | 1,000 chars | Overlap between consecutive windows |

---

## Retry logic

Both `extractEntities` (single call) and `extractEntitiesMapReduce` return a raw result. `extract-preview` validates with `isValidExtractionResult`:
- If invalid on first attempt: retry once.
- If invalid on retry: set source `status = 'degraded'`, return 422.
- If Gemini throws and message starts with `RATE_LIMITED`: set source `status = 'degraded'`.
- All other throws: set source `status = 'failed'`.

**Bug fixed in Block 2:** The retry block used `const raw` — the retry result was computed but never assigned back to `raw`, so the invalid result was passed to `consolidateDuplicateLabels`. Fixed to `let raw` with `raw = retry` on valid retry.

---

## Canonical patterns

All three endpoints use:
- `geminiFetch` with 1s/2s/4s exponential backoff on 429/5xx (max 3 attempts)
- `log()` / `logError()` with `stage: 'extract'`
- Supabase service role factory (`createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)`)
- Auth-gated via `supabase.auth.getUser(token)` on every request

---

## Decisions

- **D-B2-01** — Two-phase serverless extraction preserves review UX
- **D-B2-02** — `extract-preview` sets source status to `extracting`; does not write nodes or edges
