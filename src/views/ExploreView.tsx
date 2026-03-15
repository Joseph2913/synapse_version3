import { useState, useCallback, useMemo, useEffect, useRef } from 'react'
import { Loader2, AlertCircle, Compass, RefreshCw, GripVertical } from 'lucide-react'
import { ExploreToolbar } from './explore/ExploreToolbar'
import { LandscapeView } from './explore/LandscapeView'
import { NeighborhoodView } from './explore/NeighborhoodView'
import { SourceGraphView } from './explore/SourceGraphView'
import { ExploreMetadataPanel } from './explore/ExploreMetadataPanel'
import { EntityBrowserTab } from './explore/EntityBrowserTab'
import { useExploreData } from '../hooks/useExploreData'
import { useExploreFilters } from '../hooks/useExploreFilters'
import { useEntityBrowser } from '../hooks/useEntityBrowser'
import type { ClusterData, EntityNode, SourceNode, SourceEdge, SourceGraphAnchor } from '../types/explore'
import type { EntityEdge } from '../services/exploreQueries'
import { useAuth } from '../hooks/useAuth'
import { fetchCandidatesWithNodes, confirmAnchorCandidate, dismissAnchorCandidate } from '../services/anchorCandidates'
import type { AnchorCandidateWithNode } from '../types/anchors'

