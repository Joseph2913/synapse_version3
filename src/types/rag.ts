import type { KnowledgeNode, KnowledgeEdge } from './database'
import type { ChatScope } from './chatRouting'

export type RAGPipelineStep =
  | 'embedding'
  | 'semantic_search'
  | 'keyword_search'
  | 'graph_traversal'
  | 'context_assembly'
  | 'generating'

// ─── Query Configuration ──────────────────────────────────────────────────────

export type QueryMindsetId = 'auto' | 'factual' | 'analytical' | 'comparative' | 'exploratory'
export type ToolModeId = 'quick' | 'deep' | 'timeline'
export type ModelTierId = 'fast' | 'thorough'

export interface QueryConfig {
  mindset: QueryMindsetId
  scopeAnchors: string[]     // Array of anchor node IDs (empty = all)
  toolMode: ToolModeId
  modelTier: ModelTierId
  scope?: ChatScope          // Pipeline-level scope constraints (PRD-A)
  systemDirective?: string   // Hidden instruction for Gemini system prompt (PRD-A)
  thinkingBudget?: number    // Gemini 2.5 Flash thinking budget (PRD-C)
  responseFormat?: string    // Response format key from responseFormats.ts (PRD-C)
  skipClassification?: boolean  // Skip query classification (digest modules already have known intent)
  skipDecomposition?: boolean   // Skip query decomposition (digest templates are already focused)
}

export const DEFAULT_QUERY_CONFIG: QueryConfig = {
  mindset: 'auto',
  scopeAnchors: [],
  toolMode: 'deep',
  modelTier: 'thorough',
}

// ─── Chat Messages ────────────────────────────────────────────────────────────

export interface SourceReference {
  index: number            // 1-based source number shown in bibliography
  sourceId: string
  title: string
  sourceType: string
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  citations?: InlineCitation[]
  timestamp: Date
  pipelineDurationMs?: number
  followUp?: {               // PRD-C: suggested follow-up question
    question: string
    label: string
  }
  /** Unique sources used in this response, numbered for the bibliography */
  sourcesUsed?: SourceReference[]
  /** Maps chunk index (from AI) → source index (in sourcesUsed) */
  chunkToSourceIndex?: Record<number, number>
}

// ─── Citations ────────────────────────────────────────────────────────────────

/** Legacy citation type — used internally for citation resolution */
export interface Citation {
  label: string
  entity_type: string
  node_id: string | null
  source_id: string | null
}

/** Inline citation with [N] index for rendering within response text */
export interface InlineCitation {
  index: number               // The [N] number in the response text
  label: string               // Source title or entity label
  entity_type: string         // Entity type for badge styling
  node_id: string | null      // Link to knowledge_nodes
  source_id: string | null    // Link to knowledge_sources
  chunk_index: number | null  // Which chunk within the source
  snippet?: string            // First ~120 chars of chunk content (for tooltip)
}

// ─── Source / Node types ──────────────────────────────────────────────────────

export interface SourceChunkResult {
  id: string
  source_id: string
  chunk_index: number
  content: string
  similarity: number
  sourceTitle?: string
  sourceType?: string
  sourceCreatedAt?: string
}

export interface EnrichedChunk {
  id: string
  source_id: string
  content: string
  similarity: number
  sourceTitle: string
  sourceType: string
  sourceCreatedAt: string
  sourceSummary?: string | null
}

export interface NodeSummary {
  id: string
  label: string
  entity_type: string
  description: string | null
}

export interface RelationshipPath {
  from: string
  relation: string
  to: string
  evidence?: string
}

// ─── RAG Context ──────────────────────────────────────────────────────────────

export interface SkillSummary {
  name: string
  domain: string | null
  description: string
  confidence: number
  sourceCount: number
}

export interface AnchorSummary {
  label: string
  entityType: string
  description: string | null
  connectionCount: number
}

export interface RAGContext {
  sourceChunks: EnrichedChunk[]
  nodeSummaries: NodeSummary[]
  relationshipPaths: RelationshipPath[]
  skills?: SkillSummary[]
  anchors?: AnchorSummary[]
}

export interface RAGResponseContext {
  sourceChunks: EnrichedChunk[]
  relatedNodes: KnowledgeNode[]
  relatedEdges: KnowledgeEdge[]
  citations: InlineCitation[]
}

export interface RAGGenerationResult {
  answer: string
  citations: InlineCitation[]
  followUp?: {               // PRD-C: suggested follow-up question
    question: string
    label: string
  }
}

// ─── Search result types ──────────────────────────────────────────────────────

export interface SemanticChunkResult {
  id: string
  source_id: string
  chunk_index: number
  content: string
  similarity: number
}

export interface KeywordNodeResult {
  id: string
  label: string
  entity_type: string
  description: string | null
  source: string | null
  source_type: string | null
  source_id: string | null
  confidence: number | null
  is_anchor: boolean
  tags: string[] | null
  created_at: string
}

export interface KeywordSourceResult {
  id: string
  title: string | null
  source_type: string | null
  source_url: string | null
  created_at: string
}

export interface GraphStats {
  nodeCount: number
  chunkCount: number
  edgeCount: number
  sourceCount: number
}

// ─── Pipeline Events ──────────────────────────────────────────────────────────

export interface RAGStepEvent {
  step: RAGPipelineStep
  status: 'running' | 'done'
  // embedding step
  subQueries?: string[]
  hasEmbedding?: boolean
  // semantic_search step
  sources?: number
  keywordNodes?: number
  semanticChunks?: number
  semanticNodes?: number
  // keyword_search step (chunk retrieval)
  rawChunks?: number
  rankedChunks?: number
  // graph_traversal step
  seedNodes?: number
  graphNodes?: number
  graphEdges?: number
  // context_assembly step
  contextChunks?: number
  contextNodes?: number
  relationshipPaths?: number
}
