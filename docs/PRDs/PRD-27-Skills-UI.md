# PRD-27 — Skills UI in Explore View

**Phase:** Phase 6 — Skills Layer
**Dependencies:** PRD-4 (Explore Browse tab), PRD-26 (Persistent Skill Pipeline)
**Complexity:** Medium
**Type:** Frontend only — no new API endpoints, no schema changes

---

## Objective

Make the skill library visible, reviewable, and manually controllable inside the Synapse application. After PRD-26, skills exist as real database records but are invisible to the user. This PRD adds a Skills tab to the existing Explore view — the natural home for all graph entities — where confirmed skills are presented as a browsable card library with a right panel for full detail, and candidate skills are surfaced in a collapsible section for manual review. All four manual controls (confirm, dismiss, edit exposure level, edit label) are available from the right panel.

---

## What Gets Built

### New Files

| File | Purpose |
|---|---|
| `src/components/skills/SkillCard.tsx` | Individual skill card rendered in the library list |
| `src/components/skills/SkillDetailPanel.tsx` | Right panel content for a selected skill |
| `src/components/skills/SkillExposureBadge.tsx` | Exposure level badge — reusable across card and panel |
| `src/components/skills/SkillConfidenceBar.tsx` | Confidence progress bar — reusable across card and panel |
| `src/components/skills/CandidateSkillRow.tsx` | Compact row for candidate skills in the collapsible section |
| `src/hooks/useSkills.ts` | Data hook — fetches confirmed and candidate skills, exposes mutation functions |

### Modified Files

| File | Change |
|---|---|
| `src/views/ExploreView.tsx` | Add "Skills" as the third tab alongside Graph and Browse |
| `src/components/layout/RightPanel.tsx` | Add `skill` case to the panel type discriminated union |

---

## `src/hooks/useSkills.ts`

All data fetching and mutations for the Skills tab live here. No component makes direct Supabase calls.

```typescript
interface Skill {
  id: string;
  label: string;
  domain: 'technical' | 'consulting' | 'strategic' | 'interpersonal' | 'domain_specific';
  description: string | null;
  exposure_level: 'novice' | 'developing' | 'proficient' | 'advanced';
  confidence: number;
  evidence_count: number;
  status: 'candidate' | 'confirmed' | 'dormant' | 'archived';
  when_to_apply: string | null;
  how_to_apply: string | null;
  related_anchor_ids: string[];
  related_skill_ids: string[];
  signal_breakdown: Record<string, number> | null;
  last_reinforced_at: string;
  first_detected_at: string;
}

interface SkillWithSources extends Skill {
  contributing_sources: Array<{
    id: string;
    title: string;
    source_type: string;
    created_at: string;
    contribution: 'created' | 'reinforced' | 'upgraded' | 'corrected';
  }>;
  related_anchors: Array<{
    id: string;
    label: string;
    entity_type: string;
  }>;
  related_skills: Array<{
    id: string;
    label: string;
    domain: string;
    confidence: number;
  }>;
}

interface UseSkillsReturn {
  confirmed: Skill[];
  candidates: Skill[];
  loading: boolean;
  error: string | null;
  selectedSkill: SkillWithSources | null;
  selectedSkillLoading: boolean;
  selectSkill: (id: string | null) => Promise<void>;
  confirmSkill: (id: string) => Promise<void>;
  dismissSkill: (id: string) => Promise<void>;
  updateExposureLevel: (id: string, level: Skill['exposure_level']) => Promise<void>;
  updateLabel: (id: string, label: string) => Promise<void>;
  refresh: () => Promise<void>;
}
```

**`confirmed` query:**
```sql
SELECT id, label, domain, description, exposure_level, confidence,
       evidence_count, status, when_to_apply, how_to_apply,
       related_anchor_ids, related_skill_ids, signal_breakdown,
       last_reinforced_at, first_detected_at
FROM knowledge_skills
WHERE user_id = $1
  AND status IN ('confirmed', 'dormant')
ORDER BY confidence DESC, evidence_count DESC
```

