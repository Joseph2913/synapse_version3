# PRD-D — Ask Right Panel, Citation Wiring & Chat History

**Phase:** Intelligence (post-Phase 3)
**Dependencies:** PRD-A (Chat Entry Context System), PRD-C (Intelligent Chat Engine)
**Estimated complexity:** Medium-High
**Depends on:** `ChatEntryContext`, `ChatScope`, `RAGResponseContext`, right panel rendering in AskView, `ChatMessage` citations, `GraphContext`

---

## 1. Objective

Wire up all the interactive elements in the Ask view that currently look clickable but do nothing. Citation badges in responses should open source/entity detail in the right panel. Entity badges in the right panel should be clickable and trigger scoped follow-ups. Source cards in the right panel should open full source detail. Connection chains should be clickable. And conversation history should persist across sessions so users can resume past Ask conversations.

Today, the right panel's `AskRightPanel` renders source cards, entity badges, and connection chains — all as static, display-only elements. The `ChatMessage` component has an `onCitationClick` prop but `AskView` never passes a handler. The `EntityChain` component accepts an `onNodeClick` prop but `AskRightPanel` never passes one. Chat messages exist only in React state and are lost on page refresh or navigation away.

After this PRD, every element in the right panel is interactive, citation clicks surface detail with one click and trigger scoped queries with two, and conversations persist to Supabase so users can resume them.

---

## 2. What Gets Built

### 2.1 Citation Click → Right Panel

**Current state:** `ChatMessage` renders citation badges (`[1]`, `[2]`, etc.) that accept an `onCitationClick` prop. `AskView` never passes a handler. Clicking a citation does nothing except show a hover tooltip.

**What changes:**

**Modified file: `src/views/AskView.tsx`**

Add a citation click handler that resolves the citation to either a source or entity and opens the appropriate detail panel:

```typescript
const handleCitationClick = useCallback(async (citationIndex: number) => {
  if (!askContext) return
  const citation = askContext.citations.find(c => c.index === citationIndex)
  if (!citation) return

  // If citation has a source_id, open source detail
  if (citation.source_id) {
    const source = await fetchSourceById(citation.source_id)
    if (source) {
      setRightPanelContent({ type: 'source', data: source })
      return
    }
  }

  // If citation has a node_id, open node detail
  if (citation.node_id) {
    const node = await fetchNodeById(citation.node_id)
    if (node) {
      setRightPanelContent({ type: 'node', data: node })
      return
    }
  }
}, [askContext, setRightPanelContent])
```

Pass to `ChatMessageList`:

```tsx
<ChatMessageList
  messages={messages}
  isLoading={isLoading}
  pipelineEvents={pipelineEvents}
  scroll={scroll}
  onFollowUpClick={handleFollowUp}
  onCitationClick={handleCitationClick}
/>
```

**Modified file: `src/components/ask/ChatMessageList.tsx`**

Accept and pass through `onCitationClick`:

```typescript
interface ChatMessageListProps {
  messages: ChatMessage[]
  isLoading: boolean
  pipelineEvents: RAGStepEvent[]
  scroll: ReturnType<typeof useChatScroll>
  onFollowUpClick?: (question: string) => void
  onCitationClick?: (index: number) => void    // NEW
}
```

Pass to each `ChatMessage`:

```tsx
<ChatMessage
  key={message.id}
  message={message}
  onCitationClick={onCitationClick}
  onFollowUpClick={onFollowUpClick}
/>
```

