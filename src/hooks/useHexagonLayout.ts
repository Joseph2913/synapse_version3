// src/hooks/useHexagonLayout.ts
// Positions anchor/skill hexagons in the white space between playlist clusters.

import { useMemo } from 'react'

interface ClusterCenter {
  id: string
  x: number
  y: number
  radius: number
}

interface HexNode {
  id: string
  connectedClusterIds: string[]  // playlist IDs this hex connects to
  kind: 'anchor' | 'skill'
  score: number                  // for sizing
}

export interface HexPosition {
  id: string
  x: number
  y: number
  radius: number                 // hex circumradius in px
  kind: 'anchor' | 'skill'
}

/** Generate a deterministic angle from a string ID (0 to 2*PI) */
function hashAngle(id: string): number {
  let hash = 0
  for (let i = 0; i < id.length; i++) {
    hash = ((hash << 5) - hash + id.charCodeAt(i)) | 0
  }
  return (Math.abs(hash) % 360) * (Math.PI / 180)
}

export function useHexagonLayout(
  hexNodes: HexNode[],
  clusterCenters: ClusterCenter[],
  canvasWidth: number,
  canvasHeight: number,
): HexPosition[] {
  return useMemo(() => {
    if (hexNodes.length === 0 || clusterCenters.length === 0) return []

    const clusterMap = new Map<string, ClusterCenter>()
    for (const c of clusterCenters) clusterMap.set(c.id, c)

    const positions: HexPosition[] = []

    for (const node of hexNodes) {
      // Find connected clusters that exist in the current graph
      const connected = node.connectedClusterIds
        .map(id => clusterMap.get(id))
        .filter((c): c is ClusterCenter => c !== undefined)

      if (connected.length === 0) continue

      // Hex radius based on kind and score (compact: 60% smaller)
      const hexRadius = node.kind === 'anchor'
        ? 5.5 + node.score * 2.5   // 5.5-8px
        : 5 + node.score * 1.5     // 5-6.5px

      let x: number
      let y: number

      if (connected.length === 1) {
        // Single cluster: place just outside its boundary
        const c = connected[0]!
        const angle = hashAngle(node.id)
        const dist = c.radius + 30 + hexRadius
        x = c.x + Math.cos(angle) * dist
        y = c.y + Math.sin(angle) * dist
      } else {
        // Multiple clusters: centroid of connected cluster centers
        x = connected.reduce((sum, c) => sum + c.x, 0) / connected.length
        y = connected.reduce((sum, c) => sum + c.y, 0) / connected.length
      }

      positions.push({ id: node.id, x, y, radius: hexRadius, kind: node.kind })
    }

    // Steps 2 & 3: Iterative push outside cluster boundaries + hex-hex repulsion
    // Run multiple passes so fixing one overlap doesn't push into another cluster
    const MIN_SEP = 20
    const CLUSTER_PAD = 15 // extra padding beyond cluster radius

    for (let iter = 0; iter < 20; iter++) {
      // Push outside ALL cluster boundaries
      for (const pos of positions) {
        for (const cluster of clusterCenters) {
          const dx = pos.x - cluster.x
          const dy = pos.y - cluster.y
          const dist = Math.sqrt(dx * dx + dy * dy)
          const minDist = cluster.radius + pos.radius + CLUSTER_PAD

          if (dist < minDist) {
            if (dist < 0.1) {
              // Dead center — push in a deterministic direction
              const angle = hashAngle(pos.id + cluster.id)
              pos.x = cluster.x + Math.cos(angle) * minDist
              pos.y = cluster.y + Math.sin(angle) * minDist
            } else {
              const push = (minDist - dist) / dist
              pos.x += dx * push
              pos.y += dy * push
            }
          }
        }
      }

      // Hex-hex repulsion
      for (let i = 0; i < positions.length; i++) {
        for (let j = i + 1; j < positions.length; j++) {
          const a = positions[i]!
          const b = positions[j]!
          const dx = b.x - a.x
          const dy = b.y - a.y
          const dist = Math.sqrt(dx * dx + dy * dy)

          if (dist < MIN_SEP && dist > 0) {
            const push = ((MIN_SEP - dist) / dist) * 0.5
            a.x -= dx * push
            a.y -= dy * push
            b.x += dx * push
            b.y += dy * push
          }
        }
      }
    }

    // Step 4: Boundary containment (soft push)
    const PAD = 50
    for (const pos of positions) {
      if (canvasWidth > 0 && canvasHeight > 0) {
        const maxExtent = Math.max(canvasWidth, canvasHeight) * 1.5
        if (pos.x < -maxExtent) pos.x = -maxExtent + PAD
        if (pos.x > maxExtent) pos.x = maxExtent - PAD
        if (pos.y < -maxExtent) pos.y = -maxExtent + PAD
        if (pos.y > maxExtent) pos.y = maxExtent - PAD
      }
    }

    return positions
  }, [hexNodes, clusterCenters, canvasWidth, canvasHeight])
}
