/**
 * api/agent/run.ts
 *
 * Synapse Agent orchestration endpoint.
 * Receives a user question, loops Gemini tool-call decisions up to 10 times,
 * executes each tool against Supabase, and streams results via SSE.
 *
 * CRITICAL: Fully self-contained. No local imports.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

export const maxDuration = 60

// ─── Env vars ────────────────────────────────────────────────────────────────

const SUPABASE_URL = process.env.SUPABASE_URL!
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY!
const GEMINI_API_KEY = process.env.GEMINI_API_KEY!
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models'

// ─── Auth ────────────────────────────────────────────────────────────────────

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

// ─── Gemini multi-turn JSON helper ───────────────────────────────────────────

interface GeminiMessage {
  role: string
  content: string
}

async function geminiJson<T>(
  systemPrompt: string,
  messages: GeminiMessage[],
  temperature = 0.2,
  timeoutMs = 30000
): Promise<T> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    // Map to Gemini's format: 'assistant' → 'model'
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
      }
    )
    if (!resp.ok) throw new Error(`Gemini ${resp.status}: ${await resp.text()}`)
    const data = await resp.json() as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
    }
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text
    if (!text) throw new Error('No response from Gemini')
    return JSON.parse(text) as T
  } finally {
    clearTimeout(timeout)
  }
}

// ─── Embedding helper ────────────────────────────────────────────────────────

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
    }
  )
  const data = await resp.json() as { embedding?: { values?: number[] } }
  if (!data.embedding?.values) throw new Error('No embedding returned')
  return data.embedding.values
}

// ─── SSE helper ─────────────────────────────────────────────────────────────

function sendSSE(res: VercelResponse, event: string, data: Record<string, unknown>): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

// ─── System prompt ───────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are the Synapse Agent — an intelligent orchestrator with access to a personal knowledge graph. Your job is to answer the user's question by calling the right tools in the right order, then synthesising a final answer.

## Available Tools

### Entity & Graph Tools
1. **search_entities** — Semantic + keyword search across extracted entities (people, orgs, topics, projects, etc.)
   Params: { query: string, match_threshold?: number (0–1, default 0.7), match_count?: number (default 10), entity_type?: string }

2. **get_entity** — Fetch a single entity node with its edges and connected node labels
   Params: { node_id: string }

3. **get_connections** — BFS traversal from a node, up to 3 hops, max 30 nodes
   Params: { node_id: string, hops?: number (1–3, default 2), max_nodes?: number (default 20) }

4. **list_anchors** — List all anchor nodes (user-designated key concepts)
   Params: {}

### Source & Content Tools
5. **search_sources** — Search knowledge sources by title keyword, optionally filter by type and date
   Params: { query: string, source_type?: string, date_from?: string (ISO), date_to?: string (ISO), limit?: number (default 10) }

6. **get_source_content** — Full content of a single source (truncated at 15000 chars)
   Params: { source_id: string }

7. **get_recent_sources** — List most recently ingested sources
   Params: { limit?: number (default 10), source_type?: string }

8. **get_related_sources** — Find sources related to a given source via shared entities
   Params: { source_id: string, limit?: number (default 8) }

### Meeting-Specific Tools
9. **get_meeting_brief** — Source metadata + up to 20 extracted entities for a meeting
   Params: { source_id: string }

10. **get_meeting_notes** — Source metadata + entities (30) + edges for a meeting
    Params: { source_id: string }

11. **get_meeting_transcript** — Full meeting transcript (truncated at 20000 chars)
    Params: { source_id: string }

### Skills & Methodology Tools
12. **search_skills** — Search the skills library by name or description
    Params: { query: string, limit?: number (default 10) }

13. **get_skill_content** — Full content of a named skill
    Params: { skill_name: string }

14. **get_skills** — List all skills, optionally excluding drafts
    Params: { include_drafts?: boolean (default true), limit?: number (default 50) }

### Semantic Retrieval Tools
15. **ask_synapse** — Semantic search across source chunks — best for specific factual questions
    Params: { query: string, match_threshold?: number (default 0.65), match_count?: number (default 8) }

### Multi-Agent Tools
16. **consult_council** — Consult all advisory council agents in parallel for deep, multi-perspective analysis
    Params: { query: string }

### Ingestion Tools
17. **send_to_synapse** — Save a new source to the knowledge graph
    Params: { title: string, content: string, source_type: string, source_url?: string }

---

## Response Format

You MUST respond with valid JSON matching exactly one of these two shapes:

**To call a tool:**
\`\`\`json
{
  "action": "tool_call",
  "tool": "<tool_name>",
  "params": { ... },
  "reasoning": "One sentence explaining why you're calling this tool"
}
\`\`\`

**To give a final answer:**
\`\`\`json
{
  "action": "answer",
  "answer": "Your complete answer in markdown",
  "sources_used": ["list of source titles or entity names you drew from"]
}
\`\`\`

---

## Usage Guidance

- Start with the most targeted tool. Use \`ask_synapse\` for factual recall. Use \`search_entities\` for finding people/orgs/topics.
- Chain tools: find an entity → get its connections → get source content for context.
- Use \`consult_council\` for complex strategic or analytical questions that benefit from multi-perspective reasoning.
- Do not call the same tool with the same params twice.
- After 3–4 tool calls, synthesise what you have rather than continuing to gather.
- Always ground your final answer in what the tools returned. Do not hallucinate facts.
- If tools return empty results, say so honestly in your answer.`

// ─── Tool executor types ──────────────────────────────────────────────────────

type ToolParams = Record<string, unknown>
type ToolResult = Record<string, unknown>
type ToolExecutor = (params: ToolParams, sb: SupabaseClient, userId: string) => Promise<ToolResult>

// ─── Tool executors ───────────────────────────────────────────────────────────

async function search_entities(params: ToolParams, sb: SupabaseClient, userId: string): Promise<ToolResult> {
  try {
    const query = String(params['query'] ?? '')
    const matchThreshold = Number(params['match_threshold'] ?? 0.7)
    const matchCount = Number(params['match_count'] ?? 10)
    const entityType = params['entity_type'] ? String(params['entity_type']) : null

    // Semantic search via RPC
    let semanticResults: Array<Record<string, unknown>> = []
    try {
      const embedding = await embedText(query)
      const rpcParams: Record<string, unknown> = {
        query_embedding: embedding,
        match_threshold: matchThreshold,
        match_count: matchCount,
        p_user_id: userId,
      }
      const { data: rpcData } = await sb.rpc('match_knowledge_nodes', rpcParams)
      if (Array.isArray(rpcData)) semanticResults = rpcData as Array<Record<string, unknown>>
    } catch { /* fall through to keyword */ }

    // Keyword fallback
    let keywordQuery = sb
      .from('knowledge_nodes')
      .select('id, label, entity_type, description, confidence, is_anchor')
      .eq('user_id', userId)
      .ilike('label', `%${query}%`)
      .limit(10)

    if (entityType) keywordQuery = keywordQuery.eq('entity_type', entityType)

    const { data: keywordData } = await keywordQuery

    // Merge and deduplicate by id
    const seen = new Set<string>()
    const merged: Array<Record<string, unknown>> = []

    for (const r of semanticResults) {
      const id = String(r['id'] ?? '')
      if (!seen.has(id)) {
        seen.add(id)
        if (!entityType || r['entity_type'] === entityType) merged.push(r)
      }
    }
    for (const r of (keywordData ?? [])) {
      const id = String((r as Record<string, unknown>)['id'] ?? '')
      if (!seen.has(id)) {
        seen.add(id)
        merged.push(r as Record<string, unknown>)
      }
    }

    return { entities: merged.slice(0, matchCount), count: merged.length }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'search_entities failed', entities: [] }
  }
}

