/**
 * api/mcp.ts
 *
 * Synapse MCP Server — Vercel serverless function implementing MCP Streamable HTTP transport.
 * Exposes 15 tools: 12 knowledge graph tools + 3 skill library tools (PRD-Skills-C).
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
]

// ─── Tool handlers ───────────────────────────────────────────────────────────

async function handleAskSynapse(
  params: { query: string; max_results?: number; source_ids?: string[]; source_type?: string },
  userId: string,
  sb: SupabaseClient
): Promise<ToolContent> {
  const maxResults = Math.min(params.max_results ?? 8, 20)
  // Lower threshold when source_ids is provided — explicit source scoping is a strong intent signal
  const isSourceScoped = (params.source_ids && params.source_ids.length > 0) || !!params.source_type
  const matchThreshold = isSourceScoped ? 0.1 : 0.3

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
    match_threshold: matchThreshold,
    match_count: isSourceScoped ? maxResults * 3 : maxResults, // fetch more if we'll filter
    p_user_id: userId,
  })

  let chunks: ChunkResult[] = (semanticChunks ?? []) as ChunkResult[]

  // Apply source scoping filters
  if (params.source_ids && params.source_ids.length > 0) {
    const scopeSet = new Set(params.source_ids)
    chunks = chunks.filter(c => scopeSet.has(c.source_id))

    // Fall back to raw chunk retrieval if semantic search returned nothing for these sources
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

  // 8. Format response — include source_ids for follow-up tool calls
  const sources = topChunks
    .map(c => {
      const src = sourceMap.get(c.source_id)
      return src
        ? { source_id: c.source_id, title: src.title, source_type: src.source_type, relevance: Math.round(c.score * 100) / 100 }
        : null
    })
    .filter(Boolean)
    // Deduplicate by source_id
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

// ─── Skill library handlers (PRD-Skills-C) ──────────────────────────────────

async function handleGetSkills(
  params: { domain?: string; include_drafts?: boolean },
  userId: string,
  sb: SupabaseClient
): Promise<ToolContent> {
  const includeDrafts = params.include_drafts === true
  const statuses = includeDrafts ? ['active', 'draft'] : ['active']

  let query = sb
    .from('knowledge_skills')
    .select('name, title, description, domain, tags, confidence, source_count, status, updated_at')
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
    name: string; title: string; description: string; domain: string | null
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

  return { content: [{ type: 'text', text: lines.join('\n') }] }
}

async function handleGetSkillContent(
  params: { name: string },
  userId: string,
  sb: SupabaseClient
): Promise<ToolContent> {
  const { data, error } = await sb
    .from('knowledge_skills')
    .select('name, title, description, domain, tags, content, confidence, instructional_ratio, generalizability, structural_density, source_ids, source_count, status, created_at, updated_at')
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

  return { content: [{ type: 'text', text: header }] }
}

async function handleSearchSkills(
  params: { query: string; max_results?: number },
  userId: string,
  sb: SupabaseClient
): Promise<ToolContent> {
  const maxResults = Math.min(Math.max(params.max_results ?? 5, 1), 10)

  // Try semantic search via direct query (not RPC — match_skills uses auth.uid()
  // which returns null with the service-role client used by MCP)
  let usedSemantic = false
  let results: Array<{
    name: string; title: string; description: string; domain: string | null
    tags: string[]; confidence: number; source_count: number; status: string
    similarity: number
  }> = []

  try {
    const embedding = await embedText(params.query)

    // Use raw SQL via rpc to do cosine similarity with the user_id filter
    const { data, error } = await sb.rpc('match_skills_for_user', {
      query_embedding: JSON.stringify(embedding),
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
      .select('name, title, description, domain, tags, confidence, source_count, status')
      .eq('user_id', userId)
      .eq('status', 'active')
      .or(`title.ilike.${pattern},description.ilike.${pattern}`)
      .order('confidence', { ascending: false })
      .limit(maxResults)

    if (textData && textData.length > 0) {
      results = (textData as Array<{
        name: string; title: string; description: string; domain: string | null
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

  return { content: [{ type: 'text', text: lines.join('\n') }] }
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
                sb
              )
            )

          case 'get_skill_content':
            return jsonRpcResult(
              reqId,
              await handleGetSkillContent(
                { name: toolArgs.name as string },
                userId,
                sb
              )
            )

          case 'search_skills':
            return jsonRpcResult(
              reqId,
              await handleSearchSkills(
                {
                  query: toolArgs.query as string,
                  max_results: toolArgs.max_results as number | undefined,
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
