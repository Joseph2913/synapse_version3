# Design Spec: Anchors & Skills in Playlist Graph View

**Date:** 2026-04-17
**Status:** Approved
**Scope:** Playlist/Source graph view within Explore page

---

## Problem

The Explore page's playlist graph shows sources grouped by playlist/ingestion method, but the two other most valuable data types in Synapse (anchors and skills) are invisible in this view. Users must navigate to separate pages to see them. By integrating all three into a single graph, users get a consolidated view of their knowledge landscape and can see how anchors and skills relate to their source material.

## Goal

Add confirmed anchors and active skills as visually distinct hexagonal nodes in the playlist graph, positioned in the interstitial white space between source clusters, connected to their related sources via glowing colored edges. Include controls to toggle visibility and adjust how many appear.

---

## Data Model

### Anchor nodes in the graph

- **Source:** `anchor_candidates` table joined with `knowledge_nodes` (existing)
- **Filter:** `status = 'confirmed'` only
- **Connection to sources:** An anchor is a knowledge node. Its edges in `knowledge_node_edges` connect it to other entities. Those entities have `source_id` values. The anchor connects to every source that contains at least one entity it has an edge to.
- **Ranking:** Sorted by `composite_score` descending. Default display count: top 50.
- **Fields needed per node:**
  - `id` (anchor candidate ID)
  - `nodeId` (knowledge node ID)
  - `label` (from knowledge_nodes)
  - `entityType` (from knowledge_nodes)
  - `compositeScore`
  - `connectedSourceIds: string[]` (derived from entity edges)
  - `entityCount` (number of connected entities)

### Skill nodes in the graph

- **Source:** `knowledge_skills` table (existing)
- **Filter:** `status = 'active'` only
- **Connection to sources:** Direct via `source_ids` field on the skill record (array of source UUIDs that contributed to the skill)
- **Ranking:** Weighted relevance score:
  ```
  relevanceScore = (confidence * 0.4) + (usage_count_norm * 0.3) + (source_count_norm * 0.3)
  ```
  Where `usage_count_norm` = `usage_count / max(usage_count)` and `source_count_norm` = `source_count / max(source_count)` across all active skills.
- **Default display count:** Top 15.
- **Fields needed per node:**
  - `id` (skill ID)
  - `name`
  - `title`
  - `description`
  - `domain`
  - `confidence`
  - `sourceIds: string[]` (from `source_ids`)
  - `usageCount`
  - `sourceCount`

### Mapping to playlist clusters

Both anchor and skill nodes connect to individual sources (video/document dots) within playlist clusters. A single anchor or skill may connect to sources across multiple clusters.

- For each anchor/skill, resolve its `connectedSourceIds` / `sourceIds` against the loaded video nodes to find which playlist clusters it spans
- Only render an anchor/skill if it connects to at least one visible source in the current graph

---

## Visual Design

### Node shape: Hexagon

Both anchors and skills render as regular hexagons, visually distinct from the circular source/playlist nodes.

**Hexagon geometry:**
- 6 vertices at equal angular spacing (0, 60, 120, 180, 240, 300 degrees)
- Base radius: 14px for anchors, 12px for skills
- Anchors with higher composite scores get slightly larger: `14 + (compositeScore * 6)` px (range: 14-20px)
- Skills scale similarly: `12 + (confidence * 4)` px (range: 12-16px)

### Anchor node styling

| Property | Value |
|----------|-------|
| Shape | Regular hexagon |
| Border | 2px dashed `#d97706` (amber-500) |
| Fill | `#d97706` at 7% opacity (`#d9770612`) |
| Center icon | Small circle (4px) in the entity type's color |
| Label | Below node, 10px, DM Sans 500, `#d97706` |
| Hover | Scale 1.08x, glow ring: `0 0 12px rgba(217,119,6,0.35)` |
| Selected | Solid amber border (not dashed), glow intensifies |

### Skill node styling

| Property | Value |
|----------|-------|
| Shape | Regular hexagon |
| Border | 2px dashed `#0891b2` (cyan-600) |
| Fill | `#0891b2` at 7% opacity (`#0891b212`) |
| Center icon | Sparkle/star symbol (4-point star path), `#0891b2` |
| Label | Below node, 10px, DM Sans 500, `#0891b2` |
| Hover | Scale 1.08x, glow ring: `0 0 12px rgba(8,145,178,0.35)` |
| Selected | Solid teal border (not dashed), glow intensifies |

### Edge styling

**Anchor edges (anchor to source):**

| Property | Value |
|----------|-------|
| Color | `rgba(217,119,6,0.30)` (amber, 30% opacity) |
| Hover color | `rgba(217,119,6,0.55)` |
| Stroke width | 1.5px |
| Dash pattern | `[3, 3]` (dotted) |
| Glow | SVG filter: `feGaussianBlur stdDeviation="2"` on a duplicate path at 20% opacity |
| Curvature | Straight lines (no bezier) to keep them visually lighter than source-source curves |

