import type { ExtractionResult, ExtractedEntity, ExtractedRelationship } from '../types/extraction'
import type { RAGContext, RAGGenerationResult, InlineCitation } from '../types/rag'

const GEMINI_API_KEY = import.meta.env.VITE_GEMINI_API_KEY
const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models'

const MAX_CONTENT_LENGTH = 100_000

// --- Custom Error ---

export class ExtractionError extends Error {
  rawData: unknown
  constructor(message: string, rawData?: unknown) {
    super(message)
    this.name = 'ExtractionError'
    this.rawData = rawData
  }
}

// --- Retry Logic ---

export async function fetchWithRetry(
  url: string,
  options: RequestInit,
  maxRetries: number = 3
): Promise<Response> {
  let lastError: Error | null = null

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await fetch(url, options)

      if (response.ok) return response

      // Don't retry client errors (except rate limits)
      if (response.status === 400 || response.status === 401) {
        const errorBody = await response.text()
        throw new ExtractionError(
          `Gemini API error ${response.status}: ${errorBody}`,
          errorBody
        )
      }

      // Retry on rate limit and server errors
      if (response.status === 429 || response.status >= 500) {
        lastError = new ExtractionError(
          `Gemini API returned ${response.status}`,
          await response.text()
        )
        if (attempt < maxRetries - 1) {
          const delay = Math.pow(2, attempt) * 1000 // 1s, 2s, 4s
          await new Promise(resolve => setTimeout(resolve, delay))
          continue
        }
      }

      const errorBody = await response.text()
      throw new ExtractionError(
        `Gemini API error ${response.status}: ${errorBody}`,
        errorBody
      )
    } catch (err) {
      if (err instanceof ExtractionError) throw err
      lastError = err as Error
      if (attempt < maxRetries - 1) {
        const delay = Math.pow(2, attempt) * 1000
        await new Promise(resolve => setTimeout(resolve, delay))
      }
    }
  }

  throw lastError ?? new ExtractionError('Gemini API request failed after retries')
}

// --- Validation Helpers ---

function validateEntity(raw: Record<string, unknown>): ExtractedEntity | null {
  if (!raw.label || typeof raw.label !== 'string') {
    console.warn('[gemini] Dropping entity: missing label', raw)
    return null
  }
  if (!raw.entity_type || typeof raw.entity_type !== 'string') {
    console.warn('[gemini] Dropping entity: missing entity_type', raw)
    return null
  }
  const confidence = typeof raw.confidence === 'number' ? raw.confidence : 0.5
  if (confidence < 0.1) {
    console.warn('[gemini] Dropping entity: very low confidence', raw.label, confidence)
    return null
  }

  return {
    label: String(raw.label).trim(),
    entity_type: String(raw.entity_type),
    description: typeof raw.description === 'string' ? raw.description : '',
    confidence: Math.min(1, Math.max(0, confidence)),
    tags: Array.isArray(raw.tags)
      ? raw.tags.filter((t): t is string => typeof t === 'string')
      : [],
  }
}

function validateRelationship(raw: Record<string, unknown>): ExtractedRelationship | null {
  if (!raw.source || typeof raw.source !== 'string') {
    console.warn('[gemini] Dropping relationship: missing source', raw)
    return null
  }
  if (!raw.target || typeof raw.target !== 'string') {
    console.warn('[gemini] Dropping relationship: missing target', raw)
    return null
  }
  if (!raw.relation_type || typeof raw.relation_type !== 'string') {
    console.warn('[gemini] Dropping relationship: missing relation_type', raw)
    return null
  }

  return {
    source: String(raw.source).trim(),
    target: String(raw.target).trim(),
    relation_type: String(raw.relation_type),
    evidence: typeof raw.evidence === 'string' ? raw.evidence : '',
  }
}

// --- Entity Extraction ---

