import { useEffect, useRef, type RefObject } from 'react'
import type { SimulationNode, SimulationEdge, GraphLevel, Camera } from '../types/graph'

const BG_COLOR = '#f7f7f7'
const GRID_COLOR = 'rgba(0,0,0,0.018)'
const GRID_SPACING = 60

// ─── Edge colors by kind ─────────────────────────────────────────────────────

const EDGE_COLORS = {
  anchor:  { default: 'rgba(0,0,0,0.04)', hover: 'rgba(214,58,0,0.2)' },
  source:  { default: 'rgba(0,0,0,0.12)', hover: 'rgba(0,0,0,0.35)' },
  intra:   { default: 'rgba(0,0,0,0.06)', hover: 'rgba(0,0,0,0.18)' },
  cross:   { default: 'rgba(214,58,0,0.08)', hover: 'rgba(214,58,0,0.3)' },
  ghost:   { default: 'rgba(214,58,0,0.06)', hover: 'rgba(214,58,0,0.3)' },
} as const

// ─── Helpers ─────────────────────────────────────────────────────────────────

function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `rgba(${r},${g},${b},${alpha})`
}

function truncate(str: string, max: number): string {
  return str.length > max ? str.slice(0, max - 1) + '\u2026' : str
}

function drawRoundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.lineTo(x + w - r, y)
  ctx.quadraticCurveTo(x + w, y, x + w, y + r)
  ctx.lineTo(x + w, y + h - r)
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h)
  ctx.lineTo(x + r, y + h)
  ctx.quadraticCurveTo(x, y + h, x, y + h - r)
  ctx.lineTo(x, y + r)
  ctx.quadraticCurveTo(x, y, x + r, y)
  ctx.closePath()
}

// ─── Draw functions per level ────────────────────────────────────────────────

function drawGrid(ctx: CanvasRenderingContext2D, w: number, h: number) {
  ctx.strokeStyle = GRID_COLOR
  ctx.lineWidth = 1
  for (let x = 0; x < w; x += GRID_SPACING) {
    ctx.beginPath()
    ctx.moveTo(x, 0)
    ctx.lineTo(x, h)
    ctx.stroke()
  }
  for (let y = 0; y < h; y += GRID_SPACING) {
    ctx.beginPath()
    ctx.moveTo(0, y)
    ctx.lineTo(w, y)
    ctx.stroke()
  }
}

function drawEdge(
  ctx: CanvasRenderingContext2D,
  from: SimulationNode,
  to: SimulationNode,
  edge: SimulationEdge,
  isHovered: boolean,
  font: string
) {
  const colors = EDGE_COLORS[edge.kind] ?? EDGE_COLORS.source
  const isDashed = edge.kind === 'ghost' || edge.kind === 'cross'
  const baseWidth = edge.kind === 'anchor'
    ? 0.5 + edge.weight * 1.5
    : edge.kind === 'source'
      ? 1 + edge.weight * 2
      : 0.5 + edge.weight * 0.5

  const strokeWidth = isHovered ? baseWidth * 1.5 : baseWidth

  // Bezier control point
  const mx = (from.x + to.x) / 2
  const my = (from.y + to.y) / 2 - 20

  ctx.save()
  if (isDashed) ctx.setLineDash([4, 4])
  ctx.beginPath()
  ctx.moveTo(from.x, from.y)
  ctx.quadraticCurveTo(mx, my, to.x, to.y)
  ctx.strokeStyle = isHovered ? colors.hover : colors.default
  ctx.lineWidth = Math.min(strokeWidth, 6)
  ctx.stroke()
  ctx.restore()

  // Midpoint labels on hover
  if (isHovered) {
    ctx.font = `600 9px ${font}`
    ctx.fillStyle = 'rgba(100,100,100,0.8)'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'

    if (edge.kind === 'anchor') {
      const parts: string[] = []
      if (edge.bridgeEntityCount) parts.push(`${edge.bridgeEntityCount} bridge`)
      if (edge.sharedSourceCount) parts.push(`${edge.sharedSourceCount} sources`)
      if (parts.length > 0) ctx.fillText(parts.join(' \u00B7 '), mx, my)
    } else if (edge.kind === 'source' && edge.sharedEntityCount) {
      ctx.fillText(`${edge.sharedEntityCount} shared`, mx, my)
    } else if (edge.kind === 'intra' && edge.relationType) {
      // Relationship label pill
      const text = edge.relationType.replace(/_/g, ' ')
      const tw = ctx.measureText(text).width
      ctx.fillStyle = '#f0f0f0'
      drawRoundedRect(ctx, mx - tw / 2 - 4, my - 7, tw + 8, 14, 4)
      ctx.fill()
      ctx.fillStyle = 'rgba(80,80,80,0.8)'
      ctx.fillText(text, mx, my)
    }
  }
}