**`candidates` query:**
```sql
SELECT id, label, domain, exposure_level, confidence,
       evidence_count, status, last_reinforced_at, first_detected_at
FROM knowledge_skills
WHERE user_id = $1
  AND status = 'candidate'
ORDER BY confidence DESC
LIMIT 30
```

**`selectSkill` — fetches full detail for the right panel:**
```sql
-- Skill base
SELECT * FROM knowledge_skills
WHERE id = $1 AND user_id = $2

-- Contributing sources via skill_sources junction
SELECT ks.id, ks.title, ks.source_type, ks.created_at, ss.contribution
FROM skill_sources ss
JOIN knowledge_sources ks ON ks.id = ss.source_id
WHERE ss.skill_id = $1
ORDER BY ss.created_at ASC

-- Related anchors
SELECT id, label, entity_type
FROM knowledge_nodes
WHERE id = ANY($related_anchor_ids) AND user_id = $2

-- Related skills
SELECT id, label, domain, confidence
FROM knowledge_skills
WHERE id = ANY($related_skill_ids) AND user_id = $2
```

**Mutation functions — all use optimistic updates:**

`confirmSkill`: Updates `status = 'confirmed'`, `confidence = MAX(existing, 0.55)` in Supabase. Optimistically moves the skill from `candidates` to `confirmed` in local state.

`dismissSkill`: Updates `status = 'archived'` in Supabase. Optimistically removes from both lists. If API fails, re-inserts with error toast.

`updateExposureLevel`: Updates `exposure_level` in Supabase. Optimistically updates in local state.

`updateLabel`: Updates `label` in Supabase. Validates: non-empty, max 80 characters, no duplicate label check (enforced by DB unique constraint — catch the 409 and surface as "A skill with this name already exists").

---

## ExploreView.tsx — Tab Addition

Add "Skills" as the third tab in the existing tab bar. Read the current `ExploreView.tsx` before modifying — add to the existing tab array only. Do not restructure the tab bar.

```typescript
// Existing tabs (do not change these)
{ id: 'graph', label: 'Graph' }
{ id: 'browse', label: 'Browse' }

// New tab
{ id: 'skills', label: 'Skills' }
```

Tab bar styling — unchanged from existing pattern:
- `--bg-card` background, `--border-subtle` bottom border
- Active tab: `--text-primary` label, `--accent-500` 2px bottom underline indicator
- Inactive tab: `--text-secondary` label, transparent underline
- DM Sans 12px weight-600, `12px 20px` padding per tab

When the Skills tab is active, the right panel shows `SkillDetailPanel` if a skill is selected, or the default Quick Access panel if none is selected.

---

## Skills Tab Layout

```
┌─────────────────────────────────────────────────┐
│  Tab bar: Graph | Browse | Skills               │
├─────────────────────────────────────────────────┤
│  Stats row                                      │
│  Filter pills + Search                          │
├─────────────────────────────────────────────────┤
│  SkillCard × n  (confirmed, sorted by conf)     │
│  SkillCard × n                                  │
│  ...                                            │
│                                                 │
│  ▼ SKILL CANDIDATES  (collapsible, n pending)   │
│    CandidateSkillRow × n                        │
│    CandidateSkillRow × n                        │
└─────────────────────────────────────────────────┘
```

Content area: `32px 36px` padding, `840px` max-width centered, `--bg-content` background.

---

## Stats Row

Rendered immediately below the tab bar, above the filter row. Single horizontal line.

```
12 skills  ·  3 technical  ·  4 consulting  ·  2 strategic  ·  3 others  ·  Last updated: 2h ago
```

- DM Sans 12px `--text-secondary`
- Counts derived from the `confirmed` array in `useSkills`
- "Last updated" shows the most recent `last_reinforced_at` across all confirmed skills, formatted relatively (e.g. "2h ago", "3 days ago")
- No border, no card — plain inline text row, `16px` bottom margin

---

## Filter Row

Two elements: filter pills on the left, search input on the right.

**Filter pills (domain):**
- All · Technical · Consulting · Strategic · Interpersonal · Domain Expert
- Pill style: 20px radius, DM Sans 11px weight-600, 5px 13px padding
- Inactive: `--border-subtle` border, `--text-secondary` text, transparent background
- Active: `--accent-50` background, `rgba(214,58,0,0.15)` border, `--accent-500` text
- Only one active at a time (single-select domain filter)
- "All" is active by default

