# PRD-A — Chat Entry Context System

**Phase:** Intelligence (post-Phase 3)
**Dependencies:** PRD 7 (extraction pipeline), PRD 8 (Ask view + RAG pipeline)
**Estimated complexity:** High
**Depends on:** Existing Ask view, RAG pipeline (`rag.ts`), Gemini service (`gemini.ts`), query composer (`useQueryComposer.ts`)
**Enables:** PRD-B (context-aware entry points), PRD-C (in-chat interactions)

---

## 1. Objective

Build the infrastructure that allows any page in Synapse to pass structured context into the Ask view's RAG pipeline — a system directive that shapes the AI's response, a query configuration override that selects the right retrieval strategy, and scope constraints that focus the database queries on the relevant sources, entities, or anchors.

Today, every entry point into the chat interface passes a single `autoQuery` string and fires the RAG pipeline with identical settings. The pipeline runs the same keyword searches, the same semantic searches, the same graph traversal, and the same Gemini system prompt regardless of whether the user clicked "Chat with source" on a specific document or "Find Similar" on an entity. The `scopeAnchors` field on `QueryConfig` exists in the type definition and is wired to the toolbar UI, but the RAG pipeline ignores it entirely.

After this PRD, the system can accept a rich context package from any entry point, route it through every layer of the pipeline, and persist it across follow-up messages — so each conversation stays focused on what the user originally asked about until they explicitly change direction.

---

## 2. What Gets Built

### 2.1 Type Definitions

**New file: `src/types/chatContext.ts`**

```typescript
// ─── Entry Point Enum ────────────────────────────────────────────────────────

export type ChatEntryPoint =
  // Home Feed
  | 'home_entity_explore'
  | 'home_entity_similar'
  | 'home_relationship_chat'
  | 'home_source_chat'
  | 'home_source_anchor'
  | 'home_source_compare'
  // Explore
  | 'explore_entity_browse'
  | 'explore_entity_graph'
  | 'explore_source_connection'
  // Capture
  | 'capture_post_extraction'
  // Pipeline
  | 'pipeline_extraction_detail'
  // Orient
  | 'orient_digest_drilldown'
  // Anchors
  | 'anchors_explore'
  // Direct navigation (nav rail, command palette, empty state suggestion)
  | 'direct'

// ─── Chat Entry Context ──────────────────────────────────────────────────────

export interface ChatEntryContext {
  /** The user-visible question displayed in the chat bubble. */
  autoQuery: string

  /** Hidden instruction prepended to Gemini's system prompt. Never shown to the user. */
  systemDirective?: string

  /** Overrides for query configuration. Merged with DEFAULT_QUERY_CONFIG. */
  queryConfigOverrides?: Partial<QueryConfig>

  /** Scope constraints for the RAG pipeline. Restricts which data is searched. */
  scope?: ChatScope

  /** Which button/view the user came from. Used for analytics and debugging. */
  entryPoint: ChatEntryPoint

  /** Label shown in the Ask view status bar (e.g., "Exploring: Q3 Strategy Review"). */
  displayLabel?: string
}

// ─── Scope Constraints ───────────────────────────────────────────────────────

export interface ChatScope {
  /**
   * Lock chunk retrieval to these source IDs only.
   * When set, the pipeline skips keyword/semantic search on sources
   * and fetches chunks directly from these source_ids.
   */
  sourceIds?: string[]

  /**
   * Seed graph traversal from these entity IDs.
   * When set, the pipeline skips keyword/semantic search on nodes
   * and starts traversal from these nodes directly.
   */
  entityIds?: string[]

  /**
   * Filter results to entities connected to these anchor IDs.
   * This is the pipeline-level implementation of the existing
   * scopeAnchors field on QueryConfig (currently unused).
   */
  anchorIds?: string[]

  /**
   * Use this entity's stored embedding vector for semantic search
   * instead of generating a new embedding from the question text.
   * Used by "Find Similar" to find entities conceptually close
   * to the selected entity.
   */
  useEntityEmbedding?: string
}
```

**Modified file: `src/types/rag.ts`**

