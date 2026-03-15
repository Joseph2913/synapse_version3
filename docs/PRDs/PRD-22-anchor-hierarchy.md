# PRD-22 — Anchor Hierarchy: Parent and Sub-Anchor System

**Phase:** 5 — Intelligence Layer  
**Dependencies:**
- PRD-17 — `anchor_candidates` schema, `src/types/anchors.ts`, `src/services/anchorCandidates.ts`
- PRD-18 — scoring engine (scoring SQL and serverless functions updated here)
- PRD-19 — Anchors page (`AnchorCard`, `AnchorDetailPanel`, `AnchorCreateForm`)
- PRD-20 (updated) — `SuggestedAnchorPanel` contains the placeholder comment this PRD fills in
- PRD-21 — deduplication (must have run retroactive merge so graph is clean before hierarchy is built)

**Estimated Complexity:** High  
**Estimated Effort:** 2–3 sessions

---

## 1. Objective

The current anchor system is flat — every anchor is equal, and the Explore Landscape view shows all clusters at the same visual weight. This doesn't reflect how knowledge actually organises itself. "AI Risk Management" is a parent concept; "AI Security", "Risk Assessment", and "AI Risk Management System" are sub-topics that live within it. Making them all independent anchors fragments the graph into too many small, disconnected clusters.

This PRD adds a one-level hierarchy: a confirmed anchor can have a `parent_anchor_id` pointing to another confirmed anchor, making it a **sub-anchor**. The system suggests parent relationships automatically based on semantic similarity. The user confirms or declines.

**What changes visually in Explore:** Sub-anchor clusters render as smaller satellite bubbles orbiting their parent, with a visible tether line connecting them. The parent anchor acts as a gravitational hub — clicking it shows all its sub-anchor satellites. Clicking a sub-anchor zooms into that cluster's neighborhood as normal. The hierarchy is one level deep — no infinite nesting.

**What changes in the Anchors page:** Confirming a suggested candidate now offers two options when a parent relationship is detected: "Confirm as independent anchor" or "Add as sub-anchor of [parent]". The signal score breakdown shows a "Parent relationship" indicator when `suggested_parent_anchor_id` is populated.

---

## 2. What Gets Built

### Database migration
- `supabase/migrations/20260315_prd22_anchor_hierarchy.sql`

### Modified source files
- `src/types/explore.ts` — add `parentAnchorId`, `subAnchorIds`, `isSubAnchor` to `ClusterData` and `AnchorNode`
- `src/types/anchors.ts` — add `suggestedParentAnchorId` to `AnchorCandidate`; add `AnchorHierarchyInfo` type
- `src/types/database.ts` — add `parent_anchor_id` to `KnowledgeNode`; add `suggested_parent_anchor_id` to `AnchorCandidateRow`
- `src/services/exploreQueries.ts` — update `fetchClusterData` to fetch parent-child relationships
- `src/services/anchorCandidates.ts` — update `mapRow` and `upsertAnchorCandidate` for new field; add `promoteToSubAnchor`, `removeSubAnchorRelationship`
- `src/hooks/useClusterLayout.ts` — sub-anchors orbit their parent; force simulation awareness of hierarchy
- `src/views/explore/LandscapeView.tsx` — render sub-anchor satellites, tether lines, parent hub visual
- `src/components/explore/ClusterBubble.tsx` — `isSubAnchor` prop for smaller satellite rendering
- `src/views/explore/ExploreMetadataPanel.tsx` — fill in PRD-20's `suggestedParentAnchorId` placeholder
- `src/components/anchors/AnchorDetailPanel.tsx` — show parent/child relationship info
- `src/components/anchors/AnchorCard.tsx` — sub-anchor indentation and parent badge
- `src/views/AnchorsView.tsx` — update handleConfirm to support sub-anchor path

### New serverless function update
- `api/anchors/score-post-extraction.ts` — add parent suggestion logic (inline)
- `api/anchors/score-daily.ts` — add parent suggestion logic (inline)

### Scoring SQL update
- New SQL script: `score-anchor-candidates-v4.sql` — adds `suggested_parent_anchor_id` computation

---

## 3. Database Migration

**File:** `supabase/migrations/20260315_prd22_anchor_hierarchy.sql`

```sql
-- PRD-22: Anchor Hierarchy
-- Adds parent_anchor_id to knowledge_nodes for confirmed sub-anchor relationships.
-- Adds suggested_parent_anchor_id to anchor_candidates for system suggestions.

-- ── 1. Parent anchor relationship on knowledge_nodes ─────────────────────────
-- A sub-anchor is an anchor node with parent_anchor_id pointing to another anchor.
-- One level deep only — parent_anchor_id always points to a root anchor (never a sub-anchor).
-- ON DELETE SET NULL: if the parent is demoted from anchor, sub-anchors become root anchors.

ALTER TABLE knowledge_nodes
  ADD COLUMN IF NOT EXISTS parent_anchor_id UUID
    REFERENCES knowledge_nodes(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_knowledge_nodes_parent_anchor
  ON knowledge_nodes (parent_anchor_id)
  WHERE parent_anchor_id IS NOT NULL;

-- ── 2. Suggested parent on anchor_candidates ──────────────────────────────────
-- When the scoring engine detects a strong semantic relationship between a candidate
-- and an existing anchor (similarity > 0.85), it writes the anchor's ID here.
-- The user sees "Add as sub-anchor of [parent]" in the confirmation UI.

ALTER TABLE anchor_candidates
  ADD COLUMN IF NOT EXISTS suggested_parent_anchor_id UUID
    REFERENCES knowledge_nodes(id) ON DELETE SET NULL;

-- ── 3. Prevent circular references (root anchor cannot be its own sub-anchor) ─

CREATE OR REPLACE FUNCTION prevent_circular_anchor_hierarchy()
RETURNS TRIGGER AS $$
BEGIN
  -- A node cannot be its own parent
  IF NEW.parent_anchor_id = NEW.id THEN
    RAISE EXCEPTION 'An anchor cannot be its own parent';
  END IF;
  -- A parent anchor cannot itself have a parent (one level deep only)
  IF NEW.parent_anchor_id IS NOT NULL THEN
    PERFORM 1 FROM knowledge_nodes
    WHERE id = NEW.parent_anchor_id
      AND parent_anchor_id IS NOT NULL;
    IF FOUND THEN
      RAISE EXCEPTION 'Sub-anchors cannot be parents (maximum one level of hierarchy)';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER anchor_hierarchy_check
  BEFORE INSERT OR UPDATE OF parent_anchor_id ON knowledge_nodes
  FOR EACH ROW
  WHEN (NEW.parent_anchor_id IS NOT NULL)
  EXECUTE FUNCTION prevent_circular_anchor_hierarchy();
```