export async function extractEntities(
  content: string,
  systemPrompt: string
): Promise<ExtractionResult> {
  if (!GEMINI_API_KEY) {
    throw new ExtractionError('VITE_GEMINI_API_KEY is not configured')
  }

  // Truncate very long content
  let processedContent = content
  if (content.length > MAX_CONTENT_LENGTH) {
    processedContent =
      content.substring(0, MAX_CONTENT_LENGTH) +
      '\n\n[Content truncated at 100,000 characters. The above is a partial text.]'
  }

  const response = await fetchWithRetry(
    `${GEMINI_BASE_URL}/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents: [{ parts: [{ text: processedContent }] }],
        generationConfig: {
          temperature: 0.1,
          responseMimeType: 'application/json',
        },
      }),
    }
  )

  const data = await response.json()

  if (!data.candidates?.[0]?.content?.parts?.[0]?.text) {
    throw new ExtractionError('No content in Gemini response', data)
  }

  const rawText = data.candidates[0].content.parts[0].text

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(rawText)
  } catch {
    console.error('[gemini] Failed to parse JSON response:', rawText.substring(0, 500))
    throw new ExtractionError(
      'Gemini returned an invalid response. This is usually temporary — try re-extracting.',
      rawText
    )
  }

  if (!Array.isArray(parsed.entities)) {
    throw new ExtractionError('Response missing entities array', parsed)
  }

  const entities = (parsed.entities as Record<string, unknown>[])
    .map(validateEntity)
    .filter((e): e is ExtractedEntity => e !== null)

  const relationships = Array.isArray(parsed.relationships)
    ? (parsed.relationships as Record<string, unknown>[])
        .map(validateRelationship)
        .filter((r): r is ExtractedRelationship => r !== null)
    : []

  return {
    entities,
    relationships,
    rawResponse: rawText,
  }
}

// --- Embedding Generation ---

export async function generateEmbedding(text: string): Promise<number[]> {
  if (!GEMINI_API_KEY) {
    throw new ExtractionError('VITE_GEMINI_API_KEY is not configured')
  }

  const response = await fetchWithRetry(
    `${GEMINI_BASE_URL}/gemini-embedding-001:embedContent?key=${GEMINI_API_KEY}`,
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
    throw new ExtractionError('No embedding in Gemini response', data)
  }

  return data.embedding.values as number[]
}

export async function generateEmbeddings(
  texts: string[],
  concurrency: number = 5,
  onProgress?: (completed: number, total: number) => void
): Promise<(number[] | null)[]> {
  const results: (number[] | null)[] = new Array(texts.length).fill(null)
  let completed = 0

  for (let i = 0; i < texts.length; i += concurrency) {
    const batch = texts.slice(i, i + concurrency)
    const batchResults = await Promise.allSettled(
      batch.map(text => generateEmbedding(text))
    )

    batchResults.forEach((result, j) => {
      if (result.status === 'fulfilled') {
        results[i + j] = result.value
      } else {
        console.warn(
          `[gemini] Embedding failed for text ${i + j}:`,
          result.reason?.message ?? result.reason
        )
        results[i + j] = null
      }
    })

    completed += batch.length
    onProgress?.(completed, texts.length)
  }

  return results
}

// ─── RAG: Query Embedding ─────────────────────────────────────────────────────

/**
 * Generate a 3072-dim embedding for a query text.
 * Returns [] on failure so the RAG pipeline degrades gracefully to keyword-only mode.
 */
export async function embedQuery(text: string): Promise<number[]> {
  try {
    const values = await generateEmbedding(text)
    if (!Array.isArray(values) || values.length !== 3072) {
      console.warn('[embedQuery] Unexpected embedding dimensions:', values?.length)
      return []
    }
    return values
  } catch (err) {
    console.warn('[embedQuery] Embedding failed, falling back to keyword-only:', err instanceof Error ? err.message : err)
    return []
  }
}

// ─── RAG: Response Generation ─────────────────────────────────────────────────

function buildRAGSystemPrompt(context: RAGContext, sourceContextNote?: string, mindsetPromptAddition?: string, systemDirective?: string, responseFormatInstruction?: string): string {
  // Detect when multiple distinct sources are present — triggers comparison mode
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
6. FORMATTING — Write in clear flowing prose. Use **bold** for people's names, key terms, product names, and important facts. Use natural paragraph breaks for readability.
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

Reminder: The source chunks contain actual words from the user's documents. They are more authoritative than entity summaries. Extract maximum detail from them.`
}

function parseRAGResponse(responseText: string): RAGGenerationResult {
  // Strip markdown code fences if present
  let cleaned = responseText
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim()

  // Gemini 2.5 Flash sometimes returns multiple JSON objects concatenated,
  // or wraps the response in extra whitespace/newlines. Normalize.
  // Also strip any leading/trailing non-JSON characters.
  const firstBrace = cleaned.indexOf('{')
  if (firstBrace > 0) {
    cleaned = cleaned.slice(firstBrace)
  }

  // Try standard JSON parse
  let parsed: Record<string, unknown> | null = null
  try {
    parsed = JSON.parse(cleaned) as Record<string, unknown>
  } catch {
    // JSON might be truncated (maxOutputTokens hit). Try to fix common issues:
    // 1. Missing closing braces/brackets
    // 2. Trailing comma before closing
    let fixAttempt = cleaned
      .replace(/,\s*$/, '')  // trailing comma

    // Count braces to see if we need to close them
    let braceCount = 0
    let bracketCount = 0
    let inString = false
    let escaped = false
    for (const ch of fixAttempt) {
      if (escaped) { escaped = false; continue }
      if (ch === '\\') { escaped = true; continue }
      if (ch === '"') { inString = !inString; continue }
      if (inString) continue
      if (ch === '{') braceCount++
      if (ch === '}') braceCount--
      if (ch === '[') bracketCount++
      if (ch === ']') bracketCount--
    }

    // If we're inside a string, close it
    if (inString) fixAttempt += '"'
    // Close any open brackets/braces
    while (bracketCount > 0) { fixAttempt += ']'; bracketCount-- }
    while (braceCount > 0) { fixAttempt += '}'; braceCount-- }

    // Remove trailing comma before closing brace/bracket
    fixAttempt = fixAttempt.replace(/,\s*([}\]])/g, '$1')

    try {
      parsed = JSON.parse(fixAttempt) as Record<string, unknown>
      console.debug('[gemini] Parsed RAG response after fix-up (truncated JSON)')
    } catch (e2) {
      console.warn('[gemini] JSON parse failed even after fix-up:', (e2 as Error).message)
      console.debug('[gemini] First 300 chars:', cleaned.slice(0, 300))

      // Last resort: regex extract the answer field
      const answerMatch = cleaned.match(/"answer"\s*:\s*"((?:[^"\\]|\\.)*)/)
      if (answerMatch?.[1]) {
        const rawAnswer = answerMatch[1]
          .replace(/\\n/g, '\n')
          .replace(/\\"/g, '"')
          .replace(/\\\\/g, '\\')
        return { answer: rawAnswer, citations: [] }
      }

      return { answer: cleaned, citations: [] }
    }
  }

  if (!parsed) return { answer: cleaned, citations: [] }

  const answer = typeof parsed.answer === 'string' ? parsed.answer : cleaned
  const citations: InlineCitation[] = Array.isArray(parsed.citations)
    ? (parsed.citations as Record<string, unknown>[])
        .filter(c => typeof c === 'object' && c !== null)
        .map((c, i) => ({
          index: typeof c['index'] === 'number' ? c['index']
            : typeof c['index'] === 'string' && /^\d+$/.test(c['index']) ? parseInt(c['index'], 10)
            : i + 1,
          label: typeof c['label'] === 'string' ? c['label'] : '',
          entity_type: typeof c['entity_type'] === 'string' ? c['entity_type'] : 'Topic',
          node_id: typeof c['node_id'] === 'string' && c['node_id'] !== 'null' ? c['node_id'] : null,
          source_id: typeof c['source_id'] === 'string' && c['source_id'] !== 'null' ? c['source_id'] : null,
          chunk_index: typeof c['chunk_index'] === 'number' ? c['chunk_index']
            : typeof c['chunk_index'] === 'string' && /^\d+$/.test(c['chunk_index']) ? parseInt(c['chunk_index'], 10)
            : null,
        }))
    : []

  // PRD-C: Parse follow-up suggestion
  const rawFollowUp = parsed.followUp as Record<string, unknown> | undefined
  const followUp = rawFollowUp && typeof rawFollowUp === 'object'
    && typeof rawFollowUp.question === 'string' && (rawFollowUp.question as string).length > 0
    ? {
        question: rawFollowUp.question as string,
        label: typeof rawFollowUp.label === 'string' ? rawFollowUp.label : 'Go deeper',
      }
    : undefined

  return { answer, citations, followUp }
}

