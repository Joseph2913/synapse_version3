import { useState } from 'react'
import { ChevronRight, Search, MessageSquare } from 'lucide-react'
import { ProviderIcon } from '../shared/ProviderIcon'
import type { KnowledgeSource } from '../../types/database'

interface SourceFeedItemProps {
  source: KnowledgeSource
  entityCount: number
  onClick: () => void
  onExplore?: (source: KnowledgeSource) => void
  onChat?: (source: KnowledgeSource) => void
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

export function SourceFeedItem({ source, entityCount, onClick, onExplore, onChat, stretch }: SourceFeedItemProps) {
  const provider = (source.metadata as Record<string, unknown> | null)?.provider as string | undefined
  const summary = source.summary ?? null
  const [hovered, setHovered] = useState(false)

  return (
    <div
      className="relative overflow-hidden"
      style={{
        borderBottom: '1px solid var(--border-subtle)',
        flex: stretch ? '1 1 0' : undefined,
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Main row content — shifts left on hover */}
      <button
        type="button"
        onClick={onClick}
        className="flex w-full text-left bg-transparent cursor-pointer border-none"
        style={{
          gap: 14,
          padding: '14px 20px',
          alignItems: 'flex-start',
          background: hovered ? 'var(--color-bg-hover)' : 'transparent',
          transition: 'background 0.15s ease',
        }}
      >
        <ProviderIcon
          sourceType={source.source_type}
          provider={provider}
          size={36}
          borderRadius={9}
        />

        <div className="flex-1 min-w-0">
          {/* Title row */}
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

      {/* Action buttons — slide in from right on hover */}
      <div
        style={{
          position: 'absolute',
          top: 0,
          right: 0,
          bottom: 0,
          width: 144,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 2,
          transform: hovered ? 'translateX(0)' : 'translateX(144px)',
          transition: 'transform 0.2s ease',
          background: 'var(--color-bg-card)',
          borderLeft: '1px solid var(--border-subtle)',
        }}
      >
        {/* Explore more */}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onExplore?.(source)
          }}
          className="flex flex-col items-center justify-center cursor-pointer"
          style={{
            width: 66,
            height: '100%',
            background: 'transparent',
            border: 'none',
            gap: 4,
            color: 'var(--color-text-secondary)',
            transition: 'color 0.15s ease, background 0.15s ease',
            borderRadius: 6,
          }}
          onMouseEnter={e => {
            e.currentTarget.style.color = 'var(--color-accent-500)'
            e.currentTarget.style.background = 'var(--color-accent-50)'
          }}
          onMouseLeave={e => {
            e.currentTarget.style.color = 'var(--color-text-secondary)'
            e.currentTarget.style.background = 'transparent'
          }}
        >
          <Search size={16} />
          <span className="font-body" style={{ fontSize: 9, fontWeight: 600 }}>Explore</span>
        </button>

        {/* Chat with */}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onChat?.(source)
          }}
          className="flex flex-col items-center justify-center cursor-pointer"
          style={{
            width: 66,
            height: '100%',
            background: 'transparent',
            border: 'none',
            gap: 4,
            color: 'var(--color-text-secondary)',
            transition: 'color 0.15s ease, background 0.15s ease',
            borderRadius: 6,
          }}
          onMouseEnter={e => {
            e.currentTarget.style.color = 'var(--color-accent-500)'
            e.currentTarget.style.background = 'var(--color-accent-50)'
          }}
          onMouseLeave={e => {
            e.currentTarget.style.color = 'var(--color-text-secondary)'
            e.currentTarget.style.background = 'transparent'
          }}
        >
          <MessageSquare size={16} />
          <span className="font-body" style={{ fontSize: 9, fontWeight: 600 }}>Chat</span>
        </button>
      </div>
    </div>
  )
}
