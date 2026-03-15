# PRD-23 — Anchor Knowledge Inheritance

**Phase:** 5 — Intelligence Layer  
**Dependencies:** PRD-22 (anchor hierarchy — `parent_anchor_id`, `subAnchorIds`, tether lines, satellite layout all in place)  
**Estimated Complexity:** High  
**Estimated Effort:** 2–3 sessions

---

## 1. What PRD-22 Built vs What's Still Missing

PRD-22 established the structural hierarchy: sub-anchor bubbles orbit their parent in Explore, tether lines connect them, `parent_anchor_id` is stored on the node. **What it did not build** is the knowledge flowing from sub-anchors up to the parent.

Right now, clicking "AI Agents" in Explore shows only its 15 direct entities. MCP, Claude Code, and AI Coding Agents are visually connected to it but their 97 combined entities are invisible from the parent view. Clicking into AI Agents feels empty compared to its sub-anchors.

This PRD adds three things on top of PRD-22:

1. **Inheritance edges** — when a node becomes a sub-anchor, its entities propagate to the parent via `inherited_from` edges in `knowledge_edges`. The parent anchor's score, RAG weight, and visual size all increase automatically.

2. **Combined neighborhood view** — clicking a parent anchor shows all inherited entities grouped by sub-anchor origin, with sub-anchor hubs navigable within the view.

3. **Inheritance cleanup** — when a sub-anchor relationship is dissolved, the inherited edges are removed cleanly.

---

## 2. What Gets Built

### Database migration
- `supabase/migrations/20260315_prd23_inheritance.sql`

### Modified files
- `src/services/anchorCandidates.ts` — expand `promoteToSubAnchor` with edge inheritance; update `removeSubAnchorRelationship` to clean up
- `src/services/exploreQueries.ts` — update `fetchClusterData` to compute inherited entity count for bubble sizing; update `fetchClusterEntities` to include inherited entities when showing a parent cluster
- `src/types/explore.ts` — add `inheritedEntityCount` and `directEntityCount` to `ClusterData`
- `src/views/explore/NeighborhoodView.tsx` — dual-mode view: parent mode shows inherited entities grouped by sub-anchor hub; sub-anchor breadcrumb navigation
- `src/hooks/useClusterLayout.ts` — use `inheritedEntityCount` (not `entityCount`) for bubble sizing of parent clusters

### No new files
Everything builds on existing PRD-22 structures. Zero new files.

---

## 3. Database Migration

**File:** `supabase/migrations/20260315_prd23_inheritance.sql`

```sql
-- PRD-23: Anchor Knowledge Inheritance
-- Adds is_inherited flag to knowledge_edges so inherited edges can be
-- identified and removed cleanly when sub-anchor relationships are dissolved.

ALTER TABLE knowledge_edges
  ADD COLUMN IF NOT EXISTS is_inherited BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS inherited_from_anchor_id UUID
    REFERENCES knowledge_nodes(id) ON DELETE SET NULL;

-- Index for fast cleanup: "delete all inherited edges from this sub-anchor"
CREATE INDEX IF NOT EXISTS idx_knowledge_edges_inherited
  ON knowledge_edges (inherited_from_anchor_id)
  WHERE is_inherited = true;
```

That's the only schema change needed. Two columns, one index. All existing edges keep `is_inherited = false` and behave exactly as before.

---

## 4. `anchorCandidates.ts` — Expand `promoteToSubAnchor`

**File:** `src/services/anchorCandidates.ts`

The current `promoteToSubAnchor` function sets `parent_anchor_id` and confirms the candidate. Replace the `return true` at the end with the inheritance step, keeping everything before it identical:

```typescript
export async function promoteToSubAnchor(
  candidateId:    string,
  nodeId:         string,
  parentAnchorId: string
): Promise<boolean> {
  // ... all existing validation and node/candidate update code unchanged ...
  // The function currently ends with `return true` after confirming the candidate.
  // Replace that final `return true` with the inheritance block below:

  // ── INHERITANCE: propagate sub-anchor entities to parent ─────────────────
  // Fire-and-forget — don't block the UI on this. If it fails, the relationship
  // still exists; the next daily scoring pass will retry via the healing logic.
  propagateInheritanceToParent(nodeId, parentAnchorId).catch(err => {
    console.warn('[anchorCandidates] Inheritance propagation failed (non-fatal):', err)
  })

  // Dispatch event to trigger Explore refetch after a delay (inheritance takes ~2s)
  window.dispatchEvent(new CustomEvent('synapse:anchor-confirmed', { detail: { nodeId } }))
  setTimeout(() => {
    window.dispatchEvent(new CustomEvent('synapse:anchor-confirmed', { detail: { nodeId } }))
  }, 5000)

  return true
}
```

Add the `propagateInheritanceToParent` helper function below `promoteToSubAnchor`:

```typescript
// ── INTERNAL: propagate sub-anchor entities to parent anchor ─────────────────
// Creates `inherited_from` edges between the parent anchor and all entities
// connected to the sub-anchor. Skips entities already connected to the parent.
// Called after promoteToSubAnchor succeeds. Non-blocking (fire-and-forget).

async function propagateInheritanceToParent(
  subAnchorId:    string,
  parentAnchorId: string
): Promise<{ edgesCreated: number }> {
  // 1. Get the sub-anchor's user_id
  const { data: subAnchorNode } = await supabase
    .from('knowledge_nodes')
    .select('user_id')
    .eq('id', subAnchorId)
    .maybeSingle()

  if (!subAnchorNode) return { edgesCreated: 0 }
  const userId = subAnchorNode.user_id as string

  // 2. Fetch all entities directly connected to the sub-anchor
  const { data: subEdges } = await supabase
    .from('knowledge_edges')
    .select('source_node_id, target_node_id')
    .eq('user_id', userId)
    .eq('is_inherited', false)  // only real edges, not previously inherited ones
    .or(`source_node_id.eq.${subAnchorId},target_node_id.eq.${subAnchorId}`)

  // Collect entity IDs connected to this sub-anchor (excluding other anchors)
  const entityIds = new Set<string>()
  for (const edge of subEdges ?? []) {
    const src = edge.source_node_id as string
    const tgt = edge.target_node_id as string
    const entityId = src === subAnchorId ? tgt : src
    if (entityId !== parentAnchorId) entityIds.add(entityId)
  }

  if (entityIds.size === 0) return { edgesCreated: 0 }

  // 3. Find which of these entities are already connected to the parent
  //    (either directly or via a previous inheritance)
  const { data: existingParentEdges } = await supabase
    .from('knowledge_edges')
    .select('source_node_id, target_node_id')
    .eq('user_id', userId)
    .or(`source_node_id.eq.${parentAnchorId},target_node_id.eq.${parentAnchorId}`)

  const alreadyConnected = new Set<string>()
  for (const edge of existingParentEdges ?? []) {
    const src = edge.source_node_id as string
    const tgt = edge.target_node_id as string
    alreadyConnected.add(src === parentAnchorId ? tgt : src)
  }

  // 4. Create inherited edges for entities not already connected to parent
  const toInsert = Array.from(entityIds)
    .filter(id => !alreadyConnected.has(id))
    .map(entityId => ({
      user_id:                    userId,
      source_node_id:             parentAnchorId,
      target_node_id:             entityId,
      relation_type:              'inherited_from',
      evidence:                   `Inherited from sub-anchor: ${subAnchorId}`,
      weight:                     0.5,          // lower weight than direct connections
      is_inherited:               true,
      inherited_from_anchor_id:   subAnchorId,
    }))

  if (toInsert.length === 0) return { edgesCreated: 0 }

  const { error } = await supabase
    .from('knowledge_edges')
    .insert(toInsert)

  if (error) {
    console.error('[anchorCandidates] propagateInheritanceToParent insert error:', error.message)
    throw error
  }

  console.log(`[anchorCandidates] Created ${toInsert.length} inherited edges: ${subAnchorId} → ${parentAnchorId}`)
  return { edgesCreated: toInsert.length }
}
```

