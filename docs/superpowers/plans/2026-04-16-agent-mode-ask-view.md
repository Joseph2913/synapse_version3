# Agent Mode - Ask View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a third "Agent" query mode to the Ask view that lets Gemini Flash autonomously decide which Synapse tools to call, executes them in a loop, and synthesizes a final answer - with the tool-calling process shown transparently in the chat UI (matching Claude's MCP pattern).

**Architecture:** A single Vercel serverless function (`api/agent/run.ts`) runs the orchestration loop: it sends the user's question to Gemini with all 17 tool descriptions, Gemini responds with tool calls or a final answer, and results stream back to the frontend via SSE. A new `useAgentQuery` hook consumes the stream and drives three new components (`AgentResponse`, `AgentToolChain`, `AgentToolBlock`) that render the collapsible tool-call chain in the chat.

**Tech Stack:** Gemini 2.5 Flash (orchestrator), Supabase (tool execution), Server-Sent Events (streaming), React (UI components)

**Spec:** `docs/superpowers/specs/2026-04-16-agent-mode-ask-view-design.md`

---

## File Structure

### New Files

| File | Responsibility |
|---|---|
| `src/types/agent.ts` | AgentToolCall, AgentQueryState, AgentSSEEvent types |
| `api/agent/run.ts` | Serverless orchestration loop + all 17 tool executors + SSE streaming |
| `src/hooks/useAgentQuery.ts` | SSE client, state management, abort control |
| `src/components/ask/AgentToolBlock.tsx` | Single collapsible tool call block (icon, name, expandable request/response) |
| `src/components/ask/AgentToolChain.tsx` | Vertical-line-connected sequence of AgentToolBlocks + "Done" indicator |
| `src/components/ask/AgentResponse.tsx` | Container: renders AgentToolChain + final answer text |

### Modified Files

| File | Change |
|---|---|
| `src/components/ask/ChatInput.tsx` | Expand AskMode type to include `'agent'`, add third pill |
| `src/views/AskView.tsx` | Add agent mode state, dispatch, rendering branch |

---

## Task 1: Add Agent Types

**Files:**
- Create: `src/types/agent.ts`
- Modify: `src/components/ask/ChatInput.tsx` (line 8, AskMode type)

- [ ] **Step 1: Create agent type definitions**

```typescript
// src/types/agent.ts
import type { InlineCitation } from './rag'

export interface AgentToolCall {
  index: number
  tool: string
  params: Record<string, unknown>
  result: Record<string, unknown> | null
  status: 'running' | 'complete' | 'error'
  duration_ms?: number
  error?: string
}

export interface AgentQueryState {
  status: 'idle' | 'running' | 'complete' | 'error'
  toolCalls: AgentToolCall[]
  thinking: string | null
  answer: string | null
  citations: InlineCitation[]
  error: string | null
}

/** SSE event types streamed from /api/agent/run */
export type AgentSSEEvent =
  | { type: 'tool_start'; tool: string; params: Record<string, unknown>; call_index: number }
  | { type: 'tool_result'; call_index: number; result: Record<string, unknown>; duration_ms: number }
  | { type: 'tool_error'; call_index: number; error: string }
  | { type: 'thinking'; text: string }
  | { type: 'answer'; text: string; citations?: InlineCitation[] }
  | { type: 'error'; message: string }
  | { type: 'done' }

export const INITIAL_AGENT_STATE: AgentQueryState = {
  status: 'idle',
  toolCalls: [],
  thinking: null,
  answer: null,
  citations: [],
  error: null,
}
```

- [ ] **Step 2: Expand AskMode type**

In `src/components/ask/ChatInput.tsx` line 8, change:

```typescript
// Before
export type AskMode = 'standard' | 'council'

// After
export type AskMode = 'standard' | 'council' | 'agent'
```

- [ ] **Step 3: Verify build**

Run: `npx tsc --noEmit`
Expected: PASS (no type errors, new types are not yet consumed)

- [ ] **Step 4: Commit**

```bash
git add src/types/agent.ts src/components/ask/ChatInput.tsx
git commit -m "feat(agent): add AgentToolCall, AgentQueryState, and SSE event types"
```

---

## Task 2: Build the Serverless Orchestration Endpoint

This is the largest task. The file must be self-contained (no local imports - Vercel requirement). It contains: auth, Gemini helper, all 17 tool executors, the orchestration loop, and SSE streaming.

**Files:**
- Create: `api/agent/run.ts`

**Reference:** `api/council/route.ts` for auth + Gemini patterns, `api/mcp.ts` for tool query logic.

- [ ] **Step 1: Create the endpoint with auth, Gemini helper, and SSE scaffolding**

```typescript
// api/agent/run.ts
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createClient, SupabaseClient } from '@supabase/supabase-js'

export const maxDuration = 60

// ─── Environment ──────────────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL!
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY!
const GEMINI_API_KEY = process.env.GEMINI_API_KEY!
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models'

// ─── Auth ─────────────────────────────────────────────────────────────
async function getUser(req: VercelRequest): Promise<string | null> {
  const auth = req.headers.authorization
  if (!auth?.startsWith('Bearer ')) return null
  const token = auth.slice(7)
  const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
  try {
    const { data: { user } } = await sb.auth.getUser(token)
    return user?.id ?? null
  } catch { return null }
}

// ─── Gemini JSON call ─────────────────────────────────────────────────
async function geminiJson<T>(
  systemPrompt: string,
  messages: Array<{ role: string; content: string }>,
  temperature = 0.2,
  timeoutMs = 20000,
): Promise<T> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const contents = messages.map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }))
    const resp = await fetch(
      `${GEMINI_BASE}/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          system_instruction: { parts: [{ text: systemPrompt }] },
          contents,
          generationConfig: { temperature, responseMimeType: 'application/json' },
        }),
      },
    )
    if (!resp.ok) throw new Error(`Gemini ${resp.status}`)
    const data = await resp.json()
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text
    if (!text) throw new Error('No response from Gemini')
    return JSON.parse(text) as T
  } finally {
    clearTimeout(timeout)
  }
}

