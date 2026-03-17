# Graph Visualisation Specification

> Canonical reference for all graph-based views in Synapse. Every graph visualisation — whether it renders anchors, entities, sources, or any future node type — must follow these rules. This document was derived from the Explore Landscape view implementation (March 2026) and should be treated as the design system for spatial visualisations.

---

## 1. Core Principles

1. **Spatial overview first.** The graph is a living map, not a diagram. It should feel ambient and organic — like looking at a constellation, not reading a spreadsheet.

2. **Progressive disclosure.** Show the minimum at default zoom. Reveal detail through interaction. Never overwhelm with text at first glance.

3. **Every node is equal in behaviour.** Root nodes, child nodes, suggested nodes — they all float, drift, drag, and respond to hover identically. Visual distinctions are cosmetic (border style, fill opacity), never behavioural.

4. **No collisions, no explosions.** Nodes never push each other away on contact. Dragging one node into another has no effect on the other. The physics are ambient, not reactive.

5. **Full-screen canvas.** Graph views occupy 100% of available space. No sidebar, no split panel. Detail panels appear as floating cards anchored to the selected node.

---

## 2. Canvas & Camera

### Background
- Colour: `var(--color-bg-content)` — clean, no grid lines, no dots, no pattern.

### Text Selection Prevention (MANDATORY)
All graph containers (SVG and Canvas) **must** disable text selection to prevent browser selection artifacts during drag interactions:
```css
user-select: none;
-webkit-user-select: none;
```
Apply to **both** the container `<div>` and the `<svg>` or `<canvas>` element. This prevents label text from being selected when dragging nodes, which causes rendering slowdowns and visual glitches. All `<text>` elements within SVG graphs should also have `pointer-events: none` and `user-select: none` in their inline styles.

### Camera Controls

| Input | Behaviour |
|-------|-----------|
| Scroll wheel | Zoom toward cursor position |
| Trackpad pinch (Ctrl+scroll) | Zoom toward cursor position |
| Trackpad two-finger swipe | Pan |
| Click + drag on background | Pan |
| `+` or `=` key | Zoom in (centred) |
| `-` or `_` key | Zoom out (centred) |
| `0` key | Reset camera to default |

### Camera Limits
```
MIN_ZOOM = 0.2
MAX_ZOOM = 4.0
Default  = 1.0
```

### Zoom Controls Overlay
- Position: bottom-right, `16px` from edges
- Three buttons: `+`, `−`, `⊙` (reset)
- Styling: 26×26px, `borderRadius: 6`, `rgba(255,255,255,0.9)`, `backdrop-filter: blur(8px)`, `1px solid rgba(0,0,0,0.08)`

### Stats Overlay
- Position: top-right, `16px` from edges
- Shows: Clusters count, Entities count, Edges count
- Styling: `rgba(255,255,255,0.9)`, `backdrop-filter: blur(8px)`, `borderRadius: 10`, `pointerEvents: 'none'`
- Label: `var(--font-body)` 9px, `text-secondary`
- Value: `var(--font-display)` 11px/700, `text-primary`

---

## 3. Node Sizing

All nodes — regardless of type (root, child, suggested) — use the same sizing formula:

```
minR = 12px
maxR = min(viewportWidth, viewportHeight) × 0.04
r = minR + sqrt(entityCount / maxEntityCount) × (maxR - minR)
```

- `entityCount` = the metric driving the node's visual weight (entities for anchors, connections for other graphs, etc.)
- `maxEntityCount` = the maximum across ALL nodes in the current view (not just visible/filtered ones)
- The square root normalisation prevents outliers from dominating — a node with 300 entities is larger than one with 30, but not 10× larger.

**Never artificially shrink child/sub nodes.** If a sub-anchor has 200 entities, it gets the same radius as a root anchor with 200 entities.

---

## 4. Node Visual Design

### 4.1 Shape
Every node is a **solid filled circle** rendered as an SVG `<circle>`. No rings, no donuts, no hollow centres.

### 4.2 Node Types — Visual Treatments

| Property | Root Node | Child/Sub Node | Suggested/Ghost Node |
|----------|-----------|---------------|---------------------|
| Fill | `{entityColor}22` | `{entityColor}15` | `rgba(245,158,11,0.12)` |
| Stroke | `{entityColor}`, solid | `{entityColor}` at 70% opacity, **dashed** `6 3` | `rgba(245,158,11,0.5)`, **dashed** `3 2` |
| Stroke width | 2px | 1.5px | 1px |
| Label font size | 9px | 7px | 9px |

`{entityColor}` = the colour returned by `getEntityColor(node.entityType)` from the entity type colour map.

