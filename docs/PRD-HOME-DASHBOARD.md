# PRD-HOME-DASHBOARD — Synapse Home Dashboard

**PRD Number:** PRD-HOME-DASHBOARD (replaces PRD 6 — Home View)
**Phase:** Phase 2, Data Surfaces
**Dependencies:** PRD 1 (Scaffold + Auth), PRD 2 (App Shell + Nav), PRD 3 (Settings: Profile + Anchors)
**Soft dependency:** PRD 7 / PRD 8 (Ingest + RAG pipeline) — Quick Query degrades gracefully if absent
**Estimated Complexity:** High

---

## 1. Objective

Replace the current single-column activity feed on the Home view with a full-coverage control centre that gives the user situational awareness across the entire knowledge base the moment they open the app. The view must answer four questions without any navigation: How large and healthy is my knowledge base? What's been ingested recently? What signals (anchors and skills) have emerged? And what unexpected connections did the system discover? A one-shot query widget lets the user interrogate the graph inline without switching to the Ask view. The right panel surfaces a permanent knowledge snapshot — entity type distribution, top anchors by connection count, and pipeline health — replacing the current static "Quick Access" default with live data.

---

## 2. What Gets Built

### New Files — `src/components/home/`

- **`StatTile.tsx`** — Single metric tile: label, large value, 7-day delta indicator
- **`QuickQueryWidget.tsx`** — RAG query input + inline response card, "Open in Ask" link
- **`RecentSourcesPanel.tsx`** — Section card wrapping 5 `SourceFeedItem` rows
- **`SourceFeedItem.tsx`** — Compact source row: type badge, title, age, entity count
- **`SignalsPanel.tsx`** — Section card containing `AnchorSubsection` and `SkillSubsection` stacked
- **`SignalItem.tsx`** — Single anchor or skill row: entity dot, label, count/status badge
- **`CrossConnectionsPanel.tsx`** — Section card wrapping 3–5 `CrossConnectionItem` rows
- **`CrossConnectionItem.tsx`** — Single discovery card: node A → relation → node B, source attribution
- **`PipelineStatusStrip.tsx`** — Compact single-line status strip at bottom of center column
- **`KnowledgeSnapshotPanel.tsx`** — Right panel default: entity type bars, top anchors, source type counts, system health indicators

### Modified Files

- **`src/views/HomeView.tsx`** — Full replacement of current implementation
- **`src/services/supabase.ts`** — Add 7 new typed query functions (detailed in §5)
- **`src/hooks/useHomeDashboard.ts`** — New hook aggregating all dashboard data with loading/error state per section

### No New Tables or Schema Changes

All queries target existing tables: `knowledge_sources`, `knowledge_nodes`, `knowledge_edges`, `source_chunks`, `youtube_ingestion_queue`, `youtube_scan_history`. If a dedicated `skills` table exists, substitute accordingly per the note in §5.

---

## 3. Design Requirements

All components follow the design system in `docs/DESIGN-SYSTEM.md`. No inline styles. All classes use Tailwind 4 utility classes referencing tokens defined in `src/styles/tokens.css`.

### Page Layout

The center stage content area uses `padding: 28px 36px`, `max-width: 840px`, `margin: 0 auto`. Sections stack vertically with `gap-[18px]` between them. The page scrolls internally inside the center stage div — the nav rail, topbar, and right panel remain fixed.

### A. Greeting + Stats Row

Greeting heading: `font-['Cabinet_Grotesk'] text-[22px] font-[800] tracking-[-0.03em] text-text-primary leading-tight mb-1`

Subtitle: `text-[12px] text-text-secondary font-body mb-4`

Stats row: `grid grid-cols-4 gap-[10px] mb-[18px]`

**StatTile** — white card (`bg-bg-card border border-border-subtle rounded-[10px] p-[12px_14px]`):
- Section label: `text-[10px] uppercase tracking-[0.06em] font-[700] text-text-secondary font-display mb-[5px]`
- Value: `text-[22px] font-[800] tracking-[-0.03em] text-text-primary font-display leading-none mb-[3px]`
- Delta row: `text-[10px] font-[600] flex items-center gap-[2px]`. Positive delta: `text-[--e-project]`. Zero/negative: `text-text-secondary`
- Delta icon: Lucide `TrendingUp` at 9px, same color as text

