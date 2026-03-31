import { useState, useCallback, useRef, useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'
import { GripVertical, Layers } from 'lucide-react'
import { FeedTab } from '../components/home/FeedTab'
import { HomeFeedDetail } from '../components/home/HomeFeedDetail'
import { useActivityFeed } from '../hooks/useActivityFeed'
import type { FeedItem } from '../types/feed'

const DEFAULT_LEFT_PCT = 64
const MIN_LEFT_PCT = 30
const MAX_LEFT_PCT = 75

function EmptyDetail() {
  return (
    <div
      className="flex flex-col items-center justify-center h-full"
      style={{ padding: '0 32px', textAlign: 'center' }}
    >
      <Layers size={32} style={{ color: 'var(--color-text-placeholder)', marginBottom: 12 }} />
      <p className="font-body font-semibold" style={{ fontSize: 14, color: 'var(--color-text-body)', marginBottom: 4 }}>
        Select a source to explore
      </p>
      <p className="font-body" style={{ fontSize: 13, color: 'var(--color-text-secondary)', maxWidth: 280 }}>
        Click any feed card or &ldquo;Explore More&rdquo; to see its full details, entities, and connections here.
      </p>
    </div>
  )
}

export default function SourcesView() {
  const [searchParams] = useSearchParams()
  const { items: feedItems, loading, error, hasMore, loadMore, refetch } = useActivityFeed()
  const [selectedFeedItem, setSelectedFeedItem] = useState<FeedItem | null>(null)

  // Auto-select source from URL param (e.g. /sources?sourceId=xxx)
  useEffect(() => {
    const sourceId = searchParams.get('sourceId')
    if (sourceId && feedItems.length > 0 && !selectedFeedItem) {
      const match = feedItems.find(i => i.source.id === sourceId)
      if (match) setSelectedFeedItem(match)
    }
  }, [searchParams, feedItems, selectedFeedItem])

  // Resizable layout
  const containerRef = useRef<HTMLDivElement>(null)
  const [leftWidthPct, setLeftWidthPct] = useState(DEFAULT_LEFT_PCT)
  const [isDragging, setIsDragging] = useState(false)
  const [isHandleHovered, setIsHandleHovered] = useState(false)
  const dragStartX = useRef(0)
  const dragStartPct = useRef(DEFAULT_LEFT_PCT)

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

  const handleItemSelect = useCallback((item: FeedItem) => {
    setSelectedFeedItem(item)
    if (leftWidthPct > 60) {
      setLeftWidthPct(50)
    }
  }, [leftWidthPct])

  // Keep selected item synced with fresh data
  const selected = selectedFeedItem
    ? feedItems.find(i => i.source.id === selectedFeedItem.source.id) ?? selectedFeedItem
    : null

  return (
    <div className="flex flex-col h-full">
      <style>{`
        @keyframes fadeUp {
          from { opacity: 0; transform: translateY(8px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>

      {/* Control bar */}
      <div
        className="flex items-center shrink-0"
        style={{
          background: 'var(--color-bg-card)',
          borderBottom: '1px solid var(--border-subtle)',
          padding: '8px 24px',
          minHeight: 44,
          gap: 8,
        }}
      >
        <span className="font-display" style={{ fontSize: 12, fontWeight: 700, color: 'var(--color-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
          All Sources
        </span>
        <div style={{ width: 1, height: 24, background: 'var(--border-subtle)', margin: '0 4px' }} />
        <span className="font-body text-text-secondary" style={{ fontSize: 12 }}>
          {feedItems.length} sources ingested
        </span>
      </div>

      {/* Two-column layout */}
      <div
        ref={containerRef}
        className="flex flex-1 overflow-hidden"
        style={{
          background: 'var(--color-bg-content)',
          userSelect: isDragging ? 'none' : undefined,
          cursor: isDragging ? 'col-resize' : undefined,
        }}
      >
        {/* Left: Feed list */}
        <div
          className="h-full overflow-y-auto shrink-0"
          style={{
            width: `${leftWidthPct}%`,
            transition: isDragging ? 'none' : 'width 0.2s ease',
            padding: '20px 36px',
          }}
        >
          <FeedTab
            items={feedItems}
            loading={loading}
            error={error}
            hasMore={hasMore}
            onLoadMore={loadMore}
            onRetry={refetch}
            selectedSourceId={selected?.source.id ?? null}
            onItemSelect={handleItemSelect}
          />
        </div>

        {/* Drag handle */}
        <div
          className="shrink-0 flex items-center justify-center"
          onMouseDown={handleDividerMouseDown}
          onMouseEnter={() => setIsHandleHovered(true)}
          onMouseLeave={() => setIsHandleHovered(false)}
          style={{ width: 16, cursor: 'col-resize', position: 'relative', zIndex: 1 }}
        >
          <div style={{
            position: 'absolute',
            left: '50%',
            transform: 'translateX(-50%)',
            top: 0,
            bottom: 0,
            width: 2,
            background: (isDragging || isHandleHovered) ? 'var(--color-accent-500)' : 'var(--border-subtle)',
            transition: 'background 0.15s ease',
            borderRadius: 1,
          }} />
          <GripVertical
            size={14}
            style={{
              position: 'relative',
              zIndex: 1,
              color: (isDragging || isHandleHovered) ? 'var(--color-accent-500)' : 'var(--color-text-placeholder)',
              transition: 'color 0.15s ease',
              background: 'var(--color-bg-content)',
              borderRadius: 2,
            }}
          />
        </div>

        {/* Right: Source detail */}
        <div className="flex-1 h-full overflow-y-auto" style={{ minWidth: 0 }}>
          {selected ? (
            <HomeFeedDetail
              item={selected}
              onClose={() => setSelectedFeedItem(null)}
              onSourceSelect={(sourceId) => {
                const found = feedItems.find(i => i.source.id === sourceId)
                if (found) handleItemSelect(found)
              }}
            />
          ) : (
            <EmptyDetail />
          )}
        </div>
      </div>
    </div>
  )
}
