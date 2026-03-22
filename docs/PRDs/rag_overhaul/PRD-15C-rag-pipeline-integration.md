# PRD-15C: RAG Pipeline — Hybrid Search Integration

> **CORRECTION (March 17, 2026):** This PRD states the chunks table is `knowledge_source_chunks`. The table has been renamed to `source_chunks` to match the application code. The RPC functions `match_source_chunks` and `match_chunks` have been updated to reference the new name. See `supabase/migrations/20260317_rename_source_chunks_fix_rpcs.sql` for the migration.

## Overview

Wire semantic (vector) search into the Synapse RAG pipeline so that every query benefits from both keyword matching AND meaning-based similarity search. This is the final PRD in the 15A→15B→15C sequence. After this PRD, the Ask view's conversational interface will return dramatically better results because it can find conceptually related content, not just exact keyword matches.

## Prerequisites

- **PRD-15A complete:** Database columns are `vector(3072)`, RPC functions `match_source_chunks` and `match_knowledge_nodes` exist.
- **PRD-15B complete:** All source chunks and knowledge nodes have valid 3072-dim embeddings. The `extractionPersistence.ts` fix is deployed so new ingestions store embeddings correctly.

## Context for AI Coding Agent

**What exists today (working):**
- `src/services/rag.ts` — orchestrates the full RAG pipeline with 5 approaches
- `src/services/supabase.ts` — contains keyword search functions (`keywordSearchSources`, `keywordSearchChunks`, `keywordSearchNodes`), and a stubbed/deprecated `semanticSearchChunks` that returns `[]`
- `src/services/gemini.ts` — contains the embedding generation function (needs to use `gemini-embedding-001`)

**What this PRD adds:**
1. A working `embedQuery()` function that generates a 3072-dim embedding for the user's question
2. A working `semanticSearchChunks()` function that calls the `match_source_chunks` RPC
3. A working `semanticSearchNodes()` function that calls the `match_knowledge_nodes` RPC
4. Integration of semantic results into the RAG pipeline's parallel retrieval block
5. Updated reranking that combines keyword and semantic scores

**CRITICAL — Table name:** The chunks table is `knowledge_source_chunks`, NOT `source_chunks`. The RPC function is `match_source_chunks` (this is what the function is named, not the table).

---

## Deliverable 1: Embedding Query Function

**File:** `src/services/gemini.ts` (or wherever embedding generation currently lives)

Add or update the function that embeds a user's query text. This must use `gemini-embedding-001` and return a 3072-dim vector.

```typescript
/**
 * Generate a 3072-dimensional embedding for a text query using gemini-embedding-001.
 * Used by the RAG pipeline to perform semantic search.
 */
export async function embedQuery(text: string): Promise<number[]> {
  const apiKey = import.meta.env.VITE_GEMINI_API_KEY;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent?key=${apiKey}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'models/gemini-embedding-001',
      content: { parts: [{ text }] }
    })
  });

  if (!response.ok) {
    console.warn(`[embedQuery] Gemini embedding failed: HTTP ${response.status}`);
    return [];
  }

  const data = await response.json();
  const values = data?.embedding?.values;

  if (!Array.isArray(values) || values.length !== 3072) {
    console.warn(`[embedQuery] Unexpected embedding dimensions: ${values?.length}`);
    return [];
  }

  return values;
}
```

**Important:** If an `embedQuery`, `generateEmbedding`, or similar function already exists in `gemini.ts`, update it in place rather than creating a duplicate. Ensure it uses `gemini-embedding-001` (not `text-embedding-004`) and handles the 3072-dim output.

Search for any existing embedding function:
```bash
grep -rn "embedContent\|generateEmbedding\|embedQuery\|text-embedding" src/services/
```

---

## Deliverable 2: Semantic Search Functions in `supabase.ts`

**File:** `src/services/supabase.ts`

### 2A: `semanticSearchChunks`

Remove the existing deprecated/stubbed version and replace with a real implementation that calls the `match_source_chunks` RPC.

```typescript
export interface SemanticChunkResult {
  id: string;
  source_id: string;
  chunk_index: number;
  content: string;
  similarity: number;
}

/**
 * Semantic search over source chunks using vector similarity.
 * Calls the match_source_chunks RPC function (created in PRD-15A).
 */
export async function semanticSearchChunks(
  embedding: number[],
  userId: string,
  options: { matchThreshold?: number; matchCount?: number } = {}
): Promise<SemanticChunkResult[]> {
  if (!embedding || embedding.length === 0) {
    console.warn('[semanticSearchChunks] Empty embedding, skipping semantic search');
    return [];
  }

  const { matchThreshold = 0.4, matchCount = 15 } = options;

  const { data, error } = await supabase.rpc('match_source_chunks', {
    query_embedding: embedding,
    match_threshold: matchThreshold,
    match_count: matchCount,
    p_user_id: userId,
  });

  if (error) {
    console.warn('[semanticSearchChunks] RPC call failed:', error.message);
    return [];
  }

  return (data ?? []) as SemanticChunkResult[];
}
```

