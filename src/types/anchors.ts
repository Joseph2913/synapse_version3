import type { EntityType } from './database'

// ─── Lifecycle Status ─────────────────────────────────────────────────────────

export type AnchorCandidateStatus =
  | 'pending'     // Scored; not yet surfaced to user
  | 'suggested'   // Visible on Anchors page; awaiting user review
  | 'confirmed'   // User confirmed; is_anchor = true on knowledge_nodes
  | 'dismissed'   // User dismissed; respects resurface_after cooldown
  | 'archived'    // User archived a confirmed anchor
  | 'dormant'     // Confirmed anchor inactive beyond dormant threshold

// ─── Scoring Profile ──────────────────────────────────────────────────────────

export type AnchorScoringProfile =
  | 'balanced'        // Default equal weighting
  | 'emerging_topics' // High velocity weight
  | 'deep_concepts'   // High centrality + richness weight
  | 'active_focus'    // High recency multiplier
  | 'well_evidenced'  // High diversity weight

export const SCORING_PROFILE_LABELS: Record<AnchorScoringProfile, string> = {
  balanced:        'Balanced',
  emerging_topics: 'Emerging Topics',
  deep_concepts:   'Deep Concepts',
  active_focus:    'Active Focus',
  well_evidenced:  'Well Evidenced',
}

export const SCORING_PROFILE_DESCRIPTIONS: Record<AnchorScoringProfile, string> = {
  balanced:        'Equal weighting across all signals. Best starting point.',
  emerging_topics: 'Surfaces concepts that are rising quickly in your recent content.',
  deep_concepts:   'Surfaces structurally important hubs with rich relationship patterns.',
  active_focus:    'Surfaces what you have been actively working on recently.',
  well_evidenced:  'Surfaces concepts supported by multiple independent sources.',
}

// ─── Signal weights per profile ───────────────────────────────────────────────
// Used by the scoring engine (PRD-18) to compute composite_score.
// Weights must sum to 1.0 for each profile.

export interface SignalWeights {
  centrality:   number  // Betweenness + degree centrality
  diversity:    number  // Source count × source type diversity
  velocity:     number  // Recency + acceleration
  richness:     number  // Unique relationship types × avg weight
  behavioural:  number  // Reserved for Phase 2; always 0 for now
}

export const SIGNAL_WEIGHTS_BY_PROFILE: Record<AnchorScoringProfile, SignalWeights> = {
  balanced: {
    centrality: 0.35, diversity: 0.25, velocity: 0.20, richness: 0.15, behavioural: 0.05,
  },
  emerging_topics: {
    centrality: 0.15, diversity: 0.15, velocity: 0.55, richness: 0.10, behavioural: 0.05,
  },
  deep_concepts: {
    centrality: 0.45, diversity: 0.15, velocity: 0.10, richness: 0.25, behavioural: 0.05,
  },
  active_focus: {
    centrality: 0.20, diversity: 0.20, velocity: 0.45, richness: 0.10, behavioural: 0.05,
  },
  well_evidenced: {
    centrality: 0.25, diversity: 0.50, velocity: 0.10, richness: 0.10, behavioural: 0.05,
  },
}

// ─── Velocity Direction ───────────────────────────────────────────────────────

export type VelocityDirection = 'rising' | 'stable' | 'falling'

// ─── Core Candidate Interface ─────────────────────────────────────────────────
// Matches the anchor_candidates table shape with camelCase field names.

export interface AnchorCandidate {
  id:                  string
  userId:              string
  nodeId:              string | null

  // Scores
  compositeScore:      number
  centralityScore:     number
  diversityScore:      number
  velocityScore:       number
  richnessScore:       number
  behaviouralScore:    number

  // Raw signal inputs
  mentionCount:        number
  sourceCount:         number
  uniqueSourceTypes:   number
  daysActive:          number
  recentVelocity:      number
  velocityDirection:   VelocityDirection

  // Lifecycle
  status:              AnchorCandidateStatus
  scoringProfile:      AnchorScoringProfile
  reasoningText:       string | null

  // Timestamps
  firstScoredAt:       string
  lastScoredAt:        string
  suggestedAt:         string | null
  reviewedAt:          string | null
  dormantSince:        string | null

  // Dismissal
  dismissCount:        number
  resurface_after:     string | null

  // Audit
  thresholdAtScoring:  number | null
  totalEdges:          number
  createdAt:           string
  updatedAt:           string

  // PRD-22: hierarchy
  suggestedParentAnchorId: string | null
}

// ─── Candidate with joined node data ─────────────────────────────────────────
// Returned by fetchCandidatesWithNodes() — the primary query for the Anchors page.

export interface AnchorCandidateWithNode extends AnchorCandidate {
  node: {
    id:               string
    label:            string
    entity_type:      EntityType
    description:      string | null
    confidence:       number | null
    is_anchor:        boolean
    parent_anchor_id: string | null
    created_at:       string
  } | null

