import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createClient } from '@supabase/supabase-js'

// Allow up to 60 seconds for large graphs
export const maxDuration = 60

// ─── ENVIRONMENT ──────────────────────────────────────────────────────────────
const SUPABASE_URL              = process.env.SUPABASE_URL!
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!

const getSupabase = () => createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

// ─── AUTH ──────────────────────────────────────────────────────────────────────
async function resolveUserId(req: VercelRequest): Promise<string | null> {
  const auth = req.headers['authorization']
  if (!auth) return null
  const token = auth.replace('Bearer ', '')
  const sb = getSupabase()
  const { data: { user }, error } = await sb.auth.getUser(token)
  if (error || !user) return null
  return user.id
}

// ─── LAYOUT SIMULATION ───────────────────────────────────────────────────────
// Force-directed layout with grid-based spatial indexing for 5,000+ nodes.
// Grid cells avoid O(n²) repulsion checks — only nearby nodes repel each other.

interface SimNode {
  id: string
  x: number
  y: number
  vx: number
  vy: number
  isAnchor: boolean
  edgeCount: number
}

const CANVAS_WIDTH = 4000
const CANVAS_HEIGHT = 3000
const GRID_CELL_SIZE = 80
const SIM_TICKS = 120

function computeLayout(
  nodes: Array<{ id: string; isAnchor: boolean }>,
  edges: Array<{ sourceNodeId: string; targetNodeId: string }>,
): Map<string, { x: number; y: number }> {
  if (nodes.length === 0) return new Map()

  const cx = CANVAS_WIDTH / 2
  const cy = CANVAS_HEIGHT / 2

  // Count edges per node
  const edgeCounts: Record<string, number> = {}
  for (const e of edges) {
    edgeCounts[e.sourceNodeId] = (edgeCounts[e.sourceNodeId] ?? 0) + 1
    edgeCounts[e.targetNodeId] = (edgeCounts[e.targetNodeId] ?? 0) + 1
  }

  // Build adjacency for spring forces
  const adjacency = new Map<string, string[]>()
  for (const e of edges) {
    if (!adjacency.has(e.sourceNodeId)) adjacency.set(e.sourceNodeId, [])
    if (!adjacency.has(e.targetNodeId)) adjacency.set(e.targetNodeId, [])
    adjacency.get(e.sourceNodeId)!.push(e.targetNodeId)
    adjacency.get(e.targetNodeId)!.push(e.sourceNodeId)
  }

  // Initial placement: golden-angle spiral from center
  const simNodes: SimNode[] = nodes.map((n, i) => {
    const angle = i * 2.399963 // golden angle
    const r = 20 + Math.sqrt(i) * 15
    return {
      id: n.id,
      x: cx + Math.cos(angle) * Math.min(r, CANVAS_WIDTH * 0.4),
      y: cy + Math.sin(angle) * Math.min(r, CANVAS_HEIGHT * 0.4),
      vx: 0,
      vy: 0,
      isAnchor: n.isAnchor,
      edgeCount: edgeCounts[n.id] ?? 0,
    }
  })

  const nodeIndex = new Map(simNodes.map((n, i) => [n.id, i]))

  // ── Simulation loop ────────────────────────────────────────────────────────
  for (let tick = 0; tick < SIM_TICKS; tick++) {
    const alpha = 0.8 * (1 - tick / SIM_TICKS) // cooling

    // ── Grid-based repulsion ─────────────────────────────────────────────────
    // Place nodes into grid cells, then only check repulsion against same + adjacent cells
    const gridCols = Math.ceil(CANVAS_WIDTH / GRID_CELL_SIZE)
    const grid = new Map<number, number[]>() // cellKey → node indices

    for (let i = 0; i < simNodes.length; i++) {
      const n = simNodes[i]!
      const col = Math.floor(n.x / GRID_CELL_SIZE)
      const row = Math.floor(n.y / GRID_CELL_SIZE)
      const key = row * gridCols + col
      if (!grid.has(key)) grid.set(key, [])
      grid.get(key)!.push(i)
    }

    // Check repulsion within each cell and its 8 neighbors
    for (const [cellKey, indices] of grid) {
      const row = Math.floor(cellKey / gridCols)
      const col = cellKey % gridCols

      // Collect indices from this cell + 8 neighbors
      const nearbyIndices: number[] = [...indices]
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (dr === 0 && dc === 0) continue
          const neighborKey = (row + dr) * gridCols + (col + dc)
          const neighborIndices = grid.get(neighborKey)
          if (neighborIndices) nearbyIndices.push(...neighborIndices)
        }
      }

      // Repulsion between this cell's nodes and all nearby nodes
      for (const i of indices) {
        const a = simNodes[i]!
        for (const j of nearbyIndices) {
          if (j <= i) continue // avoid duplicates
          const b = simNodes[j]!
          const dx = b.x - a.x
          const dy = b.y - a.y
          const dist = Math.sqrt(dx * dx + dy * dy) || 0.1
          const minDist = 25

          if (dist < minDist * 3) {
            const repulsion = (minDist * 2.5 / dist) * 0.8 * alpha
            const nx = dx / dist
            const ny = dy / dist
            a.vx -= nx * repulsion
            a.vy -= ny * repulsion
            b.vx += nx * repulsion
            b.vy += ny * repulsion
          }
        }
      }
    }

    // ── Spring forces (edges) ────────────────────────────────────────────────
    for (const e of edges) {
      const ai = nodeIndex.get(e.sourceNodeId)
      const bi = nodeIndex.get(e.targetNodeId)
      if (ai === undefined || bi === undefined) continue

      const a = simNodes[ai]!
      const b = simNodes[bi]!
      const dx = b.x - a.x
      const dy = b.y - a.y
      const dist = Math.sqrt(dx * dx + dy * dy) || 0.1
      const idealDist = 60

      const force = (dist - idealDist) * 0.01 * alpha
      const nx = dx / dist
      const ny = dy / dist
      a.vx += nx * force
      a.vy += ny * force
      b.vx -= nx * force
      b.vy -= ny * force
    }

    // ── Center gravity ───────────────────────────────────────────────────────
    for (const n of simNodes) {
      n.vx += (cx - n.x) * 0.001 * alpha
      n.vy += (cy - n.y) * 0.001 * alpha
    }

    // ── Apply velocity + damping ─────────────────────────────────────────────
    for (const n of simNodes) {
      n.vx *= 0.85
      n.vy *= 0.85
      n.x += n.vx
      n.y += n.vy

      // Boundary containment
      const pad = 50
      n.x = Math.max(pad, Math.min(CANVAS_WIDTH - pad, n.x))
      n.y = Math.max(pad, Math.min(CANVAS_HEIGHT - pad, n.y))
    }
  }

  // Return positions
  const result = new Map<string, { x: number; y: number }>()
  for (const n of simNodes) {
    result.set(n.id, { x: Math.round(n.x * 100) / 100, y: Math.round(n.y * 100) / 100 })
  }
  return result
}

