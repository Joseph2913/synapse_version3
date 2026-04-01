import { useRef, useEffect } from 'react'
import type {
  GraphLevel,
  SimulationNode,
  SimulationEdge,
  AnchorLevelData,
  AllSourcesLevelData,
  SourceLevelData,
  EntityLevelData,
} from '../types/graph'
import { FORCE_PARAMS as PARAMS } from '../types/graph'
import type { LevelData } from './useGraphData'

const GOLDEN_ANGLE = 2.39996322972865

// ─── Radius computation per level ────────────────────────────────────────────

function anchorRadius(entityCount: number): number {
  return 20 + Math.sqrt(entityCount) * 1.5
}

function sourceRadius(_entityCount: number): number {
  return 4
}

function entityRadius(isBridge: boolean): number {
  return isBridge ? 16 : 12
}

// ─── Build simulation nodes from level data ──────────────────────────────────

function buildAnchorNodes(data: AnchorLevelData, cw: number, ch: number): SimulationNode[] {
  return data.anchors.map((a, i) => {
    const angle = i * GOLDEN_ANGLE
    const r = anchorRadius(a.entityCount)
    return {
      id: a.id,
      kind: 'anchor' as const,
      x: cw * 0.5 + Math.cos(angle) * cw * 0.3,
      y: ch * 0.5 + Math.sin(angle) * ch * 0.3,
      vx: 0, vy: 0,
      radius: r,
      label: a.label,
      color: a.color,
      entityType: a.entityType,
      entityCount: a.entityCount,
      sourceCount: a.sourceCount,
      connectionCount: a.connectionCount,
      anchorStatus: a.anchorStatus,
      isQuiet: a.isQuiet,
      description: a.description,
      confidence: a.confidence,
      lastActivity: a.lastActivity,
    }
  })
}

function buildAllSourceNodes(data: AllSourcesLevelData, cw: number, ch: number): SimulationNode[] {
  const cx = cw * 0.5
  const cy = ch * 0.5
  const gravityAnchors = data.gravityAnchors ?? []
  const anchorCount = gravityAnchors.length
  console.log('[GraphSim] buildAllSourceNodes: gravityAnchors count =', anchorCount, gravityAnchors.map(a => a.label))

  // Build anchor position map for initial source placement
  const anchorPositions = new Map<string, { x: number; y: number }>()
  const anchorRadius_val = Math.min(cw, ch) * 0.35

  // Place gravity anchor nodes evenly around a circle
  const anchorNodes: SimulationNode[] = gravityAnchors.map((a, i) => {
    const angle = (i / Math.max(anchorCount, 1)) * Math.PI * 2 - Math.PI / 2
    const ax = cx + Math.cos(angle) * anchorRadius_val
    const ay = cy + Math.sin(angle) * anchorRadius_val
    anchorPositions.set(a.id, { x: ax, y: ay })
    return {
      id: a.id,
      kind: 'anchor' as const,
      x: ax,
      y: ay,
      vx: 0, vy: 0,
      radius: 16,
      label: a.label,
      color: a.color,
      entityType: a.entityType,
      connectionCount: a.connectionCount,
      fixed: true,
    }
  })

  // Place source nodes — biased toward their anchor(s) or in outer spiral
  const sourceNodes: SimulationNode[] = data.sources.map((s, i) => {
    const r = sourceRadius(s.entityCount)
    const links = s.anchorLinks ?? []
    let x: number, y: number

    if (links.length > 0 && anchorCount > 0) {
      // Weighted centroid of connected anchors
      let wx = 0, wy = 0, totalWeight = 0
      for (const link of links) {
        const pos = anchorPositions.get(link.anchorId)
        if (!pos) continue
        wx += pos.x * link.strength
        wy += pos.y * link.strength
        totalWeight += link.strength
      }
      if (totalWeight > 0) {
        // Place near centroid with jitter to avoid stacking
        const jitterAngle = i * GOLDEN_ANGLE
        const jitterDist = 30 + Math.random() * 60
        x = wx / totalWeight + Math.cos(jitterAngle) * jitterDist
        y = wy / totalWeight + Math.sin(jitterAngle) * jitterDist
      } else {
        // Fallback: spiral
        const angle = i * GOLDEN_ANGLE
        const spread = 0.15 + (i / Math.max(data.sources.length, 1)) * 0.3
        x = cx + Math.cos(angle) * cw * spread
        y = cy + Math.sin(angle) * ch * spread
      }
    } else {
      // Unclustered sources: place in outer ring
      const angle = i * GOLDEN_ANGLE
      const outerDist = anchorRadius_val * 1.3 + Math.random() * 40
      x = cx + Math.cos(angle) * outerDist
      y = cy + Math.sin(angle) * outerDist
    }

    return {
      id: s.id,
      kind: 'source' as const,
      x, y,
      vx: 0, vy: 0,
      radius: r,
      label: s.label,
      color: s.color,
      sourceType: s.sourceType,
      icon: s.icon,
      entityCount: s.entityCount,
      anchorRelevance: s.anchorRelevance,
      typeDistribution: s.typeDistribution,
      bridgeAnchorIds: s.bridgeAnchorIds,
      anchorLinks: links,
      createdAt: s.createdAt,
      metadata: s.metadata,
    }
  })

  return [...anchorNodes, ...sourceNodes]
}

