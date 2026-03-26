import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useAuth } from './useAuth'
import {
  fetchPipelineHistory,
  fetchActiveQueueItems,
  fetchActiveMeetingItems,
  type PipelineSession,
} from '../services/supabase'
import type {
  PipelineHistoryItem,
  SourceTypeFilter,
  StatusFilter,
  SortOption,
} from '../types/pipeline'

const PAGE_SIZE = 20

function mapSessionToItem(s: PipelineSession): PipelineHistoryItem {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const queueStatus = (s as any)._queueStatus as string | undefined
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const provider = (s as any)._provider as string | undefined
  const isFailed = !queueStatus && s.entity_count === 0 && s.extraction_duration_ms !== null
  const isProcessing = !!queueStatus

  let status: PipelineHistoryItem['status'] = 'completed'
  let step: string | undefined
  if (isProcessing) {
    if (queueStatus === 'pending') {
      status = 'pending'
      step = 'queued'
    } else if (queueStatus === 'transcript_ready') {
      status = 'processing'
      step = 'transcript_ready'
    } else {
      status = 'processing'
      step = queueStatus
    }
  } else if (isFailed) {
    status = 'failed'
  }

  return {
    id: s.id,
    title: s.source_name ?? 'Untitled',
    sourceType: (s.source_type ?? 'Document') as PipelineHistoryItem['sourceType'],
    provider: provider ?? (s.source_type === 'YouTube' ? 'youtube' : null),
    mode: (s.extraction_mode ?? 'comprehensive') as PipelineHistoryItem['mode'],
    emphasis: (s.anchor_emphasis ?? 'standard') as PipelineHistoryItem['emphasis'],
    status,
    step,
    error: isFailed ? 'Extraction produced no entities' : undefined,
    createdAt: s.created_at,
    entityCount: s.entity_count,
    relationshipCount: s.relationship_count,
    chunkCount: s.chunk_count ?? 0,
    duration: s.extraction_duration_ms ?? 0,
    confidence: 0,
    crossConnections: s.cross_connection_count ?? 0,
    rating: s.feedback_rating,
    ratingText: s.feedback_text,
    entityBreakdown: {},
    topEntityTypes: [],
    anchors: (s.selected_anchor_ids ?? []),
    sourceId: null,
    sourceUrl: null,
    extractedNodeIds: s.extracted_node_ids ?? [],
    extractedEdgeIds: s.extracted_edge_ids ?? [],
  }
}

interface FilterCounts {
  all: number
  YouTube: number
  Meeting: number
  Document: number
  Note: number
  queued: number
  inProgress: number
  completed: number
  failed: number
}

export interface UsePipelineHistoryReturn {
  items: PipelineHistoryItem[]
  allItems: PipelineHistoryItem[]
  loading: boolean
  error: string | null
  hasMore: boolean
  loadMore: () => void
  refetch: () => void
  startPolling: () => void
  stopPolling: () => void
  counts: FilterCounts
}

