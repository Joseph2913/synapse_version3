import { createContext, useState, useCallback, useRef, useEffect, type ReactNode } from 'react'
import { useAuth } from '../../hooks/useAuth'
import { supabase, fetchCouncilDigest, fetchRecentSourceRelationCounts } from '../../services/supabase'
import type { KnowledgeNode, KnowledgeSource, KnowledgeSkill } from '../../types/database'
import type {
  HomeDashboardStats,
  CrossConnectionEdge,
  PipelineStatus,
  KnowledgeSnapshot,
} from '../../services/supabase'
import type { CouncilDigest } from '../../types/council'

// ─── Public types (match original useHomeDashboard interface) ────────────────

export interface HomeDashboardLoading {
  stats: boolean
  sources: boolean
  signals: boolean
  crossConnections: boolean
  pipeline: boolean
  snapshot: boolean
  councilDigest: boolean
}

export interface HomeDashboardData {
  stats: HomeDashboardStats | null
  recentSources: KnowledgeSource[]
  sourceEntityCounts: Record<string, number>
  sourceCrossConnectionCounts: Record<string, number>
  sourceRelatedSourceCounts: Record<string, number>
  recentAnchors: KnowledgeNode[]
  anchorConnectionCounts: Record<string, number>
  recentSkills: KnowledgeSkill[]
  crossConnections: CrossConnectionEdge[]
  pipelineStatus: PipelineStatus | null
  snapshot: KnowledgeSnapshot | null
  councilDigest: CouncilDigest | null
  loading: HomeDashboardLoading
  errors: Partial<Record<keyof HomeDashboardLoading, string>>
  refresh: () => void
}

export interface HomeDashboardContextValue extends HomeDashboardData {
  /** Call when the Home view mounts — serves cache instantly or triggers background refresh if stale */
  ensureFresh: () => void
}

// ─── RPC response shape ─────────────────────────────────────────────────────

interface RpcRecentSource {
  id: string
  title: string | null
  source_type: string | null
  source_url: string | null
  metadata: Record<string, unknown> | null
  summary: string | null
  created_at: string
  entityCount: number
}

interface RpcRecentAnchor {
  id: string
  label: string
  entity_type: string
  description: string | null
  is_anchor: boolean
  created_at: string
  user_id: string
  source_id: string | null
  connectionCount: number
}

interface RpcDashboardResponse {
  stats: HomeDashboardStats
  recentSources: RpcRecentSource[]
  recentAnchors: RpcRecentAnchor[]
  recentSkills: KnowledgeSkill[]
  crossConnections: CrossConnectionEdge[]
  pipelineStatus: PipelineStatus
  snapshot: KnowledgeSnapshot
}

// ─── Context ─────────────────────────────────────────────────────────────────

export const HomeDashboardContext = createContext<HomeDashboardContextValue | null>(null)

// ─── Provider ────────────────────────────────────────────────────────────────

/** How long (ms) cached data is considered fresh before a background refetch */
const STALE_TIME = 2 * 60 * 1000 // 2 minutes

