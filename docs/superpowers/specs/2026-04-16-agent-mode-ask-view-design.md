# Agent Mode - Ask View Design Spec

## Overview

Add a third query mode ("Agent") to the Ask view that behaves like an MCP-powered AI agent. Instead of the user choosing between Standard RAG or Council, Agent mode lets the LLM decide which tools to call based on the question. It analyzes the query, makes tool calls against the full Synapse toolkit, reads results, decides if it needs more, and synthesizes a final answer when it has enough context.

The UI shows the tool-calling process transparently in the chat, with expandable blocks showing each tool's request and response in real-time (matching the Claude MCP UI pattern).

## Goals

- Users can ask any question without thinking about which mode to use
- The LLM (Gemini Flash) autonomously decides which combination of tools answers the question best
- Tool calls are visible and inspectable, building trust and transparency
- Existing Standard and Council modes remain untouched

## Non-Goals

- Replacing Standard or Council modes (this is additive)
- Building a general-purpose agent framework (this is specific to Synapse tool-calling)
- Parallel tool execution (v1 is sequential - each result informs the next call)

---

## Architecture

### The Orchestration Loop

1. User types a question with "Agent" mode selected
2. Question + conversation history go to `POST /api/agent/run`
3. The endpoint sends the question to Gemini Flash with a system prompt containing descriptions of all 17 Synapse tools + their parameter schemas
4. Gemini responds with either:
   - A **tool call** (tool name + parameters) - the endpoint executes it against Supabase, streams the call and result back to the frontend, appends both to the conversation context, and asks Gemini for the next step
   - A **final answer** - the loop ends, answer streams to the frontend
5. Safety valve: maximum 10 tool calls per question to prevent runaway loops
6. Each step streams to the frontend via Server-Sent Events (SSE)

### Why Server-Side Orchestration

The loop runs in a Vercel serverless function, not in the browser. Reasons:
- Gemini API key stays server-side
- Supabase service-role queries (for tool execution) stay server-side
- No CORS complexity
- Single streaming connection to the frontend

### SSE Event Types

| Event | Payload | Purpose |
|---|---|---|
| `tool_start` | `{ tool: string, params: object, call_index: number }` | Render the tool block header (collapsed, loading state) |
| `tool_result` | `{ call_index: number, result: object, duration_ms: number }` | Fill in the result inside the block |
| `thinking` | `{ text: string }` | Optional reasoning text between tool calls |
| `answer` | `{ text: string, citations?: InlineCitation[] }` | Final synthesized response |
| `error` | `{ message: string, call_index?: number }` | Error at tool level or overall |
| `done` | `{}` | Stream complete |

### Timeout Budget

Vercel functions have a 60-second limit. Expected timing per tool call:
- Gemini round-trip: 2-3s
- Supabase query: 0.5-1s
- Total per tool call: ~3-4s

With the 10-call safety valve, worst case is ~40s + final synthesis (~3-5s) = ~45s. Within budget.

---

## Available Tools

The agent has access to all 17 Synapse MCP tools. Each tool definition sent to Gemini includes a name, description (with guidance on when to use it), and parameter schema.

