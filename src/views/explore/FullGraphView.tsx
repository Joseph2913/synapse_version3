import { useState, useRef, useEffect, useCallback } from 'react'
import { Loader2, RefreshCw, ZoomIn, ZoomOut, Maximize2 } from 'lucide-react'
import { getEntityColor } from '../../config/entityTypes'
import { useAuth } from '../../hooks/useAuth'
import { fetchFullGraph, triggerLayoutComputation } from '../../services/graphQueries'
import type { FullGraphData, FullGraphNode } from '../../services/graphQueries'

// ─── Constants ───────────────────────────────────────────────────────────────

const MIN_ZOOM = 0.05
const MAX_ZOOM = 4.0
const LABEL_ZOOM_THRESHOLD = 0.15  // labels appear earlier since we have fewer nodes
const NODE_BASE_RADIUS = 10
const ANCHOR_RADIUS = 16
const EDGE_COLOR = 'rgba(0,0,0,0.06)'
const EDGE_HIGHLIGHT_COLOR = 'rgba(214,58,0,0.25)'

interface Camera { zoom: number; panX: number; panY: number }

// ─── Component ───────────────────────────────────────────────────────────────

export function FullGraphView() {
  const { user, session } = useAuth()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })

  const [graphData, setGraphData] = useState<FullGraphData | null>(null)
  const [loading, setLoading] = useState(true)
  const [computing, setComputing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null)
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)

  const cameraRef = useRef<Camera>({ zoom: 0.25, panX: 0, panY: 0 })
  const [camera, setCamera] = useState<Camera>({ zoom: 0.25, panX: 0, panY: 0 })
  const rafRef = useRef(0)

  // Drag state
  const dragRef = useRef<{ startX: number; startY: number; startPanX: number; startPanY: number } | null>(null)
  const hasDraggedRef = useRef(false)

  // ─── Sizing ────────────────────────────────────────────────────────────────
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver(entries => {
      const { width, height } = entries[0]!.contentRect
      setSize({ width, height })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Auto-center camera on actual node positions
  useEffect(() => {
    if (size.width <= 0 || size.height <= 0 || !graphData) return

    // Find bounding box of positioned nodes
    const positioned = graphData.nodes.filter(n => n.graphX != null && n.graphY != null)
    if (positioned.length === 0) {
      // No positioned nodes — default center
      const cam = { zoom: 0.5, panX: size.width / 2, panY: size.height / 2 }
      cameraRef.current = cam
      setCamera(cam)
      return
    }

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const n of positioned) {
      if (n.graphX! < minX) minX = n.graphX!
      if (n.graphY! < minY) minY = n.graphY!
      if (n.graphX! > maxX) maxX = n.graphX!
      if (n.graphY! > maxY) maxY = n.graphY!
    }

    const graphWidth = maxX - minX || 100
    const graphHeight = maxY - minY || 100
    const centerX = (minX + maxX) / 2
    const centerY = (minY + maxY) / 2

    // Zoom to fit all nodes with some padding
    const pad = 100
    const zoomX = size.width / (graphWidth + pad * 2)
    const zoomY = size.height / (graphHeight + pad * 2)
    const zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.min(zoomX, zoomY)))

    const panX = size.width / 2 - centerX * zoom
    const panY = size.height / 2 - centerY * zoom

    const cam = { zoom, panX, panY }
    cameraRef.current = cam
    setCamera(cam)
  }, [size.width, size.height, graphData])

  // ─── Data fetching ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!user) return
    setLoading(true)
    setError(null)

    fetchFullGraph(user.id)
      .then(data => {
        console.log('[FullGraph] Fetched:', {
          nodes: data.nodes.length,
          edges: data.edges.length,
          stats: data.stats,
          positionedSample: data.nodes.slice(0, 3).map(n => ({ id: n.id, label: n.label, graphX: n.graphX, graphY: n.graphY })),
        })
        setGraphData(data)

        // If no nodes have positions yet, trigger layout computation
        if (data.stats.positionedNodes === 0 && data.stats.totalNodes > 0 && session?.access_token) {
          console.log('[FullGraph] No positioned nodes — triggering compute-layout…')
          setComputing(true)
          triggerLayoutComputation(session.access_token, user.id)
            .then(ok => {
              console.log('[FullGraph] compute-layout result:', ok)
              // Reload data after computation
              return fetchFullGraph(user.id)
            })
            .then(freshData => {
              console.log('[FullGraph] Refreshed after layout:', freshData.stats)
              setGraphData(freshData)
            })
            .catch(err => console.error('[FullGraph] compute-layout error:', err))
            .finally(() => setComputing(false))
        }
      })
      .catch(err => setError(err.message))
      .finally(() => setLoading(false))
  }, [user, session])

  // ─── Build lookup maps ─────────────────────────────────────────────────────
  const nodeMapRef = useRef(new Map<string, FullGraphNode>())
  const adjacencyRef = useRef(new Map<string, Set<string>>())

  useEffect(() => {
    if (!graphData) return
    const nm = new Map<string, FullGraphNode>()
    for (const n of graphData.nodes) nm.set(n.id, n)
    nodeMapRef.current = nm

    const adj = new Map<string, Set<string>>()
    for (const e of graphData.edges) {
      if (!adj.has(e.sourceNodeId)) adj.set(e.sourceNodeId, new Set())
      if (!adj.has(e.targetNodeId)) adj.set(e.targetNodeId, new Set())
      adj.get(e.sourceNodeId)!.add(e.targetNodeId)
      adj.get(e.targetNodeId)!.add(e.sourceNodeId)
    }
    adjacencyRef.current = adj
  }, [graphData])

  // ─── Canvas rendering ──────────────────────────────────────────────────────
  const draw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas || !graphData) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dpr = window.devicePixelRatio || 1
    const { width, height } = size
    canvas.width = width * dpr
    canvas.height = height * dpr

    const cam = cameraRef.current
    ctx.setTransform(cam.zoom * dpr, 0, 0, cam.zoom * dpr, cam.panX * dpr, cam.panY * dpr)

    // Clear
    ctx.clearRect(
      -cam.panX / cam.zoom, -cam.panY / cam.zoom,
      width / cam.zoom, height / cam.zoom
    )

    const nodeMap = nodeMapRef.current
    const hovId = hoveredNodeId
    const selId = selectedNodeId
    const highlightIds = new Set<string>()
    if (hovId) {
      highlightIds.add(hovId)
      const neighbors = adjacencyRef.current.get(hovId)
      if (neighbors) for (const nid of neighbors) highlightIds.add(nid)
    }
    if (selId) {
      highlightIds.add(selId)
      const neighbors = adjacencyRef.current.get(selId)
      if (neighbors) for (const nid of neighbors) highlightIds.add(nid)
    }

    // ── Draw edges ───────────────────────────────────────────────────────────
    const hasHighlight = highlightIds.size > 0
    for (const e of graphData.edges) {
      const src = nodeMap.get(e.sourceNodeId)
      const tgt = nodeMap.get(e.targetNodeId)
      if (!src?.graphX || !src?.graphY || !tgt?.graphX || !tgt?.graphY) continue

      const isHighlighted = hasHighlight && highlightIds.has(e.sourceNodeId) && highlightIds.has(e.targetNodeId)

      ctx.beginPath()
      ctx.moveTo(src.graphX, src.graphY)
      ctx.lineTo(tgt.graphX, tgt.graphY)
      ctx.strokeStyle = isHighlighted ? EDGE_HIGHLIGHT_COLOR : (hasHighlight ? 'rgba(0,0,0,0.02)' : EDGE_COLOR)
      ctx.lineWidth = isHighlighted ? 1.5 / cam.zoom : 0.5 / cam.zoom
      ctx.stroke()
    }

    // ── Draw nodes ───────────────────────────────────────────────────────────
    const showLabels = cam.zoom >= LABEL_ZOOM_THRESHOLD

    for (const node of graphData.nodes) {
      if (node.graphX == null || node.graphY == null) continue
      const x = node.graphX
      const y = node.graphY
      const color = getEntityColor(node.entityType)
      const r = node.isAnchor ? ANCHOR_RADIUS : NODE_BASE_RADIUS
      const isHovered = node.id === hovId
      const isSelected = node.id === selId
      const isDimmed = hasHighlight && !highlightIds.has(node.id)

      // Node circle
      ctx.beginPath()
      ctx.arc(x, y, r, 0, Math.PI * 2)
      ctx.fillStyle = isDimmed ? `${color}15` : `${color}55`
      ctx.fill()
      ctx.strokeStyle = isDimmed ? `${color}30` : color
      ctx.lineWidth = (isHovered || isSelected) ? 2.5 / cam.zoom : 1.2 / cam.zoom
      ctx.stroke()

      // Hover/selection glow
      if (isHovered || isSelected) {
        ctx.beginPath()
        ctx.arc(x, y, r + 3, 0, Math.PI * 2)
        ctx.strokeStyle = isSelected ? '#d63a00' : `${color}40`
        ctx.lineWidth = 2 / cam.zoom
        ctx.stroke()
      }

      // Label (only when zoomed in enough)
      if (showLabels && !isDimmed) {
        const fontSize = Math.max(8, Math.min(11, 11 / cam.zoom))
        ctx.font = `500 ${fontSize}px "DM Sans", sans-serif`
        ctx.fillStyle = isHovered || isSelected ? 'rgba(0,0,0,0.9)' : 'rgba(0,0,0,0.55)'
        ctx.textAlign = 'center'
        ctx.textBaseline = 'top'
        const label = node.label.length > 22 ? node.label.slice(0, 20) + '…' : node.label
        ctx.fillText(label, x, y + r + 3)
      }
    }

    rafRef.current = requestAnimationFrame(draw)
  }, [graphData, size, hoveredNodeId, selectedNodeId])

  // Start/stop render loop
  useEffect(() => {
    if (graphData && size.width > 0) {
      rafRef.current = requestAnimationFrame(draw)
    }
    return () => cancelAnimationFrame(rafRef.current)
  }, [draw, graphData, size])

  // ─── Mouse interaction ─────────────────────────────────────────────────────

  const screenToWorld = useCallback((screenX: number, screenY: number) => {
    const cam = cameraRef.current
    return {
      x: (screenX - cam.panX) / cam.zoom,
      y: (screenY - cam.panY) / cam.zoom,
    }
  }, [])

  const hitTest = useCallback((worldX: number, worldY: number): FullGraphNode | null => {
    if (!graphData) return null
    // Reverse iterate so top-drawn nodes are hit first
    for (let i = graphData.nodes.length - 1; i >= 0; i--) {
      const n = graphData.nodes[i]!
      if (n.graphX == null || n.graphY == null) continue
      const dx = worldX - n.graphX
      const dy = worldY - n.graphY
      const r = (n.isAnchor ? ANCHOR_RADIUS : NODE_BASE_RADIUS) + 4
      if (dx * dx + dy * dy < r * r) return n
    }
    return null
  }, [graphData])

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    const rect = canvasRef.current?.getBoundingClientRect()
    if (!rect) return

    // Handle pan drag
    if (dragRef.current) {
      const dx = e.clientX - dragRef.current.startX
      const dy = e.clientY - dragRef.current.startY
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) hasDraggedRef.current = true
      const cam = {
        ...cameraRef.current,
        panX: dragRef.current.startPanX + dx,
        panY: dragRef.current.startPanY + dy,
      }
      cameraRef.current = cam
      setCamera(cam)
      return
    }

    const { x, y } = screenToWorld(e.clientX - rect.left, e.clientY - rect.top)
    const hit = hitTest(x, y)
    setHoveredNodeId(hit?.id ?? null)

    if (canvasRef.current) {
      canvasRef.current.style.cursor = hit ? 'pointer' : 'grab'
    }
  }, [screenToWorld, hitTest])

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    hasDraggedRef.current = false
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      startPanX: cameraRef.current.panX,
      startPanY: cameraRef.current.panY,
    }
  }, [])

  const handleMouseUp = useCallback((e: React.MouseEvent) => {
    dragRef.current = null
    if (hasDraggedRef.current) return

    const rect = canvasRef.current?.getBoundingClientRect()
    if (!rect) return
    const { x, y } = screenToWorld(e.clientX - rect.left, e.clientY - rect.top)
    const hit = hitTest(x, y)
    setSelectedNodeId(hit?.id ?? null)
  }, [screenToWorld, hitTest])

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault()
    const rect = canvasRef.current?.getBoundingClientRect()
    if (!rect) return

    const mouseX = e.clientX - rect.left
    const mouseY = e.clientY - rect.top

    const cam = cameraRef.current
    const factor = e.deltaY > 0 ? 0.9 : 1.1
    const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, cam.zoom * factor))

    // Zoom centered on mouse position
    const newPanX = mouseX - (mouseX - cam.panX) * (newZoom / cam.zoom)
    const newPanY = mouseY - (mouseY - cam.panY) * (newZoom / cam.zoom)

    const newCam = { zoom: newZoom, panX: newPanX, panY: newPanY }
    cameraRef.current = newCam
    setCamera(newCam)
  }, [])

  // ─── Zoom controls ─────────────────────────────────────────────────────────
  const zoomIn = useCallback(() => {
    const cam = cameraRef.current
    const newZoom = Math.min(MAX_ZOOM, cam.zoom * 1.3)
    const newCam = {
      zoom: newZoom,
      panX: size.width / 2 - (size.width / 2 - cam.panX) * (newZoom / cam.zoom),
      panY: size.height / 2 - (size.height / 2 - cam.panY) * (newZoom / cam.zoom),
    }
    cameraRef.current = newCam
    setCamera(newCam)
  }, [size])

  const zoomOut = useCallback(() => {
    const cam = cameraRef.current
    const newZoom = Math.max(MIN_ZOOM, cam.zoom * 0.7)
    const newCam = {
      zoom: newZoom,
      panX: size.width / 2 - (size.width / 2 - cam.panX) * (newZoom / cam.zoom),
      panY: size.height / 2 - (size.height / 2 - cam.panY) * (newZoom / cam.zoom),
    }
    cameraRef.current = newCam
    setCamera(newCam)
  }, [size])

  const resetZoom = useCallback(() => {
    if (!graphData) return
    const positioned = graphData.nodes.filter(n => n.graphX != null && n.graphY != null)
    if (positioned.length === 0) return

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const n of positioned) {
      if (n.graphX! < minX) minX = n.graphX!
      if (n.graphY! < minY) minY = n.graphY!
      if (n.graphX! > maxX) maxX = n.graphX!
      if (n.graphY! > maxY) maxY = n.graphY!
    }
    const graphWidth = maxX - minX || 100
    const graphHeight = maxY - minY || 100
    const centerX = (minX + maxX) / 2
    const centerY = (minY + maxY) / 2
    const pad = 100
    const zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.min(
      size.width / (graphWidth + pad * 2),
      size.height / (graphHeight + pad * 2)
    )))
    const cam = { zoom, panX: size.width / 2 - centerX * zoom, panY: size.height / 2 - centerY * zoom }
    cameraRef.current = cam
    setCamera(cam)
  }, [size, graphData])

  // ─── Recompute layout ──────────────────────────────────────────────────────
  const handleRecompute = useCallback(async () => {
    if (!user || !session?.access_token) return
    setComputing(true)
    await triggerLayoutComputation(session.access_token, user.id)
    const freshData = await fetchFullGraph(user.id)
    setGraphData(freshData)
    setComputing(false)
  }, [user, session])

  // ─── Selected node detail ──────────────────────────────────────────────────
  const selectedNode = selectedNodeId ? nodeMapRef.current.get(selectedNodeId) : null
  const selectedNeighborCount = selectedNodeId ? (adjacencyRef.current.get(selectedNodeId)?.size ?? 0) : 0

  // ─── Render ────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <Loader2 size={20} style={{ animation: 'spin 1s linear infinite', color: 'var(--color-text-secondary)' }} />
          <span className="font-body" style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
            Loading full graph…
          </span>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <span className="font-body" style={{ fontSize: 12, color: 'var(--color-semantic-red-500)' }}>
          {error}
        </span>
      </div>
    )
  }

  return (
    <div ref={containerRef} className="flex-1 overflow-hidden relative" style={{ userSelect: 'none', WebkitUserSelect: 'none' }}>
      <canvas
        ref={canvasRef}
        style={{ width: size.width, height: size.height, display: 'block' }}
        onMouseMove={handleMouseMove}
        onMouseDown={handleMouseDown}
        onMouseUp={handleMouseUp}
        onWheel={handleWheel}
      />

      {/* Computing overlay */}
      {computing && (
        <div className="absolute inset-0 flex items-center justify-center" style={{ background: 'rgba(255,255,255,0.8)', zIndex: 10 }}>
          <div className="flex flex-col items-center gap-3">
            <Loader2 size={20} style={{ animation: 'spin 1s linear infinite', color: 'var(--color-accent-500)' }} />
            <span className="font-body" style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
              Computing graph layout…
            </span>
          </div>
        </div>
      )}

      {/* Stats overlay */}
      <div
        className="absolute font-body"
        style={{
          top: 12, right: 12, padding: '8px 12px',
          background: 'rgba(255,255,255,0.9)', borderRadius: 8,
          border: '1px solid var(--border-subtle)',
          fontSize: 11, color: 'var(--color-text-secondary)',
          display: 'flex', flexDirection: 'column', gap: 2,
        }}
      >
        <div><strong style={{ color: 'var(--color-text-primary)' }}>{graphData?.stats.totalNodes.toLocaleString()}</strong> nodes</div>
        <div><strong style={{ color: 'var(--color-text-primary)' }}>{graphData?.stats.totalEdges.toLocaleString()}</strong> edges</div>
        <div style={{ fontSize: 10, opacity: 0.7 }}>Zoom: {Math.round(camera.zoom * 100)}%</div>
      </div>

      {/* Zoom controls */}
      <div
        className="absolute flex flex-col gap-1"
        style={{ bottom: 16, right: 12 }}
      >
        <button type="button" onClick={zoomIn} className="flex items-center justify-center" style={zoomBtnStyle}>
          <ZoomIn size={14} />
        </button>
        <button type="button" onClick={zoomOut} className="flex items-center justify-center" style={zoomBtnStyle}>
          <ZoomOut size={14} />
        </button>
        <button type="button" onClick={resetZoom} className="flex items-center justify-center" style={zoomBtnStyle}>
          <Maximize2 size={14} />
        </button>
        <button type="button" onClick={handleRecompute} className="flex items-center justify-center" style={zoomBtnStyle} title="Recompute layout">
          <RefreshCw size={14} style={computing ? { animation: 'spin 1s linear infinite' } : undefined} />
        </button>
      </div>

      {/* Selected node detail card */}
      {selectedNode && (
        <div
          className="absolute font-body"
          style={{
            bottom: 16, left: 16, width: 280, padding: '14px 16px',
            background: 'var(--color-bg-card)', borderRadius: 10,
            border: '1px solid var(--border-subtle)',
            boxShadow: '0 4px 12px rgba(0,0,0,0.08)',
          }}
        >
          <div className="flex items-center gap-2" style={{ marginBottom: 8 }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: getEntityColor(selectedNode.entityType), flexShrink: 0 }} />
            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text-primary)' }}>
              {selectedNode.label}
            </span>
          </div>
          <div style={{ fontSize: 11, color: 'var(--color-text-secondary)', display: 'flex', flexDirection: 'column', gap: 3 }}>
            <div>Type: <strong>{selectedNode.entityType}</strong></div>
            <div>Connections: <strong>{selectedNeighborCount}</strong></div>
            {selectedNode.isAnchor && <div style={{ color: 'var(--color-accent-500)', fontWeight: 600 }}>Anchor</div>}
            {selectedNode.confidence != null && <div>Confidence: {Math.round(selectedNode.confidence * 100)}%</div>}
          </div>
          <button
            type="button"
            onClick={() => setSelectedNodeId(null)}
            className="font-body"
            style={{
              marginTop: 8, fontSize: 10, color: 'var(--color-text-secondary)',
              background: 'none', border: 'none', cursor: 'pointer', padding: 0,
            }}
          >
            Press Escape or click elsewhere to close
          </button>
        </div>
      )}
    </div>
  )
}

const zoomBtnStyle: React.CSSProperties = {
  width: 30, height: 30, borderRadius: 8,
  background: 'rgba(255,255,255,0.9)',
  border: '1px solid var(--border-subtle)',
  color: 'var(--color-text-secondary)',
  cursor: 'pointer',
}