export function HomeDashboardProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth()

  const [stats, setStats] = useState<HomeDashboardStats | null>(null)
  const [recentSources, setRecentSources] = useState<KnowledgeSource[]>([])
  const [sourceEntityCounts, setSourceEntityCounts] = useState<Record<string, number>>({})
  const [sourceCrossConnectionCounts, setSourceCrossConnectionCounts] = useState<Record<string, number>>({})
  const [sourceRelatedSourceCounts, setSourceRelatedSourceCounts] = useState<Record<string, number>>({})
  const [recentAnchors, setRecentAnchors] = useState<KnowledgeNode[]>([])
  const [anchorConnectionCounts, setAnchorConnectionCounts] = useState<Record<string, number>>({})
  const [recentSkills, setRecentSkills] = useState<KnowledgeSkill[]>([])
  const [crossConnections, setCrossConnections] = useState<CrossConnectionEdge[]>([])
  const [pipelineStatus, setPipelineStatus] = useState<PipelineStatus | null>(null)
  const [snapshot, setSnapshot] = useState<KnowledgeSnapshot | null>(null)
  const [councilDigest, setCouncilDigest] = useState<CouncilDigest | null>(null)
  const allLoading: HomeDashboardLoading = { stats: true, sources: true, signals: true, crossConnections: true, pipeline: true, snapshot: true, councilDigest: true }
  const allDone: HomeDashboardLoading = { stats: false, sources: false, signals: false, crossConnections: false, pipeline: false, snapshot: false, councilDigest: false }

  const [loading, setLoading] = useState<HomeDashboardLoading>(allDone)
  const [errors, setErrors] = useState<Partial<Record<keyof HomeDashboardLoading, string>>>({})

  const fetchCountRef = useRef(0)
  const lastFetchTimeRef = useRef(0)
  const hasFetchedRef = useRef(false)

  const load = useCallback(async (background = false) => {
    if (!user) return
    if (!background) setLoading(allLoading)
    setErrors({})

    const id = ++fetchCountRef.current
    try {
      const [dashboardRes, digestRes, relationCountsRes] = await Promise.allSettled([
        supabase.rpc('get_home_dashboard', { p_user_id: user.id }),
        fetchCouncilDigest(user.id, 7),
        fetchRecentSourceRelationCounts(user.id, 5),
      ])
      if (id !== fetchCountRef.current) return // stale

      if (dashboardRes.status === 'rejected') throw new Error(String(dashboardRes.reason))
      const { data, error: rpcError } = dashboardRes.value
      if (rpcError) throw new Error(rpcError.message)

      // Council digest is non-fatal — record error but keep loading the rest
      if (digestRes.status === 'fulfilled') {
        setCouncilDigest(digestRes.value)
      } else {
        const msg = digestRes.reason instanceof Error ? digestRes.reason.message : "Couldn't load Council digest."
        setErrors(prev => ({ ...prev, councilDigest: msg }))
      }

      if (relationCountsRes.status === 'fulfilled') {
        const cross: Record<string, number> = {}
        const related: Record<string, number> = {}
        for (const r of relationCountsRes.value) {
          cross[r.source_id] = r.cross_connection_count
          related[r.source_id] = r.related_source_count
        }
        setSourceCrossConnectionCounts(cross)
        setSourceRelatedSourceCounts(related)
      }

      const d = data as RpcDashboardResponse

      // Stats
      setStats(d.stats)

      // Recent sources — extract entityCount into separate Record (matches existing interface)
      const sources = (d.recentSources ?? []).map(({ entityCount: _ec, ...rest }) => rest as unknown as KnowledgeSource)
      setRecentSources(sources)
      const entityCounts: Record<string, number> = {}
      for (const s of d.recentSources ?? []) entityCounts[s.id] = s.entityCount
      setSourceEntityCounts(entityCounts)

      // Recent anchors — extract connectionCount into separate Record
      const anchors = (d.recentAnchors ?? []).map(({ connectionCount: _cc, ...rest }) => rest as unknown as KnowledgeNode)
      setRecentAnchors(anchors)
      const connCounts: Record<string, number> = {}
      for (const a of d.recentAnchors ?? []) connCounts[a.id] = a.connectionCount
      setAnchorConnectionCounts(connCounts)

      // Skills, cross-connections, pipeline, snapshot
      setRecentSkills((d.recentSkills ?? []) as unknown as KnowledgeSkill[])
      setCrossConnections((d.crossConnections ?? []) as CrossConnectionEdge[])
      setPipelineStatus(d.pipelineStatus)
      setSnapshot(d.snapshot)

      lastFetchTimeRef.current = Date.now()
      hasFetchedRef.current = true
    } catch (err) {
      if (id !== fetchCountRef.current) return
      const msg = err instanceof Error ? err.message : "Couldn't load dashboard."
      setErrors({ stats: msg, sources: msg, signals: msg, crossConnections: msg, pipeline: msg, snapshot: msg, councilDigest: msg })
    } finally {
      if (id === fetchCountRef.current) setLoading(allDone)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user])

  // Initial fetch when user becomes available
  useEffect(() => {
    if (user && !hasFetchedRef.current) {
      load()
    }
  }, [user, load])

  // Force refresh (replaces cache)
  const refresh = useCallback(() => {
    load(false)
  }, [load])

  // Stale-while-revalidate: called when Home view mounts
  const ensureFresh = useCallback(() => {
    if (!hasFetchedRef.current) {
      load(false)
    } else if (Date.now() - lastFetchTimeRef.current > STALE_TIME) {
      load(true)
    }
  }, [load])

  // Listen for invalidation events
  useEffect(() => {
    const onInvalidate = () => load(false)
    window.addEventListener('synapse:anchor-confirmed', onInvalidate)
    window.addEventListener('synapse:ingestion-complete', onInvalidate)
    return () => {
      window.removeEventListener('synapse:anchor-confirmed', onInvalidate)
      window.removeEventListener('synapse:ingestion-complete', onInvalidate)
    }
  }, [load])

  // Reset when user changes (logout/login)
  useEffect(() => {
    if (!user) {
      setStats(null)
      setRecentSources([])
      setSourceEntityCounts({})
      setSourceCrossConnectionCounts({})
      setSourceRelatedSourceCounts({})
      setRecentAnchors([])
      setAnchorConnectionCounts({})
      setRecentSkills([])
      setCrossConnections([])
      setPipelineStatus(null)
      setSnapshot(null)
      setCouncilDigest(null)
      setLoading(allDone)
      setErrors({})
      hasFetchedRef.current = false
      lastFetchTimeRef.current = 0
    }
  }, [user])

  const value: HomeDashboardContextValue = {
    stats,
    recentSources,
    sourceEntityCounts,
    sourceCrossConnectionCounts,
    sourceRelatedSourceCounts,
    recentAnchors,
    anchorConnectionCounts,
    recentSkills,
    crossConnections,
    pipelineStatus,
    snapshot,
    councilDigest,
    loading,
    errors,
    refresh,
    ensureFresh,
  }

  return (
    <HomeDashboardContext.Provider value={value}>
      {children}
    </HomeDashboardContext.Provider>
  )
}
