# PRD-21 — Node Deduplication Engine

**Phase:** 5 — Intelligence Layer  
**Dependencies:** PRD-17 (anchor_candidates schema), PRD-18 (scoring engine)  
**Estimated Complexity:** High  
**Estimated Effort:** 2–3 sessions  
**Must complete before:** PRD-20 (Explore Integration), PRD-22 (Anchor Hierarchy)

---

## 1. Objective

Synapse currently creates a new `knowledge_nodes` row every time an entity is extracted, regardless of whether that entity already exists in the graph. "Joseph Thomas" extracted from 4 different meeting transcripts produces 4 separate nodes with no connection between them. This fragments the graph, inflates entity counts, corrupts anchor candidate scores, and makes the knowledge base less useful over time.

This PRD builds a sustainable deduplication system with three layers:

1. **Prevention at extraction time** — before saving new entities, detect exact and near-exact matches against existing nodes and reuse their IDs instead of creating duplicates. Critically, edges involving reused nodes are still created, so new relationships are never silently lost.

2. **Near-duplicate review queue** — entities that are probably but not certainly the same (embedding similarity 0.80–0.92) are surfaced in the Pipeline page for human review, not auto-merged.

3. **Retroactive cleanup** — a one-time serverless function that merges exact-label duplicates already in the graph, preserving all edges on a canonical node and soft-deleting the redundant ones.

After this PRD, the graph grows correctly: each real-world entity has one canonical node that accumulates connections over time, making it progressively more useful as an anchor candidate and in RAG retrieval.

---

## 2. Critical Bug Fix — Edges Are Currently Lost

The existing code has a silent data loss bug that this PRD fixes as a primary concern.

In `saveNodes`, exact duplicate labels are filtered out and not inserted. In `saveEdges`, the `labelToId` map is built only from `savedNodes` (the newly inserted rows). If "Joseph Thomas" already exists and is skipped in `saveNodes`, it won't appear in `savedNodes`, so `labelToId` won't have it, and any edge like `project → Joseph Thomas` will be silently dropped.

**The fix:** `saveNodes` must return not just newly created nodes but also the existing node IDs for every entity that was deduplicated. `saveEdges` then has a complete `labelToId` map covering both new and reused nodes, so no relationships are lost.

This is the single highest-priority change in this PRD.

---

## 3. What Gets Built

### Database migration
- `supabase/migrations/20260315_prd21_deduplication.sql`

### New service file
- `src/services/deduplication.ts` — all deduplication logic (exact match, near-match, merge operations)

### Modified files
- `src/services/extractionPersistence.ts` — `saveNodes` returns reused node IDs; `saveEdges` accepts them
- `src/services/supabase.ts` — upgrade `checkDuplicateNodes` to return node IDs not just labels
- `src/hooks/useExtraction.ts` — pass reused nodes through the pipeline; populate near-duplicate review state
- `src/types/extraction.ts` — add `nearDuplicates` and `reusedNodes` to `PipelineState`
- `src/types/database.ts` — add `merged_into_node_id` to `KnowledgeNode`; add `PotentialDuplicateRow`
- `src/components/shared/EntityReview.tsx` — show "matches existing node" warning on duplicate entities
- `src/components/pipeline/PipelineStats.tsx` — add potential duplicates review section
- `src/views/PipelineView.tsx` — surface near-duplicate review in right panel default state
- `api/anchors/on-confirm.ts` (from improvements brief) — no change, but note it runs after dedup
- `api/youtube/extract-knowledge.ts` — add deduplication step inline (serverless constraint)
- `api/meetings/process.ts` — add deduplication step inline (serverless constraint)

### New serverless function
- `api/nodes/merge-duplicates.ts` — retroactive merge of exact-label duplicates

---

## 4. Database Migration

**File:** `supabase/migrations/20260315_prd21_deduplication.sql`