**Exposure level filter (secondary, right of domain pills):**
- Separator `·` in `--text-secondary`
- Pills: All Levels · Novice · Developing · Proficient · Advanced
- Same pill styling as domain filter

**Search input:**
- Right-aligned in the filter row, 200px width
- `--bg-inset` background, `--border-subtle` border, 8px radius, 36px height
- Lucide `Search` icon at 14px left-inside, `--text-secondary`
- Placeholder: "Search skills..." in `--text-placeholder`
- DM Sans 13px, `--text-body`
- Filters `confirmed` and `candidates` arrays client-side on `skill.label` (case-insensitive contains match)
- No API call on search — purely client-side filter on already-loaded data

Filter row margin bottom: `20px` before first card.

---

## `SkillCard.tsx`

One card per confirmed skill. Clickable — selects the skill and opens right panel.

### Layout

```
┌───────────────────────────────────────────────────────────────────┐
│  [domain badge]  [exposure badge]          [confidence bar  82%]  │
│                                                                    │
│  Skill Label — Cabinet Grotesk 14px weight-700                    │
│  when_to_apply text (2 lines max, truncated) — DM Sans 12px       │
│                                                                    │
│  [anchor badge] [anchor badge]     ○ 4 sources · 3 days ago       │
└───────────────────────────────────────────────────────────────────┘
```

**Card container:**
- White `--bg-card`, `--border-subtle` 1px border, 12px radius
- `16px 20px` padding
- `8px` gap between cards
- Hover: border darkens to `--border-default`, `translateY(-1px)`, `0 2px 8px rgba(0,0,0,0.04)` shadow, `0.18s ease`
- Selected: `--accent-50` background, `rgba(214,58,0,0.15)` border — same selected card pattern used in AutomateView

**Header row (top):**
- Left: `SkillDomainBadge` + `SkillExposureBadge` side by side, `6px` gap
- Right: `SkillConfidenceBar` — shows percentage value and a thin progress bar

**Title:**
- Skill `label` in Cabinet Grotesk 14px weight-700 `--text-primary`, letter-spacing `-0.01em`
- `6px` top margin from header row

**When to apply preview:**
- `when_to_apply` text in DM Sans 12px `--text-body`
- 2 lines max, `overflow: hidden`, `display: -webkit-box`, `-webkit-line-clamp: 2`
- If `when_to_apply` is null: show "Application guidance generating..." in `--text-secondary` italic
- `4px` top margin from title

**Footer row (bottom):**
- Left: up to 2 related anchor badges using existing `EntityBadge` component (entity dot + label). If more than 2 anchors: show 2 + "+N more" in `--text-secondary` 11px
- Right: bullet `·` + evidence count ("4 sources") + bullet `·` + relative time of `last_reinforced_at`
- DM Sans 11px `--text-secondary`
- `12px` top margin from preview text

---

## `SkillExposureBadge.tsx`

Reusable badge component used in both `SkillCard` and `SkillDetailPanel`.

```typescript
interface SkillExposureBadgeProps {
  level: 'novice' | 'developing' | 'proficient' | 'advanced';
  size?: 'sm' | 'md';  // sm = 10px, md = 11px. Default: sm
}
```

**Colour mapping:**

| Level | Background | Border | Text | Dot color |
|---|---|---|---|---|
| novice | `rgba(128,128,128,0.08)` | `rgba(128,128,128,0.16)` | `#808080` | `#808080` |
| developing | `rgba(59,130,246,0.08)` | `rgba(59,130,246,0.16)` | `#2563eb` | `#3b82f6` |
| proficient | `rgba(16,185,129,0.08)` | `rgba(16,185,129,0.16)` | `#059669` | `#10b981` |
| advanced | `rgba(214,58,0,0.08)` | `rgba(214,58,0,0.16)` | `#d63a00` | `#d63a00` |

