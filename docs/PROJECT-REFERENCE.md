# Synapse — Project Development Reference

A comprehensive reference document covering the strategic vision, product architecture, feature development, and technical implementation decisions made throughout the Synapse project. This document serves as persistent context for future development conversations.

---

## 1. The Core Insight

### The Problem with "Second Brain" Tools

Traditional second brain and personal knowledge management tools share a fundamental flaw: they rely on the human to extract value from the system. They store information, maybe organise it, and then wait passively for the user to come back and query it. The result is a graveyard of captured notes that nobody revisits.

The deeper problem is that neither a dense, complex graph interface nor a blank chat input serve daily users effectively. A graph with hundreds of nodes is too overwhelming to scan casually. A chat requires the user to already know what to ask — but if they knew what to ask, they probably wouldn't need the tool.

AI analysis layered on top (weekly summaries, insight dashboards, pattern reports) doesn't solve this either. These push-based approaches put the burden on the user to care about what the AI decided was interesting, at a time the AI chose, in a format the AI picked. Most of it gets ignored.

### Synapse's Breakthrough Positioning

Synapse's answer is not to be another productivity tool or note-taking app. Instead, it positions the personal knowledge graph as **foundational infrastructure for personal AI agent fleets**. The knowledge graph doesn't just store information — it continuously trains, updates, and improves specialised agents that operate on the user's behalf.

The key reframe: **the human is the bottleneck in making full use of accumulated knowledge**. The solution isn't better dashboards or smarter summaries — it's delegating the use of that knowledge to AI agents who can act on it autonomously. The graph becomes the persistent memory layer that gives those agents context no general-purpose model can match.

In the near term, before full agent autonomy, the practical solution is **proactive intelligence delivery through composable briefing systems** — pushing the right knowledge to users' existing workflows (email, Telegram, Slack) at the right time, in a format calibrated to their needs.

### The Defensibility Thesis

Synapse's competitive moat comes from three compounding effects:

1. **Network effects within the graph** — Every new source ingested creates connections to existing nodes, making the entire graph more valuable. The 100th ingestion is worth more than the 10th because it has 99 prior sources to connect against.
2. **Relationship mapping** — Unlike flat note-taking, the graph structure captures how entities relate to each other. This relationship layer is what enables pattern detection, gap identification, and serendipitous discovery.
3. **Data sovereignty** — Tech giants harvest personal data for advertising. Synapse returns that data to the user as an intelligence asset. This resonates with growing awareness of data privacy and positions Synapse as the ethical alternative to platform lock-in.

---

## 2. The Six Knowledge Value Modes

The Knowledge Value Modes framework defines six distinct ways a personal knowledge graph can deliver value to its owner. These modes form the strategic roadmap for Synapse's feature development. Each mode answers a different question the user brings to their knowledge base.

### Mode 1: Orientation — "Where do I stand?"

**Status: Phase 1 implemented, Phase 2 spec complete**

Orientation is about situational awareness. The user wants to understand their current state across projects, commitments, relationships, and knowledge without manually scanning the graph. It answers: What's happening? What needs my attention? What did I miss?

**Implementation: The Orientation Engine**

The Orientation Engine is a composable briefing system built on a meta-agent architecture:

- **Digest Profiles** — User-configured briefings that define what intelligence to gather, how to format it, when to deliver it, and where to send it. A user can have multiple profiles (daily morning brief, weekly review, monthly strategy summary).
- **Modules (Sub-Agents)** — Individual intelligence-gathering tasks within a digest. Each module has a fixed system prompt, user-configurable custom context, access to tools (graph queries, web search), and a structured output format.
- **Templates** — Pre-built module configurations organised by frequency:
  - **Daily templates**: Active Project Status, Today's Priorities, People Pulse, Attention Map, Signals & Alerts, Learning & Knowledge Gaps
  - **Weekly templates**: Weekly Progress Review, Emerging Themes & Patterns, Relationship Dynamics, Decision Audit, Knowledge Velocity, Week Ahead Preparation
  - **Monthly templates**: Strategic Arc Review, Goal Trajectory Analysis, Network Evolution, Knowledge Portfolio Assessment, Hypothesis & Assumption Review, Monthly Priorities Framework