Add `scope` field to `QueryConfig`:

```typescript
export interface QueryConfig {
  mindset: QueryMindsetId
  scopeAnchors: string[]        // Existing field — now wired to pipeline
  toolMode: ToolModeId
  modelTier: ModelTierId
  scope?: ChatScope             // NEW: pipeline-level scope constraints
  systemDirective?: string      // NEW: hidden instruction for Gemini
}
```

### 2.2 Navigation State

**Modified file: `src/views/AskView.tsx`**

Change what AskView reads from `location.state`:

```typescript
// BEFORE (current):
const pendingAutoQuery = useRef(
  (location.state as { autoQuery?: string } | null)?.autoQuery ?? ''
)

// AFTER:
const pendingEntryContext = useRef<ChatEntryContext | null>(
  (location.state as ChatEntryContext | { autoQuery?: string } | null)
    ? normalizeEntryContext(location.state)
    : null
)
```

**New utility function in `src/types/chatContext.ts`:**

```typescript
/**
 * Normalizes both legacy { autoQuery: string } state and new ChatEntryContext.
 * Ensures backward compatibility with any existing navigate() calls
 * that haven't been upgraded to pass full context yet.
 */
export function normalizeEntryContext(
  state: unknown
): ChatEntryContext | null {
  if (!state || typeof state !== 'object') return null
  const s = state as Record<string, unknown>

  // Full ChatEntryContext
  if (s.entryPoint && typeof s.autoQuery === 'string') {
    return s as ChatEntryContext
  }

  // Legacy format: { autoQuery: string }
  if (typeof s.autoQuery === 'string' && s.autoQuery.trim()) {
    return {
      autoQuery: s.autoQuery,
      entryPoint: 'direct',
    }
  }

  return null
}
```

### 2.3 Entry Context Persistence in useRAGQuery

**Modified file: `src/hooks/useRAGQuery.ts`**

Add state to hold the active entry context, and apply it to every `sendMessage` call:

```typescript
export interface UseRAGQueryReturn {
  messages: ChatMessage[]
  isLoading: boolean
  currentStep: RAGPipelineStep | null
  pipelineEvents: RAGStepEvent[]
  error: string | null
  lastResponseContext: RAGResponseContext | null
  activeEntryContext: ChatEntryContext | null      // NEW
  sendMessage: (text: string, queryConfig?: QueryConfig) => Promise<void>
  sendWithContext: (context: ChatEntryContext) => Promise<void>  // NEW
  clearChat: () => void
}
```

New `sendWithContext` method:

- Stores the `ChatEntryContext` in a ref (`activeEntryContextRef`)
- Merges `context.queryConfigOverrides` with the provided or default `QueryConfig`
- Attaches `context.scope` and `context.systemDirective` to the merged config
- Calls `sendMessage` internally with the merged config
- The stored context persists across follow-up `sendMessage` calls — scope, directive, and config overrides are re-applied until `clearChat` is called

New behavior for `sendMessage`:

- If `activeEntryContextRef.current` exists:
  - Re-apply `scope` from the entry context to the provided `queryConfig`
  - Re-apply `systemDirective` from the entry context
  - Do NOT re-apply `queryConfigOverrides` — those were for the initial query only. Follow-ups use whatever the toolbar shows, but keep the scope and directive.
- If `activeEntryContextRef.current` is null, behave exactly as today.

`clearChat` resets `activeEntryContextRef.current` to null.

### 2.4 RAG Pipeline: Scope Constraints

**Modified file: `src/services/rag.ts`**

The `queryGraph` function signature adds optional scope:

```typescript
export async function queryGraph(
  question: string,
  userId: string,
  conversationHistory: { role: string; content: string }[],
  queryConfig?: QueryConfig,
  onStepChange?: (event: RAGStepEvent) => void,
  signal?: AbortSignal
): Promise<RAGResponse>
```

No signature change needed — `QueryConfig` now carries `scope` and `systemDirective`.

**New behavior based on `queryConfig.scope`:**

