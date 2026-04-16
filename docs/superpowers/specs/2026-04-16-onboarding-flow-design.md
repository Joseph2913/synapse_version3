# Onboarding Flow Design Spec

## Overview

A 5-step onboarding wizard that appears the first time a user signs into Synapse. It introduces the platform, collects an AI conversation export to bootstrap the user's profile and knowledge graph, lets them review the generated profile, and connects their meeting services and YouTube playlist for ongoing ingestion.

**Approach:** Full-screen takeover. The onboarding wizard replaces the entire app shell (no nav rail, no topbar). The user sees nothing of the main app until onboarding is complete or skipped.

---

## Trigger and Persistence

- **When it shows:** After successful authentication, if `onboarding_complete` is `false` on the user's profile row.
- **Where the flag lives:** `user_profiles` table, new boolean column `onboarding_complete`, default `false`.
- **One-time only:** Once marked complete (by finishing or skipping), the user goes straight to the app on all future logins, across all devices.
- **Replay:** A "Replay onboarding" button in Settings resets the flag and redirects to the wizard.
- **Mid-session exit:** If the user closes the tab during onboarding, they restart from Step 0 next time. Step progress is not persisted between sessions.

---

## Integration Point

In `App.tsx`, the `AuthGate` component currently renders `<LoginPage />` when there's no session and the app shell when there is. The change:

```
if (!session) return <LoginPage />
if (!profile.onboarding_complete) return <OnboardingWizard />
return <>{children}</>
```

The `OnboardingWizard` component owns all 5 steps and manages step transitions via local React state.

---

## Step Summary

| Step | Name | Skippable | Condition | Exit Action |
|------|------|-----------|-----------|-------------|
| 0 | Platform Walkthrough | Yes (skip all) | Always shown | Advances to Step 1 |
| 1 | Import AI History | Yes | Always shown | Advances to Step 2 (if processed) or Step 3 (if skipped) |
| 2 | Review Profile | Yes | Only if Step 1 completed | Advances to Step 3 |
| 3 | Connect Meetings | Yes | Always shown | Advances to Step 4 |
| 4 | Connect YouTube | Yes | Always shown | Marks onboarding complete, enters app |

A persistent "Skip onboarding" link is visible at every step. Clicking it marks `onboarding_complete = true` and drops the user into the main app immediately.

---

## Step 0: Platform Walkthrough

### Purpose
Give the user a visual tour of what Synapse does by showing each page with realistic mock data.

### Layout
Full-screen scrollable sequence. No app shell visible.

### Sections (in scroll order)

1. **Welcome Hero**
   - Synapse flame logo (centered)
   - "Welcome to Synapse" heading
   - Tagline: "Your knowledge, connected."
   - One-line description: "Synapse transforms scattered knowledge from meetings, videos, documents, and research into an interconnected graph you can explore, query, and build on."
   - Row of page name pills (Home, Explore, Ask, Sources, Signals, Council)
   - "Skip onboarding" link in the top-right corner

2. **Home** - Dashboard with mock activity feed (YouTube videos, meetings, documents, notes, research), stats pills, source type badges, council advisor cards with health statuses.

3. **Explore** - Anchor bubble cluster view with 6-7 mock anchors (AI Agent Architecture, Product Strategy, Knowledge Graphs, Graph RAG, Consulting Delivery, Market Analysis) plus one dashed "suggested" anchor. Floating detail card showing entity breakdown.

4. **Ask** - A mock conversation showing a user question with a Standard mode response (inline citations) and Council mode response (4 advisor cards with names, confidence percentages, and reasoning).

5. **Sources** - Split panel. Left: source list with mixed types (YouTube, Meeting, Document, Research, Note). Right: detail view of a selected source showing extracted entities, connected anchors, and key takeaways.

6. **Signals** - Split panel. Left: anchor cards with scores and velocity indicators + skill cards with descriptions and domains. Right: explainer text on what anchors are, what skills are, and how health scoring works.

7. **Council** - Split panel. Left: 4 advisor cards (AI Strategy, Product Growth, Knowledge Systems, Consulting Ops) with health badges, theme entity pills, and stats. Right: health overview grid, active cross-domain signals, and emerging insights with type badges (Convergence, Tension).

### Page Preview Rendering

