# PRD-Anchor-Dedup: Anchor Deduplication & Merge Pipeline

## Header

- **PRD Number**: Anchor-Dedup
- **Title**: Anchor Deduplication, Merge Pipeline & Retroactive Cleanup
- **Phase**: Knowledge Graph Integrity — Prerequisite for Skills Pipeline anchor relevance scoring
- **Dependencies**: PRD-21 (deduplication tables — exists but needs vector dimension fix), PRD-22 (anchor hierarchy — exists but needs vector dimension fix)
- **Estimated Complexity**: High

---

## Objective

Fix the systemic anchor duplication problem in Synapse V3. Today, duplicate anchors like "Claude Code" (68 connections) and "Cloud Code" (55 connections) coexist in the graph because: (1) extraction pipelines only do exact string matching for dedup, (2) the `checkDeduplication()` service exists but is never called during ingestion, and (3) the `find_similar_nodes()` and `find_similar_anchors()` RPCs use stale `vector(768)` dimensions instead of the current `vector(3072)`.

This PRD addresses four layers of the problem:

1. **Prevention** — Fuzzy + semantic dedup at extraction time, before nodes are saved
2. **Detection** — Anchor-level similarity check when suggesting new anchor candidates
3. **Manual Resolution** — UI for users to manually merge confirmed anchors
4. **Retroactive Cleanup** — Batch scan of existing nodes to surface all current duplicates for review

This is a prerequisite for the anchor relevance signal in the skills pipeline. If duplicate anchors like "Cloud Code" / "Claude Code" split connection counts and distort relevance scoring, the `anchorRelevance` signal (0.30 weight in the skill readiness formula) will be unreliable.

---

## What Gets Built

### 1. Migration: Fix Vector Dimensions & Add Dedup Infrastructure

**New file**: `supabase/migrations/20260329_anchor_dedup_fixes.sql`

Fixes the `vector(768)` → `vector(3072)` mismatch in existing RPCs and adds new dedup helper functions.

### 2. Pre-Save Dedup in Extraction Pipelines

**Modified files**:
- `api/meetings/process.ts`
- `api/youtube/extract-knowledge.ts`

Add fuzzy + semantic duplicate detection before persisting new nodes.

### 3. Anchor Candidate Dedup in Scoring Pipeline

**Modified file**: `api/anchors/score-post-extraction.ts`

Before suggesting a new anchor candidate, check if it semantically duplicates an existing confirmed anchor.

### 4. Retroactive Batch Cleanup Endpoint

**New file**: `api/anchors/dedup-scan.ts`

Vercel endpoint that scans all existing nodes for duplicates and queues them in `potential_duplicates` for review.

### 5. Anchor Merge UI

**Modified file**: `src/views/PipelineView.tsx` (or new component)

UI for reviewing duplicate anchors, previewing merge results, and confirming merges. Extends the existing `potential_duplicates` display.

### 6. Dedup Service Activation

**Modified file**: `src/services/deduplication.ts`

Wire up the existing `checkDeduplication()` and `mergeNodes()` functions so they're actually called, and fix any vector dimension issues in the service layer.

---

## Part 1: Migration — Fix Vector Dimensions & Add Infrastructure

### File: `supabase/migrations/20260329_anchor_dedup_fixes.sql`

