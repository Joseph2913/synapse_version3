export type EntityType =
  | 'Person' | 'Organization' | 'Team' | 'Topic' | 'Project'
  | 'Goal' | 'Action' | 'Risk' | 'Blocker' | 'Decision'
  | 'Insight' | 'Question' | 'Idea' | 'Concept' | 'Takeaway'
  | 'Lesson' | 'Document' | 'Event' | 'Location' | 'Technology'
  | 'Product' | 'Metric' | 'Hypothesis' | 'Anchor'

export type SourceType = 'Meeting' | 'YouTube' | 'Research' | 'Note' | 'Document' | 'GitHub'

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
  match_type:  'exact' | 'fuzzy' | 'semantic' | null
  metadata:    Record<string, unknown> | null
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
  embedding?: number[] | null
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
  onboarding_complete: boolean
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

// ─── knowledge_skills (PRD-Skills-A) ─────────────────────────────────────────

export type SkillStatus = 'draft' | 'active' | 'archived'

export interface KnowledgeSkill {
  id: string
  user_id: string
  name: string
  title: string
  description: string
  domain: string | null
  tags: string[]
  content: string
  source_ids: string[]
  source_count: number
  confidence: number
  instructional_ratio: number | null
  generalizability: number | null
  structural_density: number | null
  status: SkillStatus
  embedding: number[] | null
  usage_count: number
  last_used_at: string | null
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

// ─── Advisory Council ───────────────────────────────────────────────────────

export type HealthStatus = 'initialising' | 'thin' | 'growing' | 'strong' | 'stale'

export interface DomainAgent {
  id: string
  user_id: string
  playlist_id: string | null
  name: string
  description: string | null
  reasoning_style: string | null
  expertise_index: Record<string, unknown>
  awareness_register: Record<string, unknown>
  health_status: HealthStatus
  linked_anchor_ids: string[]
  source_count: number
  entity_count: number
  last_ingestion_at: string | null
  last_index_rebuild_at: string | null
  index_stale: boolean
  is_active: boolean
  created_at: string
  updated_at: string
}

export interface DomainAgentSource {
  id: string
  user_id: string
  agent_id: string
  source_id: string
  association_type: 'primary' | 'associated' | 'cross_domain'
  created_at: string
}

export interface AgentStandingQuestion {
  id: string
  user_id: string
  agent_id: string
  question: string
  question_type: 'gap_driven' | 'frontier' | 'cross_domain' | 'user_defined'
  status: 'open' | 'partially_addressed' | 'answered' | 'dismissed'
  priority: number
  trigger_description: string | null
  trigger_source_id: string | null
  addressing_source_ids: string[] | null
  addressing_evidence: import('./council').AddressingEvidenceEntry[] | null
  generated_at: string
  status_changed_at: string | null
  created_at: string
}

export interface AgentInsightRow {
  id: string
  user_id: string
  agent_id: string
  insight_type: 'tension' | 'convergence' | 'novel_connection'
  claim: string
  evidence_summary: string | null
  trigger_source_id: string | null
  related_source_ids: string[]
  related_entity_ids: string[]
  related_edge_ids: string[]
  confidence: number | null
  status: 'active' | 'promoted' | 'dismissed' | 'superseded'
  promoted_to: string | null
  created_at: string
}

export interface AgentGapRow {
  id: string
  user_id: string
  agent_id: string
  gap_type: 'structural' | 'orphan' | 'recency'
  topic: string
  description: string | null
  severity: 'minor' | 'moderate' | 'significant'
  content_suggestion: string | null
  related_entity_ids: string[]
  status: 'active' | 'filling' | 'resolved' | 'dismissed'
  resolved_by_source_id: string | null
  created_at: string
  updated_at: string
}

export interface AgentSignalRow {
  id: string
  user_id: string
  source_agent_id: string
  target_agent_id: string
  trigger_source_id: string | null
  bridge_entity_ids: string[]
  bridge_edge_id: string | null
  reason: string
  status: 'pending' | 'processing' | 'acknowledged' | 'extracted' | 'dismissed'
  processing_result: string | null
  extracted_entity_ids: string[]
  processed_at: string | null
  created_at: string
}
