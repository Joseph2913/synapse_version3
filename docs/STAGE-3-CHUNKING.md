# Stage 3 — Chunking + Chunk Embeddings

**Status:** Done.
**Shipped:** 2026-04-27.
**Owner doc tracked in:** [PIPELINE-IMPLEMENTATION-LOG.md](PIPELINE-IMPLEMENTATION-LOG.md).

---

## What Stage 3 does

Turns saved source content into searchable passages. For every source in
`knowledge_sources`, Stage 3 produces ~500-token chunks split on structure-first
boundaries, embeds each chunk with `gemini-embedding-001`, and writes them to
`source_chunks`. This is the substrate for Ask, the Council, and any
"find me something relevant" feature.

---

## Canonical chunking rule

| Rule | Value | Reason |
|---|---|---|
| Target size | ~500 tokens (≈2000 chars) | On-target with the existing dataset (median 1,946 chars). |
| Overlap | 100 chars | Preserves cross-chunk context for retrieval. |
| Hard ceiling per chunk | 3,000 chars | Prevents the "no sentence boundary found" runaway. |
| Splitter order | Markdown headings → paragraphs (`\n\n`) → sentences → hard char split | Structural cues land chunks on real ideas; sentences are the safety net. |
| Sentence regex | `(?<=[.!?])\s+(?=["'(\[]?[A-Z0-9])` with abbreviation masking | Handles `Dr.`, `U.S.`, decimals, and quoted/parenthesised openers. |
| Min tail merge | <200 chars merges into previous | Keeps every chunk substantive. |
| What we embed | `${source.title}\n\n${chunk_content}` | Cheap topical context; helps retrieval for short chunks. |
| Per-source-type tweaks | None | Same rule across paste, URL, file, YouTube, meeting. |

The canonical implementation lives at [src/utils/chunking.ts](../src/utils/chunking.ts). Two byte-equivalent paste-in copies live at [api/pipeline/extract-pipeline.ts](../api/pipeline/extract-pipeline.ts) (`chunkText`) and [api/content/backfill-chunks.ts](../api/content/backfill-chunks.ts) (`chunkText`). The header comment in each copy points to the canonical file. **Change one — change all three.** Vercel forbids shared local imports across serverless functions.

---

## Failure handling

Per [FAILURE-POLICY.md](FAILURE-POLICY.md), Stage 3 is fatal:

| Failure mode | Source state | Behaviour |
|---|---|---|
| Chunking throws | `failed` | No chunks written. Source visible in retry queue. |
| Embedding throws or returns missing values | `degraded` | No chunks written (all-or-nothing). Source visible in retry queue. |
| `source_chunks` insert fails | `failed` | Throws to caller. No silent gaps. |

Wired into [api/pipeline/extract-pipeline.ts](../api/pipeline/extract-pipeline.ts) (`saveTranscriptChunks` plus the wrapper at the chunking step), [src/hooks/useExtraction.ts](../src/hooks/useExtraction.ts), [src/services/extractionPipeline.ts](../src/services/extractionPipeline.ts), and [src/services/manualSignals.ts](../src/services/manualSignals.ts).

---

## Embedding

- Model: `gemini-embedding-001` (3072-dim — see Note below).
- Browser path: `generateEmbeddings()` from [src/services/gemini.ts](../src/services/gemini.ts). Concurrency-5 calls to `:embedContent`. Acceptable at browser scale.
- Serverless path: `embedTexts()` (canonical Stage 0 batch helper) — true batch via `:batchEmbedContents`, 100 per call.
- All three paths embed `${title}\n\n${chunk_content}`.

### Note: embeddings are 3072-dim, not 768

The codebase docs (CLAUDE.md, the original audit) listed the embedding model as 768-dim. **Production data is 3072-dim** (verified `vector_dims(embedding) = 3072` for all 7,096 pre-Stage-3 chunks). This is the default output dimensionality of `gemini-embedding-001` on the current Gemini API.

This matters for indexing: pgvector's standard `vector_cosine_ops` for HNSW caps at 2,000 dims. We use `halfvec_cosine_ops` instead (supports up to 4,000 dims). Storage halves; recall is effectively identical.

CLAUDE.md is updated in this stage.

---

## Database

### Schema migration `stage3_chunks_constraints_and_index` (applied 2026-04-27)

- `UNIQUE (source_id, chunk_index)` — replaces app-level dedup. Insert now uses `ON CONFLICT … DO NOTHING`.
- `source_id NOT NULL` — chunks must belong to a source. (Zero existing rows had null `source_id`.)
- `DROP COLUMN token_count` — column was added but never populated.
- HNSW index over `(embedding::halfvec(3072)) halfvec_cosine_ops` with `m=16, ef_construction=64`.
- `match_source_chunks` RPC updated to cast both query and stored vectors to `halfvec(3072)` so the index is hit. Verified via `EXPLAIN`: query plan shows `Index Scan using source_chunks_embedding_halfvec_idx`.

