# Stage 9 — Anchor Scoring

**Status:** Done. Shipped 2026-04-28.
**Pipeline log entry:** [PIPELINE-IMPLEMENTATION-LOG.md § Stage 9](PIPELINE-IMPLEMENTATION-LOG.md)

---

## What this stage does

Anchor scoring is the background process that watches the knowledge graph and identifies which nodes are important enough to become *anchors* — user-defined focal points that shape extraction, RAG retrieval, and graph navigation.

There are two complementary mechanisms:

1. **Candidate scoring** — nodes with high composite scores are promoted from `suggested` → `confirmed` anchor candidates, or downgraded/archived based on their score trend and lifecycle state.
2. **Anchor graph wiring** — confirmed anchors get their edges to the wider graph established (`on-confirm.ts`) and are periodically checked for sub-anchor relationships (`spawn-sub-anchors.ts`).

---

## Files

| File | Role |
|---|---|
| `api/anchors/score-daily.ts` | Daily cron: score all candidates for all users, run lifecycle transitions |
| `api/anchors/rescore-backfill.ts` | One-off backfill: re-score every node for a given user |
| `api/anchors/score-post-extraction.ts` | Fire-and-forget hook: score new nodes after each extraction |
| `api/anchors/on-confirm.ts` | Called when user confirms an anchor: wires edges to unconnected nodes via Gemini |
| `api/anchors/spawn-sub-anchors.ts` | Promotes high-affinity suggested candidates as sub-anchors under root anchors |
| `api/anchors/dedup-scan.ts` | Finds duplicate clusters and queues them in `potential_duplicates` for review |
| `supabase/migrations/20260428_anchor_scoring_bulk_ops.sql` | UNIQUE constraint + two bulk RPCs |

---

## Signal formulas (D-S9-02)

Composite score = weighted sum of five signals. All signals normalise to [0, 1].

### S1 — Momentum / velocity (weight: 0.30)

```
score = Σ occurrences[i] × exp(−daysDiff[i] × ln(2) / 7)
```

Exponential half-life of 7 days. A node mentioned daily this week scores near 1.0; a node last seen 30 days ago scores near 0.

### S2 — Centrality (weight: 0.25)

```
score = min(directEdgeCount / maxDegree, 1.0)   where maxDegree = min(userMaxDegree, 50)
```

Measures how central the node is in the graph. Capped at 50 to prevent hub nodes from monopolising the scoring space.

### S3 — Diversity (weight: 0.20)

```
score = min(distinctEntityTypesInNeighbourhood / 6, 1.0)
```

Rewards nodes whose immediate neighbours span multiple entity types (Person, Topic, Project, Goal, …). Anchors that bridge domains are more useful than anchors deep within a single domain.

### S4 — Richness (weight: 0.15)

```
score = (has_description ? 0.5 : 0) + clamp(description.length / 500, 0, 0.5)
```

A tiebreaker for descriptive quality. A well-described node is more likely to be a meaningful concept than a bare label.

### S5 — Behavioural (weight: 0.10)

Reserved. Currently contributes 0. Intended for explicit user signals: manual promotes, RAG query hits, in-session views. Will be wired in a future phase without changing the other signal weights.

---

## Lifecycle transitions (D-S9-03)

`runLifecycleTransitions()` in `score-daily.ts` applies six rules in order. Each rule has its own time-budget guard (breaks at 100 s wall time).

| # | Rule | Trigger | Action |
|---|---|---|---|
| 1 | Suggested cleanup | `node_id` no longer in `knowledge_nodes` | Delete candidate row |
| 2 | Confirmed → dormant | No edge activity for 90 days | `status = 'dormant'` via `bulk_anchor_dormancy_transitions` |
| 3 | Dormant → reactivated | New edge activity in past 14 days | `status = 'confirmed'` via `bulk_anchor_dormancy_transitions` |
| 4 | Dismissed → resurfaced | `composite_score > 0.70` | `status = 'suggested'` (re-queue for user review) |
| 5 | Heal | `knowledge_node.is_anchor = false` on a confirmed anchor | Set `is_anchor = true` (self-heal schema drift) |
| 6 | Auto-archive | `status = 'dismissed'` for > 180 days AND node no longer exists | `status = 'archived'` |

---

## Bulk RPCs (D-S9-04, D-S9-05)

### `bulk_upsert_anchor_candidates(p_user_id UUID, p_candidates JSONB)`

Single SQL upsert for an entire scoring run. Status-protection CASE logic:

- `dismissed`, `archived`, `dormant`, `confirmed` rows: update score fields only, preserve status.
- `pending`, `suggested` rows: allow status promotion (e.g. `suggested` → `confirmed`).

A CTE at the end of the same transaction propagates `is_anchor = true` on `knowledge_nodes` for any candidate whose new status is `confirmed`.

Requires `UNIQUE (user_id, node_id)` on `anchor_candidates` — added by the same migration.

### `bulk_anchor_dormancy_transitions(p_user_id UUID, p_dormant_cutoff TIMESTAMPTZ)`

Two SQL UPDATEs:

1. **Confirmed → dormant**: sets `status = 'dormant'` for confirmed anchors with no `knowledge_edge` touching the anchor's `node_id` since `p_dormant_cutoff`. Uses `NOT EXISTS`.
2. **Dormant → confirmed**: sets `status = 'confirmed'` for dormant anchors with at least one `knowledge_edge` touching the anchor's `node_id` since `now() - 14 days`. Uses `EXISTS`.

Returns `{ dormant_count, reactivated_count }` JSON. Replaces what was previously a Python-style `for anchor of confirmed:` loop with two single-pass SQL statements.

---

## Async-only policy (D-S9-01)

`score-post-extraction.ts` is never awaited by its callers. Every extraction pipeline endpoint fires it as fire-and-forget:

```ts
fetch('/api/anchors/score-post-extraction', { method: 'POST', ... })
// no await
```

Rationale: scoring 500+ candidates requires fetching all edges for the user, computing five signals per node, and calling a bulk RPC. This takes 5–30 s. Blocking the extraction completion response on it is not acceptable.

`score-daily.ts` runs on a Vercel cron schedule (daily). It is the primary path for scoring all users. `score-post-extraction.ts` is an opportunistic fast-path that scores only the nodes extracted in the current session.

---

## Failure policy

Stage 9 = **Skip-with-telemetry** per `FAILURE-POLICY.md`.

- Scoring failures → `logError()` + return 200 with `{ success: true, promoted: 0 }`.
- Source `status` in `knowledge_sources` is never set to `failed` or `degraded` by any anchor file.
- `on-confirm.ts` and `spawn-sub-anchors.ts` log failures per-node but continue processing remaining nodes.

---

## Structured logging

All log lines use `stage: 'anchor'`. Key fields:

| Event | Fields |
|---|---|
| Per-user scoring complete | `stage, user_id, status, candidates_scored, promoted, duration_ms` |
| Lifecycle transitions | `stage, user_id, status, dormant_count, reactivated_count, duration_ms` |
| Sub-anchor promoted | `stage, user_id, status:'ok', sub_anchor, parent, affinity, inherited_edges` |
| Edge wiring complete | `stage, user_id, status:'ok', node_id, edges_created, duration_ms` |
| Skipped (no candidates) | `stage, user_id, status:'skipped', message` |
| Any failure | `logError({ stage:'anchor', user_id, error, duration_ms })` |