**When `scope.sourceIds` is set:**
- Skip `keywordSearchSources` entirely — we already have the source IDs
- Skip `semanticSearchChunks` (broad vector search) — replace with `fetchChunksForSources(scope.sourceIds, userId, { limit })` to fetch chunks directly from the scoped sources
- Keep `keywordSearchChunks` but filtered: add `.in('source_id', scope.sourceIds)` to constrain results
- For source-balanced chunk selection: if 2 source IDs, enforce 50/50 balance; if 1 source ID, increase the chunk limit to `maxContextChunks * 2` (deeper single-source coverage)

**When `scope.entityIds` is set:**
- Skip `keywordSearchNodes` — we already have the node IDs
- Skip `semanticSearchNodes` — unless the query is exploratory (mindset === 'exploratory')
- Start graph traversal directly from `scope.entityIds` instead of from keyword/semantic search results
- Direct-fetch the scoped entities by ID for node summaries (guaranteed inclusion)

**When `scope.anchorIds` is set (also wires existing `scopeAnchors`):**
- After retrieval, filter `allKeywordNodes` to only include nodes that are connected to at least one scoped anchor via `knowledge_edges`
- After graph traversal, prioritize paths that pass through scoped anchor nodes

**When `scope.useEntityEmbedding` is set:**
- Skip `embedQuery(question)` — instead, fetch the entity's stored `embedding` vector from `knowledge_nodes` by ID
- Use that vector for `semanticSearchNodes` — finds entities conceptually similar to the source entity rather than semantically similar to the question text
- Skip `semanticSearchChunks` — "Find Similar" is an entity-level query, not a source-level query

**Fallback rule:** If a scoped query returns fewer than 3 chunks, fall back to the standard unscoped pipeline and log a warning. This prevents empty responses when scope constraints are too narrow.

### 2.5 RAG Pipeline: System Directive Injection

**Modified file: `src/services/gemini.ts`**

Change `buildRAGSystemPrompt` signature:

```typescript
function buildRAGSystemPrompt(
  context: RAGContext,
  sourceContextNote?: string,
  mindsetPromptAddition?: string,
  systemDirective?: string          // NEW
): string
```

Inject the directive immediately after the core mission block and before the answering rules:

```
═══════════════════════════════════════════════════
CORE MISSION: Give RICH, COMPREHENSIVE answers.
═══════════════════════════════════════════════════

${systemDirective ? `CONTEXT DIRECTIVE:\n${systemDirective}\n\n` : ''}

ANSWERING RULES (follow these exactly):
...
```

The directive is positioned here so it takes priority over the generic answering rules but after the core mission statement. Gemini will treat it as the most specific instruction about this particular query.

Pass the directive through `generateRAGResponse`:

```typescript
export async function generateRAGResponse(
  context: RAGContext,
  question: string,
  conversationHistory: { role: string; content: string }[],
  sourceContextNote?: string,
  mindsetPromptAddition?: string,
  temperatureOverride?: number,
  maxOutputTokens?: number,
  systemDirective?: string          // NEW
): Promise<RAGGenerationResult>
```

And from `queryGraph` in `rag.ts`, pass `queryConfig?.systemDirective` through to `generateRAGResponse`.

### 2.6 New Supabase Query Functions

**Modified file: `src/services/supabase.ts`**

```typescript
/**
 * Fetch ALL chunks for a single source, ordered by chunk_index.
 * Higher limit than fetchChunksForSources — used when the pipeline
 * is scope-locked to one source and wants maximum coverage.
 */
export async function fetchAllChunksForSource(
  sourceId: string,
  userId: string,
  limit: number = 30
): Promise<SemanticChunkResult[]>

/**
 * Fetch a node's stored embedding vector by ID.
 * Used by "Find Similar" to search with the entity's own vector
 * rather than generating a new embedding from the question text.
 */
export async function fetchNodeEmbedding(
  nodeId: string
): Promise<number[] | null>

/**
 * Fetch all edges directly connected to a specific node.
 * Returns edges where the node is either source or target.
 * Used to provide explicit relationship context when the entry
 * point is a specific entity or relationship.
 */
export async function fetchDirectEdges(
  nodeId: string,
  userId: string,
  limit: number = 20
): Promise<KnowledgeEdge[]>

/**
 * Fetch all entities extracted from a specific source.
 * Returns nodes where source_id matches.
 * Used when scope-locked to a source to get its full entity set.
 */
export async function fetchNodesForSource(
  sourceId: string,
  userId: string,
  limit: number = 50
): Promise<KnowledgeNode[]>
```

