import { generateRAGResponse, decomposeQuery, embedQuery } from './gemini'
import { classifyQuery, mapIntentToMindset } from './queryClassifier'
import type { QueryClassification } from './queryClassifier'
import { getResponseFormatForClassification } from '../config/responseFormats'
import {
  keywordSearchChunks,
  fetchChunksForSources,
  keywordSearchNodes,
  keywordSearchSources,
  semanticSearchChunks,
  semanticSearchNodes,
  traverseGraphFromNodes,
  fetchSourcesByIds,
  fetchNodesByIds,
  fetchTopNodes,
} from './supabase'
import type {
  RAGStepEvent,
  RAGContext,
  RAGResponseContext,
  EnrichedChunk,
  NodeSummary,
  RelationshipPath,
  InlineCitation,
  SemanticChunkResult,
  KeywordNodeResult,
  KeywordSourceResult,
  QueryConfig,
} from '../types/rag'
import { QUERY_MINDSETS, MODEL_TIERS, DEFAULT_MINDSET_ID, DEFAULT_MODEL_TIER_ID } from '../config/queryMindsets'
import { TOOL_MODES, DEFAULT_TOOL_MODE_ID } from '../config/toolModes'
import type { SemanticNodeResult } from './supabase'
import type { KnowledgeNode, KnowledgeEdge } from '../types/database'

// ─── Deduplication Helpers ────────────────────────────────────────────────────

function deduplicateNodes(nodes: KnowledgeNode[]): KnowledgeNode[] {
  const seen = new Set<string>()
  return nodes.filter(n => { if (seen.has(n.id)) return false; seen.add(n.id); return true })
}

function deduplicateKeywordNodes(nodes: KeywordNodeResult[]): KeywordNodeResult[] {
  const seen = new Set<string>()
  return nodes.filter(n => { if (seen.has(n.id)) return false; seen.add(n.id); return true })
}

function deduplicateChunks(chunks: SemanticChunkResult[]): SemanticChunkResult[] {
  const seen = new Set<string>()
  return chunks.filter(c => { if (seen.has(c.id)) return false; seen.add(c.id); return true })
}

function deduplicateSources(sources: KeywordSourceResult[]): KeywordSourceResult[] {
  const seen = new Set<string>()
  return sources.filter(s => { if (seen.has(s.id)) return false; seen.add(s.id); return true })
}

// ─── Source-balanced Chunk Selection ─────────────────────────────────────────

/**
 * Selects up to `maxTotal` chunks while guaranteeing at least `minPerSource`
 * from each source that has chunks available. This prevents any single source
 * from dominating the context window on comparison queries.
 *
 * Pass-1: take minPerSource from each source (in ranked order within source).
 * Pass-2: fill remaining slots with the highest-ranked chunks not yet selected.
 * Final: re-sort by similarity so Gemini sees the strongest evidence first.
 */
function balanceChunksBySource(
  ranked: SemanticChunkResult[],
  maxTotal: number,
  minPerSource: number
): SemanticChunkResult[] {
  const bySource = new Map<string, SemanticChunkResult[]>()
  for (const chunk of ranked) {
    if (!bySource.has(chunk.source_id)) bySource.set(chunk.source_id, [])
    bySource.get(chunk.source_id)!.push(chunk)
  }

  const selected = new Set<string>()
  const result: SemanticChunkResult[] = []

  // Pass 1: guarantee minimum coverage per source
  for (const sourceChunks of bySource.values()) {
    for (const chunk of sourceChunks.slice(0, minPerSource)) {
      if (!selected.has(chunk.id)) {
        selected.add(chunk.id)
        result.push(chunk)
      }
    }
  }

  // Pass 2: fill remainder with top-ranked across all sources
  for (const chunk of ranked) {
    if (result.length >= maxTotal) break
    if (!selected.has(chunk.id)) {
      selected.add(chunk.id)
      result.push(chunk)
    }
  }

  return result.sort((a, b) => b.similarity - a.similarity)
}

// ─── Lightweight Reranking (Approach 4) ──────────────────────────────────────