async function get_entity(params: ToolParams, sb: SupabaseClient, userId: string): Promise<ToolResult> {
  try {
    const nodeId = String(params['node_id'] ?? '')

    const { data: node } = await sb
      .from('knowledge_nodes')
      .select('id, label, entity_type, description, confidence, is_anchor, source_id, created_at')
      .eq('id', nodeId)
      .eq('user_id', userId)
      .maybeSingle()

    if (!node) return { error: 'Node not found', node: null }

    const { data: edges } = await sb
      .from('knowledge_edges')
      .select('id, source_node_id, target_node_id, relation_type, evidence, weight')
      .eq('user_id', userId)
      .or(`source_node_id.eq.${nodeId},target_node_id.eq.${nodeId}`)
      .limit(30)

    // Collect connected node IDs
    const connectedIds = new Set<string>()
    for (const e of (edges ?? [])) {
      const edge = e as Record<string, unknown>
      if (edge['source_node_id'] !== nodeId) connectedIds.add(String(edge['source_node_id']))
      if (edge['target_node_id'] !== nodeId) connectedIds.add(String(edge['target_node_id']))
    }

    const { data: connectedNodes } = connectedIds.size > 0
      ? await sb
          .from('knowledge_nodes')
          .select('id, label, entity_type')
          .in('id', Array.from(connectedIds))
          .eq('user_id', userId)
      : { data: [] }

    return {
      node: node as Record<string, unknown>,
      edges: (edges ?? []) as Array<Record<string, unknown>>,
      connected_nodes: (connectedNodes ?? []) as Array<Record<string, unknown>>,
    }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'get_entity failed', node: null }
  }
}

