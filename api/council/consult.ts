/**
 * api/council/consult.ts
 *
 * Vercel serverless function for the Advisory Council consultation pipeline.
 * Called by the frontend Ask view in Council mode.
 *
 * CRITICAL: Fully self-contained. No local imports. All helpers defined inline.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

export const maxDuration = 60

// ─── Environment ─────────────────────────────────────────────────────────────

const SUPABASE_URL = process.env.SUPABASE_URL!
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY!
const GEMINI_API_KEY = process.env.GEMINI_API_KEY!
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models'

if (!GEMINI_API_KEY) {
  throw new Error('[gemini] Missing env var: GEMINI_API_KEY')
}

const GEMINI_MODEL = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash'
const GEMINI_EMBEDDING_MODEL = 'gemini-embedding-001'
// ─── Types ───────────────────────────────────────────────────────────────────

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

// ─── Helpers ─────────────────────────────────────────────────────────────────

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !SUPABASE_ANON_KEY) {
  throw new Error('[supabase] Missing env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY')
}


// ─── Structured logging ─────────────────────────────────────────────────────

type LogStatus = 'ok' | 'failed' | 'partial' | 'skipped'

interface LogFields {
  stage: string
  user_id?: string
  source_id?: string
  duration_ms?: number
  status?: LogStatus
  error?: string
  [k: string]: unknown
}

function log(fields: LogFields): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...fields }))
}

function logError(fields: LogFields & { error: string }): void {
  console.error(JSON.stringify({ ts: new Date().toISOString(), level: 'error', ...fields }))
}

function getServiceSupabase(): SupabaseClient {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
}

function getAnonSupabase(): SupabaseClient {
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
}

// ─── Gemini fetch + helpers (retry on 429/5xx, token-usage logging) ─────────

interface GeminiUsage {
  promptTokenCount?: number
  candidatesTokenCount?: number
  totalTokenCount?: number
}

async function geminiFetch(
  endpoint: string,
  body: unknown,
  timeoutMs: number,
  stage: string
): Promise<{ json: unknown; usage: GeminiUsage | undefined }> {
  const url = `${GEMINI_BASE}/${endpoint}?key=${GEMINI_API_KEY}`
  const maxAttempts = 3
  let lastErr: Error | null = null
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify(body),
      })
      if (resp.ok) {
        const json = await resp.json() as { usageMetadata?: GeminiUsage }
        const usage = json.usageMetadata
        if (usage) {
          console.log(JSON.stringify({
            stage, model: endpoint.split(':')[0],
            prompt_tokens: usage.promptTokenCount,
            output_tokens: usage.candidatesTokenCount,
            total_tokens: usage.totalTokenCount,
          }))
        }
        return { json, usage }
      }
      const txt = await resp.text().catch(() => '')
      lastErr = new Error(`Gemini ${resp.status}: ${txt.slice(0, 200)}`)
      if ((resp.status === 429 || resp.status >= 500) && attempt < maxAttempts - 1) {
        await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 1000))
        continue
      }
      throw lastErr
    } catch (err) {
      lastErr = err as Error
      if (attempt < maxAttempts - 1) {
        await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 1000))
        continue
      }
      throw lastErr
    } finally {
      clearTimeout(timer)
    }
  }
  throw lastErr ?? new Error('[gemini] request failed')
}

async function embedText(text: string, timeoutMs = 30000, stage = 'council:consult:embed'): Promise<number[]> {
  const { json } = await geminiFetch(
    `${GEMINI_EMBEDDING_MODEL}:embedContent`,
    { model: `models/${GEMINI_EMBEDDING_MODEL}`, content: { parts: [{ text }] } },
    timeoutMs,
    stage
  )
  const data = json as { embedding?: { values?: number[] } }
  if (!data.embedding?.values) throw new Error('No embedding in Gemini response')
  return data.embedding.values
}

async function geminiJson<T>(
  systemPrompt: string,
  userContent: string,
  temperature: number = 0.2,
  timeoutMs: number = 30000,
  stage: string = 'council:consult'
): Promise<T> {
  const { json } = await geminiFetch(
    `${GEMINI_MODEL}:generateContent`,
    {
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents: [{ parts: [{ text: userContent }] }],
      generationConfig: {
        temperature,
        responseMimeType: 'application/json',
      },
    },
    timeoutMs,
    stage
  )
  const data = json as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> }
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text
  if (!text) throw new Error('No response from Gemini')
  return JSON.parse(text) as T
}

async function authenticateUser(req: VercelRequest, sb: SupabaseClient): Promise<string | null> {
  const authHeader = req.headers.authorization
  if (!authHeader?.startsWith('Bearer ')) return null
  const token = authHeader.slice(7)
  try {
    const { data: { user } } = await sb.auth.admin.getUserById(token)
    return user?.id ?? null
  } catch {
    // Try as access token
    const anonSb = getAnonSupabase()
    try {
      const { data: { user } } = await anonSb.auth.getUser(token)
      return user?.id ?? null
    } catch {
      return null
    }
  }
}

// ─── Main Handler ────────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'OPTIONS') {
    return res.status(200).end()
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const sb = getServiceSupabase()

  // Auth: accept Supabase access token
  const authHeader = req.headers.authorization
  let userId: string | null = null
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7)
    const anonSb = getAnonSupabase()
    try {
      const { data: { user } } = await anonSb.auth.getUser(token)
      userId = user?.id ?? null
    } catch { /* fall through */ }
  }

  if (!userId) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const { query, mode = 'auto', agent_names, include_agent_reasoning = true } = req.body as {
    query: string
    mode?: string
    agent_names?: string[]
    include_agent_reasoning?: boolean
  }

  if (!query?.trim()) {
    return res.status(400).json({ error: 'Missing query' })
  }

  try {
    // ── Fetch all agents for this user ──
    const { data: allAgents, error: agentsErr } = await sb
      .from('domain_agents')
      .select('id, user_id, name, description, reasoning_style, expertise_index, source_count, entity_count')
      .eq('user_id', userId)
      .eq('is_active', true)

    if (agentsErr || !allAgents || allAgents.length === 0) {
      return res.status(200).json({
        error: 'no_agents',
        message: 'No advisory council agents found. Ingest YouTube playlists first.',
      })
    }

    const agents = allAgents as CouncilAgent[]

    // Build master index summary
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

    const agentNameConstraint = agent_names?.length
      ? `\n\nThe user has explicitly requested these advisors: ${agent_names.join(', ')}. Respect this selection.`
      : ''

    // Send routing immediately, then continue pipeline
    const orchestratorResult = await geminiJson<OrchestratorResult>(
      orchestratorSystem,
      `Query: ${query}${agentNameConstraint}`,
      0.2,
      15000
    )

    // ── Meta classification: orchestrator answers directly ──
    if (orchestratorResult.classification === 'meta' && orchestratorResult.meta_answer) {
      return res.status(200).json({
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
      })
    }

    // Resolve selected agents
    const selectedAgentIds = new Set(orchestratorResult.selected_agents.map(a => a.agent_id))
    const selectedByName = new Set(orchestratorResult.selected_agents.map(a => a.agent_name.toLowerCase()))
    const resolvedAgents = agents.filter(
      a => selectedAgentIds.has(a.id) || selectedByName.has(a.name.toLowerCase())
    )

    if (resolvedAgents.length === 0) {
      resolvedAgents.push(agents[0])
    }

    // ── Step 2: Domain-Scoped RAG (parallel across agents) ──
    const queryEmbedding = await embedText(query)

    const ragResults = await Promise.allSettled(
      resolvedAgents.map(async (agent) => {
        const { data: chunks } = await sb.rpc('get_domain_scoped_chunks', {
          p_agent_id: agent.id,
          p_query_embedding: JSON.stringify(queryEmbedding),
          p_match_threshold: 0.5,
          p_match_count: 8,
        })

        const { data: agentSources } = await sb
          .from('domain_agent_sources')
          .select('source_id')
          .eq('agent_id', agent.id)

        const sourceIds = (agentSources ?? []).map((s: { source_id: string }) => s.source_id)

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

    // Build context packages
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
        const userMessage = `Question: ${query}\n\n${context}`

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
      return res.status(200).json({
        error: 'all_agents_failed',
        message: 'All agent analyses failed. Please retry.',
        routing: {
          classification: orchestratorResult.classification,
          agents_consulted: orchestratorResult.selected_agents,
          routing_rationale: orchestratorResult.routing_rationale,
        },
      })
    }

    // ── Step 4: Synthesis ──
    const routing = {
      classification: orchestratorResult.classification,
      agents_consulted: orchestratorResult.selected_agents.filter(
        sa => perspectives.some(p => p.agent_id === sa.agent_id || p.agent_name.toLowerCase() === sa.agent_name.toLowerCase())
      ),
      routing_rationale: orchestratorResult.routing_rationale,
    }

    // Single-domain: wrap single agent's analysis
    if (perspectives.length === 1) {
      const p = perspectives[0]
      return res.status(200).json({
        routing,
        agent_perspectives: include_agent_reasoning ? perspectives : undefined,
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
      })
    }

    // Multi-domain: synthesise
    const synthesisSystem = `You are the orchestrator synthesising perspectives from multiple domain advisors.

The user asked: ${query}

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
      synthesisResult = await geminiJson<SynthesisResult>(synthesisSystem, query, 0.3, 30000)
    } catch {
      synthesisResult = {
        synthesis: perspectives.map(p => `**${p.agent_name}:** ${p.analysis}`).join('\n\n'),
        agreements: [],
        tensions: [],
        emergent_insight: null,
        blind_spots: [],
        follow_up_suggestions: ['Synthesis step failed — individual agent perspectives are shown above.'],
      }
    }

    return res.status(200).json({
      routing,
      agent_perspectives: include_agent_reasoning ? perspectives : undefined,
      synthesis: {
        answer: synthesisResult.synthesis,
        agreements: synthesisResult.agreements,
        tensions: synthesisResult.tensions,
        emergent_insight: synthesisResult.emergent_insight,
        blind_spots: synthesisResult.blind_spots,
        follow_up_suggestions: synthesisResult.follow_up_suggestions,
      },
    })

  } catch (err) {
    logError({ stage: 'council:consult', error: err instanceof Error ? err.message : String(err), status: 'failed' })
    return res.status(500).json({
      error: 'pipeline_failed',
      message: err instanceof Error ? err.message : 'Unknown error',
    })
  }
}
