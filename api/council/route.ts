/**
 * api/council/route.ts
 *
 * Step 1 of the council pipeline: Orchestrator classification.
 * Decides which agents to consult and returns the routing decision.
 * The user can then approve, modify, or skip before calling /analyse.
 *
 * CRITICAL: Fully self-contained. No local imports.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createClient } from '@supabase/supabase-js'

export const maxDuration = 30

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

// ─── Gemini JSON helper ──────────────────────────────────────────────────────

async function geminiJson<T>(
  systemPrompt: string,
  userContent: string,
  temperature = 0.2,
  timeoutMs = 20000
): Promise<T> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const resp = await fetch(
      `${GEMINI_BASE}/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          system_instruction: { parts: [{ text: systemPrompt }] },
          contents: [{ parts: [{ text: userContent }] }],
          generationConfig: { temperature, responseMimeType: 'application/json' },
        }),
      }
    )
    if (!resp.ok) throw new Error(`Gemini ${resp.status}`)
    const data = await resp.json() as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
    }
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text
    if (!text) throw new Error('No response from Gemini')
    return JSON.parse(text) as T
  } finally { clearTimeout(timeout) }
}

// ─── Handler ─────────────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const userId = await getUser(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })

  const { query, mode = 'auto', agent_names } = req.body as {
    query: string; mode?: string; agent_names?: string[]
  }
  if (!query?.trim()) return res.status(400).json({ error: 'Missing query' })

  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

  try {
    // Fetch all agents
    const { data: allAgents, error: agentsErr } = await sb
      .from('domain_agents')
      .select('id, name, description, reasoning_style, expertise_index, source_count, entity_count')
      .eq('user_id', userId)
      .eq('is_active', true)
      .order('source_count', { ascending: false })

    if (agentsErr || !allAgents || allAgents.length === 0) {
      return res.status(200).json({
        error: 'no_agents',
        message: 'No advisory council agents found. Ingest YouTube playlists first.',
      })
    }

    // Build master index
    const masterIndex = allAgents.map((a: { id: string; name: string; description: string | null; expertise_index: Record<string, unknown> | null; source_count: number; entity_count: number }) => {
      const ei = a.expertise_index as {
        summary?: string; core_themes?: string[]; reasoning_approach?: string
        strongest_areas?: Array<{ topic: string }>; weakest_areas?: Array<{ topic: string }>
      } | null
      return [
        `## ${a.name} (ID: ${a.id})`,
        a.description ? `Description: ${a.description}` : '',
        ei?.summary ? `Summary: ${ei.summary}` : '',
        ei?.core_themes?.length ? `Core themes: ${ei.core_themes.join(', ')}` : '',
        ei?.reasoning_approach ? `Reasoning approach: ${ei.reasoning_approach}` : '',
        ei?.strongest_areas?.length ? `Strongest areas: ${ei.strongest_areas.map(s => s.topic).join(', ')}` : '',
        ei?.weakest_areas?.length ? `Weakest areas: ${ei.weakest_areas.map(w => w.topic).join(', ')}` : '',
        `Sources: ${a.source_count}, Entities: ${a.entity_count}`,
      ].filter(Boolean).join('\n')
    }).join('\n\n')

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

    const constraint = agent_names?.length
      ? `\n\nThe user has explicitly requested these advisors: ${agent_names.join(', ')}. Respect this selection.`
      : ''

    const result = await geminiJson<{
      classification: string
      selected_agents: Array<{ agent_id: string; agent_name: string; relevance: string; reason: string }>
      routing_rationale: string
      meta_answer: string | null
    }>(orchestratorSystem, `Query: ${query}${constraint}`, 0.2, 20000)

    // Return routing + all available agents so the frontend can show an add-more dropdown
    return res.status(200).json({
      routing: {
        classification: result.classification,
        agents_consulted: result.selected_agents,
        routing_rationale: result.routing_rationale,
      },
      meta_answer: result.meta_answer,
      available_agents: allAgents.map((a: { id: string; name: string; description: string | null; source_count: number }) => ({
        id: a.id,
        name: a.name,
        description: a.description,
        source_count: a.source_count,
      })),
    })
  } catch (err) {
    console.error('Council route error:', err)
    return res.status(500).json({
      error: 'routing_failed',
      message: err instanceof Error ? err.message : 'Unknown error',
    })
  }
}
