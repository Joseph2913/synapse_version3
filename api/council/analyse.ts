/**
 * api/council/analyse.ts
 *
 * Step 2 of the council pipeline: Domain-scoped RAG + Agent analysis.
 * Accepts the approved agent IDs from Step 1, runs retrieval and analysis
 * in parallel across selected agents, returns perspectives.
 *
 * CRITICAL: Fully self-contained. No local imports.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

export const maxDuration = 60

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

async function getUser(req: VercelRequest): Promise<string | null> {
  const auth = req.headers.authorization
  if (!auth?.startsWith('Bearer ')) return null
  const token = auth.slice(7)
  try {
    const { data: { user } } = await getAnonSupabase().auth.getUser(token)
    return user?.id ?? null
  } catch { return null }
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

async function embedText(text: string, timeoutMs = 30000, stage = 'council:analyse:embed'): Promise<number[]> {
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
  temperature = 0.3,
  timeoutMs = 30000,
  stage = 'council:analyse'
): Promise<T> {
  const { json } = await geminiFetch(
    `${GEMINI_MODEL}:generateContent`,
    {
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents: [{ parts: [{ text: userContent }] }],
      generationConfig: { temperature, responseMimeType: 'application/json' },
    },
    timeoutMs,
    stage
  )
  const data = json as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> }
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text
  if (!text) throw new Error('No response from Gemini')
  return JSON.parse(text) as T
}

interface AgentAnalysis {
  analysis: string
  key_claims: Array<{ claim: string; evidence: string; confidence: 'high' | 'medium' | 'low' }>
  coverage_assessment: 'strong' | 'adequate' | 'thin' | 'gap'
  coverage_note: string
  cross_domain_flags: string[]
  sources_cited: string[]
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const userId = await getUser(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })

  const { query, agent_ids } = req.body as {
    query: string
    agent_ids: string[]
  }
  if (!query?.trim()) return res.status(400).json({ error: 'Missing query' })
  if (!agent_ids?.length) return res.status(400).json({ error: 'Missing agent_ids' })

  const sb = getServiceSupabase()

  try {
    // Fetch selected agents
    const { data: agents, error: agErr } = await sb
      .from('domain_agents')
      .select('id, name, description, reasoning_style, expertise_index, source_count, entity_count')
      .eq('user_id', userId)
      .in('id', agent_ids)

    if (agErr || !agents || agents.length === 0) {
      return res.status(400).json({ error: 'No valid agents found' })
    }

    // Fetch all agents for awareness register
    const { data: allAgents } = await sb
      .from('domain_agents')
      .select('name, description, expertise_index')
      .eq('user_id', userId)
      .eq('is_active', true)

    const awarenessLines = (allAgents ?? []).map((a: { name: string; description: string | null; expertise_index: Record<string, unknown> | null }) => {
      const ei = a.expertise_index as { summary?: string } | null
      return `- ${a.name}: ${a.description ?? ei?.summary ?? 'no description'}`
    }).join('\n')

    // Embed query once
    const queryEmbedding = await embedText(query)

    // Run RAG + analysis in parallel across agents
    const results = await Promise.allSettled(
      agents.map(async (agent: {
        id: string; name: string; description: string | null
        reasoning_style: string | null
        expertise_index: Record<string, unknown> | null
      }) => {
        const ei = agent.expertise_index as {
          summary?: string; reasoning_approach?: string
          strongest_areas?: Array<{ topic: string }>
          weakest_areas?: Array<{ topic: string }>
        } | null

        // RAG: domain-scoped chunks
        const { data: chunks } = await sb.rpc('get_domain_scoped_chunks', {
          p_agent_id: agent.id,
          p_query_embedding: JSON.stringify(queryEmbedding),
          p_match_threshold: 0.5,
          p_match_count: 8,
        })

        // RAG: entities from agent's sources
        const { data: agentSources } = await sb
          .from('domain_agent_sources')
          .select('source_id')
          .eq('agent_id', agent.id)
        const sourceIds = (agentSources ?? []).map((s: { source_id: string }) => s.source_id)

        let entities: Array<{ label: string; entity_type: string; description: string | null }> = []
        if (sourceIds.length > 0) {
          const { data: entityData } = await sb
            .from('knowledge_nodes')
            .select('label, entity_type, description')
            .eq('user_id', userId)
            .in('source_id', sourceIds)
            .limit(10)
          entities = (entityData ?? []) as typeof entities
        }

        // Build context package
        const chunkArr = (chunks ?? []) as Array<{ content: string; similarity: number }>
        const chunkText = chunkArr.length > 0
          ? chunkArr.map((c, i) => `[Source ${i + 1}] (${c.similarity.toFixed(2)})\n${c.content}`).join('\n\n')
          : 'No relevant source chunks found.'
        const entityText = entities.length > 0
          ? entities.map(e => `- ${e.label} (${e.entity_type})${e.description ? ': ' + e.description : ''}`).join('\n')
          : 'No closely related entities found.'

        // Agent analysis call
        const systemPrompt = `You are the ${agent.name} advisor — a domain expert in ${agent.description ?? 'your domain'}.

Your reasoning style: ${agent.reasoning_style ?? ei?.reasoning_approach ?? 'analytical'}

Your expertise covers: ${ei?.summary ?? 'Not yet indexed'}
Your strongest areas: ${ei?.strongest_areas?.map(s => s.topic).join(', ') ?? 'Unknown'}
Your known gaps: ${ei?.weakest_areas?.map(w => w.topic).join(', ') ?? 'Unknown'}

You are part of an Advisory Council. Other advisors cover:
${awarenessLines}

Analyse the following question through your domain lens. Draw on the provided source material. Be specific — cite entities and sources. Be honest about where your coverage is strong and where it's thin.

If you notice connections to other advisors' domains, flag them explicitly.

Respond with JSON:
{
  "analysis": "string — 2-4 paragraphs",
  "key_claims": [{ "claim": "string", "evidence": "string", "confidence": "high" | "medium" | "low" }],
  "coverage_assessment": "strong" | "adequate" | "thin" | "gap",
  "coverage_note": "string",
  "cross_domain_flags": ["string"],
  "sources_cited": ["string"]
}`

        const analysis = await geminiJson<AgentAnalysis>(
          systemPrompt,
          `Question: ${query}\n\n## Source Material\n\n${chunkText}\n\n## Related Entities\n\n${entityText}`,
          0.3,
          30000
        )

        return {
          agent_name: agent.name,
          agent_id: agent.id,
          reasoning_style: agent.reasoning_style ?? ei?.reasoning_approach ?? 'analytical',
          ...analysis,
        }
      })
    )

    // Collect results
    const perspectives: Array<{
      agent_name: string; agent_id: string; reasoning_style: string
      analysis: string
      key_claims: AgentAnalysis['key_claims']
      coverage_assessment: string; coverage_note: string
      cross_domain_flags: string[]; sources_cited: string[]
    }> = []
    const errors: string[] = []

    for (const r of results) {
      if (r.status === 'fulfilled') {
        perspectives.push(r.value)
      } else {
        errors.push(String(r.reason))
      }
    }

    return res.status(200).json({
      agent_perspectives: perspectives,
      errors: errors.length > 0 ? errors : undefined,
    })
  } catch (err) {
    console.error('Council analyse error:', err)
    return res.status(500).json({
      error: 'analysis_failed',
      message: err instanceof Error ? err.message : 'Unknown error',
    })
  }
}