| Tool | Description (for Gemini) | Key Parameters |
|---|---|---|
| `search_entities` | Find people, concepts, projects, decisions, topics by name or description. Recommended first tool for broad exploration or specific entity lookup. | query: string, entity_type?: string, limit?: number |
| `search_sources` | Search source titles with filters for type, date, and participant. Use when you need compound filters. | query: string, type?: string, date_from?: string, date_to?: string, sort?: string |
| `search_skills` | Find methodology skills by describing the task. Returns skill names and descriptions. | query: string |
| `get_skill_content` | Load the full methodology, examples, and process steps for a specific skill. Use after search_skills identifies a relevant skill. | skill_name: string |
| `get_skills` | List all skills in the library. Always pass include_drafts: true. | include_drafts: boolean |
| `get_entity` | Full detail for a specific entity including all direct connections and source appearances. | entity_id: string |
| `get_connections` | Traverse relationships around an entity up to 3 hops. Use hops=2 as default. | entity_id: string, hops?: number |
| `get_source_content` | Read the full raw content of a source (transcript, article, notes). Use for deep single-source analysis. | source_id: string |
| `get_meeting_brief` | Quick structured meeting summary optimised for pre-meeting preparation. | source_id: string |
| `get_meeting_notes` | Structured meeting output: overview, key topics, decisions, action items. Use for fast orientation. | source_id: string |
| `get_meeting_transcript` | Full verbatim transcript with speaker labels. Use when exact language, reasoning chains, or quotes matter. | source_id: string |
| `get_recent_sources` | List recently ingested sources with indexing status. Use to check what content exists. | limit?: number, type?: string |
| `get_related_sources` | Find sources that share entity connections with a given source. Use for cross-source discovery. | source_id: string |
| `list_anchors` | Returns the user's most important recurring entities (highest connectivity hubs). Use when exploring cross-domain connections. | limit?: number |
| `ask_synapse` | Semantic RAG search across source chunks. Best for specific factual questions when you know content exists. Poor for abstract or thematic queries. | query: string |
| `consult_council` | Multi-perspective advisory analysis from domain-specific AI advisors. Use for strategic questions spanning multiple knowledge domains, not for factual lookups. | query: string, agent_ids?: string[] |
| `send_to_synapse` | **Write operation.** Send content to Synapse for ingestion. Only use if the user explicitly asks to save or ingest something. Never call this unless the user's intent is clearly to store new content. | content: string, type?: string |

### System Prompt Structure

The Gemini system prompt includes:
1. Role description: "You are an AI agent with access to a personal knowledge graph. Analyze the user's question and use the available tools to find the best answer."
2. Tool descriptions with usage guidance (matching the synapse-context routing patterns)
3. Instructions on response format: either a tool call (JSON) or a final answer
4. Guidance: "Orient before deep-diving. Search broadly first, then drill into specifics. Don't call ask_synapse for abstract queries - use search_entities instead."
5. The user's conversation history for context

---

## UI Design

### Chat Input Changes

The mode toggle in `ChatInput.tsx` gets a third pill:

```
[ Standard ] [ Council ] [ Agent ]
```

Same pill styling as existing toggles. No other changes to the input area. The depth controls (Auto / Deep / Thorough) and attachment button remain as-is.

### Agent Response Rendering

When Agent mode completes, the chat shows:

1. **Tool call chain** - A vertical sequence of collapsible tool blocks connected by a left-side vertical line
2. **Done indicator** - Checkmark icon + "Done" text
3. **Final answer** - Normal chat message with citations where applicable

### Tool Block Component (AgentToolBlock)

**Collapsed state (default):**
- Left: icon (magnifying glass for search tools, "S" badge for Synapse-specific tools, document icon for content retrieval, checkmark for done)
- Center: human-readable tool name (e.g. "Search sources", "Get meeting notes", "Get entity details")
- Right: "Result" pill badge indicating data returned

**Expanded state (on click):**
- Rounded container with light background
- **Request** section: JSON-formatted parameters (e.g. `{ "query": "Arxivar", "sort": "relevant" }`)
- **Response** section: scrollable response data with a max-height constraint
- Divider between request and response

**Visual chain:**
- Vertical line on the left connecting all tool blocks (like the Claude UI)
- Each block is indented slightly from the line
- "Done" appears at the bottom of the chain with a checkmark circle icon

### Loading States

- **Tool executing:** Current block shows the tool name with a subtle pulse/spinner. No "Result" pill yet.
- **Between tools (Gemini thinking):** Brief "Thinking..." text or no visible indicator (the next tool block simply appears)
- **Final answer generating:** Standard streaming text appearance below the tool chain

### Right Panel

For Agent mode responses, the right panel shows the same Ask Context panel as Standard mode:
- Sources referenced across all tool calls
- Entities mentioned
- Relationship paths discovered

Populated by aggregating results from all tool calls in the chain.

---

## Frontend Implementation

### New Hook: `useAgentQuery`

Lives at `src/hooks/useAgentQuery.ts`. Manages the SSE connection and agent state.

**State shape:**

```typescript
interface AgentToolCall {
  index: number
  tool: string
  params: Record<string, unknown>
  result: Record<string, unknown> | null
  status: 'running' | 'complete' | 'error'
  duration_ms?: number
}

interface AgentQueryState {
  status: 'idle' | 'running' | 'complete' | 'error'
  toolCalls: AgentToolCall[]
  thinking: string | null
  answer: string | null
  citations: InlineCitation[]
  error: string | null
}
```