### 4.3 Colour Source
Node colour always derives from the node's entity type using the project's `ENTITY_TYPE_COLORS` map. Never hardcode colours. The fill is always the entity colour at low opacity (hex `15`–`22`), and the stroke is the entity colour at full or 70% opacity.

### 4.4 Selection State
When a node is selected (clicked):
- An additional ring renders at `r + 5` pixels
- Ring stroke: `var(--color-accent-500)`, 2px, 60% opacity
- The label below turns `var(--color-accent-500)`

### 4.5 Hover State
When a node is hovered:
- Scale: `1.08×` (via SVG `<g transform="scale(...)">`)
- A glow ring renders at `r + 4` pixels: `{entityColor}35`, 2px
- The label below turns `var(--color-text-primary)`
- Entity count appears centred inside the circle at `{entityColor}` with 45% opacity
- A tooltip appears (see Section 8)

### 4.6 Dimmed State
When a filter hides a node but it should remain as a ghost:
- Opacity: `0.12`
- No hover or click interactions

---

## 5. Labels

### Placement
Labels render **below the circle**, never inside it. Positioned at `y = r + 12` from the node centre.

### Typography
- Font: `var(--font-display)`
- Weight: 600
- Size: 9px for root nodes, 7px for child nodes
- Truncation: 20 characters for roots, 14 for children, with `…` suffix

### Colour States

| State | Label Colour |
|-------|-------------|
| Default | `var(--color-text-secondary)` |
| Hovered | `var(--color-text-primary)` |
| Selected | `var(--color-accent-500)` |
| Suggested | `rgba(217,119,6,0.7)` (amber) |

### Always Visible
Labels are **always rendered** at every zoom level. They do not fade in or out based on zoom. This ensures the graph is always readable.

### Entity Count (Inside Circle)
The entity count renders inside the circle ONLY on hover or when camera zoom ≥ 1.8×. It uses:
- Font: `var(--font-body)`, weight 700
- Size: `max(7, r × 0.5)` — scales with node size
- Colour: `{entityColor}` at 45% opacity
- Centred vertically and horizontally (`textAnchor: middle`, `dominantBaseline: middle`)

---

## 6. Edges / Connections

### 6.1 Cross-Node Edges (Standard)
Connections between nodes that represent shared entities, relationships, or co-occurrence.

| Property | Value |
|----------|-------|
| Stroke colour | `rgba(100,116,139, {opacity})` (slate) |
| Opacity | `min(0.06 + weight/30 × 0.14, 0.20)` — weight-proportional |
| Width | `min(0.5 + weight × 0.2, 3)` — weight-proportional |
| Dash | None (solid) |
| Toggleable | Yes, via toolbar control |

When filters are active and both connected nodes are not visible: opacity drops to `0.01`.

### 6.2 Parent–Child Tether Edges
Visual connection between a child/sub node and its parent.

| Property | Value |
|----------|-------|
| Stroke colour | Parent's entity colour |
| Opacity | 40% |
| Width | 2px |
| Dash | `6 4` pattern |
| Toggleable | No — always rendered |
| Pointer events | None |

The tether line extends from the child's centre to the edge of the parent circle (not its centre), calculated as:
```
dx = childX - parentX
dy = childY - parentY
dist = sqrt(dx² + dy²)
endX = parentX + (dx / dist) × parentRadius
endY = parentY + (dy / dist) × parentRadius
```

### 6.3 Suggested/Ghost Tether Edges
Faint connection from a suggested node to the nearest confirmed node.

| Property | Value |
|----------|-------|
| Stroke | `rgba(245,158,11,0.06)` |
| Width | 0.5px |
| Dash | `3 5` |
| Pointer events | None |

---

## 7. Physics & Animation

### 7.1 Initial Layout (Force Simulation)
Run synchronously on mount (not animated). Produces the starting positions.

**Algorithm:**
1. Separate root and child nodes
2. Place root nodes on a grid: `cols × rows` based on viewport aspect ratio
3. Place child nodes offset 60–90px from their parent at golden-angle intervals
4. Combine all nodes into one simulation
5. Run 200 ticks with:
   - **Centering force**: `0.001` — very gentle pull toward viewport centre
   - **Parent gravity** (children only): `0.008` — mild pull toward parent
   - **Pairwise repulsion**: ideal distance = `max(rA + rB + 60, 90)`, force = `0.04`
   - **Damping**: `0.8`
6. Clamp to viewport bounds with `r + 20` padding

### 7.2 Node Motion Behaviour

**No automatic floating.** Nodes are static after initial layout. They do NOT drift, bob, or animate on their own. Movement only occurs when the user drags a node.

**Child node gravity** (sub-anchors only, live):
- Only activates when distance exceeds `80px` from parent
- Strength: `0.002 × deltaTime` — very gentle pull back

**Damping:** `0.97` per frame — applied to all velocity, so nodes decelerate smoothly after drag release.

