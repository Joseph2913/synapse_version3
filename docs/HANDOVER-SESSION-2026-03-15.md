# Session Handover — 2026-03-15

## Summary

This session implemented PRDs 17–20, the anchor improvements brief, and several rounds of Explore UI redesign. The auto-anchor system is now fully operational end-to-end: scoring engine → candidate table → Anchors management page → Explore graph integration.

---

## PRDs Implemented

### PRD-17 — Anchor Candidates: Data Foundation
- **Migration**: `supabase/migrations/20260315_prd17_anchor_candidates.sql` — `anchor_candidates` table, two enums, 4 indexes, 4 RLS policies, `updated_at` trigger
- **Types**: `src/types/anchors.ts` — all interfaces, signal weights, threshold presets, defaults
- **Database types**: `src/types/database.ts` — `AnchorCandidateRow` interface added
- **Service layer**: `src/services/anchorCandidates.ts` — all CRUD functions with two-step queries (no FK joins)
- **Type index**: `src/types/index.ts` — re-exports for all new types

### PRD-18 — Anchor Scoring Engine
- **Post-extraction scorer**: `api/anchors/score-post-extraction.ts` — scores new nodes after each extraction
- **Daily scorer + lifecycle**: `api/anchors/score-daily.ts` — full graph scoring, auto-dismiss, dormant detection, healing
- **Trigger integration**: Fire-and-forget calls added to `api/youtube/extract-knowledge.ts`, `api/meetings/process.ts`, `src/hooks/useExtraction.ts`
- **Cron**: `vercel.json` — added `0 3 * * *` daily cron

### PRD-19 — Anchors Page UI
- **View**: `src/views/AnchorsView.tsx` — full page with control bar, filter pills, stats strip, two-column drag-resize
- **Components**: `src/components/anchors/` — AnchorCard, AnchorDetailPanel, AnchorHealthPanel, AnchorCreateForm, AnchorSignalBar
- **Hook**: `src/hooks/useAnchorCandidates.ts` — data fetching with optimistic updates, legacy fallback for pre-scoring anchors
- **Navigation**: NavRail (Anchor icon + amber badge), Router (`/anchors`), AppShell (suggestion count via custom events)

### PRD-20 — Explore Integration
- **Ghost clusters**: Suggested candidates appear as dashed amber bubbles in Landscape view
- **SuggestedTooltip**: New tooltip variant in `NodeTooltip.tsx`
- **SuggestedAnchorPanel**: Confirm/dismiss from within Explore (`ExploreMetadataPanel.tsx`)
- **Cross-cluster edges**: Enhanced visibility with weight-proportional thickness
- **Toolbar**: "✦ N new clusters detected" notification pill, Connections toggle
- **Event system**: `synapse:anchor-confirmed` + `synapse:anchor-suggestions-changed` custom events for cross-view reactivity

### Anchor Improvements Brief (5 items)
1. Suggested cards show "edges" instead of misleading "0 connections"
2. Composite score pill (green/amber/gray) on suggested cards
3. Signal bar descriptions + lead signal summary in detail panel
4. `synapse:anchor-confirmed` event triggers Explore refetch
5. `api/anchors/on-confirm.ts` — retroactive edge scan via Gemini after anchor confirmation

---

## Critical Bug Fixes

### Supabase 1000-row pagination
**File**: `src/services/exploreQueries.ts`
**Problem**: `fetchClusterData` fetched all nodes and edges with a single `.select()` which silently truncated at Supabase's 1000-row default limit. With 4400+ nodes and 3900+ edges, most data was missing.
**Fix**: Both the nodes and edges queries now paginate in 1000-row batches until all data is retrieved. This fix is essential — any new query fetching potentially large datasets must use the same pattern.

### Service layer FK join failure
**File**: `src/services/anchorCandidates.ts`
**Problem**: The original `fetchCandidatesWithNodes` used a Supabase join (`node:knowledge_nodes(...)`) that failed silently when PostgREST hadn't cached the FK relationship.
**Fix**: Split into two separate queries — fetch candidates first, then fetch node data by ID. All service layer functions now avoid FK joins.

