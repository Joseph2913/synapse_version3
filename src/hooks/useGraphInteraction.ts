import { useEffect, useRef, type RefObject } from 'react'
import type { SimulationNode, Camera } from '../types/graph'

function hitTestNode(node: SimulationNode, wx: number, wy: number): boolean {
  const dx = wx - node.x
  const dy = wy - node.y
  return Math.sqrt(dx * dx + dy * dy) < node.radius + 4
}

export function useGraphInteraction(
  canvasRef: RefObject<HTMLCanvasElement | null>,
  nodesRef: React.MutableRefObject<SimulationNode[]>,
  hoveredNodeIdRef: React.MutableRefObject<string | null>,
  cameraRef: React.MutableRefObject<Camera>,
  wasDraggingRef: React.MutableRefObject<boolean>,
  onHover: (nodeId: string | null) => void,
  onClick: (nodeId: string, kind: SimulationNode['kind']) => void,
  onRightClick: () => void,
  onClickEmpty: () => void
): void {
  // Use refs so event listeners always call the latest callback versions
  const onClickRef = useRef(onClick)
  const onHoverRef = useRef(onHover)
  const onRightClickRef = useRef(onRightClick)
  const onClickEmptyRef = useRef(onClickEmpty)
  onClickRef.current = onClick
  onHoverRef.current = onHover
  onRightClickRef.current = onRightClick
  onClickEmptyRef.current = onClickEmpty

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const toWorld = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect()
      const sx = e.clientX - rect.left
      const sy = e.clientY - rect.top
      const { zoom, panX, panY } = cameraRef.current
      return { wx: (sx - panX) / zoom, wy: (sy - panY) / zoom }
    }

    const findNodeAt = (wx: number, wy: number): SimulationNode | null => {
      const nodes = nodesRef.current
      for (let i = nodes.length - 1; i >= 0; i--) {
        const node = nodes[i]
        if (node && hitTestNode(node, wx, wy)) return node
      }
      return null
    }

    const handleMouseMove = (e: MouseEvent) => {
      const { wx, wy } = toWorld(e)
      const hit = findNodeAt(wx, wy)
      const newId = hit?.id ?? null

      if (newId !== hoveredNodeIdRef.current) {
        hoveredNodeIdRef.current = newId
        canvas.style.cursor = newId ? 'pointer' : 'default'
        onHoverRef.current(newId)
      }
    }

    const handleClick = (e: MouseEvent) => {
      // Suppress click if the user was dragging (pan or node drag)
      if (wasDraggingRef.current) {
        wasDraggingRef.current = false
        return
      }

      const { wx, wy } = toWorld(e)
      const hit = findNodeAt(wx, wy)

      if (!hit) {
        onClickEmptyRef.current()
        return
      }

      onClickRef.current(hit.id, hit.kind)
    }

    const handleContextMenu = (e: MouseEvent) => {
      e.preventDefault()
      onRightClickRef.current()
    }

    const handleMouseLeave = () => {
      hoveredNodeIdRef.current = null
      canvas.style.cursor = 'default'
      onHoverRef.current(null)
    }

    canvas.addEventListener('mousemove', handleMouseMove)
    canvas.addEventListener('click', handleClick)
    canvas.addEventListener('contextmenu', handleContextMenu)
    canvas.addEventListener('mouseleave', handleMouseLeave)

    return () => {
      canvas.removeEventListener('mousemove', handleMouseMove)
      canvas.removeEventListener('click', handleClick)
      canvas.removeEventListener('contextmenu', handleContextMenu)
      canvas.removeEventListener('mouseleave', handleMouseLeave)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvasRef.current])
}