### 2.7 Fix: NodeDetailPanel Broken Redirect

**Modified file: `src/components/explore/NodeDetailPanel.tsx`**

Replace:
```typescript
window.location.href = `/ask?context=${entity.id}`
```

With:
```typescript
navigate('/ask', {
  state: {
    autoQuery: `Tell me about "${entity.label}" (${entity.entity_type}). What is its significance in my knowledge graph, what key insights are associated with it, and how does it connect to other important concepts?`,
    entryPoint: 'explore_entity_graph',
  } satisfies ChatEntryContext
})
```

This is a minimal fix using the `normalizeEntryContext` backward-compat path. PRD-B will upgrade it to a full `ChatEntryContext` with scope and directive.

---

## 3. Design Requirements

This PRD has no visual changes. All modifications are to the data layer, service layer, and type system. The Ask view UI renders identically — same chat bubbles, same right panel, same toolbar.

The only user-visible change: if `displayLabel` is set on the entry context, the `StatusBar` component shows it (e.g., "Exploring: Q3 Strategy Review"). This is a single line of text in the existing status bar area.

**StatusBar modification (`src/components/ask/StatusBar.tsx`):**

Add an optional `contextLabel` prop. When present, render it as:

- Font: DM Sans, 11px, weight 500
- Color: `var(--color-text-secondary)`
- Position: left-aligned in the status bar, before the clear button
- Prefix: none — just the label text
- Truncation: ellipsis at 300px max-width

---

## 4. Data & Service Layer

### Tables Queried (No Schema Changes)

| Table | New Query Functions | Purpose |
|---|---|---|
| `source_chunks` | `fetchAllChunksForSource` | Scope-locked single-source chunk retrieval |
| `knowledge_nodes` | `fetchNodeEmbedding`, `fetchNodesForSource` | Entity embedding for "Find Similar", source entity set |
| `knowledge_edges` | `fetchDirectEdges` | Direct relationship context for entity/relationship entry points |
| `knowledge_sources` | (existing `fetchSourcesByIds`) | Source metadata for scope-locked queries |

### Modified Service Functions

| Function | File | Change |
|---|---|---|
| `queryGraph` | `rag.ts` | Read `scope` and `systemDirective` from `QueryConfig`, implement scoped retrieval logic |
| `buildRAGSystemPrompt` | `gemini.ts` | Accept and inject `systemDirective` parameter |
| `generateRAGResponse` | `gemini.ts` | Pass `systemDirective` through to `buildRAGSystemPrompt` |

### Modified Hooks

| Hook | File | Change |
|---|---|---|
| `useRAGQuery` | `useRAGQuery.ts` | Add `activeEntryContext` state, `sendWithContext` method, persistent scope on follow-ups |
| `useQueryComposer` | `useQueryComposer.ts` | Accept initial config overrides from entry context |

### Modified Views

| View | File | Change |
|---|---|---|
| `AskView` | `AskView.tsx` | Read `ChatEntryContext` from location state, call `sendWithContext` instead of `sendMessage` for auto-queries |

---

## 5. Interaction & State

### Entry Flow

1. User clicks a chat redirect button on any view (e.g., "Chat with source" on Home feed)
2. The button calls `navigate('/ask', { state: chatEntryContext })` where `chatEntryContext` is a full `ChatEntryContext` object
3. `AskView` mounts, reads the context via `normalizeEntryContext(location.state)`
4. If context exists, AskView calls `sendWithContext(context)` on the RAG hook
5. `useRAGQuery.sendWithContext`:
   - Stores the context in `activeEntryContextRef`
   - Merges `context.queryConfigOverrides` with `DEFAULT_QUERY_CONFIG`
   - Attaches `context.scope` and `context.systemDirective` to the merged config
   - Adds the user message (from `context.autoQuery`) to the chat
   - Calls `queryGraph` with the merged config