// ─── HANDLER ─────────────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')

  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const userId = await resolveUserId(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })

  const startMs = Date.now()
  const sb = getSupabase()

  try {
    // 1. Fetch all non-merged nodes
    const PAGE = 1000
    const allNodes: Array<{ id: string; is_anchor: boolean }> = []
    let offset = 0
    while (true) {
      const { data, error } = await sb
        .from('knowledge_nodes')
        .select('id, is_anchor')
        .eq('user_id', userId)
        .eq('is_merged', false)
        .range(offset, offset + PAGE - 1)
      if (error) throw new Error(error.message)
      if (!data || data.length === 0) break
      for (const n of data) allNodes.push({ id: n.id as string, isAnchor: n.is_anchor as boolean })
      if (data.length < PAGE) break
      offset += PAGE
    }

    // 2. Fetch all edges
    const allEdges: Array<{ sourceNodeId: string; targetNodeId: string }> = []
    offset = 0
    while (true) {
      const { data, error } = await sb
        .from('knowledge_edges')
        .select('source_node_id, target_node_id')
        .eq('user_id', userId)
        .range(offset, offset + PAGE - 1)
      if (error) throw new Error(error.message)
      if (!data || data.length === 0) break
      for (const e of data) allEdges.push({
        sourceNodeId: e.source_node_id as string,
        targetNodeId: e.target_node_id as string,
      })
      if (data.length < PAGE) break
      offset += PAGE
    }

    console.log(`[compute-layout] Loaded ${allNodes.length} nodes, ${allEdges.length} edges`)

    // 3. Run layout simulation
    const positions = computeLayout(allNodes, allEdges)

    // 4. Save positions back to database (batch updates)
    const BATCH = 500
    const entries = Array.from(positions.entries())
    let updated = 0

    for (let i = 0; i < entries.length; i += BATCH) {
      const batch = entries.slice(i, i + BATCH)
      // Use a single RPC or individual updates
      const promises = batch.map(([id, pos]) =>
        sb.from('knowledge_nodes')
          .update({ graph_x: pos.x, graph_y: pos.y })
          .eq('id', id)
          .eq('user_id', userId)
      )
      await Promise.all(promises)
      updated += batch.length
    }

    const durationMs = Date.now() - startMs
    console.log(`[compute-layout] Positioned ${updated} nodes in ${durationMs}ms`)

    return res.status(200).json({
      success: true,
      nodesPositioned: updated,
      totalEdges: allEdges.length,
      durationMs,
    })
  } catch (err) {
    console.error('[compute-layout] Error:', err)
    return res.status(500).json({ error: String(err) })
  }
}