**Visual feedback on click:** When a citation is clicked and the right panel opens to a source or node detail, the corresponding source card in the `AskRightPanel` (if it's still visible) gets a brief highlight pulse (0.5s accent-50 background flash, matching the existing `isHighlighted` prop on `SourceCard`). This connects the citation click in the chat to the source in the context panel.

### 2.2 Right Panel Entity Badges → Clickable

**Current state:** Entity badges in `AskRightPanel` are plain `<span>` tags with no click behaviour.

**Modified file: `src/components/ask/AskRightPanel.tsx`**

Replace the static `<span>` badges with clickable buttons that open entity detail:

```tsx
{context.relatedNodes.slice(0, 20).map(node => (
  <button
    key={node.id}
    type="button"
    onClick={() => onEntityClick?.(node)}
    className="font-body font-medium cursor-pointer"
    style={{
      fontSize: 11,
      padding: '3px 8px',
      borderRadius: 5,
      background: 'var(--color-bg-inset)',
      border: '1px solid var(--border-subtle)',
      color: 'var(--color-text-body)',
      transition: 'background 0.15s ease, border-color 0.15s ease',
    }}
    onMouseEnter={e => {
      e.currentTarget.style.background = 'var(--color-bg-card)'
      e.currentTarget.style.borderColor = 'var(--border-default)'
    }}
    onMouseLeave={e => {
      e.currentTarget.style.background = 'var(--color-bg-inset)'
      e.currentTarget.style.borderColor = 'var(--border-subtle)'
    }}
  >
    {node.label}
  </button>
))}
```

**New props on `AskRightPanel`:**

```typescript
interface AskRightPanelProps {
  context: RAGResponseContext
  highlightedCitationIndex?: number | null
  lastQuery?: string
  onEntityClick?: (node: KnowledgeNode) => void        // NEW
  onSourceCardClick?: (chunk: EnrichedChunk) => void    // NEW
  onConnectionNodeClick?: (label: string) => void       // NEW
}
```

**Modified file: `src/views/AskView.tsx`**

Wire the entity click handler — opens entity detail in the right panel:

```typescript
const handleEntityClick = useCallback((node: KnowledgeNode) => {
  setRightPanelContent({ type: 'node', data: node })
}, [setRightPanelContent])
```

Pass to `AskRightPanel`:

```tsx
<AskRightPanel
  context={rightPanelContent.data}
  lastQuery={lastQuery}
  onEntityClick={handleEntityClick}
  onSourceCardClick={handleSourceCardClick}
  onConnectionNodeClick={handleConnectionNodeClick}
/>
```

### 2.3 Right Panel Source Cards → Clickable

**Current state:** `SourceCard` in `AskRightPanel` has hover states (border darkening, subtle shadow) suggesting it's clickable, but no click handler.

**Modified file: `src/components/ask/SourceCard.tsx`**

Add `onClick` prop:

```typescript
interface SourceCardProps {
  chunk: EnrichedChunk
  citationIndex?: number
  isHighlighted?: boolean
  isSameSourceAsPrevious?: boolean
  onClick?: () => void                  // NEW
}
```

Update the root `div` to be a clickable element:

```tsx
<div
  style={{
    ...existingStyles,
    cursor: onClick ? 'pointer' : 'default',
  }}
  onClick={onClick}
  onMouseEnter={...}
  onMouseLeave={...}
>
```

**Modified file: `src/components/ask/AskRightPanel.tsx`**

Pass click handler to each `SourceCard`:

```tsx
<SourceCard
  chunk={chunk}
  citationIndex={citIndex}
  isHighlighted={isHighlighted}
  isSameSourceAsPrevious={isSameSource}
  onClick={() => onSourceCardClick?.(chunk)}
/>
```

**Modified file: `src/views/AskView.tsx`**

Wire the source card click handler — fetches the full source and opens source detail:

```typescript
const handleSourceCardClick = useCallback(async (chunk: EnrichedChunk) => {
  const source = await fetchSourceById(chunk.source_id)
  if (source) {
    setRightPanelContent({ type: 'source', data: source })
  }
}, [setRightPanelContent])
```

### 2.4 Right Panel Connection Chains → Clickable

**Current state:** `EntityChain` accepts an `onNodeClick` prop and renders entity names as buttons. But `AskRightPanel` never passes a handler.

**Modified file: `src/components/ask/AskRightPanel.tsx`**

Pass the `onConnectionNodeClick` prop through to `EntityChain`:

```tsx
<EntityChain
  key={edge.id}
  path={{
    from,
    relation: edge.relation_type ?? 'relates_to',
    to,
    evidence: edge.evidence ?? undefined,
  }}
  onNodeClick={onConnectionNodeClick}
/>
```

**Modified file: `src/views/AskView.tsx`**

Wire the connection node click handler — resolves a label to a node and opens its detail:

```typescript
const handleConnectionNodeClick = useCallback(async (label: string) => {
  // Find the node in the current context by label
  const node = askContext?.relatedNodes.find(
    n => n.label === label
  )
  if (node) {
    setRightPanelContent({ type: 'node', data: node })
  }
}, [askContext, setRightPanelContent])
```

### 2.5 "Ask About This" Action in Detail Panels

When a user clicks an entity or source in the right panel and sees its detail view, they should be able to ask about it directly from the panel without leaving the chat. This creates a natural drill-down flow: see context → click entity → see detail → ask about it → get scoped response.

**Modified file: `src/components/panels/NodeDetail.tsx`**

Add an "Ask about this" button in the actions section. This button does NOT navigate away from the Ask view — instead, it pre-fills the chat input with a scoped query:

```tsx
{isAskView && (
  <button
    type="button"
    onClick={() => onAskAbout?.(node)}
    className="font-body font-semibold cursor-pointer"
    style={actionButtonStyle}
  >
    <MessageSquare size={12} /> Ask about this
  </button>
)}
```

New props:

```typescript
interface NodeDetailProps {
  node: KnowledgeNode
  onClose?: () => void
  isAskView?: boolean                                 // NEW
  onAskAbout?: (node: KnowledgeNode) => void          // NEW
}
```

**Modified file: `src/components/panels/SourceDetail.tsx`**

Same pattern — add "Ask about this source" button:

```typescript
interface SourceDetailProps {
  source: KnowledgeSource
  onClose?: () => void
  isAskView?: boolean                                    // NEW
  onAskAbout?: (source: KnowledgeSource) => void         // NEW
}
```

**Modified file: `src/views/AskView.tsx`**

Wire the "Ask about this" handlers. These send a scoped follow-up message:

```typescript
const handleAskAboutNode = useCallback((node: KnowledgeNode) => {
  // Return to context panel first
  handleBackToAskContext()
  // Send a scoped follow-up
  const question = `Tell me more about "${node.label}" (${node.entity_type}).`
  void sendMessage(question, {
    ...config,
    scope: { entityIds: [node.id] },
  })
}, [handleBackToAskContext, sendMessage, config])

const handleAskAboutSource = useCallback((source: KnowledgeSource) => {
  handleBackToAskContext()
  const question = `Tell me more about "${source.title ?? 'this source'}".`
  void sendMessage(question, {
    ...config,
    scope: { sourceIds: [source.id] },
  })
}, [handleBackToAskContext, sendMessage, config])
```

Pass to the detail panels:

```tsx
<NodeDetail
  node={rightPanelContent.data}
  onClose={handleBackToAskContext}
  isAskView={true}
  onAskAbout={handleAskAboutNode}
/>
```

### 2.6 Citation Highlight Sync

When the user hovers over a citation `[N]` in the chat, the corresponding source card in the right panel should highlight. The infrastructure for this partially exists (`highlightedCitationIndex` prop on `AskRightPanel`) but is never wired.

**Modified file: `src/views/AskView.tsx`**

Add state for the highlighted citation:

```typescript
const [highlightedCitationIndex, setHighlightedCitationIndex] = useState<number | null>(null)
```

**Modified file: `src/components/ask/ChatMessage.tsx`**

Add an `onCitationHoverChange` prop (different from the existing tooltip hover):

```typescript
interface ChatMessageProps {
  message: ChatMessageType
  onCitationClick?: (index: number) => void
  onFollowUpClick?: (question: string) => void
  onCitationHoverChange?: (index: number | null) => void    // NEW
}
```

Fire it when a citation is hovered/unhovered:

```tsx
onMouseEnter={e => {
  onCitationHover?.(citation, e.currentTarget.getBoundingClientRect())
  onCitationHoverChange?.(citIndex)
}}
onMouseLeave={() => {
  onCitationLeave?.()
  onCitationHoverChange?.(null)
}}
```

**Modified file: `src/views/AskView.tsx`**

Pass the highlight state to `AskRightPanel`:

```tsx
<AskRightPanel
  context={rightPanelContent.data}
  highlightedCitationIndex={highlightedCitationIndex}
  lastQuery={lastQuery}
  onEntityClick={handleEntityClick}
  onSourceCardClick={handleSourceCardClick}
  onConnectionNodeClick={handleConnectionNodeClick}
/>
```

When a citation is highlighted, the `AskRightPanel` scrolls the corresponding `SourceCard` into view using the existing `cardRefs` map:

**Modified file: `src/components/ask/AskRightPanel.tsx`**

```typescript
// Auto-scroll to highlighted card
useEffect(() => {
  if (highlightedCitationIndex !== null) {
    const el = cardRefs.current.get(highlightedCitationIndex)
    el?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }
}, [highlightedCitationIndex])
```

### 2.7 Chat History Persistence

**New database table: `chat_sessions`**

This requires a Supabase migration:

```sql
CREATE TABLE chat_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title TEXT,                          -- Auto-generated from first message
  messages JSONB NOT NULL DEFAULT '[]', -- Array of ChatMessage objects
  entry_context JSONB,                 -- Serialised ChatEntryContext (nullable for direct sessions)
  last_query_config JSONB,             -- Last used QueryConfig
  message_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- RLS policies
ALTER TABLE chat_sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own chat sessions"
  ON chat_sessions FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own chat sessions"
  ON chat_sessions FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own chat sessions"
  ON chat_sessions FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own chat sessions"
  ON chat_sessions FOR DELETE
  USING (auth.uid() = user_id);

-- Index for listing sessions
CREATE INDEX idx_chat_sessions_user_updated
  ON chat_sessions (user_id, updated_at DESC);
```

**New file: `src/services/chatHistory.ts`**

```typescript
export interface ChatSession {
  id: string
  user_id: string
  title: string | null
  messages: ChatMessage[]
  entry_context: ChatEntryContext | null
  last_query_config: QueryConfig | null
  message_count: number
  created_at: string
  updated_at: string
}

/** Create a new chat session. Returns the session ID. */
export async function createChatSession(
  userId: string,
  firstMessage: ChatMessage,
  entryContext?: ChatEntryContext
): Promise<string>

/** Append a message to an existing session. */
export async function appendMessage(
  sessionId: string,
  message: ChatMessage
): Promise<void>

/** Update session title (auto-generated from first user message). */
export async function updateSessionTitle(
  sessionId: string,
  title: string
): Promise<void>

/** Fetch recent sessions for the session list. */
export async function fetchRecentSessions(
  userId: string,
  limit?: number
): Promise<ChatSession[]>

/** Fetch a single session with full messages. */
export async function fetchSession(
  sessionId: string
): Promise<ChatSession | null>

/** Delete a session. */
export async function deleteSession(
  sessionId: string
): Promise<void>
```

**Session lifecycle:**

1. **First message in a new conversation:** `useRAGQuery` calls `createChatSession` with the user message and optional entry context. Stores the returned `sessionId` in state.
2. **Subsequent messages:** Each user and assistant message is appended via `appendMessage(sessionId, message)`.
3. **Title generation:** After the first assistant response, auto-generate a title from the first user message (truncate to 60 chars). Update via `updateSessionTitle`.
4. **Clear chat:** Does NOT delete the session from the database. It creates a new session for subsequent messages. The old session remains accessible in history.
5. **Navigation away and back:** On mount, AskView checks for a `sessionId` in URL params or state. If present, loads the session and populates messages.

**Modified file: `src/hooks/useRAGQuery.ts`**

Add session management:

```typescript
export interface UseRAGQueryReturn {
  messages: ChatMessage[]
  isLoading: boolean
  currentStep: RAGPipelineStep | null
  pipelineEvents: RAGStepEvent[]
  error: string | null
  lastResponseContext: RAGResponseContext | null
  activeEntryContext: ChatEntryContext | null
  activeSessionId: string | null          // NEW
  sendMessage: (text: string, queryConfig?: QueryConfig) => Promise<void>
  sendWithContext: (context: ChatEntryContext) => Promise<void>
  clearChat: () => void
  loadSession: (sessionId: string) => Promise<void>   // NEW
}
```

- `sendMessage` and `sendWithContext` now persist messages to `chat_sessions` after successful responses
- `loadSession` fetches a session by ID, populates `messages`, restores `activeEntryContext` from the session's `entry_context` field, and sets `activeSessionId`
- `clearChat` resets `activeSessionId` to null (next message starts a new session)

### 2.8 Session List in Empty State

**Modified file: `src/components/ask/EmptyAskState.tsx`**

Below the existing suggestion pills and mindset showcase, add a "Recent Conversations" section that shows the user's last 5 chat sessions:

```tsx
{sessions.length > 0 && (
  <div style={{ marginTop: 32, width: '100%', maxWidth: 520 }}>
    <span
      className="font-display font-bold uppercase"
      style={{
        fontSize: 10,
        color: 'var(--color-text-secondary)',
        letterSpacing: '0.08em',
        display: 'block',
        marginBottom: 10,
      }}
    >
      Recent Conversations
    </span>
    <div className="flex flex-col" style={{ gap: 6 }}>
      {sessions.map(session => (
        <button
          key={session.id}
          type="button"
          onClick={() => onLoadSession(session.id)}
          className="w-full font-body cursor-pointer text-left"
          style={{
            fontSize: 12,
            fontWeight: 500,
            color: 'var(--color-text-body)',
            background: 'var(--color-bg-card)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 10,
            padding: '10px 16px',
            transition: 'border-color 0.15s ease',
          }}
          onMouseEnter={e => {
            e.currentTarget.style.borderColor = 'var(--border-default)'
          }}
          onMouseLeave={e => {
            e.currentTarget.style.borderColor = 'var(--border-subtle)'
          }}
        >
          <div className="flex items-center justify-between">
            <span style={{ fontWeight: 600 }}>
              {session.title ?? 'Untitled conversation'}
            </span>
            <span style={{ fontSize: 10, color: 'var(--color-text-secondary)' }}>
              {formatRelativeTime(session.updated_at)}
            </span>
          </div>
          <div style={{ fontSize: 11, color: 'var(--color-text-secondary)', marginTop: 2 }}>
            {session.message_count} messages
          </div>
        </button>
      ))}
    </div>
  </div>
)}
```

**New props on `EmptyAskState`:**

```typescript
interface EmptyAskStateProps {
  onSendSuggestion: (text: string) => void
  isEmpty?: boolean
  sessions?: ChatSession[]                      // NEW
  onLoadSession?: (sessionId: string) => void   // NEW
}
```

**Modified file: `src/views/AskView.tsx`**

Fetch recent sessions on mount and pass to `EmptyAskState`:

```typescript
const [recentSessions, setRecentSessions] = useState<ChatSession[]>([])

useEffect(() => {
  if (!user) return
  fetchRecentSessions(user.id, 5)
    .then(setRecentSessions)
    .catch(() => setRecentSessions([]))
}, [user])

const handleLoadSession = useCallback(async (sessionId: string) => {
  await loadSession(sessionId)
}, [loadSession])
```

---

## 3. Design Requirements

### Citation Click Feedback

- When a citation `[N]` is clicked, the right panel transitions to the source or entity detail view with the existing "← Back to Context" breadcrumb
- The clicked citation badge gets a brief pulse: background transitions from `rgba(214,58,0,0.08)` to `rgba(214,58,0,0.2)` and back over 0.3s
- If the right panel is showing the context view, the source card corresponding to the clicked citation gets a 0.5s highlight pulse (accent-50 background flash)

### Citation Hover Sync

- Hovering a citation `[N]` in chat highlights the corresponding source card in the right panel with `var(--color-accent-50)` background (existing `isHighlighted` prop, now wired)
- The right panel auto-scrolls to bring the highlighted card into view (`scrollIntoView` with `smooth` behaviour)
- Unhover removes the highlight immediately

### Clickable Entity Badges

- Entity badges in the right panel change from `<span>` to `<button>`
- Cursor changes to pointer
- Hover: background transitions to `var(--color-bg-card)`, border to `var(--border-default)` (0.15s ease)
- Click opens entity detail in the right panel with "← Back to Context" breadcrumb

### Clickable Source Cards

- Source cards gain `cursor: pointer` (they already have hover states)
- Click opens source detail in the right panel with "← Back to Context" breadcrumb
- No additional visual changes needed — the existing hover states (border darkening, subtle shadow) already signal clickability

### "Ask About This" Button

- Position: in the actions section of NodeDetail and SourceDetail, only when rendered inside the Ask view
- Icon: `MessageSquare` (12px)
- Style: matches existing action button patterns — `var(--color-bg-inset)` background, `var(--border-subtle)` border, 7px radius, DM Sans 12px weight 600
- Hover: background transitions to `var(--color-bg-card)`
- Behaviour: sends a scoped follow-up, returns to context panel, new response appears in chat

### Recent Conversations in Empty State

- Section label: "RECENT CONVERSATIONS" — Cabinet Grotesk 10px, weight 700, uppercase, 0.08em letter-spacing, secondary colour
- Session cards: match existing suggestion pill styling — white background, subtle border, 10px radius, 10px 16px padding
- Each card shows: title (bold 12px), relative time (right-aligned, 10px secondary), message count (11px secondary, below title)
- Hover: border darkens (same as suggestion pills)
- Maximum 5 sessions displayed
- Hidden when there are no sessions

---

## 4. Data & Service Layer

### New Database Table

| Table | Columns | Purpose |
|---|---|---|
| `chat_sessions` | `id`, `user_id`, `title`, `messages` (JSONB), `entry_context` (JSONB), `last_query_config` (JSONB), `message_count`, `created_at`, `updated_at` | Persists chat conversations across sessions |

### New Service Functions

| Function | File | Purpose |
|---|---|---|
| `createChatSession` | `chatHistory.ts` | Create new session with first message |
| `appendMessage` | `chatHistory.ts` | Add message to existing session |
| `updateSessionTitle` | `chatHistory.ts` | Auto-title from first user message |
| `fetchRecentSessions` | `chatHistory.ts` | List recent sessions for empty state |
| `fetchSession` | `chatHistory.ts` | Load full session with messages |
| `deleteSession` | `chatHistory.ts` | Remove a session |

### Existing Functions Used

| Function | File | Used For |
|---|---|---|
| `fetchSourceById` | `supabase.ts` | Resolving citation source_id to full source for right panel |
| `fetchNodeById` | `supabase.ts` | Resolving citation node_id to full node for right panel |

### Migration File

**New file: `supabase/migrations/YYYYMMDD_prd_d_chat_sessions.sql`**

Contains the `CREATE TABLE`, RLS policies, and index from Section 2.7.

---

## 5. Interaction & State

### Citation Click Flow

1. User clicks `[3]` in an assistant message
2. `onCitationClick(3)` fires in `AskView`
3. Handler finds the citation in `askContext.citations` where `index === 3`
4. If `citation.source_id` exists: fetch source via `fetchSourceById`, open in right panel as `{ type: 'source', data: source }`
5. If `citation.node_id` exists (and no source_id): fetch node via `fetchNodeById`, open in right panel as `{ type: 'node', data: node }`
6. Right panel shows source/node detail with "← Back to Context" breadcrumb
7. User can click "← Back to Context" to return to the `AskRightPanel` context view
8. User can click "Ask about this" to send a scoped follow-up

### Entity Badge Click Flow

1. User clicks an entity badge (e.g., "Machine Learning") in the right panel entities section
2. `onEntityClick(node)` fires — the full `KnowledgeNode` is already available in `context.relatedNodes`
3. Right panel shows `NodeDetail` for that node with "← Back to Context" breadcrumb
4. User can click "Ask about this" to send a scoped follow-up about that entity
5. The follow-up inherits the active session's entry context (scope, directive)

### Source Card Click Flow

1. User clicks a source card in the right panel
2. `onSourceCardClick(chunk)` fires
3. Handler fetches the full `KnowledgeSource` via `fetchSourceById(chunk.source_id)`
4. Right panel shows `SourceDetail` with "← Back to Context" breadcrumb
5. User can click "Ask about this source" to send a source-scoped follow-up

### Connection Chain Click Flow

1. User clicks an entity name (e.g., "Project Alpha") in a connection chain in the right panel
2. `onConnectionNodeClick('Project Alpha')` fires
3. Handler finds the node in `askContext.relatedNodes` by label match
4. Right panel shows `NodeDetail` for that node
5. If label not found in current context (edge case — node label changed): no-op, log warning

### Session Resume Flow

1. User opens Ask view with no active conversation
2. Empty state shows suggestion pills + recent conversations
3. User clicks a recent conversation
4. `loadSession(sessionId)` fires — fetches session from `chat_sessions`
5. Messages are populated in `useRAGQuery` state
6. `activeEntryContext` is restored from `session.entry_context` (scope and directive re-applied)
7. `activeSessionId` is set — subsequent messages append to this session
8. Right panel shows the last response's context (if available from the last assistant message's context)