// ─── Anchor node drawing ─────────────────────────────────────────────────────

function drawAnchorNode(
  ctx: CanvasRenderingContext2D,
  node: SimulationNode,
  isHovered: boolean,
  isSelected: boolean,
  font: string
) {
  const r = node.radius

  // Solid filled circle
  const fillAlpha = isHovered ? 0.28 : 0.18
  const strokeAlpha = isHovered ? 0.6 : 0.35
  const strokeW = isSelected ? 2.5 : isHovered ? 2 : 1.5

  ctx.beginPath()
  ctx.arc(node.x, node.y, r, 0, Math.PI * 2)
  ctx.fillStyle = hexToRgba(node.color, fillAlpha)
  ctx.fill()
  ctx.strokeStyle = hexToRgba(node.color, isSelected ? 0.7 : strokeAlpha)
  ctx.lineWidth = strokeW
  ctx.stroke()

  // Entity count centered in node
  const countSize = Math.max(11, r * 0.38)
  ctx.font = `700 ${countSize}px ${font}`
  ctx.fillStyle = hexToRgba(node.color, 0.85)
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(`${node.entityCount ?? 0}`, node.x, node.y)

  // Label below node
  ctx.font = `${isHovered ? 600 : 500} 11px ${font}`
  ctx.fillStyle = isHovered ? '#1a1a1a' : 'rgba(30,30,30,0.75)'
  ctx.textBaseline = 'top'
  ctx.fillText(truncate(node.label, 22), node.x, node.y + r + 8)

  // Sub-label: source count
  ctx.font = `400 9px ${font}`
  ctx.fillStyle = 'rgba(100,100,100,0.6)'
  ctx.fillText(`${node.sourceCount ?? 0} sources`, node.x, node.y + r + 22)
}

// ─── Gravity anchor node drawing (all_sources level landmarks) ──────────────

function drawGravityAnchorNode(
  ctx: CanvasRenderingContext2D,
  node: SimulationNode,
  isHovered: boolean,
  isSelected: boolean,
  font: string
) {
  const r = node.radius

  // Subtle glow ring showing gravity field
  ctx.beginPath()
  ctx.arc(node.x, node.y, r + 8, 0, Math.PI * 2)
  ctx.fillStyle = hexToRgba(node.color, 0.06)
  ctx.fill()

  // Main circle — translucent fill with solid stroke
  const fillAlpha = isHovered ? 0.25 : 0.15
  const strokeAlpha = isHovered ? 0.6 : isSelected ? 0.7 : 0.3
  ctx.beginPath()
  ctx.arc(node.x, node.y, r, 0, Math.PI * 2)
  ctx.fillStyle = hexToRgba(node.color, fillAlpha)
  ctx.fill()
  ctx.strokeStyle = hexToRgba(node.color, strokeAlpha)
  ctx.lineWidth = isSelected ? 2.5 : 2
  ctx.stroke()

  // Connection count centered in node
  const countSize = Math.max(9, r * 0.45)
  ctx.font = `700 ${countSize}px ${font}`
  ctx.fillStyle = hexToRgba(node.color, 0.8)
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(`${node.connectionCount ?? 0}`, node.x, node.y)

  // Label below
  ctx.font = `${isHovered ? 700 : 600} 10px ${font}`
  ctx.fillStyle = isHovered ? hexToRgba(node.color, 0.95) : hexToRgba(node.color, 0.7)
  ctx.textBaseline = 'top'
  ctx.fillText(truncate(node.label, 22), node.x, node.y + r + 6)
}

// ─── Source node drawing ─────────────────────────────────────────────────────

function drawSourceNode(
  ctx: CanvasRenderingContext2D,
  node: SimulationNode,
  isHovered: boolean,
  isSelected: boolean,
  font: string,
  _parentAnchorColor?: string
) {
  const r = node.radius

  // Solid colored dot
  const fillAlpha = isHovered ? 0.85 : 0.6
  const strokeW = isSelected ? 2 : isHovered ? 1.5 : 0

  ctx.beginPath()
  ctx.arc(node.x, node.y, r, 0, Math.PI * 2)
  ctx.fillStyle = hexToRgba(node.color, fillAlpha)
  ctx.fill()
  if (strokeW > 0) {
    ctx.strokeStyle = hexToRgba(node.color, isSelected ? 0.9 : 0.7)
    ctx.lineWidth = strokeW
    ctx.stroke()
  }

  // Title label below node
  ctx.font = `${isHovered ? 600 : 400} 8px ${font}`
  ctx.fillStyle = isHovered ? '#1a1a1a' : 'rgba(30,30,30,0.5)'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'top'
  ctx.fillText(truncate(node.label, 20), node.x, node.y + r + 3)
}