// ─── RAG: Query Decomposition ─────────────────────────────────────────────────

/**
 * Lightweight direct Gemini text generation (no RAG, no JSON parsing).
 * Used for digest executive summaries and other synthesis tasks where
 * we already have the context and just need LLM generation.
 */
export async function generateText(
  systemPrompt: string,
  userPrompt: string,
  options?: { temperature?: number; maxOutputTokens?: number }
): Promise<string> {
  if (!GEMINI_API_KEY) throw new ExtractionError('VITE_GEMINI_API_KEY is not configured')

  const response = await fetchWithRetry(
    `${GEMINI_BASE_URL}/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
        generationConfig: {
          temperature: options?.temperature ?? 0.4,
          maxOutputTokens: options?.maxOutputTokens ?? 4096,
        },
      }),
    }
  )

  const data = await response.json() as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> } }>
  }
  const parts = data.candidates?.[0]?.content?.parts ?? []
  const textPart = parts.find(p => p.thought !== true && typeof p.text === 'string')
    ?? parts.find(p => typeof p.text === 'string')
  return textPart?.text ?? ''
}

/**
 * For complex multi-concept queries, decomposes into 2-3 focused sub-queries.
 * Simple or short queries are returned as-is (single element array).
 * Fails gracefully — always returns at least the original question.
 */
export async function decomposeQuery(question: string): Promise<string[]> {
  if (!GEMINI_API_KEY) return [question]

  // Only decompose if the query is genuinely multi-concept (> 7 words)
  const wordCount = question.trim().split(/\s+/).length
  if (wordCount <= 7) return [question]

  try {
    const response = await fetchWithRetry(
      `${GEMINI_BASE_URL}/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [{
              text: `You are a search query decomposer. Break the following query into 2-3 focused noun-phrase sub-queries that together cover its full intent. Return ONLY a JSON array of strings.

Query: "${question}"

Rules:
- If the query is already focused on one topic, return it as a single-element array
- Return 2-3 sub-queries only when there are clearly distinct concepts ("AI research AND consulting" → two sub-queries)
- Each sub-query should be 3-8 words, focused on retrievable nouns/topics
- Do NOT include question words (what, how, who) — just the searchable concepts
- Example: "What connections between my AI research and consulting work?" → ["AI research projects", "consulting opportunities", "AI consulting connections"]

Return only the JSON array, nothing else.`,
            }],
          }],
          generationConfig: { temperature: 0, responseMimeType: 'application/json' },
        }),
      }
    )

    const data = await response.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> }
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text
    if (!text) return [question]

    const parsed = JSON.parse(text) as unknown
    if (Array.isArray(parsed) && parsed.length > 0) {
      const subQueries = (parsed as unknown[])
        .filter((q): q is string => typeof q === 'string' && q.trim().length > 0)
        .slice(0, 3)
      return subQueries.length > 0 ? subQueries : [question]
    }
    return [question]
  } catch {
    return [question]
  }
}

