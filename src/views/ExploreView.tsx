import { useState, useCallback, useMemo, useEffect } from 'react'
import { Loader2, AlertCircle, Compass, RefreshCw } from 'lucide-react'
import { ExploreToolbar } from './explore/ExploreToolbar'
import { LandscapeView } from './explore/LandscapeView'
import { NeighborhoodView } from './explore/NeighborhoodView'
import { SourceGraphView } from './explore/SourceGraphView'
import { PlaylistGraphView } from './explore/PlaylistGraphView'

import { useExploreData } from '../hooks/useExploreData'
import { useExploreFilters } from '../hooks/useExploreFilters'
import type { ClusterData, EntityNode, SourceNode, SourceEdge } from '../types/explore'
import type { EntityEdge } from '../services/exploreQueries'
import { useAuth } from '../hooks/useAuth'
import { fetchCandidatesWithNodes } from '../services/anchorCandidates'
import type { AnchorCandidateWithNode } from '../types/anchors'


interface SuggestedClusterData {
  candidateId:             string
  nodeId:                  string
  label:                   string
  entityType:              string
  compositeScore:          number
  reasoningText:           string | null
  mentionCount:            number
  sourceCount:             number
  velocityDirection:       'rising' | 'stable' | 'falling'
  suggestedParentAnchorId: string | null
  duplicateCount:          number
}

