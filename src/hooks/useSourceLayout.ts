import { useMemo } from 'react'
import type { SourceNode, SourceEdge, SourceGraphAnchor } from '../types/explore'

export interface SourcePosition {
  x: number
  y: number
  radius: number
}

/** Source dot radius — standardized to match entity/anchor sizing */
export function dotRadius(entityCount: number, maxEntityCount: number = 50): number {
  if (entityCount <= 0) return 6
  const minR = 6
  const maxR = 18
  return minR + Math.sqrt(entityCount / Math.max(maxEntityCount, 1)) * (maxR - minR)
}

export const ANCHOR_RADIUS = 10

/**
 * Territory-based layout:
 *
 * 1. Classify each source as "primary" (connected to exactly 1 anchor) or
 *    "secondary" (connected to 0 or 2+ anchors).
 * 2. Compute each anchor's cluster size (# of primary sources).
 * 3. Place anchors on a circle, spaced proportionally to cluster size so
 *    larger clusters get more room.
 * 4. Place primary sources in a tight ring around their anchor (the "territory").
 * 5. Place secondary sources outside the territories, pulled gently toward
 *    their connected anchors.
 * 6. Run a short repulsion-only sim to resolve overlaps without collapsing structure.
 */
export function useSourceLayout(
  sources: SourceNode[],
  edges: SourceEdge[],
  width: number,
  height: number,
  anchors: SourceGraphAnchor[] = [],
): Map<string, SourcePosition> {
  return useMemo(() => {
    if ((!sources.length && !anchors.length) || width === 0 || height === 0) return new Map()

    const cx = width / 2
    const cy = height / 2
    const result = new Map<string, SourcePosition>()
    const maxEntityCount = Math.max(...sources.map(s => s.entityCount), 1)

    // ── Step 1: Classify sources ─────────────────────────────────────────────
    // For each source, find which anchors it connects to
    const sourceAnchorMap = new Map<string, string[]>() // sourceId → anchorIds
    for (const s of sources) {
      const connected: string[] = []
      for (const a of anchors) {
        if (a.connectedSourceIds.includes(s.id)) connected.push(a.id)
      }
      sourceAnchorMap.set(s.id, connected)
    }

    // Primary = connected to exactly 1 anchor. Secondary = 0 or 2+
    const primaryByAnchor = new Map<string, SourceNode[]>() // anchorId → sources
    const secondarySources: SourceNode[] = []

    for (const a of anchors) primaryByAnchor.set(a.id, [])

    for (const s of sources) {
      const anchorIds = sourceAnchorMap.get(s.id) ?? []
      if (anchorIds.length === 1) {
        primaryByAnchor.get(anchorIds[0]!)!.push(s)
      } else {
        secondarySources.push(s)
      }
    }

    // ── Step 2: Compute cluster sizes and anchor ring ────────────────────────
    const anchorCount = anchors.length
    if (anchorCount === 0) {
      // No anchors — just spread sources evenly
      const cols = Math.ceil(Math.sqrt(sources.length * (width / height)))
      const rows = Math.ceil(sources.length / cols)
      const spacingX = width / (cols + 1)
      const spacingY = height / (rows + 1)
      sources.forEach((s, i) => {
        const col = i % cols
        const row = Math.floor(i / cols)
        result.set(s.id, {
          x: spacingX * (col + 1) + (Math.random() - 0.5) * 10,
          y: spacingY * (row + 1) + (Math.random() - 0.5) * 10,
          radius: dotRadius(s.entityCount, maxEntityCount),
        })
      })
      return result
    }

    // Cluster radius = proportional to sqrt of primary source count
    const clusterSizes = anchors.map(a => (primaryByAnchor.get(a.id) ?? []).length)
    const maxClusterSize = Math.max(...clusterSizes, 1)

    // Each cluster gets a territory radius — tighter spacing
    const minTerritoryR = 25
    const maxTerritoryR = Math.min(width, height) * 0.10
    const territoryRadii = clusterSizes.map(size =>
      minTerritoryR + Math.sqrt(size / maxClusterSize) * (maxTerritoryR - minTerritoryR)
    )

    // Place anchors on an ellipse — tighter to center for better clustering
    const pad = 80
    const ellipseRx = (width / 2) - pad
    const ellipseRy = (height / 2) - pad

    // ── Step 3: Place anchors on the ellipse ─────────────────────────────────
    // Cumulative angle placement so larger clusters get more arc space
    const totalWeight = territoryRadii.reduce((s, r) => s + r, 0) || 1
    let cumulativeAngle = -Math.PI / 2

    const anchorPositions = new Map<string, { x: number; y: number; territoryR: number }>()

    for (let i = 0; i < anchorCount; i++) {
      const a = anchors[i]!
      const tr = territoryRadii[i]!
      const arcShare = (tr / totalWeight) * Math.PI * 2
      const angle = cumulativeAngle + arcShare / 2
      cumulativeAngle += arcShare

      // Tighter ellipse — 0.55 instead of 0.7 to bring anchors closer together
      const ax = cx + Math.cos(angle) * ellipseRx * 0.55
      const ay = cy + Math.sin(angle) * ellipseRy * 0.55

      anchorPositions.set(a.id, { x: ax, y: ay, territoryR: tr })
      result.set(a.id, { x: ax, y: ay, radius: ANCHOR_RADIUS })
    }

    // ── Step 4: Place primary sources in territory rings (tighter) ───────────
    for (const a of anchors) {
      const pos = anchorPositions.get(a.id)!
      const primaries = primaryByAnchor.get(a.id) ?? []
      if (primaries.length === 0) continue

      // Golden-angle spiral within the territory — tighter starting distance
      for (let i = 0; i < primaries.length; i++) {
        const s = primaries[i]!
        const angle = i * 2.399963 // golden angle
        const t = (i + 1) / (primaries.length + 1)
        const dist = 10 + t * (pos.territoryR - 10)

        result.set(s.id, {
          x: pos.x + Math.cos(angle) * dist,
          y: pos.y + Math.sin(angle) * dist,
          radius: dotRadius(s.entityCount, maxEntityCount),
        })
      }
    }

    // ── Step 5: Place secondary sources between territories ──────────────────
    for (const s of secondarySources) {
      const anchorIds = sourceAnchorMap.get(s.id) ?? []

      if (anchorIds.length === 0) {
        // Unconnected: place in outer ring but not too far
        const angle = Math.random() * Math.PI * 2
        result.set(s.id, {
          x: cx + Math.cos(angle) * ellipseRx * 0.7 + (Math.random() - 0.5) * 20,
          y: cy + Math.sin(angle) * ellipseRy * 0.7 + (Math.random() - 0.5) * 20,
          radius: dotRadius(s.entityCount, maxEntityCount),
        })
      } else {
        // Multi-anchor: place at the midpoint of connected anchors
        let avgX = 0, avgY = 0
        for (const aid of anchorIds) {
          const apos = anchorPositions.get(aid)
          if (apos) { avgX += apos.x; avgY += apos.y }
        }
        avgX /= anchorIds.length
        avgY /= anchorIds.length

        // Slight push outward from center so it sits between clusters
        const dxFromCenter = avgX - cx
        const dyFromCenter = avgY - cy
        const distFromCenter = Math.sqrt(dxFromCenter * dxFromCenter + dyFromCenter * dyFromCenter) || 1
        const pushOut = 15 + Math.random() * 10

        result.set(s.id, {
          x: avgX + (dxFromCenter / distFromCenter) * pushOut + (Math.random() - 0.5) * 10,
          y: avgY + (dyFromCenter / distFromCenter) * pushOut + (Math.random() - 0.5) * 10,
          radius: dotRadius(s.entityCount, maxEntityCount),
        })
      }
    }

    // ── Step 6: Overlap resolution (repulsion only, no attraction) ───────────
    // Short sim that pushes overlapping nodes apart without collapsing clusters
    interface SimpleNode { id: string; x: number; y: number; r: number; isAnchor: boolean }
    const simNodes: SimpleNode[] = Array.from(result.entries()).map(([id, pos]) => ({
      id, x: pos.x, y: pos.y, r: pos.radius, isAnchor: anchors.some(a => a.id === id),
    }))

    for (let tick = 0; tick < 80; tick++) {
      for (let i = 0; i < simNodes.length; i++) {
        for (let j = i + 1; j < simNodes.length; j++) {
          const a = simNodes[i]!
          const b = simNodes[j]!
          const dx = b.x - a.x
          const dy = b.y - a.y
          const dist = Math.sqrt(dx * dx + dy * dy) || 0.1
          const minDist = a.r + b.r + 4

          if (dist < minDist) {
            const push = (minDist - dist) * 0.3
            const nx = dx / dist
            const ny = dy / dist
            // Anchors are immovable during overlap resolution
            if (a.isAnchor && !b.isAnchor) {
              b.x += nx * push; b.y += ny * push
            } else if (b.isAnchor && !a.isAnchor) {
              a.x -= nx * push; a.y -= ny * push
            } else if (!a.isAnchor && !b.isAnchor) {
              a.x -= nx * push * 0.5; a.y -= ny * push * 0.5
              b.x += nx * push * 0.5; b.y += ny * push * 0.5
            }
            // anchor-anchor: both stay (they were placed deliberately)
          }
        }
      }
    }

    // Write resolved positions back
    for (const n of simNodes) {
      const existing = result.get(n.id)!
      result.set(n.id, { ...existing, x: n.x, y: n.y })
    }

    return result
  }, [sources, edges, width, height, anchors])
}