Also export `propagateInheritanceToParent` — it's needed by `removeSubAnchorRelationship` cleanup and the backfill script:

```typescript
export { propagateInheritanceToParent }
```

---

## 5. `anchorCandidates.ts` — Update `removeSubAnchorRelationship`

When a sub-anchor is demoted back to a root anchor, clean up the inherited edges. Replace the current simple implementation:

```typescript
export async function removeSubAnchorRelationship(
  nodeId: string
): Promise<boolean> {
  // 1. Find the current parent before clearing it
  const { data: nodeData } = await supabase
    .from('knowledge_nodes')
    .select('parent_anchor_id, user_id')
    .eq('id', nodeId)
    .maybeSingle()

  const parentAnchorId = nodeData?.parent_anchor_id as string | null

  // 2. Clear the parent relationship
  const { error } = await supabase
    .from('knowledge_nodes')
    .update({ parent_anchor_id: null })
    .eq('id', nodeId)

  if (error) {
    console.error('[anchorCandidates] removeSubAnchorRelationship error:', error.message)
    return false
  }

  // 3. Remove inherited edges that came from this sub-anchor
  if (parentAnchorId) {
    const { error: cleanupError } = await supabase
      .from('knowledge_edges')
      .delete()
      .eq('inherited_from_anchor_id', nodeId)
      .eq('is_inherited', true)

    if (cleanupError) {
      console.warn('[anchorCandidates] Failed to clean up inherited edges:', cleanupError.message)
      // Non-fatal — the relationship is still removed, orphaned edges will be cleaned by daily scorer
    }
  }

  // Trigger Explore refetch
  window.dispatchEvent(new CustomEvent('synapse:anchor-confirmed'))

  return true
}
```

---

## 6. `exploreQueries.ts` — Inherited Entity Count for Bubble Sizing

**File:** `src/services/exploreQueries.ts`

### 6.1 Update `ClusterData` population in `fetchClusterData`

The current code computes `entityCount` from direct edges only. Add `inheritedEntityCount` and `directEntityCount` separately.

In the cluster-building loop, after computing `clusterNodes` (direct entities), add:

```typescript
// Count inherited entities for this anchor (from sub-anchors)
// These are edges with is_inherited=true and source_node_id = this anchor's ID
const inheritedNodeIds = new Set<string>()
for (const edge of allEdges) {
  // We need is_inherited flag — see note below about edge fetching
  if (
    (edge as { source_node_id: string; target_node_id: string; is_inherited?: boolean }).is_inherited &&
    edge.source_node_id === a.id
  ) {
    inheritedNodeIds.add(edge.target_node_id)
  }
}

// Remove direct entities from inherited count (avoid double-counting)
for (const directId of clusterNodeIds) {
  inheritedNodeIds.delete(directId)
}

const directEntityCount    = clusterNodes.length
const inheritedEntityCount = inheritedNodeIds.size
```

**Important:** The current edge fetch in step 3 selects only `source_node_id, target_node_id`. Update it to also select `is_inherited`:

```typescript
// Step 3: Fetch all edges — add is_inherited to the select
const { data, error } = await supabase
  .from('knowledge_edges')
  .select('source_node_id, target_node_id, is_inherited')  // ADD is_inherited
  .eq('user_id', userId)
  .range(offset, offset + PAGE - 1)
```

### 6.2 Update the cluster return object

```typescript
return {
  anchor: {
    id: a.id,
    label: a.label,
    entityType: a.entity_type,
    description: a.description,
    entityCount: directEntityCount + inheritedEntityCount,  // total for display
    parentAnchorId: a.parent_anchor_id ?? null,
    isSubAnchor: !!a.parent_anchor_id,
  },
  entityCount:           directEntityCount + inheritedEntityCount,  // total — drives bubble size
  directEntityCount,                                                 // NEW
  inheritedEntityCount,                                              // NEW
  typeDistribution,
  position:          { cx: 0, cy: 0, r: 0 },
  crossClusterEdges,
  subAnchorIds:      subAnchorMap.get(a.id) ?? [],
}
```