**Skill edges (skill to source):**

| Property | Value |
|----------|-------|
| Color | `rgba(8,145,178,0.30)` (teal, 30% opacity) |
| Hover color | `rgba(8,145,178,0.55)` |
| Stroke width | 1.5px |
| Dash pattern | `[3, 3]` (dotted) |
| Glow | SVG filter: `feGaussianBlur stdDeviation="2"` on a duplicate path at 20% opacity |
| Curvature | Straight lines |

**Edge visibility on hover:**
- Hovering an anchor/skill node highlights all its edges and dims unrelated edges
- Hovering a source dot also highlights any anchor/skill edges connected to it

---

## Layout Algorithm

### Positioning anchors and skills in white space

The goal: place anchor/skill hexagons between the playlist clusters they relate to, in the natural white space.

**Step 1: Compute centroid**
For each anchor/skill, find the centroid of its connected playlist cluster centers:
```
centroid.x = average(connectedClusterCenter.x for each connected cluster)
centroid.y = average(connectedClusterCenter.y for each connected cluster)
```

If an anchor/skill connects to only one cluster, place it at an offset just outside that cluster's boundary radius.

**Step 2: Push outside cluster boundaries**
For each anchor/skill position, check if it falls inside any cluster boundary circle. If so, push it radially outward from that cluster center until it clears the boundary + 20px padding.

**Step 3: Repulsion between hexagons**
Run a simple iterative repulsion pass (10-15 iterations) to prevent hexagon overlap:
- Minimum separation: 40px center-to-center
- Each iteration pushes overlapping hexagons apart along the vector between their centers
- Damping factor: 0.5 per iteration

**Step 4: Boundary containment**
Soft-push hexagons that drift outside the visible canvas area back toward center, matching the existing boundary behavior for source nodes.

### Integration with drag system

- Anchor/skill hexagons are draggable using the same `LiveNode` infrastructure
- When dragged, they participate in the drift system with weak links to their connected sources (weight: 0.3)
- They do NOT influence playlist center positions (one-directional coupling only)

---

## Right Panel Integration

### Clicking an anchor node

Opens a panel in the right sidebar showing:
- Anchor label and entity type badge
- Description text
- Connection stats: connected anchors count, cross-edges count, shared entities count
- "Strongest connection" callout with the most-connected anchor
- Top connections list (other anchors sorted by edge count)
- Entity composition breakdown by type

