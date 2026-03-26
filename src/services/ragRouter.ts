import { generateRAGResponse, embedQuery } from './gemini'
import {
  fetchAllChunksForSource,
  fetchEntitiesForSource,
  fetchEdgesBetweenEntities,
  fetchCrossSourceEdges,
  fetchEntityDirectEdges,
  fetchNodeWithEmbedding,
  fetchNodeById,
  fetchSourcesByIds,
  fetchSourcesWithContent,
  semanticSearchNodes,
  traverseGraphFromNodes,
} from './supabase'
import { queryGraph, buildRAGResponseContext } from './rag'
import type { RAGResponse } from './rag'
import type { RAGStepEvent, RAGContext, EnrichedChunk, NodeSummary, RelationshipPath, QueryConfig, SemanticChunkResult } from '../types/rag'
import { DEFAULT_QUERY_CONFIG } from '../types/rag'
import type { ChatEntryContext } from '../types/chatRouting'
import type { KnowledgeNode, KnowledgeEdge } from '../types/database'
import { QUERY_MINDSETS, MODEL_TIERS } from '../config/queryMindsets'
import { getResponseFormatForEntryPoint, getThinkingBudgetForEntryPoint } from '../config/responseFormats'

export { buildRAGResponseContext }

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildRelPaths(nodes: KnowledgeNode[], edges: KnowledgeEdge[]): RelationshipPath[] {
  const nodeMap = new Map<string, string>()
  for (const n of nodes) nodeMap.set(n.id, n.label)
  const result: RelationshipPath[] = []
  for (const e of edges) {
    const from = nodeMap.get(e.source_node_id)
    const to = nodeMap.get(e.target_node_id)
    if (!from || !to) continue
    result.push({ from, relation: (e.relation_type ?? 'relates_to') as string, to, evidence: e.evidence ?? undefined })
  }
  return result
}

async function enrichChunksWithSources(chunks: SemanticChunkResult[]): Promise<EnrichedChunk[]> {
  if (chunks.length === 0) return []
  const sourceIds = [...new Set(chunks.map(c => c.source_id))]
  const sourceMap = await fetchSourcesByIds(sourceIds)
  return chunks.map(chunk => {
    const source = sourceMap.get(chunk.source_id)
    return {
      id: chunk.id,
      source_id: chunk.source_id,
      content: chunk.content,
      similarity: chunk.similarity,
      sourceTitle: source?.title?.trim() || 'Unknown Source',
      sourceType: source?.source_type ?? 'Document',
      sourceCreatedAt: source?.created_at ?? new Date().toISOString(),
      sourceSummary: source?.summary ?? null,
    }
  })
}

function toNodeSummaries(nodes: KnowledgeNode[]): NodeSummary[] {
  return nodes.map(n => ({
    id: n.id,
    label: n.label,
    entity_type: n.entity_type,
    description: n.description ?? null,
  }))
}

function resolveConfig(ctx: ChatEntryContext): QueryConfig {
  return {
    mindset: ctx.queryConfig.mindset ?? DEFAULT_QUERY_CONFIG.mindset,
    scopeAnchors: ctx.queryConfig.scopeAnchors ?? DEFAULT_QUERY_CONFIG.scopeAnchors,
    toolMode: ctx.queryConfig.toolMode ?? DEFAULT_QUERY_CONFIG.toolMode,
    modelTier: ctx.queryConfig.modelTier ?? DEFAULT_QUERY_CONFIG.modelTier,
  }
}

/** Return type of fetchSourcesByIds */
type SourceMapEntry = { id: string; title: string | null; source_type: string | null; created_at: string; summary: string | null; summary_source: string | null }

/**
 * Create synthetic chunks from source summaries when real chunks aren't available.
 * First tries the lightweight sourceMap (from fetchSourcesByIds — has summary).
 * If that yields nothing, fetches full source records (from fetchSourcesWithContent — has content).
 */
function sourceSummariesToChunks(
  sources: Map<string, SourceMapEntry>
): SemanticChunkResult[] {
  const chunks: SemanticChunkResult[] = []
  for (const [sourceId, source] of sources) {
    if (source.summary) {
      chunks.push({
        id: `summary-${sourceId}`,
        source_id: sourceId,
        chunk_index: 0,
        content: `[Source Summary] ${source.title ?? 'Untitled'}: ${source.summary}`,
        similarity: 1.0,
      })
    }
  }
  return chunks
}

