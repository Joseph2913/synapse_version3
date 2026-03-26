# Next Session: Neighborhood View Redesign

## Objective

Redesign `NeighborhoodView.tsx` to match the graph visualisation spec (`docs/GRAPH-VISUALISATION-SPEC.md`). When a user clicks into a specific anchor cluster, the entity-level view should use the same visual language, physics, and interaction model as the landscape view.

## Current State

- File: `src/views/explore/NeighborhoodView.tsx` (~600 lines)
- Uses `EntityDot` component for rendering nodes (old style — variable-radius circles with inline labels)
- Uses `useEntityLayout` hook for force simulation
- Has camera (zoom/pan), drag, edges, tooltips — all functional
- Displayed in split-panel layout (67/33 with metadata panel on right)
- Drag moves connected nodes via spring physics
- Has auto-back on zoom-out

## Required Changes

### 1. Full-Screen Layout
The neighborhood view should be full-screen like the landscape view. The metadata panel should appear as a floating info card above the selected entity, not as a sidebar.

In `ExploreView.tsx`, change the neighborhood rendering to use the same full-screen pattern:
```tsx
) : viewMode === 'anchors' && isNeighborhood ? (
  <div className="flex-1 overflow-hidden relative">
    <NeighborhoodView ... />
    {/* Floating entity info card positioned above selected entity */}
  </div>
)
```

### 2. Node Rendering — Follow Spec Section 4

Replace `EntityDot` with the same solid-circle-with-label-below pattern from `ClusterBubble`:
- Solid filled circle: `fill={entityColor}22`, `stroke={entityColor}`, `strokeWidth=2`
- Label below circle at `y = r + 12`, always visible, font-display 9px/600
- Entity count NOT shown (entities don't have sub-counts)
- Hover: scale 1.08, glow ring at `r+4`, label turns `text-primary`
- Selected: selection ring at `r+5` in accent colour

### 3. Node Sizing — Follow Spec Section 3

Use connection count as the sizing metric:
```
minR = 6
maxR = min(width, height) * 0.025
r = minR + sqrt(connectionCount / maxConnectionCount) * (maxR - minR)
```

Smaller than landscape bubbles since there are more nodes.

### 4. Floating Animation — Follow Spec Section 7.2

Add the same `LiveNode` + `requestAnimationFrame` loop from `LandscapeView`:
- Independent sinusoidal drift per entity
- Same parameters: `speedX: 0.25–0.6`, `speedY: 0.18–0.43`, `ampX: 0.12–0.32`, `ampY: 0.1–0.26`
- Damping: 0.97
- Boundary soft push at 30px from edges

### 5. Drag — Follow Spec Section 8

- Drag moves only the dragged node
- NO spring physics pulling connected nodes
- After release, node resumes floating from new position

### 6. Edges — Follow Spec Section 6

Knowledge edges:
- Solid lines, `rgba(100,116,139, opacity)`, weight-proportional opacity and thickness
- Same formula as landscape cross-cluster edges

Co-source edges:
- Dashed `7 4`, blue tint `rgba(37,99,235,opacity)`

Co-tag edges:
- Dashed `2 5`, purple tint `rgba(124,58,237,opacity)`

### 7. Info Card — Follow Spec Section 10

When an entity is clicked, show a floating info card above the entity (not in a sidebar):
- Entity label, type badge, description
- Connection count, source info
- "View Connections" or similar action button
- Same positioning math as landscape info card

### 8. Back Navigation

Keep the back button (top-left) to return to landscape. Remove auto-back on zoom-out — follow the spec's "no auto-transitions" rule.

### 9. Anchor Entity

The cluster's anchor entity should render slightly larger (1.5× the computed radius) with a thicker stroke (3px) to visually anchor the view.

## Files to Modify

| File | Changes |
|------|---------|
| `src/views/explore/NeighborhoodView.tsx` | Major rewrite — floating animation, spec-compliant nodes, no spring drag, floating info card |
| `src/views/ExploreView.tsx` | Neighborhood renders full-screen (same pattern as landscape) |
| `src/hooks/useEntityLayout.ts` | May need updating for new sizing formula |
| `src/components/explore/EntityDot.tsx` | May become unused — evaluate whether to keep or remove |

## Reference Files

- `docs/GRAPH-VISUALISATION-SPEC.md` — the canonical spec
- `src/views/explore/LandscapeView.tsx` — reference implementation for floating, drag, info card
- `src/components/explore/ClusterBubble.tsx` — reference for node rendering pattern
- `src/hooks/useClusterLayout.ts` — reference for force simulation