async function get_connections(params: ToolParams, sb: SupabaseClient, userId: string): Promise<ToolResult> {
  try {
    const startId = String(params['node_id'] ?? '')
    const hops = Math.min(3, Math.max(1, Number(params['hops'] ?? 2)))
    const maxNodes = Math.min(30, Number(params['max_nodes'] ?? 20))

    const visited = new Set<string>([startId])
    const frontier = new Set<string>([startId])
    const allNodes: Array<Record<string, unknown>> = []
    const allEdges: Array<Record<string, unknown>> = []

    for (let hop = 0; hop < hops && visited.size < maxNodes; hop++) {
      const ids = Array.from(frontier)
      frontier.clear()

      const { data: edges } = await sb
        .from('knowledge_edges')
        .select('id, source_node_id, target_node_id, relation_type, weight')
        .eq('user_id', userId)
        .or(ids.map(id => `source_node_id.eq.${id},target_node_id.eq.${id}`).join(','))
        .limit(100)

      const newIds = new Set<string>()
      for (const e of (edges ?? [])) {
        const edge = e as Record<string, unknown>
        allEdges.push(edge)
        const src = String(edge['source_node_id'])
        const tgt = String(edge['target_node_id'])
        if (!visited.has(src)) { newIds.add(src); visited.add(src) }
        if (!visited.has(tgt)) { newIds.add(tgt); visited.add(tgt) }
      }

      if (newIds.size > 0) {
        const { data: nodes } = await sb
          .from('knowledge_nodes')
          .select('id, label, entity_type, description, is_anchor')
          .in('id', Array.from(newIds))
          .eq('user_id', userId)

        for (const n of (nodes ?? [])) {
          allNodes.push(n as Record<string, unknown>)
          frontier.add(String((n as Record<string, unknown>)['id']))
        }
      }

      if (visited.size >= maxNodes) break
    }

    return { nodes: allNodes.slice(0, maxNodes), edges: allEdges, start_node_id: startId }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'get_connections failed', nodes: [] }
  }
}

async function list_anchors(params: ToolParams, sb: SupabaseClient, userId: string): Promise<ToolResult> {
  try {
    const { data, error } = await sb
      .from('knowledge_nodes')
      .select('id, label, entity_type, description, confidence, created_at')
      .eq('user_id', userId)
      .eq('is_anchor', true)
      .order('label', { ascending: true })

    if (error) return { error: error.message, anchors: [] }
    return { anchors: (data ?? []) as Array<Record<string, unknown>>, count: data?.length ?? 0 }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'list_anchors failed', anchors: [] }
  }
}

