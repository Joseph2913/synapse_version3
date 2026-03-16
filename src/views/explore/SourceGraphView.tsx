import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { Upload } from 'lucide-react'
import { getSourceConfig, SOURCE_TYPE_CONFIG, DEFAULT_SOURCE_CONFIG } from '../../config/sourceTypes'
import { useSourceLayout, dotRadius, ANCHOR_RADIUS } from '../../hooks/useSourceLayout'
import { useAuth } from '../../hooks/useAuth'
import { fetchSourceGraph } from '../../services/exploreQueries'
import { SourceDetailCard } from '../../components/explore/SourceDetailCard'
import type {
  SourceNode,
  SourceEdge,
  SourceGraphAnchor,
  ExploreFilters,
} from '../../types/explore'

const MIN_ZOOM = 0.15
const MAX_ZOOM = 6.0

interface Camera { zoom: number; panX: number; panY: number }

// Live node for floating animation
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

// Anchor color constant
const ANCHOR_COLOR = '#b45309'

interface SourceGraphViewProps {
  filters: ExploreFilters
  selectedSourceId: string | null
  onSelectSource: (source: SourceNode | null) => void
  onSourcesLoaded?: (sources: SourceNode[], edges: SourceEdge[], anchors: SourceGraphAnchor[]) => void
}