- **Meta-Agent** — The orchestration layer that triggers all sub-agents, aggregates outputs, generates an executive summary across modules, formats appropriately per delivery channel, and dispatches. The meta-agent also has cross-digest awareness to avoid repeating information already covered in other digest profiles.
- **Delivery Channels** — Email (rich HTML), Telegram (concise markdown), Slack (block kit). Each channel can have its own density override (brief/standard/comprehensive).
- **Density control** — Three levels (brief, standard, comprehensive) that govern how much detail each module produces, configurable at the profile level and overridable per channel.

**Database schema**: `digest_profiles`, `digest_modules`, `digest_channels`, `digest_history` tables with full Row Level Security.

**Key design decisions**:
- Templates are frequency-aware (filtered based on selected digest frequency)
- Modules use `sort_order` for drag-and-drop reordering
- Digest history enables cross-digest awareness to prevent content repetition
- Preview functionality lets users test digests in-app before enabling delivery

### Mode 2: Reflection — "What have I learned?"

**Status: Conceptual**

Reflection is retrospective. It helps the user understand what patterns have emerged from their accumulated knowledge over time. It answers: What themes keep recurring? How has my thinking evolved? Where have my assumptions been challenged?

This mode would analyse the temporal dimension of the graph — tracking how nodes and relationships have evolved, which topics have grown or shrunk in prominence, and where contradictions exist between earlier and later knowledge. It enables decision archaeology (reviewing the context of past decisions) and bias detection (identifying recurring blind spots).

### Mode 3: Anticipation — "What's coming?"

**Status: Conceptual**

Anticipation is forward-looking. It uses the graph to project likely futures based on current trajectories and dependencies. It answers: What risks are emerging? What dependencies could break? What opportunities are converging?

This mode would traverse dependency chains, identify stale commitments approaching deadlines, flag risk nodes with growing connection density, and surface goal drift (where stated objectives diverge from actual attention allocation based on ingestion patterns).

### Mode 4: Discovery — "What am I missing?"

**Status: Conceptual**

Discovery is about serendipity — surfacing unexpected connections across domains that the user would never think to query. It answers: What surprising patterns exist in my knowledge? What connections span different projects, topics, and time periods?

This mode would identify concept collisions (when an idea from one domain directly relates to a problem in another), weak tie discovery (dormant relationships with latent value), knowledge gap identification (topics with many inbound references but sparse depth), and orphaned high-potential nodes (recently created entities with few connections that might deserve enrichment).

The key insight from development discussions: discovery should be triggered rather than scheduled — the system notices patterns emerging (e.g., three sources about the same topic in one week) and surfaces the connection at that moment, when the user's attention is already there and relevance is undeniable.

### Mode 5: Execution — "What should I do next?"

**Status: Conceptual**

Execution is operational. It uses the graph to inform and sequence concrete actions. It answers: What are my highest-leverage next steps? What blockers can be resolved? What dependencies need coordination?

This mode would rank actions by leverage (those connected to multiple projects), identify parallelisable work streams, surface delegation opportunities (when a person node has capacity and relevant expertise), and track commitment fulfilment rates to calibrate future planning.

### Mode 6: Institutionalisation — "How do I preserve this?"

**Status: Conceptual**

Institutionalisation is about converting personal knowledge into durable, transferable assets. It answers: What knowledge should be codified? How do I ensure continuity if I move on?

This mode would identify knowledge that exists only in the graph (not documented elsewhere), surface tribal knowledge patterns (insights held by single person nodes), generate structured documentation from graph traversals, and maintain a "knowledge health" score that tracks how well the graph covers critical domains.

A particularly powerful sub-case: the graph becomes the persistent memory for AI agent fleets. Institutionalisation means the graph continuously updates Claude Skills, agent configurations, and operational playbooks so that the user's AI workforce improves automatically as the knowledge base grows.

---

## 3. Ingestion Pipeline Architecture

### Meeting Transcripts

Meeting transcripts were the first major ingestion source, handled through the main Injection Hub (InjectionHub.tsx). The pipeline works as follows:

1. **Input** — User pastes meeting transcript text into the ingestion interface, selects "Meeting" as source type
2. **Configuration** — User can optionally:
   - Select an extraction mode (Comprehensive, Strategic, Actionable, Relational)
   - Choose anchor emphasis level (None, Light, Moderate, Strong)
   - Select specific anchors to prioritise
   - Add custom extraction guidance
3. **Source persistence** — Raw transcript saved to `knowledge_sources` table with metadata
4. **AI extraction** — Transcript sent to Google Gemini 2.0 Flash with a composed system prompt built from:
   - Base extraction instructions (entity ontology, relationship types, core rules)
   - Extraction mode template (determines entity/relationship focus)
   - User profile context (professional background, interests, preferences)
   - Anchor context with emphasis level
   - Custom user guidance
5. **Entity/relationship creation** — Gemini returns structured JSON with nodes and edges. Nodes saved to `knowledge_nodes`, edges to `knowledge_edges`
6. **Embedding generation** — Each node gets a 768-dimensional vector embedding via Gemini's text-embedding-004 model, stored in pgvector for semantic search
7. **Cross-connection** — New nodes compared against existing graph. Gemini identifies potential connections and creates cross-reference edges
8. **Review** — User reviews extracted entities and relationships before final save, with ability to edit labels, remove noise, and adjust entity types

**Extraction modes** (defined in `config/extractionModes.ts`):
- **Comprehensive** — Maximum entity capture, all relationship types, deepest analysis. Best for research papers, detailed notes, technical documentation.
- **Strategic** — High-level concepts, decisions, strategic insights only. Skip minor details. Best for executive summaries, strategic planning, market analysis.
- **Actionable** — Actions, goals, blockers, decisions, ownership, deadlines. Best for project planning, sprint retrospectives, implementation plans.
- **Relational** — Emphasis on connections between concepts over individual entities. Best for discovering patterns, building context, understanding influence flows.

**Anchor emphasis levels** control how strongly the extraction prompt instructs Gemini to find connections to the user's anchor nodes:
- **None** — No anchor context in prompt
- **Light** — Anchors listed as "areas of interest" for optional reference
- **Moderate** — Explicit instruction to find connections where they naturally exist
- **Strong** — Directive to prioritise anchor-related extraction

### YouTube Ingestion

YouTube is the second major ingestion source, designed for automated, continuous knowledge capture from video content. This pipeline is significantly more complex due to its asynchronous, multi-stage architecture.

#### Discovery: How Videos Are Found

Two discovery mechanisms, both using public APIs:

**Channel-based discovery** (`api/youtube/poll.ts`):
- User subscribes to YouTube channels via the Automation Hub
- Cron job runs every 15 minutes
- Fetches channel RSS feed (`youtube.com/feeds/videos.xml?channel_id=...`)
- Parses XML to extract video IDs, titles, thumbnails, publish dates
- Filters by minimum duration (fetches each video's page HTML and extracts duration via regex patterns)
- Queues qualifying videos in `youtube_ingestion_queue`

**Playlist-based discovery** (`api/youtube/poll-playlist.ts`):
- User connects public YouTube playlists with a generated Synapse code (SYN-XXXX format)
- Each playlist is linked to specific anchors, extraction modes, and custom instructions
- Cron job runs every 5 minutes
- Fetches playlist items via YouTube Data API v3 (`/playlistItems` endpoint, 50 items per page, max 200)
- Deduplicates against existing queue items
- Queues new videos with playlist-specific settings (extraction mode, anchor emphasis, linked anchors)

**Key architectural decision**: Public playlist URLs + YouTube Data API v3 key approach, rather than OAuth-based Google account sync. This avoids the complexity and privacy concerns of accessing user's private watch history, while still enabling powerful automated ingestion through curated playlists.

#### Selection: What Gets Processed

Videos enter `youtube_ingestion_queue` with status `pending`. The processing pipeline (`api/youtube/process.ts`) runs as a Vercel cron job every 5 minutes, picking up to 2 pending items per batch (20 when user clicks "Process Now").

Queue items carry inherited settings from their source (channel or playlist):
- `extraction_mode` — Which extraction template to use
- `anchor_emphasis` — How strongly to prioritise anchor connections
- `linked_anchor_ids` — Specific anchors to reference during extraction
- `custom_instructions` — Free-text guidance for the AI

When both channel and playlist settings exist (a video could belong to both), playlist settings take precedence as more specific.

#### Extraction: Transcript Retrieval

Transcript extraction uses a tiered fallback system:

1. **Tier 1: youtube-caption-extractor** (npm package) — Free, fast (~15s timeout), ~90% success rate on videos with captions. First choice for cost efficiency.
2. **Tier 2: Innertube API** — Direct call to YouTube's internal API. Free, ~15s timeout, medium success rate. Fallback when npm package fails.
3. **Tier 3: Apify** (pintostudio/youtube-transcript-scraper actor) — Paid per-use, ~120s timeout, very high success rate. Cloud-based scraper that handles edge cases the free tiers miss.

If all three tiers fail, the queue item is marked `failed` with a retry counter (up to 3 retries).

Once a transcript is obtained, it flows into the same Gemini extraction pipeline as meeting transcripts (entity extraction, relationship inference, embedding generation, cross-connection) with the queue item's specific extraction settings applied.

#### The "Vercel Serverless" Constraint

A critical architectural constraint: every API endpoint under `api/youtube/` is deployed as an independent Vercel serverless function. Vercel bundles each file separately, meaning:

- **No shared local imports** — Each function must be self-contained. Helper files in `_utils/` are not automatically bundled with files that import them.
- **No module-level side effects** — If an import fails, the entire function crashes with `FUNCTION_INVOCATION_FAILED` before any code executes.
- **All helpers inline** — Functions like `verifyAuth()`, `extractPlaylistId()`, `generateSynapseCode()`, `queuePlaylistVideos()` must be defined within each file that uses them.

This constraint was the root cause of a persistent deployment bug (see Technical Lessons below).

#### Database Schema

**youtube_channels**: Stores channel subscriptions with `channel_id`, `channel_name`, `channel_url`, connection settings (extraction mode, anchor emphasis, linked anchors, custom instructions), and monitoring metadata.

**youtube_playlists**: Stores playlist connections with `playlist_id`, `playlist_url`, `synapse_code` (SYN-XXXX identifier), linked anchors, extraction settings, `known_video_count`, and connection status (`active`/`paused`/`error`).

**youtube_ingestion_queue**: The processing queue with `video_id`, `video_url`, `video_title`, `thumbnail_url`, `status` (pending/fetching_transcript/extracting/complete/failed), `retry_count`, `transcript` (once fetched), `nodes_created`/`edges_created` (post-extraction metrics), and foreign keys to `channel_source_id` and `playlist_source_id`.

#### UI Architecture

The YouTube ingestion UI is split across two navigation areas:

**Automation Hub** (AutomatePanel.tsx) — Horizontal tab bar with "Meeting Transcripts | YouTube | Custom API Integration". The YouTube tab contains PlaylistHub.tsx, which provides:
- Inline playlist connection form (paste URL → connect)
- Expandable playlist cards showing videos with checkboxes
- "Add to Queue" action for selected videos
- Queue status banner

**Queue Panel** (QueueHub.tsx) — Separate top-level navigation item showing:
- 5-step processing progress per video (Queued → Fetching Transcript → Extracting Knowledge → Connecting to Graph → Complete)
- Filter bar (All/Pending/Processing/Complete/Failed)
- Retry and delete actions per item
- "Process Now" button to trigger immediate batch processing

---

## 4. Technical Architecture Summary

### Stack

- **Frontend**: React + Vite, D3.js for graph visualisation, Tailwind CSS with cyber-themed design system (slate backgrounds, gold/amber anchors, cyan accents)
- **Backend**: Supabase (PostgreSQL) with Row Level Security for multi-user data isolation
- **AI**: Google Gemini 2.0 Flash for extraction and Graph RAG, Gemini text-embedding-004 for vector embeddings
- **Hosting**: Vercel (automatic deployment from GitHub)
- **Icons**: Lucide React

### Key Services

- `services/gemini.ts` — All AI operations: extraction, embedding generation, entity resolution, cross-connections, Graph RAG queries, deep research
- `services/supabase.ts` — All database operations: CRUD, semantic search (pgvector), authentication, source management
- `services/anchorService.ts` — Anchor promotion/demotion, anchor context building
- `services/extractionSettings.ts` — User extraction preferences persistence
- `utils/promptBuilder.ts` — Composable system prompt construction from modular context layers (profile + anchors + mode + guidance)
- `config/extractionModes.ts` — Four extraction mode templates with per-mode prompt additions

### Graph Data Model

**Nodes** (`knowledge_nodes`): id, label, entity_type, description, confidence, is_anchor, source/source_type/source_url/source_id, embedding (vector 768), tags, user_id

**Edges** (`knowledge_edges`): id, source_node_id, target_node_id, relation_type, evidence, user_id

**Sources** (`knowledge_sources`): id, title, content, source_type, source_url, metadata (JSONB), user_id

### Entity Ontology

Person, Organisation, Team, Topic, Project, Goal, Action, Risk, Blocker, Decision, Insight, Question, Idea, Concept, Takeaway, Lesson, Document, Event, Location, Technology, Product, Metric, Hypothesis, Anchor

### Relationship Types

Positive: leads_to, supports, enables, created, achieved, produced
Negative: blocks, contradicts, risks, prevents, challenges, inhibits
Neutral: part_of, relates_to, mentions, connected_to, owns, associated_with

### Graph View Lenses

| Lens | Filter | Purpose |
|------|--------|---------|
| All | No filter | Holistic view |
| Social | Person, Organisation | People and relationships |
| Strategic | Goal, Project, Decision | Planning and strategy |
| Operational | Action, Risk, Blocker | Execution tracking |
| Creative | Topic, Insight, Idea | Ideation and patterns |
| Pathways | All (directional) | Flow visualisation |
| AnchorFocus | Selected anchor + neighbours | Isolated context view |

---

## 5. Technical Lessons and Debugging History

### The YouTube Pipeline Bug (Critical Case Study)

**Symptom**: Persistent "string doesn't match the expected pattern" error when connecting YouTube playlists. Every fix attempt (three rounds) failed to resolve it.

**Misdirection**: Initial diagnosis blamed Supabase's PostgREST layer, hypothesising that it was validating UUID[] arrays and URL-format columns during INSERT. Three fix rounds focused on defensive payload construction: excluding null fields, two-stage INSERTs (minimal insert + update for optionals), type coercion.

**Actual root cause**: Vercel serverless functions were crashing with `FUNCTION_INVOCATION_FAILED` before any code executed. The functions imported modules that didn't exist in the deployment:

1. `api/youtube/playlists.ts` imported from `_utils/playlist-helpers` — file never created
2. `api/youtube/poll-playlist.ts` imported from `_utils/playlist-helpers` — same missing file
3. `api/youtube/process.ts` imported from `services/transcriptExtractor` — file never created (transcript logic actually lives inline and in `services/apify.ts`)
4. `api/youtube/poll.ts` inserted `duration_seconds` into queue — column doesn't exist in database

**Why it was hard to diagnose**: The Vercel runtime logs showed `FUNCTION_INVOCATION_FAILED` but the frontend displayed a generic 500 error. The "string doesn't match pattern" message was coming from a different code path that executed only when the function happened to partially load. The GET endpoint failing with the same error confirmed it was a file-level crash, not a payload validation issue.

**Resolution**: Complete rewrite of `playlists.ts` and `poll-playlist.ts` with zero local imports (all helpers defined inline). Surgical edits to `process.ts` (remove dead import) and `poll.ts` (remove non-existent column from insert payload).

**Lesson**: In Vercel serverless deployments, always verify that every import resolves to an existing file. A single bad import crashes the entire function silently. Check Vercel runtime logs (not just frontend errors) to distinguish between code-level errors and deployment-level crashes.

### PostgREST Defensive Patterns

Even though PostgREST wasn't the root cause of the YouTube bug, the defensive INSERT patterns developed during debugging are good practice:

- Only include nullable fields in INSERT payloads when they have truthy values
- For UUID[] array columns (like `linked_anchor_ids`), omit empty arrays — let the database DEFAULT handle it
- For URL-format columns, only include when the value is a valid, non-empty string
- Use `.maybeSingle()` instead of `.single()` for queries that might return zero rows (avoids PostgREST throwing on empty results)

### Two-Stage INSERT Strategy

For tables with many optional columns that PostgREST might validate aggressively:

1. **INSERT** with only NOT NULL / required fields
2. **UPDATE** to add optional fields (only those with values)

This bypasses PostgREST's INSERT payload validation for complex column types while ensuring all data is eventually persisted.

---

## 6. Ingestion Enhancement Phases (Completed)

### Phase 1: Foundation (PRDs 1-2)

**PRD 1 — User Profile System**: Settings page with optional profile fields (professional context, personal interests, processing preferences). Profile data stored in `user_profiles` table, automatically injected into extraction system prompts via `utils/profileContext.ts`.

**PRD 2 — Global Anchor System**: Anchor management interface allowing users to designate specific nodes as high-priority focal points. Anchors stored with `is_anchor: true` flag on `knowledge_nodes`. Visual distinction (amber styling) in graph view. Anchor context builder (`utils/anchorContext.ts`) formats selected anchors for inclusion in extraction prompts.

### Phase 2: Advanced Extraction (PRD 3)

**PRD 3 — Extraction Guidance & Mode System**: Four extraction mode templates (Comprehensive, Strategic, Actionable, Relational). Default extraction settings in Settings page. Per-source customisation with collapsible "Advanced Options" in ingestion UI. Centralised prompt builder (`utils/promptBuilder.ts`) that composes the final system prompt from modular context layers. Source-to-anchor conversion feature. Extraction session tracking via `extraction_sessions` table.

### Phase 3: Intelligence (Deferred)

Originally planned to include anchor suggestion system, bias mitigation, serendipity mode, and feedback loops. Deferred after recognising that anchors shouldn't be the sole arbiter of relevance — valuable information can exist outside current anchors, and over-weighting them could limit discovery. Decision made to ship PRDs 1-3 and validate through real-world usage before adding complexity.

---

## 7. PRDs Generated in This Project

| PRD | File | Status | Summary |
|-----|------|--------|---------|
| Orientation Engine Phase 1 | `synapse-orientation-prd.md` | Spec complete | Composable digest system with meta-agent architecture, 6 daily templates, delivery channels, scheduling |
| Orientation Engine Phase 2 | `synapse-orientation-phase2-prd.md` | Spec complete | 6 weekly + 6 monthly templates, frequency-aware template filtering, density tooltip fix, channel card uniformity |
| YouTube Playlist Auto-Ingestion | `synapse-youtube-playlist-prd.md` | Implemented (with bugs) | Public playlist + API key approach, playlist code system, tiered transcript extraction, queue integration |
| YouTube Playlist Fix (v1) | `synapse-youtube-playlist-fix-prd.md` | Superseded | Two-stage INSERT strategy for PostgREST validation (was addressing wrong root cause) |
| YouTube Pipeline Comprehensive Fix | `synapse-youtube-pipeline-fix-prd.md` | Current | Fixes all 4 broken serverless functions: rewrite playlists.ts + poll-playlist.ts, fix imports in process.ts + poll.ts |

---

## 8. Open Architecture Decisions

1. **Graph RAG implementation** — Hybrid search (keyword + semantic vector search) implemented for the chat interface. Chunking system splits source content for better context assembly during retrieval. Ongoing refinement needed for retrieval accuracy.

2. **Cross-connection quality** — Gemini compares new nodes against existing graph nodes to create connecting edges. Quality is variable and depends on graph density. More nodes = better cross-connections, but also more noise. May need confidence thresholds tuned over time.

3. **Agent fleet vision** — The long-term vision of the graph as persistent memory for AI agent fleets (where anchors update Claude Skills automatically) is compelling but architecturally distant. Current focus remains on the six Knowledge Value Modes as the near-term product roadmap.

4. **B2B pivot potential** — The Tokai Project (partnership with InfoCert and Bird & Bird for AI TRiSM services) represents a potential enterprise market using the same context graph technology for compliance and governance. Enterprise context graphs for AI agent audit trails is a growing market ($1.07B → $6.9B at 36.6% CAGR).
