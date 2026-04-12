import { useState, useCallback, useRef, useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'
import { GripVertical, Plus, Plug2, ChevronRight, Youtube, FileText, StickyNote, FlaskConical, Globe, MessageSquare as MeetingIcon } from 'lucide-react'
import { FeedTab } from '../components/home/FeedTab'
import { HomeFeedDetail } from '../components/home/HomeFeedDetail'
import { useActivityFeed } from '../hooks/useActivityFeed'
import { useAutomationSources } from '../hooks/useAutomationSources'
import { useApiKeys } from '../hooks/useApiKeys'
import { fetchKnowledgeSnapshot } from '../services/supabase'
import { SourceDetailPanel } from '../components/automate/SourceDetailPanel'
import { NewSourcePanel } from '../components/automate/NewSourcePanel'
import { McpAccessPanel } from '../components/automate/McpAccessPanel'
import { ManualUploadPanel } from '../components/automate/ManualUploadPanel'
import type { FeedItem } from '../types/feed'
import type { AutomationSource } from '../services/automationSources'

export type ManualUploadType = 'document' | 'text' | 'url' | 'transcript' | 'youtube'

const CATEGORY_ORDER: AutomationSource['category'][] = ['microsoft', 'meeting', 'youtube-playlist']
const CATEGORY_LABELS: Record<AutomationSource['category'], string> = {
  'microsoft': 'Microsoft 365',
  'meeting': 'Meeting Services',
  'youtube-playlist': 'YouTube Playlists',
}

const DEFAULT_LEFT_PCT = 64
const MIN_LEFT_PCT = 30
const MAX_LEFT_PCT = 75

// Source type badge config
const SOURCE_BADGES: Array<{
  type: string
  label: string
  icon: typeof Youtube
  color: string
  bg: string
}> = [
  { type: 'YouTube', label: 'YouTube', icon: Youtube, color: '#ef4444', bg: '#fef2f2' },
  { type: 'Document', label: 'Documents', icon: FileText, color: '#f59e0b', bg: '#fffbeb' },
  { type: 'Note', label: 'Notes', icon: StickyNote, color: '#10b981', bg: '#ecfdf5' },
  { type: 'Research', label: 'Research', icon: FlaskConical, color: '#8b5cf6', bg: '#f5f3ff' },
  { type: 'API', label: 'API', icon: Globe, color: '#6b7280', bg: '#f9fafb' },
  { type: 'Meeting', label: 'Meetings', icon: MeetingIcon, color: '#3b82f6', bg: '#eff6ff' },
]

function timeAgo(dateStr: string | null): string {
  if (!dateStr) return ''
  const diff = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  const weeks = Math.floor(days / 7)
  return `${weeks}w ago`
}

export default function SourcesView() {
  const [searchParams] = useSearchParams()

  // ── Sources data ──
  const { items: feedItems, loading: feedLoading, error: feedError, hasMore, loadMore, refetch: feedRefetch } = useActivityFeed()
  const [selectedFeedItem, setSelectedFeedItem] = useState<FeedItem | null>(null)

  // ── Ingestion methods data ──
  const { sources: automationSources, loading: methodsLoading, refetch: methodsRefetch } = useAutomationSources()
  const { keys: apiKeys } = useApiKeys()
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null)
  const [selectedIntegrationId, setSelectedIntegrationId] = useState<string | null>(null)
  const [manualUploadType, setManualUploadType] = useState<ManualUploadType | null>(null)
  const [methodsExpanded, setMethodsExpanded] = useState(false)
  const [globalTypeCounts, setGlobalTypeCounts] = useState<Array<{ source_type: string; count: number }>>([])

  const selectedAutomationSource = selectedSourceId ? automationSources.find(s => s.id === selectedSourceId) ?? null : null

  const groupedSources = (() => {
    return CATEGORY_ORDER
      .map(cat => ({
        category: cat,
        srcs: automationSources
          .filter(s => s.category === cat)
          .sort((a, b) => ((b.videosIngested ?? 0) + (b.meetingsIngested ?? 0)) - ((a.videosIngested ?? 0) + (a.meetingsIngested ?? 0))),
      }))
      .filter(g => g.srcs.length > 0)
  })()

  // Fetch global source type counts (all sources, not just paginated feed)
  useEffect(() => {
    fetchKnowledgeSnapshot().then(snap => {
      setGlobalTypeCounts(snap.sourceTypeCounts)
    }).catch(() => { /* ignore */ })
  }, [])

  const typeCounts: Record<string, number> = {}
  for (const { source_type, count } of globalTypeCounts) {
    typeCounts[source_type] = count
  }
  const totalSources = globalTypeCounts.reduce((s, t) => s + t.count, 0)

  // Auto-select source from URL param
  useEffect(() => {
    const sourceId = searchParams.get('sourceId')
    if (sourceId && feedItems.length > 0 && !selectedFeedItem) {
      const match = feedItems.find(i => i.source.id === sourceId)
      if (match) setSelectedFeedItem(match)
    }
  }, [searchParams, feedItems, selectedFeedItem])

  // ── Resizable layout ──
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

  const handleFeedItemSelect = useCallback((item: FeedItem) => {
    setSelectedFeedItem(item)
    setMethodsExpanded(false)
    if (leftWidthPct > 60) setLeftWidthPct(50)
  }, [leftWidthPct])

  const selectedFeed = selectedFeedItem
    ? feedItems.find(i => i.source.id === selectedFeedItem.source.id) ?? selectedFeedItem
    : null

  // ── Methods handlers ──
  const handleMethodCardClick = (id: string) => {
    setManualUploadType(null)
    setSelectedIntegrationId(null)
    setSelectedFeedItem(null)
    setSelectedSourceId(prev => prev === id ? null : id)
  }

  const handleMcpCardClick = () => {
    setManualUploadType(null)
    setSelectedSourceId(null)
    setSelectedFeedItem(null)
    setSelectedIntegrationId(prev => prev === 'mcp-access' ? null : 'mcp-access')
  }

  const handleConnectClick = () => {
    setManualUploadType(null)
    setSelectedSourceId(null)
    setSelectedIntegrationId(null)
    setSelectedFeedItem(null)
  }

  const handleSourceAdded = async (source: AutomationSource) => {
    await methodsRefetch()
    setSelectedSourceId(source.id)
  }

  // Determine right panel content
  const showMethodsPanel = selectedIntegrationId !== null || selectedSourceId !== null || manualUploadType !== null
  const showFeedDetail = selectedFeed !== null && !showMethodsPanel

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
          {totalSources} sources ingested
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
        {/* Left column */}
        <div
          className="h-full overflow-y-auto shrink-0"
          style={{
            width: `${leftWidthPct}%`,
            transition: isDragging ? 'none' : 'width 0.2s ease',
            padding: '20px 36px',
          }}
        >
          {/* ── Ingested From card ── */}
          <div
            style={{
              background: '#faf8f6',
              border: '1px solid #e8e0d8',
              borderRadius: 12,
              marginBottom: 20,
              overflow: 'hidden',
            }}
          >
            {/* Header row — always visible */}
            <button
              type="button"
              onClick={() => setMethodsExpanded(!methodsExpanded)}
              className="flex items-center w-full border-none cursor-pointer bg-transparent"
              style={{ padding: '14px 18px', gap: 10 }}
            >
              <div style={{
                transform: methodsExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
                transition: 'transform 0.15s ease',
                color: 'var(--color-text-secondary)',
                display: 'flex',
                alignItems: 'center',
              }}>
                <ChevronRight size={14} />
              </div>
              <span className="font-display" style={{ fontSize: 12, fontWeight: 700, color: 'var(--color-text-primary)', whiteSpace: 'nowrap', flexShrink: 0 }}>
                Ingested from
              </span>
              <div className="flex items-center flex-wrap" style={{ gap: 6, flex: 1 }}>
                {SOURCE_BADGES.map(badge => {
                  const count = typeCounts[badge.type] ?? 0
                  if (count === 0) return null
                  const Icon = badge.icon
                  return (
                    <span
                      key={badge.type}
                      className="font-body flex items-center"
                      style={{
                        fontSize: 11,
                        fontWeight: 600,
                        padding: '3px 10px',
                        borderRadius: 20,
                        background: badge.bg,
                        border: `1px solid ${badge.color}18`,
                        color: badge.color,
                        gap: 5,
                        whiteSpace: 'nowrap',
                      }}
                    >
                      <Icon size={12} />
                      {badge.label}
                      <span style={{ fontWeight: 700 }}>{count}</span>
                    </span>
                  )
                })}
              </div>
            </button>

            {/* Expanded: table-format connections list */}
            {methodsExpanded && (
              <div style={{ borderTop: '1px solid #e8e0d8' }}>
                {methodsLoading && automationSources.length === 0 && (
                  <p className="font-body" style={{ fontSize: 12, color: 'var(--color-text-secondary)', textAlign: 'center', padding: '16px 0' }}>
                    Loading connections…
                  </p>
                )}

                {/* API & MCP row */}
                <button
                  type="button"
                  onClick={handleMcpCardClick}
                  className="flex items-center w-full border-none cursor-pointer"
                  style={{
                    padding: '10px 18px',
                    background: selectedIntegrationId === 'mcp-access' ? 'rgba(214,58,0,0.04)' : 'transparent',
                    borderBottom: '1px solid #e8e0d820',
                    gap: 10,
                    transition: 'background 0.15s',
                  }}
                  onMouseEnter={e => { if (selectedIntegrationId !== 'mcp-access') e.currentTarget.style.background = 'rgba(0,0,0,0.02)' }}
                  onMouseLeave={e => { if (selectedIntegrationId !== 'mcp-access') e.currentTarget.style.background = 'transparent' }}
                >
                  <Plug2 size={13} style={{ color: '#d63a00', flexShrink: 0 }} />
                  <span className="font-body" style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text-primary)', flex: 1, textAlign: 'left' }}>
                    API &amp; MCP Access
                  </span>
                  <span className="font-body" style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>
                    {apiKeys.length} key{apiKeys.length !== 1 ? 's' : ''}
                  </span>
                  <div style={{ width: 6, height: 6, borderRadius: '50%', background: apiKeys.length > 0 ? '#10b981' : '#d1d5db', flexShrink: 0 }} />
                </button>

                {/* Automation source rows */}
                {groupedSources.map(({ category, srcs }) => (
                  <div key={category}>
                    <div style={{ padding: '8px 18px 4px', background: 'rgba(0,0,0,0.015)' }}>
                      <span className="font-display font-bold uppercase" style={{ fontSize: 9, letterSpacing: '0.08em', color: 'var(--color-text-placeholder)' }}>
                        {CATEGORY_LABELS[category]}
                      </span>
                    </div>
                    {srcs.map((source) => (
                      <button
                        key={source.id}
                        type="button"
                        onClick={() => handleMethodCardClick(source.id)}
                        className="flex items-center w-full border-none cursor-pointer"
                        style={{
                          padding: '8px 18px',
                          background: selectedSourceId === source.id ? 'rgba(214,58,0,0.04)' : 'transparent',
                          borderBottom: '1px solid #e8e0d820',
                          gap: 10,
                          transition: 'background 0.15s',
                        }}
                        onMouseEnter={e => { if (selectedSourceId !== source.id) e.currentTarget.style.background = 'rgba(0,0,0,0.02)' }}
                        onMouseLeave={e => { if (selectedSourceId !== source.id) e.currentTarget.style.background = 'transparent' }}
                      >
                        {source.category === 'youtube-playlist' ? (
                          <img src="/logos/youtube.svg" alt="YouTube" style={{ width: 14, height: 14, flexShrink: 0 }} />
                        ) : source.iconUrl ? (
                          <img src={source.iconUrl} alt="" style={{ width: 14, height: 14, borderRadius: 3, flexShrink: 0 }} />
                        ) : (
                          <div style={{ width: 14, height: 14, borderRadius: 3, background: 'var(--color-bg-inset)', flexShrink: 0 }} />
                        )}
                        <span className="font-body truncate" style={{ fontSize: 12, fontWeight: 500, color: 'var(--color-text-primary)', flex: 1, textAlign: 'left' }}>
                          {source.name}
                        </span>
                        {source.videosIngested != null && source.videosIngested > 0 && (
                          <span className="font-body" style={{ fontSize: 11, color: 'var(--color-text-secondary)', flexShrink: 0 }}>
                            {source.videosIngested} ingested
                          </span>
                        )}
                        {source.meetingsIngested != null && source.meetingsIngested > 0 && (
                          <span className="font-body" style={{ fontSize: 11, color: 'var(--color-text-secondary)', flexShrink: 0 }}>
                            {source.meetingsIngested} ingested
                          </span>
                        )}
                        {(source.lastScan || source.lastSync) && (
                          <span className="font-body" style={{ fontSize: 10, color: 'var(--color-text-placeholder)', flexShrink: 0 }}>
                            {timeAgo(source.lastScan ?? source.lastSync ?? null)}
                          </span>
                        )}
                        <div style={{
                          width: 6, height: 6, borderRadius: '50%', flexShrink: 0,
                          background: source.status === 'active' || source.status === 'connected' ? '#10b981' : '#d1d5db',
                        }} />
                      </button>
                    ))}
                  </div>
                ))}

                {/* Add connection row */}
                <button
                  type="button"
                  onClick={handleConnectClick}
                  className="flex items-center w-full border-none cursor-pointer"
                  style={{ padding: '10px 18px', background: 'transparent', gap: 8, transition: 'background 0.15s' }}
                  onMouseEnter={e => { e.currentTarget.style.background = 'rgba(0,0,0,0.02)' }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
                >
                  <Plus size={13} style={{ color: 'var(--color-accent-500)' }} />
                  <span className="font-body" style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-accent-500)' }}>
                    Connect a new source
                  </span>
                </button>
              </div>
            )}
          </div>

          {/* ── Feed list ── */}
          <FeedTab
            items={feedItems}
            loading={feedLoading}
            error={feedError}
            hasMore={hasMore}
            onLoadMore={loadMore}
            onRetry={feedRefetch}
            selectedSourceId={selectedFeed?.source.id ?? null}
            onItemSelect={handleFeedItemSelect}
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

        {/* Right column */}
        <div className="flex-1 h-full overflow-y-auto" style={{ minWidth: 0 }}>
          {manualUploadType !== null ? (
            <ManualUploadPanel
              type={manualUploadType}
              onBack={() => setManualUploadType(null)}
            />
          ) : selectedIntegrationId === 'mcp-access' ? (
            <McpAccessPanel
              onClose={() => setSelectedIntegrationId(null)}
            />
          ) : selectedAutomationSource ? (
            <SourceDetailPanel
              source={selectedAutomationSource}
              onClose={() => setSelectedSourceId(null)}
              onRefetch={methodsRefetch}
            />
          ) : showFeedDetail ? (
            <HomeFeedDetail
              item={selectedFeed}
              onClose={() => setSelectedFeedItem(null)}
              onSourceSelect={(sourceId) => {
                const found = feedItems.find(i => i.source.id === sourceId)
                if (found) handleFeedItemSelect(found)
              }}
            />
          ) : (
            <NewSourcePanel
              onSourceAdded={handleSourceAdded}
              onSelectMcp={handleMcpCardClick}
              onSelectManualUpload={(type) => {
                setSelectedSourceId(null)
                setSelectedIntegrationId(null)
                setManualUploadType(type)
              }}
            />
          )}
        </div>
      </div>
    </div>
  )
}