6. `queryGraph` reads `config.scope` and adjusts retrieval accordingly
7. `queryGraph` passes `config.systemDirective` to `generateRAGResponse`
8. Response renders in chat as normal

### Follow-Up Flow

1. User types a follow-up question and presses Send
2. `useRAGQuery.sendMessage` is called with the toolbar's current `QueryConfig`
3. If `activeEntryContextRef.current` exists:
   - `scope` from the entry context is re-applied to the config (scope persists)
   - `systemDirective` from the entry context is re-applied (directive persists)
   - `queryConfigOverrides` are NOT re-applied (user controls toolbar after first message)
4. Pipeline runs with the inherited scope and directive
5. Response renders normally

### Clear Flow

1. User clicks "Clear chat" or sends `/clear`
2. `clearChat()` resets `activeEntryContextRef.current` to null
3. All subsequent queries use `DEFAULT_QUERY_CONFIG` with no scope or directive
4. StatusBar `contextLabel` disappears

### Direct Navigation Flow (backward compat)

1. User clicks Ask in the nav rail, or opens Ask via command palette
2. No `location.state` is present, or state has no `entryPoint` field
3. `normalizeEntryContext` returns null
4. `pendingEntryContext.current` is null — no auto-query fires
5. User types manually, pipeline runs exactly as today

### Legacy Auto-Query Flow (backward compat)

1. An entry point that hasn't been upgraded still passes `{ autoQuery: string }`
2. `normalizeEntryContext` detects the legacy format, wraps it as `{ autoQuery, entryPoint: 'direct' }`
3. `sendWithContext` fires the query with `DEFAULT_QUERY_CONFIG`, no scope, no directive
4. Behavior is identical to today

---

## 6. Forward-Compatible Decisions

- **`ChatEntryPoint` enum is extensible.** PRD-B will add entry points as it wires up each redirect. The enum is a union type, not a fixed set — new values can be added without breaking existing code.

- **`ChatScope` is additive.** Future PRDs can add new scope fields (e.g., `tagFilter`, `dateRange`, `sourceTypeFilter`) without modifying existing scope logic. Each scope field is independently evaluated in the pipeline.

- **System directives are composable.** The directive is a single string, but nothing prevents a future PRD from building it from multiple parts (entry-point directive + user preference directive + conversation history directive). The injection point in the system prompt is designed to accept any length of instruction.

- **`sendWithContext` doesn't replace `sendMessage`.** Both methods coexist. `sendMessage` remains the primary method for user-typed queries and for the existing toolbar-driven flow. `sendWithContext` is the entry point for programmatic/redirected queries. This means no existing code breaks.

- **The scope fallback rule (< 3 chunks → unscoped retry) ensures graceful degradation.** PRD-B entry points can set aggressive scope locks knowing the infrastructure will catch edge cases where the scope is too narrow.

- **PRD-C (in-chat interactions) will use `sendWithContext` for citation-click follow-ups.** When a user clicks a citation, PRD-C will construct a `ChatEntryContext` scoped to that citation's source and fire a follow-up. The infrastructure built here supports that pattern without modification.

---

## 7. Edge Cases & Error Handling