### Session Auto-Save Flow

1. User sends first message (typed or via entry-point auto-query)
2. After the assistant responds, `createChatSession` is called with:
   - Both the user message and assistant message
   - The entry context (if present)
   - Title auto-generated from first user message (first 60 chars)
3. `activeSessionId` is stored in `useRAGQuery` state
4. Each subsequent message pair (user + assistant) is appended via `appendMessage`
5. `updated_at` and `message_count` are updated on each append
6. If the user clears chat, `activeSessionId` is reset to null. The old session remains in the database. The next message creates a new session.

---

## 6. Forward-Compatible Decisions

- **`chat_sessions.messages` is JSONB, not normalised.** This is intentional — chat messages contain citations, follow-ups, and pipeline metadata that would be painful to normalise. JSONB supports the full `ChatMessage[]` shape and allows the schema to evolve without migrations. The trade-off is that individual message search is harder, but that's not a current requirement.

- **`chat_sessions.entry_context` preserves full context.** When a session is resumed, the entry context (scope, directive, display label) is restored. This means a user who started a "Chat with source" conversation can close their browser, come back the next day, and the conversation is still scoped to that source.

- **Session list is intentionally simple.** This PRD does not build a full conversation management UI (search, folders, tags, sharing). It builds the persistence layer and a minimal "recent conversations" list in the empty state. A future PRD can add a dedicated conversation history view, conversation search, and conversation management features.

