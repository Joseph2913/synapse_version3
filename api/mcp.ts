/**
 * api/mcp.ts
 *
 * Synapse MCP Server — Vercel serverless function implementing MCP Streamable HTTP transport.
 * Exposes 10 tools for querying the user's personal knowledge graph.
 *
 * CRITICAL: Fully self-contained. No local imports. All helpers defined inline.
 * PRD-24: MCP Server & API Key Management
 */

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import crypto from 'crypto'

// ─── Environment ─────────────────────────────────────────────────────────────

const SUPABASE_URL = process.env.SUPABASE_URL!
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY!
const GEMINI_API_KEY = process.env.GEMINI_API_KEY!
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models'
const GEMINI_MODEL = process.env.GEMINI_MODEL ?? 'gemini-2.0-flash'

// ─── Types ───────────────────────────────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: '2.0'
  method: string
  params?: Record<string, unknown>
  id?: string | number | null
}

interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: string | number | null
  result?: unknown
  error?: { code: number; message: string }
}

interface ToolDescriptor {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

interface ToolContent {
  content: Array<{ type: 'text'; text: string }>
}

interface ChunkResult {
  id: string
  content: string
  source_id: string
  similarity: number
  chunk_index?: number
}

interface KeywordNodeResult {
  id: string
  label: string
  description: string | null
  entity_type: string
  source_id: string | null
}

interface AnchorConnection {
  label: string
  entity_type: string
  relation_type: string
}

interface SourceInfo {
  id: string
  title: string
  source_type: string
  source_url: string | null
}

// ─── Supabase clients ────────────────────────────────────────────────────────

function getServiceSupabase(): SupabaseClient {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
}

// ─── API Key verification ────────────────────────────────────────────────────

async function verifyApiKey(req: VercelRequest): Promise<{ userId: string } | null> {
  const authHeader = req.headers.authorization
  if (!authHeader?.startsWith('Bearer ')) return null

  const token = authHeader.slice(7)
  if (!token || !token.startsWith('sk-syn-')) return null

  const keyHash = crypto.createHash('sha256').update(token).digest('hex')
  const sb = getServiceSupabase()

  const { data, error } = await sb
    .from('synapse_api_keys')
    .select('id, user_id')
    .eq('key_hash', keyHash)
    .maybeSingle()

  if (error || !data) return null

  // Fire-and-forget: update last_used_at
  sb.from('synapse_api_keys')
    .update({ last_used_at: new Date().toISOString() })
    .eq('id', data.id)
    .then(() => {})

  return { userId: data.user_id as string }
}

// ─── Gemini helpers ──────────────────────────────────────────────────────────

async function embedText(text: string): Promise<number[]> {
  const response = await fetch(
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

  const data = await response.json()
  if (!data.embedding?.values) {
    throw new Error('No embedding in Gemini response')
  }
  return data.embedding.values as number[]
}

async function generateAnswer(systemPrompt: string, userPrompt: string): Promise<string> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 8000)