async function search_sources(params: ToolParams, sb: SupabaseClient, userId: string): Promise<ToolResult> {
  try {
    const query = String(params['query'] ?? '')
    const sourceType = params['source_type'] ? String(params['source_type']) : null
    const dateFrom = params['date_from'] ? String(params['date_from']) : null
    const dateTo = params['date_to'] ? String(params['date_to']) : null
    const limit = Math.min(20, Number(params['limit'] ?? 10))

    let q = sb
      .from('knowledge_sources')
      .select('id, title, source_type, source_url, participants, created_at')
      .eq('user_id', userId)
      .ilike('title', `%${query}%`)
      .order('created_at', { ascending: false })
      .limit(limit)

    if (sourceType) q = q.eq('source_type', sourceType)
    if (dateFrom) q = q.gte('created_at', dateFrom)
    if (dateTo) q = q.lte('created_at', dateTo)

    const { data, error } = await q
    if (error) return { error: error.message, sources: [] }
    return { sources: (data ?? []) as Array<Record<string, unknown>>, count: data?.length ?? 0 }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'search_sources failed', sources: [] }
  }
}

async function get_source_content(params: ToolParams, sb: SupabaseClient, userId: string): Promise<ToolResult> {
  try {
    const sourceId = String(params['source_id'] ?? '')

    const { data, error } = await sb
      .from('knowledge_sources')
      .select('id, title, source_type, source_url, content, participants, metadata, created_at')
      .eq('id', sourceId)
      .eq('user_id', userId)
      .maybeSingle()

    if (error) return { error: error.message, source: null }
    if (!data) return { error: 'Source not found', source: null }

    const src = data as Record<string, unknown>
    const content = String(src['content'] ?? '')
    return {
      source: {
        ...src,
        content: content.length > 15000 ? content.slice(0, 15000) + '\n\n[truncated]' : content,
      },
    }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'get_source_content failed', source: null }
  }
}

async function get_recent_sources(params: ToolParams, sb: SupabaseClient, userId: string): Promise<ToolResult> {
  try {
    const limit = Math.min(20, Number(params['limit'] ?? 10))
    const sourceType = params['source_type'] ? String(params['source_type']) : null

    let q = sb
      .from('knowledge_sources')
      .select('id, title, source_type, source_url, participants, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(limit)

    if (sourceType) q = q.eq('source_type', sourceType)

    const { data, error } = await q
    if (error) return { error: error.message, sources: [] }
    return { sources: (data ?? []) as Array<Record<string, unknown>>, count: data?.length ?? 0 }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'get_recent_sources failed', sources: [] }
  }
}