**Boundary soft-push:** Nodes near viewport edges get a gentle push inward (pad `30px`, strength `0.01`).

**Boundary push:** soft force when within 30px of viewport edge.

**All nodes use identical floating parameters.** Children are not dampened, slowed, or constrained differently from roots.

### 7.3 What NOT To Do
- **No collision detection.** Nodes pass through each other freely.
- **No repulsion on drag.** Dragging a node into others has no effect on those others.
- **No snap-to-grid.** Positions are always continuous.
- **No auto-zoom transitions.** Zooming in never automatically changes view mode.

---

## 8. Drag Behaviour

### Grabbing
- Cursor: `grab` on hover, `grabbing` while dragging
- Triggered by `mousedown` on a node `<g>` element (with `stopPropagation` to prevent canvas pan)

### Movement
The dragged node follows the cursor exactly, accounting for camera zoom and pan:
```
worldX = (clientX - svgRect.left - camera.panX) / camera.zoom
worldY = (clientY - svgRect.top  - camera.panY) / camera.zoom
node.x = worldX - offsetX
node.y = worldY - offsetY
```

### Connected Node Drift (Directional Delta Model)

When a node is dragged, connected nodes respond with a **very subtle drift in the same direction** as the drag movement. This is NOT a pull-toward-the-dragged-node force — connected nodes never collapse or converge on the dragged node. They glide gently in the same direction, staying in their own position.

**How it works:**

Each animation frame during a drag, compute the **movement delta** of the dragged node (how far it moved since the previous frame). Apply that delta as a tiny velocity nudge to connected nodes, scaled by connection weight:

```
moveDx = dragNode.x - dragNode.previousX
moveDy = dragNode.y - dragNode.previousY

// 1st-degree connections:
strength = 0.003 + connectionWeight × 0.025
connectedNode.vx += moveDx × strength
connectedNode.vy += moveDy × strength

// 2nd-degree connections:
secStrength = 0.0005 + connectionWeight × 0.003
secondDegreeNode.vx += moveDx × secStrength
secondDegreeNode.vy += moveDy × secStrength
```

**Effective speeds at each degree:**

| Connection | Weight ~1.0 | Weight ~0.1 |
|------------|------------|------------|
| 1st degree | ~2.8% of drag speed | ~0.5% of drag speed |
| 2nd degree | ~0.35% of drag speed | ~0.08% of drag speed |
| Unconnected | No movement | No movement |

**Key principles:**
- The effect must be **barely perceptible** — the user should notice connected nodes gently drifting if they look for it, but the graph should not visibly distort or cluster
- Connected nodes NEVER move toward or converge on the dragged node
- Stronger connections (higher weight) drift slightly more than weaker ones
- The movement is **velocity-based**, not positional — nodes accelerate slowly and decelerate via damping (0.94), creating natural momentum
- Damping at 0.94 during drag ensures nudges dissipate quickly and don't accumulate into large displacements
- Floating animation continues for all non-dragged nodes during the drag
- Unconnected nodes are completely unaffected

### Group Dragging Rules (Landscape/Neighborhood Views)

| What's Dragged | What Moves With It |
|---------------|--------------------|
| Root/parent node | All its direct children move along (same delta) |
| Child/sub node | Only that child — nothing else |
| Suggested node | Only that node |

Children are NOT dragged when a sibling is dragged. The parent is NOT dragged when a child is dragged.

Note: The connected-node-drift model (above) applies to the **Source Graph view**. The landscape and neighborhood views use the simpler group-drag rules in this table.

### After Release
The node resumes floating from its new position. Its velocity is zeroed. Connected nodes retain any residual velocity from drag nudges and decelerate naturally via damping.

### Reset Node Positions
A dedicated reset button (↺) or the **R key** snaps all nodes back to their original layout-computed positions with velocity zeroed. This is useful after extensive dragging has displaced nodes from their territory clusters.

---

## 9. Interaction Model

### Click (Single)
- Selects the node
- A **floating info card** appears positioned above the node (see Section 10)
- Clears any previous selection (entity, source, or other node)
- Does NOT change zoom level or view mode

### Double-Click
- Enters the detail/drill-down view for that node (e.g., neighborhood view for anchors)
- This is the ONLY way to enter a deeper view from the graph canvas

### Hover
- Shows tooltip (see Section 8 of the handover doc for tooltip variants)
- Applies hover visual state (scale, glow ring, label colour change)
- Shows entity count inside circle

### Escape Key
- Clears current selection
- Dismisses floating info card

### Click on Canvas Background
- Clears current selection
- Starts canvas panning if dragged

---

## 10. Floating Info Card

Appears when a node is single-clicked. Positioned **directly above the selected node**, not in a fixed corner.