  try {
    const response = await fetch(
      `${GEMINI_BASE}/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          system_instruction: { parts: [{ text: systemPrompt }] },
          contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
          generationConfig: {
            temperature: 0.3,
            maxOutputTokens: 1024,
          },
        }),
      }
    )

    const data = await response.json()
    return data.candidates?.[0]?.content?.parts?.[0]?.text ?? ''
  } finally {
    clearTimeout(timeout)
  }
}

// ─── Stop word removal ───────────────────────────────────────────────────────

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'shall', 'can', 'to', 'of', 'in', 'for',
  'on', 'with', 'at', 'by', 'from', 'as', 'into', 'about', 'between',
  'through', 'after', 'before', 'above', 'below', 'and', 'or', 'but',
  'not', 'no', 'nor', 'so', 'yet', 'if', 'then', 'than', 'that',
  'this', 'these', 'those', 'it', 'its', 'my', 'your', 'his', 'her',
  'our', 'their', 'what', 'which', 'who', 'whom', 'when', 'where',
  'how', 'why', 'all', 'each', 'every', 'both', 'few', 'more', 'most',
  'some', 'any', 'much', 'many', 'such', 'very', 'just', 'also',
])

function extractKeywords(query: string): string[] {
  return query
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w))
    .slice(0, 3)
}

// ─── Tool descriptors ────────────────────────────────────────────────────────

const TOOLS: ToolDescriptor[] = [
  {
    name: 'ask_synapse',
    description:
      "Query the user's personal Synapse knowledge graph. Use this when the question involves the user's own knowledge, decisions, projects, relationships, or domain context — things learned from their meetings, documents, YouTube videos, or notes. This performs full graph-traversal RAG and returns a synthesised answer with source citations. Do NOT use for general world knowledge.",
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: "The question to answer using the user's personal knowledge graph.",
        },
        max_results: {
          type: 'number',
          description: 'Maximum number of source chunks to retrieve. Default 8, max 20.',
          default: 8,
        },
        source_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Constrain RAG search to chunks from these specific source UUIDs only.',
        },
        source_type: {
          type: 'string',
          description: 'Constrain RAG search to chunks from sources of this type only (Meeting, YouTube, etc.).',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'search_entities',
    description:
      "Search for specific entities (people, concepts, projects, decisions, etc.) in the user's knowledge graph. Returns matching nodes with their type, description, and connection count. Use when you need to look up a specific person, project, concept, or topic the user has encountered.",
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Name or description of the entity to find.',
        },
        entity_type: {
          type: 'string',
          description:
            'Optional filter. One of: Person, Organization, Project, Concept, Decision, Insight, Topic, Technology, Goal, Risk, Action, Idea, Event, Location, Product, Metric, Hypothesis, Lesson, Takeaway, Question, Document, Team, Blocker, Anchor',
        },
        limit: { type: 'number', default: 10 },
        source_id: {
          type: 'string',
          description: 'Filter entities to those extracted from this specific source UUID.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_entity',
    description:
      'Get full detail for a specific entity by its label, including all its direct connections and the sources it appears in. Use after search_entities to drill into a specific node.',
    inputSchema: {
      type: 'object',
      properties: {
        label: {
          type: 'string',
          description: 'Exact or approximate label of the entity.',
        },
      },
      required: ['label'],
    },
  },
  {
    name: 'get_connections',
    description:
      "Traverse the relationship network around a specific entity up to N hops. Shows how concepts, people, and projects are linked in the user's knowledge graph. Use to understand context and relationships around a topic.",
    inputSchema: {
      type: 'object',
      properties: {
        label: { type: 'string' },
        hops: {
          type: 'number',
          default: 2,
          description: 'How many relationship hops to traverse. Max 3.',
        },
      },
      required: ['label'],
    },
  },
  {
    name: 'list_anchors',
    description:
      "Return the user's anchor entities — the high-signal, recurring concepts and people that the user has designated as important. Anchors represent the core of the user's knowledge graph. Use to understand what the user considers most significant in their domain.",
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'get_recent_sources',
    description:
      "List the most recently ingested content sources in the user's knowledge graph — meetings, YouTube videos, documents, and notes. Use to understand what the user has been learning about recently. Supports date range filtering.",
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          default: 10,
          description: 'Max number of sources to return.',
        },
        source_type: {
          type: 'string',
          description: 'Optional filter: Meeting, YouTube, Research, Note, Document',
        },
        date_from: {
          type: 'string',
          description: 'ISO date string. Only return sources created on or after this date.',
        },
        date_to: {
          type: 'string',
          description: 'ISO date string. Only return sources created on or before this date.',
        },
      },
    },
  },
  {
    name: 'get_source_content',
    description:
      "Retrieve the full raw content of a source (transcript, article, notes) plus its metadata. Use this to access the actual transcript or text of a meeting, video, document, or note. Supports lookup by title search or direct source ID.",
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search term to match against source titles. Fuzzy matching (case-insensitive, partial match).',
        },
        source_id: {
          type: 'string',
          description: 'Direct lookup by source UUID. If provided, query is ignored.',
        },
        include_content: {
          type: 'boolean',
          default: true,
          description: 'Whether to return the full content field. Set to false for metadata-only lookups.',
        },
        max_content_length: {
          type: 'number',
          default: 50000,
          description: 'Truncate content at this character count. Safety valve for very long transcripts.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'search_sources',
    description:
      "Search for content sources using keyword matching with filters for type, date range, and participants. Use to find meetings, documents, videos by keyword, date, or participant name (e.g. 'meetings with Antonio last week').",
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Keyword search against title and content. If omitted, returns all sources matching other filters.',
        },
        source_type: {
          type: 'string',
          description: 'Filter by source type: Meeting, YouTube, Research, Note, Document.',
        },
        date_from: {
          type: 'string',
          description: 'ISO date string. Sources created on or after this date.',
        },
        date_to: {
          type: 'string',
          description: 'ISO date string. Sources created on or before this date.',
        },
        participant: {
          type: 'string',
          description: 'Filter to sources where participants array contains this name (case-insensitive partial match).',
        },
        limit: {
          type: 'number',
          default: 10,
          description: 'Max results to return.',
        },
        sort: {
          type: 'string',
          default: 'recent',
          description: "Sort order: 'recent' (created_at DESC) or 'relevant' (keyword match quality).",
        },
      },
    },
  },
  {
    name: 'get_meeting_brief',
    description:
      "Assemble a structured meeting intelligence brief from existing extracted data. Returns decisions, action items, key insights, topics, people mentioned, risks/blockers, and related sources — all in a single call. No AI generation needed, pure database assembly.",
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: "Meeting title or search term. Fuzzy matched against meeting source titles.",
        },
        source_id: {
          type: 'string',
          description: 'Direct lookup by source UUID. If provided, query is ignored.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_related_sources',
    description:
      "Given a source, find other sources that share entity connections with it. Surfaces cross-meeting threading and how topics/people recur across different content. Use to discover the narrative arc around a meeting or document.",
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Source title or search term.',
        },
        source_id: {
          type: 'string',
          description: 'Direct lookup by source UUID. If provided, query is ignored.',
        },
        source_type: {
          type: 'string',
          description: 'Filter related sources by type (Meeting, YouTube, etc.).',
        },
        limit: {
          type: 'number',
          default: 10,
          description: 'Max related sources to return.',
        },
      },
      required: ['query'],
    },
  },
]

// ─── Tool handlers ───────────────────────────────────────────────────────────

async function handleAskSynapse(
  params: { query: string; max_results?: number; source_ids?: string[]; source_type?: string },
  userId: string,
  sb: SupabaseClient
): Promise<ToolContent> {
  const maxResults = Math.min(params.max_results ?? 8, 20)

  // 1. Embed query
  let embedding: number[]
  try {
    embedding = await embedText(params.query)
  } catch {
    return {
      content: [{ type: 'text', text: 'Unable to generate query embedding. Please try again.' }],
    }
  }

  // 2. Semantic search on source chunks
  const { data: semanticChunks } = await sb.rpc('match_source_chunks', {
    query_embedding: JSON.stringify(embedding),
    match_threshold: 0.3,
    match_count: params.source_ids || params.source_type ? maxResults * 3 : maxResults, // fetch more if we'll filter
    p_user_id: userId,
  })

  let chunks: ChunkResult[] = (semanticChunks ?? []) as ChunkResult[]

  // Apply source scoping filters
  if (params.source_ids && params.source_ids.length > 0) {
    const scopeSet = new Set(params.source_ids)
    chunks = chunks.filter(c => scopeSet.has(c.source_id))
  }
  if (params.source_type) {
    // Need to look up source types for the chunks
    const chunkSourceIds = [...new Set(chunks.map(c => c.source_id))]
    if (chunkSourceIds.length > 0) {
      const { data: stData } = await sb
        .from('knowledge_sources')
        .select('id, source_type')
        .in('id', chunkSourceIds)
        .eq('user_id', userId)
      const typeMap = new Map<string, string>()
      for (const s of (stData ?? []) as Array<{ id: string; source_type: string }>) {
        typeMap.set(s.id, s.source_type)
      }
      chunks = chunks.filter(c => typeMap.get(c.source_id) === params.source_type)
    }
  }
  chunks = chunks.slice(0, maxResults)

  // 3. Keyword search on knowledge nodes
  const keywords = extractKeywords(params.query)
  let keywordNodes: KeywordNodeResult[] = []
  if (keywords.length > 0) {
    const pattern = `%${keywords.join('%')}%`
    const { data } = await sb
      .from('knowledge_nodes')
      .select('id, label, description, entity_type, source_id')
      .eq('user_id', userId)
      .or(`label.ilike.${pattern},description.ilike.${pattern}`)
      .limit(10)
    keywordNodes = (data ?? []) as KeywordNodeResult[]
  }

  // 4. Merge & score — get source_ids from keyword nodes that overlap with chunk source_ids
  const chunkSourceIds = new Set(chunks.map(c => c.source_id))
  const keywordSourceIds = new Set(keywordNodes.map(n => n.source_id).filter(Boolean))

  const scoredChunks = chunks.map(c => ({
    ...c,
    score: 0.6 * c.similarity + (keywordSourceIds.has(c.source_id) ? 0.4 : 0),
  }))
  scoredChunks.sort((a, b) => b.score - a.score)
  const topChunks = scoredChunks.slice(0, maxResults)

  // Handle empty results
  if (topChunks.length === 0) {
    // If source-scoped and empty, note the scoping
    if (params.source_ids || params.source_type) {
      return {
        content: [{
          type: 'text',
          text: `No relevant chunks found in the specified sources${params.source_type ? ` (type: ${params.source_type})` : ''}. Try removing the source filter for a broader search.`,
        }],
      }
    }
    return {
      content: [{
        type: 'text',
        text: "Your knowledge graph doesn't have enough content to answer this yet. Try ingesting some sources in Synapse first.",
      }],
    }
  }

  // Fetch source titles for top chunks
  const uniqueSourceIds = [...new Set(topChunks.map(c => c.source_id))]
  const { data: sourcesData } = await sb
    .from('knowledge_sources')
    .select('id, title, source_type')
    .in('id', uniqueSourceIds)
    .eq('user_id', userId)

  const sourceMap = new Map<string, { title: string; source_type: string }>()
  for (const s of (sourcesData ?? []) as Array<{ id: string; title: string; source_type: string }>) {
    sourceMap.set(s.id, { title: s.title, source_type: s.source_type })
  }

  // 5. Graph traversal — fetch connected anchor nodes
  const topNodeIds = keywordNodes.slice(0, 5).map(n => n.id)
  let anchorConnections: AnchorConnection[] = []
  if (topNodeIds.length > 0) {
    const { data: edgeData } = await sb
      .from('knowledge_edges')
      .select(`
        relation_type,
        source_node:knowledge_nodes!knowledge_edges_source_node_id_fkey(label, entity_type, is_anchor),
        target_node:knowledge_nodes!knowledge_edges_target_node_id_fkey(label, entity_type, is_anchor)
      `)
      .or(`source_node_id.in.(${topNodeIds.join(',')}),target_node_id.in.(${topNodeIds.join(',')})`)
      .limit(20)

    if (edgeData) {
      for (const edge of edgeData as Array<Record<string, unknown>>) {
        const sourceNode = edge.source_node as Record<string, unknown> | null
        const targetNode = edge.target_node as Record<string, unknown> | null
        if (sourceNode && sourceNode.is_anchor) {
          anchorConnections.push({
            label: sourceNode.label as string,
            entity_type: sourceNode.entity_type as string,
            relation_type: edge.relation_type as string,
          })
        }
        if (targetNode && targetNode.is_anchor) {
          anchorConnections.push({
            label: targetNode.label as string,
            entity_type: targetNode.entity_type as string,
            relation_type: edge.relation_type as string,
          })
        }
      }
    }
  }

  // 6. Assemble context
  const passageLines = topChunks.map(c => {
    const src = sourceMap.get(c.source_id)
    const title = src?.title ?? 'Unknown Source'
    return `[${title}]\n${c.content}`
  })

  const entityLines = anchorConnections.map(
    a => `- ${a.label} (${a.entity_type}) — ${a.relation_type}`
  )

  const contextStr = [
    '[Source Passages]',
    ...passageLines,
    '',
    '[Key Entities & Connections]',
    ...(entityLines.length > 0 ? entityLines : ['(none found)']),
  ].join('\n\n')

  // 7. Call Gemini
  const systemPrompt =
    'You are Synapse, an AI assistant that answers questions based only on the provided context from the user\'s personal knowledge graph. ' +
    'Cite sources by their title. If the context does not contain enough information, say so clearly. Do not make up information.'

  let answer: string
  try {
    answer = await generateAnswer(systemPrompt, `Context:\n${contextStr}\n\nQuestion: ${params.query}`)
  } catch {
    // Timeout or Gemini error — return partial results
    const titles = topChunks
      .map(c => sourceMap.get(c.source_id)?.title)
      .filter(Boolean)
    return {
      content: [{
        type: 'text',
        text: `Unable to generate answer: Gemini API error. Source chunks retrieved: ${titles.join(', ')}`,
      }],
    }
  }

  // 8. Format response
  const sources = topChunks
    .map(c => {
      const src = sourceMap.get(c.source_id)
      return src
        ? { title: src.title, source_type: src.source_type, relevance: Math.round(c.score * 100) / 100 }
        : null
    })
    .filter(Boolean)
    // Deduplicate by title
    .filter((s, i, arr) => arr.findIndex(x => x!.title === s!.title) === i) as Array<{
      title: string
      source_type: string
      relevance: number
    }>

  const entityLabels = [...new Set(anchorConnections.map(a => a.label))]

  const sourcesText = sources
    .map(s => `- ${s.title} (relevance: ${Math.round(s.relevance * 100)}%)`)
    .join('\n')

  const entitiesText = entityLabels.length > 0 ? entityLabels.join(', ') : 'None identified'

  return {
    content: [{
      type: 'text',
      text: `${answer}\n\n**Sources:**\n${sourcesText}\n\n**Entities:** ${entitiesText}`,
    }],
  }
}

async function handleSearchEntities(
  params: { query: string; entity_type?: string; limit?: number; source_id?: string },
  userId: string,
  sb: SupabaseClient
): Promise<ToolContent> {
  const limit = Math.min(params.limit ?? 10, 30)

  // Hybrid search: semantic + keyword
  let semanticResults: Array<{ id: string; label: string; entity_type: string; description: string | null; similarity: number; source_id?: string }> = []
  try {
    const embedding = await embedText(params.query)
    const rpcParams: Record<string, unknown> = {
      query_embedding: JSON.stringify(embedding),
      match_threshold: 0.3,
      match_count: params.source_id ? limit * 3 : limit, // fetch more if filtering
      p_user_id: userId,
    }
    const { data } = await sb.rpc('match_knowledge_nodes', rpcParams)
    semanticResults = (data ?? []) as typeof semanticResults
  } catch {
    // Fall through to keyword-only
  }

  // Apply source_id filter to semantic results
  if (params.source_id) {
    // Semantic results may not include source_id, so fetch it
    const semIds = semanticResults.map(r => r.id)
    if (semIds.length > 0) {
      const { data: nodeSourceData } = await sb
        .from('knowledge_nodes')
        .select('id, source_id')
        .in('id', semIds)
      const sourceMap = new Map<string, string>()
      for (const n of (nodeSourceData ?? []) as Array<{ id: string; source_id: string }>) {
        sourceMap.set(n.id, n.source_id)
      }
      semanticResults = semanticResults.filter(r => sourceMap.get(r.id) === params.source_id)
    }
  }

  // Keyword fallback
  let keywordQuery = sb
    .from('knowledge_nodes')
    .select('id, label, description, entity_type')
    .eq('user_id', userId)
    .or(`label.ilike.%${params.query}%,description.ilike.%${params.query}%`)
    .limit(limit)

  if (params.entity_type) {
    keywordQuery = keywordQuery.eq('entity_type', params.entity_type)
  }
  if (params.source_id) {
    keywordQuery = keywordQuery.eq('source_id', params.source_id)
  }

  const { data: keywordData } = await keywordQuery
  const keywordResults = (keywordData ?? []) as Array<{ id: string; label: string; entity_type: string; description: string | null }>

  // Merge & deduplicate
  const seen = new Set<string>()
  const merged: Array<{ id: string; label: string; entity_type: string; description: string | null }> = []

  // Filter semantic results by entity_type if specified
  const filteredSemantic = params.entity_type
    ? semanticResults.filter(r => r.entity_type === params.entity_type)
    : semanticResults

  for (const r of filteredSemantic) {
    if (!seen.has(r.id)) {
      seen.add(r.id)
      merged.push(r)
    }
  }
  for (const r of keywordResults) {
    if (!seen.has(r.id)) {
      seen.add(r.id)
      merged.push(r)
    }
  }

  const results = merged.slice(0, limit)

  if (results.length === 0) {
    return { content: [{ type: 'text', text: `No entities found matching "${params.query}".` }] }
  }

  // Fetch connection counts
  const lines: string[] = []
  for (let i = 0; i < results.length; i++) {
    const r = results[i]!
    const { count } = await sb
      .from('knowledge_edges')
      .select('id', { count: 'exact', head: true })
      .or(`source_node_id.eq.${r.id},target_node_id.eq.${r.id}`)

    const desc = r.description ? ` — ${r.description.slice(0, 120)}` : ''
    lines.push(`${i + 1}. **${r.label}** (${r.entity_type})${desc}. Connections: ${count ?? 0}`)
  }

  return {
    content: [{
      type: 'text',
      text: `Found ${results.length} entities:\n\n${lines.join('\n')}`,
    }],
  }
}

async function handleGetEntity(
  params: { label: string },
  userId: string,
  sb: SupabaseClient
): Promise<ToolContent> {
  // Find node by approximate label match
  const { data: nodeData } = await sb
    .from('knowledge_nodes')
    .select('*')
    .eq('user_id', userId)
    .ilike('label', `%${params.label}%`)
    .limit(1)

  const node = (nodeData ?? [])[0] as Record<string, unknown> | undefined
  if (!node) {
    return { content: [{ type: 'text', text: `No entity found matching "${params.label}".` }] }
  }

  // Fetch outbound edges
  const { data: outbound } = await sb
    .from('knowledge_edges')
    .select('relation_type, evidence, target_node_id')
    .eq('source_node_id', node.id)
    .eq('user_id', userId)
    .limit(20)

  // Fetch inbound edges
  const { data: inbound } = await sb
    .from('knowledge_edges')
    .select('relation_type, evidence, source_node_id')
    .eq('target_node_id', node.id)
    .eq('user_id', userId)
    .limit(20)

  // Resolve connected node labels
  const outNodeIds = ((outbound ?? []) as Array<Record<string, unknown>>).map(e => e.target_node_id as string)
  const inNodeIds = ((inbound ?? []) as Array<Record<string, unknown>>).map(e => e.source_node_id as string)
  const allConnectedIds = [...new Set([...outNodeIds, ...inNodeIds])]

  let connectedMap = new Map<string, { label: string; entity_type: string }>()
  if (allConnectedIds.length > 0) {
    const { data: connectedNodes } = await sb
      .from('knowledge_nodes')
      .select('id, label, entity_type')
      .in('id', allConnectedIds)
    for (const cn of (connectedNodes ?? []) as Array<{ id: string; label: string; entity_type: string }>) {
      connectedMap.set(cn.id, { label: cn.label, entity_type: cn.entity_type })
    }
  }

  // Fetch source with enriched context
  let sourceTitle: string | null = null
  let sourceType: string | null = null
  let sourceCreatedAt: string | null = null
  let sourceParticipants: string[] | null = null
  let sourceExcerpt: string | null = null

  if (node.source_id) {
    const { data: srcData } = await sb
      .from('knowledge_sources')
      .select('title, source_type, created_at, participants')
      .eq('id', node.source_id as string)
      .maybeSingle()
    if (srcData) {
      const src = srcData as { title: string; source_type: string; created_at: string; participants: string[] | null }
      sourceTitle = src.title
      sourceType = src.source_type
      sourceCreatedAt = src.created_at
      sourceParticipants = src.participants ?? null
    }

    // Try to get a source excerpt from the nearest source chunk
    if (node.embedding) {
      const { data: excerptData } = await sb.rpc('match_source_chunks', {
        query_embedding: typeof node.embedding === 'string' ? node.embedding : JSON.stringify(node.embedding),
        match_threshold: 0.3,
        match_count: 1,
        p_user_id: userId,
      })
      const excerptChunks = (excerptData ?? []) as Array<{ content: string; source_id: string }>
      const matchingChunk = excerptChunks.find(c => c.source_id === (node.source_id as string))
      if (matchingChunk) {
        sourceExcerpt = matchingChunk.content.slice(0, 200)
      }
    }
  }

  // Format connections
  const connectionLines: string[] = []
  for (const edge of (outbound ?? []) as Array<Record<string, unknown>>) {
    const target = connectedMap.get(edge.target_node_id as string)
    const evidenceStr = edge.evidence ? ` (evidence: ${(edge.evidence as string).slice(0, 80)})` : ''
    connectionLines.push(`→ ${edge.relation_type} ${target?.label ?? 'Unknown'} (${target?.entity_type ?? '?'})${evidenceStr}`)
  }
  for (const edge of (inbound ?? []) as Array<Record<string, unknown>>) {
    const source = connectedMap.get(edge.source_node_id as string)
    const evidenceStr = edge.evidence ? ` (evidence: ${(edge.evidence as string).slice(0, 80)})` : ''
    connectionLines.push(`← ${edge.relation_type} ${source?.label ?? 'Unknown'} (${source?.entity_type ?? '?'})${evidenceStr}`)
  }

  const confidence = node.confidence != null ? `, confidence: ${Math.round((node.confidence as number) * 100)}%` : ''
  const desc = node.description ? `\n\n${node.description}` : ''
  const quoteStr = node.quote ? `\n\n> "${node.quote}"` : ''
  const sourceText = sourceTitle ? `\nSource: "${sourceTitle}" (${sourceType}, ${sourceCreatedAt})` : ''
  const participantsText = sourceParticipants?.length ? `\nParticipants: ${sourceParticipants.join(', ')}` : ''
  const excerptText = sourceExcerpt ? `\nSource excerpt: "${sourceExcerpt}"` : ''

  return {
    content: [{
      type: 'text',
      text: `**${node.label}** (${node.entity_type}${confidence})${desc}${quoteStr}${sourceText}${participantsText}${excerptText}\n\nConnections:\n${connectionLines.length > 0 ? connectionLines.join('\n') : '(no connections)'}`,
    }],
  }
}

async function handleGetConnections(
  params: { label: string; hops?: number },
  userId: string,
  sb: SupabaseClient
): Promise<ToolContent> {
  const maxHops = Math.min(params.hops ?? 2, 3)

  // Find root node
  const { data: nodeData } = await sb
    .from('knowledge_nodes')
    .select('id, label, entity_type')
    .eq('user_id', userId)
    .ilike('label', `%${params.label}%`)
    .limit(1)

  const rootNode = (nodeData ?? [])[0] as { id: string; label: string; entity_type: string } | undefined
  if (!rootNode) {
    return { content: [{ type: 'text', text: `No entity found matching "${params.label}".` }] }
  }

  // BFS traversal
  const visited = new Set<string>([rootNode.id])
  const nodeLabels = new Map<string, { label: string; entity_type: string }>()
  nodeLabels.set(rootNode.id, { label: rootNode.label, entity_type: rootNode.entity_type })

  interface TreeNode {
    id: string
    label: string
    entityType: string
    relation: string
    children: TreeNode[]
  }

  const tree: TreeNode = {
    id: rootNode.id,
    label: rootNode.label,
    entityType: rootNode.entity_type,
    relation: '',
    children: [],
  }

  // Map from nodeId to its tree nodes (a node can appear at multiple levels)
  let currentLevel: Array<{ nodeId: string; treeNode: TreeNode }> = [{ nodeId: rootNode.id, treeNode: tree }]

  for (let hop = 0; hop < maxHops && visited.size < 30; hop++) {
    const nodeIds = currentLevel.map(n => n.nodeId)
    if (nodeIds.length === 0) break

    // Fetch edges for current level
    const { data: edges } = await sb
      .from('knowledge_edges')
      .select('source_node_id, target_node_id, relation_type')
      .eq('user_id', userId)
      .or(`source_node_id.in.(${nodeIds.join(',')}),target_node_id.in.(${nodeIds.join(',')})`)
      .limit(60)

    if (!edges || edges.length === 0) break

    // Collect new node IDs
    const newIds = new Set<string>()
    for (const edge of edges as Array<{ source_node_id: string; target_node_id: string; relation_type: string }>) {
      if (!visited.has(edge.target_node_id)) newIds.add(edge.target_node_id)
      if (!visited.has(edge.source_node_id)) newIds.add(edge.source_node_id)
    }

    // Fetch new node labels
    const newIdsArr = [...newIds]
    if (newIdsArr.length > 0) {
      const { data: newNodes } = await sb
        .from('knowledge_nodes')
        .select('id, label, entity_type')
        .in('id', newIdsArr)
      for (const n of (newNodes ?? []) as Array<{ id: string; label: string; entity_type: string }>) {
        nodeLabels.set(n.id, { label: n.label, entity_type: n.entity_type })
      }
    }

    // Build tree children
    const nextLevel: Array<{ nodeId: string; treeNode: TreeNode }> = []
    for (const edge of edges as Array<{ source_node_id: string; target_node_id: string; relation_type: string }>) {
      for (const item of currentLevel) {
        let connectedId: string | null = null
        let relation = ''
        if (edge.source_node_id === item.nodeId && !visited.has(edge.target_node_id)) {
          connectedId = edge.target_node_id
          relation = `${edge.relation_type} →`
        } else if (edge.target_node_id === item.nodeId && !visited.has(edge.source_node_id)) {
          connectedId = edge.source_node_id
          relation = `← ${edge.relation_type}`
        }

        if (connectedId && visited.size < 30) {
          visited.add(connectedId)
          const info = nodeLabels.get(connectedId)
          const child: TreeNode = {
            id: connectedId,
            label: info?.label ?? 'Unknown',
            entityType: info?.entity_type ?? '?',
            relation,
            children: [],
          }
          item.treeNode.children.push(child)
          nextLevel.push({ nodeId: connectedId, treeNode: child })
        }
      }
    }

    currentLevel = nextLevel
  }

  // Render tree as text
  function renderTree(node: TreeNode, prefix: string, isLast: boolean, isRoot: boolean): string {
    const lines: string[] = []
    if (isRoot) {
      lines.push(`${node.label} (${node.entityType})`)
    } else {
      const connector = isLast ? '└─' : '├─'
      lines.push(`${prefix}${connector} ${node.relation} ${node.label} (${node.entityType})`)
    }
    const childPrefix = isRoot ? '' : prefix + (isLast ? '    ' : '│   ')
    for (let i = 0; i < node.children.length; i++) {
      lines.push(renderTree(node.children[i]!, childPrefix, i === node.children.length - 1, false))
    }
    return lines.join('\n')
  }

  const treeText = renderTree(tree, '', true, true)

  return {
    content: [{
      type: 'text',
      text: treeText || `${rootNode.label} (${rootNode.entity_type})\n(no connections found)`,
    }],
  }
}

async function handleListAnchors(
  userId: string,
  sb: SupabaseClient
): Promise<ToolContent> {
  // Direct query — no dedicated RPC for anchor listing
  const { data: anchors } = await sb
    .from('knowledge_nodes')
    .select('id, label, entity_type, description')
    .eq('user_id', userId)
    .eq('is_anchor', true)
    .limit(30)

  if (!anchors || anchors.length === 0) {
    return { content: [{ type: 'text', text: 'No anchor entities found. The user has not designated any entities as anchors yet.' }] }
  }

  // Fetch connection counts for each anchor
  const anchorResults: Array<{ label: string; entity_type: string; description: string | null; connection_count: number }> = []
  for (const anchor of anchors as Array<{ id: string; label: string; entity_type: string; description: string | null }>) {
    const { count } = await sb
      .from('knowledge_edges')
      .select('id', { count: 'exact', head: true })
      .or(`source_node_id.eq.${anchor.id},target_node_id.eq.${anchor.id}`)

    anchorResults.push({
      label: anchor.label,
      entity_type: anchor.entity_type,
      description: anchor.description,
      connection_count: count ?? 0,
    })
  }

  // Sort by connection count
  anchorResults.sort((a, b) => b.connection_count - a.connection_count)

  // Group by entity type
  const grouped = new Map<string, typeof anchorResults>()
  for (const a of anchorResults) {
    const existing = grouped.get(a.entity_type) ?? []
    existing.push(a)
    grouped.set(a.entity_type, existing)
  }

  const sections: string[] = []
  for (const [type, items] of grouped) {
    const lines = items.map(
      i => `  - ${i.label}${i.description ? ` — ${i.description.slice(0, 80)}` : ''} (${i.connection_count} connections)`
    )
    sections.push(`**${type}**\n${lines.join('\n')}`)
  }

  return {
    content: [{
      type: 'text',
      text: `Anchor entities (${anchorResults.length} total):\n\n${sections.join('\n\n')}`,
    }],
  }
}

async function handleGetRecentSources(
  params: { limit?: number; source_type?: string; date_from?: string; date_to?: string },
  userId: string,
  sb: SupabaseClient
): Promise<ToolContent> {
  const limit = Math.min(params.limit ?? 10, 30)

  let query = sb
    .from('knowledge_sources')
    .select('id, title, source_type, source_url, created_at, participants')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(limit)

  if (params.source_type) {
    query = query.eq('source_type', params.source_type)
  }
  if (params.date_from) {
    query = query.gte('created_at', params.date_from)
  }
  if (params.date_to) {
    const dateTo = new Date(params.date_to)
    dateTo.setDate(dateTo.getDate() + 1)
    query = query.lt('created_at', dateTo.toISOString().split('T')[0])
  }

  const { data } = await query

  if (!data || data.length === 0) {
    return { content: [{ type: 'text', text: 'No sources found in the knowledge graph.' }] }
  }

  const sources = data as Array<{
    id: string; title: string; source_type: string; source_url: string | null
    created_at: string; participants: string[] | null
  }>

  // Fetch node counts and build consistent response
  const results: Array<Record<string, unknown>> = []
  for (const s of sources) {
    const { count } = await sb
      .from('knowledge_nodes')
      .select('id', { count: 'exact', head: true })
      .eq('source_id', s.id)
      .eq('user_id', userId)

    results.push({
      source_id: s.id,
      title: s.title,
      source_type: s.source_type,
      created_at: s.created_at,
      participants: s.participants ?? null,
      entity_count: count ?? 0,
      source_url: s.source_url ?? null,
    })
  }

  return {
    content: [{
      type: 'text',
      text: JSON.stringify(results, null, 2),
    }],
  }
}

// ─── Shared helpers ─────────────────────────────────────────────────────────

/** Find a source by ID or fuzzy title match. Optionally restrict to a source_type. */
async function findSource(
  sb: SupabaseClient,
  userId: string,
  opts: { source_id?: string; query?: string; source_type?: string }
): Promise<Record<string, unknown> | null> {
  if (opts.source_id) {
    const { data } = await sb
      .from('knowledge_sources')
      .select('*')
      .eq('id', opts.source_id)
      .eq('user_id', userId)
      .maybeSingle()
    return data as Record<string, unknown> | null
  }

  if (opts.query) {
    let q = sb
      .from('knowledge_sources')
      .select('*')
      .eq('user_id', userId)
      .ilike('title', `%${opts.query}%`)
      .order('created_at', { ascending: false })
      .limit(1)

    if (opts.source_type) {
      q = q.eq('source_type', opts.source_type)
    }

    const { data } = await q
    return ((data ?? []) as Array<Record<string, unknown>>)[0] ?? null
  }

  return null
}

/** Cross-source connection finder. Returns related sources sharing entity connections. */
async function findRelatedSources(
  sb: SupabaseClient,
  userId: string,
  sourceId: string,
  sourceTypeFilter?: string,
  limit: number = 10
): Promise<Array<{
  source_id: string
  title: string
  source_type: string
  created_at: string
  participants: string[] | null
  source_url: string | null
  shared_entity_count: number
  shared_entities: Array<{ label: string; entity_type: string; relation_type: string }>
}>> {
  // 1. Get all node IDs from this source
  const { data: sourceNodes } = await sb
    .from('knowledge_nodes')
    .select('id')
    .eq('source_id', sourceId)
    .eq('user_id', userId)

  if (!sourceNodes?.length) return []

  const nodeIds = (sourceNodes as Array<{ id: string }>).map(n => n.id)

  // 2. Find edges connecting to these nodes
  const { data: edges } = await sb
    .from('knowledge_edges')
    .select('source_node_id, target_node_id, relation_type')
    .eq('user_id', userId)
    .or(
      nodeIds.map(id => `source_node_id.eq.${id},target_node_id.eq.${id}`).join(',')
    )

  if (!edges?.length) return []

  const nodeIdSet = new Set(nodeIds)

  // 3. Collect "other side" node IDs with their edge info
  const otherNodeEdges = new Map<string, string[]>() // nodeId -> relation_types
  for (const edge of edges as Array<{ source_node_id: string; target_node_id: string; relation_type: string }>) {
    if (nodeIdSet.has(edge.source_node_id) && !nodeIdSet.has(edge.target_node_id)) {
      const existing = otherNodeEdges.get(edge.target_node_id) ?? []
      existing.push(edge.relation_type)
      otherNodeEdges.set(edge.target_node_id, existing)
    }
    if (nodeIdSet.has(edge.target_node_id) && !nodeIdSet.has(edge.source_node_id)) {
      const existing = otherNodeEdges.get(edge.source_node_id) ?? []
      existing.push(edge.relation_type)
      otherNodeEdges.set(edge.source_node_id, existing)
    }
  }

  if (otherNodeEdges.size === 0) return []

  // 4. Fetch those nodes with their source info
  const otherNodeIdsArr = Array.from(otherNodeEdges.keys())
  const { data: otherNodes } = await sb
    .from('knowledge_nodes')
    .select('id, label, entity_type, source_id')
    .in('id', otherNodeIdsArr)
    .neq('source_id', sourceId)

  if (!otherNodes?.length) return []

  // 5. Group by source_id
  const sourceGroups = new Map<string, Array<{ label: string; entity_type: string; relation_type: string }>>()
  for (const node of otherNodes as Array<{ id: string; label: string; entity_type: string; source_id: string }>) {
    if (!node.source_id) continue
    const existing = sourceGroups.get(node.source_id) ?? []
    const relTypes = otherNodeEdges.get(node.id) ?? []
    existing.push({
      label: node.label,
      entity_type: node.entity_type,
      relation_type: relTypes[0] ?? 'connected_to',
    })
    sourceGroups.set(node.source_id, existing)
  }

  // 6. Sort by shared entity count, limit
  const sortedSourceIds = [...sourceGroups.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, limit)
    .map(([sid]) => sid)

  if (sortedSourceIds.length === 0) return []

  // 7. Fetch source metadata
  let sourceQuery = sb
    .from('knowledge_sources')
    .select('id, title, source_type, created_at, participants, source_url')
    .in('id', sortedSourceIds)
    .eq('user_id', userId)

  if (sourceTypeFilter) {
    sourceQuery = sourceQuery.eq('source_type', sourceTypeFilter)
  }

  const { data: sourcesData } = await sourceQuery
  const sourceMap = new Map<string, Record<string, unknown>>()
  for (const s of (sourcesData ?? []) as Array<Record<string, unknown>>) {
    sourceMap.set(s.id as string, s)
  }

  // 8. Assemble results
  const results: Array<{
    source_id: string
    title: string
    source_type: string
    created_at: string
    participants: string[] | null
    source_url: string | null
    shared_entity_count: number
    shared_entities: Array<{ label: string; entity_type: string; relation_type: string }>
  }> = []

  for (const sid of sortedSourceIds) {
    const src = sourceMap.get(sid)
    if (!src) continue
    const entities = sourceGroups.get(sid) ?? []
    results.push({
      source_id: sid,
      title: src.title as string,
      source_type: src.source_type as string,
      created_at: src.created_at as string,
      participants: (src.participants as string[] | null) ?? null,
      source_url: (src.source_url as string | null) ?? null,
      shared_entity_count: entities.length,
      shared_entities: entities,
    })
  }

  return results
}

// ─── New tool handlers ──────────────────────────────────────────────────────

async function handleGetSourceContent(
  params: { query: string; source_id?: string; include_content?: boolean; max_content_length?: number },
  userId: string,
  sb: SupabaseClient
): Promise<ToolContent> {
  const includeContent = params.include_content !== false
  const maxLen = params.max_content_length ?? 50000

  const source = await findSource(sb, userId, {
    source_id: params.source_id,
    query: params.query,
  })

  if (!source) {
    return {
      content: [{
        type: 'text',
        text: `No source found matching "${params.source_id ?? params.query}". Try \`search_sources\` with broader terms or check \`get_recent_sources\` for recent ingestions.`,
      }],
    }
  }

  // Entity count
  const { count: entityCount } = await sb
    .from('knowledge_nodes')
    .select('id', { count: 'exact', head: true })
    .eq('source_id', source.id as string)
    .eq('user_id', userId)

  // Chunk count
  const { count: chunkCount } = await sb
    .from('source_chunks')
    .select('id', { count: 'exact', head: true })
    .eq('source_id', source.id as string)

  const rawContent = (source.content as string) ?? ''
  const contentLength = rawContent.length
  const truncated = contentLength > maxLen
  const content = includeContent ? (truncated ? rawContent.slice(0, maxLen) : rawContent) : null

  const result = {
    source_id: source.id as string,
    title: source.title as string,
    source_type: source.source_type as string,
    source_url: (source.source_url as string | null) ?? null,
    created_at: source.created_at as string,
    participants: (source.participants as string[] | null) ?? null,
    metadata: (source.metadata as Record<string, unknown>) ?? {},
    content,
    content_length: contentLength,
    content_truncated: truncated,
    entity_count: entityCount ?? 0,
    chunk_count: chunkCount ?? 0,
  }

  return {
    content: [{
      type: 'text',
      text: JSON.stringify(result, null, 2),
    }],
  }
}

