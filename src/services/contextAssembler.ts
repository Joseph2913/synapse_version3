/**
 * PRD-RAG-01: Type-Specific Context Assembly
 *
 * Builds the final context window for Gemini generation, with different
 * assembly logic per retrieval type (factual, relational, synthesis).
 *
 * Factual: reranked chunks + minimal entity summaries
 * Relational: matched relationships (with evidence) + supporting chunks + paths
 * Synthesis: reranked chunks + chronological entity evolution + relationship context
 */

import type { RankedCandidate } from './reranker'
import type { RelationshipMatch } from './supabase'
import { fetchEntitySourceMentions } from './supabase'
import type { RetrievalType } from './queryClassifier'

// ─── Helpers ─────────────────────────────────────────────────────────────────

interface EntityFrequency {
  label: string
  count: number
}

/**
 * Count entity label occurrences across ranked candidates.
 * Uses entity_labels from candidate metadata when available.
 */
function countEntityMentionsInCandidates(candidates: RankedCandidate[]): EntityFrequency[] {
  const counts = new Map<string, number>()

  for (const candidate of candidates) {
    if (candidate.metadata?.entity_labels) {
      for (const label of candidate.metadata.entity_labels) {
        counts.set(label, (counts.get(label) ?? 0) + 1)
      }
    }
  }

  return Array.from(counts.entries())
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count)
}

/**
 * Extract a text excerpt centred around the first mention of a term.
 */
function extractExcerptAroundMention(
  chunkContent: string,
  entityLabel: string,
  maxLength: number = 200
): string {
  const lowerContent = chunkContent.toLowerCase()
  const lowerLabel = entityLabel.toLowerCase()
  const index = lowerContent.indexOf(lowerLabel)

  if (index === -1) {
    return chunkContent.slice(0, maxLength) + (chunkContent.length > maxLength ? '...' : '')
  }

  const halfWindow = Math.floor((maxLength - entityLabel.length) / 2)
  const start = Math.max(0, index - halfWindow)
  const end = Math.min(chunkContent.length, index + entityLabel.length + halfWindow)

  let excerpt = chunkContent.slice(start, end)
  if (start > 0) excerpt = '...' + excerpt
  if (end < chunkContent.length) excerpt = excerpt + '...'

  return excerpt
}

// ─── Assembly Functions ──────────────────────────────────────────────────────

/**
 * Factual context: reranked chunks with source info. Concise.
 */
function assembleFactualContext(
  rankedChunks: RankedCandidate[]
): string {
  const parts: string[] = ['## Retrieved Source Passages\n']

  for (const chunk of rankedChunks) {
    const sourceInfo = chunk.metadata?.source_title
      ? ` (from: ${chunk.metadata.source_title})`
      : ''
    parts.push(`${chunk.text}${sourceInfo}\n`)
  }

  return parts.join('\n')
}

/**
 * Relational context: relationships first, then supporting chunks.
 */
function assembleRelationalContext(
  rankedChunks: RankedCandidate[],
  relationships: RelationshipMatch[]
): string {
  const parts: string[] = []

  if (relationships.length > 0) {
    parts.push('## Key Relationships\n')
    for (const rel of relationships) {
      parts.push(`- ${rel.source_label} (${rel.source_type}) ${rel.relation_type} ${rel.target_label} (${rel.target_type})`)
      if (rel.evidence) {
        parts.push(`  Evidence: ${rel.evidence}`)
      }
    }
    parts.push('')
  }

  if (rankedChunks.length > 0) {
    parts.push('## Supporting Source Passages\n')
    for (const chunk of rankedChunks) {
      const sourceInfo = chunk.metadata?.source_title
        ? ` (from: ${chunk.metadata.source_title})`
        : ''
      parts.push(`${chunk.text}${sourceInfo}\n`)
    }
  }

  return parts.join('\n')
}

/**
 * Synthesis context: reranked chunks + relationships + chronological entity evolution.
 * The chronological section shows how key entities were discussed across sources over time.
 */
