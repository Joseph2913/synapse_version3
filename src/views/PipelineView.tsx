import { useState, useCallback, useRef, useMemo, useEffect } from 'react'
import { Activity, GripVertical, ChevronDown } from 'lucide-react'
import { useAuth } from '../hooks/useAuth'
import { usePipelineHistory } from '../hooks/usePipelineHistory'
import { usePipelineMetrics } from '../hooks/usePipelineMetrics'
import { updateExtractionRating, deleteExtractionSession } from '../services/supabase'
import { fetchPendingDuplicates, mergeNodes, keepSeparate } from '../services/deduplication'
import type { PotentialDuplicatePair } from '../services/deduplication'
import { HistoryCard } from '../components/pipeline/HistoryCard'
import { ExtractionDetail } from '../components/pipeline/ExtractionDetail'
import { ActiveItemDetail } from '../components/pipeline/ActiveItemDetail'
import { ExtractionSettings } from '../components/pipeline/ExtractionSettings'
import { PipelineStats } from '../components/pipeline/PipelineStats'
import type { SourceTypeFilter, StatusFilter, SortOption } from '../types/pipeline'

const DEFAULT_LEFT_PCT = 65
const MIN_LEFT_PCT = 30
const MAX_LEFT_PCT = 80

// ─── Filter Dropdown ───────────────────────────────────────────────────────────

interface DropdownOption<T extends string> {
  value: T
  label: string
  count?: number
}