  // Computed connection stats — joined from knowledge_edges
  connectionCount:     number   // Total edges on the node
  anchorConnections:   number   // Edges to other anchor nodes
}

// ─── User Configuration ───────────────────────────────────────────────────────
// Persisted in user_profiles.processing_preferences.anchor_settings (JSONB).
// Loaded via useSettings(); written by the Anchors page settings panel (PRD-19).

export interface AnchorUserConfig {
  // How often the scoring engine runs
  suggestionFrequency:  'per_extraction' | 'daily' | 'weekly'

  // Score threshold for surfacing a candidate as 'suggested'
  // Maps to UI slider: 'conservative' ≈ 0.72, 'balanced' ≈ 0.60, 'aggressive' ≈ 0.45
  suggestionThreshold:  number

  // Days before an unreviewed 'suggested' candidate auto-reverts to 'pending'
  autoDismissAfterDays: number  // Default: 14, range: 7–30

  // Days of inactivity before a 'confirmed' anchor moves to 'dormant'
  dormantAfterDays:     number  // Default: 60, range: 30–180

  // Days before a dismissed candidate can be re-surfaced
  resurfaceCooldownDays: number  // Default: 30, range: 7–90

  // Which signal weight profile to use
  scoringProfile:       AnchorScoringProfile

  // Auto-archive dormant anchors after additional X days (opt-in)
  autoArchiveDormantAfterDays: number | null  // null = disabled
}

export const DEFAULT_ANCHOR_USER_CONFIG: AnchorUserConfig = {
  suggestionFrequency:         'per_extraction',
  suggestionThreshold:         0.60,
  autoDismissAfterDays:        14,
  dormantAfterDays:            60,
  resurfaceCooldownDays:       30,
  scoringProfile:              'balanced',
  autoArchiveDormantAfterDays: null,
}

// ─── Threshold presets ────────────────────────────────────────────────────────
// Maps to the Conservative / Balanced / Aggressive slider in the UI.

export const THRESHOLD_PRESETS = {
  conservative: 0.72,
  balanced:     0.60,
  aggressive:   0.45,
} as const

export type ThresholdPreset = keyof typeof THRESHOLD_PRESETS

// ─── Upsert payload ───────────────────────────────────────────────────────────
// Shape accepted by upsertAnchorCandidate() in the service layer.
// Used by the scoring engine (PRD-18).

export interface AnchorCandidateUpsert {
  userId:             string
  nodeId:             string
  compositeScore:     number
  centralityScore:    number
  diversityScore:     number
  velocityScore:      number
  richnessScore:      number
  mentionCount:       number
  sourceCount:        number
  uniqueSourceTypes:  number
  daysActive:         number
  recentVelocity:     number
  velocityDirection:  VelocityDirection
  scoringProfile:     AnchorScoringProfile
  reasoningText:      string
  thresholdAtScoring: number
}

// ─── Status update payload ────────────────────────────────────────────────────
// Shape accepted by updateCandidateStatus() in the service layer.

export interface AnchorCandidateStatusUpdate {
  status:          AnchorCandidateStatus
  reviewedAt?:     string   // ISO string; set when user confirms/dismisses
  dormantSince?:   string   // ISO string; set when transitioning to dormant
  resurface_after?: string  // ISO string; set when dismissing
  dismissCount?:   number   // Incremented on dismiss
}

// ─── Anchor health summary ────────────────────────────────────────────────────
// Computed by fetchAnchorHealthSummary(); displayed in the right panel
// default state of the Anchors page (PRD-19).

// ─── Anchor Hierarchy Info (PRD-22) ──────────────────────────────────────────
// Used by AnchorDetailPanel to display parent/child relationships.

export interface AnchorHierarchyInfo {
  parentAnchorId:   string | null
  parentLabel:      string | null
  parentEntityType: string | null
  subAnchors: Array<{
    id:          string
    label:       string
    entityType:  string
    entityCount: number
  }>
}

export const SUGGESTED_PARENT_SIMILARITY_THRESHOLD = 0.85

export interface AnchorHealthSummary {
  totalConfirmed:        number
  totalSuggested:        number
  totalDormant:          number
  avgNodesPerAnchor:     number
  mostConnectedAnchor:   { label: string; nodeCount: number } | null
  isolatedAnchors:       number   // Confirmed anchors with 0 cross-anchor connections
  staleAnchors:          Array<{  // For "Needs Attention" list
    candidateId:  string
    nodeId:       string
    label:        string
    issue:        'isolated' | 'low_nodes' | 'dormant' | 'single_source'
    detail:       string   // Human-readable: "Only 2 nodes" / "No new content in 78 days"
  }>
}
