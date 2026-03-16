# CHAT-ROUTING-LOGIC.md — Context-Aware RAG Routing Architecture

## Purpose

This document defines the architectural logic behind Synapse's context-aware chat routing system. It exists so that any developer (human or AI agent) adding a new redirect to the Ask/chat interface understands:

1. **Why** different entry points produce different pipeline configurations
2. **How** to design a new entry point's retrieval strategy
3. **What** each lever controls in the pipeline

Read this document before creating any new navigation path that sends the user to the Ask view.

---

## Core Principle

**The more context the user gives you at click time, the less searching you should do.**

When a user clicks a button next to a specific source, entity, or relationship, they are telling us exactly what they care about. The pipeline should use that signal to eliminate noise, not run the same broad search as if the user had typed a freeform question.

The corollary: **never repeat what the user can already see.** If they clicked from a panel showing an entity's description, confidence score, and tags, the AI response should go deeper, not summarize what's visible.

---

## Architecture Overview

### The ChatEntryContext Object

Every navigation to the Ask view carries a `ChatEntryContext`:

```typescript
interface ChatEntryContext {
  autoQuery: string           // Visible in chat as the user's message
  systemDirective: string     // Hidden instruction prepended to Gemini system prompt
  queryConfig: Partial<QueryConfig>  // Mindset, tool mode, model tier overrides
  scope?: ChatScope           // Database retrieval constraints
  entryPoint: ChatEntryPoint  // Enum for routing + analytics
  displayLabel?: string       // Optional status bar label
  metadata?: Record<string, string>  // Arbitrary key-value pairs for tracing
}
```

### The Pipeline Router

`src/services/ragRouter.ts` receives the `ChatEntryContext` and executes a tailored retrieval pipeline based on `entryPoint`. Each entry point defines:

1. **Which tables to query** (and which to skip)
2. **How to filter** each query (scope-locking)
3. **What parameters to use** (chunk limits, traversal depth, similarity thresholds)
4. **What to tell Gemini** (system directive)
5. **How to configure the response** (mindset, tool mode, temperature)

### Flow

```
User clicks action button
  → Builder function creates ChatEntryContext
  → navigate('/ask', { state: { chatContext } })
  → AskView reads context
  → useRAGQuery.sendMessage(query, context)
  → ragRouter.routedQuery(query, userId, history, context)
  → Entry-point-specific pipeline executes
  → Gemini generates with tailored system prompt
  → Response renders in ChatMessageList
```

---

## The Five Levers

Every entry point configures these five levers. When designing a new entry point, decide each one explicitly.

### Lever 1: Scope (Database Filtering)

**What it controls:** Which rows the pipeline is allowed to retrieve from `source_chunks`, `knowledge_nodes`, and `knowledge_edges`.

**Options:**

| Mode | Behavior | When to Use |
|------|----------|-------------|
| No scope | All tables searched broadly via keyword + semantic | Freeform questions, open exploration |
| Soft scope | Prefer results matching scope IDs, but allow broader fallback | Entity exploration, anchor-related queries |
| Hard scope | ONLY retrieve from scoped IDs; skip keyword/semantic search entirely | Single-source chat, two-source comparison |

**Rule of thumb:** If the user clicked on a specific database object (source, entity), scope to it. Hard scope when the user's intent is focused ("chat with THIS source"). Soft scope when they want to discover outward ("explore this entity's connections").

### Lever 2: System Directive (Hidden Prompt)

**What it controls:** A block of text prepended to the Gemini system prompt that the user never sees. It shapes the response's structure, tone, and focus.

**Principles for writing directives:**

1. **State what the user already knows.** "The user can see this entity's label, type, description." This prevents the AI from wasting tokens on repetition.
2. **Give structural instructions.** "Present results as a ranked list." "Structure as: Shared Themes → Unique → Tensions → Synthesis." The AI follows formatting instructions well when they're explicit.
3. **Specify what to prioritize.** "Focus on cross-source appearances." "Emphasize the evidence, not the conclusion." This steers depth.
4. **Include dynamic context.** Inject actual values: edge evidence, source summaries, anchor labels. The more concrete data in the directive, the better the response.
5. **Keep it under 300 words.** Long directives dilute attention. Be precise.