async function get_related_sources(params: ToolParams, sb: SupabaseClient, userId: string): Promise<ToolResult> {
  try {
    const sourceId = String(params['source_id'] ?? '')
    const limit = Math.min(20, Number(params['limit'] ?? 8))

    // Get entities from this source
    const { data: entities } = await sb
      .from('knowledge_nodes')
      .select('id')
      .eq('source_id', sourceId)
      .eq('user_id', userId)
      .limit(30)

    if (!entities || entities.length === 0) return { sources: [], count: 0 }

    const entityIds = entities.map(e => (e as Record<string, unknown>)['id'] as string)

    // Find edges connecting these entities to others
    const { data: edges } = await sb
      .from('knowledge_edges')
      .select('source_node_id, target_node_id')
      .eq('user_id', userId)
      .or(entityIds.map(id => `source_node_id.eq.${id},target_node_id.eq.${id}`).join(','))
      .limit(100)

    // Collect connected node IDs outside this source
    const connectedIds = new Set<string>()
    for (const e of (edges ?? [])) {
      const edge = e as Record<string, unknown>
      const src = String(edge['source_node_id'])
      const tgt = String(edge['target_node_id'])
      if (!entityIds.includes(src)) connectedIds.add(src)
      if (!entityIds.includes(tgt)) connectedIds.add(tgt)
    }

    if (connectedIds.size === 0) return { sources: [], count: 0 }

    // Get source IDs for connected nodes
    const { data: connectedNodes } = await sb
      .from('knowledge_nodes')
      .select('source_id')
      .in('id', Array.from(connectedIds))
      .eq('user_id', userId)
      .not('source_id', 'is', null)

    const relatedSourceIds = [...new Set(
      (connectedNodes ?? [])
        .map(n => (n as Record<string, unknown>)['source_id'] as string)
        .filter(id => id && id !== sourceId)
    )].slice(0, limit)

    if (relatedSourceIds.length === 0) return { sources: [], count: 0 }

    const { data: sources } = await sb
      .from('knowledge_sources')
      .select('id, title, source_type, source_url, created_at')
      .in('id', relatedSourceIds)
      .eq('user_id', userId)

    return { sources: (sources ?? []) as Array<Record<string, unknown>>, count: sources?.length ?? 0 }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'get_related_sources failed', sources: [] }
  }
}

async function get_meeting_brief(params: ToolParams, sb: SupabaseClient, userId: string): Promise<ToolResult> {
  try {
    const sourceId = String(params['source_id'] ?? '')

    const { data: source } = await sb
      .from('knowledge_sources')
      .select('id, title, source_type, source_url, participants, metadata, created_at')
      .eq('id', sourceId)
      .eq('user_id', userId)
      .maybeSingle()

    if (!source) return { error: 'Source not found', source: null }

    const { data: entities } = await sb
      .from('knowledge_nodes')
      .select('id, label, entity_type, description, confidence')
      .eq('source_id', sourceId)
      .eq('user_id', userId)
      .order('confidence', { ascending: false })
      .limit(20)

    return {
      source: source as Record<string, unknown>,
      entities: (entities ?? []) as Array<Record<string, unknown>>,
    }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'get_meeting_brief failed', source: null }
  }
}

async function get_meeting_notes(params: ToolParams, sb: SupabaseClient, userId: string): Promise<ToolResult> {
  try {
    const sourceId = String(params['source_id'] ?? '')

    const { data: source } = await sb
      .from('knowledge_sources')
      .select('id, title, source_type, source_url, participants, metadata, created_at')
      .eq('id', sourceId)
      .eq('user_id', userId)
      .maybeSingle()

    if (!source) return { error: 'Source not found', source: null }

    const { data: entities } = await sb
      .from('knowledge_nodes')
      .select('id, label, entity_type, description, confidence')
      .eq('source_id', sourceId)
      .eq('user_id', userId)
      .order('confidence', { ascending: false })
      .limit(30)

    const entityIds = (entities ?? []).map(e => (e as Record<string, unknown>)['id'] as string)

    const { data: edges } = entityIds.length > 0
      ? await sb
          .from('knowledge_edges')
          .select('id, source_node_id, target_node_id, relation_type, evidence')
          .eq('user_id', userId)
          .or(entityIds.map(id => `source_node_id.eq.${id},target_node_id.eq.${id}`).join(','))
          .limit(50)
      : { data: [] }

    return {
      source: source as Record<string, unknown>,
      entities: (entities ?? []) as Array<Record<string, unknown>>,
      edges: (edges ?? []) as Array<Record<string, unknown>>,
    }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'get_meeting_notes failed', source: null }
  }
}