---

## 4. Type Updates

### 4.1 `src/types/explore.ts`

Add `parentAnchorId` and `isSubAnchor` to `AnchorNode`:

```typescript
export interface AnchorNode {
  id:            string
  label:         string
  entityType:    string
  description:   string | null
  entityCount:   number
  // PRD-22: hierarchy fields
  parentAnchorId: string | null   // null = root anchor
  isSubAnchor:    boolean         // true when parentAnchorId is set
}
```

Add `subAnchorIds` to `ClusterData`:

```typescript
export interface ClusterData {
  anchor:            AnchorNode
  entityCount:       number
  typeDistribution:  TypeDistributionEntry[]
  position:          { cx: number; cy: number; r: number }
  crossClusterEdges: CrossClusterEdge[]
  // PRD-22: sub-anchors orbiting this cluster
  subAnchorIds:      string[]  // IDs of anchors whose parent_anchor_id = this anchor's id
}
```

### 4.2 `src/types/anchors.ts`

Add `suggestedParentAnchorId` to `AnchorCandidate`:

```typescript
export interface AnchorCandidate {
  // ... all existing fields ...
  suggestedParentAnchorId: string | null  // PRD-22: system-detected parent relationship
}
```

Add new type for hierarchy info used in the UI:

```typescript
export interface AnchorHierarchyInfo {
  parentAnchorId:   string | null
  parentLabel:      string | null
  parentEntityType: string | null
  subAnchors: Array<{
    id:          string
    label:       string
    entityType:  string
    entityCount: number
  }>
}
```

Add `SUGGESTED_PARENT_SIMILARITY_THRESHOLD = 0.85` constant — the embedding cosine similarity above which a parent relationship is suggested.

### 4.3 `src/types/database.ts`

Add to `KnowledgeNode`:
```typescript
parent_anchor_id?: string | null
```

Add to `AnchorCandidateRow`:
```typescript
suggested_parent_anchor_id: string | null
```

---

## 5. `fetchClusterData` Update

**File:** `src/services/exploreQueries.ts`

### 5.1 Fetch parent_anchor_id alongside anchor nodes

Update the first SELECT in `fetchClusterData` to include `parent_anchor_id`:

```typescript
const { data: anchors, error: ancErr } = await supabase
  .from('knowledge_nodes')
  .select('id, label, entity_type, description, parent_anchor_id')
  .eq('user_id', userId)
  .eq('is_anchor', true)
  .order('label')
```

### 5.2 Compute sub-anchor relationships

After the existing cluster-building loop, add:

```typescript
// Build a map of parent_anchor_id → sub-anchor IDs
const subAnchorMap = new Map<string, string[]>()
for (const anchor of anchors ?? []) {
  const a = anchor as { id: string; parent_anchor_id: string | null }
  if (a.parent_anchor_id) {
    const existing = subAnchorMap.get(a.parent_anchor_id) ?? []
    existing.push(a.id)
    subAnchorMap.set(a.parent_anchor_id, existing)
  }
}
```

### 5.3 Add hierarchy fields to each cluster object

In the `.map(anchor => {...})` loop, update the returned cluster object:

```typescript
return {
  anchor: {
    id:             a.id,
    label:          a.label,
    entityType:     a.entity_type,
    description:    a.description,
    entityCount:    clusterNodes.length,
    parentAnchorId: a.parent_anchor_id ?? null,   // NEW
    isSubAnchor:    !!a.parent_anchor_id,          // NEW
  },
  entityCount:       clusterNodes.length,
  typeDistribution,
  position:          { cx: 0, cy: 0, r: 0 },
  crossClusterEdges,
  subAnchorIds:      subAnchorMap.get(a.id) ?? [], // NEW
}
```

---

## 6. `useClusterLayout.ts` Update

**File:** `src/hooks/useClusterLayout.ts`

The layout hook currently treats all clusters identically. With hierarchy, sub-anchor clusters must orbit their parent rather than floating freely.

### 6.1 Updated hook signature

```typescript
export function useClusterLayout(
  clusters: ClusterData[],
  width: number,
  height: number
): LayoutCluster[]
```

Signature unchanged — callers don't change. The hook detects hierarchy internally from `cluster.anchor.isSubAnchor` and `cluster.anchor.parentAnchorId`.

### 6.2 Two-pass layout algorithm

**Pass 1 — Root anchor layout (existing algorithm, sub-anchors excluded):**

Run the existing force simulation only on clusters where `!cluster.anchor.isSubAnchor`. This positions root anchors as today. Sub-anchors are excluded from the main physics loop so they don't push root anchors around.

```typescript
const rootClusters  = clusters.filter(c => !c.anchor.isSubAnchor)
const subClusters   = clusters.filter(c => c.anchor.isSubAnchor)

// Existing force simulation runs on rootClusters only
// minR/maxR sizing based on rootClusters entity counts only
```

**Pass 2 — Sub-anchor satellite positioning:**

After root positions are computed, position each sub-anchor radially around its parent. Multiple sub-anchors of the same parent are spread at equal angular intervals.

