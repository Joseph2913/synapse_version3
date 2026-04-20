/**
 * api/mcp.ts
 *
 * Synapse MCP Server — Vercel serverless function implementing MCP Streamable HTTP transport.
 * Exposes 16 tools: 12 knowledge graph tools + 3 skill library tools + 1 write tool (send_to_synapse).
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

// ─── Relationship Search (PRD-RAG-05) ───────────────────────────────────────
// Called internally by ask_synapse when query classifier routes here (PRD-RAG-01)

async function matchRelationships(
  queryEmbedding: number[],
  userId: string,
  sb: SupabaseClient,
  threshold: number = 0.65,
  count: number = 10
) {
  const { data, error } = await sb.rpc('match_relationships', {
    query_embedding: JSON.stringify(queryEmbedding),
    match_threshold: threshold,
    match_count: count,
    p_user_id: userId,
  })

  if (error) {
    console.error('match_relationships RPC error:', error)
    return []
  }

  return data ?? []
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

// ─── PRD-RAG-01: Inline Query Classification & Reranking ───────────────────

type RetrievalType = 'factual' | 'relational' | 'synthesis'

const RELATIONAL_PATTERNS = [
  /how\s+(does|do|did|is|are|was|were)\s+.+\s+(relate|connect|link|impact|affect|influence|support|block|enable)/i,
  /relationship\s+between/i,
  /connection\s+between/i,
  /how\s+.+\s+and\s+.+\s+(relate|connect|interact)/i,
  /what('s|\s+is)\s+the\s+(link|connection|relationship|relation)\s+between/i,
  /does\s+.+\s+(support|block|enable|contradict|prevent)\s+/i,
]

const SYNTHESIS_PATTERNS = [
  /what\s+do\s+I\s+know\s+about/i,
  /summarise|summarize|overview|summary\s+of/i,
  /how\s+has\s+.+\s+evolved/i,
  /everything\s+(about|related|regarding)/i,
  /compare\s+.+\s+(and|with|to|versus|vs)/i,
  /what\s+are\s+(the\s+)?(key|main|major)\s+(themes|topics|points|takeaways)/i,
  /across\s+(all\s+)?(my\s+)?(sources|meetings|documents)/i,
  /brief\s+me\s+on/i,
  /what\s+do\s+we\s+know/i,
]

const FACTUAL_PATTERNS = [
  /what\s+did\s+\w+\s+say/i,
  /when\s+(did|was|were|is)/i,
  /who\s+(said|mentioned|proposed|decided|created|leads|owns)/i,
  /what\s+is\s+the\s+(status|deadline|date|cost|price|number)/i,
  /how\s+many/i,
  /what\s+(exactly|specifically)/i,
  /quote\s+(from|about)/i,
]

function classifyRetrievalType(query: string): RetrievalType {
  for (const p of RELATIONAL_PATTERNS) { if (p.test(query)) return 'relational' }
  for (const p of SYNTHESIS_PATTERNS) { if (p.test(query)) return 'synthesis' }
  for (const p of FACTUAL_PATTERNS) { if (p.test(query)) return 'factual' }
  return 'factual' // safe default
}

interface RerankResult { id: string; text: string; score: number; source_type: 'chunk' | 'relationship' }

async function rerankForMCP(
  query: string,
  candidates: Array<{ id: string; text: string; source_type: 'chunk' | 'relationship' }>,
  topN: number
): Promise<RerankResult[]> {
  if (candidates.length <= topN) {
    return candidates.map(c => ({ ...c, score: 5 }))
  }

  const candidateList = candidates.map((c, i) => `[${i}] ${c.text.slice(0, 300)}`).join('\n\n')
  const prompt = `Score each passage 0-10 for relevance to this query. Return ONLY a JSON array of numbers.\n\nQuery: "${query}"\n\nPassages:\n${candidateList}`

  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 6000)
    try {
      const resp = await fetch(
        `${GEMINI_BASE}/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { maxOutputTokens: 1024, temperature: 0, responseMimeType: 'application/json', thinkingConfig: { thinkingBudget: 0 } },
          }),
        }
      )
      const data = await resp.json()
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text
      if (!text) throw new Error('empty')
      const scores: number[] = JSON.parse(text)
      const ranked = candidates.map((c, i) => ({ ...c, score: typeof scores[i] === 'number' ? scores[i] : 0 }))
      ranked.sort((a, b) => b.score - a.score)
      return ranked.slice(0, topN)
    } finally {
      clearTimeout(timeout)
    }
  } catch {
    return candidates.slice(0, topN).map(c => ({ ...c, score: 5 }))
  }
}

function getTypeSystemPromptGuidance(type: RetrievalType): string {
  switch (type) {
    case 'factual':
      return 'Answer directly and specifically. Cite the exact source. Be concise.'
    case 'relational':
      return 'Explain the relationships between concepts. Describe how they connect, support, or influence each other. Reference evidence for each relationship.'
    case 'synthesis':
      return 'Provide a comprehensive overview synthesising information across multiple sources. Highlight patterns, contradictions, and temporal evolution. Be thorough but organised.'
  }
}

// ─── Send to Synapse handler ────────────────────────────────────────────────

async function handleSendToSynapse(
  args: { title: string; content: string; repo?: string; branch?: string; guidance?: string },
  userId: string
): Promise<ToolContent> {
  const INGEST_SECRET = process.env.INGEST_SECRET;
  if (!INGEST_SECRET) {
    return { content: [{ type: 'text', text: 'Error: INGEST_SECRET not configured on server.' }] };
  }

  const appUrl = process.env.APP_DOMAIN
    ?? (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000');

  const response = await fetch(`${appUrl}/api/ingest/session`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-ingest-secret': INGEST_SECRET,
    },
    body: JSON.stringify({
      userId,
      title: args.title,
      content: args.content,
      repo: args.repo ?? null,
      branch: args.branch ?? null,
      guidance: args.guidance ?? null,
    }),
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    const errBody = await response.text();
    return { content: [{ type: 'text', text: `Failed to ingest session: ${response.status} ${errBody.slice(0, 300)}` }] };
  }

  const result = await response.json() as {
    source_id: string;
    title: string;
    status: string;
    message: string;
  };

  return {
    content: [{
      type: 'text',
      text: `Session sent to Synapse.\n\nSource ID: ${result.source_id}\nTitle: ${result.title}\nStatus: ${result.status}\n\nThe extraction pipeline is running in the background. Entities, relationships, and embeddings will be available in your knowledge graph shortly. You can check the source status via search_sources.`,
    }],
  };
}

// ─── Tool descriptors ────────────────────────────────────────────────────────

const TOOLS: ToolDescriptor[] = [
  {
    name: 'ask_synapse',
    description:
      "Query the user's knowledge graph using semantic RAG — searches source content chunks by embedding similarity and returns relevant passages with source citations. Best for CROSS-SOURCE SYNTHESIS when you need to find specific information scattered across multiple sources.\n\n⚠️ IMPORTANT ROUTING GUIDANCE: This tool should typically NOT be your first call. It searches over indexed source chunks using embedding similarity, which means:\n- It CANNOT find content from recently ingested sources that are not yet indexed (check get_recent_sources for indexing_status)\n- It performs POORLY on abstract/thematic queries (\"What is the philosophy of X?\") because it matches on linguistic similarity, not conceptual themes\n- It returns fragmented snippets, not coherent narratives — for depth on a specific source, use get_source_content instead\n- It cannot tell you what content EXISTS in the graph — only what matches your query linguistically\n\nRECOMMENDED SEQUENCE for most queries:\n1. search_entities (orient — what entities exist in this space?)\n2. get_recent_sources (orient — what sources exist and are they indexed?)\n3. list_anchors (if the query spans multiple domains)\n4. get_connections (map — how are relevant entities related?)\n5. get_source_content (extract — read full transcripts of the most relevant sources)\n6. ask_synapse (synthesise — targeted cross-source questions to fill gaps)\n\nUSE THIS TOOL DIRECTLY (skip orientation) only when:\n- You have a specific factual question and know the content exists (\"What did source X say about Y?\")\n- You are doing targeted gap-filling after already reading full source transcripts\n- The user has constrained the query to specific source_ids or source_type\n\nWhen using this tool, prefer specific concrete queries with entity names and domain-specific terms over abstract conceptual queries. \"Narayana Murthy Infosys partnership strategy\" will outperform \"Indian business philosophy.\"",
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
      "RECOMMENDED FIRST TOOL for most queries. Search for entities (people, concepts, projects, decisions, topics, organisations, etc.) in the user's knowledge graph by name or description. Returns matching nodes with their type, description, and connection count.\n\nQUERY ROUTING — Start here for:\n- Broad thematic exploration (\"What do I know about X?\") → use a thematic query with limit 20 to survey the entity landscape before going deeper\n- Specific entity lookup (\"Who is X?\" / \"What is Y?\") → use the entity name directly\n- Relationship mapping (\"How is X connected to Y?\") → find both entities, then use get_connections\n- Meeting/person preparation (\"Brief me on X\") → find the person entity, then trace their connections\n\nThis tool searches over extracted entity labels and descriptions — a DIFFERENT index than source content chunks. It finds things that ask_synapse may miss, especially recently ingested content where entities have been extracted but chunks are not yet indexed.\n\nAfter getting results, typical next steps are:\n1. get_connections (hops=2) on the most connected entities to map the relationship network\n2. get_source_content on relevant sources to read full transcripts\n3. ask_synapse ONLY for targeted cross-source synthesis questions\n\nNote: this returns entities, not the sources they came from. To find which sources a person appeared in, use search_sources with the participant filter, or get_recent_sources with the participant parameter.",
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
      "Traverse the relationship network around a specific entity up to N hops. Shows how concepts, people, and projects are linked in the user's knowledge graph. Returns a tree of connected entities with relationship types.\n\nQUERY ROUTING — Use this tool:\n- After search_entities has identified relevant entities — traverse from the most connected ones (highest connection count) to map the surrounding knowledge structure\n- For relationship mapping queries (\"How is X connected to Y?\") — run get_connections on both entities and look for shared nodes\n- For broad exploration — run with hops=2 on thematic entities or anchors to discover the full scope of content in a domain\n- For meeting preparation — traverse from a person entity to see all topics, projects, and decisions connected to them\n\nUse hops=1 for focused neighbourhood view, hops=2 for broader context (recommended default), hops=3 only when specifically looking for distant/bridging connections.\n\nIMPORTANT: Verify entity labels carefully before calling this tool. If the knowledge graph contains multiple entities with similar labels (e.g., an acronym that matches both a sports league and an unrelated concept), the wrong entity may be traversed. Cross-reference with search_entities results to confirm you have the correct node.",
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
      "Return the user's anchor entities — the high-signal, recurring concepts and people that the user has designated as most important. Anchors are the structural hubs of the knowledge graph with the highest connectivity.\n\nQUERY ROUTING — Use this tool:\n- During the orientation phase of broad exploratory queries, to check if any anchors relate to the topic being explored. Anchors are the most connected nodes and serve as bridges between different knowledge domains.\n- When looking for cross-domain connections — anchors connect clusters of related entities that might otherwise appear disconnected.\n- When the user asks about their \"main topics\" or \"key themes\" — anchors represent exactly this.\n\nTypical sequence: search_entities → list_anchors (check for relevant anchors) → get_connections on relevant anchors → deeper exploration.",
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'get_recent_sources',
    description:
      "List recently ingested content sources (meetings, YouTube videos, documents, notes) with their indexing status. Each result includes an indexing_status field (complete/partial/pending) indicating whether semantic search via ask_synapse can find content from that source yet.\n\nQUERY ROUTING — Use this tool:\n- ALWAYS as part of the orientation phase for broad exploratory queries, to check what content exists and whether it is searchable yet. Sources with pending/partial indexing status will NOT appear in ask_synapse results but CAN be accessed via get_source_content.\n- For any time-based query (\"What did I ingest this week?\" / \"What meetings did I have recently?\")\n- When ask_synapse returns surprisingly few results — check whether relevant sources exist but are not yet indexed\n- For meeting/person preparation — filter by participant to find all sources involving a specific person\n\nCombine with search_entities for comprehensive orientation: search_entities maps the entity landscape, get_recent_sources maps the source landscape and indexing status.",
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
        participant: {
          type: 'string',
          description: 'Optional filter: name of a person who participated. Searches the participants array on the source.',
        },
      },
    },
  },
  {
    name: 'get_source_content',
    description:
      "PRIMARY tool for deep analysis of a specific source. Returns the full raw content (transcript, article, notes) plus metadata including entity count and chunk count. Contains the complete verbatim record including tone, reasoning, and details that structured notes or RAG snippets omit.\n\nQUERY ROUTING — Use this tool:\n- For any single-source deep dive (\"Summarise that video about X\" / \"What were the key points from Y?\")\n- AFTER the orientation phase (search_entities + get_recent_sources) has identified the 3-5 most relevant sources for a broad query — reading full transcripts produces far richer synthesis than multiple ask_synapse calls returning fragmented snippets\n- When ask_synapse returns low-relevance results (sub-40% scores) — the content may exist but not match the query linguistically. Reading the full source lets you find thematic connections that semantic search misses.\n- When a source has chunk_count: 0 or indexing_status: pending/partial — this tool bypasses the chunk index entirely and reads the raw source content directly.\n\nFor broad synthesis tasks, prefer reading 3-5 full source transcripts over running 10+ ask_synapse queries. Full transcripts give coherent narratives; RAG snippets give fragments.\n\nFor quick structured summaries of meetings specifically, prefer get_meeting_notes or get_meeting_brief instead.",
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
      "Search for content sources using keyword matching with filters for type, date range, and participants. Use when you need to find specific sources by title keyword, filter by source type (Meeting, YouTube, Research, Note, Document), or find all sources involving a specific participant.\n\nQUERY ROUTING — Use this over get_recent_sources when you need keyword-based title search or compound filters (e.g., \"meetings with Claudio in the last month\"). Use get_recent_sources for simple chronological browsing or indexing status checks.",
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
      "Assemble a structured meeting intelligence brief from existing extracted data. Provides a concise briefing format optimised for quick consumption before or after meetings.\n\nQUERY ROUTING — Use for fast pre-meeting preparation or post-meeting catchup. For deeper analysis, follow up with get_meeting_transcript (full verbatim text) or get_source_content (full source content).",
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
      "Given a source, find other sources that share entity connections with it. Surfaces content that is thematically related through shared people, concepts, or topics — even if the sources are from different time periods or formats.\n\nQUERY ROUTING — Use after identifying a relevant source to discover related content the user may not have thought to connect. Useful for broad exploration and serendipitous discovery.",
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
  {
    name: 'get_meeting_notes',
    description:
      "Get structured meeting notes — overview, key topics, decisions, action items — WITHOUT the raw transcript. Use for fast orientation: pre-meeting briefs, status updates, \"what did I miss?\" queries, action item follow-up.\n\nQUERY ROUTING — Use this instead of get_source_content when you need a quick structured summary of a meeting rather than the full verbatim transcript. For the raw transcript (needed for content creation, exact language, reasoning chains, or finding the \"why\" behind decisions), use get_meeting_transcript instead.",
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Meeting title or search term. Fuzzy matched against meeting source titles.',
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
    name: 'get_meeting_transcript',
    description:
      "Get the raw verbatim transcript of a meeting with speaker labels. Use for deep mining: content creation (slides, proposals), capturing exact language and framing, understanding reasoning chains, finding the \"why\" behind decisions.\n\nQUERY ROUTING — Use this when you need the full word-for-word record of a meeting. For quick structured summaries (topics, decisions, action items), use get_meeting_notes instead. For non-meeting sources (YouTube, documents, notes), use get_source_content.",
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Meeting title or search term. Fuzzy matched against meeting source titles.',
        },
        source_id: {
          type: 'string',
          description: 'Direct lookup by source UUID. If provided, query is ignored.',
        },
        max_length: {
          type: 'number',
          default: 50000,
          description: 'Truncate transcript at this character count.',
        },
      },
      required: ['query'],
    },
  },

  // ============================================
  // SKILL LIBRARY TOOLS (PRD-Skills-C)
  // ============================================

  {
    name: 'get_skills',
    description:
      "Return a lightweight index of all active skills in the user's Synapse skill library. Each entry includes the skill name, title, description, domain, tags, confidence score, and source count — but NOT the full content. Use this to discover which skills are relevant to the current task, then call get_skill_content to load the full methodology for the ones you need.\n\nSkills are auto-generated from the user's Synapse knowledge sources (YouTube videos, meeting transcripts, documents) and represent reusable methodologies, frameworks, and techniques. Always check for relevant skills before starting substantive work — the user's knowledge graph may contain methodology directly applicable to the task.",
    inputSchema: {
      type: 'object',
      properties: {
        domain: {
          type: 'string',
          description: "Optional filter: only return skills in this domain (e.g., 'ai-tooling', 'consulting-methodology', 'change-management'). Omit to return all active skills.",
        },
        include_drafts: {
          type: 'boolean',
          description: "If true, also return skills with status 'draft' (not yet reviewed by the user). Default false — only active skills are returned.",
          default: false,
        },
      },
    },
  },
  {
    name: 'get_skill_content',
    description:
      "Load the full content of a specific skill from the user's Synapse skill library. Returns the complete methodology, examples, and source attribution. Call this after using get_skills to identify a relevant skill by name.\n\nThe skill content includes a Methodology section (the core process to follow), Examples (showing the methodology applied), and Source Attribution (which Synapse sources contributed to this skill, with instructions for retrieving the original content via other Synapse MCP tools like get_source_content or get_meeting_transcript).",
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: "The kebab-case name of the skill to retrieve (e.g., 'local-claude-code-setup'). Use the exact name from the get_skills index.",
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'search_skills',
    description:
      "Search for skills in the user's Synapse skill library by semantic similarity. Finds skills whose descriptions match the intent of your query, even if the exact keywords don't appear. Use this when you need to find skills related to a specific task or topic, especially when the skill library is large.\n\nFor example, searching \"how to prevent AI from making things up\" would find a skill about AI honesty prompting even though the exact words don't match. Returns the top matches with their descriptions so you can decide which to load with get_skill_content.",
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Natural language description of the task or topic you\'re looking for skills about.',
        },
        max_results: {
          type: 'number',
          description: 'Maximum number of skills to return. Default 5, max 10.',
          default: 5,
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'consult_council',
    description:
      "Query your Advisory Council — a team of domain-specific AI advisors derived from your YouTube playlists. Each advisor has deep expertise in their domain and a distinct reasoning style.\n\nUse this instead of ask_synapse when:\n- The question spans multiple knowledge domains and benefits from cross-perspective analysis\n- You want to understand tensions or trade-offs between different viewpoints in your knowledge\n- The question is strategic/analytical (\"what should I think about X\") rather than factual (\"what do I know about X\")\n- You want to see which of your domain advisors have relevant expertise and where their knowledge gaps are\n\nDo NOT use for: simple factual lookups, single-source retrieval, \"what did X say about Y\" — use ask_synapse for those.",
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The question to put to the advisory council.',
        },
        mode: {
          type: 'string',
          enum: ['auto', 'single', 'multi'],
          description: 'Routing mode. "auto" (orchestrator decides), "single" (force one agent), "multi" (force multiple agents). Default "auto".',
        },
        agent_names: {
          type: 'array',
          items: { type: 'string' },
          description: 'Explicitly name which advisors to consult (e.g. ["Geopolitics", "AI Upskilling"]). If omitted, the orchestrator selects.',
        },
        include_agent_reasoning: {
          type: 'boolean',
          description: 'Whether to include each agent\'s individual analysis or just the final synthesis. Default true.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'send_to_synapse',
    description:
      'Send a structured session summary from Claude Code into the Synapse knowledge graph. Creates a GitHub source and triggers the full extraction pipeline (entity extraction, embeddings, chunking, cross-connections). Use after generating a session summary.',
    inputSchema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Concise descriptive title for the session.',
        },
        content: {
          type: 'string',
          description: 'Full structured markdown summary of the session.',
        },
        repo: {
          type: 'string',
          description: 'Repository name (auto-detected from working directory).',
        },
        branch: {
          type: 'string',
          description: 'Git branch name at time of session.',
        },
        guidance: {
          type: 'string',
          description: 'User-provided instructions that shaped the summary emphasis.',
        },
      },
      required: ['title', 'content'],
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
  const isSourceScoped = (params.source_ids && params.source_ids.length > 0) || !!params.source_type
  const matchThreshold = isSourceScoped ? 0.1 : 0.3

  // PRD-RAG-01 Step 1: Classify retrieval type
  const retrievalType = classifyRetrievalType(params.query)

  // Step 2: Embed query
  let embedding: number[]
  try {
    embedding = await embedText(params.query)
  } catch {
    return {
      content: [{ type: 'text', text: 'Unable to generate query embedding. Please try again.' }],
    }
  }

  // Step 3: Parallel retrieval — semantic chunks + keywords + relationships (if relational/synthesis)
  const useRelSearch = retrievalType === 'relational' || retrievalType === 'synthesis'
  const relMatchCount = retrievalType === 'relational' ? 10 : 5

  const [semanticChunksResult, keywordNodesResult, relationshipsResult] = await Promise.all([
    // Semantic search on source chunks
    sb.rpc('match_source_chunks', {
      query_embedding: embedding,
      match_threshold: retrievalType === 'synthesis' ? Math.min(matchThreshold, 0.25) : matchThreshold,
      match_count: isSourceScoped ? maxResults * 3 : (retrievalType === 'synthesis' ? maxResults * 2 : maxResults),
      p_user_id: userId,
    }),
    // Keyword search on knowledge nodes
    (async () => {
      const keywords = extractKeywords(params.query)
      if (keywords.length === 0) return [] as KeywordNodeResult[]
      const pattern = `%${keywords.join('%')}%`
      const { data } = await sb
        .from('knowledge_nodes')
        .select('id, label, description, entity_type, source_id')
        .eq('user_id', userId)
        .or(`label.ilike.${pattern},description.ilike.${pattern}`)
        .limit(10)
      return (data ?? []) as KeywordNodeResult[]
    })(),
    // Relationship embedding search (PRD-RAG-01)
    useRelSearch
      ? matchRelationships(embedding, userId, sb, 0.65, relMatchCount)
      : Promise.resolve([]),
  ])

  let chunks: ChunkResult[] = (semanticChunksResult.data ?? []) as ChunkResult[]
  const keywordNodes = keywordNodesResult as KeywordNodeResult[]
  const relationships = relationshipsResult as Array<{
    id: string; source_node_id: string; target_node_id: string;
    relation_type: string; evidence: string; weight: number;
    source_label: string; source_type: string; target_label: string; target_type: string;
    similarity: number;
  }>

  // Apply source scoping filters
  if (params.source_ids && params.source_ids.length > 0) {
    const scopeSet = new Set(params.source_ids)
    chunks = chunks.filter(c => scopeSet.has(c.source_id))

    if (chunks.length === 0) {
      const { data: fallbackChunks } = await sb
        .from('source_chunks')
        .select('id, source_id, chunk_index, content')
        .in('source_id', params.source_ids)
        .eq('user_id', userId)
        .order('chunk_index', { ascending: true })
        .limit(maxResults)

      chunks = ((fallbackChunks ?? []) as Array<{ id: string; source_id: string; chunk_index: number; content: string }>)
        .map(c => ({ ...c, similarity: 0 }))
    }
  }
  if (params.source_type) {
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
  chunks = chunks.slice(0, maxResults * 2) // Keep more for reranking

  // Step 4: Hybrid score
  const keywordSourceIds = new Set(keywordNodes.map(n => n.source_id).filter(Boolean))
  const scoredChunks = chunks.map(c => ({
    ...c,
    score: 0.6 * c.similarity + (keywordSourceIds.has(c.source_id) ? 0.4 : 0),
  }))
  scoredChunks.sort((a, b) => b.score - a.score)

  // Handle empty results
  if (scoredChunks.length === 0 && relationships.length === 0) {
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

  // Step 5: PRD-RAG-01 — Gemini reranking
  const rerankerCandidates = [
    ...scoredChunks.map(c => ({
      id: c.id,
      text: c.content,
      source_type: 'chunk' as const,
    })),
    ...relationships.map(r => ({
      id: r.id,
      text: `${r.source_label} (${r.source_type}) ${r.relation_type} ${r.target_label} (${r.target_type})${r.evidence ? '. Evidence: ' + r.evidence : ''}`,
      source_type: 'relationship' as const,
    })),
  ]

  const topN = retrievalType === 'synthesis' ? 12 : retrievalType === 'relational' ? 10 : 8
  const reranked = await rerankForMCP(params.query, rerankerCandidates, topN)

  // Separate reranked back into chunks and relationships for context assembly
  const finalChunkIds = new Set(reranked.filter(r => r.source_type === 'chunk').map(r => r.id))
  const topChunks = scoredChunks.filter(c => finalChunkIds.has(c.id)).slice(0, maxResults)

  // Fetch source titles for top chunks
  const uniqueSourceIds = [...new Set(topChunks.map(c => c.source_id))]
  const { data: sourcesData } = await sb
    .from('knowledge_sources')
    .select('id, title, source_type')
    .in('id', uniqueSourceIds.length > 0 ? uniqueSourceIds : ['_'])
    .eq('user_id', userId)

  const sourceMap = new Map<string, { title: string; source_type: string }>()
  for (const s of (sourcesData ?? []) as Array<{ id: string; title: string; source_type: string }>) {
    sourceMap.set(s.id, { title: s.title, source_type: s.source_type })
  }

  // Step 6: Graph traversal — fetch connected anchor nodes
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

  // Step 7: Assemble context with type-specific structure
  const passageLines = topChunks.map(c => {
    const src = sourceMap.get(c.source_id)
    const title = src?.title ?? 'Unknown Source'
    return `[${title}]\n${c.content}`
  })

  const entityLines = anchorConnections.map(
    a => `- ${a.label} (${a.entity_type}) — ${a.relation_type}`
  )

  // PRD-RAG-01: Add relationship context for relational/synthesis queries
  const relationshipLines = relationships.length > 0
    ? relationships.map(r =>
        `- ${r.source_label} (${r.source_type}) ${r.relation_type} ${r.target_label} (${r.target_type})${r.evidence ? ' — ' + r.evidence : ''}`
      )
    : []

  const contextParts = [
    '[Source Passages]',
    ...passageLines,
    '',
    '[Key Entities & Connections]',
    ...(entityLines.length > 0 ? entityLines : ['(none found)']),
  ]

  if (relationshipLines.length > 0) {
    contextParts.push('', '[Semantic Relationships]', ...relationshipLines)
  }

  const contextStr = contextParts.join('\n\n')

  // Step 8: Call Gemini with type-specific guidance
  const typeGuidance = getTypeSystemPromptGuidance(retrievalType)
  const systemPrompt =
    'You are Synapse, an AI assistant that answers questions based only on the provided context from the user\'s personal knowledge graph. ' +
    'Cite sources by their title. If the context does not contain enough information, say so clearly. Do not make up information. ' +
    typeGuidance

  let answer: string
  try {
    answer = await generateAnswer(systemPrompt, `Context:\n${contextStr}\n\nQuestion: ${params.query}`)
  } catch {
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

  // Step 9: Format response
  const sources = topChunks
    .map(c => {
      const src = sourceMap.get(c.source_id)
      return src
        ? { source_id: c.source_id, title: src.title, source_type: src.source_type, relevance: Math.round(c.score * 100) / 100 }
        : null
    })
    .filter(Boolean)
    .filter((s, i, arr) => arr.findIndex(x => x!.source_id === s!.source_id) === i) as Array<{
      source_id: string
      title: string
      source_type: string
      relevance: number
    }>

  const entityLabels = [...new Set(anchorConnections.map(a => a.label))]

  const sourcesText = sources
    .map(s => `- ${s.title} (${s.source_type}, relevance: ${Math.round(s.relevance * 100)}%, id: ${s.source_id})`)
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
      query_embedding: embedding,
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
  params: { limit?: number; source_type?: string; date_from?: string; date_to?: string; participant?: string },
  userId: string,
  sb: SupabaseClient
): Promise<ToolContent> {
  const limit = Math.min(params.limit ?? 10, 30)

  let query = sb
    .from('knowledge_sources')
    .select('id, title, source_type, source_url, created_at, participants')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(params.participant ? 50 : limit) // fetch more when filtering by participant

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

  let sources = data as Array<{
    id: string; title: string; source_type: string; source_url: string | null
    created_at: string; participants: string[] | null
  }>

  // Filter by participant if provided — match against the participants array
  if (params.participant) {
    const participantLower = params.participant.toLowerCase()
    sources = sources.filter(s =>
      s.participants?.some(p => p.toLowerCase().includes(participantLower))
    )
    sources = sources.slice(0, limit)
  }

  if (sources.length === 0) {
    return { content: [{ type: 'text', text: params.participant ? `No sources found with participant "${params.participant}".` : 'No sources found in the knowledge graph.' }] }
  }

  // Fetch node counts, chunk counts, and embedding status for indexing_status
  const results: Array<Record<string, unknown>> = []
  for (const s of sources) {
    const [{ count: nodeCount }, { count: chunkCount }, { count: embeddedCount }] = await Promise.all([
      sb.from('knowledge_nodes').select('id', { count: 'exact', head: true }).eq('source_id', s.id).eq('user_id', userId),
      sb.from('source_chunks').select('id', { count: 'exact', head: true }).eq('source_id', s.id).eq('user_id', userId),
      sb.from('source_chunks').select('id', { count: 'exact', head: true }).eq('source_id', s.id).eq('user_id', userId).not('embedding', 'is', null),
    ])

    const totalChunks = chunkCount ?? 0
    const totalEmbedded = embeddedCount ?? 0
    const indexingStatus = totalChunks === 0 ? 'pending' : totalEmbedded < totalChunks ? 'partial' : 'complete'

    results.push({
      source_id: s.id,
      title: s.title,
      source_type: s.source_type,
      created_at: s.created_at,
      participants: s.participants ?? null,
      entity_count: nodeCount ?? 0,
      indexing_status: indexingStatus,
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

/** Parse meeting content into notes and transcript sections. Handles both formats:
 *  - V1 markdown: `## Meeting Notes` ... `## Transcript` ...
 *  - V2 delimited: notes ... `--- TRANSCRIPT ---` ... `--- ACTION ITEMS ---` ...
 *  - Manual paste: no delimiters, full content treated as transcript
 */
