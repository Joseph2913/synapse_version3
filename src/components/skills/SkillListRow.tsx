import { useState } from 'react'
import type { Ref } from 'react'
import { BookOpen } from 'lucide-react'
import { DomainBadge } from './SkillCard'
import { SkillExposureBadge } from './SkillExposureBadge'
import type { Skill } from '../../hooks/useSkills'

interface SkillListRowProps {
  skill: Skill
  selected: boolean
  onClick: () => void
  rowRef?: Ref<HTMLDivElement>
  index?: number
}

function getConfidenceColor(confidence: number): string {
  if (confidence < 0.40) return '#808080'
  if (confidence < 0.60) return '#3b82f6'
  if (confidence < 0.80) return '#10b981'
  return '#d63a00'
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

export function SkillListRow({ skill, selected, onClick, rowRef, index = 0 }: SkillListRowProps) {
  const [hovered, setHovered] = useState(false)
  const pct = Math.round(skill.confidence * 100)
  const color = getConfidenceColor(skill.confidence)

  return (
    <div
      ref={rowRef}
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') onClick() }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        padding: '14px 18px',
        borderRadius: 12,
        background: selected ? 'rgba(254,242,237,0.5)' : 'var(--color-bg-card)',
        border: selected
          ? '1px solid rgba(214,58,0,0.3)'
          : hovered
            ? '1px solid var(--border-default)'
            : '1px solid var(--border-subtle)',
        cursor: 'pointer',
        transition: 'all 0.18s ease',
        transform: hovered && !selected ? 'translateY(-1px)' : undefined,
        boxShadow: hovered && !selected ? '0 2px 8px rgba(0,0,0,0.04)' : undefined,
        outline: 'none',
        animation: `fadeUp 0.3s ease ${index * 0.04}s both`,
      }}
    >
      {/* Badge row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 8 }}>
        <DomainBadge domain={skill.domain} />
        <SkillExposureBadge level={skill.exposure_level} />
      </div>

      {/* Title */}
      <div
        className="font-display font-bold"
        style={{
          fontSize: 14,
          color: 'var(--color-text-primary)',
          letterSpacing: '-0.01em',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          marginBottom: 4,
        }}
      >
        {skill.label}
      </div>

      {/* Description — 2-line clamp */}
      {skill.description && (
        <div
          className="font-body"
          style={{
            fontSize: 12,
            color: 'var(--color-text-secondary)',
            overflow: 'hidden',
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            lineHeight: 1.5,
            marginBottom: 10,
          }}
        >
          {skill.description}
        </div>
      )}

      {/* Footer stats row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: skill.description ? 0 : 6 }}>
        <BookOpen size={10} style={{ color: 'var(--color-text-secondary)', flexShrink: 0 }} />
        <span className="font-body" style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>
          <span style={{ fontWeight: 600, color: 'var(--color-text-body)' }}>{skill.evidence_count}</span> sources
        </span>
        <span style={{ color: 'var(--color-text-secondary)', fontSize: 10 }}>·</span>
        <span className="font-body font-semibold" style={{ fontSize: 11, color }}>
          {pct}%
        </span>
        <div
          style={{
            width: 32,
            height: 3,
            borderRadius: 2,
            background: 'var(--color-bg-inset)',
            flexShrink: 0,
          }}
        >
          <div style={{ width: `${pct}%`, height: '100%', borderRadius: 2, background: color }} />
        </div>
        <span style={{ color: 'var(--color-text-secondary)', fontSize: 10 }}>·</span>
        <span className="font-body" style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>
          {formatRelativeTime(skill.last_reinforced_at)}
        </span>
      </div>
    </div>
  )
}
