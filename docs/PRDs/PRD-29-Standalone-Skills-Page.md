# PRD-29 — Standalone Skills Page

**Phase:** Phase 6 — Skills Layer
**Dependencies:** PRD-26 (persistent skill pipeline), PRD-27 (skills UI — components reused here), PRD-28 (skill-aware extraction)
**Complexity:** Medium
**Type:** New view + nav rail addition. Replaces the Skills tab in Explore (PRD-27 tab is removed).

---

## Objective

Move the skill library out of the Explore tab system and into a dedicated full-page experience with a two-pane master-detail layout. The left pane is a filterable, sortable skill list. The right pane shows a rich library overview when nothing is selected, and full skill detail when a skill is clicked. The page sits as the sixth item in the nav rail, below Anchors.

---

## What Gets Built

### New Files

| File | Purpose |
|---|---|
| `src/views/SkillsView.tsx` | The full two-pane page view |
| `src/components/skills/SkillListRow.tsx` | Single row in the left pane list |
| `src/components/skills/SkillOverviewPanel.tsx` | Right pane default state — library overview |
| `src/components/skills/SkillDetailPane.tsx` | Right pane detail state — individual skill |
| `src/components/skills/SkillDomainChart.tsx` | Horizontal bar chart showing skill count by domain |
| `src/components/skills/SkillConfidenceTrajectory.tsx` | Confidence timeline — dots on a line per reinforcement event |

### Modified Files

| File | Change |
|---|---|
| `src/app/Router.tsx` | Add `/skills` route |
| `src/components/layout/NavRail.tsx` | Add Skills as sixth nav item below Anchors — use Lucide `Sparkles` icon |
| `src/views/ExploreView.tsx` | Remove the Skills tab added in PRD-27 — read the file first, remove only the Skills tab entry and its conditional render block |
| `src/components/layout/RightPanel.tsx` | Remove the `skill` case added in PRD-27 — the right panel is not used on the Skills page |

The `SkillCard`, `SkillExposureBadge`, `SkillConfidenceBar`, `CandidateSkillRow` components from PRD-27 remain in `src/components/skills/` — they are reused here. The `useSkills` hook from PRD-27 is also reused unchanged.

---

## Page Layout

The Skills page fills the full center stage (no right panel). It replaces the standard center stage + right panel split with its own internal two-pane layout.

```
┌──────┬──────────────────────────────────────────────────────────┐
│      │  Topbar: "Skills"  ·  110 skills · 32 anchors           │
│      ├────────────────────────┬─────────────────────────────────┤
│ Nav  │                        │                                 │
│ Rail │   LEFT PANE            │   RIGHT PANE                    │
│      │   340px fixed          │   flex: 1                       │
│      │   skill list           │   overview OR detail            │
│      │                        │                                 │
│      │                        │                                 │
└──────┴────────────────────────┴─────────────────────────────────┘
```

**Container:** `display: flex; height: 100%; overflow: hidden` — fills the center stage entirely, no padding at the page level. Each pane scrolls independently.

**Left pane:** `width: 340px; min-width: 340px; border-right: 1px solid var(--border-subtle); background: var(--bg-card); display: flex; flex-direction: column; overflow: hidden`

**Right pane:** `flex: 1; background: var(--bg-content); overflow-y: auto`

**Topbar metadata:** `{total confirmed} skills · {anchor count} anchors aligned`

---

## Left Pane

### Controls Bar

Fixed at the top of the left pane. Does not scroll with the list. `padding: 12px 16px`. `border-bottom: 1px solid var(--border-subtle)`. `background: var(--bg-card)`.

**Search input** — full width, `--bg-inset` background, `--border-subtle` border, 8px radius, 34px height. Lucide `Search` 13px icon left-inside in `--text-secondary`. Placeholder "Search skills...". DM Sans 12px. Filters list client-side on label.

**Controls row below search** — `display: flex; gap: 6px; margin-top: 8px; align-items: center`.

**Sort dropdown:**
- Trigger: DM Sans 11px weight-600 `--text-secondary`, "Sort: Confidence ▾" format. Lucide `ChevronDown` 11px.
- `--bg-inset` background, `--border-subtle` border, 6px radius, `4px 8px` padding.
- Options: Confidence (default) · Exposure Level · Domain · Most Reinforced · Recently Added · Alphabetical
- Dropdown panel: `--bg-card` background, `--border-strong` border, 10px radius, `0 4px 12px rgba(0,0,0,0.08)` shadow. Each option: DM Sans 12px, `10px 14px` padding, hover `--bg-hover`. Active option: `--accent-500` text.

