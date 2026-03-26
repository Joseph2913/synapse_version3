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
  const entityColor = node ? getEntityColor(node.entity_type) : '#808080'

  // Orphaned node — show with delete option
  if (!node) {
    return (
      <div
        style={{
          background: 'var(--color-bg-card)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 12,
          padding: '12px 16px',
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
        background: isSelected ? 'rgba(254,242,237,0.5)' : 'var(--color-bg-card)',
        border: `1px solid ${isSelected ? 'rgba(214,58,0,0.3)' : hovered ? 'var(--border-default, var(--border-subtle))' : 'var(--border-subtle)'}`,
        borderRadius: 12,
        padding: isSuggested ? '12px 16px 12px 16px' : '12px 16px 12px 16px',
        borderLeft: isSuggested ? `3px dashed ${entityColor}` : undefined,
        transform: hovered && !isSelected ? 'translateY(-1px)' : undefined,
        boxShadow: hovered && !isSelected ? '0 2px 8px rgba(0,0,0,0.04)' : undefined,
        transition: 'all 0.15s ease',
        animation: `fadeUp 0.4s ease ${index * 0.05}s both`,
      }}
    >
      {/* Solid left bar for confirmed/dormant */}
      {!isSuggested && (
        <div style={{
          position: 'absolute', left: 0, top: 0, bottom: 0, width: 3,
          background: entityColor, borderRadius: '12px 0 0 12px',
        }} />
      )}

      {/* Header row */}
      <div className="flex items-start justify-between gap-2" style={{ marginBottom: 4 }}>
        <div className="flex items-center gap-2 min-w-0">
          <div className="shrink-0" style={{ width: 8, height: 8, borderRadius: '50%', background: entityColor }} />
          <span className="font-display truncate" style={{ fontSize: 14, fontWeight: 700, color: 'var(--color-text-primary)' }}>
            {node.label}
          </span>
        </div>
        <div className="flex items-center gap-1 shrink-0">
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
          <EntityBadge type={node.entity_type} size="xs" />
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
      </div>

      {/* Reasoning text for suggested */}
      {isSuggested && candidate.reasoningText && (
        <p
          className="font-body truncate"
          style={{ fontSize: 11, color: 'var(--color-text-secondary)', fontStyle: 'italic', margin: '2px 0 6px 0' }}
        >
          {candidate.dismissCount >= 3 && 'You\'ve dismissed this before — it re-appeared because activity increased. '}
          {candidate.reasoningText}
        </p>
      )}

      {/* Parent badge for sub-anchors */}
      {parentLabel && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 4 }}>
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
      <div className="flex items-center gap-4" style={{ marginTop: 6, marginBottom: isSuggested ? 8 : 4 }}>
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

      {/* Bottom row: actions for suggested, timestamp for confirmed */}
      {isSuggested ? (
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
          <span className="flex-1" />
          <span className="font-body" style={{ fontSize: 10, color: 'var(--color-text-secondary)' }}>
            Detected {formatRelativeTime(candidate.firstScoredAt)}
          </span>
        </div>
      ) : (
        <div className="flex items-center justify-between" style={{ marginTop: 2 }}>
          <span className="font-body" style={{ fontSize: 10, color: 'var(--color-text-secondary)' }}>
            Updated {formatRelativeTime(candidate.updatedAt)}
          </span>
        </div>
      )}
    </div>
  )
}