// ─── Embedding helper ─────────────────────────────────────────────────
async function embedText(text: string): Promise<number[]> {
  const resp = await fetch(
    `${GEMINI_BASE}/gemini-embedding-001:embedContent?key=${GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'models/gemini-embedding-001',
        content: { parts: [{ text }] },
      }),
    },
  )
  const data = await resp.json()
  if (!data.embedding?.values) throw new Error('No embedding')
  return data.embedding.values as number[]
}

// ─── SSE helper ───────────────────────────────────────────────────────
function sendSSE(res: VercelResponse, event: string, data: Record<string, unknown>) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}
```

- [ ] **Step 2: Add the tool definitions (system prompt content)**

Add this below the SSE helper in `api/agent/run.ts`:

```typescript
// ─── Tool definitions for Gemini system prompt ────────────────────────
const TOOL_DEFINITIONS = `
You have access to these tools for querying a personal knowledge graph:

1. search_entities(query: string, entity_type?: string, limit?: number)
   Find people, concepts, projects, decisions, topics by name or description.
   Recommended first tool for broad exploration or specific entity lookup.
   entity_type options: Person, Organization, Team, Topic, Project, Goal, Action, Risk, Blocker, Decision, Insight, Question, Idea, Concept, Takeaway, Lesson, Document, Event, Location, Technology, Product, Metric, Hypothesis, Anchor

2. search_sources(query: string, type?: string, date_from?: string, date_to?: string, sort?: string)
   Search source titles with filters for type, date, and participant.
   type options: Meeting, YouTube, Research, Note, Document, GitHub
   sort options: recent, relevant

3. search_skills(query: string)
   Find methodology skills by describing the task. Returns skill names and descriptions.

4. get_skill_content(skill_name: string)
   Load the full methodology for a specific skill by its kebab-case name.
   Use after search_skills identifies a relevant skill.

5. get_skills(include_drafts: boolean)
   List all skills in the library. Always pass include_drafts: true.

6. get_entity(entity_id: string)
   Full detail for a specific entity including all direct connections and source appearances.
   Requires an entity UUID obtained from search_entities or get_connections.

7. get_connections(entity_id: string, hops?: number)
   Traverse relationships around an entity up to 3 hops. Default hops=2.
   Requires an entity UUID.

8. get_source_content(source_id: string)
   Read the full raw content of a source. Use for deep single-source analysis.
   Requires a source UUID obtained from search_sources or get_recent_sources.

9. get_meeting_brief(source_id: string)
   Quick structured meeting summary for pre-meeting preparation.

10. get_meeting_notes(source_id: string)
    Structured meeting output: overview, key topics, decisions, action items.

11. get_meeting_transcript(source_id: string)
    Full verbatim transcript with speaker labels. Use when exact quotes matter.

12. get_recent_sources(limit?: number, type?: string)
    List recently ingested sources with indexing status.

13. get_related_sources(source_id: string)
    Find sources that share entity connections with a given source.

14. list_anchors(limit?: number)
    Get the user's most important recurring entities (highest connectivity hubs).
    Use when exploring cross-domain connections or understanding the knowledge landscape.

15. ask_synapse(query: string)
    Semantic RAG search across source chunks. Best for specific factual questions.
    Poor for abstract or thematic queries. Use search_entities for thematic exploration.

16. consult_council(query: string, agent_ids?: string[])
    Multi-perspective advisory analysis from domain advisors.
    Use for strategic questions spanning multiple knowledge domains, not for factual lookups.
    This is slow (20-30s). Only use when the question genuinely needs cross-domain synthesis.

17. send_to_synapse(content: string, type?: string)
    WRITE OPERATION. Send content to Synapse for ingestion.
    Only use if the user explicitly asks to save or ingest something.

## How to respond

Respond with a JSON object. Either call a tool:
{
  "action": "tool_call",
  "tool": "<tool_name>",
  "params": { ... },
  "reasoning": "Brief explanation of why you're calling this tool"
}

Or give your final answer when you have enough information:
{
  "action": "answer",
  "text": "Your synthesized answer in markdown format",
  "reasoning": "Brief explanation of how you arrived at this answer"
}

## Guidelines

- Orient before deep-diving. Start with broad searches, then drill into specifics.
- Each tool result gives you new information. Use it to decide what to do next.
- Don't call ask_synapse for abstract queries. Use search_entities instead.
- Don't call consult_council unless the question genuinely spans multiple knowledge domains.
- Don't call send_to_synapse unless the user explicitly asks to save something.
- When you have enough information to answer, stop calling tools and give your answer.
- Keep answers concise and well-structured. Use markdown formatting.
- If a tool returns no results, try a different approach rather than repeating the same call.
- Maximum 10 tool calls per question. If you reach 8, start synthesizing.
`

const SYSTEM_PROMPT = `You are an AI agent with access to a personal knowledge graph called Synapse. The user asks questions and you use the available tools to find the best answer. You analyze each question, decide which tools to call, read the results, and either call more tools or synthesize a final answer.

${TOOL_DEFINITIONS}`
```

- [ ] **Step 3: Add all 17 tool executor functions**

Add this below the tool definitions in `api/agent/run.ts`:

```typescript
// ─── Tool executors ───────────────────────────────────────────────────
// Each function receives parsed params + Supabase client + userId
// Returns a JSON-serialisable result object

type ToolExecutor = (
  params: Record<string, unknown>,
  sb: SupabaseClient,
  userId: string,
) => Promise<Record<string, unknown>>

async function execSearchEntities(
  params: Record<string, unknown>,
  sb: SupabaseClient,
  userId: string,
): Promise<Record<string, unknown>> {
  const query = String(params.query ?? '')
  const entityType = params.entity_type as string | undefined
  const limit = Math.min(Number(params.limit) || 10, 20)

  // Semantic search via embedding
  let semanticResults: Array<Record<string, unknown>> = []
  try {
    const embedding = await embedText(query)
    const { data } = await sb.rpc('match_knowledge_nodes', {
      query_embedding: JSON.stringify(embedding),
      match_threshold: 0.3,
      match_count: limit,
      p_user_id: userId,
    })
    semanticResults = (data ?? []).map((r: Record<string, unknown>) => ({
      id: r.id,
      label: r.label,
      entity_type: r.entity_type,
      description: r.description,
      similarity: r.similarity,
    }))
  } catch { /* fallback to keyword only */ }

  // Keyword fallback
  let kw = sb.from('knowledge_nodes')
    .select('id, label, entity_type, description')
    .eq('user_id', userId)
    .or(`label.ilike.%${query}%,description.ilike.%${query}%`)
  if (entityType) kw = kw.eq('entity_type', entityType)
  const { data: kwData } = await kw.limit(limit)

  // Merge and deduplicate
  const seen = new Set(semanticResults.map(r => r.id as string))
  const merged = [...semanticResults]
  for (const r of kwData ?? []) {
    if (!seen.has(r.id)) {
      merged.push({ ...r, similarity: null })
      seen.add(r.id)
    }
  }

  return { entities: merged.slice(0, limit), total: merged.length }
}

async function execSearchSources(
  params: Record<string, unknown>,
  sb: SupabaseClient,
  userId: string,
): Promise<Record<string, unknown>> {
  const query = String(params.query ?? '')
  const type = params.type as string | undefined
  const dateFrom = params.date_from as string | undefined
  const dateTo = params.date_to as string | undefined
  const sort = (params.sort as string) ?? 'recent'
  const limit = 10

  let q = sb.from('knowledge_sources')
    .select('id, title, source_type, source_url, created_at, participants')
    .eq('user_id', userId)
    .or(`title.ilike.%${query}%`)

  if (type) q = q.eq('source_type', type)
  if (dateFrom) q = q.gte('created_at', dateFrom)
  if (dateTo) q = q.lt('created_at', dateTo)
  q = q.order('created_at', { ascending: false }).limit(limit)

  const { data, error } = await q
  if (error) return { error: error.message, sources: [] }
  return { sources: data ?? [] }
}

async function execSearchSkills(
  params: Record<string, unknown>,
  sb: SupabaseClient,
  userId: string,
): Promise<Record<string, unknown>> {
  const query = String(params.query ?? '')
  const { data } = await sb.from('skills')
    .select('name, description, category, is_draft')
    .eq('user_id', userId)
    .or(`name.ilike.%${query}%,description.ilike.%${query}%`)
    .limit(10)
  return { skills: data ?? [] }
}

async function execGetSkillContent(
  params: Record<string, unknown>,
  sb: SupabaseClient,
  userId: string,
): Promise<Record<string, unknown>> {
  const name = String(params.skill_name ?? '')
  const { data } = await sb.from('skills')
    .select('name, description, content, category, examples')
    .eq('user_id', userId)
    .eq('name', name)
    .maybeSingle()
  if (!data) return { error: `Skill "${name}" not found` }
  return { skill: data }
}

async function execGetSkills(
  params: Record<string, unknown>,
  sb: SupabaseClient,
  userId: string,
): Promise<Record<string, unknown>> {
  const includeDrafts = params.include_drafts !== false
  let q = sb.from('skills')
    .select('name, description, category, is_draft')
    .eq('user_id', userId)
  if (!includeDrafts) q = q.eq('is_draft', false)
  const { data } = await q.limit(50)
  return { skills: data ?? [] }
}

async function execGetEntity(
  params: Record<string, unknown>,
  sb: SupabaseClient,
  userId: string,
): Promise<Record<string, unknown>> {
  const entityId = String(params.entity_id ?? '')
  const { data: node } = await sb.from('knowledge_nodes')
    .select('id, label, entity_type, description, confidence, is_anchor, source_id, created_at')
    .eq('id', entityId)
    .eq('user_id', userId)
    .maybeSingle()
  if (!node) return { error: 'Entity not found' }

  // Get direct connections
  const { data: edges } = await sb.from('knowledge_edges')
    .select('source_node_id, target_node_id, relation_type, evidence, weight')
    .eq('user_id', userId)
    .or(`source_node_id.eq.${entityId},target_node_id.eq.${entityId}`)
    .limit(30)

  // Get connected node labels
  const connectedIds = new Set<string>()
  for (const e of edges ?? []) {
    if (e.source_node_id !== entityId) connectedIds.add(e.source_node_id)
    if (e.target_node_id !== entityId) connectedIds.add(e.target_node_id)
  }
  const { data: connectedNodes } = connectedIds.size > 0
    ? await sb.from('knowledge_nodes')
        .select('id, label, entity_type')
        .in('id', Array.from(connectedIds))
    : { data: [] }

  const nodeMap = new Map((connectedNodes ?? []).map(n => [n.id, n]))

  const connections = (edges ?? []).map(e => {
    const isSource = e.source_node_id === entityId
    const otherId = isSource ? e.target_node_id : e.source_node_id
    const other = nodeMap.get(otherId)
    return {
      relation: e.relation_type,
      direction: isSource ? 'outgoing' : 'incoming',
      target: other ? { id: other.id, label: other.label, entity_type: other.entity_type } : { id: otherId },
      evidence: e.evidence,
    }
  })

  return { entity: node, connections }
}

async function execGetConnections(
  params: Record<string, unknown>,
  sb: SupabaseClient,
  userId: string,
): Promise<Record<string, unknown>> {
  const entityId = String(params.entity_id ?? '')
  const maxHops = Math.min(Number(params.hops) || 2, 3)

  // Start node
  const { data: root } = await sb.from('knowledge_nodes')
    .select('id, label, entity_type')
    .eq('id', entityId)
    .eq('user_id', userId)
    .maybeSingle()
  if (!root) return { error: 'Entity not found' }

  const visited = new Map<string, Record<string, unknown>>()
  visited.set(root.id, root)
  let frontier = [root.id]
  const allEdges: Array<Record<string, unknown>> = []

  for (let hop = 0; hop < maxHops && frontier.length > 0; hop++) {
    const { data: edges } = await sb.from('knowledge_edges')
      .select('source_node_id, target_node_id, relation_type')
      .eq('user_id', userId)
      .or(frontier.map(id => `source_node_id.eq.${id},target_node_id.eq.${id}`).join(','))
      .limit(100)

    const newIds = new Set<string>()
    for (const e of edges ?? []) {
      allEdges.push(e)
      if (!visited.has(e.source_node_id)) newIds.add(e.source_node_id)
      if (!visited.has(e.target_node_id)) newIds.add(e.target_node_id)
    }

    if (newIds.size > 0) {
      const { data: newNodes } = await sb.from('knowledge_nodes')
        .select('id, label, entity_type')
        .in('id', Array.from(newIds))
      for (const n of newNodes ?? []) visited.set(n.id, n)
    }

    frontier = Array.from(newIds).filter(id => visited.has(id))
    if (visited.size > 30) break
  }

  return {
    root: root,
    nodes: Array.from(visited.values()),
    edges: allEdges,
    hops_traversed: maxHops,
  }
}

async function execGetSourceContent(
  params: Record<string, unknown>,
  sb: SupabaseClient,
  userId: string,
): Promise<Record<string, unknown>> {
  const sourceId = String(params.source_id ?? '')
  const { data } = await sb.from('knowledge_sources')
    .select('id, title, source_type, content, source_url, participants, created_at')
    .eq('id', sourceId)
    .eq('user_id', userId)
    .maybeSingle()
  if (!data) return { error: 'Source not found' }
  // Truncate very long content to avoid blowing up the Gemini context
  const content = data.content && data.content.length > 15000
    ? data.content.slice(0, 15000) + '\n\n[Content truncated - showing first 15,000 characters]'
    : data.content
  return { source: { ...data, content } }
}

async function execGetMeetingBrief(
  params: Record<string, unknown>,
  sb: SupabaseClient,
  userId: string,
): Promise<Record<string, unknown>> {
  const sourceId = String(params.source_id ?? '')
  const { data: source } = await sb.from('knowledge_sources')
    .select('id, title, source_type, content, participants, created_at, metadata')
    .eq('id', sourceId)
    .eq('user_id', userId)
    .maybeSingle()
  if (!source) return { error: 'Source not found' }

  // Get extracted entities for this source
  const { data: entities } = await sb.from('knowledge_nodes')
    .select('label, entity_type, description')
    .eq('source_id', sourceId)
    .eq('user_id', userId)
    .limit(20)

  return {
    brief: {
      title: source.title,
      type: source.source_type,
      date: source.created_at,
      participants: source.participants,
      entity_count: (entities ?? []).length,
      key_entities: (entities ?? []).map(e => ({ label: e.label, type: e.entity_type })),
      content_preview: source.content?.slice(0, 2000) ?? '',
    },
  }
}

async function execGetMeetingNotes(
  params: Record<string, unknown>,
  sb: SupabaseClient,
  userId: string,
): Promise<Record<string, unknown>> {
  const sourceId = String(params.source_id ?? '')
  const { data: source } = await sb.from('knowledge_sources')
    .select('id, title, source_type, content, participants, created_at, metadata')
    .eq('id', sourceId)
    .eq('user_id', userId)
    .maybeSingle()
  if (!source) return { error: 'Source not found' }

  const { data: entities } = await sb.from('knowledge_nodes')
    .select('label, entity_type, description')
    .eq('source_id', sourceId)
    .eq('user_id', userId)
    .limit(30)

  const { data: edges } = await sb.from('knowledge_edges')
    .select('source_node_id, target_node_id, relation_type, evidence')
    .eq('user_id', userId)
    .in('source_node_id', (entities ?? []).map(e => e.label)) // approximate filter
    .limit(30)

  return {
    notes: {
      title: source.title,
      type: source.source_type,
      date: source.created_at,
      participants: source.participants,
      content: source.content && source.content.length > 15000
        ? source.content.slice(0, 15000) + '\n[Truncated]'
        : source.content,
      entities: entities ?? [],
      relationships: edges ?? [],
    },
  }
}

async function execGetMeetingTranscript(
  params: Record<string, unknown>,
  sb: SupabaseClient,
  userId: string,
): Promise<Record<string, unknown>> {
  const sourceId = String(params.source_id ?? '')
  const { data } = await sb.from('knowledge_sources')
    .select('id, title, content, participants, created_at')
    .eq('id', sourceId)
    .eq('user_id', userId)
    .maybeSingle()
  if (!data) return { error: 'Source not found' }
  const content = data.content && data.content.length > 20000
    ? data.content.slice(0, 20000) + '\n\n[Transcript truncated - showing first 20,000 characters]'
    : data.content
  return { transcript: { ...data, content } }
}

async function execGetRecentSources(
  params: Record<string, unknown>,
  sb: SupabaseClient,
  userId: string,
): Promise<Record<string, unknown>> {
  const limit = Math.min(Number(params.limit) || 10, 20)
  const type = params.type as string | undefined

  let q = sb.from('knowledge_sources')
    .select('id, title, source_type, source_url, created_at, participants')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })

  if (type) q = q.eq('source_type', type)
  const { data } = await q.limit(limit)
  return { sources: data ?? [] }
}

async function execGetRelatedSources(
  params: Record<string, unknown>,
  sb: SupabaseClient,
  userId: string,
): Promise<Record<string, unknown>> {
  const sourceId = String(params.source_id ?? '')

  // Get entities from this source
  const { data: entities } = await sb.from('knowledge_nodes')
    .select('id')
    .eq('source_id', sourceId)
    .eq('user_id', userId)
    .limit(50)
  if (!entities?.length) return { related_sources: [] }

  const entityIds = entities.map(e => e.id)

  // Find other entities connected to these
  const { data: edges } = await sb.from('knowledge_edges')
    .select('source_node_id, target_node_id')
    .eq('user_id', userId)
    .or(entityIds.map(id => `source_node_id.eq.${id},target_node_id.eq.${id}`).join(','))
    .limit(100)

  const connectedNodeIds = new Set<string>()
  for (const e of edges ?? []) {
    if (!entityIds.includes(e.source_node_id)) connectedNodeIds.add(e.source_node_id)
    if (!entityIds.includes(e.target_node_id)) connectedNodeIds.add(e.target_node_id)
  }

  if (connectedNodeIds.size === 0) return { related_sources: [] }

  // Find sources these connected nodes belong to
  const { data: relatedNodes } = await sb.from('knowledge_nodes')
    .select('source_id')
    .in('id', Array.from(connectedNodeIds))
    .not('source_id', 'is', null)
    .limit(50)

  const relatedSourceIds = [...new Set((relatedNodes ?? []).map(n => n.source_id).filter(Boolean))]
    .filter(id => id !== sourceId)
    .slice(0, 10)

  if (relatedSourceIds.length === 0) return { related_sources: [] }

  const { data: sources } = await sb.from('knowledge_sources')
    .select('id, title, source_type, created_at')
    .in('id', relatedSourceIds)
    .eq('user_id', userId)

  return { related_sources: sources ?? [] }
}

async function execListAnchors(
  params: Record<string, unknown>,
  sb: SupabaseClient,
  userId: string,
): Promise<Record<string, unknown>> {
  const limit = Math.min(Number(params.limit) || 30, 50)
  const { data } = await sb.from('knowledge_nodes')
    .select('id, label, entity_type, description')
    .eq('user_id', userId)
    .eq('is_anchor', true)
    .limit(limit)
  return { anchors: data ?? [] }
}

async function execAskSynapse(
  params: Record<string, unknown>,
  sb: SupabaseClient,
  userId: string,
): Promise<Record<string, unknown>> {
  const query = String(params.query ?? '')

  // Semantic chunk search
  let chunks: Array<Record<string, unknown>> = []
  try {
    const embedding = await embedText(query)
    const { data } = await sb.rpc('match_source_chunks', {
      query_embedding: JSON.stringify(embedding),
      match_threshold: 0.3,
      match_count: 8,
      p_user_id: userId,
    })
    chunks = data ?? []
  } catch { /* empty */ }

  if (chunks.length === 0) return { answer_context: 'No relevant content found for this query.', chunks: [] }

  // Get source titles for context
  const sourceIds = [...new Set(chunks.map((c: Record<string, unknown>) => c.source_id as string))]
  const { data: sources } = await sb.from('knowledge_sources')
    .select('id, title, source_type')
    .in('id', sourceIds)
    .eq('user_id', userId)
  const sourceMap = new Map((sources ?? []).map(s => [s.id, s]))

  const enrichedChunks = chunks.map((c: Record<string, unknown>) => {
    const src = sourceMap.get(c.source_id as string)
    return {
      content: c.content,
      similarity: c.similarity,
      source_id: c.source_id,
      source_title: src?.title ?? 'Unknown',
      source_type: src?.source_type ?? 'Unknown',
    }
  })

  return { chunks: enrichedChunks }
}

async function execConsultCouncil(
  params: Record<string, unknown>,
  sb: SupabaseClient,
  userId: string,
): Promise<Record<string, unknown>> {
  const query = String(params.query ?? '')
  const agentIds = params.agent_ids as string[] | undefined

  // Fetch available agents
  let agentQuery = sb.from('domain_agents')
    .select('id, name, description, reasoning_style')
    .eq('user_id', userId)
    .eq('is_active', true)
  if (agentIds?.length) agentQuery = agentQuery.in('id', agentIds)
  const { data: agents } = await agentQuery.limit(5)

  if (!agents?.length) return { error: 'No active domain advisors found' }

  // Run simplified council: route + brief analysis per agent
  const perspectives = await Promise.allSettled(
    agents.map(async (agent) => {
      // Get domain-scoped chunks
      const embedding = await embedText(query)
      const { data: chunks } = await sb.rpc('get_domain_scoped_chunks', {
        p_agent_id: agent.id,
        p_query_embedding: JSON.stringify(embedding),
        p_match_threshold: 0.5,
        p_match_count: 5,
      })
      const chunkText = (chunks ?? [])
        .map((c: Record<string, unknown>, i: number) => `[${i + 1}] ${c.content}`)
        .join('\n\n')

      const analysis = await geminiJson<{ analysis: string; key_points: string[] }>(
        `You are ${agent.name}, a domain advisor with this reasoning style: ${agent.reasoning_style}. Analyze the question using your domain expertise and the provided source material. Return JSON with "analysis" (2-3 paragraphs) and "key_points" (array of 3-5 bullet points).`,
        [{ role: 'user', content: `Question: ${query}\n\nSource Material:\n${chunkText || 'No domain-specific sources found.'}` }],
        0.3,
        30000,
      )

      return { agent_name: agent.name, agent_id: agent.id, ...analysis }
    }),
  )

  const results = perspectives
    .filter((r): r is PromiseFulfilledResult<Record<string, unknown>> => r.status === 'fulfilled')
    .map(r => r.value)

  return { council_perspectives: results }
}

async function execSendToSynapse(
  params: Record<string, unknown>,
  sb: SupabaseClient,
  userId: string,
): Promise<Record<string, unknown>> {
  const content = String(params.content ?? '')
  const type = (params.type as string) ?? 'Note'
  if (!content.trim()) return { error: 'No content provided' }

  const title = content.slice(0, 80) + (content.length > 80 ? '...' : '')
  const { data, error } = await sb.from('knowledge_sources')
    .insert({ user_id: userId, title, content, source_type: type })
    .select('id, title')
    .single()
  if (error) return { error: error.message }
  return { saved: true, source_id: data.id, title: data.title }
}

// ─── Tool executor map ────────────────────────────────────────────────
const TOOL_EXECUTORS: Record<string, ToolExecutor> = {
  search_entities: execSearchEntities,
  search_sources: execSearchSources,
  search_skills: execSearchSkills,
  get_skill_content: execGetSkillContent,
  get_skills: execGetSkills,
  get_entity: execGetEntity,
  get_connections: execGetConnections,
  get_source_content: execGetSourceContent,
  get_meeting_brief: execGetMeetingBrief,
  get_meeting_notes: execGetMeetingNotes,
  get_meeting_transcript: execGetMeetingTranscript,
  get_recent_sources: execGetRecentSources,
  get_related_sources: execGetRelatedSources,
  list_anchors: execListAnchors,
  ask_synapse: execAskSynapse,
  consult_council: execConsultCouncil,
  send_to_synapse: execSendToSynapse,
}
```

- [ ] **Step 4: Add the orchestration loop and handler**

Add this at the bottom of `api/agent/run.ts`:

```typescript
// ─── Orchestration types ──────────────────────────────────────────────
interface GeminiToolCall {
  action: 'tool_call'
  tool: string
  params: Record<string, unknown>
  reasoning?: string
}

interface GeminiAnswer {
  action: 'answer'
  text: string
  reasoning?: string
}

type GeminiResponse = GeminiToolCall | GeminiAnswer

// ─── Main handler ─────────────────────────────────────────────────────
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const userId = await getUser(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })

  const { query, conversation_history } = req.body as {
    query: string
    conversation_history?: Array<{ role: string; content: string }>
  }
  if (!query?.trim()) return res.status(400).json({ error: 'Missing query' })

  // Set up SSE
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('Access-Control-Allow-Origin', '*')

  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
  const MAX_CALLS = 10

  // Build conversation for Gemini
  const messages: Array<{ role: string; content: string }> = [
    ...(conversation_history ?? []),
    { role: 'user', content: query },
  ]

  let callIndex = 0

  try {
    for (let i = 0; i < MAX_CALLS; i++) {
      // Ask Gemini what to do next
      const geminiResp = await geminiJson<GeminiResponse>(
        SYSTEM_PROMPT,
        messages,
        0.2,
        20000,
      )

      // If Gemini wants to give a final answer
      if (geminiResp.action === 'answer') {
        if (geminiResp.reasoning) {
          sendSSE(res, 'thinking', { text: geminiResp.reasoning })
        }
        sendSSE(res, 'answer', { text: geminiResp.text })
        sendSSE(res, 'done', {})
        res.end()
        return
      }

      // If Gemini wants to call a tool
      if (geminiResp.action === 'tool_call') {
        const toolName = geminiResp.tool
        const toolParams = geminiResp.params ?? {}
        const executor = TOOL_EXECUTORS[toolName]

        if (geminiResp.reasoning) {
          sendSSE(res, 'thinking', { text: geminiResp.reasoning })
        }

        sendSSE(res, 'tool_start', {
          tool: toolName,
          params: toolParams,
          call_index: callIndex,
        })

        if (!executor) {
          const errMsg = `Unknown tool: ${toolName}`
          sendSSE(res, 'tool_error', { call_index: callIndex, error: errMsg })
          messages.push({
            role: 'assistant',
            content: JSON.stringify({ action: 'tool_call', tool: toolName, params: toolParams }),
          })
          messages.push({ role: 'user', content: `Tool error: ${errMsg}. Try a different approach.` })
          callIndex++
          continue
        }

        const startTime = Date.now()
        try {
          const result = await executor(toolParams, sb, userId)
          const duration = Date.now() - startTime

          sendSSE(res, 'tool_result', {
            call_index: callIndex,
            result,
            duration_ms: duration,
          })

          // Append tool call + result to conversation for next Gemini turn
          messages.push({
            role: 'assistant',
            content: JSON.stringify({ action: 'tool_call', tool: toolName, params: toolParams }),
          })
          messages.push({
            role: 'user',
            content: `Tool result for ${toolName}:\n${JSON.stringify(result, null, 2)}`,
          })
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : 'Tool execution failed'
          sendSSE(res, 'tool_error', { call_index: callIndex, error: errMsg })
          messages.push({
            role: 'assistant',
            content: JSON.stringify({ action: 'tool_call', tool: toolName, params: toolParams }),
          })
          messages.push({
            role: 'user',
            content: `Tool error for ${toolName}: ${errMsg}. Try a different approach.`,
          })
        }

        callIndex++
        continue
      }

      // Unexpected response format - force an answer
      break
    }

    // Safety valve: if we hit MAX_CALLS, force Gemini to synthesize
    messages.push({
      role: 'user',
      content: 'You have reached the maximum number of tool calls. Please synthesize your final answer now based on everything you have gathered so far.',
    })

    const finalResp = await geminiJson<GeminiAnswer>(
      SYSTEM_PROMPT,
      messages,
      0.2,
      20000,
    )

    sendSSE(res, 'answer', { text: finalResp.text ?? 'I was unable to synthesize a complete answer.' })
    sendSSE(res, 'done', {})
    res.end()
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : 'Agent loop failed'
    sendSSE(res, 'error', { message: errMsg })
    sendSSE(res, 'done', {})
    res.end()
  }
}
```

- [ ] **Step 5: Verify the file compiles**

Run: `npx tsc --noEmit api/agent/run.ts --esModuleInterop --moduleResolution node --target es2020 --module commonjs --skipLibCheck 2>&1 | head -20`

If there are type errors, fix them. The most likely issues are Supabase generic types - use `as` casts where needed.

- [ ] **Step 6: Commit**

```bash
git add api/agent/run.ts
git commit -m "feat(agent): add /api/agent/run orchestration endpoint with 17 tool executors"
```

---

## Task 3: Build the useAgentQuery Hook

**Files:**
- Create: `src/hooks/useAgentQuery.ts`

**Reference:** `src/hooks/useCouncilQuery.ts` for auth pattern and state management.

- [ ] **Step 1: Create the hook**

```typescript
// src/hooks/useAgentQuery.ts
import { useState, useRef, useCallback } from 'react'
import { supabase } from '../services/supabase'
import type { AgentToolCall, AgentQueryState, AgentSSEEvent } from '../types/agent'
import { INITIAL_AGENT_STATE } from '../types/agent'
import type { ChatMessage } from '../types/rag'

async function getAuthHeaders(): Promise<Record<string, string>> {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session?.access_token) throw new Error('Not authenticated')
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${session.access_token}`,
  }
}