```typescript
// Group sub-anchors by parent
const subsByParent = new Map<string, typeof subClusters>()
for (const sc of subClusters) {
  const parentId = sc.anchor.parentAnchorId!
  const group = subsByParent.get(parentId) ?? []
  group.push(sc)
  subsByParent.set(parentId, group)
}

const SUB_ANCHOR_SIZE_FACTOR = 0.45  // sub-anchor radius = parent radius * 0.45
const SUB_ANCHOR_ORBIT_GAP  = 20    // pixels gap between parent edge and sub-anchor center

for (const [parentId, subs] of subsByParent) {
  const parent = positionedRoots.find(p => p.anchor.id === parentId)
  if (!parent) continue

  const subR = parent.position.r * SUB_ANCHOR_SIZE_FACTOR
  const orbitR = parent.position.r + subR + SUB_ANCHOR_ORBIT_GAP

  subs.forEach((sub, i) => {
    // Distribute evenly starting from the top (–π/2)
    const angle = -Math.PI / 2 + (i / subs.length) * Math.PI * 2
    const cx = parent.position.cx + Math.cos(angle) * orbitR
    const cy = parent.position.cy + Math.sin(angle) * orbitR

    positionedSubs.push({
      ...sub,
      position: { cx, cy, r: subR },
    })
  })
}
```

**Return value:** `[...positionedRoots, ...positionedSubs]` — all clusters with computed positions. The rest of the codebase receives the same flat array it always has; hierarchy is expressed through position, not a separate data structure.

---

## 7. `LandscapeView.tsx` Updates

**File:** `src/views/explore/LandscapeView.tsx`

Three changes to the SVG render:

### 7.1 Tether lines — render before cluster bubbles (layer 0)

Add a new layer before layer 1 (cross-cluster edges). Tether lines draw from sub-anchor center to parent anchor edge — thin, solid, in the parent's entity color at low opacity:

```tsx
{/* 0. Hierarchy tether lines — sub-anchors to their parents */}
{layoutClusters
  .filter(c => c.anchor.isSubAnchor && c.anchor.parentAnchorId)
  .map(subCluster => {
    const parent = layoutClusters.find(
      c => c.anchor.id === subCluster.anchor.parentAnchorId
    )
    if (!parent) return null

    // Line from sub-anchor center to parent edge (not center — stops at parent radius)
    const dx   = subCluster.position.cx - parent.position.cx
    const dy   = subCluster.position.cy - parent.position.cy
    const dist = Math.sqrt(dx * dx + dy * dy) || 1
    // End point: parent edge (parent center + normalized direction * parent radius)
    const ex   = parent.position.cx + (dx / dist) * parent.position.r
    const ey   = parent.position.cy + (dy / dist) * parent.position.r

    const color = getEntityColor(parent.anchor.entityType)

    return (
      <line
        key={`tether-${subCluster.anchor.id}`}
        x1={subCluster.position.cx}
        y1={subCluster.position.cy}
        x2={ex}
        y2={ey}
        stroke={color}
        strokeWidth={1.5}
        strokeOpacity={0.25}
        strokeDasharray="none"
        style={{ pointerEvents: 'none' }}
      />
    )
  })
}
```

`getEntityColor` is already imported in `LandscapeView.tsx`.

### 7.2 Pass `isSubAnchor` to ClusterBubble

Update the cluster bubble render (layer 2):

```tsx
{layoutClusters.map(cluster => (
  <ClusterBubble
    key={cluster.anchor.id}
    cluster={cluster}
    dimmed={!isClusterVisible(cluster)}
    isSubAnchor={cluster.anchor.isSubAnchor}   // NEW
    onHover={handleClusterHover}
    onClick={onClusterClick}
  />
))}
```

### 7.3 Sub-anchor count badge on parent clusters

When a parent cluster has sub-anchors, show a small badge in the bottom-right of the bubble indicating the count. This renders as an SVG element inside the `ClusterBubble` — handled via the `subAnchorCount` prop (see Section 8).

---

## 8. `ClusterBubble.tsx` Updates

**File:** `src/components/explore/ClusterBubble.tsx`

### 8.1 New props

```typescript
interface ClusterBubbleProps {
  cluster:         ClusterData
  dimmed:          boolean
  isSuggested?:    boolean    // PRD-20
  duplicateCount?: number     // PRD-20
  isSubAnchor?:    boolean    // PRD-22 — renders as smaller satellite
  subAnchorCount?: number     // PRD-22 — shows badge on parent bubbles
  onHover: (cluster: ClusterData | null, event: React.MouseEvent) => void
  onClick: (cluster: ClusterData) => void
}
```

`subAnchorCount` is derived from `cluster.subAnchorIds.length` in `LandscapeView` — pass it explicitly so `ClusterBubble` stays a pure presentation component.

### 8.2 Sub-anchor visual treatment

When `isSubAnchor` is true:

**Solid inner border** to distinguish from root anchors — a second inner circle:

```tsx
{isSubAnchor && (
  <circle
    r={r - 3}
    fill="none"
    stroke={getEntityColor(cluster.anchor.entityType)}
    strokeWidth={1}
    strokeOpacity={0.3}
  />
)}
```

**Slightly smaller label text** (11px instead of 13px):

```tsx
<text
  y={-6}
  textAnchor="middle"
  style={{
    fontFamily: 'var(--font-display)',
    fontSize: isSubAnchor ? 11 : 13,
    fontWeight: 700,
    fill: 'var(--color-text-primary)',
    pointerEvents: 'none',
    userSelect: 'none',
  }}
>
  {cluster.anchor.label.length > (isSubAnchor ? 14 : 18)
    ? cluster.anchor.label.slice(0, isSubAnchor ? 12 : 16) + '…'
    : cluster.anchor.label}
</text>
```

### 8.3 Sub-anchor count badge on parent bubbles

When `subAnchorCount > 0` (shown on parent clusters only, not on sub-anchors):