```sql
-- ============================================================
-- Part 1A: Fix vector(768) → vector(3072) in existing RPCs
-- ============================================================

-- Fix find_similar_nodes() from PRD-21
CREATE OR REPLACE FUNCTION find_similar_nodes(
  p_user_id UUID,
  p_embedding VECTOR(3072),
  p_threshold FLOAT DEFAULT 0.80,
  p_limit INT DEFAULT 20
)
RETURNS TABLE (
  id UUID,
  label TEXT,
  entity_type TEXT,
  description TEXT,
  is_anchor BOOLEAN,
  similarity FLOAT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RETURN QUERY
  SELECT
    kn.id,
    kn.label,
    kn.entity_type,
    kn.description,
    kn.is_anchor,
    1 - (kn.embedding <=> p_embedding) AS similarity
  FROM public.knowledge_nodes kn
  WHERE kn.user_id = p_user_id
    AND kn.embedding IS NOT NULL
    AND kn.is_merged IS NOT TRUE
    AND 1 - (kn.embedding <=> p_embedding) > p_threshold
  ORDER BY kn.embedding <=> p_embedding
  LIMIT p_limit;
END;
$$;

-- Fix find_similar_anchors() from PRD-22
CREATE OR REPLACE FUNCTION find_similar_anchors(
  p_user_id UUID,
  p_threshold FLOAT DEFAULT 0.85,
  p_limit INT DEFAULT 50
)
RETURNS TABLE (
  anchor_id UUID,
  anchor_label TEXT,
  similar_id UUID,
  similar_label TEXT,
  similar_entity_type TEXT,
  similarity FLOAT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RETURN QUERY
  SELECT
    a.id AS anchor_id,
    a.label AS anchor_label,
    b.id AS similar_id,
    b.label AS similar_label,
    b.entity_type AS similar_entity_type,
    1 - (a.embedding <=> b.embedding) AS similarity
  FROM public.knowledge_nodes a
  INNER JOIN public.knowledge_nodes b
    ON a.user_id = b.user_id
    AND a.id < b.id  -- Avoid duplicate pairs and self-joins
    AND b.embedding IS NOT NULL
    AND b.is_merged IS NOT TRUE
  WHERE a.user_id = p_user_id
    AND a.is_anchor = true
    AND a.embedding IS NOT NULL
    AND a.is_merged IS NOT TRUE
    AND 1 - (a.embedding <=> b.embedding) > p_threshold
  ORDER BY similarity DESC
  LIMIT p_limit;
END;
$$;


-- ============================================================
-- Part 1B: New RPC — Find all duplicate clusters across nodes
-- ============================================================

-- Returns groups of nodes that are likely duplicates, using both
-- exact label matching (case-insensitive) and semantic similarity.
-- Used by the retroactive batch cleanup endpoint.
CREATE OR REPLACE FUNCTION find_duplicate_clusters(
  p_user_id UUID,
  p_semantic_threshold FLOAT DEFAULT 0.88,
  p_entity_type TEXT DEFAULT NULL,
  p_anchors_only BOOLEAN DEFAULT false,
  p_limit INT DEFAULT 100
)
RETURNS TABLE (
  node_a_id UUID,
  node_a_label TEXT,
  node_a_entity_type TEXT,
  node_a_is_anchor BOOLEAN,
  node_a_connection_count BIGINT,
  node_b_id UUID,
  node_b_label TEXT,
  node_b_entity_type TEXT,
  node_b_is_anchor BOOLEAN,
  node_b_connection_count BIGINT,
  match_type TEXT,         -- 'exact' or 'semantic'
  similarity FLOAT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RETURN QUERY

  -- Exact matches (case-insensitive, same entity type)
  SELECT
    a.id, a.label, a.entity_type, a.is_anchor,
    (SELECT COUNT(*) FROM public.knowledge_edges e
     WHERE e.source_node_id = a.id OR e.target_node_id = a.id) AS a_conns,
    b.id, b.label, b.entity_type, b.is_anchor,
    (SELECT COUNT(*) FROM public.knowledge_edges e
     WHERE e.source_node_id = b.id OR e.target_node_id = b.id) AS b_conns,
    'exact'::TEXT,
    1.0::FLOAT
  FROM public.knowledge_nodes a
  INNER JOIN public.knowledge_nodes b
    ON a.user_id = b.user_id
    AND a.id < b.id
    AND LOWER(TRIM(a.label)) = LOWER(TRIM(b.label))
    AND a.entity_type = b.entity_type
    AND b.is_merged IS NOT TRUE
  WHERE a.user_id = p_user_id
    AND a.is_merged IS NOT TRUE
    AND (p_entity_type IS NULL OR a.entity_type = p_entity_type)
    AND (p_anchors_only IS FALSE OR (a.is_anchor = true OR b.is_anchor = true))

  UNION ALL

  -- Semantic matches (high embedding similarity, different labels)
  SELECT
    a.id, a.label, a.entity_type, a.is_anchor,
    (SELECT COUNT(*) FROM public.knowledge_edges e
     WHERE e.source_node_id = a.id OR e.target_node_id = a.id) AS a_conns,
    b.id, b.label, b.entity_type, b.is_anchor,
    (SELECT COUNT(*) FROM public.knowledge_edges e
     WHERE e.source_node_id = b.id OR e.target_node_id = b.id) AS b_conns,
    'semantic'::TEXT,
    1 - (a.embedding <=> b.embedding)
  FROM public.knowledge_nodes a
  INNER JOIN public.knowledge_nodes b
    ON a.user_id = b.user_id
    AND a.id < b.id
    AND LOWER(TRIM(a.label)) != LOWER(TRIM(b.label))  -- Exclude exact matches (already above)
    AND b.embedding IS NOT NULL
    AND b.is_merged IS NOT TRUE
  WHERE a.user_id = p_user_id
    AND a.is_merged IS NOT TRUE
    AND a.embedding IS NOT NULL
    AND (p_entity_type IS NULL OR a.entity_type = p_entity_type)
    AND (p_anchors_only IS FALSE OR (a.is_anchor = true OR b.is_anchor = true))
    AND 1 - (a.embedding <=> b.embedding) > p_semantic_threshold

  ORDER BY similarity DESC
  LIMIT p_limit;
END;
$$;


-- ============================================================
-- Part 1C: New RPC — Check if a specific label has near-matches
-- ============================================================

-- Used by extraction pipelines before saving a new node.
-- Lightweight: checks one label against existing nodes.
CREATE OR REPLACE FUNCTION check_node_duplicate(
  p_user_id UUID,
  p_label TEXT,
  p_entity_type TEXT,
  p_embedding VECTOR(3072),
  p_exact_threshold FLOAT DEFAULT 0.92,    -- Levenshtein-normalized similarity
  p_semantic_threshold FLOAT DEFAULT 0.88
)
RETURNS TABLE (
  match_id UUID,
  match_label TEXT,
  match_entity_type TEXT,
  match_is_anchor BOOLEAN,
  match_type TEXT,          -- 'exact', 'fuzzy', or 'semantic'
  similarity FLOAT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RETURN QUERY

  -- Exact case-insensitive match (same entity type)
  SELECT
    kn.id, kn.label, kn.entity_type, kn.is_anchor,
    'exact'::TEXT,
    1.0::FLOAT
  FROM public.knowledge_nodes kn
  WHERE kn.user_id = p_user_id
    AND LOWER(TRIM(kn.label)) = LOWER(TRIM(p_label))
    AND kn.entity_type = p_entity_type
    AND kn.is_merged IS NOT TRUE

  UNION ALL

  -- Fuzzy match: Levenshtein-based for catching typos ("Cloud Code" / "Claude Code")
  SELECT
    kn.id, kn.label, kn.entity_type, kn.is_anchor,
    'fuzzy'::TEXT,
    1.0 - (public.levenshtein(LOWER(TRIM(kn.label)), LOWER(TRIM(p_label)))::FLOAT
           / GREATEST(LENGTH(kn.label), LENGTH(p_label))::FLOAT)
  FROM public.knowledge_nodes kn
  WHERE kn.user_id = p_user_id
    AND kn.is_merged IS NOT TRUE
    AND kn.entity_type = p_entity_type
    AND LENGTH(kn.label) BETWEEN LENGTH(p_label) - 3 AND LENGTH(p_label) + 3  -- Quick length filter
    AND 1.0 - (public.levenshtein(LOWER(TRIM(kn.label)), LOWER(TRIM(p_label)))::FLOAT
               / GREATEST(LENGTH(kn.label), LENGTH(p_label))::FLOAT) >= p_exact_threshold
    AND LOWER(TRIM(kn.label)) != LOWER(TRIM(p_label))  -- Exclude exact matches (already above)

  UNION ALL

  -- Semantic match: embedding cosine similarity
  SELECT
    kn.id, kn.label, kn.entity_type, kn.is_anchor,
    'semantic'::TEXT,
    1 - (kn.embedding <=> p_embedding)
  FROM public.knowledge_nodes kn
  WHERE kn.user_id = p_user_id
    AND kn.is_merged IS NOT TRUE
    AND kn.embedding IS NOT NULL
    AND 1 - (kn.embedding <=> p_embedding) > p_semantic_threshold
    AND LOWER(TRIM(kn.label)) != LOWER(TRIM(p_label))  -- Exclude exact (covered above)

  ORDER BY similarity DESC
  LIMIT 10;
END;
$$;


-- ============================================================
-- Part 1D: Enable fuzzystrmatch extension for Levenshtein
-- ============================================================

CREATE EXTENSION IF NOT EXISTS fuzzystrmatch;
```