// ─── Entity node drawing ─────────────────────────────────────────────────────

function drawEntityNode(
  ctx: CanvasRenderingContext2D,
  node: SimulationNode,
  isHovered: boolean,
  isSelected: boolean,
  font: string
) {
  const r = node.radius
  const isBridge = node.isBridge ?? false

  const fillAlpha = isHovered ? 0.2 : 0.1
  const strokeAlpha = isHovered ? 0.7 : 0.3

  // Main circle
  ctx.beginPath()
  ctx.arc(node.x, node.y, r, 0, Math.PI * 2)
  ctx.fillStyle = hexToRgba(node.color, fillAlpha)
  ctx.fill()
  ctx.strokeStyle = hexToRgba(node.color, isSelected ? 0.7 : strokeAlpha)
  ctx.lineWidth = isSelected ? 2 : 1.5
  ctx.stroke()

  // Bridge entity: outer accent ring + glow
  if (isBridge) {
    ctx.beginPath()
    ctx.arc(node.x, node.y, r + 3, 0, Math.PI * 2)
    ctx.strokeStyle = 'rgba(214,58,0,0.12)'
    ctx.lineWidth = 1.5
    ctx.stroke()
  }

  // Type dot center
  ctx.beginPath()
  ctx.arc(node.x, node.y, 3.5, 0, Math.PI * 2)
  ctx.fillStyle = hexToRgba(node.color, 0.8)
  ctx.fill()

  // Source count dots below node
  const dotCount = Math.min(node.sourceCount ?? 1, 5)
  if (dotCount > 1) {
    const dotY = node.y + r + 4
    const startX = node.x - (dotCount - 1) * 2.5
    for (let i = 0; i < dotCount; i++) {
      ctx.beginPath()
      ctx.arc(startX + i * 5, dotY, 2, 0, Math.PI * 2)
      ctx.fillStyle = 'rgba(100,100,100,0.3)'
      ctx.fill()
    }
  }

  // Label
  ctx.font = `500 9px ${font}`
  ctx.fillStyle = isHovered ? '#1a1a1a' : 'rgba(30,30,30,0.6)'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'top'
  ctx.fillText(truncate(node.label, 18), node.x, node.y + r + (dotCount > 1 ? 10 : 6))

  // Type label below
  ctx.font = `400 8px ${font}`
  ctx.fillStyle = hexToRgba(node.color, 0.5)
  ctx.fillText(node.entityType ?? '', node.x, node.y + r + (dotCount > 1 ? 20 : 16))

  // Cross-source hover indicator
  if (isHovered && isBridge) {
    ctx.font = `600 9px ${font}`
    ctx.fillStyle = 'rgba(214,58,0,0.7)'
    ctx.fillText('\u2197 cross-source', node.x, node.y + r + (dotCount > 1 ? 30 : 26))
  }
}

// ─── Ghost node drawing ──────────────────────────────────────────────────────

function drawGhostAnchor(ctx: CanvasRenderingContext2D, node: SimulationNode, isHovered: boolean, font: string) {
  const r = 18
  ctx.save()
  ctx.setLineDash([4, 3])
  ctx.beginPath()
  ctx.arc(node.x, node.y, r, 0, Math.PI * 2)
  ctx.fillStyle = hexToRgba(node.color, isHovered ? 0.2 : 0.05)
  ctx.fill()
  ctx.strokeStyle = hexToRgba(node.color, 0.15)
  ctx.lineWidth = 1.5
  ctx.stroke()
  ctx.restore()

  ctx.font = `bold 10px ${font}`
  ctx.fillStyle = hexToRgba(node.color, 0.5)
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText('\u2693', node.x, node.y)

  ctx.font = `500 9px ${font}`
  ctx.fillStyle = '#aaaaaa'
  ctx.textBaseline = 'top'
  ctx.fillText(truncate(node.label, 16), node.x, node.y + r + 4)
}

function drawGhostSource(ctx: CanvasRenderingContext2D, node: SimulationNode, isHovered: boolean, font: string) {
  const w = 40
  const h = 24
  ctx.save()
  ctx.setLineDash([4, 3])
  drawRoundedRect(ctx, node.x - w / 2, node.y - h / 2, w, h, 6)
  ctx.fillStyle = hexToRgba(node.color, isHovered ? 0.1 : 0.04)
  ctx.fill()
  ctx.strokeStyle = hexToRgba(node.color, 0.12)
  ctx.lineWidth = 1
  ctx.stroke()
  ctx.restore()

  ctx.font = '10px sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(node.icon ?? '\uD83D\uDCC4', node.x, node.y)

  ctx.font = `500 8px ${font}`
  ctx.fillStyle = '#aaaaaa'
  ctx.textBaseline = 'top'
  ctx.fillText(truncate(node.label, 16), node.x, node.y + h / 2 + 4)
}

