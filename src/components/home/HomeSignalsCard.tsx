import { useNavigate } from 'react-router-dom'
import { Radio, Anchor as AnchorIcon, Zap, ArrowRight, GitBranch } from 'lucide-react'
import { useHomeDashboard } from '../../hooks/useHomeDashboard'
import type { KnowledgeNode, KnowledgeSkill } from '../../types/database'

const WINDOW_DAYS = 7

// ── Helpers ─────────────────────────────────────────────────────────────────

function formatRelative(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime()
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 3_600_000 * 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  return `${Math.floor(days / 30)}mo ago`
}

function isWithinWindow(dateStr: string | null | undefined): boolean {
  if (!dateStr) return false
  const diffMs = Date.now() - new Date(dateStr).getTime()
  return diffMs <= WINDOW_DAYS * 24 * 60 * 60 * 1000
}

type SkillKind = 'new' | 'updated'

interface SkillWithKind {
  skill: KnowledgeSkill
  kind: SkillKind
  timestamp: string
}

function classifySkills(skills: KnowledgeSkill[]): SkillWithKind[] {
  const entries: SkillWithKind[] = []
  for (const s of skills) {
    if (isWithinWindow(s.created_at)) {
      entries.push({ skill: s, kind: 'new', timestamp: s.created_at })
    } else if (s.updated_at && s.updated_at !== s.created_at) {
      entries.push({ skill: s, kind: 'updated', timestamp: s.updated_at })
    }
  }
  entries.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
  return entries
}

const KIND_PILL: Record<SkillKind, { bg: string; text: string; label: string }> = {
  new:     { bg: '#d1fae5', text: '#047857', label: 'New' },
  updated: { bg: '#e0e7ff', text: '#4338ca', label: 'Updated' },
}

// ── Shared row primitives ───────────────────────────────────────────────────

function MetaItem({ icon, value, label }: { icon?: React.ReactNode; value: string | number; label: string }) {
  return (
    <span
      className="flex items-center font-body text-text-secondary"
      style={{ gap: 4, fontSize: 11, fontVariantNumeric: 'tabular-nums' }}
    >
      {icon && <span style={{ color: 'var(--color-text-placeholder)', display: 'flex' }}>{icon}</span>}
      <span style={{ fontWeight: 600, color: 'var(--color-text-body)' }}>{value}</span>
      <span style={{ color: 'var(--color-text-placeholder)' }}>{label}</span>
    </span>
  )
}

// ── Anchor row ──────────────────────────────────────────────────────────────

function AnchorRow({
  anchor,
  connectionCount,
  isLast,
  onClick,
}: {
  anchor: KnowledgeNode
  connectionCount: number
  isLast: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full text-left bg-transparent border-none cursor-pointer hover:bg-bg-hover items-start"
      style={{
        gap: 10,
        padding: '12px 16px',
        transition: 'background 0.15s ease',
        borderBottom: isLast ? 'none' : '1px solid var(--border-subtle)',
        flex: '1 1 0',
        minHeight: 0,
      }}
    >
      <div
        className="shrink-0 flex items-center justify-center"
        style={{ width: 28, height: 28, borderRadius: 8, background: 'rgba(16,185,129,0.08)' }}
      >
        <AnchorIcon size={13} style={{ color: '#047857' }} />
      </div>

      <div className="flex-1 min-w-0">
        <div className="font-display text-text-primary truncate" style={{ fontSize: 12, fontWeight: 700, letterSpacing: '-0.01em', marginBottom: 4 }}>
          {anchor.label}
        </div>
        <div className="flex items-center" style={{ gap: 12 }}>
          <span className="font-body text-text-placeholder" style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.04em', fontWeight: 600 }}>
            {anchor.entity_type}
          </span>
          <MetaItem icon={<GitBranch size={11} />} value={connectionCount} label="edges" />
          <span className="font-body text-text-placeholder" style={{ fontSize: 11, marginLeft: 'auto' }}>
            {formatRelative(anchor.created_at)}
          </span>
        </div>
      </div>
    </button>
  )
}