### 6.3 Update `fetchClusterEntities` for parent mode

The current function fetches entities connected to a single `anchorId`. For parent anchors that have sub-anchors, it should also include entities connected to those sub-anchors.

Add a parameter `includeSubAnchors: boolean = true` and a `subAnchorIds` parameter:

```typescript
export async function fetchClusterEntities(
  userId:           string,
  anchorId:         string,
  clusterData?:     ClusterData[],
  subAnchorIds?:    string[]          // NEW — pass sub-anchor IDs to include their entities
): Promise<EntityNode[]> {
  
  // Build the set of anchor IDs to fetch for
  const anchorIdsToFetch = [anchorId, ...(subAnchorIds ?? [])]

  // Get edges involving this anchor OR any of its sub-anchors
  // (existing query, extended to cover multiple anchor IDs)
  const orFilter = anchorIdsToFetch
    .map(id => `source_node_id.eq.${id},target_node_id.eq.${id}`)
    .join(',')

  const { data: anchorEdges, error: edgeErr } = await supabase
    .from('knowledge_edges')
    .select('source_node_id, target_node_id')
    .eq('user_id', userId)
    .or(orFilter)

  if (edgeErr) throw new Error(edgeErr.message)

  const nodeIds = new Set<string>()
  const anchorIdSet = new Set(anchorIdsToFetch)

  for (const e of anchorEdges ?? []) {
    const src = e.source_node_id as string
    const tgt = e.target_node_id as string
    // Add neither end if it's one of the anchor IDs themselves
    if (!anchorIdSet.has(src)) nodeIds.add(src)
    if (!anchorIdSet.has(tgt)) nodeIds.add(tgt)
  }

  if (nodeIds.size === 0) return []

  // ... rest of function unchanged (fetch node details, compute connection counts, etc.) ...
```

Also add `subAnchorId` to the `EntityNode` shape for parent-mode display — needed to group entities by their sub-anchor origin in the neighborhood view. Add `originAnchorId?: string` to the returned nodes:

```typescript
// When building return objects, annotate which anchor this entity belongs to
// Find which anchor this entity is primarily connected to
const primaryAnchor = anchorIdsToFetch.find(ancId => {
  return (anchorEdges ?? []).some(e =>
    (e.source_node_id === ancId && e.target_node_id === node.id) ||
    (e.target_node_id === ancId && e.source_node_id === node.id)
  )
}) ?? anchorId

return {
  // ... all existing fields ...
  originAnchorId: primaryAnchor,   // NEW — used by NeighborhoodView parent mode
}
```

Add `originAnchorId?: string` to `EntityNode` in `src/types/explore.ts`.

---

## 7. `explore.ts` — Type Updates

**File:** `src/types/explore.ts`

Add to `ClusterData`:
```typescript
export interface ClusterData {
  anchor:                AnchorNode
  entityCount:           number       // total: direct + inherited
  directEntityCount:     number       // NEW — direct edges only
  inheritedEntityCount:  number       // NEW — from sub-anchors
  typeDistribution:      TypeDistributionEntry[]
  position:              { cx: number; cy: number; r: number }
  crossClusterEdges:     CrossClusterEdge[]
  subAnchorIds:          string[]
}
```

Add to `EntityNode`:
```typescript
originAnchorId?: string  // NEW — which anchor this entity primarily connects to
```

---

## 8. `useClusterLayout.ts` — Use Total Entity Count for Sizing

**File:** `src/hooks/useClusterLayout.ts`

The layout currently sizes bubbles by `c.entityCount`. This already works correctly once `fetchClusterData` is updated (Step 6.2) because `entityCount` will include inherited entities. No change needed here — the inherited count flows through `entityCount` automatically.

**However**, verify the line that reads `c.entityCount` for sizing:

```typescript
const maxCount = Math.max(...clusters.map(c => c.entityCount), 1)
```