Structure: 6px dot + label text, same pattern as existing `EntityBadge`. `4px 8px` padding, `20px` radius.

---

## `SkillConfidenceBar.tsx`

Reusable confidence display used in both card (compact) and panel (full-width).

```typescript
interface SkillConfidenceBarProps {
  confidence: number;   // 0–1
  variant: 'compact' | 'full';
}
```

**Compact (card header):**
- Percentage label: DM Sans 11px weight-600 `--text-secondary`, right-aligned
- Thin progress bar: 48px wide, 3px height, 4px below percentage label
- Track: `--bg-inset`
- Fill: colour mapped by confidence level:
  - < 0.40: `#808080` (gray — candidate territory)
  - 0.40–0.59: `#3b82f6` (blue — developing confidence)
  - 0.60–0.79: `#10b981` (green — solid confidence)
  - ≥ 0.80: `#d63a00` (accent — high confidence)

**Full (right panel):**
- Label row: "Confidence" section label (left) + percentage value in Cabinet Grotesk 18px weight-800 (right, same colour mapping as fill)
- Full-width progress bar: 100% width, 6px height, 6px radius
- Track: `--bg-inset`
- Fill: same colour mapping, smooth `width` transition `0.3s ease`

---

## Candidate Skills Section

Rendered below all confirmed skill cards. Collapsible. Default state: **collapsed**.

**Section header:**
```
▶  SKILL CANDIDATES   8 pending confirmation
```
- Lucide `ChevronRight` (collapsed) / `ChevronDown` (expanded) — 14px `--text-secondary`, rotates `0.18s ease`
- Section label style: Cabinet Grotesk 10px weight-700 uppercase `--text-secondary` letter-spacing `0.08em`
- Count badge: DM Sans 11px weight-600, `--bg-inset` background, `4px 8px` padding, `10px` radius, `--text-secondary` text
- Full row is clickable to toggle
- `24px` top margin from last confirmed card, `--border-subtle` top border

**`CandidateSkillRow.tsx` — compact row when section is expanded:**

```
[domain badge]  Skill Label                confidence bar (compact)   [Confirm]  [×]
                DM Sans 11px · n sources · first detected x ago
```

- No card border — list rows separated by `--border-subtle` bottom border only
- `12px 4px` padding (top/bottom only — no left indent)
- Domain badge (same as SkillCard) left-aligned
- Label: Cabinet Grotesk 13px weight-600 `--text-primary`
- Sub-line: DM Sans 11px `--text-secondary` — evidence count + first detected date
- Right side: `SkillConfidenceBar` (compact variant, 40px wide) + "Confirm" ghost button (accent text, 11px) + Lucide `X` dismiss button (12px `--text-secondary`)
- Confirm button shows a spinner while `confirmSkill` is in flight
- Dismiss × shows inline confirmation: text changes to "Dismiss?" with small "Yes" (red) / "No" links — same inline pattern as `ApiKeyRow` in PRD-24

Clicking anywhere on a candidate row (except the action buttons) selects it and opens `SkillDetailPanel` in the right panel — candidates get the same detail view as confirmed skills.

---

## `SkillDetailPanel.tsx`

Right panel content when a skill is selected. Replaces the default Quick Access panel.

Rendered inside the existing right panel (310px wide, white, `--border-subtle` left border). Follows existing right panel padding: `20px 22px`.

### Sections (top to bottom)

**1. Panel header**

```
[← back]                                    [⋯ actions]
Skill Label
[domain badge]  [exposure badge]
```

- Back link: Lucide `ArrowLeft` 14px + "Skills" label, DM Sans 12px ghost style — deselects skill and returns to Quick Access
- Actions menu (Lucide `MoreHorizontal` 16px): dropdown with "Edit label", "Change exposure level", "Dismiss skill"
- Label: Cabinet Grotesk 15px weight-700 `--text-primary`, `8px` top margin
- Badges row: `SkillDomainBadge` + `SkillExposureBadge` side by side, `8px` top margin
- `--border-subtle` divider, `16px` margin below

**2. Confidence**

Section label: "CONFIDENCE"

`SkillConfidenceBar` full variant — full-width bar with large percentage value.

