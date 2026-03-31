import { BarChart3, FileText, Sparkles } from 'lucide-react'
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

function hexToRgba(hex: string, alpha: number): string {
  const value = hex.replace('#', '')
  const normalized = value.length === 3
    ? value.split('').map(char => char + char).join('')
    : value
  const int = Number.parseInt(normalized, 16)
  const r = (int >> 16) & 255
  const g = (int >> 8) & 255
  const b = int & 255
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

function formatDomainLabel(domain: string | null): string {
  const raw = domain ?? 'general'
  return raw
    .split('-')
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
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

// ─── Domain Badge ────────────────────────────────────────────────────────────

interface DomainBadgeProps {
  domain: string | null
}

export function DomainBadge({ domain }: DomainBadgeProps) {
  const color = getDomainColor(domain)
  const label = formatDomainLabel(domain)
  return (
    <span
      className="inline-flex items-center gap-1 font-body font-semibold"
      style={{
        background: hexToRgba(color, 0.06),
        border: `1px solid ${hexToRgba(color, 0.16)}`,
        color,
        padding: '3px 9px',
        borderRadius: 5,
        fontSize: 11,
        fontWeight: 600,
        lineHeight: 1,
      }}
    >
      <span style={{ width: 5, height: 5, borderRadius: '50%', background: color, flexShrink: 0 }} />
      {label}
    </span>
  )
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
  const isDraft = skill.status === 'draft'
  const isArchived = skill.status === 'archived'
  const domainLabel = formatDomainLabel(skill.domain)

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
        borderRadius: 12,
        padding: '16px 18px',
        cursor: 'pointer',
        opacity: isArchived ? 0.72 : isDraft ? 0.92 : 1,
        transition: 'all 0.15s ease',
        animation: `fadeUp 0.4s ease ${index * 0.05}s both`,
        position: 'relative',
        overflow: 'hidden',
        borderLeft: isDraft ? `3px dashed ${domainColor}` : undefined,
      }}
      onMouseEnter={e => {
        if (!isSelected) {
          e.currentTarget.style.transform = 'translateY(-1px)'
          e.currentTarget.style.boxShadow = '0 2px 8px rgba(0,0,0,0.04)'
        }
      }}
      onMouseLeave={e => {
        e.currentTarget.style.transform = 'translateY(0)'
        e.currentTarget.style.boxShadow = 'none'
      }}
    >
      {!isDraft && (
        <div style={{
          position: 'absolute', left: 0, top: 0, bottom: 0, width: 3,
          background: domainColor, borderRadius: '12px 0 0 12px',
        }} />
      )}

      <div className="flex items-start justify-between gap-3" style={{ minWidth: 0, marginBottom: 8 }}>
        <div className="flex items-center gap-2 min-w-0">
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: domainColor, flexShrink: 0 }} />
          <span
            className="font-display"
            style={{
              fontSize: 14,
              fontWeight: 700,
              color: 'var(--color-text-primary)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              minWidth: 0,
            }}
          >
            {skill.title}
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
          Updated {relativeTime(skill.updated_at)}
        </span>
      </div>

      <div className="flex items-center gap-1 flex-wrap" style={{ marginBottom: 10 }}>
        <span
          className="flex items-center gap-1"
          style={{
            background: hexToRgba(domainColor, 0.06),
            border: `1px solid ${hexToRgba(domainColor, 0.16)}`,
            color: domainColor,
            padding: '3px 9px',
            borderRadius: 5,
            fontSize: 11,
            fontWeight: 600,
          }}
        >
          <span style={{ width: 5, height: 5, borderRadius: '50%', background: domainColor, flexShrink: 0 }} />
          {domainLabel}
        </span>
        {isDraft && (
          <span
            style={{
              fontSize: 10,
              fontWeight: 700,
              padding: '2px 7px',
              borderRadius: 4,
              background: 'rgba(245,158,11,0.08)',
              border: '1px solid rgba(245,158,11,0.2)',
              color: 'var(--color-semantic-amber-700, #b45309)',
            }}
          >
            Draft
          </span>
        )}
        {isArchived && (
          <span
            style={{
              fontSize: 10,
              fontWeight: 700,
              padding: '2px 7px',
              borderRadius: 4,
              background: 'rgba(0,0,0,0.04)',
              border: '1px solid var(--border-subtle)',
              color: 'var(--color-text-secondary)',
            }}
          >
            Archived
          </span>
        )}
      </div>

      <div className="flex items-center gap-4 flex-wrap" style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>
        <span className="flex items-center gap-1 font-body">
          <FileText size={10} /> <span style={{ fontWeight: 600, color: 'var(--color-text-body)' }}>{skill.source_count}</span> source{skill.source_count !== 1 ? 's' : ''}
        </span>
        <span className="flex items-center gap-1 font-body">
          <Sparkles size={10} /> <span style={{ fontWeight: 600, color: 'var(--color-text-body)' }}>{skill.usage_count}</span> use{skill.usage_count !== 1 ? 's' : ''}
        </span>
        <span className="flex items-center gap-1 font-body">
          <BarChart3 size={10} /> <span style={{ fontWeight: 600, color: 'var(--color-text-body)' }}>{Math.round(skill.confidence * 100)}%</span> confidence
        </span>
      </div>
    </div>
  )
}