export function useAgentQuery() {
  const [state, setState] = useState<AgentQueryState>(INITIAL_AGENT_STATE)
  const abortRef = useRef<AbortController | null>(null)

  const sendAgentQuery = useCallback(async (
    query: string,
    conversationHistory: ChatMessage[] = [],
  ) => {
    // Abort any in-flight request
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller

    setState({
      ...INITIAL_AGENT_STATE,
      status: 'running',
    })

    try {
      const headers = await getAuthHeaders()
      const historyForApi = conversationHistory.map(m => ({
        role: m.role,
        content: m.content,
      }))

      const resp = await fetch('/api/agent/run', {
        method: 'POST',
        headers,
        signal: controller.signal,
        body: JSON.stringify({
          query,
          conversation_history: historyForApi,
        }),
      })

      if (!resp.ok) {
        const errBody = await resp.text()
        throw new Error(`Agent API error ${resp.status}: ${errBody}`)
      }

      if (!resp.body) throw new Error('No response body')

      // Read SSE stream
      const reader = resp.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        let eventType = ''
        for (const line of lines) {
          if (line.startsWith('event: ')) {
            eventType = line.slice(7).trim()
          } else if (line.startsWith('data: ') && eventType) {
            try {
              const data = JSON.parse(line.slice(6)) as Record<string, unknown>
              processEvent({ type: eventType, ...data } as unknown as AgentSSEEvent)
            } catch { /* skip malformed JSON */ }
            eventType = ''
          }
        }
      }

      // Mark complete if not already
      setState(prev => prev.status === 'error' ? prev : { ...prev, status: 'complete' })
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return
      const message = err instanceof Error ? err.message : 'Agent query failed'
      setState(prev => ({ ...prev, status: 'error', error: message }))
    }
  }, [])

  function processEvent(event: AgentSSEEvent) {
    switch (event.type) {
      case 'tool_start':
        setState(prev => ({
          ...prev,
          toolCalls: [
            ...prev.toolCalls,
            {
              index: event.call_index,
              tool: event.tool,
              params: event.params,
              result: null,
              status: 'running',
            },
          ],
          thinking: null,
        }))
        break

      case 'tool_result':
        setState(prev => ({
          ...prev,
          toolCalls: prev.toolCalls.map(tc =>
            tc.index === event.call_index
              ? { ...tc, result: event.result, status: 'complete' as const, duration_ms: event.duration_ms }
              : tc,
          ),
        }))
        break

      case 'tool_error':
        setState(prev => ({
          ...prev,
          toolCalls: prev.toolCalls.map(tc =>
            tc.index === event.call_index
              ? { ...tc, status: 'error' as const, error: event.error }
              : tc,
          ),
        }))
        break

      case 'thinking':
        setState(prev => ({ ...prev, thinking: event.text }))
        break

      case 'answer':
        setState(prev => ({
          ...prev,
          answer: event.text,
          citations: event.citations ?? [],
          thinking: null,
        }))
        break

      case 'error':
        setState(prev => ({
          ...prev,
          status: 'error',
          error: event.message,
        }))
        break

      case 'done':
        setState(prev => prev.status === 'error' ? prev : { ...prev, status: 'complete' })
        break
    }
  }

  const reset = useCallback(() => {
    abortRef.current?.abort()
    setState(INITIAL_AGENT_STATE)
  }, [])

  return {
    agentState: state,
    sendAgentQuery,
    resetAgent: reset,
  }
}
```

- [ ] **Step 2: Verify build**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/hooks/useAgentQuery.ts
git commit -m "feat(agent): add useAgentQuery hook with SSE stream consumer"
```

