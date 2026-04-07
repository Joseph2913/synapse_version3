/**
 * Backfill script: Generate embeddings for all existing knowledge_edges.
 *
 * Usage: npx tsx scripts/backfill-edge-embeddings.ts
 *
 * Requires environment variables:
 *   VITE_SUPABASE_URL       — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY — Service role key (bypasses RLS for backfill)
 *   VITE_GEMINI_API_KEY     — Gemini API key for embedding generation
 *
 * Safe to re-run: only processes edges where embedding IS NULL.
 */

import { createClient } from '@supabase/supabase-js'

// ─── Config ─────────────────────────────────────────────────────────────────

const SUPABASE_URL = process.env.VITE_SUPABASE_URL!
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!
const GEMINI_API_KEY = process.env.VITE_GEMINI_API_KEY!
const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models'

const BATCH_SIZE = 50
const CONCURRENCY = 5
const DELAY_BETWEEN_BATCHES_MS = 200

if (!SUPABASE_URL || !SUPABASE_KEY || !GEMINI_API_KEY) {
  console.error('Missing required environment variables: VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, VITE_GEMINI_API_KEY')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

// ─── Helpers (inline for script portability) ────────────────────────────────

const MAX_EVIDENCE_LENGTH = 500

function generateEdgeEmbeddingText(
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

async function generateEmbedding(text: string): Promise<number[]> {
  const response = await fetch(
    `${GEMINI_BASE_URL}/gemini-embedding-001:embedContent?key=${GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'models/gemini-embedding-001',
        content: { parts: [{ text }] },
      }),
    }
  )

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`Embedding API error ${response.status}: ${body}`)
  }

  const data = await response.json()
  if (!data.embedding?.values) {
    throw new Error('No embedding in Gemini response')
  }

  return data.embedding.values as number[]
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function backfill() {
  console.log('Starting edge embedding backfill...')

  // 1. Count edges needing embeddings
  const { count, error: countError } = await supabase
    .from('knowledge_edges')
    .select('id', { count: 'exact', head: true })
    .is('embedding', null)

  if (countError) {
    console.error('Count query failed:', countError)
    return
  }

  console.log(`Found ${count} edges without embeddings`)

  if (!count || count === 0) {
    console.log('Nothing to backfill. Done.')
    return
  }

  // 2. Process in batches
  // Always fetch from range(0, BATCH_SIZE-1) because each successful update
  // removes the row from the IS NULL result set, shifting remaining rows down.
  let processed = 0
  let failed = 0

  while (true) {
    const { data: edges, error: fetchError } = await supabase
      .from('knowledge_edges')
      .select('id, source_node_id, target_node_id, relation_type, evidence')
      .is('embedding', null)
      .range(0, BATCH_SIZE - 1)

    if (fetchError || !edges || edges.length === 0) {
      if (fetchError) console.error('Fetch error:', fetchError)
      break
    }

    // Collect all node IDs we need labels for
    const nodeIds = new Set<string>()
    for (const edge of edges) {
      nodeIds.add(edge.source_node_id)
      nodeIds.add(edge.target_node_id)
    }

    // Fetch node labels
    const { data: nodes, error: nodeError } = await supabase
      .from('knowledge_nodes')
      .select('id, label, entity_type')
      .in('id', Array.from(nodeIds))

    if (nodeError || !nodes) {
      console.error('Node fetch error:', nodeError)
      break
    }

    const nodeMap = new Map(nodes.map(n => [n.id, n]))

    // Generate embeddings concurrently within the batch
    const embedPromises: Array<Promise<void>> = []
    let batchProcessed = 0
    let batchFailed = 0

    for (let i = 0; i < edges.length; i += CONCURRENCY) {
      const chunk = edges.slice(i, i + CONCURRENCY)

      const results = await Promise.allSettled(
        chunk.map(async (edge) => {
          const sourceNode = nodeMap.get(edge.source_node_id)
          const targetNode = nodeMap.get(edge.target_node_id)

          if (!sourceNode || !targetNode) {
            console.warn(`Skipping edge ${edge.id}: orphaned node reference`)
            throw new Error('orphaned')
          }

          const text = generateEdgeEmbeddingText(
            sourceNode.label,
            targetNode.label,
            edge.relation_type,
            edge.evidence
          )

          const embedding = await generateEmbedding(text)

          const { error: updateError } = await supabase
            .from('knowledge_edges')
            .update({ embedding })
            .eq('id', edge.id)

          if (updateError) {
            throw new Error(`Update failed: ${updateError.message}`)
          }
        })
      )

      for (const result of results) {
        if (result.status === 'fulfilled') {
          batchProcessed++
        } else {
          batchFailed++
          console.warn(`  Edge failed:`, result.reason?.message ?? result.reason)
        }
      }
    }

    processed += batchProcessed
    failed += batchFailed

    console.log(`Progress: ${processed} embedded, ${failed} failed, ${count - processed - failed} remaining`)

    // Brief pause between batches for rate limiting
    await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_BATCHES_MS))
  }

  console.log(`\nBackfill complete: ${processed} embedded, ${failed} failed`)
}

backfill().catch(console.error)