export function ExploreView() {
  const { data, loading, error, refetch } = useExploreData()
  const {
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
    toggleAnchor,
    isClusterVisible,
    toggleConnType,
    setSourceAnchorFilter,
    resetFilters,
  } = useExploreFilters()

  const { user } = useAuth()

  // Suggested anchor candidates — for ghost cluster rendering
  const [suggestedCandidates, setSuggestedCandidates] = useState<AnchorCandidateWithNode[]>([])
  const [, setSelectedSuggestedId] = useState<string | null>(null)
  const [selectedClusterId, setSelectedClusterId] = useState<string | null>(null)

  // Fetch suggested candidates for ghost cluster rendering
  useEffect(() => {
    if (!user) return
    fetchCandidatesWithNodes(user.id, ['suggested'])
      .then(setSuggestedCandidates)
      .catch(err => console.warn('[ExploreView] Failed to fetch suggested candidates:', err))
  }, [user])

  // Event listener for suggestion changes (anchor-confirmed is handled by ExploreDataProvider)
  useEffect(() => {
    const onSuggestionsChanged = () => {
      if (!user) return
      fetchCandidatesWithNodes(user.id, ['suggested'])
        .then(setSuggestedCandidates)
        .catch(() => {})
    }
    window.addEventListener('synapse:anchor-suggestions-changed', onSuggestionsChanged)
    return () => {
      window.removeEventListener('synapse:anchor-suggestions-changed', onSuggestionsChanged)
    }
  }, [user])

  // Source graph data
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null)

  // Neighborhood edge-type visibility (lifted so toolbar can control it)
  const [visibleEdgeTypes, setVisibleEdgeTypes] = useState<Set<string>>(
    () => new Set(['direct'])
  )
  const toggleNeighborhoodEdgeType = useCallback((type: string) => {
    setVisibleEdgeTypes(prev => {
      const next = new Set(prev)
      if (next.has(type)) next.delete(type); else next.add(type)
      return next
    })
  }, [])

  const clearAllFilters = useCallback(() => {
    resetFilters()
    setVisibleEdgeTypes(new Set(['direct', 'source', 'tag']))
  }, [resetFilters])


  const clusters = data?.clusters ?? []
  const stats = data?.stats ?? { nodeCount: 0, edgeCount: 0, sourceCount: 0, anchorCount: 0 }
  const unclustered = data?.unclustered ?? []

  // Find the active cluster for neighborhood view
  const activeCluster = useMemo(() => {
    if (!activeClusterId) return null
    return clusters.find(c => c.anchor.id === activeClusterId) ?? null
  }, [activeClusterId, clusters])

  const isNeighborhood = zoomLevel === 'neighborhood' && activeCluster !== null

  // Build deduplicated ghost cluster data
  const suggestedClusterData = useMemo((): SuggestedClusterData[] => {
    const candidates = suggestedCandidates.filter(c => c.node !== null)
    if (candidates.length === 0) return []

    const grouped = new Map<string, AnchorCandidateWithNode & { duplicateCount: number }>()
    for (const c of candidates) {
      const key = c.node!.label.toLowerCase()
      const existing = grouped.get(key)
      if (!existing) {
        grouped.set(key, { ...c, duplicateCount: 0 })
      } else if (c.compositeScore > existing.compositeScore) {
        grouped.set(key, { ...c, duplicateCount: existing.duplicateCount + 1 })
      } else {
        existing.duplicateCount++
      }
    }

    return Array.from(grouped.values())
      .sort((a, b) => b.compositeScore - a.compositeScore)
      .slice(0, 8)
      .map(c => ({
        candidateId:             c.id,
        nodeId:                  c.nodeId ?? '',
        label:                   c.node!.label,
        entityType:              c.node!.entity_type,
        compositeScore:          c.compositeScore,
        reasoningText:           c.reasoningText,
        mentionCount:            c.mentionCount,
        sourceCount:             c.sourceCount,
        velocityDirection:       c.velocityDirection,
        suggestedParentAnchorId: null,
        duplicateCount:          c.duplicateCount,
      }))
  }, [suggestedCandidates])

  // Clear selection on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setSelectedEntityId(null)
        setSelectedSourceId(null)
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [setSelectedEntityId])

  // Mode switching: clear selection
  const handleViewModeChange = useCallback((mode: typeof viewMode) => {
    setSelectedEntityId(null)
    setSelectedSourceId(null)
    setViewMode(mode)
  }, [setViewMode, setSelectedEntityId])

  // Single click: select cluster (show info card). Double-click: enter neighborhood.
  const handleClusterClick = useCallback((cluster: ClusterData) => {
    setSelectedClusterId(prev => prev === cluster.anchor.id ? null : cluster.anchor.id)
    setSelectedSuggestedId(null)
    setSelectedEntityId(null)
    setSelectedSourceId(null)
  }, [setSelectedEntityId])

  const handleClusterDoubleClick = useCallback((cluster: ClusterData) => {
    enterNeighborhood(cluster.anchor.id)
  }, [enterNeighborhood])

  // "Explore" button from the cluster info card
  const handleExploreCluster = useCallback((clusterId: string) => {
    enterNeighborhood(clusterId)
  }, [enterNeighborhood])

  const handleSelectEntity = useCallback((entity: EntityNode | null) => {
    setSelectedEntityId(entity?.id ?? null)
  }, [setSelectedEntityId])

  const handleSelectSource = useCallback((source: SourceNode | null) => {
    setSelectedSourceId(source?.id ?? null)
  }, [])

  const handleSourcesLoaded = useCallback((_sources: SourceNode[], _edges: SourceEdge[]) => {
    // Sources loaded — no further processing needed
  }, [])

  const handleEntitiesLoaded = useCallback((_entities: EntityNode[]) => {
    // Entities available for neighborhood view context
  }, [])

  const handleEdgesLoaded = useCallback((_edges: EntityEdge[]) => {
    // Edges available for neighborhood view context
  }, [])

  const handleToggleShowEdges = useCallback(() => {
    setShowEdges(prev => !prev)
  }, [setShowEdges])

  const handleSuggestedClusterClick = useCallback((candidate: SuggestedClusterData) => {
    setSelectedSuggestedId(candidate.candidateId)
    setSelectedEntityId(null)
    setSelectedSourceId(null)
  }, [setSelectedEntityId])

  // Toolbar props
  const toolbarProps = {
    viewMode,
    onViewModeChange: handleViewModeChange,
    filters,
    clusters: loading || error ? [] : clusters,
    showEdges,
    onToggleShowEdges: handleToggleShowEdges,
    onToggleAnchor: toggleAnchor,
    onEnterNeighborhood: enterNeighborhood,
    onClearAnchor: returnToLandscape,
    visibleEdgeTypes,
    onToggleNeighborhoodEdgeType: toggleNeighborhoodEdgeType,
    onSetSourceAnchorFilter: setSourceAnchorFilter,
    onToggleConnType: toggleConnType,
    onClearAllFilters: clearAllFilters,
    suggestedCount: suggestedClusterData.length,
  }

  return (
    <div className="flex flex-col h-full" style={{ background: 'var(--color-bg-content)' }}>
      <ExploreToolbar {...toolbarProps} />

      {loading ? (
        <div className="flex-1 flex items-center justify-center">
          <LoadingSkeleton />
        </div>
      ) : error ? (
        <div className="flex-1 flex items-center justify-center">
          <ErrorBanner message={error.message} onRetry={refetch} />
        </div>
      ) : clusters.length === 0 && viewMode === 'anchors' ? (
        <div className="flex-1 flex items-center justify-center">
          <EmptyState />
        </div>
      ) : viewMode === 'anchors' && !isNeighborhood ? (
        /* ── LANDSCAPE: Full-screen with floating info card ── */
        <div className="flex-1 overflow-hidden relative">
          <LandscapeView
            clusters={clusters}
            stats={stats}
            unclustered={unclustered}
            isClusterVisible={isClusterVisible}
            onClusterClick={handleClusterClick}
            onClusterDoubleClick={handleClusterDoubleClick}
            onExploreCluster={handleExploreCluster}
            selectedClusterId={selectedClusterId}
            onClearSelection={() => setSelectedClusterId(null)}
            suggestedClusters={suggestedClusterData}
            showCrossEdges={showEdges}
            onSuggestedClusterClick={handleSuggestedClusterClick}
          />
        </div>
      ) : viewMode === 'anchors' && isNeighborhood && activeCluster ? (
        /* ── NEIGHBORHOOD: Full-screen with floating info card ── */
        <div className="flex-1 overflow-hidden relative">
          <NeighborhoodView
            cluster={activeCluster}
            allClusters={clusters}
            filters={filters}
            showEdges={showEdges}
            visibleEdgeTypes={visibleEdgeTypes}
            selectedEntityId={selectedEntityId}
            onSelectEntity={handleSelectEntity}
            onBack={returnToLandscape}
            onEntitiesLoaded={handleEntitiesLoaded}
            onEdgesLoaded={handleEdgesLoaded}
          />
        </div>
      ) : viewMode === 'sources' ? (
        /* ── SOURCE GRAPH: Full-screen canvas ── */
        <div className="flex-1 overflow-hidden relative">
          <SourceGraphView
            filters={filters}
            selectedSourceId={selectedSourceId}
            onSelectSource={handleSelectSource}
            onSourcesLoaded={handleSourcesLoaded}
            showEdges={showEdges}
          />
        </div>
      ) : viewMode === 'playlists' ? (
        /* ── PLAYLIST GRAPH: Cross-playlist video connections ── */
        <div className="flex-1 overflow-hidden relative">
          <PlaylistGraphView showEdges={showEdges} />
        </div>
      ) : null}
    </div>
  )
}