/**
 * Deeper fallback: fetch full source content when both chunks and summaries are empty.
 */
async function fetchContentFallbackChunks(sourceIds: string[]): Promise<SemanticChunkResult[]> {
  const fullSources = await fetchSourcesWithContent(sourceIds)
  const chunks: SemanticChunkResult[] = []
  for (const [sourceId, source] of fullSources) {
    if (source.summary) {
      chunks.push({
        id: `summary-${sourceId}`,
        source_id: sourceId,
        chunk_index: 0,
        content: `[Source Summary] ${source.title ?? 'Untitled'}: ${source.summary}`,
        similarity: 1.0,
      })
    }
    if (source.content) {
      // Split long content into ~2000 char chunks
      const content = source.content
      for (let i = 0; i < content.length && chunks.length < 20; i += 2000) {
        chunks.push({
          id: `content-${sourceId}-${i}`,
          source_id: sourceId,
          chunk_index: chunks.length,
          content: content.slice(i, i + 2000),
          similarity: 0.9,
        })
      }
    }
  }
  return chunks
}

/**
 * PRD-17 §8: Zero-chunk fallback.
 * When a hard-scoped pipeline gets 0 chunks, relax to the standard queryGraph
 * but keep the system directive so the response format is still tailored.
 */
async function fallbackToStandard(
  question: string,
  userId: string,
  conversationHistory: { role: string; content: string }[],
  ctx: ChatEntryContext,
  onStepChange?: (event: RAGStepEvent) => void,
  signal?: AbortSignal
): Promise<RAGResponse> {
  console.warn(`[ragRouter] Zero-chunk fallback for entryPoint=${ctx.entryPoint} — relaxing to standard queryGraph`)
  return queryGraph(question, userId, conversationHistory, resolveConfig(ctx), onStepChange, signal)
}

async function generateFromContext(
  ragContext: RAGContext,
  question: string,
  conversationHistory: { role: string; content: string }[],
  ctx: ChatEntryContext,
  signal?: AbortSignal
): Promise<import('../types/rag').RAGGenerationResult> {
  const config = resolveConfig(ctx)
  const mindset = QUERY_MINDSETS.find(m => m.id === config.mindset)
  const modelTier = MODEL_TIERS.find(t => t.id === config.modelTier)
  const temperature = mindset?.temperatureOverride ?? modelTier?.generationConfig.temperature
  const maxOutputTokens = modelTier?.generationConfig.maxOutputTokens

  // PRD-C: Entry-point-specific response format and thinking budget
  const responseFormatInstruction = getResponseFormatForEntryPoint(ctx.entryPoint)
  const thinkingBudget = getThinkingBudgetForEntryPoint(ctx.entryPoint)

  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')

  return generateRAGResponse(
    ragContext,
    question,
    conversationHistory.slice(-6),
    '',
    mindset?.promptAddition,
    temperature,
    maxOutputTokens,
    ctx.systemDirective || undefined,
    responseFormatInstruction,
    thinkingBudget
  )
}

// ─── Entry Point Pipelines ───────────────────────────────────────────────────