function FilterDropdown<T extends string>({
  options,
  value,
  onChange,
  isOpen,
  onToggle,
  variant,
}: {
  options: DropdownOption<T>[]
  value: T
  onChange: (v: T) => void
  isOpen: boolean
  onToggle: () => void
  variant?: 'danger'
}) {
  const ref = useRef<HTMLDivElement>(null)
  const currentOption = options.find(o => o.value === value)
  const isFiltered = value !== options[0]?.value
  const isDanger = variant === 'danger' && isFiltered

  useEffect(() => {
    if (!isOpen) return
    const handleClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onToggle()
    }
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onToggle()
    }
    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('keydown', handleEscape)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleEscape)
    }
  }, [isOpen, onToggle])

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        type="button"
        onClick={onToggle}
        className="font-body font-semibold"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          padding: '5px 13px',
          borderRadius: 20,
          fontSize: 12,
          background: isDanger
            ? 'var(--semantic-red-50, rgba(239,68,68,0.06))'
            : isFiltered
              ? 'var(--color-accent-50)'
              : 'transparent',
          border: `1px solid ${
            isDanger
              ? 'rgba(239,68,68,0.2)'
              : isFiltered
                ? 'rgba(214,58,0,0.15)'
                : 'var(--border-subtle)'
          }`,
          color: isDanger
            ? 'var(--semantic-red-500, #ef4444)'
            : isFiltered
              ? 'var(--color-accent-500)'
              : 'var(--color-text-secondary)',
          cursor: 'pointer',
          transition: 'all 0.15s ease',
        }}
      >
        {currentOption?.label}
        <ChevronDown size={12} style={{ color: 'var(--color-text-secondary)' }} />
      </button>

      {isOpen && (
        <div
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            marginTop: 4,
            background: 'var(--color-bg-card)',
            border: '1px solid var(--border-strong, var(--border-subtle))',
            borderRadius: 10,
            boxShadow: '0 4px 16px rgba(0,0,0,0.08)',
            padding: 4,
            zIndex: 50,
            minWidth: 160,
          }}
        >
          {options.map(opt => {
            const isActive = opt.value === value
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => { onChange(opt.value); onToggle() }}
                className="font-body"
                style={{
                  display: 'block',
                  width: '100%',
                  textAlign: 'left',
                  padding: '8px 14px',
                  borderRadius: 6,
                  border: 'none',
                  background: isActive ? 'var(--color-accent-50)' : 'transparent',
                  color: isActive ? 'var(--color-accent-500)' : 'var(--color-text-body)',
                  fontSize: 12,
                  fontWeight: isActive ? 600 : 500,
                  cursor: 'pointer',
                  transition: 'background 0.1s ease',
                }}
                onMouseEnter={e => { if (!isActive) e.currentTarget.style.background = 'var(--color-bg-hover, var(--color-bg-inset))' }}
                onMouseLeave={e => { if (!isActive) e.currentTarget.style.background = 'transparent' }}
              >
                {opt.label}{opt.count !== undefined ? ` (${opt.count})` : ''}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ─── Main View ─────────────────────────────────────────────────────────────────

export function PipelineView() {
  const { session } = useAuth()

  // Filters + selection
  const [sourceFilter, setSourceFilter] = useState<SourceTypeFilter>('all')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [sortBy, setSortBy] = useState<SortOption>('recent')
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null)
  const [openDropdown, setOpenDropdown] = useState<'source' | 'status' | 'sort' | null>(null)

  // Drag resize
  const containerRef = useRef<HTMLDivElement>(null)
  const [leftWidthPct, setLeftWidthPct] = useState(DEFAULT_LEFT_PCT)
  const [isDragging, setIsDragging] = useState(false)
  const dragStartX = useRef(0)
  const dragStartPct = useRef(DEFAULT_LEFT_PCT)

  // Data
  const { items, allItems, loading, error, hasMore, loadMore, refetch, startPolling, counts } = usePipelineHistory(sourceFilter, statusFilter, sortBy)
  const metrics = usePipelineMetrics(allItems)

  // Potential duplicates state
  const { user } = useAuth()
  const [pendingDuplicates, setPendingDuplicates] = useState<PotentialDuplicatePair[]>([])

  const refreshDuplicates = useCallback(async () => {
    if (!user?.id) return
    try {
      const pairs = await fetchPendingDuplicates(user.id)
      setPendingDuplicates(pairs)
    } catch (err) {
      console.warn('[PipelineView] Failed to fetch pending duplicates:', err)
    }
  }, [user?.id])

  useEffect(() => {
    refreshDuplicates()
  }, [refreshDuplicates])

  const handleMergeDuplicates = useCallback(async (canonicalId: string, mergeId: string, _pairId: string) => {
    if (!user?.id) return
    try {
      await mergeNodes(user.id, canonicalId, mergeId)
      refreshDuplicates()
    } catch (err) {
      console.warn('[PipelineView] Merge failed:', err)
    }
  }, [user?.id, refreshDuplicates])

  const handleKeepSeparate = useCallback(async (pairId: string) => {
    if (!user?.id) return
    try {
      await keepSeparate(user.id, pairId)
      refreshDuplicates()
    } catch (err) {
      console.warn('[PipelineView] Keep separate failed:', err)
    }
  }, [user?.id, refreshDuplicates])

  const handleBatchMerge = useCallback(async (pairs: Array<{ canonicalId: string; mergeId: string; pairId: string }>) => {
    if (!user?.id) return
    for (const pair of pairs) {
      try {
        await mergeNodes(user.id, pair.canonicalId, pair.mergeId)
      } catch (err) {
        console.warn(`[PipelineView] Batch merge failed for pair ${pair.pairId}:`, err)
      }
    }
    refreshDuplicates()
  }, [user?.id, refreshDuplicates])

  const selectedItem = useMemo(
    () => selectedItemId ? items.find(i => i.id === selectedItemId) ?? null : null,
    [selectedItemId, items]
  )

  // ── Handlers ───────────────────────────────────────────────────────────────

  const handleDividerMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    dragStartX.current = e.clientX
    dragStartPct.current = leftWidthPct
    setIsDragging(true)

    const onMove = (ev: MouseEvent) => {
      if (!containerRef.current) return
      const containerW = containerRef.current.getBoundingClientRect().width
      const delta = ev.clientX - dragStartX.current
      const deltaPct = (delta / containerW) * 100
      setLeftWidthPct(Math.min(MAX_LEFT_PCT, Math.max(MIN_LEFT_PCT, dragStartPct.current + deltaPct)))
    }
    const onUp = () => {
      setIsDragging(false)
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [leftWidthPct])

  const handleCardClick = useCallback((id: string) => {
    setSelectedItemId(prev => prev === id ? null : id)
  }, [])

  const handleRate = useCallback(async (itemId: string, rating: number) => {
    try {
      await updateExtractionRating(itemId, rating)
      refetch()
    } catch (err) {
      console.warn('Failed to save rating:', err)
    }
  }, [refetch])

  const handleDelete = useCallback(async (itemId: string) => {
    const item = allItems.find(i => i.id === itemId)
    if (!item) return
    try {
      await deleteExtractionSession(itemId, item.extractedNodeIds, item.extractedEdgeIds)
      setSelectedItemId(null)
      refetch()
    } catch (err) {
      console.warn('Failed to delete extraction:', err)
    }
  }, [allItems, refetch])

  const [processingNowId, setProcessingNowId] = useState<string | null>(null)

  const handleProcessNow = useCallback(async (item: { id: string; sourceType: string; step?: string }) => {
    if (!session?.access_token || processingNowId) return
    setProcessingNowId(item.id)
    // Start fast polling immediately so the UI tracks progress in real time
    startPolling()
    try {
      const headers = {
        'Authorization': `Bearer ${session.access_token}`,
        'Content-Type': 'application/json',
      }
      if (item.sourceType === 'Meeting') {
        await fetch('/api/meetings/process', { method: 'POST', headers })
      } else {
        // YouTube: call decoupled endpoints sequentially
        // Skip transcript fetch if transcript is already ready
        if (item.step !== 'transcript_ready') {
          await fetch('/api/youtube/fetch-transcripts', { method: 'POST', headers })
        }
        await fetch('/api/youtube/extract-knowledge', { method: 'POST', headers })
      }
      // API call done — do an immediate refetch, then let polling handle the rest
      refetch()
      setProcessingNowId(null)
    } catch {
      setProcessingNowId(null)
    }
  }, [session?.access_token, processingNowId, refetch, startPolling])

  const toggleDropdown = useCallback((id: 'source' | 'status' | 'sort') => {
    setOpenDropdown(prev => prev === id ? null : id)
  }, [])

  // Escape key handler
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (openDropdown) setOpenDropdown(null)
        else if (selectedItemId) setSelectedItemId(null)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [openDropdown, selectedItemId])

  // ── Summary line ───────────────────────────────────────────────────────────

  const successColor = metrics.successRate >= 95
    ? 'var(--semantic-green-500, #22c55e)'
    : metrics.successRate >= 80
      ? 'var(--semantic-amber-500, #f59e0b)'
      : 'var(--semantic-red-500, #ef4444)'

  // ── Dropdown options ───────────────────────────────────────────────────────

  const sourceOptions: DropdownOption<SourceTypeFilter>[] = [
    { value: 'all', label: 'All Sources' },
    { value: 'YouTube', label: 'YouTube', count: counts.YouTube },
    { value: 'Meeting', label: 'Meetings', count: counts.Meeting },
    { value: 'Document', label: 'Documents', count: counts.Document },
    { value: 'Note', label: 'Notes', count: counts.Note },
  ]

  const statusOptions: DropdownOption<StatusFilter>[] = [
    { value: 'all', label: 'All Statuses' },
    { value: 'queued', label: 'Queued', count: counts.queued },
    { value: 'in_progress', label: 'In Progress', count: counts.inProgress },
    { value: 'completed', label: 'Completed', count: counts.completed },
    { value: 'failed', label: 'Failed', count: counts.failed },
  ]

  const sortOptions: DropdownOption<SortOption>[] = [
    { value: 'recent', label: 'Most Recent' },
    { value: 'slowest', label: 'Slowest First' },
    { value: 'entities', label: 'Most Entities' },
    { value: 'confidence', label: 'Lowest Confidence' },
  ]

  // ── Right panel content ────────────────────────────────────────────────────

  const isCompletedOrFailed = selectedItem && (selectedItem.status === 'completed' || selectedItem.status === 'failed')
  const isActive = selectedItem && (selectedItem.status === 'pending' || selectedItem.status === 'processing' || selectedItem.status === 'extracting')

  const rightContent = (() => {
    if (isCompletedOrFailed && selectedItem) {
      return (
        <ExtractionDetail
          item={selectedItem}
          onClose={() => setSelectedItemId(null)}
          onRate={(rating) => handleRate(selectedItem.id, rating)}
          onDelete={() => handleDelete(selectedItem.id)}
        />
      )
    }

    if (isActive && selectedItem) {
      return (
        <ActiveItemDetail
          item={selectedItem}
          onClose={() => setSelectedItemId(null)}
          onProcessNow={() => handleProcessNow(selectedItem)}
          processingNow={processingNowId === selectedItem.id}
        />
      )
    }

    return (
      <div style={{ overflowY: 'auto', height: '100%' }}>
        <PipelineStats
          metrics={metrics}
          allItems={allItems}
          loading={loading}
          pendingDuplicatesCount={pendingDuplicates.length}
          pendingDuplicates={pendingDuplicates}
          onMerge={handleMergeDuplicates}
          onKeepSeparate={handleKeepSeparate}
          onBatchMerge={handleBatchMerge}
        />
        <ExtractionSettings />
      </div>
    )
  })()

  return (
    <div className="flex flex-col h-full">
      <style>{`
        @keyframes fadeUp {
          from { opacity: 0; transform: translateY(8px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>

      {/* ── Control bar — full width above split ── */}
      <div
        className="flex items-center shrink-0 flex-wrap"
        style={{
          background: 'var(--color-bg-card)',
          borderBottom: '1px solid var(--border-subtle)',
          padding: '8px 24px',
          minHeight: 44,
          gap: 8,
        }}
      >
        {/* Filter dropdowns */}
        <FilterDropdown
          options={sourceOptions}
          value={sourceFilter}
          onChange={setSourceFilter}
          isOpen={openDropdown === 'source'}
          onToggle={() => toggleDropdown('source')}
        />
        <FilterDropdown
          options={statusOptions}
          value={statusFilter}
          onChange={setStatusFilter}
          isOpen={openDropdown === 'status'}
          onToggle={() => toggleDropdown('status')}
          variant={statusFilter === 'failed' && counts.failed > 0 ? 'danger' : undefined}
        />
        <FilterDropdown
          options={sortOptions}
          value={sortBy}
          onChange={setSortBy}
          isOpen={openDropdown === 'sort'}
          onToggle={() => toggleDropdown('sort')}
        />

        {/* Divider */}
        <div style={{ width: 1, height: 24, background: 'var(--border-subtle)', flexShrink: 0 }} />

        {/* Stats strip */}
        <span className="font-body" style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
          <span style={{ color: 'var(--semantic-green-500, #22c55e)', fontWeight: 600 }}>
            {metrics.sourcesThisWeek}
          </span>
          {' sources this week'}
        </span>
        <span className="font-body" style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
          {metrics.entitiesThisWeek} entities
        </span>
        <span className="font-body" style={{ fontSize: 12, color: successColor, fontWeight: 600 }}>
          {metrics.successRate}% success
        </span>
        {metrics.activeProcessing > 0 && (
          <span className="font-body" style={{ fontSize: 12, color: 'var(--color-accent-500)', fontWeight: 600 }}>
            {metrics.activeProcessing} processing
          </span>
        )}
      </div>

      <div
        ref={containerRef}
        className="flex flex-1 overflow-hidden"
        style={{
          background: 'var(--color-bg-content)',
          userSelect: isDragging ? 'none' : undefined,
          cursor: isDragging ? 'col-resize' : undefined,
        }}
      >
        {/* ── Left: scrollable center stage — queue/history cards ── */}
        <div
          style={{
            width: `${leftWidthPct}%`,
            height: '100%',
            overflowY: 'auto',
            overflowX: 'hidden',
            flexShrink: 0,
            transition: isDragging ? 'none' : 'width 0.2s ease',
          }}
        >
          <div style={{ padding: '20px 36px' }}>
            {/* ── History / Queue Cards ── */}
            {loading && items.length === 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {[0, 1, 2].map(i => (
                  <div
                    key={i}
                    className="animate-pulse"
                    style={{
                      height: 100,
                      borderRadius: 10,
                      background: 'var(--color-bg-inset)',
                      animation: `fadeUp 0.4s ease ${i * 0.05}s both`,
                    }}
                  />
                ))}
              </div>
            ) : error ? (
              <div style={{ textAlign: 'center', padding: '48px 0' }}>
                <p className="font-body" style={{ fontSize: 13, color: 'var(--color-text-secondary)', marginBottom: 12 }}>
                  Couldn't load pipeline history.
                </p>
                <button
                  type="button"
                  onClick={refetch}
                  className="font-body font-semibold"
                  style={{
                    padding: '8px 20px',
                    borderRadius: 8,
                    border: '1px solid var(--border-subtle)',
                    background: 'var(--color-bg-card)',
                    color: 'var(--color-text-body)',
                    fontSize: 12,
                    cursor: 'pointer',
                  }}
                >
                  Retry
                </button>
              </div>
            ) : items.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '48px 0' }}>
                <Activity size={48} style={{ color: 'var(--color-text-placeholder)', margin: '0 auto 14px', display: 'block' }} />
                <h2 className="font-display" style={{ fontSize: 18, fontWeight: 700, color: 'var(--color-text-primary)', marginBottom: 8 }}>
                  No extraction history yet
                </h2>
                <p className="font-body" style={{ fontSize: 13, color: 'var(--color-text-secondary)', maxWidth: 400, margin: '0 auto' }}>
                  Your pipeline history will appear here as you ingest content. Head to Capture to get started.
                </p>
              </div>
            ) : (
              <>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {items.map((item, i) => (
                    <HistoryCard
                      key={item.id}
                      item={item}
                      isSelected={selectedItemId === item.id}
                      onClick={() => handleCardClick(item.id)}
                      onRate={(rating) => handleRate(item.id, rating)}
                      onProcessNow={(item.status === 'pending' || item.step === 'transcript_ready') ? () => handleProcessNow(item) : undefined}
                      index={i}
                    />
                  ))}
                </div>

                {hasMore && (
                  <div style={{ textAlign: 'center', padding: '16px 0' }}>
                    <button
                      type="button"
                      onClick={loadMore}
                      className="font-body font-semibold"
                      style={{
                        padding: '8px 24px',
                        borderRadius: 8,
                        border: '1px solid var(--border-subtle)',
                        background: 'var(--color-bg-card)',
                        color: 'var(--color-text-body)',
                        fontSize: 12,
                        cursor: 'pointer',
                      }}
                    >
                      Load More
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        </div>

        {/* ── Drag handle ── */}
        <div
          onMouseDown={handleDividerMouseDown}
          style={{
            width: 12,
            flexShrink: 0,
            cursor: 'col-resize',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            position: 'relative',
            zIndex: 1,
          }}
        >
          <div
            style={{
              position: 'absolute',
              left: '50%',
              transform: 'translateX(-50%)',
              top: 0,
              bottom: 0,
              width: 2,
              background: isDragging ? 'var(--color-accent-500)' : 'var(--border-subtle)',
              transition: 'background 0.15s ease',
              borderRadius: 1,
            }}
          />
          <GripVertical
            size={14}
            style={{
              position: 'relative',
              zIndex: 1,
              color: isDragging ? 'var(--color-accent-500)' : 'var(--color-text-placeholder)',
              transition: 'color 0.15s ease',
              background: 'var(--color-bg-content)',
              borderRadius: 2,
            }}
          />
        </div>

        {/* ── Right panel ── */}
        <div style={{ flex: 1, height: '100%', overflow: 'hidden', minWidth: 0 }}>
          {rightContent}
        </div>
      </div>
    </div>
  )
}