Each page preview renders the **actual production component** (e.g. `<HomeView />`, `<ExploreView />`) inside a contained wrapper that includes a fake nav rail and topbar to mimic the app shell. Components receive mock data via a `DemoDataProvider` context that intercepts data-fetching hooks and returns curated dummy data. This ensures the onboarding previews look identical to the real app.

### Floating Description Card

Each page preview has a floating card positioned in a natural whitespace area within the view. The card has:
- Rounded corners, white background, subtle border and shadow
- Page icon and page name
- 2-3 sentence description of what the page does
- **"Next" button** that smooth-scrolls to the next page preview
- On the final page (Council), the button says **"Continue to Setup"** and advances to Step 1

### Navigation

- Dot navigation on the right edge for jumping between pages
- Free-form scrolling is also supported
- The description card's "Next" button is the primary navigation method

---

## Step 1: Import AI History

### Purpose
Upload a ChatGPT or Claude conversation export so Synapse can bootstrap the user's profile, interests, entities, and anchors.

### Layout
Centered wizard panel. White card on light background, max-width ~600px. Same visual style as the login page.

### UI Elements

- **Tab bar:** "ChatGPT" | "Claude" tabs at the top
- **Export instructions** (per tab):
  - ChatGPT: Settings > Data Controls > Export Data > download ZIP > upload `conversations.json`
  - Claude: Settings > Account > Export Data > download ZIP > upload the ZIP directly
- **Drop zone:** Drag-and-drop area for the file, with a "click to browse" fallback
- **Privacy note:** "Your raw conversations are never stored. Synapse only extracts topics, patterns, and entities."
- **Progress indicator:** Shows during processing
- **Error handling:** Clear error message if file format is wrong or processing fails, with "Try again" option
- **Buttons:** "Skip for now" (advances to Step 3) | "Process & Continue" (processes file, advances to Step 2)

### Processing Pipeline

1. **File validation** - Check file type (JSON for ChatGPT, ZIP for Claude). Validate internal structure matches expected format. Reject with clear error if not.
2. **Extraction** - Pull conversation texts from the format. Strip system prompts and metadata. Keep user messages and assistant responses.
3. **Batched analysis** - Send conversation text in batches to Gemini (staying within token limits) with a prompt to identify: professional context, recurring interests, key people/topics/projects/technologies, and candidate focus areas.
4. **Profile assembly** - Merge results across batches, deduplicate entities, rank candidate anchors.
5. **Write to database** - Populate `user_profiles` fields (professional_context, personal_interests) and create initial `knowledge_nodes` with appropriate `is_anchor` flags.

### Technical Notes

- Processing runs in a **Vercel serverless function**, not client-side. Client uploads the file, function processes it, client polls for completion.
- Upload size cap: **100MB** (typical ChatGPT export for a heavy user is 20-50MB).
- Both ChatGPT and Claude formats are supported from day one.

---

## Step 2: Review Profile

### Purpose
Show the user what Synapse learned from their AI conversation export and let them adjust before proceeding.

### Condition
**Only appears if Step 1 was completed.** If the user skipped Step 1, the flow jumps directly to Step 3.

### Layout
Centered wizard panel, max-width ~700px. Two columns.

### Left Column
- **Professional Context** - Editable text area, pre-filled with the AI-generated summary
- **Interests** - Pill badges with X to remove, plus an input to add new ones

### Right Column
- **Detected Anchors** - List of candidate anchors with mention counts. Each has a toggle/checkbox to confirm or remove.
- **Explainer:** "Anchors are your key focus areas. They organize your knowledge graph. You can always change these later in Settings."

### Buttons
- "Edit Profile" (expands into full edit mode)
- "Looks Good" (saves any changes, advances to Step 3)

### Key Principle
Everything is editable but pre-filled. The goal is to give the user the feeling that "Synapse already understands me" while letting them correct anything off.

---

## Step 3: Connect Meeting Services

### Purpose
Connect meeting transcript tools for automatic ongoing ingestion.

### Layout
Centered wizard panel, max-width ~550px.

### Integration Cards (currently functional)

1. **Microsoft 365** - Teams meeting transcripts and Outlook calendar events. Connects via OAuth.
2. **Circleback** - Meeting transcripts via webhook. Connects via webhook setup flow.

### Rules
- **Only show integrations that have functional connection flows.** No "Coming Soon" placeholders.
- As more integrations become functional (Fireflies, tl;dv, MeetGeek), they are added as new card rows with no structural changes needed.
- On successful connection, the button changes to a green "Connected" state with a checkmark, and a brief note of what gets synced.