---

## Task 4: Build the AgentToolBlock Component

**Files:**
- Create: `src/components/ask/AgentToolBlock.tsx`

- [ ] **Step 1: Create the component**

```typescript
// src/components/ask/AgentToolBlock.tsx
import { useState } from 'react'
import { Search, FileText, Database, Loader2, AlertCircle } from 'lucide-react'
import type { AgentToolCall } from '../../types/agent'

// Map tool names to human-readable labels
const TOOL_LABELS: Record<string, string> = {
  search_entities: 'Search entities',
  search_sources: 'Search sources',
  search_skills: 'Search skills',
  get_skill_content: 'Get skill content',
  get_skills: 'List skills',
  get_entity: 'Get entity details',
  get_connections: 'Get connections',
  get_source_content: 'Get source content',
  get_meeting_brief: 'Get meeting brief',
  get_meeting_notes: 'Get meeting notes',
  get_meeting_transcript: 'Get meeting transcript',
  get_recent_sources: 'Get recent sources',
  get_related_sources: 'Get related sources',
  list_anchors: 'List anchors',
  ask_synapse: 'Ask Synapse',
  consult_council: 'Consult council',
  send_to_synapse: 'Send to Synapse',
}

// Categorise tools for icon selection
const SEARCH_TOOLS = new Set(['search_entities', 'search_sources', 'search_skills', 'ask_synapse'])
const CONTENT_TOOLS = new Set(['get_source_content', 'get_meeting_brief', 'get_meeting_notes', 'get_meeting_transcript', 'get_skill_content'])

function getToolIcon(tool: string) {
  if (SEARCH_TOOLS.has(tool)) return Search
  if (CONTENT_TOOLS.has(tool)) return FileText
  return Database
}

interface AgentToolBlockProps {
  toolCall: AgentToolCall
}

export function AgentToolBlock({ toolCall }: AgentToolBlockProps) {
  const [expanded, setExpanded] = useState(false)
  const Icon = getToolIcon(toolCall.tool)
  const label = TOOL_LABELS[toolCall.tool] ?? toolCall.tool
  const isRunning = toolCall.status === 'running'
  const isError = toolCall.status === 'error'

  return (
    <div style={{ marginLeft: 20, position: 'relative' }}>
      {/* Clickable header */}
      <button
        type="button"
        onClick={() => !isRunning && setExpanded(!expanded)}
        className="font-body"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '6px 0',
          background: 'none',
          border: 'none',
          cursor: isRunning ? 'default' : 'pointer',
          width: '100%',
          textAlign: 'left',
        }}
      >
        {/* Icon */}
        <span
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 24,
            height: 24,
            borderRadius: 6,
            background: isError ? 'var(--color-red-50, #fef2f2)' : 'var(--color-bg-inset)',
            color: isError ? 'var(--color-red-500, #ef4444)' : 'var(--color-text-secondary)',
            flexShrink: 0,
          }}
        >
          {isRunning ? (
            <Loader2 size={14} className="animate-spin" />
          ) : isError ? (
            <AlertCircle size={14} />
          ) : (
            <Icon size={14} />
          )}
        </span>

        {/* Tool name */}
        <span
          style={{
            fontSize: 13,
            color: 'var(--color-text-primary)',
            fontWeight: 500,
            flex: 1,
          }}
        >
          {label}
        </span>

        {/* Result badge */}
        {toolCall.status === 'complete' && (
          <span
            className="font-body"
            style={{
              fontSize: 11,
              fontWeight: 600,
              padding: '2px 8px',
              borderRadius: 6,
              background: 'var(--color-bg-inset)',
              color: 'var(--color-text-secondary)',
            }}
          >
            Result
          </span>
        )}
        {isError && (
          <span
            className="font-body"
            style={{
              fontSize: 11,
              fontWeight: 600,
              padding: '2px 8px',
              borderRadius: 6,
              background: 'var(--color-red-50, #fef2f2)',
              color: 'var(--color-red-500, #ef4444)',
            }}
          >
            Error
          </span>
        )}
      </button>

      {/* Expanded content */}
      {expanded && (
        <div
          style={{
            marginTop: 4,
            marginBottom: 8,
            borderRadius: 10,
            border: '1px solid var(--border-subtle)',
            background: 'var(--color-bg-card)',
            overflow: 'hidden',
          }}
        >
          {/* Request */}
          <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border-subtle)' }}>
            <div
              className="font-body"
              style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-secondary)', marginBottom: 6 }}
            >
              Request
            </div>
            <pre
              className="font-mono"
              style={{
                fontSize: 12,
                color: 'var(--color-text-primary)',
                margin: 0,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
            >
              {JSON.stringify(toolCall.params, null, 2)}
            </pre>
          </div>

          {/* Response */}
          {(toolCall.result || toolCall.error) && (
            <div style={{ padding: '10px 14px', maxHeight: 300, overflowY: 'auto' }}>
              <div
                className="font-body"
                style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-secondary)', marginBottom: 6 }}
              >
                Response
              </div>
              <pre
                className="font-mono"
                style={{
                  fontSize: 12,
                  color: isError ? 'var(--color-red-500, #ef4444)' : 'var(--color-text-primary)',
                  margin: 0,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                }}
              >
                {isError
                  ? toolCall.error
                  : JSON.stringify(toolCall.result, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Verify build**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/components/ask/AgentToolBlock.tsx
git commit -m "feat(agent): add AgentToolBlock component with collapsible request/response"
```

