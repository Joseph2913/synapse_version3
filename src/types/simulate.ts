export type SimulationStatus =
  | 'pending' | 'preparing' | 'running' | 'completed' | 'failed'

export interface SimulationJob {
  id: string
  userId: string
  status: SimulationStatus
  title: string
  scopeAnchorIds: string[]
  scopeTimeWindowDays: number
  scopeNodeCount: number | null
  scopeEdgeCount: number | null
  scopeSourceCount: number | null
  predictionQuestion: string
  whatIfVariables: string[]
  excludedNodeIds: string[]
  seedGraph: SimulationSeedGraph | null
  progress: number
  progressMessage: string | null
  result: SimulationReport | null
  ingestedSourceId: string | null
  errorMessage: string | null
  createdAt: string
  completedAt: string | null
}

export interface SimulationSeedGraph {
  nodes: SimulationNode[]
  edges: SimulationEdge[]
  sourceChunks: SimulationChunk[]
  metadata: {
    exportedAt: string
    anchorIds: string[]
    timeWindowDays: number
  }
}

export interface SimulationNode {
  id: string
  label: string
  entityType: string
  description: string
  isAnchor: boolean
  confidence: number
  centrality: number
  sourceId: string | null
  tags: string[]
}

export interface SimulationEdge {
  id: string
  sourceNodeId: string
  targetNodeId: string
  relationType: string
  evidence: string
  weight: number
}

export interface SimulationChunk {
  id: string
  sourceId: string
  content: string
  chunkIndex: number
}

export interface SimulationReport {
  headline: string
  summary: string
  forecasts: SimulationForecast[]
  agentMoves: SimulationAgentMove[]
  surprises: string[]
  confidenceLevel: 'low' | 'medium' | 'high'
  confidenceRationale: string
  simulationRounds: number
  agentCount: number
  generatedAt: string
}

export interface SimulationForecast {
  direction: string
  rationale: string
  timeframe: string
  confidence: 'low' | 'medium' | 'high'
}

export interface SimulationAgentMove {
  agentLabel: string
  entityType: string
  likelyAction: string
  rationale: string
  influence: 'low' | 'medium' | 'high'
}

export interface SimulationBuilderState {
  selectedAnchorIds: string[]
  timeWindowDays: number
  predictionQuestion: string
  whatIfVariables: string[]
  excludedNodeIds: string[]
  currentWhatIfInput: string
  // PRD-Simulate-C additions
  sourceTypeFilter: SourceTypeFilter[] | null
  outputHorizon: OutputHorizon
  externalAgents: ExternalAgent[]
  mode: SimulationMode
  depth: SimulationDepth
  surpriseSensitivity: SurpriseSensitivity
  presetUsed: string | null
}

// ─── PRD-Simulate-C: Configuration types ─────────────────────────────────────

export type SourceTypeFilter = 'meetings' | 'documents' | 'youtube' | 'notes'
export type OutputHorizon = '30d' | '90d' | '6m' | '1y' | '2y+'
export type SimulationMode = 'prediction' | 'hypothesis_test' | 'contrarian_scan' | 'optimisation' | 'consensus_mapping'
export type SimulationDepth = 'quick_scan' | 'standard' | 'deep_dive' | 'exhaustive'
export type SurpriseSensitivity = 'conservative' | 'balanced' | 'expansive'

export interface ExternalAgent {
  label: string
  entity_type: string
  known_position: string
}

export interface SimulationConfig {
  anchorNodeIds: string[]
  timeWindow: '30d' | '90d' | '6m' | 'all'
  sourceTypeFilter: SourceTypeFilter[] | null
  outputHorizon: OutputHorizon
  question: string
  whatIfVariables: string[]
  externalAgents: ExternalAgent[]
  mode: SimulationMode
  depth: SimulationDepth
  surpriseSensitivity: SurpriseSensitivity
  presetUsed: string | null
}

// ─── PRD-Simulate-D: Persona generation types ────────────────────────────────

export type GroundingQuality = 'strong' | 'moderate' | 'weak' | 'inferred'
export type EpistemicStyle = 'empirical' | 'ideological' | 'opportunistic' | 'contrarian' | 'cautious' | 'structural'
export type InfluenceTier = 'high' | 'medium' | 'low'
export type StanceCategory = 'pro' | 'anti' | 'conditional' | 'uncertain' | 'orthogonal'

export interface SimulationPersona {
  agent_id: string
  label: string
  entity_type: string
  influence_tier: InfluenceTier
  grounding_quality: GroundingQuality
  grounding_chunk_ids: string[]
  source_count: number
  documented_position: string
  question_specific_stance: string
  stance_category: StanceCategory
  incentive_structure: string
  epistemic_style: EpistemicStyle
  update_conditions: string
  blind_spots: string
  inter_agent_relationships: string[]
  behavioural_prompt: string
  is_synthetic: boolean
  is_excluded: boolean
}

export interface PersonaSetDiversity {
  score: number
  distribution: Record<StanceCategory, number>
  warning: 'none' | 'low_diversity' | 'single_source'
  recommendation: 'proceed' | 'inject_contrarian' | 'broaden_scope'
}

export type SimulationStage =
  | 'idle'
  | 'generating_personas'
  | 'awaiting_review'
  | 'confirmed'
  | 'running_simulation'
  | 'generating_report'
  | 'complete'
  | 'failed'