function buildSourceNodes(data: SourceLevelData, cw: number, ch: number): SimulationNode[] {
  const main: SimulationNode[] = data.sources.map((s, i) => {
    const angle = i * GOLDEN_ANGLE
    const r = sourceRadius(s.entityCount)
    return {
      id: s.id,
      kind: 'source' as const,
      x: cw * 0.5 + Math.cos(angle) * cw * 0.38,
      y: ch * 0.5 + Math.sin(angle) * ch * 0.35,
      vx: 0, vy: 0,
      radius: r,
      label: s.label,
      color: s.color,
      sourceType: s.sourceType,
      icon: s.icon,
      entityCount: s.entityCount,
      anchorRelevance: s.anchorRelevance,
      typeDistribution: s.typeDistribution,
      bridgeAnchorIds: s.bridgeAnchorIds,
      createdAt: s.createdAt,
      metadata: s.metadata,
    }
  })

  // Ghost anchors at periphery
  const ghosts: SimulationNode[] = data.ghostAnchors.map((g, i) => {
    const angle = i * GOLDEN_ANGLE + Math.PI
    return {
      id: g.id,
      kind: 'ghost_anchor' as const,
      x: cw * 0.5 + Math.cos(angle) * cw * 0.42,
      y: ch * 0.5 + Math.sin(angle) * ch * 0.38,
      vx: 0, vy: 0,
      radius: 18,
      label: g.label,
      color: g.color,
      entityType: g.entityType,
      contributingSourceIds: g.contributingSourceIds,
    }
  })

  return [...main, ...ghosts]
}

function buildEntityNodes(data: EntityLevelData, cw: number, ch: number): SimulationNode[] {
  const main: SimulationNode[] = data.entities.map((e, i) => {
    const angle = i * GOLDEN_ANGLE
    const r = entityRadius(e.isBridge)
    return {
      id: e.id,
      kind: 'entity' as const,
      x: cw * 0.5 + Math.cos(angle) * cw * 0.2,
      y: ch * 0.5 + Math.sin(angle) * ch * 0.2,
      vx: 0, vy: 0,
      radius: r,
      label: e.label,
      color: e.color,
      entityType: e.entityType,
      isBridge: e.isBridge,
      sourceCount: e.sourceCount,
      confidence: e.confidence,
      description: e.description,
    }
  })

  // Ghost sources at periphery
  const ghosts: SimulationNode[] = data.ghostSources.map((g, i) => {
    const angle = i * GOLDEN_ANGLE + Math.PI * 0.7
    return {
      id: g.id,
      kind: 'ghost_source' as const,
      x: cw * 0.5 + Math.cos(angle) * cw * 0.4,
      y: ch * 0.5 + Math.sin(angle) * ch * 0.35,
      vx: 0, vy: 0,
      radius: 14,
      label: g.label,
      color: g.color,
      sourceType: g.sourceType,
      icon: g.icon,
    }
  })

  return [...main, ...ghosts]
}

// ─── Build simulation edges ──────────────────────────────────────────────────

function buildEdges(levelData: LevelData): SimulationEdge[] {
  if (levelData.level === 'anchors') {
    return levelData.data.edges.map(e => ({
      fromId: e.fromAnchorId,
      toId: e.toAnchorId,
      weight: e.strength,
      kind: 'anchor' as const,
      bridgeEntityCount: e.bridgeEntityCount,
      sharedSourceCount: e.sharedSourceCount,
    }))
  }

  if (levelData.level === 'all_sources') {
    return levelData.data.edges.map(e => ({
      fromId: e.fromSourceId,
      toId: e.toSourceId,
      weight: e.strength,
      kind: 'source' as const,
      sharedEntityCount: e.sharedEntityCount,
    }))
  }

  if (levelData.level === 'sources') {
    const sourceEdges: SimulationEdge[] = levelData.data.edges.map(e => ({
      fromId: e.fromSourceId,
      toId: e.toSourceId,
      weight: e.strength,
      kind: 'source' as const,
      sharedEntityCount: e.sharedEntityCount,
    }))
    const ghostEdges: SimulationEdge[] = levelData.data.ghostEdges.map(e => ({
      fromId: e.sourceId,
      toId: e.anchorId,
      weight: 0.3,
      kind: 'ghost' as const,
    }))
    return [...sourceEdges, ...ghostEdges]
  }

  // entities level
  const intra: SimulationEdge[] = levelData.data.intraEdges.map(e => ({
    fromId: e.fromEntityId,
    toId: e.toEntityId,
    weight: e.weight / 5, // normalize
    kind: 'intra' as const,
    relationType: e.relationType,
    evidence: e.evidence,
  }))
  const cross: SimulationEdge[] = levelData.data.crossEdges.map(e => ({
    fromId: e.entityId,
    toId: e.ghostSourceId,
    weight: 0.3,
    kind: 'cross' as const,
  }))
  return [...intra, ...cross]
}