**Domain filter dropdown:**
- Trigger: "Domain: All ▾" same style as sort
- Options: All · Technical · Consulting · Strategic · Interpersonal · Domain Expert
- Multi-select — selected options show a count badge on the trigger: "Domain: 2 ▾"

**Exposure filter dropdown:**
- Trigger: "Exposure: All ▾"
- Options: All · Novice · Developing · Proficient · Advanced
- Single-select

**Result count** — DM Sans 10px `--text-secondary`, right-aligned in the controls row: "{n} skills"

### Skill List

Scrollable. `flex: 1; overflow-y: auto; padding: 8px`.

**Confirmed skills** rendered first, ordered by the active sort option.

**Candidate section** — collapsible, same pattern as PRD-27. Default collapsed. Header row: Cabinet Grotesk 10px weight-700 uppercase `--text-secondary` + count badge + Lucide `ChevronDown`. `--border-subtle` top border, `8px` top margin.

**`SkillListRow.tsx`** — one row per skill.

```
┌────────────────────────────────────────┐
│ [domain badge]  [exposure badge]       │
│                                        │
│ Skill Label                            │
│ Cabinet Grotesk 13px weight-700        │
│                                        │
│ Description preview (2 lines)          │
│ DM Sans 11px --text-body               │
│                                        │
│ ○ 4 sources  ·  82%  ███░  ·  3d ago  │
└────────────────────────────────────────┘
```

- Container: `padding: 12px 12px; border-radius: 8px; cursor: pointer; transition: background 0.15s ease`
- Default: transparent background
- Hover: `var(--bg-hover)` background
- Selected: `var(--accent-50)` background, `3px solid var(--accent-500)` left border (via `border-left`, padding-left reduced by 3px to compensate), `border-radius: 0 8px 8px 0`

**Badge row:** `SkillDomainBadge` + `SkillExposureBadge` (reused from PRD-27), `gap: 4px`, `margin-bottom: 4px`

**Label:** Cabinet Grotesk 13px weight-700 `--text-primary`, `letter-spacing: -0.01em`, single line truncated with ellipsis

**Description:** DM Sans 11px `--text-body`, 2 lines max, `-webkit-line-clamp: 2`, `margin-top: 3px`

**Footer row:** `display: flex; align-items: center; gap: 6px; margin-top: 6px`
- Evidence: Lucide `BookOpen` 10px `--text-secondary` + "{n} sources" DM Sans 10px `--text-secondary`
- Separator `·` in `--text-secondary`
- Confidence: percentage value DM Sans 10px weight-600, colour-mapped (same as `SkillConfidenceBar`) + mini progress bar 32px × 3px inline
- Separator `·`
- Relative time: DM Sans 10px `--text-secondary` from `last_reinforced_at`

**Loading skeleton:** 6 skeleton rows — `--bg-inset` blocks at varying widths, `border-radius: 6px`, pulsing opacity animation `1.4s ease-in-out infinite`, `0.08s` stagger.

---

## Right Pane — Overview State

Rendered when no skill is selected. `padding: 36px 40px`. Max-width `860px`. Staggered fade-up animation on load (0.4s ease, 0.05s per item).

### Section 1 — Library Headline

Page heading: "Your Skill Library" — Cabinet Grotesk 22px weight-800 `--text-primary` letter-spacing `-0.03em`.

Sub-line: "Built automatically from {source count} ingested sources · Last updated {relative time}" — DM Sans 13px `--text-secondary`. `6px` below heading.

`28px` bottom margin.

### Section 2 — Stat Cards Row

Three cards in a horizontal row. `display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px`. `margin-bottom: 32px`.

Each card: white `--bg-card`, `--border-subtle` border, 12px radius, `16px 20px` padding.

| Card | Large number | Sub-label |
|---|---|---|
| Total Skills | confirmed count | Cabinet Grotesk 32px weight-800 `--text-primary` |
| Pending Review | candidate count | Cabinet Grotesk 32px weight-800 `--text-secondary` |
| Avg Confidence | e.g. "74%" | Cabinet Grotesk 32px weight-800, colour-mapped |

Sub-label: DM Sans 11px `--text-secondary`, `6px` below number.

