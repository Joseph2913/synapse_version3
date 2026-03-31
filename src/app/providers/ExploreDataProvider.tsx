import { createContext, useState, useCallback, useRef, useEffect, type ReactNode } from 'react'
import { useAuth } from '../../hooks/useAuth'
import { fetchClusterData, fetchGraphStats, fetchUnclusteredNodes } from '../../services/exploreQueries'
import type { ClusterData } from '../../types/explore'
import type { GraphStats, UnclusteredEntity } from '../../services/exploreQueries'

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ExploreData {
  clusters: ClusterData[]
  stats: GraphStats
  unclustered: UnclusteredEntity[]
}

export interface ExploreDataContextValue {
  data: ExploreData | null
  loading: boolean
  error: Error | null
  /** Force a fresh fetch, replacing the cache */
  refetch: () => void
}

// ─── Context ─────────────────────────────────────────────────────────────────

export const ExploreDataContext = createContext<ExploreDataContextValue | null>(null)

// ─── Provider ────────────────────────────────────────────────────────────────

/** How long (ms) cached data is considered fresh before a background refetch */
const STALE_TIME = 5 * 60 * 1000 // 5 minutes

export function ExploreDataProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth()
  const [data, setData] = useState<ExploreData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<Error | null>(null)

  const fetchCountRef = useRef(0)
  const lastFetchTimeRef = useRef(0)
  const hasFetchedRef = useRef(false)

  const load = useCallback(async (background = false) => {
    if (!user) return
    if (!background) setLoading(true)
    setError(null)

    const id = ++fetchCountRef.current
    try {
      const [clusterResult, stats] = await Promise.all([
        fetchClusterData(user.id),
        fetchGraphStats(user.id),
      ])
      if (id !== fetchCountRef.current) return // stale

      const unclustered = await fetchUnclusteredNodes(user.id, clusterResult.clusteredNodeIds)
      if (id !== fetchCountRef.current) return // stale

      setData({ clusters: clusterResult.clusters, stats, unclustered })
      lastFetchTimeRef.current = Date.now()
      hasFetchedRef.current = true
    } catch (err) {
      if (id !== fetchCountRef.current) return
      setError(err instanceof Error ? err : new Error(String(err)))
    } finally {
      if (id === fetchCountRef.current) setLoading(false)
    }
  }, [user])

  // Initial fetch when user becomes available
  useEffect(() => {
    if (user && !hasFetchedRef.current) {
      load()
    }
  }, [user, load])

  // Refetch: force a fresh load (replaces cache)
  const refetch = useCallback(() => {
    load(false)
  }, [load])

  // Stale-while-revalidate: when data exists but is stale, trigger background refresh.
  // This is called by useExploreData when the Explore view mounts.
  // We expose `ensureFresh` via a ref on the context so the hook can call it.
  const ensureFresh = useCallback(() => {
    if (!hasFetchedRef.current) {
      // No data yet — do a full (non-background) load
      load(false)
    } else if (Date.now() - lastFetchTimeRef.current > STALE_TIME) {
      // Data is stale — refresh in background while showing cached data
      load(true)
    }
    // Otherwise data is fresh — do nothing
  }, [load])

  // Listen for invalidation events
  useEffect(() => {
    const onAnchorConfirmed = () => {
      load(false)
      // Also refetch after a delay to pick up any async processing
      setTimeout(() => load(true), 35000)
    }
    window.addEventListener('synapse:anchor-confirmed', onAnchorConfirmed)
    return () => {
      window.removeEventListener('synapse:anchor-confirmed', onAnchorConfirmed)
    }
  }, [load])

  // Reset when user changes (logout/login)
  useEffect(() => {
    if (!user) {
      setData(null)
      setLoading(false)
      setError(null)
      hasFetchedRef.current = false
      lastFetchTimeRef.current = 0
    }
  }, [user])

  const value: ExploreDataContextValue & { ensureFresh: () => void } = {
    data,
    loading,
    error,
    refetch,
    ensureFresh,
  }

  return (
    <ExploreDataContext.Provider value={value}>
      {children}
    </ExploreDataContext.Provider>
  )
}