### Lever 3: Query Config (Mindset + Tool Mode + Model Tier)

**What it controls:** The behavioral profile of both retrieval and generation.

**Mindset selection guide:**

| Mindset | Temperature | Best For |
|---------|-------------|----------|
| Factual | 0.1 | Single-source deep dive, specific fact retrieval |
| Analytical | 0.3 | Relationship explanation, cause-and-effect, implications |
| Comparative | 0.2 | Two-source comparison, entity-vs-entity analysis |
| Exploratory | 0.5 | Open discovery, lateral connections, "what else?" |

**Tool mode selection guide:**

| Tool Mode | Chunks | Nodes | Hops | Best For |
|-----------|--------|-------|------|----------|
| Quick | 5 | 5 | 1 | Focused questions with known targets |
| Deep | 15 | 15 | 3 | Broad exploration, multi-concept queries |
| Timeline | 12 | 10 | 2 | Chronological ordering, evolution tracking |

**Rule of thumb:** Tight intent → factual + quick. Broad curiosity → exploratory + deep. Two things being compared → comparative + deep. Time-based question → any mindset + timeline.

### Lever 4: Retrieval Strategy (Which Tables, Which Queries)

**What it controls:** The exact database operations executed before Gemini generation.

The standard pipeline runs 8+ parallel queries across 4 tables. Context-aware routing can skip entire query categories:

| Query Category | Standard Pipeline | When to Skip |
|----------------|-------------------|--------------|
| Query decomposition (Gemini) | Always | When you have exact IDs — no need to decompose a question about a known entity |
| Keyword search on `knowledge_sources` | Always | When scope provides source IDs directly |
| Keyword search on `knowledge_nodes` | Always | When scope provides entity IDs, or when the query is source-level (not entity-level) |
| Keyword search on `source_chunks` | Always | When scope provides source IDs (fetch chunks directly by source_id) |
| Semantic search on `source_chunks` (vector RPC) | Always | When hard-scoped to specific sources — semantic search would pull in unrelated sources |
| Semantic search on `knowledge_nodes` (vector RPC) | Always | When the query is about a specific relationship (we have both entity IDs) or source-level |
| Graph traversal (`knowledge_edges` BFS) | Always | When hard-scoped to a single source's entities (internal edges only) |
| Source enrichment (`knowledge_sources` metadata) | Always | When source metadata already fetched in scope step |

**Key insight:** Every skip is a performance win AND a relevance win. Fewer irrelevant results means less noise in the context window, which means better Gemini output.

### Lever 5: Context Assembly (What Gets Sent to Gemini)

**What it controls:** How the retrieved data is formatted into the system prompt's context sections.

**Decisions per entry point:**

| Decision | Options |
|----------|---------|
| Chunk ordering | By similarity (default), by chunk_index (document order), by date (timeline) |
| Chunk budget | Per-source balanced (comparison), single-source high-limit, reduced (entity-only) |
| Node summaries | From keyword matches (default), from source entities, from edge neighbors, skip entirely |
| Relationship paths | From graph traversal (default), from direct edge fetch, skip entirely |
| Source metadata | Injected as "matched documents" note (default), injected into directive (comparison), skipped |

---

## Entry Point Design Template

When adding a new redirect to Ask, fill in this template:

```
### Entry Point: [name]

**Origin:** Where the user clicks (view, panel, component)
**User intent:** What they're trying to learn (one sentence)
**Available IDs:** What database IDs are known at click time

**Scope:**
- sourceIds: [list or none]
- entityIds: [list or none]
- anchorIds: [list or none]
- mode: hard | soft

**Tables to query:**
- knowledge_sources: [query or SKIP]
- knowledge_nodes: [query or SKIP]
- knowledge_edges: [query or SKIP]
- source_chunks: [query or SKIP]
- Vector RPCs: [query or SKIP]

**Retrieval to skip:**
- [ ] Query decomposition
- [ ] Keyword search (sources)
- [ ] Keyword search (nodes)
- [ ] Keyword search (chunks)
- [ ] Semantic search (chunks)
- [ ] Semantic search (nodes)
- [ ] Graph traversal

**Query config:**
- Mindset: [factual | analytical | comparative | exploratory]
- Tool mode: [quick | deep | timeline]
- Model tier: [fast | thorough]

**System directive:** (write it out — under 300 words)

**Context assembly notes:**
- Chunk ordering: [similarity | document order | chronological]
- Chunk budget: [number per source, or total]
- Special formatting: [any custom context sections]

**Follow-up behavior:**
- Scope persists: [yes | no]
- What resets it: [specific triggers]
```

---

## The Six Current Entry Points (Summary)