/**
 * Hybrid reranking: combines keyword term-frequency with semantic cosine similarity.
 *
 * Scoring formula per chunk:
 *   base similarity  (1.0 for keyword/source chunks; cosine score for semantic-only)
 *   + each matching query term adds 0.05
 *   + if also found by semantic search: cosine_similarity × 0.3 bonus
 *
 * Chunks found by BOTH keyword and semantic search rank highest.
 * Pure semantic chunks with high cosine similarity can outrank pure keyword chunks.
 * Low-similarity semantic-only chunks (threshold 0.4) score below keyword chunks.
 */
function scoreChunks(
  chunks: SemanticChunkResult[],
  question: string,
  semanticScores?: Map<string, number>
): SemanticChunkResult[] {
  const terms = question
    .toLowerCase()
    .split(/\s+/)
    .map(w => w.replace(/[^a-z0-9]/g, ''))
    .filter(w => w.length >= 3)

  return chunks
    .map(chunk => {
      const lc = chunk.content.toLowerCase()
      const termHits = terms.filter(t => lc.includes(t)).length
      const semanticSimilarity = semanticScores?.get(chunk.id) ?? 0
      return { ...chunk, similarity: chunk.similarity + termHits * 0.05 + semanticSimilarity * 0.3 }
    })
    .sort((a, b) => b.similarity - a.similarity)
}

// ─── Context Builders ─────────────────────────────────────────────────────────

function buildRelationshipPaths(
  nodes: KnowledgeNode[],
  edges: KnowledgeEdge[]
): RelationshipPath[] {
  const nodeMap = new Map<string, string>()
  for (const node of nodes) nodeMap.set(node.id, node.label)
  const paths: RelationshipPath[] = []
  for (const edge of edges) {
    const from = nodeMap.get(edge.source_node_id)
    const to = nodeMap.get(edge.target_node_id)
    if (!from || !to) continue
    paths.push({
      from,
      relation: edge.relation_type ?? 'relates_to',
      to,
      evidence: edge.evidence ?? undefined,
    })
  }
  return paths
}

async function enrichChunks(chunks: SemanticChunkResult[]): Promise<EnrichedChunk[]> {
  if (chunks.length === 0) return []
  const sourceIds = chunks.map(c => c.source_id)
  const sourceMap = await fetchSourcesByIds(sourceIds)
  return chunks.map(chunk => {
    const source = sourceMap.get(chunk.source_id)
    return {
      id: chunk.id,
      source_id: chunk.source_id,
      content: chunk.content,
      similarity: chunk.similarity,
      sourceTitle: (() => {
        const t = source?.title?.trim()
        const isPlaceholder = !t || /^(untitled|untitled meeting|untitled document|transcript)$/i.test(t)
        if (!isPlaceholder) return t!
        if (source?.source_type === 'Meeting') return 'Meeting Recording'
        if (source?.source_type === 'YouTube') return 'YouTube Video'
        return 'Unknown Source'
      })(),
      sourceType: source?.source_type ?? 'Document',
      sourceCreatedAt: source?.created_at ?? new Date().toISOString(),
      sourceSummary: source?.summary ?? null,
    }
  })
}

async function resolveCitations(
  rawCitations: InlineCitation[],
  _userId: string
): Promise<InlineCitation[]> {
  const nodeIds = rawCitations
    .map(c => c.node_id)
    .filter((id): id is string => id !== null && id.length > 0)
  if (nodeIds.length === 0) return rawCitations
  const nodes = await fetchNodesByIds(nodeIds)
  const nodeMap = new Map(nodes.map(n => [n.id, n]))
  return rawCitations.map(citation => {
    if (!citation.node_id) return citation
    const node = nodeMap.get(citation.node_id)
    if (!node) return citation
    return { ...citation, label: node.label, entity_type: node.entity_type }
  })
}

function enrichCitationsWithSnippets(
  citations: InlineCitation[],
  enrichedChunks: EnrichedChunk[]
): InlineCitation[] {
  return citations.map(citation => {
    if (!citation.source_id) return citation
    const chunk = enrichedChunks.find(c =>
      c.source_id === citation.source_id &&
      (citation.chunk_index === null || c.source_id === citation.source_id)
    )
    if (!chunk) return citation
    return { ...citation, snippet: chunk.content.slice(0, 120) }
  })
}

function formatSourceContext(sources: KeywordSourceResult[]): string {
  if (sources.length === 0) return ''
  return sources
    .map(s => `- "${s.title ?? 'Untitled'}" (${s.source_type ?? 'Document'}, ${new Date(s.created_at).toLocaleDateString()})`)
    .join('\n')
}