async function handleSearchSources(
  params: {
    query?: string
    source_type?: string
    date_from?: string
    date_to?: string
    participant?: string
    limit?: number
    sort?: string
  },
  userId: string,
  sb: SupabaseClient
): Promise<ToolContent> {
  const limit = Math.min(params.limit ?? 10, 30)
  const sort = params.sort ?? 'recent'

  let query = sb
    .from('knowledge_sources')
    .select('id, title, source_type, source_url, created_at, participants, metadata, content')
    .eq('user_id', userId)
    .limit(limit)

  if (params.source_type) {
    query = query.eq('source_type', params.source_type)
  }
  if (params.date_from) {
    query = query.gte('created_at', params.date_from)
  }
  if (params.date_to) {
    // Add a day to make the date_to inclusive
    const dateTo = new Date(params.date_to)
    dateTo.setDate(dateTo.getDate() + 1)
    query = query.lt('created_at', dateTo.toISOString().split('T')[0])
  }
  if (params.query) {
    query = query.or(`title.ilike.%${params.query}%,content.ilike.%${params.query}%`)
  }

  // Sort
  if (sort === 'recent') {
    query = query.order('created_at', { ascending: false })
  } else {
    // 'relevant' — title matches first, then recent
    query = query.order('created_at', { ascending: false })
  }

  const { data } = await query

  if (!data || data.length === 0) {
    const suggestion = params.query
      ? `No sources found matching "${params.query}". Try broader terms or remove date/type filters.`
      : 'No sources found matching the given filters. Try a broader date range or remove filters.'
    return { content: [{ type: 'text', text: suggestion }] }
  }

  const sources = data as Array<Record<string, unknown>>

  // Participant filter (PostgREST doesn't support array element ILIKE natively)
  let filtered = sources
  if (params.participant) {
    const partLower = params.participant.toLowerCase()
    filtered = sources.filter(s => {
      const participants = s.participants as string[] | null
      if (!participants) return false
      return participants.some(p => p.toLowerCase().includes(partLower))
    })
    if (filtered.length === 0) {
      return { content: [{ type: 'text', text: `No sources found with participant matching "${params.participant}".` }] }
    }
  }

  // If sort is 'relevant' and query is present, reorder by title match quality
  if (sort === 'relevant' && params.query) {
    const qLower = params.query.toLowerCase()
    filtered.sort((a, b) => {
      const aTitle = ((a.title as string) ?? '').toLowerCase().includes(qLower) ? 0 : 1
      const bTitle = ((b.title as string) ?? '').toLowerCase().includes(qLower) ? 0 : 1
      if (aTitle !== bTitle) return aTitle - bTitle
      return new Date(b.created_at as string).getTime() - new Date(a.created_at as string).getTime()
    })
  }

  // Fetch entity counts and format results
  const results: Array<Record<string, unknown>> = []
  for (const s of filtered) {
    const { count } = await sb
      .from('knowledge_nodes')
      .select('id', { count: 'exact', head: true })
      .eq('source_id', s.id as string)
      .eq('user_id', userId)

    const rawContent = (s.content as string) ?? ''
    results.push({
      source_id: s.id as string,
      title: s.title as string,
      source_type: s.source_type as string,
      source_url: (s.source_url as string | null) ?? null,
      created_at: s.created_at as string,
      participants: (s.participants as string[] | null) ?? null,
      metadata: (s.metadata as Record<string, unknown>) ?? {},
      entity_count: count ?? 0,
      content_preview: rawContent.slice(0, 300),
    })
  }

  return {
    content: [{
      type: 'text',
      text: JSON.stringify(results, null, 2),
    }],
  }
}

