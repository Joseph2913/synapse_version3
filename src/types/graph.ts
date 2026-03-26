// src/types/graph.ts — Three-level graph hierarchy types (PRD 5B)

// ─── Navigation ──────────────────────────────────────────────────────────────

export type GraphLevel = 'anchors' | 'all_sources' | 'sources' | 'entities'

export interface GraphNavState {
  level: GraphLevel
  anchorId?: string    // set when at sources or entities level
  anchorLabel?: string
  sourceId?: string    // set when at entities level
  sourceTitle?: string
}

export interface BreadcrumbSegment {
  label: string
  level: GraphLevel
  id?: string // anchor or source ID to navigate to
}

// ─── Level 1: Anchor Landscape ───────────────────────────────────────────────

export type AnchorStatus = 'manual' | 'auto' | 'proposed'

export interface AnchorGraphNode {
  id: string
  kind: 'anchor'
  label: string
  entityType: string
  color: string
  entityCount: number
  sourceCount: number
  connectionCount: number // inter-anchor connections
  description: string | null
  confidence: number | null
  anchorStatus: AnchorStatus
  lastActivity: string | null // ISO timestamp
  isQuiet: boolean // no activity in 14+ days
}

export interface AnchorEdge {
  fromAnchorId: string
  toAnchorId: string
  bridgeEntityCount: number
  sharedSourceCount: number
  strength: number // 0-1 derived from bridge + shared
}

export interface AnchorLevelData {
  anchors: AnchorGraphNode[]
  edges: AnchorEdge[]
  stats: { anchorCount: number; sourceCount: number; entityCount: number }
}

// ─── All Sources (full DB view) ──────────────────────────────────────────────

export interface AllSourcesLevelData {
  sources: SourceGraphNode[]
  edges: SourceEdge[]
  stats: { sourceCount: number; entityCount: number; connectionCount: number }
}

// ─── Level 2: Sources Within an Anchor ───────────────────────────────────────

export interface TypeDistSegment {
  entityType: string
  count: number
  fraction: number // 0-1
}

export interface SourceGraphNode {
  id: string
  kind: 'source'
  label: string
  sourceType: string
  color: string
  icon: string
  entityCount: number
  anchorRelevance: number // 0-1, fraction of entities relevant to current anchor
  typeDistribution: TypeDistSegment[]
  bridgeAnchorIds: string[] // other anchors this source contributes to
  createdAt: string
  metadata: Record<string, unknown>
}

export interface SourceEdge {
  fromSourceId: string
  toSourceId: string
  sharedEntityCount: number
  strength: number // 0-1
}

export interface GhostAnchorNode {
  id: string
  kind: 'ghost_anchor'
  label: string
  entityType: string
  color: string
  contributingSourceIds: string[]
}

export interface SourceLevelData {
  sources: SourceGraphNode[]
  edges: SourceEdge[]
  ghostAnchors: GhostAnchorNode[]
  ghostEdges: { sourceId: string; anchorId: string }[]
  parentAnchor: { id: string; label: string; entityType: string; color: string }
  stats: { sourceCount: number; entityCount: number; bridgeCount: number }
}

// ─── Level 3: Entities Within a Source ───────────────────────────────────────

export interface EntityGraphNode {
  id: string
  kind: 'entity'
  label: string
  entityType: string
  color: string
  confidence: number | null
  isBridge: boolean // exists in 2+ sources
  sourceCount: number // how many sources contain this entity
  description: string | null
}

export interface IntraSourceEdge {
  fromEntityId: string
  toEntityId: string
  relationType: string | null
  evidence: string | null
  weight: number
}

export interface CrossSourceEdge {
  entityId: string
  ghostSourceId: string
}

export interface GhostSourceNode {
  id: string
  kind: 'ghost_source'
  label: string
  sourceType: string
  color: string
  icon: string
}

export interface EntityLevelData {
  entities: EntityGraphNode[]
  intraEdges: IntraSourceEdge[]
  crossEdges: CrossSourceEdge[]
  ghostSources: GhostSourceNode[]
  parentAnchor: { id: string; label: string }
  parentSource: { id: string; title: string; sourceType: string }
  stats: { entityCount: number; edgeCount: number; bridgeCount: number }
}

// ─── Simulation (shared across levels) ───────────────────────────────────────

export interface SimulationNode {
  id: string
  kind: 'anchor' | 'source' | 'entity' | 'ghost_anchor' | 'ghost_source'
  x: number
  y: number
  vx: number
  vy: number
  radius: number
  label: string
  color: string
  // Level-specific data carried through
  entityType?: string
  sourceType?: string
  icon?: string
  entityCount?: number
  sourceCount?: number
  connectionCount?: number
  anchorStatus?: AnchorStatus
  isQuiet?: boolean
  anchorRelevance?: number
  typeDistribution?: TypeDistSegment[]
  bridgeAnchorIds?: string[]
  isBridge?: boolean
  confidence?: number | null
  description?: string | null
  createdAt?: string
  metadata?: Record<string, unknown>
  bridgeEntityCount?: number
  sharedSourceCount?: number
  lastActivity?: string | null
  contributingSourceIds?: string[]
}

export interface SimulationEdge {
  fromId: string
  toId: string
  weight: number
  kind: 'anchor' | 'source' | 'intra' | 'cross' | 'ghost'
  relationType?: string | null
  evidence?: string | null
  bridgeEntityCount?: number
  sharedSourceCount?: number
  sharedEntityCount?: number
}

// ─── Camera ──────────────────────────────────────────────────────────────────

export interface Camera {
  zoom: number
  panX: number
  panY: number
}

// ─── Force simulation parameters per level ───────────────────────────────────

export interface ForceParams {
  linkDistance: number
  chargeStrength: number // base, before radius multiplier
  chargeRadiusMultiplier: number
  collisionPadding: number
  damping: number
}

export const FORCE_PARAMS: Record<GraphLevel, ForceParams> = {
  anchors: {
    linkDistance: 280,
    chargeStrength: -350,
    chargeRadiusMultiplier: 4,
    collisionPadding: 30,
    damping: 0.96,
  },
  all_sources: {
    linkDistance: 180,
    chargeStrength: -800,
    chargeRadiusMultiplier: 12,
    collisionPadding: 60,
    damping: 0.96,
  },
  sources: {
    linkDistance: 260,
    chargeStrength: -400,
    chargeRadiusMultiplier: 6,
    collisionPadding: 40,
    damping: 0.96,
  },
  entities: {
    linkDistance: 120,
    chargeStrength: -100,
    chargeRadiusMultiplier: 4,
    collisionPadding: 14,
    damping: 0.96,
  },
}

// ─── Auto-Anchor Detection ───────────────────────────────────────────────────

export interface ClusterCandidate {
  centroidLabel: string
  entityIds: string[]
  sourceIds: string[]
  sourceDiversity: number
  sourceTypeDiversity: number
  avgSimilarity: number
  growthRate: number
  entityTypeDistribution: Record<string, number>
  confidence: number
}

// ─── Detail panel types ──────────────────────────────────────────────────────

export type DetailPanelContent =
  | { type: 'anchor'; data: AnchorGraphNode; connectedAnchors: { id: string; label: string; strength: number }[] }
  | { type: 'source'; data: SourceGraphNode; entityBreakdown: TypeDistSegment[] }
  | { type: 'entity'; data: EntityGraphNode; relationships: { label: string; type: string; direction: 'in' | 'out' }[]; sources: { id: string; title: string }[] }
  | null