async function pipelineEntityExplore(
  question: string,
  userId: string,
  conversationHistory: { role: string; content: string }[],
  ctx: ChatEntryContext,
  onStepChange?: (event: RAGStepEvent) => void,
  signal?: AbortSignal
): Promise<RAGResponse> {
  const entityId = ctx.scope?.entityIds?.[0]
  if (!entityId) return queryGraph(question, userId, conversationHistory, resolveConfig(ctx), onStepChange, signal)

  onStepChange?.({ step: 'embedding', status: 'running' })

  // Fetch entity and its embedding
  const [entity, queryEmbedding] = await Promise.all([
    fetchNodeById(entityId),
    embedQuery(question),
  ])
  if (!entity) return queryGraph(question, userId, conversationHistory, resolveConfig(ctx), onStepChange, signal)

  onStepChange?.({ step: 'embedding', status: 'done', subQueries: [question], hasEmbedding: queryEmbedding.length > 0 })
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')

  onStepChange?.({ step: 'semantic_search', status: 'running' })

  // Direct edges + source chunks + semantic nodes
  const [directEdges, sourceChunks, semanticNodes] = await Promise.all([
    fetchEntityDirectEdges(entityId, userId),
    entity.source_id ? fetchAllChunksForSource(entity.source_id, userId, 15) : Promise.resolve([]),
    queryEmbedding.length > 0
      ? semanticSearchNodes(queryEmbedding, userId, { matchThreshold: 0.4, matchCount: 20 })
      : Promise.resolve([]),
  ])

  onStepChange?.({ step: 'semantic_search', status: 'done', semanticNodes: semanticNodes.length })
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')

  onStepChange?.({ step: 'graph_traversal', status: 'running' })

  // 2-hop BFS from entity
  const { nodes: graphNodes, edges: graphEdges } = await traverseGraphFromNodes([entityId], userId, 2)

  onStepChange?.({ step: 'graph_traversal', status: 'done', seedNodes: 1, graphNodes: graphNodes.length, graphEdges: graphEdges.length })
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')

  onStepChange?.({ step: 'context_assembly', status: 'running' })

  const allNodes = deduplicateById([entity, ...graphNodes])
  const allEdges = deduplicateById([...directEdges, ...graphEdges])
  const enrichedChunks = await enrichChunksWithSources(sourceChunks)

  const ragContext: RAGContext = {
    sourceChunks: enrichedChunks,
    nodeSummaries: toNodeSummaries(allNodes).slice(0, 25),
    relationshipPaths: buildRelPaths(allNodes, allEdges).slice(0, 20),
  }

  onStepChange?.({ step: 'context_assembly', status: 'done', contextChunks: enrichedChunks.length, contextNodes: ragContext.nodeSummaries.length, relationshipPaths: ragContext.relationshipPaths.length })

  onStepChange?.({ step: 'generating', status: 'running' })
  const result = await generateFromContext(ragContext, question, conversationHistory, ctx, signal)

  return { answer: result.answer, citations: result.citations, sourceChunks: enrichedChunks, relatedNodes: allNodes, relatedEdges: allEdges, followUp: result.followUp }
}

async function pipelineEntityFindSimilar(
  question: string,
  userId: string,
  conversationHistory: { role: string; content: string }[],
  ctx: ChatEntryContext,
  onStepChange?: (event: RAGStepEvent) => void,
  signal?: AbortSignal
): Promise<RAGResponse> {
  const entityId = ctx.scope?.entityIds?.[0]
  if (!entityId) return queryGraph(question, userId, conversationHistory, resolveConfig(ctx), onStepChange, signal)

  onStepChange?.({ step: 'embedding', status: 'running' })

  // Fetch entity with its embedding
  const nodeWithEmb = await fetchNodeWithEmbedding(entityId, userId)
  if (!nodeWithEmb) return queryGraph(question, userId, conversationHistory, resolveConfig(ctx), onStepChange, signal)

  // Use the entity's own embedding for similarity search, or fall back to query embedding
  let searchEmbedding = nodeWithEmb.embedding
  if (!searchEmbedding || searchEmbedding.length === 0) {
    searchEmbedding = await embedQuery(`${nodeWithEmb.label} ${nodeWithEmb.description ?? ''}`)
  }

  onStepChange?.({ step: 'embedding', status: 'done', subQueries: [question], hasEmbedding: searchEmbedding.length > 0 })
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')

  onStepChange?.({ step: 'semantic_search', status: 'running' })

  const semanticNodes = searchEmbedding.length > 0
    ? await semanticSearchNodes(searchEmbedding, userId, { matchThreshold: 0.35, matchCount: 30 })
    : []

  onStepChange?.({ step: 'semantic_search', status: 'done', semanticNodes: semanticNodes.length })
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')

  onStepChange?.({ step: 'graph_traversal', status: 'running' })

  // 3-hop BFS for structural similarity
  const { nodes: graphNodes, edges: graphEdges } = await traverseGraphFromNodes([entityId], userId, 3)

  onStepChange?.({ step: 'graph_traversal', status: 'done', seedNodes: 1, graphNodes: graphNodes.length, graphEdges: graphEdges.length })
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')

  onStepChange?.({ step: 'context_assembly', status: 'running' })

  const allNodes = deduplicateById([nodeWithEmb as KnowledgeNode, ...graphNodes])

  const ragContext: RAGContext = {
    sourceChunks: [],
    nodeSummaries: toNodeSummaries(allNodes).slice(0, 30),
    relationshipPaths: buildRelPaths(allNodes, graphEdges).slice(0, 20),
  }

  onStepChange?.({ step: 'context_assembly', status: 'done', contextChunks: 0, contextNodes: ragContext.nodeSummaries.length, relationshipPaths: ragContext.relationshipPaths.length })

  onStepChange?.({ step: 'generating', status: 'running' })
  const result = await generateFromContext(ragContext, question, conversationHistory, ctx, signal)

  return { answer: result.answer, citations: result.citations, sourceChunks: [], relatedNodes: allNodes, relatedEdges: graphEdges, followUp: result.followUp }
}

