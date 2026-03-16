# PRD-17 — Context-Aware Chat Routing

## Header

- **PRD Number:** 17
- **Title:** Context-Aware Chat Routing
- **Phase:** 5 — Polish + Advanced
- **Dependencies:** PRD 8 (Ask + RAG pipeline), PRD 6 (Home view), PRD 4 (Browse tab), PRD 5 (Graph tab)
- **Estimated Complexity:** High

---

## 1. Objective

Replace the flat `{ autoQuery: string }` navigation pattern with a structured `ChatEntryContext` system that customizes the RAG pipeline per entry point. When a user clicks "Chat with source" on a specific document, the pipeline should scope retrieval to that source, use a factual mindset, and inject a hidden system directive telling Gemini how to structure its answer. When they click "Compare sources," the pipeline should lock to both sources, balance chunks equally, and use comparative framing. Every redirect to Ask should carry enough context to produce a purpose-built response on the first try.

This is a backend-only PRD. No UI changes to the Ask view itself. The user sees the same chat interface — the intelligence is entirely in how the pipeline configures itself based on where the user came from.

---

## 2. What Gets Built

### 2.1 New Type Definitions

**File: `src/types/chatRouting.ts`** (new)

```typescript
// ─── Entry Point Enum ────────────────────────────────────────────────────────

export type ChatEntryPoint =
  | 'direct'                  // Nav rail, command palette, or manual navigation
  | 'entity_explore'          // "Explore with AI" from entity detail
  | 'entity_find_similar'     // "Find Similar" from entity detail
  | 'relationship_chat'       // "Chat about this relationship" from edge detail
  | 'source_chat'             // "Chat with source" from source card
  | 'source_anchor_relate'    // "Ask how this relates" from source × anchor
  | 'source_compare'          // "Compare sources" from source × related source
  | 'suggestion_pill'         // Empty state suggestion pill
  | 'explore_entity_browse'   // "Explore with AI" from Entity Browser
  | 'explore_node_detail'     // "Explore with AI" from NodeDetailPanel
  | 'explore_source_connection' // "Ask about connection" from ExploreMetadataPanel

// ─── Scope Definition ────────────────────────────────────────────────────────

export interface ChatScope {
  sourceIds?: string[]
  entityIds?: string[]
  anchorIds?: string[]
  mode: 'hard' | 'soft'
}

// ─── Entry Context ───────────────────────────────────────────────────────────

export interface ChatEntryContext {
  autoQuery: string
  systemDirective: string
  queryConfig: Partial<QueryConfig>
  scope?: ChatScope
  entryPoint: ChatEntryPoint
  displayLabel?: string
  metadata?: Record<string, string>
}
```

### 2.2 Entry Context Builder Functions

**File: `src/config/chatEntryContexts.ts`** (new)

Six builder functions, one per Home Feed entry point, plus builders for Explore view entry points. Each function accepts the relevant data objects and returns a complete `ChatEntryContext`.

```typescript
buildEntityExploreContext(node: KnowledgeNode): ChatEntryContext
buildEntityFindSimilarContext(node: KnowledgeNode): ChatEntryContext
buildRelationshipChatContext(conn: UnifiedConnection): ChatEntryContext
buildSourceChatContext(source: KnowledgeSource | FeedItem['source']): ChatEntryContext
buildSourceAnchorRelateContext(source: { id: string; title: string }, anchor: { nodeId: string; label: string }): ChatEntryContext
buildSourceCompareContext(sourceA: { id: string; title: string }, sourceB: { id: string; title: string }): ChatEntryContext
```

Each builder is a pure function with no side effects. See Section 5 for the exact system directive and query config per entry point.

### 2.3 Modified RAG Pipeline

**File: `src/services/rag.ts`** (modified)

The `queryGraph` function signature gains an optional `ChatEntryContext` parameter. When present, the pipeline branches based on `entryPoint`:

- **Scope-locked retrieval:** If `scope.sourceIds` is set with `mode: 'hard'`, skip keyword/semantic search — fetch chunks directly by source ID.
- **Entity-seeded traversal:** If `scope.entityIds` is set, use those IDs as graph traversal seeds instead of keyword search results.
- **Directive injection:** If `systemDirective` is present, prepend it to the Gemini system prompt before the standard RAG instructions.
- **Config override:** If `queryConfig` fields are present, they override `DEFAULT_QUERY_CONFIG` for this request.

### 2.4 Scoped Retrieval Functions

**File: `src/services/supabase.ts`** (additions)