- **The `onAskAbout` action in detail panels creates a natural drill-down loop.** This is the same pattern that PRD-B uses for entry-point redirects, but happening in-conversation instead of across views. The infrastructure from PRD-A (scoped queries, persistent context) supports both patterns without modification.

- **Citation click handlers resolve IDs at click time, not at render time.** This avoids fetching full source/node data for every citation in every message. The trade-off is a brief network call on click (~50ms with Supabase), but it keeps the initial render fast.

---

## 7. Edge Cases & Error Handling

| Scenario | Behaviour |
|---|---|
| Citation click but `source_id` and `node_id` are both null | No-op. Citation tooltip still works on hover. |
| `fetchSourceById` returns null (source was deleted) | Show a brief toast or inline message: "This source is no longer available." Stay on current panel view. |
| `fetchNodeById` returns null (node was deleted or merged) | Same as above: "This entity is no longer available." |
| Connection chain label doesn't match any node in `relatedNodes` | No-op. This can happen if the label in the edge doesn't exactly match the node label (unlikely but possible with edge data). |
| User clicks "Ask about this" on a node that has no source_id | Scope only includes `entityIds`, no `sourceIds`. Pipeline uses standard search for chunks. |
| Chat session JSONB exceeds reasonable size (50+ messages) | Cap message storage at the 50 most recent messages. Older messages are truncated from the stored array but the session metadata (title, count) reflects the full history. |
| `fetchRecentSessions` fails (network error) | Empty state shows suggestion pills without the recent conversations section. No error shown. |
| Session loaded but entry_context references a deleted source/entity | Scope constraints will produce empty results → pipeline falls back to unscoped (PRD-A fallback rule). Session still loads. |
| Two browser tabs with the same session | Last-write-wins on `appendMessage`. Messages may interleave. Acceptable for v1 — real-time sync is a future concern. |
| User navigates away mid-conversation and comes back | The session persists. On returning to Ask, the empty state shows the session in "Recent Conversations." Clicking it restores the full conversation. |