```sql
-- PRD-21: Node Deduplication Engine
-- Adds merged_into_node_id for soft-delete tracking and creates the
-- potential_duplicates table for near-match review queue.

-- ── 1. Soft-delete tracking on knowledge_nodes ────────────────────────────────
-- When a duplicate node is merged into a canonical node, it is NOT hard-deleted
-- (that would cascade-delete edges). Instead it is soft-deleted: its
-- merged_into_node_id is set and is_merged = true. The merge function
-- re-routes all edges to the canonical node first, then sets these flags.

ALTER TABLE knowledge_nodes
  ADD COLUMN IF NOT EXISTS merged_into_node_id UUID
    REFERENCES knowledge_nodes(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS is_merged BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_knowledge_nodes_is_merged
  ON knowledge_nodes (user_id, is_merged)
  WHERE is_merged = false;

-- ── 2. potential_duplicates table ─────────────────────────────────────────────
-- Stores near-match pairs (similarity 0.80–0.92) for human review.
-- Created by the deduplication service during extraction.
-- Reviewed and resolved via the Pipeline page right panel.

CREATE TABLE IF NOT EXISTS potential_duplicates (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  node_a_id       UUID NOT NULL REFERENCES knowledge_nodes(id) ON DELETE CASCADE,
  node_b_id       UUID NOT NULL REFERENCES knowledge_nodes(id) ON DELETE CASCADE,
  similarity      NUMERIC(5, 4) NOT NULL,  -- cosine similarity 0.0–1.0
  detected_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Resolution
  status          TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'merged', 'kept_separate', 'auto_resolved')),
  resolved_at     TIMESTAMPTZ,
  resolved_by     TEXT,  -- 'user' | 'system'
  -- Ensure each pair is stored once (node_a_id < node_b_id by convention)
  UNIQUE (user_id, node_a_id, node_b_id)
);

CREATE INDEX IF NOT EXISTS idx_potential_duplicates_user_status
  ON potential_duplicates (user_id, status)
  WHERE status = 'pending';

-- RLS
ALTER TABLE potential_duplicates ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own potential duplicates"
  ON potential_duplicates FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own potential duplicates"
  ON potential_duplicates FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own potential duplicates"
  ON potential_duplicates FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own potential duplicates"
  ON potential_duplicates FOR DELETE USING (auth.uid() = user_id);
```

---

## 5. `src/services/deduplication.ts` — New File

This is the central deduplication service. All deduplication logic lives here — both the frontend pipeline and the serverless functions inline-copy the core algorithm from this file (serverless constraint applies only to `api/` files).