export async function generateRAGResponse(
  context: RAGContext,
  question: string,
  conversationHistory: { role: string; content: string }[],
  sourceContextNote?: string,
  mindsetPromptAddition?: string,
  temperatureOverride?: number,
  maxOutputTokens?: number,
  systemDirective?: string,
  responseFormatInstruction?: string,
  _thinkingBudget?: number
): Promise<RAGGenerationResult> {
  if (!GEMINI_API_KEY) {
    throw new ExtractionError('VITE_GEMINI_API_KEY is not configured')
  }

  // Truncate overly long directives (PRD-A §7: max 2000 chars)
  let truncatedDirective = systemDirective
  if (truncatedDirective && truncatedDirective.length > 2000) {
    console.warn(`[gemini] systemDirective too long (${truncatedDirective.length} chars), truncating to 2000`)
    truncatedDirective = truncatedDirective.slice(0, 2000) + '...'
  }

  const systemPrompt = buildRAGSystemPrompt(context, sourceContextNote, mindsetPromptAddition, truncatedDirective, responseFormatInstruction)

  const contents = [
    ...conversationHistory.map(msg => ({
      role: msg.role === 'user' ? 'user' : 'model',
      parts: [{ text: msg.content }],
    })),
    { role: 'user', parts: [{ text: question }] },
  ]

  // Build generation config (PRD-C §2.3)
  // NOTE: thinkingConfig is NOT compatible with responseMimeType: 'application/json' in Gemini 2.5 Flash.
  // Thinking budgets are disabled for now until Google adds JSON + thinking support.
  const generationConfig: Record<string, unknown> = {
    temperature: temperatureOverride ?? 0.3,
    maxOutputTokens: maxOutputTokens ?? 16384,
    responseMimeType: 'application/json',
  }

  const response = await fetchWithRetry(
    `${GEMINI_BASE_URL}/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents,
        generationConfig,
      }),
    }
  )

  const data = await response.json() as {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string; thought?: boolean }> }
      finishReason?: string
    }>
  }

  const candidate = data.candidates?.[0]
  const finishReason = candidate?.finishReason

  if (finishReason === 'MAX_TOKENS') {
    console.warn('[gemini] RAG response was truncated (MAX_TOKENS). Consider increasing maxOutputTokens.')
  }

  // Gemini 2.5 Flash may return thought parts before the real answer.
  // Find the first non-thought text part, or fall back to any text part.
  const parts = candidate?.content?.parts ?? []
  const textPart = parts.find(p => p.thought !== true && typeof p.text === 'string')
    ?? parts.find(p => typeof p.text === 'string')
  const responseText = textPart?.text

  if (!responseText) {
    console.error('[gemini] Empty RAG response. Parts:', JSON.stringify(parts.map(p => ({ thought: p.thought, textLen: p.text?.length }))))
    throw new ExtractionError('Empty response from Gemini', data)
  }

  console.debug('[gemini] RAG response length:', responseText.length, '| finishReason:', finishReason, '| starts with:', responseText.slice(0, 80))

  return parseRAGResponse(responseText)
}