Four tiles in order: Total Sources, Total Nodes, Active Anchors, Active Skills. Delta shows count change vs. 7 days ago (computed client-side from timestamped query).

### B. Quick Query Widget

Container: `bg-bg-card border border-border-subtle rounded-[12px] p-[13px_16px] mb-[16px]`

Section label: standard uppercase label pattern. Text: `QUICK QUERY`.

Input row: `flex gap-[8px] items-center`

Input field: `flex-1 bg-bg-inset border border-border-subtle rounded-[8px] px-[12px] py-[8px] text-[13px] font-body text-text-primary placeholder:text-text-placeholder outline-none focus:border-accent-300 focus:ring-1 focus:ring-accent-50 transition-all duration-150`

Send button (the **one primary button** on this view): `bg-accent-500 hover:bg-accent-600 active:bg-accent-700 text-white rounded-[8px] px-[14px] py-[8px] text-[12px] font-[600] font-body cursor-pointer transition-colors duration-150 whitespace-nowrap`

**Response card** (shown after successful query): appears below input row with 12px margin-top. Container: `bg-bg-content border border-border-subtle rounded-[10px] p-[12px_14px]`. Response text: `text-[13px] font-body text-text-body leading-relaxed`. Footer row: `flex items-center justify-between mt-[10px] pt-[8px] border-t border-border-subtle`. "Open in Ask" link: `text-[11px] font-[600] text-accent-500 hover:text-accent-600 cursor-pointer`. Citation badges shown as entity badge components.

**Loading state:** Three animated skeleton lines (`bg-bg-inset animate-pulse rounded h-[12px]`) at 100%, 80%, 60% width.

**Empty/disabled state** (RAG endpoint unavailable): Input renders as normal but send button shows `cursor-not-allowed opacity-60`. A `text-[11px] text-text-secondary` note below: "Ask is setting up — available after first ingestion."

### C. Two-Column Body

`grid grid-cols-[1fr_300px] gap-[14px] mb-[14px]`

**RecentSourcesPanel** — section card (`bg-bg-card border border-border-subtle rounded-[12px] overflow-hidden`):

Section header: `flex items-center justify-between px-[14px] py-[11px] border-b border-border-subtle`
- Label: standard uppercase label. "View all" ghost link: `text-[11px] font-[600] text-accent-500 cursor-pointer hover:text-accent-600`

**SourceFeedItem** (`flex items-start gap-[9px] px-[14px] py-[9px] border-b border-border-subtle last:border-b-0 cursor-pointer transition-colors duration-150 hover:bg-bg-hover`):
- Source type badge: `w-[26px] h-[26px] rounded-[6px] flex items-center justify-center text-[9px] font-[700] flex-shrink-0`. Colors per source type: Meeting = `bg-blue-50 border border-blue-100 text-blue-600`, YouTube = `bg-red-50 border border-red-100 text-red-500`, Document = `bg-amber-50 border border-amber-100 text-amber-600`, Note = `bg-green-50 border border-green-100 text-green-600`. Label is one uppercase letter (M, Y, D, N, R).
- Title: `text-[12px] font-[700] tracking-[-0.01em] text-text-primary truncate mb-[2px]`
- Meta row: `text-[10px] text-text-secondary flex items-center gap-[5px]`. Entity count badge: `bg-black/5 rounded px-[5px] py-[1px] font-[600]`

Show 5 items. Clicking opens `SourceDetail` in right panel via `setRightPanelContent({ type: 'source', data: source })`. "View all" routes to `/ingest` with history tab active.

**SignalsPanel** — stacked container of two section cards with `flex flex-col gap-[12px]`:

Each sub-card (`bg-bg-card border border-border-subtle rounded-[12px] overflow-hidden`) contains a section header and list of `SignalItem` rows.

**SignalItem** (`flex items-center gap-[7px] px-[14px] py-[8px] border-b border-border-subtle last:border-b-0 cursor-pointer hover:bg-bg-hover transition-colors duration-150`):
- Entity dot: `w-[7px] h-[7px] rounded-full flex-shrink-0` — color from `entityTypeColors` config
- Label: `text-[12px] font-[600] tracking-[-0.01em] text-text-primary flex-1`
- For anchors: connection count `text-[10px] text-text-secondary mr-[4px]`
- Status badge — three variants:
  - Active: `text-[9px] font-[700] px-[6px] py-[2px] rounded bg-[--e-project]/8 text-[--e-project] border border-[--e-project]/16 uppercase tracking-[0.03em]`
  - Suggested: same pattern but `bg-accent-50 text-accent-500 border-accent-100`
  - Dormant: `bg-black/4 text-text-secondary border-border-subtle`

