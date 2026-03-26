# PRD-19 — Anchors Page: Full View

**Phase:** 5 — Intelligence Layer  
**Dependencies:** PRD-17 (schema + types + service layer), PRD-18 (scoring engine writing rows)  
**Estimated Complexity:** High  
**Estimated Effort:** 2–3 sessions  

---

## 1. Objective

This PRD builds the full Anchors management page — the primary surface where users discover system-suggested anchor candidates, confirm or dismiss them, manually create new anchors, and audit the health of their existing anchor layer.

After this PRD, the auto-anchor system is fully visible and actionable. A user opening the app after the scoring engine has run will see a badge on the nav rail indicating new suggestions, navigate to the Anchors page, review candidates with system-generated reasoning, and confirm them with a single click. The page also serves as the control panel for the anchor system's behaviour — suggestion frequency, threshold sensitivity, and signal weight profiles are all configurable here.

The design follows the two-column + drag-resize pattern established by `OrientView` and `PipelineView`, with a full-width control bar above the split.

---

## 2. What Gets Built

### Files created
- `src/views/AnchorsView.tsx` — the main page component
- `src/components/anchors/AnchorCard.tsx` — card for both confirmed and suggested states
- `src/components/anchors/AnchorDetailPanel.tsx` — right panel when an anchor is selected
- `src/components/anchors/AnchorHealthPanel.tsx` — right panel default state
- `src/components/anchors/AnchorCreateForm.tsx` — right panel create/edit form
- `src/components/anchors/AnchorSignalBar.tsx` — visual signal score breakdown component
- `src/hooks/useAnchorCandidates.ts` — data hook for all anchor candidate operations

### Files modified
- `src/components/layout/NavRail.tsx` — add Anchors nav item with suggestion count badge
- `src/app/Router.tsx` — add `/anchors` route
- `src/app/providers/SettingsProvider.tsx` — expose `refreshAnchors` after confirm/create operations
- `src/types/index.ts` — already updated in PRD-17; no changes needed

---

## 3. Design Specification

### 3.1 Page Layout

Identical structural pattern to `PipelineView` and `OrientView`:

```
┌─────────────────────────────────────────────────────────────────┐
│ CONTROL BAR (full width, bg-card, border-bottom, 44px min-h)    │
├──────────────────────────────────┬──┬──────────────────────────┤
│                                  │  │                           │
│   LEFT COLUMN (65% default)      │▓▓│   RIGHT PANEL (flex-1)   │
│   scrollable, bg-content         │  │   overflow-hidden         │
│   padding: 20px 36px             │  │                           │
│                                  │  │                           │
└──────────────────────────────────┴──┴──────────────────────────┘
```

- Default split: `DEFAULT_LEFT_PCT = 65`, `MIN_LEFT_PCT = 30`, `MAX_LEFT_PCT = 80`
- Drag handle: same `GripVertical` pattern as Pipeline/Orient — 12px wide, accent-500 on hover/drag
- Left column: `overflowY: 'auto'`, `background: 'var(--color-bg-content)'`
- Right panel: `flex: 1`, `height: '100%'`, `overflow: 'hidden'`, `minWidth: 0`

### 3.2 Control Bar

`background: 'var(--color-bg-card)'`, `borderBottom: '1px solid var(--border-subtle)'`, `padding: '8px 24px'`, `minHeight: 44`, `gap: 8`, `flexWrap: 'wrap'`

**Left — filter pills** (same pattern as PipelineView `FilterDropdown` pills):

Five pills using the accent-50/accent-500 active treatment from OrientView:

| Key | Label | Count source |
|-----|-------|-------------|
| `all` | All | `confirmed + suggested + dormant` |
| `confirmed` | Confirmed | `confirmed` status count |
| `suggested` | Suggested | `suggested` status count — amber treatment when > 0 |
| `manual` | Manual | candidates where `compositeScore === 1.0` |
| `dormant` | Dormant | `dormant` status count |

The `suggested` pill has special treatment when its count > 0: amber background (`rgba(245,158,11,0.08)`), amber border (`rgba(245,158,11,0.25)`), amber text (`#d97706`). When count is 0 it uses the standard inactive pill style.

**Middle — stats strip** (inline, `fontSize: 12`, `color: text-secondary`):

```
[vertical divider]  24 anchors  ·  6 suggested  ·  847 nodes  ·  scored 2h ago
```

"6 suggested" text uses `color: #d97706, fontWeight: 600` when > 0 (amber, draws eye). "847 nodes" shows total `knowledge_nodes` count. "scored 2h ago" shows relative time since the most recent `last_scored_at` across all candidates.

**Right — primary action**:

```
[+ New Anchor]   ← accent-500 bg, white text, 12px, 7px 14px padding, 8px radius
```

When the create form is open in the right panel, this button inverts to accent-50 bg, accent-500 text, accent border — exact same pattern as "New Digest" in OrientView.

### 3.3 Left Column — List Structure

Padding: `20px 36px`. Card gap: `8px`. Section gap: `24px` between SUGGESTED and YOUR ANCHORS sections.

**Section labels**: Cabinet Grotesk, uppercase, 10px, weight 700, letter-spacing 0.08em, `color: text-secondary`, `marginBottom: 10`.

#### SUGGESTED section

Only renders when `filter === 'all' || filter === 'suggested'` AND there are suggested candidates.

