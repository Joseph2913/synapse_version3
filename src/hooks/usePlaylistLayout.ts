import { useMemo } from 'react'
import type { PlaylistNode, PlaylistEdge } from '../types/explore'

export interface PlaylistPosition {
  x: number
  y: number
  radius: number
}

/** Playlist node radius — scaled by video count */
export function playlistRadius(videoCount: number, maxVideoCount: number = 30): number {
  if (videoCount <= 0) return 16
  const minR = 16
  const maxR = 48
  return minR + Math.sqrt(videoCount / Math.max(maxVideoCount, 1)) * (maxR - minR)
}

/**
 * Force-directed layout for playlists.
 *
 * 1. Place playlists in a circle (initial positions).
 * 2. Run repulsion + edge-attraction simulation to cluster
 *    connected playlists together.
 */
export function usePlaylistLayout(
  playlists: PlaylistNode[],
  edges: PlaylistEdge[],
  width: number,
  height: number,
): Map<string, PlaylistPosition> {
  return useMemo(() => {
    if (!playlists.length || width === 0 || height === 0) return new Map()

    const cx = width / 2
    const cy = height / 2
    const maxVideoCount = Math.max(...playlists.map(p => p.videoCount), 1)

    // Build edge lookup
    const edgeMap = new Map<string, { targetId: string; weight: number }[]>()
    const maxWeight = Math.max(...edges.map(e => e.connectionCount), 1)
    for (const e of edges) {
      if (!edgeMap.has(e.fromPlaylistId)) edgeMap.set(e.fromPlaylistId, [])
      if (!edgeMap.has(e.toPlaylistId)) edgeMap.set(e.toPlaylistId, [])
      const w = e.connectionCount / maxWeight
      edgeMap.get(e.fromPlaylistId)!.push({ targetId: e.toPlaylistId, weight: w })
      edgeMap.get(e.toPlaylistId)!.push({ targetId: e.fromPlaylistId, weight: w })
    }

    // Initial placement: circle
    interface SimNode { id: string; x: number; y: number; r: number }
    const spreadR = Math.min(width, height) * 0.3
    const nodes: SimNode[] = playlists.map((p, i) => {
      const angle = (i / playlists.length) * Math.PI * 2 - Math.PI / 2
      return {
        id: p.id,
        x: cx + Math.cos(angle) * spreadR + (Math.random() - 0.5) * 15,
        y: cy + Math.sin(angle) * spreadR + (Math.random() - 0.5) * 15,
        r: playlistRadius(p.videoCount, maxVideoCount),
      }
    })

    const nodeIndex = new Map(nodes.map((n, i) => [n.id, i]))

    // Force simulation: 80 ticks
    for (let tick = 0; tick < 80; tick++) {
      const alpha = 1 - tick / 80

      // Repulsion
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i]!
          const b = nodes[j]!
          const dx = b.x - a.x
          const dy = b.y - a.y
          const dist = Math.sqrt(dx * dx + dy * dy) || 0.1
          const minDist = a.r + b.r + 20
          const repulsion = Math.max(0, (minDist * 3 - dist)) * 0.12 * alpha

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
          const idealDist = a.r + b.r + 50
          if (dist > idealDist) {
            const pull = (dist - idealDist) * 0.025 * weight * alpha
            const nx = dx / dist
            const ny = dy / dist
            a.x += nx * pull
            a.y += ny * pull
            b.x -= nx * pull
            b.y -= ny * pull
          }
        }
      }

      // Center gravity
      for (const n of nodes) {
        n.x += (cx - n.x) * 0.015 * alpha
        n.y += (cy - n.y) * 0.015 * alpha
      }

      // Boundary containment
      const pad = 40
      for (const n of nodes) {
        n.x = Math.max(pad + n.r, Math.min(width - pad - n.r, n.x))
        n.y = Math.max(pad + n.r, Math.min(height - pad - n.r, n.y))
      }
    }

    const result = new Map<string, PlaylistPosition>()
    for (const n of nodes) {
      result.set(n.id, { x: n.x, y: n.y, radius: n.r })
    }
    return result
  }, [playlists, edges, width, height])
}