---

## Task 5: Build the AgentToolChain Component

**Files:**
- Create: `src/components/ask/AgentToolChain.tsx`

- [ ] **Step 1: Create the component**

```typescript
// src/components/ask/AgentToolChain.tsx
import { CheckCircle2 } from 'lucide-react'
import { AgentToolBlock } from './AgentToolBlock'
import type { AgentToolCall } from '../../types/agent'

interface AgentToolChainProps {
  toolCalls: AgentToolCall[]
  isComplete: boolean
  thinking?: string | null
}

export function AgentToolChain({ toolCalls, isComplete, thinking }: AgentToolChainProps) {
  if (toolCalls.length === 0 && !thinking) return null

  return (
    <div style={{ position: 'relative', paddingLeft: 12 }}>
      {/* Vertical connecting line */}
      <div
        style={{
          position: 'absolute',
          left: 12,
          top: 8,
          bottom: isComplete ? 28 : 8,
          width: 2,
          background: 'var(--border-subtle)',
          borderRadius: 1,
        }}
      />

      {/* Tool call blocks */}
      {toolCalls.map(tc => (
        <AgentToolBlock key={tc.index} toolCall={tc} />
      ))}

      {/* Thinking indicator between tools */}
      {thinking && !isComplete && (
        <div
          className="font-body"
          style={{
            marginLeft: 20,
            padding: '6px 0',
            fontSize: 12,
            color: 'var(--color-text-secondary)',
            fontStyle: 'italic',
          }}
        >
          {thinking}
        </div>
      )}

      {/* Done indicator */}
      {isComplete && toolCalls.length > 0 && (
        <div
          style={{
            marginLeft: 20,
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '6px 0',
          }}
        >
          <CheckCircle2
            size={16}
            style={{ color: 'var(--color-text-secondary)' }}
          />
          <span
            className="font-body"
            style={{
              fontSize: 13,
              fontWeight: 600,
              color: 'var(--color-text-primary)',
            }}
          >
            Done
          </span>
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Verify build**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/components/ask/AgentToolChain.tsx
git commit -m "feat(agent): add AgentToolChain with vertical connector line and Done indicator"
```