### Section 3 — Two-Column Layout

`display: grid; grid-template-columns: 1fr 1fr; gap: 20px`. `margin-bottom: 32px`.

**Left column — Capability Distribution (`SkillDomainChart`)**

White card, `--border-subtle`, 12px radius, `20px` padding.

Section label: "CAPABILITY DISTRIBUTION"

`SkillDomainChart.tsx` — horizontal bar chart. One bar per domain. Each bar is a full-width row:

```
Technical       ████████████████░░░░  34  (43%)
Consulting      ████████░░░░░░░░░░░░  18  (23%)
Strategic       ██████░░░░░░░░░░░░░░  14  (18%)
Domain Expert   ████░░░░░░░░░░░░░░░░   9  (11%)
Interpersonal   ██░░░░░░░░░░░░░░░░░░   5   (6%)
```

- Label: DM Sans 11px weight-600 `--text-primary`, 80px fixed width left-aligned
- Bar track: `--bg-inset`, 6px height, 6px radius, `flex: 1`
- Bar fill: domain colour at 70% opacity (use entity-type colour pattern — technical = blue, consulting = green, strategic = purple, interpersonal = amber, domain_specific = orange). Width = `(count / maxCount) * 100%`. Smooth `width` transition `0.6s ease` on mount.
- Count: DM Sans 10px weight-600 `--text-secondary` right-aligned, 28px fixed width
- Percentage: DM Sans 10px `--text-secondary`, 36px fixed width
- `8px` vertical gap between rows

**Right column — Top Anchors by Skill Alignment**

White card, `--border-subtle`, 12px radius, `20px` padding.

Section label: "TOP ANCHORS"

Query: for each anchor in `related_anchor_ids` across all confirmed skills, count how many skills reference it. Top 8 anchors by skill count.

Each anchor row:
- Entity dot (6px, entity type colour) + anchor label (DM Sans 12px weight-600 `--text-primary`) + skill count badge right-aligned (`--bg-inset` background, DM Sans 10px weight-600, `3px 7px` padding, 10px radius)
- `10px` vertical padding, `--border-subtle` bottom border on all but last

Empty state if no anchor alignment: "Anchor alignment builds as more content is ingested" in `--text-secondary` 11px.

### Section 4 — Recent Activity

White card, `--border-subtle`, 12px radius, `20px` padding. Full width. `margin-bottom: 32px`.

Section label: "RECENTLY REINFORCED"

The 6 most recently reinforced confirmed skills as compact rows. Each row:

```
[domain badge]  Skill Label                    reinforced 2h ago
```

- Domain badge (reused from PRD-27)
- Label: DM Sans 13px weight-600 `--text-primary`
- Right: "reinforced {relative time}" DM Sans 11px `--text-secondary`
- `10px` vertical padding, `--border-subtle` bottom border
- Entire row is clickable — selects that skill and populates the detail pane

### Section 5 — Call to Action Prompt

Centred below recent activity. `margin-top: 8px`.

Lucide `MousePointerClick` icon 16px `--text-secondary`.

"Select a skill from the list to explore its full detail" — DM Sans 12px `--text-secondary`. `6px` gap below icon.

---

## Right Pane — Detail State

Rendered when a skill is selected. `padding: 36px 40px`. Max-width `860px`. Scrollable independently of the left pane. Staggered fade-up on selection (same animation as overview).

### Detail Header

**Back action:** Not needed — deselection happens by clicking the selected row again in the left pane (clicking an already-selected row deselects it, returns to overview). This is cleaner than a back button given the persistent list is always visible.

**Skill identity block:**

```
[domain badge]  [exposure badge]                   [⋯ actions]

Skill Label
Cabinet Grotesk 20px weight-800 --text-primary -0.02em tracking

DM Sans 13px --text-body description (full, not truncated)
```

Actions menu (Lucide `MoreHorizontal` 16px, tertiary button style): Edit label · Change exposure level · Dismiss skill. Same inline edit/confirm patterns as PRD-27.

`--border-subtle` divider `24px` below header block.

### Detail Body — Three-Column Grid

Below the header, the detail content uses a responsive grid: `display: grid; grid-template-columns: 1fr 1fr; gap: 20px` for the first row, then full-width sections below.

**Top row — two equal columns:**

**Left — Confidence**

White card, `--border-subtle`, 12px radius, `20px` padding.