---

## 8. Files Created or Modified

### New Files

| File | Purpose |
|---|---|
| `src/services/chatHistory.ts` | Chat session CRUD operations against `chat_sessions` table |
| `supabase/migrations/YYYYMMDD_prd_d_chat_sessions.sql` | Database migration for `chat_sessions` table, RLS policies, and index |

### Modified Files

| File | Change |
|---|---|
| `src/views/AskView.tsx` | Wire `onCitationClick`, `handleEntityClick`, `handleSourceCardClick`, `handleConnectionNodeClick`, `handleAskAboutNode`, `handleAskAboutSource`, `handleLoadSession`; add `highlightedCitationIndex` state; fetch recent sessions on mount |
| `src/components/ask/AskRightPanel.tsx` | Add `onEntityClick`, `onSourceCardClick`, `onConnectionNodeClick` props; make entity badges clickable buttons; pass click handlers to `SourceCard` and `EntityChain`; add auto-scroll on highlight |
| `src/components/ask/SourceCard.tsx` | Add `onClick` prop, set cursor to pointer when clickable |
| `src/components/ask/ChatMessage.tsx` | Add `onCitationHoverChange` prop, fire it on citation mouse enter/leave |
| `src/components/ask/ChatMessageList.tsx` | Pass through `onCitationClick`, `onCitationHoverChange`, `onFollowUpClick` |
| `src/components/ask/EmptyAskState.tsx` | Add `sessions` and `onLoadSession` props, render "Recent Conversations" section |
| `src/components/panels/NodeDetail.tsx` | Add `isAskView` and `onAskAbout` props, render "Ask about this" button when in Ask view |
| `src/components/panels/SourceDetail.tsx` | Add `isAskView` and `onAskAbout` props, render "Ask about this source" button when in Ask view |
| `src/hooks/useRAGQuery.ts` | Add `activeSessionId` state, `loadSession` method, persist messages to `chat_sessions` on send/receive |
| `src/types/rag.ts` | No changes (ChatMessage type already supports all needed fields) |