### Live signal score computation
**File**: `src/services/anchorCandidates.ts`
**Problem**: Manually created anchor candidates had all signal scores at 0 in the database (never scored by the engine).
**Fix**: `fetchCandidatesWithNodes` now computes live signal scores and source counts for any candidate with all-zero stored values, using the same algorithm as PRD-18.

---

## Explore View: Design Standards

### Philosophy
The Explore landscape is a **spatial overview** — it should feel like a living, breathing map of the user's knowledge. Clean, minimal, ambient. Information reveals itself progressively through interaction (hover, zoom, click).

### Layout Rules

| Rule | Value |
|------|-------|
| Landscape mode | **Full-screen** — no split panel, no right sidebar |
| Neighborhood/Sources mode | Split layout with drag-resize (67% default, 30–80% range) |
| Background | `var(--color-bg-content)` — clean, no grid or pattern |

### Cluster Bubble Design

| Property | Root Anchor | Sub-Anchor | Suggested |
|----------|------------|------------|-----------|
| Border | **Solid** 2px, entity color | **Dashed** `6 3`, 1.5px, entity color at 70% opacity | **Dashed** `3 2`, 1px, amber |
| Fill | Entity color at `22` hex opacity | Entity color at `15` hex opacity | Amber at 12% |
| Sizing | Proportional to entity count (same scale for all) | Same proportional scale as roots | Fixed small (10–12px radius) |
| Label | Below circle, always visible, 9px | Below circle, always visible, 7px | Below circle with "✦ Suggested" marker |

### Sizing Formula
```
minR = 12px
maxR = min(viewportWidth, viewportHeight) × 0.04
r = minR + sqrt(entityCount / maxEntityCount) × (maxR - minR)
```
Sub-anchors use the **exact same formula** — they are not artificially shrunk.

### Progressive Disclosure

| Zoom Level | What's Visible |
|-----------|---------------|
| Default (1.0x) | Colored circles + labels below |
| Hover | Glow ring, entity count inside circle, tooltip with full details |
| 1.8x+ | Entity count appears inside all circles |
| Click | Floating info card positioned above the cluster |
| Double-click | Enters neighborhood view |

### Floating Animation
- Every node has independent sinusoidal drift (phase, speed, amplitude randomized per node)
- Float parameters: `speedX: 0.25–0.6`, `speedY: 0.18–0.43`, `ampX: 0.12–0.32`, `ampY: 0.1–0.26`
- Sub-anchors use identical parameters — no dampening
- Animation runs at requestAnimationFrame rate, React state updates for rendering

### Sub-Anchor Gravity
- Sub-anchors have a **very mild** pull toward their parent: `force = 0.003 × dt`
- This keeps them in the general vicinity without constraining their movement
- They are otherwise completely free to float, drift, and be dragged independently

### Drag Behaviour

| Action | Result |
|--------|--------|
| Drag a root anchor | Root + all its sub-anchors move together |
| Drag a sub-anchor | Only that sub-anchor moves (gravity drifts it back over time) |
| Drag into another node | **Nothing happens** — nodes pass through each other, no collision physics |
| Drag background | Pans the camera |

### Navigation

| Interaction | Result |
|------------|--------|
| Single click on cluster | Floating info card appears above the cluster |
| Double-click on cluster | Enters neighborhood view |
| "Explore Cluster →" button | Enters neighborhood view |
| Click × or Escape | Dismisses the info card |
| Scroll/pinch | Zooms (no auto-transition to neighborhood) |
| +/- keys | Zoom in/out |
| 0 key | Reset camera |

### Cross-Cluster Edges
- Solid lines (not dashed), `rgba(100,116,139)` slate color
- Opacity: `min(0.06 + weight/30 × 0.14, 0.20)` — weight-proportional
- Thickness: `min(0.5 + weight × 0.2, 3)` — weight-proportional
- Toggleable via "Connections" button in toolbar

### Sub-Anchor Tether Lines
- **Dashed** `6 4` pattern — visually distinct from cross-cluster edges
- Color: parent's entity color
- Width: 2px
- Opacity: 40%
- Always rendered (not toggleable)

