import { useMemo } from 'react'
import type { SourceNode, SourceEdge } from '../types/explore'

export interface SourcePosition {
  x: number
  y: number
  radius: number
}

/** Source dot radius — standardized to match entity sizing */
export function dotRadius(entityCount: number, maxEntityCount: number = 50): number {
  if (entityCount <= 0) return 6
  const minR = 6
  const maxR = 18
  return minR + Math.sqrt(entityCount / Math.max(maxEntityCount, 1)) * (maxR - minR)
}

/**
 * Force-directed layout for sources only (no anchors).
 *
 * 1. Place sources in a circle (initial positions).
 * 2. Run a short repulsion + edge-attraction simulation to cluster
 *    connected sources together while keeping everything readable.
 */
export function useSourceLayout(
  sources: SourceNode[],
  edges: SourceEdge[],
  width: number,
  height: number,
): Map<string, SourcePosition> {
  return useMemo(() => {
    if (!sources.length || width === 0 || height === 0) return new Map()

    const cx = width / 2
    const cy = height / 2
    const maxEntityCount = Math.max(...sources.map(s => s.entityCount), 1)

    // Build edge lookup for attraction
    const edgeMap = new Map<string, { targetId: string; weight: number }[]>()
    const maxWeight = Math.max(...edges.map(e => e.totalWeight), 1)
    for (const e of edges) {
      if (!edgeMap.has(e.fromSourceId)) edgeMap.set(e.fromSourceId, [])
      if (!edgeMap.has(e.toSourceId)) edgeMap.set(e.toSourceId, [])
      const w = e.totalWeight / maxWeight
      edgeMap.get(e.fromSourceId)!.push({ targetId: e.toSourceId, weight: w })
      edgeMap.get(e.toSourceId)!.push({ targetId: e.fromSourceId, weight: w })
    }

    // Initial placement: circle
    interface SimNode { id: string; x: number; y: number; r: number }
    const spreadR = Math.min(width, height) * 0.35
    const nodes: SimNode[] = sources.map((s, i) => {
      const angle = (i / sources.length) * Math.PI * 2 - Math.PI / 2
      return {
        id: s.id,
        x: cx + Math.cos(angle) * spreadR + (Math.random() - 0.5) * 20,
        y: cy + Math.sin(angle) * spreadR + (Math.random() - 0.5) * 20,
        r: dotRadius(s.entityCount, maxEntityCount),
      }
    })

    const nodeIndex = new Map(nodes.map((n, i) => [n.id, i]))

    // Force simulation: 60 ticks
    for (let tick = 0; tick < 60; tick++) {
      const alpha = 1 - tick / 60 // cooling

      // Repulsion (all pairs)
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i]!
          const b = nodes[j]!
          const dx = b.x - a.x
          const dy = b.y - a.y
          const dist = Math.sqrt(dx * dx + dy * dy) || 0.1
          const minDist = a.r + b.r + 8
          const repulsion = Math.max(0, (minDist * 2.5 - dist)) * 0.15 * alpha

          if (repulsion > 0) {
            const nx = dx / dist
            const ny = dy / dist
            a.x -= nx * repulsion
            a.y -= ny * repulsion
            b.x += nx * repulsion
            b.y += ny * repulsion
          }
        }
      }

      // Attraction (connected pairs)
      for (const [srcId, targets] of edgeMap) {
        const ai = nodeIndex.get(srcId)
        if (ai === undefined) continue
        const a = nodes[ai]!
        for (const { targetId, weight } of targets) {
          const bi = nodeIndex.get(targetId)
          if (bi === undefined) continue
          const b = nodes[bi]!
          const dx = b.x - a.x
          const dy = b.y - a.y
          const dist = Math.sqrt(dx * dx + dy * dy) || 0.1
          const idealDist = a.r + b.r + 30
          if (dist > idealDist) {
            const pull = (dist - idealDist) * 0.02 * weight * alpha
            const nx = dx / dist
            const ny = dy / dist
            a.x += nx * pull
            a.y += ny * pull
            b.x -= nx * pull
            b.y -= ny * pull
          }
        }
      }

      // Center gravity — gentle pull toward center
      for (const n of nodes) {
        n.x += (cx - n.x) * 0.01 * alpha
        n.y += (cy - n.y) * 0.01 * alpha
      }

      // Boundary containment
      const pad = 30
      for (const n of nodes) {
        n.x = Math.max(pad + n.r, Math.min(width - pad - n.r, n.x))
        n.y = Math.max(pad + n.r, Math.min(height - pad - n.r, n.y))
      }
    }

    const result = new Map<string, SourcePosition>()
    for (const n of nodes) {
      result.set(n.id, { x: n.x, y: n.y, radius: n.r })
    }
    return result
  }, [sources, edges, width, height])
}
