import { useRef, useEffect } from 'react'
import { getEntityColor } from '../../config/entityTypes'
import type { EntityWithConnections } from '../../types/explore'
import type { EntityNeighbor } from '../../services/exploreQueries'

interface LocalGraphProps {
  entity: EntityWithConnections
  neighbors: EntityNeighbor[]
  width?: number
  height?: number
}

export function LocalGraph({ entity, neighbors, width = 262, height = 200 }: LocalGraphProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rafRef = useRef<number>(0)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    // Cap satellites for readability
    const satellites = neighbors.slice(0, 14)
    const centerColor = getEntityColor(entity.entityType)
    const cx = width / 2
    const cy = height / 2

    // Angle spacing for satellites
    const angleStep = satellites.length > 0 ? (Math.PI * 2) / satellites.length : 0
    const orbitRadius = Math.min(width, height) * 0.36

    // Gentle drift state
    let driftAngle = 0

    const draw = () => {
      ctx.clearRect(0, 0, width, height)

      // Draw edges
      for (let i = 0; i < satellites.length; i++) {
        const angle = angleStep * i + driftAngle
        const sx = cx + Math.cos(angle) * orbitRadius
        const sy = cy + Math.sin(angle) * orbitRadius
        const satColor = getEntityColor(satellites[i]!.node.entityType)

        ctx.beginPath()
        ctx.moveTo(cx, cy)
        ctx.lineTo(sx, sy)
        ctx.strokeStyle = satColor + '40' // 25% opacity
        ctx.lineWidth = 1.2
        ctx.stroke()
      }

      // Draw satellite nodes
      for (let i = 0; i < satellites.length; i++) {
        const sat = satellites[i]!
        const angle = angleStep * i + driftAngle
        const sx = cx + Math.cos(angle) * orbitRadius
        const sy = cy + Math.sin(angle) * orbitRadius
        const satColor = getEntityColor(sat.node.entityType)

        // Outer halo
        ctx.beginPath()
        ctx.arc(sx, sy, 7, 0, Math.PI * 2)
        ctx.fillStyle = satColor + '30'
        ctx.fill()

        // Inner dot
        ctx.beginPath()
        ctx.arc(sx, sy, 3.5, 0, Math.PI * 2)
        ctx.fillStyle = satColor
        ctx.fill()

        // Label
        const truncated = sat.node.label.length > 14
          ? sat.node.label.slice(0, 13) + '…'
          : sat.node.label
        ctx.font = '500 9px DM Sans, system-ui, sans-serif'
        ctx.fillStyle = '#808080'
        ctx.textAlign = 'center'
        ctx.textBaseline = 'top'
        ctx.fillText(truncated, sx, sy + 10)
      }

      // Draw center node
      // Outer circle (entity color at 20% opacity)
      ctx.beginPath()
      ctx.arc(cx, cy, 16, 0, Math.PI * 2)
      ctx.fillStyle = centerColor + '33'
      ctx.fill()
      ctx.strokeStyle = centerColor + '80'
      ctx.lineWidth = 1.5
      ctx.stroke()

      // Inner dot
      ctx.beginPath()
      ctx.arc(cx, cy, 6, 0, Math.PI * 2)
      ctx.fillStyle = centerColor
      ctx.fill()

      // Center label
      const centerLabel = entity.label.length > 18
        ? entity.label.slice(0, 17) + '…'
        : entity.label
      ctx.font = '600 10px DM Sans, system-ui, sans-serif'
      ctx.fillStyle = '#1a1a1a'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'top'
      ctx.fillText(centerLabel, cx, cy + 20)

      // Animate drift
      driftAngle += 0.003
      rafRef.current = requestAnimationFrame(draw)
    }

    rafRef.current = requestAnimationFrame(draw)
    return () => {
      cancelAnimationFrame(rafRef.current)
    }
  }, [entity, neighbors, width, height])

  return (
    <canvas
      ref={canvasRef}
      width={width}
      height={height}
      style={{ display: 'block', width, height, userSelect: 'none', WebkitUserSelect: 'none' }}
    />
  )
}
