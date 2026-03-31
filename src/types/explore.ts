// src/types/explore.ts — Shared types for Explore page (PRDs 4A–4E)

export type ExploreViewMode = 'anchors' | 'sources'
export type ZoomLevel = 'landscape' | 'neighborhood' | 'detail'

export interface ClusterData {
  anchor: AnchorNode
  entityCount: number              // total: direct + inherited
  directEntityCount: number        // PRD-23: direct edges only
  inheritedEntityCount: number     // PRD-23: from sub-anchors
  typeDistribution: TypeDistributionEntry[]
  position: { cx: number; cy: number; r: number }
  crossClusterEdges: CrossClusterEdge[]
  // PRD-22: sub-anchors orbiting this cluster
  subAnchorIds: string[]
}

export interface TypeDistributionEntry {
  entityType: string
  count: number
  percentage: number // 0–1
}

export interface CrossClusterEdge {
  targetClusterId: string
  sharedEntityCount: number
  crossEdgeCount: number
  totalWeight: number
}

export interface AnchorNode {
  id: string
  label: string
  entityType: string
  description: string | null
  entityCount: number
  // PRD-22: hierarchy fields
  parentAnchorId: string | null   // null = root anchor
  isSubAnchor:    boolean         // true when parentAnchorId is set
}

export interface EntityNode {
  id: string
  label: string
  entityType: string
  description: string | null
  confidence: number | null
  connectionCount: number
  clusters: string[] // anchor IDs this entity belongs to
  sourceId: string | null
  sourceName: string | null
  sourceType: string | null
  tags: string[]
  createdAt: string
  isBridge: boolean // belongs to 2+ clusters
  isUnclustered: boolean // belongs to 0 clusters
  isAnchor: boolean // this node is itself an anchor
  originAnchorId?: string // PRD-23: which anchor this entity primarily connects to
}

export interface SourceNode {
  id: string
  title: string
  sourceType: string
  entityIds: string[]
  entityCount: number
  createdAt: string
  tags: string[]             // unique tags across all entities in this source
  anchorIds: string[]        // anchor IDs this source's entities connect to
}

export type SourceConnectionType = 'entity' | 'anchor'

export interface SourceEdge {
  fromSourceId: string
  toSourceId: string
  totalWeight: number          // aggregate strength across all connection types
  connections: {
    type: SourceConnectionType
    count: number              // e.g. # of cross-source edges, # of shared tags, # of common anchors
    labels: string[]           // human-readable: tag names, anchor labels, etc.
  }[]
}

/** Anchor node rendered inside the source graph */
export interface SourceGraphAnchor {
  id: string
  label: string
  entityType: string
  connectedSourceIds: string[] // sources whose entities link to this anchor
}

export interface ExploreFilters {
  searchQuery: string
  activeAnchorId: string | null
  spotlightEntityType: string | null
  recency: '7d' | '30d' | 'all'
  // Source-mode filters
  sourceTypes: Set<string>              // empty = show all
  connTypes: Set<SourceConnectionType>  // empty = show all
  sourceAnchorFilter: string | null     // anchor ID or null
}

export interface ContextBasketItem {
  nodeId: string
  label: string
  entityType: string
}

export type ExploreRightPanelContent =
  | { type: 'node'; data: EntityNode }
  | { type: 'source'; data: SourceNode }
  | { type: 'cluster'; data: ClusterData }
  | null

// ─── Entity Browser types ─────────────────────────────────────────────────────

export interface EntityWithConnections {
  id: string
  label: string
  entityType: string
  description: string | null
  confidence: number | null
  sourceId: string | null
  sourceName: string | null
  sourceType: string | null
  tags: string[]
  createdAt: string
  connectionCount: number
  topConnections: Array<{
    id: string
    label: string
    entityType: string
    relationType: string
  }>
}
