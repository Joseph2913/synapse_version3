import type { UserProfile } from './database'

// --- Pipeline Step States ---

export type ExtractionStep =
  | 'idle'
  | 'saving_source'
  | 'summarizing'
  | 'composing_prompt'
  | 'extracting'
  | 'reviewing'
  | 'saving_nodes'
  | 'generating_embeddings'
  | 'chunking_source'
  | 'discovering_connections'
  | 'complete'
  | 'error'

// --- Extraction Configuration ---

export interface ExtractionConfig {
  mode: 'comprehensive' | 'strategic' | 'actionable' | 'relational'
  anchorEmphasis: 'passive' | 'standard' | 'aggressive'
  anchors: Array<{ label: string; entity_type: string; description: string }>
  userProfile: UserProfile | null
  customGuidance?: string
}

export interface SourceMetadata {
  title?: string
  sourceType: string
  sourceUrl?: string
}

// --- Gemini Response Types ---

export interface ExtractedEntity {
  label: string
  entity_type: string
  description: string
  confidence: number
  tags: string[]
}

export interface ExtractedRelationship {
  source: string
  target: string
  relation_type: string
  evidence: string
}

export interface ExtractionResult {
  entities: ExtractedEntity[]
  relationships: ExtractedRelationship[]
  rawResponse: string
}

// --- Review UI Types ---

export interface ReviewEntity extends ExtractedEntity {
  removed: boolean
  edited: boolean
}

// --- Persistence Types ---

export interface SavedNode {
  id: string
  label: string
  entity_type: string
  embedding?: number[]
}

export interface DiscoveredEdge {
  sourceNodeId: string
  targetNodeId: string
  relationType: string
  evidence: string
  weight: number
}

// --- Pipeline State ---

export interface PipelineState {
  step: ExtractionStep
  entities: ReviewEntity[] | null
  relationships: ExtractedRelationship[] | null
  sourceId: string | null
  savedNodes: SavedNode[] | null
  savedEdgeIds: string[] | null
  crossConnectionCount: number
  error: Error | null
  elapsedMs: number
  embeddingProgress: { completed: number; total: number } | null
  statusText: string
  duplicatesSkipped: number
  nearDuplicates: Array<{
    incomingLabel:  string
    incomingType:   string
    existingNodeId: string
    existingLabel:  string
    similarity:     number
  }> | null
  reusedNodeCount: number
}

export interface UseExtractionReturn {
  state: PipelineState
  start: (content: string, config: ExtractionConfig, metadata: SourceMetadata) => Promise<void>
  approveAndSave: (reviewedEntities: ReviewEntity[]) => Promise<void>
  reExtract: () => Promise<void>
  reset: () => void
}

// --- History Tab Types ---

export interface ExtractionSession {
  id: string
  source_name: string | null
  source_type: string | null
  source_content_preview: string | null
  extraction_mode: string
  anchor_emphasis: string
  user_guidance: string | null
  selected_anchor_ids: string[] | null
  entity_count: number
  relationship_count: number
  extraction_duration_ms: number | null
  feedback_rating: number | null
  feedback_text: string | null
  created_at: string
}