### Key decisions:

- **`check_node_duplicate` is the workhorse RPC** — called by extraction pipelines before saving each entity. It combines three match strategies (exact, fuzzy via Levenshtein, and semantic via embedding cosine) in a single call to minimize round-trips.
- **`find_duplicate_clusters` is for batch scanning** — called by the retroactive cleanup endpoint. It's heavier (pairwise join) and should only run on-demand, not during extraction.
- **Levenshtein for typo detection**: "Cloud Code" → "Claude Code" has edit distance 1 but would score ~0.91 on normalized Levenshtein. Setting the fuzzy threshold at 0.92 catches single-character typos for labels of this length. The length filter (`BETWEEN length-3 AND length+3`) keeps the search space manageable.
- **`is_merged IS NOT TRUE` filter everywhere**: Prevents merged-away nodes from appearing as duplicate candidates.

---

## Part 2: Pre-Save Dedup in Extraction Pipelines

### Modified files:
- `api/meetings/process.ts`
- `api/youtube/extract-knowledge.ts`

### Current behavior (broken):

Both pipelines currently do inline exact string matching only:

```typescript
const matchingEntity = entities.find(
  e => e.label.toLowerCase() === (existing.label as string).toLowerCase()
    && e.entity_type === existing.entity_type
)
```

This misses typos ("Cloud Code" vs "Claude Code"), abbreviations ("MCP" vs "Model Context Protocol"), and semantically equivalent labels with different wording.

