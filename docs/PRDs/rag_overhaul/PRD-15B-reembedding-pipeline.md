# PRD-15B: Re-Embedding Pipeline + Persistence Fix

> **CORRECTION (March 17, 2026):** This PRD references the table name `knowledge_source_chunks`. The table has been renamed to `source_chunks` to match the application code. The re-embedding script (`scripts/reembed-all.mjs`) has been updated accordingly. See `supabase/migrations/20260317_rename_source_chunks_fix_rpcs.sql` for the migration.

## Overview

After the schema migration in PRD-15A, all embedding columns are NULL. This PRD builds a re-embedding pipeline that generates fresh 3072-dimensional embeddings for all existing source chunks and knowledge nodes using `gemini-embedding-001`, and fixes the application code so future ingestions store embeddings correctly.

## Prerequisites

- **PRD-15A must be complete.** Both `knowledge_nodes.embedding` and `knowledge_source_chunks.embedding` must be `vector(3072)` columns with all values NULL.
- The Gemini API key (in `.env.local` as `VITE_GEMINI_API_KEY`) must have access to `gemini-embedding-001`.

## Context for AI Coding Agent

**Current state after PRD-15A:**
- `knowledge_source_chunks`: 1,171 rows, all embeddings NULL
- `knowledge_nodes`: 2,495 rows, all embeddings NULL
- Both columns are `vector(3072)` type
- `match_source_chunks` and `match_knowledge_nodes` RPC functions exist and expect 3072-dim vectors

**Embedding model details:**
- Model: `gemini-embedding-001`
- Output dimensions: 3072
- API endpoint: `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent`
- Request body:
  ```json
  {
    "model": "models/gemini-embedding-001",
    "content": { "parts": [{ "text": "your text here" }] }
  }
  ```
- Response: `response.embedding.values` → `number[]` of length 3072
- Rate limits: Be conservative — max 5 concurrent requests, exponential backoff on HTTP 429

**CRITICAL — Table name:** The chunks table is `knowledge_source_chunks`, NOT `source_chunks`.

**CRITICAL — Embedding text format:**
- For source chunks: embed the `content` field directly
- For knowledge nodes: embed `"${label}: ${description}"` (this matches the existing convention used throughout the codebase)

---

## Deliverable 1: Fix `extractionPersistence.ts` — Remove JSON.stringify

**File:** `src/services/extractionPersistence.ts`

The current code wraps embeddings in `JSON.stringify()` before sending to Supabase. When the column was `vector(768)`, PostgreSQL may have been silently coercing the string. With `vector(3072)`, this could cause issues. The Supabase JS client can pass a raw JavaScript `number[]` directly to a `vector` column — no serialization needed.

### Changes Required

Find every location where an embedding is saved to Supabase and remove `JSON.stringify()` wrapping. The specific patterns to find and fix:

**Pattern 1 — Node embedding updates:**
```typescript
// FIND this pattern (may vary slightly):
.update({ embedding: JSON.stringify(n.embedding) })

// REPLACE with:
.update({ embedding: n.embedding })
```

**Pattern 2 — Chunk embedding inserts:**
```typescript
// FIND this pattern (may vary slightly):
row.embedding = JSON.stringify(embeddings[i])

// REPLACE with:
row.embedding = embeddings[i]
```

**Search strategy:** Search the entire `src/` directory for `JSON.stringify` combined with `embedding` to catch any other instances:
```bash
grep -rn "JSON.stringify.*embedding\|embedding.*JSON.stringify" src/
```

Fix every instance found. Embeddings should always be passed as raw `number[]` to Supabase.

### Also Check: Embedding Model Reference

Search for any hardcoded references to `text-embedding-004` in the codebase and update them to `gemini-embedding-001`:
```bash
grep -rn "text-embedding-004" src/
```

If the embedding model is referenced in `services/gemini.ts` or similar, update it to `gemini-embedding-001`. The embedding dimension constant should also be updated from 768 to 3072 if it exists anywhere.

---

## Deliverable 2: Re-Embedding Script

Create a standalone Node.js script that can be run from the command line to re-embed all existing data. This is a one-time operation but should be built with resume capability in case it's interrupted.

**File:** `scripts/reembed-all.ts` (or `scripts/reembed-all.mjs` if TypeScript compilation is not set up for scripts)

### Script Requirements

**Environment:**
- Reads `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, and `VITE_GEMINI_API_KEY` from `.env.local`
- Uses `@supabase/supabase-js` for database access
- Uses `fetch` for Gemini API calls (Node 18+ has built-in fetch)

**Authentication:**
- The script needs to read data across all users for re-embedding
- Use the Supabase **service role key** (not the anon key) to bypass RLS, OR
- If service role key is not available, the script should accept a `--user-id` flag and process one user at a time using the anon key with auth headers
- Document both approaches in the script comments

**Processing Flow:**

```
Phase 1: Re-embed source chunks
  1. SELECT id, content FROM knowledge_source_chunks WHERE embedding IS NULL ORDER BY id
  2. Process in batches of 20
  3. For each chunk: call gemini-embedding-001 with chunk.content
  4. UPDATE knowledge_source_chunks SET embedding = <vector> WHERE id = <id>
  5. Log progress: "[Chunks] 20/1171 complete (1.7%)"
  6. On HTTP 429: exponential backoff (1s, 2s, 4s, max 30s)
  7. On other error: log error, skip row, continue

