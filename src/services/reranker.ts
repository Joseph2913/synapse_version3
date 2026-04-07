/**
 * PRD-RAG-01: Gemini-Powered Reranking
 *
 * Scores retrieval candidates 0–10 for query relevance using Gemini Flash.
 * Adds ~500–800ms latency but significantly improves result quality by
 * filtering out false positives from vector similarity search.
 */

import { fetchWithRetry } from './gemini'

const GEMINI_API_KEY = import.meta.env.VITE_GEMINI_API_KEY
const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models'

export interface RerankerCandidate {
  id: string
  text: string
  source_type: 'chunk' | 'entity' | 'relationship'
  metadata?: {
    source_title?: string
    entity_type?: string
    relation_type?: string
    entity_labels?: string[]
  }
}

export interface RankedCandidate extends RerankerCandidate {
  relevance_score: number  // 0–10 from Gemini
}

/**
 * Robust score extraction from Gemini output.
 *
 * Handles: clean arrays, object-wrapped arrays, trailing commas,
 * markdown fences, and partial/truncated responses. When Gemini
 * returns fewer scores than expected (truncated output), uses
 * the partial scores and fills the rest with neutral 5s.
 */
function parseScoresRobust(text: string, expectedCount: number): number[] {
  console.debug('[reranker] Raw Gemini response:', text.slice(0, 300))

  // Try clean JSON parse first
  try {
    const parsed = JSON.parse(text)
    if (Array.isArray(parsed)) return padScores(parsed, expectedCount)
    // Gemini sometimes wraps in an object like {"scores": [...]}
    if (typeof parsed === 'object' && parsed !== null) {
      const firstArrayValue = Object.values(parsed).find(Array.isArray) as number[] | undefined
      if (firstArrayValue) return padScores(firstArrayValue, expectedCount)
    }
  } catch {
    // Fall through to robust extraction
  }

  // Try fixing common JSON issues
  try {
    let cleaned = text.trim()
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '')
    cleaned = cleaned.replace(/,\s*([}\]])/g, '$1')
    // Close unclosed array (truncated response like "[1, 8, 3,")
    if (cleaned.includes('[') && !cleaned.includes(']')) {
      cleaned = cleaned.replace(/,\s*$/, '') + ']'
    }
    if (!cleaned.startsWith('[')) {
      const bracketStart = cleaned.indexOf('[')
      if (bracketStart >= 0) cleaned = cleaned.slice(bracketStart)
    }
    if (!cleaned.endsWith(']')) {
      const bracketEnd = cleaned.lastIndexOf(']')
      if (bracketEnd >= 0) cleaned = cleaned.slice(0, bracketEnd + 1)
    }
    const parsed = JSON.parse(cleaned)
    if (Array.isArray(parsed)) return padScores(parsed, expectedCount)
  } catch {
    // Fall through to regex extraction
  }

  // Last resort: extract all numbers from the text and use them as partial scores
  const numbers = text.match(/\b(\d+(?:\.\d+)?)\b/g)
  if (numbers && numbers.length > 0) {
    console.debug('[reranker] Extracted', numbers.length, 'scores via regex (expected', expectedCount, ')')
    return padScores(numbers.map(Number), expectedCount)
  }

  console.warn('[reranker] No scores found, using neutral 5s')
  return Array(expectedCount).fill(5) as number[]
}

/** Pad a partial score array to the expected length with neutral 5s */
function padScores(scores: unknown[], expectedCount: number): number[] {
  const numeric = scores.map(v => typeof v === 'number' ? v : 0)
  if (numeric.length >= expectedCount) return numeric.slice(0, expectedCount)
  // Partial scores — use what we have, pad the rest
  if (numeric.length > 0 && numeric.length < expectedCount) {
    console.debug('[reranker] Partial scores:', numeric.length, '/', expectedCount, '— padding rest with 5')
  }
  return [...numeric, ...Array(expectedCount - numeric.length).fill(5) as number[]]
}

/**
 * Reranks retrieval candidates using Gemini Flash relevance scoring.
 * Gracefully degrades to original order on failure.
 */
export async function rerankCandidates(
  query: string,
  candidates: RerankerCandidate[],
  topN: number = 10
): Promise<RankedCandidate[]> {
  if (candidates.length === 0) return []

  // If fewer candidates than topN, skip reranking — all are included
  if (candidates.length <= topN) {
    return candidates.map(c => ({ ...c, relevance_score: 5 }))
  }

  if (!GEMINI_API_KEY) {
    console.warn('[reranker] No API key, returning original order')
    return candidates.slice(0, topN).map(c => ({ ...c, relevance_score: 5 }))
  }

  // Cap candidates to avoid overwhelming Gemini's output budget.
  // With 150 chars per candidate and 30 candidates, input is ~4,500 chars.
  // Gemini needs ~4 tokens per score, so 30 scores ≈ 120 output tokens.
  const maxCandidates = 30
  const capped = candidates.slice(0, maxCandidates)

  const candidateList = capped.map((c, i) =>
    `[${i}] ${c.text.slice(0, 150)}`
  ).join('\n')

  const rerankPrompt = `Score each passage 0-10 for relevance to the query. Return ONLY a JSON array of ${capped.length} integers, nothing else.

Query: "${query}"

${candidateList}`

  try {
    const response = await fetchWithRetry(
      `${GEMINI_BASE_URL}/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: rerankPrompt }] }],
          generationConfig: {
            maxOutputTokens: 1024,
            temperature: 0,
            responseMimeType: 'application/json',
            // Disable thinking — scoring is a simple task that doesn't
            // need internal reasoning, and thinking eats the output budget
            thinkingConfig: { thinkingBudget: 0 },
          },
        }),
      },
      1 // Single attempt — speed over reliability for reranking
    )

    const data = await response.json() as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> } }>
    }

    const parts = data.candidates?.[0]?.content?.parts ?? []
    const textPart = parts.find(p => p.thought !== true && typeof p.text === 'string')
      ?? parts.find(p => typeof p.text === 'string')
    const text = textPart?.text

    if (!text) {
      console.warn('[reranker] Empty response, returning original order')
      return candidates.slice(0, topN).map(c => ({ ...c, relevance_score: 5 }))
    }

    const scores = parseScoresRobust(text, capped.length)

    // Apply scores to capped candidates, then append uncapped ones with neutral score
    const ranked: RankedCandidate[] = [
      ...capped.map((c, i) => ({
        ...c,
        relevance_score: typeof scores[i] === 'number' ? scores[i] : 5,
      })),
      ...candidates.slice(maxCandidates).map(c => ({ ...c, relevance_score: 3 })),
    ]

    ranked.sort((a, b) => b.relevance_score - a.relevance_score)

    return ranked.slice(0, topN)
  } catch (err) {
    console.error('[reranker] Reranking failed, returning original order:', err)
    return candidates.slice(0, topN).map(c => ({ ...c, relevance_score: 5 }))
  }
}
