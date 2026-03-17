import { useRef, useState, useEffect, useCallback } from 'react'
import { useGraphSimulation } from '../../hooks/useGraphSimulation'
import { useGraphRenderer, type Camera } from '../../hooks/useGraphRenderer'
import { useGraphInteraction } from '../../hooks/useGraphInteraction'
import type { GraphData, GraphScope, EntityDot, SimulationNode } from '../../types/graph'

const MIN_ZOOM = 0.2
const MAX_ZOOM = 4.0

interface GraphCanvasProps {
  data: GraphData
  scope: GraphScope
  expandedNodeId: string | null
  selectedNodeId: string | null
  expandedEntities: EntityDot[] | null
  onClickNode: (node: SimulationNode) => void
  onExpandNode: (nodeId: string, kind: 'source' | 'anchor') => void
  onClickEmpty: () => void
}

export function GraphCanvas({
  data,
  scope,
  expandedNodeId,
  selectedNodeId,
  expandedEntities,
  onClickNode,
  onExpandNode,
  onClickEmpty,
}: GraphCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [dims, setDims] = useState({ width: 0, height: 0 })
  const hoveredNodeIdRef = useRef<string | null>(null)
  const cameraRef = useRef<Camera>({ zoom: 1, panX: 0, panY: 0 })

  // Measure container
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const obs = new ResizeObserver(entries => {
      const entry = entries[0]
      if (!entry) return
      const { width, height } = entry.contentRect
      setDims({ width: Math.floor(width), height: Math.floor(height) })
    })
    obs.observe(el)
    const rect = el.getBoundingClientRect()
    setDims({ width: Math.floor(rect.width), height: Math.floor(rect.height) })
    return () => obs.disconnect()
  }, [])

  const { nodesRef, edgesRef, tick } = useGraphSimulation(data, scope, dims.width, dims.height)

  useGraphRenderer(
    canvasRef,
    nodesRef,
    edgesRef,
    hoveredNodeIdRef,
    selectedNodeId,
    expandedNodeId,
    expandedEntities,
    dims.width,
    dims.height,
    tick,
    cameraRef
  )

  const handleClick = useCallback((nodeId: string) => {
    const node = nodesRef.current.find(n => n.id === nodeId)
    if (node) onClickNode(node)
  }, [nodesRef, onClickNode])

  const handleDoubleClick = useCallback((nodeId: string) => {
    const node = nodesRef.current.find(n => n.id === nodeId)
    if (node) onExpandNode(nodeId, node.kind)
  }, [nodesRef, onExpandNode])

  useGraphInteraction(
    canvasRef,
    nodesRef,
    hoveredNodeIdRef,
    cameraRef,
    () => {},
    handleClick,
    handleDoubleClick,
    onClickEmpty
  )

  // ── Wheel zoom ──────────────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const handleWheel = (e: WheelEvent) => {
      e.preventDefault()
      const rect = canvas.getBoundingClientRect()
      const mouseX = e.clientX - rect.left
      const mouseY = e.clientY - rect.top

      const factor = e.deltaY < 0 ? 1.1 : 0.9
      const cam = cameraRef.current
      const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, cam.zoom * factor))

      // Zoom around cursor: keep world-point under cursor fixed
      cameraRef.current = {
        zoom: newZoom,
        panX: mouseX - (mouseX - cam.panX) * (newZoom / cam.zoom),
        panY: mouseY - (mouseY - cam.panY) * (newZoom / cam.zoom),
      }
    }

    canvas.addEventListener('wheel', handleWheel, { passive: false })
    return () => canvas.removeEventListener('wheel', handleWheel)
  }, [dims]) // re-attach when dims change (canvas element stays same)

  // ── Drag-to-pan ─────────────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    let dragging = false
    let startX = 0
    let startY = 0
    let startPanX = 0
    let startPanY = 0
    let didDrag = false

    const handleMouseDown = (e: MouseEvent) => {
      // Only pan when clicking empty space (no node hovered)
      if (hoveredNodeIdRef.current) return
      dragging = true
      didDrag = false
      startX = e.clientX
      startY = e.clientY
      startPanX = cameraRef.current.panX
      startPanY = cameraRef.current.panY
      canvas.style.cursor = 'grab'
    }

    const handleMouseMove = (e: MouseEvent) => {
      if (!dragging) return
      const dx = e.clientX - startX
      const dy = e.clientY - startY
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) didDrag = true
      cameraRef.current = {
        ...cameraRef.current,
        panX: startPanX + dx,
        panY: startPanY + dy,
      }
    }

    const handleMouseUp = () => {
      if (dragging) {
        dragging = false
        canvas.style.cursor = didDrag ? 'default' : 'default'
      }
    }

    canvas.addEventListener('mousedown', handleMouseDown)
    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)

    return () => {
      canvas.removeEventListener('mousedown', handleMouseDown)
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [dims])

  // ── Zoom control helpers ─────────────────────────────────────────────────────
  const zoomIn = useCallback(() => {
    const cam = cameraRef.current
    const cx = dims.width / 2
    const cy = dims.height / 2
    const newZoom = Math.min(MAX_ZOOM, cam.zoom * 1.25)
    cameraRef.current = {
      zoom: newZoom,
      panX: cx - (cx - cam.panX) * (newZoom / cam.zoom),
      panY: cy - (cy - cam.panY) * (newZoom / cam.zoom),
    }
  }, [dims])

  const zoomOut = useCallback(() => {
    const cam = cameraRef.current
    const cx = dims.width / 2
    const cy = dims.height / 2
    const newZoom = Math.max(MIN_ZOOM, cam.zoom / 1.25)
    cameraRef.current = {
      zoom: newZoom,
      panX: cx - (cx - cam.panX) * (newZoom / cam.zoom),
      panY: cy - (cy - cam.panY) * (newZoom / cam.zoom),
    }
  }, [dims])

  const resetZoom = useCallback(() => {
    cameraRef.current = { zoom: 1, panX: 0, panY: 0 }
  }, [])

  return (
    <div ref={containerRef} className="w-full h-full relative" style={{ userSelect: 'none', WebkitUserSelect: 'none' }}>
      <canvas
        ref={canvasRef}
        style={{ display: 'block', width: dims.width, height: dims.height, userSelect: 'none' }}
      />

      {/* Zoom controls — bottom-right overlay */}
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
          { label: '+', title: 'Zoom in', action: zoomIn },
          { label: '−', title: 'Zoom out', action: zoomOut },
          { label: '⊙', title: 'Reset zoom', action: resetZoom },
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
    </div>
  )
}
