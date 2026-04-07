/**
 * Edge embedding utilities for PRD-RAG-05.
 *
 * Composes embedding text for knowledge_edges and provides batch embedding
 * helpers used by the extraction pipeline and backfill script.
 */

import { generateEmbedding, generateEmbeddings } from './gemini'

// ─── Types ──────────────────────────────────────────────────────────────────

export interface EdgeForEmbedding {
  id: string
  source_node_id: string
  target_node_id: string
  relation_type: string | null
  evidence: string | null
}

export interface NodeLabel {
  id: string
  label: string
  entity_type: string
}

// ─── Embedding Text Composition ─────────────────────────────────────────────

const MAX_EVIDENCE_LENGTH = 500

/**
 * Composes the text that gets embedded for a relationship edge.
 *
 * Format: "SourceLabel relation_type TargetLabel[: evidence]"
 *
 * The embedding captures both the structural relationship (who connects to whom)
 * and the semantic meaning of why they're connected (the evidence).
 */
export function generateEdgeEmbeddingText(
  sourceLabel: string,
  targetLabel: string,
  relationType: string | null,
  evidence: string | null
): string {
  const relation = relationType ?? 'relates_to'
  const base = `${sourceLabel} ${relation} ${targetLabel}`

  if (evidence && evidence.trim().length > 0) {
    const trimmed = evidence.trim()
    const truncated = trimmed.length > MAX_EVIDENCE_LENGTH
      ? trimmed.substring(0, MAX_EVIDENCE_LENGTH)
      : trimmed
    return `${base}: ${truncated}`
  }

  return base
}

// ─── Single Edge Embedding ──────────────────────────────────────────────────

export async function embedEdge(
  sourceLabel: string,
  targetLabel: string,
  relationType: string | null,
  evidence: string | null
): Promise<number[]> {
  const text = generateEdgeEmbeddingText(sourceLabel, targetLabel, relationType, evidence)
  return generateEmbedding(text)
}

// ─── Batch Edge Embedding ───────────────────────────────────────────────────

/**
 * Generates embeddings for a batch of edges using the concurrent batch
 * embedding function from gemini.ts.
 *
 * Returns a Map of edgeId → embedding vector. Edges that fail to embed
 * are omitted from the map (logged but not thrown).
 */
export async function embedEdgeBatch(
  edges: EdgeForEmbedding[],
  nodesMap: Map<string, NodeLabel>,
  options?: { concurrency?: number; onProgress?: (completed: number, total: number) => void }
): Promise<Map<string, number[]>> {
  const results = new Map<string, number[]>()

  // Build texts array, tracking which edges are valid
  const validEdges: EdgeForEmbedding[] = []
  const texts: string[] = []

  for (const edge of edges) {
    const sourceNode = nodesMap.get(edge.source_node_id)
    const targetNode = nodesMap.get(edge.target_node_id)

    if (!sourceNode || !targetNode) {
      console.warn(`[edgeEmbedding] Skipping edge ${edge.id}: missing node labels`)
      continue
    }

    validEdges.push(edge)
    texts.push(generateEdgeEmbeddingText(
      sourceNode.label,
      targetNode.label,
      edge.relation_type,
      edge.evidence
    ))
  }

  if (texts.length === 0) return results

  const embeddings = await generateEmbeddings(
    texts,
    options?.concurrency ?? 5,
    options?.onProgress
  )

  for (let i = 0; i < validEdges.length; i++) {
    const embedding = embeddings[i]
    const edge = validEdges[i]
    if (embedding && edge) {
      results.set(edge.id, embedding)
    }
  }

  return results
}