### Buttons
- "Skip for now" (advances to Step 4)
- "Continue" (advances to Step 4, available whether or not anything was connected)

---

## Step 4: Connect YouTube Playlist

### Purpose
Connect a YouTube playlist for automatic video transcript ingestion.

### Layout
Centered wizard panel, max-width ~550px.

### UI Elements

- **Public playlist note:** "The playlist must be public so Synapse can access it."
- **URL input:** Text field for pasting a YouTube playlist URL, with a "Fetch Playlist" button.
- **Playlist preview:** Once fetched, shows playlist name, video count. If >25 videos: "The first 25 videos will be processed. New videos you add to this playlist will be ingested automatically going forward."
- **Empty playlists are fine.** Confirm it's connected, explain future videos will be ingested as added.
- **Processing note:** "Processing takes about 30-60 seconds per video. This runs in the background - you can start using Synapse while it works."

### Constraints
- No slider or limit picker. Simple rule: first 25 videos get processed, then it becomes a persistent feed.
- Playlist must be public.
- No minimum video count.

### Buttons
- "Skip for now" (marks onboarding complete, enters app)
- "Start Processing & Finish Setup" (kicks off YouTube pipeline in background, marks onboarding complete, enters app)

### This is the final step. Both buttons lead to the main app.

---

## Mock Data Specification

The following mock data is used in Step 0 page previews. It should feel like a real user who works in AI, product strategy, and consulting.

### Sources (for Home and Sources views)
| Title | Type | Age |
|-------|------|-----|
| How AI Agents Actually Work - Full Breakdown | YouTube | 2h ago |
| Product Strategy Sync - Q2 Roadmap | Meeting | 5h ago |
| Market Analysis: Personal Knowledge Tools 2026 | Document | 1d ago |
| Graph RAG vs Traditional RAG - Benchmark Study | Research | 1d ago |
| Notes: Competitive positioning for enterprise | Note | 2d ago |
| Building Knowledge Graphs at Scale | YouTube | 3d ago |

### Anchors (for Explore and Signals views)
| Name | Entity Count | Score | Status |
|------|-------------|-------|--------|
| AI Agent Architecture | 187 | 0.92 | Active |
| Product Strategy | 124 | 0.87 | Active |
| Knowledge Graphs | 98 | 0.84 | Growing |
| Graph RAG | 67 | 0.79 | Active |
| Consulting Delivery | 82 | 0.71 | Active |
| Market Analysis | 143 | 0.83 | Active |
| UX Design (suggested) | - | - | Suggested |

### Council Advisors (for Home, Ask, and Council views)
| Name | Icon | Health | Sources | Insights | Themes |
|------|------|--------|---------|----------|--------|
| AI Strategy | Brain | Strong | 34 | 12 | Multi-Agent, RAG, Tool Use, Embeddings |
| Product Growth | Chart | Growing | 18 | 7 | GTM, Retention, PMF |
| Knowledge Systems | Link | Strong | 22 | 9 | Ontology, Graphs, Embedding |
| Consulting Ops | Briefcase | Thin | 8 | 3 | Delivery, Frameworks |

### Skills (for Signals view)
| Title | Domain | Description |
|-------|--------|-------------|
| Competitive Analysis Framework | Strategy | Structured approach to evaluating market competitors |
| Meeting Debrief Protocol | Operations | Extract decisions, action items, and dynamics from transcripts |

### Stats
- 247 sources, 1,842 nodes, 12 anchors, 8 skills
- Source breakdown: 34 YouTube, 89 Documents, 52 Notes, 41 Research, 31 Meetings

---

## Database Changes

- **New column:** `user_profiles.onboarding_complete` (boolean, default `false`)
- **No new tables required.** Step 1 processing writes to existing `user_profiles` and `knowledge_nodes` tables.

---

## Settings Integration

- A "Replay onboarding" button is added to the Settings view (likely under a General or Account section).
- Clicking it sets `onboarding_complete = false` and navigates to the wizard.

---

## Out of Scope

- Animated transitions between steps (can be added as polish later)
- Onboarding analytics/tracking (which step users drop off at)
- Multi-language support for instructions
- Mobile-responsive onboarding layout (desktop-first)
