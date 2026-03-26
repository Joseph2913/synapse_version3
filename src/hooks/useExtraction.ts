import { useState, useRef, useCallback, useEffect } from 'react'
import type {
  PipelineState,
  ExtractionConfig,
  ReviewEntity,
  SourceMetadata,
  UseExtractionReturn,
} from '../types/extraction'
import { useAuth } from './useAuth'
import { buildExtractionPrompt } from '../utils/promptBuilder'
import { chunkSourceContent } from '../utils/chunking'
import { resolveSummary } from '../utils/summarize'
import { extractEntities, generateEmbeddings } from '../services/gemini'
import {
  saveSource,
  saveNodes,
  saveEdges,
  updateNodeEmbeddings,
  saveChunks,
  saveExtractionSession,
} from '../services/extractionPersistence'
import { checkDuplicateNodes, supabase } from '../services/supabase'
import { discoverCrossConnections, saveCrossConnectionEdges } from '../services/crossConnections'

const INITIAL_STATE: PipelineState = {
  step: 'idle',
  entities: null,
  relationships: null,
  sourceId: null,
  savedNodes: null,
  savedEdgeIds: null,
  crossConnectionCount: 0,
  error: null,
  elapsedMs: 0,
  embeddingProgress: null,
  statusText: '',
  duplicatesSkipped: 0,
}

