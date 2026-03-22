/**
 * PRD-C §2.2: Auto-Classification Pre-Pass
 *
 * Lightweight classification call that runs before the full RAG pipeline.
 * Takes the user's question (and optional entry context) and returns a
 * structured intent classification.
 */

import { fetchWithRetry } from './gemini'

const GEMINI_API_KEY = import.meta.env.VITE_GEMINI_API_KEY
const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models'

export interface QueryClassification {
  /** Detected intent type */
  intent: 'factual' | 'analytical' | 'comparative' | 'exploratory' | 'temporal' | 'actionable'

  /** Recommended retrieval strategy */
  retrieval: {
    chunkCount: number         // How many source chunks to fetch (3-20)
    traversalHops: number      // Graph traversal depth (1-3)
    prioritiseRecency: boolean // Weight recent sources higher
    needsBroadSearch: boolean  // Skip scope locks, search widely
  }

  /** Recommended response format */
  responseFormat: 'prose' | 'list' | 'comparison' | 'timeline' | 'summary'

  /** Thinking budget for Gemini 2.5 Flash (0 = no thinking, higher = deeper reasoning) */
  thinkingBudget: number  // 0, 1024, 4096, 8192

  /** Whether to suggest a follow-up question */
  suggestFollowUp: boolean

  /** Confidence in the classification (0-1) */
  confidence: number
}

/** Default fallback classification when the classifier fails */
const DEFAULT_CLASSIFICATION: QueryClassification = {
  intent: 'analytical',
  retrieval: {
    chunkCount: 15,
    traversalHops: 2,
    prioritiseRecency: false,
    needsBroadSearch: false,
  },
  responseFormat: 'prose',
  thinkingBudget: 1024,
  suggestFollowUp: true,
  confidence: 0,
}

/**
 * Classify query intent using a fast Gemini 2.5 Flash call (~200ms).
 * For entry-point queries (PRD-B), the classification is pre-determined
 * by the entry context and this function is skipped.
 */
export async function classifyQuery(
  question: string,
  conversationContext?: string
): Promise<QueryClassification> {
  if (!GEMINI_API_KEY) {
    console.warn('[classifier] No API key, using default classification')
    return DEFAULT_CLASSIFICATION
  }

  try {
    const prompt = `Classify this knowledge graph query. Return ONLY valid JSON.

Query: "${question}"
${conversationContext ? `Conversation context: "${conversationContext}"` : ''}

Classify into:
- intent: factual (specific fact/date/name), analytical (why/how/implications), comparative (X vs Y), exploratory (open-ended/what exists), temporal (timeline/evolution/latest), actionable (risks/actions/decisions)
- retrieval: { chunkCount (3-20), traversalHops (1-3), prioritiseRecency (bool), needsBroadSearch (bool) }
- responseFormat: prose (default analysis), list (ranked items), comparison (structured side-by-side), timeline (chronological), summary (concise overview)
- thinkingBudget: 0 (simple fact), 1024 (moderate), 4096 (complex analysis), 8192 (deep multi-source reasoning)
- suggestFollowUp: true if the topic has natural depth to explore further
- confidence: 0-1

Return only the JSON object.`

    const response = await fetchWithRetry(
      `${GEMINI_BASE_URL}/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            maxOutputTokens: 256,
            temperature: 0,
            responseMimeType: 'application/json',
          },
        }),
      },
      1 // Single attempt — speed over reliability for classification
    )

    const data = await response.json() as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
    }

    const text = data.candidates?.[0]?.content?.parts?.[0]?.text
    if (!text) {
      console.warn('[classifier] Empty response, using default')
      return DEFAULT_CLASSIFICATION
    }

    const parsed = JSON.parse(text) as Record<string, unknown>
    return validateClassification(parsed)
  } catch (err) {
    console.warn('[classifier] Classification failed, using default:', err instanceof Error ? err.message : err)
    return DEFAULT_CLASSIFICATION
  }
}

/**
 * Validate and sanitize the raw classifier output.
 * Any missing or invalid field falls back to the default.
 */
function validateClassification(raw: Record<string, unknown>): QueryClassification {
  const validIntents = ['factual', 'analytical', 'comparative', 'exploratory', 'temporal', 'actionable'] as const
  const validFormats = ['prose', 'list', 'comparison', 'timeline', 'summary'] as const
  const validBudgets = [0, 1024, 4096, 8192]

  const intent = validIntents.includes(raw.intent as typeof validIntents[number])
    ? (raw.intent as QueryClassification['intent'])
    : 'analytical'

  const rawRetrieval = typeof raw.retrieval === 'object' && raw.retrieval !== null
    ? (raw.retrieval as Record<string, unknown>)
    : {}

  const chunkCount = typeof rawRetrieval.chunkCount === 'number'
    ? Math.min(20, Math.max(3, Math.round(rawRetrieval.chunkCount)))
    : 15
  const traversalHops = typeof rawRetrieval.traversalHops === 'number'
    ? Math.min(3, Math.max(1, Math.round(rawRetrieval.traversalHops)))
    : 2

  const responseFormat = validFormats.includes(raw.responseFormat as typeof validFormats[number])
    ? (raw.responseFormat as QueryClassification['responseFormat'])
    : 'prose'

  const rawBudget = typeof raw.thinkingBudget === 'number' ? raw.thinkingBudget : 1024
  // Snap to nearest valid budget
  const thinkingBudget = validBudgets.reduce((prev, curr) =>
    Math.abs(curr - rawBudget) < Math.abs(prev - rawBudget) ? curr : prev
  )

  return {
    intent,
    retrieval: {
      chunkCount,
      traversalHops,
      prioritiseRecency: typeof rawRetrieval.prioritiseRecency === 'boolean' ? rawRetrieval.prioritiseRecency : false,
      needsBroadSearch: typeof rawRetrieval.needsBroadSearch === 'boolean' ? rawRetrieval.needsBroadSearch : false,
    },
    responseFormat,
    thinkingBudget,
    suggestFollowUp: typeof raw.suggestFollowUp === 'boolean' ? raw.suggestFollowUp : true,
    confidence: typeof raw.confidence === 'number' ? Math.min(1, Math.max(0, raw.confidence)) : 0,
  }
}

/**
 * Maps classifier intent to the closest existing mindset for promptAddition.
 * (PRD-C §2.7)
 */
export function mapIntentToMindset(intent: QueryClassification['intent']): 'factual' | 'analytical' | 'comparative' | 'exploratory' {
  switch (intent) {
    case 'factual': return 'factual'
    case 'analytical': return 'analytical'
    case 'comparative': return 'comparative'
    case 'exploratory':
    case 'temporal':
    case 'actionable':
      return 'exploratory'
  }
}