Anchor sub-section shows 4 items ordered by `created_at DESC`. Skill sub-section shows 3 items ordered by `created_at DESC`. Both have "View all" ghost links routing to `/signals` (the Signals/Anchors+Skills unified page, or current equivalent).

### D. Cross-Connections Panel

Full-width section card, same card pattern. Section label: `CROSS-CONNECTION DISCOVERIES`.

**CrossConnectionItem** (`flex flex-col px-[14px] py-[10px] border-b border-border-subtle last:border-b-0 cursor-pointer hover:bg-bg-hover transition-colors duration-150`):
- Top row: `flex items-center gap-[6px] flex-wrap mb-[3px]`
  - Node A label: `text-[12px] font-[600] tracking-[-0.01em] text-text-primary`
  - Relation pill: `text-[10px] font-[600] text-accent-500 bg-accent-50 px-[6px] py-[1px] rounded`
  - Node B label: same as Node A
- Source attribution: `text-[10px] text-text-secondary`

Show 3–5 items ordered by edge `created_at DESC` where `source_node.source_id ≠ target_node.source_id`. Clicking an item calls `setRightPanelContent({ type: 'crossConnection', data: edge })` — see §6 for right panel cross-connection detail state.

### E. Pipeline Status Strip

`bg-bg-card border border-border-subtle rounded-[10px] px-[14px] py-[9px] flex items-center gap-[12px] text-[11px] text-text-secondary flex-wrap`

Contains three segments separated by vertical dividers (`w-[1px] h-[14px] bg-border-subtle`):
1. Green status dot + "YouTube — scanned Xh ago · N videos queued"
2. "Queue — N pending · N failed" (failed count in red if > 0)
3. "Last processed — [Source title], [time ago]"

If YouTube tables are empty (automation not set up), show: "Automation not configured — set up in Automate"

### F. Right Panel — KnowledgeSnapshotPanel

Shown when `rightPanelContent === null` (default state). Replaces current "Quick Access" placeholder.

Padding: `p-[18px]`. Sections separated by `border-t border-border-subtle pt-[12px] mt-[14px]`.

**Entity Types section:** `text-[10px] uppercase tracking-[0.06em] font-[700] text-text-secondary font-display mb-[8px]` label. Each type row: `flex items-center gap-[7px] py-[4px]`. Entity dot (7px), type name (`text-[12px] text-text-body flex-1`), mini bar (`flex-1 h-[3px] bg-black/6 rounded overflow-hidden` with colored fill proportional to max), count (`text-[11px] font-[600] text-text-secondary min-w-[28px] text-right`). Show top 5 entity types by count.

**Top Anchors section:** List of 4 anchor rows. Each: entity dot, label (`text-[12px] font-[600] text-text-primary flex-1`), connection count (`text-[10px] text-text-secondary`). Clicking opens node detail in right panel.

**Sources by Type section:** Three rows for Meeting, YouTube, Document (or whatever source types exist). Type badge (20px square, same letter-in-colored-box pattern as SourceFeedItem), label, count.

**System Health section:** Three status indicators with green/amber dots:
- YouTube automation: green "running" / amber "idle" / gray "not configured"
- Meeting integration: green "connected" / gray "not connected"  
- Queue: green "0 pending" / amber "N pending" / red "N failed"

### Animation

Page load: staggered `animate-[fadeUp_0.4s_ease]` on each section, using CSS `animation-delay` increments of 0.05s per item (greeting → stats → query → columns → intel → pipeline). The `fadeUp` keyframe is defined in `tokens.css`:

```css
@keyframes fadeUp {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: translateY(0); }
}
```

All hover transitions: `transition-all duration-150 ease-[ease]` or `transition-colors duration-150`.

---

## 4. Data & Service Layer

### New Service Functions in `src/services/supabase.ts`

All functions are async, typed, use the singleton `supabase` client, check for errors, and return typed results or throw.