export function SourceGraphView({
  filters,
  selectedSourceId,
  onSelectSource,
  onSourcesLoaded,
}: SourceGraphViewProps) {
  const { user } = useAuth()
  const containerRef = useRef<HTMLDivElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const sizeRef = useRef({ width: 0, height: 0 })

  // Camera
  const [camera, setCamera] = useState<Camera>({ zoom: 1, panX: 0, panY: 0 })
  const cameraRef = useRef<Camera>({ zoom: 1, panX: 0, panY: 0 })
  useEffect(() => { cameraRef.current = camera }, [camera])

  // Data
  const [sources, setSources] = useState<SourceNode[]>([])
  const [edges, setEdges] = useState<SourceEdge[]>([])
  const [anchors, setAnchors] = useState<SourceGraphAnchor[]>([])
  const [loading, setLoading] = useState(true)

  // Interaction
  const [hoveredSourceId, setHoveredSourceId] = useState<string | null>(null)
  const [hoveredAnchorId, setHoveredAnchorId] = useState<string | null>(null)
  const [exploringSourceId, setExploringSourceId] = useState<string | null>(null)

  // Static layout
  const layoutPositions = useSourceLayout(sources, edges, size.width, size.height, anchors)

  // Live floating positions
  const liveNodesRef = useRef<LiveNode[]>([])
  const [livePositions, setLivePositions] = useState<Map<string, { x: number; y: number }>>(new Map())
  const dragRef = useRef<{ id: string; offsetX: number; offsetY: number } | null>(null)
  const rafRef = useRef<number>(0)
  const hasDraggedRef = useRef(false)
  const panStartRef = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null)

  // Edge refs
  const edgesRef = useRef(edges)
  useEffect(() => { edgesRef.current = edges }, [edges])
  const anchorsRef = useRef(anchors)
  useEffect(() => { anchorsRef.current = anchors }, [anchors])

  // Weighted connectivity map: nodeId → Map<connectedNodeId, weight 0-1>
  // Weight determines how strongly a connected node follows during drag
  const connectivityRef = useRef(new Map<string, Map<string, number>>())
  useEffect(() => {
    const map = new Map<string, Map<string, number>>()
    const addLink = (a: string, b: string, weight: number) => {
      if (!map.has(a)) map.set(a, new Map())
      if (!map.has(b)) map.set(b, new Map())
      // Keep the strongest weight if duplicate
      const existing = map.get(a)!.get(b) ?? 0
      if (weight > existing) {
        map.get(a)!.set(b, weight)
        map.get(b)!.set(a, weight)
      }
    }
    // Source-to-source: weight based on totalWeight (normalise to 0-1)
    const maxWeight = Math.max(...edges.map(e => e.totalWeight), 1)
    for (const e of edges) {
      addLink(e.fromSourceId, e.toSourceId, Math.min(e.totalWeight / maxWeight, 1))
    }
    // Anchor-to-source: strong connection (0.8)
    for (const a of anchors) {
      for (const srcId of a.connectedSourceIds) addLink(a.id, srcId, 0.8)
    }
    connectivityRef.current = map
  }, [edges, anchors])

  // Node radii
  const nodeRadii = useMemo(() => {
    const radii = new Map<string, number>()
    for (const s of sources) radii.set(s.id, dotRadius(s.entityCount))
    for (const a of anchors) radii.set(a.id, ANCHOR_RADIUS)
    return radii
  }, [sources, anchors])

  // Initialize live nodes
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
      floatSpeedX: 0.2 + Math.random() * 0.25,
      floatSpeedY: 0.15 + Math.random() * 0.2,
      floatAmpX: 0.06 + Math.random() * 0.1,
      floatAmpY: 0.05 + Math.random() * 0.08,
    }))
  }, [layoutPositions, nodeRadii])

  // Previous dragged node position — used to compute movement delta
  const dragPrevPos = useRef<{ x: number; y: number } | null>(null)

  // Animation loop — floating + directional drag drift
  //
  // When dragging: we compute the DIRECTION the dragged node moved this frame,
  // then apply that direction as a gentle velocity nudge to connected nodes.
  // They glide in the same direction — NOT toward the dragged node.
  // Stronger connections get a bigger nudge, weaker ones barely move.
  // Nodes stay in their own area; they just drift along with the movement.
  useEffect(() => {
    let lastTime = performance.now()
    const tick = (now: number) => {
      const dt = Math.min((now - lastTime) / 1000, 0.05)
      lastTime = now
      const nodes = liveNodesRef.current
      if (nodes.length === 0) { rafRef.current = requestAnimationFrame(tick); return }

      const nodeMap = new Map<string, LiveNode>()
      for (const n of nodes) nodeMap.set(n.id, n)

      // ── Directional drag drift ───────────────────────────────────────────
      // Compute how far the dragged node moved this frame, then nudge
      // connected nodes in that SAME direction (not toward the node).
      if (dragRef.current && dragPrevPos.current) {
        const dragNode = nodeMap.get(dragRef.current.id)
        if (dragNode) {
          // Movement delta of the dragged node this frame
          const moveDx = dragNode.x - dragPrevPos.current.x
          const moveDy = dragNode.y - dragPrevPos.current.y

          if (Math.abs(moveDx) > 0.1 || Math.abs(moveDy) > 0.1) {
            const connections = connectivityRef.current.get(dragRef.current.id)
            if (connections) {
              for (const [connId, weight] of connections) {
                const connNode = nodeMap.get(connId)
                if (!connNode) continue

                // Very subtle nudge in the same direction as the drag
                // Strong connections (weight ~1): ~3% of drag speed
                // Weak connections (weight ~0.1): ~0.5% of drag speed
                const strength = 0.003 + weight * 0.025
                connNode.vx += moveDx * strength
                connNode.vy += moveDy * strength

                // 2nd degree: barely perceptible
                const secondDeg = connectivityRef.current.get(connId)
                if (secondDeg) {
                  for (const [secId, secWeight] of secondDeg) {
                    if (secId === dragRef.current!.id) continue
                    const secNode = nodeMap.get(secId)
                    if (!secNode) continue
                    const secStrength = 0.0005 + secWeight * 0.003
                    secNode.vx += moveDx * secStrength
                    secNode.vy += moveDy * secStrength
                  }
                }
              }
            }
          }

          dragPrevPos.current = { x: dragNode.x, y: dragNode.y }
        }
      }

      // ── Update all nodes ─────────────────────────────────────────────────
      for (const n of nodes) {
        if (dragRef.current?.id === n.id) { n.vx = 0; n.vy = 0; continue }

        // Floating drift
        n.floatPhase += dt
        n.vx += Math.sin(n.floatPhase * n.floatSpeedX) * n.floatAmpX * dt
        n.vy += Math.cos(n.floatPhase * n.floatSpeedY) * n.floatAmpY * dt

        // Boundary soft push
        const w = sizeRef.current.width
        const h = sizeRef.current.height
        if (w > 0 && h > 0) {
          const pad = 30
          if (n.x < pad) n.vx += (pad - n.x) * 0.01
          if (n.x > w - pad) n.vx -= (n.x - (w - pad)) * 0.01
          if (n.y < pad) n.vy += (pad - n.y) * 0.01
          if (n.y > h - pad) n.vy -= (n.y - (h - pad)) * 0.01
        }

        // Damping
        n.vx *= 0.94
        n.vy *= 0.94
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

  // Auto-fit camera
  const hasAutoFitRef = useRef(false)
  useEffect(() => {
    if (layoutPositions.size === 0 || size.width === 0 || size.height === 0) return
    if (hasAutoFitRef.current) return
    hasAutoFitRef.current = true

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const [, pos] of layoutPositions) {
      const r = pos.radius + 20
      minX = Math.min(minX, pos.x - r)
      minY = Math.min(minY, pos.y - r)
      maxX = Math.max(maxX, pos.x + r)
      maxY = Math.max(maxY, pos.y + r)
    }

    const contentW = maxX - minX
    const contentH = maxY - minY
    if (contentW <= 0 || contentH <= 0) return

    const scaleX = size.width / contentW
    const scaleY = size.height / contentH
    const zoom = Math.max(MIN_ZOOM, Math.min(1.5, Math.min(scaleX, scaleY) * 0.92))

    setCamera({
      zoom,
      panX: size.width / 2 - ((minX + maxX) / 2) * zoom,
      panY: size.height / 2 - ((minY + maxY) / 2) * zoom,
    })
  }, [layoutPositions, size])

  useEffect(() => { hasAutoFitRef.current = false }, [sources])

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

  // Fetch
  useEffect(() => {
    if (!user) return
    let cancelled = false
    setLoading(true)
    fetchSourceGraph(user.id)
      .then(data => {
        if (cancelled) return
        setSources(data.sources)
        setEdges(data.edges)
        setAnchors(data.anchors)
        onSourcesLoaded?.(data.sources, data.edges, data.anchors)
      })
      .catch(err => console.warn('SourceGraphView fetch error:', err))
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [user, onSourcesLoaded])

  // ─── Filtering ──────────────────────────────────────────────────────────────

  const filteredEdges = useMemo(() => {
    if (filters.connTypes.size === 0) return edges
    return edges.filter(e => e.connections.some(c => filters.connTypes.has(c.type)))
  }, [edges, filters.connTypes])

  const filteredSourceIds = useMemo(() => {
    const ids = new Set<string>()
    for (const s of sources) {
      if (filters.sourceTypes.size > 0 && !filters.sourceTypes.has(s.sourceType)) continue
      if (filters.sourceAnchorFilter && !s.anchorIds.includes(filters.sourceAnchorFilter)) continue
      if (filters.searchQuery && !s.title.toLowerCase().includes(filters.searchQuery.toLowerCase())) continue
      if (filters.recency !== 'all') {
        const days = filters.recency === '7d' ? 7 : 30
        if (Date.now() - new Date(s.createdAt).getTime() > days * 86400000) continue
      }
      ids.add(s.id)
    }
    return ids
  }, [sources, filters.sourceTypes, filters.sourceAnchorFilter, filters.searchQuery, filters.recency])

  const edgesForSource = useMemo(() => {
    const map = new Map<string, SourceEdge[]>()
    for (const e of filteredEdges) {
      const a = map.get(e.fromSourceId) ?? []
      a.push(e); map.set(e.fromSourceId, a)
      const b = map.get(e.toSourceId) ?? []
      b.push(e); map.set(e.toSourceId, b)
    }
    return map
  }, [filteredEdges])

  const activeSourceId = hoveredSourceId || selectedSourceId
  const highlightedEdges = useMemo(() => {
    if (!activeSourceId) return new Set<string>()
    const relevant = edgesForSource.get(activeSourceId) ?? []
    return new Set(relevant.map(e => `${e.fromSourceId}-${e.toSourceId}`))
  }, [activeSourceId, edgesForSource])

  // ─── Camera helpers ─────────────────────────────────────────────────────────

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
    zoomAround(1.3, sizeRef.current.width / 2, sizeRef.current.height / 2)
  }, [zoomAround])

  const zoomOut = useCallback(() => {
    zoomAround(0.75, sizeRef.current.width / 2, sizeRef.current.height / 2)
  }, [zoomAround])

  const resetCamera = useCallback(() => {
    hasAutoFitRef.current = false
    setCamera({ zoom: 1, panX: 0, panY: 0 })
  }, [])

  // Reset all nodes back to their original layout positions
  const resetNodes = useCallback(() => {
    if (layoutPositions.size === 0) return
    for (const n of liveNodesRef.current) {
      const orig = layoutPositions.get(n.id)
      if (orig) {
        n.x = orig.x
        n.y = orig.y
        n.vx = 0
        n.vy = 0
      }
    }
    // Also re-fit camera
    hasAutoFitRef.current = false
  }, [layoutPositions])

  // Wheel zoom — works for scroll wheel, trackpad pinch, and two-finger pan
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
        // Trackpad pinch — gentle sensitivity
        const factor = 1 - e.deltaY * 0.004
        zoomAround(factor, sx, sy)
      } else if (Math.abs(e.deltaX) > Math.abs(e.deltaY) * 0.5 && Math.abs(e.deltaX) > 2) {
        // Two-finger horizontal swipe → pan
        setCamera(prev => ({
          ...prev,
          panX: prev.panX - e.deltaX,
          panY: prev.panY - e.deltaY,
        }))
      } else {
        // Mouse scroll wheel → zoom around cursor position (gentle)
        const factor = e.deltaY < 0 ? 1.06 : 0.94
        zoomAround(factor, sx, sy)
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [zoomAround])

  // Keyboard zoom
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      if (e.key === '+' || e.key === '=') { zoomIn(); e.preventDefault() }
      else if (e.key === '-' || e.key === '_') { zoomOut(); e.preventDefault() }
      else if (e.key === '0') { resetCamera(); e.preventDefault() }
      else if (e.key === 'r' || e.key === 'R') { resetNodes(); e.preventDefault() }
      else if (e.key === 'Escape') { onSelectSource(null); setExploringSourceId(null) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [zoomIn, zoomOut, resetCamera, resetNodes, onSelectSource])

  // ── Node dragging ──────────────────────────────────────────────────────────
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
    dragPrevPos.current = { x: node.x, y: node.y }

    const onMove = (ev: MouseEvent) => {
      if (!dragRef.current || !svgRef.current) return
      hasDraggedRef.current = true
      const cam2 = cameraRef.current
      const r2 = svgRef.current.getBoundingClientRect()
      const wx = (ev.clientX - r2.left - cam2.panX) / cam2.zoom
      const wy = (ev.clientY - r2.top - cam2.panY) / cam2.zoom
      const n = liveNodesRef.current.find(nd => nd.id === dragRef.current!.id)
      if (n) { n.x = wx - dragRef.current.offsetX; n.y = wy - dragRef.current.offsetY }
    }
    const onUp = () => {
      const n = liveNodesRef.current.find(nd => nd.id === dragRef.current?.id)
      if (n) { n.vx = 0; n.vy = 0 }
      dragRef.current = null
      dragPrevPos.current = null
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [])

  // ─── SVG pan ───────────────────────────────────────────────────────────────
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
      onSelectSource(null)
      setExploringSourceId(null)
    }
  }

  // ─── Handlers ──────────────────────────────────────────────────────────────
  const handleSourceHover = useCallback((source: SourceNode | null) => {
    if (dragRef.current) return
    setHoveredSourceId(source?.id ?? null)
  }, [])

  const handleSourceClick = useCallback((source: SourceNode) => {
    if (hasDraggedRef.current) return
    const deselecting = selectedSourceId === source.id
    onSelectSource(deselecting ? null : source)
    // Click directly opens the right-side detail panel
    setExploringSourceId(deselecting ? null : source.id)
  }, [onSelectSource, selectedSourceId])

  // selectedSourceId is used for highlight ring / edge emphasis; detail panel uses exploringSourceId

  // ─── Legend items ──────────────────────────────────────────────────────────
  const legendItems = useMemo(() => {
    const sourceTypeSet = new Set(sources.map(s => s.sourceType))
    const items: { color: string; label: string; dashed?: boolean }[] = []
    for (const [type, cfg] of Object.entries(SOURCE_TYPE_CONFIG)) {
      if (sourceTypeSet.has(type)) items.push({ color: cfg.color, label: cfg.label })
    }
    // Add "Other" if any source uses default config
    if (sources.some(s => !SOURCE_TYPE_CONFIG[s.sourceType])) {
      items.push({ color: DEFAULT_SOURCE_CONFIG.color, label: 'Other' })
    }
    if (anchors.length > 0) {
      items.push({ color: ANCHOR_COLOR, label: 'Anchor', dashed: true })
    }
    return items
  }, [sources, anchors])

  // Loading
  if (loading) {
    return (
      <div ref={containerRef} className="relative w-full h-full flex items-center justify-center">
        <span style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-secondary)' }}>
          Loading sources…
        </span>
      </div>
    )
  }

  // Empty
  if (sources.length === 0) {
    return (
      <div ref={containerRef} className="relative w-full h-full flex items-center justify-center">
        <div className="flex flex-col items-center gap-3" style={{ maxWidth: 320, textAlign: 'center' }}>
          <Upload size={32} style={{ color: 'var(--color-text-placeholder)' }} />
          <h3 style={{ fontFamily: 'var(--font-display)', fontSize: 16, fontWeight: 700, color: 'var(--color-text-primary)' }}>
            No sources yet
          </h3>
          <p style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-secondary)', lineHeight: 1.5 }}>
            Ingest content to see your source graph.
          </p>
        </div>
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

            {/* 1. Source-to-source edges — simple thin lines */}
            {filteredEdges.map(edge => {
              const fromPos = livePositions.get(edge.fromSourceId)
              const toPos = livePositions.get(edge.toSourceId)
              if (!fromPos || !toPos) return null

              const edgeKey = `${edge.fromSourceId}-${edge.toSourceId}`
              const isHighlighted = highlightedEdges.has(edgeKey)
              const isSelected = selectedSourceId === edge.fromSourceId || selectedSourceId === edge.toSourceId
              const isActive = isHighlighted || isSelected
              const hasActiveSource = !!activeSourceId

              return (
                <line
                  key={edgeKey}
                  x1={fromPos.x} y1={fromPos.y} x2={toPos.x} y2={toPos.y}
                  stroke={isSelected ? 'var(--color-accent-500)' : 'rgba(100,116,139,1)'}
                  strokeWidth={isActive ? 1.2 : 0.5}
                  strokeOpacity={isActive ? 0.5 : hasActiveSource ? 0.03 : 0.08}
                  style={{ transition: 'stroke-opacity 0.15s ease' }}
                />
              )
            })}

            {/* 2. Source-to-anchor edges — thin dashed */}
            {anchors.map(anchor => {
              const anchorPos = livePositions.get(anchor.id)
              if (!anchorPos) return null
              return anchor.connectedSourceIds.map(srcId => {
                const srcPos = livePositions.get(srcId)
                if (!srcPos) return null
                const isAnchorActive = hoveredAnchorId === anchor.id || filters.sourceAnchorFilter === anchor.id
                const isSourceActive = activeSourceId === srcId
                const isActive = isAnchorActive || isSourceActive
                return (
                  <line
                    key={`a-${anchor.id}-${srcId}`}
                    x1={anchorPos.x} y1={anchorPos.y} x2={srcPos.x} y2={srcPos.y}
                    stroke={ANCHOR_COLOR}
                    strokeWidth={isActive ? 1 : 0.4}
                    strokeOpacity={isActive ? 0.45 : (activeSourceId && !isSourceActive) ? 0.02 : 0.08}
                    strokeDasharray={isActive ? '4,2' : '2,3'}
                    style={{ transition: 'stroke-opacity 0.15s ease' }}
                  />
                )
              })
            })}

            {/* 3. Source circles — plain colored, no icons */}
            {sources.map(source => {
              const pos = livePositions.get(source.id)
              if (!pos) return null

              const r = nodeRadii.get(source.id) ?? 3
              const cfg = getSourceConfig(source.sourceType)
              const isDimmed = !filteredSourceIds.has(source.id)
              const isSelected = selectedSourceId === source.id
              const isHovered = hoveredSourceId === source.id

              return (
                <g
                  key={source.id}
                  onMouseDown={e => handleNodeMouseDown(e, source.id)}
                  onMouseEnter={() => handleSourceHover(source)}
                  onMouseLeave={() => handleSourceHover(null)}
                  onClick={() => handleSourceClick(source)}
                  style={{
                    cursor: dragRef.current?.id === source.id ? 'grabbing' : 'pointer',
                    opacity: isDimmed ? 0.12 : 1,
                    transition: 'opacity 0.18s ease',
                  }}
                >
                  <g transform={`translate(${pos.x}, ${pos.y})`}>
                    {/* Selection ring */}
                    {isSelected && !isDimmed && (
                      <circle r={r + 4} fill="none" stroke="var(--color-accent-500)" strokeWidth={1.5} opacity={0.7} />
                    )}

                    {/* Hover ring */}
                    {isHovered && !isDimmed && !isSelected && (
                      <circle r={r + 3} fill="none" stroke={`${cfg.color}50`} strokeWidth={1} />
                    )}

                    {/* Solid filled circle — no icon */}
                    <circle
                      r={r}
                      fill={cfg.color}
                      fillOpacity={0.75}
                      stroke={cfg.color}
                      strokeWidth={isSelected ? 1.5 : 0.5}
                      strokeOpacity={0.9}
                    />

                    {/* Label — only on hover, select, or sufficient zoom */}
                    {(isHovered || isSelected || camera.zoom > 0.6) && (
                      <text
                        y={r + 10}
                        textAnchor="middle"
                        style={{
                          fontFamily: 'var(--font-body)',
                          fontSize: 7,
                          fontWeight: isSelected ? 700 : 500,
                          fill: isSelected ? 'var(--color-accent-500)'
                            : isHovered ? 'var(--color-text-primary)'
                            : 'var(--color-text-secondary)',
                          pointerEvents: 'none',
                          userSelect: 'none',
                          opacity: isHovered || isSelected ? 1 : 0.7,
                        }}
                      >
                        {source.title.length > 18 ? source.title.slice(0, 16) + '…' : source.title}
                      </text>
                    )}
                  </g>
                </g>
              )
            })}

            {/* 4. Anchor dots — small filled circles */}
            {anchors.map(anchor => {
              const pos = livePositions.get(anchor.id)
              if (!pos) return null
              const isActive = hoveredAnchorId === anchor.id || filters.sourceAnchorFilter === anchor.id

              return (
                <g
                  key={`anchor-${anchor.id}`}
                  onMouseDown={e => handleNodeMouseDown(e, anchor.id)}
                  onMouseEnter={() => { if (!dragRef.current) setHoveredAnchorId(anchor.id) }}
                  onMouseLeave={() => setHoveredAnchorId(null)}
                  style={{ cursor: dragRef.current?.id === anchor.id ? 'grabbing' : 'pointer' }}
                >
                  <g transform={`translate(${pos.x}, ${pos.y})`}>
                    {isActive && (
                      <circle r={ANCHOR_RADIUS + 4} fill={`${ANCHOR_COLOR}15`} />
                    )}
                    <circle
                      r={ANCHOR_RADIUS}
                      fill={ANCHOR_COLOR}
                      fillOpacity={isActive ? 0.85 : 0.6}
                      stroke={ANCHOR_COLOR}
                      strokeWidth={isActive ? 1.5 : 0.5}
                      strokeOpacity={0.8}
                    />
                    {/* Small diamond inside */}
                    <text
                      y={0.5}
                      textAnchor="middle"
                      dominantBaseline="middle"
                      style={{ fontSize: 5, fill: '#fff', pointerEvents: 'none', userSelect: 'none', fontWeight: 700 }}
                    >
                      ◆
                    </text>
                    {/* Label */}
                    {(isActive || camera.zoom > 0.6) && (
                      <text
                        y={ANCHOR_RADIUS + 9}
                        textAnchor="middle"
                        style={{
                          fontFamily: 'var(--font-display)',
                          fontSize: 6,
                          fontWeight: 700,
                          fill: isActive ? ANCHOR_COLOR : `${ANCHOR_COLOR}99`,
                          pointerEvents: 'none',
                          userSelect: 'none',
                        }}
                      >
                        {anchor.label.length > 16 ? anchor.label.slice(0, 14) + '…' : anchor.label}
                      </text>
                    )}
                  </g>
                </g>
              )
            })}
          </g>
        </svg>
      )}

      {/* Hover tooltip for source */}
      {hoveredSourceId && !exploringSourceId && (() => {
        const hSource = sources.find(s => s.id === hoveredSourceId)
        if (!hSource) return null
        const livePos = livePositions.get(hSource.id)
        if (!livePos) return null
        const r = nodeRadii.get(hSource.id) ?? 3
        const cfg = getSourceConfig(hSource.sourceType)
        const connCount = edgesForSource.get(hSource.id)?.length ?? 0

        const screenX = livePos.x * camera.zoom + camera.panX
        const screenY = livePos.y * camera.zoom + camera.panY
        const cardWidth = 220
        const left = Math.max(8, Math.min(size.width - cardWidth - 8, screenX - cardWidth / 2))
        const top = Math.max(8, screenY - r * camera.zoom - 12)

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
              border: '1px solid var(--border-subtle)',
              borderRadius: 10,
              padding: '8px 12px',
              boxShadow: '0 4px 16px rgba(0,0,0,0.08)',
              pointerEvents: 'none',
            }}
          >
            <div className="flex items-center gap-2" style={{ marginBottom: 3 }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: cfg.color, flexShrink: 0 }} />
              <span className="font-display" style={{ fontSize: 12, fontWeight: 700, color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {hSource.title}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className="font-body" style={{
                fontSize: 9, fontWeight: 600, padding: '1px 5px', borderRadius: 3,
                color: cfg.color, background: `${cfg.color}12`, border: `1px solid ${cfg.color}25`,
              }}>
                {hSource.sourceType}
              </span>
              <span className="font-body" style={{ fontSize: 9, color: 'var(--color-text-secondary)' }}>
                {hSource.entityCount} entities · {connCount} connections
              </span>
            </div>
          </div>
        )
      })()}

      {/* Right-side detail panel when exploring a source */}
      {exploringSourceId && (
        <SourceDetailCard
          sourceId={exploringSourceId}
          onClose={() => setExploringSourceId(null)}
          onNavigateToSource={(sourceId) => {
            const target = sources.find(s => s.id === sourceId)
            if (target) {
              onSelectSource(target)
              setExploringSourceId(sourceId)
            }
          }}
        />
      )}

      {/* Legend — bottom-left */}
      <div
        style={{
          position: 'absolute', bottom: 16, left: 16,
          background: 'rgba(255,255,255,0.92)',
          backdropFilter: 'blur(8px)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 8,
          padding: '8px 10px',
          display: 'flex', flexDirection: 'column', gap: 4,
          zIndex: 20,
        }}
      >
        <span style={{ fontFamily: 'var(--font-display)', fontSize: 8, fontWeight: 700, color: 'var(--color-text-secondary)', letterSpacing: '0.06em', textTransform: 'uppercase' as const }}>
          Legend
        </span>
        {legendItems.map(item => (
          <div key={item.label} className="flex items-center gap-2">
            {item.dashed ? (
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: item.color, opacity: 0.7, flexShrink: 0 }} />
            ) : (
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: item.color, opacity: 0.75, flexShrink: 0 }} />
            )}
            <span style={{ fontFamily: 'var(--font-body)', fontSize: 9, fontWeight: 500, color: 'var(--color-text-body)' }}>
              {item.label}
            </span>
          </div>
        ))}
      </div>

      {/* Stats — top-right */}
      <div
        style={{
          position: 'absolute', top: 16, right: 16,
          background: 'rgba(255,255,255,0.92)',
          backdropFilter: 'blur(8px)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 8, padding: '6px 10px',
          display: 'flex', gap: 12, alignItems: 'center',
          pointerEvents: 'none',
        }}
      >
        <span style={{ fontFamily: 'var(--font-body)', fontSize: 9, color: 'var(--color-text-secondary)' }}>
          <strong style={{ fontFamily: 'var(--font-display)', fontWeight: 700, color: 'var(--color-text-primary)' }}>{sources.length}</strong> sources
        </span>
        <span style={{ fontFamily: 'var(--font-body)', fontSize: 9, color: 'var(--color-text-secondary)' }}>
          <strong style={{ fontFamily: 'var(--font-display)', fontWeight: 700, color: 'var(--color-text-primary)' }}>{filteredEdges.length}</strong> connections
        </span>
        <span style={{ fontFamily: 'var(--font-body)', fontSize: 9, color: 'var(--color-text-secondary)' }}>
          <strong style={{ fontFamily: 'var(--font-display)', fontWeight: 700, color: 'var(--color-text-primary)' }}>{anchors.length}</strong> anchors
        </span>
      </div>

      {/* Zoom controls — bottom-right */}
      <div style={{ position: 'absolute', bottom: 16, right: 16, display: 'flex', flexDirection: 'column', gap: 3, zIndex: 20 }}>
        {[
          { label: '+', title: 'Zoom in (+ key)', action: zoomIn },
          { label: '−', title: 'Zoom out (− key)', action: zoomOut },
          { label: '⊙', title: 'Fit to screen (0 key)', action: resetCamera },
          { label: '↺', title: 'Reset node positions (R key)', action: resetNodes },
        ].map(({ label, title, action }) => (
          <button
            key={label}
            type="button"
            onClick={action}
            title={title}
            className="flex items-center justify-center font-body font-bold cursor-pointer"
            style={{
              width: 26, height: 26, borderRadius: 6,
              background: 'rgba(255,255,255,0.92)',
              border: '1px solid rgba(0,0,0,0.08)',
              color: 'var(--color-text-secondary)',
              fontSize: 14, lineHeight: 1,
              backdropFilter: 'blur(8px)',
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {/* No edges banner */}
      {edges.length === 0 && sources.length > 0 && (
        <div
          style={{
            position: 'absolute', bottom: 16, left: '50%', transform: 'translateX(-50%)',
            background: 'rgba(255,255,255,0.92)', border: '1px solid var(--border-subtle)',
            borderRadius: 8, padding: '6px 14px',
            fontFamily: 'var(--font-body)', fontSize: 10, color: 'var(--color-text-secondary)',
            maxWidth: 380, textAlign: 'center',
            backdropFilter: 'blur(8px)',
          }}
        >
          Sources aren't connected yet. Ingest more content with overlapping topics to see connections emerge.
        </div>
      )}
    </div>
  )
}