export function usePipelineHistory(
  sourceFilter: SourceTypeFilter,
  statusFilter: StatusFilter,
  sortBy: SortOption
): UsePipelineHistoryReturn {
  const { user } = useAuth()
  const [sessions, setSessions] = useState<PipelineSession[]>([])
  const [queueItems, setQueueItems] = useState<PipelineSession[]>([])
  const [totalCount, setTotalCount] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const loadingRef = useRef(false)

  const fetchData = useCallback(
    async (offset: number, append: boolean) => {
      if (!user?.id || loadingRef.current) return
      loadingRef.current = true
      if (!append) setLoading(true)
      setError(null)

      try {
        const [historyResult, activeResult, meetingResult] = await Promise.all([
          fetchPipelineHistory(user.id, PAGE_SIZE, offset),
          offset === 0 ? fetchActiveQueueItems(user.id) : Promise.resolve(null),
          offset === 0 ? fetchActiveMeetingItems(user.id) : Promise.resolve(null),
        ])

        if (append) {
          setSessions(prev => [...prev, ...historyResult.sessions])
        } else {
          setSessions(historyResult.sessions)
        }
        setTotalCount(historyResult.totalCount)
        if (activeResult !== null || meetingResult !== null) {
          setQueueItems([...(activeResult ?? []), ...(meetingResult ?? [])])
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load pipeline history')
      } finally {
        loadingRef.current = false
        setLoading(false)
      }
    },
    [user?.id]
  )

  useEffect(() => {
    fetchData(0, false)
  }, [fetchData])

  const loadMore = useCallback(() => {
    fetchData(sessions.length, true)
  }, [fetchData, sessions.length])

  const refetch = useCallback(() => {
    fetchData(0, false)
  }, [fetchData])

  // ── Auto-polling: poll every 5s when active items exist ──────────────────
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const hasActiveItems = useRef(false)
  // Fast polling mode: triggered by "Process Now", polls every 3s then slows
  const fastPollRef = useRef(false)

  const clearPoll = useCallback(() => {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current)
      pollIntervalRef.current = null
    }
  }, [])

  const startPolling = useCallback(() => {
    fastPollRef.current = true
    clearPoll()
    // Fast poll every 3s — the interval auto-manages itself below
    pollIntervalRef.current = setInterval(() => {
      fetchData(0, false)
    }, 3000)
  }, [clearPoll, fetchData])

  const stopPolling = useCallback(() => {
    fastPollRef.current = false
    clearPoll()
  }, [clearPoll])

  // Auto-manage polling based on whether active items exist
  useEffect(() => {
    const activeCount = queueItems.length
    const hadActive = hasActiveItems.current
    hasActiveItems.current = activeCount > 0

    if (fastPollRef.current) {
      // Fast polling is active — if all items completed, stop fast polling
      if (activeCount === 0 && hadActive) {
        fastPollRef.current = false
        clearPoll()
        // Do one final refetch to get completed state
        fetchData(0, false)
      }
      return // Don't interfere with fast polling interval
    }

    if (activeCount > 0 && !pollIntervalRef.current) {
      // Start background polling at 5s
      pollIntervalRef.current = setInterval(() => {
        fetchData(0, false)
      }, 5000)
    } else if (activeCount === 0 && pollIntervalRef.current) {
      clearPoll()
    }
  }, [queueItems.length, clearPoll, fetchData])

  // Cleanup on unmount
  useEffect(() => {
    return () => clearPoll()
  }, [clearPoll])

  // Merge sessions + queue items into unified list
  // Sort queue items: meetings first (higher priority), then YouTube
  const allItems = useMemo(() => {
    const mappedQueue = queueItems.map(mapSessionToItem)
    mappedQueue.sort((a, b) => {
      if (a.sourceType === 'Meeting' && b.sourceType !== 'Meeting') return -1
      if (a.sourceType !== 'Meeting' && b.sourceType === 'Meeting') return 1
      return 0
    })
    return [...mappedQueue, ...sessions.map(mapSessionToItem)]
  }, [sessions, queueItems])

  // Compute counts
  const counts = useMemo<FilterCounts>(() => {
    const c: FilterCounts = { all: allItems.length, YouTube: 0, Meeting: 0, Document: 0, Note: 0, queued: 0, inProgress: 0, completed: 0, failed: 0 }
    for (const item of allItems) {
      if (item.sourceType === 'YouTube') c.YouTube += 1
      else if (item.sourceType === 'Meeting') c.Meeting += 1
      else if (item.sourceType === 'Document') c.Document += 1
      else if (item.sourceType === 'Note') c.Note += 1
      if (item.status === 'pending') c.queued += 1
      else if (item.status === 'processing' || item.status === 'extracting') c.inProgress += 1
      else if (item.status === 'completed') c.completed += 1
      else if (item.status === 'failed') c.failed += 1
    }
    return c
  }, [allItems])

  // Apply filters + sort
  const filteredItems = useMemo(() => {
    let result = allItems

    if (sourceFilter !== 'all') {
      result = result.filter(i => i.sourceType === sourceFilter)
    }

    if (statusFilter === 'queued') {
      result = result.filter(i => i.status === 'pending')
    } else if (statusFilter === 'in_progress') {
      result = result.filter(i => i.status === 'processing' || i.status === 'extracting')
    } else if (statusFilter === 'completed') {
      result = result.filter(i => i.status === 'completed')
    } else if (statusFilter === 'failed') {
      result = result.filter(i => i.status === 'failed')
    }

    switch (sortBy) {
      case 'slowest':
        result = [...result].sort((a, b) => b.duration - a.duration)
        break
      case 'entities':
        result = [...result].sort((a, b) => b.entityCount - a.entityCount)
        break
      case 'confidence':
        result = [...result].sort((a, b) => a.confidence - b.confidence)
        break
      default: // 'recent' — already sorted by created_at desc
        break
    }

    return result
  }, [allItems, sourceFilter, statusFilter, sortBy])

  const hasMore = sessions.length < totalCount

  return {
    items: filteredItems,
    allItems,
    loading,
    error,
    hasMore,
    loadMore,
    refetch,
    startPolling,
    stopPolling,
    counts,
  }
}
