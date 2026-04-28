import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL!
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY!
const GEMINI_API_KEY = process.env.GEMINI_API_KEY!
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models'
const GEMINI_MODEL = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash'

if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !GEMINI_API_KEY) {
  throw new Error('[gemini/simulate] Missing required env vars')
}

function getAnonSupabase(): SupabaseClient {
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
}

async function getUserIdFromRequest(req: VercelRequest): Promise<string | null> {
  const auth = req.headers.authorization
  if (!auth?.startsWith('Bearer ')) return null
  const token = auth.slice(7)
  try {
    const { data: { user } } = await getAnonSupabase().auth.getUser(token)
    return user?.id ?? null
  } catch {
    return null
  }
}

interface GeminiUsage {
  promptTokenCount?: number
  candidatesTokenCount?: number
  totalTokenCount?: number
}

async function geminiFetch(endpoint: string, body: unknown, timeoutMs: number) {
  const url = `${GEMINI_BASE}/${endpoint}?key=${GEMINI_API_KEY}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify(body),
    })
    if (!resp.ok) {
      const txt = await resp.text().catch(() => '')
      throw new Error(`Gemini ${resp.status}: ${txt.slice(0, 200)}`)
    }
    const json = await resp.json() as { usageMetadata?: GeminiUsage }
    return { json, usage: json.usageMetadata }
  } finally {
    clearTimeout(timer)
  }
}

interface EvidenceBody {
  kind: 'evidence'
  entityLabel: string
  entityType: string
  question: string
  sourceMaterial: string
}

interface SynthesisBody {
  kind: 'synthesis'
  entityLabel: string
  entityType: string
  influenceTier: string
  documentedPosition: string
  relationships: string[]
  question: string
  whatIfVariables: string[]
  modeDirective: string
  sensitivityDirective: string
}

type SimulateBody = EvidenceBody | SynthesisBody

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every(s => typeof s === 'string')
}

function isSimulateBody(b: unknown): b is SimulateBody {
  if (!b || typeof b !== 'object') return false
  const o = b as Record<string, unknown>
  if (o.kind === 'evidence') {
    return typeof o.entityLabel === 'string'
      && typeof o.entityType === 'string'
      && typeof o.question === 'string'
      && typeof o.sourceMaterial === 'string'
      && o.sourceMaterial.length <= 12000
  }
  if (o.kind === 'synthesis') {
    return typeof o.entityLabel === 'string'
      && typeof o.entityType === 'string'
      && typeof o.influenceTier === 'string'
      && typeof o.documentedPosition === 'string'
      && isStringArray(o.relationships)
      && typeof o.question === 'string'
      && isStringArray(o.whatIfVariables)
      && typeof o.modeDirective === 'string'
      && typeof o.sensitivityDirective === 'string'
  }
  return false
}

function buildEvidencePrompt(b: EvidenceBody): string {
  return `You are extracting evidence about a specific entity from source documents.

Entity: ${b.entityLabel} (${b.entityType})
Question being investigated: ${b.question}

Source material:
${b.sourceMaterial}

Return JSON only — no preamble, no markdown:
{
  "documented_position": "One sentence: what do these sources say this entity has said or done relevant to the question? If nothing relevant, state that explicitly.",
  "stance_category": "pro | anti | conditional | uncertain | orthogonal",
  "topic_proximity": 0.0,
  "source_count": 0,
  "grounding_quality": "strong | moderate | weak | inferred"
}

grounding_quality rules:
- strong: 3+ sources with direct relevance
- moderate: 1–2 directly relevant sources
- weak: sources exist but are tangential
- inferred: no relevant sources — derive from entity type and relationships only`
}

function buildSynthesisPrompt(b: SynthesisBody): string {
  return `You are building a simulation agent profile for a multi-agent deliberation.

Entity: ${b.entityLabel} (${b.entityType})
Influence tier: ${b.influenceTier}
Documented position: ${b.documentedPosition}
Relationships to other agents: ${b.relationships.join(', ') || 'None identified'}
Question: ${b.question}
What-if conditions: ${b.whatIfVariables.join('; ') || 'None'}

${b.modeDirective}
${b.sensitivityDirective}

Return JSON only — no preamble, no markdown:
{
  "question_specific_stance": "Their specific position on the question. One sentence. Evidence-grounded.",
  "incentive_structure": "What they gain or lose from each possible outcome. One sentence.",
  "epistemic_style": "empirical | ideological | opportunistic | contrarian | cautious | structural",
  "update_conditions": "What specific evidence or argument would cause them to revise their position. One sentence.",
  "blind_spots": "What they are systematically unlikely to see or acknowledge. One sentence.",
  "behavioural_prompt": "3–4 sentence system prompt governing this agent's behaviour in the simulation. Written in second person. Incorporates all of the above."
}`
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' })

  const userId = await getUserIdFromRequest(req)
  if (!userId) return res.status(401).json({ error: 'unauthenticated' })

  if (!isSimulateBody(req.body)) {
    return res.status(400).json({ error: 'invalid_request', detail: 'Expected { kind: "evidence" | "synthesis", ... }' })
  }

  const body = req.body
  const prompt = body.kind === 'evidence' ? buildEvidencePrompt(body) : buildSynthesisPrompt(body)
  const temperature = body.kind === 'evidence' ? 0.1 : 0.3

  const startedAt = Date.now()
  try {
    const { json, usage } = await geminiFetch(
      `${GEMINI_MODEL}:generateContent`,
      {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature, maxOutputTokens: 1024 },
      },
      30_000,
    )
    const data = json as { candidates?: { content?: { parts?: { text?: string }[] } }[] }
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? ''

    console.log(JSON.stringify({
      stage: `gemini:simulate:${body.kind}`,
      user_id: userId,
      duration_ms: Date.now() - startedAt,
      status: 'ok',
      prompt_tokens: usage?.promptTokenCount,
      output_tokens: usage?.candidatesTokenCount,
    }))

    return res.status(200).json({ text })
  } catch (err) {
    console.log(JSON.stringify({
      stage: `gemini:simulate:${body.kind}`,
      user_id: userId,
      duration_ms: Date.now() - startedAt,
      status: 'error',
      error: (err as Error).message,
    }))
    return res.status(502).json({ error: 'vendor', detail: (err as Error).message })
  }
}