```typescript
// ─── HOME DASHBOARD QUERIES ─────────────────────────────────────────────

export interface HomeDashboardStats {
  totalSources: number;
  totalNodes: number;
  activeAnchors: number;
  activeSkills: number;
  sourcesDelta7d: number;
  nodesDelta7d: number;
  anchorsDelta7d: number;
  skillsDelta7d: number;
}

export async function fetchHomeDashboardStats(): Promise<HomeDashboardStats>
// Queries:
// COUNT(*) from knowledge_sources → totalSources
// COUNT(*) from knowledge_nodes → totalNodes
// COUNT(*) from knowledge_nodes WHERE is_anchor = true → activeAnchors
// COUNT(*) from knowledge_nodes WHERE entity_type = 'Skill' → activeSkills
//   (substitute dedicated skills table name if confirmed to differ)
// For deltas: count rows WHERE created_at > NOW() - INTERVAL '7 days'
// Run all 8 counts in parallel via Promise.all

export async function fetchRecentSources(limit = 5): Promise<KnowledgeSource[]>
// SELECT id, title, source_type, source_url, metadata, created_at
// FROM knowledge_sources
// ORDER BY created_at DESC
// LIMIT limit

// Requires a second query to get entity count per source:
export async function fetchSourceEntityCounts(
  sourceIds: string[]
): Promise<Record<string, number>>
// SELECT source_id, COUNT(*) as count
// FROM knowledge_nodes
// WHERE source_id = ANY(sourceIds)
// GROUP BY source_id

export async function fetchRecentAnchors(limit = 4): Promise<KnowledgeNode[]>
// SELECT id, label, entity_type, created_at
// FROM knowledge_nodes
// WHERE is_anchor = true
// ORDER BY created_at DESC
// LIMIT limit

// Connection count per anchor requires a separate edges query:
export async function fetchAnchorConnectionCounts(
  anchorIds: string[]
): Promise<Record<string, number>>
// SELECT source_node_id as node_id, COUNT(*) as count
// FROM knowledge_edges
// WHERE source_node_id = ANY(anchorIds)
//   OR target_node_id = ANY(anchorIds)
// GROUP BY node_id
// Note: use client-side aggregation to combine source + target counts per node

export async function fetchRecentSkills(limit = 3): Promise<KnowledgeNode[]>
// SELECT id, label, entity_type, description, created_at
// FROM knowledge_nodes
// WHERE entity_type = 'Skill'
// ORDER BY created_at DESC
// LIMIT limit
// IMPORTANT: If a dedicated skills table exists with when_to_apply / how_to_apply columns,
// substitute accordingly. The implementer must verify the correct table name.

export interface CrossConnectionEdge {
  id: string;
  sourceNode: { id: string; label: string; entity_type: string; source_id: string };
  targetNode: { id: string; label: string; entity_type: string; source_id: string };
  relation_type: string;
  sourceTitles: string[]; // titles of the two distinct sources
  created_at: string;
}

export async function fetchCrossConnectionEdges(
  limit = 5
): Promise<CrossConnectionEdge[]>
// This requires a two-step query due to Supabase PostgREST limitations:
// Step 1: Fetch recent edges with JOIN to both node records
//   SELECT ke.id, ke.relation_type, ke.created_at,
//          sn.id, sn.label, sn.entity_type, sn.source_id,
//          tn.id, tn.label, tn.entity_type, tn.source_id
//   FROM knowledge_edges ke
//   JOIN knowledge_nodes sn ON ke.source_node_id = sn.id
//   JOIN knowledge_nodes tn ON ke.target_node_id = tn.id
//   WHERE sn.source_id IS NOT NULL
//     AND tn.source_id IS NOT NULL
//     AND sn.source_id != tn.source_id
//   ORDER BY ke.created_at DESC
//   LIMIT limit * 3   ← oversample because some may filter out
// Step 2: Deduplicate and limit to `limit` results client-side
// Step 3: Fetch source titles for the discovered source_ids
//   SELECT id, title FROM knowledge_sources WHERE id = ANY(distinctSourceIds)
// CRITICAL: Supabase silently returns empty arrays for invalid column references.
// Verify the JOIN column names match actual schema before deploying.

export interface PipelineStatus {
  lastScanAt: string | null;
  lastScanVideosFound: number;
  pendingQueueCount: number;
  failedQueueCount: number;
  lastProcessedSource: { title: string; created_at: string } | null;
}

export async function fetchPipelineStatus(): Promise<PipelineStatus>
// Query 1: SELECT created_at, metadata FROM youtube_scan_history
//   ORDER BY created_at DESC LIMIT 1
// Query 2: SELECT COUNT(*) FROM youtube_ingestion_queue WHERE status = 'pending'
// Query 3: SELECT COUNT(*) FROM youtube_ingestion_queue WHERE status = 'failed'
// Query 4: SELECT title, created_at FROM knowledge_sources
//   ORDER BY created_at DESC LIMIT 1
// Run in parallel via Promise.all. If youtube tables return error/empty, set null.

export interface KnowledgeSnapshot {
  entityTypeCounts: Array<{ entity_type: string; count: number }>;
  topAnchors: Array<{ id: string; label: string; entity_type: string; connectionCount: number }>;
  sourceTypeCounts: Array<{ source_type: string; count: number }>;
}

export async function fetchKnowledgeSnapshot(): Promise<KnowledgeSnapshot>
// Query 1: SELECT entity_type, COUNT(*) as count FROM knowledge_nodes
//   GROUP BY entity_type ORDER BY count DESC LIMIT 5
// Query 2: SELECT id, label, entity_type FROM knowledge_nodes
//   WHERE is_anchor = true LIMIT 8
//   (then fetch edge counts separately and sort/limit to 4)
// Query 3: SELECT source_type, COUNT(*) as count FROM knowledge_sources
//   GROUP BY source_type ORDER BY count DESC
```