```typescript
fetchAllChunksForSource(sourceId: string, userId: string, limit?: number): Promise<SemanticChunkResult[]>
fetchEntitiesForSource(sourceId: string, userId: string): Promise<KnowledgeNode[]>
fetchEdgesBetweenEntities(entityIds: string[], userId: string): Promise<KnowledgeEdge[]>
fetchCrossSourceEdges(setA: string[], setB: string[], userId: string): Promise<KnowledgeEdge[]>
fetchEntityDirectEdges(entityId: string, userId: string): Promise<KnowledgeEdge[]>
fetchNodeWithEmbedding(nodeId: string, userId: string): Promise<(KnowledgeNode & { embedding: number[] | null }) | null>
```

### 2.5 Modified Navigation State

**File: `src/components/home/HomeFeedDetail.tsx`** (modified)

Replace all six `navigate('/ask', { state: { autoQuery: '...' } })` calls with:

```typescript
navigate('/ask', { state: { chatContext: buildSourceChatContext(item.source) } })
```

**Also modified:**
- `src/views/explore/EntityBrowserTab.tsx` — use `buildEntityExploreContext`
- `src/views/explore/ExploreMetadataPanel.tsx` — use connection-aware builders
- `src/components/explore/NodeDetailPanel.tsx` — replace broken `window.location.href` with proper `navigate` + `buildEntityExploreContext`
- `src/components/explore/GraphTab.tsx` — no change (back navigation)
- `src/components/modals/CommandPalette.tsx` — no change (direct navigation)

### 2.6 Modified AskView State Consumption

**File: `src/views/AskView.tsx`** (modified)

Replace the current `autoQuery` extraction:

```typescript
const navState = location.state as { chatContext?: ChatEntryContext; autoQuery?: string } | null
const pendingContext = useRef<ChatEntryContext | null>(
  navState?.chatContext
    ?? (navState?.autoQuery
      ? { autoQuery: navState.autoQuery, entryPoint: 'direct', systemDirective: '', queryConfig: {} }
      : null)
)
```

### 2.7 Modified useRAGQuery Hook

**File: `src/hooks/useRAGQuery.ts`** (modified)

- `sendMessage` gains optional `ChatEntryContext` parameter
- Stores active context in `useRef` for follow-up persistence
- Passes context through to `routedQuery`

### 2.8 Pipeline Router

**File: `src/services/ragRouter.ts`** (new)

```typescript
export async function routedQuery(
  question: string,
  userId: string,
  conversationHistory: { role: string; content: string }[],
  entryContext: ChatEntryContext,
  onStepChange?: (event: RAGStepEvent) => void,
  signal?: AbortSignal
): Promise<RAGResponse>
```

Switches on `entryContext.entryPoint` and executes the tailored pipeline. Falls back to `queryGraph` for `'direct'` and `'suggestion_pill'`.

---

## 3. Design Requirements

No UI changes. This PRD is entirely backend pipeline logic. The only visible difference is better, more focused first answers.

Optional minor addition: show `displayLabel` in the existing `StatusBar` (e.g., "Exploring: Q3 Strategy Review").

---

## 4. Data & Service Layer

### 4.1 Tables Queried Per Entry Point

#### `entity_explore`

| Step | Table | Filter | Purpose |
|------|-------|--------|---------|
| Direct fetch | `knowledge_nodes` | `WHERE id = {entityId}` | Load target entity |
| Direct edges | `knowledge_edges` | `WHERE source_node_id = {entityId} OR target_node_id = {entityId}` | All first-degree relationships |
| Source chunks | `source_chunks` | `WHERE source_id = {entity.source_id} ORDER BY chunk_index` | Raw source content |
| Semantic nodes | `match_knowledge_nodes` RPC | Embedding of entity label + description, threshold 0.4, count 20 | Conceptually related entities |
| Graph traversal | `knowledge_edges` → `knowledge_nodes` | 2-hop BFS from `{entityId}` | Broader neighborhood |
| Enrichment | `knowledge_sources` | `WHERE id IN (chunk source IDs)` | Chunk metadata |

**Skipped:** `keywordSearchSources`, `keywordSearchChunks`, `keywordSearchNodes`, query decomposition.

#### `entity_find_similar`

