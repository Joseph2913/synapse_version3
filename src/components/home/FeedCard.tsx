import { useMemo } from 'react'
import { ArrowRight } from 'lucide-react'
import { useGraphContext } from '../../hooks/useGraphContext'
import { ProviderIcon } from '../shared/ProviderIcon'
import { fetchNodeById, fetchSourceById } from '../../services/supabase'
import { stripMarkdown } from '../../utils/stripMarkdown'
import type { FeedItem } from '../../types/feed'

function formatRelativeTime(dateStr: string): string {
  const now = Date.now()
  const then = new Date(dateStr).getTime()
  const diff = now - then
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  const weeks = Math.floor(days / 7)
  if (weeks < 4) return `${weeks}w ago`
  return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

// ─── Feed Card ────────────────────────────────────────────────────────────────

interface FeedCardProps {
  item: FeedItem
  animDelay: number
  isSelected: boolean
  onItemSelect: (item: FeedItem) => void
}

export function FeedCard({ item, animDelay, isSelected, onItemSelect }: FeedCardProps) {
  const { setRightPanelContent } = useGraphContext()

  const sourceProvider = (item.source.metadata as Record<string, unknown> | null)?.provider as string | undefined

  const handleNodeClick = async (nodeId: string, e: React.MouseEvent) => {
    e.stopPropagation()
    const node = await fetchNodeById(nodeId)
    if (node) setRightPanelContent({ type: 'node', data: node })
  }

  const handleSourceLinkClick = async (sourceId: string, e: React.MouseEvent) => {
    e.stopPropagation()
    const source = await fetchSourceById(sourceId)
    if (source) setRightPanelContent({ type: 'source', data: source })
  }

  // Build unified connections list to derive anchor/source chips
  const allConnections = useMemo(() => [
    ...item.withinSourceConnections.map(cc => ({
      ...cc,
      isExternal: false,
      sourceName: null as string | null,
      toSourceId: null as string | null,
    })),
    ...item.crossConnections.map(cc => ({
      ...cc,
      isExternal: true,
      sourceName: cc.toSourceTitle,
      toSourceId: cc.toSourceId,
    })),
  ], [item.withinSourceConnections, item.crossConnections])

  // Unique anchors connected to by this source's entities
  const uniqueAnchors = useMemo(() => {
    const seen = new Set<string>()
    const result: { nodeId: string; label: string }[] = []
    allConnections.forEach(c => {
      if (c.isAnchor && !seen.has(c.toNodeId)) {
        seen.add(c.toNodeId)
        result.push({ nodeId: c.toNodeId, label: c.toLabel })
      }
    })
    return result
  }, [allConnections])

  // Unique external non-anchor sources
  const uniqueExternalSources = useMemo(() => {
    const seen = new Set<string>()
    const result: { sourceId: string; title: string }[] = []
    allConnections.forEach(c => {
      if (!c.isAnchor && c.isExternal && c.toSourceId && !seen.has(c.toSourceId)) {
        seen.add(c.toSourceId)
        result.push({ sourceId: c.toSourceId, title: c.sourceName ?? 'Source' })
      }
    })
    return result
  }, [allConnections])

  const pillLabel = allConnections.length > 0
    ? `${item.entityCount} entities · ${allConnections.length} connections`
    : `${item.entityCount} entities`

  return (
    <div
      className="rounded-[12px]"
      style={{
        background: isSelected
          ? 'linear-gradient(135deg, rgba(214,58,0,0.04) 0%, rgba(214,58,0,0.015) 100%)'
          : 'var(--color-bg-card)',
        border: isSelected ? '1px solid rgba(214,58,0,0.2)' : '1px solid var(--border-subtle)',
        padding: '14px 16px',
        marginBottom: 8,
        boxShadow: isSelected ? 'var(--shadow-md)' : 'var(--shadow-sm)',
        animation: 'fadeUp 0.4s var(--ease-out-expo) both',
        animationDelay: `${animDelay}s`,
        transition: 'all 0.2s var(--ease-out-expo)',
      }}
    >
      {/* ── Header: clickable → selects this item ── */}
      <button
        type="button"
        onClick={() => onItemSelect(item)}
        className="w-full text-left flex items-center gap-2.5 rounded-md"
        style={{
          background: 'transparent',
          border: 'none',
          padding: '2px 4px',
          margin: '-2px -4px',
          transition: 'background 0.15s ease',
          cursor: 'pointer',
        }}
        onMouseEnter={e => { ;(e.currentTarget as HTMLButtonElement).style.background = 'var(--color-bg-inset)' }}
        onMouseLeave={e => { ;(e.currentTarget as HTMLButtonElement).style.background = 'transparent' }}
      >
        <ProviderIcon sourceType={item.source.source_type} provider={sourceProvider} size={26} borderRadius={6} />
        <div className="min-w-0 flex-1">
          <p
            className="font-display font-bold text-text-primary"
            style={{ fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          >
            {item.source.title ?? 'Untitled Source'}
          </p>
          <p className="font-body" style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>
            {formatRelativeTime(item.source.created_at)}
          </p>
        </div>
      </button>

      {/* ── Summary ── */}
      {item.summary && (
        <p
          className="font-body"
          style={{
            fontSize: 12,
            color: item.isFallbackSummary ? 'var(--color-text-secondary)' : 'var(--color-text-body)',
            fontStyle: item.isFallbackSummary ? 'italic' : 'normal',
            lineHeight: 1.5,
            marginTop: 8,
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
          }}
        >
          {stripMarkdown(item.summary)}
        </p>
      )}

      {/* ── Related Anchors chips ── */}
      {uniqueAnchors.length > 0 && (
        <div className="flex items-center flex-wrap" style={{ gap: '4px 6px', marginTop: 8 }}>
          <span
            className="font-display font-bold uppercase"
            style={{ fontSize: 9, letterSpacing: '0.07em', color: '#b45309', flexShrink: 0 }}
          >
            Related Anchors
          </span>
          {uniqueAnchors.map(a => (
            <button
              key={a.nodeId}
              type="button"
              onClick={e => handleNodeClick(a.nodeId, e)}
              className="font-body font-semibold cursor-pointer"
              style={{
                fontSize: 10,
                padding: '2px 8px',
                borderRadius: 20,
                border: '1px solid rgba(180,83,9,0.25)',
                background: 'rgba(180,83,9,0.07)',
                color: '#b45309',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                maxWidth: 160,
                transition: 'background 0.12s ease',
              }}
              onMouseEnter={e => { ;(e.currentTarget as HTMLButtonElement).style.background = 'rgba(180,83,9,0.14)' }}
              onMouseLeave={e => { ;(e.currentTarget as HTMLButtonElement).style.background = 'rgba(180,83,9,0.07)' }}
              title={a.label}
            >
              {a.label}
            </button>
          ))}
        </div>
      )}

      {/* ── Related Sources chips ── */}
      {uniqueExternalSources.length > 0 && (
        <div className="flex items-center flex-wrap" style={{ gap: '4px 6px', marginTop: 6 }}>
          <span
            className="font-display font-bold uppercase"
            style={{ fontSize: 9, letterSpacing: '0.07em', color: 'var(--color-text-secondary)', flexShrink: 0 }}
          >
            Related Sources
          </span>
          {uniqueExternalSources.map(s => (
            <button
              key={s.sourceId}
              type="button"
              onClick={e => handleSourceLinkClick(s.sourceId, e)}
              className="font-body font-semibold cursor-pointer"
              style={{
                fontSize: 10,
                padding: '2px 8px',
                borderRadius: 20,
                border: '1px solid var(--border-subtle)',
                background: 'var(--color-bg-inset)',
                color: 'var(--color-text-secondary)',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                maxWidth: 160,
                transition: 'background 0.12s ease',
              }}
              onMouseEnter={e => { ;(e.currentTarget as HTMLButtonElement).style.background = 'var(--color-bg-hover, var(--color-bg-card))' }}
              onMouseLeave={e => { ;(e.currentTarget as HTMLButtonElement).style.background = 'var(--color-bg-inset)' }}
              title={s.title}
            >
              {s.title}
            </button>
          ))}
        </div>
      )}

      {/* ── Stats + Explore More CTA ── */}
      {item.entityCount > 0 && (
        <div className="flex items-center justify-between" style={{ marginTop: 10 }}>
          <span
            className="font-body"
            style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}
          >
            {pillLabel}
          </span>
          <button
            type="button"
            onClick={e => { e.stopPropagation(); onItemSelect(item) }}
            className="inline-flex items-center gap-1.5 font-body font-semibold cursor-pointer"
            style={{
              fontSize: 11,
              padding: '4px 10px',
              borderRadius: 6,
              border: isSelected ? '1px solid rgba(214,58,0,0.2)' : '1px solid var(--border-subtle)',
              background: isSelected ? 'rgba(214,58,0,0.07)' : 'var(--color-bg-inset)',
              color: isSelected ? 'var(--color-accent-500)' : 'var(--color-text-secondary)',
              transition: 'all 0.2s var(--ease-out-expo)',
            }}
          >
            Explore More <ArrowRight size={11} />
          </button>
        </div>
      )}
    </div>
  )
}
