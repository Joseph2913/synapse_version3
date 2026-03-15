import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { ArrowLeft, ChevronRight } from 'lucide-react'
import { EntityDot } from '../../components/explore/EntityDot'
import { NodeTooltip } from '../../components/explore/NodeTooltip'
import { useEntityLayout, type EntityPosition } from '../../hooks/useEntityLayout'
import { useAuth } from '../../hooks/useAuth'
import { fetchClusterEntities, fetchEntityEdges } from '../../services/exploreQueries'
import { getEntityColor } from '../../config/entityTypes'
import type { ClusterData, EntityNode, ExploreFilters } from '../../types/explore'
import type { EntityEdge } from '../../services/exploreQueries'
import type { TooltipData } from '../../components/explore/NodeTooltip'

interface NeighborhoodViewProps {
  cluster: ClusterData
  allClusters: ClusterData[]
  filters: ExploreFilters
  showEdges: boolean
  visibleEdgeTypes: Set<string>
  selectedEntityId: string | null
  onSelectEntity: (entity: EntityNode | null) => void
  onBack: () => void
  onAutoBack?: () => void
  onEntitiesLoaded?: (entities: EntityNode[]) => void
  onEdgesLoaded?: (edges: EntityEdge[]) => void
}

const HUB_CONNECTION_THRESHOLD = 7
const MIN_ZOOM = 0.2
const MAX_ZOOM = 4.0
const AUTO_BACK_ZOOM = 0.35

interface Camera { zoom: number; panX: number; panY: number }

