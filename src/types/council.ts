// Types for the Council Weekly Digest (Home view).
// Matches the JSON shape returned by the `get_council_digest` Postgres RPC.

export interface CouncilDigestSummary {
  insights_count: number
  questions_count: number
  gaps_count: number
  active_agents_count: number
  window_days: number
}

export interface CouncilDigestTension {
  id: string
  agent_id: string
  agent_name: string
  claim: string
  evidence_summary: string | null
  confidence: number | null
  created_at: string
}

export interface CouncilDigestQuestion {
  id: string
  agent_id: string
  agent_name: string
  question: string
  priority: number | null
  created_at: string
}

export type CouncilGapSeverity = 'minor' | 'moderate' | 'significant'
export type CouncilGapType = 'structural' | 'orphan' | 'recency' | 'demand'

export interface CouncilDigestGap {
  id: string
  agent_id: string
  agent_name: string
  topic: string
  description: string | null
  severity: CouncilGapSeverity
  gap_type: CouncilGapType
  created_at: string
}

export interface CouncilDigestAgentSummary {
  agent_id: string
  agent_name: string
  health_status: string
  new_insights: number
  new_questions: number
  new_gaps: number
}

export interface CouncilDigestRecentlyAnswered {
  id: string
  agent_id: string
  agent_name: string
  question: string
  question_type: 'gap_driven' | 'frontier' | 'cross_domain' | 'user_defined'
  status: 'answered' | 'partially_addressed'
  status_changed_at: string
  addressing_source_ids: string[] | null
  addressing_evidence: AddressingEvidenceEntry[] | null
}

export interface CouncilDigest {
  summary: CouncilDigestSummary
  top_tensions: CouncilDigestTension[]
  top_frontier_questions: CouncilDigestQuestion[]
  top_gaps: CouncilDigestGap[]
  active_agents: CouncilDigestAgentSummary[]
  recently_answered_questions: CouncilDigestRecentlyAnswered[]
}

// ─── Phase 0 (pull-based answer check) ──────────────────────────────────────

export type QuestionVerdict = 'answered' | 'partially_addressed' | 'no_real_answer'

export interface AddressingEvidenceEntry {
  source_id: string | null
  verdict: QuestionVerdict | 'legacy'
  snippet: string
  confidence: number | null
  checked_at: string | null
  legacy?: boolean
}

export interface PullCandidateRow {
  question_id: string
  question_text: string
  question_type: 'gap_driven' | 'frontier' | 'cross_domain' | 'user_defined'
  question_status: 'open' | 'partially_addressed'
  existing_addressing_source_ids: string[]
  source_id: string
  chunk_id: string
  chunk_content: string
  similarity: number
  source_primary_agent_ids: string[]
}

export interface CouncilCronPhase0Counts {
  agents_scanned: number
  questions_checked: number
  questions_answered: number
  questions_partially_addressed: number
  novel_connections_written: number
  gemini_calls: number
  duration_ms: number
}

export interface CouncilCronPhaseCounts {
  phase0?: CouncilCronPhase0Counts
}

export interface CouncilCronRun {
  id: string
  started_at: string
  finished_at: string | null
  status: 'running' | 'ok' | 'partial_failure' | 'failed'
  phase_counts: CouncilCronPhaseCounts
  error: string | null
}