// ── Skill row ───────────────────────────────────────────────────────────────

function SkillRow({ entry, isLast, onClick }: { entry: SkillWithKind; isLast: boolean; onClick: () => void }) {
  const pill = KIND_PILL[entry.kind]
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full text-left bg-transparent border-none cursor-pointer hover:bg-bg-hover items-start"
      style={{
        gap: 10,
        padding: '12px 16px',
        transition: 'background 0.15s ease',
        borderBottom: isLast ? 'none' : '1px solid var(--border-subtle)',
        flex: '1 1 0',
        minHeight: 0,
      }}
    >
      <div
        className="shrink-0 flex items-center justify-center"
        style={{ width: 28, height: 28, borderRadius: 8, background: 'var(--color-accent-50)' }}
      >
        <Zap size={13} style={{ color: 'var(--color-accent-500)' }} />
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center" style={{ gap: 6, marginBottom: 4 }}>
          <span className="font-display text-text-primary truncate" style={{ fontSize: 12, fontWeight: 700, letterSpacing: '-0.01em', flex: 1, minWidth: 0 }}>
            {entry.skill.title || entry.skill.name}
          </span>
          <span
            className="font-body shrink-0"
            style={{
              fontSize: 9,
              fontWeight: 700,
              padding: '2px 6px',
              borderRadius: 4,
              background: pill.bg,
              color: pill.text,
              letterSpacing: '0.04em',
              textTransform: 'uppercase',
            }}
          >
            {pill.label}
          </span>
        </div>
        <div className="flex items-center" style={{ gap: 12 }}>
          <MetaItem value={entry.skill.source_count} label="sources" />
          <MetaItem value={entry.skill.usage_count ?? 0} label="uses" />
          <span className="font-body text-text-placeholder" style={{ fontSize: 11, marginLeft: 'auto' }}>
            {formatRelative(entry.timestamp)}
          </span>
        </div>
      </div>
    </button>
  )
}

// ── Sub-header ──────────────────────────────────────────────────────────────

function PaneHeader({
  icon,
  label,
  onViewAll,
}: {
  icon: React.ReactNode
  label: string
  onViewAll: () => void
}) {
  return (
    <div
      className="flex items-center justify-between shrink-0"
      style={{ padding: '10px 16px', borderBottom: '1px solid var(--border-subtle)' }}
    >
      <div className="flex items-center" style={{ gap: 8 }}>
        <span style={{ display: 'flex', color: 'var(--color-accent-500)' }}>{icon}</span>
        <span
          className="font-display text-text-primary"
          style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.02em', textTransform: 'uppercase' }}
        >
          {label}
        </span>
      </div>
      <button
        type="button"
        onClick={onViewAll}
        className="font-body cursor-pointer bg-transparent border-none flex items-center"
        style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-accent-500)', gap: 3 }}
      >
        View all <ArrowRight size={11} />
      </button>
    </div>
  )
}

// ── Main component ──────────────────────────────────────────────────────────

const TARGET_ROWS = 5

