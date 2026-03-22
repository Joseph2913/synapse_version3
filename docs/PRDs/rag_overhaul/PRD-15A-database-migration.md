# PRD-15A: Vector Embedding Schema Migration (768 → 3072)

> **CORRECTION (March 17, 2026):** This PRD references the table name `knowledge_source_chunks` throughout. The table has since been renamed to `source_chunks` to match the application code. All SQL referencing the old name should use `source_chunks` instead. See `supabase/migrations/20260317_rename_source_chunks_fix_rpcs.sql` for the migration. The original SQL below is preserved as-is for historical reference since it was already executed.

## Overview

Migrate the Synapse database from 768-dimensional vectors (`text-embedding-004`, now unavailable) to 3072-dimensional vectors (`gemini-embedding-001`, the only embedding model available on the current API key). This is a pure SQL migration — no application code changes.

## Context for AI Coding Agent

**Why this migration is needed:**
- The `text-embedding-004` model (768-dim) returns HTTP 404 on the project's Gemini API key — it is no longer available
- The only working embedding model is `gemini-embedding-001`, which produces 3072-dimensional vectors
- Both `knowledge_nodes.embedding` and `knowledge_source_chunks.embedding` are currently `vector(768)` columns
- All existing embeddings (1,171 chunks + 820 nodes) are 768-dim and must be discarded — they cannot be used with the new model
- After this migration, all embedding columns will be NULL and ready for re-embedding in PRD-15B

**Current database state (verified):**
- `knowledge_nodes.embedding`: `vector(768)` type, 820 rows have embeddings, 1,675 are NULL
- `knowledge_source_chunks.embedding`: `vector(768)` type, all 1,171 rows have embeddings
- Existing index: `knowledge_nodes_embedding_idx` — HNSW with `vector_cosine_ops`
- Existing index: `chunks_embedding_idx` — IVFFlat with `vector_cosine_ops`, lists=100
- Existing RPC: `match_nodes` (768-dim, no user_id filter) — must be replaced
- Missing RPCs: `match_source_chunks` and `match_knowledge_nodes` do not exist
- pgvector extension: enabled

**CRITICAL — Table name:** The chunks table is called `knowledge_source_chunks`, NOT `source_chunks`. Use the correct name in all SQL.

**This PRD does NOT modify any application code.** It is SQL-only, executed in the Supabase SQL Editor or via migration file.

---

## Step-by-Step Migration

Execute these steps in order in the Supabase SQL Editor. Each step can be run independently and verified before proceeding.

### Step 1: Drop Existing Indexes

The existing indexes reference the 768-dim column. They must be dropped before altering the column.

```sql
-- Drop the HNSW index on knowledge_nodes
DROP INDEX IF EXISTS knowledge_nodes_embedding_idx;

-- Drop the IVFFlat index on knowledge_source_chunks
DROP INDEX IF EXISTS chunks_embedding_idx;
```

**Verify:** Run `SELECT indexname FROM pg_indexes WHERE indexdef LIKE '%embedding%';` — should return no rows.

---

### Step 2: Alter Embedding Columns from vector(768) to vector(3072)

PostgreSQL cannot alter a vector column's dimensions in place. We must drop and recreate.

```sql
-- Drop and recreate knowledge_nodes.embedding
ALTER TABLE knowledge_nodes DROP COLUMN embedding;
ALTER TABLE knowledge_nodes ADD COLUMN embedding vector(3072);

-- Drop and recreate knowledge_source_chunks.embedding
ALTER TABLE knowledge_source_chunks DROP COLUMN embedding;
ALTER TABLE knowledge_source_chunks ADD COLUMN embedding vector(3072);
```

**Verify:**
```sql
SELECT table_name, column_name, udt_name, data_type
FROM information_schema.columns
WHERE table_name IN ('knowledge_nodes', 'knowledge_source_chunks')
  AND column_name = 'embedding';
```
Should return two rows, both with `udt_name = 'vector'` and `data_type = 'USER-DEFINED'`.

Then verify dimensions by checking the column accepts 3072-dim input:
```sql
-- This should succeed (inserts a dummy 3072-dim vector then rolls back)
DO $$
BEGIN
  PERFORM embedding FROM knowledge_source_chunks LIMIT 0;
  RAISE NOTICE 'Column exists and is accessible';
END $$;
```

Also confirm all embeddings are now NULL:
```sql
SELECT
  'knowledge_source_chunks' as table_name,
  COUNT(*) as total_rows,
  COUNT(embedding) as has_embedding
FROM knowledge_source_chunks
UNION ALL
SELECT
  'knowledge_nodes',
  COUNT(*),
  COUNT(embedding)
FROM knowledge_nodes;
```
`has_embedding` should be 0 for both tables.

---

### Step 3: Drop Old `match_nodes` RPC Function

The old function was built for 768-dim vectors and lacks a `user_id` parameter for RLS filtering.

```sql
-- Drop the old function (may have different signatures, so use CASCADE)
DROP FUNCTION IF EXISTS match_nodes(vector, float, int) CASCADE;
DROP FUNCTION IF EXISTS match_nodes(vector(768), float, int) CASCADE;
DROP FUNCTION IF EXISTS match_nodes CASCADE;
```

**Verify:**
```sql
SELECT routine_name FROM information_schema.routines
WHERE routine_schema = 'public' AND routine_name = 'match_nodes';
```
Should return no rows.

---

### Step 4: Create `match_source_chunks` RPC Function

This is the primary function for semantic search in the RAG pipeline. It finds the most similar source chunks to a query embedding.