### Positioning
```
screenX = worldX × camera.zoom + camera.panX
screenY = worldY × camera.zoom + camera.panY
cardLeft = clamp(screenX - cardWidth/2, 8, viewportWidth - cardWidth - 8)
cardBottom = viewportHeight - max(8, screenY - nodeRadius × camera.zoom - 14)
```

The card sits above the node and stays anchored to it as the node floats.

### Dimensions
- Width: 220px fixed
- Padding: `12px 14px`
- Border radius: 10px

### Styling
```
background:      rgba(255,255,255,0.96)
backdrop-filter:  blur(12px)
border:          1px solid {entityColor}40
box-shadow:      0 6px 24px rgba(0,0,0,0.08)
animation:       fadeUp 0.15s ease
```

### Content Structure
1. **Header row**: Node label (font-display 13px/700) + close button `×`
2. **Badges**: Entity type badge + metric count (e.g., "48 entities")
3. **Description** (if available): Truncated at 100 characters, font-body 10px, text-secondary
4. **Primary action button**: Full-width, `var(--color-accent-500)` background, white text, "Explore Cluster →" or equivalent action label

### Suggested Node Card Variant
For suggested/ghost nodes, the card has an amber border (`rgba(245,158,11,0.25)`) and includes:
- `✦ Suggested Anchor` label in amber
- Reasoning text in italic
- Two-button row: "Confirm ✓" (accent) + "Dismiss" (ghost)

---

## 11. Suggested/Ghost Nodes

Nodes that the system has identified but the user hasn't confirmed.

### Positioning
Placed around the periphery of the canvas at `42%` of the smaller viewport dimension from centre, evenly spaced by angle. Collision-avoided against confirmed nodes.

### Fixed Small Size
Suggested nodes use a fixed small radius (10–12px), NOT the proportional sizing formula. They should be clearly secondary to confirmed nodes.

### Deduplication
Before rendering, group suggested nodes by lowercase label. Keep only the highest-scoring representative per unique label. Show `+N similar` badge on hover when duplicates exist.

### Cap
Maximum 8 suggested ghost nodes visible simultaneously (top 8 by composite score after deduplication).

---

## 12. Applying This Spec to New Graph Views

When building a new graph-based visualisation (e.g., source connections, entity relationships, topic clusters):

1. **Use `useClusterLayout`** (or adapt it) for initial positioning. Replace the `entityCount` metric with whatever drives visual weight in the new context.

2. **Use the same floating animation loop.** Copy the `LiveNode` interface and `requestAnimationFrame` tick from `LandscapeView`. Every graph view should feel alive.

3. **Use `ClusterBubble`** (or a variant) for rendering nodes. The component already handles all visual states (root, child, suggested, selected, hovered, dimmed).

4. **Follow the interaction model exactly.** Single click = select + info card. Double click = drill down. No auto-transitions. No collision physics.

5. **Full-screen canvas.** No split panel in the overview. Detail panels are floating cards, not sidebars.

6. **Paginate Supabase queries.** Any query that might return more than 1000 rows MUST use pagination (see `exploreQueries.ts` for the pattern).

7. **Edge weight drives opacity and thickness**, not a binary on/off. Use the formulas in Section 6.1.

8. **Child nodes are behaviourally identical to root nodes.** Differentiate only through border style (dashed vs solid) and a gentle gravity force. Never constrain, lock, or shrink children.

---

## Appendix: Entity Type Colour Map

```typescript
Person:       '#d97706'    Organization: '#7c3aed'
Team:         '#7c3aed'    Topic:        '#0891b2'
Project:      '#059669'    Goal:         '#e11d48'
Action:       '#2563eb'    Risk:         '#dc2626'
Blocker:      '#dc2626'    Decision:     '#db2777'
Insight:      '#7c3aed'    Question:     '#ea580c'
Idea:         '#ca8a04'    Concept:      '#4f46e5'
Takeaway:     '#0891b2'    Lesson:       '#65a30d'
Document:     '#6b7280'    Event:        '#8b5cf6'
Location:     '#14b8a6'    Technology:   '#0d9488'
Product:      '#059669'    Metric:       '#6366f1'
Hypothesis:   '#a855f7'    Anchor:       '#b45309'
Fallback:     '#808080'
```

## Appendix: CSS Custom Properties Referenced

```
--color-bg-content          Canvas background
--color-bg-card             Card/overlay background
--color-text-primary        High-emphasis text
--color-text-secondary      Low-emphasis text / labels
--color-text-body           Body text
--color-accent-500          Primary accent (blood orange #d63a00)
--color-accent-50           Accent tint background
--border-subtle             Light border
--font-display              Cabinet Grotesk (headings, labels)
--font-body                 DM Sans (body text, values)
```