// ─── Loading Skeleton ─────────────────────────────────────────────────────────

function LoadingSkeleton() {
  return (
    <div className="flex flex-col items-center gap-4">
      <div className="flex items-center gap-6">
        {[80, 60, 90, 50, 70].map((size, i) => (
          <div
            key={i}
            style={{
              width: size,
              height: size,
              borderRadius: '50%',
              background: 'var(--color-bg-inset)',
              animation: 'pulse 1.5s ease-in-out infinite',
              animationDelay: `${i * 0.15}s`,
            }}
          />
        ))}
      </div>
      <span
        style={{
          fontFamily: 'var(--font-body)',
          fontSize: 12,
          color: 'var(--color-text-secondary)',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
        }}
      >
        <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} />
        Loading graph…
      </span>
    </div>
  )
}

// ─── Empty State ──────────────────────────────────────────────────────────────

function EmptyState() {
  return (
    <div className="flex flex-col items-center gap-3" style={{ maxWidth: 320, textAlign: 'center' }}>
      <Compass size={32} style={{ color: 'var(--color-text-placeholder)' }} />
      <h3
        style={{
          fontFamily: 'var(--font-display)',
          fontSize: 16,
          fontWeight: 700,
          color: 'var(--color-text-primary)',
        }}
      >
        No anchors yet
      </h3>
      <p
        style={{
          fontFamily: 'var(--font-body)',
          fontSize: 13,
          color: 'var(--color-text-secondary)',
          lineHeight: 1.5,
        }}
      >
        Promote nodes to anchors in Settings to see your knowledge graph organized into clusters.
      </p>
    </div>
  )
}

// ─── Error Banner ─────────────────────────────────────────────────────────────

function ErrorBanner({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div
      className="flex items-center gap-3"
      style={{
        background: 'var(--color-semantic-red-50)',
        border: '1px solid rgba(239,68,68,0.2)',
        borderRadius: 10,
        padding: '12px 18px',
        maxWidth: 420,
      }}
    >
      <AlertCircle size={16} style={{ color: 'var(--color-semantic-red-500)', flexShrink: 0 }} />
      <span
        style={{
          fontFamily: 'var(--font-body)',
          fontSize: 12,
          color: 'var(--color-semantic-red-700)',
          flex: 1,
        }}
      >
        {message}
      </span>
      <button
        type="button"
        onClick={onRetry}
        className="flex items-center gap-1.5 cursor-pointer font-body"
        style={{
          fontSize: 11,
          fontWeight: 600,
          color: 'var(--color-semantic-red-500)',
          background: 'none',
          border: 'none',
          padding: '4px 8px',
        }}
      >
        <RefreshCw size={12} />
        Retry
      </button>
    </div>
  )
}
