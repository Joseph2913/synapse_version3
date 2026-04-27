# BUILD-PLAN.md — Synapse V2 Build Roadmap

## Purpose

This document defines the complete build sequence for Synapse V2. It exists so that every PRD is implemented with awareness of what comes before and after it. When working on any individual PRD, read this document first to understand where that PRD sits in the overall architecture and what forward-compatible decisions to make.

---

## Build Philosophy

### Design-First, Always

Every PRD must produce output that matches the design system (`docs/DESIGN-SYSTEM.md`) and the mockup specification (`docs/synapse-v2-mockup.html`). This is not optional. There is no "functionality first, design later" phase.

What this means concretely:

- **Typography:** Cabinet Grotesk for all headings, section labels, and large metrics. DM Sans for all body text, UI labels, metadata, and input fields. Correct weights, sizes, and letter-spacing per the type scale. Every PRD.
- **Colors:** Light theme foundation — `#f7f7f7` content area, `#ffffff` cards, `#f0f0f0` frame/nav/inset. Blood orange accent (`#d63a00`) on interactive elements only, one primary button per view maximum. Entity type colors on badges, dots, and graph nodes. Every PRD.
- **Components:** Cards with subtle borders and hover lift. Buttons following the 4-level hierarchy (primary → secondary → tertiary → ghost). Filter pills with active/inactive states. Input fields with recessed backgrounds. Entity badges with colored dots. Every PRD.
- **Spacing:** 4px base unit. Card padding `16px 22px`. Content max-width `840px` centered. Feed card gap `8px`. Section gap `36px`. Every PRD.
- **Animation:** Staggered fade-up on page content load (0.4s ease, 0.05s delay increment). Hover transitions 0.15–0.18s ease. Chevron rotation on expand. Every PRD.
- **Interaction:** Hover states on all clickable elements. Focus-visible rings using accent-50. Cursor changes. No dead-feeling UI. Every PRD.

If a component doesn't look like it belongs in the mockup, it's not done.

### Forward-Compatible Decisions

Each PRD builds on the last. When implementing a PRD, make decisions that accommodate future PRDs without over-engineering. Specific guidance is noted in each PRD description below.

### Existing Database

Synapse V2 connects to an existing Supabase database with real user data. The schema is documented in `docs/DATA-MODEL.md`. Do not create new tables or modify existing schema unless a PRD explicitly includes a migration. All queries must respect RLS (Row Level Security).

---

## Phase 1: Foundation

> Goal: A working, deployed app with authentication and the complete navigational shell. Every view exists as a styled placeholder. The app looks and feels like a real product from day one.

### PRD 1 — Project Scaffold + Authentication

**What gets built:**
- Vite + React + TypeScript project with strict mode
- Tailwind CSS 4 configured with all design system tokens in `src/styles/tokens.css`
- Font imports (Cabinet Grotesk from Fontshare, DM Sans from Google Fonts)
- Supabase client singleton in `services/supabase.ts`
- `AuthProvider` context with session management
- Login screen: email/password sign-in and sign-up
- Auth guard: unauthenticated users see login, authenticated users see the app shell
- Deployed to Vercel with environment variables configured
- `.env.example` documenting required variables

**Design requirements:**
- Login screen follows the design system — centered card on `--bg-content` background, Cabinet Grotesk heading, DM Sans inputs with `--bg-inset` background, single primary button in `--accent-500`
- The Synapse logo mark (gradient square with "S") appears above the form
- Loading state while checking auth session

**Forward-compatible decisions:**
- The Supabase client must be typed using a `Database` type definition in `types/database.ts`. Define the types for at minimum `knowledge_nodes`, `knowledge_edges`, `knowledge_sources`, and `user_profiles` now, even though they're not all queried yet.
- Create the `services/`, `hooks/`, `utils/`, `config/`, `types/` directories with placeholder `index.ts` files so the project structure is established.
- Set up `config/entityTypes.ts` with the full entity type color map and `config/extractionModes.ts` with the four mode definitions. These are static config that multiple future PRDs reference.