async function pipelineRelationshipChat(
  question: string,
  userId: string,
  conversationHistory: { role: string; content: string }[],
  ctx: ChatEntryContext,
  onStepChange?: (event: RAGStepEvent) => void,
  signal?: AbortSignal
): Promise<RAGResponse> {
  const entityIds = ctx.scope?.entityIds ?? []
  if (entityIds.length < 2) return queryGraph(question, userId, conversationHistory, resolveConfig(ctx), onStepChange, signal)

  const fromId = entityIds[0]!
  const toId = entityIds[1]!

  onStepChange?.({ step: 'embedding', status: 'running' })
  onStepChange?.({ step: 'embedding', status: 'done', subQueries: [question], hasEmbedding: false })

  onStepChange?.({ step: 'semantic_search', status: 'running' })

  // Fetch both entities and the edge between them
  const [entities, directEdges] = await Promise.all([
    Promise.all([fetchNodeById(fromId), fetchNodeById(toId)]),
    fetchEntityDirectEdges(fromId, userId),
  ])

  const [entityA, entityB] = entities
  if (!entityA || !entityB) return queryGraph(question, userId, conversationHistory, resolveConfig(ctx), onStepChange, signal)

  // Fetch chunks for both entities' sources
  const sourceIds = [entityA.source_id, entityB.source_id].filter((id): id is string => !!id)
  const uniqueSourceIds = [...new Set(sourceIds)]

  const chunkArrays = await Promise.all(
    uniqueSourceIds.map(sid => fetchAllChunksForSource(sid, userId, 8))
  )

  onStepChange?.({ step: 'semantic_search', status: 'done', sources: uniqueSourceIds.length })
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')

  onStepChange?.({ step: 'graph_traversal', status: 'running' })

  // 1-hop from both
  const { nodes: graphNodes, edges: graphEdges } = await traverseGraphFromNodes([fromId, toId], userId, 1)

  onStepChange?.({ step: 'graph_traversal', status: 'done', seedNodes: 2, graphNodes: graphNodes.length, graphEdges: graphEdges.length })
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')

  onStepChange?.({ step: 'context_assembly', status: 'running' })

  const allChunks = chunkArrays.flat()
  const enrichedChunks = await enrichChunksWithSources(allChunks)
  const allNodes = deduplicateById([entityA, entityB, ...graphNodes])
  const allEdges = deduplicateById([...directEdges, ...graphEdges])

  const ragContext: RAGContext = {
    sourceChunks: enrichedChunks,
    nodeSummaries: toNodeSummaries(allNodes).slice(0, 15),
    relationshipPaths: buildRelPaths(allNodes, allEdges).slice(0, 15),
  }

  onStepChange?.({ step: 'context_assembly', status: 'done', contextChunks: enrichedChunks.length, contextNodes: ragContext.nodeSummaries.length, relationshipPaths: ragContext.relationshipPaths.length })

  onStepChange?.({ step: 'generating', status: 'running' })
  const result = await generateFromContext(ragContext, question, conversationHistory, ctx, signal)

  return { answer: result.answer, citations: result.citations, sourceChunks: enrichedChunks, relatedNodes: allNodes, relatedEdges: allEdges, followUp: result.followUp }
}

