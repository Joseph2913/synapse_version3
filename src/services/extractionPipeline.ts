/**
 * Headless extraction pipeline — reusable from services, hooks, or handlers.
 *
 * Mirrors the full useExtraction flow (save source → Gemini extraction →
 * dedup → save nodes/edges → embeddings → chunks → cross-connections →
 * anchor scoring) but without React state management or a review pause.
 * All extracted entities are auto-approved.
 */

import type { ExtractionConfig, ReviewEntity, SourceMetadata } from '../types/extraction'
import { buildExtractionPrompt } from '../utils/promptBuilder'
import { chunkSourceContent } from '../utils/chunking'
import { resolveSummary } from '../utils/summarize'
import { extractEntities, generateEmbeddings } from './gemini'
import {
  saveSource,
  saveNodes,
  saveEdges,
  updateNodeEmbeddings,
  saveChunks,
  saveExtractionSession,
} from './extractionPersistence'
import { supabase } from './supabase'
import { checkDeduplication, savePotentialDuplicates } from './deduplication'
import { discoverCrossConnections, saveCrossConnectionEdges } from './crossConnections'

// ─── Public types ────────────────────────────────────────────────────────────

export interface HeadlessExtractionInput {
  userId: string
  accessToken: string
  /** Raw source content (transcript, document text, etc.) */
  content: string
  /** Pre-created source ID. If provided, source row creation is skipped. */
  existingSourceId?: string
  metadata: SourceMetadata
  config?: Partial<ExtractionConfig>
  /** Optional progress callback for UI feedback */
  onProgress?: (step: string, message: string) => void
}

export interface HeadlessExtractionResult {
  sourceId: string
  nodeIds: string[]
  edgeIds: string[]
  chunkCount: number
  crossConnectionCount: number
  durationMs: number
}

// ─── Main pipeline ───────────────────────────────────────────────────────────

