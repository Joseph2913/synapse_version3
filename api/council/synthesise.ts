/**
 * api/council/synthesise.ts
 *
 * Step 3 of the council pipeline: Cross-perspective synthesis.
 * Accepts agent perspectives from Step 2, produces unified synthesis.
 *
 * CRITICAL: Fully self-contained. No local imports.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createClient } from '@supabase/supabase-js'

export const maxDuration = 30

const SUPABASE_URL = process.env.SUPABASE_URL!
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY!
const GEMINI_API_KEY = process.env.GEMINI_API_KEY!
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models'

if (!GEMINI_API_KEY) {
  throw new Error('[gemini] Missing env var: GEMINI_API_KEY')
}

const GEMINI_MODEL = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash'
const GEMINI_EMBEDDING_MODEL = 'gemini-embedding-001'
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  throw new Error('[supabase] Missing env vars: SUPABASE_URL, SUPABASE_ANON_KEY')
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

function getAnonSupabase() {
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

async function geminiJson<T>(
  systemPrompt: string,
  userContent: string,
  temperature = 0.3,
  timeoutMs = 30000,
  stage = 'council:synthesise'
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

interface Perspective {
  agent_name: string
  reasoning_style: string
  analysis: string
  key_claims: Array<{ claim: string; confidence: string }>
  coverage_assessment: string
  coverage_note: string
  cross_domain_flags: string[]
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const userId = await getUser(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })

  const { query, perspectives } = req.body as {
    query: string
    perspectives: Perspective[]
  }
  if (!query?.trim()) return res.status(400).json({ error: 'Missing query' })
  if (!perspectives?.length) return res.status(400).json({ error: 'Missing perspectives' })

  // Single agent — no synthesis needed, wrap the analysis
  if (perspectives.length === 1) {
    const p = perspectives[0]!
    return res.status(200).json({
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

  try {
    const perspectiveText = perspectives.map(p =>
      `### ${p.agent_name} (${p.reasoning_style})\n${p.analysis}\n\nKey claims: ${p.key_claims.map(c => `- ${c.claim} [${c.confidence}]`).join('\n')}\nCoverage: ${p.coverage_assessment} — ${p.coverage_note}\nCross-domain flags: ${p.cross_domain_flags.join(', ') || 'none'}`
    ).join('\n\n---\n\n')

    const systemPrompt = `You are the orchestrator synthesising perspectives from multiple domain advisors.

The user asked: ${query}

The following advisors provided their analyses:

${perspectiveText}

Synthesise these perspectives into a coherent response. Specifically:
1. Where do the advisors agree? What claims are corroborated across domains?
2. Where do they diverge? What tensions exist between their perspectives?
3. What emerges from the intersection that no single advisor would see alone?
4. What couldn't any advisor address? Map this to known gaps.
5. What follow-up questions would deepen the analysis?

Do NOT simply concatenate the advisors' views. Produce genuine synthesis — the value is in the intersection, not the union.

Respond with JSON:
{
  "synthesis": "string — 3-5 paragraphs",
  "agreements": [{ "point": "string", "supporting_agents": ["agent names"] }],
  "tensions": [{ "point": "string", "agents_involved": ["agent names"], "nature": "string" }],
  "emergent_insight": "string or null",
  "blind_spots": [{ "topic": "string", "relevant_gaps": ["string"] }],
  "follow_up_suggestions": ["string"]
}`

    const result = await geminiJson<{
      synthesis: string
      agreements: Array<{ point: string; supporting_agents: string[] }>
      tensions: Array<{ point: string; agents_involved: string[]; nature: string }>
      emergent_insight: string | null
      blind_spots: Array<{ topic: string; relevant_gaps: string[] }>
      follow_up_suggestions: string[]
    }>(systemPrompt, query, 0.3, 30000)

    return res.status(200).json({
      synthesis: {
        answer: result.synthesis,
        agreements: result.agreements,
        tensions: result.tensions,
        emergent_insight: result.emergent_insight,
        blind_spots: result.blind_spots,
        follow_up_suggestions: result.follow_up_suggestions,
      },
    })
  } catch (err) {
    console.error('Council synthesise error:', err)
    return res.status(500).json({
      error: 'synthesis_failed',
      message: err instanceof Error ? err.message : 'Unknown error',
    })
  }
}