async function get_meeting_transcript(params: ToolParams, sb: SupabaseClient, userId: string): Promise<ToolResult> {
  try {
    const sourceId = String(params['source_id'] ?? '')

    const { data, error } = await sb
      .from('knowledge_sources')
      .select('id, title, content, participants, created_at')
      .eq('id', sourceId)
      .eq('user_id', userId)
      .maybeSingle()

    if (error) return { error: error.message, source: null }
    if (!data) return { error: 'Source not found', source: null }

    const src = data as Record<string, unknown>
    const content = String(src['content'] ?? '')
    return {
      source: {
        ...src,
        content: content.length > 20000 ? content.slice(0, 20000) + '\n\n[truncated]' : content,
      },
    }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'get_meeting_transcript failed', source: null }
  }
}

async function search_skills(params: ToolParams, sb: SupabaseClient, userId: string): Promise<ToolResult> {
  try {
    const query = String(params['query'] ?? '')
    const limit = Math.min(20, Number(params['limit'] ?? 10))

    const { data, error } = await sb
      .from('skills')
      .select('name, description, category, examples, is_draft, created_at')
      .eq('user_id', userId)
      .or(`name.ilike.%${query}%,description.ilike.%${query}%`)
      .limit(limit)

    if (error) return { error: error.message, skills: [] }
    return { skills: (data ?? []) as Array<Record<string, unknown>>, count: data?.length ?? 0 }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'search_skills failed', skills: [] }
  }
}

async function get_skill_content(params: ToolParams, sb: SupabaseClient, userId: string): Promise<ToolResult> {
  try {
    const skillName = String(params['skill_name'] ?? '')

    const { data, error } = await sb
      .from('skills')
      .select('name, description, content, category, examples, is_draft, created_at')
      .eq('user_id', userId)
      .eq('name', skillName)
      .maybeSingle()

    if (error) return { error: error.message, skill: null }
    if (!data) return { error: `Skill "${skillName}" not found`, skill: null }
    return { skill: data as Record<string, unknown> }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'get_skill_content failed', skill: null }
  }
}

async function get_skills(params: ToolParams, sb: SupabaseClient, userId: string): Promise<ToolResult> {
  try {
    const includeDrafts = params['include_drafts'] !== false
    const limit = Math.min(100, Number(params['limit'] ?? 50))

    let q = sb
      .from('skills')
      .select('name, description, category, is_draft, created_at')
      .eq('user_id', userId)
      .order('name', { ascending: true })
      .limit(limit)

    if (!includeDrafts) q = q.eq('is_draft', false)

    const { data, error } = await q
    if (error) return { error: error.message, skills: [] }
    return { skills: (data ?? []) as Array<Record<string, unknown>>, count: data?.length ?? 0 }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'get_skills failed', skills: [] }
  }
}

async function ask_synapse(params: ToolParams, sb: SupabaseClient, userId: string): Promise<ToolResult> {
  try {
    const query = String(params['query'] ?? '')
    const matchThreshold = Number(params['match_threshold'] ?? 0.65)
    const matchCount = Number(params['match_count'] ?? 8)

    const embedding = await embedText(query)

    const { data: chunks, error } = await sb.rpc('match_source_chunks', {
      query_embedding: embedding,
      match_threshold: matchThreshold,
      match_count: matchCount,
      p_user_id: userId,
    })

    if (error) return { error: error.message, chunks: [] }

    const chunkArray = (chunks ?? []) as Array<Record<string, unknown>>

    // Enrich with source titles
    const sourceIds = [...new Set(chunkArray.map(c => c['source_id'] as string).filter(Boolean))]
    const { data: sources } = sourceIds.length > 0
      ? await sb
          .from('knowledge_sources')
          .select('id, title')
          .in('id', sourceIds)
      : { data: [] }

    const sourceMap = new Map<string, string>()
    for (const s of (sources ?? [])) {
      const src = s as Record<string, unknown>
      sourceMap.set(String(src['id']), String(src['title'] ?? ''))
    }

    const enriched = chunkArray.map(c => ({
      ...c,
      source_title: sourceMap.get(String(c['source_id'])) ?? 'Unknown',
    }))

    return { chunks: enriched, count: enriched.length }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'ask_synapse failed', chunks: [] }
  }
}