This is correct as-is once `entityCount` reflects inheritance. No code change needed in this file.

---

## 9. `NeighborhoodView.tsx` — Dual-Mode Parent View

**File:** `src/views/explore/NeighborhoodView.tsx`

This is the most visible change. When clicking into a parent anchor cluster (one with `subAnchorIds.length > 0`), the neighborhood view shows all inherited entities grouped by sub-anchor origin, with sub-anchor nodes rendered as navigable hubs.

### 9.1 Detect parent mode

```typescript
const isParentMode = cluster.subAnchorIds.length > 0
```

### 9.2 Update the data fetch for parent mode

In the `useEffect` that calls `fetchClusterEntities`, pass sub-anchor IDs when in parent mode:

```typescript
useEffect(() => {
  if (!user) return
  let cancelled = false
  setLoading(true)

  async function load() {
    try {
      // Parent mode: fetch entities from this anchor AND all sub-anchors
      const subAnchorIds = isParentMode ? cluster.subAnchorIds : []
      
      const entityData = await fetchClusterEntities(
        user!.id,
        cluster.anchor.id,
        allClusters,
        subAnchorIds    // NEW parameter
      )
      if (cancelled) return
      setEntities(entityData)
      onEntitiesLoaded?.(entityData)

      const nodeIds = entityData.map(e => e.id)
      const edgeData = await fetchEntityEdges(user!.id, nodeIds)
      if (cancelled) return
      setEdges(edgeData)
      onEdgesLoaded?.(edgeData)
    } catch (err) {
      console.warn('NeighborhoodView fetch error:', err)
    } finally {
      if (!cancelled) setLoading(false)
    }
  }
  load()
  return () => { cancelled = true }
}, [user, cluster.anchor.id, allClusters, isParentMode, cluster.subAnchorIds])
```

### 9.3 Sub-anchor hub state

Add state for drilling into a sub-anchor from within parent mode:

```typescript
const [activeSubAnchorId, setActiveSubAnchorId] = useState<string | null>(null)
```

When `activeSubAnchorId` is set, the view filters entities to only show that sub-anchor's entities (using `originAnchorId`). This is the "drill down" state.

### 9.4 Filtered entities for display

```typescript
// In parent mode, optionally filter to a single sub-anchor
const displayEntities = useMemo(() => {
  if (!isParentMode || !activeSubAnchorId) return entities
  return entities.filter(e =>
    e.originAnchorId === activeSubAnchorId ||
    e.originAnchorId === cluster.anchor.id
  )
}, [entities, isParentMode, activeSubAnchorId, cluster.anchor.id])
```

### 9.5 Parent mode header bar

In parent mode, render a sub-anchor navigation strip below the existing back button. This shows all sub-anchors as pills — clicking one filters to that sub-anchor's entities:

```tsx
{isParentMode && (
  <div style={{
    display: 'flex', alignItems: 'center', gap: 6,
    padding: '6px 16px',
    background: 'var(--color-bg-card)',
    borderBottom: '1px solid var(--border-subtle)',
    flexWrap: 'wrap',
  }}>
    {/* "All" pill */}
    <button
      type="button"
      onClick={() => setActiveSubAnchorId(null)}
      style={{
        padding: '3px 10px', borderRadius: 20, cursor: 'pointer',
        fontSize: 11, fontWeight: 600,
        fontFamily: 'var(--font-body)',
        background: !activeSubAnchorId ? 'var(--color-accent-50)' : 'transparent',
        border: !activeSubAnchorId
          ? '1px solid rgba(214,58,0,0.2)'
          : '1px solid var(--border-subtle)',
        color: !activeSubAnchorId
          ? 'var(--color-accent-500)'
          : 'var(--color-text-secondary)',
      }}
    >
      All ({entities.length})
    </button>

    {/* One pill per sub-anchor */}
    {cluster.subAnchorIds.map(subId => {
      const subCluster = allClusters.find(c => c.anchor.id === subId)
      if (!subCluster) return null
      const subEntities = entities.filter(e => e.originAnchorId === subId)
      const isActive = activeSubAnchorId === subId

      return (
        <button
          key={subId}
          type="button"
          onClick={() => setActiveSubAnchorId(isActive ? null : subId)}
          style={{
            padding: '3px 10px', borderRadius: 20, cursor: 'pointer',
            fontSize: 11, fontWeight: 600,
            fontFamily: 'var(--font-body)',
            background: isActive ? 'var(--color-accent-50)' : 'transparent',
            border: isActive
              ? '1px solid rgba(214,58,0,0.2)'
              : '1px solid var(--border-subtle)',
            color: isActive
              ? 'var(--color-accent-500)'
              : 'var(--color-text-secondary)',
          }}
        >
          {subCluster.anchor.label.length > 16
            ? subCluster.anchor.label.slice(0, 14) + '…'
            : subCluster.anchor.label}
          {' '}({subEntities.length})
        </button>
      )
    })}
  </div>
)}
```