function parseMeetingContent(content: string): {
  notes: string | null
  transcript: string | null
  actionItems: string | null
  format: 'v1_markdown' | 'v2_delimited' | 'manual'
} {
  // V1 markdown format: ## Meeting Notes ... ## Transcript
  const v1TranscriptIdx = content.indexOf('## Transcript')
  if (v1TranscriptIdx !== -1) {
    const notesSection = content.slice(0, v1TranscriptIdx).trim()
    const transcriptSection = content.slice(v1TranscriptIdx + '## Transcript'.length).trim()
    return {
      notes: notesSection || null,
      transcript: transcriptSection || null,
      actionItems: null, // V1 format embeds actions in the notes section
      format: 'v1_markdown',
    }
  }

  // V2 delimited format: --- TRANSCRIPT --- ... --- ACTION ITEMS ---
  const v2TranscriptIdx = content.indexOf('--- TRANSCRIPT ---')
  if (v2TranscriptIdx !== -1) {
    const notesSection = content.slice(0, v2TranscriptIdx).trim()
    const afterTranscript = content.slice(v2TranscriptIdx + '--- TRANSCRIPT ---'.length)
    const actionIdx = afterTranscript.indexOf('--- ACTION ITEMS ---')
    let transcriptSection: string
    let actionItems: string | null = null
    if (actionIdx !== -1) {
      transcriptSection = afterTranscript.slice(0, actionIdx).trim()
      actionItems = afterTranscript.slice(actionIdx + '--- ACTION ITEMS ---'.length).trim() || null
    } else {
      transcriptSection = afterTranscript.trim()
    }
    return {
      notes: notesSection || null,
      transcript: transcriptSection || null,
      actionItems,
      format: 'v2_delimited',
    }
  }

  // Manual paste: no delimiters found, entire content is the transcript
  return {
    notes: null,
    transcript: content || null,
    actionItems: null,
    format: 'manual',
  }
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

async function handleGetMeetingNotes(
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
  const rawContent = (source.content as string) ?? ''
  const parsed = parseMeetingContent(rawContent)

  // Fetch extracted entities grouped by function
  const { data: entities } = await sb
    .from('knowledge_nodes')
    .select('label, entity_type, description, confidence, quote')
    .eq('source_id', sourceId)
    .eq('user_id', userId)

  const allEntities = (entities ?? []) as Array<{
    label: string; entity_type: string; description: string | null
    confidence: number | null; quote: string | null
  }>

  const decisions = allEntities.filter(e => e.entity_type === 'Decision')
  const actionItems = allEntities.filter(e => e.entity_type === 'Action')
  const keyInsights = allEntities.filter(e => ['Insight', 'Concept', 'Lesson', 'Takeaway'].includes(e.entity_type))
  const topics = allEntities.filter(e => e.entity_type === 'Topic')
  const people = allEntities.filter(e => e.entity_type === 'Person')

  const metadata = (source.metadata as Record<string, unknown>) ?? {}

  const result = {
    meeting: {
      source_id: sourceId,
      title: source.title as string,
      created_at: source.created_at as string,
      participants: (source.participants as string[] | null) ?? null,
      source_url: (source.source_url as string | null) ?? null,
      duration: (metadata.duration_seconds as number | null) ?? null,
    },
    format: parsed.format,
    notes: parsed.notes,
    action_items_raw: parsed.actionItems,
    extracted_entities: {
      decisions: decisions.map(e => ({ label: e.label, description: e.description, quote: e.quote })),
      action_items: actionItems.map(e => ({ label: e.label, description: e.description, quote: e.quote })),
      key_insights: keyInsights.map(e => ({ label: e.label, type: e.entity_type, description: e.description })),
      topics: topics.map(e => ({ label: e.label, description: e.description })),
      people: people.map(e => ({ label: e.label, description: e.description })),
    },
    total_entities: allEntities.length,
  }

  if (!parsed.notes) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(result, null, 2) +
          '\n\nNote: This meeting was manually pasted without structured notes. The extracted entities above contain the key intelligence. Use `get_meeting_transcript` for the full text.',
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

async function handleGetMeetingTranscript(
  params: { query: string; source_id?: string; max_length?: number },
  userId: string,
  sb: SupabaseClient
): Promise<ToolContent> {
  const maxLen = params.max_length ?? 50000

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

  const rawContent = (source.content as string) ?? ''
  const parsed = parseMeetingContent(rawContent)

  const transcript = parsed.transcript ?? ''
  const transcriptLength = transcript.length
  const truncated = transcriptLength > maxLen

  const metadata = (source.metadata as Record<string, unknown>) ?? {}

  const result = {
    meeting: {
      source_id: source.id as string,
      title: source.title as string,
      created_at: source.created_at as string,
      participants: (source.participants as string[] | null) ?? null,
      source_url: (source.source_url as string | null) ?? null,
      duration: (metadata.duration_seconds as number | null) ?? null,
    },
    format: parsed.format,
    transcript: truncated ? transcript.slice(0, maxLen) : transcript,
    transcript_length: transcriptLength,
    transcript_truncated: truncated,
  }

  if (!parsed.transcript) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(result, null, 2) +
          '\n\nNote: No transcript section found in this meeting content.',
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

// ─── Skill Usage Logging (PRD-Skills-D) ─────────────────────────────────────

function logSkillUsage(
  sb: SupabaseClient,
  userId: string,
  toolName: string,
  skillIds: string[],
  queryText: string | null,
  queryContext: Record<string, unknown>,
  sessionId: string | null
): void {
  if (skillIds.length === 0) return
  const rows = skillIds.map((skillId, idx) => ({
    user_id: userId,
    skill_id: skillId,
    tool_name: toolName,
    query_text: queryText,
    query_context: queryContext,
    session_id: sessionId,
    retrieval_rank: idx + 1,
  }))
  sb.from('skill_usage_log').insert(rows).then(() => {}).catch(err => {
    console.warn('[mcp] skill usage log failed:', err)
  })
}

// ─── Skill library handlers (PRD-Skills-C) ──────────────────────────────────

async function handleGetSkills(
  params: { domain?: string; include_drafts?: boolean },
  userId: string,
  sb: SupabaseClient,
  sessionId?: string | null
): Promise<ToolContent> {
  const includeDrafts = params.include_drafts === true
  const statuses = includeDrafts ? ['active', 'draft'] : ['active']

  let query = sb
    .from('knowledge_skills')
    .select('id, name, title, description, domain, tags, confidence, source_count, status, updated_at')
    .eq('user_id', userId)
    .in('status', statuses)
    .order('confidence', { ascending: false })
    .order('updated_at', { ascending: false })
    .limit(100)

  if (params.domain) {
    query = query.eq('domain', params.domain)
  }

  const { data, error } = await query

  if (error) {
    return { content: [{ type: 'text', text: `Error fetching skills: ${error.message}` }] }
  }

  const skills = (data ?? []) as Array<{
    id: string; name: string; title: string; description: string; domain: string | null
    tags: string[]; confidence: number; source_count: number; status: string
    updated_at: string
  }>

  if (skills.length === 0) {
    return {
      content: [{
        type: 'text',
        text: 'No skills in library yet. Skills are auto-generated from Synapse knowledge sources.',
      }],
    }
  }

  // Group by domain
  const grouped = new Map<string, typeof skills>()
  for (const skill of skills) {
    const domain = skill.domain ?? 'uncategorized'
    const existing = grouped.get(domain) ?? []
    existing.push(skill)
    grouped.set(domain, existing)
  }

  const statusLabel = includeDrafts ? 'active + draft' : 'active'
  const lines: string[] = [`Skills library (${skills.length} ${statusLabel}):\n`]
  let idx = 1

  for (const [domain, domainSkills] of grouped) {
    lines.push(`**${domain}**`)
    for (const s of domainSkills) {
      const date = s.updated_at.split('T')[0]
      const statusTag = s.status === 'draft' ? ' [DRAFT]' : ''
      lines.push(
        `  ${idx}. ${s.name}${statusTag} — ${s.description} ` +
        `(confidence: ${s.confidence.toFixed(2)}, sources: ${s.source_count}, updated: ${date})`
      )
      idx++
    }
    lines.push('')
  }

  if (skills.length >= 100) {
    lines.push('Showing top 100 by confidence. Use search_skills for targeted discovery.')
  }

  // Fire-and-forget usage logging (PRD-Skills-D)
  logSkillUsage(sb, userId, 'get_skills', skills.map(s => s.id), null,
    { filters: { domain: params.domain ?? null, include_drafts: includeDrafts } },
    sessionId ?? null)

  return { content: [{ type: 'text', text: lines.join('\n') }] }
}

async function handleGetSkillContent(
  params: { name: string },
  userId: string,
  sb: SupabaseClient,
  sessionId?: string | null
): Promise<ToolContent> {
  const { data, error } = await sb
    .from('knowledge_skills')
    .select('id, name, title, description, domain, tags, content, confidence, instructional_ratio, generalizability, structural_density, source_ids, source_count, status, created_at, updated_at, usage_count, last_used_at')
    .eq('user_id', userId)
    .eq('name', params.name)
    .maybeSingle()

  if (error) {
    return { content: [{ type: 'text', text: `Error fetching skill: ${error.message}` }] }
  }

  if (!data) {
    return {
      content: [{
        type: 'text',
        text: `Skill '${params.name}' not found. Use get_skills to see available skills.`,
      }],
    }
  }

  const skill = data as {
    name: string; title: string; description: string; domain: string | null
    tags: string[]; content: string; confidence: number
    instructional_ratio: number | null; generalizability: number | null
    structural_density: number | null; source_ids: string[]; source_count: number
    status: string; created_at: string; updated_at: string
  }

  const signals = [
    skill.instructional_ratio != null ? `instructional_ratio: ${skill.instructional_ratio.toFixed(2)}` : null,
    skill.generalizability != null ? `generalizability: ${skill.generalizability.toFixed(2)}` : null,
    skill.structural_density != null ? `structural_density: ${skill.structural_density.toFixed(2)}` : null,
  ].filter(Boolean).join(', ')

  const tagsStr = skill.tags.length > 0 ? skill.tags.join(', ') : 'none'

  const header = [
    `# ${skill.title}`,
    '',
    `**Domain**: ${skill.domain ?? 'uncategorized'} | **Confidence**: ${skill.confidence.toFixed(2)} | **Sources**: ${skill.source_count} | **Status**: ${skill.status}`,
    `**Last updated**: ${skill.updated_at.split('T')[0]}`,
    `**Tags**: ${tagsStr}`,
    signals ? `**Quality signals**: ${signals}` : null,
    '',
    '---',
    '',
    `**Triggering description**: ${skill.description}`,
    '',
    '---',
    '',
    skill.content,
  ].filter((line): line is string => line !== null).join('\n')

  // Track usage: increment usage_count and update last_used_at (fire-and-forget)
  const currentCount = ((data as Record<string, unknown>).usage_count as number) ?? 0
  sb.from('knowledge_skills')
    .update({
      usage_count: currentCount + 1,
      last_used_at: new Date().toISOString(),
    })
    .eq('user_id', userId)
    .eq('name', params.name)
    .then(() => { /* fire-and-forget */ })

  // Fire-and-forget usage logging (PRD-Skills-D)
  const skillId = (data as Record<string, unknown>).id as string
  logSkillUsage(sb, userId, 'get_skill_content', [skillId], skill.title,
    { request_type: 'full_content' }, sessionId ?? null)

  return { content: [{ type: 'text', text: header }] }
}

async function handleSearchSkills(
  params: { query: string; max_results?: number },
  userId: string,
  sb: SupabaseClient,
  sessionId?: string | null
): Promise<ToolContent> {
  const maxResults = Math.min(Math.max(params.max_results ?? 5, 1), 10)

  // Try semantic search via direct query (not RPC — match_skills uses auth.uid()
  // which returns null with the service-role client used by MCP)
  let usedSemantic = false
  let results: Array<{
    id: string; name: string; title: string; description: string; domain: string | null
    tags: string[]; confidence: number; source_count: number; status: string
    similarity: number
  }> = []

  try {
    const embedding = await embedText(params.query)

    // Use raw SQL via rpc to do cosine similarity with the user_id filter
    const { data, error } = await sb.rpc('match_skills_for_user', {
      query_embedding: embedding,
      match_count: maxResults,
      match_threshold: 0.3,
      p_user_id: userId,
    })

    if (!error && data && (data as unknown[]).length > 0) {
      results = data as typeof results
      usedSemantic = true
    }
  } catch {
    // Embedding generation failed — fall through to text search
  }

  // Text search fallback if semantic search didn't produce results
  if (!usedSemantic) {
    const pattern = `%${params.query}%`
    const { data: textData } = await sb
      .from('knowledge_skills')
      .select('id, name, title, description, domain, tags, confidence, source_count, status')
      .eq('user_id', userId)
      .eq('status', 'active')
      .or(`title.ilike.${pattern},description.ilike.${pattern}`)
      .order('confidence', { ascending: false })
      .limit(maxResults)

    if (textData && textData.length > 0) {
      results = (textData as Array<{
        id: string; name: string; title: string; description: string; domain: string | null
        tags: string[]; confidence: number; source_count: number; status: string
      }>).map(r => ({ ...r, similarity: 0 }))
    }
  }

  if (results.length === 0) {
    return {
      content: [{
        type: 'text',
        text: 'No matching skills found. Use get_skills to browse the full library.',
      }],
    }
  }

  const lines: string[] = [`Found ${results.length} matching skill${results.length === 1 ? '' : 's'}:\n`]

  for (let i = 0; i < results.length; i++) {
    const r = results[i]!
    const simStr = r.similarity > 0 ? ` (similarity: ${r.similarity.toFixed(2)})` : ' (text match)'
    lines.push(`${i + 1}. **${r.name}**${simStr}`)
    lines.push(`   Domain: ${r.domain ?? 'uncategorized'} | Confidence: ${r.confidence.toFixed(2)} | Sources: ${r.source_count}`)
    lines.push(`   ${r.description}`)
    lines.push('')
  }

  if (!usedSemantic) {
    lines.push('Note: Used text search fallback (skill embeddings not yet available). Results may be less precise than semantic search.')
  }

  lines.push('Use get_skill_content with the skill name to load the full methodology.')

  // Fire-and-forget usage logging (PRD-Skills-D)
  logSkillUsage(sb, userId, 'search_skills', results.map(r => r.id), params.query,
    { result_count: results.length, used_semantic: usedSemantic }, sessionId ?? null)

  return { content: [{ type: 'text', text: lines.join('\n') }] }
}

// ─── Council types ──────────────────────────────────────────────────────────

interface CouncilAgent {
  id: string
  user_id: string
  name: string
  description: string | null
  reasoning_style: string | null
  expertise_index: {
    summary?: string
    core_themes?: string[]
    reasoning_approach?: string
    strongest_areas?: Array<{ topic: string; source_count: number; key_entities: string[] }>
    weakest_areas?: Array<{ topic: string; reason: string }>
  } | null
  source_count: number
  entity_count: number
}

interface OrchestratorResult {
  classification: 'single_domain' | 'cross_domain' | 'meta'
  selected_agents: Array<{
    agent_id: string
    agent_name: string
    relevance: 'primary' | 'secondary'
    reason: string
  }>
  routing_rationale: string
  meta_answer: string | null
}

interface AgentAnalysisResult {
  analysis: string
  key_claims: Array<{ claim: string; evidence: string; confidence: 'high' | 'medium' | 'low' }>
  coverage_assessment: 'strong' | 'adequate' | 'thin' | 'gap'
  coverage_note: string
  cross_domain_flags: string[]
  sources_cited: string[]
}

interface SynthesisResult {
  synthesis: string
  agreements: Array<{ point: string; supporting_agents: string[] }>
  tensions: Array<{ point: string; agents_involved: string[]; nature: string }>
  emergent_insight: string | null
  blind_spots: Array<{ topic: string; relevant_gaps: string[] }>
  follow_up_suggestions: string[]
}

// ─── Council Gemini helper (JSON mode) ──────────────────────────────────────

async function geminiJson<T>(
  systemPrompt: string,
  userContent: string,
  temperature: number = 0.2,
  timeoutMs: number = 30000
): Promise<T> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetch(
      `${GEMINI_BASE}/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          system_instruction: { parts: [{ text: systemPrompt }] },
          contents: [{ parts: [{ text: userContent }] }],
          generationConfig: {
            temperature,
            responseMimeType: 'application/json',
          },
        }),
      }
    )

    if (!response.ok) {
      const errText = await response.text()
      throw new Error(`Gemini ${response.status}: ${errText.slice(0, 300)}`)
    }

    const data = await response.json() as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
    }
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text
    if (!text) throw new Error('No response from Gemini')
    return JSON.parse(text) as T
  } finally {
    clearTimeout(timeout)
  }
}

// ─── Council handler ────────────────────────────────────────────────────────

async function handleConsultCouncil(
  params: {
    query: string
    mode?: string
    agent_names?: string[]
    include_agent_reasoning?: boolean
  },
  userId: string,
  sb: SupabaseClient
): Promise<ToolContent> {
  const mode = params.mode ?? 'auto'
  const includeReasoning = params.include_agent_reasoning !== false

  // ── Fetch all agents for this user ──
  const { data: allAgents, error: agentsErr } = await sb
    .from('domain_agents')
    .select('id, user_id, name, description, reasoning_style, expertise_index, source_count, entity_count')
    .eq('user_id', userId)

  if (agentsErr || !allAgents || allAgents.length === 0) {
    // Fallback: no agents exist — delegate to ask_synapse behaviour
    return {
      content: [{
        type: 'text',
        text: 'No advisory council agents found. The council is built from your YouTube playlists — ingest some playlists first, then the nightly cron will create domain advisors. In the meantime, use ask_synapse for knowledge graph queries.',
      }],
    }
  }

  const agents = allAgents as CouncilAgent[]

  // Build master index summary for the orchestrator
  const masterIndex = agents.map(a => {
    const ei = a.expertise_index
    return [
      `## ${a.name} (ID: ${a.id})`,
      a.description ? `Description: ${a.description}` : '',
      ei?.summary ? `Summary: ${ei.summary}` : '',
      ei?.core_themes?.length ? `Core themes: ${ei.core_themes.join(', ')}` : '',
      ei?.reasoning_approach ? `Reasoning approach: ${ei.reasoning_approach}` : '',
      ei?.strongest_areas?.length
        ? `Strongest areas: ${ei.strongest_areas.map(s => s.topic).join(', ')}`
        : '',
      ei?.weakest_areas?.length
        ? `Weakest areas: ${ei.weakest_areas.map(w => w.topic).join(', ')}`
        : '',
      `Sources: ${a.source_count}, Entities: ${a.entity_count}`,
    ].filter(Boolean).join('\n')
  }).join('\n\n')

  // ── Step 1: Orchestrator Classification ──
  const orchestratorSystem = `You are the central orchestrator of an Advisory Council — a team of domain-specific AI advisors. Your job is to classify incoming queries and route them to the right advisor(s).

You have access to the following advisors, each with their own domain expertise:

${masterIndex}

Given the user's query, determine:
1. Is this a single-domain question (one advisor can handle it), a cross-domain question (2-3 advisors should each provide their perspective), or a meta question about the knowledge base itself (you answer directly)?
2. Which specific advisor(s) should be consulted?
3. Why these advisors? What does each bring to this question?

If the user has explicitly specified agent names, respect that selection but note if you think additional advisors would strengthen the response.

${mode === 'single' ? 'CONSTRAINT: You MUST select exactly ONE agent (the most relevant).' : ''}
${mode === 'multi' ? 'CONSTRAINT: You MUST select 2-3 agents even if the query seems single-domain.' : ''}

Respond with JSON matching this schema:
{
  "classification": "single_domain" | "cross_domain" | "meta",
  "selected_agents": [{ "agent_id": "uuid", "agent_name": "string", "relevance": "primary" | "secondary", "reason": "string" }],
  "routing_rationale": "string",
  "meta_answer": "string or null"
}`

  const agentNameConstraint = params.agent_names?.length
    ? `\n\nThe user has explicitly requested these advisors: ${params.agent_names.join(', ')}. Respect this selection.`
    : ''

  let orchestratorResult: OrchestratorResult
  try {
    orchestratorResult = await geminiJson<OrchestratorResult>(
      orchestratorSystem,
      `Query: ${params.query}${agentNameConstraint}`,
      0.2,
      15000
    )
  } catch (err) {
    // Classification failed — fall back to flat text answer
    return {
      content: [{
        type: 'text',
        text: `Council orchestrator failed (${err instanceof Error ? err.message : 'unknown error'}). Please retry, or use ask_synapse for a standard knowledge graph query.`,
      }],
    }
  }

  // ── Meta classification: orchestrator answers directly ──
  if (orchestratorResult.classification === 'meta' && orchestratorResult.meta_answer) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          routing: {
            classification: 'meta',
            agents_consulted: [],
            routing_rationale: orchestratorResult.routing_rationale,
          },
          agent_perspectives: [],
          synthesis: {
            answer: orchestratorResult.meta_answer,
            agreements: [],
            tensions: [],
            emergent_insight: null,
            blind_spots: [],
            follow_up_suggestions: [],
          },
        }, null, 2),
      }],
    }
  }

  // Resolve selected agents — match IDs from orchestrator to our fetched agents
  const selectedAgentIds = new Set(orchestratorResult.selected_agents.map(a => a.agent_id))
  // Also match by name in case orchestrator returned names that don't match IDs perfectly
  const selectedByName = new Set(orchestratorResult.selected_agents.map(a => a.agent_name.toLowerCase()))
  const resolvedAgents = agents.filter(
    a => selectedAgentIds.has(a.id) || selectedByName.has(a.name.toLowerCase())
  )

  if (resolvedAgents.length === 0) {
    // Orchestrator selected agents we can't find — pick the first agent as fallback
    resolvedAgents.push(agents[0])
  }

  // ── Step 2: Domain-Scoped RAG (parallel across agents) ──
  // Embed query once, reuse across all agents
  let queryEmbedding: number[]
  try {
    queryEmbedding = await embedText(params.query)
  } catch {
    return {
      content: [{ type: 'text', text: 'Unable to generate query embedding. Please try again.' }],
    }
  }

  // Parallel retrieval for each agent: chunks + entities
  const ragResults = await Promise.allSettled(
    resolvedAgents.map(async (agent) => {
      // Domain-scoped chunks via RPC
      const { data: chunks } = await sb.rpc('get_domain_scoped_chunks', {
        p_agent_id: agent.id,
        p_query_embedding: JSON.stringify(queryEmbedding),
        p_match_threshold: 0.5,
        p_match_count: 8,
      })

      // Get agent's source IDs for entity lookup
      const { data: agentSources } = await sb
        .from('domain_agent_sources')
        .select('source_id')
        .eq('agent_id', agent.id)

      const sourceIds = (agentSources ?? []).map((s: { source_id: string }) => s.source_id)

      // Entity lookup within agent scope (by source_id membership)
      let entities: Array<{ id: string; label: string; entity_type: string; description: string | null }> = []
      if (sourceIds.length > 0) {
        const { data: entityData } = await sb
          .from('knowledge_nodes')
          .select('id, label, entity_type, description')
          .eq('user_id', userId)
          .in('source_id', sourceIds)
          .limit(10)
        entities = (entityData ?? []) as typeof entities
      }

      return {
        agentId: agent.id,
        chunks: (chunks ?? []) as Array<{ chunk_id: string; source_id: string; content: string; similarity: number }>,
        entities,
      }
    })
  )

  // Build context packages per agent
  const contextPackages = new Map<string, string>()
  for (let i = 0; i < resolvedAgents.length; i++) {
    const result = ragResults[i]
    const agent = resolvedAgents[i]
    if (result.status === 'fulfilled') {
      const { chunks, entities } = result.value
      const chunkText = chunks.length > 0
        ? chunks.map((c, idx) => `[Source chunk ${idx + 1}] (similarity: ${c.similarity.toFixed(2)})\n${c.content}`).join('\n\n')
        : 'No relevant source chunks found for this agent.'
      const entityText = entities.length > 0
        ? entities.map(e => `- ${e.label} (${e.entity_type})${e.description ? ': ' + e.description : ''}`).join('\n')
        : 'No closely related entities found.'
      contextPackages.set(agent.id, `## Source Material\n\n${chunkText}\n\n## Related Entities\n\n${entityText}`)
    } else {
      contextPackages.set(agent.id, 'Retrieval failed for this agent — no source material available.')
    }
  }

  // ── Step 3: Agent Analysis (parallel across agents) ──
  // Build awareness register (one line per sibling agent)
  const awarenessLines = agents
    .map(a => `- ${a.name}: ${a.description ?? a.expertise_index?.summary ?? 'no description'}`)
    .join('\n')

  const analysisResults = await Promise.allSettled(
    resolvedAgents.map(async (agent) => {
      const ei = agent.expertise_index
      const systemPrompt = `You are the ${agent.name} advisor — a domain expert in ${agent.description ?? 'your domain'}.

Your reasoning style: ${agent.reasoning_style ?? ei?.reasoning_approach ?? 'analytical'}

Your expertise covers: ${ei?.summary ?? 'Not yet indexed'}
Your strongest areas: ${ei?.strongest_areas?.map(s => s.topic).join(', ') ?? 'Unknown'}
Your known gaps: ${ei?.weakest_areas?.map(w => w.topic).join(', ') ?? 'Unknown'}

You are part of an Advisory Council. Other advisors cover:
${awarenessLines}

Analyse the following question through your domain lens. Draw on the provided source material. Be specific — cite entities and sources. Be honest about where your coverage is strong and where it's thin.

If you notice connections to other advisors' domains, flag them explicitly — the orchestrator will use these to enrich the synthesis.

Respond with JSON matching this schema:
{
  "analysis": "string — 2-4 paragraphs",
  "key_claims": [{ "claim": "string", "evidence": "string", "confidence": "high" | "medium" | "low" }],
  "coverage_assessment": "strong" | "adequate" | "thin" | "gap",
  "coverage_note": "string",
  "cross_domain_flags": ["string"],
  "sources_cited": ["string"]
}`

      const context = contextPackages.get(agent.id) ?? 'No context available.'
      const userMessage = `Question: ${params.query}\n\n${context}`

      return {
        agentId: agent.id,
        agentName: agent.name,
        reasoningStyle: agent.reasoning_style ?? ei?.reasoning_approach ?? 'analytical',
        result: await geminiJson<AgentAnalysisResult>(systemPrompt, userMessage, 0.3, 30000),
      }
    })
  )

  // Collect successful analyses
  const perspectives: Array<{
    agent_name: string
    agent_id: string
    reasoning_style: string
    analysis: string
    key_claims: AgentAnalysisResult['key_claims']
    coverage_assessment: string
    coverage_note: string
    cross_domain_flags: string[]
    sources_cited: string[]
  }> = []
  const failedAgents: string[] = []

  for (const result of analysisResults) {
    if (result.status === 'fulfilled') {
      const { agentId, agentName, reasoningStyle, result: analysis } = result.value
      perspectives.push({
        agent_name: agentName,
        agent_id: agentId,
        reasoning_style: reasoningStyle,
        analysis: analysis.analysis,
        key_claims: analysis.key_claims,
        coverage_assessment: analysis.coverage_assessment,
        coverage_note: analysis.coverage_note,
        cross_domain_flags: analysis.cross_domain_flags ?? [],
        sources_cited: analysis.sources_cited ?? [],
      })
    } else {
      failedAgents.push(result.reason?.toString?.() ?? 'unknown error')
    }
  }

  if (perspectives.length === 0) {
    return {
      content: [{
        type: 'text',
        text: 'All agent analyses failed. Please retry, or use ask_synapse for a standard knowledge graph query.',
      }],
    }
  }

  // ── Step 4: Synthesis (cross-domain only) ──
  const routing = {
    classification: orchestratorResult.classification,
    agents_consulted: orchestratorResult.selected_agents.filter(
      sa => perspectives.some(p => p.agent_id === sa.agent_id || p.agent_name.toLowerCase() === sa.agent_name.toLowerCase())
    ),
    routing_rationale: orchestratorResult.routing_rationale,
  }

  // Single-domain: wrap the single agent's analysis as the synthesis
  if (perspectives.length === 1) {
    const p = perspectives[0]
    const response = {
      routing,
      agent_perspectives: includeReasoning ? perspectives : undefined,
      synthesis: {
        answer: p.analysis,
        agreements: [],
        tensions: [],
        emergent_insight: null,
        blind_spots: p.coverage_assessment === 'thin' || p.coverage_assessment === 'gap'
          ? [{ topic: p.coverage_note, relevant_gaps: [] }]
          : [],
        follow_up_suggestions: p.cross_domain_flags.length > 0
          ? [`Consider consulting other advisors on: ${p.cross_domain_flags.join(', ')}`]
          : [],
      },
    }
    if (failedAgents.length > 0) {
      (response.synthesis as Record<string, unknown>)._note = `${failedAgents.length} agent(s) failed and were excluded.`
    }
    return { content: [{ type: 'text', text: JSON.stringify(response, null, 2) }] }
  }

  // Multi-domain: synthesise across perspectives
  const synthesisSystem = `You are the orchestrator synthesising perspectives from multiple domain advisors.

The user asked: ${params.query}

The following advisors provided their analyses:

${perspectives.map(p => `### ${p.agent_name} (reasoning style: ${p.reasoning_style})\n${p.analysis}\n\nKey claims: ${p.key_claims.map(c => `- ${c.claim} [${c.confidence}]`).join('\n')}\nCoverage: ${p.coverage_assessment} — ${p.coverage_note}\nCross-domain flags: ${p.cross_domain_flags.join(', ') || 'none'}`).join('\n\n---\n\n')}

