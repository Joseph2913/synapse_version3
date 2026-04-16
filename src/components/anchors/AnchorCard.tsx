import { useState } from 'react'
import { Network, FileText, Link2 } from 'lucide-react'
import { getEntityColor } from '../../config/entityTypes'
import { EntityBadge } from '../shared/EntityBadge'
import type { AnchorCandidateWithNode } from '../../types/anchors'

interface AnchorCardProps {
  candidate: AnchorCandidateWithNode
  isSelected: boolean
  onClick: () => void
  onConfirm: (candidateId: string, nodeId: string) => void
  onDismiss: (candidateId: string, dismissCount: number) => void
  onDelete?: (candidateId: string) => void
  index: number
  parentLabel?: string  // PRD-22: populated when this is a sub-anchor
}

function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

export function AnchorCard({ candidate, isSelected, onClick, onConfirm, onDismiss, onDelete, index, parentLabel }: AnchorCardProps) {
  const [hovered, setHovered] = useState(false)
  const node = candidate.node
  const isSuggested = candidate.status === 'suggested'
  const isDormant = candidate.status === 'dormant'
  const isManual = candidate.compositeScore === 1
  const entityColor = node ? getEntityColor(node.entity_type) : '#808080'

  // Orphaned node — show with delete option
  if (!node) {
    return (
      <div
      style={{
          background: 'var(--color-bg-card)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 12,
          padding: '16px 18px',
          opacity: 0.5,
          animation: `fadeUp 0.4s ease ${index * 0.05}s both`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <span className="font-body" style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
          Deleted node
        </span>
        <button
          type="button"
          onClick={e => { e.stopPropagation(); onDelete?.(candidate.id) }}
          className="font-body"
          style={{
            fontSize: 11, fontWeight: 600, color: 'var(--semantic-red-500, #ef4444)',
            background: 'none', border: 'none', cursor: 'pointer', padding: '2px 8px',
          }}
        >
          Remove
        </button>
      </div>
    )
  }

  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className="cursor-pointer"
      style={{
        position: 'relative',
        overflow: 'hidden',
        background: isSelected
          ? 'var(--color-accent-50)'
          : `linear-gradient(135deg, ${entityColor}08 0%, ${entityColor}03 100%)`,
        border: `1px solid ${isSelected ? 'rgba(214,58,0,0.3)' : hovered ? `${entityColor}25` : 'var(--border-subtle)'}`,
        borderRadius: 12,
        padding: '16px 18px',
        transform: hovered && !isSelected ? 'translateY(-1px)' : undefined,
        boxShadow: hovered && !isSelected ? 'var(--shadow-md)' : 'var(--shadow-sm)',
        transition: 'all 0.2s var(--ease-out-expo)',
        animation: `fadeUp 0.4s var(--ease-out-expo) ${index * 0.05}s both`,
      }}
    >

      {/* Header row */}
      <div className="flex items-start justify-between gap-3" style={{ marginBottom: 8 }}>
        <div className="flex items-center gap-2 min-w-0">
          <div className="shrink-0" style={{
            width: isSuggested ? 10 : 8,
            height: isSuggested ? 10 : 8,
            borderRadius: '50%',
            background: entityColor,
            boxShadow: `0 0 0 3px ${entityColor}15`,
            transition: 'all 0.2s var(--ease-out-expo)',
          }} />
          <span className="font-display truncate" style={{ fontSize: 14, fontWeight: 700, color: 'var(--color-text-primary)' }}>
            {node.label}
          </span>
        </div>
        <span
          className="shrink-0 font-body"
          style={{
            fontSize: 11,
            color: 'var(--color-text-secondary)',
            whiteSpace: 'nowrap',
          }}
        >
          {isSuggested ? `Detected ${formatRelativeTime(candidate.firstScoredAt)}` : `Updated ${formatRelativeTime(candidate.updatedAt)}`}
        </span>
      </div>

      <div className="flex items-center gap-1 flex-wrap" style={{ marginBottom: 10 }}>
        <EntityBadge type={node.entity_type} size="xs" />
        {isManual && !isSuggested && !isDormant && (
          <span style={{
            fontSize: 10, fontWeight: 700, color: 'var(--color-accent-500)',
            background: 'var(--color-accent-50)', border: '1px solid rgba(214,58,0,0.15)',
            padding: '2px 7px', borderRadius: 4,
          }}>
            Manual
          </span>
        )}
        {isSuggested && (
          <span style={{
            fontSize: 10, fontWeight: 700, color: '#d97706',
            background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.2)',
            padding: '2px 7px', borderRadius: 4,
          }}>
            ✦ Suggested
          </span>
        )}
        {isDormant && (
          <span style={{
            fontSize: 10, fontWeight: 700, color: '#d97706',
            background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.2)',
            padding: '2px 7px', borderRadius: 4,
          }}>
            ◑ Dormant
          </span>
        )}
        {isSuggested && (() => {
          const pct = Math.round(candidate.compositeScore * 100)
          const isGreen = pct >= 60
          const isAmber = pct >= 50 && pct < 60
          return (
            <span style={{
              fontFamily: 'var(--font-body)', fontSize: 10, fontWeight: 700,
              padding: '2px 7px', borderRadius: 4,
              background: isGreen ? 'rgba(34,197,94,0.08)' : isAmber ? 'rgba(245,158,11,0.08)' : 'rgba(0,0,0,0.04)',
              border: `1px solid ${isGreen ? 'rgba(34,197,94,0.25)' : isAmber ? 'rgba(245,158,11,0.25)' : 'rgba(0,0,0,0.08)'}`,
              color: isGreen ? '#16a34a' : isAmber ? '#d97706' : 'var(--color-text-secondary)',
            }}>
              {pct}%
            </span>
          )
        })()}
      </div>

      {/* Reasoning text for suggested */}
      {isSuggested && candidate.reasoningText && (
        <p
          className="font-body truncate"
          style={{ fontSize: 11, color: 'var(--color-text-secondary)', fontStyle: 'italic', margin: '0 0 8px 0' }}
        >
          {candidate.dismissCount >= 3 && 'You\'ve dismissed this before — it re-appeared because activity increased. '}
          {candidate.reasoningText}
        </p>
      )}

      {/* Parent badge for sub-anchors */}
      {parentLabel && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 8 }}>
          <span className="font-body" style={{ fontSize: 9, color: 'var(--color-text-secondary)' }}>
            sub-anchor of
          </span>
          <span className="font-body" style={{
            fontSize: 9, fontWeight: 600,
            color: 'var(--color-text-secondary)',
            background: 'var(--color-bg-inset)',
            padding: '1px 6px', borderRadius: 4,
            border: '1px solid var(--border-subtle)',
          }}>
            {parentLabel}
          </span>
        </div>
      )}

      {/* Stats row */}
      <div className="flex items-center gap-4 flex-wrap" style={{ marginTop: 0, marginBottom: isSuggested ? 12 : 0 }}>
        <span className="flex items-center gap-1 font-body" style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>
          <Network size={10} /> <span style={{ fontWeight: 600, color: 'var(--color-text-body)' }}>{candidate.connectionCount}</span> nodes
        </span>
        <span className="flex items-center gap-1 font-body" style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>
          <FileText size={10} /> <span style={{ fontWeight: 600, color: 'var(--color-text-body)' }}>{candidate.sourceCount}</span> sources
        </span>
        <span className="flex items-center gap-1 font-body" style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>
          <Link2 size={10} /> <span style={{ fontWeight: 600, color: 'var(--color-text-body)' }}>{isSuggested ? candidate.connectionCount : candidate.anchorConnections}</span> {isSuggested ? 'edges' : 'connections'}
        </span>
      </div>

      {/* Bottom row: actions for suggested */}
      {isSuggested && (
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={e => { e.stopPropagation(); onConfirm(candidate.id, node.id) }}
            className="font-body"
            style={{
              background: 'var(--color-accent-500)', color: 'white',
              fontSize: 11, fontWeight: 600, padding: '4px 12px', borderRadius: 6, border: 'none', cursor: 'pointer',
            }}
          >
            Confirm ✓
          </button>
          <button
            type="button"
            onClick={e => { e.stopPropagation(); onDismiss(candidate.id, candidate.dismissCount) }}
            className="font-body"
            style={{
              background: 'transparent', border: '1px solid var(--border-subtle)',
              color: 'var(--color-text-secondary)', fontSize: 11, fontWeight: 600,
              padding: '4px 10px', borderRadius: 6, cursor: 'pointer',
            }}
          >
            Dismiss ×
          </button>
        </div>
      )}
    </div>
  )
}