### New Hook: `src/hooks/useHomeDashboard.ts`

```typescript
export interface HomeDashboardData {
  stats: HomeDashboardStats | null;
  recentSources: KnowledgeSource[];
  sourceEntityCounts: Record<string, number>;
  recentAnchors: KnowledgeNode[];
  anchorConnectionCounts: Record<string, number>;
  recentSkills: KnowledgeNode[];
  crossConnections: CrossConnectionEdge[];
  pipelineStatus: PipelineStatus | null;
  snapshot: KnowledgeSnapshot | null;
  loading: {
    stats: boolean;
    sources: boolean;
    signals: boolean;
    crossConnections: boolean;
    pipeline: boolean;
    snapshot: boolean;
  };
  errors: Partial<Record<keyof HomeDashboardData['loading'], string>>;
}

export function useHomeDashboard(): HomeDashboardData
```

Load strategy: fire all queries in parallel on mount. Each section has its own loading boolean so sections render independently as data arrives — sources panel doesn't wait for pipeline status. No global spinner. Use individual skeleton states per section.

The hook should NOT refetch on every render. Fetch once on mount. Expose a `refresh()` function for manual reload.

### Quick Query Integration

`QuickQueryWidget.tsx` manages its own local state for `query`, `response`, `isLoading`, `error`. On submit, it calls the existing RAG endpoint at `api/ask` (or the equivalent endpoint used by `AskView`). Do not duplicate the RAG logic — import the `askKnowledgeBase` service function from `services/gemini.ts` if it exists, or call the Vercel serverless endpoint directly via `fetch('/api/ask', { method: 'POST', body: JSON.stringify({ query }) })`.

If the endpoint returns a 404 or the fetch fails with a network error, show the "Ask is setting up" disabled state. Do not throw — degrade silently.

The response object should carry `answer: string` and `citations: Array<{ label: string; entity_type: string }>`. Render citations as `EntityBadge` components from `src/components/shared/EntityBadge.tsx`.

"Open in Ask" link sets the query as a URL param or session state that `AskView` reads on mount. Use `navigate('/ask', { state: { initialQuery: query, initialResponse: response } })` via react-router-dom `useNavigate`.

---

## 5. Interaction & State

### HomeView State

`HomeView.tsx` uses `useHomeDashboard()` for all data. Local state:
- `rightPanelContent` is managed by `GraphContext` (already established in PRD 2). `HomeView` calls `setRightPanelContent()` from context when items are clicked — it does not manage right panel state itself.
- No tab state — the Feed/Briefings toggle is removed. The Home view is now a single-scroll dashboard.

### Click Behaviours

