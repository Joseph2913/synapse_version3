import { useNavigate } from 'react-router-dom'
import { Inbox, Database } from 'lucide-react'
import { SourceFeedItem } from './SourceFeedItem'
import type { KnowledgeSource } from '../../types/database'

interface RecentSourcesPanelProps {
  sources: KnowledgeSource[]
  entityCounts: Record<string, number>
  loading: boolean
  error?: string
  onSourceClick: (source: KnowledgeSource) => void
  onExploreSource?: (source: KnowledgeSource) => void
  onChatWithSource?: (source: KnowledgeSource) => void
  onGraphSource?: (source: KnowledgeSource) => void
  stretch?: boolean
}

export function RecentSourcesPanel({
  sources,
  entityCounts,
  loading,
  error,
  onSourceClick,
  onExploreSource,
  onChatWithSource,
  onGraphSource,
  stretch,
}: RecentSourcesPanelProps) {
  const navigate = useNavigate()

  return (
    <div
      className={`bg-bg-card border border-border-subtle overflow-hidden ${stretch ? 'flex flex-col' : ''}`}
      style={{ borderRadius: 12, height: stretch ? '100%' : undefined }}
    >
      {/* Header */}
      <div
        className="flex items-center justify-between shrink-0"
        style={{ padding: '12px 20px' }}
      >
        <div className="flex items-center" style={{ gap: 10 }}>
          <div
            className="shrink-0 flex items-center justify-center"
            style={{ width: 28, height: 28, borderRadius: 8, background: 'var(--color-accent-50)' }}
          >
            <Database size={14} style={{ color: 'var(--color-accent-500)' }} />
          </div>
          <span
            className="font-display text-text-primary"
            style={{ fontSize: 13, fontWeight: 700, letterSpacing: '-0.01em' }}
          >
            Recent Sources
          </span>
        </div>
        <button
          type="button"
          onClick={() => navigate('/sources')}
          className="font-body cursor-pointer bg-transparent border-none"
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: 'var(--color-accent-500)',
            padding: '4px 12px',
            borderRadius: 6,
            border: '1px solid rgba(214,58,0,0.15)',
            background: 'var(--color-accent-50)',
            transition: 'all 0.15s ease',
          }}
        >
          View all →
        </button>
      </div>

      {/* Content — flex-1 to fill remaining height when stretch is enabled */}
      {loading ? (
        <div style={{ padding: '18px 22px' }} className="flex flex-col">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="flex items-center" style={{ gap: 14, padding: '14px 0', borderBottom: i < 2 ? '1px solid var(--border-subtle)' : 'none' }}>
              <div className="bg-bg-inset animate-pulse" style={{ width: 36, height: 36, borderRadius: 9, flexShrink: 0 }} />
              <div className="flex-1">
                <div className="bg-bg-inset animate-pulse" style={{ height: 13, borderRadius: 4, width: '75%', marginBottom: 6 }} />
                <div className="bg-bg-inset animate-pulse" style={{ height: 12, borderRadius: 4, width: '90%' }} />
              </div>
            </div>
          ))}
        </div>
      ) : error ? (
        <div style={{ padding: '20px 22px' }}>
          <p className="font-body text-text-secondary" style={{ fontSize: 13, fontStyle: 'italic' }}>{error}</p>
        </div>
      ) : sources.length === 0 ? (
        <div className="flex flex-col items-center text-center" style={{ padding: '40px 22px' }}>
          <Inbox size={32} style={{ color: 'var(--color-text-secondary)', marginBottom: 12 }} />
          <p className="font-display text-text-primary" style={{ fontSize: 15, fontWeight: 700, marginBottom: 4 }}>
            No sources yet
          </p>
          <p className="font-body text-text-secondary" style={{ fontSize: 13, marginBottom: 16 }}>
            Ingest your first document, meeting, or video to get started.
          </p>
          <button
            type="button"
            onClick={() => navigate('/capture')}
            className="font-body cursor-pointer border-none"
            style={{
              fontSize: 13,
              fontWeight: 600,
              color: 'var(--color-accent-500)',
              background: 'var(--color-accent-50)',
              border: '1px solid rgba(214,58,0,0.15)',
              padding: '8px 20px',
              borderRadius: 8,
            }}
          >
            Go to Capture
          </button>
        </div>
      ) : (
        <div className={stretch ? 'flex flex-col flex-1' : ''}>
          {sources.map((source) => (
            <SourceFeedItem
              key={source.id}
              source={source}
              entityCount={entityCounts[source.id] ?? 0}
              onClick={() => onSourceClick(source)}
              onExplore={onExploreSource}
              onChat={onChatWithSource}
              onGraph={onGraphSource}
              stretch={stretch}
            />
          ))}
        </div>
      )}
    </div>
  )
}
