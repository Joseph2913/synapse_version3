import type { KnowledgeSkillListItem } from '../../types/skills'

// ─── Domain Colors ───────────────────────────────────────────────────────────

const DOMAIN_COLORS: Record<string, string> = {
  'ai-tooling':              '#3b82f6',
  'ai-prompting':            '#8b5cf6',
  'consulting-methodology':  '#d63a00',
  'change-management':       '#059669',
  'financial-analysis':      '#d97706',
  'risk-management':         '#ef4444',
  'sales-methodology':       '#ec4899',
  'project-management':      '#0891b2',
  'product-design':          '#6366f1',
  'general':                 '#6b7280',
}

function getDomainColor(domain: string | null): string {
  if (!domain) return DOMAIN_COLORS['general'] ?? '#6b7280'
  return DOMAIN_COLORS[domain] ?? '#6b7280'
}

function getConfidenceColor(confidence: number): string {
  if (confidence >= 0.8) return 'var(--color-accent-500)'
  if (confidence >= 0.6) return '#10b981'
  if (confidence >= 0.4) return '#3b82f6'
  return '#808080'
}

function relativeTime(dateStr: string): string {
  const now = Date.now()
  const then = new Date(dateStr).getTime()
  const diff = now - then
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  if (days < 30) return `${days}d ago`
  const months = Math.floor(days / 30)
  return `${months}mo ago`
}

// ─── Component ───────────────────────────────────────────────────────────────

interface SkillCardProps {
  skill: KnowledgeSkillListItem
  isSelected: boolean
  onClick: () => void
  index: number
}

export function SkillCard({ skill, isSelected, onClick, index }: SkillCardProps) {
  const domainColor = getDomainColor(skill.domain)
  const confColor = getConfidenceColor(skill.confidence)
  const isDraft = skill.status === 'draft'
  const isArchived = skill.status === 'archived'
  const domainLabel = skill.domain ?? 'general'
  const visibleTags = skill.tags.slice(0, 3)
  const extraTagCount = skill.tags.length - 3

  return (
    <div
      onClick={onClick}
      style={{
        background: isSelected ? 'var(--color-accent-50)' : 'var(--color-bg-card)',
        border: isSelected
          ? '1px solid rgba(214,58,0,0.3)'
          : isDraft
            ? '1px dashed var(--border-subtle)'
            : '1px solid var(--border-subtle)',
        borderRadius: 10,
        padding: '14px 18px',
        cursor: 'pointer',
        opacity: isArchived ? 0.5 : isDraft ? 0.85 : 1,
        transition: 'all 0.15s ease',
        animation: `fadeUp 0.4s ease ${index * 0.05}s both`,
        position: 'relative',
      }}
      onMouseEnter={e => {
        if (!isSelected) {
          e.currentTarget.style.transform = 'translateY(-1px)'
          e.currentTarget.style.boxShadow = '0 2px 8px rgba(0,0,0,0.06)'
        }
      }}
      onMouseLeave={e => {
        e.currentTarget.style.transform = 'translateY(0)'
        e.currentTarget.style.boxShadow = 'none'
      }}
    >
      {/* Status badge (top-right) */}
      {isDraft && (
        <span
          style={{
            position: 'absolute',
            top: 10,
            right: 12,
            fontSize: 9,
            fontWeight: 700,
            textTransform: 'uppercase',
            padding: '2px 6px',
            borderRadius: 4,
            background: 'rgba(245,158,11,0.1)',
            color: 'var(--semantic-amber-500, #f59e0b)',
          }}
        >
          Draft
        </span>
      )}
      {isArchived && (
        <span
          style={{
            position: 'absolute',
            top: 10,
            right: 12,
            fontSize: 9,
            fontWeight: 700,
            textTransform: 'uppercase',
            padding: '2px 6px',
            borderRadius: 4,
            background: 'rgba(128,128,128,0.1)',
            color: 'var(--color-text-secondary)',
          }}
        >
          Archived
        </span>
      )}

      {/* Row 1: Domain badge + Title + Timestamp */}
      <div className="flex items-center gap-2" style={{ minWidth: 0 }}>
        {/* Domain badge */}
        <span
          className="flex items-center gap-1 shrink-0"
          style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', color: domainColor }}
        >
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: domainColor, flexShrink: 0 }} />
          {domainLabel}
        </span>

        {/* Title */}
        <span
          className="font-body font-semibold"
          style={{
            fontSize: 14,
            color: 'var(--color-text-primary)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            flex: 1,
            minWidth: 0,
          }}
        >
          {skill.title}
        </span>

        {/* Timestamp — pushed right by the status badge when present */}
        <span
          className="shrink-0"
          style={{
            fontSize: 11,
            color: 'var(--color-text-secondary)',
            marginRight: (isDraft || isArchived) ? 60 : 0,
          }}
        >
          {relativeTime(skill.updated_at)}
        </span>
      </div>

      {/* Row 2: Description (2-line clamp) */}
      <p
        className="font-body"
        style={{
          fontSize: 12,
          color: 'var(--color-text-secondary)',
          lineHeight: 1.5,
          marginTop: 6,
          marginBottom: 0,
          overflow: 'hidden',
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
        }}
      >
        {skill.description}
      </p>

      {/* Row 3: Confidence bar + score */}
      <div className="flex items-center gap-2" style={{ marginTop: 10 }}>
        <div style={{ flex: 1, height: 4, borderRadius: 2, background: 'var(--color-bg-inset)', overflow: 'hidden' }}>
          <div
            style={{
              width: `${Math.min(skill.confidence * 100, 100)}%`,
              height: '100%',
              borderRadius: 2,
              background: confColor,
              transition: 'width 0.3s ease',
            }}
          />
        </div>
        <span style={{ fontSize: 12, fontWeight: 700, color: confColor, flexShrink: 0 }}>
          {skill.confidence.toFixed(2)}
        </span>
      </div>

      {/* Row 4: Meta line */}
      <div className="flex items-center gap-1 flex-wrap" style={{ marginTop: 8, fontSize: 11, color: 'var(--color-text-secondary)' }}>
        <span>{domainLabel}</span>
        <span style={{ opacity: 0.5 }}>·</span>
        <span>{skill.source_count} source{skill.source_count !== 1 ? 's' : ''}</span>
        {skill.usage_count > 0 && (
          <>
            <span style={{ opacity: 0.5 }}>·</span>
            <span style={{ color: 'var(--color-accent-500)', fontWeight: 600 }}>
              {skill.usage_count} use{skill.usage_count !== 1 ? 's' : ''}
            </span>
          </>
        )}
        {visibleTags.length > 0 && <span style={{ opacity: 0.5 }}>·</span>}
        {visibleTags.map(tag => (
          <span key={tag} style={{ color: 'var(--color-text-secondary)' }}>#{tag}</span>
        ))}
        {extraTagCount > 0 && <span style={{ opacity: 0.6 }}>+{extraTagCount}</span>}
      </div>
    </div>
  )
}
