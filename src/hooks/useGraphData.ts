import { useState, useEffect, useRef, useCallback } from 'react'
import { useAuth } from './useAuth'
import {
  fetchAnchorLevelData,
  fetchAllSourcesLevelData,
  fetchSourceLevelData,
  fetchEntityLevelData,
} from '../services/graphQueries'
import type {
  GraphLevel,
  GraphNavState,
  AnchorLevelData,
  AllSourcesLevelData,
  SourceLevelData,
  EntityLevelData,
} from '../types/graph'

export type LevelData =
  | { level: 'anchors'; data: AnchorLevelData }
  | { level: 'all_sources'; data: AllSourcesLevelData }
  | { level: 'sources'; data: SourceLevelData }
  | { level: 'entities'; data: EntityLevelData }

export function useGraphData(): {
  levelData: LevelData | null
  loading: boolean
  error: Error | null
  nav: GraphNavState
  drillToSources: (anchorId: string, anchorLabel: string) => void
  drillToEntities: (sourceId: string, sourceTitle: string) => void
  navigateBack: () => void
  navigateToLevel: (level: GraphLevel, id?: string) => void
  switchRootView: (level: 'anchors' | 'all_sources') => void
  refetch: () => void
} {
  const { user } = useAuth()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)
  const [levelData, setLevelData] = useState<LevelData | null>(null)
  const [nav, setNav] = useState<GraphNavState>({ level: 'all_sources' })
  const fetchCount = useRef(0)

  // Cache level data for quick back navigation
  const anchorCacheRef = useRef<AnchorLevelData | null>(null)
  const allSourcesCacheRef = useRef<AllSourcesLevelData | null>(null)
  const sourceCacheRef = useRef<Map<string, SourceLevelData>>(new Map())

  const load = useCallback(async (navState: GraphNavState) => {
    if (!user) return
    setLoading(true)
    setError(null)
    const id = ++fetchCount.current

    try {
      if (navState.level === 'anchors') {
        // Use cache if available
        if (anchorCacheRef.current) {
          if (id !== fetchCount.current) return
          setLevelData({ level: 'anchors', data: anchorCacheRef.current })
          setLoading(false)
          return
        }
        const data = await fetchAnchorLevelData(user.id)
        console.log('[GraphData] Anchor data loaded:', data.anchors.length, 'anchors,', data.stats)
        if (id !== fetchCount.current) return
        anchorCacheRef.current = data
        setLevelData({ level: 'anchors', data })
      } else if (navState.level === 'all_sources') {
        // Cache temporarily disabled to pick up gravity anchor changes
        allSourcesCacheRef.current = null
        const data = await fetchAllSourcesLevelData(user.id)
        if (id !== fetchCount.current) return
        allSourcesCacheRef.current = data
        setLevelData({ level: 'all_sources', data })
      } else if (navState.level === 'sources' && navState.anchorId) {
        // Check cache
        const cached = sourceCacheRef.current.get(navState.anchorId)
        if (cached) {
          if (id !== fetchCount.current) return
          setLevelData({ level: 'sources', data: cached })
          setLoading(false)
          return
        }
        const data = await fetchSourceLevelData(user.id, navState.anchorId)
        if (id !== fetchCount.current) return
        sourceCacheRef.current.set(navState.anchorId, data)
        setLevelData({ level: 'sources', data })
      } else if (navState.level === 'entities' && navState.sourceId && navState.anchorId) {
        const data = await fetchEntityLevelData(user.id, navState.sourceId, navState.anchorId)
        if (id !== fetchCount.current) return
        setLevelData({ level: 'entities', data })
      }
    } catch (err) {
      if (id !== fetchCount.current) return
      setError(err instanceof Error ? err : new Error(String(err)))
    } finally {
      if (id === fetchCount.current) setLoading(false)
    }
  }, [user])

  useEffect(() => {
    load(nav)
  }, [load, nav])

  const drillToSources = useCallback((anchorId: string, anchorLabel: string) => {
    setNav({
      level: 'sources',
      anchorId,
      anchorLabel,
    })
  }, [])

  const drillToEntities = useCallback((sourceId: string, sourceTitle: string) => {
    setNav(prev => ({
      ...prev,
      level: 'entities',
      sourceId,
      sourceTitle,
    }))
  }, [])

  const navigateBack = useCallback(() => {
    setNav(prev => {
      if (prev.level === 'entities') {
        return {
          level: 'sources',
          anchorId: prev.anchorId,
          anchorLabel: prev.anchorLabel,
        }
      }
      if (prev.level === 'sources') {
        return { level: 'anchors' }
      }
      return prev
    })
  }, [])

  const navigateToLevel = useCallback((level: GraphLevel, id?: string) => {
    if (level === 'anchors' || level === 'all_sources') {
      setNav({ level })
    } else if (level === 'sources' && id) {
      const anchor = anchorCacheRef.current?.anchors.find(a => a.id === id)
      setNav({ level: 'sources', anchorId: id, anchorLabel: anchor?.label })
    }
  }, [])

  const switchRootView = useCallback((level: 'anchors' | 'all_sources') => {
    setNav({ level })
  }, [])

  const refetch = useCallback(() => {
    anchorCacheRef.current = null
    allSourcesCacheRef.current = null
    sourceCacheRef.current.clear()
    load(nav)
  }, [load, nav])

  return {
    levelData,
    loading,
    error,
    nav,
    drillToSources,
    drillToEntities,
    navigateBack,
    navigateToLevel,
    switchRootView,
    refetch,
  }
}