export function useExtraction(): UseExtractionReturn {
  const [state, setState] = useState<PipelineState>(INITIAL_STATE)
  const { user } = useAuth()

  // Refs for data persistence across async steps
  const contentRef = useRef<string>('')
  const configRef = useRef<ExtractionConfig | null>(null)
  const metadataRef = useRef<SourceMetadata | null>(null)
  const sourceIdRef = useRef<string | null>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const startTimeRef = useRef<number>(0)

  // Timer management
  const startTimer = useCallback(() => {
    stopTimer()
    startTimeRef.current = Date.now()
    timerRef.current = setInterval(() => {
      setState(prev => ({
        ...prev,
        elapsedMs: Date.now() - startTimeRef.current,
      }))
    }, 1000)
  }, [])

  const stopTimer = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
  }, [])

  // Cleanup on unmount
  useEffect(() => {
    return () => stopTimer()
  }, [stopTimer])

  // Helper to update state
  const update = useCallback((patch: Partial<PipelineState>) => {
    setState(prev => ({ ...prev, ...patch }))
  }, [])

  // --- start: Steps 1-3, then pause at 'reviewing' ---
  const start = useCallback(
    async (content: string, config: ExtractionConfig, metadata: SourceMetadata) => {
      if (!user?.id) return
      const userId = user.id

      contentRef.current = content
      configRef.current = config
      metadataRef.current = metadata

      startTimer()

      try {
        // Step 1: Save source
        update({ step: 'saving_source', statusText: 'Saving source content...' })
        const sourceId = await saveSource(userId, content, metadata)
        sourceIdRef.current = sourceId
        update({ sourceId })

        // Step 2: Summarize (non-blocking — failures don't halt pipeline)
        update({ step: 'summarizing', statusText: 'Generating summary...' })
        try {
          const summaryResult = await resolveSummary(
            metadata.sourceType,
            content,
            null // metadata from source row not available yet; extraction metadata is minimal
          )
          if (summaryResult) {
            await supabase
              .from('knowledge_sources')
              .update({
                summary: summaryResult.summary,
                summary_source: summaryResult.source,
              })
              .eq('id', sourceId)
          }
        } catch (summaryErr) {
          console.warn('[useExtraction] Summary generation failed (non-blocking):', summaryErr)
        }

        // Step 3: Compose prompt
        update({ step: 'composing_prompt', statusText: 'Composing extraction prompt...' })
        const systemPrompt = buildExtractionPrompt(config)

        // Step 3: Extract entities
        update({ step: 'extracting', statusText: 'Waiting for Gemini extraction...' })
        const result = await extractEntities(content, systemPrompt)

        // Convert to ReviewEntity[]
        const reviewEntities: ReviewEntity[] = result.entities.map(e => ({
          ...e,
          removed: false,
          edited: false,
        }))

        const entityCount = result.entities.length
        const relCount = result.relationships.length

        update({
          step: 'reviewing',
          entities: reviewEntities,
          relationships: result.relationships,
          statusText: `Found ${entityCount} entities and ${relCount} relationships`,
        })

        // Pipeline pauses here — user reviews and calls approveAndSave
      } catch (err) {
        stopTimer()
        const error = err instanceof Error ? err : new Error(String(err))
        update({
          step: 'error',
          error,
          statusText: `Error: ${error.message}`,
        })
      }
    },
    [user, startTimer, stopTimer, update]
  )

  // --- approveAndSave: Steps 5-8 ---
  const approveAndSave = useCallback(
    async (reviewedEntities: ReviewEntity[]) => {
      if (!user?.id || !sourceIdRef.current) return
      const userId = user.id
      const sourceId = sourceIdRef.current
      const content = contentRef.current
      const config = configRef.current
      const metadata = metadataRef.current

      // Update entities in state
      update({ entities: reviewedEntities })

      try {
        // Step 5: Save nodes + edges
        update({ step: 'saving_nodes', statusText: 'Saving entities to your knowledge graph...' })

        const included = reviewedEntities.filter(e => !e.removed)
        const removedLabels = new Set(
          reviewedEntities.filter(e => e.removed).map(e => e.label.toLowerCase())
        )

        // Check for duplicates
        const existingLabels = await checkDuplicateNodes(
          included.map(e => e.label),
          userId
        )

        const sourceName = metadata?.title || deriveQuickTitle(content)
        const savedNodes = await saveNodes(userId, reviewedEntities, sourceId, {
          sourceName,
          sourceType: metadata?.sourceType || 'Note',
          sourceUrl: metadata?.sourceUrl,
        }, existingLabels)

        const duplicatesSkipped = included.length - savedNodes.length

        const savedEdgeIds = await saveEdges(
          userId,
          state.relationships ?? [],
          savedNodes,
          removedLabels
        )

        update({ savedNodes, savedEdgeIds, duplicatesSkipped })

        // Step 6: Generate embeddings
        update({ step: 'generating_embeddings', statusText: 'Generating embeddings...' })

        if (savedNodes.length > 0) {
          const texts = savedNodes.map(n => {
            const entity = reviewedEntities.find(
              e => e.label.toLowerCase() === n.label.toLowerCase()
            )
            // Include entity_type for richer semantic vectors (aligns with backend)
            return `${entity?.entity_type ?? n.entity_type}: ${n.label} — ${entity?.description || ''}`
          })

          const embeddings = await generateEmbeddings(texts, 5, (completed, total) => {
            update({
              embeddingProgress: { completed, total },
              statusText: `Generating embedding ${completed} of ${total}...`,
            })
          })

          // Update nodes with embeddings (skip nulls)
          const nodesToUpdate: Array<{ id: string; embedding: number[] }> = []
          embeddings.forEach((emb, i) => {
            const node = savedNodes[i]
            if (emb && node) {
              nodesToUpdate.push({ id: node.id, embedding: emb })
            } else if (!emb && node) {
              console.warn(`[useExtraction] Embedding failed for: ${node.label}`)
            }
          })

          if (nodesToUpdate.length > 0) {
            await updateNodeEmbeddings(nodesToUpdate)
          }
        }

        // Step 7: Chunk source
        update({
          step: 'chunking_source',
          statusText: 'Chunking source for RAG retrieval...',
          embeddingProgress: null,
        })

        let chunkCount = 0
        try {
          const chunks = chunkSourceContent(content)
          if (chunks.length > 0) {
            update({
              statusText: `Embedding ${chunks.length} source chunks...`,
            })

            const chunkEmbeddings = await generateEmbeddings(chunks, 5)
            await saveChunks(userId, sourceId, chunks, chunkEmbeddings)
            chunkCount = chunks.length
          }
        } catch (chunkErr) {
          console.warn('[useExtraction] Chunking/chunk embedding failed:', chunkErr)
          // Continue — chunking failure is non-fatal
        }

        // Step 8: Discover cross-connections
        update({
          step: 'discovering_connections',
          statusText: `Checking ${savedNodes.length} new entities against existing graph...`,
        })

        let crossConnectionCount = 0
        let crossEdgeIds: string[] = []
        try {
          if (savedNodes.length > 0) {
            const crossEdges = await discoverCrossConnections(
              savedNodes.map(n => n.id),
              userId
            )
            crossConnectionCount = crossEdges.length

            if (crossEdges.length > 0) {
              crossEdgeIds = await saveCrossConnectionEdges(userId, crossEdges)
            }
          }
        } catch (crossErr) {
          console.warn('[useExtraction] Cross-connection discovery failed:', crossErr)
          // Continue — cross-connection failure is non-fatal
        }

        // Record the extraction session
        stopTimer()
        const durationMs = Date.now() - startTimeRef.current

        await saveExtractionSession(userId, {
          sourceName,
          sourceType: metadata?.sourceType || 'Note',
          contentPreview: content,
          extractionMode: config?.mode || 'comprehensive',
          anchorEmphasis: config?.anchorEmphasis || 'standard',
          userGuidance: config?.customGuidance,
          selectedAnchorIds: config?.anchors.map(() => ''), // simplified
          extractedNodeIds: savedNodes.map(n => n.id),
          extractedEdgeIds: [...savedEdgeIds, ...crossEdgeIds],
          entityCount: savedNodes.length,
          relationshipCount: savedEdgeIds.length + crossEdgeIds.length,
          chunkCount,
          crossConnectionCount,
          durationMs,
        })

        update({
          step: 'complete',
          crossConnectionCount,
          statusText: 'Extraction complete!',
          elapsedMs: durationMs,
        })
      } catch (err) {
        stopTimer()
        const error = err instanceof Error ? err : new Error(String(err))
        update({
          step: 'error',
          error,
          statusText: `Error: ${error.message}`,
        })
      }
    },
    [user, state.relationships, stopTimer, update]
  )

  // --- reExtract: Restart from step 2 ---
  const reExtract = useCallback(async () => {
    if (!user?.id || !contentRef.current || !configRef.current) return

    update({
      step: 'composing_prompt',
      entities: null,
      relationships: null,
      error: null,
      statusText: 'Re-composing extraction prompt...',
    })

    try {
      const systemPrompt = buildExtractionPrompt(configRef.current)

      update({ step: 'extracting', statusText: 'Re-extracting with Gemini...' })
      const result = await extractEntities(contentRef.current, systemPrompt)

      const reviewEntities: ReviewEntity[] = result.entities.map(e => ({
        ...e,
        removed: false,
        edited: false,
      }))

      update({
        step: 'reviewing',
        entities: reviewEntities,
        relationships: result.relationships,
        statusText: `Found ${result.entities.length} entities and ${result.relationships.length} relationships`,
      })
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      update({
        step: 'error',
        error,
        statusText: `Error: ${error.message}`,
      })
    }
  }, [user, update])

  // --- reset: Return to idle ---
  const reset = useCallback(() => {
    stopTimer()
    contentRef.current = ''
    configRef.current = null
    metadataRef.current = null
    sourceIdRef.current = null
    setState(INITIAL_STATE)
  }, [stopTimer])

  return { state, start, approveAndSave, reExtract, reset }
}

function deriveQuickTitle(content: string): string {
  const trimmed = content.trim()
  const firstLine = (trimmed.split('\n')[0] ?? '').trim()
  return firstLine.length <= 60 ? firstLine : firstLine.substring(0, 60) + '...'
}
