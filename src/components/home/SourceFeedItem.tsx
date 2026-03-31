import { ChevronRight } from 'lucide-react'
import { ProviderIcon } from '../shared/ProviderIcon'
import type { KnowledgeSource } from '../../types/database'

interface SourceFeedItemProps {
  source: KnowledgeSource
  entityCount: number
  onClick: () => void
  stretch?: boolean
}

function formatRelativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime()
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  return `${Math.floor(days / 30)}mo ago`
}

export function SourceFeedItem({ source, entityCount, onClick, stretch }: SourceFeedItemProps) {
  const provider = (source.metadata as Record<string, unknown> | null)?.provider as string | undefined
  const summary = source.summary ?? null

  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full text-left bg-transparent cursor-pointer transition-all duration-150 hover:bg-bg-hover border-none"
      style={{
        gap: 14,
        padding: '14px 20px',
        borderBottom: '1px solid var(--border-subtle)',
        flex: stretch ? '1 1 0' : undefined,
        alignItems: 'flex-start',
      }}
    >
      <ProviderIcon
        sourceType={source.source_type}
        provider={provider}
        size={36}
        borderRadius={9}
      />

      <div className="flex-1 min-w-0">
        {/* Title row: name + time + stats + chevron */}
        <div className="flex items-center" style={{ gap: 8, marginBottom: summary ? 4 : 0 }}>
          <span
            className="font-display text-text-primary truncate flex-1"
            style={{ fontSize: 13, fontWeight: 700, letterSpacing: '-0.01em' }}
          >
            {source.title ?? 'Untitled'}
          </span>
          <span className="font-body text-text-placeholder shrink-0" style={{ fontSize: 11 }}>
            {formatRelativeTime(source.created_at)}
          </span>
          {entityCount > 0 && (
            <span
              className="font-body shrink-0"
              style={{
                fontSize: 10,
                fontWeight: 600,
                padding: '2px 7px',
                borderRadius: 4,
                background: 'rgba(0,0,0,0.04)',
                color: 'var(--color-text-secondary)',
              }}
            >
              {entityCount} entities
            </span>
          )}
          <ChevronRight size={13} style={{ color: 'var(--color-text-placeholder)', flexShrink: 0 }} />
        </div>

        {/* Summary */}
        {summary && (
          <p
            className="font-body text-text-secondary"
            style={{
              fontSize: 12,
              lineHeight: 1.5,
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
              margin: 0,
            }}
          >
            {summary}
          </p>
        )}
      </div>
    </button>
  )
}
