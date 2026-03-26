import { useRef, useState, useEffect, useCallback } from 'react'
import { useGraphSimulation } from '../../hooks/useGraphSimulation'
import { useGraphRenderer } from '../../hooks/useGraphRenderer'
import { useGraphInteraction } from '../../hooks/useGraphInteraction'
import type { GraphLevel, SimulationNode, Camera } from '../../types/graph'
import type { LevelData } from '../../hooks/useGraphData'

const MIN_ZOOM = 0.2
const MAX_ZOOM = 4.0

interface GraphCanvasProps {
  levelData: LevelData
  level: GraphLevel
  selectedNodeId: string | null
  parentAnchorColor?: string
  onClickNode: (nodeId: string, kind: SimulationNode['kind']) => void
  onRightClick: () => void
  onClickEmpty: () => void
  onHoverNode: (nodeId: string | null) => void
}

export function GraphCanvas({
  levelData,
  level,
  selectedNodeId,
  parentAnchorColor,
  onClickNode,
  onRightClick,
  onClickEmpty,
  onHoverNode,
}: GraphCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [dims, setDims] = useState({ width: 0, height: 0 })
  const hoveredNodeIdRef = useRef<string | null>(null)
  const cameraRef = useRef<Camera>({ zoom: 1, panX: 0, panY: 0 })
  const wasDraggingRef = useRef(false)

  // Reset camera on level change
  useEffect(() => {
    cameraRef.current = { zoom: 1, panX: 0, panY: 0 }
  }, [level])

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

  const { nodesRef, edgesRef, tick } = useGraphSimulation(levelData, dims.width, dims.height)

  useGraphRenderer(
    canvasRef,
    nodesRef,
    edgesRef,
    hoveredNodeIdRef,
    selectedNodeId,
    level,
    dims.width,
    dims.height,
    tick,
    cameraRef,
    parentAnchorColor
  )

  useGraphInteraction(
    canvasRef,
    nodesRef,
    hoveredNodeIdRef,
    cameraRef,
    wasDraggingRef,
    onHoverNode,
    onClickNode,
    onRightClick,
    onClickEmpty
  )

  // Wheel zoom
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

      cameraRef.current = {
        zoom: newZoom,
        panX: mouseX - (mouseX - cam.panX) * (newZoom / cam.zoom),
        panY: mouseY - (mouseY - cam.panY) * (newZoom / cam.zoom),
      }
    }

    canvas.addEventListener('wheel', handleWheel, { passive: false })
    return () => canvas.removeEventListener('wheel', handleWheel)
  }, [dims])

  // Drag: pan canvas (empty space) or drag individual nodes
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    let mode: 'none' | 'pan' | 'node' = 'none'
    let startX = 0
    let startY = 0
    let startPanX = 0
    let startPanY = 0
    let draggedNode: SimulationNode | null = null

    const toWorld = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect()
      const sx = e.clientX - rect.left
      const sy = e.clientY - rect.top
      const { zoom, panX, panY } = cameraRef.current
      return { wx: (sx - panX) / zoom, wy: (sy - panY) / zoom }
    }

    const handleMouseDown = (e: MouseEvent) => {
      startX = e.clientX
      startY = e.clientY
      wasDraggingRef.current = false

      // Check if hovering a node — start node drag
      if (hoveredNodeIdRef.current) {
        const node = nodesRef.current.find(n => n.id === hoveredNodeIdRef.current)
        if (node) {
          mode = 'node'
          draggedNode = node
          node.vx = 0
          node.vy = 0
          canvas.style.cursor = 'grabbing'
          return
        }
      }

      // Otherwise pan the canvas
      mode = 'pan'
      startPanX = cameraRef.current.panX
      startPanY = cameraRef.current.panY
      canvas.style.cursor = 'grab'
    }

    const handleMouseMove = (e: MouseEvent) => {
      if (mode === 'none') return
      const dx = e.clientX - startX
      const dy = e.clientY - startY
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
        wasDraggingRef.current = true
      }

      if (mode === 'pan') {
        cameraRef.current = {
          ...cameraRef.current,
          panX: startPanX + dx,
          panY: startPanY + dy,
        }
      } else if (mode === 'node' && draggedNode) {
        const { wx, wy } = toWorld(e)
        draggedNode.x = wx
        draggedNode.y = wy
        draggedNode.vx = 0
        draggedNode.vy = 0
      }
    }

    const handleMouseUp = () => {
      if (mode !== 'none') {
        mode = 'none'
        draggedNode = null
        canvas.style.cursor = hoveredNodeIdRef.current ? 'pointer' : 'default'
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
  }, [dims, nodesRef])

  // Zoom controls
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
    <div ref={containerRef} className="w-full h-full relative">
      <canvas
        ref={canvasRef}
        style={{ display: 'block', width: dims.width, height: dims.height }}
      />

      {/* Zoom controls */}
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
          { label: '\u2212', title: 'Zoom out', action: zoomOut },
          { label: '\u2299', title: 'Reset zoom', action: resetZoom },
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
