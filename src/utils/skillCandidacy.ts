/**
 * Shared candidacy gate function for skill candidate detection.
 * Used by the ingestion pipeline (useExtraction hook) to tag sources
 * at ingestion time.
 *
 * PRD: PRD-25b — Skill Detection Infrastructure
 */

const SOURCE_TYPE_SCORES: Record<string, number> = {
  YouTube: 1.0,
  Document: 0.7,
  Research: 0.7,
  Meeting: 0.4,
  Note: 0.2,
  Web: 0.5,
}

const INSTRUCTIONAL_TYPES = new Set([
  'Topic', 'Technology', 'Concept', 'Insight',
  'Idea', 'Hypothesis', 'Lesson', 'Takeaway',
])

export interface CandidacyChecks {
  sourceTypeScore: number
  instructionalRatio: number
  chunkCount: number
  check1Pass: boolean
  check2Pass: boolean
  check3Pass: boolean
  passCount: number
}

export interface CandidacyResult {
  isCandidate: boolean
  checks: CandidacyChecks
}

export function evaluateCandidacy(
  sourceType: string,
  extractedEntityTypes: string[],
  chunkCount: number,
): CandidacyResult {
  const check1 = SOURCE_TYPE_SCORES[sourceType] ?? 0.3
  const check1Pass = check1 >= 0.5

  const totalEntities = extractedEntityTypes.length
  const instructionalCount = extractedEntityTypes.filter(t => INSTRUCTIONAL_TYPES.has(t)).length
  const instructionalRatio = totalEntities > 0 ? instructionalCount / totalEntities : 0
  const check2Pass = instructionalRatio >= 0.35

  const check3Pass = chunkCount >= 3

  const passCount = [check1Pass, check2Pass, check3Pass].filter(Boolean).length
  const isCandidate = passCount >= 2

  return {
    isCandidate,
    checks: {
      sourceTypeScore: check1,
      instructionalRatio: Math.round(instructionalRatio * 100) / 100,
      chunkCount,
      check1Pass,
      check2Pass,
      check3Pass,
      passCount,
    },
  }
}