### 2B: `semanticSearchNodes`

This is a new function — it may not have existed before.

```typescript
export interface SemanticNodeResult {
  id: string;
  label: string;
  entity_type: string;
  description: string;
  similarity: number;
}

/**
 * Semantic search over knowledge nodes using vector similarity.
 * Calls the match_knowledge_nodes RPC function (created in PRD-15A).
 */
export async function semanticSearchNodes(
  embedding: number[],
  userId: string,
  options: { matchThreshold?: number; matchCount?: number } = {}
): Promise<SemanticNodeResult[]> {
  if (!embedding || embedding.length === 0) {
    console.warn('[semanticSearchNodes] Empty embedding, skipping semantic search');
    return [];
  }

  const { matchThreshold = 0.4, matchCount = 20 } = options;

  const { data, error } = await supabase.rpc('match_knowledge_nodes', {
    query_embedding: embedding,
    match_threshold: matchThreshold,
    match_count: matchCount,
    p_user_id: userId,
  });

  if (error) {
    console.warn('[semanticSearchNodes] RPC call failed:', error.message);
    return [];
  }

  return (data ?? []) as SemanticNodeResult[];
}
```

**Important:** Search for any existing `semanticSearch` functions in `supabase.ts` and either update them or remove the deprecated versions:
```bash
grep -n "semanticSearch\|match_nodes\|match_source_chunks\|match_knowledge_nodes" src/services/supabase.ts
```

Also check if there's an `semanticSearchNodesExtended` or similar function from v1 that should be updated or removed.

---

## Deliverable 3: Integrate Semantic Search into RAG Pipeline

**File:** `src/services/rag.ts`

This is the core change. The RAG pipeline currently runs keyword search only. We need to add semantic search in parallel with keyword search, then merge and deduplicate the results.

### 3A: Add Semantic Search to the Retrieval Phase

Find the section of `rag.ts` where keyword retrieval happens (likely in the main `askQuestion` or `runRAGPipeline` function). The current pattern probably looks something like:

```typescript
// CURRENT: Keyword-only retrieval
const [sourceResults, chunkResults, nodeResults] = await Promise.all([
  keywordSearchSources(query, userId),
  keywordSearchChunks(query, userId),
  keywordSearchNodes(query, userId),
]);
```

Modify it to run semantic search in parallel:

```typescript
// UPDATED: Hybrid retrieval — keyword + semantic in parallel
const queryEmbedding = await embedQuery(question);

const [sourceResults, chunkResults, nodeResults, semanticChunks, semanticNodes] = await Promise.all([
  keywordSearchSources(question, userId),
  keywordSearchChunks(question, userId),
  keywordSearchNodes(question, userId),
  semanticSearchChunks(queryEmbedding, userId, { matchThreshold: 0.4, matchCount: 15 }),
  semanticSearchNodes(queryEmbedding, userId, { matchThreshold: 0.4, matchCount: 20 }),
]);
```

**Note:** The `embedQuery` call is separated out so it runs once. If query decomposition is active (sub-queries), embed each sub-query separately and merge the semantic results.

### 3B: Merge and Deduplicate Results

After both keyword and semantic results are collected, merge them with deduplication:

```typescript
/**
 * Merge keyword and semantic chunk results.
 * Chunks found by both methods get a boosted score.
 * Deduplicates by chunk ID.
 */
function mergeChunkResults(
  keywordChunks: Array<{ id: string; content: string; source_id: string; chunk_index: number }>,
  semanticChunks: SemanticChunkResult[]
): Array<{ id: string; content: string; source_id: string; chunk_index: number; score: number; source: 'keyword' | 'semantic' | 'both' }> {
  const merged = new Map<string, {
    id: string;
    content: string;
    source_id: string;
    chunk_index: number;
    keywordMatch: boolean;
    semanticScore: number;
  }>();

  // Add keyword results
  for (const chunk of keywordChunks) {
    merged.set(chunk.id, {
      ...chunk,
      keywordMatch: true,
      semanticScore: 0,
    });
  }

  // Add/merge semantic results
  for (const chunk of semanticChunks) {
    const existing = merged.get(chunk.id);
    if (existing) {
      existing.semanticScore = chunk.similarity;
    } else {
      merged.set(chunk.id, {
        id: chunk.id,
        content: chunk.content,
        source_id: chunk.source_id,
        chunk_index: chunk.chunk_index,
        keywordMatch: false,
        semanticScore: chunk.similarity,
      });
    }
  }

  // Score and sort
  return Array.from(merged.values())
    .map(chunk => ({
      id: chunk.id,
      content: chunk.content,
      source_id: chunk.source_id,
      chunk_index: chunk.chunk_index,
      score: calculateHybridScore(chunk.keywordMatch, chunk.semanticScore),
      source: chunk.keywordMatch && chunk.semanticScore > 0 ? 'both' as const
        : chunk.keywordMatch ? 'keyword' as const
        : 'semantic' as const,
    }))
    .sort((a, b) => b.score - a.score);
}

/**
 * Hybrid scoring: keyword match = 0.4, semantic similarity contributes 0.6.
 * Chunks found by both methods get the combined score (max ~1.0).
 */
function calculateHybridScore(keywordMatch: boolean, semanticScore: number): number {
  const keywordComponent = keywordMatch ? 0.4 : 0;
  const semanticComponent = semanticScore * 0.6;
  return keywordComponent + semanticComponent;
}
```

### 3C: Use Semantic Nodes for Graph Traversal Seeds

The current graph traversal (Approach 3) only uses keyword-matched nodes as seeds. Add semantic nodes as additional seeds:

```typescript
// CURRENT: Only keyword nodes as seeds
const seedNodeIds = keywordNodes.map(n => n.id);

// UPDATED: Keyword + semantic nodes as seeds (deduplicated)
const allNodeIds = new Set([
  ...keywordNodes.map(n => n.id),
  ...semanticNodes.map(n => n.id),
]);
const seedNodeIds = Array.from(allNodeIds).slice(0, 15); // Cap at 15 seeds
```

### 3D: Update the Existing Reranking

If the existing `scoreChunks` function (Approach 4) only uses keyword term frequency, enhance it to factor in the hybrid score:

```typescript
// When scoring chunks, prefer the hybrid score if available,
// fall back to keyword-only scoring for chunks that only came from keyword search
function enhancedScoreChunk(
  chunk: { content: string; score?: number; source?: string },
  queryTerms: string[]
): number {
  // If chunk already has a hybrid score from mergeChunkResults, weight it heavily
  if (chunk.score && chunk.score > 0) {
    // Blend hybrid score (70%) with term frequency (30%)
    const termFreqScore = countMatchingTerms(chunk.content, queryTerms) / queryTerms.length;
    return chunk.score * 0.7 + termFreqScore * 0.3;
  }

  // Fallback: pure term frequency scoring
  return countMatchingTerms(chunk.content, queryTerms) / queryTerms.length;
}
```

### 3E: Handle Embedding Failures Gracefully

If `embedQuery` returns an empty array (API error, rate limit, etc.), the pipeline should gracefully fall back to keyword-only search — the same behavior as today. This means semantic search is an enhancement, not a dependency.

```typescript
// In the main pipeline function:
const queryEmbedding = await embedQuery(question);
const hasEmbedding = queryEmbedding.length > 0;

// Only run semantic search if embedding succeeded
const semanticChunks = hasEmbedding
  ? await semanticSearchChunks(queryEmbedding, userId, { matchThreshold: 0.4, matchCount: 15 })
  : [];
const semanticNodes = hasEmbedding
  ? await semanticSearchNodes(queryEmbedding, userId, { matchThreshold: 0.4, matchCount: 20 })
  : [];

// Log which mode is active
if (hasEmbedding) {
  console.log(`[RAG] Hybrid mode: keyword + semantic (${semanticChunks.length} semantic chunks, ${semanticNodes.length} semantic nodes)`);
} else {
  console.log('[RAG] Keyword-only mode: embedding generation failed, falling back');
}
```

---

## Deliverable 4: Query Decomposition + Semantic Search

If query decomposition (Approach 5) is active, each sub-query should get its own semantic search pass. The current decomposition logic breaks complex queries into 2-3 focused sub-queries and runs keyword retrieval for each. Extend this to also embed each sub-query:

```typescript
// For each sub-query in the decomposed set:
for (const subQuery of subQueries) {
  const [kwSources, kwChunks, kwNodes] = await Promise.all([
    keywordSearchSources(subQuery, userId),
    keywordSearchChunks(subQuery, userId),
    keywordSearchNodes(subQuery, userId),
  ]);

  // Embed the sub-query for semantic search
  const subEmbedding = await embedQuery(subQuery);
  const semChunks = subEmbedding.length > 0
    ? await semanticSearchChunks(subEmbedding, userId, { matchThreshold: 0.4, matchCount: 10 })
    : [];
  const semNodes = subEmbedding.length > 0
    ? await semanticSearchNodes(subEmbedding, userId, { matchThreshold: 0.4, matchCount: 10 })
    : [];

  // Merge this sub-query's results into the overall result set
  allChunks.push(...kwChunks, ...semChunks);
  allNodes.push(...kwNodes, ...semNodes);
}

// Deduplicate across all sub-queries
const uniqueChunks = deduplicateById(allChunks);
const uniqueNodes = deduplicateById(allNodes);
```

