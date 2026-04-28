import type { ExtractionResult, ExtractedEntity, ExtractedRelationship } from '../types/extraction'
import type { RAGContext, RAGGenerationResult, InlineCitation } from '../types/rag'
import { callApi, ApiError } from './apiClient'

// Single source of truth for model names. Server-side endpoints read GEMINI_MODEL
// from process.env; this constant is kept for callers that want to display the
// model name (e.g. config/queryMindsets.ts).
export const GEMINI_CHAT_MODEL = (import.meta.env.VITE_GEMINI_MODEL as string | undefined) ?? 'gemini-2.5-flash'
export const GEMINI_EMBEDDING_MODEL = 'gemini-embedding-001'

// --- Custom Error ---

export class ExtractionError extends Error {
  rawData: unknown
  constructor(message: string, rawData?: unknown) {
    super(message)
    this.name = 'ExtractionError'
    this.rawData = rawData
  }
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
  let rawText: string
  try {
    const result = await callApi<{ text: string }>('/api/gemini/extract', { content, systemPrompt })
    rawText = result.text
  } catch (err) {
    if (err instanceof ApiError) {
      throw new ExtractionError(`Gemini API error ${err.status}: ${err.detail}`, err.detail)
    }
    throw err
  }

  if (!rawText) {
    throw new ExtractionError('No content in Gemini response')
  }

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
  const { embeddings } = await callApi<{ embeddings: (number[] | null)[] }>('/api/gemini/embed', {
    texts: [text],
  })
  const values = embeddings[0]
  if (!Array.isArray(values)) {
    throw new ExtractionError('No embedding in Gemini response')
  }
  return values
}

export async function generateEmbeddings(
  texts: string[],
  concurrency: number = 5,
  onProgress?: (completed: number, total: number) => void
): Promise<(number[] | null)[]> {
  const results: (number[] | null)[] = new Array(texts.length).fill(null)
  let completed = 0

  // The endpoint accepts up to 100 texts per call; chunk to stay under that
  // and to keep request bodies modest.
  const SERVER_BATCH = 50
  for (let i = 0; i < texts.length; i += SERVER_BATCH) {
    const batch = texts.slice(i, i + SERVER_BATCH)
    try {
      const { embeddings } = await callApi<{ embeddings: (number[] | null)[] }>('/api/gemini/embed', {
        texts: batch,
      })
      embeddings.forEach((v, j) => { results[i + j] = v })
    } catch (err) {
      console.warn('[gemini] Embedding batch failed:', err instanceof Error ? err.message : err)
      // Leave nulls in place
    }
    completed += batch.length
    onProgress?.(completed, texts.length)
  }

  // concurrency parameter retained for backwards compatibility but no longer
  // controls behaviour — the server endpoint handles its own concurrency.
  void concurrency

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

function parseRAGResponse(responseText: string): RAGGenerationResult {
  // Strip markdown code fences if present
  let cleaned = responseText
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim()

  const firstBrace = cleaned.indexOf('{')
  if (firstBrace > 0) {
    cleaned = cleaned.slice(firstBrace)
  }

  let parsed: Record<string, unknown> | null = null
  try {
    parsed = JSON.parse(cleaned) as Record<string, unknown>
  } catch {
    let fixAttempt = ''
    {
      let inStr = false
      let esc = false
      for (let idx = 0; idx < cleaned.length; idx++) {
        const ch = cleaned[idx]!
        if (esc) { fixAttempt += ch; esc = false; continue }
        if (ch === '\\' && inStr) { fixAttempt += ch; esc = true; continue }

        if (ch === '"') {
          if (!inStr) {
            inStr = true
            fixAttempt += ch
          } else {
            let nextIdx = idx + 1
            while (nextIdx < cleaned.length && (cleaned[nextIdx] === ' ' || cleaned[nextIdx] === '\n' || cleaned[nextIdx] === '\r' || cleaned[nextIdx] === '\t')) {
              nextIdx++
            }
            const nextCh = nextIdx < cleaned.length ? cleaned[nextIdx] : ''

            if (nextCh === ',' || nextCh === '}' || nextCh === ']' || nextCh === ':' || nextCh === '') {
              inStr = false
              fixAttempt += ch
            } else {
              fixAttempt += '\\"'
            }
          }
        } else if (inStr && ch === '\n') {
          fixAttempt += '\\n'
        } else if (inStr && ch === '\r') {
          fixAttempt += '\\r'
        } else if (inStr && ch === '\t') {
          fixAttempt += '\\t'
        } else {
          fixAttempt += ch
        }
      }
    }

    fixAttempt = fixAttempt.replace(/,\s*$/, '')

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

    if (inString) fixAttempt += '"'
    while (bracketCount > 0) { fixAttempt += ']'; bracketCount-- }
    while (braceCount > 0) { fixAttempt += '}'; braceCount-- }

    fixAttempt = fixAttempt.replace(/,\s*([}\]])/g, '$1')

    try {
      parsed = JSON.parse(fixAttempt) as Record<string, unknown>
      console.debug('[gemini] Parsed RAG response after fix-up')
    } catch {
      try {
        const sanitised = fixAttempt.replace(
          /"(?:[^"\\]|\\.)*"/g,
          match => match.replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')
        )
        parsed = JSON.parse(sanitised) as Record<string, unknown>
        console.debug('[gemini] Parsed RAG response after newline sanitisation')
      } catch (e3) {
        console.warn('[gemini] JSON parse failed even after all fix-ups:', (e3 as Error).message)
        console.debug('[gemini] First 500 chars:', cleaned.slice(0, 500))

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
  const { text } = await callApi<{ text: string }>('/api/gemini/generate-text', {
    systemPrompt,
    userPrompt,
    temperature: options?.temperature,
    maxOutputTokens: options?.maxOutputTokens,
  })
  return text
}

/**
 * For complex multi-concept queries, decomposes into 2-3 focused sub-queries.
 * Simple or short queries are returned as-is (single element array).
 * Fails gracefully — always returns at least the original question.
 */
export async function decomposeQuery(question: string): Promise<string[]> {
  const wordCount = question.trim().split(/\s+/).length
  if (wordCount <= 7) return [question]

  try {
    const { text } = await callApi<{ text: string }>('/api/gemini/decompose-query', { question })
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
  void _thinkingBudget
  let result: { text: string; finishReason?: string }
  try {
    result = await callApi<{ text: string; finishReason?: string }>('/api/gemini/rag', {
      context,
      question,
      conversationHistory,
      sourceContextNote,
      mindsetPromptAddition,
      temperatureOverride,
      maxOutputTokens,
      systemDirective,
      responseFormatInstruction,
    })
  } catch (err) {
    if (err instanceof ApiError) {
      throw new ExtractionError(`Gemini RAG error ${err.status}: ${err.detail}`, err.detail)
    }
    throw err
  }

  if (result.finishReason === 'MAX_TOKENS') {
    console.warn('[gemini] RAG response was truncated (MAX_TOKENS). Consider increasing maxOutputTokens.')
  }

  if (!result.text) {
    throw new ExtractionError('Empty response from Gemini')
  }

  console.debug('[gemini] RAG response length:', result.text.length, '| finishReason:', result.finishReason, '| starts with:', result.text.slice(0, 80))

  return parseRAGResponse(result.text)
}
