export type EntityType =
  | 'Person' | 'Organization' | 'Team' | 'Topic' | 'Project'
  | 'Goal' | 'Action' | 'Risk' | 'Blocker' | 'Decision'
  | 'Insight' | 'Question' | 'Idea' | 'Concept' | 'Takeaway'
  | 'Lesson' | 'Document' | 'Event' | 'Location' | 'Technology'
  | 'Product' | 'Metric' | 'Hypothesis' | 'Anchor'

export type SourceType = 'Meeting' | 'YouTube' | 'Research' | 'Note' | 'Document'

export type RelationType =
  | 'leads_to' | 'supports' | 'blocks' | 'depends_on' | 'part_of'
  | 'authored' | 'mentions' | 'conflicts_with' | 'relates_to' | 'enables'
  | 'created' | 'achieved' | 'produced' | 'contradicts' | 'risks'
  | 'prevents' | 'challenges' | 'inhibits' | 'connected_to' | 'owns'
  | 'associated_with'

export interface KnowledgeNode {
  id: string
  user_id: string
  label: string
  entity_type: EntityType
  description?: string | null
  confidence?: number | null
  is_anchor: boolean
  source?: string | null
  source_type?: SourceType | null
  source_url?: string | null
  source_id?: string | null
  tags?: string[] | null
  user_tags?: string[] | null
  quote?: string | null
  merged_into_node_id?: string | null
  is_merged?: boolean
  parent_anchor_id?: string | null
  created_at: string
}

export interface PotentialDuplicateRow {
  id:          string
  user_id:     string
  node_a_id:   string
  node_b_id:   string
  similarity:  number
  detected_at: string
  status:      'pending' | 'merged' | 'kept_separate' | 'auto_resolved'
  resolved_at: string | null
  resolved_by: string | null
}

export interface KnowledgeEdge {
  id: string
  user_id: string
  source_node_id: string
  target_node_id: string
  relation_type?: RelationType | null
  evidence?: string | null
  weight?: number | null
  created_at: string
}

export interface KnowledgeSource {
  id: string
  user_id: string
  title?: string | null
  content?: string | null
  source_type?: string | null
  source_url?: string | null
  metadata?: Record<string, unknown> | null
  summary?: string | null
  summary_source?: string | null // 'extracted' | 'generated' | 'user' | 'truncated'
  created_at: string
}

export interface UserProfile {
  id: string
  user_id: string
  professional_context: { role?: string; industry?: string; current_projects?: string }
  personal_interests: { topics?: string; learning_goals?: string }
  processing_preferences: { insight_depth?: string; relationship_focus?: string }
  created_at: string
  updated_at: string
}

export interface ExtractionSettings {
  id: string
  user_id: string
  default_mode: 'comprehensive' | 'strategic' | 'actionable' | 'relational'
  default_anchor_emphasis: 'passive' | 'standard' | 'aggressive'
  settings: Record<string, unknown>
  created_at: string
  updated_at: string
}

// ─── anchor_candidates (PRD-17) ───────────────────────────────────────────────

export interface AnchorCandidateRow {
  id:                    string
  user_id:               string
  node_id:               string | null
  composite_score:       number
  centrality_score:      number
  diversity_score:       number
  velocity_score:        number
  richness_score:        number
  behavioural_score:     number
  mention_count:         number
  source_count:          number
  unique_source_types:   number
  days_active:           number
  recent_velocity:       number
  velocity_direction:    'rising' | 'stable' | 'falling'
  status:                'pending' | 'suggested' | 'confirmed' | 'dismissed' | 'archived' | 'dormant'
  scoring_profile:       'balanced' | 'emerging_topics' | 'deep_concepts' | 'active_focus' | 'well_evidenced'
  reasoning_text:        string | null
  first_scored_at:       string
  last_scored_at:        string
  suggested_at:          string | null
  reviewed_at:           string | null
  dormant_since:         string | null
  dismiss_count:         number
  resurface_after:       string | null
  threshold_at_scoring:  number | null
  total_edges:           number
  suggested_parent_anchor_id: string | null
  created_at:            string
  updated_at:            string
}
