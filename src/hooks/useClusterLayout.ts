import { useMemo } from 'react'
import type { ClusterData } from '../types/explore'

interface LayoutCluster extends ClusterData {
  position: { cx: number; cy: number; r: number }
}

/**
 * Computes cluster bubble positions with maximum spacing.
 * ALL anchors (root and sub) participate in the same force simulation.
 * Sub-anchors start near their parent but are otherwise free to move.
 */
export function useClusterLayout(
  clusters: ClusterData[],
  width: number,
  height: number
): LayoutCluster[] {
  return useMemo(() => {
    if (!clusters.length || width === 0 || height === 0) return []

    const allMaxCount = Math.max(...clusters.map(c => c.entityCount), 1)
    const minR = 12
    const maxR = Math.min(width, height) * 0.04

    function computeR(entityCount: number) {
      return minR + Math.sqrt(entityCount / allMaxCount) * (maxR - minR)
    }

    // Separate roots and subs for initial positioning
    const rootClusters = clusters.filter(c => !c.anchor.isSubAnchor)
    const subClusters = clusters.filter(c => c.anchor.isSubAnchor)

    // Grid-based initial positions for root anchors
    const cols = Math.ceil(Math.sqrt(rootClusters.length * (width / height))) || 1
    const rows = Math.ceil(rootClusters.length / cols) || 1
    const cellW = width / (cols + 1)
    const cellH = height / (rows + 1)

    const rootNodes = rootClusters.map((c, i) => {
      const col = i % cols
      const row = Math.floor(i / cols)
      return {
        cluster: c,
        x: cellW * (col + 1) + (Math.random() - 0.5) * cellW * 0.3,
        y: cellH * (row + 1) + (Math.random() - 0.5) * cellH * 0.3,
        vx: 0,
        vy: 0,
        r: computeR(c.entityCount),
        parentId: null as string | null,
      }
    })

    // Sub-anchors start offset from their parent's initial position
    const rootPosMap = new Map(rootNodes.map(n => [n.cluster.anchor.id, { x: n.x, y: n.y }]))
    const subNodes = subClusters.map((c, i) => {
      const parentPos = rootPosMap.get(c.anchor.parentAnchorId!) ?? { x: width / 2, y: height / 2 }
      const angle = (i * 2.4) // golden angle spread
      const offset = 60 + Math.random() * 30
      return {
        cluster: c,
        x: parentPos.x + Math.cos(angle) * offset,
        y: parentPos.y + Math.sin(angle) * offset,
        vx: 0,
        vy: 0,
        r: computeR(c.entityCount),
        parentId: c.anchor.parentAnchorId ?? null,
      }
    })

    // All nodes in one simulation
    const allNodes = [...rootNodes, ...subNodes]

    for (let tick = 0; tick < 200; tick++) {
      const damping = 0.8

      for (const n of allNodes) {
        // Gentle centering for all
        n.vx += (width / 2 - n.x) * 0.001
        n.vy += (height / 2 - n.y) * 0.001

        // Sub-anchors: gentle gravity toward parent (not a rigid spring)
        if (n.parentId) {
          const parent = allNodes.find(p => p.cluster.anchor.id === n.parentId)
          if (parent) {
            n.vx += (parent.x - n.x) * 0.008
            n.vy += (parent.y - n.y) * 0.008
          }
        }
      }

      // Repulsion between all pairs
      for (let i = 0; i < allNodes.length; i++) {
        for (let j = i + 1; j < allNodes.length; j++) {
          const a = allNodes[i]!
          const b = allNodes[j]!
          const dx = b.x - a.x
          const dy = b.y - a.y
          const dist = Math.sqrt(dx * dx + dy * dy) || 1
          const idealDist = Math.max(a.r + b.r + 60, 90)
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

    // Boundary clamping
    for (const n of allNodes) {
      const pad = n.r + 20
      n.x = Math.max(pad, Math.min(width - pad, n.x))
      n.y = Math.max(pad, Math.min(height - pad, n.y))
    }

    return allNodes.map(n => ({
      ...n.cluster,
      position: { cx: n.x, cy: n.y, r: n.r },
    }))
  }, [clusters, width, height])
}