async function pipelineSourceChat(
  question: string,
  userId: string,
  conversationHistory: { role: string; content: string }[],
  ctx: ChatEntryContext,
  onStepChange?: (event: RAGStepEvent) => void,
  signal?: AbortSignal
): Promise<RAGResponse> {
  const sourceId = ctx.scope?.sourceIds?.[0]
  if (!sourceId) return queryGraph(question, userId, conversationHistory, resolveConfig(ctx), onStepChange, signal)

  onStepChange?.({ step: 'embedding', status: 'running' })
  onStepChange?.({ step: 'embedding', status: 'done', subQueries: [question], hasEmbedding: false })

  onStepChange?.({ step: 'semantic_search', status: 'running' })

  // Fetch source metadata, chunks, and entities in parallel
  const [sourceMap, chunks, entities] = await Promise.all([
    fetchSourcesByIds([sourceId]),
    fetchAllChunksForSource(sourceId, userId, 30),
    fetchEntitiesForSource(sourceId, userId),
  ])

  console.debug(`[ragRouter:source_chat] sourceId=${sourceId} chunks=${chunks.length} entities=${entities.length}`)

  // Zero-chunk fallback: try summary, then full content, then standard pipeline
  let effectiveChunks = chunks
  if (effectiveChunks.length === 0) {
    console.warn(`[ragRouter:source_chat] 0 chunks for source ${sourceId} — trying summary fallback`)
    effectiveChunks = sourceSummariesToChunks(sourceMap)
  }
  if (effectiveChunks.length === 0) {
    console.warn(`[ragRouter:source_chat] 0 summaries — trying full content fallback`)
    effectiveChunks = await fetchContentFallbackChunks([sourceId])
  }
  if (effectiveChunks.length === 0 && entities.length === 0) {
    return fallbackToStandard(question, userId, conversationHistory, ctx, onStepChange, signal)
  }

  onStepChange?.({ step: 'semantic_search', status: 'done', sources: 1, semanticChunks: effectiveChunks.length })
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')

  onStepChange?.({ step: 'graph_traversal', status: 'running' })

  // Internal edges within source entities
  const entityIds = entities.map(e => e.id)
  const internalEdges = await fetchEdgesBetweenEntities(entityIds, userId)

  onStepChange?.({ step: 'graph_traversal', status: 'done', seedNodes: entityIds.length, graphNodes: entities.length, graphEdges: internalEdges.length })
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')

  onStepChange?.({ step: 'context_assembly', status: 'running' })

  const enrichedChunks = await enrichChunksWithSources(effectiveChunks)

  const ragContext: RAGContext = {
    sourceChunks: enrichedChunks,
    nodeSummaries: toNodeSummaries(entities).slice(0, 25),
    relationshipPaths: buildRelPaths(entities, internalEdges).slice(0, 20),
  }

  onStepChange?.({ step: 'context_assembly', status: 'done', contextChunks: enrichedChunks.length, contextNodes: ragContext.nodeSummaries.length, relationshipPaths: ragContext.relationshipPaths.length })

  onStepChange?.({ step: 'generating', status: 'running' })
  const result = await generateFromContext(ragContext, question, conversationHistory, ctx, signal)

  return { answer: result.answer, citations: result.citations, sourceChunks: enrichedChunks, relatedNodes: entities, relatedEdges: internalEdges, followUp: result.followUp }
}

