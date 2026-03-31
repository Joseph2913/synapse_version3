import { useState, useCallback, useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'
import type { ExploreFilters, ExploreViewMode, ZoomLevel, ClusterData, SourceConnectionType } from '../types/explore'

const DEFAULT_FILTERS: ExploreFilters = {
  searchQuery: '',
  activeAnchorId: null,
  spotlightEntityType: null,
  recency: 'all',
  sourceTypes: new Set(),
  connTypes: new Set<SourceConnectionType>(['entity']),
  sourceAnchorFilter: null,
}

export function useExploreFilters() {
  const [searchParams, setSearchParams] = useSearchParams()

  // View mode: anchors | sources
  const [viewMode, setViewMode] = useState<ExploreViewMode>(
    (searchParams.get('mode') as ExploreViewMode) || 'anchors'
  )

  // Zoom level
  const [zoomLevel, setZoomLevel] = useState<ZoomLevel>(
    (searchParams.get('zoom') as ZoomLevel) || 'landscape'
  )

  // Active cluster (for neighborhood view)
  const [activeClusterId, setActiveClusterId] = useState<string | null>(
    searchParams.get('cluster') || null
  )

  // Show edges toggle (default on)
  const [showEdges, setShowEdges] = useState(true)

  // Selected entity ID
  const [selectedEntityId, setSelectedEntityId] = useState<string | null>(
    searchParams.get('node') || null
  )

  // Filters
  const [filters, setFilters] = useState<ExploreFilters>({
    ...DEFAULT_FILTERS,
    activeAnchorId: searchParams.get('anchor') || null,
    spotlightEntityType: searchParams.get('spotlight') || null,
    recency: (searchParams.get('recency') as ExploreFilters['recency']) || 'all',
    sourceTypes: new Set(searchParams.get('stypes')?.split(',').filter(Boolean) ?? []),
    connTypes: searchParams.has('ctypes')
      ? new Set((searchParams.get('ctypes')!.split(',').filter(Boolean)) as SourceConnectionType[])
      : DEFAULT_FILTERS.connTypes,
    sourceAnchorFilter: searchParams.get('sanchor') || null,
  })

  // Debounced search
  const [searchInput, setSearchInput] = useState(searchParams.get('q') || '')

  useEffect(() => {
    const timer = setTimeout(() => {
      setFilters(prev => ({ ...prev, searchQuery: searchInput }))
    }, 300)
    return () => clearTimeout(timer)
  }, [searchInput])

  // Sync state to URL params
  useEffect(() => {
    const params = new URLSearchParams()
    if (viewMode !== 'anchors') params.set('mode', viewMode)
    if (zoomLevel !== 'landscape') params.set('zoom', zoomLevel)
    if (activeClusterId) params.set('cluster', activeClusterId)
    if (selectedEntityId) params.set('node', selectedEntityId)
    if (filters.activeAnchorId) params.set('anchor', filters.activeAnchorId)
    if (filters.spotlightEntityType) params.set('spotlight', filters.spotlightEntityType)
    if (filters.recency !== 'all') params.set('recency', filters.recency)
    if (searchInput) params.set('q', searchInput)
    if (filters.sourceTypes.size > 0) params.set('stypes', [...filters.sourceTypes].join(','))
    if (filters.connTypes.size > 0) params.set('ctypes', [...filters.connTypes].join(','))
    if (filters.sourceAnchorFilter) params.set('sanchor', filters.sourceAnchorFilter)
    setSearchParams(params, { replace: true })
  }, [viewMode, zoomLevel, activeClusterId, selectedEntityId, filters.activeAnchorId, filters.spotlightEntityType, filters.recency, filters.sourceTypes, filters.connTypes, filters.sourceAnchorFilter, searchInput, setSearchParams])

  // Anchor toggle — click active anchor again to clear
  const toggleAnchor = useCallback((anchorId: string) => {
    setFilters(prev => ({
      ...prev,
      activeAnchorId: prev.activeAnchorId === anchorId ? null : anchorId,
      spotlightEntityType: null, // Clear spotlight when anchor selected
    }))
  }, [])

  // Spotlight toggle
  const toggleSpotlight = useCallback((entityType: string | null) => {
    setFilters(prev => ({
      ...prev,
      spotlightEntityType: prev.spotlightEntityType === entityType ? null : entityType,
      activeAnchorId: null, // Clear anchor when spotlight selected
    }))
  }, [])

  // Recency toggle
  const setRecency = useCallback((recency: ExploreFilters['recency']) => {
    setFilters(prev => ({ ...prev, recency }))
  }, [])

  // Enter neighborhood (click cluster) — also sets the anchor filter to reflect context
  const enterNeighborhood = useCallback((clusterId: string) => {
    setActiveClusterId(clusterId)
    setZoomLevel('neighborhood')
    setSelectedEntityId(null)
    setFilters(prev => ({ ...prev, activeAnchorId: clusterId }))
  }, [])

  // Return to landscape — clears the auto-set anchor filter
  const returnToLandscape = useCallback(() => {
    setActiveClusterId(null)
    setZoomLevel('landscape')
    setSelectedEntityId(null)
    setFilters(prev => ({ ...prev, activeAnchorId: null }))
  }, [])

  // Source-mode filter toggles
  const toggleSourceType = useCallback((type: string) => {
    setFilters(prev => {
      const next = new Set(prev.sourceTypes)
      if (next.has(type)) next.delete(type); else next.add(type)
      return { ...prev, sourceTypes: next }
    })
  }, [])

  const toggleConnType = useCallback((type: SourceConnectionType) => {
    setFilters(prev => {
      const next = new Set(prev.connTypes)
      if (next.has(type)) next.delete(type); else next.add(type)
      return { ...prev, connTypes: next }
    })
  }, [])

  const setSourceAnchorFilter = useCallback((anchorId: string | null) => {
    setFilters(prev => ({
      ...prev,
      sourceAnchorFilter: prev.sourceAnchorFilter === anchorId ? null : anchorId,
    }))
  }, [])

  const resetFilters = useCallback(() => {
    setFilters({ ...DEFAULT_FILTERS })
    setActiveClusterId(null)
    setZoomLevel('landscape')
    setSelectedEntityId(null)
  }, [])

  // Cluster visibility: determines if a cluster should be dimmed or bright
  const isClusterVisible = useCallback((cluster: ClusterData): boolean => {
    // If no filters active, all visible
    if (!filters.activeAnchorId && !filters.spotlightEntityType && !filters.searchQuery) {
      return true
    }

    // Anchor filter: only the selected anchor's cluster is visible
    if (filters.activeAnchorId) {
      return cluster.anchor.id === filters.activeAnchorId
    }

    // Spotlight: cluster is visible if it contains the spotlighted entity type
    if (filters.spotlightEntityType) {
      return cluster.typeDistribution.some(t => t.entityType === filters.spotlightEntityType)
    }

    // Search: cluster is visible if anchor label matches
    if (filters.searchQuery) {
      return cluster.anchor.label.toLowerCase().includes(filters.searchQuery.toLowerCase())
    }

    return true
  }, [filters])

  return {
    viewMode,
    setViewMode,
    zoomLevel,
    activeClusterId,
    showEdges,
    setShowEdges,
    selectedEntityId,
    setSelectedEntityId,
    enterNeighborhood,
    returnToLandscape,
    filters,
    searchInput,
    setSearchInput,
    toggleAnchor,
    toggleSpotlight,
    setRecency,
    isClusterVisible,
    toggleSourceType,
    toggleConnType,
    setSourceAnchorFilter,
    resetFilters,
  }
}