// ─── Main RAG Pipeline ────────────────────────────────────────────────────────

export interface RAGResponse {
  answer: string
  citations: InlineCitation[]
  sourceChunks: EnrichedChunk[]
  relatedNodes: KnowledgeNode[]
  relatedEdges: KnowledgeEdge[]
  followUp?: {
    question: string
    label: string
  }
}

/**
 * 5-approach RAG pipeline:
 *
 * Approach 1 — Source Chunk Retrieval:
 *   Source-first: find relevant documents by title → pull their chunks in order.
 *   Fallback: keyword search across all chunk content.
 *
 * Approach 2 — Hybrid Search:
 *   Keyword search on sources, nodes, and chunks in parallel.
 *   (Semantic/vector search blocked by embedding dimension mismatch in DB —
 *   requires server-side re-embedding to fix.)
 *
 * Approach 3 — Graph Traversal:
 *   2-hop expansion from keyword-matched entity nodes, up to 50 context nodes.
 *
 * Approach 4 — Reranking:
 *   Lightweight term-frequency reranking of retrieved chunks before sending to Gemini.
 *
 * Approach 5 — Query Decomposition:
 *   Complex multi-concept queries are decomposed into 2-3 sub-queries by Gemini.
 *   Each sub-query runs its own retrieval pass; results are merged and deduplicated.
 */