async function assembleSynthesisContext(
  rankedChunks: RankedCandidate[],
  relationships: RelationshipMatch[],
  userId: string
): Promise<string> {
  const parts: string[] = []

  // Part 1: Top reranked chunks
  parts.push('## Retrieved Source Passages\n')
  for (const chunk of rankedChunks) {
    const sourceInfo = chunk.metadata?.source_title
      ? ` (from: ${chunk.metadata.source_title})`
      : ''
    parts.push(`${chunk.text}${sourceInfo}\n`)
  }

  // Part 2: Relationship context
  if (relationships.length > 0) {
    parts.push('\n## Key Relationships\n')
    for (const rel of relationships) {
      parts.push(`- ${rel.source_label} ${rel.relation_type} ${rel.target_label}`)
      if (rel.evidence) {
        parts.push(`  Evidence: ${rel.evidence}`)
      }
    }
  }

  // Part 3: Chronological entity evolution (synthesis-only enrichment)
  const entityFrequency = countEntityMentionsInCandidates(rankedChunks)
  const topEntities = entityFrequency.slice(0, 5)

  if (topEntities.length > 0) {
    const entitySections: string[] = []

    // Fetch mentions for all entities in parallel, with 3s timeout
    const mentionResults = await Promise.all(
      topEntities.map(entity =>
        Promise.race([
          fetchEntitySourceMentions(entity.label, userId, 5),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('timeout')), 3000)
          ),
        ]).catch(() => [])
      )
    )

    for (let i = 0; i < topEntities.length; i++) {
      const entity = topEntities[i]!
      const mentions = mentionResults[i]

      // Only include if multi-source (otherwise no evolution to show)
      if (!Array.isArray(mentions) || mentions.length <= 1) continue

      const lines: string[] = [`\n### ${entity.label}\n`]
      for (const mention of mentions) {
        const date = new Date(mention.source_created_at).toLocaleDateString('en-GB', {
          day: 'numeric', month: 'short', year: 'numeric',
        })
        const excerpt = extractExcerptAroundMention(mention.chunk_content, entity.label, 200)
        lines.push(`**${mention.source_title}** (${date}, ${mention.source_type}):`)
        lines.push(`> ${excerpt}\n`)
      }
      entitySections.push(lines.join('\n'))
    }

    if (entitySections.length > 0) {
      parts.push('\n## Entity Evolution Across Sources\n')
      parts.push('The following shows how key entities were discussed across sources over time:\n')
      parts.push(...entitySections)
    }
  }

  return parts.join('\n')
}

// ─── Token Budget Enforcement ────────────────────────────────────────────────

const MAX_CONTEXT_TOKENS = 8000  // ~32,000 chars at 4 chars/token
const CHARS_PER_TOKEN = 4

function enforceTokenBudget(context: string): string {
  const maxChars = MAX_CONTEXT_TOKENS * CHARS_PER_TOKEN
  if (context.length <= maxChars) return context
  console.warn(`[contextAssembler] Context too long (${context.length} chars), truncating to ${maxChars}`)
  return context.slice(0, maxChars) + '\n\n[Context truncated due to token budget]'
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Assembles the final context string for Gemini generation, using the
 * appropriate strategy for the given retrieval type.
 */
export async function assembleContext(
  retrievalType: RetrievalType,
  rankedChunks: RankedCandidate[],
  relationships: RelationshipMatch[],
  userId: string
): Promise<string> {
  let context: string

  switch (retrievalType) {
    case 'synthesis':
      context = await assembleSynthesisContext(rankedChunks, relationships, userId)
      break
    case 'relational':
      context = assembleRelationalContext(rankedChunks, relationships)
      break
    case 'factual':
    default:
      context = assembleFactualContext(rankedChunks)
      break
  }

  return enforceTokenBudget(context)
}

/**
 * Returns type-specific generation guidance for the Gemini system prompt.
 */
export function getTypeGuidance(retrievalType: RetrievalType): string {
  switch (retrievalType) {
    case 'factual':
      return 'Answer the question directly and specifically. Cite the exact source where you found the information. If the answer is a specific quote, data point, or fact, state it clearly. Be concise.'
    case 'relational':
      return 'Explain the relationship between the concepts mentioned in the question. Describe how they connect, support, or influence each other. Reference the evidence for each relationship. Structure your answer around the connections, not just the individual concepts.'
    case 'synthesis':
      return 'Provide a comprehensive overview that synthesises information across multiple sources. Where the context includes chronological entity evolution, describe how understanding or positioning has developed over time. Highlight patterns, contradictions, and connections across sources. Be thorough but organised.'
  }
}
