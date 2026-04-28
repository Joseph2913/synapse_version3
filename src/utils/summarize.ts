import type { SummaryResult } from '../types/summary'
import { callApi } from '../services/apiClient'
import { stripMarkdown } from './stripMarkdown'

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
  if (sourceType === 'meeting') {
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
  try {
    const { text } = await callApi<{ text: string }>('/api/gemini/summarize', {
      content,
      sourceType,
    })

    if (!text || text.trim().length === 0) {
      return truncateAsSummary(content, 300)
    }

    const clamped = clampSummary(text.trim())
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