| Step | Table | Filter | Purpose |
|------|-------|--------|---------|
| Direct fetch | `knowledge_nodes` (including `embedding`) | `WHERE id = {entityId}` | Entity + stored embedding |
| Semantic nodes | `match_knowledge_nodes` RPC | Entity's own embedding vector, threshold 0.35, count 30 | Similar entities by vector similarity |
| Graph traversal | `knowledge_edges` → `knowledge_nodes` | 3-hop BFS from `{entityId}`, frontier 25 | Structurally connected entities |
| Tag matching | `knowledge_nodes` | `WHERE entity_type = {type} AND tags && {tags}` | Same-type, same-tag entities |

**Skipped:** ALL chunk retrieval, ALL keyword search, query decomposition.

#### `relationship_chat`

| Step | Table | Filter | Purpose |
|------|-------|--------|---------|
| Direct fetch | `knowledge_nodes` | `WHERE id IN ({fromId}, {toId})` | Both entities |
| Direct fetch edge | `knowledge_edges` | `WHERE (source_node_id, target_node_id) match both IDs` | The specific edge + evidence |
| Chunks (entity A) | `source_chunks` | `WHERE source_id = {A.source_id} LIMIT 8` | Source content for A |
| Chunks (entity B) | `source_chunks` | `WHERE source_id = {B.source_id} LIMIT 8` | Source content for B |
| 1-hop edges | `knowledge_edges` | 1-hop from both entity IDs | Shared context |
| Enrichment | `knowledge_sources` | `WHERE id IN (both source IDs)` | Source metadata |

**Skipped:** Semantic search, keyword search, query decomposition, broad traversal.

#### `source_chat`

| Step | Table | Filter | Purpose |
|------|-------|--------|---------|
| Source metadata | `knowledge_sources` | `WHERE id = {sourceId}` | Full record including summary |
| ALL chunks | `source_chunks` | `WHERE source_id = {sourceId} ORDER BY chunk_index LIMIT 30` | Entire source content, high limit |
| Source entities | `knowledge_nodes` | `WHERE source_id = {sourceId}` | All entities from this source |
| Internal edges | `knowledge_edges` | Both endpoints in source entity set | Relationship structure within source |

**Skipped:** ALL semantic search, ALL keyword search, query decomposition, graph traversal. Most locked-down pipeline.

#### `source_anchor_relate`

| Step | Table | Filter | Purpose |
|------|-------|--------|---------|
| Source chunks | `source_chunks` | `WHERE source_id = {sourceId} LIMIT 20` | Full source content |
| Anchor node | `knowledge_nodes` | `WHERE id = {anchorId}` | The anchor |
| Anchor edges | `knowledge_edges` | `WHERE source_node_id = {anchorId} OR target_node_id = {anchorId}` | Anchor neighborhood |
| Other anchor sources | `knowledge_nodes` | Distinct `source_id` from anchor neighbors ≠ current source | Sources also connected to anchor |
| Comparison chunks | `source_chunks` | `WHERE source_id IN ({otherSourceIds}) LIMIT 3` per source | Context from other anchor sources |
| Bridge entities | `knowledge_nodes` | `WHERE source_id = {sourceId} AND id IN (anchor neighbor IDs)` | Entities bridging source to anchor |
| Enrichment | `knowledge_sources` | All source IDs | Source labels |

**Skipped:** Keyword search, query decomposition. Semantic search only as fallback for sparse anchors.

#### `source_compare`

| Step | Table | Filter | Purpose |
|------|-------|--------|---------|
| Both sources | `knowledge_sources` | `WHERE id IN ({A}, {B})` | Full metadata including summaries |
| Chunks A | `source_chunks` | `WHERE source_id = {A} LIMIT 15` | Content from source A |
| Chunks B | `source_chunks` | `WHERE source_id = {B} LIMIT 15` | Content from source B — equal budget |
| Entities A | `knowledge_nodes` | `WHERE source_id = {A}` | All entities from A |
| Entities B | `knowledge_nodes` | `WHERE source_id = {B}` | All entities from B |
| Cross edges | `knowledge_edges` | `WHERE (source IN setA AND target IN setB) OR reverse` | Cross-source relationships |

**Skipped:** ALL semantic search, ALL keyword search, query decomposition, graph traversal.

### 4.2 New Supabase Functions

Full signatures with table/column details:

```typescript
// Fetch all chunks for a single source, ordered, high limit
fetchAllChunksForSource(sourceId, userId, limit = 30)
  → source_chunks: id, source_id, chunk_index, content
  → WHERE source_id = X AND user_id = Y ORDER BY chunk_index LIMIT 30

// Fetch all entities extracted from a source
fetchEntitiesForSource(sourceId, userId)
  → knowledge_nodes: full row
  → WHERE source_id = X AND user_id = Y AND is_merged = false

// Fetch edges where both endpoints are in a given set
fetchEdgesBetweenEntities(entityIds, userId)
  → knowledge_edges: full row
  → WHERE source_node_id IN set AND target_node_id IN set AND user_id = Y

// Fetch edges crossing between two entity sets
fetchCrossSourceEdges(setA, setB, userId)
  → knowledge_edges: full row
  → Two parallel queries: (source IN A AND target IN B) + reverse, deduplicated

// Fetch first-degree edges for one entity
fetchEntityDirectEdges(entityId, userId)
  → knowledge_edges: full row
  → WHERE source_node_id = X OR target_node_id = X

// Fetch node including embedding vector
fetchNodeWithEmbedding(nodeId, userId)
  → knowledge_nodes: full row + embedding column
  → WHERE id = X AND user_id = Y, maybeSingle
```

---

## 5. System Directives & Query Config Per Entry Point

### 5.1 `entity_explore`

**System Directive:**

```
CONTEXT: The user arrived from an entity detail panel on the Home feed.
They can already see this entity's label, type, confidence score, description, and tags.
DO NOT repeat information they already have.

INSTRUCTIONS:
- Focus on what MULTIPLE SOURCES say about this entity — synthesize across sources.
- Highlight the entity's most significant RELATIONSHIPS, explaining the evidence.
- Surface any CONTRADICTIONS or evolving perspectives across different sources.
- If this is an Anchor, emphasize its role as a connective hub.
- End with 1-2 follow-up questions the user might want to explore.
```

**Query Config:** `{ mindset: 'exploratory', toolMode: 'deep' }`
**Scope:** `{ entityIds: [node.id], mode: 'soft' }`

### 5.2 `entity_find_similar`

**System Directive:**

```
CONTEXT: The user wants to discover entities SIMILAR to the one they're viewing.
They are in a discovery mindset — lateral connections, not deep analysis.

INSTRUCTIONS:
- Present results as a RANKED LIST of 5-8 similar entities.
- For each: label, type, and ONE-LINE explanation of WHY it's similar.
- Prioritize same-type entities sharing relationships or sources.
- Then broaden to entities connected by the same anchors or tags.
- End with ONE surprising connection they wouldn't expect.
- Keep it scannable — no deep analysis of any single entity.
```

**Query Config:** `{ mindset: 'exploratory', toolMode: 'deep' }`
**Scope:** `{ entityIds: [node.id], mode: 'soft' }`

### 5.3 `relationship_chat`

**System Directive:**

```
CONTEXT: The user is examining a specific relationship between two entities.
They can see: from-entity, to-entity, relation type, cross-source status.
DO NOT restate the relationship — explain it.

EXTRACTION EVIDENCE: {edge.evidence ?? 'No extraction evidence available'}
EDGE WEIGHT: {edge.weight}

INSTRUCTIONS:
- Explain the EVIDENCE from source chunks that supports this connection.
- If cross-source, emphasize the insight from the intersection.
- Discuss DOWNSTREAM IMPLICATIONS — what does this enable or risk?
- Keep focused — one specific connection, not the broader graph.
```

**Query Config:** `{ mindset: 'analytical', toolMode: 'quick' }`
**Scope:** `{ entityIds: [fromId, toId], mode: 'hard' }`

### 5.4 `source_chat`

**System Directive:**

```
CONTEXT: The user wants a focused conversation about a SINGLE source.
They can see the summary and extracted entities. DO NOT repeat the summary.

SOURCE SUMMARY (user has seen this): {source.summary ?? 'No summary available'}

INSTRUCTIONS:
- Go DEEPER — surface specific arguments, data points, decisions, quotes.
- Highlight anything the extraction may have missed.
- Structure: Key Themes (with depth) → Notable Specifics → Open Questions.
- Keep this source as PRIMARY subject. Graph connections are secondary.
- All citations should reference THIS source unless making a graph connection.
```

**Query Config:** `{ mindset: 'factual', toolMode: 'quick' }`
**Scope:** `{ sourceIds: [source.id], mode: 'hard' }`

### 5.5 `source_anchor_relate`

**System Directive:**

```
CONTEXT: The user is investigating how a source connects to an anchor topic.

ANCHOR: "{anchor.label}"
SOURCE: "{source.title}"

INSTRUCTIONS:
- Identify which entities from this source connect to the anchor and HOW.
- Explain what this source ADDS to understanding the anchor.
- Briefly note whether it CONFIRMS, EXTENDS, or CHALLENGES other anchor-connected sources.
- Frame as: "Here's what this source contributes to your understanding of [anchor]."
```