- **SourceFeedItem clicked** → `setRightPanelContent({ type: 'source', data: source })`
- **SignalItem (anchor) clicked** → `setRightPanelContent({ type: 'node', data: anchorNode })`
- **SignalItem (skill) clicked** → `setRightPanelContent({ type: 'node', data: skillNode })`
- **CrossConnectionItem clicked** → `setRightPanelContent({ type: 'crossConnection', data: edge })`. This is a new right panel content type — add it to the `RightPanelContent` discriminated union in `src/types/index.ts`:
  ```typescript
  | { type: 'crossConnection'; data: CrossConnectionEdge }
  ```
  When `RightPanel.tsx` receives this type, it renders a two-entity comparison: Node A detail (entity dot, label, type, description) + relation chip + Node B detail, followed by source attribution rows.
- **"View all" on Recent Sources** → `navigate('/ingest')`
- **"View all" on Anchors/Skills** → `navigate('/signals')` (or current route for the Signals/Anchors view)
- **"View all" on Cross-Connections** → future — for now, navigate to `/explore`

### Query Widget Keyboard

`Enter` keypress inside the input field submits the query (same as clicking the Send button). `Escape` clears the response card. The input focus ring uses `focus:ring-accent-50` per design system.

### Right Panel Default State

When `rightPanelContent === null` AND the current view is `'home'`, `RightPanel.tsx` renders `KnowledgeSnapshotPanel`. This replaces the "Quick Access" default. The `KnowledgeSnapshotPanel` receives `snapshot` data and `pipelineStatus` as props passed from `HomeView` (which gets them from `useHomeDashboard`).

This requires a small change to `RightPanel.tsx`: add a `homeDashboardProps?: { snapshot: KnowledgeSnapshot | null; pipeline: PipelineStatus | null }` prop. When view is 'home' and `content` is null, render `KnowledgeSnapshotPanel`. On all other views, keep the existing "Quick Access" default behaviour.

### State That Persists vs. Resets

- Dashboard data: refetched every time `HomeView` mounts (route change). No caching between sessions.
- Query widget: clears on route away and back (local state).
- Right panel: `GraphContext` manages this — persists until explicitly closed or overwritten.

---

## 6. Forward-Compatible Decisions

- **`crossConnection` right panel type** (references PRD 5, PRD 8): Adding this type to the `RightPanelContent` union now enables future PRDs to use the same two-entity comparison view anywhere in the app (Explore graph, Ask citations, etc.).
- **`useHomeDashboard` hook separation** (references PRD 13 — Digests): The hook is scoped to the Home view only. When the Digests feature is added in PRD 13, it can add its own data queries without coupling to this hook.
- **`KnowledgeSnapshotPanel` as standalone component** (references PRD 10 — Automate): The pipeline health section of the right panel can be promoted or linked from the Automate view without modification.
- **Quick Query `initialQuery` state handoff** (references PRD 8 — Ask view): The `navigate('/ask', { state: { initialQuery } })` pattern requires that `AskView` reads `location.state?.initialQuery` on mount and pre-populates its own input. Flag this as a dependency on PRD 8's AskView implementation.
- **Skills query flexibility** (references future skills pipeline PRD): The `fetchRecentSkills` function is written to accept an optional `tableName` parameter internally. When the dedicated skills table is confirmed, swap the table reference without touching the component layer.
- **Delta calculation as client-side** (references future analytics PRD): The 7-day delta is currently computed by running two COUNT queries (total vs. last-7-days). When a dedicated analytics layer is added, replace this with a single function call without changing the `HomeDashboardStats` interface shape.

---

## 7. Edge Cases & Error Handling

### Empty Database (New User, No Data)

- **Stats row**: All four tiles show `0` with no delta badge.
- **Recent Sources panel**: Empty state card — center-aligned icon (Lucide `Inbox`, 24px, `text-text-secondary`) + heading "No sources yet" + body "Ingest your first document, meeting, or video to get started." + ghost button "Go to Ingest" routing to `/ingest`.
- **Signals panel (Anchors)**: Empty state — "No anchors yet. Anchors are promoted from your most important entities after ingestion."
- **Signals panel (Skills)**: Empty state — "Skills emerge after multiple ingestions. Check back after processing a few more sources."
- **Cross-connections**: Empty state — "No cross-connections discovered yet. They appear when entities from different sources share relationships."
- **Pipeline strip**: "Automation not configured — set up in Automate."
- **Right panel snapshot**: Entity type bars all at zero. Top anchors list shows empty state. Source type counts show zero.