### Indexes on `source_chunks`

```
knowledge_source_chunks_pkey            UNIQUE btree (id)
source_chunks_source_chunk_idx_uniq     UNIQUE btree (source_id, chunk_index)
chunks_user_id_idx                      btree (user_id)
chunks_source_id_idx                    btree (source_id)
source_chunks_embedding_halfvec_idx     hnsw ((embedding::halfvec(3072)) halfvec_cosine_ops)
```

### Foreign keys

```
source_id → knowledge_sources(id) ON DELETE CASCADE
```

---

## Backfill

Two artefacts:
- Production HTTP endpoint: [api/content/backfill-chunks.ts](../api/content/backfill-chunks.ts) — resumable, idempotent, processes up to 50 sources per call. Cron-callable.
- One-shot script: [scripts/backfill-chunks-stage3.ts](../scripts/backfill-chunks-stage3.ts) — used to clear the existing dataset.

### Selection criteria

A source is processed if it has ≥200 chars of content AND any of:
- zero rows in `source_chunks`
- any chunk with `embedding IS NULL`
- `status` is anything other than `complete` (i.e. `failed`, `degraded`, `pending`)

### Run results — 2026-04-27

```
candidates examined:  601
sources processed:     62
chunks written:     1,360
backfilled:            62
degraded:               0
failed:                 0
duration:           243 s
```

Replay test: re-run on the same dataset produced 0 sources to process. Idempotency confirmed.

---

## Validation suite results

| Check | Before Stage 3 | After Stage 3 |
|---|---|---|
| Sources with content but zero chunks | 58 | **0** |
| Chunks with null embedding | 20 | **0** |
| Duplicate `(source_id, chunk_index)` groups | 61 | **0** |
| Total chunks | 7,108 | 8,312 |
| Sources with chunks | 534 | 593 |
| HNSW index used by `match_source_chunks` | n/a (no index) | **Yes** (`EXPLAIN` plan confirms) |
| Replay backfill on clean dataset | n/a | **0 changes** |

Chunk size distribution after Stage 3: median 1,946 chars, p95 2,105 chars, max 22,525 (54 chunks >4,000 chars are legacy from the old chunker — see Open below).

---

## Open follow-ups

Items intentionally left for later. Not Stage 3 blockers.

- **Re-chunk legacy oversize chunks.** 54 chunks exceed 4,000 chars; they pre-date the hard ceiling. Run a targeted re-chunk against the affected sources when convenient. Low priority — retrieval quality is degraded but not broken on these.
- **CLAUDE.md / Stage 0 doc dimension fix.** Updated as part of this stage. Verify nothing else in `docs/` still cites 768-dim.
- **Stage 1 follow-up: Markdown-structured output from adapters.** Stage 3's structural-first splitter prefers Markdown headings, but Stage 1 adapters currently return mostly plain text. If the file/URL/YouTube adapters returned Markdown with section headings or speaker labels, chunk quality would improve for free. Logged under Stage 1 Open list.
- **Browser-side batch embedding.** `src/services/gemini.ts:generateEmbeddings` still does concurrency-5 `:embedContent` calls. The serverless `embedTexts` batch endpoint would be faster, but at browser scale this is not currently a bottleneck.

---

## Decisions

- **D-007 (2026-04-27) — halfvec HNSW index.** Use pgvector `halfvec(3072)` with `halfvec_cosine_ops` as an expression index. Reason: `vector_cosine_ops` HNSW caps at 2,000 dims; `halfvec_cosine_ops` supports up to 4,000. Half-precision halves storage with negligible recall impact. RPC casts on both sides so queries hit the index.
- **D-008 (2026-04-27) — embed `title + chunk` rather than chunk alone.** One-line reason: cheap, deterministic, improves retrieval for short or vague chunks.
- **D-009 (2026-04-27) — chunking is fatal, embedding is degraded.** Surface gaps explicitly. No more silent partial saves.

---

## Files touched

- [src/utils/chunking.ts](../src/utils/chunking.ts) — canonical chunker.
- [api/pipeline/extract-pipeline.ts](../api/pipeline/extract-pipeline.ts) — `chunkText` + `saveTranscriptChunks` rewritten.
- [api/content/backfill-chunks.ts](../api/content/backfill-chunks.ts) — full rewrite.
- [src/hooks/useExtraction.ts](../src/hooks/useExtraction.ts) — chunking fatal, embedding degraded.
- [src/services/extractionPipeline.ts](../src/services/extractionPipeline.ts) — same.
- [src/services/manualSignals.ts](../src/services/manualSignals.ts) — anchor briefs now embed.
- [src/services/extractionPersistence.ts](../src/services/extractionPersistence.ts) — `saveChunks` now upserts and rejects null-embedding rows.
- [scripts/backfill-chunks-stage3.ts](../scripts/backfill-chunks-stage3.ts) — one-shot backfill.
- Migration: `stage3_chunks_constraints_and_index` (applied 2026-04-27).