// ─── Layout constants ────────────────────────────────────────────────────────
const DEFAULT_LEFT_PCT = 67
const MIN_LEFT_PCT = 30
const MAX_LEFT_PCT = 80

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
    toggleSpotlight,
    setRecency,
    isClusterVisible,
    toggleSourceType,
    toggleConnType,
    setSourceAnchorFilter,
  } = useExploreFilters()

  // Entity browser — only fetches when entity-browser tab is active
  const entityBrowser = useEntityBrowser(viewMode === 'entity-browser')

  const { user } = useAuth()

  // Suggested anchor candidates — for ghost cluster rendering
  const [suggestedCandidates, setSuggestedCandidates] = useState<AnchorCandidateWithNode[]>([])
  const [showCrossEdges, setShowCrossEdges] = useState(true)
  const [selectedSuggestedId, setSelectedSuggestedId] = useState<string | null>(null)
  const [selectedClusterId, setSelectedClusterId] = useState<string | null>(null)

  // Fetch suggested candidates for ghost cluster rendering
  useEffect(() => {
    if (!user) return
    fetchCandidatesWithNodes(user.id, ['suggested'])
      .then(setSuggestedCandidates)
      .catch(err => console.warn('[ExploreView] Failed to fetch suggested candidates:', err))
  }, [user])

  // Event listeners for anchor changes
  useEffect(() => {
    const onSuggestionsChanged = () => {
      if (!user) return
      fetchCandidatesWithNodes(user.id, ['suggested'])
        .then(setSuggestedCandidates)
        .catch(() => {})
    }
    const onAnchorConfirmed = () => {
      refetch()
      setTimeout(() => refetch(), 35000)
    }
    window.addEventListener('synapse:anchor-suggestions-changed', onSuggestionsChanged)
    window.addEventListener('synapse:anchor-confirmed', onAnchorConfirmed)
    return () => {
      window.removeEventListener('synapse:anchor-suggestions-changed', onSuggestionsChanged)
      window.removeEventListener('synapse:anchor-confirmed', onAnchorConfirmed)
    }
  }, [user, refetch])

  // Track neighborhood entities + edges for metadata panel
  const [neighborhoodEntities, setNeighborhoodEntities] = useState<EntityNode[]>([])
  const [neighborhoodEdges, setNeighborhoodEdges] = useState<EntityEdge[]>([])

  // Source graph data (managed by SourceGraphView, stored here for metadata panel + toolbar)
  const [allSources, setAllSources] = useState<SourceNode[]>([])
  const [sourceEdges, setSourceEdges] = useState<SourceEdge[]>([])
  const [sourceGraphAnchors, setSourceGraphAnchors] = useState<SourceGraphAnchor[]>([])
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null)

  // Neighborhood edge-type visibility (lifted so toolbar can control it)
  const [visibleEdgeTypes, setVisibleEdgeTypes] = useState<Set<string>>(
    () => new Set(['direct', 'source', 'tag'])
  )
  const toggleNeighborhoodEdgeType = useCallback((type: string) => {
    setVisibleEdgeTypes(prev => {
      const next = new Set(prev)
      if (next.has(type)) next.delete(type); else next.add(type)
      return next
    })
  }, [])
  const clearAllFilters = useCallback(() => {
    toggleSpotlight(null)
    setVisibleEdgeTypes(new Set(['direct', 'source', 'tag']))
  }, [toggleSpotlight])

  // Resizable two-column layout
  const [leftWidthPct, setLeftWidthPct] = useState(DEFAULT_LEFT_PCT)
  const [isDragging, setIsDragging] = useState(false)
  const [isHandleHovered, setIsHandleHovered] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const dragStartX = useRef(0)
  const dragStartPct = useRef(DEFAULT_LEFT_PCT)

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

  const selectedSuggestedCandidate = useMemo(() =>
    selectedSuggestedId
      ? suggestedCandidates.find(c => c.id === selectedSuggestedId) ?? null
      : null,
  [selectedSuggestedId, suggestedCandidates])

  // Unique source types present in data (for toolbar dropdown)
  const sourceTypesPresent = useMemo(() => {
    const types = new Set(allSources.map(s => s.sourceType))
    return Array.from(types).sort()
  }, [allSources])

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

  // Drag-to-resize
  const handleDividerMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    dragStartX.current = e.clientX
    dragStartPct.current = leftWidthPct
    setIsDragging(true)

    const onMouseMove = (ev: MouseEvent) => {
      if (!containerRef.current) return
      const containerWidth = containerRef.current.offsetWidth
      const delta = ev.clientX - dragStartX.current
      const deltaPct = (delta / containerWidth) * 100
      setLeftWidthPct(Math.max(MIN_LEFT_PCT, Math.min(MAX_LEFT_PCT, dragStartPct.current + deltaPct)))
    }

    const onMouseUp = () => {
      setIsDragging(false)
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
    }

    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }, [leftWidthPct])

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

  const handleSourcesLoaded = useCallback((sources: SourceNode[], edges: SourceEdge[], anchors: SourceGraphAnchor[]) => {
    setAllSources(sources)
    setSourceEdges(edges)
    setSourceGraphAnchors(anchors)
  }, [])

  const handleEntitiesLoaded = useCallback((entities: EntityNode[]) => {
    setNeighborhoodEntities(entities)
  }, [])

  const handleEdgesLoaded = useCallback((edges: EntityEdge[]) => {
    setNeighborhoodEdges(edges)
  }, [])

  const handleToggleShowEdges = useCallback(() => {
    setShowEdges(prev => !prev)
  }, [setShowEdges])

  const handleSuggestedClusterClick = useCallback((candidate: SuggestedClusterData) => {
    setSelectedSuggestedId(candidate.candidateId)
    setSelectedEntityId(null)
    setSelectedSourceId(null)
  }, [setSelectedEntityId])

  const handleConfirmFromExplore = useCallback(async (candidateId: string, nodeId: string) => {
    const success = await confirmAnchorCandidate(candidateId, nodeId)
    if (success) {
      setSuggestedCandidates(prev => prev.filter(c => c.id !== candidateId))
      setSelectedSuggestedId(null)
      refetch()
      setTimeout(() => refetch(), 35000)
      window.dispatchEvent(new CustomEvent('synapse:anchor-suggestions-changed'))
      window.dispatchEvent(new CustomEvent('synapse:anchor-confirmed', { detail: { nodeId } }))
    }
  }, [refetch])

  const handleDismissFromExplore = useCallback(async (candidateId: string, dismissCount: number) => {
    const success = await dismissAnchorCandidate(candidateId, dismissCount, 30)
    if (success) {
      setSuggestedCandidates(prev => prev.filter(c => c.id !== candidateId))
      setSelectedSuggestedId(null)
      window.dispatchEvent(new CustomEvent('synapse:anchor-suggestions-changed'))
    }
  }, [])

  // Shared toolbar props
  const toolbarProps = {
    viewMode,
    onViewModeChange: handleViewModeChange,
    filters,
    onToggleAnchor: toggleAnchor,
    onEnterNeighborhood: enterNeighborhood,
    onClearAnchor: returnToLandscape,
    onToggleSpotlight: toggleSpotlight,
    onRecencyChange: setRecency,
    clusters,
    isNeighborhood,
    showEdges,
    onToggleShowEdges: handleToggleShowEdges,
    // Source-mode filter props
    sourceTypesPresent,
    sourceGraphAnchors,
    onToggleSourceType: toggleSourceType,
    onToggleConnType: toggleConnType,
    onSetSourceAnchorFilter: setSourceAnchorFilter,
    // Neighborhood edge-type filter
    visibleEdgeTypes,
    onToggleNeighborhoodEdgeType: toggleNeighborhoodEdgeType,
    onClearAllFilters: clearAllFilters,
    // Entity browser state (controls rendered inline in toolbar)
    entityBrowser,
    suggestedCount: suggestedClusterData.length,
    showCrossEdges,
    onToggleShowCrossEdges: () => setShowCrossEdges(prev => !prev),
  }

  // Determine effective clusters for toolbar (empty when loading/errored)
  const toolbarClusters = loading || error ? [] : clusters

  return (
    <div className="flex flex-col h-full" style={{ background: 'var(--color-bg-content)' }}>
      <ExploreToolbar {...toolbarProps} clusters={toolbarClusters} />

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
      ) : viewMode === 'entity-browser' ? (
        <div className="flex-1 overflow-hidden">
          <EntityBrowserTab browser={entityBrowser} />
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
            showCrossEdges={showCrossEdges}
            onSuggestedClusterClick={handleSuggestedClusterClick}
          />
        </div>
      ) : viewMode === 'anchors' && isNeighborhood && activeCluster ? (
        /* ── NEIGHBORHOOD: Full-screen with floating info card (spec Section 1.5) ── */
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
      ) : (

      /* ── SOURCE GRAPH: Split panel layout ── */
      <div
        ref={containerRef}
        className="flex-1 flex overflow-hidden"
        style={{
          userSelect: isDragging ? 'none' : undefined,
          cursor: isDragging ? 'col-resize' : undefined,
        }}
      >
        {/* ── LEFT: Graph visualization ── */}
        <div
          className="h-full overflow-hidden"
          style={{
            width: `${leftWidthPct}%`,
            flexShrink: 0,
            transition: isDragging ? 'none' : 'width 0.2s ease',
          }}
        >
          {viewMode === 'sources' && (
            <SourceGraphView
              filters={filters}
              selectedSourceId={selectedSourceId}
              onSelectSource={handleSelectSource}
              onSourcesLoaded={handleSourcesLoaded}
            />
          )}
        </div>

        {/* ── Resize handle ── */}
        <div
          className="flex-shrink-0 flex items-center justify-center"
          onMouseDown={handleDividerMouseDown}
          onMouseEnter={() => setIsHandleHovered(true)}
          onMouseLeave={() => setIsHandleHovered(false)}
          style={{
            width: 16,
            cursor: 'col-resize',
            position: 'relative',
            flexShrink: 0,
            zIndex: 1,
          }}
        >
          <div style={{
            position: 'absolute',
            left: '50%',
            transform: 'translateX(-50%)',
            top: 0,
            bottom: 0,
            width: 2,
            background: (isDragging || isHandleHovered) ? 'var(--color-accent-500)' : 'var(--border-subtle)',
            transition: 'background 0.15s ease',
            borderRadius: 1,
          }} />
          <GripVertical
            size={14}
            style={{
              position: 'relative',
              zIndex: 1,
              color: (isDragging || isHandleHovered) ? 'var(--color-accent-500)' : 'var(--color-text-placeholder)',
              transition: 'color 0.15s ease',
              background: 'var(--color-bg-content)',
              borderRadius: 2,
            }}
          />
        </div>

        {/* ── RIGHT: Metadata panel ── */}
        <div
          className="flex-1 h-full overflow-hidden"
          style={{ minWidth: 0 }}
        >
          <ExploreMetadataPanel
            viewMode={viewMode}
            zoomLevel={zoomLevel}
            activeCluster={activeCluster}
            neighborhoodEntities={neighborhoodEntities}
            neighborhoodEdges={neighborhoodEdges}
            allSources={allSources}
            sourceEdges={sourceEdges}
            sourceGraphAnchors={sourceGraphAnchors}
            selectedEntityId={selectedEntityId}
            selectedSourceId={selectedSourceId}
            onSelectEntity={handleSelectEntity}
            onSelectSource={handleSelectSource}
            onBack={returnToLandscape}
            filters={filters}
            onClearSpotlight={() => toggleSpotlight(null)}
            selectedSuggestedCandidate={selectedSuggestedCandidate}
            onConfirmSuggested={handleConfirmFromExplore}
            onDismissSuggested={handleDismissFromExplore}
            onClearSuggested={() => setSelectedSuggestedId(null)}
          />
        </div>
      </div>
      )}
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
