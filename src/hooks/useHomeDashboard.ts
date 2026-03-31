import { useState, useEffect, useCallback } from 'react'
import type { KnowledgeNode, KnowledgeSource, KnowledgeSkill } from '../types/database'
import {
  fetchHomeDashboardStats,
  fetchRecentSources,
  fetchSourceEntityCounts,
  fetchRecentAnchors,
  fetchAnchorConnectionCounts,
  fetchRecentSkills,
  fetchCrossConnectionEdges,
  fetchPipelineStatus,
  fetchKnowledgeSnapshot,
} from '../services/supabase'
import type {
  HomeDashboardStats,
  CrossConnectionEdge,
  PipelineStatus,
  KnowledgeSnapshot,
} from '../services/supabase'

export interface HomeDashboardData {
  stats: HomeDashboardStats | null
  recentSources: KnowledgeSource[]
  sourceEntityCounts: Record<string, number>
  recentAnchors: KnowledgeNode[]
  anchorConnectionCounts: Record<string, number>
  recentSkills: KnowledgeSkill[]
  crossConnections: CrossConnectionEdge[]
  pipelineStatus: PipelineStatus | null
  snapshot: KnowledgeSnapshot | null
  loading: {
    stats: boolean
    sources: boolean
    signals: boolean
    crossConnections: boolean
    pipeline: boolean
    snapshot: boolean
  }
  errors: Partial<Record<keyof HomeDashboardData['loading'], string>>
  refresh: () => void
}

export function useHomeDashboard(): HomeDashboardData {
  const [stats, setStats] = useState<HomeDashboardStats | null>(null)
  const [recentSources, setRecentSources] = useState<KnowledgeSource[]>([])
  const [sourceEntityCounts, setSourceEntityCounts] = useState<Record<string, number>>({})
  const [recentAnchors, setRecentAnchors] = useState<KnowledgeNode[]>([])
  const [anchorConnectionCounts, setAnchorConnectionCounts] = useState<Record<string, number>>({})
  const [recentSkills, setRecentSkills] = useState<KnowledgeSkill[]>([])
  const [crossConnections, setCrossConnections] = useState<CrossConnectionEdge[]>([])
  const [pipelineStatus, setPipelineStatus] = useState<PipelineStatus | null>(null)
  const [snapshot, setSnapshot] = useState<KnowledgeSnapshot | null>(null)

  const [loading, setLoading] = useState({
    stats: true,
    sources: true,
    signals: true,
    crossConnections: true,
    pipeline: true,
    snapshot: true,
  })
  const [errors, setErrors] = useState<Partial<Record<keyof HomeDashboardData['loading'], string>>>({})

  const loadAll = useCallback(() => {
    setLoading({
      stats: true,
      sources: true,
      signals: true,
      crossConnections: true,
      pipeline: true,
      snapshot: true,
    })
    setErrors({})

    // Stats
    fetchHomeDashboardStats()
      .then(setStats)
      .catch(() => setErrors(prev => ({ ...prev, stats: "Couldn't load stats." })))
      .finally(() => setLoading(prev => ({ ...prev, stats: false })))

    // Sources + entity counts
    fetchRecentSources(5)
      .then(async (sources) => {
        setRecentSources(sources)
        if (sources.length > 0) {
          const counts = await fetchSourceEntityCounts(sources.map(s => s.id))
          setSourceEntityCounts(counts)
        }
      })
      .catch(() => setErrors(prev => ({ ...prev, sources: "Couldn't load recent sources." })))
      .finally(() => setLoading(prev => ({ ...prev, sources: false })))

    // Signals: anchors + skills (5 each for toggle view)
    Promise.all([
      fetchRecentAnchors(5).then(async (anchors) => {
        setRecentAnchors(anchors)
        if (anchors.length > 0) {
          const counts = await fetchAnchorConnectionCounts(anchors.map(a => a.id))
          setAnchorConnectionCounts(counts)
        }
      }),
      fetchRecentSkills(5).then(setRecentSkills),
    ])
      .catch(() => setErrors(prev => ({ ...prev, signals: "Couldn't load signals." })))
      .finally(() => setLoading(prev => ({ ...prev, signals: false })))

    // Cross-connections
    fetchCrossConnectionEdges(5)
      .then(setCrossConnections)
      .catch(() => setErrors(prev => ({ ...prev, crossConnections: "Couldn't load cross-connections." })))
      .finally(() => setLoading(prev => ({ ...prev, crossConnections: false })))

    // Pipeline
    fetchPipelineStatus()
      .then(setPipelineStatus)
      .catch(() => setErrors(prev => ({ ...prev, pipeline: "Couldn't load pipeline status." })))
      .finally(() => setLoading(prev => ({ ...prev, pipeline: false })))

    // Snapshot
    fetchKnowledgeSnapshot()
      .then(setSnapshot)
      .catch(() => setErrors(prev => ({ ...prev, snapshot: "Couldn't load knowledge snapshot." })))
      .finally(() => setLoading(prev => ({ ...prev, snapshot: false })))
  }, [])

  useEffect(() => {
    loadAll()
  }, [loadAll])

  return {
    stats,
    recentSources,
    sourceEntityCounts,
    recentAnchors,
    anchorConnectionCounts,
    recentSkills,
    crossConnections,
    pipelineStatus,
    snapshot,
    loading,
    errors,
    refresh: loadAll,
  }
}