export function NeighborhoodView({
  cluster,
  allClusters,
  filters,
  showEdges,
  visibleEdgeTypes,
  selectedEntityId,
  onSelectEntity,
  onBack,
  onAutoBack,
  onEntitiesLoaded,
  onEdgesLoaded,
}: NeighborhoodViewProps) {
  const { user } = useAuth()
  const containerRef = useRef<HTMLDivElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const sizeRef = useRef({ width: 0, height: 0 })

  // Camera (zoom + pan)
  const [camera, setCamera] = useState<Camera>({ zoom: 1, panX: 0, panY: 0 })
  const cameraRef = useRef<Camera>({ zoom: 1, panX: 0, panY: 0 })
  useEffect(() => { cameraRef.current = camera }, [camera])

  // Data state
  const [entities, setEntities] = useState<EntityNode[]>([])
  const [edges, setEdges] = useState<EntityEdge[]>([])
  const [loading, setLoading] = useState(true)

  // PRD-23: Parent mode — show sub-anchor entities
  const isParentMode = cluster.subAnchorIds.length > 0
  const [activeSubAnchorId, setActiveSubAnchorId] = useState<string | null>(null)

  // Reset sub-anchor filter when cluster changes
  useEffect(() => { setActiveSubAnchorId(null) }, [cluster.anchor.id])

  // Synthetic co-source edges — hub-and-spoke per source document (needed before layout)
  const coSourceEdgesForLayout = useMemo((): EntityEdge[] => {
    const bySource = new Map<string, EntityNode[]>()
    for (const e of entities) {
      if (!e.sourceId) continue
      const group = bySource.get(e.sourceId) ?? []
      group.push(e)
      bySource.set(e.sourceId, group)
    }
    const result: EntityEdge[] = []
    for (const [, group] of bySource) {
      if (group.length < 2) continue
      const sorted = [...group].sort((a, b) => b.connectionCount - a.connectionCount)
      const hub = sorted[0]!
      for (let i = 1; i < sorted.length; i++) {
        result.push({ sourceNodeId: hub.id, targetNodeId: sorted[i]!.id, relationType: 'co-source', weight: 0.3 })
      }
    }
    return result
  }, [entities])

  // Synthetic co-tag edges — hub-and-spoke per shared tag (skip tags shared by too many to avoid noise)
  const coTagEdgesForLayout = useMemo((): EntityEdge[] => {
    const byTag = new Map<string, EntityNode[]>()
    for (const e of entities) {
      for (const tag of e.tags) {
        if (!byTag.has(tag)) byTag.set(tag, [])
        byTag.get(tag)!.push(e)
      }
    }
    const result: EntityEdge[] = []
    for (const [, group] of byTag) {
      if (group.length < 2 || group.length > 25) continue
      const sorted = [...group].sort((a, b) => b.connectionCount - a.connectionCount)
      const hub = sorted[0]!
      for (let i = 1; i < sorted.length; i++) {
        result.push({ sourceNodeId: hub.id, targetNodeId: sorted[i]!.id, relationType: 'co-tag', weight: 0.2 })
      }
    }
    return result
  }, [entities])

  const allEdgesForLayout = useMemo(
    () => [...edges, ...coSourceEdgesForLayout, ...coTagEdgesForLayout],
    [edges, coSourceEdgesForLayout, coTagEdgesForLayout]
  )

  // Draggable positions — live state so drag updates trigger re-render
  // Uses allEdgesForLayout (real + co-source) so co-source entities attract each other
  const layoutPositions = useEntityLayout(entities, allEdgesForLayout, size.width, size.height)
  const [nodePositions, setNodePositions] = useState<Map<string, EntityPosition>>(new Map())
  useEffect(() => { setNodePositions(layoutPositions) }, [layoutPositions])

  // Ref so drag handler never has stale allEdgesForLayout
  const allEdgesForLayoutRef = useRef(allEdgesForLayout)
  useEffect(() => { allEdgesForLayoutRef.current = allEdgesForLayout }, [allEdgesForLayout])

  // Drag & pan refs (no state to avoid re-renders on every frame)
  const dragNodeRef = useRef<{ id: string } | null>(null)
  const panStartRef = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null)
  const hasDraggedRef = useRef(false)
  const hasAutoBackedRef = useRef(false)

  // Tooltip state
  const [tooltip, setTooltip] = useState<{ data: TooltipData; x: number; y: number } | null>(null)
  const tooltipTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Hovered entity (for edge highlighting)
  const [hoveredEntityId, setHoveredEntityId] = useState<string | null>(null)

  // ResizeObserver
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const obs = new ResizeObserver(entries => {
      const entry = entries[0]
      if (entry) {
        const s = { width: entry.contentRect.width, height: entry.contentRect.height }
        setSize(s)
        sizeRef.current = s
      }
    })
    obs.observe(el)
    return () => obs.disconnect()
  }, [])

  // Fetch cluster entities and edges
  useEffect(() => {
    if (!user) return
    let cancelled = false
    setLoading(true)

    async function load() {
      try {
        const subIds = isParentMode ? cluster.subAnchorIds : []
        const entityData = await fetchClusterEntities(user!.id, cluster.anchor.id, allClusters, subIds)
        if (cancelled) return
        setEntities(entityData)
        onEntitiesLoaded?.(entityData)

        const nodeIds = entityData.map(e => e.id)
        const edgeData = await fetchEntityEdges(user!.id, nodeIds)
        if (cancelled) return
        setEdges(edgeData)
        onEdgesLoaded?.(edgeData)
      } catch (err) {
        console.warn('NeighborhoodView fetch error:', err)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [user, cluster.anchor.id, allClusters, onEntitiesLoaded, onEdgesLoaded])

  // Anchor entity — the cluster's own anchor in the entities list
  const anchorEntity = useMemo(
    () => entities.find(e => e.isAnchor && e.clusters.includes(cluster.anchor.id)),
    [entities, cluster.anchor.id]
  )

  // PRD-23: Filtered entities for display (sub-anchor filter in parent mode)
  const displayEntities = useMemo(() => {
    if (!isParentMode || !activeSubAnchorId) return entities
    return entities.filter(e =>
      e.originAnchorId === activeSubAnchorId ||
      e.originAnchorId === cluster.anchor.id
    )
  }, [entities, isParentMode, activeSubAnchorId, cluster.anchor.id])

  // Peripheral entities (belong to other clusters)
  const peripheralIds = useMemo(() => {
    const set = new Set<string>()
    for (const e of entities) {
      if (e.clusters.length > 0 && !e.clusters.includes(cluster.anchor.id)) {
        set.add(e.id)
      }
    }
    return set
  }, [entities, cluster.anchor.id])

  // Edge map keyed by node id
  const edgesForNode = useMemo(() => {
    const map = new Map<string, EntityEdge[]>()
    for (const e of edges) {
      const a = map.get(e.sourceNodeId) ?? []
      a.push(e); map.set(e.sourceNodeId, a)
      const b = map.get(e.targetNodeId) ?? []
      b.push(e); map.set(e.targetNodeId, b)
    }
    return map
  }, [edges])

  // Entities connected to the selected node (for dimming non-connected)
  const connectedToSelected = useMemo(() => {
    if (!selectedEntityId) return null
    const set = new Set<string>([selectedEntityId])
    for (const edge of edgesForNode.get(selectedEntityId) ?? []) {
      set.add(edge.sourceNodeId)
      set.add(edge.targetNodeId)
    }
    return set
  }, [selectedEntityId, edgesForNode])

  // Filter visibility
  const isEntityVisible = useCallback((entity: EntityNode): boolean => {
    if (!filters.searchQuery && !filters.spotlightEntityType) return true
    if (filters.spotlightEntityType) return entity.entityType === filters.spotlightEntityType
    if (filters.searchQuery) return entity.label.toLowerCase().includes(filters.searchQuery.toLowerCase())
    return true
  }, [filters])

  // Boundary radius uses static layout (stays stable while dragging nodes)
  const boundaryRadius = useMemo(() => {
    if (layoutPositions.size === 0) return 0
    let maxDist = 0
    const cx = size.width / 2
    const cy = size.height / 2
    for (const [, pos] of layoutPositions) {
      const dx = pos.x - cx
      const dy = pos.y - cy
      const dist = Math.sqrt(dx * dx + dy * dy) + pos.radius
      if (dist > maxDist) maxDist = dist
    }
    return maxDist + 30
  }, [layoutPositions, size])

  // Visible edges
  const visibleEdges = useMemo(() => {
    if (showEdges) return edges
    const activeId = hoveredEntityId || selectedEntityId
    if (!activeId) return []
    return edgesForNode.get(activeId) ?? []
  }, [showEdges, hoveredEntityId, selectedEntityId, edges, edgesForNode])

  // ── Camera helpers ────────────────────────────────────────────────────────

  const zoomAround = useCallback((factor: number, cx: number, cy: number) => {
    setCamera(prev => {
      const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, prev.zoom * factor))
      return {
        zoom: newZoom,
        panX: cx - (cx - prev.panX) / prev.zoom * newZoom,
        panY: cy - (cy - prev.panY) / prev.zoom * newZoom,
      }
    })
  }, [])

  const zoomIn = useCallback(() => {
    zoomAround(1.25, sizeRef.current.width / 2, sizeRef.current.height / 2)
  }, [zoomAround])

  const zoomOut = useCallback(() => {
    zoomAround(0.8, sizeRef.current.width / 2, sizeRef.current.height / 2)
  }, [zoomAround])

  const resetCamera = useCallback(() => {
    setCamera({ zoom: 1, panX: 0, panY: 0 })
  }, [])

  // Stable ref for onAutoBack — avoids stale closure in wheel effect with [] deps
  const onAutoBackRef = useRef(onAutoBack)
  useEffect(() => { onAutoBackRef.current = onAutoBack }, [onAutoBack])

  // Wheel zoom (non-passive; attached to containerRef which is always mounted)
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const svg = svgRef.current
      if (!svg) return
      const rect = svg.getBoundingClientRect()
      const sx = e.clientX - rect.left
      const sy = e.clientY - rect.top

      if (e.ctrlKey) {
        // Trackpad pinch or Ctrl+scroll → zoom around cursor
        setCamera(prev => {
          const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, prev.zoom * (1 - e.deltaY * 0.01)))
          if (onAutoBackRef.current && newZoom <= AUTO_BACK_ZOOM && prev.zoom > AUTO_BACK_ZOOM && !hasAutoBackedRef.current) {
            hasAutoBackedRef.current = true
            setTimeout(() => onAutoBackRef.current?.(), 0)
          }
          return {
            zoom: newZoom,
            panX: sx - (sx - prev.panX) / prev.zoom * newZoom,
            panY: sy - (sy - prev.panY) / prev.zoom * newZoom,
          }
        })
      } else if (Math.abs(e.deltaX) > 2) {
        // Trackpad two-finger horizontal swipe → pan
        setCamera(prev => ({
          ...prev,
          panX: prev.panX - e.deltaX,
          panY: prev.panY - e.deltaY,
        }))
      } else {
        // Mouse scroll wheel → zoom around cursor
        setCamera(prev => {
          const factor = e.deltaY < 0 ? 1.12 : 0.9
          const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, prev.zoom * factor))
          if (onAutoBackRef.current && newZoom <= AUTO_BACK_ZOOM && prev.zoom > AUTO_BACK_ZOOM && !hasAutoBackedRef.current) {
            hasAutoBackedRef.current = true
            setTimeout(() => onAutoBackRef.current?.(), 0)
          }
          return {
            zoom: newZoom,
            panX: sx - (sx - prev.panX) / prev.zoom * newZoom,
            panY: sy - (sy - prev.panY) / prev.zoom * newZoom,
          }
        })
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  // Keyboard zoom: +/= to zoom in, -/_ to zoom out, 0 to reset
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      if (e.key === '+' || e.key === '=') { zoomIn(); e.preventDefault() }
      else if (e.key === '-' || e.key === '_') { zoomOut(); e.preventDefault() }
      else if (e.key === '0') { resetCamera(); e.preventDefault() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [zoomIn, zoomOut, resetCamera])

  // ── SVG interaction ───────────────────────────────────────────────────────

  const toWorldPos = (clientX: number, clientY: number) => {
    const rect = containerRef.current!.getBoundingClientRect()
    const cam = cameraRef.current
    return {
      wx: (clientX - rect.left - cam.panX) / cam.zoom,
      wy: (clientY - rect.top - cam.panY) / cam.zoom,
    }
  }

  const hitTestEntity = (wx: number, wy: number): EntityNode | null => {
    for (let i = entities.length - 1; i >= 0; i--) {
      const entity = entities[i]!
      const pos = nodePositions.get(entity.id)
      if (!pos) continue
      const dx = wx - pos.x
      const dy = wy - pos.y
      if (Math.sqrt(dx * dx + dy * dy) < pos.radius + 8) return entity
    }
    return null
  }

  const handleSvgMouseDown = (e: React.MouseEvent<SVGSVGElement>) => {
    hasDraggedRef.current = false
    const { wx, wy } = toWorldPos(e.clientX, e.clientY)
    const hit = hitTestEntity(wx, wy)

    if (hit) {
      dragNodeRef.current = { id: hit.id }
      if (svgRef.current) svgRef.current.style.cursor = 'grabbing'
    } else {
      const cam = cameraRef.current
      panStartRef.current = { x: e.clientX, y: e.clientY, panX: cam.panX, panY: cam.panY }
      if (svgRef.current) svgRef.current.style.cursor = 'grab'
    }
  }

  const handleSvgMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (dragNodeRef.current) {
      const { wx, wy } = toWorldPos(e.clientX, e.clientY)
      const id = dragNodeRef.current.id
      setNodePositions(prev => {
        const old = prev.get(id)
        if (!old) return prev
        const dx = wx - old.x
        const dy = wy - old.y
        const next = new Map(prev)
        next.set(id, { ...old, x: wx, y: wy })
        // Spring: pull connected nodes toward the dragged node
        for (const edge of allEdgesForLayoutRef.current) {
          if (edge.sourceNodeId !== id && edge.targetNodeId !== id) continue
          const otherId = edge.sourceNodeId === id ? edge.targetNodeId : edge.sourceNodeId
          const other = next.get(otherId)
          if (!other) continue
          const k = edge.relationType === 'co-source' ? 0.08
                   : edge.relationType === 'co-tag'    ? 0.05
                   : 0.15 // knowledge edge
          next.set(otherId, { ...other, x: other.x + dx * k, y: other.y + dy * k })
        }
        return next
      })
      hasDraggedRef.current = true
    } else if (panStartRef.current) {
      const dx = e.clientX - panStartRef.current.x
      const dy = e.clientY - panStartRef.current.y
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) hasDraggedRef.current = true
      const { panX: startPanX, panY: startPanY } = panStartRef.current
      setCamera(prev => ({ ...prev, panX: startPanX + dx, panY: startPanY + dy }))
    }
  }

  const handleSvgMouseUp = () => {
    dragNodeRef.current = null
    panStartRef.current = null
    if (svgRef.current) svgRef.current.style.cursor = 'default'
  }

  const handleSvgClick = (e: React.MouseEvent<SVGSVGElement>) => {
    if (e.target === e.currentTarget && !hasDraggedRef.current) {
      onSelectEntity(null)
    }
    hasDraggedRef.current = false
  }

  // ── Entity event handlers ─────────────────────────────────────────────────

  const handleEntityHover = useCallback((entity: EntityNode | null, event: React.MouseEvent) => {
    if (dragNodeRef.current) return  // suppress during drag
    if (tooltipTimerRef.current) {
      clearTimeout(tooltipTimerRef.current)
      tooltipTimerRef.current = null
    }
    if (entity) {
      tooltipTimerRef.current = setTimeout(() => {
        setTooltip({
          data: { kind: 'entity', data: entity },
          x: event.clientX,
          y: event.clientY,
        })
      }, 120)
      setHoveredEntityId(entity.id)
    } else {
      setTooltip(null)
      setHoveredEntityId(null)
    }
  }, [])

  const handleEntityClick = useCallback((entity: EntityNode) => {
    if (hasDraggedRef.current) return  // was a drag, not a click
    onSelectEntity(selectedEntityId === entity.id ? null : entity)
  }, [onSelectEntity, selectedEntityId])

  useEffect(() => {
    return () => {
      if (tooltipTimerRef.current) clearTimeout(tooltipTimerRef.current)
    }
  }, [])

  if (loading) {
    return (
      <div ref={containerRef} className="relative w-full h-full flex items-center justify-center">
        <span
          style={{
            fontFamily: 'var(--font-body)',
            fontSize: 12,
            color: 'var(--color-text-secondary)',
          }}
        >
          Loading entities…
        </span>
      </div>
    )
  }

  return (
    <div ref={containerRef} className="relative w-full h-full" style={{ overflow: 'hidden' }}>
      {size.width > 0 && size.height > 0 && (
        <svg
          ref={svgRef}
          width={size.width}
          height={size.height}
          style={{ display: 'block' }}
          onMouseDown={handleSvgMouseDown}
          onMouseMove={handleSvgMouseMove}
          onMouseUp={handleSvgMouseUp}
          onMouseLeave={handleSvgMouseUp}
          onClick={handleSvgClick}
        >
          {/* Camera transform — wraps all world-space content */}
          <g transform={`translate(${camera.panX},${camera.panY}) scale(${camera.zoom})`}>
            {/* 1. Cluster boundary ghost (subtle ring, kept for spatial context) */}
            <circle
              cx={size.width / 2}
              cy={size.height / 2}
              r={boundaryRadius}
              fill="none"
              stroke="rgba(180,83,9,0.06)"
              strokeWidth={1.5}
            />

            {/* 2a. Co-source background edges */}
            {visibleEdgeTypes.has('source') && coSourceEdgesForLayout.map(edge => {
              const sourcePos = nodePositions.get(edge.sourceNodeId)
              const targetPos = nodePositions.get(edge.targetNodeId)
              if (!sourcePos || !targetPos) return null
              return (
                <line
                  key={`cs-${edge.sourceNodeId}-${edge.targetNodeId}`}
                  x1={sourcePos.x}
                  y1={sourcePos.y}
                  x2={targetPos.x}
                  y2={targetPos.y}
                  stroke={(() => {
                    if (connectedToSelected === null) return 'rgba(37,99,235,0.32)'
                    const hit = edge.sourceNodeId === selectedEntityId || edge.targetNodeId === selectedEntityId
                    return hit ? 'rgba(37,99,235,0.78)' : 'rgba(37,99,235,0.05)'
                  })()}
                  strokeWidth={connectedToSelected !== null && (edge.sourceNodeId === selectedEntityId || edge.targetNodeId === selectedEntityId) ? 2.5 : 1.5}
                  strokeDasharray="7 4"
                  style={{ transition: 'stroke 0.18s ease, stroke-width 0.18s ease' }}
                />
              )
            })}

            {/* 2b. Co-tag background edges */}
            {visibleEdgeTypes.has('tag') && coTagEdgesForLayout.map(edge => {
              const sourcePos = nodePositions.get(edge.sourceNodeId)
              const targetPos = nodePositions.get(edge.targetNodeId)
              if (!sourcePos || !targetPos) return null
              return (
                <line
                  key={`ct-${edge.sourceNodeId}-${edge.targetNodeId}`}
                  x1={sourcePos.x}
                  y1={sourcePos.y}
                  x2={targetPos.x}
                  y2={targetPos.y}
                  stroke={(() => {
                    if (connectedToSelected === null) return 'rgba(124,58,237,0.30)'
                    const hit = edge.sourceNodeId === selectedEntityId || edge.targetNodeId === selectedEntityId
                    return hit ? 'rgba(124,58,237,0.75)' : 'rgba(124,58,237,0.04)'
                  })()}
                  strokeWidth={connectedToSelected !== null && (edge.sourceNodeId === selectedEntityId || edge.targetNodeId === selectedEntityId) ? 2.5 : 1.5}
                  strokeDasharray="2 5"
                  style={{ transition: 'stroke 0.18s ease, stroke-width 0.18s ease' }}
                />
              )
            })}

            {/* 2c. Knowledge edges */}
            {visibleEdgeTypes.has('direct') && visibleEdges.map(edge => {
              const sourcePos = nodePositions.get(edge.sourceNodeId)
              const targetPos = nodePositions.get(edge.targetNodeId)
              if (!sourcePos || !targetPos) return null

              const isSelected =
                selectedEntityId === edge.sourceNodeId || selectedEntityId === edge.targetNodeId
              const isHovered =
                hoveredEntityId === edge.sourceNodeId || hoveredEntityId === edge.targetNodeId

              const dx = targetPos.x - sourcePos.x
              const dy = targetPos.y - sourcePos.y
              const mx = (sourcePos.x + targetPos.x) / 2
              const my = (sourcePos.y + targetPos.y) / 2
              const len = Math.sqrt(dx * dx + dy * dy) || 1
              const offset = Math.min(len * 0.15, 30)
              const ecx = mx - dy * offset / len
              const ecy = my + dx * offset / len

              return (
                <g key={`${edge.sourceNodeId}-${edge.targetNodeId}`}>
                  <path
                    d={`M ${sourcePos.x} ${sourcePos.y} Q ${ecx} ${ecy} ${targetPos.x} ${targetPos.y}`}
                    fill="none"
                    stroke={
                      isSelected
                        ? 'var(--color-accent-500)'
                        : isHovered
                          ? 'rgba(0,0,0,0.2)'
                          : 'rgba(0,0,0,0.15)'
                    }
                    strokeWidth={isSelected ? 2 : 1}
                    style={{ transition: 'stroke 0.15s ease, stroke-width 0.15s ease' }}
                  />
                  {isSelected && edge.relationType && (
                    <text
                      x={ecx}
                      y={ecy - 6}
                      textAnchor="middle"
                      style={{
                        fontFamily: 'var(--font-body)',
                        fontSize: 8,
                        fontWeight: 500,
                        fill: 'var(--color-accent-600)',
                        pointerEvents: 'none',
                        textShadow: '0 0 3px var(--color-bg-content), 0 0 3px var(--color-bg-content)',
                      }}
                    >
                      {edge.relationType}
                    </text>
                  )}
                </g>
              )
            })}

            {/* 3. Entity nodes — use displayEntities for sub-anchor filtering */}
            {displayEntities.map(entity => {
              const pos = nodePositions.get(entity.id)
              if (!pos) return null

              const isHub = entity.connectionCount >= HUB_CONNECTION_THRESHOLD
              const isPeripheral = peripheralIds.has(entity.id)
              const filterVisible = isEntityVisible(entity)
              const isDimmed = !filterVisible || (connectedToSelected !== null && !connectedToSelected.has(entity.id))

              // PRD-23: Origin ring for entities from sub-anchors (parent mode)
              const originCluster = isParentMode && entity.originAnchorId && entity.originAnchorId !== cluster.anchor.id
                ? allClusters.find(c => c.anchor.id === entity.originAnchorId)
                : null

              return (
                <g key={entity.id}>
                  {originCluster && (
                    <circle
                      cx={pos.x}
                      cy={pos.y}
                      r={(pos.radius ?? 6) + 3}
                      fill="none"
                      stroke={getEntityColor(originCluster.anchor.entityType)}
                      strokeWidth={1}
                      strokeOpacity={0.3}
                      style={{ pointerEvents: 'none' }}
                    />
                  )}
                  <EntityDot
                    entity={entity}
                    x={pos.x}
                    y={pos.y}
                    radius={pos.radius}
                    selected={selectedEntityId === entity.id}
                    dimmed={isDimmed}
                    isPeripheral={isPeripheral}
                    isHubLabel={isHub}
                    showAllLabels={camera.zoom >= 1.5}
                    onHover={handleEntityHover}
                    onClick={handleEntityClick}
                  />
                </g>
              )
            })}

            {/* 4. Hub anchor node — always at center, on top of entities */}
            <g
              transform={`translate(${size.width / 2}, ${size.height / 2})`}
              onClick={() => { if (anchorEntity) onSelectEntity(anchorEntity) }}
              style={{ cursor: anchorEntity ? 'pointer' : 'default' }}
            >
              {/* Glow aura */}
              <circle r={36} fill="rgba(180,83,9,0.05)" />
              <circle r={28} fill="rgba(180,83,9,0.09)" />
              {/* Gold border ring */}
              <circle r={22} fill="none" stroke="rgba(180,83,9,0.75)" strokeWidth={2.5} />
              {/* Parchment fill */}
              <circle r={20} fill="rgb(235,222,205)" />
              {/* ⚓ symbol */}
              <text
                y={2}
                textAnchor="middle"
                dominantBaseline="middle"
                style={{ fontSize: 14, fill: 'rgba(140,70,0,0.85)', pointerEvents: 'none', userSelect: 'none' }}
              >
                ⚓
              </text>
              {/* Anchor label below */}
              <text
                y={33}
                textAnchor="middle"
                style={{
                  fontFamily: 'var(--font-display)',
                  fontSize: 9,
                  fontWeight: 700,
                  fill: 'rgba(140,70,0,0.85)',
                  pointerEvents: 'none',
                  userSelect: 'none',
                }}
              >
                {cluster.anchor.label.length > 20
                  ? cluster.anchor.label.slice(0, 19) + '…'
                  : cluster.anchor.label}
              </text>
            </g>
          </g>
        </svg>
      )}

      {/* Breadcrumb — top-left */}
      <div
        style={{
          position: 'absolute',
          top: 16,
          left: 16,
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          pointerEvents: 'none',
        }}
      >
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-1 cursor-pointer font-body"
          style={{
            fontSize: 11,
            fontWeight: 500,
            color: 'var(--color-text-secondary)',
            background: 'var(--color-bg-card)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 8,
            padding: '5px 10px',
            transition: 'all 0.15s ease',
            pointerEvents: 'all',
          }}
        >
          <ArrowLeft size={12} />
          All clusters
        </button>
        <ChevronRight size={12} style={{ color: 'var(--color-text-placeholder)' }} />
        <span
          className="flex items-center gap-1.5"
          style={{
            fontFamily: 'var(--font-body)',
            fontSize: 11,
            fontWeight: 600,
            color: 'var(--color-text-primary)',
            background: 'var(--color-bg-card)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 8,
            padding: '5px 10px',
          }}
        >
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: getEntityColor(cluster.anchor.entityType),
              flexShrink: 0,
            }}
          />
          {cluster.anchor.label}
        </span>
      </div>

      {/* PRD-23: Sub-anchor navigation pills (parent mode only) */}
      {isParentMode && (
        <div
          style={{
            position: 'absolute',
            top: 46,
            left: 16,
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            flexWrap: 'wrap',
            pointerEvents: 'all',
            maxWidth: '60%',
          }}
        >
          <button
            type="button"
            onClick={() => setActiveSubAnchorId(null)}
            className="font-body font-semibold"
            style={{
              padding: '3px 10px', borderRadius: 20, cursor: 'pointer',
              fontSize: 11,
              background: !activeSubAnchorId ? 'var(--color-accent-50)' : 'var(--color-bg-card)',
              border: !activeSubAnchorId
                ? '1px solid rgba(214,58,0,0.2)'
                : '1px solid var(--border-subtle)',
              color: !activeSubAnchorId
                ? 'var(--color-accent-500)'
                : 'var(--color-text-secondary)',
            }}
          >
            All ({entities.length})
          </button>
          {cluster.subAnchorIds.map(subId => {
            const subCluster = allClusters.find(c => c.anchor.id === subId)
            if (!subCluster) return null
            const subEntities = entities.filter(e => e.originAnchorId === subId)
            const isActive = activeSubAnchorId === subId

            return (
              <button
                key={subId}
                type="button"
                onClick={() => setActiveSubAnchorId(isActive ? null : subId)}
                className="font-body font-semibold"
                style={{
                  padding: '3px 10px', borderRadius: 20, cursor: 'pointer',
                  fontSize: 11,
                  background: isActive ? 'var(--color-accent-50)' : 'var(--color-bg-card)',
                  border: isActive
                    ? '1px solid rgba(214,58,0,0.2)'
                    : '1px solid var(--border-subtle)',
                  color: isActive
                    ? 'var(--color-accent-500)'
                    : 'var(--color-text-secondary)',
                }}
              >
                {subCluster.anchor.label.length > 16
                  ? subCluster.anchor.label.slice(0, 14) + '…'
                  : subCluster.anchor.label}
                {' '}({subEntities.length})
              </button>
            )
          })}
        </div>
      )}

      {/* Entity count — top-right */}
      <div
        style={{
          position: 'absolute',
          top: 16,
          right: 16,
          background: 'var(--color-bg-card)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 10,
          padding: '8px 12px',
          fontFamily: 'var(--font-body)',
          fontSize: 11,
          color: 'var(--color-text-secondary)',
          pointerEvents: 'none',
        }}
      >
        <span
          style={{
            fontFamily: 'var(--font-display)',
            fontWeight: 700,
            fontSize: 13,
            color: 'var(--color-text-primary)',
          }}
        >
          {entities.length}
        </span>{' '}
        entities · {edges.length} edges
      </div>

      {/* Zoom controls — bottom-right */}
      <div
        style={{
          position: 'absolute',
          bottom: 16,
          right: 16,
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
          zIndex: 20,
        }}
      >
        {[
          { label: '+', title: 'Zoom in (+ key)', action: zoomIn },
          { label: '−', title: 'Zoom out (− key)', action: zoomOut },
          { label: '⊙', title: 'Reset view (0 key)', action: resetCamera },
        ].map(({ label, title, action }) => (
          <button
            key={label}
            type="button"
            onClick={action}
            title={title}
            className="flex items-center justify-center font-body font-bold cursor-pointer"
            style={{
              width: 28,
              height: 28,
              borderRadius: 7,
              background: 'rgba(255,255,255,0.95)',
              border: '1px solid rgba(0,0,0,0.08)',
              color: 'var(--color-text-secondary)',
              fontSize: 16,
              lineHeight: 1,
              transition: 'background 0.15s ease',
            }}
            onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = '#fff' }}
            onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.95)' }}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Tooltip */}
      {tooltip && (
        <NodeTooltip
          tooltip={tooltip.data}
          x={tooltip.x}
          y={tooltip.y}
        />
      )}
    </div>
  )
}
