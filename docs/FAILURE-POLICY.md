# Failure-handling Policy

**Purpose.** Every stage of the 13-stage source-ingestion pipeline gets one rule for how it handles failure. No stage decides for itself. No catch block makes ad-hoc choices.

**Owner:** Joseph Thomas
**Created:** 2026-04-26
**Stage:** Stage 0 — Item 5

---

## The three rules

| Rule | Meaning | Source-level outcome |
|---|---|---|
| **Fatal** | Stage failed → no useful work to keep → throw out the source. | `knowledge_sources.status = 'failed'` |
| **Degraded** | Stage failed → previous stages produced useful work → keep what we have, mark the source as having gaps. | `knowledge_sources.status = 'degraded'` |
| **Skip-with-telemetry** | Stage failed → it was a non-essential enrichment → log loudly, move on. | Source still reaches `'complete'`. Failure logged via `logError()` for retry. |

Every **failure-handling** catch block in `api/` must end in one of those three outcomes. Silent `catch { /* ignore */ }` is forbidden going forward.

**Exception — control-flow catches.** Two patterns are *not* failure handlers and may stay silent:

1. **Auth probe fall-throughs.** Helpers that try multiple auth strategies in sequence (`auth.getUser(token)` → next strategy on throw) use `catch { /* fall through */ }` because the throw is expected on bad/missing tokens. These fire on every unauthenticated request. Logging them as errors would flood logs with non-events.
2. **Defensive parse fallbacks.** `try { return JSON.parse(raw) } catch { return [] }` where the empty/null default is the documented behaviour for malformed input. The catch is part of input validation, not error handling.

Both exceptions must be marked with the comment `/* fall through */` (auth) or `/* ignore parse errors */` (validation) so a future reviewer can tell them apart from real silent swallows. Anything else that swallows an error is a bug.

---

## Per-stage policy

| # | Stage | Rule | Why |
|---|---|---|---|
| 1 | **Capture** (paste, URL, file, YouTube webhook, meeting webhook) | **Fatal** | If we can't even capture the source, there's nothing to save. Reject at the entry point. |
| 2 | **Persist** (write `knowledge_sources` row) | **Fatal** | If the source row can't be created, downstream stages have nothing to attach to. |
| 3 | **Chunk + chunk embeddings** | **Degraded** | If chunking fails, we keep the source but skip semantic-search ability. Source is queryable by metadata; chunks can be backfilled. |
| 4 | **Prompt composition** | **Fatal** | A bad prompt means extraction will be garbage. Stop and log. |
| 5 | **Entity extraction** | **Fatal** | The whole point of the pipeline is entities. If extraction fails, mark `'failed'`. The source row stays so we can retry. |
| 6 | **Deduplication + merge** | **Degraded** | If dedup fails, we keep all extracted entities (some duplicates). The graph is noisy but usable. Backfill job cleans up later. |
| 7 | **Knowledge persistence** (insert nodes + edges) | **Fatal** | If we can't write the entities, the source has no knowledge attached. Roll back. |
| 8 | **Cross-connection discovery** | **Skip-with-telemetry** | Cross-connections are enrichment. Source is fully usable without them. Log and move on; nightly retry job picks up failures. |
| 9 | **Anchor scoring** | **Skip-with-telemetry** | Anchor scoring boosts relevance but isn't required. Log; retry on next cron. |
| 10 | **Skills detection** | **Skip-with-telemetry** | Skills are a derived feature on top of entities. Failure means no skills detected for this source; cron rescans. |
| 11 | **Council updates** | **Skip-with-telemetry** | Council index update is downstream of ingestion. Failure does not affect the source. Cron rebuilds. |
| 12 | **Extraction session audit** | **Skip-with-telemetry** | Audit metadata. Useful for debugging but not user-facing. Log and move on. |
| 13 | **Surfacing** (RAG, MCP, activity feed) | **Skip-with-telemetry** | Surfacing failures are read-side. Log; user retries the query. |

---

## Source state machine

```
   pending  ──────────►  chunking  ──────────►  extracting  ──────────►  augmenting  ──────────►  complete
      │                     │                       │                        │
      │                     │                       │                        │
      ▼                     ▼                       ▼                        ▼
   failed              failed                   failed                   degraded
```

- **pending** — row created, no work done yet.
- **chunking** — chunking + chunk embeddings in progress (Stage 3).
- **extracting** — entity extraction + persistence in progress (Stages 4–7).
- **augmenting** — cross-connections, anchor scoring, skills, council, audit (Stages 8–12).
- **complete** — all stages succeeded, including skip-with-telemetry stages (which log but don't block).
- **degraded** — at least one Degraded-rule stage (Stages 3 or 6) failed but the source has enough useful data to surface.
- **failed** — a Fatal-rule stage failed. The source is unusable. Manual retry or backfill required.

---

## How this is enforced in code

1. **Schema.** `knowledge_sources` gains a `status` column with the values above. Migration: `20260427_knowledge_sources_status.sql`.
2. **Helper.** Every backend file uses `log()` and `logError()` (Item 4 helpers). Errors include the `stage` field from the 13-stage taxonomy plus `status: 'failed' | 'degraded' | 'skipped'`.
3. **Catch-block discipline.** No `catch { /* ignore */ }`. Every catch logs structured (via `logError`) AND either:
   - **Fatal stages:** updates `knowledge_sources.status = 'failed'` and rethrows so upstream halts.
   - **Degraded stages:** updates `knowledge_sources.status = 'degraded'` and continues.
   - **Skip-with-telemetry stages:** logs and continues. Source status untouched.

---

## Operational consequences

Once this lands and Items 4 + 5 are both wired up, the following queries become possible against Vercel logs and the database:

```sql
-- Health snapshot
SELECT status, count(*) FROM knowledge_sources
WHERE created_at > now() - interval '7 days'
GROUP BY status;

-- Degraded sources awaiting backfill
SELECT id, title, source_type, created_at FROM knowledge_sources
WHERE status = 'degraded' ORDER BY created_at DESC;

-- Failure rate by source type
SELECT source_type,
       sum(case when status='failed' then 1 else 0 end)::float / count(*) AS failure_rate
FROM knowledge_sources
WHERE created_at > now() - interval '30 days'
GROUP BY source_type;
```

```
# Vercel log filters
filter level=error AND status=failed
filter level=error AND stage=cross-connect AND status=skipped
filter status=degraded
```

A nightly **retry job** (separate task, Stage 8/9/10/11 owners) picks up sources where `status = 'degraded'` and attempts to complete the missing stages. Successful retries flip the status to `'complete'`.

---

## Migration policy for the existing codebase

The 145 existing catch blocks are not all rewritten in one pass. Stage 0 Item 5:

1. Adds the schema column with a default of `'complete'` (so existing rows are valid).
2. Documents the policy.
3. Replaces the **silent catches** (`catch { /* ignore */ }` and `catch { /* fall through */ }`) with structured `logError()` calls. These are the highest-risk catches because today they hide real failures.
4. **Does not** rewrite every catch to update source status — that work happens stage-by-stage as each pipeline stage is hardened (Stages 1–13). The policy in this doc is the contract those passes implement.

This avoids a high-risk shotgun rewrite while still closing the silent-failure hole today.