async function handleGetMeetingBrief(
  params: { query: string; source_id?: string },
  userId: string,
  sb: SupabaseClient
): Promise<ToolContent> {
  const source = await findSource(sb, userId, {
    source_id: params.source_id,
    query: params.query,
    source_type: 'Meeting',
  })

  if (!source) {
    return {
      content: [{
        type: 'text',
        text: `No meeting found matching "${params.source_id ?? params.query}". Try \`search_sources\` with source_type "Meeting" to find the correct title.`,
      }],
    }
  }

  const sourceId = source.id as string

  // Fetch all entities for this source
  const { data: entities } = await sb
    .from('knowledge_nodes')
    .select('id, label, entity_type, description, confidence, quote')
    .eq('source_id', sourceId)
    .eq('user_id', userId)

  const allEntities = (entities ?? []) as Array<{
    id: string; label: string; entity_type: string
    description: string | null; confidence: number | null; quote: string | null
  }>

  // Group entities by type
  const decisions = allEntities
    .filter(e => e.entity_type === 'Decision')
    .map(e => ({ label: e.label, description: e.description ?? '', confidence: e.confidence ?? 0, quote: e.quote ?? null }))

  const actionItems = allEntities
    .filter(e => e.entity_type === 'Action')
    .map(e => ({ label: e.label, description: e.description ?? '', confidence: e.confidence ?? 0, quote: e.quote ?? null }))

  const keyInsights = allEntities
    .filter(e => ['Insight', 'Concept', 'Lesson', 'Takeaway'].includes(e.entity_type))
    .map(e => ({ label: e.label, entity_type: e.entity_type, description: e.description ?? '', confidence: e.confidence ?? 0, quote: e.quote ?? null }))

  const topicsDiscussed = allEntities
    .filter(e => e.entity_type === 'Topic')
    .map(e => ({ label: e.label, description: e.description ?? '' }))

  const peopleMentioned = allEntities
    .filter(e => e.entity_type === 'Person')
    .map(e => ({ label: e.label, description: e.description ?? '' }))

  const risksAndBlockers = allEntities
    .filter(e => ['Risk', 'Blocker'].includes(e.entity_type))
    .map(e => ({ label: e.label, entity_type: e.entity_type, description: e.description ?? '' }))

  // Cross-source connections
  const relatedSources = await findRelatedSources(sb, userId, sourceId, undefined, 10)

  // Edge count
  const nodeIds = allEntities.map(e => e.id)
  let totalEdges = 0
  if (nodeIds.length > 0) {
    const { count } = await sb
      .from('knowledge_edges')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .or(
        nodeIds.map(id => `source_node_id.eq.${id},target_node_id.eq.${id}`).join(',')
      )
    totalEdges = count ?? 0
  }

  const metadata = (source.metadata as Record<string, unknown>) ?? {}

  const result = {
    meeting: {
      source_id: sourceId,
      title: source.title as string,
      created_at: source.created_at as string,
      participants: (source.participants as string[] | null) ?? null,
      source_url: (source.source_url as string | null) ?? null,
      metadata,
      duration: (metadata.duration as string | null) ?? null,
    },
    decisions,
    action_items: actionItems,
    key_insights: keyInsights,
    topics_discussed: topicsDiscussed,
    people_mentioned: peopleMentioned,
    risks_and_blockers: risksAndBlockers,
    related_sources: relatedSources,
    total_entities_extracted: allEntities.length,
    total_edges: totalEdges,
  }

  if (allEntities.length === 0) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(result, null, 2) +
          '\n\nNote: This meeting has been ingested but no entities have been extracted yet. The transcript is available via `get_source_content`.',
      }],
    }
  }

  return {
    content: [{
      type: 'text',
      text: JSON.stringify(result, null, 2),
    }],
  }
}