### Force Simulation (Initial Layout)
- All anchors (root + sub) in one unified simulation
- Sub-anchors start positioned near their parent (offset 60–90px)
- Centering force: `0.001` (very gentle)
- Sub-anchor parent gravity: `0.008` (mild, during layout only)
- Repulsion: ideal distance = `max(rA + rB + 60, 90)`
- 200 ticks, damping 0.8
- Boundary padding: `r + 20`

### Floating Info Card
- Positioned **above the selected cluster**, centered horizontally
- Uses `position: absolute` with `bottom` calculated from camera-transformed world coordinates
- Content: label, entity type badge, entity count, description (truncated 100 chars), "Explore Cluster →" button
- Styling: `rgba(255,255,255,0.96)`, `backdrop-filter: blur(12px)`, border tinted with entity color, 10px radius
- Width: 220px fixed

---

## Event System

| Event | Emitted By | Listened By | Purpose |
|-------|-----------|------------|---------|
| `synapse:anchor-suggestions-changed` | useAnchorCandidates, ExploreView | AppShell (nav badge), ExploreView (refetch suggestions) | Update suggestion counts |
| `synapse:anchor-confirmed` | useAnchorCandidates, ExploreView | ExploreView (refetch clusters + delayed 35s refetch) | Refresh graph after anchor confirmation |

---

## Files Modified in This Session

### Created
- `supabase/migrations/20260315_prd17_anchor_candidates.sql`
- `src/types/anchors.ts`
- `src/services/anchorCandidates.ts`
- `src/hooks/useAnchorCandidates.ts`
- `src/views/AnchorsView.tsx`
- `src/components/anchors/AnchorCard.tsx`
- `src/components/anchors/AnchorDetailPanel.tsx`
- `src/components/anchors/AnchorHealthPanel.tsx`
- `src/components/anchors/AnchorCreateForm.tsx`
- `src/components/anchors/AnchorSignalBar.tsx`
- `api/anchors/score-post-extraction.ts`
- `api/anchors/score-daily.ts`
- `api/anchors/on-confirm.ts`

### Modified
- `src/types/database.ts` — AnchorCandidateRow, total_edges
- `src/types/index.ts` — anchor type exports
- `src/app/Router.tsx` — /anchors route
- `src/components/layout/NavRail.tsx` — Anchor nav item + badge
- `src/components/layout/AppShell.tsx` — suggestion count fetch + event listener
- `src/components/explore/ClusterBubble.tsx` — complete redesign (solid filled, dashed sub-anchor, progressive labels)
- `src/components/explore/NodeTooltip.tsx` — suggested tooltip variant
- `src/views/explore/LandscapeView.tsx` — complete redesign (floating physics, drag, ghost clusters, info card)
- `src/views/ExploreView.tsx` — full-screen landscape, suggested candidates, click/double-click, event listeners
- `src/views/explore/ExploreToolbar.tsx` — notification pill, connections toggle
- `src/views/explore/ExploreMetadataPanel.tsx` — SuggestedAnchorPanel
- `src/hooks/useClusterLayout.ts` — unified simulation, proportional sizing
- `src/hooks/useExtraction.ts` — anchor scoring trigger
- `src/services/exploreQueries.ts` — paginated queries (1000-row batches)
- `api/youtube/extract-knowledge.ts` — anchor scoring trigger
- `api/meetings/process.ts` — anchor scoring trigger
- `vercel.json` — daily cron entry

---

## Known Issues for Next Session

1. **TypeScript warnings in AnchorDetailPanel.tsx and AnchorsView.tsx** — unused imports from PRD-22 linter changes (`Anchor` icon, `confirmingDelete` state, `archived` filter). Non-blocking but should be cleaned up.

2. **`total_edges` column** — SQL migration provided but may not have been run yet. The column is referenced in types but the service layer computes edge counts live as a fallback.

3. **Scoring engine hasn't run on all nodes** — manually created anchors have live-computed scores (fallback in service layer). Once `score-daily` runs, all candidates will have proper stored scores.

4. **Context window** — this session consumed significant context. Future PRD implementations should start fresh conversations.