Section label: "CONFIDENCE"

Large confidence value: Cabinet Grotesk 36px weight-800, colour-mapped. `margin-bottom: 4px`.

Sub-line: "Based on {evidence_count} source{s} · {exposure_level}" DM Sans 11px `--text-secondary`.

Full-width `SkillConfidenceBar` (full variant) below sub-line.

`--border-subtle` divider, then: "Last reinforced {relative time} · First detected {relative time}" DM Sans 11px `--text-secondary`.

**Right — Signal Breakdown**

White card, `--border-subtle`, 12px radius, `20px` padding.

Section label: "RELEVANCE SIGNALS"

Six signal rows — same as PRD-27 but with more space. Each row:
- Signal name: DM Sans 12px weight-600 `--text-primary`, 120px fixed width
- Bar: `flex: 1`, 5px height, 6px radius, `--bg-inset` track, colour fill mapped to score (green ≥ 0.6, amber 0.3–0.59, gray < 0.3)
- Score: DM Sans 11px weight-600 `--text-secondary`, 32px right-aligned

`8px` gap between signal rows.

Null state: "Signal data available after next re-score" in `--text-secondary` 11px.

**Full-width sections below the grid:**

---

**When to Apply**

White card, full width. Section label: "WHEN TO APPLY". Body text DM Sans 13px `--text-body` line-height 1.6. Null state: `--bg-inset` block with clock icon + "Generating on next weekly re-score".

**How to Apply**

White card, full width. Same treatment as When to Apply.

---

**Confidence Trajectory (`SkillConfidenceTrajectory.tsx`)**

White card, full width. Section label: "CONFIDENCE OVER TIME".

A simple SVG timeline showing confidence at each reinforcement event.

```
0.65  ●────────●──────────────●
      │        │              │
   Created  Reinforced    Upgraded
   Mar 20   Mar 22        Mar 25
```

- Horizontal line in `--bg-inset`, 2px height
- Each event is a dot (8px radius) filled with the confidence colour at that point in time
- Dots connected by the horizontal line
- Below each dot: event type label (DM Sans 9px weight-600 `--text-secondary` uppercase) + date (DM Sans 9px `--text-secondary`)
- Left Y-axis label: DM Sans 9px `--text-secondary` confidence values at start and end
- The line fills from left to right using `--accent-500` at 30% opacity for the segments between dots
- SVG viewBox scales to content width. Min 3 dots (created + at least 2 reinforcements) for meaningful display.
- If only 1 event (just created): show "Trajectory builds as more sources reinforce this skill" in `--text-secondary` 11px instead.

Data source: `skill_sources` join, ordered by `created_at` ASC, with `confidence_delta` accumulated to produce the confidence value at each point.

---

**Contributing Sources**

White card, full width. Section label: "CONTRIBUTING SOURCES {evidence_count}".

List of contributing sources. Each row:
- 28px source type icon container (emoji in `--bg-inset` circle, 28px, 7px radius)
- Title: DM Sans 13px weight-600 `--text-primary`
- Sub-line: contribution badge + date
- `--border-subtle` bottom border, `12px` vertical padding

Contribution badges (same as PRD-27): Created / Reinforced / Upgraded.

---

**Related Anchors + Related Skills — Side by Side**

`display: grid; grid-template-columns: 1fr 1fr; gap: 20px`.

**Related Anchors** — white card. Section label: "RELATED ANCHORS". Entity badges (`EntityBadge` component) in a flex-wrap layout with `6px` gap. Empty state: "No anchor alignment detected".

**Related Skills** — white card. Section label: "RELATED SKILLS".

Each related skill as a mini card — not a pill. Each mini card:
- `--bg-inset` background, `--border-subtle` border, 8px radius, `10px 12px` padding
- Domain badge (small) + skill label DM Sans 12px weight-600 `--text-primary`
- Confidence bar (compact, 32px) + percentage DM Sans 10px right-aligned
- Clickable — clicking selects that skill: updates the left pane selected row and populates this detail pane with the clicked skill's data. Smooth transition.
- `flex-wrap` layout, `6px` gap

Empty state: "Related skills identified on next re-score".

---

**Entity Cluster**

White card, full width. Section label: "CLUSTER ENTITIES".

