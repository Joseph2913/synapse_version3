import { useRef, useEffect, useState } from 'react'
import { useAuth } from '../../hooks/useAuth'
import { fetchAnchorLevelData } from '../../services/graphQueries'
import type { AnchorLevelData, SimulationNode, SimulationEdge } from '../../types/graph'

const WIDTH = 290
const HEIGHT = 160
const GOLDEN_ANGLE = 2.39996322972865

function buildMiniNodes(data: AnchorLevelData): SimulationNode[] {
  return data.anchors.map((a, i) => {
    const angle = i * GOLDEN_ANGLE
    return {
      id: a.id,
      kind: 'anchor' as const,
      x: WIDTH * 0.5 + Math.cos(angle) * WIDTH * 0.3,
      y: HEIGHT * 0.5 + Math.sin(angle) * HEIGHT * 0.3,
      vx: 0, vy: 0,
      radius: 6 + Math.sqrt(a.entityCount) * 0.8,
      label: a.label,
      color: a.color,
      entityType: a.entityType,
      entityCount: a.entityCount,
      connectionCount: a.connectionCount,
    }
  })
}

function buildMiniEdges(data: AnchorLevelData): SimulationEdge[] {
  return data.edges.map(e => ({
    fromId: e.fromAnchorId,
    toId: e.toAnchorId,
    weight: e.strength,
    kind: 'anchor' as const,
  }))
}

interface MiniGraphProps {
  contextNodeIds?: string[]
}

export function MiniGraph({ contextNodeIds }: MiniGraphProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const nodesRef = useRef<SimulationNode[]>([])
  const edgesRef = useRef<SimulationEdge[]>([])
  const rafRef = useRef<number | null>(null)
  const [data, setData] = useState<AnchorLevelData | null>(null)
  const { user } = useAuth()

  useEffect(() => {
    if (!user) return
    fetchAnchorLevelData(user.id)
      .then(setData)
      .catch((err: unknown) => console.warn('MiniGraph data fetch failed:', err))
  }, [user])

  useEffect(() => {
    if (!data) return
    nodesRef.current = buildMiniNodes(data)
    edgesRef.current = buildMiniEdges(data)
  }, [data])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const dpr = window.devicePixelRatio || 1
    canvas.width = WIDTH * dpr
    canvas.height = HEIGHT * dpr
    canvas.style.width = `${WIDTH}px`
    canvas.style.height = `${HEIGHT}px`

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const contextSet = contextNodeIds ? new Set(contextNodeIds) : null

    const tick = () => {
      const nodes = nodesRef.current
      for (const node of nodes) {
        node.vx *= 0.97
        node.vy *= 0.97
        node.vx += (Math.random() - 0.5) * 0.03
        node.vy += (Math.random() - 0.5) * 0.03

        const pad = node.radius + 4
        if (node.x < pad) node.vx += 0.2
        if (node.x > WIDTH - pad) node.vx -= 0.2
        if (node.y < pad) node.vy += 0.2
        if (node.y > HEIGHT - pad) node.vy -= 0.2

        for (const other of nodes) {
          if (other.id === node.id) continue
          const dx = node.x - other.x
          const dy = node.y - other.y
          const dist = Math.sqrt(dx * dx + dy * dy) || 1
          if (dist < 40) {
            const force = (40 - dist) * 0.002
            node.vx += (dx / dist) * force
            node.vy += (dy / dist) * force
          }
        }

        node.x += node.vx
        node.y += node.vy
      }
    }

    const render = () => {
      tick()

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, WIDTH, HEIGHT)

      const nodes = nodesRef.current
      const edges = edgesRef.current

      const nodeById = new Map<string, SimulationNode>()
      for (const node of nodes) nodeById.set(node.id, node)

      // Draw edges
      for (const edge of edges) {
        const from = nodeById.get(edge.fromId)
        const to = nodeById.get(edge.toId)
        if (!from || !to) continue

        ctx.beginPath()
        ctx.moveTo(from.x, from.y)
        ctx.lineTo(to.x, to.y)
        ctx.strokeStyle = 'rgba(0,0,0,0.03)'
        ctx.lineWidth = 0.5
        ctx.stroke()
      }

      // Draw nodes
      const anchorCount = nodes.length

      for (const node of nodes) {
        const inContext = contextSet ? contextSet.has(node.id) : true
        const alpha = inContext ? 1 : 0.3
        const r = inContext ? node.radius * 1.1 : node.radius

        ctx.beginPath()
        ctx.arc(node.x, node.y, r, 0, Math.PI * 2)

        const hex = node.color
        const rv = parseInt(hex.slice(1, 3), 16)
        const gv = parseInt(hex.slice(3, 5), 16)
        const bv = parseInt(hex.slice(5, 7), 16)
        ctx.fillStyle = `rgba(${rv},${gv},${bv},${0.5 * alpha})`
        ctx.fill()

        if (anchorCount <= 5) {
          ctx.font = '8px "DM Sans", sans-serif'
          ctx.fillStyle = `rgba(30,30,30,${0.65 * alpha})`
          ctx.textAlign = 'center'
          ctx.textBaseline = 'top'
          ctx.fillText(
            node.label.length > 12 ? node.label.slice(0, 11) + '\u2026' : node.label,
            node.x,
            node.y + r + 2
          )
        }
      }

      rafRef.current = requestAnimationFrame(render)
    }

    rafRef.current = requestAnimationFrame(render)
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, contextNodeIds])

  return (
    <canvas
      ref={canvasRef}
      style={{ display: 'block', borderRadius: 8 }}
    />
  )
}
