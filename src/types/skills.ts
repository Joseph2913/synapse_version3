// ─── Skills UI types (PRD-Skills-E) ──────────────────────────────────────────

export type KnowledgeSkillStatus = 'draft' | 'active' | 'archived'

export interface KnowledgeSkillListItem {
  id: string
  name: string
  title: string
  description: string
  domain: string | null
  tags: string[]
  confidence: number
  source_count: number
  status: KnowledgeSkillStatus
  usage_count: number
  last_used_at: string | null
  created_at: string
  updated_at: string
}

export interface KnowledgeSkillDetail extends KnowledgeSkillListItem {
  content: string
  source_ids: string[]
  instructional_ratio: number | null
  generalizability: number | null
  structural_density: number | null
  anchor_relevance: number | null
}

export interface KnowledgeSkillSource {
  id: string
  title: string
  source_type: string
  created_at: string
}

export type SkillSortOption = 'confidence' | 'updated' | 'created' | 'sources' | 'usage' | 'size' | 'alpha'
