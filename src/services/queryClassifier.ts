/**
 * PRD-C §2.2: Auto-Classification Pre-Pass
 *
 * Lightweight classification call that runs before the full RAG pipeline.
 * Takes the user's question (and optional entry context) and returns a
 * structured intent classification.
 */

import { callApi } from './apiClient'

/** Retrieval type determines which search strategy to use (PRD-RAG-01) */
export type RetrievalType = 'factual' | 'relational' | 'synthesis'

export interface QueryClassification {
  /** Detected intent type */
  intent: 'factual' | 'analytical' | 'comparative' | 'exploratory' | 'temporal' | 'actionable'

  /** Retrieval routing type — drives search strategy (PRD-RAG-01) */
  retrievalType: RetrievalType

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
  retrievalType: 'factual',
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

// ─── PRD-RAG-01: Heuristic Retrieval Type Detection ────────────────────────

const RELATIONAL_PATTERNS = [
  /how\s+(does|do|did|is|are|was|were)\s+.+\s+(relate|connect|link|impact|affect|influence|support|block|enable)/i,
  /relationship\s+between/i,
  /connection\s+between/i,
  /how\s+.+\s+and\s+.+\s+(relate|connect|interact)/i,
  /what('s|\s+is)\s+the\s+(link|connection|relationship|relation)\s+between/i,
  /does\s+.+\s+(support|block|enable|contradict|prevent)\s+/i,
]

const SYNTHESIS_PATTERNS = [
  /what\s+do\s+I\s+know\s+about/i,
  /summarise|summarize|overview|summary\s+of/i,
  /how\s+has\s+.+\s+evolved/i,
  /everything\s+(about|related|regarding)/i,
  /compare\s+.+\s+(and|with|to|versus|vs)/i,
  /what\s+are\s+(the\s+)?(key|main|major)\s+(themes|topics|points|takeaways)/i,
  /across\s+(all\s+)?(my\s+)?(sources|meetings|documents)/i,
  /brief\s+me\s+on/i,
  /what\s+do\s+we\s+know/i,
]

const FACTUAL_PATTERNS = [
  /what\s+did\s+\w+\s+say/i,
  /when\s+(did|was|were|is)/i,
  /who\s+(said|mentioned|proposed|decided|created|leads|owns)/i,
  /what\s+is\s+the\s+(status|deadline|date|cost|price|number)/i,
  /how\s+many/i,
  /what\s+(exactly|specifically)/i,
  /quote\s+(from|about)/i,
]

/**
 * Fast heuristic retrieval type detection (PRD-RAG-01 Tier 1).
 * Returns null if no pattern matches confidently (triggers Gemini fallback).
 */
export function detectRetrievalTypeHeuristic(query: string): RetrievalType | null {
  for (const pattern of RELATIONAL_PATTERNS) {
    if (pattern.test(query)) return 'relational'
  }
  for (const pattern of SYNTHESIS_PATTERNS) {
    if (pattern.test(query)) return 'synthesis'
  }
  for (const pattern of FACTUAL_PATTERNS) {
    if (pattern.test(query)) return 'factual'
  }
  return null
}

/**
 * Derives retrieval type from Gemini's intent classification (PRD-RAG-01 Tier 2).
 */
function intentToRetrievalType(intent: QueryClassification['intent']): RetrievalType {
  switch (intent) {
    case 'factual':
    case 'actionable':
      return 'factual'
    case 'comparative':
      return 'relational'
    case 'exploratory':
    case 'temporal':
      return 'synthesis'
    case 'analytical':
      return 'factual' // safe default — analytical queries benefit from precise retrieval
  }
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
  // PRD-RAG-01: Try heuristic retrieval type detection first (fast, no API call)
  const heuristicRetrievalType = detectRetrievalTypeHeuristic(question)

  try {
    const { text } = await callApi<{ text: string }>('/api/gemini/classify-query', {
      question,
      conversationContext,
    })

    if (!text) {
      console.warn('[classifier] Empty response, using default')
      const fallback = { ...DEFAULT_CLASSIFICATION }
      if (heuristicRetrievalType) fallback.retrievalType = heuristicRetrievalType
      return fallback
    }

    // Clean Gemini output: strip BOM, invisible chars, markdown fences
    let cleanedText = text.trim()
      .replace(/^\uFEFF/, '')             // BOM
      .replace(/^[\x00-\x1F]+/, '')       // control chars before JSON
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/i, '')
    // If text doesn't start with {, find the first {
    if (!cleanedText.startsWith('{')) {
      const braceStart = cleanedText.indexOf('{')
      if (braceStart >= 0) cleanedText = cleanedText.slice(braceStart)
    }
    console.debug('[classifier] Cleaned response:', cleanedText.slice(0, 100))
    const parsed = JSON.parse(cleanedText) as Record<string, unknown>
    const classification = validateClassification(parsed)

    // PRD-RAG-01: Heuristic retrieval type takes priority when available
    // (regex patterns are highly specific and more reliable than Gemini for routing)
    if (heuristicRetrievalType) {
      classification.retrievalType = heuristicRetrievalType
    }

    return classification
  } catch (err) {
    console.warn('[classifier] Classification failed, using default:', err instanceof Error ? err.message : err)
    const fallback = { ...DEFAULT_CLASSIFICATION }
    if (heuristicRetrievalType) {
      fallback.retrievalType = heuristicRetrievalType
    }
    return fallback
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
    retrievalType: intentToRetrievalType(intent),
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