### New behavior:

Replace the inline matching with a call to the `check_node_duplicate` RPC. The flow for each extracted entity becomes:

```typescript
// For each entity extracted by Gemini:
async function resolveEntityDedup(
  userId: string,
  entity: ExtractedEntity,
  supabase: SupabaseClient
): Promise<{ action: 'create' | 'merge' | 'skip'; targetNodeId?: string }> {

  // Step 1: Generate embedding for the entity label + description
  const embedding = await generateEmbedding(
    `${entity.label}: ${entity.description || ''}`
  )

  // Step 2: Call the check_node_duplicate RPC
  const { data: matches } = await supabase.rpc('check_node_duplicate', {
    p_user_id: userId,
    p_label: entity.label,
    p_entity_type: entity.entity_type,
    p_embedding: embedding,
    p_exact_threshold: 0.92,
    p_semantic_threshold: 0.88
  })

  if (!matches || matches.length === 0) {
    return { action: 'create' }
  }

  // Step 3: Evaluate the best match
  const bestMatch = matches[0]  // Already sorted by similarity DESC

  if (bestMatch.match_type === 'exact') {
    // Exact match: merge into existing node (update description if richer)
    return { action: 'merge', targetNodeId: bestMatch.match_id }
  }

  if (bestMatch.match_type === 'fuzzy' && bestMatch.similarity >= 0.95) {
    // Very high fuzzy match (e.g., "Cloud Code" / "Claude Code") — auto-merge
    return { action: 'merge', targetNodeId: bestMatch.match_id }
  }

  if (bestMatch.match_type === 'fuzzy' || bestMatch.match_type === 'semantic') {
    // Near-match: create the node but queue a potential duplicate for review
    await supabase.from('potential_duplicates').insert({
      user_id: userId,
      node_a_id: bestMatch.match_id,
      node_b_id: null,  // Will be set after the new node is created
      similarity: bestMatch.similarity,
      match_type: bestMatch.match_type,
      status: 'pending',
      metadata: {
        new_label: entity.label,
        existing_label: bestMatch.match_label,
        detected_at: new Date().toISOString(),
        detection_source: 'extraction_pipeline'
      }
    })
    return { action: 'create' }  // Create but flag for review
  }

  return { action: 'create' }
}
```

### Merge behavior:

When `action === 'merge'`, instead of creating a new node:

1. **Repoint the new entity's edges** to the existing node — all edges that would have been created pointing to/from the new node now point to the existing one.
2. **Update the existing node's description** if the new entity's description is longer/richer (simple heuristic: use the longer description).
3. **Do NOT create a new node row** — the existing node absorbs the new entity.
4. **Log the merge** in the source's metadata for traceability:

```json
{
  "merged_entities": [
    {
      "original_label": "Cloud Code",
      "merged_into": "Claude Code",
      "merged_into_id": "abc-123",
      "similarity": 0.96,
      "match_type": "fuzzy"
    }
  ]
}
```

### Performance consideration:

The `check_node_duplicate` RPC adds one database call per extracted entity (typically 5–15 entities per source). The RPC itself is fast — it hits the existing embedding HNSW index for the semantic check and does exact/fuzzy matching on the label text column. The embedding generation for each entity label is the heavier cost, but Synapse already generates embeddings for new nodes, so this is moving that step earlier rather than adding a new cost.

### When to NOT auto-merge:

Two entities with the same label but different entity types should NOT merge. "AI" as a Technology and "AI" as a Topic are conceptually different nodes with different connection patterns. The RPC already filters by `entity_type` for exact and fuzzy matches. For semantic matches, the RPC does not filter by entity type (two differently-typed nodes could be semantically identical), but these are always queued for human review rather than auto-merged.

---

## Part 3: Anchor Candidate Dedup in Scoring Pipeline

### Modified file: `api/anchors/score-post-extraction.ts`

### Current behavior:

The post-extraction scoring pipeline evaluates new entities for anchor candidacy based on momentum (2+ active days in 7 days) and signal scores (centrality, diversity, richness). When a candidate passes, it's inserted into `anchor_candidates` for user review.

**Problem**: If "Cloud Code" and "Claude Code" both independently build momentum, they both get suggested as anchor candidates. The user sees duplicate suggestions.

### New behavior:

Add a dedup check before inserting an anchor candidate:

```typescript
// After computing anchor scores, before inserting into anchor_candidates:
async function checkAnchorCandidateDedup(
  userId: string,
  candidateNodeId: string,
  supabase: SupabaseClient
): Promise<{
  isDuplicate: boolean
  duplicateOfAnchorId?: string
  duplicateOfAnchorLabel?: string
  similarity?: number
}> {

  // Get the candidate node
  const { data: candidate } = await supabase
    .from('knowledge_nodes')
    .select('label, entity_type, embedding')
    .eq('id', candidateNodeId)
    .single()

  if (!candidate?.embedding) {
    return { isDuplicate: false }
  }

  // Check against confirmed anchors using find_similar_nodes
  const { data: similarAnchors } = await supabase.rpc('find_similar_nodes', {
    p_user_id: userId,
    p_embedding: candidate.embedding,
    p_threshold: 0.85,   // Slightly lower threshold than extraction dedup
    p_limit: 5             // because anchor dedup is more consequential
  })

  if (!similarAnchors || similarAnchors.length === 0) {
    return { isDuplicate: false }
  }

  // Check if any high-similarity match is a confirmed anchor
  const anchorMatch = similarAnchors.find(
    (n: any) => n.is_anchor === true && n.id !== candidateNodeId
  )

  if (anchorMatch) {
    return {
      isDuplicate: true,
      duplicateOfAnchorId: anchorMatch.id,
      duplicateOfAnchorLabel: anchorMatch.label,
      similarity: anchorMatch.similarity
    }
  }

  // Also check fuzzy label match against anchors specifically
  const { data: anchors } = await supabase
    .from('knowledge_nodes')
    .select('id, label, entity_type')
    .eq('user_id', userId)
    .eq('is_anchor', true)
    .eq('is_merged', false)

  if (anchors) {
    for (const anchor of anchors) {
      const normalizedCandidate = candidate.label.toLowerCase().trim()
      const normalizedAnchor = anchor.label.toLowerCase().trim()

      // Check Levenshtein similarity
      // (Implemented in TypeScript since we already have the anchor list in memory)
      const editDistance = levenshteinDistance(normalizedCandidate, normalizedAnchor)
      const maxLen = Math.max(normalizedCandidate.length, normalizedAnchor.length)
      const similarity = 1 - (editDistance / maxLen)

      if (similarity >= 0.90) {
        return {
          isDuplicate: true,
          duplicateOfAnchorId: anchor.id,
          duplicateOfAnchorLabel: anchor.label,
          similarity
        }
      }
    }
  }

  return { isDuplicate: false }
}
```

### When a duplicate is detected:

Instead of creating a new anchor candidate, the scoring pipeline should:

1. **Boost the existing anchor's score** — the fact that another entity built independent momentum for the same concept validates the anchor.
2. **Queue a merge suggestion** in `potential_duplicates` with metadata indicating it was caught during anchor scoring.
3. **Log it** in the scoring results for visibility.

This prevents the "Cloud Code / Claude Code" scenario from recurring: even if Gemini extracts "Cloud Code" from a new source, the extraction pipeline catches it (Part 2). And even if the extraction pipeline misses it, the anchor scoring pipeline catches it here (Part 3) before it becomes a user-facing suggestion.

---

## Part 4: Retroactive Batch Cleanup Endpoint

### New file: `api/anchors/dedup-scan.ts`

A Vercel serverless function that scans the entire graph for existing duplicates and queues them for review.

### Endpoint specification:

```
POST /api/anchors/dedup-scan
```

**Request body** (optional):

```json
{
  "anchorsOnly": true,         // Default true — start with anchor dedup only
  "semanticThreshold": 0.88,   // Cosine similarity threshold
  "dryRun": false              // If true, return duplicates but don't queue them
}
```

**Response body**:

```json
{
  "success": true,
  "duplicateClusters": [
    {
      "match_type": "fuzzy",
      "similarity": 0.91,
      "nodeA": {
        "id": "abc-123",
        "label": "Claude Code",
        "entity_type": "Technology",
        "is_anchor": true,
        "connection_count": 68
      },
      "nodeB": {
        "id": "def-456",
        "label": "Cloud Code",
        "entity_type": "Technology",
        "is_anchor": true,
        "connection_count": 55
      },
      "recommendation": "merge_into_a",
      "reason": "Node A has more connections and the correct label"
    },
    {
      "match_type": "semantic",
      "similarity": 0.91,
      "nodeA": {
        "id": "ghi-789",
        "label": "AI Risk Management",
        "entity_type": "Topic",
        "is_anchor": true,
        "connection_count": 84
      },
      "nodeB": {
        "id": "jkl-012",
        "label": "Risk management",
        "entity_type": "Topic",
        "is_anchor": false,
        "connection_count": 39
      },
      "recommendation": "merge_into_a",
      "reason": "Node A is an anchor with more connections and more specific label"
    }
  ],
  "totalClusters": 2,
  "queuedForReview": 2
}
```

