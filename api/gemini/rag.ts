import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL!
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY!
const GEMINI_API_KEY = process.env.GEMINI_API_KEY!
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models'
const GEMINI_MODEL = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash'

if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !GEMINI_API_KEY) {
  throw new Error('[gemini/rag] Missing required env vars')
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

// ─── RAG context types (mirrored from src/types/rag.ts) ──────────────────────

interface RAGSourceChunk {
  source_id: string
  sourceTitle: string
  sourceType: string
  sourceCreatedAt: string
  content: string
}

interface RAGNodeSummary {
  label: string
  entity_type: string
  description?: string | null
}

interface RAGRelationshipPath {
  from: string
  relation: string
  to: string
  evidence?: string
}

interface RAGAnchor {
  label: string
  entityType: string
  description?: string | null
  connectionCount: number
}

interface RAGSkill {
  name: string
  domain?: string | null
  description: string
  sourceCount: number
  confidence: number
}

interface RAGContext {
  sourceChunks: RAGSourceChunk[]
  nodeSummaries: RAGNodeSummary[]
  relationshipPaths: RAGRelationshipPath[]
  anchors?: RAGAnchor[]
  skills?: RAGSkill[]
}

interface RagBody {
  context: RAGContext
  question: string
  conversationHistory: { role: string; content: string }[]
  sourceContextNote?: string
  mindsetPromptAddition?: string
  temperatureOverride?: number
  maxOutputTokens?: number
  systemDirective?: string
  responseFormatInstruction?: string
}

function isBody(b: unknown): b is RagBody {
  if (!b || typeof b !== 'object') return false
  const o = b as Record<string, unknown>
  if (typeof o.question !== 'string' || o.question.length === 0) return false
  if (!Array.isArray(o.conversationHistory)) return false
  if (!o.context || typeof o.context !== 'object') return false
  const ctx = o.context as Record<string, unknown>
  if (!Array.isArray(ctx.sourceChunks) || !Array.isArray(ctx.nodeSummaries) || !Array.isArray(ctx.relationshipPaths)) return false
  return true
}

function buildRAGSystemPrompt(
  context: RAGContext,
  sourceContextNote: string | undefined,
  mindsetPromptAddition: string | undefined,
  systemDirective: string | undefined,
  responseFormatInstruction: string | undefined,
): string {
  const distinctSources = new Set(context.sourceChunks.map(c => c.source_id))
  const isMultiSource = distinctSources.size >= 2

  const chunksText = context.sourceChunks.length > 0
    ? context.sourceChunks
        .map((c, i) =>
          `--- Chunk ${i + 1} | Source: "${c.sourceTitle}" | source_id: "${c.source_id}" | Type: ${c.sourceType} | Date: ${new Date(c.sourceCreatedAt).toLocaleDateString()} ---\n${c.content}`
        )
        .join('\n\n')
    : '(No source chunks were retrieved for this query)'

  const nodesText = context.nodeSummaries.length > 0
    ? context.nodeSummaries
        .map(n => `  • ${n.label} [${n.entity_type}]: ${n.description ?? '(no description)'}`)
        .join('\n')
    : '  (none)'

  const pathsText = context.relationshipPaths.length > 0
    ? context.relationshipPaths
        .map(p => `  ${p.from} —[${p.relation}]→ ${p.to}${p.evidence ? ` | evidence: "${p.evidence}"` : ''}`)
        .join('\n')
    : '  (none)'

  const sourcesSection = sourceContextNote
    ? `\nMATCHED DOCUMENTS (newest first — use dates to answer "latest" questions):\n${sourceContextNote}\n`
    : ''

  return `You are Synapse — a personal knowledge assistant with access to the user's private knowledge graph. This graph contains their meeting transcripts, research notes, articles, video summaries, and extracted entities.

═══════════════════════════════════════════════════
CORE MISSION: Give RICH, COMPREHENSIVE answers.
═══════════════════════════════════════════════════

${systemDirective ? `CONTEXT DIRECTIVE:\n${systemDirective}\n\n` : ''}${responseFormatInstruction ? `${responseFormatInstruction}\n\n` : ''}ANSWERING RULES (follow these exactly):
1. LENGTH & DEPTH — Your answers must be detailed and thorough. Do NOT give one or two sentence summaries. Synthesize ALL relevant information from every chunk provided. The user explicitly values depth.
2. USE ALL CHUNKS — Read every source chunk and extract relevant details. If 5 chunks are provided, your answer should draw from all 5, not just the first.
3. SPECIFICITY — Include specific names, dates, quotes, decisions, questions raised, action items, and any numbers or metrics mentioned in the source material.
4. MEETINGS & SESSIONS — When asked about a meeting or session: name who attended, who facilitated, what topics were covered (with detail on each), what questions were raised, what was decided, and any follow-up actions.
5. RELATIONSHIPS — Use the entity relationship paths to explain HOW concepts connect to each other.
6. FORMATTING — Write in clear flowing prose. Use **bold** for people's names, key terms, product names, and important facts. Use natural paragraph breaks for readability. IMPORTANT: Never use literal double-quote characters (") inside your answer text — they break JSON. Use single quotes or **bold** instead. Write the **S** tier, not the "S" tier. Write the **My Artifacts** page, not the "My Artifacts" page.
7. "LATEST" QUERIES — When asked about "the latest", "most recent", or "newest", use the dates in chunk headers and the matched documents list to identify the correct content.
8. HONESTY — Only state you lack information if the context is genuinely empty. If partial context exists, use it and note what is and isn't covered.
9. INLINE CITATIONS — Use [N] numbered references inline in your answer text (e.g. "The project launched in Q3 [1] and expanded later [2]"). Every factual claim should have a citation. Cite source chunks with their chunk number. Ensure every [N] in the answer has a matching entry in the citations array.${isMultiSource ? `
10. COMPARISON QUERIES — ${distinctSources.size} distinct sources are present in the context. When the user asks to compare, contrast, or find differences/similarities between documents or sessions:
    - Dedicate a section to EACH source (label by source title)
    - Explicitly state what each source says on the topic
    - Then synthesize: similarities, differences, patterns across sources
    - Do NOT merge content from different sources without attribution — keep it clear which source says what
    - If one source has richer detail, report what the other source DOES say, even if it's brief` : ''}
${mindsetPromptAddition ? `\n${mindsetPromptAddition}\n` : ''}${sourcesSection}
═══════════════════════════════════════════════════
RESPONSE FORMAT — return ONLY valid JSON:
{
  "answer": "Your comprehensive answer with [1], [2], [3] inline citations. Use **bold** for key entities.",
  "citations": [
    {
      "index": 1,
      "label": "Source title or entity label",
      "entity_type": "Person | Topic | Organization | Event | Tool | Concept",
      "node_id": "the node UUID if citing a knowledge node, otherwise null",
      "source_id": "the source UUID if citing a document chunk, otherwise null",
      "chunk_index": 0
    }
  ],
  "followUp": {
    "question": "A natural next question the user might ask, phrased as the user would phrase it",
    "label": "2-4 word button label"
  }
}
Ensure every [N] reference in your answer text has a corresponding entry in the citations array with matching index.

FOLLOW-UP QUESTION:
When the topic has natural depth to explore further, include a "followUp" object in your JSON response with a "question" (a natural next question the user might ask, phrased as the user would phrase it) and a "label" (2-4 word button label). The follow-up should deepen the current thread, not change topics. Omit the followUp object for simple factual answers that don't warrant further exploration.
═══════════════════════════════════════════════════

SOURCE CHUNKS — your primary evidence (read all of them carefully):
${chunksText}

ENTITY SUMMARIES — supporting context:
${nodesText}

RELATIONSHIP PATHS — how entities connect:
${pathsText}
${context.anchors && context.anchors.length > 0 ? `
ANCHOR TOPICS — the user's most important knowledge themes:
${context.anchors.map(a => `  • ${a.label} [${a.entityType}]${a.description ? ': ' + a.description : ''} (${a.connectionCount} connections)`).join('\n')}
` : ''}${context.skills && context.skills.length > 0 ? `
USER SKILLS — capabilities the user is developing:
${context.skills.map(s => `  • ${s.name}${s.domain ? ' (' + s.domain + ')' : ''}: ${s.description} [${s.sourceCount} sources, confidence: ${(s.confidence * 100).toFixed(0)}%]`).join('\n')}
` : ''}
Reminder: The source chunks contain actual words from the user's documents. They are more authoritative than entity summaries. Extract maximum detail from them. Use anchor topics and skills to make connections that are personally relevant to the user.`
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
  stage: string,
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
            stage,
            model: endpoint.split(':')[0],
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

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' })

  const userId = await getUserIdFromRequest(req)
  if (!userId) return res.status(401).json({ error: 'unauthenticated' })

  if (!isBody(req.body)) {
    return res.status(400).json({ error: 'invalid_request', detail: 'Expected { context, question, conversationHistory, ... }' })
  }

  const {
    context, question, conversationHistory,
    sourceContextNote, mindsetPromptAddition,
    temperatureOverride, maxOutputTokens,
    systemDirective, responseFormatInstruction,
  } = req.body

  let truncatedDirective = systemDirective
  if (truncatedDirective && truncatedDirective.length > 2000) {
    truncatedDirective = truncatedDirective.slice(0, 2000) + '...'
  }

  const systemPrompt = buildRAGSystemPrompt(
    context, sourceContextNote, mindsetPromptAddition, truncatedDirective, responseFormatInstruction,
  )

  const contents = [
    ...conversationHistory.map(msg => ({
      role: msg.role === 'user' ? 'user' : 'model',
      parts: [{ text: msg.content }],
    })),
    { role: 'user', parts: [{ text: question }] },
  ]

  const startedAt = Date.now()
  try {
    const { json, usage } = await geminiFetch(
      `${GEMINI_MODEL}:generateContent`,
      {
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents,
        generationConfig: {
          temperature: temperatureOverride ?? 0.3,
          maxOutputTokens: maxOutputTokens ?? 32768,
          responseMimeType: 'application/json',
        },
      },
      120_000,
      'gemini:rag',
    )

    const data = json as {
      candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[]
    }
    const candidate = data.candidates?.[0]
    const parts = candidate?.content?.parts ?? []
    const textPart = parts.find(p => p.thought !== true && typeof p.text === 'string')
      ?? parts.find(p => typeof p.text === 'string')
    const text = textPart?.text ?? ''
    const finishReason = candidate?.finishReason

    console.log(JSON.stringify({
      stage: 'gemini:rag',
      user_id: userId,
      chunks: context.sourceChunks.length,
      duration_ms: Date.now() - startedAt,
      status: 'ok',
      finish_reason: finishReason,
      prompt_tokens: usage?.promptTokenCount,
      output_tokens: usage?.candidatesTokenCount,
    }))

    return res.status(200).json({ text, finishReason })
  } catch (err) {
    console.log(JSON.stringify({
      stage: 'gemini:rag',
      user_id: userId,
      duration_ms: Date.now() - startedAt,
      status: 'error',
      error: (err as Error).message,
    }))
    return res.status(502).json({ error: 'vendor', detail: (err as Error).message })
  }
}