### 9.6 Entity color coding by origin

In parent mode with no active sub-anchor filter, entities from different sub-anchors should be visually distinguishable. Use the existing `EntityDot` component — it already colors by entity type. Add a subtle background ring around dots that belong to a specific sub-anchor to show grouping.

This is achieved by passing `originAnchorId` through to the SVG entity dot render. When an entity's `originAnchorId` matches a sub-anchor, draw a faint outer ring around it in the sub-anchor's entity type color.

In the SVG entity rendering section of `NeighborhoodView`, locate where `EntityDot` (or entity circles) are rendered and add:

```tsx
{/* Sub-anchor origin ring — shown in parent mode */}
{isParentMode && entity.originAnchorId && entity.originAnchorId !== cluster.anchor.id && (() => {
  const originCluster = allClusters.find(c => c.anchor.id === entity.originAnchorId)
  if (!originCluster) return null
  return (
    <circle
      cx={pos.x}
      cy={pos.y}
      r={(pos.radius ?? 6) + 3}
      fill="none"
      stroke={getEntityColor(originCluster.anchor.entityType)}
      strokeWidth={1}
      strokeOpacity={0.3}
      style={{ pointerEvents: 'none' }}
    />
  )
})()}
```

### 9.7 Reset sub-anchor filter when cluster changes

```typescript
useEffect(() => {
  setActiveSubAnchorId(null)
}, [cluster.anchor.id])
```

### 9.8 Replace `entities` with `displayEntities` in the SVG render

All entity rendering in the SVG body should use `displayEntities` instead of `entities`. The layout hook (`useEntityLayout`) and `nodePositions` state still use the full `entities` array so positions are stable — only the SVG render filters.

Specifically: in the `.map((entity) => ...)` that renders entity dots and labels, change `entities.map(...)` to `displayEntities.map(...)`. The `layoutPositions` useMemo and `useEntityLayout` call keep using `entities` (full set) so positions don't jump when the filter changes.

---

## 10. Backfill Script — Apply Inheritance to Existing Sub-Anchors

Any sub-anchor relationships created via PRD-22's `promoteToSubAnchor` before this PRD was deployed won't have inheritance edges yet. Run this SQL once after deploying:

```sql
-- Backfill: create inherited edges for existing sub-anchor relationships
-- Safe to run multiple times (WHERE NOT EXISTS prevents duplicates)

DO $$
DECLARE
  sub RECORD;
  entity_rec RECORD;
  parent_connected BOOLEAN;
BEGIN
  -- Loop over all current sub-anchor nodes
  FOR sub IN
    SELECT kn.id AS sub_id, kn.parent_anchor_id, kn.user_id
    FROM knowledge_nodes kn
    WHERE kn.parent_anchor_id IS NOT NULL
      AND kn.is_anchor = true
      AND kn.is_merged = false
  LOOP
    -- Loop over entities connected to this sub-anchor (non-inherited edges only)
    FOR entity_rec IN
      SELECT
        CASE WHEN ke.source_node_id = sub.sub_id
          THEN ke.target_node_id
          ELSE ke.source_node_id
        END AS entity_id
      FROM knowledge_edges ke
      WHERE ke.user_id = sub.user_id
        AND ke.is_inherited = false
        AND (ke.source_node_id = sub.sub_id OR ke.target_node_id = sub.sub_id)
    LOOP
      -- Skip if already connected to parent
      SELECT EXISTS (
        SELECT 1 FROM knowledge_edges
        WHERE user_id = sub.user_id
          AND (
            (source_node_id = sub.parent_anchor_id AND target_node_id = entity_rec.entity_id) OR
            (target_node_id = sub.parent_anchor_id AND source_node_id = entity_rec.entity_id)
          )
      ) INTO parent_connected;

      IF NOT parent_connected THEN
        INSERT INTO knowledge_edges (
          user_id, source_node_id, target_node_id,
          relation_type, evidence, weight, is_inherited, inherited_from_anchor_id
        ) VALUES (
          sub.user_id,
          sub.parent_anchor_id,
          entity_rec.entity_id,
          'inherited_from',
          'Inherited from sub-anchor: ' || sub.sub_id,
          0.5,
          true,
          sub.sub_id
        );
      END IF;
    END LOOP;
  END LOOP;
END $$;

-- Verify: count inherited edges created
SELECT COUNT(*) AS inherited_edges FROM knowledge_edges WHERE is_inherited = true;
```

---

## 11. Scoring Engine — Filter Inherited Edges

**Files:** `api/anchors/score-post-extraction.ts`, `api/anchors/score-daily.ts`, and the SQL scoring script

The scoring engine computes signals from `knowledge_edges`. With inherited edges now present, there's a risk that the scores become inflated — a parent anchor's centrality score would skyrocket because it suddenly has hundreds of inherited edges.

**The fix:** In both serverless functions and in the scoring SQL, add `.eq('is_inherited', false)` to all edge queries used for signal computation. Inherited edges should flow to RAG and display, but not inflate the structural scoring signals (which are meant to reflect organic graph connectivity).

In the scoring SQL (`score-anchor-candidates-v4.sql`), update the `edge_counts` CTE:

```sql
edge_counts AS (
  SELECT node_id, COUNT(*) AS total_edges
  FROM (
    SELECT source_node_id AS node_id FROM knowledge_edges WHERE is_inherited = false
    UNION ALL
    SELECT target_node_id AS node_id FROM knowledge_edges WHERE is_inherited = false
  ) all_edges
  GROUP BY node_id
),
```

Apply the same `is_inherited = false` filter to the `temporal_signals`, `relation_richness`, and `anchor_neighbours` CTEs.

In the serverless functions, add the filter to the edge queries in `fetchNodeSignalsBatch`.

---

## 12. Forward-Compatible Decisions

- **`is_inherited = false` is the default** on all existing edges and all new edges from extraction. Inherited edges are clearly flagged and isolated. If we ever want to show "only real connections" in any view, the filter is a single `.eq('is_inherited', false)` — already used by the scoring engine.

- **`inherited_from_anchor_id` enables clean cascade removal.** When `removeSubAnchorRelationship` is called, it deletes all edges where `inherited_from_anchor_id = subAnchorNodeId`. No complex JOIN needed. Fast indexed lookup.

- **`originAnchorId` on `EntityNode` enables further drill-down.** Future PRDs can use this to build richer group-by views, source attribution ("these 5 entities came from MCP"), or filtering. It costs nothing to compute during `fetchClusterEntities` and is available throughout the app once added.

- **The sub-anchor pill navigation in `NeighborhoodView`** is stateless — `activeSubAnchorId` resets when the cluster changes. No URL params, no persistence. This keeps the implementation simple. If persistence is needed later, it's a one-line addition to `useExploreFilters`.

- **Bubble sizing** uses total `entityCount` (direct + inherited) which flows through from `fetchClusterData`. Any future change to what counts toward sizing only requires updating `fetchClusterData` — `useClusterLayout` remains unchanged.

---

## 13. Edge Cases and Error Handling