### Implementation:

```typescript
export default async function handler(req: VercelRequest, res: VercelResponse) {
  // 1. Authenticate
  const supabase = createClient(/* ... */)

  const { anchorsOnly = true, semanticThreshold = 0.88, dryRun = false } = req.body || {}

  // 2. Call find_duplicate_clusters RPC
  const { data: clusters } = await supabase.rpc('find_duplicate_clusters', {
    p_user_id: userId,
    p_semantic_threshold: semanticThreshold,
    p_anchors_only: anchorsOnly,
    p_limit: 100
  })

  if (!clusters || clusters.length === 0) {
    return res.json({ success: true, duplicateClusters: [], totalClusters: 0 })
  }

  // 3. For each cluster, determine merge recommendation
  const recommendations = clusters.map((pair: any) => {
    // Prefer the node that:
    // (a) is an anchor (anchor beats non-anchor)
    // (b) has more connections (more established in the graph)
    // (c) has a longer/more descriptive label (more precise)
    const aScore = (pair.node_a_is_anchor ? 100 : 0) + pair.node_a_connection_count
    const bScore = (pair.node_b_is_anchor ? 100 : 0) + pair.node_b_connection_count

    return {
      match_type: pair.match_type,
      similarity: pair.similarity,
      nodeA: {
        id: pair.node_a_id,
        label: pair.node_a_label,
        entity_type: pair.node_a_entity_type,
        is_anchor: pair.node_a_is_anchor,
        connection_count: pair.node_a_connection_count
      },
      nodeB: {
        id: pair.node_b_id,
        label: pair.node_b_label,
        entity_type: pair.node_b_entity_type,
        is_anchor: pair.node_b_is_anchor,
        connection_count: pair.node_b_connection_count
      },
      recommendation: aScore >= bScore ? 'merge_into_a' : 'merge_into_b',
      reason: buildReason(pair, aScore >= bScore ? 'a' : 'b')
    }
  })

  // 4. Queue for review (unless dry run)
  if (!dryRun) {
    for (const rec of recommendations) {
      // Check if this pair is already in potential_duplicates
      const { data: existing } = await supabase
        .from('potential_duplicates')
        .select('id')
        .or(`and(node_a_id.eq.${rec.nodeA.id},node_b_id.eq.${rec.nodeB.id}),and(node_a_id.eq.${rec.nodeB.id},node_b_id.eq.${rec.nodeA.id})`)
        .eq('status', 'pending')

      if (!existing || existing.length === 0) {
        await supabase.from('potential_duplicates').insert({
          user_id: userId,
          node_a_id: rec.nodeA.id,
          node_b_id: rec.nodeB.id,
          similarity: rec.similarity,
          match_type: rec.match_type,
          status: 'pending',
          metadata: {
            recommendation: rec.recommendation,
            reason: rec.reason,
            detected_at: new Date().toISOString(),
            detection_source: 'batch_scan'
          }
        })
      }
    }
  }

  return res.json({
    success: true,
    duplicateClusters: recommendations,
    totalClusters: recommendations.length,
    queuedForReview: dryRun ? 0 : recommendations.length
  })
}
```

### Running the initial cleanup:

After deploying this PRD, run the scan with `dryRun: true` first to inspect results:

```bash
curl -X POST "https://your-project.vercel.app/api/anchors/dedup-scan" \
  -H "Authorization: Bearer $AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"anchorsOnly": true, "dryRun": true}'
```

Review the output. If the recommendations look correct, run again with `dryRun: false` to queue them for review in the UI.

Then optionally run a broader scan with `anchorsOnly: false` to catch entity-level duplicates beyond anchors.

---

## Part 5: Anchor Merge UI

### Location: `src/views/PipelineView.tsx` (extend existing potential_duplicates panel)

The PipelineView already has a right panel that shows pending duplicates from the `potential_duplicates` table. This PRD extends that panel with anchor-specific merge functionality.

### Merge flow:

1. **Duplicate list view**: Shows all pending duplicate pairs, sorted by similarity DESC. Each pair shows:
   - Both labels side by side
   - Entity types and anchor status badges
   - Connection counts
   - Match type (exact / fuzzy / semantic) and similarity score
   - The system's recommendation (which to keep)