async function pipelineSourceAnchorRelate(
  question: string,
  userId: string,
  conversationHistory: { role: string; content: string }[],
  ctx: ChatEntryContext,
  onStepChange?: (event: RAGStepEvent) => void,
  signal?: AbortSignal
): Promise<RAGResponse> {
  const sourceId = ctx.scope?.sourceIds?.[0]
  const anchorId = ctx.scope?.anchorIds?.[0]
  if (!sourceId || !anchorId) return queryGraph(question, userId, conversationHistory, resolveConfig(ctx), onStepChange, signal)

  onStepChange?.({ step: 'embedding', status: 'running' })
  onStepChange?.({ step: 'embedding', status: 'done', subQueries: [question], hasEmbedding: false })

  onStepChange?.({ step: 'semantic_search', status: 'running' })

  // Source chunks + anchor node + anchor edges + source metadata
  const [sourceMap, sourceChunks, anchorNode, anchorEdges] = await Promise.all([
    fetchSourcesByIds([sourceId]),
    fetchAllChunksForSource(sourceId, userId, 20),
    fetchNodeById(anchorId),
    fetchEntityDirectEdges(anchorId, userId),
  ])

  // Zero-chunk fallback: try summary, then full content
  let effectiveChunks = sourceChunks
  if (effectiveChunks.length === 0) {
    console.warn(`[ragRouter:source_anchor_relate] 0 chunks for source ${sourceId} — trying summary fallback`)
    effectiveChunks = sourceSummariesToChunks(sourceMap)
  }
  if (effectiveChunks.length === 0) {
    effectiveChunks = await fetchContentFallbackChunks([sourceId])
  }

  onStepChange?.({ step: 'semantic_search', status: 'done', sources: 1, semanticChunks: effectiveChunks.length })
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')

  onStepChange?.({ step: 'graph_traversal', status: 'running' })

  // Find anchor neighbor node IDs
  const anchorNeighborIds = [...new Set(
    anchorEdges.flatMap(e => [e.source_node_id, e.target_node_id])
  )].filter(id => id !== anchorId)

  // Fetch source entities to find bridge entities
  const sourceEntities = await fetchEntitiesForSource(sourceId, userId)
  const bridgeEntities = sourceEntities.filter(e => anchorNeighborIds.includes(e.id))

  const allNodes = deduplicateById([...(anchorNode ? [anchorNode] : []), ...sourceEntities, ...bridgeEntities])

  // If still no content at all, fall back to standard
  if (effectiveChunks.length === 0 && allNodes.length === 0) {
    return fallbackToStandard(question, userId, conversationHistory, ctx, onStepChange, signal)
  }

  onStepChange?.({ step: 'graph_traversal', status: 'done', seedNodes: 2, graphNodes: allNodes.length, graphEdges: anchorEdges.length })
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')

  onStepChange?.({ step: 'context_assembly', status: 'running' })

  const enrichedChunks = await enrichChunksWithSources(effectiveChunks)

  const ragContext: RAGContext = {
    sourceChunks: enrichedChunks,
    nodeSummaries: toNodeSummaries(allNodes).slice(0, 25),
    relationshipPaths: buildRelPaths(allNodes, anchorEdges).slice(0, 15),
  }

  onStepChange?.({ step: 'context_assembly', status: 'done', contextChunks: enrichedChunks.length, contextNodes: ragContext.nodeSummaries.length, relationshipPaths: ragContext.relationshipPaths.length })

  onStepChange?.({ step: 'generating', status: 'running' })
  const result = await generateFromContext(ragContext, question, conversationHistory, ctx, signal)

  return { answer: result.answer, citations: result.citations, sourceChunks: enrichedChunks, relatedNodes: allNodes, relatedEdges: anchorEdges, followUp: result.followUp }
}