Below bar: DM Sans 11px `--text-secondary` — "Based on {evidence_count} source{s}" + "Last reinforced {relative time}"

`16px` margin below.

**3. When to Apply**

Section label: "WHEN TO APPLY"

`when_to_apply` text in DM Sans 13px `--text-body` line-height 1.5.

If null: `--bg-inset` block with Lucide `Clock` 12px + "Generating application guidance on next weekly re-score" in DM Sans 11px `--text-secondary` italic. `8px` padding, `8px` radius.

`16px` margin below.

**4. How to Apply**

Section label: "HOW TO APPLY"

`how_to_apply` text in DM Sans 13px `--text-body` line-height 1.5.

Same null state as above.

`16px` margin below.

**5. Signal Breakdown**

Section label: "RELEVANCE SIGNALS"

Six signal rows. Each: signal name (DM Sans 12px weight-600 `--text-primary`) + score bar (full width minus label, 4px height, `--bg-inset` track, `--accent-500` fill at signal score opacity) + score value (DM Sans 11px `--text-secondary` right-aligned).

| Signal key | Display label |
|---|---|
| `anchorAlignment` | Anchor Alignment |
| `nodeDensity` | Node Density |
| `sourceHistory` | Source History |
| `graphProximity` | Graph Proximity |
| `profileContext` | Profile Match |
| `velocity` | Recent Activity |

If `signal_breakdown` is null (older skill before PRD-25b): show "Signal breakdown available after next re-score" in `--text-secondary` 11px.

`16px` margin below.

**6. Contributing Sources**

Section label: "SOURCES  {evidence_count}"

List of contributing sources as compact rows. Each row:
- Source type emoji (YouTube = 📺, Meeting = 💬, Document = 📄, Research = 🔬) in a 24px `--bg-inset` circle
- Source title in DM Sans 12px weight-600 `--text-primary`, single line truncated
- Sub-line: DM Sans 10px `--text-secondary` — contribution type badge (`created` / `reinforced` / `upgraded`) + date
- `8px` vertical padding per row, `--border-subtle` bottom border

Contribution type badge: 4px 7px padding, 4px radius, DM Sans 10px weight-600:
- `created`: `rgba(214,58,0,0.08)` bg, `--accent-500` text — "Created"
- `reinforced`: `rgba(59,130,246,0.08)` bg, `#2563eb` text — "Reinforced"
- `upgraded`: `rgba(16,185,129,0.08)` bg, `#059669` text — "Upgraded"

Loading state for this section (while `selectedSkillLoading`): 3 skeleton rows — `--bg-inset` blocks, 12px height, 8px radius, full width, `0.05s` stagger animation.

`16px` margin below.

**7. Related Anchors**

Section label: "ANCHORS"

Related anchor entity badges using existing `EntityBadge` component. `flex-wrap`, `6px` gap.

Empty state: "No anchor alignment detected" in `--text-secondary` 11px.

`16px` margin below.

**8. Related Skills**

Section label: "RELATED SKILLS"

Sibling skills as compact pills — label only, `--bg-inset` background, `--border-subtle` border, DM Sans 11px weight-600 `--text-body`, clickable to select that skill. `flex-wrap`, `6px` gap.

Empty state: "Related skills identified on next re-score" if `related_skill_ids` is empty.

---

## Manual Controls

All four controls are accessible from the right panel actions menu (Lucide `MoreHorizontal`). The dropdown appears on click, dismisses on outside click or Esc.

**Dropdown menu:**
- `--bg-card` background, `--border-strong` 1px border, 10px radius, `0 4px 16px rgba(0,0,0,0.08)` shadow
- 160px min-width, right-aligned to the trigger button
- DM Sans 13px, `14px 16px` padding per item, hover `--bg-hover`

**"Edit label"**
Opens an inline edit state in the panel header. The label text becomes an input:
- `--bg-inset` background, `--border-default` border, 8px radius, same Cabinet Grotesk 15px weight-700 font
- Save on Enter or blur, cancel on Escape
- Validation: non-empty, max 80 chars. Show character count when > 60 chars
- If Supabase returns 409 (duplicate): show inline error "A skill with this name already exists"
- Save calls `updateLabel(id, newLabel)`. Optimistic update reverts on failure.