```tsx
{(subAnchorCount ?? 0) > 0 && !isSubAnchor && (
  <g transform={`translate(${r * 0.6}, ${r * 0.6})`}>
    <circle
      r={9}
      fill={getEntityColor(cluster.anchor.entityType)}
      fillOpacity={0.15}
      stroke={getEntityColor(cluster.anchor.entityType)}
      strokeWidth={1}
      strokeOpacity={0.4}
    />
    <text
      textAnchor="middle"
      dominantBaseline="middle"
      style={{
        fontFamily: 'var(--font-body)',
        fontSize: 8,
        fontWeight: 700,
        fill: getEntityColor(cluster.anchor.entityType),
        pointerEvents: 'none',
        userSelect: 'none',
      }}
    >
      {subAnchorCount}
    </text>
  </g>
)}
```

Import `getEntityColor` at the top of `ClusterBubble.tsx` — add `import { getEntityColor } from '../../config/entityTypes'`.

---

## 9. Scoring Engine Updates

Both the SQL scoring script and the serverless functions need parent suggestion logic. The rule: if a candidate node has embedding similarity > 0.85 to an existing confirmed anchor node, AND the candidate's composite score is ≥ 0.40 (anchor-worthy), set `suggested_parent_anchor_id` to that anchor's ID.

### 9.1 Updated SQL scoring script

**File:** `score-anchor-candidates-v4.sql` (new file, replaces v3)

Add a CTE after `top_candidates` that computes parent suggestions:

```sql
-- ── STEP 5B: Find suggested parent anchors via embedding similarity ────────────
-- For each top candidate, find the existing anchor with highest embedding similarity.
-- If similarity > 0.85 and below the auto-merge threshold (< 0.92), suggest as parent.

parent_suggestions AS (
  SELECT
    tc.node_id                                    AS candidate_node_id,
    an.id                                         AS suggested_parent_id,
    1 - (kn.embedding <=> an_emb.embedding)       AS similarity
  FROM top_candidates tc
  -- Join to get candidate embedding
  JOIN knowledge_nodes kn ON kn.id = tc.node_id AND kn.embedding IS NOT NULL
  -- Cross join with anchor nodes that have embeddings
  CROSS JOIN LATERAL (
    SELECT
      n.id,
      n.embedding,
      1 - (kn.embedding <=> n.embedding) AS sim
    FROM knowledge_nodes n
    WHERE n.user_id = tc.user_id
      AND n.is_anchor = true
      AND n.embedding IS NOT NULL
      AND n.id != tc.node_id
    ORDER BY kn.embedding <=> n.embedding
    LIMIT 1
  ) an_emb
  JOIN knowledge_nodes an ON an.id = an_emb.id
  WHERE an_emb.sim BETWEEN 0.85 AND 0.92
  -- Only suggest parent if the candidate isn't already close to being an exact duplicate
  -- (similarity > 0.92 would be handled by deduplication, not hierarchy)
)
```

Then in the `INSERT` statement, add `suggested_parent_anchor_id`:

```sql
INSERT INTO anchor_candidates (
  ...,
  suggested_parent_anchor_id  -- NEW
)
SELECT
  ...,
  (SELECT ps.suggested_parent_id FROM parent_suggestions ps
   WHERE ps.candidate_node_id = tc.node_id LIMIT 1)  AS suggested_parent_anchor_id
FROM top_candidates tc
...
```

And in `ON CONFLICT DO UPDATE`:

```sql
ON CONFLICT (user_id, node_id) DO UPDATE SET
  ...,
  suggested_parent_anchor_id = EXCLUDED.suggested_parent_anchor_id
```

**Note:** The LATERAL join with embedding similarity requires the `pgvector` extension and the `find_similar_nodes` function from PRD-21. Verify both are present before running v4. If embeddings are sparse (many nodes have `embedding IS NULL`), this CTE simply returns no rows — no parent suggestions are made, and the rest of the script works normally.

### 9.2 Serverless function updates

Both `api/anchors/score-post-extraction.ts` and `api/anchors/score-daily.ts` need an additional step to compute `suggested_parent_anchor_id` for candidates being upserted.

**Add inline after computing composite score, before calling `upsertCandidate`:**

```typescript
// ── FIND SUGGESTED PARENT ANCHOR ─────────────────────────────────────────────
// If this node's embedding is similar (0.85–0.92) to an existing anchor,
// suggest that anchor as a parent. Below 0.85 = unrelated, above 0.92 = duplicate.
let suggestedParentAnchorId: string | null = null

const { data: nodeWithEmbedding } = await supabase
  .from('knowledge_nodes')
  .select('embedding')
  .eq('id', nodeId)
  .maybeSingle()

if (nodeWithEmbedding?.embedding) {
  const { data: similarAnchors } = await supabase.rpc('find_similar_nodes', {
    p_user_id:          userId,
    p_embedding:        nodeWithEmbedding.embedding,
    p_entity_type:      signals.entityType ?? '',  // empty string = match all types
    p_limit:            1,
    p_min_similarity:   0.85,
  })

  const topMatch = similarAnchors?.[0]
  if (topMatch && (topMatch.similarity as number) < 0.92) {
    // Verify this node is actually an anchor
    const { data: anchorCheck } = await supabase
      .from('knowledge_nodes')
      .select('id')
      .eq('id', topMatch.id)
      .eq('is_anchor', true)
      .maybeSingle()

    if (anchorCheck) {
      suggestedParentAnchorId = topMatch.id as string
    }
  }
}
```

Pass `suggestedParentAnchorId` to `upsertCandidate` and write it to the `anchor_candidates` row.

**Note:** The `find_similar_nodes` function signature from PRD-21 uses `p_entity_type` as a filter. For parent suggestion, we want cross-type similarity (e.g. a Topic candidate related to an Anchor-typed anchor). Pass an empty string or modify the RPC to accept `NULL` for entity type when calling for parent suggestion. The simplest approach: add a separate `find_similar_anchors` RPC that omits the entity type filter:

```sql
-- Add to migration (or run separately in Supabase SQL Editor):
CREATE OR REPLACE FUNCTION find_similar_anchors(
  p_user_id        UUID,
  p_embedding      vector(768),
  p_limit          INT DEFAULT 3,
  p_min_similarity FLOAT DEFAULT 0.85
)
RETURNS TABLE (id UUID, label TEXT, similarity FLOAT)
LANGUAGE sql STABLE AS $$
  SELECT
    id, label,
    1 - (embedding <=> p_embedding) AS similarity
  FROM knowledge_nodes
  WHERE user_id     = p_user_id
    AND is_anchor   = true
    AND is_merged   = false
    AND embedding   IS NOT NULL
    AND 1 - (embedding <=> p_embedding) >= p_min_similarity
  ORDER BY embedding <=> p_embedding
  LIMIT p_limit;
$$;
```

Add this function to the migration file from Step 3.

---

## 10. `anchorCandidates.ts` Service Updates

**File:** `src/services/anchorCandidates.ts`

### 10.1 Update `mapRow`

Add `suggestedParentAnchorId` to the returned object:

```typescript
function mapRow(row: AnchorCandidateRow): AnchorCandidate {
  return {
    // ... all existing fields ...
    suggestedParentAnchorId: row.suggested_parent_anchor_id,
  }
}
```

### 10.2 Add `promoteToSubAnchor`

Called when user confirms a candidate as a sub-anchor of a specific parent:

```typescript
export async function promoteToSubAnchor(
  candidateId:    string,
  nodeId:         string,
  parentAnchorId: string
): Promise<boolean> {
  const now = new Date().toISOString()

  // Verify parent is actually an anchor (safety check)
  const { data: parentCheck } = await supabase
    .from('knowledge_nodes')
    .select('id, is_anchor, parent_anchor_id')
    .eq('id', parentAnchorId)
    .maybeSingle()

  if (!parentCheck?.is_anchor) {
    console.error('[anchorCandidates] promoteToSubAnchor: parent is not an anchor')
    return false
  }

  // Parent cannot itself be a sub-anchor (one level deep only)
  if (parentCheck.parent_anchor_id) {
    console.error('[anchorCandidates] promoteToSubAnchor: parent is already a sub-anchor')
    return false
  }

  // Set is_anchor = true AND parent_anchor_id on the node
  const { error: nodeError } = await supabase
    .from('knowledge_nodes')
    .update({ is_anchor: true, parent_anchor_id: parentAnchorId })
    .eq('id', nodeId)

  if (nodeError) {
    console.error('[anchorCandidates] promoteToSubAnchor node error:', nodeError.message)
    return false
  }

  // Update candidate to confirmed status
  const { error: candidateError } = await supabase
    .from('anchor_candidates')
    .update({ status: 'confirmed', reviewed_at: now })
    .eq('id', candidateId)

  if (candidateError) {
    // Rollback
    await supabase.from('knowledge_nodes').update({ is_anchor: false, parent_anchor_id: null }).eq('id', nodeId)
    return false
  }

  return true
}
```

### 10.3 Add `removeSubAnchorRelationship`

Called from `AnchorDetailPanel` when user demotes a sub-anchor back to a root anchor:

```typescript
export async function removeSubAnchorRelationship(
  nodeId: string
): Promise<boolean> {
  const { error } = await supabase
    .from('knowledge_nodes')
    .update({ parent_anchor_id: null })
    .eq('id', nodeId)

  if (error) {
    console.error('[anchorCandidates] removeSubAnchorRelationship error:', error.message)
    return false
  }
  return true
}
```

### 10.4 Add `fetchAnchorHierarchyInfo`

Used by `AnchorDetailPanel` to show parent and sibling sub-anchors:

```typescript
export async function fetchAnchorHierarchyInfo(
  userId: string,
  nodeId: string
): Promise<AnchorHierarchyInfo> {
  // Get this node's parent_anchor_id
  const { data: thisNode } = await supabase
    .from('knowledge_nodes')
    .select('id, parent_anchor_id')
    .eq('id', nodeId)
    .eq('user_id', userId)
    .maybeSingle()

  const parentAnchorId = (thisNode?.parent_anchor_id as string | null) ?? null

  // Get parent details if it exists
  let parentLabel: string | null = null
  let parentEntityType: string | null = null
  if (parentAnchorId) {
    const { data: parent } = await supabase
      .from('knowledge_nodes')
      .select('label, entity_type')
      .eq('id', parentAnchorId)
      .maybeSingle()
    parentLabel      = parent?.label as string ?? null
    parentEntityType = parent?.entity_type as string ?? null
  }

  // Get sub-anchors (nodes that have this node as parent)
  const { data: subAnchors } = await supabase
    .from('knowledge_nodes')
    .select('id, label, entity_type')
    .eq('user_id', userId)
    .eq('parent_anchor_id', nodeId)
    .eq('is_anchor', true)

  // Get entity counts for sub-anchors via edge count (approximate)
  const subAnchorList = await Promise.all(
    (subAnchors ?? []).map(async sa => {
      const { count } = await supabase
        .from('knowledge_edges')
        .select('id', { count: 'exact', head: true })
        .or(`source_node_id.eq.${sa.id},target_node_id.eq.${sa.id}`)
      return {
        id:          sa.id as string,
        label:       sa.label as string,
        entityType:  sa.entity_type as string,
        entityCount: count ?? 0,
      }
    })
  )

  return { parentAnchorId, parentLabel, parentEntityType, subAnchors: subAnchorList }
}
```

---

## 11. `AnchorDetailPanel.tsx` Updates

**File:** `src/components/anchors/AnchorDetailPanel.tsx`

### 11.1 Load hierarchy info on mount

Add a `useEffect` that calls `fetchAnchorHierarchyInfo` when the panel opens:

```typescript
const [hierarchyInfo, setHierarchyInfo] = useState<AnchorHierarchyInfo | null>(null)

useEffect(() => {
  if (!node || !candidate.userId) return
  fetchAnchorHierarchyInfo(candidate.userId, node.id)
    .then(setHierarchyInfo)
    .catch(() => setHierarchyInfo(null))
}, [node?.id, candidate.userId])
```

