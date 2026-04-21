import type { SummaryResult } from '../types/summary'
import { fetchWithRetry } from '../services/gemini'
import { stripMarkdown } from './stripMarkdown'

const GEMINI_API_KEY = import.meta.env.VITE_GEMINI_API_KEY
const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models'

// --- Public API ---

export async function resolveSummary(
  sourceType: string | null,
  content: string | null,
  metadata: Record<string, unknown> | null
): Promise<SummaryResult | null> {
  if (!content || content.trim().length === 0) return null

  const wordCount = content.trim().split(/\s+/).length

  // Tier 1: Short content — use as-is
  if (wordCount <= 150) {
    return {
      summary: truncateAsSummary(content, 300),
      source: 'truncated',
    }
  }

  // Tier 2: Structured sources — attempt extraction
  if (sourceType === 'Meeting') {
    const extracted = extractStructuredSummary(content, metadata)
    if (extracted) {
      return { summary: extracted, source: 'extracted' }
    }
  }

  // Tier 3: Check metadata for pre-existing summaries (og:description, abstracts)
  if (metadata) {
    const metaSummary = extractMetadataSummary(metadata)
    if (metaSummary) {
      return { summary: metaSummary, source: 'extracted' }
    }
  }

  // Tier 4: Gemini generation
  const generated = await generateSummary(content, sourceType)
  return { summary: generated, source: 'generated' }
}

// --- Structured Summary Extraction ---

export function extractStructuredSummary(
  content: string,
  metadata: Record<string, unknown> | null
): string | null {
  // 1. Known provider patterns
  const provider = (metadata?.provider as string || '').toLowerCase()
  if (['circleback', 'otter', 'fireflies', 'meetgeek'].includes(provider)) {
    // For known providers, try labelled section first, then preamble
    const labelled = extractLabelledSection(content)
    if (labelled) return labelled
    const preamble = extractPreamble(content)
    if (preamble) return preamble
  }

  // 2. Preamble before first heading
  const preamble = extractPreamble(content)
  if (preamble) return preamble

  // 3. Labelled summary section
  const labelled = extractLabelledSection(content)
  if (labelled) return labelled

  // 4. No structured summary found
  return null
}

// --- Metadata Summary Extraction ---

export function extractMetadataSummary(metadata: Record<string, unknown>): string | null {
  const candidates = [
    metadata.description,
    metadata.og_description,
    metadata.abstract,
    metadata.summary,
    metadata.excerpt,
  ].filter((v): v is string => typeof v === 'string' && v.trim().length > 30)

  const first = candidates[0]
  if (first) {
    return clampSummary(first)
  }
  return null
}

// --- Gemini Summary Generation ---

export async function generateSummary(
  content: string,
  sourceType: string | null
): Promise<string> {
  const truncatedContent = content.length > 8000
    ? content.slice(0, 8000) + '\n\n[Content truncated for summarization]'
    : content

  const sourceLabel = sourceType || 'content'

  const systemPrompt = `You are a concise summarizer. Given a piece of ${sourceLabel.toLowerCase()}, produce a 2–3 sentence summary that describes what this content contains. Rules:
- Be factual and descriptive, not analytical or evaluative.
- Describe the topics covered, not what the reader should take away.
- Use plain, professional language.
- Do not start with "This ${sourceLabel.toLowerCase()}..." — vary your openings.
- Do not reference the format ("this transcript", "this document") — summarize the substance.
- Maximum 300 characters.
- Return ONLY the summary text, no preamble, no quotes, no formatting.`

  try {
    const response = await fetchWithRetry(
      `${GEMINI_BASE_URL}/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: systemPrompt }] },
          contents: [{ parts: [{ text: truncatedContent }] }],
          generationConfig: {
            temperature: 0.2,
            maxOutputTokens: 150,
          },
        }),
      }
    )

    const data = await response.json()
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text

    if (!text || text.trim().length === 0) {
      return truncateAsSummary(content, 300)
    }

    const clamped = clampSummary(text.trim())
    // If Gemini returned something too short, fallback
    if (clamped.length < 20) {
      return truncateAsSummary(content, 300)
    }

    return clamped
  } catch (err) {
    console.warn('[summarize] Gemini summary generation failed:', err)
    return truncateAsSummary(content, 300)
  }
}

// --- Helpers ---

export function clampSummary(text: string, maxLength: number = 350): string {
  const cleaned = stripMarkdown(text).replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim()
  if (cleaned.length <= maxLength) return cleaned

  const truncated = cleaned.slice(0, maxLength)
  const lastPeriod = truncated.lastIndexOf('.')
  const lastQuestion = truncated.lastIndexOf('?')
  const lastExclaim = truncated.lastIndexOf('!')
  const lastBoundary = Math.max(lastPeriod, lastQuestion, lastExclaim)

  if (lastBoundary > maxLength * 0.5) {
    return truncated.slice(0, lastBoundary + 1)
  }
  return truncated.trimEnd() + '...'
}

export function truncateAsSummary(content: string, maxChars: number = 300): string {
  const cleaned = stripMarkdown(content).replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim()
  if (cleaned.length <= maxChars) return cleaned
  return clampSummary(cleaned, maxChars)
}

// --- Internal Heuristics ---

function extractPreamble(content: string): string | null {
  const firstHeadingIndex = content.search(/^#{1,3}\s/m)
  if (firstHeadingIndex > 20) {
    const preamble = content.slice(0, firstHeadingIndex).trim()
    const sentences = preamble.split(/[.!?]+/).filter(s => s.trim().length > 10)
    if (sentences.length >= 1 && sentences.length <= 4 && preamble.length <= 500) {
      return clampSummary(preamble)
    }
  }
  return null
}

function extractLabelledSection(content: string): string | null {
  const summaryHeadingPattern = /^#{1,3}\s*(Summary|Overview|Key Takeaways|Executive Summary|TLDR)\s*$/im
  const match = content.match(summaryHeadingPattern)
  if (match && match.index !== undefined) {
    const afterHeading = content.slice(match.index + match[0].length).trim()
    const nextHeading = afterHeading.search(/^#{1,3}\s/m)
    const sectionBody = nextHeading > 0
      ? afterHeading.slice(0, nextHeading).trim()
      : afterHeading.slice(0, 500).trim()
    if (sectionBody.length > 20) {
      return clampSummary(sectionBody)
    }
  }
  return null
}
