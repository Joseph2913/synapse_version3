/**
 * Barnes-Hut quadtree for O(n log n) force calculations.
 * Used by useGraphSimulation to replace the O(n²) repulsion loop.
 */

interface QuadNode {
  x: number
  y: number
  mass: number  // number of particles
  comX: number  // center of mass X
  comY: number  // center of mass Y
  children: (QuadNode | null)[]  // NW, NE, SW, SE
  isLeaf: boolean
  particleX: number
  particleY: number
  particleIdx: number  // index into original array (-1 if internal)
}

export interface Particle {
  x: number
  y: number
  radius: number
}

const THETA = 0.7  // Barnes-Hut opening angle (higher = faster but less accurate)

function createNode(x: number, y: number, _size: number): QuadNode {
  return {
    x, y, mass: 0, comX: 0, comY: 0,
    children: [null, null, null, null],
    isLeaf: true, particleX: 0, particleY: 0, particleIdx: -1,
  }
}

function getQuadrant(nodeX: number, nodeY: number, halfSize: number, px: number, py: number): number {
  const isRight = px >= nodeX + halfSize
  const isBottom = py >= nodeY + halfSize
  return (isBottom ? 2 : 0) + (isRight ? 1 : 0)
}

function insertInto(
  node: QuadNode, px: number, py: number, idx: number,
  nodeX: number, nodeY: number, size: number, depth: number
): void {
  if (depth > 20) return  // safety cap

  if (node.mass === 0) {
    // Empty node — store particle
    node.mass = 1
    node.comX = px
    node.comY = py
    node.particleX = px
    node.particleY = py
    node.particleIdx = idx
    node.isLeaf = true
    return
  }

  const halfSize = size / 2

  if (node.isLeaf) {
    // Convert leaf to internal — re-insert existing particle
    const existingIdx = node.particleIdx
    const existingX = node.particleX
    const existingY = node.particleY
    node.isLeaf = false
    node.particleIdx = -1

    const q1 = getQuadrant(nodeX, nodeY, halfSize, existingX, existingY)
    if (!node.children[q1]) {
      const childX = nodeX + (q1 & 1 ? halfSize : 0)
      const childY = nodeY + (q1 & 2 ? halfSize : 0)
      node.children[q1] = createNode(childX, childY, halfSize)
    }
    insertInto(node.children[q1]!, existingX, existingY, existingIdx,
      nodeX + (q1 & 1 ? halfSize : 0), nodeY + (q1 & 2 ? halfSize : 0), halfSize, depth + 1)
  }

  // Insert new particle
  const q2 = getQuadrant(nodeX, nodeY, halfSize, px, py)
  if (!node.children[q2]) {
    const childX = nodeX + (q2 & 1 ? halfSize : 0)
    const childY = nodeY + (q2 & 2 ? halfSize : 0)
    node.children[q2] = createNode(childX, childY, halfSize)
  }
  insertInto(node.children[q2]!, px, py, idx,
    nodeX + (q2 & 1 ? halfSize : 0), nodeY + (q2 & 2 ? halfSize : 0), halfSize, depth + 1)

  // Update center of mass
  const totalMass = node.mass + 1
  node.comX = (node.comX * node.mass + px) / totalMass
  node.comY = (node.comY * node.mass + py) / totalMass
  node.mass = totalMass
}

export function buildQuadtree(particles: Particle[]): QuadNode | null {
  if (particles.length === 0) return null

  // Find bounds
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  for (const p of particles) {
    if (p.x < minX) minX = p.x
    if (p.x > maxX) maxX = p.x
    if (p.y < minY) minY = p.y
    if (p.y > maxY) maxY = p.y
  }

  const size = Math.max(maxX - minX, maxY - minY, 1) + 1
  const root = createNode(minX, minY, size)

  for (let i = 0; i < particles.length; i++) {
    insertInto(root, particles[i]!.x, particles[i]!.y, i, minX, minY, size, 0)
  }

  return root
}

/**
 * Compute repulsion forces on particle at (px, py) using Barnes-Hut approximation.
 * Returns accumulated force {fx, fy}.
 * chargeStrength controls the repulsion magnitude.
 */
export function computeRepulsion(
  root: QuadNode,
  px: number,
  py: number,
  particleIdx: number,
  chargeStrength: number,
  minDist: number
): { fx: number; fy: number } {
  let fx = 0, fy = 0

  function visit(node: QuadNode, nodeX: number, nodeY: number, size: number) {
    if (node.mass === 0) return

    const dx = node.comX - px
    const dy = node.comY - py
    const dist = Math.sqrt(dx * dx + dy * dy) || 0.01

    // If leaf and it's the same particle, skip
    if (node.isLeaf && node.particleIdx === particleIdx) return

    // Barnes-Hut criterion: if size/dist < theta, treat as single body
    if (node.isLeaf || size / dist < THETA) {
      if (dist < minDist) {
        const force = chargeStrength * node.mass / (dist * dist)
        fx -= (dx / dist) * force
        fy -= (dy / dist) * force
      }
      return
    }

    // Otherwise, recurse into children
    const halfSize = size / 2
    for (let q = 0; q < 4; q++) {
      const child = node.children[q]
      if (child) {
        visit(child, nodeX + (q & 1 ? halfSize : 0), nodeY + (q & 2 ? halfSize : 0), halfSize)
      }
    }
  }

  // Estimate traversal size from root
  let size = 1
  // Estimate size from root bounds
  const stack: QuadNode[] = [root]
  while (stack.length > 0) {
    const n = stack.pop()!
    for (const c of n.children) if (c) stack.push(c)
  }

  size = Math.max(1, Math.abs(root.comX - root.x) * 4, Math.abs(root.comY - root.y) * 4)

  visit(root, root.x, root.y, size)

  return { fx, fy }
}
