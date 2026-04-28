# Stage 8 — Cross-connection Discovery

**Status:** Done
**Shipped:** 2026-04-28
**Owner:** Joseph Thomas

---

## What this stage does

After new knowledge nodes and edges are persisted (Stage 7), Stage 8 finds semantic relationships between the new nodes and pre-existing nodes in the user's graph. It:

1. Fetches newly-ingested nodes with their embeddings.
2. Calls `match_knowledge_nodes` RPC per node — vector similarity search using the HNSW halfvec index.
3. Deduplicates candidates, keeps the top 20 by similarity.
4. Sends one Gemini batch call covering all new entities + top candidates.
5. Bulk-inserts confirmed edges into `knowledge_edges` with `weight = 0.8`.

Failure policy: **Skip-with-telemetry** (per `docs/FAILURE-POLICY.md`). Any failure logs via `logError()` with `stage: 'cross-connect'` and returns successfully — source status is never set to `failed` or `degraded` by this stage.

---

## Key files

| File | Role |
|---|---|
| `api/cross-connect/run.ts` | Authoritative server-side endpoint. Auth-gated POST. Canonical Stage 0 patterns inlined (Supabase factory, geminiFetch, log/logError). |
| `api/gemini/cross-connect.ts` | Legacy Gemini proxy (receives entity lists, calls Gemini, returns raw text). Still used by `src/services/crossConnections.ts`. |
| `src/services/crossConnections.ts` | Browser-side orchestration helper. Used by direct consumer code. No longer called by the main extraction flows. Logging migrated to structured `log()`/`logError()`. |
| `api/pipeline/extract-pipeline.ts` | Serverless pipeline cross-connection helper (inline, time-budget gated). Fixed: bulk INSERT, structured logging. |
| `src/hooks/useExtraction.ts` | Browser extraction hook. Fires `/api/cross-connect/run` as fire-and-forget after extraction completes. |
| `src/services/extractionPipeline.ts` | Headless pipeline service. Same fire-and-forget pattern. |
| `supabase/migrations/20260428_knowledge_nodes_halfvec_index.sql` | Fixes HNSW index op class + rewrites `match_knowledge_nodes` RPC. |

---

## Constants (api/cross-connect/run.ts)

| Constant | Value | Rationale |
|---|---|---|
| `CROSS_CONNECT_TIME_BUDGET_MS` | 25 000 ms | Leaves margin inside Vercel Pro 300 s timeout after a 120 s extraction. |
| `SIMILARITY_THRESHOLD` | 0.55 | Minimum cosine similarity for a candidate to be evaluated by Gemini. Consistent with pipeline value. |
| `CANDIDATES_PER_NODE` | 30 | Max candidates returned by `match_knowledge_nodes` per new node (padded to filter new-node IDs). |
| `GEMINI_BATCH_SIZE` | 20 | Max total candidates forwarded in one Gemini call. Keeps prompt under ~4 k tokens, Gemini call under 30 s. |

---

## RPC: match_knowledge_nodes

**Signature:** `match_knowledge_nodes(query_embedding vector(3072), match_threshold float, match_count int, p_user_id uuid)`

**Index:** `idx_knowledge_nodes_embedding_hnsw_halfvec` on `(embedding::halfvec(3072)) halfvec_cosine_ops`, m=16, ef_construction=64.

**Note:** Prior to `20260428_knowledge_nodes_halfvec_index.sql`, the index used `vector_cosine_ops` which caps at 2000 dims. Every call was silently falling back to a sequential scan over all user nodes. The Stage 3 fix (D-007) applied this halfvec pattern to `source_chunks`; this migration applies the same fix to `knowledge_nodes`.

---

## Decisions

- **D-S8-01** — Fire-and-forget from browser/headless paths; inline (time-budget gated) in serverless pipelines.
- **D-S8-02** — `match_knowledge_nodes` must cast to `halfvec(3072)` to hit the HNSW index.
- **D-S8-03** — Time budget: 25 s standalone, remainder of 50 s pipeline. Gemini call timeout: 30 s.

See Decision Log in `PIPELINE-IMPLEMENTATION-LOG.md` for full rationale.

---

## Open follow-ups (non-blocking)

- `crossConnectionCount` in `extraction_sessions` is recorded as 0 for browser/headless paths (discovery runs async). Could be updated via a Supabase UPDATE when `/api/cross-connect/run` completes. Deferred.
- `api/gemini/cross-connect.ts` is now only used by `src/services/crossConnections.ts`. When the direct caller is removed, the endpoint can be deprecated.