---

## Task 6: Build the AgentResponse Component

**Files:**
- Create: `src/components/ask/AgentResponse.tsx`

- [ ] **Step 1: Create the component**

```typescript
// src/components/ask/AgentResponse.tsx
import { AgentToolChain } from './AgentToolChain'
import type { AgentQueryState } from '../../types/agent'

interface AgentResponseProps {
  state: AgentQueryState
}

export function AgentResponse({ state }: AgentResponseProps) {
  const isComplete = state.status === 'complete'
  const hasToolCalls = state.toolCalls.length > 0

  return (
    <div style={{ maxWidth: 1020, margin: '0 auto', padding: '0 24px' }}>
      {/* Tool call chain */}
      {(hasToolCalls || state.thinking) && (
        <div
          style={{
            padding: '12px 16px',
            marginBottom: 12,
            background: 'var(--color-bg-card)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 12,
          }}
        >
          <AgentToolChain
            toolCalls={state.toolCalls}
            isComplete={isComplete && state.answer !== null}
            thinking={state.thinking}
          />
        </div>
      )}

      {/* Final answer */}
      {state.answer && (
        <div
          className="font-body"
          style={{
            fontSize: 14,
            lineHeight: 1.65,
            color: 'var(--color-text-primary)',
            padding: '0 4px',
          }}
        >
          <div style={{ whiteSpace: 'pre-wrap' }}>{state.answer}</div>
        </div>
      )}

      {/* Error state */}
      {state.status === 'error' && state.error && (
        <div
          className="font-body"
          style={{
            fontSize: 13,
            color: 'var(--color-red-500, #ef4444)',
            padding: '8px 12px',
            background: 'var(--color-red-50, #fef2f2)',
            borderRadius: 8,
            marginTop: 8,
          }}
        >
          {state.error}
        </div>
      )}

      {/* Loading indicator when running but no tool calls yet */}
      {state.status === 'running' && !hasToolCalls && !state.thinking && (
        <div
          className="font-body"
          style={{
            fontSize: 13,
            color: 'var(--color-text-secondary)',
            padding: '12px 0',
            fontStyle: 'italic',
          }}
        >
          Analyzing your question...
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Verify build**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/components/ask/AgentResponse.tsx
git commit -m "feat(agent): add AgentResponse container component"
```