// ─── Hook ────────────────────────────────────────────────────────────────────

export function useGraphSimulation(
  levelData: LevelData | null,
  canvasWidth: number,
  canvasHeight: number
): {
  nodesRef: React.MutableRefObject<SimulationNode[]>
  edgesRef: React.MutableRefObject<SimulationEdge[]>
  tick: () => void
  resetPositions: () => void
} {
  const nodesRef = useRef<SimulationNode[]>([])
  const edgesRef = useRef<SimulationEdge[]>([])

  const initPositions = () => {
    if (!levelData || canvasWidth === 0 || canvasHeight === 0) return

    let nodes: SimulationNode[]
    if (levelData.level === 'anchors') {
      nodes = buildAnchorNodes(levelData.data, canvasWidth, canvasHeight)
    } else if (levelData.level === 'all_sources') {
      nodes = buildAllSourceNodes(levelData.data, canvasWidth, canvasHeight)
    } else if (levelData.level === 'sources') {
      nodes = buildSourceNodes(levelData.data, canvasWidth, canvasHeight)
    } else {
      nodes = buildEntityNodes(levelData.data, canvasWidth, canvasHeight)
    }

    nodesRef.current = nodes
    edgesRef.current = buildEdges(levelData)
  }

  useEffect(() => {
    initPositions()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [levelData, canvasWidth, canvasHeight])

  const tick = () => {
    const nodes = nodesRef.current
    const edges = edgesRef.current
    if (nodes.length === 0) return

    const level: GraphLevel = levelData?.level ?? 'anchors'
    const params = PARAMS[level]
    const n = nodes.length

    // 1. Damping + random drift (skip fixed nodes)
    for (const node of nodes) {
      if (node.fixed) continue
      node.vx *= params.damping
      node.vy *= params.damping
      node.vx += (Math.random() - 0.5) * 0.06
      node.vy += (Math.random() - 0.5) * 0.06
    }

    // 2. Node-node repulsion (cap at 200 pairs for performance)
    const maxPairs = Math.min(n, 200)
    for (let i = 0; i < maxPairs; i++) {
      for (let j = i + 1; j < maxPairs; j++) {
        const a = nodes[i]
        const b = nodes[j]
        if (!a || !b) continue
        const dx = b.x - a.x
        const dy = b.y - a.y
        const dist = Math.sqrt(dx * dx + dy * dy) || 1
        const minDist = a.radius + b.radius + params.collisionPadding

        if (dist < minDist) {
          const strength = Math.abs(params.chargeStrength + a.radius * params.chargeRadiusMultiplier)
          const force = ((minDist - dist) / minDist) * strength * 0.00015
          const fx = (dx / dist) * force
          const fy = (dy / dist) * force
          a.vx -= fx
          a.vy -= fy
          b.vx += fx
          b.vy += fy
        }
      }
    }

    // 3. Edge spring forces
    const nodeById = new Map<string, SimulationNode>()
    for (const node of nodes) nodeById.set(node.id, node)

    for (const edge of edges) {
      const a = nodeById.get(edge.fromId)
      const b = nodeById.get(edge.toId)
      if (!a || !b) continue

      const dx = b.x - a.x
      const dy = b.y - a.y
      const dist = Math.sqrt(dx * dx + dy * dy) || 1
      const idealDist = params.linkDistance

      // Ghost edges are weaker
      const springStrength = edge.kind === 'ghost' || edge.kind === 'cross'
        ? 0.0003
        : 0.0008

      const force = (dist - idealDist) * springStrength
      const fx = (dx / dist) * force
      const fy = (dy / dist) * force
      a.vx += fx
      a.vy += fy
      b.vx -= fx
      b.vy -= fy
    }

    // 4. Gravity well forces: pull sources toward their anchor(s)
    if (level === 'all_sources') {
      for (const node of nodes) {
        if (node.fixed || !node.anchorLinks?.length) continue
        for (const link of node.anchorLinks) {
          const anchor = nodeById.get(link.anchorId)
          if (!anchor) continue
          const dx = anchor.x - node.x
          const dy = anchor.y - node.y
          const dist = Math.sqrt(dx * dx + dy * dy)
          if (dist < 1) continue
          // Strength scales with link strength and distance
          const pullStrength = 0.0015 * link.strength
          node.vx += (dx / dist) * pullStrength * dist
          node.vy += (dy / dist) * pullStrength * dist
        }
      }
    }

    // 5. Boundary constraints + position update
    for (const node of nodes) {
      if (node.fixed) continue // gravity well anchors stay put
      const pad = node.radius + 10
      if (node.x < pad) node.vx += 0.3
      if (node.x > canvasWidth - pad) node.vx -= 0.3
      if (node.y < pad) node.vy += 0.3
      if (node.y > canvasHeight - pad) node.vy -= 0.3

      node.x += node.vx
      node.y += node.vy
    }
  }

  const resetPositions = () => {
    initPositions()
  }

  return { nodesRef, edgesRef, tick, resetPositions }
}