Phase 2: Re-embed knowledge nodes
  1. SELECT id, label, description FROM knowledge_nodes WHERE embedding IS NULL ORDER BY id
  2. Process in batches of 20
  3. For each node: call gemini-embedding-001 with "${label}: ${description || ''}"
  4. UPDATE knowledge_nodes SET embedding = <vector> WHERE id = <id>
  5. Log progress: "[Nodes] 20/2495 complete (0.8%)"
  6. Same error handling as Phase 1
```

**Resume Capability:**
- The `WHERE embedding IS NULL` clause naturally provides resume capability — if the script is interrupted and restarted, it picks up where it left off since completed rows already have embeddings.
- Log the last processed ID so the operator can see where it stopped.

**Concurrency:**
- Process each batch of 20 with up to 5 concurrent API calls (use `Promise.all` with a concurrency pool)
- Wait 200ms between batches to stay well under rate limits
- On 429 errors, pause all concurrent work and back off

**Progress Reporting:**
- Print a summary line every batch:
  ```
  [Chunks] 40/1171 (3.4%) — 2 errors, 0 skipped — elapsed: 12s
  [Chunks] 60/1171 (5.1%) — 2 errors, 0 skipped — elapsed: 18s
  ```
- At completion, print final summary:
  ```
  === Re-embedding Complete ===
  Source chunks: 1171 embedded, 0 failed
  Knowledge nodes: 2495 embedded, 0 failed
  Total time: 14m 32s
  ```

### Embedding Function

```typescript
async function embedText(text: string, apiKey: string): Promise<number[] | null> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent?key=${apiKey}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'models/gemini-embedding-001',
      content: { parts: [{ text }] }
    })
  });

  if (response.status === 429) {
    throw new Error('RATE_LIMITED');
  }

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Gemini API error ${response.status}: ${errText.substring(0, 200)}`);
  }

  const data = await response.json();
  const values = data?.embedding?.values;

  if (!Array.isArray(values) || values.length !== 3072) {
    throw new Error(`Unexpected embedding dimensions: ${values?.length}`);
  }

  return values;
}
```

### Running the Script

Add a script entry to `package.json`:
```json
{
  "scripts": {
    "reembed": "npx tsx scripts/reembed-all.ts"
  }
}
```

Or if using plain Node:
```bash
node --env-file=.env.local scripts/reembed-all.mjs
```

**Ensure `tsx` is available** (install with `npm install -D tsx` if needed).

---

## Deliverable 3: Validation

After the script completes, run these SQL queries to verify:

```sql
-- 1. All chunks should have embeddings
SELECT
  COUNT(*) as total,
  COUNT(embedding) as embedded,
  COUNT(*) - COUNT(embedding) as missing
FROM knowledge_source_chunks;
-- Expected: missing = 0

-- 2. All nodes should have embeddings
SELECT
  COUNT(*) as total,
  COUNT(embedding) as embedded,
  COUNT(*) - COUNT(embedding) as missing
FROM knowledge_nodes;
-- Expected: missing = 0

-- 3. Verify dimensions are 3072 (sample check)
SELECT
  pg_typeof(embedding) as type,
  array_length(embedding::real[], 1) as dimensions
FROM knowledge_source_chunks
WHERE embedding IS NOT NULL
LIMIT 1;
-- Expected: type = vector, dimensions = 3072

SELECT
  pg_typeof(embedding) as type,
  array_length(embedding::real[], 1) as dimensions
FROM knowledge_nodes
WHERE embedding IS NOT NULL
LIMIT 1;
-- Expected: type = vector, dimensions = 3072

-- 4. Test the RPC functions work with real data
-- (Replace the user_id with your actual user ID)
SELECT id, content, similarity
FROM match_source_chunks(
  (SELECT embedding FROM knowledge_source_chunks WHERE embedding IS NOT NULL LIMIT 1),
  0.5,
  5,
  (SELECT user_id FROM knowledge_source_chunks LIMIT 1)
);
-- Expected: Returns up to 5 rows with similarity scores > 0.5
```

---

## Estimated Execution Time

| Phase | Items | Est. Time |
|---|---|---|
| Fix `extractionPersistence.ts` | Code change | 5 minutes |
| Fix embedding model references | Code change | 5 minutes |
| Re-embed source chunks | 1,171 items | ~5-7 minutes |
| Re-embed knowledge nodes | 2,495 items | ~10-13 minutes |
| Validation | SQL queries | 2 minutes |
| **Total** | | **~25-30 minutes** |

## What This PRD Does NOT Do

- Does NOT modify the RAG pipeline in `rag.ts` (that's PRD-15C)
- Does NOT add semantic search to the `supabase.ts` service layer (that's PRD-15C)
- Does NOT change the database schema (that was PRD-15A)
- Does NOT modify any UI components

## Risk Notes

- **API rate limits:** The script may hit Gemini's rate limits if run too aggressively. The 5-concurrent + 200ms-between-batches approach should avoid this, but monitor for 429 errors.
- **Cost:** `gemini-embedding-001` is a paid API. ~3,666 embedding calls at current pricing is minimal (fractions of a cent per call).
- **Partial completion:** If the script fails partway through, simply rerun it — the `WHERE embedding IS NULL` clause means it will resume from where it stopped.
- **Supabase anon key limitation:** If using the anon key, the script can only update rows belonging to the authenticated user. If you have multiple users, you'll need the service role key or run the script once per user.