---

## Task 7: Wire Agent Mode into ChatInput

**Files:**
- Modify: `src/components/ask/ChatInput.tsx` (lines 173, 194, 199-210, 219)

- [ ] **Step 1: Update the mode toggle to include "Agent"**

In `src/components/ask/ChatInput.tsx`, find the mode toggle (around line 173):

```typescript
// Before
{(['standard', 'council'] as const).map(mode => {

// After
{(['standard', 'council', 'agent'] as const).map(mode => {
```

- [ ] **Step 2: Update the button label and color logic**

Find the button text rendering (around line 194):

```typescript
// Before
{mode === 'standard' ? 'Standard' : 'Council'}

// After
{mode === 'standard' ? 'Standard' : mode === 'council' ? 'Council' : 'Agent'}
```

Find the active color logic (around line 188):

```typescript
// Before
color: isActive
  ? (mode === 'council' ? 'var(--color-accent-500)' : 'var(--color-text-primary)')
  : 'var(--color-text-secondary)',

// After
color: isActive
  ? (mode === 'standard' ? 'var(--color-text-primary)' : 'var(--color-accent-500)')
  : 'var(--color-text-secondary)',
```

- [ ] **Step 3: Update the helper text and placeholder**

Find the council helper text block (around lines 199-210):

```typescript
// Before
{askMode === 'council' && (
  <p ...>
    Your question will be analysed by domain advisors with cross-perspective synthesis
  </p>
)}

// After
{askMode === 'council' && (
  <p
    className="font-body"
    style={{
      fontSize: 11,
      color: 'var(--color-text-secondary)',
      margin: '6px 0 0',
    }}
  >
    Your question will be analysed by domain advisors with cross-perspective synthesis
  </p>
)}
{askMode === 'agent' && (
  <p
    className="font-body"
    style={{
      fontSize: 11,
      color: 'var(--color-text-secondary)',
      margin: '6px 0 0',
    }}
  >
    Agent will automatically search your knowledge graph using the best tools for your question
  </p>
)}
```

Find the placeholder text (around line 219):

```typescript
// Before
placeholder={askMode === 'council'
  ? 'Ask your advisory council...'
  : 'Ask your knowledge graph anything...'}

// After
placeholder={askMode === 'council'
  ? 'Ask your advisory council...'
  : askMode === 'agent'
    ? 'Ask your agent anything...'
    : 'Ask your knowledge graph anything...'}
```