The nodes from this skill's cluster displayed as a tag cloud. Each entity:
- Pill: `--bg-inset` background, `--border-subtle` border, pill radius (20px), DM Sans 11px weight-600 `--text-body`
- Size is uniform (not variable) for now — the tag cloud layout is achieved by `flex-wrap` with varying label lengths creating natural visual density variation
- Entity type dot (6px) prefix using entity type colour
- `flex-wrap`, `6px` gap

---

## State & Interaction

```typescript
// Local state in SkillsView
const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);
const [searchQuery, setSearchQuery] = useState('');
const [sortBy, setSortBy] = useState<SortOption>('confidence');
const [domainFilter, setDomainFilter] = useState<string[]>([]);
const [exposureFilter, setExposureFilter] = useState<string | null>(null);
const [candidatesExpanded, setCandidatesExpanded] = useState(false);

// From useSkills hook (unchanged from PRD-27)
const {
  confirmed, candidates, loading, selectedSkill, selectedSkillLoading,
  selectSkill, confirmSkill, dismissSkill, updateExposureLevel, updateLabel
} = useSkills();
```

**Selecting a skill:**
- Click on a `SkillListRow` → `setSelectedSkillId(id)` + `selectSkill(id)` (fetches full detail)
- Left pane row gets selected styling (accent-50 bg, accent left border)
- Right pane transitions from overview to detail with a `fadeUp` animation (opacity 0→1, translateY 8→0, 0.25s ease)

**Deselecting:**
- Click the already-selected row again → `setSelectedSkillId(null)` + `selectSkill(null)`
- Right pane transitions back to overview with the same fade animation

**Clicking a related skill in the detail pane:**
- Updates `selectedSkillId` and calls `selectSkill(newId)`
- Left pane scroll position updates to show the newly selected skill (use `scrollIntoView` on the selected row ref)
- Detail pane content replaces with new skill data — same fade animation

**Sort logic (client-side on `confirmed` array):**
```typescript
const SORT_FNS: Record<SortOption, (a: Skill, b: Skill) => number> = {
  confidence:     (a, b) => b.confidence - a.confidence,
  exposure:       (a, b) => LEVEL_ORDER[b.exposure_level] - LEVEL_ORDER[a.exposure_level],
  domain:         (a, b) => a.domain.localeCompare(b.domain),
  mostReinforced: (a, b) => new Date(b.last_reinforced_at).getTime() - new Date(a.last_reinforced_at).getTime(),
  recentlyAdded:  (a, b) => new Date(b.first_detected_at).getTime() - new Date(a.first_detected_at).getTime(),
  alphabetical:   (a, b) => a.label.localeCompare(b.label),
};
```

**Filter logic (client-side):**
```typescript
const filteredSkills = confirmed
  .filter(s => !searchQuery || s.label.toLowerCase().includes(searchQuery.toLowerCase()))
  .filter(s => domainFilter.length === 0 || domainFilter.includes(s.domain))
  .filter(s => !exposureFilter || s.exposure_level === exposureFilter)
  .sort(SORT_FNS[sortBy]);
```

All filtering and sorting are client-side — no re-fetch on filter change.

---

## Nav Rail Addition

In `src/components/layout/NavRail.tsx`, add Skills as the sixth nav item, positioned after Anchors (or after Automate if Anchors is not a separate nav item — read the current nav structure before implementing).

```typescript
{ path: '/skills', label: 'Skills', icon: Sparkles }  // Lucide Sparkles
```

Icon: Lucide `Sparkles` — matches the "skill" concept well and is visually distinct from all existing nav icons. Active: `--accent-500`. Inactive: `--text-secondary`.

Nav tooltip on hover (when rail is collapsed): "Skills" — same tooltip pattern as other nav items.

---

## Empty States

**No confirmed skills:**
Centred in right pane overview area.
- Lucide `Sparkles` 32px `--text-secondary`
- "Your skill library is empty" — Cabinet Grotesk 16px weight-700 `--text-primary`
- "Skills build automatically as you ingest content. Try adding a YouTube tutorial or meeting transcript." — DM Sans 13px `--text-secondary` max-width 300px centred
- "Go to Ingest" ghost button, accent colour, `24px` top margin

**No results after filtering:**
- Lucide `SearchX` 20px `--text-secondary`
- "No skills match your filters" — DM Sans 13px weight-600
- "Clear filters" ghost link

---

## Forward-Compatible Decisions