2. **Merge preview** (on selecting a pair): Shows what will happen if the merge proceeds:
   - Which node survives (the "target") and which gets absorbed (the "source")
   - How many edges will be repointed
   - The combined connection count
   - If descriptions differ, a preview of the merged description
   - A toggle to swap the merge direction (if the system's recommendation is wrong)

3. **Actions per pair**:
   - **Merge** — Execute the merge. Calls `mergeNodes()` from `deduplication.ts`:
     - Repoints all edges from source → target
     - Deduplicates edges (if source and target share the same edge to a third node, keep only one)
     - Merges tags arrays
     - If source is anchor and target is not: promotes target to anchor
     - Soft-deletes source (`is_merged = true`, `merged_into_node_id = target.id`)
     - Updates `potential_duplicates` status to `merged`
   - **Keep Separate** — User confirms these are distinct entities. Updates status to `kept_separate`. These won't be flagged again.
   - **Skip** — Defer the decision. Keeps status as `pending`.

4. **Batch actions**: A "Merge All Recommended" button that executes all pairs where the system recommendation has high confidence (similarity > 0.95). Requires a confirmation dialog listing all pairs.

### Anchor-specific UI considerations:

- When merging two anchors, the surviving anchor should be the one with more connections (it's more established in the graph). The label of the surviving anchor is kept, but the user can edit it before confirming.
- After a merge involving an anchor, the anchor score should be recalculated since it now has more connections. This can be deferred to the next `score-daily.ts` run.
- The merge panel should show a "Before/After" visualization: a mini connection count bar chart showing how the surviving anchor's centrality changes after absorbing the merged node's connections.

### Component structure:

```typescript
// New or extended components:
// - DuplicatePairCard: Displays a single pair with match info and actions
// - MergePreviewPanel: Shows merge consequences before confirmation
// - BatchMergeDialog: Confirmation for bulk merge operations
// - AnchorMergeStats: Before/after connection count visualization

// These can be new components in src/components/pipeline/ or inline in PipelineView.
// Follow existing pattern: no component library, custom components from design system,
// entity badges with colored dots, one primary-accent button per view max.
```

---

## Part 6: Wire Up Existing Dedup Service

### Modified file: `src/services/deduplication.ts`

The existing `checkDeduplication()` and `mergeNodes()` functions need to be:

1. **Updated for vector(3072)** — if they generate or compare embeddings, they must use the 3072-dimension model (`text-embedding-004` with `outputDimensionality: 3072`).
2. **Actually imported and called** from the extraction pipelines (Part 2) and the anchor scoring pipeline (Part 3).
3. **Tested** against the known duplicates ("Claude Code" / "Cloud Code").

If `mergeNodes()` already handles edge repointing, tag merging, and soft deletion correctly, it should be used as-is by the Merge UI (Part 5). If it's missing any of these capabilities (e.g., edge deduplication after merge), they need to be added.

### Edge deduplication during merge:

When merging node B into node A, if both A and B have an edge to node C:
- Keep only one edge (the one with higher `weight`)
- If edge `relation_type` differs, keep both (they represent different relationships)
- Delete the duplicate edge from the merged node B

```typescript
async function deduplicateEdgesAfterMerge(
  targetNodeId: string,
  supabase: SupabaseClient
) {
  // Find edges that share the same (target_node_id, relation_type) pair
  // after repointing, and keep only the highest-weight one
  const { data: edges } = await supabase
    .from('knowledge_edges')
    .select('*')
    .or(`source_node_id.eq.${targetNodeId},target_node_id.eq.${targetNodeId}`)
    .order('weight', { ascending: false })

  // Group by (other_node_id, relation_type) and delete duplicates
  const seen = new Map<string, string>()  // key → id of edge to keep
  const toDelete: string[] = []

  for (const edge of edges || []) {
    const otherNodeId = edge.source_node_id === targetNodeId
      ? edge.target_node_id
      : edge.source_node_id
    const key = `${otherNodeId}:${edge.relation_type}`

    if (seen.has(key)) {
      toDelete.push(edge.id)
    } else {
      seen.set(key, edge.id)
    }
  }

  if (toDelete.length > 0) {
    await supabase.from('knowledge_edges').delete().in('id', toDelete)
  }

  return { deduplicatedEdges: toDelete.length }
}
```

---

## Execution Order

This PRD should be executed in the following order:

1. **Migration** (Part 1) — Run first. Fixes the vector dimensions and adds new RPCs. Safe to run on production — only creates/replaces functions and adds an extension.

2. **Retroactive scan** (Part 4) — Run second with `dryRun: true`. This immediately surfaces the known duplicates ("Claude Code" / "Cloud Code") and any others. Review the output to validate thresholds.

3. **Merge UI** (Part 5) — Build third. This gives the user (Joseph) a way to resolve the retroactive scan results. Critical for resolving the existing "Claude Code" / "Cloud Code" split.

4. **Dedup service wiring** (Part 6) — Build alongside or just after the Merge UI, since `mergeNodes()` powers the Merge button.

5. **Extraction pipeline dedup** (Part 2) — Build fourth. This prevents new duplicates from being created going forward.

6. **Anchor candidate dedup** (Part 3) — Build last. This is the least urgent since the extraction pipeline dedup (Part 2) should catch most cases before entities even reach anchor candidacy.

---

## Known Duplicate Clusters (From Current Anchor List)

Based on the current 28 anchors, these are the high-confidence duplicate clusters that the batch scan should surface:

| Cluster | Match Type | Expected Similarity | Recommendation |
|---|---|---|---|
| "Claude Code" (Technology, 68 conns) ↔ "Cloud Code" (Technology, 55 conns) | fuzzy | ~0.91 | Merge into "Claude Code" — correct label, more connections |
| "AI Risk Management" (Topic, 84 conns) ↔ "Risk management" (Topic, 39 conns) ↔ "Risk Assessment" (Action, 18 conns) | semantic | ~0.85–0.90 | Merge "Risk management" into "AI Risk Management" (anchor, more specific). Keep "Risk Assessment" separate — different entity type (Action vs Topic) and narrower concept |
| "AI" (Technology, 60 conns) ↔ "AI Agents" (Topic, 202 conns) ↔ "AI Coding Agents" (Topic, 74 conns) ↔ "AI Security" (Topic, 15 conns) | semantic | ~0.80–0.88 | Keep ALL separate — these are distinct concepts that happen to share the "AI" prefix. The semantic threshold of 0.88 should exclude most of these. If any surface, the user should mark them "keep separate" |

### Threshold tuning:

The 0.88 semantic threshold and 0.92 fuzzy threshold are starting values. After running the initial scan, review the results:
- If too many false positives (distinct concepts flagged as duplicates): raise thresholds
- If known duplicates are missed: lower thresholds
- The "Claude Code" / "Cloud Code" pair is the litmus test — it should always be caught by the fuzzy matcher

---

## Edge Cases & Error Handling

- **Merging an anchor into a non-anchor**: If node A is an anchor and it's being merged INTO node B (which is not an anchor), B should be promoted to anchor status automatically. The surviving node inherits anchor status.

- **Merging two anchors**: The surviving anchor keeps its position. The merged anchor's connections boost the survivor's centrality score on next scoring run.

- **Circular merge**: If node A was already merged into node B, and later a scan suggests merging B into C, the merge should follow the chain: A → B → C. The `merged_into_node_id` on A should be updated to point to C, not left pointing to B.

- **Edges to self after merge**: If node A had an edge to node B, and B is merged into A, that edge would become A → A. These self-edges should be deleted during merge.

- **Concurrent extraction**: Two sources processed simultaneously might both try to create the same entity. The `check_node_duplicate` RPC handles this because it checks the database state at query time. If a race condition creates a duplicate, the retroactive scan will catch it.

- **Missing embeddings**: Some older nodes may not have embeddings (pre-migration). The semantic check naturally excludes these (`embedding IS NOT NULL`). These nodes can only be caught by exact or fuzzy matching.

- **Levenshtein extension not available**: The migration enables `fuzzystrmatch`. If the extension fails to install (permissions issue on managed Supabase), the fuzzy match portion of `check_node_duplicate` will fail. Handle gracefully — fall back to exact + semantic only.

---

## Acceptance Criteria

After this PRD is implemented:

1. The `find_similar_nodes()` and `find_similar_anchors()` RPCs use `vector(3072)`, not `vector(768)`.
2. The `check_node_duplicate()` RPC exists and correctly identifies "Cloud Code" as a fuzzy match for "Claude Code".
3. The `find_duplicate_clusters()` RPC exists and returns the "Claude Code" / "Cloud Code" pair when run against the current graph.
4. The `/api/anchors/dedup-scan` endpoint exists and returns duplicate clusters for the authenticated user.
5. Running the dedup scan with `anchorsOnly: true` surfaces the "Claude Code" / "Cloud Code" pair.
6. The PipelineView shows pending duplicates with merge/keep-separate actions.
7. Executing a merge on "Cloud Code" into "Claude Code" correctly repoints all 55 connections, soft-deletes "Cloud Code", and the surviving "Claude Code" now shows 100+ connections.
8. New sources processed through `api/meetings/process.ts` or `api/youtube/extract-knowledge.ts` no longer create new nodes when a fuzzy or exact match exists in the graph.
9. The anchor scoring pipeline (`score-post-extraction.ts`) does not suggest anchor candidates that semantically duplicate existing confirmed anchors.
10. After resolving all duplicate clusters, anchor-based skill relevance scoring produces clean, non-fragmented results.
