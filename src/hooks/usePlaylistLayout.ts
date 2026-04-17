import { useMemo } from 'react'
import type { PlaylistNode, PlaylistEdge } from '../types/explore'

export interface PlaylistPosition {
  x: number
  y: number
  radius: number
}

/** Playlist cluster radius — estimates the space videos will occupy around center.
 *  Must match ringGap=20, spacing=18, centerR from PlaylistGraphView. */
export function playlistRadius(videoCount: number, _maxVideoCount: number = 30): number {
  if (videoCount <= 0) return 30
  const centerR = 12 + Math.min(videoCount * 0.4, 12)
  let placed = 0
  let rings = 0
  while (placed < videoCount) {
    rings++
    const ringR = centerR + 8 + rings * 20
    const circumference = 2 * Math.PI * ringR
    placed += Math.max(1, Math.floor(circumference / 18))
  }
  return centerR + 8 + rings * 20 + 18
}

/**
 * Center-weighted layout: top ~25% playlists (by video count) placed in the center,
 * remaining playlists distributed around the perimeter. Force refinement prevents overlap.
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

    // Sort by video count descending to identify top playlists
    const sorted = [...playlists].sort((a, b) => b.videoCount - a.videoCount)

    // Top 25% go in the center zone, rest go on the perimeter
    const centerCount = Math.max(1, Math.min(
      Math.ceil(sorted.length * 0.25),
      sorted.length - 1
    ))
    const centerPlaylists = sorted.slice(0, centerCount)
    const perimeterSorted = sorted.slice(centerCount)

    // Interleave perimeter playlists: alternate large/small so connections
    // are distributed evenly around the oval instead of clustering in one area.
    // Split into two halves, then weave them together.
    const half = Math.ceil(perimeterSorted.length / 2)
    const topHalf = perimeterSorted.slice(0, half)   // larger playlists
    const bottomHalf = perimeterSorted.slice(half)    // smaller playlists
    const perimeterPlaylists: PlaylistNode[] = []
    for (let i = 0; i < Math.max(topHalf.length, bottomHalf.length); i++) {
      if (i < topHalf.length) perimeterPlaylists.push(topHalf[i]!)
      if (i < bottomHalf.length) perimeterPlaylists.push(bottomHalf[i]!)
    }

    // Perimeter ellipse
    const ellipseRx = width * 0.42
    const ellipseRy = height * 0.4

    // Center zone — large interior so center playlists spread out well
    const centerRx = ellipseRx * 0.65
    const centerRy = ellipseRy * 0.65

    interface SimNode { id: string; x: number; y: number; r: number; isCenter: boolean }
    const nodes: SimNode[] = []

    // Place center playlists using golden angle spiral
    const goldenAngle = Math.PI * (3 - Math.sqrt(5))
    if (centerPlaylists.length === 1) {
      const p = centerPlaylists[0]!
      nodes.push({ id: p.id, x: cx, y: cy, r: playlistRadius(p.videoCount), isCenter: true })
    } else {
      centerPlaylists.forEach((p, i) => {
        const t = (i + 0.5) / centerPlaylists.length
        const spiralR = Math.sqrt(t)
        const angle = i * goldenAngle
        const r = playlistRadius(p.videoCount)
        nodes.push({
          id: p.id,
          x: cx + Math.cos(angle) * spiralR * centerRx,
          y: cy + Math.sin(angle) * spiralR * centerRy,
          r,
          isCenter: true,
        })
      })
    }

    // Place interleaved perimeter playlists evenly around the outer ellipse
    perimeterPlaylists.forEach((p, i) => {
      const angle = (i / perimeterPlaylists.length) * Math.PI * 2 - Math.PI / 2
      const r = playlistRadius(p.videoCount)
      nodes.push({
        id: p.id,
        x: cx + Math.cos(angle) * ellipseRx,
        y: cy + Math.sin(angle) * ellipseRy,
        r,
        isCenter: false,
      })
    })

    // Force refinement
    for (let tick = 0; tick < 80; tick++) {
      const alpha = 1 - tick / 80

      // Repulsion — all pairs, strong enough to spread center playlists apart
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i]!
          const b = nodes[j]!
          const dx = b.x - a.x
          const dy = b.y - a.y
          const dist = Math.sqrt(dx * dx + dy * dy) || 0.1
          const minDist = (a.r + b.r) * 1.25
          const repulsion = Math.max(0, (minDist - dist)) * 0.28 * alpha

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

      // Containment
      for (const n of nodes) {
        if (n.isCenter) {
          // Keep center nodes inside the inner ellipse
          const ndx = (n.x - cx) / centerRx
          const ndy = (n.y - cy) / centerRy
          const d = ndx * ndx + ndy * ndy
          if (d > 1) {
            const scale = 1 / Math.sqrt(d) * 0.95
            n.x = cx + (n.x - cx) * scale
            n.y = cy + (n.y - cy) * scale
          }
          // Very gentle center gravity
          n.x += (cx - n.x) * 0.003 * alpha
          n.y += (cy - n.y) * 0.003 * alpha
        } else {
          // Perimeter nodes: anchor to their ellipse slot
          const idx = perimeterPlaylists.findIndex(p => p.id === n.id)
          if (idx >= 0) {
            const angle = (idx / perimeterPlaylists.length) * Math.PI * 2 - Math.PI / 2
            const targetX = cx + Math.cos(angle) * ellipseRx
            const targetY = cy + Math.sin(angle) * ellipseRy
            n.x += (targetX - n.x) * 0.04 * alpha
            n.y += (targetY - n.y) * 0.04 * alpha
          }
        }
      }
    }

    const result = new Map<string, PlaylistPosition>()
    for (const n of nodes) {
      result.set(n.id, { x: n.x, y: n.y, radius: n.r })
    }
    return result
  }, [playlists, edges, width, height])
}
