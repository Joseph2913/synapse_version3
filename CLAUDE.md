# CLAUDE.md — Synapse V2

## What This Project Is

Synapse is a personal knowledge graph platform that ingests diverse content (meeting transcripts, YouTube videos, documents, notes, web pages), extracts entities and relationships using AI, visualizes them as an interactive graph, and enables Graph RAG querying. It is positioned as infrastructure for personal AI agent fleets — not a productivity tool, not a note-taking app.

This is a **complete rebuild** (v2) with a new codebase connecting to an **existing Supabase database** that already contains user data, knowledge nodes, edges, and sources from v1. The database schema is not changing — only the frontend and API layer are being rebuilt.

---

## Tech Stack

| Layer | Technology | Version |
|---|---|---|
| Framework | React | 18.x |
| Build | Vite | 6.x |
| Language | TypeScript | 5.x (strict mode) |
| Styling | Tailwind CSS 4 | with custom theme tokens via CSS variables |
| Database | Supabase (PostgreSQL) | Client v2 |
| AI | Google Gemini 2.0 Flash | via REST API |
| Embeddings | Gemini text-embedding-004 | 768-dimensional vectors |
| Vector Search | pgvector | via Supabase |
| Graph Viz | D3.js | v7 |
| Icons | Lucide React | Latest |
| Fonts | Cabinet Grotesk (display), DM Sans (body) | Via Fontshare + Google Fonts |
| Hosting | Vercel | Automatic deploy from GitHub |
| Serverless | Vercel Functions | Under `api/` directory |

---

## Project Structure

```
synapse-v2/
├── src/
│   ├── app/                    # App shell, router, providers
│   │   ├── App.tsx
│   │   ├── Router.tsx
│   │   └── providers/
│   │       ├── AuthProvider.tsx
│   │       └── ThemeProvider.tsx
│   ├── components/
│   │   ├── ui/                 # Shared primitives (Card, Badge, Pill, Button, Input, FilterDrop)
│   │   ├── layout/             # Shell components (NavRail, TopBar, RightPanel, CenterStage)
│   │   ├── graph/              # D3 graph visualization components
│   │   └── shared/             # Cross-view components (EntityBadge, SourceIcon, ConfidenceBar)
│   ├── views/                  # Top-level view components (one per nav item)
│   │   ├── HomeView.tsx
│   │   ├── ExploreView.tsx
│   │   ├── AskView.tsx
│   │   ├── IngestView.tsx
│   │   └── AutomateView.tsx
│   ├── services/               # External service integrations
│   │   ├── supabase.ts         # All Supabase client operations
│   │   ├── gemini.ts           # All Gemini AI operations
│   │   └── auth.ts             # Authentication helpers
│   ├── hooks/                  # Custom React hooks
│   ├── utils/                  # Pure utility functions
│   │   ├── promptBuilder.ts    # Composable system prompt construction
│   │   ├── profileContext.ts   # User profile context for prompts
│   │   └── anchorContext.ts    # Anchor context for prompts
│   ├── config/                 # Static configuration
│   │   ├── entityTypes.ts      # Entity ontology and colors
│   │   ├── extractionModes.ts  # Extraction mode templates
│   │   └── lenses.ts           # Graph view lens configurations
│   ├── types/                  # TypeScript type definitions
│   │   ├── database.ts         # Supabase table row types
│   │   ├── graph.ts            # Graph visualization types
│   │   └── index.ts            # Shared types
│   └── styles/
│       └── tokens.css          # CSS custom properties (design system tokens)
├── api/                        # Vercel serverless functions
│   └── youtube/                # YouTube processing endpoints
├── public/
├── docs/                       # AI agent context documents (you are here)
│   ├── CLAUDE.md
│   ├── ARCHITECTURE.md
│   ├── DATA-MODEL.md
│   ├── DESIGN-SYSTEM.md
│   ├── LEGACY-PATTERNS.md
│   └── PRDs/
└── package.json
```

---

## Critical Rules