async function handleGetRelatedSources(
  params: { query: string; source_id?: string; source_type?: string; limit?: number },
  userId: string,
  sb: SupabaseClient
): Promise<ToolContent> {
  const limit = Math.min(params.limit ?? 10, 30)

  const source = await findSource(sb, userId, {
    source_id: params.source_id,
    query: params.query,
  })

  if (!source) {
    return {
      content: [{
        type: 'text',
        text: `No source found matching "${params.source_id ?? params.query}".`,
      }],
    }
  }

  const sourceId = source.id as string
  const relatedSources = await findRelatedSources(sb, userId, sourceId, params.source_type, limit)

  const result = {
    source: {
      source_id: sourceId,
      title: source.title as string,
      source_type: source.source_type as string,
      created_at: source.created_at as string,
    },
    related_sources: relatedSources.map(rs => ({
      ...rs,
      relevance_summary: `Shares ${rs.shared_entity_count} entities: ${rs.shared_entities.map(e => `${e.label} (${e.entity_type})`).join(', ')}`,
    })),
  }

  if (relatedSources.length === 0) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(result, null, 2) +
          '\n\nNote: This source has no discovered connections to other sources yet. Entities may not have been extracted, or no shared entities exist across sources.',
      }],
    }
  }

  return {
    content: [{
      type: 'text',
      text: JSON.stringify(result, null, 2),
    }],
  }
}