- **`propagateInheritanceToParent` fails after `promoteToSubAnchor` sets the relationship:** The sub-anchor relationship still exists (the node has `parent_anchor_id` set). The parent just won't have inherited edges yet. The backfill SQL script handles this — running it is safe any time. The `window.setTimeout` refetch in `promoteToSubAnchor` also gives the async function time to complete before Explore reloads.

- **Circular inheritance attempt (sub-anchor of a sub-anchor):** Blocked at the Postgres trigger level from PRD-22. `promoteToSubAnchor` validates `parentCheck.parent_anchor_id` before proceeding. `propagateInheritanceToParent` would never be reached.

- **Same entity connected to two sub-anchors of the same parent:** `propagateInheritanceToParent` checks `alreadyConnected` before inserting. The second sub-anchor promotion simply finds the entity already connected and skips it. No duplicate edges.

- **Sub-anchor dissolved (`removeSubAnchorRelationship`):** Inherited edges with `inherited_from_anchor_id = subAnchorId` are deleted. Direct edges from those entities to the parent (if any existed naturally) are untouched — `is_inherited = false` edges are never deleted by this function.

- **Parent cluster `directEntityCount = 0`:** A parent anchor may have zero direct entities and only inherit from sub-anchors. This is valid — the parent is a pure organisational node. `entityCount` still shows the total, the bubble still sizes correctly, the neighborhood view still shows all inherited entities.

- **`fetchClusterEntities` with many sub-anchor IDs (10+):** The `OR` filter is built as a single `.or(orFilter)` call. Supabase supports up to 100 OR conditions in a single query. With a cap of 8 sub-anchors per parent (from PRD-20's ghost cluster cap), this is well within limits.

- **`NeighborhoodView` entity count jumps when switching from sub-anchor to parent view:** This is expected and correct behaviour — clicking "AI Agents" shows 112 entities; clicking "MCP" shows 20. The loading state in `NeighborhoodView` handles the transition cleanly.

---

## 14. Acceptance Criteria

- [ ] Migration runs cleanly: `is_inherited` and `inherited_from_anchor_id` columns exist on `knowledge_edges`, index exists
- [ ] Running `promoteToSubAnchor("MCP candidate", "MCP node", "AI Agents node")` creates `inherited_from` edges between "AI Agents" and all of MCP's entities in `knowledge_edges` with `is_inherited = true`
- [ ] Entities already connected to the parent are not duplicated — no duplicate edge error
- [ ] The AI Agents cluster bubble in Explore grows to reflect its total inherited entity count after promotion (reload required)
- [ ] Clicking into AI Agents neighborhood shows entities from AI Agents AND all its sub-anchors combined
- [ ] The sub-anchor pill strip appears at the top of the neighborhood view when in parent mode, showing one pill per sub-anchor with entity counts
- [ ] Clicking a sub-anchor pill filters the neighborhood to show only that sub-anchor's entities
- [ ] Clicking "All" pill or an active pill again returns to the full combined view
- [ ] Entities from different sub-anchors show a faint origin ring in their color when in unfiltered parent mode
- [ ] `removeSubAnchorRelationship("MCP node")` deletes all `inherited_from` edges where `inherited_from_anchor_id = "MCP node"`, AI Agents bubble shrinks on next reload
- [ ] Running the backfill SQL creates inherited edges for any existing sub-anchor relationships from PRD-22
- [ ] Scoring engine queries include `is_inherited = false` — parent anchor scores are not inflated by inherited edges
- [ ] `fetchClusterData` returns `directEntityCount` and `inheritedEntityCount` as separate fields on `ClusterData`
- [ ] `EntityNode.originAnchorId` is populated correctly for entities fetched via parent mode
- [ ] Cross-cluster edges in the Landscape view are stronger for parent anchors (because they inherit sub-anchor connections to other clusters)
- [ ] All TypeScript files compile with zero errors in strict mode
- [ ] No existing sub-anchor visual features from PRD-22 are broken (tether lines, satellite layout, hierarchy section in detail panel)