export async function queryGraph(
  question: string,
  userId: string,
  conversationHistory: { role: string; content: string }[],
  queryConfig?: QueryConfig,
  onStepChange?: (event: RAGStepEvent) => void,
  signal?: AbortSignal
): Promise<RAGResponse> {
  const checkAbort = () => {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
  }

  // Resolve tool mode config
  const toolModeId = queryConfig?.toolMode ?? DEFAULT_TOOL_MODE_ID
  const toolModeConfig = TOOL_MODES.find(m => m.id === toolModeId)?.pipelineOverrides
    ?? TOOL_MODES.find(m => m.id === DEFAULT_TOOL_MODE_ID)!.pipelineOverrides

  // Resolve mindset — auto mode runs classifier (PRD-C §2.7)
  const mindsetId = queryConfig?.mindset ?? DEFAULT_MINDSET_ID
  let classification: QueryClassification | null = null
  let effectiveMindsetId = mindsetId
  let responseFormatInstruction: string | undefined
  let thinkingBudget: number | undefined

  if (mindsetId === 'auto') {
    // Build conversation context from last few messages for classifier
    const recentContext = conversationHistory.slice(-2).map(m => m.content).join(' ')
    classification = await classifyQuery(question, recentContext || undefined)
    console.debug('[rag] auto-classification:', classification)

    // Map classifier intent to existing mindset for promptAddition
    effectiveMindsetId = mapIntentToMindset(classification.intent)
    responseFormatInstruction = getResponseFormatForClassification(classification.responseFormat)
    thinkingBudget = classification.thinkingBudget
  } else {
    // Manual mindset — default thinking budget of 1024
    thinkingBudget = queryConfig?.thinkingBudget ?? 1024
    responseFormatInstruction = queryConfig?.responseFormat
      ? getResponseFormatForClassification(queryConfig.responseFormat)
      : undefined
  }

  const mindset = QUERY_MINDSETS.find(m => m.id === effectiveMindsetId)

  // Resolve model tier
  const modelTierId = queryConfig?.modelTier ?? DEFAULT_MODEL_TIER_ID
  const modelTier = MODEL_TIERS.find(t => t.id === modelTierId)

  // ─── Approach 5: Query Decomposition + Embedding (parallel) ──────────────
  onStepChange?.({ step: 'embedding', status: 'running' })
  const [subQueries, queryEmbedding] = await Promise.all([
    decomposeQuery(question),
    embedQuery(question),
  ])
  const hasEmbedding = queryEmbedding.length > 0
  console.debug('[rag] sub-queries:', subQueries, '| embedding:', hasEmbedding ? '3072-dim' : 'failed (keyword-only fallback)')
  onStepChange?.({ step: 'embedding', status: 'done', subQueries, hasEmbedding })
  checkAbort()

  // ─── Approach 2: Hybrid retrieval — keyword + semantic in parallel ─────────
  onStepChange?.({ step: 'semantic_search', status: 'running' })

  const [retrievalResults, semanticChunks, semanticNodes] = await Promise.all([
    // Keyword search per sub-query
    Promise.all(
      subQueries.map(sq =>
        Promise.all([
          keywordSearchSources(sq, userId, { limit: 4 }),
          keywordSearchNodes(sq, userId, { limit: 8 }),
        ])
      )
    ),
    // Semantic chunk search (returns [] if no embedding)
    hasEmbedding
      ? semanticSearchChunks(queryEmbedding, userId, { matchThreshold: 0.4, matchCount: 15 })
      : Promise.resolve([] as SemanticChunkResult[]),
    // Semantic node search (returns [] if no embedding)
    hasEmbedding
      ? semanticSearchNodes(queryEmbedding, userId, { matchThreshold: 0.4, matchCount: 20 })
      : Promise.resolve([] as SemanticNodeResult[]),
  ])
  checkAbort()

  // Merge and deduplicate across all sub-queries
  const allSources = deduplicateSources(retrievalResults.flatMap(([s]) => s))
  const allKeywordNodes = deduplicateKeywordNodes(retrievalResults.flatMap(([, n]) => n))

  console.debug('[rag] sources:', allSources.length, '| keyword nodes:', allKeywordNodes.length, '| semantic chunks:', semanticChunks.length, '| semantic nodes:', semanticNodes.length)
  onStepChange?.({ step: 'semantic_search', status: 'done', sources: allSources.length, keywordNodes: allKeywordNodes.length, semanticChunks: semanticChunks.length, semanticNodes: semanticNodes.length })
  onStepChange?.({ step: 'keyword_search', status: 'running' })

  // ─── Approach 1: Source-first (per-source) + keyword chunks + semantic chunks ──
  // Fetch per-source so each document contributes chunks independently.
  const perSourceLimit = Math.max(4, Math.ceil(toolModeConfig.chunkCount / Math.max(1, allSources.length)))
  const [perSourceChunkArrays, keywordChunkArrays] = await Promise.all([
    allSources.length > 0
      ? Promise.all(allSources.map(s => fetchChunksForSources([s.id], userId, { limit: perSourceLimit })))
      : Promise.resolve([] as SemanticChunkResult[][]),
    Promise.all(subQueries.map(sq => keywordSearchChunks(sq, userId, { limit: toolModeConfig.chunkCount }))),
  ])

  // Merge all chunk sources; deduplicate by ID
  const rawChunks = deduplicateChunks([
    ...perSourceChunkArrays.flat(),
    ...keywordChunkArrays.flat(),
    ...semanticChunks,
  ])

  console.debug('[rag] raw chunks (merged):', rawChunks.length)
  checkAbort()

  // ─── Approach 4: Hybrid reranking + source-balanced selection ─────────────
  const semanticScores = new Map(semanticChunks.map(c => [c.id, c.similarity]))
  const rankedChunks = scoreChunks(rawChunks, question, semanticScores)

  // When multiple sources are present, guarantee each source gets ≥2 slots before
  // filling the remainder with the highest-ranked chunks from any source.
  const finalChunkCount = Math.max(toolModeConfig.maxContextChunks, Math.min(toolModeConfig.chunkCount, allSources.length * 4))
  const balancedChunks = balanceChunksBySource(rankedChunks, finalChunkCount, 2)
  onStepChange?.({ step: 'keyword_search', status: 'done', rawChunks: rawChunks.length, rankedChunks: balancedChunks.length })

  // ─── Approach 3: Graph traversal from keyword + semantic nodes ────────────
  onStepChange?.({ step: 'graph_traversal', status: 'running' })

  // Combine keyword and semantic node IDs as graph traversal seeds (deduplicated)
  const combinedNodeIds = [...new Set([
    ...allKeywordNodes.map(n => n.id),
    ...semanticNodes.map(n => n.id),
  ])]

  let seedNodeIds = combinedNodeIds
  let fallbackNodes: KeywordNodeResult[] = []

  if (seedNodeIds.length === 0) {
    fallbackNodes = await fetchTopNodes(userId, { limit: 12, anchorsOnly: true })
    if (fallbackNodes.length === 0) {
      fallbackNodes = await fetchTopNodes(userId, { limit: 12 })
    }
    seedNodeIds = fallbackNodes.map(n => n.id)
  }

  // Use tool mode's frontier limit for seeds
  const { nodes: graphNodes, edges: graphEdges } = seedNodeIds.length > 0
    ? await traverseGraphFromNodes(seedNodeIds.slice(0, toolModeConfig.maxFrontier), userId, toolModeConfig.traversalHops)
    : { nodes: [] as KnowledgeNode[], edges: [] as KnowledgeEdge[] }
  onStepChange?.({ step: 'graph_traversal', status: 'done', seedNodes: seedNodeIds.length, graphNodes: graphNodes.length, graphEdges: graphEdges.length })
  checkAbort()

  // ─── Context assembly ─────────────────────────────────────────────────────
  onStepChange?.({ step: 'context_assembly', status: 'running' })

  let enrichedChunks = await enrichChunks(balancedChunks)
  checkAbort()

  // Timeline mode: sort chronologically (oldest first) instead of by similarity
  if (queryConfig?.toolMode === 'timeline') {
    enrichedChunks = [...enrichedChunks].sort((a, b) =>
      new Date(a.sourceCreatedAt).getTime() - new Date(b.sourceCreatedAt).getTime()
    )
  }

  const effectiveKeywordNodes = allKeywordNodes.length > 0 ? allKeywordNodes : fallbackNodes
  const kwNodeSummaries: NodeSummary[] = deduplicateKeywordNodes(effectiveKeywordNodes)
    .slice(0, Math.ceil(toolModeConfig.maxNodeSummaries / 2))
    .map(n => ({ id: n.id, label: n.label, entity_type: n.entity_type, description: n.description }))

  const graphNodeSummaries: NodeSummary[] = deduplicateNodes(graphNodes)
    .slice(0, toolModeConfig.maxNodeSummaries)
    .map(n => ({ id: n.id, label: n.label, entity_type: n.entity_type, description: n.description ?? null }))

  // Include top semantic nodes (high cosine similarity → most conceptually related)
  const semanticNodeSummaries: NodeSummary[] = semanticNodes
    .slice(0, 10)
    .map(n => ({ id: n.id, label: n.label, entity_type: n.entity_type, description: n.description }))

  const allNodeSummaries = deduplicateKeywordNodes([
    ...kwNodeSummaries,
    ...graphNodeSummaries,
    ...semanticNodeSummaries,
  ] as unknown as KeywordNodeResult[])
    .slice(0, toolModeConfig.maxNodeSummaries) as unknown as NodeSummary[]

  const sourceContextNote = formatSourceContext(allSources)

  const context: RAGContext = {
    sourceChunks: enrichedChunks,
    nodeSummaries: allNodeSummaries,
    relationshipPaths: buildRelationshipPaths(graphNodes, graphEdges).slice(0, toolModeConfig.maxRelPaths),
  }
  onStepChange?.({ step: 'context_assembly', status: 'done', contextChunks: enrichedChunks.length, contextNodes: allNodeSummaries.length, relationshipPaths: context.relationshipPaths.length })

  // ─── Generate response ────────────────────────────────────────────────────
  onStepChange?.({ step: 'generating', status: 'running' })

  // Apply mindset and model tier to generation
  const temperature = mindset?.temperatureOverride ?? modelTier?.generationConfig.temperature
  const maxOutputTokens = modelTier?.generationConfig.maxOutputTokens

  const generationResult = await generateRAGResponse(
    context,
    question,
    conversationHistory.slice(-6),
    sourceContextNote,
    mindset?.promptAddition,
    temperature,
    maxOutputTokens,
    queryConfig?.systemDirective,
    responseFormatInstruction,
    thinkingBudget
  )
  checkAbort()

  // ─── Resolve citations & enrich with snippets ─────────────────────────────
  const resolvedCitations = await resolveCitations(generationResult.citations, userId)
  const enrichedCitations = enrichCitationsWithSnippets(resolvedCitations, enrichedChunks)

  return {
    answer: generationResult.answer,
    citations: enrichedCitations,
    sourceChunks: enrichedChunks,
    relatedNodes: graphNodes,
    relatedEdges: graphEdges,
    followUp: generationResult.followUp,
  }
}

// ─── Build RAGResponseContext ─────────────────────────────────────────────────

export function buildRAGResponseContext(response: RAGResponse): RAGResponseContext {
  return {
    sourceChunks: response.sourceChunks,
    relatedNodes: response.relatedNodes,
    relatedEdges: response.relatedEdges,
    citations: response.citations,
  }
}