```typescript
import { supabase } from './supabase'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ExistingNodeMatch {
  existingNodeId: string
  existingLabel:  string
  matchType:      'exact' | 'near'
  similarity:     number  // 1.0 for exact, 0.80–0.92 for near
}

export interface DeduplicationResult {
  // Map from incoming entity label (lowercase) → existing node ID
  // For exact matches: use this ID instead of creating a new node
  exactMatches: Map<string, string>

  // Near matches (0.80–0.92 similarity) — surface for review, don't auto-merge
  nearMatches: Array<{
    incomingLabel:  string
    incomingType:   string
    existingNodeId: string
    existingLabel:  string
    similarity:     number
  }>
}

// ─── Core deduplication check ─────────────────────────────────────────────────
// Called before saveNodes. Returns exact matches (reuse these IDs) and
// near matches (surface for review). Does NOT modify the database.

export async function checkDeduplication(
  userId: string,
  entities: Array<{ label: string; entity_type: string; embedding?: number[] }>
): Promise<DeduplicationResult> {
  const result: DeduplicationResult = {
    exactMatches: new Map(),
    nearMatches:  [],
  }

  if (entities.length === 0) return result

  // ── Step 1: Exact label match (case-insensitive, same entity_type) ──────────
  const labels = entities.map(e => e.label)

  const { data: exactRows } = await supabase
    .from('knowledge_nodes')
    .select('id, label, entity_type')
    .eq('user_id', userId)
    .eq('is_merged', false)
    .in('label', labels)

  for (const row of exactRows ?? []) {
    const matchingEntity = entities.find(
      e => e.label.toLowerCase() === (row.label as string).toLowerCase()
        && e.entity_type === row.entity_type
    )
    if (matchingEntity) {
      result.exactMatches.set(matchingEntity.label.toLowerCase(), row.id as string)
    }
  }

  // ── Step 2: Embedding-based near match for entities with embeddings ─────────
  // Only run for entities that didn't get an exact match and have embeddings.
  // Uses pgvector cosine similarity via a direct RPC call.
  const entitiesNeedingNearCheck = entities.filter(
    e => !result.exactMatches.has(e.label.toLowerCase()) && e.embedding
  )

  for (const entity of entitiesNeedingNearCheck) {
    if (!entity.embedding) continue

    // Find top candidates by embedding similarity, same entity_type, not merged
    const { data: nearRows } = await supabase.rpc('find_similar_nodes', {
      p_user_id:      userId,
      p_embedding:    entity.embedding,
      p_entity_type:  entity.entity_type,
      p_limit:        5,
      p_min_similarity: 0.80,
    })

    for (const row of nearRows ?? []) {
      const similarity = row.similarity as number
      const existingLabel = row.label as string

      // Skip if it's an exact label match already handled above
      if (existingLabel.toLowerCase() === entity.label.toLowerCase()) continue

      if (similarity >= 0.92) {
        // High confidence: treat as exact match (auto-deduplicate)
        result.exactMatches.set(entity.label.toLowerCase(), row.id as string)
      } else if (similarity >= 0.80) {
        // Medium confidence: surface for human review
        result.nearMatches.push({
          incomingLabel:  entity.label,
          incomingType:   entity.entity_type,
          existingNodeId: row.id as string,
          existingLabel,
          similarity,
        })
      }
    }
  }

  return result
}

// ─── Save potential duplicates to review queue ────────────────────────────────
// Called after extraction to persist near matches for Pipeline review.

export async function savePotentialDuplicates(
  userId: string,
  nearMatches: DeduplicationResult['nearMatches'],
  newNodeIds: Map<string, string>  // label.toLowerCase() → new node ID
): Promise<void> {
  if (nearMatches.length === 0) return

  const toInsert = nearMatches
    .map(match => {
      const newNodeId = newNodeIds.get(match.incomingLabel.toLowerCase())
      if (!newNodeId) return null

      // Enforce node_a_id < node_b_id convention for the unique constraint
      const [nodeAId, nodeBId] = newNodeId < match.existingNodeId
        ? [newNodeId, match.existingNodeId]
        : [match.existingNodeId, newNodeId]

      return {
        user_id:    userId,
        node_a_id:  nodeAId,
        node_b_id:  nodeBId,
        similarity: match.similarity,
      }
    })
    .filter(Boolean)

  if (toInsert.length === 0) return

  // Insert, ignoring conflicts (same pair already in queue from previous extraction)
  await supabase
    .from('potential_duplicates')
    .upsert(toInsert, { onConflict: 'user_id,node_a_id,node_b_id', ignoreDuplicates: true })
}

// ─── Merge two nodes ──────────────────────────────────────────────────────────
// Merges nodeToMerge into canonicalNode:
//   1. Repoints all edges from nodeToMerge to canonicalNode
//   2. Merges tags arrays
//   3. Updates description if canonicalNode has none
//   4. Marks nodeToMerge as merged (soft delete)
//   5. Updates potential_duplicates status

export async function mergeNodes(
  userId: string,
  canonicalNodeId: string,
  nodeToMergeId:   string
): Promise<{ edgesRepointed: number }> {
  let edgesRepointed = 0

  // 1. Repoint outgoing edges from nodeToMerge → canonicalNode
  const { data: outEdges } = await supabase
    .from('knowledge_edges')
    .select('id, target_node_id')
    .eq('user_id', userId)
    .eq('source_node_id', nodeToMergeId)

  for (const edge of outEdges ?? []) {
    // Skip self-loops that would be created
    if ((edge.target_node_id as string) === canonicalNodeId) {
      await supabase.from('knowledge_edges').delete().eq('id', edge.id as string)
    } else {
      await supabase
        .from('knowledge_edges')
        .update({ source_node_id: canonicalNodeId })
        .eq('id', edge.id as string)
      edgesRepointed++
    }
  }

  // 2. Repoint incoming edges to nodeToMerge → canonicalNode
  const { data: inEdges } = await supabase
    .from('knowledge_edges')
    .select('id, source_node_id')
    .eq('user_id', userId)
    .eq('target_node_id', nodeToMergeId)

  for (const edge of inEdges ?? []) {
    if ((edge.source_node_id as string) === canonicalNodeId) {
      await supabase.from('knowledge_edges').delete().eq('id', edge.id as string)
    } else {
      await supabase
        .from('knowledge_edges')
        .update({ target_node_id: canonicalNodeId })
        .eq('id', edge.id as string)
      edgesRepointed++
    }
  }

  // 3. Fetch both nodes to merge metadata
  const { data: nodes } = await supabase
    .from('knowledge_nodes')
    .select('id, description, tags, user_tags')
    .in('id', [canonicalNodeId, nodeToMergeId])

  const canonical = nodes?.find(n => n.id === canonicalNodeId)
  const toMerge   = nodes?.find(n => n.id === nodeToMergeId)

  if (canonical && toMerge) {
    const mergedTags = Array.from(new Set([
      ...((canonical.tags as string[]) ?? []),
      ...((toMerge.tags    as string[]) ?? []),
    ]))
    const mergedUserTags = Array.from(new Set([
      ...((canonical.user_tags as string[]) ?? []),
      ...((toMerge.user_tags   as string[]) ?? []),
    ]))
    const description = canonical.description || toMerge.description || null

    await supabase
      .from('knowledge_nodes')
      .update({ tags: mergedTags, user_tags: mergedUserTags, description })
      .eq('id', canonicalNodeId)
  }

  // 4. Soft-delete the merged node
  await supabase
    .from('knowledge_nodes')
    .update({ is_merged: true, merged_into_node_id: canonicalNodeId })
    .eq('id', nodeToMergeId)

  // 5. Resolve any potential_duplicates entries involving these two nodes
  await supabase
    .from('potential_duplicates')
    .update({ status: 'merged', resolved_at: new Date().toISOString(), resolved_by: 'user' })
    .eq('user_id', userId)
    .or(
      `and(node_a_id.eq.${canonicalNodeId},node_b_id.eq.${nodeToMergeId}),` +
      `and(node_a_id.eq.${nodeToMergeId},node_b_id.eq.${canonicalNodeId})`
    )

  return { edgesRepointed }
}

// ─── Fetch pending potential duplicates ───────────────────────────────────────
// Used by the Pipeline page right panel.

export interface PotentialDuplicatePair {
  id:         string
  similarity: number
  detectedAt: string
  nodeA: { id: string; label: string; entityType: string; connectionCount: number }
  nodeB: { id: string; label: string; entityType: string; connectionCount: number }
}

export async function fetchPendingDuplicates(
  userId: string
): Promise<PotentialDuplicatePair[]> {
  const { data, error } = await supabase
    .from('potential_duplicates')
    .select(`
      id, similarity, detected_at,
      node_a:knowledge_nodes!node_a_id (id, label, entity_type),
      node_b:knowledge_nodes!node_b_id (id, label, entity_type)
    `)
    .eq('user_id', userId)
    .eq('status', 'pending')
    .order('similarity', { ascending: false })
    .limit(20)

  if (error || !data) return []

  return data.map(row => ({
    id:         row.id as string,
    similarity: row.similarity as number,
    detectedAt: row.detected_at as string,
    nodeA: {
      id:              (row.node_a as { id: string }).id,
      label:           (row.node_a as { label: string }).label,
      entityType:      (row.node_a as { entity_type: string }).entity_type,
      connectionCount: 0,  // enriched separately if needed
    },
    nodeB: {
      id:              (row.node_b as { id: string }).id,
      label:           (row.node_b as { label: string }).label,
      entityType:      (row.node_b as { entity_type: string }).entity_type,
      connectionCount: 0,
    },
  }))
}

// ─── Keep separate (dismiss a potential duplicate pair) ───────────────────────

export async function keepSeparate(
  userId: string,
  pairId: string
): Promise<void> {
  await supabase
    .from('potential_duplicates')
    .update({
      status:      'kept_separate',
      resolved_at: new Date().toISOString(),
      resolved_by: 'user',
    })
    .eq('id', pairId)
    .eq('user_id', userId)
}
```

