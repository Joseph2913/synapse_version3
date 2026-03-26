# PRD-20 (Updated) — Explore Integration: Suggested Anchors in the Graph

**Phase:** 5 — Intelligence Layer  
**Dependencies:**
- PRD-17 — `anchor_candidates` schema, `src/types/anchors.ts`, `src/services/anchorCandidates.ts`
- PRD-18 — scoring engine populating `anchor_candidates` rows
- PRD-19 — `useAnchorCandidates` hook, `synapse:anchor-confirmed` custom event
- PRD-21 — deduplication engine (must run first so ghost clusters don't show duplicate labels)

**Estimated Complexity:** Medium  
**Estimated Effort:** 1–2 sessions  
**Supersedes:** Original PRD-20 (four changes applied — see section 1.1)

---

## 1. Objective

This PRD surfaces the auto-anchor system inside the Explore graph. Suggested anchor candidates appear as ghost clusters in the Landscape view. Cross-cluster edges between confirmed anchors become visibly readable. A toolbar notification alerts users when new suggestions exist. Confirm and dismiss actions work directly from within the graph.

### 1.1 Changes from the original PRD-20

Four issues were identified after PRD-19 was implemented and real data was available:

**Change 1 — Duplicate ghost cluster grouping.** Before PRD-21 runs its retroactive merge, multiple `anchor_candidates` rows may exist for nodes with identical labels (e.g. 4× "Joseph Thomas"). Rendering all of them as ghost clusters would produce an incomprehensible canvas. Ghost clusters are now grouped by label before rendering — one representative ghost per unique label, with a `+N similar` badge when duplicates exist.

**Change 2 — Double refetch after confirmation.** Confirming an anchor triggers `on-confirm.ts` (from the improvements brief), which creates new edges retroactively over ~10–30 seconds. The original PRD's single immediate `refetch()` shows the new cluster but misses the enriched edge count. A second delayed refetch at 35 seconds captures the enriched state.

**Change 3 — PRD-22 forward compatibility.** `SuggestedClusterData` gains a nullable `suggestedParentAnchorId` field. It's always `null` in this PRD — PRD-22 populates it when the scoring engine recommends a sub-anchor relationship. The `SuggestedAnchorPanel` confirmation UI already checks for this field so PRD-22 requires zero changes to the panel component.

**Change 4 — Score visible before clicking.** The composite score now appears on the ghost cluster bubble itself (below the ✦ badge) and in the hover tooltip. Users can judge quality at a glance, consistent with the score pill added to `AnchorCard` in the improvements brief.

---

## 2. What Gets Built

### Files modified (5 existing files)
- `src/components/explore/NodeTooltip.tsx` — add `kind: 'suggested'` to `TooltipData` union
- `src/components/explore/ClusterBubble.tsx` — add `isSuggested` and `duplicateCount` props
- `src/views/explore/LandscapeView.tsx` — ghost cluster rendering layer, enhanced cross-cluster edges, `suggestedClusters` prop
- `src/views/ExploreView.tsx` — fetch suggested candidates, handle confirm/dismiss, event listeners, pass new props
- `src/views/explore/ExploreToolbar.tsx` — "new clusters detected" notification pill, cross-edges toggle
- `src/views/explore/ExploreMetadataPanel.tsx` — `SuggestedAnchorPanel` local component, new props

### Files NOT created
All types come from PRD-17 (`src/types/anchors.ts`) and all service functions come from PRD-17 (`src/services/anchorCandidates.ts`) and PRD-18/19. This PRD creates zero new files.

### Prerequisites to verify before implementing
The following must exist before this PRD runs:
- `src/types/anchors.ts` with `AnchorCandidateWithNode`, `AnchorCandidateStatus`, `VelocityDirection`
- `src/services/anchorCandidates.ts` with `fetchCandidatesWithNodes`, `confirmAnchorCandidate`, `dismissAnchorCandidate`
- `useAnchorCandidates` hook dispatching `synapse:anchor-confirmed` event after successful confirmation
- `anchor_candidates` table populated with `suggested` rows (from scoring engine or SQL script)
- PRD-21 retroactive merge has run (`/api/nodes/merge-duplicates` called once)

---

## 3. Data Architecture

### 3.1 SuggestedClusterData — the internal shape

Defined at the top of both `LandscapeView.tsx` and `ExploreView.tsx` (not exported — internal to the view layer):

```typescript
// Internal interface — not exported, not a new type file
interface SuggestedClusterData {
  candidateId:             string
  nodeId:                  string
  label:                   string
  entityType:              string
  compositeScore:          number
  reasoningText:           string | null
  mentionCount:            number
  sourceCount:             number
  velocityDirection:       'rising' | 'stable' | 'falling'
  // Change 3: forward-compatible field for PRD-22 sub-anchor system
  // Always null in this PRD. PRD-22 populates it from scoring engine output.
  suggestedParentAnchorId: string | null
  // Change 1: populated during dedup-grouping in ExploreView
  duplicateCount:          number  // 0 for unique labels, N for grouped duplicates
}
```

### 3.2 How suggested candidates are fetched

`ExploreView` fetches via `fetchCandidatesWithNodes(user.id, ['suggested'])` from `src/services/anchorCandidates.ts` on mount and on scoring events. This is parallel to the existing `useExploreData()` cluster fetch and never mutates it.

### 3.3 Deduplication grouping (Change 1)

Before passing to `LandscapeView`, `ExploreView` groups suggested candidates by lowercase label in a `useMemo`. One representative per unique label (highest `compositeScore`). Others contribute to `duplicateCount`.

```typescript
// In ExploreView — suggestedClusterData memo
const suggestedClusterData = useMemo(() => {
  const candidates = suggestedCandidates.filter(c => c.node !== null)

  // Group by lowercase label — keep highest score per group
  const grouped = new Map<string, typeof candidates[0] & { duplicateCount: number }>()
  for (const c of candidates) {
    const key = c.node!.label.toLowerCase()
    const existing = grouped.get(key)
    if (!existing || c.compositeScore > existing.compositeScore) {
      grouped.set(key, {
        ...c,
        duplicateCount: (existing?.duplicateCount ?? 0) + (existing ? 0 : 0),
      })
    } else {
      const rep = grouped.get(key)!
      rep.duplicateCount = (rep.duplicateCount ?? 0) + 1
    }
  }

  // Convert to SuggestedClusterData, sort by score, cap at 8
  return Array.from(grouped.values())
    .sort((a, b) => b.compositeScore - a.compositeScore)
    .slice(0, 8)
    .map(c => ({
      candidateId:             c.id,
      nodeId:                  c.nodeId ?? '',
      label:                   c.node!.label,
      entityType:              c.node!.entity_type,
      compositeScore:          c.compositeScore,
      reasoningText:           c.reasoningText,
      mentionCount:            c.mentionCount,
      sourceCount:             c.sourceCount,
      velocityDirection:       c.velocityDirection,
      suggestedParentAnchorId: null,     // PRD-22 will populate this
      duplicateCount:          c.duplicateCount ?? 0,
    } satisfies SuggestedClusterData))
}, [suggestedCandidates])
```

### 3.4 Cross-cluster edge enhancement

`ClusterData.crossClusterEdges` is already computed by `fetchClusterData` and contains `totalWeight` for every confirmed anchor pair with shared entities. Current rendering: dashed lines at `rgba(0,0,0,0.06)` — invisible in practice. This PRD makes them readable when `showCrossEdges` is true.

---

## 4. `NodeTooltip.tsx` Modifications

**File:** `src/components/explore/NodeTooltip.tsx`

### 4.1 Extend TooltipData union

```typescript
// Change 4: add 'suggested' kind
export type TooltipData =
  | { kind: 'cluster';   data: ClusterData }
  | { kind: 'entity';    data: EntityNode }
  | { kind: 'suggested'; candidateId: string; label: string; entityType: string; reasoning: string | null; score: number; velocity: 'rising' | 'stable' | 'falling' }
```

### 4.2 Add suggested tooltip renderer

Add to the `NodeTooltip` function body, before the final `return null`:

```tsx
if (tooltip.kind === 'suggested') {
  return <SuggestedTooltip data={tooltip} x={x} y={y} />
}
```

Add `SuggestedTooltip` as a local function component at the bottom of the file:

```tsx
function SuggestedTooltip({
  data, x, y,
}: {
  data: Extract<TooltipData, { kind: 'suggested' }>
  x: number
  y: number
}) {
  // Change 4: score pill color
  const scorePct = Math.round(data.score * 100)
  const scoreColor = data.score >= 0.60 ? '#16a34a'
    : data.score >= 0.50 ? '#d97706'
    : 'var(--color-text-secondary)'

  return (
    <div
      style={{
        position: 'fixed',
        left: x + 12,
        top: y - 8,
        zIndex: 50,
        background: 'var(--color-bg-card)',
        border: '1px solid rgba(245,158,11,0.25)',
        borderRadius: 10,
        padding: '12px 16px',
        boxShadow: '0 4px 16px rgba(0,0,0,0.08)',
        maxWidth: 240,
        pointerEvents: 'none',
      }}
    >
      {/* ✦ Suggested label + score */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
        <span style={{
          fontFamily: 'var(--font-body)', fontSize: 10, fontWeight: 700, color: '#d97706',
        }}>
          ✦ Suggested Anchor
        </span>
        {/* Change 4: score in tooltip */}
        <span style={{
          fontFamily: 'var(--font-body)', fontSize: 10, fontWeight: 700,
          color: scoreColor,
          background: `${scoreColor}14`,
          border: `1px solid ${scoreColor}30`,
          borderRadius: 4, padding: '1px 6px',
        }}>
          {scorePct}%
        </span>
      </div>

      {/* Label */}
      <div style={{
        fontFamily: 'var(--font-display)', fontSize: 13, fontWeight: 700,
        color: 'var(--color-text-primary)', marginBottom: 4,
      }}>
        {data.label}
      </div>

      {/* Entity type */}
      <span style={{
        fontFamily: 'var(--font-body)', fontSize: 10, fontWeight: 500,
        color: 'var(--color-text-secondary)',
        background: 'var(--color-bg-inset)',
        borderRadius: 4, padding: '1px 6px',
        display: 'inline-block', marginBottom: 6,
      }}>
        {data.entityType}
      </span>

      {/* Velocity indicator */}
      {data.velocity === 'rising' && (
        <div style={{
          fontFamily: 'var(--font-body)', fontSize: 10, color: '#16a34a', marginBottom: 4,
        }}>
          ↑ Activity increasing recently
        </div>
      )}

      {/* Reasoning */}
      {data.reasoning && (
        <p style={{
          fontFamily: 'var(--font-body)', fontSize: 10,
          color: 'var(--color-text-secondary)', lineHeight: 1.5,
          marginBottom: 6,
        }}>
          {data.reasoning.length > 100
            ? data.reasoning.slice(0, 97) + '…'
            : data.reasoning}
        </p>
      )}

      {/* CTA */}
      <div style={{
        fontFamily: 'var(--font-body)', fontSize: 10, fontWeight: 600,
        color: '#d97706',
      }}>
        Click to review →
      </div>
    </div>
  )
}
```

---

## 5. `ClusterBubble.tsx` Modifications

**File:** `src/components/explore/ClusterBubble.tsx`

### 5.1 Props change

```typescript
interface ClusterBubbleProps {
  cluster:        ClusterData
  dimmed:         boolean
  isSuggested?:   boolean   // renders ghost/dashed treatment
  duplicateCount?: number   // Change 1: shows "+N" badge when > 0
  onHover: (cluster: ClusterData | null, event: React.MouseEvent) => void
  onClick: (cluster: ClusterData) => void
}
```

Destructure new props:
```typescript
export function ClusterBubble({ cluster, dimmed, isSuggested = false, duplicateCount = 0, onHover, onClick }) {
```

### 5.2 Suggested visual treatment

When `isSuggested` is true, apply these changes to the existing render:

**Background circle** — replace the existing `<circle>` with:
```tsx
<circle
  r={r}
  fill={isSuggested ? 'rgba(245,158,11,0.03)' : 'rgba(0,0,0,0.015)'}
  stroke={isSuggested ? 'rgba(245,158,11,0.35)' : 'rgba(0,0,0,0.06)'}
  strokeWidth={isSuggested ? 1.5 : 1}
  strokeDasharray={isSuggested ? '5 3' : '6 4'}
  style={{ transition: 'stroke 0.18s ease' }}
/>
```

**Type distribution ring** — add opacity wrapper:
```tsx
<g transform={`translate(${-r}, ${-r})`} opacity={isSuggested ? 0.35 : 1}>
  <TypeDistributionRing ... />
</g>
```

**Anchor label** — reduce opacity when suggested:
```tsx
<text
  y={-6}
  textAnchor="middle"
  style={{
    fontFamily: 'var(--font-display)',
    fontSize: 13,
    fontWeight: 700,
    fill: isSuggested ? 'rgba(0,0,0,0.45)' : 'var(--color-text-primary)',
    pointerEvents: 'none',
    userSelect: 'none',
  }}
>
  {cluster.anchor.label.length > 18
    ? cluster.anchor.label.slice(0, 16) + '…'
    : cluster.anchor.label}
</text>
```

**Sub-label** — "✦ Suggested" instead of entity count, with score:
```tsx
<text
  y={10}
  textAnchor="middle"
  style={{
    fontFamily: 'var(--font-body)',
    fontSize: 10,
    fill: isSuggested ? '#d97706' : 'var(--color-text-secondary)',
    pointerEvents: 'none',
    userSelect: 'none',
  }}
>
  {isSuggested ? '✦ Suggested' : `${cluster.entityCount} entities`}
</text>

{/* Change 4: score below sub-label on suggested clusters */}
{isSuggested && (cluster as ClusterData & { compositeScore?: number }).compositeScore !== undefined && (
  <text
    y={22}
    textAnchor="middle"
    style={{
      fontFamily: 'var(--font-body)',
      fontSize: 9,
      fontWeight: 700,
      fill: 'rgba(217,119,6,0.7)',
      pointerEvents: 'none',
      userSelect: 'none',
    }}
  >
    {Math.round(((cluster as ClusterData & { compositeScore?: number }).compositeScore ?? 0) * 100)}%
  </text>
)}
```

**Note on score access:** The ghost cluster passed to `ClusterBubble` is a `ClusterData` shape constructed from `SuggestedClusterData`. To pass the score through, add `compositeScore` to the ghost cluster object when constructing it in `LandscapeView` (see Section 6.3). The cast above handles the type gap cleanly without changing `ClusterData`.

**✦ Suggested badge** — top-right of the bubble:
```tsx
{isSuggested && (
  <g transform={`translate(${r * 0.65}, ${-r * 0.65})`}>
    <rect x={-16} y={-9} width={32} height={18} rx={9}
      fill="rgba(245,158,11,0.12)"
      stroke="rgba(245,158,11,0.35)"
      strokeWidth={1}
    />
    <text
      textAnchor="middle"
      dominantBaseline="middle"
      style={{
        fontFamily: 'var(--font-body)', fontSize: 9, fontWeight: 700,
        fill: '#d97706', pointerEvents: 'none', userSelect: 'none',
      }}
    >
      ✦
    </text>
  </g>
)}
```

**Change 1: "+N similar" badge** — bottom-left when `duplicateCount > 0`:
```tsx
{isSuggested && duplicateCount > 0 && (
  <g transform={`translate(${-r * 0.65}, ${r * 0.65})`}>
    <rect x={-18} y={-9} width={36} height={18} rx={9}
      fill="rgba(0,0,0,0.06)"
      stroke="rgba(0,0,0,0.10)"
      strokeWidth={1}
    />
    <text
      textAnchor="middle"
      dominantBaseline="middle"
      style={{
        fontFamily: 'var(--font-body)', fontSize: 8, fontWeight: 600,
        fill: 'var(--color-text-secondary)', pointerEvents: 'none', userSelect: 'none',
      }}
    >
      +{duplicateCount} similar
    </text>
  </g>
)}
```

---

## 6. `LandscapeView.tsx` Modifications

**File:** `src/views/explore/LandscapeView.tsx`

### 6.1 Props additions

```typescript
interface LandscapeViewProps {
  clusters:          ClusterData[]
  stats:             GraphStats
  unclustered:       UnclusteredEntity[]
  isClusterVisible:  (cluster: ClusterData) => boolean
  onClusterClick:    (cluster: ClusterData) => void
  onZoomTransition?: (clusterId: string) => void
  // NEW
  suggestedClusters?:         SuggestedClusterData[]
  showCrossEdges?:             boolean   // default true
  onSuggestedClusterClick?:   (candidate: SuggestedClusterData) => void
}
```

Define `SuggestedClusterData` at the top of the file (same interface as in Section 3.1 — copy verbatim, not imported).

### 6.2 Suggested cluster positioning

Add after `const layoutClusters = useClusterLayout(clusters, size.width, size.height)`:

```typescript
// Position suggested clusters around the periphery with collision avoidance
const positionedSuggested = useMemo(() => {
  if (!suggestedClusters?.length || layoutClusters.length === 0) return []

  const SUGGESTED_RADIUS = 55
  const results: Array<SuggestedClusterData & { cx: number; cy: number; r: number }> = []

  suggestedClusters.forEach((candidate, i) => {
    const angle = (i / suggestedClusters.length) * Math.PI * 2
    const ringRadius = Math.min(size.width, size.height) * 0.38

    let cx = size.width / 2 + Math.cos(angle) * ringRadius
    let cy = size.height / 2 + Math.sin(angle) * ringRadius

    // Push away from confirmed clusters
    for (const lc of layoutClusters) {
      const dx = cx - lc.position.cx
      const dy = cy - lc.position.cy
      const dist = Math.sqrt(dx * dx + dy * dy)
      const minDist = lc.position.r + SUGGESTED_RADIUS + 20
      if (dist < minDist && dist > 0) {
        const push = (minDist - dist) / dist
        cx += dx * push * 0.5
        cy += dy * push * 0.5
      }
    }

    // Clamp to canvas bounds
    const pad = SUGGESTED_RADIUS + 15
    cx = Math.max(pad, Math.min(size.width - pad, cx))
    cy = Math.max(pad, Math.min(size.height - pad, cy))

    results.push({ ...candidate, cx, cy, r: SUGGESTED_RADIUS })
  })

  return results
}, [suggestedClusters, layoutClusters, size.width, size.height])
```

### 6.3 SVG render — cross-cluster edges (enhanced)

Replace the current cross-cluster edge rendering (the first `{layoutClusters.map(...)}` block in the SVG) with:

```tsx
{/* 1. Cross-cluster edges — enhanced visibility */}
{(showCrossEdges ?? true) && layoutClusters.map(cluster =>
  cluster.crossClusterEdges.map(edge => {
    const target = layoutClusters.find(c => c.anchor.id === edge.targetClusterId)
    if (!target) return null
    if (cluster.anchor.id > edge.targetClusterId) return null  // deduplicate pairs

    const bothVisible = isClusterVisible(cluster) && isClusterVisible(target)
    const hasActiveFilter = clusters.some(c => !isClusterVisible(c))

    // Weight-proportional opacity: min 0.12, max 0.35
    const baseOpacity = Math.min(0.12 + (edge.totalWeight / 20) * 0.23, 0.35)
    const opacity = hasActiveFilter && !bothVisible ? 0.02 : baseOpacity

    // Weight-proportional thickness: 1–5px
    const strokeWidth = Math.min(1 + edge.totalWeight * 0.4, 5)

    return (
      <line
        key={`${cluster.anchor.id}-${edge.targetClusterId}`}
        x1={cluster.position.cx} y1={cluster.position.cy}
        x2={target.position.cx}  y2={target.position.cy}
        stroke={`rgba(100,116,139,${opacity})`}
        strokeWidth={strokeWidth}
        style={{ transition: 'opacity 0.18s ease, stroke-width 0.18s ease' }}
      />
    )
  })
)}
```

Key changes from original: removed `strokeDasharray`, raised minimum opacity from `0.06` to `0.12`, added weight-proportional thickness.

### 6.4 SVG render — suggested ghost layers

Add after the existing cluster bubbles layer (layer 2), before the unclustered zone (layer 3):

```tsx
{/* 2b. Ghost edges: suggested cluster → nearest confirmed (faint tether) */}
{positionedSuggested.map(sc => {
  const nearest = layoutClusters[0]  // first cluster as proximity anchor
  if (!nearest) return null
  return (
    <line
      key={`suggested-tether-${sc.candidateId}`}
      x1={sc.cx} y1={sc.cy}
      x2={nearest.position.cx} y2={nearest.position.cy}
      stroke="rgba(245,158,11,0.08)"
      strokeWidth={1}
      strokeDasharray="4 6"
      style={{ pointerEvents: 'none' }}
    />
  )
})}

{/* 2c. Ghost cluster bubbles */}
{positionedSuggested.map(sc => {
  // Build a minimal ClusterData for ClusterBubble
  // cx/cy = 0 because the outer <g> handles world positioning
  const ghostCluster: ClusterData & { compositeScore: number } = {
    anchor: {
      id:          sc.nodeId,
      label:       sc.label,
      entityType:  sc.entityType,
      description: null,
      entityCount: sc.mentionCount,
    },
    entityCount:       sc.mentionCount,
    typeDistribution:  [],
    position:          { cx: 0, cy: 0, r: sc.r },   // ← IMPORTANT: 0,0 not sc.cx,sc.cy
    crossClusterEdges: [],
    compositeScore:    sc.compositeScore,  // Change 4: passed for score display
  }

  return (
    <g
      key={`suggested-${sc.candidateId}`}
      transform={`translate(${sc.cx}, ${sc.cy})`}
      onClick={() => onSuggestedClusterClick?.(sc)}
      style={{ cursor: 'pointer' }}
    >
      <ClusterBubble
        cluster={ghostCluster}
        dimmed={false}
        isSuggested={true}
        duplicateCount={sc.duplicateCount}
        onHover={(c, e) => {
          if (c) {
            setTooltip({
              data: {
                kind:        'suggested',
                candidateId: sc.candidateId,
                label:       sc.label,
                entityType:  sc.entityType,
                reasoning:   sc.reasoningText,
                score:       sc.compositeScore,
                velocity:    sc.velocityDirection,
              },
              x: e.clientX,
              y: e.clientY,
            })
          } else {
            setTooltip(null)
          }
        }}
        onClick={() => { /* handled by outer g */ }}
      />
    </g>
  )
})}
```

---

## 7. `ExploreView.tsx` Modifications

**File:** `src/views/ExploreView.tsx`

### 7.1 New imports

Add to existing imports:

```typescript
import { fetchCandidatesWithNodes, confirmAnchorCandidate, dismissAnchorCandidate } from '../services/anchorCandidates'
import type { AnchorCandidateWithNode } from '../types/anchors'
```

### 7.2 New state

Add inside `ExploreView` function body, near the existing state declarations:

```typescript
// Suggested anchor candidates — for ghost cluster rendering
const [suggestedCandidates, setSuggestedCandidates] = useState<AnchorCandidateWithNode[]>([])
const [showCrossEdges, setShowCrossEdges]           = useState(true)
const [selectedSuggestedId, setSelectedSuggestedId] = useState<string | null>(null)
```

### 7.3 Fetch suggested candidates on mount

Add a new `useEffect` after the existing `useEffect` blocks:

```typescript
// Fetch suggested anchor candidates for ghost cluster rendering
useEffect(() => {
  if (!user) return  // user comes from useAuth() — add that import if not present
  fetchCandidatesWithNodes(user.id, ['suggested'])
    .then(setSuggestedCandidates)
    .catch(err => console.warn('[ExploreView] Failed to fetch suggested candidates:', err))
}, [user])
```

**Note:** If `useAuth` isn't already imported in `ExploreView.tsx`, add `import { useAuth } from '../hooks/useAuth'` and destructure `const { user } = useAuth()` at the top of the component.

### 7.4 Event listeners — two custom events

Add a single `useEffect` for both events:

```typescript
useEffect(() => {
  // Re-fetch suggested candidates when scoring engine runs
  const onSuggestionsChanged = () => {
    if (!user) return
    fetchCandidatesWithNodes(user.id, ['suggested'])
      .then(setSuggestedCandidates)
      .catch(() => { /* non-fatal */ })
  }

  // Re-fetch confirmed cluster data when an anchor is confirmed anywhere in the app
  const onAnchorConfirmed = () => {
    refetch()
    // Change 2: second delayed refetch captures on-confirm.ts enrichment
    setTimeout(() => refetch(), 35000)
  }

  window.addEventListener('synapse:anchor-suggestions-changed', onSuggestionsChanged)
  window.addEventListener('synapse:anchor-confirmed',           onAnchorConfirmed)

  return () => {
    window.removeEventListener('synapse:anchor-suggestions-changed', onSuggestionsChanged)
    window.removeEventListener('synapse:anchor-confirmed',           onAnchorConfirmed)
  }
}, [user, refetch])
```

### 7.5 suggestedClusterData memo (Change 1 — dedup grouping)

Add after the existing `activeCluster` memo:

```typescript
// Build deduplicated ghost cluster data — one per unique label, highest score wins
const suggestedClusterData = useMemo((): SuggestedClusterData[] => {
  const candidates = suggestedCandidates.filter(c => c.node !== null)
  if (candidates.length === 0) return []

  // Group by lowercase label
  const grouped = new Map<string, AnchorCandidateWithNode & { duplicateCount: number }>()

  for (const c of candidates) {
    const key = c.node!.label.toLowerCase()
    const existing = grouped.get(key)
    if (!existing) {
      grouped.set(key, { ...c, duplicateCount: 0 })
    } else if (c.compositeScore > existing.compositeScore) {
      grouped.set(key, { ...c, duplicateCount: existing.duplicateCount + 1 })
    } else {
      existing.duplicateCount++
    }
  }

  // Map to SuggestedClusterData, sort by score, cap at 8
  return Array.from(grouped.values())
    .sort((a, b) => b.compositeScore - a.compositeScore)
    .slice(0, 8)
    .map(c => ({
      candidateId:             c.id,
      nodeId:                  c.nodeId ?? '',
      label:                   c.node!.label,
      entityType:              c.node!.entity_type,
      compositeScore:          c.compositeScore,
      reasoningText:           c.reasoningText,
      mentionCount:            c.mentionCount,
      sourceCount:             c.sourceCount,
      velocityDirection:       c.velocityDirection,
      suggestedParentAnchorId: null,  // PRD-22 will populate
      duplicateCount:          c.duplicateCount,
    }))
}, [suggestedCandidates])
```

`SuggestedClusterData` interface must also be defined in this file (same definition as in `LandscapeView.tsx` — copy, don't import).

### 7.6 Selected suggested candidate derived value

```typescript
const selectedSuggestedCandidate = useMemo(() =>
  selectedSuggestedId
    ? suggestedCandidates.find(c => c.id === selectedSuggestedId) ?? null
    : null,
[selectedSuggestedId, suggestedCandidates])
```

### 7.7 Handlers

```typescript
const handleSuggestedClusterClick = useCallback((candidate: SuggestedClusterData) => {
  setSelectedSuggestedId(candidate.candidateId)
  setSelectedEntityId(null)
  setSelectedSourceId(null)
}, [setSelectedEntityId])

// Change 2: immediate refetch + delayed refetch for on-confirm.ts enrichment
const handleConfirmFromExplore = useCallback(async (candidateId: string, nodeId: string) => {
  const success = await confirmAnchorCandidate(candidateId, nodeId)
  if (success) {
    // Optimistic: remove from suggested immediately
    setSuggestedCandidates(prev => prev.filter(c => c.id !== candidateId))
    setSelectedSuggestedId(null)
    // Immediate refetch — shows new confirmed cluster
    refetch()
    // Delayed refetch — captures edges created by on-confirm.ts (runs ~10–30s)
    setTimeout(() => refetch(), 35000)
    // Notify nav badge + Anchors page
    window.dispatchEvent(new CustomEvent('synapse:anchor-suggestions-changed'))
    window.dispatchEvent(new CustomEvent('synapse:anchor-confirmed', { detail: { nodeId } }))
  }
}, [refetch])

const handleDismissFromExplore = useCallback(async (candidateId: string, dismissCount: number) => {
  const success = await dismissAnchorCandidate(candidateId, dismissCount, 30)
  if (success) {
    setSuggestedCandidates(prev => prev.filter(c => c.id !== candidateId))
    setSelectedSuggestedId(null)
    window.dispatchEvent(new CustomEvent('synapse:anchor-suggestions-changed'))
  }
}, [])
```

### 7.8 Pass new props to LandscapeView

Update the `LandscapeView` render:

```tsx
{viewMode === 'anchors' && !isNeighborhood && (
  <LandscapeView
    clusters={clusters}
    stats={stats}
    unclustered={unclustered}
    isClusterVisible={isClusterVisible}
    onClusterClick={handleClusterClick}
    onZoomTransition={handleZoomTransition}
    suggestedClusters={suggestedClusterData}
    showCrossEdges={showCrossEdges}
    onSuggestedClusterClick={handleSuggestedClusterClick}
  />
)}
```

### 7.9 Pass new props to ExploreMetadataPanel

```tsx
<ExploreMetadataPanel
  viewMode={viewMode}
  zoomLevel={zoomLevel}
  activeCluster={activeCluster}
  neighborhoodEntities={neighborhoodEntities}
  neighborhoodEdges={neighborhoodEdges}
  allSources={allSources}
  sourceEdges={sourceEdges}
  sourceGraphAnchors={sourceGraphAnchors}
  selectedEntityId={selectedEntityId}
  selectedSourceId={selectedSourceId}
  onSelectEntity={handleSelectEntity}
  onSelectSource={handleSelectSource}
  onBack={returnToLandscape}
  filters={filters}
  onClearSpotlight={() => toggleSpotlight(null)}
  selectedSuggestedCandidate={selectedSuggestedCandidate}
  onConfirmSuggested={handleConfirmFromExplore}
  onDismissSuggested={handleDismissFromExplore}
  onClearSuggested={() => setSelectedSuggestedId(null)}
/>
```

### 7.10 Pass new props to ExploreToolbar

Add to `toolbarProps`:

```typescript
const toolbarProps = {
  // ... all existing props unchanged ...
  suggestedCount:          suggestedClusterData.length,
  showCrossEdges,
  onToggleShowCrossEdges:  () => setShowCrossEdges(prev => !prev),
}
```

---

## 8. `ExploreToolbar.tsx` Modifications

**File:** `src/views/explore/ExploreToolbar.tsx`

### 8.1 New props

Add to `ExploreToolbarProps` interface:

```typescript
suggestedCount?:          number
showCrossEdges?:          boolean
onToggleShowCrossEdges?:  () => void
```

Destructure in the function signature.

### 8.2 "New clusters detected" notification pill

Add inside the toolbar JSX, in the right-side area before the existing mode controls. Render only when `(suggestedCount ?? 0) > 0 && viewMode === 'anchors'`:

```tsx
{(suggestedCount ?? 0) > 0 && viewMode === 'anchors' && (
  <div style={{
    display: 'flex', alignItems: 'center', gap: 6,
    padding: '4px 10px', borderRadius: 20,
    background: 'rgba(245,158,11,0.08)',
    border: '1px solid rgba(245,158,11,0.25)',
    flexShrink: 0,
  }}>
    <span style={{
      fontFamily: 'var(--font-body)', fontSize: 11, fontWeight: 600, color: '#d97706',
    }}>
      ✦ {suggestedCount} new cluster{suggestedCount !== 1 ? 's' : ''} detected
    </span>
    <button
      type="button"
      onClick={() => { window.location.href = '/anchors' }}
      style={{
        fontFamily: 'var(--font-body)', fontSize: 11, fontWeight: 600, color: '#d97706',
        background: 'none', border: 'none', padding: 0, cursor: 'pointer',
        textDecoration: 'underline', textUnderlineOffset: 2,
      }}
    >
      Review →
    </button>
  </div>
)}
```

### 8.3 Cross-edges toggle

Add near the existing "Show edges" toggle, when `viewMode === 'anchors' && !isNeighborhood`:

```tsx
{viewMode === 'anchors' && !isNeighborhood && onToggleShowCrossEdges && (
  <button
    type="button"
    onClick={onToggleShowCrossEdges}
    style={{
      display: 'flex', alignItems: 'center', gap: 5,
      padding: '4px 10px', borderRadius: 20,
      fontSize: 11, fontWeight: 600,
      fontFamily: 'var(--font-body)',
      border: `1px solid ${showCrossEdges ? 'rgba(100,116,139,0.3)' : 'var(--border-subtle)'}`,
      background: showCrossEdges ? 'rgba(100,116,139,0.06)' : 'transparent',
      color: showCrossEdges ? 'rgb(71,85,105)' : 'var(--color-text-secondary)',
      cursor: 'pointer',
      transition: 'all 0.15s ease',
    }}
  >
    <svg width={14} height={10} viewBox="0 0 14 10" style={{ flexShrink: 0 }}>
      <circle cx={2}  cy={5} r={2}  fill="currentColor" opacity={0.6} />
      <line x1={4} y1={5} x2={10} y2={5} stroke="currentColor" strokeWidth={1.5} opacity={0.6} />
      <circle cx={12} cy={5} r={2}  fill="currentColor" opacity={0.6} />
    </svg>
    Connections
  </button>
)}
```

---

## 9. `ExploreMetadataPanel.tsx` Modifications

**File:** `src/views/explore/ExploreMetadataPanel.tsx`

### 9.1 New imports

```typescript
import type { AnchorCandidateWithNode } from '../../types/anchors'
import { EntityBadge } from '../../components/shared/EntityBadge'
```

(`EntityBadge` is already imported in this file — verify and skip if so.)

### 9.2 New props

Add to `ExploreMetadataPanelProps`:

```typescript
selectedSuggestedCandidate?: AnchorCandidateWithNode | null
onConfirmSuggested?:  (candidateId: string, nodeId: string) => Promise<void>
onDismissSuggested?:  (candidateId: string, dismissCount: number) => Promise<void>
onClearSuggested?:    () => void
```

Destructure in the function signature.

### 9.3 Priority condition at the top of ExploreMetadataPanel

Add as the **first** condition, before the existing landscape/neighborhood/source checks:

```typescript
// Suggested anchor selected — highest priority
if (selectedSuggestedCandidate && viewMode === 'anchors') {
  return (
    <SuggestedAnchorPanel
      candidate={selectedSuggestedCandidate}
      onConfirm={onConfirmSuggested ?? (async () => {})}
      onDismiss={onDismissSuggested ?? (async () => {})}
      onClose={onClearSuggested ?? (() => {})}
    />
  )
}
```

### 9.4 `SuggestedAnchorPanel` local component

Add at the bottom of `ExploreMetadataPanel.tsx` as a local function component (not exported). Imports `useState` from React (already imported in this file).

```tsx
function SuggestedAnchorPanel({
  candidate, onConfirm, onDismiss, onClose,
}: {
  candidate:  AnchorCandidateWithNode
  onConfirm:  (candidateId: string, nodeId: string) => Promise<void>
  onDismiss:  (candidateId: string, dismissCount: number) => Promise<void>
  onClose:    () => void
}) {
  const [confirming, setConfirming] = useState(false)
  const [dismissing, setDismissing] = useState(false)
  const node = candidate.node

  const handleConfirm = async () => {
    if (!node) return
    setConfirming(true)
    await onConfirm(candidate.id, node.id)
    setConfirming(false)
  }

  const handleDismiss = async () => {
    setDismissing(true)
    await onDismiss(candidate.id, candidate.dismissCount)
    setDismissing(false)
  }

  // Change 4: score color
  const scorePct   = Math.round(candidate.compositeScore * 100)
  const scoreColor = candidate.compositeScore >= 0.60 ? '#16a34a'
    : candidate.compositeScore >= 0.50 ? '#d97706'
    : 'var(--color-text-secondary)'

  return (
    <div style={{
      height: '100%', overflowY: 'auto', padding: '20px 18px',
      animation: 'slideInRight 0.2s ease',
    }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 14 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          {/* Suggested badge + score */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
            <div style={{
              display: 'inline-flex', alignItems: 'center', gap: 4,
              padding: '2px 8px', borderRadius: 4,
              background: 'rgba(245,158,11,0.08)',
              border: '1px solid rgba(245,158,11,0.2)',
            }}>
              <span style={{ fontSize: 10, fontWeight: 700, color: '#d97706', fontFamily: 'var(--font-body)' }}>
                ✦ Suggested
              </span>
            </div>
            {/* Change 4: score pill */}
            <span style={{
              fontSize: 10, fontWeight: 700,
              color: scoreColor,
              background: `${scoreColor}12`,
              border: `1px solid ${scoreColor}28`,
              borderRadius: 4, padding: '2px 7px',
              fontFamily: 'var(--font-body)',
            }}>
              {scorePct}%
            </span>
          </div>
          {/* Label */}
          <h2 style={{
            fontFamily: 'var(--font-display)', fontSize: 16, fontWeight: 700,
            color: 'var(--color-text-primary)', margin: 0, lineHeight: 1.3,
          }}>
            {node?.label ?? 'Unknown'}
          </h2>
          {node && (
            <div style={{ marginTop: 6 }}>
              <EntityBadge type={node.entity_type} size="xs" />
            </div>
          )}
        </div>
        <button
          type="button" onClick={onClose}
          style={{
            background: 'none', border: 'none', cursor: 'pointer',
            color: 'var(--color-text-secondary)', padding: 4, flexShrink: 0,
            fontSize: 18, lineHeight: 1,
          }}
        >
          ×
        </button>
      </div>

      {/* Reasoning */}
      {candidate.reasoningText && (
        <div style={{
          background: 'rgba(245,158,11,0.05)',
          border: '1px solid rgba(245,158,11,0.15)',
          borderRadius: 8, padding: '10px 12px', marginBottom: 16,
        }}>
          <p style={{
            fontFamily: 'var(--font-body)', fontSize: 12,
            color: 'var(--color-text-body)', lineHeight: 1.6, margin: 0,
          }}>
            {candidate.reasoningText}
          </p>
        </div>
      )}

      {/* Signal bars — compact inline version */}
      <div style={{ marginBottom: 16 }}>
        <div style={{
          fontFamily: 'var(--font-display)', fontSize: 10, fontWeight: 700,
          textTransform: 'uppercase' as const, letterSpacing: '0.08em',
          color: 'var(--color-text-secondary)', marginBottom: 8,
        }}>
          Signal Breakdown
        </div>
        {([
          ['Centrality', candidate.centralityScore],
          ['Diversity',  candidate.diversityScore],
          ['Velocity',   candidate.velocityScore],
          ['Richness',   candidate.richnessScore],
        ] as [string, number][]).map(([label, value]) => {
          const fill = value >= 0.7 ? '#22c55e' : value >= 0.4 ? '#f59e0b' : '#ef4444'
          return (
            <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5 }}>
              <span style={{
                fontFamily: 'var(--font-display)', fontSize: 9, fontWeight: 700,
                color: 'var(--color-text-secondary)', width: 60, flexShrink: 0,
                textTransform: 'uppercase' as const, letterSpacing: '0.04em',
              }}>
                {label}
              </span>
              <div style={{
                flex: 1, height: 4, background: 'var(--color-bg-inset)', borderRadius: 2, overflow: 'hidden',
              }}>
                <div style={{
                  height: '100%', width: `${Math.round(value * 100)}%`,
                  background: fill, borderRadius: 2, transition: 'width 0.4s ease',
                }} />
              </div>
              <span style={{
                fontFamily: 'var(--font-body)', fontSize: 10, fontWeight: 600,
                color: 'var(--color-text-body)', width: 28, textAlign: 'right' as const, flexShrink: 0,
              }}>
                {Math.round(value * 100)}
              </span>
            </div>
          )
        })}
      </div>

      {/* Quick stats */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginBottom: 16 }}>
        {([
          ['Mentions',   candidate.mentionCount],
          ['Sources',    candidate.sourceCount],
          ['Edges',      candidate.connectionCount],
          ['Score',      `${scorePct}%`],
        ] as [string, number | string][]).map(([label, value]) => (
          <div key={label} style={{
            background: 'var(--color-bg-inset)', borderRadius: 8, padding: '8px 10px',
          }}>
            <div style={{
              fontFamily: 'var(--font-display)', fontSize: 14, fontWeight: 700,
              color: 'var(--color-text-primary)',
            }}>
              {value}
            </div>
            <div style={{
              fontFamily: 'var(--font-body)', fontSize: 10,
              color: 'var(--color-text-secondary)', marginTop: 2,
            }}>
              {label}
            </div>
          </div>
        ))}
      </div>

      {/* Velocity direction */}
      {candidate.velocityDirection !== 'stable' && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 6, marginBottom: 16,
          padding: '7px 10px', borderRadius: 8,
          background: candidate.velocityDirection === 'rising'
            ? 'rgba(34,197,94,0.06)' : 'rgba(239,68,68,0.06)',
          border: `1px solid ${candidate.velocityDirection === 'rising'
            ? 'rgba(34,197,94,0.2)' : 'rgba(239,68,68,0.2)'}`,
        }}>
          <span style={{
            fontSize: 12,
            color: candidate.velocityDirection === 'rising' ? '#16a34a' : '#dc2626',
          }}>
            {candidate.velocityDirection === 'rising' ? '↑' : '↓'}
          </span>
          <span style={{
            fontFamily: 'var(--font-body)', fontSize: 11, fontWeight: 500,
            color: candidate.velocityDirection === 'rising' ? '#16a34a' : 'var(--color-text-secondary)',
          }}>
            {candidate.velocityDirection === 'rising'
              ? 'Activity increasing recently'
              : 'Activity has slowed recently'}
          </span>
        </div>
      )}

      {/* Change 3: sub-anchor suggestion (PRD-22 forward compat) */}
      {/* When suggestedParentAnchorId is populated by PRD-22, this renders the
          sub-anchor confirmation option. Currently never shown (field is always null). */}

      {/* Actions */}
      <div style={{
        borderTop: '1px solid var(--border-subtle)',
        paddingTop: 14, marginTop: 4,
        display: 'flex', flexDirection: 'column', gap: 8,
      }}>
        <button
          type="button" onClick={handleConfirm}
          disabled={confirming || !node}
          style={{
            width: '100%', padding: '9px 0', borderRadius: 8, border: 'none',
            background: confirming ? 'var(--color-bg-inset)' : 'var(--color-accent-500)',
            color: confirming ? 'var(--color-text-secondary)' : 'white',
            fontFamily: 'var(--font-body)', fontSize: 13, fontWeight: 600,
            cursor: confirming ? 'default' : 'pointer',
            transition: 'all 0.15s ease',
          }}
        >
          {confirming ? 'Confirming…' : '✓ Confirm Anchor'}
        </button>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            type="button"
            onClick={() => { window.location.href = '/anchors' }}
            style={{
              flex: 1, padding: '7px 0', borderRadius: 8,
              border: '1px solid var(--border-subtle)',
              background: 'var(--color-bg-inset)',
              color: 'var(--color-text-body)',
              fontFamily: 'var(--font-body)', fontSize: 12, fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Full Review →
          </button>
          <button
            type="button" onClick={handleDismiss}
            disabled={dismissing}
            style={{
              flex: 1, padding: '7px 0', borderRadius: 8,
              border: '1px solid var(--border-subtle)',
              background: 'transparent',
              color: 'var(--color-text-secondary)',
              fontFamily: 'var(--font-body)', fontSize: 12, fontWeight: 600,
              cursor: dismissing ? 'default' : 'pointer',
            }}
          >
            {dismissing ? 'Dismissing…' : 'Dismiss'}
          </button>
        </div>
      </div>
    </div>
  )
}
```

---

## 10. Forward-Compatible Decisions

- **`suggestedParentAnchorId: null` placeholder** in `SuggestedClusterData` means PRD-22 only needs to populate the field in the scoring engine — no changes to `LandscapeView`, `ClusterBubble`, or `SuggestedAnchorPanel` are needed. When non-null, ghost clusters render with a visual tether to the parent, and `SuggestedAnchorPanel` shows the "Add as sub-anchor" button. The comment in Section 9.4 marks exactly where this renders.

- **`duplicateCount` on ghost clusters** is forward-compatible with PRD-21's retroactive merge. Once the merge runs and duplicates are eliminated, all `duplicateCount` values become 0 and the "+N similar" badges disappear automatically without any code change.

- **The double-refetch pattern** (`refetch()` + `setTimeout(() => refetch(), 35000)`) is safe to call repeatedly. `useExploreData` uses a `fetchCount` ref to cancel stale fetches — if two fetches fire close together, only the latest resolves. The 35-second delay is a pragmatic approximation of `on-confirm.ts` completion time; if that function gets faster or slower, adjust this constant.

- **`synapse:anchor-confirmed` event** is emitted here (by `handleConfirmFromExplore`) AND by `useAnchorCandidates` (PRD-19 improvements brief). Both emit it. `ExploreView` listens for it. This is intentional — confirmation can come from either the Anchors page or Explore itself, and in both cases Explore should refetch.

---

## 11. Edge Cases and Error Handling

- **`fetchCandidatesWithNodes` fails on mount**: `suggestedCandidates` stays `[]`. No ghost clusters render. The graph looks exactly as before. The `.catch()` logs a warning, never surfaces to the user.

- **All suggested candidates have the same label** (extreme case — 24× "Joseph Thomas"): The dedup grouping memo produces one ghost cluster with `duplicateCount: 23`. The "+23 similar" badge renders correctly. One click → `SuggestedAnchorPanel` confirms the highest-scoring representative, others stay in `anchor_candidates` as suggested and re-surface after PRD-21 merges the underlying nodes.

- **`user` is null** when the fetch effects run: Both `useEffect` hooks guard with `if (!user) return`. No fetch fires. When `user` becomes non-null (auth resolves), the effect re-runs.

- **Confirm fails mid-optimistic-update**: `setSuggestedCandidates` has already removed the candidate. The failure path does not re-add it (the confirm function in `confirmAnchorCandidate` service handles rollback at the Anchors page level). In Explore, if `refetch()` runs and the cluster doesn't appear, the user can navigate to the Anchors page to retry. This is acceptable — the Explore confirm action is a convenience, not the primary path.

- **35-second timeout fires after user has navigated away**: `refetch()` calls `fetchClusterData` which sets state in `useExploreData`. If `ExploreView` has unmounted, the state update is a no-op (React ignores updates on unmounted components in React 18 with concurrent mode). No error thrown.

- **Ghost cluster positioned over a confirmed cluster** due to collision avoidance failure: The overlap is visually imperfect but functionally fine — both bubbles are clickable and their click targets don't interfere. The collision avoidance algorithm is best-effort, not guaranteed.

- **`showCrossEdges` defaults to `true`**: Users who find cross-cluster edges visually noisy can toggle them off. The toggle state lives in `ExploreView` local state — it resets to `true` on page navigation. Making it persistent (in `localStorage` or user config) is a future enhancement.

---

## 12. Acceptance Criteria

- [ ] Suggested anchor candidates appear as ghost clusters in the Landscape view with: dashed amber border, ✦ badge top-right, reduced-opacity type ring, amber "✦ Suggested" sub-label, composite score percentage below sub-label
- [ ] Hovering a ghost cluster shows `SuggestedTooltip` with: amber "✦ Suggested Anchor" header, score pill, anchor label, entity type, reasoning text (truncated at 100 chars), velocity indicator if rising, "Click to review →" prompt
- [ ] When multiple suggested candidates share the same label (e.g. 4× "Joseph Thomas"), only one ghost cluster renders — the highest-scoring representative — with a "+3 similar" badge at bottom-left
- [ ] Clicking a ghost cluster opens `SuggestedAnchorPanel` in the right metadata panel without changing zoom level
- [ ] `SuggestedAnchorPanel` shows: ✦ Suggested badge, score pill (green/amber/gray), anchor label, entity type badge, reasoning text box, four signal bars with percentage values, quick stats grid (mentions/sources/edges/score), velocity indicator if not stable
- [ ] Clicking "✓ Confirm Anchor": ghost cluster disappears immediately, `refetch()` fires, confirmed anchor appears as a real cluster, second `refetch()` fires at 35 seconds, nav badge decrements, both custom events dispatched
- [ ] Clicking "Dismiss": ghost cluster disappears immediately, `status = 'dismissed'` in Supabase, `resurface_after` set correctly
- [ ] "Full Review →" navigates to `/anchors`
- [ ] Cross-cluster edges between confirmed anchor clusters are visibly readable (opacity ≥ 0.12, solid lines, weight-proportional thickness)
- [ ] "Connections" toggle in toolbar shows/hides cross-cluster edges with correct active/inactive visual state — default: shown
- [ ] "✦ X new clusters detected" notification pill appears in toolbar when `suggestedClusterData.length > 0` and `viewMode === 'anchors'`, hidden otherwise
- [ ] Notification pill count reflects unique-label count (not raw candidate count), so duplicates don't inflate the number
- [ ] At most 8 ghost clusters render simultaneously (top 8 by composite score after dedup grouping)
- [ ] Ghost clusters do not trigger the zoom-into-neighborhood transition when zoomed over them
- [ ] Confirming an anchor from the Anchors page (`synapse:anchor-confirmed` event) causes Explore to refetch cluster data automatically
- [ ] Confirming an anchor from within Explore causes the Anchors page suggestion count to update (`synapse:anchor-suggestions-changed` event dispatched)
- [ ] `suggestedParentAnchorId` is `null` on all ghost clusters (PRD-22 field, not yet populated)
- [ ] All five modified files compile with zero TypeScript errors in strict mode
- [ ] No existing Explore functionality is broken: landscape→neighborhood transition, source graph view, entity browser, filter pills, anchor spotlight, edge type toggles, drag-to-resize