// ─── MCP Router ──────────────────────────────────────────────────────────────

function jsonRpcError(id: string | number | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } }
}

function jsonRpcResult(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result }
}

async function handleMcpRequest(
  body: JsonRpcRequest,
  userId: string
): Promise<JsonRpcResponse> {
  const { method, params, id } = body
  const reqId = id ?? null

  // Create a service-role Supabase client for queries (no JWT session, manual user_id filter)
  const sb = getServiceSupabase()

  switch (method) {
    case 'initialize':
      return jsonRpcResult(reqId, {
        protocolVersion: '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'synapse', version: '1.0.0' },
      })

    case 'tools/list':
      return jsonRpcResult(reqId, { tools: TOOLS })

    case 'tools/call': {
      const toolName = (params as Record<string, unknown>)?.name as string | undefined
      const toolArgs = ((params as Record<string, unknown>)?.arguments ?? {}) as Record<string, unknown>

      if (!toolName) {
        return jsonRpcError(reqId, -32602, 'Missing tool name')
      }

      try {
        switch (toolName) {
          case 'ask_synapse':
            return jsonRpcResult(
              reqId,
              await handleAskSynapse(
                {
                  query: toolArgs.query as string,
                  max_results: toolArgs.max_results as number | undefined,
                  source_ids: toolArgs.source_ids as string[] | undefined,
                  source_type: toolArgs.source_type as string | undefined,
                },
                userId,
                sb
              )
            )

          case 'search_entities':
            return jsonRpcResult(
              reqId,
              await handleSearchEntities(
                {
                  query: toolArgs.query as string,
                  entity_type: toolArgs.entity_type as string | undefined,
                  limit: toolArgs.limit as number | undefined,
                  source_id: toolArgs.source_id as string | undefined,
                },
                userId,
                sb
              )
            )

          case 'get_entity':
            return jsonRpcResult(
              reqId,
              await handleGetEntity({ label: toolArgs.label as string }, userId, sb)
            )

          case 'get_connections':
            return jsonRpcResult(
              reqId,
              await handleGetConnections(
                { label: toolArgs.label as string, hops: toolArgs.hops as number | undefined },
                userId,
                sb
              )
            )

          case 'list_anchors':
            return jsonRpcResult(reqId, await handleListAnchors(userId, sb))

          case 'get_recent_sources':
            return jsonRpcResult(
              reqId,
              await handleGetRecentSources(
                {
                  limit: toolArgs.limit as number | undefined,
                  source_type: toolArgs.source_type as string | undefined,
                  date_from: toolArgs.date_from as string | undefined,
                  date_to: toolArgs.date_to as string | undefined,
                },
                userId,
                sb
              )
            )

          case 'get_source_content':
            return jsonRpcResult(
              reqId,
              await handleGetSourceContent(
                {
                  query: toolArgs.query as string,
                  source_id: toolArgs.source_id as string | undefined,
                  include_content: toolArgs.include_content as boolean | undefined,
                  max_content_length: toolArgs.max_content_length as number | undefined,
                },
                userId,
                sb
              )
            )

          case 'search_sources':
            return jsonRpcResult(
              reqId,
              await handleSearchSources(
                {
                  query: toolArgs.query as string | undefined,
                  source_type: toolArgs.source_type as string | undefined,
                  date_from: toolArgs.date_from as string | undefined,
                  date_to: toolArgs.date_to as string | undefined,
                  participant: toolArgs.participant as string | undefined,
                  limit: toolArgs.limit as number | undefined,
                  sort: toolArgs.sort as string | undefined,
                },
                userId,
                sb
              )
            )

          case 'get_meeting_brief':
            return jsonRpcResult(
              reqId,
              await handleGetMeetingBrief(
                {
                  query: toolArgs.query as string,
                  source_id: toolArgs.source_id as string | undefined,
                },
                userId,
                sb
              )
            )

          case 'get_related_sources':
            return jsonRpcResult(
              reqId,
              await handleGetRelatedSources(
                {
                  query: toolArgs.query as string,
                  source_id: toolArgs.source_id as string | undefined,
                  source_type: toolArgs.source_type as string | undefined,
                  limit: toolArgs.limit as number | undefined,
                },
                userId,
                sb
              )
            )

          default:
            return jsonRpcError(reqId, -32602, `Unknown tool: ${toolName}`)
        }
      } catch {
        return jsonRpcError(reqId, -32603, 'Internal error')
      }
    }

    default:
      return jsonRpcError(reqId, -32601, 'Method not found')
  }
}

// ─── Vercel handler ──────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Only POST is allowed for MCP Streamable HTTP
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json(jsonRpcError(null, -32600, 'Only POST is supported'))
  }

  // Authenticate via API key
  const auth = await verifyApiKey(req)
  if (!auth) {
    return res.status(401).json({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } })
  }

  try {
    const body = req.body as JsonRpcRequest
    if (!body || body.jsonrpc !== '2.0' || !body.method) {
      return res.status(400).json(jsonRpcError(null, -32600, 'Invalid JSON-RPC request'))
    }

    const result = await handleMcpRequest(body, auth.userId)
    return res.status(200).json(result)
  } catch {
    return res.status(500).json(jsonRpcError(null, -32603, 'Internal error'))
  }
}