---

## 6. Postgres Function for Embedding Similarity

Add this to the migration file. Required by `checkDeduplication` for near-match detection:

```sql
-- ── 3. RPC function for embedding similarity search ───────────────────────────
CREATE OR REPLACE FUNCTION find_similar_nodes(
  p_user_id      UUID,
  p_embedding    vector(768),
  p_entity_type  TEXT,
  p_limit        INT DEFAULT 5,
  p_min_similarity FLOAT DEFAULT 0.80
)
RETURNS TABLE (
  id         UUID,
  label      TEXT,
  similarity FLOAT
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    id,
    label,
    1 - (embedding <=> p_embedding) AS similarity
  FROM knowledge_nodes
  WHERE user_id       = p_user_id
    AND entity_type   = p_entity_type
    AND is_merged     = false
    AND embedding     IS NOT NULL
    AND 1 - (embedding <=> p_embedding) >= p_min_similarity
  ORDER BY embedding <=> p_embedding
  LIMIT p_limit;
$$;
```

---

## 7. `extractionPersistence.ts` Modifications

### 7.1 `saveNodes` — returns reused node IDs

The function signature changes to return both new and reused nodes:

```typescript
// NEW return type — replaces SavedNode[] 
export interface SaveNodesResult {
  newNodes:     SavedNode[]         // nodes actually inserted
  reusedNodes:  SavedNode[]         // existing nodes reused (from exactMatches)
  allNodes:     SavedNode[]         // newNodes + reusedNodes combined — use this for edge creation
}

export async function saveNodes(
  userId:        string,
  entities:      ReviewEntity[],
  sourceId:      string,
  sourceMetadata: { sourceName: string; sourceType: string; sourceUrl?: string },
  exactMatches:  Map<string, string>  // label.toLowerCase() → existing node ID
): Promise<SaveNodesResult> {
  const included = entities.filter(e => !e.removed)

  // Separate: entities to insert vs entities to reuse
  const toInsert = included.filter(
    e => !exactMatches.has(e.label.toLowerCase())
  )
  const toReuse = included.filter(
    e => exactMatches.has(e.label.toLowerCase())
  )

  // Insert new nodes
  let newNodes: SavedNode[] = []
  if (toInsert.length > 0) {
    const rows = toInsert.map(e => {
      const row: Record<string, unknown> = {
        user_id:     userId,
        label:       e.label,
        entity_type: e.entity_type,
        source:      sourceMetadata.sourceName,
        source_type: sourceMetadata.sourceType,
        source_id:   sourceId,
        confidence:  e.confidence,
      }
      if (e.description)                row.description = e.description
      if (sourceMetadata.sourceUrl)     row.source_url  = sourceMetadata.sourceUrl
      if (e.tags && e.tags.length > 0)  row.tags        = e.tags
      return row
    })

    const { data, error } = await supabase
      .from('knowledge_nodes')
      .insert(rows)
      .select('id, label, entity_type')

    if (error) throw new PersistenceError('Failed to save nodes', error)
    newNodes = (data ?? []) as SavedNode[]
  }

  // Build reused nodes array from existing IDs
  const reusedNodes: SavedNode[] = toReuse.map(e => ({
    id:          exactMatches.get(e.label.toLowerCase())!,
    label:       e.label,
    entity_type: e.entity_type,
  }))

  return {
    newNodes,
    reusedNodes,
    allNodes: [...newNodes, ...reusedNodes],
  }
}
```

