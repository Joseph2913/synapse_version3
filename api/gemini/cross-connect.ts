import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL!
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY!
const GEMINI_API_KEY = process.env.GEMINI_API_KEY!
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models'
const GEMINI_MODEL = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash'

if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !GEMINI_API_KEY) {
  throw new Error('[gemini/cross-connect] Missing required env vars')
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

async function geminiFetch(
  endpoint: string,
  body: unknown,
  timeoutMs: number,
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
        return { json, usage: json.usageMetadata }
      }
      const txt = await resp.text().catch(() => '')
      lastErr = new Error(`Gemini ${resp.status}: ${txt.slice(0, 200)}`)
      if ((resp.status === 429 || resp.status >= 500) && attempt < maxAttempts - 1) {
        await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)))
        continue
      }
      throw lastErr
    } finally {
      clearTimeout(timer)
    }
  }
  throw lastErr ?? new Error('Gemini request failed')
}

interface EntitySpec {
  entity_type: string
  label: string
  description?: string | null
  connections?: string[]
}

interface CrossConnectBody {
  newEntities: EntitySpec[]
  existingEntities: EntitySpec[]
}

function isEntitySpec(v: unknown): v is EntitySpec {
  if (!v || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  if (typeof o.entity_type !== 'string' || typeof o.label !== 'string') return false
  if (o.description !== undefined && o.description !== null && typeof o.description !== 'string') return false
  if (o.connections !== undefined && !Array.isArray(o.connections)) return false
  return true
}

function isCrossConnectBody(b: unknown): b is CrossConnectBody {
  if (!b || typeof b !== 'object') return false
  const obj = b as Record<string, unknown>
  if (!Array.isArray(obj.newEntities) || !Array.isArray(obj.existingEntities)) return false
  if (obj.newEntities.length === 0 || obj.newEntities.length > 100) return false
  if (obj.existingEntities.length === 0 || obj.existingEntities.length > 100) return false
  return obj.newEntities.every(isEntitySpec) && obj.existingEntities.every(isEntitySpec)
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method_not_allowed' })
  }

  const userId = await getUserIdFromRequest(req)
  if (!userId) {
    return res.status(401).json({ error: 'unauthenticated' })
  }

  if (!isCrossConnectBody(req.body)) {
    return res.status(400).json({ error: 'invalid_request', detail: 'Expected { newEntities, existingEntities } each with entity_type+label' })
  }

  const { newEntities, existingEntities } = req.body

  const newList = newEntities.map(
    n => `- [${n.entity_type}] ${n.label}: ${n.description || 'No description'}`
  ).join('\n')

  const existingList = existingEntities.map(n => {
    const ctx = (n.connections && n.connections.length > 0)
      ? `\n    Connected to: ${n.connections.slice(0, 3).join('; ')}`
      : ''
    return `- [${n.entity_type}] ${n.label}: ${n.description || 'No description'}${ctx}`
  }).join('\n')

  const prompt = `You are building a knowledge graph. Identify meaningful cross-source relationships between new and existing entities.

New entities (just ingested from a new source):
${newList}

Existing entities (already in the user's knowledge graph, with their current connections):
${existingList}

Rules:
- Determine the natural direction of each relationship. Default to the new entity as the subject (source), but REVERSE the direction when the relationship naturally flows from the existing entity to the new one (e.g., "Existing Entity leads_to New Entity" is valid if that is the true direction).
- Use specific directional types: leads_to, enables, supports, blocks, part_of, contradicts.
- Use relates_to ONLY when the relationship is genuinely bidirectional and no more specific type fits.
- Do NOT connect entities simply because they share a label or topic — the relationship must add knowledge.
- Use the "Connected to" context on existing entities to identify cluster membership and avoid redundant connections.
- Skip connections between entities that appear to be the same concept described differently.

Return JSON:
{
  "connections": [
    {
      "source_entity": "exact label of the relationship subject — can be from EITHER the new or existing list",
      "target_entity": "exact label of the relationship object — can be from EITHER the new or existing list",
      "relation_type": "one of: leads_to, supports, enables, blocks, contradicts, part_of, relates_to, mentions, associated_with",
      "evidence": "one sentence explaining why this direction is correct and what knowledge the connection adds"
    }
  ]
}

Return an empty connections array if no genuine cross-source connections exist.`

  const startedAt = Date.now()
  try {
    const { json, usage } = await geminiFetch(
      `${GEMINI_MODEL}:generateContent`,
      {
        system_instruction: {
          parts: [{ text: 'You are a knowledge graph relationship expert. Find non-obvious, cross-source connections between entities from different content sources. Prioritise directional, specific relationship types over generic ones.' }],
        },
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.1,
          responseMimeType: 'application/json',
        },
      },
      60_000,
    )
    const data = json as {
      candidates?: { content?: { parts?: { text?: string }[] } }[]
    }
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? ''

    console.log(JSON.stringify({
      stage: 'gemini:cross-connect',
      user_id: userId,
      new_count: newEntities.length,
      existing_count: existingEntities.length,
      duration_ms: Date.now() - startedAt,
      status: 'ok',
      prompt_tokens: usage?.promptTokenCount,
      output_tokens: usage?.candidatesTokenCount,
    }))

    return res.status(200).json({ text })
  } catch (err) {
    console.log(JSON.stringify({
      stage: 'gemini:cross-connect',
      user_id: userId,
      duration_ms: Date.now() - startedAt,
      status: 'error',
      error: (err as Error).message,
    }))
    return res.status(502).json({ error: 'vendor', detail: (err as Error).message })
  }
}