### Network Failures / Supabase Errors

Each section catches its own error independently. A failed section renders a compact error state: `text-[11px] text-text-secondary italic px-4 py-3` — "Couldn't load [section name]. Check your connection." The other sections are unaffected.

Never surface raw Supabase error messages to the user. Log to `console.error` and show the generic string above.

### Supabase Silent Failures (Critical)

PostgREST returns `[]` (not an error) for invalid column names, wrong table names, or missing indexes. Always validate:
1. The cross-connection query JOINs `source_id` — verify `knowledge_nodes.source_id` is non-null for the user's data before assuming the JOIN returns results.
2. The `entity_type = 'Skill'` filter — if this returns zero rows, confirm whether skills use a different entity_type string or a different table.
3. `youtube_scan_history` and `youtube_ingestion_queue` — if these tables don't exist for the user, the pipeline status query will return an error. Wrap in try/catch and fall through to the "not configured" empty state.

### Auth Expiry

If the Supabase session expires mid-session, queries will fail with auth errors. The existing `AuthProvider` handles session refresh. If refresh fails and the user is logged out, `react-router-dom` redirects to `/login` — `HomeView` does not need to handle this case independently.

### Large Datasets (847+ Nodes, 100+ Sources)

All queries use `LIMIT` clauses. The stats COUNTs are lightweight index scans. The cross-connection query limits to `LIMIT limit * 3` (15 rows max) on the Supabase side before client-side deduplication. No full table scans. The right panel entity type distribution groups at the database level.

### Quick Query — RAG Unavailable

If `api/ask` returns a non-200 response, `QuickQueryWidget` shows a subtle error inside the response card: `text-[12px] text-text-secondary italic` — "Couldn't reach the knowledge base. Try again or open Ask for the full interface." The send button becomes re-enabled immediately (no retry delay).

### Skills Table Ambiguity

If `knowledge_nodes WHERE entity_type = 'Skill'` returns zero rows but the user has skills in a different table, the skills panel shows the empty state rather than an error. The implementer must verify the skills table name before shipping. Leave a `// TODO: verify skills table` comment in `fetchRecentSkills`.

---

## 8. Acceptance Criteria

After this PRD is implemented, a user can:

- Open the Home view and see their total source count, node count, anchor count, and skill count within 2 seconds, each with a 7-day growth delta.
- See their 5 most recently ingested sources as compact cards with type indicator, title, relative timestamp, and entity count — and click any card to open its detail in the right panel.
- See their 4 most recently created/promoted anchors and 3 most recently created skills in a stacked signals panel, each with entity type color, label, connection count or status badge.
- See 3–5 cross-source connection discoveries — pairs of entities from different sources that Synapse linked — with the relationship type and source attribution.
- Read pipeline status (last YouTube scan time, queue depth, last processed source) in a compact strip without navigating away.
- Type a question into the Quick Query widget, press Enter, and receive an inline answer from the RAG pipeline with source citations. Click "Open in Ask" to continue the conversation.
- See the Knowledge Snapshot in the right panel at all times when no node or source is selected: entity type distribution with proportional bars, top 4 anchors by connection count, source type breakdown, and system health indicators.
- Experience all sections loading independently — if one section's query fails, the others still render.
- See appropriate empty states in every section when the database has no data (new user).
- Click a cross-connection discovery and see a two-entity comparison in the right panel showing both nodes' descriptions and the relationship evidence.

---

## 9. File Summary

```
MODIFIED:
  src/views/HomeView.tsx                         ← full replacement
  src/services/supabase.ts                       ← +7 query functions
  src/types/index.ts                             ← +crossConnection RightPanelContent type
  src/components/layout/RightPanel.tsx           ← +home snapshot + crossConnection rendering

CREATED:
  src/hooks/useHomeDashboard.ts
  src/components/home/StatTile.tsx
  src/components/home/QuickQueryWidget.tsx
  src/components/home/RecentSourcesPanel.tsx
  src/components/home/SourceFeedItem.tsx
  src/components/home/SignalsPanel.tsx
  src/components/home/SignalItem.tsx
  src/components/home/CrossConnectionsPanel.tsx
  src/components/home/CrossConnectionItem.tsx
  src/components/home/PipelineStatusStrip.tsx
  src/components/home/KnowledgeSnapshotPanel.tsx
```