### 7.2 `saveEdges` — uses allNodes from SaveNodesResult

Update the call signature to accept `SavedNode[]` — callers now pass `result.allNodes` which includes both new and reused nodes. No change to the function body itself, just the caller.

---

## 8. `useExtraction.ts` Modifications

### 8.1 Import deduplication service

```typescript
import { checkDeduplication, savePotentialDuplicates } from '../services/deduplication'
```

### 8.2 Update `approveAndSave` callback

Replace the existing `checkDuplicateNodes` call with the full deduplication flow:

```typescript
// ── Step 1: Run deduplication check ──────────────────────────────────────────
// Pass embeddings for entities where we've already generated them
const entitiesWithEmbeddings = reviewedEntities
  .filter(e => !e.removed)
  .map(e => ({
    label:      e.label,
    entity_type: e.entity_type,
    // Embeddings not yet generated at this point — near-match runs post-save
    // Exact match runs now using labels only
  }))

const dedupResult = await checkDeduplication(user.id, entitiesWithEmbeddings)

// ── Step 2: Save nodes (new + reuse existing for exact matches) ───────────────
const saveResult = await saveNodes(
  user.id,
  reviewedEntities,
  sourceId,
  { sourceName, sourceType: metadata?.sourceType || 'Note', sourceUrl: metadata?.sourceUrl },
  dedupResult.exactMatches  // pass exact matches map
)

const duplicatesSkipped = dedupResult.exactMatches.size

// ── Step 3: Save edges — use allNodes so reused nodes get their edges ─────────
const savedEdgeIds = await saveEdges(
  user.id,
  state.relationships ?? [],
  saveResult.allNodes,  // ← was savedNodes, now allNodes
  removedLabels
)

update({ 
  savedNodes: saveResult.newNodes,  // for display purposes — only show new nodes
  savedEdgeIds, 
  duplicatesSkipped,
})

// ── Step 4: Generate embeddings for NEW nodes only ────────────────────────────
// (reused nodes already have embeddings)
// ... existing embedding generation code, using saveResult.newNodes ...

// ── Step 5: Near-duplicate check using embeddings (post-embedding generation) ─
// Now that we have embeddings for new nodes, check for near matches
if (saveResult.newNodes.length > 0) {
  const newNodesWithEmbeddings = saveResult.newNodes
    .map(n => {
      const entity = reviewedEntities.find(
        e => e.label.toLowerCase() === n.label.toLowerCase()
      )
      return {
        label:       n.label,
        entity_type: n.entity_type,
        embedding:   entity?._embedding,  // populated during embedding step
      }
    })
    .filter(n => n.embedding)

  const nearDedupResult = await checkDeduplication(user.id, newNodesWithEmbeddings)

  // Save near matches to review queue (non-blocking)
  const newNodeIdMap = new Map(
    saveResult.newNodes.map(n => [n.label.toLowerCase(), n.id])
  )
  savePotentialDuplicates(user.id, nearDedupResult.nearMatches, newNodeIdMap)
    .catch(err => console.warn('[useExtraction] Failed to save potential duplicates:', err))

  // Surface near matches in state for review UI
  if (nearDedupResult.nearMatches.length > 0) {
    update({ nearDuplicates: nearDedupResult.nearMatches })
  }
}
```

### 8.3 Add `nearDuplicates` and `reusedNodeCount` to `PipelineState`

In `src/types/extraction.ts`, add to `PipelineState`:

```typescript
nearDuplicates: Array<{
  incomingLabel:  string
  incomingType:   string
  existingNodeId: string
  existingLabel:  string
  similarity:     number
}> | null
reusedNodeCount: number  // how many exact matches were reused
```

Add defaults in `INITIAL_STATE`:
```typescript
nearDuplicates: null,
reusedNodeCount: 0,
```

---

## 9. `EntityReview.tsx` Modifications