**Key methods:**
- `sendAgentQuery(query: string, conversationHistory: ChatMessage[])` - Opens SSE connection to `/api/agent/run`, processes events
- `reset()` - Clears state for new query

### New Components

| Component | File | Purpose |
|---|---|---|
| `AgentResponse` | `src/components/ask/AgentResponse.tsx` | Container for one agent answer: renders tool chain + final answer |
| `AgentToolChain` | `src/components/ask/AgentToolChain.tsx` | Vertical-line-connected sequence of tool blocks with "Done" indicator |
| `AgentToolBlock` | `src/components/ask/AgentToolBlock.tsx` | Single collapsible tool call (icon, name, expandable request/response) |

### AskView Changes

Minimal changes to existing code:
- `askMode` type expands: `'standard' | 'council' | 'agent'`
- `handleSend` adds a third branch that calls `useAgentQuery.sendAgentQuery()`
- Message rendering adds a case for agent responses using `AgentResponse`
- ChatInput pill toggle gets the third "Agent" option

### Conversation History

- Agent responses stored as `ChatMessage` objects with `role: 'assistant'`
- Tool call chain stored as metadata on the message (`agentToolCalls: AgentToolCall[]`)
- Follow-up questions include summarized prior tool results in the conversation context sent to Gemini

---

## Backend Implementation

### Endpoint: `POST /api/agent/run`

Lives at `api/agent/run.ts`. Single Vercel serverless function.

**Request body:**
```typescript
{
  query: string
  conversation_history: Array<{ role: string, content: string }>
  user_id: string
}
```

**Response:** SSE stream (Content-Type: text/event-stream)

**Internal structure:**

1. **Auth validation** - Verify Supabase JWT from Authorization header
2. **Build system prompt** - Tool descriptions + usage guidance + conversation history
3. **Orchestration loop:**
   - Call Gemini with current conversation (system prompt + user query + prior tool results)
   - Parse response as either tool call or final answer
   - If tool call: execute tool, stream events, append to conversation, continue loop
   - If final answer: stream answer event, end
   - If loop count > 10: force Gemini to synthesize with what it has
4. **Tool executor map** - Inline functions that execute each tool against Supabase

**Tool executors** are thin wrappers around Supabase queries. Each one:
- Receives the parsed parameters from Gemini
- Runs the appropriate Supabase query (`.from()`, `.rpc()`, or REST call)
- Returns the result as a JSON object
- Handles errors gracefully (returns error message, doesn't crash the loop)

Since Vercel functions can't share local imports, all tool executor logic is defined inline within the single file. npm packages (supabase-js, etc.) are fine.

### Gemini Tool-Calling Format

Gemini receives instructions to respond in one of two JSON formats:

**Tool call:**
```json
{
  "action": "tool_call",
  "tool": "search_entities",
  "params": { "query": "pricing strategy", "entity_type": "Topic" },
  "reasoning": "Looking for entities related to pricing strategy to orient before deep-diving"
}
```

**Final answer:**
```json
{
  "action": "answer",
  "text": "Based on what I found...",
  "citations": [...]
}
```

The `reasoning` field is optional and streams to the frontend as a `thinking` event when present.

---

## What Stays the Same

- Standard mode: completely untouched
- Council mode: completely untouched
- All existing components, hooks, services, and API endpoints: no changes
- Right panel behaviour: same context display pattern
- Chat history persistence: same approach, extended with agent metadata
- Design system: all new components follow existing tokens and patterns

---

## File Inventory

### New Files
| File | Type | Purpose |
|---|---|---|
| `api/agent/run.ts` | Serverless function | Orchestration loop + tool executors |
| `src/hooks/useAgentQuery.ts` | Hook | SSE connection + agent state management |
| `src/components/ask/AgentResponse.tsx` | Component | Container for agent answer rendering |
| `src/components/ask/AgentToolChain.tsx` | Component | Connected sequence of tool blocks |
| `src/components/ask/AgentToolBlock.tsx` | Component | Single collapsible tool call block |

### Modified Files
| File | Change |
|---|---|
| `src/views/AskView.tsx` | Add agent mode branch in handleSend, render AgentResponse for agent messages |
| `src/components/ask/ChatInput.tsx` | Add "Agent" pill to mode toggle |
| `src/types/rag.ts` | Add AgentToolCall, AgentQueryState types |