async function consult_council(params: ToolParams, sb: SupabaseClient, userId: string): Promise<ToolResult> {
  try {
    const query = String(params['query'] ?? '')

    // Fetch all active agents
    const { data: agents, error: agentsErr } = await sb
      .from('domain_agents')
      .select('id, name, description, reasoning_style, expertise_index')
      .eq('user_id', userId)
      .eq('is_active', true)
      .order('source_count', { ascending: false })

    if (agentsErr || !agents || agents.length === 0) {
      return { error: 'No active council agents found', responses: [] }
    }

    const embedding = await embedText(query)

    // Consult each agent in parallel
    const agentResults = await Promise.allSettled(
      agents.map(async (agent) => {
        const a = agent as Record<string, unknown>
        const agentId = String(a['id'])

        // Get domain-scoped chunks
        const { data: chunks } = await sb.rpc('get_domain_scoped_chunks', {
          p_agent_id: agentId,
          p_query_embedding: embedding,
          p_match_threshold: 0.6,
          p_match_count: 6,
        })

        const chunkArray = (chunks ?? []) as Array<Record<string, unknown>>
        const context = chunkArray.map(c => String(c['content'] ?? '')).join('\n\n')

        if (!context.trim()) {
          return { agent_name: String(a['name']), response: 'No relevant context found in my knowledge base for this query.', chunks_used: 0 }
        }

        const ei = (a['expertise_index'] as Record<string, unknown> | null) ?? {}
        const agentSystem = `You are ${a['name']}, a domain expert advisor. ${a['description'] ?? ''}
Reasoning style: ${a['reasoning_style'] ?? 'analytical'}
Core themes: ${Array.isArray((ei as Record<string, unknown>)['core_themes']) ? ((ei as Record<string, unknown>)['core_themes'] as string[]).join(', ') : 'general expertise'}

Answer the question based ONLY on the provided context. Be concise and specific.`

        const response = await geminiJson<{ answer: string }>(
          agentSystem,
          [{ role: 'user', content: `Context:\n${context}\n\nQuestion: ${query}` }],
          0.3,
          20000
        )

        return {
          agent_name: String(a['name']),
          response: response.answer ?? String(response),
          chunks_used: chunkArray.length,
        }
      })
    )

    const responses = agentResults.map(r =>
      r.status === 'fulfilled'
        ? r.value
        : { agent_name: 'unknown', response: 'Agent failed to respond', error: String((r as PromiseRejectedResult).reason) }
    )

    return { responses, agent_count: agents.length }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'consult_council failed', responses: [] }
  }
}

async function send_to_synapse(params: ToolParams, sb: SupabaseClient, userId: string): Promise<ToolResult> {
  try {
    const title = String(params['title'] ?? '')
    const content = String(params['content'] ?? '')
    const sourceType = String(params['source_type'] ?? 'note')
    const sourceUrl = params['source_url'] ? String(params['source_url']) : null

    if (!title.trim() || !content.trim()) {
      return { error: 'title and content are required' }
    }

    const insertData: Record<string, unknown> = {
      user_id: userId,
      title: title.trim(),
      content,
      source_type: sourceType,
    }
    if (sourceUrl) insertData['source_url'] = sourceUrl

    const { data, error } = await sb
      .from('knowledge_sources')
      .insert(insertData)
      .select('id, title, source_type, created_at')
      .single()

    if (error) return { error: error.message }
    return { success: true, source: data as Record<string, unknown> }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'send_to_synapse failed' }
  }
}

// ─── Tool executor map ────────────────────────────────────────────────────────

const TOOL_EXECUTORS: Record<string, ToolExecutor> = {
  search_entities,
  get_entity,
  get_connections,
  list_anchors,
  search_sources,
  get_source_content,
  get_recent_sources,
  get_related_sources,
  get_meeting_brief,
  get_meeting_notes,
  get_meeting_transcript,
  search_skills,
  get_skill_content,
  get_skills,
  ask_synapse,
  consult_council,
  send_to_synapse,
}

