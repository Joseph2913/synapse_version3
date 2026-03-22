import { useState } from 'react'
import type { AutomationSource } from '../../services/automationSources'
import { StatusLabel } from '../shared/StatusIndicator'
import { ProviderIcon } from '../shared/ProviderIcon'

interface SourceCardProps {
  source: AutomationSource
  isSelected: boolean
  onClick: () => void
  index?: number
}


function getModeColor(mode: string): string {
  switch (mode) {
    case 'comprehensive': return '#0891b2'
    case 'strategic': return '#e11d48'
    case 'actionable': return '#2563eb'
    case 'relational': return '#7c3aed'
    default: return '#6b7280'
  }
}

export function SourceCard({ source, isSelected, onClick, index = 0 }: SourceCardProps) {
  const [hovered, setHovered] = useState(false)
  const queueCount = source.queue.pending + source.queue.processing
  const modeColor = getModeColor(source.mode)

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') onClick() }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        padding: '16px 22px',
        borderRadius: 12,
        background: 'var(--color-bg-card)',
        border: isSelected
          ? '1px solid rgba(214,58,0,0.3)'
          : hovered
            ? '1px solid var(--border-default)'
            : '1px solid var(--border-subtle)',
        backgroundColor: isSelected
          ? 'rgba(254,242,237,0.5)'
          : 'var(--color-bg-card)',
        cursor: 'pointer',
        transition: 'all 0.18s ease',
        transform: hovered && !isSelected ? 'translateY(-1px)' : undefined,
        boxShadow: hovered && !isSelected ? '0 2px 8px rgba(0,0,0,0.04)' : undefined,
        animation: `fadeUp 0.3s ease ${index * 0.05}s both`,
        outline: 'none',
      }}
    >
      {/* Top row */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 8 }}>
        {/* Left: icon + name */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <ProviderIcon
            sourceType={source.category === 'microsoft' ? 'Research' : source.category === 'meeting' ? 'Meeting' : 'YouTube'}
            provider={source.provider ?? (source.category === 'youtube-playlist' ? 'youtube' : source.category === 'microsoft' ? 'microsoft' : undefined)}
            size={32}
          />
          <div>
            <div
              className="font-display"
              style={{ fontSize: 14, fontWeight: 700, color: 'var(--color-text-primary)' }}
            >
              {source.name}
            </div>
            <div
              className="font-body"
              style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}
            >
              {source.handle
                ? source.handle
                : source.channel
                  ? source.channel
                  : source.category === 'microsoft'
                    ? 'Outlook & Teams'
                    : source.category === 'meeting'
                      ? 'Meeting Integration'
                      : 'YouTube Playlist'}
            </div>
          </div>
        </div>

        {/* Right: queue badge + status */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          {queueCount > 0 && (
            <span
              className="font-body"
              style={{
                padding: '2px 7px',
                borderRadius: 10,
                fontSize: 10,
                fontWeight: 700,
                background: 'rgba(59,130,246,0.08)',
                color: '#3b82f6',
              }}
            >
              {queueCount} in queue
            </span>
          )}
          <StatusLabel status={source.status} />
        </div>
      </div>

      {/* Description */}
      {source.description && (
        <div
          className="font-body"
          style={{
            fontSize: 12,
            color: 'var(--color-text-body)',
            lineHeight: 1.5,
            marginBottom: 10,
          }}
        >
          {source.description}
        </div>
      )}

      {/* Stats row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
        {source.videosIngested !== undefined && (
          <span className="font-body" style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>
            <span style={{ fontWeight: 600, color: 'var(--color-text-body)' }}>
              {source.videosIngested}
            </span>{' '}
            videos ingested
          </span>
        )}
        {source.meetingsIngested !== undefined && (
          <span className="font-body" style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>
            <span style={{ fontWeight: 600, color: 'var(--color-text-body)' }}>
              {source.meetingsIngested}
            </span>{' '}
            {source.category === 'microsoft' ? 'items ingested' : 'meetings ingested'}
          </span>
        )}
        {(source.lastScan || source.lastSync) && (
          <span className="font-body" style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>
            Last scan:{' '}
            <span style={{ fontWeight: 500 }}>{source.lastScan ?? source.lastSync}</span>
          </span>
        )}
        {/* Mode badge */}
        <span
          className="font-body"
          style={{
            padding: '1px 6px',
            borderRadius: 4,
            fontSize: 10,
            fontWeight: 700,
            background: modeColor + '14',
            color: modeColor,
            textTransform: 'capitalize',
          }}
        >
          {source.mode}
        </span>
      </div>
    </div>
  )
}