Synthesise these perspectives into a coherent response. Specifically:
1. Where do the advisors agree? What claims are corroborated across domains?
2. Where do they diverge? What tensions exist between their perspectives?
3. What emerges from the intersection that no single advisor would see alone?
4. What couldn't any advisor address? Map this to known gaps.
5. What follow-up questions would deepen the analysis?

Do NOT simply concatenate the advisors' views. Produce genuine synthesis — the value is in the intersection, not the union.

Respond with JSON matching this schema:
{
  "synthesis": "string — 3-5 paragraphs",
  "agreements": [{ "point": "string", "supporting_agents": ["agent names"] }],
  "tensions": [{ "point": "string", "agents_involved": ["agent names"], "nature": "string" }],
  "emergent_insight": "string or null",
  "blind_spots": [{ "topic": "string", "relevant_gaps": ["string"] }],
  "follow_up_suggestions": ["string"]
}`

  let synthesisResult: SynthesisResult
  try {
    synthesisResult = await geminiJson<SynthesisResult>(synthesisSystem, params.query, 0.3, 30000)
  } catch {
    // Synthesis failed — return individual perspectives without synthesis
    synthesisResult = {
      synthesis: perspectives.map(p => `**${p.agent_name}:** ${p.analysis}`).join('\n\n'),
      agreements: [],
      tensions: [],
      emergent_insight: null,
      blind_spots: [],
      follow_up_suggestions: ['Synthesis step failed — individual agent perspectives are shown above.'],
    }
  }

  const finalResponse = {
    routing,
    agent_perspectives: includeReasoning ? perspectives : undefined,
    synthesis: {
      answer: synthesisResult.synthesis,
      agreements: synthesisResult.agreements,
      tensions: synthesisResult.tensions,
      emergent_insight: synthesisResult.emergent_insight,
      blind_spots: synthesisResult.blind_spots,
      follow_up_suggestions: synthesisResult.follow_up_suggestions,
    },
  }

  if (failedAgents.length > 0) {
    (finalResponse.synthesis as Record<string, unknown>)._note = `${failedAgents.length} agent(s) failed and were excluded from synthesis.`
  }

  return { content: [{ type: 'text', text: JSON.stringify(finalResponse, null, 2) }] }
}

// ─── MCP Router ──────────────────────────────────────────────────────────────

function jsonRpcError(id: string | number | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } }
}

function jsonRpcResult(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result }
}

// ─── Query Logging (fire-and-forget) ────────────────────────────────────────

function logMcpQuery(
  userId: string,
  toolName: string,
  queryText: string,
  resultCount: number,
  topRelevance: number | null
): void {
  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
  sb.from('mcp_query_log')
    .insert({ user_id: userId, tool_name: toolName, query_text: queryText, result_count: resultCount, top_relevance: topRelevance })
    .then(() => {})
    .catch(err => console.warn('[mcp] Query log insert failed:', err))
}

function extractResultCount(text: string): { count: number; topRelevance: number | null } {
  // "Found N entities" or "N matching skills"
  const foundMatch = text.match(/Found (\d+) entities/)
  if (foundMatch) return { count: parseInt(foundMatch[1]!), topRelevance: null }

  const skillMatch = text.match(/(\d+) matching skills/)
  if (skillMatch) return { count: parseInt(skillMatch[1]!), topRelevance: null }

  // "No entities found" / "No sources found" / "No matching skills"
  if (text.includes('No entities found') || text.includes('No sources found') || text.includes('No matching skills')) {
    return { count: 0, topRelevance: null }
  }

  // For ask_synapse, check if answer contains "Sources:" section
  const sourceMatch = text.match(/\*\*Sources:\*\*\n([\s\S]*?)(?:\n\n|\*\*Entities)/);
  if (sourceMatch) {
    const lines = sourceMatch[1]!.split('\n').filter(l => l.trim().startsWith('-'))
    const relevanceMatch = sourceMatch[1]!.match(/relevance: (\d+)%/)
    return { count: lines.length, topRelevance: relevanceMatch ? parseInt(relevanceMatch[1]!) / 100 : null }
  }

  return { count: -1, topRelevance: null } // Unknown — don't log
}

async function handleMcpRequest(
  body: JsonRpcRequest,
  userId: string,
  sessionId: string | null
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
          case 'ask_synapse': {
            const askResult = await handleAskSynapse(
              {
                query: toolArgs.query as string,
                max_results: toolArgs.max_results as number | undefined,
                source_ids: toolArgs.source_ids as string[] | undefined,
                source_type: toolArgs.source_type as string | undefined,
              },
              userId,
              sb
            )
            const askText = (askResult.content?.[0] as { text?: string })?.text ?? ''
            const askStats = extractResultCount(askText)
            if (askStats.count >= 0) logMcpQuery(userId, 'ask_synapse', toolArgs.query as string, askStats.count, askStats.topRelevance)
            return jsonRpcResult(reqId, askResult)
          }

          case 'search_entities': {
            const entResult = await handleSearchEntities(
              {
                query: toolArgs.query as string,
                entity_type: toolArgs.entity_type as string | undefined,
                limit: toolArgs.limit as number | undefined,
                source_id: toolArgs.source_id as string | undefined,
              },
              userId,
              sb
            )
            const entText = (entResult.content?.[0] as { text?: string })?.text ?? ''
            const entStats = extractResultCount(entText)
            if (entStats.count >= 0) logMcpQuery(userId, 'search_entities', toolArgs.query as string, entStats.count, entStats.topRelevance)
            return jsonRpcResult(reqId, entResult)
          }

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
                  participant: toolArgs.participant as string | undefined,
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

          case 'search_sources': {
            const srcResult = await handleSearchSources(
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
            if (toolArgs.query) {
              const srcText = (srcResult.content?.[0] as { text?: string })?.text ?? ''
              const srcStats = extractResultCount(srcText)
              if (srcStats.count >= 0) logMcpQuery(userId, 'search_sources', toolArgs.query as string, srcStats.count, srcStats.topRelevance)
            }
            return jsonRpcResult(reqId, srcResult)
          }

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

          case 'get_meeting_notes':
            return jsonRpcResult(
              reqId,
              await handleGetMeetingNotes(
                {
                  query: toolArgs.query as string,
                  source_id: toolArgs.source_id as string | undefined,
                },
                userId,
                sb
              )
            )

          case 'get_meeting_transcript':
            return jsonRpcResult(
              reqId,
              await handleGetMeetingTranscript(
                {
                  query: toolArgs.query as string,
                  source_id: toolArgs.source_id as string | undefined,
                  max_length: toolArgs.max_length as number | undefined,
                },
                userId,
                sb
              )
            )

          // ── Skill library tools ──

          case 'get_skills':
            return jsonRpcResult(
              reqId,
              await handleGetSkills(
                {
                  domain: toolArgs.domain as string | undefined,
                  include_drafts: toolArgs.include_drafts as boolean | undefined,
                },
                userId,
                sb,
                sessionId
              )
            )

          case 'get_skill_content':
            return jsonRpcResult(
              reqId,
              await handleGetSkillContent(
                { name: toolArgs.name as string },
                userId,
                sb,
                sessionId
              )
            )

          case 'search_skills': {
            const skResult = await handleSearchSkills(
              {
                query: toolArgs.query as string,
                max_results: toolArgs.max_results as number | undefined,
              },
              userId,
              sb,
              sessionId
            )
            const skText = (skResult.content?.[0] as { text?: string })?.text ?? ''
            const skStats = extractResultCount(skText)
            if (skStats.count >= 0) logMcpQuery(userId, 'search_skills', toolArgs.query as string, skStats.count, skStats.topRelevance)
            return jsonRpcResult(reqId, skResult)
          }

          case 'consult_council':
            return jsonRpcResult(
              reqId,
              await handleConsultCouncil(
                {
                  query: toolArgs.query as string,
                  mode: toolArgs.mode as string | undefined,
                  agent_names: toolArgs.agent_names as string[] | undefined,
                  include_agent_reasoning: toolArgs.include_agent_reasoning as boolean | undefined,
                },
                userId,
                sb
              )
            )

          case 'send_to_synapse':
            return jsonRpcResult(
              reqId,
              await handleSendToSynapse(
                {
                  title: toolArgs.title as string,
                  content: toolArgs.content as string,
                  repo: toolArgs.repo as string | undefined,
                  branch: toolArgs.branch as string | undefined,
                  guidance: toolArgs.guidance as string | undefined,
                },
                userId
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
    // Extract session ID for usage logging (PRD-Skills-D)
    const sessionId = (req.headers['x-session-id'] as string)
      ?? (req.headers['x-request-id'] as string)
      ?? crypto.randomUUID()

    const body = req.body as JsonRpcRequest
    if (!body || body.jsonrpc !== '2.0' || !body.method) {
      return res.status(400).json(jsonRpcError(null, -32600, 'Invalid JSON-RPC request'))
    }

    const result = await handleMcpRequest(body, auth.userId, sessionId)
    return res.status(200).json(result)
  } catch {
    return res.status(500).json(jsonRpcError(null, -32603, 'Internal error'))
  }
}
