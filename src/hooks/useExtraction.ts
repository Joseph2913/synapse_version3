import { useState, useRef, useCallback, useEffect } from 'react'
import type {
  PipelineState,
  ExtractionConfig,
  ReviewEntity,
  SourceMetadata,
  UseExtractionReturn,
  ExtractedRelationship,
  ExtractedEntity,
} from '../types/extraction'
import { useAuth } from './useAuth'
import { resolveSummary } from '../utils/summarize'
import {
  saveSource,
  saveExtractionSession,
} from '../services/extractionPersistence'
import { supabase } from '../services/supabase'

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
  nearDuplicates: null,
  reusedNodeCount: 0,
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
            null
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

        // Step 3: Call extract-preview serverless endpoint
        update({ step: 'extracting', statusText: 'Waiting for Gemini extraction...' })

        const { data: { session: currentSession } } = await supabase.auth.getSession()
        if (!currentSession?.access_token) {
          throw new Error('No auth session available')
        }

        const previewRes = await fetch('/api/ingest/extract-preview', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${currentSession.access_token}`,
          },
          body: JSON.stringify({
            content,
            sourceId,
            config: {
              mode: config.mode,
              anchorEmphasis: config.anchorEmphasis,
              anchors: config.anchors,
              userProfile: config.userProfile,
              customGuidance: config.customGuidance,
            },
          }),
        })

        if (!previewRes.ok) {
          const err = await previewRes.json().catch(() => ({ error: 'Extraction failed' })) as { error?: string }
          throw new Error(err.error ?? 'Extraction failed')
        }

        const previewData = await previewRes.json() as {
          entities: ExtractedEntity[]
          relationships: ExtractedRelationship[]
          stats?: unknown
        }

        // Convert to ReviewEntity[]
        const reviewEntities: ReviewEntity[] = previewData.entities.map(e => ({
          ...e,
          removed: false,
          edited: false,
        }))

        const entityCount = previewData.entities.length
        const relCount = previewData.relationships.length

        update({
          step: 'reviewing',
          entities: reviewEntities,
          relationships: previewData.relationships,
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

  // --- approveAndSave: Persist reviewed entities via serverless ---
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
        update({ step: 'saving_nodes', statusText: 'Saving entities to your knowledge graph...' })

        const included = reviewedEntities.filter(e => !e.removed)

        const { data: { session: currentSession } } = await supabase.auth.getSession()
        if (!currentSession?.access_token) {
          throw new Error('No auth session available')
        }

        const persistRes = await fetch('/api/ingest/extract-persist', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${currentSession.access_token}`,
          },
          body: JSON.stringify({
            sourceId,
            content,
            entities: included,
            relationships: state.relationships ?? [],
            sourceContext: {
              sourceType: metadata?.sourceType ?? 'paste',
              sourceUrl: metadata?.sourceUrl ?? null,
              sourceLabel: metadata?.title ?? null,
            },
            enableFuzzyDedup: true,
            enableCrossConnections: true,
          }),
        })

        if (!persistRes.ok) {
          const err = await persistRes.json().catch(() => ({ error: 'Persistence failed' })) as { error?: string }
          throw new Error(err.error ?? 'Persistence failed')
        }

        const persistData = await persistRes.json() as {
          sourceId: string
          nodeIds: string[]
          edgesCreated: number
          chunkCount: number
          crossConnectionCount: number
          durationMs: number
          mergedEntitiesLog: Array<{ canonical: string; merged: string[] }>
        }

        const nodeIds = persistData.nodeIds
        const edgesCreated = persistData.edgesCreated
        const chunkCount = persistData.chunkCount
        const crossConnectionCount = persistData.crossConnectionCount

        // Record the extraction session
        stopTimer()
        const durationMs = Date.now() - startTimeRef.current
        const sourceName = metadata?.title || deriveQuickTitle(content)

        await saveExtractionSession(userId, {
          sourceName,
          sourceType: metadata?.sourceType || 'Note',
          contentPreview: content,
          extractionMode: config?.mode || 'comprehensive',
          anchorEmphasis: config?.anchorEmphasis || 'standard',
          userGuidance: config?.customGuidance,
          selectedAnchorIds: config?.anchors.map(() => ''),
          extractedNodeIds: nodeIds,
          extractedEdgeIds: [],
          entityCount: nodeIds.length,
          relationshipCount: edgesCreated,
          chunkCount,
          crossConnectionCount,
          durationMs,
        })

        // Trigger anchor scoring — fire-and-forget, never blocks the UI
        if (nodeIds.length > 0 && sourceId) {
          fetch('/api/anchors/score-post-extraction', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${currentSession.access_token}`,
            },
            body: JSON.stringify({
              userId,
              sourceId,
              nodeIds,
            }),
          }).catch(err => {
            console.warn('[useExtraction] Anchor scoring trigger failed (non-fatal):', err)
          })
        }

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

  // --- reExtract: Re-run extraction from server ---
  const reExtract = useCallback(async () => {
    if (!user?.id || !contentRef.current || !configRef.current) return
    const config = configRef.current

    update({
      step: 'extracting',
      entities: null,
      relationships: null,
      error: null,
      statusText: 'Re-extracting with Gemini...',
    })

    try {
      const { data: { session: currentSession } } = await supabase.auth.getSession()
      if (!currentSession?.access_token) {
        throw new Error('No auth session available')
      }

      const previewRes = await fetch('/api/ingest/extract-preview', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${currentSession.access_token}`,
        },
        body: JSON.stringify({
          content: contentRef.current,
          sourceId: sourceIdRef.current,
          config: {
            mode: config.mode,
            anchorEmphasis: config.anchorEmphasis,
            anchors: config.anchors,
            userProfile: config.userProfile,
            customGuidance: config.customGuidance,
          },
        }),
      })

      if (!previewRes.ok) {
        const err = await previewRes.json().catch(() => ({ error: 'Extraction failed' })) as { error?: string }
        throw new Error(err.error ?? 'Extraction failed')
      }

      const previewData = await previewRes.json() as {
        entities: ExtractedEntity[]
        relationships: ExtractedRelationship[]
      }

      const reviewEntities: ReviewEntity[] = previewData.entities.map(e => ({
        ...e,
        removed: false,
        edited: false,
      }))

      update({
        step: 'reviewing',
        entities: reviewEntities,
        relationships: previewData.relationships,
        statusText: `Found ${previewData.entities.length} entities and ${previewData.relationships.length} relationships`,
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