// ─── Orchestration types ─────────────────────────────────────────────────────

interface GeminiToolCall {
  action: 'tool_call'
  tool: string
  params: ToolParams
  reasoning: string
}

interface GeminiAnswer {
  action: 'answer'
  answer: string
  sources_used: string[]
}

type GeminiResponse = GeminiToolCall | GeminiAnswer

// ─── Main handler ─────────────────────────────────────────────────────────────

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

  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('Access-Control-Allow-Origin', '*')

  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

  // Build initial messages from conversation history + current query
  const messages: GeminiMessage[] = [
    ...(conversation_history ?? []).map(m => ({ role: m.role, content: m.content })),
    { role: 'user', content: query },
  ]

  try {
    const MAX_TOOL_CALLS = 10

    for (let i = 0; i < MAX_TOOL_CALLS; i++) {
      const geminiResponse = await geminiJson<GeminiResponse>(
        SYSTEM_PROMPT,
        messages,
        0.2,
        30000
      )

      if (geminiResponse.action === 'answer') {
        sendSSE(res, 'answer', {
          answer: geminiResponse.answer,
          sources_used: geminiResponse.sources_used ?? [],
        })
        sendSSE(res, 'done', { tool_calls_used: i })
        res.end()
        return
      }

      if (geminiResponse.action === 'tool_call') {
        const { tool, params, reasoning } = geminiResponse

        sendSSE(res, 'tool_start', { tool, params, reasoning, step: i + 1 })

        const executor = TOOL_EXECUTORS[tool]

        if (!executor) {
          const errResult = { error: `Unknown tool: ${tool}` }
          sendSSE(res, 'tool_error', { tool, error: errResult.error, step: i + 1 })
          messages.push({
            role: 'assistant',
            content: JSON.stringify(geminiResponse),
          })
          messages.push({
            role: 'user',
            content: `Tool error for ${tool}: ${errResult.error}. Please choose a different tool or provide an answer.`,
          })
          continue
        }

        try {
          const result = await executor(params ?? {}, sb, userId)
          sendSSE(res, 'tool_result', { tool, result, step: i + 1 })

          messages.push({
            role: 'assistant',
            content: JSON.stringify(geminiResponse),
          })
          messages.push({
            role: 'user',
            content: `Tool result for ${tool}:\n${JSON.stringify(result)}`,
          })
        } catch (toolErr) {
          const errMsg = toolErr instanceof Error ? toolErr.message : 'Tool execution failed'
          sendSSE(res, 'tool_error', { tool, error: errMsg, step: i + 1 })

          messages.push({
            role: 'assistant',
            content: JSON.stringify(geminiResponse),
          })
          messages.push({
            role: 'user',
            content: `Tool error for ${tool}: ${errMsg}. Please try a different approach or provide an answer with what you know.`,
          })
        }

        continue
      }

      // Unexpected response shape — treat as done
      break
    }

    // Safety valve: force synthesis after hitting max iterations
    const synthesisMessages: GeminiMessage[] = [
      ...messages,
      {
        role: 'user',
        content: 'You have used the maximum number of tool calls. Based on everything gathered so far, please provide your best final answer now. Respond with {"action":"answer","answer":"...","sources_used":[...]}',
      },
    ]

    const finalResponse = await geminiJson<GeminiAnswer>(
      SYSTEM_PROMPT,
      synthesisMessages,
      0.3,
      30000
    )

    sendSSE(res, 'answer', {
      answer: finalResponse.answer ?? 'Unable to synthesise a final answer.',
      sources_used: finalResponse.sources_used ?? [],
    })
    sendSSE(res, 'done', { tool_calls_used: MAX_TOOL_CALLS, forced_synthesis: true })
    res.end()
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    console.error('Agent run error:', err)

    try {
      sendSSE(res, 'error', { message })
      sendSSE(res, 'done', { error: true })
      res.end()
    } catch {
      // Response may already be closed
    }
  }
}