export function HomeSignalsCard() {
  const navigate = useNavigate()
  const { recentAnchors, anchorConnectionCounts, recentSkills, loading } = useHomeDashboard()

  const anchors = recentAnchors.slice(0, TARGET_ROWS)
  const skillEntries = classifySkills(recentSkills).slice(0, TARGET_ROWS)
  const isLoadingAnchors = loading.snapshot && anchors.length === 0
  const isLoadingSkills = loading.snapshot && skillEntries.length === 0

  return (
    <div
      className="bg-bg-card border border-border-subtle overflow-hidden flex flex-col flex-1"
      style={{ borderRadius: 12, minHeight: 0 }}
    >
      {/* Top header */}
      <div
        className="flex items-center shrink-0"
        style={{ padding: '12px 20px', borderBottom: '1px solid var(--border-subtle)', gap: 10 }}
      >
        <div
          className="shrink-0 flex items-center justify-center"
          style={{ width: 28, height: 28, borderRadius: 8, background: 'var(--color-accent-50)' }}
        >
          <Radio size={14} style={{ color: 'var(--color-accent-500)' }} />
        </div>
        <span className="font-display text-text-primary" style={{ fontSize: 13, fontWeight: 700, letterSpacing: '-0.01em' }}>
          Signals
        </span>
      </div>

      {/* Two panes */}
      <div className="flex-1 flex overflow-hidden" style={{ minHeight: 0 }}>
        {/* Left: Anchors */}
        <div className="flex flex-col min-w-0" style={{ flex: '1 1 0' }}>
          <PaneHeader icon={<AnchorIcon size={12} />} label="Anchors" onViewAll={() => navigate('/anchors')} />
          <div className="flex-1 flex flex-col overflow-hidden" style={{ minHeight: 0 }}>
            {isLoadingAnchors ? (
              Array.from({ length: TARGET_ROWS }).map((_, i) => (
                <div key={i} className="flex items-start" style={{ flex: '1 1 0', gap: 10, padding: '12px 16px', borderBottom: i < TARGET_ROWS - 1 ? '1px solid var(--border-subtle)' : 'none' }}>
                  <div className="bg-bg-inset animate-pulse" style={{ width: 28, height: 28, borderRadius: 8 }} />
                  <div className="flex-1">
                    <div className="bg-bg-inset animate-pulse" style={{ height: 11, borderRadius: 4, width: '80%', marginBottom: 6 }} />
                    <div className="bg-bg-inset animate-pulse" style={{ height: 10, borderRadius: 4, width: '60%' }} />
                  </div>
                </div>
              ))
            ) : anchors.length === 0 ? (
              <div className="flex-1 flex items-center justify-center" style={{ padding: '24px 16px', textAlign: 'center' }}>
                <p className="font-body text-text-secondary" style={{ fontSize: 12 }}>No anchors yet.</p>
              </div>
            ) : (
              anchors.map((a, i) => (
                <AnchorRow
                  key={a.id}
                  anchor={a}
                  connectionCount={anchorConnectionCounts[a.id] ?? 0}
                  isLast={i === anchors.length - 1}
                  onClick={() => navigate(`/anchors?id=${a.id}`)}
                />
              ))
            )}
          </div>
        </div>

        {/* Divider */}
        <div style={{ width: 1, background: 'var(--border-subtle)' }} />

        {/* Right: Skills */}
        <div className="flex flex-col min-w-0" style={{ flex: '1 1 0' }}>
          <PaneHeader icon={<Zap size={12} />} label="Skills" onViewAll={() => navigate('/explore?viewMode=skills')} />
          <div className="flex-1 flex flex-col overflow-hidden" style={{ minHeight: 0 }}>
            {isLoadingSkills ? (
              Array.from({ length: TARGET_ROWS }).map((_, i) => (
                <div key={i} className="flex items-start" style={{ flex: '1 1 0', gap: 10, padding: '12px 16px', borderBottom: i < TARGET_ROWS - 1 ? '1px solid var(--border-subtle)' : 'none' }}>
                  <div className="bg-bg-inset animate-pulse" style={{ width: 28, height: 28, borderRadius: 8 }} />
                  <div className="flex-1">
                    <div className="bg-bg-inset animate-pulse" style={{ height: 11, borderRadius: 4, width: '80%', marginBottom: 6 }} />
                    <div className="bg-bg-inset animate-pulse" style={{ height: 10, borderRadius: 4, width: '60%' }} />
                  </div>
                </div>
              ))
            ) : skillEntries.length === 0 ? (
              <div className="flex-1 flex items-center justify-center" style={{ padding: '24px 16px', textAlign: 'center' }}>
                <p className="font-body text-text-secondary" style={{ fontSize: 12 }}>No recent skill activity.</p>
              </div>
            ) : (
              skillEntries.map((e, i) => (
                <SkillRow
                  key={e.skill.id}
                  entry={e}
                  isLast={i === skillEntries.length - 1}
                  onClick={() => navigate(`/explore?viewMode=skills&skillId=${e.skill.id}`)}
                />
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