async function pipelineSourceCompare(
  question: string,
  userId: string,
  conversationHistory: { role: string; content: string }[],
  ctx: ChatEntryContext,
  onStepChange?: (event: RAGStepEvent) => void,
  signal?: AbortSignal
): Promise<RAGResponse> {
  const sourceIds = ctx.scope?.sourceIds ?? []
  if (sourceIds.length < 2) return queryGraph(question, userId, conversationHistory, resolveConfig(ctx), onStepChange, signal)

  const sourceIdA = sourceIds[0]!
  const sourceIdB = sourceIds[1]!

  onStepChange?.({ step: 'embedding', status: 'running' })
  onStepChange?.({ step: 'embedding', status: 'done', subQueries: [question], hasEmbedding: false })

  onStepChange?.({ step: 'semantic_search', status: 'running' })

  // Fetch source metadata, chunks, and entities for both sources in parallel
  const [sourceMap, chunksA, chunksB, entitiesA, entitiesB] = await Promise.all([
    fetchSourcesByIds([sourceIdA, sourceIdB]),
    fetchAllChunksForSource(sourceIdA, userId, 15),
    fetchAllChunksForSource(sourceIdB, userId, 15),
    fetchEntitiesForSource(sourceIdA, userId),
    fetchEntitiesForSource(sourceIdB, userId),
  ])

  console.debug(`[ragRouter:source_compare] A=${sourceIdA} chunks=${chunksA.length} entities=${entitiesA.length} | B=${sourceIdB} chunks=${chunksB.length} entities=${entitiesB.length}`)

  // Zero-chunk fallback: try summaries, then full source content, then standard pipeline
  let allChunks = [...chunksA, ...chunksB]
  if (allChunks.length === 0) {
    console.warn(`[ragRouter:source_compare] 0 chunks for both sources — trying summary fallback`)
    allChunks = sourceSummariesToChunks(sourceMap)
  }
  if (allChunks.length === 0) {
    console.warn(`[ragRouter:source_compare] 0 summaries — trying full content fallback`)
    allChunks = await fetchContentFallbackChunks([sourceIdA, sourceIdB])
  }
  if (allChunks.length === 0 && entitiesA.length === 0 && entitiesB.length === 0) {
    return fallbackToStandard(question, userId, conversationHistory, ctx, onStepChange, signal)
  }

  onStepChange?.({ step: 'semantic_search', status: 'done', sources: 2, semanticChunks: allChunks.length })
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')

  onStepChange?.({ step: 'graph_traversal', status: 'running' })

  // Cross-source edges
  const entityIdsA = entitiesA.map(e => e.id)
  const entityIdsB = entitiesB.map(e => e.id)
  const crossEdges = await fetchCrossSourceEdges(entityIdsA, entityIdsB, userId)

  onStepChange?.({ step: 'graph_traversal', status: 'done', seedNodes: entityIdsA.length + entityIdsB.length, graphNodes: entitiesA.length + entitiesB.length, graphEdges: crossEdges.length })
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')

  onStepChange?.({ step: 'context_assembly', status: 'running' })

  const enrichedChunks = await enrichChunksWithSources(allChunks)
  const allNodes = deduplicateById([...entitiesA, ...entitiesB])

  const ragContext: RAGContext = {
    sourceChunks: enrichedChunks,
    nodeSummaries: toNodeSummaries(allNodes).slice(0, 30),
    relationshipPaths: buildRelPaths(allNodes, crossEdges).slice(0, 20),
  }

  onStepChange?.({ step: 'context_assembly', status: 'done', contextChunks: enrichedChunks.length, contextNodes: ragContext.nodeSummaries.length, relationshipPaths: ragContext.relationshipPaths.length })

  onStepChange?.({ step: 'generating', status: 'running' })
  const result = await generateFromContext(ragContext, question, conversationHistory, ctx, signal)

  return { answer: result.answer, citations: result.citations, sourceChunks: enrichedChunks, relatedNodes: allNodes, relatedEdges: crossEdges, followUp: result.followUp }
}

// ─── Deduplication Helper ────────────────────────────────────────────────────

function deduplicateById<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>()
  return items.filter(item => {
    if (seen.has(item.id)) return false
    seen.add(item.id)
    return true
  })
}

// ─── Main Router ─────────────────────────────────────────────────────────────

export async function routedQuery(
  question: string,
  userId: string,
  conversationHistory: { role: string; content: string }[],
  entryContext: ChatEntryContext,
  onStepChange?: (event: RAGStepEvent) => void,
  signal?: AbortSignal
): Promise<RAGResponse> {
  const ep = entryContext.entryPoint

  switch (ep) {
    // Entity explore pipelines
    case 'entity_explore':
    case 'home_entity_explore':
    case 'explore_entity_browse':
    case 'explore_node_detail':
    case 'explore_entity_graph':
    case 'anchors_explore':
      return pipelineEntityExplore(question, userId, conversationHistory, entryContext, onStepChange, signal)

    // Find similar pipeline
    case 'entity_find_similar':
    case 'home_entity_similar':
      return pipelineEntityFindSimilar(question, userId, conversationHistory, entryContext, onStepChange, signal)

    // Relationship / connection pipeline
    case 'relationship_chat':
    case 'home_relationship_chat':
    case 'explore_source_connection':
      return pipelineRelationshipChat(question, userId, conversationHistory, entryContext, onStepChange, signal)

    // Single source pipeline
    case 'source_chat':
    case 'home_source_chat':
    case 'capture_post_extraction':
    case 'pipeline_extraction_detail':
      return pipelineSourceChat(question, userId, conversationHistory, entryContext, onStepChange, signal)

    // Source × anchor pipeline
    case 'source_anchor_relate':
    case 'home_source_anchor':
      return pipelineSourceAnchorRelate(question, userId, conversationHistory, entryContext, onStepChange, signal)

    // Source compare pipeline
    case 'source_compare':
    case 'home_source_compare':
      return pipelineSourceCompare(question, userId, conversationHistory, entryContext, onStepChange, signal)

    // Orient digest — broad graph search, standard pipeline
    case 'orient_digest_drilldown':
    case 'direct':
    case 'suggestion_pill':
    default:
      return queryGraph(question, userId, conversationHistory, resolveConfig(entryContext), onStepChange, signal)
  }
}