| Scenario | Behavior |
|---|---|
| `scope.sourceIds` contains an ID with zero chunks | Fallback: fetch `knowledge_sources.content` for that ID, split into synthetic 2000-char chunks (matches existing 3-tier fallback from chunk pipeline fix) |
| `scope.entityIds` contains an ID that doesn't exist | Skip that ID silently. If all IDs are invalid, fall back to standard unscoped pipeline. |
| `scope.useEntityEmbedding` points to a node with no stored embedding | Fall back to standard `embedQuery(question)` behavior. Log warning. |
| Scoped query returns < 3 chunks | Fall back to standard unscoped pipeline. Add a console warning: `[rag] Scoped query returned too few chunks (N), falling back to unscoped pipeline.` |
| `systemDirective` is extremely long (> 2000 chars) | Truncate to 2000 chars with `...` suffix. Log warning. Directives should be concise (200–500 chars typical). |
| Entry context with `autoQuery` but no `entryPoint` | `normalizeEntryContext` treats it as legacy format, assigns `entryPoint: 'direct'`. |
| User clears chat while a scoped query is in-flight | The abort controller cancels the request. `clearChat` resets entry context. Next query is unscoped. |
| User navigates away from Ask and back | Entry context is lost (it's in a ref, not persisted). Returning to Ask shows a fresh state. This is intentional — the user left the conversation. |
| Two rapid redirects (user clicks "Chat with source" then immediately clicks a different source) | The second `navigate('/ask', ...)` replaces the first. `AskView` re-mounts with the new context. The first auto-query may fire and be immediately aborted by the second. |

---

## 8. Files Created or Modified

### New Files

| File | Purpose |
|---|---|
| `src/types/chatContext.ts` | `ChatEntryContext`, `ChatEntryPoint`, `ChatScope` types + `normalizeEntryContext` utility |

### Modified Files

| File | Change Summary |
|---|---|
| `src/types/rag.ts` | Add `scope?: ChatScope` and `systemDirective?: string` to `QueryConfig` |
| `src/views/AskView.tsx` | Read `ChatEntryContext` from location state, call `sendWithContext` for auto-queries, pass `displayLabel` to `StatusBar` |
| `src/hooks/useRAGQuery.ts` | Add `activeEntryContext` state, `sendWithContext` method, persistent scope/directive on follow-ups |
| `src/hooks/useQueryComposer.ts` | Accept optional initial overrides from entry context to pre-set toolbar state |
| `src/services/rag.ts` | Implement scoped retrieval logic — conditional skip/replace of keyword search, semantic search, and graph traversal based on `scope` fields |
| `src/services/gemini.ts` | Add `systemDirective` parameter to `buildRAGSystemPrompt` and `generateRAGResponse`, inject into system prompt |
| `src/services/supabase.ts` | Add `fetchAllChunksForSource`, `fetchNodeEmbedding`, `fetchDirectEdges`, `fetchNodesForSource` |
| `src/components/ask/StatusBar.tsx` | Accept and render optional `contextLabel` prop |
| `src/components/explore/NodeDetailPanel.tsx` | Fix broken `window.location.href` redirect to use `navigate()` with proper state |

---

## 9. Acceptance Criteria

After this PRD is complete:

- [ ] A `ChatEntryContext` object can be passed via `navigate('/ask', { state: context })` from any view
- [ ] `AskView` reads the context and fires an auto-query with the specified scope, directive, and config overrides
- [ ] Legacy `{ autoQuery: string }` navigation state still works identically to today (backward compat)
- [ ] The RAG pipeline respects `scope.sourceIds` — when set, chunks are fetched only from those sources, keyword/semantic search on other sources is skipped
- [ ] The RAG pipeline respects `scope.entityIds` — when set, graph traversal starts from those entities directly
- [ ] The RAG pipeline respects `scope.useEntityEmbedding` — when set, the entity's stored vector is used for semantic search instead of the question text
- [ ] The `scopeAnchors` field on `QueryConfig` (which existed but was ignored) now filters results in the pipeline
- [ ] The `systemDirective` string is injected into Gemini's system prompt between the core mission and answering rules
- [ ] The system directive and scope persist across follow-up messages until `clearChat` is called
- [ ] Query config overrides from the entry context apply only to the first message, not follow-ups
- [ ] A scoped query that returns < 3 chunks falls back to the standard unscoped pipeline
- [ ] The `StatusBar` displays the `displayLabel` when present
- [ ] `NodeDetailPanel` "Explore with AI" uses `navigate()` instead of `window.location.href`
- [ ] No existing functionality is broken — direct navigation to Ask, command palette "Open Ask", nav rail Ask, and the empty state suggestions all work exactly as before
- [ ] All new functions have TypeScript types with no `any` — strict mode passes
- [ ] All new Supabase queries respect RLS (use authenticated client, filter by `user_id` where not covered by RLS policy)