When 3 or more suggestions exist, a **batch review bar** renders above the cards:

```
┌─────────────────────────────────────────────────────┐
│  ✦ 6 new clusters detected from recent ingestion    │
│                            [Review All]  [Skip All] │
└─────────────────────────────────────────────────────┘
```

Styles: `background: rgba(245,158,11,0.06)`, `border: 1px solid rgba(245,158,11,0.2)`, `borderRadius: 10`, `padding: '10px 14px'`, `marginBottom: 8`. The ✦ glyph is the suggestion indicator used throughout.

"Review All" opens the first suggested card's detail in the right panel. "Skip All" calls `dismissAll()` which moves all suggested candidates to dismissed after a confirmation dialog.

#### YOUR ANCHORS section

Only renders when filter includes confirmed/dormant candidates.

Sort control: a small dropdown at the section label level — "Most Connected", "Recently Added", "Alphabetical", "Dormant First". Defaults to "Most Connected". Uses the same `FilterDropdown` component pattern from PipelineView — compact, pill-style.

### 3.4 AnchorCard Component

**File:** `src/components/anchors/AnchorCard.tsx`

Both confirmed and suggested anchors use the same base card. Visual differentiation through left-edge treatment and badge presence only.

**Confirmed anchor card:**

```
┌─[3px solid color bar]──────────────────────────────────────────┐
│  [EntityDot 8px]  Label (Cabinet Grotesk 14px/700)             │
│                   Topic  ← EntityBadge xs                      │
│                                                                 │
│  ◈ 47 nodes    ⬡ 12 sources    ↔ 8 connections                 │
│                                                                 │
│  [tag1] [tag2] [+2 more]           Updated 3 days ago          │
└────────────────────────────────────────────────────────────────┘
```

Left-edge bar: `width: 3`, `height: '100%'`, `position: absolute`, `left: 0`, `top: 0`, `bottom: 0`, `borderRadius: '12px 0 0 12px'`, `background: entityColor`. This requires the card to be `position: relative` and `overflow: hidden`.

Stats row: DM Sans 11px, `color: text-secondary`. Icons are Lucide at size 10. Values use `fontWeight: 600, color: text-body`.

Tags: same pill style as DigestCard module tags — `fontSize: 10`, `fontWeight: 600`, `background: bg-inset`, `padding: '2px 8px'`, `borderRadius: 4`.

Timestamp: `fontSize: 10`, `color: text-secondary`, right-aligned in the bottom row.

**Selected state**: `background: rgba(254,242,237,0.5)`, `border: 1px solid rgba(214,58,0,0.3)` — same as DigestCard.

**Hover state**: `transform: translateY(-1px)`, `boxShadow: '0 2px 8px rgba(0,0,0,0.04)'`, `border: 1px solid var(--border-default)`.

**Suggested anchor card** — same structure with these differences:

1. Left-edge bar is **dashed**: achieved with a CSS `border-left: 3px dashed {entityColor}` instead of a solid positioned element. Position: `borderLeft: '3px dashed {entityColor}'`, remove the absolute bar, add `paddingLeft: 16` (same total as confirmed's 13px card padding + 3px bar).

2. **✦ Suggested badge** top-right: `fontSize: 10`, `fontWeight: 700`, `color: #d97706`, `background: rgba(245,158,11,0.08)`, `border: 1px solid rgba(245,158,11,0.2)`, `padding: '2px 7px'`, `borderRadius: 4`. Text: `✦ Suggested`.

3. **Reasoning text** below the label/badge row: one line, DM Sans 11px, `color: text-secondary`, `fontStyle: italic`, truncated with `textOverflow: ellipsis`. Shows `candidate.reasoningText`.

4. **Inline actions** replace the tags row:

```
[Confirm ✓]   [Dismiss ×]
```

"Confirm ✓": `background: var(--color-accent-500)`, `color: white`, `fontSize: 11`, `fontWeight: 600`, `padding: '4px 12px'`, `borderRadius: 6`, `border: none`. On click: calls `onConfirm(candidate.id, candidate.nodeId)` — does NOT open detail panel, just confirms in place and removes the card with a fade-out animation.

"Dismiss ×": ghost style — `background: transparent`, `border: 1px solid var(--border-subtle)`, `color: text-secondary`, `fontSize: 11`, `fontWeight: 600`, `padding: '4px 10px'`, `borderRadius: 6`. On click: calls `onDismiss(candidate.id, candidate.dismissCount)`.

5. **"Detected X days ago"** replaces the timestamp.

**Dormant anchor card**: same as confirmed, but adds a small amber `◑ Dormant` badge next to the entity type badge. No inline actions.

**Props interface:**

```typescript
interface AnchorCardProps {
  candidate: AnchorCandidateWithNode
  isSelected: boolean
  onClick: () => void
  onConfirm: (candidateId: string, nodeId: string) => void
  onDismiss: (candidateId: string, dismissCount: number) => void
  index: number
}
```

### 3.5 AnchorSignalBar Component

**File:** `src/components/anchors/AnchorSignalBar.tsx`

Used inside `AnchorDetailPanel` to show the signal score breakdown visually.

```
CENTRALITY    ████████░░░░   0.72
DIVERSITY     ██████░░░░░░   0.58
VELOCITY      ███████████░   0.91  ↑
RICHNESS      █████░░░░░░░   0.43
```

Each bar:
- Label: Cabinet Grotesk uppercase 9px/700, `color: text-secondary`, `width: 72px`, fixed
- Track: `height: 4`, `background: var(--color-bg-inset)`, `borderRadius: 2`, `flex: 1`
- Fill: `height: 4`, `borderRadius: 2`, width as percentage of track
  - Fill color: `#22c55e` if score ≥ 0.7, `#f59e0b` if ≥ 0.4, `#ef4444` if < 0.4
- Value: DM Sans 10px/600, `color: text-body`, `width: 32px`, right-aligned
- Velocity arrow: only on VELOCITY row — `↑` in green if `velocityDirection === 'rising'`, `↓` in red if `'falling'`, nothing if `'stable'`

```typescript
interface AnchorSignalBarProps {
  centralityScore: number
  diversityScore:  number
  velocityScore:   number
  richnessScore:   number
  velocityDirection: VelocityDirection
}
```

### 3.6 AnchorDetailPanel Component

**File:** `src/components/anchors/AnchorDetailPanel.tsx`

Renders when a candidate is selected. Scrollable, `padding: '24px 20px'`, same `slideInRight` animation as `ExtractionDetail`.

**Header:**
- Anchor label: Cabinet Grotesk 18px/700, `color: text-primary`, editable on click (becomes an `<input>` with same font/size styling, `onBlur` saves)
- Entity type badge (`EntityBadge` component) + status badge (Confirmed / Suggested / Dormant / Manual)
- Close button `×`: top-right, ghost, `color: text-secondary`

**For suggested candidates only — "Why suggested?" section:**

Expandable (open by default). Shows `candidate.reasoningText` as a readable paragraph in a subtle inset box:

```
┌─────────────────────────────────────────────────────────────┐
│  ✦  Referenced in 6 different sources spanning 3 content    │
│     types over 18 days, with activity increasing recently.  │
│     Participates in 5 relationship types.                   │
└─────────────────────────────────────────────────────────────┘
```

`background: rgba(245,158,11,0.05)`, `border: 1px solid rgba(245,158,11,0.15)`, `borderRadius: 8`, `padding: '10px 12px'`. Text: DM Sans 12px, `color: text-body`, `lineHeight: 1.6`.

Below the reasoning box: `AnchorSignalBar` component showing all four signal scores.

**Connected Nodes section** (section label + list):

Fetches top 8 nodes connected to `candidate.nodeId` via `knowledge_edges` (using the existing `useNodeNeighbors` hook or a direct query). Shows each as a row:

```
[EntityDot]  Node Label                    Topic  →
```

`fontSize: 12`, `color: text-body`, hover: `background: bg-inset`. "→" is an arrow that navigates to that node in Explore. Shows "View all in Explore →" text link below if connectionCount > 8.

**Source Distribution section:**

Horizontal bar showing source type proportions using the `getSourceConfig` color system. Each segment labeled with source type and percentage. If `sourceCount === 1`: a small amber warning: `⚠ Single source — consider ingesting more content on this topic`.

**Cross-Anchor Connections section:**

Chips showing other anchors that share entities with this one. Each chip: `EntityDot` + anchor label, `background: bg-inset`, `border: border-subtle`, `borderRadius: 20`, `padding: '3px 10px'`, `fontSize: 11`. If `anchorConnections === 0`: secondary text "Not yet connected to other anchors".

**Actions** — bottom of panel, `borderTop: '1px solid var(--border-subtle)'`, `paddingTop: 16`, `marginTop: 20`:

For **suggested** candidates:
- `Confirm Anchor` — accent-500 primary button, full width
- `Edit & Confirm` — secondary button (dark bg) — opens name input inline
- `Dismiss` — ghost, `color: text-secondary`

For **confirmed/dormant** candidates:
- `Edit` — tertiary button
- `View in Explore →` — ghost, accent text — navigates to `/explore?node={nodeId}`
- `Archive` — ghost, secondary color
- `Delete` — ghost, `color: #ef4444` (destructive), shows inline confirmation before executing

For **dormant** candidates only, above the standard actions:
```
◑ This anchor has been quiet for {X} days.
  [Reactivate]  ← links to Explore with this anchor focused
```

### 3.7 AnchorHealthPanel Component

**File:** `src/components/anchors/AnchorHealthPanel.tsx`

The default right panel state when nothing is selected. Provides immediate value rather than an empty call-to-action. Fetches `fetchAnchorHealthSummary` from the PRD-17 service layer on mount.

**Header**: "Anchor Health" in Cabinet Grotesk 15px/700.

**Stats grid** — 2×2 grid of stat cards (`display: grid`, `gridTemplateColumns: '1fr 1fr'`, `gap: 8`, `marginBottom: 20`):

Each stat card: `background: bg-inset`, `borderRadius: 8`, `padding: '12px 14px'`.
- Value: Cabinet Grotesk 22px/700, `color: text-primary`
- Label: DM Sans 11px, `color: text-secondary`

The four stats:
1. Total Anchors — `summary.totalConfirmed`
2. Avg. Nodes/Anchor — `summary.avgNodesPerAnchor`
3. Most Connected — `summary.mostConnectedAnchor?.label` (truncated) with count as sub-label
4. Isolated — `summary.isolatedAnchors` with label "no cross-connections" — amber treatment if > 0

**Needs Attention section** (only renders if `summary.staleAnchors.length > 0`):

Section label: "NEEDS ATTENTION". Each item is a compact row:

```
[amber ⚠]  Anchor Label          issue description text    →
```

`fontSize: 12`. Clicking navigates to that anchor's detail in the right panel (sets `selectedCandidateId`). Issues use their own colors:
- `isolated`: amber `⚠`
- `low_nodes`: amber `⚠`  
- `dormant`: gray `◑`
- `single_source`: blue `ⓘ`

**"No suggestions" empty state** (when `summary.totalSuggested === 0`):

Small inline note below the stats grid: DM Sans 12px, `color: text-secondary`:

> "No new suggestions right now. The system scores your graph after each extraction and daily at 3am UTC."

**Loading state**: Three skeleton placeholder blocks with pulse animation, same pattern as PipelineView's loading skeleton.

### 3.8 AnchorCreateForm Component

**File:** `src/components/anchors/AnchorCreateForm.tsx`

Renders in the right panel when creating or editing. Clean, minimal form — mirrors `DigestProfileEditor` panel mode.

**Header**: "New Anchor" / "Edit Anchor" in Cabinet Grotesk 15px/700. Close button `×` top-right.

**Node search field** (create mode only):

A search input that queries `searchNodesByLabel` from `src/services/supabase.ts` (already exists). Shows results as a dropdown list. Selecting a node populates the form with that node's existing label, entity type, and description. This is the primary creation path — users find an existing node and promote it to an anchor.

```
Search for a node to anchor...    [🔍]
──────────────────────────────────────
  [EntityDot]  Node Label          Topic
  [EntityDot]  Another Node      Project
```

Dropdown: `background: bg-card`, `border: 1px solid border-strong`, `borderRadius: 10`, `boxShadow: '0 4px 16px rgba(0,0,0,0.08)'`, `padding: 4`, `zIndex: 50`.

**Name field**: DM Sans input, `background: bg-inset`, `border: 1px solid border-subtle`, `borderRadius: 8`, `padding: '8px 12px'`, `fontSize: 13`. Pre-filled from selected node's label. Editable.

**Entity type selector**: Row of colored entity type pills in a wrapping flex container. Active pill: entity color bg at 12% opacity, entity color border, entity color text. Inactive: `bg-inset`, `border-subtle`, `text-secondary`. Only shows 12 most common types by default with a "Show all" toggle. Types: `Topic`, `Project`, `Person`, `Organization`, `Concept`, `Technology`, `Product`, `Goal`, `Insight`, `Idea`, `Event`, `Location` in default view.

**Description field** (optional): Textarea, 3 rows, same input styling, placeholder: "What does this anchor represent? (optional)"

**Tags field** (optional): Pill input — type and press Enter/comma to add tags. Each tag displays as a pill with `×` to remove. `background: accent-50`, `color: accent-500`, `border: 1px solid rgba(214,58,0,0.2)`.

**Action row**:
- `Save Anchor` — accent-500 primary button, disabled until a node is selected
- `Cancel` — ghost button

**Edit mode**: Same form, pre-filled from existing candidate data. Node search is hidden (can't change which node an anchor is based on). Shows a "You are editing an existing anchor" secondary text.

---

## 4. `useAnchorCandidates` Hook

**File:** `src/hooks/useAnchorCandidates.ts`

Central data hook for the Anchors page. Handles all fetch, mutate, and optimistic update logic.

```typescript
import { useState, useEffect, useCallback, useMemo } from 'react'
import { useAuth } from './useAuth'
import {
  fetchCandidatesWithNodes,
  fetchSuggestedCount,
  fetchAnchorHealthSummary,
  confirmAnchorCandidate,
  dismissAnchorCandidate,
  archiveAnchorCandidate,
  createManualAnchor,
  updateCandidateStatus,
} from '../services/anchorCandidates'
import type {
  AnchorCandidateWithNode,
  AnchorCandidateStatus,
  AnchorHealthSummary,
} from '../types/anchors'

export type AnchorSortKey = 'most_connected' | 'recently_added' | 'alphabetical' | 'dormant_first'
export type AnchorFilterKey = 'all' | 'confirmed' | 'suggested' | 'manual' | 'dormant'

interface UseAnchorCandidatesReturn {
  // Data
  suggested:         AnchorCandidateWithNode[]
  confirmed:         AnchorCandidateWithNode[]
  health:            AnchorHealthSummary | null
  suggestedCount:    number

  // Loading states
  loading:           boolean
  healthLoading:     boolean
  error:             string | null

  // Filter + sort
  filter:            AnchorFilterKey
  setFilter:         (f: AnchorFilterKey) => void
  sortKey:           AnchorSortKey
  setSortKey:        (s: AnchorSortKey) => void

  // Derived
  filteredConfirmed: AnchorCandidateWithNode[]
  filteredSuggested: AnchorCandidateWithNode[]
  totalCount:        number
  lastScoredAt:      string | null

  // Actions
  confirm:           (candidateId: string, nodeId: string) => Promise<void>
  dismiss:           (candidateId: string, dismissCount: number) => Promise<void>
  dismissAll:        () => Promise<void>
  archive:           (candidateId: string, nodeId: string) => Promise<void>
  createManual:      (nodeId: string) => Promise<void>
  refetch:           () => Promise<void>
}
```

**Implementation notes:**

- Fetches `suggested` and `confirmed` (+ dormant) in parallel on mount
- Optimistic updates: on `confirm()`, immediately remove the candidate from `suggested` and add it to `confirmed` before the async call completes. On failure, roll back.
- On `dismiss()`, immediately remove from `suggested`. On failure, add back.
- `suggestedCount` is fetched separately (lightweight count query) and used for the nav badge — it updates reactively when confirm/dismiss actions run
- `lastScoredAt` is derived by finding the maximum `last_scored_at` across all candidates — used in the stats strip
- After any mutation that changes `is_anchor` on a `knowledge_nodes` row, calls `refreshAnchors()` from `useSettings()` so the rest of the app (Explore, right panel Quick Access) immediately reflects the change

```typescript
export function useAnchorCandidates(): UseAnchorCandidatesReturn {
  const { user } = useAuth()
  const { refreshAnchors } = useSettings()

  const [suggested,      setSuggested]      = useState<AnchorCandidateWithNode[]>([])
  const [confirmed,      setConfirmed]      = useState<AnchorCandidateWithNode[]>([])
  const [health,         setHealth]         = useState<AnchorHealthSummary | null>(null)
  const [suggestedCount, setSuggestedCount] = useState(0)
  const [loading,        setLoading]        = useState(true)
  const [healthLoading,  setHealthLoading]  = useState(true)
  const [error,          setError]          = useState<string | null>(null)
  const [filter,         setFilter]         = useState<AnchorFilterKey>('all')
  const [sortKey,        setSortKey]        = useState<AnchorSortKey>('most_connected')

  const fetchAll = useCallback(async () => {
    if (!user) return
    setLoading(true)
    setError(null)
    try {
      const [suggestedData, confirmedData, count] = await Promise.all([
        fetchCandidatesWithNodes(user.id, ['suggested']),
        fetchCandidatesWithNodes(user.id, ['confirmed', 'dormant']),
        fetchSuggestedCount(user.id),
      ])
      setSuggested(suggestedData)
      setConfirmed(confirmedData)
      setSuggestedCount(count)
    } catch (err) {
      setError('Failed to load anchor candidates')
      console.error('[useAnchorCandidates]', err)
    } finally {
      setLoading(false)
    }
  }, [user])

  const fetchHealth = useCallback(async () => {
    if (!user) return
    setHealthLoading(true)
    try {
      const summary = await fetchAnchorHealthSummary(user.id)
      setHealth(summary)
    } finally {
      setHealthLoading(false)
    }
  }, [user])

  useEffect(() => {
    fetchAll()
    fetchHealth()
  }, [fetchAll, fetchHealth])

  // Sorting function for confirmed anchors
  const sortedConfirmed = useMemo(() => {
    const arr = [...confirmed]
    switch (sortKey) {
      case 'most_connected':  return arr.sort((a, b) => b.connectionCount - a.connectionCount)
      case 'recently_added':  return arr.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      case 'alphabetical':    return arr.sort((a, b) => (a.node?.label ?? '').localeCompare(b.node?.label ?? ''))
      case 'dormant_first':   return arr.sort((a, b) => {
        if (a.status === 'dormant' && b.status !== 'dormant') return -1
        if (b.status === 'dormant' && a.status !== 'dormant') return 1
        return b.connectionCount - a.connectionCount
      })
      default: return arr
    }
  }, [confirmed, sortKey])

  // Filter derived lists
  const filteredSuggested = useMemo(() => {
    if (filter === 'confirmed' || filter === 'dormant') return []
    return suggested
  }, [suggested, filter])

  const filteredConfirmed = useMemo(() => {
    switch (filter) {
      case 'suggested': return []
      case 'dormant':   return sortedConfirmed.filter(c => c.status === 'dormant')
      case 'manual':    return sortedConfirmed.filter(c => c.compositeScore === 1.0)
      case 'confirmed': return sortedConfirmed.filter(c => c.status === 'confirmed')
      default:          return sortedConfirmed
    }
  }, [sortedConfirmed, filter])

  const totalCount = confirmed.length + suggested.length

  const lastScoredAt = useMemo(() => {
    const all = [...suggested, ...confirmed]
    if (all.length === 0) return null
    return all.reduce((max, c) =>
      c.lastScoredAt > (max ?? '') ? c.lastScoredAt : max, null as string | null
    )
  }, [suggested, confirmed])

  // Actions with optimistic updates
  const confirm = useCallback(async (candidateId: string, nodeId: string) => {
    // Optimistic: move from suggested to confirmed
    const candidate = suggested.find(c => c.id === candidateId)
    if (!candidate) return
    setSuggested(prev => prev.filter(c => c.id !== candidateId))
    setSuggestedCount(prev => Math.max(0, prev - 1))
    setConfirmed(prev => [...prev, { ...candidate, status: 'confirmed' }])

    const success = await confirmAnchorCandidate(candidateId, nodeId)
    if (!success) {
      // Roll back
      setSuggested(prev => [...prev, candidate])
      setSuggestedCount(prev => prev + 1)
      setConfirmed(prev => prev.filter(c => c.id !== candidateId))
    } else {
      await refreshAnchors()
      fetchHealth()
    }
  }, [suggested, refreshAnchors, fetchHealth])

  const dismiss = useCallback(async (candidateId: string, dismissCount: number) => {
    const candidate = suggested.find(c => c.id === candidateId)
    if (!candidate || !user) return
    setSuggested(prev => prev.filter(c => c.id !== candidateId))
    setSuggestedCount(prev => Math.max(0, prev - 1))

    // Get cooldown from user config (default 30)
    const success = await dismissAnchorCandidate(candidateId, dismissCount, 30)
    if (!success) {
      setSuggested(prev => [...prev, candidate])
      setSuggestedCount(prev => prev + 1)
    }
  }, [suggested, user])

  const dismissAll = useCallback(async () => {
    if (!user) return
    const toDissmiss = [...suggested]
    setSuggested([])
    setSuggestedCount(0)
    await Promise.all(
      toDissmiss.map(c => dismissAnchorCandidate(c.id, c.dismissCount, 30))
    )
  }, [suggested, user])

  const archive = useCallback(async (candidateId: string, nodeId: string) => {
    const candidate = confirmed.find(c => c.id === candidateId)
    if (!candidate) return
    setConfirmed(prev => prev.filter(c => c.id !== candidateId))

    const success = await archiveAnchorCandidate(candidateId, nodeId)
    if (!success) {
      setConfirmed(prev => [...prev, candidate])
    } else {
      await refreshAnchors()
      fetchHealth()
    }
  }, [confirmed, refreshAnchors, fetchHealth])

  const createManual = useCallback(async (nodeId: string) => {
    if (!user) return
    const success = await createManualAnchor(user.id, nodeId)
    if (success) {
      await Promise.all([fetchAll(), fetchHealth(), refreshAnchors()])
    }
  }, [user, fetchAll, fetchHealth, refreshAnchors])

  return {
    suggested, confirmed, health, suggestedCount,
    loading, healthLoading, error,
    filter, setFilter, sortKey, setSortKey,
    filteredConfirmed, filteredSuggested, totalCount, lastScoredAt,
    confirm, dismiss, dismissAll, archive, createManual,
    refetch: fetchAll,
  }
}
```

---

## 5. `AnchorsView.tsx` — Full Structure Specification

**File:** `src/views/AnchorsView.tsx`

```typescript
// Imports
import { useState, useCallback, useRef } from 'react'
import { Plus, GripVertical, Anchor } from 'lucide-react'
import { useAnchorCandidates } from '../hooks/useAnchorCandidates'
import { useSettings } from '../hooks/useSettings'
import { AnchorCard } from '../components/anchors/AnchorCard'
import { AnchorDetailPanel } from '../components/anchors/AnchorDetailPanel'
import { AnchorHealthPanel } from '../components/anchors/AnchorHealthPanel'
import { AnchorCreateForm } from '../components/anchors/AnchorCreateForm'
import type { AnchorCandidateWithNode } from '../types/anchors'
```

**State:**
```typescript
const [selectedCandidateId, setSelectedCandidateId] = useState<string | null>(null)
const [showCreateForm, setShowCreateForm]           = useState(false)
const [editingCandidate, setEditingCandidate]       = useState<AnchorCandidateWithNode | null>(null)
const [leftWidthPct, setLeftWidthPct]               = useState(DEFAULT_LEFT_PCT)
const [isDragging, setIsDragging]                   = useState(false)
```

**Right panel content logic** (mirroring OrientView's pattern):
```
if showCreateForm || editingCandidate → <AnchorCreateForm />
else if selectedCandidate             → <AnchorDetailPanel />
else                                  → <AnchorHealthPanel />
```

**Handlers:**

`handleCardClick(id)`: sets `selectedCandidateId`, clears `showCreateForm` and `editingCandidate`.

`handleNewAnchor()`: clears `selectedCandidateId` and `editingCandidate`, sets `showCreateForm = true`.

`handleEditCandidate(candidate)`: clears `selectedCandidateId` and `showCreateForm`, sets `editingCandidate`.

`handleConfirm(candidateId, nodeId)`: calls `confirm(candidateId, nodeId)`. If the confirmed candidate was selected, clears selection. Shows a brief success toast: "✦ Anchor confirmed" — a temporary floating pill in bottom-left, `background: bg-card`, `border: 1px solid rgba(34,197,94,0.3)`, `color: #22c55e`, fades out after 2s.

`handleDismiss(candidateId, dismissCount)`: calls `dismiss(candidateId, dismissCount)`. If the dismissed candidate was selected, clears selection.

`handleCreateSaved()`: calls `createManual(nodeId)` from the form's save handler, closes form, sets selected to the new candidate.

**Escape key**: clears selection and form, same pattern as PipelineView.

**Page load animation**: staggered fade-up on cards, `animation: 'fadeUp 0.4s ease {index * 0.05}s both'`.

**Empty state** (no anchors AND no suggestions):

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│                    [Anchor icon 36px]                           │
│                                                                 │
│              Your knowledge graph has no anchors               │
│                                                                 │
│   The system will suggest anchors automatically after you       │
│   ingest content. Or create your first one manually.           │
│                                                                 │
│                   [Create Your First Anchor]                    │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

Centered in the left column content area. `Anchor` icon from Lucide at 36px, `color: text-placeholder`. Heading: Cabinet Grotesk 15px/700, `color: text-primary`. Body: DM Sans 13px, `color: text-secondary`, `maxWidth: 320px`, centered. CTA: accent-500 button.

**Error state**: Same pattern as PipelineView — short error message with a Retry button.

**Loading state**: Three skeleton card placeholders with pulse animation.

---

## 6. Nav Rail Modification

**File:** `src/components/layout/NavRail.tsx`

### 6.1 Add Anchors to NAV_ITEMS

Import `Anchor` from `lucide-react` (this icon is already in the Lucide library).

Add to the `NAV_ITEMS` array after `Pipeline`:

```typescript
{ id: 'anchors', label: 'Anchors', path: '/anchors', icon: Anchor },
```

### 6.2 Suggestion Count Badge

The `NavItemButton` component needs to accept an optional `badge` prop to show the suggestion count.

Add `badge?: number` to the `NavItemButton` props. When `badge > 0`, render a small count badge overlaid on the icon:

```
┌──────────┐
│  [icon]  │  ← collapsed state
│       ③  │  ← badge: absolute position, top-right of icon
└──────────┘
```

Badge styles: `position: absolute`, `top: 4`, `right: 4` (when collapsed), `top: 10`, `right: 8` (when expanded — next to label). `width: 16`, `height: 16`, `borderRadius: 8`, `background: '#d97706'` (amber), `color: white`, `fontSize: 9`, `fontWeight: 700`, `display: flex`, `alignItems: center`, `justifyContent: center`. Shows max "9+" if count > 9.

### 6.3 Badge Data Source

The `NavRail` component receives `anchorSuggestionCount` as a prop from `AppShell`. `AppShell` fetches this count using a lightweight call to `fetchSuggestedCount` (from `src/services/anchorCandidates.ts`) on mount and whenever navigation changes. Since this is a global count, it should live in `GraphContext` or a new lightweight context — the simplest approach is passing it from `AppShell` via prop drilling to `NavRail`.

**AppShell modification**: Add a `suggestedAnchorCount` state. On mount, call `fetchSuggestedCount(user.id)` (non-blocking, fire-and-forget style — if it fails, count stays 0). Pass the count to `NavRail` as `anchorSuggestionCount`. After any confirm/dismiss action in `useAnchorCandidates`, the hook calls its own internal `setSuggestedCount` — but since AppShell holds the global badge count, `useAnchorCandidates` should also expose a mechanism to update it. The cleanest approach: after successful confirm/dismiss in the hook, emit a custom browser event `synapse:anchor-suggestions-changed` that `AppShell` listens for and re-fetches the count.

```typescript
// In useAnchorCandidates, after successful confirm/dismiss:
window.dispatchEvent(new CustomEvent('synapse:anchor-suggestions-changed'))

// In AppShell:
useEffect(() => {
  const handler = () => {
    if (user) fetchSuggestedCount(user.id).then(setSuggestedAnchorCount)
  }
  window.addEventListener('synapse:anchor-suggestions-changed', handler)
  return () => window.removeEventListener('synapse:anchor-suggestions-changed', handler)
}, [user])
```

**`AppShell` file location**: `src/components/layout/AppShell.tsx` — add the state, effect, and prop pass.

---

## 7. Router Modification

**File:** `src/app/Router.tsx`

Add import and route:

```typescript
import { AnchorsView } from '../views/AnchorsView'

// Inside router children array:
{ path: '/anchors', element: <AnchorsView /> },
```

---

## 8. SettingsProvider Modification

**File:** `src/app/providers/SettingsProvider.tsx`

The `refreshAnchors` function already exists in the provider and is already exposed in `SettingsContextValue`. No structural changes needed.

Verify that `refreshAnchors` fetches `is_anchor = true` nodes and updates the `anchors` state — it does (confirmed in the existing code). The `useAnchorCandidates` hook already calls `refreshAnchors()` after confirm, archive, and create operations.

---

## 9. User Configuration — Settings Integration

The `AnchorUserConfig` (from PRD-17 `src/types/anchors.ts`) lives in `user_profiles.processing_preferences.anchor_settings`. The Anchors page exposes this configuration in a collapsible **Settings panel** accessible from the right panel default state (AnchorHealthPanel).

Add a "⚙ Suggestion Settings" expandable section at the bottom of `AnchorHealthPanel`. When expanded, shows:

**Suggestion Sensitivity** — labeled slider with three preset positions:

```
Conservative ────●──────── Aggressive
                Balanced
```

The slider maps to `THRESHOLD_PRESETS`: conservative = 0.72, balanced = 0.60, aggressive = 0.45. Displayed as a radio-style toggle group (`ToggleGroup` component) rather than a literal slider — three buttons: `Conservative`, `Balanced`, `Aggressive`. Active state uses the standard toggle group treatment.

**Signal Profile** — which scoring profile to use. Four options displayed as compact cards in a 2×2 grid:
- Balanced, Emerging Topics, Deep Concepts, Active Focus

Each card: label in Cabinet Grotesk 12px/700, description in DM Sans 10px `color: text-secondary`, 2 lines max. Active card: `background: accent-50`, `border: 1px solid rgba(214,58,0,0.3)`. Inactive: `background: bg-inset`, `border: border-subtle`.

**Auto-dismiss after**: Select dropdown — 7 days, 14 days (default), 30 days.

**Dormant after**: Select dropdown — 30 days, 60 days (default), 90 days, 180 days.

**Save Settings** button: saves to `user_profiles.processing_preferences.anchor_settings` via `updateProfile` from `useSettings()`. Shows a brief inline success confirmation: "✓ Saved" fading in and out.

---

## 10. Forward-Compatible Decisions

- **`AnchorCard` receives `onConfirm` and `onDismiss` as props** rather than calling the hook directly. This keeps the card purely presentational and allows it to be reused in PRD-20 (Explore graph view) where the same confirm/dismiss actions will be needed from within the canvas overlay.

- **`useAnchorCandidates` dispatches `synapse:anchor-suggestions-changed`** as a browser custom event. This pattern can be extended in PRD-20 to also trigger Explore's landscape re-render when a new anchor is confirmed from the graph.

- **`AnchorDetailPanel` accepts `candidateId` not the full candidate object** — it fetches what it needs internally via a `useMemo` over the hook's data. This makes it straightforward to open from anywhere in the app (e.g., from Explore's right panel) by just passing an ID.

- **The "View in Explore →" action** sets a URL param `/explore?node={nodeId}` — the Explore view's existing `useSearchParams` already handles `node` param for deep linking. No Explore changes needed for this to work.

- **The nav badge uses a browser custom event** rather than a global state manager, keeping the suggestion count decoupled from React's render cycle. This is the same pattern that would work if the badge needs to update from a ServiceWorker push notification in a future phase.

---

## 11. Edge Cases and Error Handling

- **`candidate.node` is null** (orphaned candidate — node was deleted): `AnchorCard` renders a tombstone state: grayed out, label "Deleted node", no stats, no inline actions, only a "Remove" button that calls `dismissAnchorCandidate` directly. `AnchorDetailPanel` shows a brief error card.

- **Confirm action fails**: Optimistic update rolls back. A brief error toast appears: "Failed to confirm anchor — please try again." Same bottom-left floating pill pattern as success toast, but `color: #ef4444`.

- **No candidates at all (new user, nothing scored yet)**: `useAnchorCandidates` returns empty arrays. Empty state renders. Stats strip shows "0 anchors · 0 suggested". AnchorHealthPanel shows its zero-state with the "No suggestions" note.

- **User config not yet set** (`processing_preferences.anchor_settings` is absent): `AnchorHealthPanel` settings section renders with all default values pre-selected. Saving writes the full default config object to Supabase for the first time.

- **Dismiss with `dismissCount >= 3`**: The card renders with a small additional note in the reasoning section: "You've dismissed this suggestion before — it re-appeared because activity increased." The dismiss button still works; no hard block.

- **Escape key while create form is open with unsaved changes**: If name field has been edited, show an inline confirmation row at the bottom of the form: "Discard changes?" with "Discard" and "Keep Editing" buttons — same pattern as any destructive action. If form is pristine, close immediately.

- **Large suggested count (50+)**: The list renders all cards but uses CSS `contentVisibility: auto` on the list container to enable browser-level virtual rendering without a full virtualisation library. This keeps the implementation simple while handling large lists gracefully.

- **Fetch failure**: `error` string is set in the hook. `AnchorsView` renders the error banner with a Retry button that calls `refetch()`. Same pattern as PipelineView's error state.

---

## 12. Acceptance Criteria

- [ ] `/anchors` route exists and renders `AnchorsView` without errors
- [ ] Anchors nav item appears in the nav rail with the `Anchor` icon, in the correct position (after Pipeline)
- [ ] Nav rail badge shows the correct suggestion count in amber when `suggestedCount > 0`, hidden when 0
- [ ] Badge updates immediately after a confirm or dismiss action without requiring a page reload
- [ ] Suggested candidates appear in the SUGGESTED section with dashed left border, ✦ badge, reasoning text, and inline Confirm/Dismiss buttons
- [ ] Confirmed anchors appear in YOUR ANCHORS section with solid left-edge color bar, stats row, and tags
- [ ] Filter pills correctly filter the list — "Suggested" shows only suggested, "Confirmed" shows only confirmed, etc.
- [ ] Clicking "Confirm" on a suggested card: card disappears from suggested section, appears in confirmed section, `is_anchor = true` is set on the knowledge_nodes row in Supabase, Explore and right panel Quick Access immediately reflect the new anchor
- [ ] Clicking "Dismiss" on a suggested card: card disappears, `status = 'dismissed'` and `resurface_after` is set in Supabase
- [ ] "Dismiss All" batch action dismisses all suggested candidates
- [ ] Right panel default state shows AnchorHealthPanel with correct stats from `fetchAnchorHealthSummary`
- [ ] Clicking a card opens AnchorDetailPanel with correct data: label, entity type, signal bars, connected nodes, source distribution, cross-anchor connections
- [ ] Signal bars in AnchorDetailPanel accurately reflect the four score values from the candidate row
- [ ] "Why suggested?" section shows the `reasoningText` from the candidate row
- [ ] "Create Your First Anchor" / "+ New Anchor" opens AnchorCreateForm in the right panel
- [ ] Node search in create form queries `searchNodesByLabel` and shows results
- [ ] Selecting a node and saving calls `createManualAnchor`, sets `is_anchor = true` on the node, creates a confirmed candidate row, and the new anchor appears in the list
- [ ] Drag-resize divider works: left column can be resized between 30% and 80%
- [ ] Suggestion settings in AnchorHealthPanel save correctly to `user_profiles.processing_preferences.anchor_settings` in Supabase
- [ ] Empty state renders correctly when no anchors and no suggestions exist
- [ ] Escape key clears selection when no form is open; shows discard confirmation when create form has unsaved changes
- [ ] Page compiles with zero TypeScript errors in strict mode
- [ ] Staggered fade-up animation plays on initial card render
