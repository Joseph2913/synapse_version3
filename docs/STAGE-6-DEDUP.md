# Stage 6 — Deduplication + Merge

**Status:** Done
**Shipped:** 2026-04-28 (Block 2)
**Commit:** `b8a8d16` (squash merge of `feat/block-2-extraction-consolidation`)

---

## What this stage owns

Before newly extracted entities are written to `knowledge_nodes`, each one is checked against existing nodes. Exact matches, near-fuzzy matches, and semantically similar matches are handled differently: auto-merged, queued for human review, or passed through as new.

---

## Architecture

### Before Block 2 (eliminated)

Two divergent dedup paths existed:
- **Browser:** `src/services/deduplication.ts:checkDeduplication()` called the `find_similar_nodes` RPC, which returns cosine-similar nodes above a threshold. Simple similarity check, no Levenshtein fuzzy tier.
- **Serverless:** `api/pipeline/extract-pipeline.ts:deduplicateEntities()` called the `check_node_duplicate` RPC, which applies three tiers. Inline threshold literals (0.85, 0.80, 0.88) with no named constants.

### After Block 2 (current)

`checkDeduplication()` deleted. `deduplicateEntities()` in `api/pipeline/extract-pipeline.ts` is the single canonical dedup path, called from both:
- `api/ingest/extract-persist` (interactive path)
- `api/pipeline/extract-pipeline.ts:runExtractionCore()` (headless path)

---

## Threshold constants

Defined in `api/pipeline/extract-pipeline.ts`:

| Constant | Value | Meaning |
|---|---|---|
| `DEDUP_EXACT_THRESHOLD` | `0.85` | Levenshtein fuzzy match threshold — labels within this edit distance are considered the same entity |
| `DEDUP_SEMANTIC_THRESHOLD` | `0.80` | Cosine similarity floor — embeddings below this are never auto-merged |
| `DEDUP_AUTO_MERGE_THRESHOLD` | `0.88` | Cosine similarity ceiling — embeddings above this trigger auto-merge without human review |

The band between `DEDUP_SEMANTIC_THRESHOLD` (0.80) and `DEDUP_AUTO_MERGE_THRESHOLD` (0.88) writes to the `potential_duplicates` table for human review.

---

## `check_node_duplicate` RPC — three tiers

1. **Exact match** — `LOWER(TRIM(label)) = LOWER(TRIM(p_label))` and same `entity_type`. Returns `match_type = 'exact'`, `similarity = 1.0`.
2. **Levenshtein fuzzy** — edit distance within ±3 chars of label length, normalised similarity ≥ `p_exact_threshold` (0.92 default). Returns `match_type = 'fuzzy'`.
3. **Semantic cosine** — `1 - (embedding <=> p_embedding) > p_semantic_threshold` (0.88 default). Returns `match_type = 'semantic'`.

Migration `20260329_anchor_dedup_fixes.sql` defines this RPC with full three-tier logic.

---

## Merge enrichment rules

When `deduplicateEntities` auto-merges a new entity into an existing canonical node:

- **Description:** keep whichever is longer.
- **Aliases:** append the incoming label if not already present.
- **Occurrence count:** sum the two counts.
- **Confidence:** take the maximum.
- **Anchor status:** if either is an anchor, the merged node is an anchor.

---

## What remains in `src/services/deduplication.ts`

The browser-side service was stripped of all extraction-path dedup logic but retains the UI-facing helpers used by the duplicate management views:
- `savePotentialDuplicates` — write near-matches to the queue
- `mergeNodes` — user-confirmed merge action
- `fetchPendingDuplicates` — load the near-match review queue
- `keepSeparate` — dismiss a near-match pair

---

## `find_similar_nodes` RPC — retained for anchor scoring

`api/anchors/score-post-extraction.ts` still calls `find_similar_nodes` to find nodes semantically related to anchors for signal computation. This is a different query shape from entity dedup (no exact/fuzzy tiers, used to build the anchor "related nodes" list). It is not part of the extraction pipeline.

---

## Open follow-ups

- `src/services/manualSignals.ts:createManualAnchor` calls `generateEmbeddings` from `src/services/gemini.ts` for anchor brief chunking. This is not an extraction path call — it generates embeddings for the anchor's brief text chunks. Out of Block 2 scope; tracked for Stage 9.

---

## Decisions

- **D-B2-03** — `check_node_duplicate` RPC is canonical dedup; `find_similar_nodes` is retained for anchor scoring only