When an entity label exactly matches an existing node (i.e. it's in the `exactMatches` set), show a subtle "matches existing node" indicator on the entity row rather than hiding it silently:

Add an optional `exactMatches?: Set<string>` prop to `EntityReviewProps`.

For each `EntityRow`, when `exactMatches?.has(entity.label.toLowerCase())` is true, render a small amber badge on the right side of the row:

```tsx
{exactMatches?.has(entity.label.toLowerCase()) && (
  <span style={{
    fontSize: 10, fontWeight: 600,
    color: '#d97706',
    background: 'rgba(245,158,11,0.08)',
    border: '1px solid rgba(245,158,11,0.2)',
    borderRadius: 4, padding: '1px 6px',
    flexShrink: 0,
  }}>
    ↗ Merging with existing
  </span>
)}
```

This gives the user visibility into what the deduplication engine is doing during the review step, without requiring any action from them.

---

## 10. Pipeline Page — Potential Duplicates Review Panel

**File:** `src/components/pipeline/PipelineStats.tsx`

Add a new section at the bottom of `PipelineStats` — "Potential Duplicates". This is the human review queue for near-matches.

The section renders only when `pendingDuplicatesCount > 0`. It shows a count badge and a "Review" button that expands inline to show the pair list.

Add to `PipelineStatsProps`:
```typescript
pendingDuplicatesCount?: number
pendingDuplicates?:      PotentialDuplicatePair[]
onMerge?:  (canonicalId: string, mergeId: string, pairId: string) => void
onKeepSeparate?: (pairId: string) => void
```

**Rendered section:**

```
┌─ POTENTIAL DUPLICATES ──────────────────────────────────────────────┐
│  ⚠ 3 pairs of nodes may be the same entity                         │
│                                                                     │
│  Joseph Thomas (Person)           ↔  Joseph Thomas (Person)        │
│  92% similar                          [Merge] [Keep Separate]       │
│                                                                     │
│  AI Risk Mgmt (Topic)             ↔  AI Risk Management (Topic)    │
│  84% similar                          [Merge] [Keep Separate]       │
└────────────────────────────────────────────────────────────────────┘
```

Each pair card:
- Left node: label + entity type badge
- Similarity percentage in center: amber if < 90%, green if ≥ 90%
- Right node: label + entity type badge
- Two action buttons: `Merge →` (merges right into left — picks higher edge count as canonical) and `Keep Separate`

**`Merge →` action logic:** Before calling `mergeNodes`, determine which node has more edges. That becomes the canonical node, the other is merged into it. This prevents accidentally making the less-connected node canonical.

**`PipelineView.tsx` wiring:** Add state for `pendingDuplicates`. Fetch via `fetchPendingDuplicates(user.id)` from `deduplication.ts` on mount (lightweight, non-blocking). Refresh after any `onMerge` or `onKeepSeparate` action. Pass down to `PipelineStats`.

---

## 11. `api/nodes/merge-duplicates.ts` — Retroactive Merge Function

**Purpose:** One-time retroactive cleanup that merges all exact-label duplicates already in the graph. Safe to run again — idempotent. Uses the same `mergeNodes` logic inlined (serverless constraint).

**Auth:** `CRON_SECRET` only — this is an admin operation, never called from the frontend.

**maxDuration:** `300`

**Algorithm:**
1. Fetch all `knowledge_nodes` for all users grouped by `(user_id, LOWER(label), entity_type)`
2. For each group with count > 1: pick the node with the highest edge count as canonical
3. Call the inline merge logic for each duplicate in the group
4. Return a summary: `{ usersProcessed, groupsFound, nodesMerged, edgesRepointed }`

**File:** `api/nodes/merge-duplicates.ts`

```typescript
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createClient } from '@supabase/supabase-js'

export const maxDuration = 300

const SUPABASE_URL              = process.env.SUPABASE_URL!
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!
const CRON_SECRET               = process.env.CRON_SECRET

const getSupabase = () => createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

function verifyCronAuth(req: VercelRequest): boolean {
  if (req.headers['x-vercel-signature']) return true
  if (!CRON_SECRET) return true
  const auth = req.headers['authorization']
  return !!(auth && auth === `Bearer ${CRON_SECRET}`)
}

// ── INLINE merge logic (serverless constraint — no local imports) ────────────

async function mergeNodesInline(
  sb: ReturnType<typeof getSupabase>,
  userId: string,
  canonicalId: string,
  mergeId: string
): Promise<number> {
  let edgesRepointed = 0

  // Repoint outgoing edges
  const { data: outEdges } = await sb
    .from('knowledge_edges')
    .select('id, target_node_id')
    .eq('user_id', userId)
    .eq('source_node_id', mergeId)

  for (const edge of outEdges ?? []) {
    if ((edge.target_node_id as string) === canonicalId) {
      await sb.from('knowledge_edges').delete().eq('id', edge.id as string)
    } else {
      await sb.from('knowledge_edges').update({ source_node_id: canonicalId }).eq('id', edge.id as string)
      edgesRepointed++
    }
  }

  // Repoint incoming edges
  const { data: inEdges } = await sb
    .from('knowledge_edges')
    .select('id, source_node_id')
    .eq('user_id', userId)
    .eq('target_node_id', mergeId)

  for (const edge of inEdges ?? []) {
    if ((edge.source_node_id as string) === canonicalId) {
      await sb.from('knowledge_edges').delete().eq('id', edge.id as string)
    } else {
      await sb.from('knowledge_edges').update({ target_node_id: canonicalId }).eq('id', edge.id as string)
      edgesRepointed++
    }
  }

  // Merge tags
  const { data: nodes } = await sb
    .from('knowledge_nodes')
    .select('id, description, tags, user_tags')
    .in('id', [canonicalId, mergeId])

  const canonical = nodes?.find(n => n.id === canonicalId)
  const toMerge   = nodes?.find(n => n.id === mergeId)

  if (canonical && toMerge) {
    const mergedTags = Array.from(new Set([
      ...((canonical.tags as string[]) ?? []),
      ...((toMerge.tags    as string[]) ?? []),
    ]))
    await sb.from('knowledge_nodes').update({
      tags: mergedTags,
      description: canonical.description || toMerge.description || null,
    }).eq('id', canonicalId)
  }

  // Soft-delete
  await sb.from('knowledge_nodes').update({
    is_merged:            true,
    merged_into_node_id:  canonicalId,
  }).eq('id', mergeId)

  return edgesRepointed
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (!verifyCronAuth(req)) return res.status(401).json({ error: 'Unauthorized' })

  const startTime = Date.now()
  const sb = getSupabase()

  let usersProcessed = 0, groupsFound = 0, nodesMerged = 0, edgesRepointed = 0

  try {
    // Find all exact-label duplicate groups across all users
    const { data: duplicateGroups } = await sb.rpc('find_exact_duplicate_nodes')

    if (!duplicateGroups || duplicateGroups.length === 0) {
      return res.status(200).json({
        success: true, message: 'No exact duplicates found',
        duration_ms: Date.now() - startTime,
      })
    }

    const usersSeen = new Set<string>()

    for (const group of duplicateGroups as Array<{
      user_id: string; label: string; entity_type: string; node_ids: string[]
    }>) {
      usersSeen.add(group.user_id)
      groupsFound++

      // Find which node has the most edges — that becomes canonical
      const edgeCounts = await Promise.all(
        group.node_ids.map(async (nodeId: string) => {
          const { count } = await sb
            .from('knowledge_edges')
            .select('id', { count: 'exact', head: true })
            .or(`source_node_id.eq.${nodeId},target_node_id.eq.${nodeId}`)
          return { nodeId, count: count ?? 0 }
        })
      )

      edgeCounts.sort((a, b) => b.count - a.count)
      const canonicalId = edgeCounts[0]!.nodeId
      const toMergeIds  = edgeCounts.slice(1).map(e => e.nodeId)

      for (const mergeId of toMergeIds) {
        const repointed = await mergeNodesInline(sb, group.user_id, canonicalId, mergeId)
        edgesRepointed += repointed
        nodesMerged++
      }
    }

    usersProcessed = usersSeen.size

    return res.status(200).json({
      success: true,
      usersProcessed,
      groupsFound,
      nodesMerged,
      edgesRepointed,
      duration_ms: Date.now() - startTime,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[merge-duplicates] Fatal error:', msg)
    return res.status(500).json({ success: false, error: msg, duration_ms: Date.now() - startTime })
  }
}
```

Add the required SQL helper function to the migration:

```sql
-- ── 4. Helper for finding exact duplicate groups ───────────────────────────────
CREATE OR REPLACE FUNCTION find_exact_duplicate_nodes()
RETURNS TABLE (
  user_id     UUID,
  label       TEXT,
  entity_type TEXT,
  node_ids    UUID[]
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    user_id,
    LOWER(label) AS label,
    entity_type,
    array_agg(id ORDER BY created_at) AS node_ids
  FROM knowledge_nodes
  WHERE is_merged = false
  GROUP BY user_id, LOWER(label), entity_type
  HAVING COUNT(*) > 1;
$$;
```

---

## 12. Serverless Pipeline Updates

Both `api/youtube/extract-knowledge.ts` and `api/meetings/process.ts` need the same exact-match deduplication step applied inline. Because of the Vercel serverless constraint (no local imports), the logic is inlined.

**Where to add it:** In each function, after node labels are collected but before the INSERT loop for new nodes.

**What to inline:** The exact-match check only — a simple `SELECT id, label FROM knowledge_nodes WHERE user_id = $1 AND LOWER(label) = ANY($2) AND is_merged = false`. Near-match (embedding-based) deduplication is skipped in serverless functions for performance reasons — those run via the daily scoring engine instead.

**The critical fix:** In both serverless functions, build a `labelToId` map that includes both newly inserted nodes AND the existing node IDs returned by the exact-match check. This ensures edges referencing pre-existing entities are correctly wired.

The exact implementation pattern in each serverless function:

```typescript
// After extracting entity labels from Gemini response, before INSERT loop:

// ── DEDUPLICATION: check for existing nodes with same label ──────────────────
const entityLabels = entities.map(e => e.label)
const { data: existingNodes } = await supabase
  .from('knowledge_nodes')
  .select('id, label, entity_type')
  .eq('user_id', item.user_id)  // or meeting.user_id
  .eq('is_merged', false)
  .in('label', entityLabels)

// Build exact-match map: label.toLowerCase() → existing node ID
const exactMatchMap = new Map<string, string>()
for (const existing of existingNodes ?? []) {
  const matchingEntity = entities.find(
    e => e.label.toLowerCase() === (existing.label as string).toLowerCase()
      && e.entity_type === existing.entity_type
  )
  if (matchingEntity) {
    exactMatchMap.set(matchingEntity.label.toLowerCase(), existing.id as string)
  }
}

// ── SAVE NODES: skip entities that already exist ─────────────────────────────
// savedNodeMap now seeded with existing node IDs for reused entities
const savedNodeMap = new Map<string, string>()

// Pre-populate with reused nodes
for (const [labelLower, existingId] of exactMatchMap) {
  const entity = entities.find(e => e.label.toLowerCase() === labelLower)
  if (entity) savedNodeMap.set(entity.label, existingId)
}

// Insert only new nodes (not in exactMatchMap)
for (const entity of entities) {
  if (exactMatchMap.has(entity.label.toLowerCase())) continue
  // ... existing INSERT logic ...
  // savedNodeMap.set(entity.label, newNode.id)
}

// savedNodeMap now covers both new and reused nodes — edges will be complete
```

---

## 13. Database Type Updates

**`src/types/database.ts`** — add to `KnowledgeNode`:

```typescript
merged_into_node_id?: string | null
is_merged?: boolean
```

Add new interface:

```typescript
export interface PotentialDuplicateRow {
  id:          string
  user_id:     string
  node_a_id:   string
  node_b_id:   string
  similarity:  number
  detected_at: string
  status:      'pending' | 'merged' | 'kept_separate' | 'auto_resolved'
  resolved_at: string | null
  resolved_by: string | null
}
```

**Existing queries across the app** that fetch `knowledge_nodes` should add `.eq('is_merged', false)` where appropriate — specifically `fetchClusterData`, `checkDuplicateNodes`, `searchNodesByLabel`, and `fetchCandidatesWithNodes`. This ensures merged nodes never appear in the graph or search results.

---

## 14. Forward-Compatible Decisions

- **`is_merged = false` index** on `knowledge_nodes` ensures queries that add this filter are fast even at 4,000+ nodes. All reads should use this filter going forward.

- **Soft delete, not hard delete.** Merged nodes stay in the database with `is_merged = true`. This preserves the audit trail, prevents foreign key violations on any tables referencing them, and allows the merge to be undone if needed (future "undo merge" feature just sets `is_merged = false` and `merged_into_node_id = null`).

- **Near-match threshold at 0.80** is conservative by design. False positives (merging distinct entities) are more damaging than false negatives (showing a pair in the review queue that turns out to be separate). The review queue exists precisely for the 0.80–0.92 range. Users who want more automation can lower the auto-merge threshold in settings — this maps cleanly to PRD-22's scoring profile configuration.

- **`savePotentialDuplicates` is fire-and-forget** — it never blocks the extraction pipeline. If it fails, the extraction still succeeds, and the next run of the scoring engine can detect near-duplicates through a separate daily pass.

- **`SuggestedClusterData` in PRD-20** should filter out merged nodes by checking `is_merged = false` in `fetchCandidatesWithNodes`. This is already handled by the `is_merged` index added here.

---

## 15. Acceptance Criteria

- [ ] Migration runs cleanly: `is_merged` and `merged_into_node_id` columns exist on `knowledge_nodes`, `potential_duplicates` table exists with RLS, both Postgres functions (`find_similar_nodes`, `find_exact_duplicate_nodes`) exist
- [ ] Running an extraction that includes "Joseph Thomas" when Joseph Thomas already exists: produces **one** node not two, creates edges correctly wired to the existing node, shows "↗ Merging with existing" badge on that entity in the review step
- [ ] `duplicatesSkipped` count in ExtractionSummary reflects exact matches reused (not just silently dropped)
- [ ] `saveEdges` correctly creates edges involving reused nodes — no relationship data is silently lost when an entity is deduplicated
- [ ] Extracting two entities with embedding similarity 0.92+ results in auto-deduplication (treated as exact match)
- [ ] Extracting two entities with embedding similarity 0.80–0.92 results in a row inserted into `potential_duplicates`, visible in the Pipeline page review section
- [ ] Extracting two entities with embedding similarity < 0.80 creates two distinct nodes (correct behaviour)
- [ ] Pipeline page right panel default state shows "Potential Duplicates" section when `pendingDuplicatesCount > 0`
- [ ] Clicking "Merge →" on a pair: edges repointed to canonical node, duplicate soft-deleted (`is_merged = true`), pair removed from review queue, canonical node gains merged node's tags
- [ ] Clicking "Keep Separate": pair removed from review queue, status set to `kept_separate`, neither node modified
- [ ] Soft-deleted nodes (`is_merged = true`) do not appear in: Explore graph clusters, Browse entity list, command palette search, anchor candidate suggestions
- [ ] `POST /api/nodes/merge-duplicates` with `CRON_SECRET` auth processes all users, returns correct counts, runs in under 60 seconds on your 4,433 node graph
- [ ] After running `merge-duplicates`, the 4× Joseph Thomas duplicates are reduced to 1 canonical node with all edges preserved
- [ ] Both `api/youtube/extract-knowledge.ts` and `api/meetings/process.ts` apply exact-match deduplication inline and their `savedNodeMap` includes reused node IDs
- [ ] All modified TypeScript files compile with zero errors in strict mode
- [ ] No existing extraction, pipeline, or explore functionality is broken