### 11.2 Hierarchy section

Add a "Hierarchy" section below the signal breakdown and above the connected nodes section:

**When this anchor is a sub-anchor (has a parent):**
```
┌─ HIERARCHY ─────────────────────────────────────────────────────┐
│  Parent: [◆ dot] AI Risk Management    [Topic]   [→ View]       │
│                                                                  │
│  [Remove parent relationship]  ← ghost button, small           │
└─────────────────────────────────────────────────────────────────┘
```

**When this anchor has sub-anchors:**
```
┌─ HIERARCHY ─────────────────────────────────────────────────────┐
│  Sub-anchors (3):                                               │
│  [◆] AI Security       [Topic]                                  │
│  [◆] Risk Assessment   [Action]                                 │
│  [◆] AI Risk Mgmt Sys  [Product]                                │
└─────────────────────────────────────────────────────────────────┘
```

Each sub-anchor chip is clickable — clicking navigates to that anchor's detail.

**Implementation:**

```tsx
{/* Hierarchy section */}
{hierarchyInfo && (hierarchyInfo.parentAnchorId || hierarchyInfo.subAnchors.length > 0) && (
  <div style={{ marginBottom: 16 }}>
    <div style={{
      fontFamily: 'var(--font-display)', fontSize: 10, fontWeight: 700,
      textTransform: 'uppercase' as const, letterSpacing: '0.08em',
      color: 'var(--color-text-secondary)', marginBottom: 8,
    }}>
      Hierarchy
    </div>

    {/* Parent relationship */}
    {hierarchyInfo.parentAnchorId && (
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '8px 10px', borderRadius: 8,
        background: 'var(--color-bg-inset)', marginBottom: 6,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <span style={{ fontSize: 11, color: 'var(--color-text-secondary)', flexShrink: 0 }}>
            Parent:
          </span>
          <span style={{
            width: 6, height: 6, borderRadius: '50%',
            background: getEntityColor(hierarchyInfo.parentEntityType ?? 'Anchor'),
            flexShrink: 0,
          }} />
          <span style={{
            fontFamily: 'var(--font-body)', fontSize: 12, fontWeight: 600,
            color: 'var(--color-text-primary)',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {hierarchyInfo.parentLabel}
          </span>
        </div>
        <button
          type="button"
          onClick={handleRemoveParent}
          style={{
            fontFamily: 'var(--font-body)', fontSize: 10, fontWeight: 600,
            color: 'var(--color-text-secondary)',
            background: 'none', border: 'none', cursor: 'pointer', flexShrink: 0,
          }}
        >
          Remove
        </button>
      </div>
    )}

    {/* Sub-anchors list */}
    {hierarchyInfo.subAnchors.length > 0 && (
      <div>
        <span style={{
          fontFamily: 'var(--font-body)', fontSize: 11, color: 'var(--color-text-secondary)',
        }}>
          Sub-anchors ({hierarchyInfo.subAnchors.length}):
        </span>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 6 }}>
          {hierarchyInfo.subAnchors.map(sa => (
            <div
              key={sa.id}
              style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '6px 10px', borderRadius: 6,
                background: 'var(--color-bg-inset)',
                cursor: 'pointer',
              }}
              onClick={() => onSelectSubAnchor?.(sa.id)}
            >
              <span style={{
                width: 6, height: 6, borderRadius: '50%',
                background: getEntityColor(sa.entityType), flexShrink: 0,
              }} />
              <span style={{
                fontFamily: 'var(--font-body)', fontSize: 12,
                color: 'var(--color-text-primary)', flex: 1,
              }}>
                {sa.label}
              </span>
              <EntityBadge type={sa.entityType} size="xs" />
            </div>
          ))}
        </div>
      </div>
    )}
  </div>
)}
```

Add `onSelectSubAnchor?: (nodeId: string) => void` to `AnchorDetailPanelProps`. Called when user clicks a sub-anchor row — the Anchors page uses this to navigate to that anchor's detail.

Add `handleRemoveParent` handler:

```typescript
const handleRemoveParent = async () => {
  if (!node) return
  const success = await removeSubAnchorRelationship(node.id)
  if (success) {
    setHierarchyInfo(prev => prev ? { ...prev, parentAnchorId: null, parentLabel: null, parentEntityType: null } : null)
    window.dispatchEvent(new CustomEvent('synapse:anchor-confirmed'))  // triggers Explore refetch
    onRefresh?.()
  }
}
```

Add `onRefresh?: () => void` to `AnchorDetailPanelProps` — called after hierarchy changes. `AnchorsView` passes `refetch` here.

### 11.3 Suggested parent section (for suggested candidates)

When `candidate.suggestedParentAnchorId` is not null, show the parent suggestion in the reasoning section:

```tsx
{candidate.suggestedParentAnchorId && (
  <div style={{
    background: 'rgba(100,116,139,0.05)',
    border: '1px solid rgba(100,116,139,0.2)',
    borderRadius: 8, padding: '8px 12px', marginBottom: 12,
  }}>
    <p style={{
      fontFamily: 'var(--font-body)', fontSize: 11,
      color: 'var(--color-text-secondary)', margin: 0, lineHeight: 1.5,
    }}>
      ⊃ This concept may belong under an existing anchor. See confirmation options below.
    </p>
  </div>
)}
```

---

## 12. `AnchorCard.tsx` Updates

**File:** `src/components/anchors/AnchorCard.tsx`

### 12.1 Sub-anchor visual treatment in the list

When `candidate.node.parent_anchor_id` is set (after the anchor is confirmed), the card should show:

1. **Left indentation** — `marginLeft: 16` when the card is in a sub-anchor position
2. **Parent badge** — a small chip below the label showing the parent anchor name

Add to `AnchorCardProps`:
```typescript
parentLabel?: string  // populated by AnchorsView when building the confirmed list
```

When `parentLabel` is provided, render below the entity type badge:

```tsx
{parentLabel && (
  <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 4 }}>
    <span style={{
      fontFamily: 'var(--font-body)', fontSize: 9,
      color: 'var(--color-text-secondary)',
    }}>
      sub-anchor of
    </span>
    <span style={{
      fontFamily: 'var(--font-body)', fontSize: 9, fontWeight: 600,
      color: 'var(--color-text-secondary)',
      background: 'var(--color-bg-inset)',
      padding: '1px 6px', borderRadius: 4,
      border: '1px solid var(--border-subtle)',
    }}>
      {parentLabel}
    </span>
  </div>
)}
```

---

## 13. `AnchorsView.tsx` Updates

**File:** `src/views/AnchorsView.tsx`

### 13.1 Group confirmed anchors by hierarchy in the list

In the YOUR ANCHORS section, root anchors render first. Their sub-anchors render immediately below them, slightly indented. The sort within each group follows the existing `sortKey`.

Update the `filteredConfirmed` rendering logic to build a hierarchical list:

```typescript
// Build ordered list: root anchors + their sub-anchors inline
const hierarchicalConfirmed = useMemo(() => {
  const roots = filteredConfirmed.filter(c => !c.node?.parent_anchor_id)
  const subs  = filteredConfirmed.filter(c => !!c.node?.parent_anchor_id)
  
  const result: Array<AnchorCandidateWithNode & { parentLabel?: string }> = []
  
  for (const root of roots) {
    result.push(root)
    // Append sub-anchors of this root immediately after
    const children = subs.filter(s => s.node?.parent_anchor_id === root.nodeId)
    for (const child of children) {
      const parentLabel = root.node?.label ?? undefined
      result.push({ ...child, parentLabel })
    }
  }
  
  // Append any sub-anchors whose parent is not in the current filtered list
  const addedIds = new Set(result.map(r => r.id))
  for (const sub of subs) {
    if (!addedIds.has(sub.id)) result.push(sub)
  }
  
  return result
}, [filteredConfirmed])
```

### 13.2 Confirm handler — two-path confirmation

Update `handleConfirm` in `AnchorsView` to handle both independent anchor and sub-anchor confirmation:

```typescript
const handleConfirmAsSubAnchor = useCallback(async (
  candidateId: string,
  nodeId:      string,
  parentId:    string
) => {
  const candidate = suggested.find(c => c.id === candidateId)
  if (!candidate) return

  // Optimistic update
  setSuggested(prev => prev.filter(c => c.id !== candidateId))

  const success = await promoteToSubAnchor(candidateId, nodeId, parentId)
  if (!success) {
    setSuggested(prev => [...prev, candidate])
  } else {
    await refreshAnchors()
    fetchHealth()
    window.dispatchEvent(new CustomEvent('synapse:anchor-confirmed', { detail: { nodeId } }))
    window.dispatchEvent(new CustomEvent('synapse:anchor-suggestions-changed'))
  }
}, [suggested, refreshAnchors, fetchHealth])
```

Pass `handleConfirmAsSubAnchor` down to the `AnchorDetailPanel` for the right panel case, and add it to the `AnchorCard` `onConfirmAsSubAnchor` prop for inline confirmation.

---

## 14. `SuggestedAnchorPanel` in `ExploreMetadataPanel.tsx` — Fill PRD-20 Placeholder

**File:** `src/views/explore/ExploreMetadataPanel.tsx`

PRD-20 added a comment `{/* Change 3: sub-anchor suggestion (PRD-22 forward compat) — when suggestedParentAnchorId is populated by PRD-22, this renders */}` in `SuggestedAnchorPanel`. This PRD fills it in.

Locate the actions section in `SuggestedAnchorPanel`. When `candidate.suggestedParentAnchorId` is not null, replace the single "✓ Confirm Anchor" button with two options:

```tsx
{candidate.suggestedParentAnchorId ? (
  // Two-option confirmation: independent or sub-anchor
  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
    <button
      type="button"
      onClick={handleConfirm}
      disabled={confirming || !node}
      style={{
        width: '100%', padding: '9px 0', borderRadius: 8, border: 'none',
        background: confirming ? 'var(--color-bg-inset)' : 'var(--color-accent-500)',
        color: confirming ? 'var(--color-text-secondary)' : 'white',
        fontFamily: 'var(--font-body)', fontSize: 13, fontWeight: 600,
        cursor: confirming ? 'default' : 'pointer',
      }}
    >
      {confirming ? 'Confirming…' : '✓ Confirm as Independent Anchor'}
    </button>
    <button
      type="button"
      onClick={handleConfirmAsSubAnchor}
      disabled={confirming || !node}
      style={{
        width: '100%', padding: '9px 0', borderRadius: 8,
        border: '1px solid var(--border-default)',
        background: 'var(--color-bg-inset)',
        color: 'var(--color-text-body)',
        fontFamily: 'var(--font-body)', fontSize: 12, fontWeight: 600,
        cursor: confirming ? 'default' : 'pointer',
      }}
    >
      ⊃ Add as sub-anchor of existing anchor
    </button>
  </div>
) : (
  // Single confirmation button (no parent suggestion)
  <button
    type="button"
    onClick={handleConfirm}
    disabled={confirming || !node}
    style={{ /* ... same styles ... */ }}
  >
    {confirming ? 'Confirming…' : '✓ Confirm Anchor'}
  </button>
)}
```

The `handleConfirmAsSubAnchor` handler:

```typescript
const handleConfirmAsSubAnchor = async () => {
  if (!node || !candidate.suggestedParentAnchorId) return
  setConfirming(true)
  // Import promoteToSubAnchor from anchorCandidates service
  const { promoteToSubAnchor } = await import('../../services/anchorCandidates')
  const success = await promoteToSubAnchor(candidate.id, node.id, candidate.suggestedParentAnchorId)
  if (success) {
    await onConfirm(candidate.id, node.id)  // triggers the parent's optimistic update + refetch
  }
  setConfirming(false)
}
```

Use dynamic import to avoid circular import concerns. Alternatively, pass `onConfirmAsSubAnchor` as a prop from `ExploreView` — cleaner but requires more prop threading. Either approach is acceptable.