**Query Config:** `{ mindset: 'analytical', toolMode: 'deep' }`
**Scope:** `{ sourceIds: [source.id], anchorIds: [anchor.nodeId], mode: 'soft' }`

### 5.6 `source_compare`

**System Directive:**

```
CONTEXT: Structured comparison between two specific sources.

SOURCE A: "{sourceA.title}"
SOURCE B: "{sourceB.title}"

INSTRUCTIONS:
- Identify 2-3 most important SHARED THEMES and how each source treats them.
- Highlight what's UNIQUE to each source.
- Surface TENSIONS or contradictions.
- End with synthesis: "Together, these sources tell you X."
- CRITICAL: Keep attribution clear. Never blend which source said what.
- Structure: Shared Themes → Unique to A → Unique to B → Tensions → Synthesis.
```

**Query Config:** `{ mindset: 'comparative', toolMode: 'deep' }`
**Scope:** `{ sourceIds: [sourceA.id, sourceB.id], mode: 'hard' }`

---

## 6. Interaction & State

### 6.1 Navigation Flow

1. User clicks action button in HomeFeedDetail
2. Builder function constructs `ChatEntryContext`
3. Navigate to `/ask` with `state: { chatContext }`
4. `AskView` reads context from location state
5. Passes to `sendMessage` → `useRAGQuery` → `routedQuery`
6. `routedQuery` executes entry-point-specific pipeline
7. Response renders normally

### 6.2 Follow-up Persistence

`useRAGQuery` stores active `ChatEntryContext` in a `useRef`. Follow-up messages reuse scope and directive. Resets on: `clearChat()`, navigation away, or new context arrival.

### 6.3 Backward Compatibility

If `location.state` contains only `autoQuery` (no `chatContext`), wrap in minimal context with `entryPoint: 'direct'`. Routes to standard `queryGraph` unchanged.

---

## 7. Forward-Compatible Decisions

1. **`ChatEntryPoint` is extensible.** New entry points added by extending the union type + adding a router case.
2. **`ChatScope` supports future scope types.** `anchorIds` prepares for anchor-scoped queries. Future: `tagIds`, `dateRange`.
3. **`systemDirective` is composable.** User-configured prompt additions can prepend/append without modifying entry-point logic.
4. **`ragRouter.ts` is the single routing point.** All future RAG paths — digests (PRD-13), Chrome extension (PRD-14), API queries — route through `routedQuery`.
5. **`metadata` field** carries arbitrary key-value pairs for tracing, threading, A/B variants.
6. **`CHAT-ROUTING-LOGIC.md`** produced alongside this PRD serves as the architectural compass for future entry points.

---

## 8. Edge Cases & Error Handling

| Scenario | Behavior |
|----------|----------|
| Scope target deleted since feed rendered | Scoped query returns `[]` → fall back to standard `queryGraph` |
| Entity has no embedding vector | Re-embed `label + description` via Gemini → if that fails, keyword fallback |
| Hard-scoped query returns zero chunks | Log warning, relax to soft scope, add note to directive |
| Source has 50+ chunks (limit 30) | First 30 by chunk_index used; directive notes later sections omitted |
| Stale bookmarked `/ask` URL | State is null → `entryPoint: 'direct'`, standard pipeline |
| Rapid double-navigation | Second context replaces first; AbortController cancels in-flight query |

---

## 9. Acceptance Criteria

1. **Entity Explore:** Answer references direct relationships and cross-source appearances without user mentioning entity name.
2. **Find Similar:** Produces a ranked list with per-entity similarity explanations — visibly different format from Explore.
3. **Relationship Chat:** Answer references specific edge evidence and both source documents.
4. **Source Chat:** Answer draws ONLY from that source's chunks. No unrelated source content.
5. **Source-Anchor Relate:** Answer identifies bridge entities and references other anchor-connected sources.
6. **Source Compare:** Structured comparison with clear per-source attribution. Equal coverage. No third source leakage.
7. **Follow-up Persistence:** "Tell me more" stays within original scope without re-specification.
8. **Backward Compatible:** Direct navigation works exactly as before.
9. **Fallback Graceful:** Zero-result scoped queries fall back without user-visible errors.
10. **NodeDetailPanel Fixed:** Broken `window.location.href` replaced with proper `navigate` call.
