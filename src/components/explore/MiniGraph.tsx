import { useRef, useEffect, useState } from 'react'
import { useAuth } from '../../hooks/useAuth'
import { fetchGraphData } from '../../services/graphQueries'
import type { GraphData, SimulationNode, SimulationEdge } from '../../types/graph'

const WIDTH = 290
const HEIGHT = 160
const GOLDEN_ANGLE = 2.39996322972865

function buildMiniNodes(data: GraphData): SimulationNode[] {
  const nodes: SimulationNode[] = []

  data.anchors.forEach((a, i) => {
    const angle = i * GOLDEN_ANGLE
    nodes.push({
      id: a.id,
      kind: 'anchor',
      x: WIDTH * 0.7 + Math.cos(angle) * WIDTH * 0.2,
      y: HEIGHT * 0.5 + Math.sin(angle) * HEIGHT * 0.3,
      vx: 0, vy: 0,
      radius: 8,
      label: a.label,
      color: a.color,
      entityType: a.entityType,
      connectionCount: a.connectionCount,
      description: a.description,
      confidence: a.confidence,
    })
  })

  data.sources.forEach((s, i) => {
    const angle = i * GOLDEN_ANGLE
    const r = 2.5 + Math.min((s.entityCount / 10) * 3.5, 3.5)
    nodes.push({
      id: s.id,
      kind: 'source',
      x: WIDTH * 0.3 + Math.cos(angle) * WIDTH * 0.2,
      y: HEIGHT * 0.5 + Math.sin(angle) * HEIGHT * 0.3,
      vx: 0, vy: 0,
      radius: r,
      label: s.label,
      color: s.color,
      sourceType: s.sourceType,
      icon: s.icon,
      entityCount: s.entityCount,
      metadata: s.metadata,
      createdAt: s.createdAt,
    })
  })

  return nodes
}

interface MiniGraphProps {
  contextNodeIds?: string[]
}

export function MiniGraph({ contextNodeIds }: MiniGraphProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const nodesRef = useRef<SimulationNode[]>([])
  const edgesRef = useRef<SimulationEdge[]>([])
  const rafRef = useRef<number | null>(null)
  const [data, setData] = useState<GraphData | null>(null)
  const { user } = useAuth()

  // Fetch graph data
  useEffect(() => {
    if (!user) return
    fetchGraphData(user.id)
      .then(setData)
      .catch(err => console.warn('MiniGraph data fetch failed:', err))
  }, [user])

  // Initialize nodes when data changes
  useEffect(() => {
    if (!data) return
    nodesRef.current = buildMiniNodes(data)
    edgesRef.current = data.edges.map(e => ({ sourceId: e.sourceId, anchorId: e.anchorId, weight: e.weight }))
  }, [data])

  // Canvas setup + render loop
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
      // Dampened drift for ambient feel
      for (const node of nodes) {
        node.vx *= 0.97
        node.vy *= 0.97
        node.vx += (Math.random() - 0.5) * 0.03
        node.vy += (Math.random() - 0.5) * 0.03

        // Soft boundary
        const pad = node.radius + 4
        if (node.x < pad) node.vx += 0.2
        if (node.x > WIDTH - pad) node.vx -= 0.2
        if (node.y < pad) node.vy += 0.2
        if (node.y > HEIGHT - pad) node.vy -= 0.2

        // Repulsion (limited pairs for mini graph)
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

      // Build lookup
      const nodeById = new Map<string, SimulationNode>()
      for (const node of nodes) nodeById.set(node.id, node)

      // Draw edges — faint
      for (const edge of edges) {
        const from = nodeById.get(edge.sourceId)
        const to = nodeById.get(edge.anchorId)
        if (!from || !to) continue

        ctx.beginPath()
        ctx.moveTo(from.x, from.y)
        ctx.lineTo(to.x, to.y)
        ctx.strokeStyle = 'rgba(0,0,0,0.03)'
        ctx.lineWidth = 0.5
        ctx.stroke()
      }

      // Draw nodes
      const anchorCount = nodes.filter(n => n.kind === 'anchor').length

      for (const node of nodes) {
        const inContext = contextSet ? contextSet.has(node.id) : true
        const alpha = inContext ? 1 : 0.3
        const r = inContext ? node.radius * 1.1 : node.radius

        ctx.beginPath()
        ctx.arc(node.x, node.y, r, 0, Math.PI * 2)

        // Parse color for rgba
        const hex = node.color
        const rv = parseInt(hex.slice(1, 3), 16)
        const gv = parseInt(hex.slice(3, 5), 16)
        const bv = parseInt(hex.slice(5, 7), 16)
        ctx.fillStyle = `rgba(${rv},${gv},${bv},${0.5 * alpha})`
        ctx.fill()

        // Anchor label when ≤5 anchors
        if (node.kind === 'anchor' && anchorCount <= 5) {
          ctx.font = '8px "DM Sans", sans-serif'
          ctx.fillStyle = `rgba(30,30,30,${0.65 * alpha})`
          ctx.textAlign = 'center'
          ctx.textBaseline = 'top'
          ctx.fillText(node.label.length > 12 ? node.label.slice(0, 11) + '…' : node.label, node.x, node.y + r + 2)
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
      style={{ display: 'block', borderRadius: 8, userSelect: 'none', WebkitUserSelect: 'none' }}
    />
  )
}