**Testable after:** Sign in with existing Supabase credentials. See the authenticated app shell (even if it's empty). Deployed and accessible on Vercel.

---

### PRD 2 — App Shell + Navigation

**What gets built:**
- Three-pane layout: nav rail (56px) + center stage (flex) + right panel (310px)
- Nav rail with logo, 5 nav items (Home, Explore, Ask, Ingest, Automate), bottom utilities (Search, Settings)
- Nav rail expands to 190px on hover, collapses on mouse leave, with smooth 0.2s transition
- Active nav indicator: accent-50 background, accent-500 icon, 3px left bar
- Top bar: view title (Cabinet Grotesk 15px/700), node/edge count metadata, user avatar circle
- `react-router-dom` routing to all 5 views (each renders a styled placeholder with the view name and a brief description)
- Right panel: default state shows "Quick Access" with anchors list and recent nodes list (reads from Supabase)
- Right panel conditionally shows/hides (visible on Ask view always, visible when content is selected on other views)
- Command palette (⌘K): modal overlay with search input, navigation actions (Go to Home, Go to Explore, etc.), keyboard navigation (↑↓ to move, ↵ to select, Esc to close)
- Settings modal skeleton: overlay with sidebar nav (Profile, Anchors, Extraction, Digests, Integrations), only Profile tab shows a placeholder form, other tabs show "Coming soon"
- `GraphContext` provider: manages `selectedNode`, `rightPanelContent`, global filters (these will be consumed by views in later PRDs)

**Design requirements:**
- Nav rail matches mockup exactly: `--bg-frame` background, `--border-subtle` right border, items are 40×40px buttons with 10px radius
- Inactive icons use `--text-secondary`, active icons use `--accent-500`
- Command palette: `--bg-card` surface, `--border-strong` border, 16px radius, 520px width, backdrop blur behind overlay
- Settings modal: 780px width, two-column layout (200px sidebar + flex content), `--bg-card` surface
- Placeholder views should not look like placeholders — they should show the view name as a Cabinet Grotesk heading with a brief DM Sans description, centered in the content area, looking intentional

**Forward-compatible decisions:**
- The right panel component (`RightPanel.tsx`) must accept a `content` prop that determines what it renders. Define a discriminated union type now:
  ```typescript
  type RightPanelContent =
    | { type: 'node'; data: KnowledgeNode }
    | { type: 'source'; data: KnowledgeSource }
    | { type: 'feed'; data: FeedItem }
    | null; // shows Quick Access default
  ```
- The nav rail's `view` state and the router must stay in sync. Use the URL as the source of truth, not local state.
- The command palette should be built as a composable component that can accept different item sources. Initially it only has navigation items, but PRD 12 adds node search.
- The `SettingsContext` provider should be created here (even if only Profile is functional). It loads `user_profiles`, `extraction_settings`, and anchors on mount. Other PRDs will consume this context.

**Testable after:** Navigate between all 5 views. Open command palette, use keyboard to navigate and select. Open Settings, see Profile tab. See anchors and recent nodes in right panel. Nav rail expands/collapses on hover. Responsive at 1280px, 1440px, 1920px.

---

## Phase 2: Data Surfaces

> Goal: Every view that reads from the database is functional. The user can see their existing knowledge graph data through multiple interfaces — table, cards, graph, and feed. No new data is created yet.

### PRD 3 — Settings: Profile, Anchors, Extraction

**What gets built:**
- **Profile tab:** Form fields for Name, Professional Context, Personal Interests, Processing Preferences. Loads from `user_profiles` table. Creates a profile row if one doesn't exist (upsert pattern). Save button with loading state and success feedback.
- **Anchors tab:** Lists all nodes where `is_anchor = true`. Each anchor shows entity dot, label, type, connection count (count edges). "Demote" button removes anchor status. "Add Anchor" button opens a search modal where user can find any existing node and promote it to anchor.
- **Extraction tab:** Default Mode selector (4 modes in a 2×2 grid, styled per mockup). Default Anchor Emphasis selector (Passive/Standard/Aggressive in a row). Reads/writes `extraction_settings` table.
- **Digests tab:** Read-only list of existing `digest_profiles` if any exist. "Coming soon" state if none.
- **Integrations tab:** Read-only cards showing connection status for Gemini API, Supabase, Circleback. Status is determined by checking if API keys are configured (env vars present) and if integration tables have data.

**Design requirements:**
- Form inputs use `--bg-inset` background with `--border-subtle` borders
- Mode selection cards match mockup: entity-type color tinting on selected card, weight-600 label, weight-400 description
- Anchor list items: 10px entity dot, label in weight-600, type + connection count in `--text-secondary`, "Demote" button in semantic red tertiary style
- Save button: primary style (`--accent-500`), disabled state at 40% opacity when no changes

**Forward-compatible decisions:**
- The anchor search modal built here will be reused in the Ingest view (PRD 7) for selecting focus anchors during extraction. Build it as a standalone component (`components/shared/AnchorPicker.tsx`).
- Profile and extraction settings should be cached in `SettingsContext` after load. Other PRDs read from context, not from Supabase directly.
- The connection count per anchor should use a reusable function `getNodeConnectionCount(nodeId)` in `services/supabase.ts` — this is needed by Browse (PRD 4), Graph (PRD 5), and right panel node detail.

**Testable after:** Edit and save profile. Promote a node to anchor, demote an anchor. Change default extraction mode and emphasis. Settings persist across page reloads.

---

### PRD 4 — Explore: Browse Tab

**What gets built:**
- Tab bar at top of Explore view: "Graph" and "Browse" tabs with underline indicator
- Search input with icon, clear button
- Dropdown filter components: Entity Type (with colored dots), Source Type (with emoji icons), Anchor (with anchor names), Tags (with # prefix). Each dropdown shows checkboxes, supports multi-select, shows count badge when active.
- Confidence range slider (0–100%)
- Active filter chips below the filter bar, each dismissible with × button. "Clear all" button when any filters are active.
- Result count display
- **Table view:** Columns — Entity (with expand chevron + dot + bold label), Type (colored), Anchors (small badges), Source (emoji + name), Tags (max 2 visible + "+N"), Confidence (percentage), Connections (mini bar + number), Time. Sticky header. Expandable rows showing top connections and quick action buttons (Explore with AI, Re-link, Find Similar — these are placeholder buttons for now).
- **Card view:** Grid layout (`repeat(auto-fill, minmax(280px, 1fr))`). Each card shows entity dot + label + type, 2-line description, anchor badges, tags, connection count + confidence.
- View toggle (table/card) in the tab bar area
- Clicking any entity opens Node Detail in the right panel

**Design requirements:**
- Filter dropdowns match mockup: `--bg-raised` background, `--border-strong` border, 10px radius, checkbox-style selection with colored indicators for entity types
- Table rows have subtle hover (`--bg-hover`), no borders between rows (use bottom border only), sticky header with `--bg-card` background
- Expanded rows use slightly darker background (`--bg-active` at 50% opacity), show connections with entity dots and relationship tags
- Cards match the Card component spec from the design system: white background, subtle border, hover lift + shadow
- Connection bars use `--accent-500` fill on `--bg-inset` track

**Forward-compatible decisions:**
- The `FilterDrop` component should be built as a reusable generic: `FilterDrop<T>({ label, options, selected, onToggle, colorMap? })`. It will be reused on the Sources panel if that gets built later.
- Node fetching should use a custom hook `useNodes({ filters, search, pagination })` that encapsulates the Supabase query logic. This hook will be consumed by Browse, the command palette search (PRD 12), and potentially the Home feed.
- The `NodeDetail` right panel component should be built as a complete, polished component here — it's used everywhere (Browse, Graph, Home feed, Ask citations). It must support edit mode (inline editing of label, description, tags) and show connections, source provenance, and anchor status.
- Edge fetching for expanded rows should use the same `getNodeNeighbors(nodeId)` pattern documented in `LEGACY-PATTERNS.md`.

**Testable after:** See all your existing nodes. Filter by any combination of type, source, anchor, tag, confidence. Search by name or description. Switch between table and card views. Expand a row to see connections. Click a node to see full detail in the right panel. Edit a node's label or description inline.

---

### PRD 5 — Explore: Graph Tab

**What gets built:**
- Graph tab content area: full-bleed canvas (fills available space)
- Scope selector bar: Overview, Anchors Only, Sources Only (filter pills)
- Help text: "Click to select · Double-click to expand entities"
- **Source-Anchor graph visualization using D3.js on Canvas:**
  - Source nodes: rounded rectangles with source type emoji, label below, entity count badge. Background uses source type color at 7–15% opacity.
  - Anchor nodes: circles with ⚓ symbol, label below, connection count badge. Background uses entity type color at 10–18% opacity.
  - Edges: curved (quadratic bezier) lines connecting sources to anchors. Stroke width maps to shared entity count (1–5px). Default color `rgba(0,0,0,0.08)`. On hover: highlights to `rgba(214,58,0,0.3)` with entity count label at midpoint.
  - Gentle force simulation: drift, repulsion between nodes, spring toward connected nodes
  - Viewport boundary constraints
- **Interaction:**
  - Hover: node highlights (border brightens, slight size increase), connected edges highlight, cursor changes to pointer
  - Click: selects node, opens detail in right panel (reuses Node Detail from PRD 4 for anchors, shows Source Detail for sources)
  - Double-click: expands entity cluster — constituent entities fan out radially around the parent node with thin connecting lines. Entity dots colored by type. Labels in DM Sans 8px.
  - Double-click again to collapse
- Stats overlay (top-right): Sources count, Anchors count, Connections count
- Legend overlay (bottom-left): Source and Anchor visual key, edge thickness explanation

**Design requirements:**
- Canvas background is `--bg-content` (light gray), not white — the graph floats on the content layer
- Node labels use DM Sans at 10px weight-500, `--text-body` at 55% opacity default, 90% on hover
- Entity count/connection count badges use DM Sans 8px weight-700 in the node's color at 80% opacity
- Expanded entity dots: 6px radius, entity type color at full saturation, label at 8px with 65% opacity
- Overlay panels (stats, legend) use `--bg-card` with very slight opacity (95%), `--border-subtle`, 10px radius
- All transitions in the graph should feel smooth and organic — no snapping, no jerky motion

**Forward-compatible decisions:**
- The graph rendering should be encapsulated in a `GraphCanvas` component with clear props: `data`, `scope`, `expandedNodeId`, `onClickNode`, `onExpandNode`. The simulation logic lives in a `useGraphSimulation` hook. This separation allows the graph to be reused (e.g., mini-graph in the right panel context view for Ask, PRD 8).
- Build a `MiniGraph` variant (smaller, non-interactive, no labels) that can render in 290×160px for the right panel. It shows a subset of the graph relevant to the current context. PRD 8 uses this.
- Source data for the graph comes from `knowledge_sources` (for source nodes) and `knowledge_nodes` where `is_anchor = true` (for anchor nodes). Edges are computed by checking which source's extracted nodes connect to which anchors. This computation should be a utility function, not embedded in the component.

**Testable after:** See the source-anchor graph with real data. Hover to highlight connections. Click to see detail. Double-click to expand entities. Switch between scopes. Graph responds smoothly to interaction. Stats and legend are readable.

---

### PRD 6 — Home View

**What gets built:**
- Greeting heading: "Good evening, Joseph" (time-aware: morning/afternoon/evening, name from user profile). Cabinet Grotesk 26px weight-800.
- Summary line: "[N] sources processed today · [N] new entities · [N] relationships discovered" — computed from `knowledge_sources` and `knowledge_nodes` created in the last 24 hours.
- **Connection Discovery card** (conditional): accent-tinted card with lightning bolt icon. Shows an AI-generated or rule-based insight about recently discovered cross-connections. Only appears when there's something meaningful to show. Can be dismissed.
- **Feed/Briefings toggle group**
- **Activity Feed tab:**
  - Reads from `knowledge_sources` joined with extraction session data, ordered by most recent
  - Each feed card shows: source type icon in tinted container, source title (Cabinet Grotesk 14px/700), timestamp, entity/relation counts, summary text, entity badges (clickable, open node detail in right panel), cross-connections section (from→relationship→to format)
  - Click a feed card to open Source Detail in right panel
- **Briefings tab:**
  - Reads from `digest_profiles` table
  - Each briefing card shows: status icon (green for ready, gray for scheduled), title, next scheduled time, frequency badge, module list as small tags, preview text if status is "ready"
  - "Configure New Digest" dashed button (placeholder — opens Settings Digests tab for now)
  - If no digests exist, show a friendly empty state explaining what briefings are

**Design requirements:**
- Greeting heading matches mockup exactly: `26px` Cabinet Grotesk weight-800
- Connection Discovery card: `--accent-50` background (extremely subtle), `--accent-500` lightning icon, accent-tinted left border or top border
- Toggle group: `--bg-inset` container with 3px padding, active item gets `--bg-card` (white) background with subtle shadow, inactive items transparent
- Feed cards: follow Card component spec, 8px gap between cards, staggered fade-up animation on load
- Briefing "ready" status: `--semantic-green-500` dot and text, `--semantic-green-50` badge background
- Briefing "scheduled" status: `--text-secondary` dot and text, `--bg-inset` badge background
- Empty states: centered, gentle, with a relevant icon in `--text-placeholder` and helpful text in `--text-secondary`

**Forward-compatible decisions:**
- The feed card component (`FeedCard.tsx`) should be reusable — it appears on the Home view and may appear in the Sources panel if built later.
- The `SourceDetail` right panel component built here is distinct from `NodeDetail` (PRD 4). It shows source title, type, timestamp, summary, list of extracted entities as badges, cross-connections, and a "Re-extract" button. Build it as a separate component.
- Cross-connection data comes from edges where `source_node_id` belongs to one source and `target_node_id` belongs to a different source. The query to identify these is non-trivial — build it as a utility function in `services/supabase.ts`.
- The time-aware greeting should use the user's local timezone, not UTC.

**Testable after:** See personalized greeting. See activity feed with real processed sources. Click entity badges to see node detail. Click feed cards to see source detail. Toggle to Briefings tab. See digest profiles if they exist. Feed cards animate in on load.

---

## Phase 3: Intelligence

> Goal: The app can create new knowledge (ingestion) and query existing knowledge (RAG). These are the two most complex features and depend on Gemini integration, prompt composition, and multiple service calls.

### PRD 7 — Ingest View: Quick Capture + Extraction Pipeline

**What gets built:**
- Tab bar: Quick Capture, YouTube, Meetings, Documents, History
- **Quick Capture tab:**
  - Large text area: "Paste a URL, write a note, or drop content here..." — auto-resizes
  - Action bar below textarea: Attach button, URL button, "Extract Knowledge" primary button
  - Collapsible "Advanced Extraction Options" section (chevron toggle)
  - Advanced options panel:
    - Extraction Mode: 2×2 grid of mode cards (Comprehensive, Strategic, Actionable, Relational) with entity-type color tinting on selected
    - Anchor Emphasis: row of 3 options (Passive, Standard, Aggressive) with anchor-color tinting on selected
    - Focus Anchors: list of all anchors as toggle chips (uses `AnchorPicker` from PRD 3)
    - Custom Guidance: textarea for free-text instructions
  - Default values for mode and emphasis load from `extraction_settings` (via SettingsContext from PRD 3)
- **Full extraction pipeline:**
  1. Save raw content to `knowledge_sources` with metadata
  2. Compose system prompt via `utils/promptBuilder.ts` (base + mode + profile + anchors + guidance)
  3. Call Gemini for entity/relationship extraction
  4. **Entity Review UI:** Modal or inline panel showing extracted entities and relationships. User can edit labels, change entity types, remove items, adjust confidence. "Save to Graph" and "Re-extract" buttons.
  5. Save approved nodes to `knowledge_nodes` with user_id
  6. Generate embeddings for each node via Gemini text-embedding-004
  7. Save edges to `knowledge_edges`
  8. Chunk source content into ~500-token passages, embed each, save to `source_chunks`
  9. Run cross-connection discovery (compare new nodes against existing graph using semantic similarity, send top candidates to Gemini for relationship inference)
  10. Save cross-connection edges
  11. Show extraction summary: "X entities extracted, Y relationships created, Z cross-connections discovered"
- **Progress UI:** Multi-step progress indicator showing current pipeline stage (Saving source → Extracting entities → Reviewing → Saving to graph → Generating embeddings → Chunking source → Discovering connections → Complete)
- **History tab:** List of past extraction sessions from `extraction_sessions` table. Each row shows source name, type, timestamp, entity count, relationship count. "Re-extract" button per row.

**Design requirements:**
- Quick Capture textarea: `--bg-card` surface, generous padding, `--border-subtle` on the card, placeholder text in `--text-placeholder`
- Extract Knowledge button: primary style, full accent-500 background, disabled when textarea is empty
- Advanced options: collapsible with smooth height transition, chevron rotates on toggle
- Entity Review: clean table or card layout showing extracted entities with colored dots, editable fields. Removed entities shown with strikethrough. This must feel polished, not like a debug view.
- Progress indicator: horizontal step bar or vertical timeline. Active step shows accent-500 color and a subtle pulse. Completed steps show green check. The pipeline can take 15–30 seconds — the progress UI is critical for user trust.

**Forward-compatible decisions:**
- The extraction pipeline should be encapsulated in a service function or custom hook (`useExtraction`) that manages the full flow and exposes state (currentStep, entities, edges, error). This hook will be reused by the YouTube processing pipeline (PRD 11) and any future ingestion source.
- The entity review component should be its own module (`components/shared/EntityReview.tsx`) — it's used here and will be used for re-extraction from the History tab.
- Source chunking logic should be a utility function `chunkSourceContent(content: string, targetTokens?: number): string[]` in `utils/chunking.ts`.
- Cross-connection discovery should be a separate service function that takes an array of new node IDs and returns discovered edges. It needs access to the full embedding set for semantic similarity search.

**Testable after:** Paste text, configure extraction settings, click Extract. See progress through pipeline stages. Review extracted entities, edit or remove some, save to graph. See new nodes appear in Browse tab. See new source in activity feed. See cross-connections created. View extraction history.

---

### PRD 8 — Ask View: Graph RAG Chat

**What gets built:**
- Chat interface: message list with user messages (right-aligned, accent-tinted) and assistant messages (left-aligned, `--bg-raised`)
- Message styling: role label (uppercase, 10px, muted), content with markdown-like bold rendering, source citation badges at bottom of assistant messages
- Input bar at bottom: text input, send button (accent-500, disabled when empty), helper text "Retrieves from source chunks, entities, and graph traversal"
- Status indicator at top: green dot + "Graph RAG Active" + node/chunk counts
- **RAG pipeline (full implementation):**
  1. Embed user query via Gemini text-embedding-004
  2. Semantic search: query `source_chunks` embeddings via pgvector cosine similarity (top 10)
  3. Keyword search: PostgreSQL full-text search on `knowledge_nodes` label + description (top 10)
  4. Merge results: normalize scores, combine overlapping results, sort by combined score
  5. Graph traversal: for top 5 results, follow edges 2 hops to pull in transitively relevant nodes
  6. Context assembly: concatenate top source chunks + node summaries + relationship paths
  7. Gemini generation: send assembled context + user question, get response with source attribution
  8. Parse response, render with citations
- **Right panel (Ask-specific):**
  - "Context" header
  - Related Subgraph: MiniGraph component (from PRD 5) showing the nodes/edges referenced in the response
  - Source Chunks: list of the actual text passages used as context, each showing source title, chunk preview, and timestamp. Clickable to see full source detail.
- Clicking a citation badge in the assistant message opens Node Detail in the right panel
- Chat history persists during the session (in React state), clears on page refresh
- Loading state while RAG pipeline runs: typing indicator animation + optional step progress (subtle, less prominent than Ingest view)

**Design requirements:**
- User messages: `--accent-50` background, `--accent-500` at 15% for border, right-aligned with rounded corners (14px top, 14px top, 4px bottom-right, 14px bottom-left)
- Assistant messages: `--bg-raised` background, `--border-subtle`, left-aligned with rounded corners (14px top, 14px top, 14px bottom-right, 4px bottom-left)
- Role labels: uppercase, 10px, `--text-secondary`, with sparkle icon for assistant
- Citation badges: entity badges (reuse Badge component from PRD 4) in a "SOURCES" section below the message
- Source chunks in right panel: Card component with source title in `--accent-500` weight-600, timestamp in `--text-secondary`, chunk text in `--text-body` at 11px
- Input bar: `--bg-card` surface for the bar, `--bg-raised` for the input container, `--border-default` border, send button in accent-500 circle
- The chat area must scroll to bottom on new messages

**Forward-compatible decisions:**
- The RAG pipeline should be a service function `queryGraph(question: string): Promise<RAGResponse>` that returns `{ answer: string, citations: Citation[], sourceChunks: Chunk[], relatedNodes: Node[] }`. This function will be reused by the Orientation Engine (PRD 13) for generating digest content.
- Chat messages should be typed as `{ id: string, role: 'user' | 'assistant', content: string, citations?: Citation[], timestamp: Date }`. Future work may persist chat history to Supabase — design the type to be serializable.
- The MiniGraph in the right panel should accept a `nodes` and `edges` prop and render a non-interactive visualization. It's the same component from PRD 5 but in read-only mode.

**Testable after:** Type a question about your knowledge graph. See the RAG pipeline process it. Get a substantive answer with source citations. Click citations to see node detail. See source chunks used in the right panel. See mini-graph of related context. Ask follow-up questions. The chat feels responsive and the answers are grounded in actual graph data.

---

## Phase 4: Automation

> Goal: The app can ingest content from external sources automatically. YouTube channels and playlists are polled on a schedule. Meeting transcripts can be imported from third-party tools.

### PRD 9 — Ingest: YouTube, Meetings, Documents Tabs

**What gets built:**
- **YouTube tab:** Connect playlist form (URL input → "Connect" button). Connected playlists displayed as expandable cards showing videos with checkboxes. "Add to Queue" action for selected videos. Queue status banner showing pending/processing/complete counts. Per-playlist settings (extraction mode, anchor emphasis, linked anchors).
- **Meetings tab:** "Paste Transcript" option (large textarea, similar to Quick Capture but pre-configured for meeting source type). Integration cards for Circleback, Fireflies, tl;dv, MeetGeek (placeholder "Connect" buttons — full integration is future work). Setup wizard concept: when clicking "Connect" for any tool, show a modal explaining the setup steps before starting.
- **Documents tab:** Drag-and-drop file upload zone. Supported formats listed (PDF, DOCX, Markdown, plain text). File upload triggers the same extraction pipeline from PRD 7 with source_type set to "Document".
- All three tabs feed into the same extraction pipeline built in PRD 7.

**Testable after:** Connect a YouTube playlist. See its videos. Queue selected videos. Paste a meeting transcript and extract. Upload a document and extract. Each source type shows correctly in the activity feed.

---

### PRD 10 — Automate View

**What gets built:**
- Integration dashboard with status cards for: YouTube Channels (count + RSS interval), YouTube Playlists (count + SYN codes), Meeting Integrations (connected services), Processing Queue (pending/failed counts + last activity)
- Each card shows: title, description, active/idle status indicator (green dot for active, gray for idle), key metric
- Expandable cards with configuration options and "Manage" actions
- Queue section with filter bar (All/Pending/Processing/Complete/Failed) and per-item cards showing 5-step processing status

**Testable after:** See all connected integrations with real status data. See processing queue with actual items. Status indicators reflect real database state.

---

### PRD 11 — YouTube Serverless Pipeline

**What gets built:**
- `api/youtube/poll.ts` — channel RSS polling. Runs on cron (every 15 min). Fetches RSS feeds for all active channels. Filters by duration. Queues new videos.
- `api/youtube/poll-playlist.ts` — playlist polling. Runs on cron (every 5 min). Fetches playlist items via YouTube Data API v3. Deduplicates against existing queue. Queues new videos with playlist-specific settings.
- `api/youtube/process.ts` — video processing. Runs on cron (every 5 min). Picks up to 2 pending items. Runs three-tier transcript extraction (youtube-caption-extractor → Innertube → Apify). On success, triggers extraction pipeline.
- All functions fully self-contained (no shared local imports). Auth verification inline. Supabase client created inline.
- Vercel cron configuration in `vercel.json`

**CRITICAL:** Follow the Vercel serverless constraint documented in `LEGACY-PATTERNS.md` and `CLAUDE.md`. Every helper function must be defined inline within each file. Test each function independently after deployment.

**Testable after:** Videos from connected channels appear in queue automatically. Transcripts are extracted and processed. New nodes appear in the graph from YouTube content.

---

## Phase 5: Polish + Advanced

> Goal: Enhance the core experience with search, intelligence, and browser integration.

### PRD 12 — Command Palette: Full Search

**What gets built:**
- Upgrade command palette with real-time node search (debounced, searches `knowledge_nodes` by label)
- Results grouped by category: Anchors (always shown first), Nodes (search results), Navigation (always shown)
- Each result shows entity dot, label, type badge
- Selecting a node navigates to Explore Browse with that node selected and its detail shown in right panel
- Recent nodes section (last 5 viewed)

**Testable after:** Press ⌘K, type a node name, see results appear. Select a result and navigate to it. See anchors always listed. See recent nodes.

---

### PRD 13 — Orientation Engine (Digests)

**What gets built:**
- Settings → Digests tab fully functional
- Create new digest profile: title, frequency (daily/weekly/monthly), schedule time, density (brief/standard/comprehensive)
- Module selection: choose from frequency-appropriate templates. Drag-and-drop reordering via `sort_order`.
- Delivery channel configuration: email (HTML), Telegram (markdown), Slack (block kit). Each channel can override density.
- Preview functionality: "Preview" button generates the digest in-app using the RAG pipeline from PRD 8
- Meta-agent orchestration: triggers all modules, aggregates outputs, generates executive summary
- Home view Briefings tab shows real digest data with "View" button for ready digests

**Testable after:** Create a digest profile with daily frequency. Add modules. Preview the digest in-app. See it appear in the Briefings tab.

---

## Dependency Graph

```
PRD 1 (Scaffold + Auth)
  └─ PRD 2 (Shell + Nav)
       ├─ PRD 3 (Settings)
       │    └─ PRD 7 (Ingest + Extraction) ─── PRD 9 (YouTube/Meetings UI)
       │         │                                    └─ PRD 10 (Automate)
       │         │                                         └─ PRD 11 (YouTube Serverless)
       │         └─ PRD 8 (Ask: RAG) ──────── PRD 13 (Orientation Engine)
       └─ PRD 4 (Browse)
            ├─ PRD 5 (Graph)
            ├─ PRD 6 (Home)
            └─ PRD 12 (Command Palette Search)
```

---

## Estimated Effort Per PRD

| PRD | Complexity | Estimated Effort | Key Risk |
|-----|-----------|-----------------|----------|
| 1 | Low | 1 session | Env var configuration, Vercel deployment |
| 2 | Medium | 1–2 sessions | Nav rail animation, right panel conditional logic |
| 3 | Medium | 1 session | Profile upsert pattern, anchor search modal |
| 4 | High | 2–3 sessions | Filter system, table with expandable rows, two view modes |
| 5 | High | 2–3 sessions | D3 canvas rendering, force simulation, interaction handling |
| 6 | Medium | 1–2 sessions | Cross-connection query, time-aware greeting, feed data assembly |
| 7 | Very High | 3–4 sessions | Full extraction pipeline, Gemini integration, entity review UI, chunking, cross-connections |
| 8 | Very High | 3–4 sessions | Full RAG pipeline, hybrid search, graph traversal, context assembly |
| 9 | Medium | 1–2 sessions | YouTube playlist connection, file upload, meeting paste |
| 10 | Low-Medium | 1 session | Mostly read-only dashboard, status indicators |
| 11 | High | 2–3 sessions | Serverless functions, cron config, three-tier transcript extraction |
| 12 | Low | 1 session | Search integration into existing command palette |
| 13 | Very High | 3–4 sessions | Meta-agent architecture, module system, delivery channels |
| 14 | Medium | 2 sessions | Separate codebase (Manifest V3), auth flow, content scripts |