**"Change exposure level"**
Opens a small inline selector immediately below the badges row in the panel header:
- Four options in a row: Novice · Developing · Proficient · Advanced
- Same toggle group pattern as anchor emphasis in Settings (white active item popping out of `--bg-inset` container)
- Currently active level pre-selected
- Selecting a new value calls `updateExposureLevel(id, level)` immediately, closes selector
- No separate save button — selection is the action

**"Dismiss skill"**
Shows a confirmation state replacing the panel header area:
```
Archive this skill?
This will hide it from your library. You can view archived skills in Settings.
[Archive]  [Cancel]
```
- "Archive" button: DM Sans 13px weight-600, `#ef4444` text, tertiary style with red border
- "Cancel" link: ghost style
- On confirm: calls `dismissSkill(id)`, optimistically removes from list, right panel returns to Quick Access

**"Confirm" (candidates only)**
Available as both a button on `CandidateSkillRow` and as a menu item in the panel when a candidate is selected. Calls `confirmSkill(id)`. Moves skill from candidates list to confirmed list with a brief fade-in animation.

---

## Empty States

**No confirmed skills (PRD-26 not yet run or new user):**

Centered empty state in the skills content area:
- Lucide `Sparkles` icon, 32px, `--text-secondary`
- "No skills detected yet" — Cabinet Grotesk 16px weight-700 `--text-primary`, `12px` top margin
- "Skills are built automatically as you ingest content. Try adding a YouTube tutorial or meeting transcript." — DM Sans 13px `--text-secondary`, centered, max-width 280px
- `24px` gap, then "Go to Ingest" — ghost button, accent colour

**No results after filtering/searching:**
- Lucide `SearchX` icon, 24px, `--text-secondary`
- "No skills match your filters" — DM Sans 13px weight-600 `--text-primary`
- "Clear filters" ghost link below

**No candidates (all confirmed or none):**
Candidate section header still renders but shows "No candidates pending" inline instead of the row list.

---

## Loading State

On initial tab load, while `useSkills` is fetching:

Skeleton screen — not a spinner. Render 4 skeleton cards:
- Same card dimensions as `SkillCard`
- `--bg-inset` blocks at 70% width (title placeholder) and 40% width (sub-line placeholder)
- A pulsing `opacity` animation: `0.5 → 1.0 → 0.5`, `1.4s` ease-in-out infinite, `0.1s` stagger between cards

---

## Interaction & State

```typescript
// Local state in ExploreView (existing tab state extended)
const [activeTab, setActiveTab] = useState<'graph' | 'browse' | 'skills'>('graph');

// Local state in skills tab section
const [domainFilter, setDomainFilter] = useState<string | null>(null);
const [exposureFilter, setExposureFilter] = useState<string | null>(null);
const [searchQuery, setSearchQuery] = useState('');
const [candidatesExpanded, setCandidatesExpanded] = useState(false);

// From useSkills hook
const {
  confirmed, candidates, loading, selectedSkill, selectedSkillLoading,
  selectSkill, confirmSkill, dismissSkill, updateExposureLevel, updateLabel
} = useSkills();
```

- Tab switching preserves filter state within the session (domainFilter, exposureFilter, searchQuery do not reset when switching away from Skills tab and back)
- Selecting a skill calls `selectSkill(id)` which fetches full detail and sets `selectedSkill`. The right panel opens if not already open.
- Deselecting (back arrow in panel) calls `selectSkill(null)`, right panel returns to Quick Access
- All filter operations are client-side on the already-loaded `confirmed` and `candidates` arrays — no re-fetch on filter change
- `useSkills` fetches once on mount and on `refresh()` call. It does not poll.
- Mutations (confirm, dismiss, updateLabel, updateExposureLevel) use optimistic updates with revert-on-failure

---

## Forward-Compatible Decisions