| Entry Point | Scope Mode | Mindset | Tool Mode | Skips | Primary Table |
|-------------|-----------|---------|-----------|-------|---------------|
| `entity_explore` | Soft (entity seed) | Exploratory | Deep | Keyword search (all 3), decomposition | `knowledge_edges` (direct), `source_chunks` (by source_id) |
| `entity_find_similar` | Soft (entity seed) | Exploratory | Deep | ALL chunks, ALL keyword search, decomposition | `knowledge_nodes` (vector RPC with entity's own embedding) |
| `relationship_chat` | Hard (both entities) | Analytical | Quick | Semantic search, keyword search, decomposition, broad traversal | `knowledge_edges` (direct edge), `source_chunks` (both source_ids) |
| `source_chat` | Hard (single source) | Factual | Quick | ALL search, decomposition, traversal | `source_chunks` (all, high limit), `knowledge_nodes` (by source_id) |
| `source_anchor_relate` | Soft (source + anchor) | Analytical | Deep | Keyword search, decomposition | `source_chunks` (source), `knowledge_edges` (anchor neighborhood) |
| `source_compare` | Hard (both sources) | Comparative | Deep | ALL search, decomposition, traversal | `source_chunks` (balanced 50/50), `knowledge_edges` (cross-source) |

---

## Patterns & Anti-Patterns

### Do

- **Use the entity's stored embedding** for similarity queries instead of re-embedding the auto-query text. The stored embedding represents the entity precisely; the auto-query text is a lossy paraphrase.
- **Fetch chunks by source_id** when you have it. Direct fetch by foreign key is faster and more accurate than keyword/semantic search.
- **Balance chunk budgets** in comparison queries. If one source has 40 chunks and the other has 5, sending 15 from the first and 5 from the second produces a lopsided comparison. Enforce equal limits.
- **Include edge evidence** in the system directive. The `evidence` column on `knowledge_edges` contains the extraction's rationale — it's often the most useful single piece of context for relationship queries.
- **Skip aggressively.** Every query you skip is both faster and more relevant. The standard pipeline's 8+ parallel queries are for freeform questions. Purpose-built pipelines should run 3-5 queries.

### Don't

- **Don't keyword-search for things you have IDs for.** If you know `source_id = abc123`, don't search `knowledge_sources WHERE title ILIKE '%...'` — just fetch by ID.
- **Don't run semantic search when hard-scoped.** Semantic search finds similar content across the entire graph. If you're locked to one source, it will pull in irrelevant sources that happen to be semantically similar.
- **Don't decompose queries for known-target entry points.** Query decomposition breaks complex questions into sub-queries. If the user clicked on a specific entity, there's nothing to decompose.
- **Don't send the auto-query through query decomposition.** The auto-query is a generated template, not a natural user question. Decomposing "Tell me about X (Y type). What is its significance..." produces worse sub-queries than the entity label alone.
- **Don't let graph traversal seeds come from keyword search when you have entity IDs.** Keyword search on "Tell me about Dario Amodei" might match a node labeled "Dario" and a node labeled "Amodei" separately. Starting traversal from the actual entity ID finds the real neighborhood.

---

## Follow-up Persistence

When a user arrives via a context-routed entry point, their subsequent messages inherit the scope and directive until explicitly reset. This is critical for natural conversation flow.

**Example:** User clicks "Chat with source" on "Q3 Strategy Review" → first message is auto-fired, scoped to that source → user types "What about the budget numbers?" → this follow-up is STILL scoped to Q3 Strategy Review, not a graph-wide search for "budget numbers."

**How it works:** `useRAGQuery` stores the active `ChatEntryContext` in a `useRef`. On follow-up messages (no new `chatContext`), the hook reuses the stored scope and directive with the new question text.

**Reset triggers:**
- `clearChat()` (user clears conversation)
- New `ChatEntryContext` arrives (user navigates away and back with a different context)
- User manually changes scope via the toolbar
- Navigation away from Ask without returning

---

## Extending for New Features

### Adding a New Entry Point

1. Add the entry point name to `ChatEntryPoint` union type in `src/types/chatRouting.ts`
2. Create a builder function in `src/config/chatEntryContexts.ts`
3. Add a case to the router switch in `src/services/ragRouter.ts`
4. Wire the navigation in the originating component
5. Document using the template above

### Adding a New Scope Dimension

To add a new scope field (e.g., `tagIds`, `dateRange`):

1. Add the field to `ChatScope` in `src/types/chatRouting.ts`
2. Handle it in `ragRouter.ts` — define what it means for retrieval (e.g., `dateRange` adds a `WHERE created_at BETWEEN` clause to chunk and source queries)
3. Update relevant builder functions to populate it
4. Document the new dimension in this file

### Adding a New Mindset

To add a new query mindset (e.g., `creative`, `critical`):

1. Add to `QUERY_MINDSETS` in `src/config/queryMindsets.ts` with `promptAddition` and `temperatureOverride`
2. Add to `QueryMindsetId` union type in `src/types/rag.ts`
3. Reference in builder functions where appropriate
4. No router changes needed — mindset is resolved in the generation step, not the retrieval step

---

## Performance Impact

Context-aware routing should be **faster** than the standard pipeline for every non-direct entry point:

| Entry Point | Standard Pipeline Queries | Routed Pipeline Queries | Estimated Speedup |
|-------------|--------------------------|------------------------|-------------------|
| `source_chat` | 8+ parallel | 3 sequential | ~60% faster |
| `source_compare` | 8+ parallel | 4 sequential | ~50% faster |
| `relationship_chat` | 8+ parallel | 4 sequential | ~50% faster |
| `entity_explore` | 8+ parallel | 5 parallel | ~30% faster |
| `entity_find_similar` | 8+ parallel | 3 parallel | ~50% faster |
| `source_anchor_relate` | 8+ parallel | 6 mixed | ~20% faster |

The speedup comes from skipping unnecessary queries, not from optimizing existing ones. The Gemini generation step (the slowest part) is unaffected.

---

## Relationship to Other Systems

| System | Interaction |
|--------|------------|
| **Extraction pipeline** (PRD-7) | Produces the entities, edges, and chunks that routing queries. Quality of extraction directly impacts routing quality. |
| **Cross-connections** (PRD-7) | Cross-source edges are critical for `source_compare` and `source_anchor_relate`. Without them, comparison queries lose their most valuable signal. |
| **Digest/Orient engine** (PRD-13) | Should route through `routedQuery` with a `digest_module` entry point. Each digest module would have its own scope and directive. |
| **Chrome extension** (PRD-14) | Should use `source_chat` routing when the user captures and immediately asks about a web page or video. |
| **Anchor-pipeline binding** (future) | When anchors are bound to pipelines, the `source_anchor_relate` entry point gains richer context — it can reference the pipeline binding rather than just entity overlap. |
| **Settings page** (future) | User-configured "always include this in my prompts" would be prepended to every system directive regardless of entry point. |
