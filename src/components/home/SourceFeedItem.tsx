import { useState } from 'react'
import { ChevronRight, Search, MessageSquare, GitFork, Network, Link2, Layers } from 'lucide-react'
import { ProviderIcon } from '../shared/ProviderIcon'
import { SpotlightCard } from '../ui/SpotlightCard'
import type { KnowledgeSource } from '../../types/database'

interface SourceFeedItemProps {
  source: KnowledgeSource
  entityCount: number
  crossConnectionCount?: number
  relatedSourceCount?: number
  onClick: () => void
  onExplore?: (source: KnowledgeSource) => void
  onChat?: (source: KnowledgeSource) => void
  onGraph?: (source: KnowledgeSource) => void
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

const SOURCE_TYPE_COLORS: Record<string, string> = {
  YouTube:  'rgba(239, 68, 68, 0.08)',
  Meeting:  'rgba(59, 130, 246, 0.08)',
  Document: 'rgba(217, 119, 6, 0.08)',
  Note:     'rgba(16, 185, 129, 0.08)',
  Research: 'rgba(139, 92, 246, 0.08)',
  API:      'rgba(99, 102, 241, 0.08)',
  Email:    'rgba(0, 120, 212, 0.08)',
}

function getSpotlightColor(sourceType: string): string {
  return SOURCE_TYPE_COLORS[sourceType] ?? 'rgba(214, 58, 0, 0.06)'
}

function Stat({ icon, value, label }: { icon: React.ReactNode; value: number; label: string }) {
  return (
    <span
      className="flex items-center font-body text-text-secondary"
      style={{ gap: 4, fontSize: 11, fontVariantNumeric: 'tabular-nums' }}
      title={`${value} ${label}`}
    >
      <span style={{ color: 'var(--color-text-placeholder)', display: 'flex' }}>{icon}</span>
      <span style={{ fontWeight: 600, color: 'var(--color-text-body)' }}>{value}</span>
      <span style={{ color: 'var(--color-text-placeholder)' }}>{label}</span>
    </span>
  )
}

export function SourceFeedItem({ source, entityCount, crossConnectionCount, relatedSourceCount, onClick, onExplore, onChat, onGraph, stretch }: SourceFeedItemProps) {
  const provider = (source.metadata as Record<string, unknown> | null)?.provider as string | undefined
  const [hovered, setHovered] = useState(false)

  return (
    <SpotlightCard
      color={getSpotlightColor(source.source_type ?? '')}
      radius={140}
      style={{
        borderBottom: '1px solid var(--border-subtle)',
        flex: stretch ? '1 1 0' : undefined,
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Main row content — two lines: title, then stats */}
      <button
        type="button"
        onClick={onClick}
        className="flex w-full text-left bg-transparent cursor-pointer border-none items-start"
        style={{
          gap: 12,
          padding: '12px 20px',
          background: 'transparent',
        }}
      >
        <ProviderIcon
          sourceType={source.source_type}
          provider={provider}
          size={32}
          borderRadius={8}
        />

        <div className="flex-1 min-w-0">
          {/* Line 1: title + chevron */}
          <div className="flex items-center" style={{ gap: 8, marginBottom: 6 }}>
            <span
              className="font-display text-text-primary truncate flex-1 min-w-0"
              style={{ fontSize: 13, fontWeight: 700, letterSpacing: '-0.01em' }}
            >
              {source.title ?? 'Untitled'}
            </span>
            <ChevronRight size={13} style={{ color: 'var(--color-text-placeholder)', flexShrink: 0 }} />
          </div>

          {/* Line 2: stats + timestamp */}
          <div className="flex items-center" style={{ gap: 14 }}>
            <Stat icon={<Layers size={11} />} value={entityCount} label="entities" />
            <Stat icon={<Network size={11} />} value={crossConnectionCount ?? 0} label="connections" />
            <Stat icon={<Link2 size={11} />} value={relatedSourceCount ?? 0} label="related" />
            <span className="font-body text-text-placeholder shrink-0" style={{ fontSize: 11, marginLeft: 'auto' }}>
              {formatRelativeTime(source.created_at)}
            </span>
          </div>
        </div>
      </button>

      {/* Action buttons — slide in from right on hover */}
      <div
        style={{
          position: 'absolute',
          top: 0,
          right: 0,
          bottom: 0,
          width: 210,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 2,
          transform: hovered ? 'translateX(0)' : 'translateX(210px)',
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

        {/* Graph view */}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onGraph?.(source)
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
          <GitFork size={16} />
          <span className="font-body" style={{ fontSize: 9, fontWeight: 600 }}>Graph</span>
        </button>
      </div>
    </SpotlightCard>
  )
}