export async function runHeadlessExtraction(
  input: HeadlessExtractionInput
): Promise<HeadlessExtractionResult> {
  const {
    userId,
    accessToken,
    content,
    existingSourceId,
    metadata,
    onProgress,
  } = input

  const startTime = Date.now()
  const progress = onProgress ?? (() => {})

  // Merge caller config with sensible defaults
  const config: ExtractionConfig = {
    mode: input.config?.mode ?? 'comprehensive',
    anchorEmphasis: input.config?.anchorEmphasis ?? 'standard',
    anchors: input.config?.anchors ?? [],
    userProfile: input.config?.userProfile ?? null,
    customGuidance: input.config?.customGuidance,
  }

  // ── Step 1: Save source (or reuse existing) ────────────────────────────────

  let sourceId: string

  if (existingSourceId) {
    sourceId = existingSourceId
  } else {
    progress('saving_source', 'Saving source content…')
    sourceId = await saveSource(userId, content, metadata)
  }

  // ── Step 2: Summarize (non-blocking) ───────────────────────────────────────

  progress('summarizing', 'Generating summary…')
  try {
    const summaryResult = await resolveSummary(metadata.sourceType, content, null)
    if (summaryResult) {
      await supabase
        .from('knowledge_sources')
        .update({ summary: summaryResult.summary, summary_source: summaryResult.source })
        .eq('id', sourceId)
    }
  } catch {
    // Non-blocking — summary failure does not halt pipeline
  }

  // ── Step 3: Extract entities ───────────────────────────────────────────────

  progress('extracting', 'Running Gemini extraction…')
  const systemPrompt = buildExtractionPrompt(config)
  const extractionResult = await extractEntities(content, systemPrompt)

  // Auto-approve all entities (no review pause)
  const reviewEntities: ReviewEntity[] = extractionResult.entities.map(e => ({
    ...e,
    removed: false,
    edited: false,
  }))
  const removedLabels = new Set<string>()

  // ── Step 4: Deduplication + save nodes & edges ─────────────────────────────

  progress('saving_nodes', 'Saving entities to knowledge graph…')

  const entitiesForDedup = reviewEntities.map(e => ({
    label: e.label,
    entity_type: e.entity_type,
  }))
  const dedupResult = await checkDeduplication(userId, entitiesForDedup)

  const sourceName = metadata.title || deriveQuickTitle(content)
  const saveResult = await saveNodes(userId, reviewEntities, sourceId, {
    sourceName,
    sourceType: metadata.sourceType || 'Note',
    sourceUrl: metadata.sourceUrl,
  }, dedupResult.exactMatches)

  const savedEdgeIds = await saveEdges(
    userId,
    extractionResult.relationships,
    saveResult.allNodes,
    removedLabels,
  )

  const savedNodes = saveResult.newNodes

  // ── Step 5: Generate embeddings ────────────────────────────────────────────

  progress('generating_embeddings', 'Generating embeddings…')

  if (savedNodes.length > 0) {
    const texts = savedNodes.map(n => {
      const entity = reviewEntities.find(
        e => e.label.toLowerCase() === n.label.toLowerCase()
      )
      return `${entity?.entity_type ?? n.entity_type}: ${n.label} — ${entity?.description || ''}`
    })

    const embeddings = await generateEmbeddings(texts, 5)

    const nodesToUpdate: Array<{ id: string; embedding: number[] }> = []
    embeddings.forEach((emb, i) => {
      const node = savedNodes[i]
      if (emb && node) {
        nodesToUpdate.push({ id: node.id, embedding: emb })
        node.embedding = emb
      }
    })

    if (nodesToUpdate.length > 0) {
      await updateNodeEmbeddings(nodesToUpdate)
    }

    // Near-duplicate detection (non-blocking)
    const nodesWithEmbeddings = savedNodes
      .map(n => ({ label: n.label, entity_type: n.entity_type, embedding: n.embedding }))
      .filter((n): n is { label: string; entity_type: string; embedding: number[] } => !!n.embedding)

    if (nodesWithEmbeddings.length > 0) {
      try {
        const nearDedupResult = await checkDeduplication(userId, nodesWithEmbeddings)
        const nodeIdMap = new Map(savedNodes.map(n => [n.label.toLowerCase(), n.id]))
        await savePotentialDuplicates(userId, nearDedupResult.nearMatches, nodeIdMap)
      } catch {
        // Non-blocking
      }
    }
  }

  // ── Step 6: Chunk source & embed ───────────────────────────────────────────

  progress('chunking_source', 'Chunking source for RAG retrieval…')

  let chunkCount = 0
  try {
    const chunks = chunkSourceContent(content)
    if (chunks.length > 0) {
      let chunkEmbeddings: (number[] | null)[] = chunks.map(() => null)
      try {
        chunkEmbeddings = await generateEmbeddings(chunks, 5)
      } catch {
        // Save chunks without embeddings if embedding fails
      }
      await saveChunks(userId, sourceId, chunks, chunkEmbeddings)
      chunkCount = chunks.length
    }
  } catch (chunkErr) {
    console.warn('[extractionPipeline] Chunking failed:', chunkErr)
  }

  // ── Step 7: Cross-connections ──────────────────────────────────────────────

  progress('discovering_connections', 'Discovering cross-connections…')

  let crossConnectionCount = 0
  let crossEdgeIds: string[] = []
  try {
    if (savedNodes.length > 0) {
      const crossEdges = await discoverCrossConnections(
        savedNodes.map(n => n.id),
        userId,
      )
      crossConnectionCount = crossEdges.length
      if (crossEdges.length > 0) {
        crossEdgeIds = await saveCrossConnectionEdges(userId, crossEdges)
      }
    }
  } catch {
    // Non-blocking
  }

  // ── Step 8: Telemetry + anchor scoring ─────────────────────────────────────

  const durationMs = Date.now() - startTime

  saveExtractionSession(userId, {
    sourceName,
    sourceType: metadata.sourceType || 'Note',
    contentPreview: content,
    extractionMode: config.mode,
    anchorEmphasis: config.anchorEmphasis,
    userGuidance: config.customGuidance,
    selectedAnchorIds: config.anchors.map(() => ''),
    extractedNodeIds: savedNodes.map(n => n.id),
    extractedEdgeIds: [...savedEdgeIds, ...crossEdgeIds],
    entityCount: savedNodes.length,
    relationshipCount: savedEdgeIds.length + crossEdgeIds.length,
    chunkCount,
    crossConnectionCount,
    durationMs,
  }).catch(() => {})

  // Trigger anchor scoring (fire-and-forget)
  if (savedNodes.length > 0) {
    fetch('/api/anchors/score-post-extraction', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ userId, sourceId, nodeIds: savedNodes.map(n => n.id) }),
    }).catch(() => {})
  }

  progress('complete', 'Extraction complete!')

  return {
    sourceId,
    nodeIds: savedNodes.map(n => n.id),
    edgeIds: [...savedEdgeIds, ...crossEdgeIds],
    chunkCount,
    crossConnectionCount,
    durationMs,
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function deriveQuickTitle(content: string): string {
  const trimmed = content.trim()
  const firstLine = (trimmed.split('\n')[0] ?? '').trim()
  return firstLine.length <= 60 ? firstLine : firstLine.substring(0, 60) + '...'
}
