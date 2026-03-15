import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { ArrowLeft, ChevronRight } from 'lucide-react'
import { NodeTooltip } from '../../components/explore/NodeTooltip'
import { useEntityLayout } from '../../hooks/useEntityLayout'
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
  onEntitiesLoaded?: (entities: EntityNode[]) => void
  onEdgesLoaded?: (edges: EntityEdge[]) => void
}

const MIN_ZOOM = 0.2
const MAX_ZOOM = 4.0

interface Camera { zoom: number; panX: number; panY: number }

// Live node positions for floating + drag — mirrors LandscapeView's LiveNode
interface LiveNode {
  id: string
  x: number
  y: number
  vx: number
  vy: number
  radius: number
  floatPhase: number
  floatSpeedX: number
  floatSpeedY: number
  floatAmpX: number
  floatAmpY: number
}

export function NeighborhoodView({
  cluster,
  allClusters,
  filters,
  showEdges,
  visibleEdgeTypes,
  selectedEntityId,
  onSelectEntity,
  onBack,
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
  useEffect(() => { setActiveSubAnchorId(null) }, [cluster.anchor.id])

  // Synthetic co-source edges
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

  // Synthetic co-tag edges
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

  // Static layout (initial positions from force simulation)
  const layoutPositions = useEntityLayout(entities, allEdgesForLayout, size.width, size.height)

  // Hovered entity
  const [hoveredEntityId, setHoveredEntityId] = useState<string | null>(null)

  // Tooltip
  const [tooltip, setTooltip] = useState<{ data: TooltipData; x: number; y: number } | null>(null)
  const tooltipTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Pan drag ref
  const panStartRef = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null)
  const hasDraggedRef = useRef(false)

  // ── Live floating positions (mirrors LandscapeView) ────────────────────────
  const liveNodesRef = useRef<LiveNode[]>([])
  const [livePositions, setLivePositions] = useState<Map<string, { x: number; y: number }>>(new Map())
  const dragRef = useRef<{ id: string; offsetX: number; offsetY: number } | null>(null)
  const rafRef = useRef<number>(0)

  // Compute node radii per spec Section 3 (connection count based)
  const nodeRadii = useMemo(() => {
    const maxConn = Math.max(...entities.map(e => e.connectionCount), 1)
    const minR = 6
    const maxR = Math.min(size.width, size.height) * 0.025
    const radii = new Map<string, number>()
    for (const entity of entities) {
      const isAnchor = entity.isAnchor && entity.clusters.includes(cluster.anchor.id)
      let r = minR + Math.sqrt(entity.connectionCount / maxConn) * (maxR - minR)
      if (isAnchor) r *= 1.5 // Anchor entity renders 1.5× larger
      radii.set(entity.id, r)
    }
    return radii
  }, [entities, size.width, size.height, cluster.anchor.id])

  // Initialize live nodes when layout changes
  useEffect(() => {
    if (layoutPositions.size === 0) return
    liveNodesRef.current = Array.from(layoutPositions.entries()).map(([id, pos]) => ({
      id,
      x: pos.x,
      y: pos.y,
      vx: 0,
      vy: 0,
      radius: nodeRadii.get(id) ?? pos.radius,
      floatPhase: Math.random() * Math.PI * 2,
      floatSpeedX: 0.25 + Math.random() * 0.35,
      floatSpeedY: 0.18 + Math.random() * 0.25,
      floatAmpX: 0.12 + Math.random() * 0.2,
      floatAmpY: 0.1 + Math.random() * 0.16,
    }))
  }, [layoutPositions, nodeRadii])

  // Animation loop — identical to LandscapeView floating
  useEffect(() => {
    let lastTime = performance.now()

    const tick = (now: number) => {
      const dt = Math.min((now - lastTime) / 1000, 0.05)
      lastTime = now
      const nodes = liveNodesRef.current
      if (nodes.length === 0) { rafRef.current = requestAnimationFrame(tick); return }

      const w = sizeRef.current.width
      const h = sizeRef.current.height

      for (const n of nodes) {
        if (dragRef.current?.id === n.id) {
          n.vx = 0
          n.vy = 0
          continue
        }

        // Floating drift
        n.floatPhase += dt
        n.vx += Math.sin(n.floatPhase * n.floatSpeedX) * n.floatAmpX * dt
        n.vy += Math.cos(n.floatPhase * n.floatSpeedY) * n.floatAmpY * dt

        // Boundary soft push
        const pad = 30
        if (n.x < pad) n.vx += (pad - n.x) * 0.01
        if (n.x > w - pad) n.vx -= (n.x - (w - pad)) * 0.01
        if (n.y < pad) n.vy += (pad - n.y) * 0.01
        if (n.y > h - pad) n.vy -= (n.y - (h - pad)) * 0.01

        // Damping
        n.vx *= 0.97
        n.vy *= 0.97

        n.x += n.vx
        n.y += n.vy
      }

      const newPos = new Map<string, { x: number; y: number }>()
      for (const n of nodes) newPos.set(n.id, { x: n.x, y: n.y })
      setLivePositions(newPos)

      rafRef.current = requestAnimationFrame(tick)
    }

    rafRef.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafRef.current)
  }, [])

  // ── Node dragging — spec Section 8: only the dragged node moves ────────────
  const handleNodeMouseDown = useCallback((e: React.MouseEvent, nodeId: string) => {
    e.stopPropagation()
    hasDraggedRef.current = false
    const cam = cameraRef.current
    const rect = svgRef.current?.getBoundingClientRect()
    if (!rect) return

    const worldX = (e.clientX - rect.left - cam.panX) / cam.zoom
    const worldY = (e.clientY - rect.top - cam.panY) / cam.zoom
    const node = liveNodesRef.current.find(n => n.id === nodeId)
    if (!node) return

    dragRef.current = { id: nodeId, offsetX: worldX - node.x, offsetY: worldY - node.y }

    const onMove = (ev: MouseEvent) => {
      if (!dragRef.current || !svgRef.current) return
      hasDraggedRef.current = true
      const cam2 = cameraRef.current
      const r2 = svgRef.current.getBoundingClientRect()
      const wx = (ev.clientX - r2.left - cam2.panX) / cam2.zoom
      const wy = (ev.clientY - r2.top - cam2.panY) / cam2.zoom
      const n = liveNodesRef.current.find(nd => nd.id === dragRef.current!.id)
      if (n) {
        n.x = wx - dragRef.current.offsetX
        n.y = wy - dragRef.current.offsetY
      }
    }

    const onUp = () => {
      // After release, node resumes floating from new position, velocity zeroed
      const n = liveNodesRef.current.find(nd => nd.id === dragRef.current?.id)
      if (n) { n.vx = 0; n.vy = 0 }
      dragRef.current = null
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }

    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [])

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

  // PRD-23: Filtered entities for display (sub-anchor filter in parent mode)
  const displayEntities = useMemo(() => {
    if (!isParentMode || !activeSubAnchorId) return entities
    return entities.filter(e =>
      e.originAnchorId === activeSubAnchorId ||
      e.originAnchorId === cluster.anchor.id
    )
  }, [entities, isParentMode, activeSubAnchorId, cluster.anchor.id])

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

  // Entities connected to selected
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

  // Wheel zoom
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
        setCamera(prev => {
          const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, prev.zoom * (1 - e.deltaY * 0.01)))
          return {
            zoom: newZoom,
            panX: sx - (sx - prev.panX) / prev.zoom * newZoom,
            panY: sy - (sy - prev.panY) / prev.zoom * newZoom,
          }
        })
      } else if (Math.abs(e.deltaX) > 2) {
        setCamera(prev => ({
          ...prev,
          panX: prev.panX - e.deltaX,
          panY: prev.panY - e.deltaY,
        }))
      } else {
        setCamera(prev => {
          const factor = e.deltaY < 0 ? 1.12 : 0.9
          const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, prev.zoom * factor))
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

  // Keyboard zoom
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      if (e.key === '+' || e.key === '=') { zoomIn(); e.preventDefault() }
      else if (e.key === '-' || e.key === '_') { zoomOut(); e.preventDefault() }
      else if (e.key === '0') { resetCamera(); e.preventDefault() }
      else if (e.key === 'Escape') { onSelectEntity(null) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [zoomIn, zoomOut, resetCamera, onSelectEntity])

  // ── SVG interaction ───────────────────────────────────────────────────────
  const handleSvgMouseDown = (e: React.MouseEvent<SVGSVGElement>) => {
    if (e.target !== e.currentTarget) return
    hasDraggedRef.current = false
    const cam = cameraRef.current
    panStartRef.current = { x: e.clientX, y: e.clientY, panX: cam.panX, panY: cam.panY }
    if (svgRef.current) svgRef.current.style.cursor = 'grab'
  }

  const handleSvgMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const start = panStartRef.current
    if (!start) return
    const dx = e.clientX - start.x
    const dy = e.clientY - start.y
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) hasDraggedRef.current = true
    setCamera(prev => ({ ...prev, panX: start.panX + dx, panY: start.panY + dy }))
  }

  const handleSvgMouseUp = () => {
    panStartRef.current = null
    if (svgRef.current) svgRef.current.style.cursor = 'default'
  }

  const handleSvgClick = (e: React.MouseEvent<SVGSVGElement>) => {
    if (e.target === e.currentTarget && !hasDraggedRef.current) {
      onSelectEntity(null)
    }
  }

  // ── Entity event handlers ─────────────────────────────────────────────────
  const handleEntityHover = useCallback((entity: EntityNode | null, event: React.MouseEvent) => {
    if (dragRef.current) return
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
    if (hasDraggedRef.current) return
    onSelectEntity(selectedEntityId === entity.id ? null : entity)
  }, [onSelectEntity, selectedEntityId])

  useEffect(() => {
    return () => {
      if (tooltipTimerRef.current) clearTimeout(tooltipTimerRef.current)
    }
  }, [])

  // ── Selected entity for info card ─────────────────────────────────────────
  const selectedEntity = useMemo(
    () => selectedEntityId ? entities.find(e => e.id === selectedEntityId) ?? null : null,
    [selectedEntityId, entities]
  )

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
    <div ref={containerRef} className="relative w-full h-full" style={{ overflow: 'hidden', background: 'var(--color-bg-content)' }}>
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
          <g transform={`translate(${camera.panX},${camera.panY}) scale(${camera.zoom})`}>
            {/* 1. Co-source edges — dashed blue */}
            {visibleEdgeTypes.has('source') && coSourceEdgesForLayout.map(edge => {
              const sp = livePositions.get(edge.sourceNodeId)
              const tp = livePositions.get(edge.targetNodeId)
              if (!sp || !tp) return null
              const isHit = edge.sourceNodeId === selectedEntityId || edge.targetNodeId === selectedEntityId
              const opacity = connectedToSelected === null ? 0.32 : isHit ? 0.78 : 0.05
              return (
                <line
                  key={`cs-${edge.sourceNodeId}-${edge.targetNodeId}`}
                  x1={sp.x} y1={sp.y} x2={tp.x} y2={tp.y}
                  stroke={`rgba(37,99,235,${opacity})`}
                  strokeWidth={isHit && connectedToSelected !== null ? 2.5 : 1.5}
                  strokeDasharray="7 4"
                  style={{ transition: 'stroke 0.18s ease, stroke-width 0.18s ease' }}
                />
              )
            })}

            {/* 2. Co-tag edges — dashed purple */}
            {visibleEdgeTypes.has('tag') && coTagEdgesForLayout.map(edge => {
              const sp = livePositions.get(edge.sourceNodeId)
              const tp = livePositions.get(edge.targetNodeId)
              if (!sp || !tp) return null
              const isHit = edge.sourceNodeId === selectedEntityId || edge.targetNodeId === selectedEntityId
              const opacity = connectedToSelected === null ? 0.30 : isHit ? 0.75 : 0.04
              return (
                <line
                  key={`ct-${edge.sourceNodeId}-${edge.targetNodeId}`}
                  x1={sp.x} y1={sp.y} x2={tp.x} y2={tp.y}
                  stroke={`rgba(124,58,237,${opacity})`}
                  strokeWidth={isHit && connectedToSelected !== null ? 2.5 : 1.5}
                  strokeDasharray="2 5"
                  style={{ transition: 'stroke 0.18s ease, stroke-width 0.18s ease' }}
                />
              )
            })}

            {/* 3. Knowledge edges — solid slate, spec Section 6.1 */}
            {visibleEdgeTypes.has('direct') && visibleEdges.map(edge => {
              const sp = livePositions.get(edge.sourceNodeId)
              const tp = livePositions.get(edge.targetNodeId)
              if (!sp || !tp) return null

              const weight = edge.weight ?? 1
              const baseOpacity = Math.min(0.06 + (weight / 30) * 0.14, 0.20)
              const strokeWidth = Math.min(0.5 + weight * 0.2, 3)

              const isSelected = selectedEntityId === edge.sourceNodeId || selectedEntityId === edge.targetNodeId
              const isHovered = hoveredEntityId === edge.sourceNodeId || hoveredEntityId === edge.targetNodeId

              return (
                <g key={`ke-${edge.sourceNodeId}-${edge.targetNodeId}`}>
                  <line
                    x1={sp.x} y1={sp.y} x2={tp.x} y2={tp.y}
                    stroke={
                      isSelected
                        ? 'var(--color-accent-500)'
                        : `rgba(100,116,139,${isHovered ? Math.min(baseOpacity * 2, 0.35) : baseOpacity})`
                    }
                    strokeWidth={isSelected ? 2 : strokeWidth}
                    style={{ transition: 'stroke 0.15s ease, stroke-width 0.15s ease' }}
                  />
                  {isSelected && edge.relationType && (
                    <text
                      x={(sp.x + tp.x) / 2}
                      y={(sp.y + tp.y) / 2 - 6}
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

            {/* 4. Entity nodes — spec-compliant solid circles with labels below */}
            {displayEntities.map(entity => {
              const pos = livePositions.get(entity.id)
              if (!pos) return null

              const r = nodeRadii.get(entity.id) ?? 6
              const entityColor = getEntityColor(entity.entityType)
              const isAnchorEntity = entity.isAnchor && entity.clusters.includes(cluster.anchor.id)
              const filterVisible = isEntityVisible(entity)
              const isDimmed = !filterVisible || (connectedToSelected !== null && !connectedToSelected.has(entity.id))
              const isSelected = selectedEntityId === entity.id
              const isHovered = hoveredEntityId === entity.id

              // PRD-23: Origin ring for entities from sub-anchors
              const originCluster = isParentMode && entity.originAnchorId && entity.originAnchorId !== cluster.anchor.id
                ? allClusters.find(c => c.anchor.id === entity.originAnchorId)
                : null

              const scale = isHovered && !isDimmed ? 1.08 : 1
              const label = entity.label.length > 20 ? entity.label.slice(0, 19) + '…' : entity.label

              return (
                <g
                  key={entity.id}
                  onMouseDown={e => handleNodeMouseDown(e, entity.id)}
                  onMouseEnter={e => handleEntityHover(entity, e)}
                  onMouseLeave={e => handleEntityHover(null, e)}
                  onClick={() => handleEntityClick(entity)}
                  style={{
                    cursor: dragRef.current?.id === entity.id ? 'grabbing' : 'grab',
                    opacity: isDimmed ? 0.12 : 1,
                    transition: 'opacity 0.18s ease',
                  }}
                >
                  {/* Origin cluster ring (PRD-23) */}
                  {originCluster && (
                    <circle
                      cx={pos.x} cy={pos.y}
                      r={r + 3}
                      fill="none"
                      stroke={getEntityColor(originCluster.anchor.entityType)}
                      strokeWidth={1}
                      strokeOpacity={0.3}
                      style={{ pointerEvents: 'none' }}
                    />
                  )}

                  <g transform={`translate(${pos.x}, ${pos.y})`}>
                    <g transform={`scale(${scale})`} style={{ transition: 'transform 0.15s ease' }}>
                      {/* Selection ring — spec Section 4.4 */}
                      {isSelected && !isDimmed && (
                        <circle
                          r={r + 5}
                          fill="none"
                          stroke="var(--color-accent-500)"
                          strokeWidth={2}
                          opacity={0.6}
                        />
                      )}

                      {/* Hover glow ring — spec Section 4.5 */}
                      {isHovered && !isDimmed && !isSelected && (
                        <circle
                          r={r + 4}
                          fill="none"
                          stroke={`${entityColor}35`}
                          strokeWidth={2}
                        />
                      )}

                      {/* Solid filled circle — spec Section 4.1/4.2 */}
                      <circle
                        r={r}
                        fill={`${entityColor}22`}
                        stroke={entityColor}
                        strokeWidth={isAnchorEntity ? 3 : 2}
                      />

                      {/* Connection count inside — on hover or deep zoom */}
                      {(isHovered || camera.zoom >= 1.8) && entity.connectionCount > 0 && (
                        <text
                          y={1}
                          textAnchor="middle"
                          dominantBaseline="middle"
                          style={{
                            fontFamily: 'var(--font-body)',
                            fontSize: Math.max(7, r * 0.5),
                            fontWeight: 700,
                            fill: entityColor,
                            opacity: 0.45,
                            pointerEvents: 'none',
                            userSelect: 'none',
                          }}
                        >
                          {entity.connectionCount}
                        </text>
                      )}
                    </g>

                    {/* Label below circle — always visible, spec Section 5 */}
                    <text
                      y={r + 12}
                      textAnchor="middle"
                      style={{
                        fontFamily: 'var(--font-display)',
                        fontSize: 9,
                        fontWeight: 600,
                        fill: isSelected ? 'var(--color-accent-500)'
                          : isHovered ? 'var(--color-text-primary)'
                          : 'var(--color-text-secondary)',
                        pointerEvents: 'none',
                        userSelect: 'none',
                        transition: 'fill 0.15s ease',
                      }}
                    >
                      {label}
                    </text>
                  </g>
                </g>
              )
            })}
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

      {/* Stats — top-right (spec Section 2) */}
      <div
        style={{
          position: 'absolute',
          top: 16,
          right: 16,
          background: 'rgba(255,255,255,0.9)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 10,
          padding: '8px 12px',
          display: 'flex',
          flexDirection: 'column',
          gap: 3,
          pointerEvents: 'none',
          backdropFilter: 'blur(8px)',
        }}
      >
        <div className="flex items-center justify-between gap-4">
          <span style={{ fontFamily: 'var(--font-body)', fontSize: 9, color: 'var(--color-text-secondary)' }}>Entities</span>
          <span style={{ fontFamily: 'var(--font-display)', fontSize: 11, fontWeight: 700, color: 'var(--color-text-primary)' }}>{entities.length}</span>
        </div>
        <div className="flex items-center justify-between gap-4">
          <span style={{ fontFamily: 'var(--font-body)', fontSize: 9, color: 'var(--color-text-secondary)' }}>Edges</span>
          <span style={{ fontFamily: 'var(--font-display)', fontSize: 11, fontWeight: 700, color: 'var(--color-text-primary)' }}>{edges.length}</span>
        </div>
      </div>

      {/* Zoom controls — bottom-right (spec Section 2) */}
      <div style={{ position: 'absolute', bottom: 16, right: 16, display: 'flex', flexDirection: 'column', gap: 3, zIndex: 20 }}>
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
              width: 26,
              height: 26,
              borderRadius: 6,
              background: 'rgba(255,255,255,0.9)',
              border: '1px solid rgba(0,0,0,0.08)',
              color: 'var(--color-text-secondary)',
              fontSize: 14,
              lineHeight: 1,
              backdropFilter: 'blur(8px)',
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Floating info card — spec Section 10 */}
      {selectedEntity && (() => {
        const livePos = livePositions.get(selectedEntity.id)
        if (!livePos) return null
        const r = nodeRadii.get(selectedEntity.id) ?? 6
        const entityColor = getEntityColor(selectedEntity.entityType)

        const screenX = livePos.x * camera.zoom + camera.panX
        const screenY = livePos.y * camera.zoom + camera.panY
        const cardWidth = 220
        const left = Math.max(8, Math.min(size.width - cardWidth - 8, screenX - cardWidth / 2))
        const top = Math.max(8, screenY - r * camera.zoom - 14)

        return (
          <div
            style={{
              position: 'absolute',
              left,
              bottom: size.height - top,
              zIndex: 30,
              width: cardWidth,
              background: 'rgba(255,255,255,0.96)',
              backdropFilter: 'blur(12px)',
              border: `1px solid ${entityColor}40`,
              borderRadius: 10,
              padding: '12px 14px',
              boxShadow: '0 6px 24px rgba(0,0,0,0.08)',
              animation: 'fadeUp 0.15s ease',
              pointerEvents: 'auto',
            }}
          >
            {/* Header */}
            <div className="flex items-center justify-between" style={{ marginBottom: 6 }}>
              <span className="font-display" style={{ fontSize: 13, fontWeight: 700, color: 'var(--color-text-primary)' }}>
                {selectedEntity.label}
              </span>
              <button
                type="button"
                onClick={() => onSelectEntity(null)}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-text-secondary)', fontSize: 14, lineHeight: 1, padding: 2 }}
              >
                ×
              </button>
            </div>

            {/* Badges */}
            <div className="flex items-center gap-2" style={{ marginBottom: 6 }}>
              <span className="font-body" style={{
                fontSize: 9, fontWeight: 600, padding: '1px 5px', borderRadius: 3,
                color: entityColor, background: `${entityColor}12`, border: `1px solid ${entityColor}29`,
              }}>
                {selectedEntity.entityType}
              </span>
              <span className="font-body" style={{ fontSize: 10, color: 'var(--color-text-secondary)' }}>
                {selectedEntity.connectionCount} connections
              </span>
            </div>

            {/* Description */}
            {selectedEntity.description && (
              <p className="font-body" style={{ fontSize: 10, color: 'var(--color-text-secondary)', lineHeight: 1.4, margin: '0 0 8px 0' }}>
                {selectedEntity.description.length > 100 ? selectedEntity.description.slice(0, 97) + '…' : selectedEntity.description}
              </p>
            )}

          </div>
        )
      })()}

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