// ─── Main hook ───────────────────────────────────────────────────────────────

export { type Camera }

export function useGraphRenderer(
  canvasRef: RefObject<HTMLCanvasElement | null>,
  nodesRef: React.MutableRefObject<SimulationNode[]>,
  edgesRef: React.MutableRefObject<SimulationEdge[]>,
  hoveredNodeIdRef: React.MutableRefObject<string | null>,
  selectedNodeId: string | null,
  level: GraphLevel,
  canvasWidth: number,
  canvasHeight: number,
  tick: () => void,
  cameraRef: React.MutableRefObject<Camera>,
  parentAnchorColor?: string
): void {
  const rafRef = useRef<number | null>(null)
  const fontReadyRef = useRef(false)

  useEffect(() => {
    document.fonts.ready.then(() => { fontReadyRef.current = true })
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || canvasWidth === 0 || canvasHeight === 0) return

    const dpr = window.devicePixelRatio || 1
    canvas.width = canvasWidth * dpr
    canvas.height = canvasHeight * dpr
    canvas.style.width = `${canvasWidth}px`
    canvas.style.height = `${canvasHeight}px`

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const render = () => {
      tick()

      const { zoom, panX, panY } = cameraRef.current
      const font = fontReadyRef.current ? '"DM Sans", sans-serif' : 'sans-serif'

      // Clear
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.fillStyle = BG_COLOR
      ctx.fillRect(0, 0, canvas.width, canvas.height)

      // Camera transform
      ctx.setTransform(zoom * dpr, 0, 0, zoom * dpr, panX * dpr, panY * dpr)

      // Grid
      drawGrid(ctx, canvasWidth / zoom + Math.abs(panX / zoom), canvasHeight / zoom + Math.abs(panY / zoom))

      const nodes = nodesRef.current
      const edges = edgesRef.current
      const hoveredId = hoveredNodeIdRef.current

      // Build node lookup
      const nodeById = new Map<string, SimulationNode>()
      for (const node of nodes) nodeById.set(node.id, node)

      // Determine hovered edges
      const hoveredEdgeSet = new Set<number>()
      if (hoveredId) {
        edges.forEach((edge, idx) => {
          if (edge.fromId === hoveredId || edge.toId === hoveredId) {
            hoveredEdgeSet.add(idx)
          }
        })
      }

      // Draw edges
      edges.forEach((edge, idx) => {
        const from = nodeById.get(edge.fromId)
        const to = nodeById.get(edge.toId)
        if (!from || !to) return
        drawEdge(ctx, from, to, edge, hoveredEdgeSet.has(idx), font)
      })

      // Draw nodes in layers: ghosts → gravity anchors → main nodes
      const ghostNodes = nodes.filter(n => n.kind === 'ghost_anchor' || n.kind === 'ghost_source')
      const gravityAnchors = nodes.filter(n => n.kind === 'anchor' && n.fixed)
      const mainNodes = nodes.filter(n => !n.fixed && n.kind !== 'ghost_anchor' && n.kind !== 'ghost_source')

      for (const node of ghostNodes) {
        if (node.kind === 'ghost_anchor') {
          drawGhostAnchor(ctx, node, node.id === hoveredId, font)
        } else {
          drawGhostSource(ctx, node, node.id === hoveredId, font)
        }
      }

      // Gravity well anchor nodes (behind source nodes)
      for (const node of gravityAnchors) {
        drawGravityAnchorNode(ctx, node, node.id === hoveredId, node.id === selectedNodeId, font)
      }

      for (const node of mainNodes) {
        const isHovered = node.id === hoveredId
        const isSelected = node.id === selectedNodeId

        if (node.kind === 'anchor') {
          drawAnchorNode(ctx, node, isHovered, isSelected, font)
        } else if (node.kind === 'source') {
          drawSourceNode(ctx, node, isHovered, isSelected, font, parentAnchorColor)
        } else if (node.kind === 'entity') {
          drawEntityNode(ctx, node, isHovered, isSelected, font)
        }
      }

      rafRef.current = requestAnimationFrame(render)
    }

    rafRef.current = requestAnimationFrame(render)

    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvasWidth, canvasHeight, selectedNodeId, level, parentAnchorColor])
}