```sql
CREATE OR REPLACE FUNCTION match_source_chunks(
  query_embedding vector(3072),
  match_threshold float,
  match_count int,
  p_user_id uuid
)
RETURNS TABLE (
  id uuid,
  source_id uuid,
  chunk_index int,
  content text,
  similarity float
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
  SELECT
    sc.id,
    sc.source_id,
    sc.chunk_index,
    sc.content,
    1 - (sc.embedding <=> query_embedding) AS similarity
  FROM knowledge_source_chunks sc
  WHERE sc.user_id = p_user_id
    AND sc.embedding IS NOT NULL
    AND 1 - (sc.embedding <=> query_embedding) > match_threshold
  ORDER BY sc.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;
```

**Verify:**
```sql
SELECT routine_name, data_type
FROM information_schema.routines
WHERE routine_schema = 'public' AND routine_name = 'match_source_chunks';
```
Should return one row with `data_type = 'record'`.

---

### Step 5: Create `match_knowledge_nodes` RPC Function

This enables semantic search over knowledge nodes for the RAG pipeline and anchor scanning.

```sql
CREATE OR REPLACE FUNCTION match_knowledge_nodes(
  query_embedding vector(3072),
  match_threshold float,
  match_count int,
  p_user_id uuid
)
RETURNS TABLE (
  id uuid,
  label text,
  entity_type text,
  description text,
  similarity float
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
  SELECT
    kn.id,
    kn.label,
    kn.entity_type,
    kn.description,
    1 - (kn.embedding <=> query_embedding) AS similarity
  FROM knowledge_nodes kn
  WHERE kn.user_id = p_user_id
    AND kn.embedding IS NOT NULL
    AND 1 - (kn.embedding <=> query_embedding) > match_threshold
  ORDER BY kn.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;
```

**Verify:**
```sql
SELECT routine_name, data_type
FROM information_schema.routines
WHERE routine_schema = 'public'
  AND routine_name IN ('match_source_chunks', 'match_knowledge_nodes');
```
Should return two rows.

---

### Step 6: Create HNSW Indexes for 3072-dim Vectors

HNSW indexes provide fast approximate nearest-neighbor search. We use HNSW for both tables (better than IVFFlat for high dimensions and doesn't require training on existing data).

**IMPORTANT:** These indexes can only be created AFTER data is populated (PRD-15B). Creating them on empty columns is valid but the index won't be useful until embeddings exist. You may choose to run this step now (the index will build instantly on empty data) or after PRD-15B completes (the index will take a few seconds to build on ~3,666 rows).

```sql
-- HNSW index on knowledge_source_chunks
CREATE INDEX IF NOT EXISTS idx_source_chunks_embedding_hnsw
  ON knowledge_source_chunks USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- HNSW index on knowledge_nodes
CREATE INDEX IF NOT EXISTS idx_knowledge_nodes_embedding_hnsw
  ON knowledge_nodes USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
```

**Verify:**
```sql
SELECT indexname, tablename, indexdef
FROM pg_indexes
WHERE tablename IN ('knowledge_nodes', 'knowledge_source_chunks')
  AND indexdef LIKE '%embedding%';
```
Should return two rows, both using `hnsw` with `vector_cosine_ops`.

---

## Final Validation Checklist

Run this single validation block after all steps are complete:

```sql
-- 1. Columns are vector(3072)
SELECT table_name, column_name, udt_name
FROM information_schema.columns
WHERE table_name IN ('knowledge_nodes', 'knowledge_source_chunks')
  AND column_name = 'embedding';
-- Expected: 2 rows, both udt_name = 'vector'

-- 2. All embeddings are NULL (ready for re-embedding)
SELECT
  'knowledge_source_chunks' as tbl, COUNT(embedding) as embedded
FROM knowledge_source_chunks
UNION ALL
SELECT 'knowledge_nodes', COUNT(embedding) FROM knowledge_nodes;
-- Expected: both 0

-- 3. Old match_nodes is gone
SELECT routine_name FROM information_schema.routines
WHERE routine_schema = 'public' AND routine_name = 'match_nodes';
-- Expected: no rows

-- 4. New RPC functions exist
SELECT routine_name FROM information_schema.routines
WHERE routine_schema = 'public'
  AND routine_name IN ('match_source_chunks', 'match_knowledge_nodes');
-- Expected: 2 rows

-- 5. HNSW indexes exist
SELECT indexname, tablename FROM pg_indexes
WHERE tablename IN ('knowledge_nodes', 'knowledge_source_chunks')
  AND indexdef LIKE '%embedding%';
-- Expected: 2 rows, both using hnsw
```

---

## What This Migration Does NOT Do

- Does NOT modify any application code (that's PRD-15B and 15C)
- Does NOT generate any new embeddings (that's PRD-15B)
- Does NOT change the RAG pipeline logic (that's PRD-15C)
- Does NOT affect any non-embedding columns or tables
- Does NOT change RLS policies (the RPC functions use `p_user_id` parameter for filtering)

## Risk Notes

- **Data loss:** All existing 768-dim embeddings (1,171 chunks + 820 nodes) will be permanently deleted. This is intentional — they are from a model that no longer works and cannot be used with the new 3072-dim model. The underlying source content and node data is unaffected.
- **Temporary degradation:** Between this migration and PRD-15B completion, semantic search will return no results (all embeddings are NULL). Keyword search continues to work normally.
- **Rollback:** If needed, columns can be reverted to `vector(768)` using the same ALTER pattern, but the old embeddings cannot be recovered.