- **`SkillsView` uses the existing `useSkills` hook unchanged** — the data layer is already correct. All changes are presentational.
- **The `SkillConfidenceTrajectory` component** reads from `selectedSkill.contributing_sources` which already contains `confidence_delta` and `created_at` from PRD-26. No new data fetching needed.
- **Related skills as mini cards with direct navigation** establishes the pattern for skill-to-skill traversal — clicking through related skills should feel like following edges in the graph. This is the manual precursor to a future visual skill graph.
- **Left pane width (340px)** is a CSS variable at the top of `SkillsView.tsx`: `const LEFT_PANE_WIDTH = 340`. Future enhancement: a drag-resizable divider between panes, reading from this constant.
- **The `skill:` prefixed `user_tags` from PRD-28** are not surfaced in this view yet — but the cluster entity display lays the groundwork for showing "this entity appears in 3 skills" in a future Browse view enhancement.

---

## Edge Cases & Error Handling

| Scenario | Behaviour |
|---|---|
| `useSkills` loads but `confirmed` is empty | Overview right pane shows empty state. Left pane shows empty state. Candidate section expands automatically if candidates exist. |
| `selectedSkill` detail fetch fails | Detail pane shows error state: Lucide `AlertCircle` + "Could not load skill detail. Click to retry." Retry calls `selectSkill(selectedSkillId)` again. |
| `SkillConfidenceTrajectory` has only 1 data point | "Trajectory builds as more sources reinforce this skill" shown instead of the SVG. |
| Related skills mini card clicked while detail is loading | Ignore click if `selectedSkillLoading` is true. Apply `pointer-events: none` on related skills cards during loading. |
| Left pane filtered list becomes empty | "No skills match your filters" empty state in the list area. Right pane stays in whatever state it was — overview or the last selected detail. |
| Selected skill is dismissed (archived) via the actions menu | Skill removed from left list. Right pane returns to overview with fade animation. `setSelectedSkillId(null)`. |
| Selected skill's label is edited | Left pane row label updates immediately via optimistic update. Detail pane header label updates simultaneously. |
| Screen width below 1100px | Left pane collapses to 260px. Label truncation on rows increases. All other layout behaviour unchanged — this view is designed for desktop only. |
| `skill_sources` junction data missing (older skills before PRD-26) | `SkillConfidenceTrajectory` shows the "trajectory builds" placeholder. Contributing sources section shows "No source data available for this skill". |

---

## Acceptance Criteria

- `/skills` route renders the two-pane Skills page. A "Skills" nav item with the Sparkles icon appears in the nav rail below Anchors (or as the last primary nav item).
- The Skills tab is removed from the Explore view. The Explore view renders identically to its pre-PRD-27 state (Graph and Browse tabs only).
- The `skill` case is removed from `RightPanel.tsx` discriminated union.
- The left pane renders a scrollable list of confirmed skills with correct row content: domain badge, exposure badge, label, description preview, source count, confidence bar, relative time.
- The sort dropdown correctly reorders the list for all six sort options.
- The domain filter dropdown correctly filters the list. Multi-selecting two domains shows skills from either domain. Clearing returns to full list.
- The exposure filter dropdown correctly filters the list.
- Search input filters by skill label in real-time.
- Clicking a skill row selects it: the row gets accent-tinted selected styling, the right pane transitions to the detail state with fade animation.
- Clicking an already-selected row deselects it and returns the right pane to the overview state.
- The overview right pane renders all five sections: headline stats, stat cards row, two-column layout (domain chart + top anchors), recent activity, call-to-action prompt.
- The domain chart bars animate in on page load with a width transition.
- The detail pane renders all sections: header, confidence card, signal breakdown card, when to apply, how to apply, confidence trajectory, contributing sources, related anchors + related skills side by side, cluster entities.
- `SkillConfidenceTrajectory` renders an SVG timeline when 2+ reinforcement events exist, and a placeholder when only 1 event exists.
- Clicking a related skill mini card navigates to that skill: left pane selection updates, detail pane content updates, left pane scrolls to show the newly selected row.
- All four manual controls (edit label, change exposure, confirm, dismiss) work correctly from the detail pane actions menu.
- Dismissing a skill removes it from the left list and returns the right pane to the overview.
- All mutations use optimistic updates with revert-on-failure.
- Loading skeleton renders in the left pane while `useSkills` is fetching.
- TypeScript compiles with zero errors in strict mode across all new and modified files.
