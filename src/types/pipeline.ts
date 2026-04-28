// ─── Pipeline Page Types ─────────────────────────────────────────────────────

export interface PipelineHistoryItem {
  id: string
  title: string
  sourceType: 'youtube' | 'meeting' | 'file' | 'paste' | 'url' | 'research' | 'github'
  mode: 'comprehensive' | 'strategic' | 'actionable' | 'relational'
  emphasis: 'passive' | 'standard' | 'aggressive'
  status: 'pending' | 'processing' | 'extracting' | 'completed' | 'failed'
  provider?: string | null // Provider that ingested this (e.g. 'youtube', 'circleback', 'fireflies')
  step?: string // For active items: 'queued' | 'fetching_transcript' | 'extracting' | 'saving'
  error?: string // For failed items
  createdAt: string
  // Extraction results (null/0 for pending/processing items)
  entityCount: number
  relationshipCount: number
  chunkCount: number
  duration: number // milliseconds
  confidence: number // 0–1 average
  crossConnections: number
  rating: number | null // 1–5 or null
  ratingText: string | null
  // Breakdown data
  entityBreakdown: Record<string, number> // { Person: 3, Topic: 4, ... }
  topEntityTypes: string[] // Sorted by count desc
  anchors: string[] // Anchor labels used
  // Source linkage
  sourceId: string | null
  sourceUrl: string | null
  // Node/edge IDs for graph navigation
  extractedNodeIds: string[]
  extractedEdgeIds: string[]
}

export interface HeatmapCell {
  week: number // 0–12
  day: number // 0–6 (Mon–Sun)
  date: string // ISO date string
  count: number // Extractions on this day
  entities: number
  relationships: number
  avgConfidence: number
  avgDuration: number // seconds
  failed: number
  sourceBreakdown: Record<string, number>
  entityBreakdown: Record<string, number>
  confidenceBuckets: number[] // [count_0.5-0.6, ..., count_0.9-1.0]
}

export interface PipelineMetrics {
  sourcesThisWeek: number
  sourcesLastWeek: number
  entitiesThisWeek: number
  avgEntitiesPerSource: number
  avgDuration: number // milliseconds
  fastestDuration: number
  slowestDuration: number
  successRate: number // 0–100
  failedThisWeek: number
  avgRating: number
  ratedCount: number
  activeProcessing: number
}

export type SourceTypeFilter = 'all' | 'youtube' | 'meeting' | 'file' | 'paste' | 'url'
export type StatusFilter = 'all' | 'queued' | 'in_progress' | 'completed' | 'failed'
export type SortOption = 'recent' | 'slowest' | 'entities' | 'confidence'
