import { useMemo } from 'react'
import type { EntityNode } from '../types/explore'
import type { EntityEdge } from '../services/exploreQueries'

export interface EntityPosition {
  x: number
  y: number
  radius: number
}

/** Anchor hub info for clustered layout */
export interface AnchorHub {
  id: string
  label: string
  entityCount: number
}

/**
 * Computes entity node positions using a synchronous force simulation.
 * When anchorHubs are provided, entities cluster around their parent anchor hub.
 */
export function useEntityLayout(
  entities: EntityNode[],
  edges: EntityEdge[],
  width: number,
  height: number,
  anchorHubs?: AnchorHub[]
): Map<string, EntityPosition> {
  return useMemo(() => {
    if (!entities.length || width === 0 || height === 0) return new Map()

    const maxConn = Math.max(...entities.map(e => e.connectionCount), 1)
    const hasHubs = anchorHubs && anchorHubs.length > 1

    // Virtual canvas scales with entity count
    const densityFactor = entities.length > 200 ? 1.9 : entities.length > 100 ? 1.75 : entities.length > 50 ? 1.65 : 1.6
    const vw = Math.max(width * densityFactor, 900)
    const vh = Math.max(height * densityFactor, 900)

    // Smaller layout radii for dense graphs
    const rScale = entities.length > 200 ? 0.5 : entities.length > 100 ? 0.65 : entities.length > 50 ? 0.8 : 1

    interface SimNode {
      id: string
      x: number
      y: number
      vx: number
      vy: number
      radius: number
      isHub: boolean
      hubId: string | null // which hub this entity belongs to
    }

    // ── Place anchor hubs in a ring around center ──────────────────────────
    const hubNodes: SimNode[] = []
    const hubPositions = new Map<string, { x: number; y: number }>()

    if (hasHubs) {
      const ringR = Math.min(vw, vh) * 0.3
      const cx = vw / 2
      const cy = vh / 2
      anchorHubs.forEach((hub, i) => {
        const angle = (i / anchorHubs.length) * Math.PI * 2 - Math.PI / 2
        const hx = cx + Math.cos(angle) * ringR
        const hy = cy + Math.sin(angle) * ringR
        // Hub radius proportional to entity count
        const hubR = 10 + Math.sqrt(hub.entityCount) * 1.5
        hubNodes.push({
          id: hub.id,
          x: hx, y: hy, vx: 0, vy: 0,
          radius: hubR,
          isHub: true,
          hubId: null,
        })
        hubPositions.set(hub.id, { x: hx, y: hy })
      })
    }

    // ── Create entity nodes — initialize near parent hub if available ──────
    const entityNodes: SimNode[] = entities.map(e => {
      const hubPos = hasHubs && e.originAnchorId ? hubPositions.get(e.originAnchorId) : null
      const scatter = hasHubs ? Math.min(vw, vh) * 0.15 : vw * 0.42
      const baseX = hubPos ? hubPos.x : vw / 2
      const baseY = hubPos ? hubPos.y : vh / 2

      return {
        id: e.id,
        x: baseX + (Math.random() - 0.5) * scatter,
        y: baseY + (Math.random() - 0.5) * scatter,
        vx: 0,
        vy: 0,
        radius: (3 + Math.min(e.connectionCount / maxConn, 1) * 6) * rScale,
        isHub: false,
        hubId: e.originAnchorId ?? null,
      }
    })

    const nodes = [...hubNodes, ...entityNodes]

    // Build adjacency for link forces (entity-entity edges only)
    const nodeById = new Map(nodes.map(n => [n.id, n]))
    const linkPairs = edges
      .map(e => ({ source: nodeById.get(e.sourceNodeId), target: nodeById.get(e.targetNodeId) }))
      .filter(l => l.source && l.target) as { source: SimNode; target: SimNode }[]

    // Run simulation
    const ticks = hasHubs ? 320 : 280
    for (let tick = 0; tick < ticks; tick++) {
      const damping = 0.85
      const progress = tick / ticks // 0→1, useful for cooling

      // 1. Center gravity (weak)
      for (const n of nodes) {
        if (n.isHub) continue // hubs have their own forces
        const dx = vw / 2 - n.x
        const dy = vh / 2 - n.y
        n.vx += dx * 0.0004
        n.vy += dy * 0.0004
      }

      // 2. Hub gravity — entities pulled toward their parent hub
      if (hasHubs) {
        for (const n of nodes) {
          if (n.isHub || !n.hubId) continue
          const hub = nodeById.get(n.hubId)
          if (!hub) continue
          const dx = hub.x - n.x
          const dy = hub.y - n.y
          const dist = Math.sqrt(dx * dx + dy * dy) || 1
          // Strong pull that weakens as simulation cools
          const strength = 0.012 * (1 - progress * 0.5)
          n.vx += (dx / dist) * dist * strength
          n.vy += (dy / dist) * dist * strength
        }

        // Hub-hub repulsion — keep hubs spread apart
        for (let i = 0; i < hubNodes.length; i++) {
          for (let j = i + 1; j < hubNodes.length; j++) {
            const a = hubNodes[i]!
            const b = hubNodes[j]!
            const dx = b.x - a.x
            const dy = b.y - a.y
            const dist = Math.sqrt(dx * dx + dy * dy) || 1
            const minDist = a.radius + b.radius + 120
            if (dist < minDist) {
              const force = (minDist - dist) * 0.05
              a.vx -= (dx / dist) * force
              a.vy -= (dy / dist) * force
              b.vx += (dx / dist) * force
              b.vy += (dy / dist) * force
            }
          }
        }

        // Hub center gravity — keep hubs loosely centered
        for (const h of hubNodes) {
          const dx = vw / 2 - h.x
          const dy = vh / 2 - h.y
          h.vx += dx * 0.0008
          h.vy += dy * 0.0008
        }
      }

      // 3a. Hub-entity repulsion — strong exclusion zone around each hub
      if (hasHubs) {
        for (const hub of hubNodes) {
          for (const ent of entityNodes) {
            const dx = ent.x - hub.x
            const dy = ent.y - hub.y
            const dist = Math.sqrt(dx * dx + dy * dy) || 1
            // Entities must stay outside the hub's radius + generous clearance
            const exclusionR = hub.radius + ent.radius + 35
            if (dist < exclusionR) {
              const force = (exclusionR - dist) * 0.25
              const fx = (dx / dist) * force
              const fy = (dy / dist) * force
              ent.vx += fx
              ent.vy += fy
            }
          }
        }
      }

      // 3b. Node-node repulsion (entity-entity)
      for (let i = 0; i < entityNodes.length; i++) {
        for (let j = i + 1; j < entityNodes.length; j++) {
          const a = entityNodes[i]!
          const b = entityNodes[j]!
          const dx = b.x - a.x
          const dy = b.y - a.y
          const dist = Math.sqrt(dx * dx + dy * dy) || 1
          const minDist = a.radius + b.radius + (hasHubs ? 20 : 30)
          if (dist < minDist) {
            const force = (minDist - dist) * 0.08
            const fx = (dx / dist) * force
            const fy = (dy / dist) * force
            a.vx -= fx
            a.vy -= fy
            b.vx += fx
            b.vy += fy
          }
          // Longer range charge repulsion
          const chargeRange = hasHubs ? 150 : 200
          if (dist < chargeRange) {
            const charge = (hasHubs ? 180 : 280) / (dist * dist)
            const fx = (dx / dist) * charge
            const fy = (dy / dist) * charge
            a.vx -= fx
            a.vy -= fy
            b.vx += fx
            b.vy += fy
          }
        }
      }

      // 4. Link attraction (entity-entity edges)
      for (const link of linkPairs) {
        const dx = link.target.x - link.source.x
        const dy = link.target.y - link.source.y
        const dist = Math.sqrt(dx * dx + dy * dy) || 1
        const idealDist = hasHubs ? 100 : 160
        const force = (dist - idealDist) * 0.003
        const fx = (dx / dist) * force
        const fy = (dy / dist) * force
        link.source.vx += fx
        link.source.vy += fy
        link.target.vx -= fx
        link.target.vy -= fy
      }

      // 5. Apply velocities with damping
      for (const n of nodes) {
        n.vx *= damping
        n.vy *= damping
        n.x += n.vx
        n.y += n.vy
      }
    }

    // Boundary clamping
    for (const n of nodes) {
      const pad = 50
      n.x = Math.max(pad, Math.min(vw - pad, n.x))
      n.y = Math.max(pad, Math.min(vh - pad, n.y))
    }

    // Re-center at SVG center
    let sumX = 0, sumY = 0
    for (const n of nodes) { sumX += n.x; sumY += n.y }
    const comX = sumX / nodes.length
    const comY = sumY / nodes.length
    const offsetX = width / 2 - comX
    const offsetY = height / 2 - comY
    for (const n of nodes) { n.x += offsetX; n.y += offsetY }

    const result = new Map<string, EntityPosition>()
    for (const n of nodes) {
      result.set(n.id, { x: n.x, y: n.y, radius: n.radius })
    }
    return result
  }, [entities, edges, width, height, anchorHubs])
}