This reuses the existing `AnchorDetailPanel` component pattern (as shown in the user's screenshot of "AI Risk Management" panel). The component may need minor adaptation to accept data from the graph context rather than the anchor settings page.

### Clicking a skill node

Opens a panel in the right sidebar showing:
- Skill title and domain badge
- Description
- Metadata row: sources count, usage count, last used date
- Confidence bar
- Tags list
- Full skill content (collapsible sections: Overview, Prerequisites, etc.)
- Contributing sources list

This reuses the existing `SkillDetailPanel` component pattern. The panel scrolls independently.

### Panel type extension

The `ExploreRightPanelContent` union type needs two new variants:
```typescript
export type ExploreRightPanelContent =
  | { type: 'node'; data: EntityNode }
  | { type: 'source'; data: SourceNode }
  | { type: 'cluster'; data: ClusterData }
  | { type: 'anchor'; data: AnchorCandidateWithNode }
  | { type: 'skill'; data: KnowledgeSkillDetail }
  | null
```

---

## Control Bar

### Toggle pills

Two new pills added to the playlist graph control bar, matching existing pill styling specs:

- **"Anchors"** pill - toggles anchor hexagon visibility. On by default. Active state: amber accent (`border: 1px solid rgba(217,119,6,0.15)`, `background: #fef3c7`, `color: #d97706`).
- **"Skills"** pill - toggles skill hexagon visibility. On by default. Active state: teal accent (`border: 1px solid rgba(8,145,178,0.15)`, `background: #cffafe`, `color: #0891b2`).

Standard pill specs: `borderRadius: 20px`, `padding: 5px 13px`, `fontSize: 12px`, `font-body font-semibold`.

### Density sliders

Below (or beside) the toggles, a compact slider control for each:

**Anchor density slider:**
- Label: "Top {N} anchors" where N updates live as you drag
- Range: 10 to 200 (or max available, whichever is smaller)
- Default: 50
- Step: 10
- Styled as a thin track with amber thumb

**Skill density slider:**
- Label: "Top {N} skills" where N updates live as you drag
- Range: 5 to 50 (or max available)
- Default: 15
- Step: 5
- Styled as a thin track with teal thumb

Slider values persist in component state (not database). Changing the slider re-filters and re-positions the hexagons with a smooth transition.

### Slider interaction

- Dragging the slider immediately updates the count label
- On release (mouse up / touch end), the graph re-renders with the new node count
- Nodes that are removed fade out; new nodes that appear fade in (200ms opacity transition)

---

## Data Fetching

### New query functions (in `exploreQueries.ts`)

**`fetchGraphAnchors(userId: string, limit: number)`**
```sql
-- Fetch top N confirmed anchors with their connected source IDs
SELECT 
  ac.id,
  ac.node_id,
  ac.composite_score,
  ac.entity_count,
  kn.label,
  kn.entity_type,
  kn.description,
  array_agg(DISTINCT s.id) FILTER (WHERE s.id IS NOT NULL) as connected_source_ids
FROM anchor_candidates ac
JOIN knowledge_nodes kn ON kn.id = ac.node_id
LEFT JOIN knowledge_node_edges e ON (e.from_node_id = ac.node_id OR e.to_node_id = ac.node_id)
LEFT JOIN knowledge_nodes linked ON linked.id = CASE 
  WHEN e.from_node_id = ac.node_id THEN e.to_node_id 
  ELSE e.from_node_id 
END
LEFT JOIN sources s ON s.id = linked.source_id
WHERE ac.user_id = $userId
  AND ac.status = 'confirmed'
GROUP BY ac.id, kn.id
ORDER BY ac.composite_score DESC
LIMIT $limit
```

This may need to be an RPC if the join is too heavy for client-side querying. Given we're limiting to 50-200 anchors and the join is on indexed columns, it should be manageable as a direct query first. If performance is poor, promote to an RPC.

**`fetchGraphSkills(userId: string, limit: number)`**
```sql
SELECT 
  id, name, title, description, domain, confidence,
  source_ids, usage_count, source_count, status, tags
FROM knowledge_skills
WHERE user_id = $userId
  AND status = 'active'
ORDER BY (
  confidence * 0.4 + 
  (usage_count::float / GREATEST(MAX(usage_count) OVER(), 1)) * 0.3 +
  (source_count::float / GREATEST(MAX(source_count) OVER(), 1)) * 0.3
) DESC
LIMIT $limit
```

### Caching

Both queries are cached alongside the playlist graph data in the same `useEffect` that fetches playlists and videos. Cache invalidation triggers on the same events: `synapse:anchor-confirmed`, ingestion complete, manual refresh.

---

## New Types

```typescript
// src/types/explore.ts additions

export interface PlaylistGraphAnchor {
  id: string                    // anchor_candidates.id
  nodeId: string                // knowledge_nodes.id
  label: string
  entityType: string
  description: string | null
  compositeScore: number
  entityCount: number
  connectedSourceIds: string[]  // source IDs with entities linked to this anchor
}

export interface PlaylistGraphSkill {
  id: string
  name: string
  title: string
  description: string
  domain: string | null
  confidence: number
  sourceIds: string[]           // source_ids from the skill record
  usageCount: number
  sourceCount: number
  tags: string[]
  relevanceScore: number        // computed ranking score
}
```

---

## Component Changes Summary

| File | Change |
|------|--------|
| `PlaylistGraphView.tsx` | Add anchor/skill state, fetch calls, hexagon SVG rendering, edge rendering, click handlers, drag integration |
| `ExploreRightPanel.tsx` | Add `anchor` and `skill` panel type cases |
| `types/explore.ts` | Add `PlaylistGraphAnchor`, `PlaylistGraphSkill` types; extend `ExploreRightPanelContent` |
| `services/exploreQueries.ts` | Add `fetchGraphAnchors()` and `fetchGraphSkills()` |
| Control bar area in `PlaylistGraphView.tsx` | Add toggle pills and density sliders |

### New components (if needed)

- `PlaylistAnchorDetailPanel.tsx` - Wrapper that adapts anchor data for display in the right panel (may be able to reuse `AnchorDetailPanel` directly)
- `PlaylistSkillDetailPanel.tsx` - Wrapper that adapts skill data for display (may reuse `SkillDetailPanel` directly)

### No changes to

- Existing playlist/source node rendering
- Existing source-to-source edges
- Existing camera/zoom/pan system
- Existing layout algorithm for playlists
- Database schema (no new tables, no migrations)
- Other explore view modes (Landscape, Neighborhood)

---

## Edge Cases

- **Anchor/skill with no visible sources:** Don't render it. Only show hexagons that connect to at least one source currently in the graph.
- **Anchor/skill connecting to a single cluster:** Position it just outside that cluster's boundary at a deterministic angle (based on node ID hash).
- **Very high density (200 anchors):** The repulsion pass prevents overlap, but at high counts the interstitial space may feel crowded. The slider default of 50 keeps this manageable.
- **Zero anchors or skills:** Toggle pills show as inactive/disabled. Sliders hidden.
- **Skills with empty `source_ids`:** Filter these out (they have no graph connections to show).
