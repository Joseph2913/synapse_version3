import { useMemo } from 'react'
import type { ClusterData } from '../types/explore'

interface LayoutCluster extends ClusterData {
  position: { cx: number; cy: number; r: number }
}

// Deterministic pseudo-random based on index — same input always gives same output
function seededJitter(i: number, seed: number): number {
  const x = Math.sin(i * 127.1 + seed * 311.7) * 43758.5453
  return x - Math.floor(x) // 0–1
}

/**
 * Computes cluster bubble positions with prominence-based sizing and placement.
 * Fully deterministic — no Math.random() — so positions are stable across re-renders.
 */
export function useClusterLayout(
  clusters: ClusterData[],
  width: number,
  height: number
): LayoutCluster[] {
  return useMemo(() => {
    if (!clusters.length || width === 0 || height === 0) return []

    // ── Prominence scoring ────────────────────────────────────────────────
    const scores = clusters.map(c => {
      const connections = c.crossClusterEdges.reduce((sum, e) => sum + e.totalWeight, 0)
      return c.entityCount + c.subAnchorIds.length * 10 + connections * 2
    })
    const maxScore = Math.max(...scores, 1)
    const prominence = scores.map(s => s / maxScore)

    // ── Radius: prominent nodes are bigger ────────────────────────────────
    const minR = 5
    const maxR = Math.min(width, height) * 0.025
    function computeR(p: number) {
      return minR + p * (maxR - minR)
    }

    // ── Sort by prominence descending ─────────────────────────────────────
    const indexed = clusters.map((c, i) => ({
      cluster: c,
      prominence: prominence[i]!,
      r: computeR(prominence[i]!),
      origIdx: i,
    }))
    indexed.sort((a, b) => b.prominence - a.prominence)

    const cx = width / 2
    const cy = height / 2
    const maxDist = Math.min(width, height) * 0.42

    // ── Initial positions: prominent → centre, peripheral → outer ring ────
    const allNodes = indexed.map((item, i) => {
      const distFromCentre = (1 - item.prominence) * maxDist
      const angle = i * 2.39996322972865 // golden angle
      // Deterministic jitter so nodes don't stack on the exact spiral
      const jx = (seededJitter(item.origIdx, 1) - 0.5) * 30
      const jy = (seededJitter(item.origIdx, 2) - 0.5) * 30
      return {
        cluster: item.cluster,
        x: cx + Math.cos(angle) * distFromCentre + jx,
        y: cy + Math.sin(angle) * distFromCentre + jy,
        vx: 0,
        vy: 0,
        r: item.r,
        prominence: item.prominence,
      }
    })

    // ── Force simulation ──────────────────────────────────────────────────
    for (let tick = 0; tick < 250; tick++) {
      const damping = 0.78

      for (const n of allNodes) {
        // Gravity toward prominence-based home ring
        const homeR = (1 - n.prominence) * maxDist
        const angle = Math.atan2(n.y - cy, n.x - cx)
        const homeX = cx + Math.cos(angle) * homeR
        const homeY = cy + Math.sin(angle) * homeR
        n.vx += (homeX - n.x) * 0.0004
        n.vy += (homeY - n.y) * 0.0004

        // Gentle centering bias
        n.vx += (cx - n.x) * 0.0003
        n.vy += (cy - n.y) * 0.0003
      }

      // Repulsion between all pairs
      for (let i = 0; i < allNodes.length; i++) {
        for (let j = i + 1; j < allNodes.length; j++) {
          const a = allNodes[i]!
          const b = allNodes[j]!
          const dx = b.x - a.x
          const dy = b.y - a.y
          const dist = Math.sqrt(dx * dx + dy * dy) || 1
          const idealDist = Math.max(a.r + b.r + 40, 50)
          if (dist < idealDist) {
            const force = (idealDist - dist) * 0.04
            a.vx -= (dx / dist) * force
            a.vy -= (dy / dist) * force
            b.vx += (dx / dist) * force
            b.vy += (dy / dist) * force
          }
        }
      }

      for (const n of allNodes) {
        n.vx *= damping; n.vy *= damping
        n.x += n.vx; n.y += n.vy
      }
    }

    // Soft boundary clamp
    for (const n of allNodes) {
      const pad = n.r + 4
      if (n.x < pad) n.x = pad
      if (n.x > width - pad) n.x = width - pad
      if (n.y < pad) n.y = pad
      if (n.y > height - pad) n.y = height - pad
    }

    return allNodes.map(n => ({
      ...n.cluster,
      position: { cx: n.x, cy: n.y, r: n.r },
    }))
  }, [clusters, width, height])
}