---

## 9. Acceptance Criteria

**Citation clicks:**
- [ ] Clicking a citation `[N]` in an assistant message opens the cited source or entity in the right panel
- [ ] The right panel shows "← Back to Context" breadcrumb to return to the context view
- [ ] If the citation has a `source_id`, the source detail view opens
- [ ] If the citation has a `node_id` (and no source_id), the node detail view opens
- [ ] If the source/node no longer exists, a graceful message is shown

**Citation hover sync:**
- [ ] Hovering a citation `[N]` highlights the corresponding source card in the right panel
- [ ] The right panel auto-scrolls to the highlighted card
- [ ] Unhover removes the highlight immediately

**Right panel entity clicks:**
- [ ] Entity badges in the right panel are clickable buttons with hover states
- [ ] Clicking an entity badge opens its `NodeDetail` in the right panel
- [ ] The "← Back to Context" breadcrumb returns to the context view

**Right panel source clicks:**
- [ ] Source cards in the right panel are clickable
- [ ] Clicking a source card opens `SourceDetail` in the right panel
- [ ] The "← Back to Context" breadcrumb returns to the context view

**Right panel connection clicks:**
- [ ] Entity names in connection chains are clickable
- [ ] Clicking an entity name opens its `NodeDetail` in the right panel

**"Ask about this" action:**
- [ ] `NodeDetail` shows an "Ask about this" button when rendered inside the Ask view
- [ ] `SourceDetail` shows an "Ask about this source" button when rendered inside the Ask view
- [ ] Clicking the button sends a scoped follow-up message and returns to the context view
- [ ] The scoped follow-up inherits the active entry context
- [ ] These buttons do NOT appear when NodeDetail/SourceDetail are rendered outside the Ask view (e.g., in Explore)

**Chat history persistence:**
- [ ] `chat_sessions` table exists with RLS policies
- [ ] First message in a new conversation creates a session in the database
- [ ] Subsequent messages are appended to the session
- [ ] Session title is auto-generated from the first user message
- [ ] Clearing chat resets the active session (old session remains in database)
- [ ] The empty state shows up to 5 recent conversations
- [ ] Clicking a recent conversation restores messages, entry context, and scope
- [ ] Session persistence survives page refresh and navigation away

**No regressions:**
- [ ] Existing citation tooltip hover still works alongside the new click behaviour
- [ ] Existing "← Back to Context" navigation still works
- [ ] Existing "Explore in Graph" button still works
- [ ] The right panel renders correctly when no context exists (default placeholder)
- [ ] TypeScript strict mode passes with no `any` types
- [ ] All new Supabase queries respect RLS