- **`SkillExposureBadge` and `SkillConfidenceBar`** are built as standalone reusable components in `src/components/skills/`. PRD-28 (skill-aware extraction) will display skill matches inline in the ingestion review UI using these same components.
- **`SkillDetailPanel` is self-contained** — it receives a `SkillWithSources` object and renders from that data only. It does not reach into `useSkills` directly. This makes it embeddable in any context (e.g., a future skill preview in the command palette).
- **The `skills` tab state** is a simple string added to the existing `activeTab` union. No new routing — still lives at `/explore`. PRD-28 may add a direct link to a specific skill via URL hash (`/explore?tab=skills&skill=id`).
- **`CandidateSkillRow` confirm/dismiss actions** call the same `confirmSkill` / `dismissSkill` functions from `useSkills` as the panel controls. One mutation function, two UI entry points.
- **`signal_breakdown` rendering** in the detail panel is future-proof — it reads keys from the stored JSONB object rather than hardcoding positions, so adding a new signal in PRD-26 updates automatically without a frontend change.

---

## Edge Cases & Error Handling

| Scenario | Behaviour |
|---|---|
| `when_to_apply` and `how_to_apply` both null (skill created before first re-score) | "Generating..." placeholder shown in both sections. No error state. |
| `signal_breakdown` null (older skill) | Signal section shows "Available after next re-score" message. |
| `related_anchor_ids` contains IDs for deleted anchors | The `related_anchors` query returns only existing nodes. Silently shows fewer anchors than the array suggests. |
| `updateLabel` called with same value as current label | No API call. No-op. |
| `confirmSkill` called on already-confirmed skill | API call updates `status = 'confirmed'` idempotently. No visible change. |
| `dismissSkill` API call fails | Optimistic removal reverted. Skill re-appears. Toast: "Could not archive skill. Please try again." |
| `selectSkill` called while another skill detail is loading | Cancel the in-flight fetch (AbortController), start new fetch for newly selected skill. |
| All skills filtered out by domain + exposure combination | "No skills match your filters" empty state with "Clear filters" link. |
| User has skills but none are `confirmed` (all `candidate` or `dormant`) | Main list shows empty state. Candidate section expands by default if candidates exist (override `candidatesExpanded` default to `true` in this case). |
| Skill label edit conflict (duplicate) | Supabase returns 409. Inline error below input: "A skill with this name already exists." Input stays open. Previous label not lost. |
| Right panel already showing a node or source from Browse | Selecting a skill overrides the panel with `SkillDetailPanel`. Back arrow restores Quick Access, not the previous Browse selection. |

---

## Acceptance Criteria

- The Explore view shows three tabs: Graph, Browse, Skills. The tab bar matches the existing Graph/Browse styling exactly.
- Navigating to the Skills tab shows a loading skeleton while data fetches, then renders confirmed skill cards sorted by confidence descending.
- Each skill card shows the domain badge, exposure badge, confidence bar with percentage, label, when_to_apply preview (or placeholder), anchor badges, evidence count, and last reinforced date.
- The domain and exposure level filter pills correctly filter the card list client-side without re-fetching.
- The search input filters by skill label in real-time.
- Clicking a skill card selects it and opens the right panel with full detail.
- The right panel shows all eight sections: header, confidence, when_to_apply, how_to_apply, signal breakdown, contributing sources, related anchors, related skills.
- The contributing sources section shows the correct `contribution` type badge (Created / Reinforced / Upgraded) for each source.
- The actions menu opens on click and shows all four control options.
- "Edit label" opens an inline input, saves on Enter, cancels on Escape, shows error on duplicate.
- "Change exposure level" opens the toggle group, selecting a value saves immediately and closes.
- "Dismiss skill" shows inline confirmation, archives on confirm, removes from list.
- The candidate section is collapsed by default and expands on header click with a chevron animation.
- Each candidate row shows the domain badge, label, evidence count, confidence bar, Confirm button, and dismiss × button.
- Confirming a candidate moves it to the confirmed list with a fade-in animation.
- Dismissing a candidate removes it from the list with inline confirmation.
- Empty states render correctly for: no skills, no search results, no candidates.
- All mutations optimistically update local state and revert on API failure with a toast message.
- TypeScript compiles with zero errors in strict mode across all new and modified files.