### Code Style
- **TypeScript strict mode** — no `any` types, no implicit returns, all functions typed
- **Functional components only** — no class components
- **Named exports** for all components and utilities. Default exports only on view-level pages
- **One component per file** — exception: tightly coupled sub-components can live together
- **Hooks over HOCs** — prefer custom hooks for shared logic
- **No inline styles** — use Tailwind utility classes. The mockup uses inline styles for reference; translate them to Tailwind
- **CSS variables for design tokens** — all colors, spacing, fonts reference tokens from `tokens.css`

### Supabase Patterns
- **Single Supabase client instance** — created in `services/supabase.ts`, never instantiated elsewhere
- **Always use RLS** — never bypass Row Level Security. All queries filter by authenticated user
- **Use `.maybeSingle()`** instead of `.single()` for queries that might return zero rows
- **Defensive INSERTs** — only include nullable fields when they have truthy values. Omit empty arrays for UUID[] columns
- **Auth context** — wrap app in `AuthProvider` that exposes `user`, `session`, `signIn`, `signOut`
- **Environment variables** use `VITE_` prefix for client-side access
- **CRITICAL — Migration safety:** After ANY database table or column rename, `grep -r "old_name" --include="*.ts"` the entire codebase before deploying. Supabase PostgREST silently returns empty results (no error) when querying a non-existent table with RLS enabled — inserts vanish without a trace. The highest-risk files are `api/` serverless functions (independently bundled, no shared imports, stale references won't cause build errors) and `src/services/supabase.ts` (centralises most table references). Always verify the affected pipeline produces expected output after deploy — absence of errors does not mean success.

### Vercel Serverless Functions
- **CRITICAL: No shared local imports in `api/` files.** Each serverless function is bundled independently. All helpers must be defined inline within each file
- **Verify every import resolves** — a single bad import crashes the entire function silently with `FUNCTION_INVOCATION_FAILED`
- **Check Vercel runtime logs** (not frontend errors) to diagnose function crashes
- **npm packages are fine** — only local file imports are problematic

### Gemini AI
- Model: `gemini-2.0-flash` for extraction and Graph RAG
- Embeddings: `text-embedding-004` (768 dimensions)
- All AI calls go through `services/gemini.ts`
- Prompt construction is modular: base instructions + extraction mode + user profile + anchor context + custom guidance
- System prompts are composed via `utils/promptBuilder.ts`

### Graph Visualisations
- **MANDATORY: `userSelect: 'none'` on all graph containers.** Every `<svg>`, `<canvas>`, and their parent `<div>` in graph views must have `userSelect: 'none'` and `WebkitUserSelect: 'none'` to prevent text selection during drag. SVG `<text>` elements must also have `pointerEvents: 'none'` and `userSelect: 'none'`. Omitting this causes rendering slowdowns and visual artifacts.
- **Consult `docs/GRAPH-VISUALISATION-SPEC.md`** for all graph rendering decisions — node styling, physics parameters, edge rendering, camera controls
- **Standardised physics across all views:** No automatic floating — nodes are static until dragged. Damping `0.97`, drag drift strength `0.0005 + weight * 0.004` (1st degree only, no 2nd degree). Boundary soft-push keeps nodes within viewport.
- **Standardised node rendering:** Translucent fill `{color}22`, solid stroke `2px`, hover scale `1.08×`, glow ring `r+4` at `{color}35`, selection ring `r+5` at `accent-500`

### Component Design
- Follow the design system in `docs/DESIGN-SYSTEM.md` for all visual decisions
- **Consult `docs/UI-AUDIT.md`** for layout architecture, control bar patterns, and quality checklists — this is MANDATORY for every UI change
- Light theme foundation — white cards on light gray backgrounds, blood orange accent (#d63a00)
- Entity type colors are the primary chromatic elements — use them on badges, dots, graph nodes
- One primary-accent button per view maximum
- Hover transitions: 0.15–0.18s ease, subtle (border darkening, slight lift, barely-there shadow)

### Layout Architecture (CRITICAL — follow for all views)
- **Topbar:** 52px height, light orange bg (`--color-accent-50`). Left: page title (Cabinet Grotesk 15px/700). Center: search bar. Right: node/edge counts + avatar
- **Full-width control bar:** Every view has a control bar BELOW the topbar and ABOVE the 2:1 column split. Must span full width across both columns.
- **Control bar container (hard-coded pixel specs):**
  - Simple bars (Ask, Home): `height: 44px` (fixed), `padding: 0 24px`, `gap: 8px`
  - Complex bars (Explore, Pipeline, Automate, Capture, Orient): `minHeight: 44px`, `padding: 8px 24px`, `gap: 8px`
  - All: `background: var(--color-bg-card)`, `borderBottom: 1px solid var(--border-subtle)`, `display: flex`, `align-items: center`, `flex-shrink: 0`
- **Control bar pills/buttons (hard-coded pixel specs — NO EXCEPTIONS):**
  - `borderRadius: 20px` — ALL interactive elements (pills, dropdown triggers, search inputs, toggle buttons). NEVER `borderRadius: 8`.
  - `padding: 5px 13px` — ALL pill buttons and dropdown triggers
  - `fontSize: 12px` — ALL text in control bars. Never 11px or 13px.
  - `font-body font-semibold` (DM Sans weight 600)
  - Active: `border: 1px solid rgba(214,58,0,0.15)`, `background: var(--color-accent-50)`, `color: var(--color-accent-500)`
  - Inactive: `border: 1px solid var(--border-subtle)`, `background: transparent`, `color: var(--color-text-secondary)` — NEVER `--text-body`
  - Dropdown chevrons: `size={12}`
  - Search inputs: `borderRadius: 20px`, `padding: 5px 26px 5px 28px`
  - Icon toggles (grid/list): `26×26px`, `borderRadius: 20px`, icon `size={12}`
  - Dividers: `width: 1px`, `height: 24px`, `background: var(--border-subtle)`
- **Gold standard:** Automate + Orient views are the reference. All other views must match their control bar height, pill styling, font size, and color exactly
- **Explore view mode toggle:** Uses individual pill buttons (NOT a ToggleGroup/segmented control). Same styling as all other pills.
- **No standalone title rows:** Page titles live in the topbar only. Views do NOT have dedicated title/subtitle blocks inside content areas
- **View structure:** `<div className="flex flex-col h-full"><ControlBar /><div className="flex flex-1 overflow-hidden"><LeftCol /><DragHandle /><RightCol /></div></div>`
- **Nav rail:** Expands as position:absolute overlay, never pushes layout. Center stage width never changes on hover

---

## Build Plan & PRD Execution

The build is organized into 14 PRDs across 5 phases, defined in `docs/BUILD-PLAN.md`. **This is the master sequencing document for all implementation work.**

### How to Use the Build Plan

1. **Before starting any PRD:** Read `docs/BUILD-PLAN.md` to understand where the PRD sits in the dependency graph, what it builds on, and what future PRDs depend on it.
2. **Check the "Forward-compatible decisions" section** of the current PRD — these are architectural choices that must be made now to avoid rework later.
3. **Design-first, always.** Every PRD must produce output matching the design system. There is no "functionality first, design later" phase. If a component doesn't look like it belongs in the mockup, it's not done.
4. **Consult the reference documents** listed below before making specific decisions.

### Build Phases

| Phase | PRDs | Goal |
|---|---|---|
| **1: Foundation** | PRD 1–2 | Working deployed app with auth, nav shell, all views as styled placeholders |
| **2: Data Surfaces** | PRD 3–6 | Settings, Browse, Graph, Home — all read-only views showing existing data |
| **3: Intelligence** | PRD 7–8 | Ingestion pipeline (Gemini extraction) + Graph RAG chat |
| **4: Automation** | PRD 9–11 | YouTube/Meetings/Documents ingestion tabs + serverless pipeline |
| **5: Polish + Advanced** | PRD 12–14 | Full command palette search, Orientation Engine, Chrome Extension |

### Current Build Status

> Update this section as PRDs are completed.

- [ ] PRD 1 — Project Scaffold + Authentication
- [ ] PRD 2 — App Shell + Navigation
- [ ] PRD 3 — Settings: Profile, Anchors, Extraction
- [ ] PRD 4 — Explore: Browse Tab
- [ ] PRD 5 — Explore: Graph Tab
- [ ] PRD 6 — Home View
- [ ] PRD 7 — Ingest: Quick Capture + Extraction Pipeline
- [ ] PRD 8 — Ask: Graph RAG Chat
- [ ] PRD 9 — Ingest: YouTube, Meetings, Documents Tabs
- [ ] PRD 10 — Automate View
- [ ] PRD 11 — YouTube Serverless Pipeline
- [ ] PRD 12 — Command Palette: Full Search
- [ ] PRD 13 — Orientation Engine (Digests)
- [ ] PRD 14 — Chrome Extension

---

## Reference Documents

Before making decisions, consult these files:

| Document | When to Read |
|---|---|
| `docs/BUILD-PLAN.md` | **Before starting ANY PRD** — understand sequencing, dependencies, and forward-compatible decisions |
| `docs/ARCHITECTURE.md` | Before creating new files, services, or changing project structure |
| `docs/DESIGN-SYSTEM.md` | Before making ANY visual/UI decision — colors, fonts, spacing, components |
| `docs/UI-AUDIT.md` | **Before ANY UI implementation** — layout architecture, control bar patterns, quality checklists, view-specific rules |
| `docs/DATA-MODEL.md` | Before writing ANY Supabase query or modifying database interactions |
| `docs/LEGACY-PATTERNS.md` | Before implementing extraction, search, transcript processing, or cross-connections |
| `docs/PROJECT-REFERENCE.md` | For strategic context — product vision, Knowledge Value Modes, ingestion pipeline details, debugging history |

---

## Navigation Structure

The app has 7 primary views accessible via a left nav rail:

1. **Home** (`/`) — Activity feed + quick stats dashboard
2. **Explore** (`/explore`) — Graph visualization + entity browser
3. **Ask** (`/ask`) — Graph RAG chat interface with source citations
4. **Capture** (`/capture`) — Manual content capture (Text/URL/Document/Transcript modes)
5. **Automate** (`/automate`) — Integration management, source cards, processing queues
6. **Orient** (`/orient`) — Orientation digests and knowledge briefings
7. **Pipeline** (`/pipeline`) — Ingestion health, extraction history, analytics

Plus:
- **Command Palette** (⌘K) — global search and navigation
- **Settings Modal** — Profile, Anchors, Extraction defaults, Digests, Integrations
- **Right Panel** — contextual detail panel (node detail, source detail, quick access)

---

## Entity Ontology

These are the entity types extracted by Gemini:

Person, Organization, Team, Topic, Project, Goal, Action, Risk, Blocker, Decision, Insight, Question, Idea, Concept, Takeaway, Lesson, Document, Event, Location, Technology, Product, Metric, Hypothesis, Anchor

Each type has an assigned color defined in the design system. Use these consistently across badges, graph nodes, dots, and filters.

## Relationship Types

Positive: leads_to, supports, enables, created, achieved, produced
Negative: blocks, contradicts, risks, prevents, challenges, inhibits
Neutral: part_of, relates_to, mentions, connected_to, owns, associated_with

---

## Testing Expectations

- Test with empty database state (new user, no nodes)
- Test with populated state (847+ nodes, 1200+ edges)
- Test all views at 1280px, 1440px, and 1920px widths
- Verify RLS — one user cannot see another user's data
- All Supabase queries must handle errors gracefully (no unhandled promise rejections)
- Graph visualization must remain responsive with 500+ visible nodes

---

## Deployment

- Push to `main` triggers automatic Vercel deployment
- Environment variables are set in Vercel dashboard (never committed to repo)
- Required env vars: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_GEMINI_API_KEY`
- Serverless functions under `api/` deploy as independent Vercel functions
- Build command: `npm run build` (Vite)
- Output directory: `dist`