- [ ] **Step 4: Verify build**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/components/ask/ChatInput.tsx
git commit -m "feat(agent): add Agent pill to ChatInput mode toggle"
```

---

## Task 8: Wire Agent Mode into AskView

**Files:**
- Modify: `src/views/AskView.tsx`

- [ ] **Step 1: Add imports**

At the top of `src/views/AskView.tsx`, add these imports:

```typescript
// Add after the existing CouncilRightPanel import (line 24)
import { AgentResponse } from '../components/ask/AgentResponse'
import { useAgentQuery } from '../hooks/useAgentQuery'
```

- [ ] **Step 2: Add agent hook and state**

Inside the `AskView` function, after the `useCouncilQuery` line (line 45), add:

```typescript
const { agentState, sendAgentQuery, resetAgent } = useAgentQuery()
```

- [ ] **Step 3: Update handleSend to dispatch agent queries**

Find the `handleSend` function (lines 77-84):

```typescript
// Before
const handleSend = (text: string) => {
  if (askMode === 'council') {
    setCouncilQuery(text)
    void sendCouncilQuery(text)
  } else {
    void sendMessage(text, config)
  }
}

// After
const handleSend = (text: string) => {
  if (askMode === 'council') {
    setCouncilQuery(text)
    void sendCouncilQuery(text)
  } else if (askMode === 'agent') {
    setAgentQuery(text)
    void sendAgentQuery(text, messages)
  } else {
    void sendMessage(text, config)
  }
}
```

Also add the agent query state variable near `councilQuery` (after line 47):

```typescript
const [agentQuery, setAgentQuery] = useState<string>('')
```

- [ ] **Step 4: Update derived state and disabled logic**

Find `councilActive` and `hasContent` (lines 229-231):

```typescript
// Before
const councilActive = councilState.status !== 'idle'
const hasContent = hasMessages || councilActive

// After
const councilActive = councilState.status !== 'idle'
const agentActive = agentState.status !== 'idle'
const hasContent = hasMessages || councilActive || agentActive
```

Find the ChatInput `disabled` prop (line 419):

```typescript
// Before
disabled={isLoading || (askMode === 'council' && councilState.status !== 'idle' && councilState.status !== 'complete' && councilState.status !== 'error')}

// After
disabled={
  isLoading
  || (askMode === 'council' && councilState.status !== 'idle' && councilState.status !== 'complete' && councilState.status !== 'error')
  || (askMode === 'agent' && agentState.status === 'running')
}
```

- [ ] **Step 5: Add agent rendering branch**

Find the rendering conditional that starts with the empty state, then council, then standard (around lines 330-414). Insert the agent branch between council and standard:

```typescript
        // After the councilActive branch (after line 400, before the standard branch):
        ) : agentActive ? (
          /* ── Agent mode response ─────────────────────────────────── */
          <div
            ref={scroll.scrollRef}
            className="flex-1 overflow-y-auto"
            onScroll={scroll.onScroll}
            style={{ scrollBehavior: 'smooth' }}
          >
            {/* Show any previous standard messages above agent */}
            {hasMessages && (
              <ChatMessageList
                messages={messages}
                isLoading={false}
                pipelineEvents={[]}
                scroll={scroll}
                onFollowUpClick={handleFollowUp}
                onCitationClick={handleCitationClick}
                onCitationHoverChange={setHighlightedCitationIndex}
                onExploreMore={handleExploreMore}
                onSourceClick={handleSourceClick}
              />
            )}

            {/* Agent query (rendered as user message style) */}
            {agentQuery && (
              <div style={{ maxWidth: 1020, margin: '0 auto', padding: '0 24px' }}>
                <div className="flex justify-end" style={{ marginBottom: 12 }}>
                  <div
                    className="font-body"
                    style={{
                      fontSize: 13,
                      color: 'var(--color-text-primary)',
                      background: 'var(--color-accent-50)',
                      border: '1px solid rgba(214,58,0,0.08)',
                      borderRadius: '16px 16px 4px 16px',
                      padding: '10px 16px',
                      maxWidth: '75%',
                    }}
                  >
                    {agentQuery}
                  </div>
                </div>
              </div>
            )}

            {/* Agent response */}
            <AgentResponse state={agentState} />

            <div ref={scroll.bottomRef} style={{ height: 1 }} />
          </div>
```

- [ ] **Step 6: Update handleFollowUp for agent mode**

Find `handleFollowUp` (lines 90-97):

```typescript
// Before
const handleFollowUp = (question: string) => {
  if (askMode === 'council') {
    setCouncilQuery(question)
    void sendCouncilQuery(question)
  } else {
    void sendMessage(question, config)
  }
}

// After
const handleFollowUp = (question: string) => {
  if (askMode === 'council') {
    setCouncilQuery(question)
    void sendCouncilQuery(question)
  } else if (askMode === 'agent') {
    setAgentQuery(question)
    void sendAgentQuery(question, messages)
  } else {
    void sendMessage(question, config)
  }
}
```

- [ ] **Step 7: Verify build**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/views/AskView.tsx
git commit -m "feat(agent): wire Agent mode into AskView with dispatch, rendering, and follow-ups"
```

---

## Task 9: Manual Integration Test

**Files:** None (testing only)

- [ ] **Step 1: Start the dev server**

Run: `npm run dev`
Expected: Vite dev server starts on localhost:5173 or 5174

- [ ] **Step 2: Test the mode toggle**

1. Navigate to `/ask`
2. Verify three pills appear: Standard | Council | Agent
3. Click each pill - verify it toggles, placeholder text changes
4. Agent pill should show accent color when active
5. Helper text below toggle should read "Agent will automatically search your knowledge graph using the best tools for your question"

- [ ] **Step 3: Test an agent query**

1. Select "Agent" mode
2. Type a question like "What do I know about pricing strategy?"
3. Verify:
   - Your question appears as a right-aligned user bubble (accent background)
   - "Analyzing your question..." appears briefly
   - Tool call blocks appear with tool names and loading spinners
   - Each block shows "Result" badge when complete
   - Clicking a completed block expands to show Request/Response JSON
   - A vertical line connects all blocks on the left
   - "Done" with checkmark appears after the last tool call
   - Final answer text renders below the tool chain
4. If errors occur, check Vercel function logs or browser console

- [ ] **Step 4: Test edge cases**

1. Send a very simple question ("Hello") - agent should answer quickly with 0-1 tool calls
2. Send a complex question mentioning a person + topic - should trigger multiple tools
3. Click the tool blocks to verify expand/collapse works
4. Switch back to Standard mode - verify it still works normally
5. Switch to Council mode - verify it still works normally

- [ ] **Step 5: Commit any fixes**

```bash
git add -A
git commit -m "fix(agent): integration test fixes"
```

---

## Task Summary

| Task | Description | New Files | Modified Files |
|---|---|---|---|
| 1 | Agent types + AskMode expansion | `src/types/agent.ts` | `src/components/ask/ChatInput.tsx` |
| 2 | Serverless orchestration endpoint | `api/agent/run.ts` | - |
| 3 | useAgentQuery hook | `src/hooks/useAgentQuery.ts` | - |
| 4 | AgentToolBlock component | `src/components/ask/AgentToolBlock.tsx` | - |
| 5 | AgentToolChain component | `src/components/ask/AgentToolChain.tsx` | - |
| 6 | AgentResponse component | `src/components/ask/AgentResponse.tsx` | - |
| 7 | Wire into ChatInput | - | `src/components/ask/ChatInput.tsx` |
| 8 | Wire into AskView | - | `src/views/AskView.tsx` |
| 9 | Manual integration test | - | - |
