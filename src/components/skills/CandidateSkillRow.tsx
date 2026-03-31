import { useState } from 'react'
import { X, Loader2 } from 'lucide-react'
import { DomainBadge } from './SkillCard'
import { SkillConfidenceBar } from './SkillConfidenceBar'
import type { Skill } from '../../hooks/useSkills'

interface CandidateSkillRowProps {
  skill: Skill
  onSelect: () => void
  onConfirm: () => Promise<void>
  onDismiss: () => Promise<void>
}

function formatRelativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  if (days < 30) return `${days}d ago`
  return `${Math.floor(days / 30)}mo ago`
}

export function CandidateSkillRow({ skill, onSelect, onConfirm, onDismiss }: CandidateSkillRowProps) {
  const [confirming, setConfirming] = useState(false)
  const [showDismissConfirm, setShowDismissConfirm] = useState(false)

  const handleConfirm = async (e: React.MouseEvent) => {
    e.stopPropagation()
    setConfirming(true)
    try {
      await onConfirm()
    } finally {
      setConfirming(false)
    }
  }

  const handleDismissClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    setShowDismissConfirm(true)
  }

  const handleDismissYes = async (e: React.MouseEvent) => {
    e.stopPropagation()
    await onDismiss()
  }

  const handleDismissNo = (e: React.MouseEvent) => {
    e.stopPropagation()
    setShowDismissConfirm(false)
  }

  return (
    <div
      className="flex items-center cursor-pointer"
      onClick={onSelect}
      style={{
        padding: '12px 4px',
        borderBottom: '1px solid var(--border-subtle)',
      }}
    >
      {/* Left: badge + label + sub-line */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <DomainBadge domain={skill.domain} />
          <span
            className="font-display font-semibold truncate"
            style={{ fontSize: 13, color: 'var(--color-text-primary)' }}
          >
            {skill.label}
          </span>
        </div>
        <div className="font-body" style={{ fontSize: 11, color: 'var(--color-text-secondary)', marginTop: 2 }}>
          {skill.evidence_count} source{skill.evidence_count !== 1 ? 's' : ''} · first detected {formatRelativeTime(skill.first_detected_at)}
        </div>
      </div>

      {/* Right: confidence + actions */}
      <div className="flex items-center gap-3 shrink-0 ml-3">
        <div style={{ width: 40 }}>
          <SkillConfidenceBar confidence={skill.confidence} variant="compact" />
        </div>

        {showDismissConfirm ? (
          <span className="font-body" style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>
            Dismiss?{' '}
            <button
              type="button"
              onClick={handleDismissYes}
              className="cursor-pointer font-body font-semibold border-none bg-transparent"
              style={{ fontSize: 11, color: '#ef4444', padding: 0 }}
            >
              Yes
            </button>
            {' / '}
            <button
              type="button"
              onClick={handleDismissNo}
              className="cursor-pointer font-body font-semibold border-none bg-transparent"
              style={{ fontSize: 11, color: 'var(--color-text-secondary)', padding: 0 }}
            >
              No
            </button>
          </span>
        ) : (
          <>
            <button
              type="button"
              onClick={handleConfirm}
              disabled={confirming}
              className="cursor-pointer font-body font-semibold border-none bg-transparent flex items-center gap-1"
              style={{ fontSize: 11, color: 'var(--color-accent-500)', padding: '4px 8px' }}
            >
              {confirming && <Loader2 size={10} style={{ animation: 'spin 1s linear infinite' }} />}
              Confirm
            </button>
            <button
              type="button"
              onClick={handleDismissClick}
              className="cursor-pointer border-none bg-transparent flex items-center justify-center"
              style={{ padding: 4, color: 'var(--color-text-secondary)' }}
            >
              <X size={12} />
            </button>
          </>
        )}
      </div>
    </div>
  )
}