**Note:** Each sub-query embedding call adds ~200ms latency. For 3 sub-queries, that's ~600ms additional time. This is acceptable given the quality improvement. If latency becomes a concern, the sub-query embeddings can be parallelized with `Promise.all`.

---

## Deliverable 5: Update Anchor Scanning (If Applicable)

Search the codebase for any anchor scanning or connection discovery code that uses the old `match_nodes` RPC or the old `semanticSearchNodesExtended` function:

```bash
grep -rn "match_nodes\|semanticSearchNodesExtended\|semanticSearchNodes" src/
```

Any code that calls these functions should be updated to use the new `semanticSearchNodes` function (which calls `match_knowledge_nodes` RPC). The function signatures may differ — the new function takes `(embedding, userId, options)` while the old one may have had different parameters.

If anchor scanning code exists in components like `AnchorManager.tsx`, `InjectionHub.tsx`, or `GraphView.tsx`, update the calls but do not change the scanning logic or UI. Just swap the underlying search function.

---

## Testing & Validation

### Functional Tests

1. **Basic semantic retrieval:** In the Ask view, ask a conceptual question that doesn't use exact keywords from any source. For example, if you have content about "machine learning model training," ask "how do neural networks learn?" — the answer should reference relevant chunks even though the words don't match exactly.

2. **Hybrid advantage:** Ask a question that has both keyword and conceptual matches. Verify the response cites sources from both keyword and semantic results. Check the console logs for `[RAG] Hybrid mode` confirmation.

3. **Graceful degradation:** Temporarily break the embedding (e.g., pass an invalid API key) and verify the RAG pipeline still works using keyword-only mode. Check console for `[RAG] Keyword-only mode: embedding generation failed, falling back`.

4. **Query decomposition + semantic:** Ask a complex multi-part question (8+ words). Verify that decomposition activates and each sub-query runs both keyword and semantic search.

5. **Graph traversal with semantic seeds:** Ask about a topic that's well-connected in your graph. Verify the response includes information from graph-traversed nodes (nodes not directly matching the query but connected to matching nodes).

### Performance Tests

6. **Latency check:** Time a RAG query end-to-end. The embedding call adds ~200-400ms. Total query time should remain under 8 seconds for typical questions.

7. **Result quality:** Compare answers for 3-5 test questions before and after this change. Semantic search should surface relevant content that keyword search missed.

### SQL Validation

```sql
-- Confirm RPC functions are being called successfully
-- (Check Supabase logs for match_source_chunks and match_knowledge_nodes calls)

-- Quick functional test from SQL:
-- 1. Get a real embedding from a chunk
-- 2. Search for similar chunks — should return results
SELECT id, LEFT(content, 80) as preview, similarity
FROM match_source_chunks(
  (SELECT embedding FROM knowledge_source_chunks WHERE embedding IS NOT NULL LIMIT 1),
  0.4,
  5,
  (SELECT user_id FROM knowledge_source_chunks WHERE embedding IS NOT NULL LIMIT 1)
);
```

---

## What This PRD Does NOT Do

- Does NOT change the database schema (PRD-15A handled that)
- Does NOT generate embeddings for existing data (PRD-15B handled that)
- Does NOT modify the UI of the Ask view or any other view
- Does NOT change how the final response is generated (the Gemini generation prompt stays the same)
- Does NOT add Gemini-based reranking (that's a future enhancement — the lightweight term-frequency reranking enhanced with hybrid scores is sufficient for now)

## Architecture Note: Future Improvements

After this PRD ships and is validated, potential future enhancements include:

- **Gemini-based reranking:** Send the top 30 merged results to Gemini with a reranking prompt before taking the final top 15 for context. Adds one API call but significantly improves precision.
- **Adaptive thresholds:** Lower `matchThreshold` for broad questions, raise it for specific ones. Could be determined by query length or decomposition results.
- **Embedding cache:** Cache query embeddings for repeated/similar questions to avoid redundant API calls.
- **Source-level semantic search:** Add embeddings to `knowledge_sources` (the full source documents) for coarse-grained retrieval before chunk-level search.

These are NOT in scope for this PRD. Ship the hybrid search first, validate it works, then iterate.