---

## 15. Forward-Compatible Decisions

- **One level deep, enforced by Postgres trigger.** The `prevent_circular_anchor_hierarchy` trigger rejects any attempt to set `parent_anchor_id` on a node that already has sub-anchors, and rejects self-referential parents. This constraint is in the database, not just the application layer — it can't be circumvented by a buggy service call.

- **`cluster.subAnchorIds` is pre-computed in `fetchClusterData`.** The Landscape view receives complete hierarchy information in the initial data fetch. No lazy loading, no follow-up queries for hierarchy rendering.

- **Sub-anchors participate in cross-cluster edge rendering as independent clusters.** The `crossClusterEdges` computation in `fetchClusterData` runs on all anchors including sub-anchors. This means a sub-anchor can have cross-cluster edges to anchors outside its parent's hierarchy — which is correct behaviour. A sub-topic of "AI Risk Management" may also relate to "Financial Literacy".

- **`parent_anchor_id` is nullable with `ON DELETE SET NULL`.** If a parent anchor is demoted (set back to `is_anchor = false`), its sub-anchors automatically become root anchors rather than becoming orphaned. The Explore graph handles this cleanly on the next `refetch()`.

- **`AnchorHierarchyInfo` is fetched lazily** in `AnchorDetailPanel` only when the panel opens, not as part of the main `useAnchorCandidates` hook. This keeps the hook lightweight and avoids N+1 queries for the list view.

---

## 16. Edge Cases and Error Handling

- **Circular hierarchy attempted via direct Supabase call:** Caught by the Postgres trigger. The service function will receive an error and return `false`. No UI state is corrupted.

- **Parent anchor is later demoted** (user sets `is_anchor = false` on a parent): `ON DELETE SET NULL` fires and `parent_anchor_id` on all children becomes null. On next Explore load, children appear as root anchors. `fetchAnchorHierarchyInfo` returns `parentAnchorId: null`. The hierarchy section in `AnchorDetailPanel` disappears. No special handling needed.

- **`suggested_parent_anchor_id` points to an anchor that has since been demoted:** The SQL and serverless scoring joins against `is_anchor = true` when looking up anchors, so stale suggestions are filtered at read time. The UI will show no parent suggestion for these candidates.

- **Many sub-anchors of one parent (5+):** `useClusterLayout` distributes them at equal angular intervals around the parent orbit. At 5+ satellites the orbit gets tight. The orbit radius scales with parent radius (`parent.r + sub.r + 20px`) — larger parent anchors have more orbital room. Cap at 8 sub-anchors visually in `LandscapeView`; extra sub-anchors appear only in the `AnchorDetailPanel` sub-anchor list, not as visual satellites.

- **Sub-anchor node has no embeddings:** The parent suggestion step in the scoring engine skips it (`embedding IS NOT NULL` filter). The candidate surfaces as a standard suggested anchor with no parent relationship. The user can manually assign a parent from `AnchorDetailPanel` using the "Add parent" flow in a future enhancement.

- **`promoteToSubAnchor` fails mid-way** (node updated but candidate status not): The rollback sets `is_anchor = false` and `parent_anchor_id = null` on the node. The candidate remains in `suggested` state. The user can retry from the Anchors page.

---

## 17. Acceptance Criteria

- [ ] Migration runs cleanly: `parent_anchor_id` column exists on `knowledge_nodes`, `suggested_parent_anchor_id` exists on `anchor_candidates`, `prevent_circular_anchor_hierarchy` trigger exists, `find_similar_anchors` RPC function exists
- [ ] Setting a node's `parent_anchor_id` to a node that already has `parent_anchor_id` set raises a Postgres exception (one-level-deep enforcement)
- [ ] Setting `parent_anchor_id = node_id` (self-referential) raises a Postgres exception
- [ ] `fetchClusterData` returns `subAnchorIds: ['id1', 'id2']` on parent clusters and `parentAnchorId: 'parentId'`, `isSubAnchor: true` on sub-anchor clusters
- [ ] In the Explore Landscape view, sub-anchor clusters render as smaller bubbles orbiting their parent at `parent.r * 0.45` radius
- [ ] Tether lines draw from sub-anchor centers to the parent cluster edge (not center), in the parent's entity type color at 25% opacity
- [ ] Parent clusters show a sub-anchor count badge (bottom-right) when they have sub-anchors
- [ ] Clicking a sub-anchor cluster enters its Neighborhood view as normal
- [ ] `useClusterLayout` positions root anchors with the existing physics simulation; sub-anchors are positioned in Pass 2 without affecting root anchor positions
- [ ] `score-anchor-candidates-v4.sql` produces `suggested_parent_anchor_id` values for candidates with embedding similarity 0.85–0.92 to existing anchors
- [ ] The Anchors page shows confirmed sub-anchors indented under their parent with "sub-anchor of [parent]" chip
- [ ] `AnchorDetailPanel` for a sub-anchor shows parent anchor name with a "Remove" action
- [ ] `AnchorDetailPanel` for a parent anchor shows all its sub-anchors as clickable rows
- [ ] Clicking "Remove" on a sub-anchor relationship sets `parent_anchor_id = null`, the anchor becomes a root anchor, Explore refetches
- [ ] `SuggestedAnchorPanel` in Explore shows two confirmation buttons when `candidate.suggestedParentAnchorId` is non-null: "Confirm as Independent Anchor" and "Add as sub-anchor of existing anchor"
- [ ] Clicking "Add as sub-anchor": node gets `is_anchor = true` AND `parent_anchor_id` set, candidate moves to confirmed, Explore refetches showing the new satellite
- [ ] Confirming as sub-anchor from the Anchors page works the same way
- [ ] `fetchAnchorHierarchyInfo` returns correct parent and sub-anchor data
- [ ] All modified TypeScript files compile with zero errors in strict mode
- [ ] No existing Explore, Anchors page, or extraction functionality is broken
