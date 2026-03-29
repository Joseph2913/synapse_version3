import { Sparkles, Clock, Target, BarChart3, MousePointerClick, Zap } from 'lucide-react'
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

function getDomainColor(domain: string): string {
  return DOMAIN_COLORS[domain] ?? '#6b7280'
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

interface SkillOverviewPanelProps {
  skills: KnowledgeSkillListItem[]
  counts: {
    total: number
    draft: number
    active: number
    archived: number
    byDomain: Record<string, number>
  }
  onSelectSkill: (id: string) => void
}

export function SkillOverviewPanel({ skills, counts, onSelectSkill }: SkillOverviewPanelProps) {
  const totalSources = skills.reduce((acc, s) => acc + s.source_count, 0)

  // Fix: compute avg confidence across ALL non-archived skills (draft + active)
  const nonArchivedSkills = skills.filter(s => s.status !== 'archived')
  const avgConfidence = nonArchivedSkills.length > 0
    ? nonArchivedSkills.reduce((acc, s) => acc + s.confidence, 0) / nonArchivedSkills.length
    : 0
  const nonArchived = counts.total - counts.archived
  const lastUpdated = skills.length > 0
    ? relativeTime(skills.reduce((a, b) => a.updated_at > b.updated_at ? a : b).updated_at ?? '')
    : 'never'

  // Recently generated (top 5 by updated_at)
  const recent = [...skills]
    .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())
    .slice(0, 5)

  // Domain distribution sorted by count desc
  const domainEntries = Object.entries(counts.byDomain)
    .sort(([, a], [, b]) => b - a)
  const totalDomainCount = domainEntries.reduce((acc, [, c]) => acc + c, 0)

  return (
    <div style={{ padding: '24px 20px', overflowY: 'auto', height: '100%' }}>
      {/* Section 1: Header */}
      <h2
        className="font-display"
        style={{ fontSize: 22, fontWeight: 800, color: 'var(--color-text-primary)', margin: 0 }}
      >
        Your Skill Library
      </h2>
      <p
        className="font-body"
        style={{ fontSize: 13, color: 'var(--color-text-secondary)', margin: '4px 0 0' }}
      >
        Built from {totalSources} ingested source{totalSources !== 1 ? 's' : ''} · Last updated {lastUpdated}
      </p>

      {/* Section 2: Stat Cards */}
      {(() => {
        const totalUsage = skills.reduce((acc, s) => acc + (s.usage_count ?? 0), 0)
        return (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginTop: 20 }}>
            <StatCard icon={Sparkles} label="Total Skills" value={nonArchived} />
            <StatCard icon={Clock} label="Pending Review" value={counts.draft} />
            <StatCard icon={Target} label="Avg Confidence" value={`${Math.round(avgConfidence * 100)}%`} />
            <StatCard icon={BarChart3} label="Total Sources" value={totalSources} />
            {totalUsage > 0 && <StatCard icon={Zap} label="Total Uses" value={totalUsage} />}
          </div>
        )
      })()}

      {/* Section 3: Domain Distribution — Pie Chart + Bar List */}
      {domainEntries.length > 0 && (
        <div style={{ marginTop: 24 }}>
          <h3
            className="font-display"
            style={{ fontSize: 12, fontWeight: 700, color: 'var(--color-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.04em', margin: '0 0 14px' }}
          >
            Domain Distribution
          </h3>

          {/* Pie chart */}
          <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 16 }}>
            <PieChart entries={domainEntries} total={totalDomainCount} />
          </div>

          {/* Bar list: label | bar | count */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {domainEntries.map(([domain, count]) => {
              const color = getDomainColor(domain)
              const pct = totalDomainCount > 0 ? (count / totalDomainCount) * 100 : 0
              return (
                <div key={domain} className="flex items-center gap-2" style={{ fontSize: 12 }}>
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: color, flexShrink: 0 }} />
                  <span
                    className="font-body"
                    style={{
                      color: 'var(--color-text-secondary)',
                      width: 130,
                      flexShrink: 0,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {domain}
                  </span>
                  <div style={{ flex: 1, height: 6, borderRadius: 3, background: 'var(--color-bg-inset)', overflow: 'hidden' }}>
                    <div style={{ width: `${pct}%`, height: '100%', borderRadius: 3, background: color, opacity: 0.75, transition: 'width 0.3s ease' }} />
                  </div>
                  <span
                    className="font-body font-semibold"
                    style={{ color: 'var(--color-text-primary)', minWidth: 24, textAlign: 'right', flexShrink: 0 }}
                  >
                    {count}
                  </span>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Section 4: Recently Generated */}
      {recent.length > 0 && (
        <div style={{ marginTop: 24 }}>
          <h3
            className="font-display"
            style={{ fontSize: 12, fontWeight: 700, color: 'var(--color-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.04em', margin: '0 0 10px' }}
          >
            Recently Generated
          </h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {recent.map(s => {
              const domainColor = getDomainColor(s.domain ?? 'general')
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => onSelectSkill(s.id)}
                  className="flex items-center gap-2 font-body"
                  style={{
                    padding: '6px 8px',
                    borderRadius: 6,
                    border: 'none',
                    background: 'transparent',
                    cursor: 'pointer',
                    textAlign: 'left',
                    width: '100%',
                    transition: 'background 0.1s ease',
                  }}
                  onMouseEnter={e => { e.currentTarget.style.background = 'var(--color-bg-hover, var(--color-bg-inset))' }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
                >
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: domainColor, flexShrink: 0 }} />
                  <span
                    style={{
                      fontSize: 12,
                      color: 'var(--color-text-primary)',
                      flex: 1,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {s.title}
                  </span>
                  <span style={{ fontSize: 11, color: 'var(--color-text-secondary)', flexShrink: 0 }}>
                    {relativeTime(s.updated_at)}
                  </span>
                </button>
              )
            })}
          </div>
        </div>
      )}

      {/* Section 5: CTA */}
      <div style={{ marginTop: 32, textAlign: 'center' }}>
        <MousePointerClick size={20} style={{ color: 'var(--color-text-placeholder)', margin: '0 auto 8px', display: 'block' }} />
        <p className="font-body" style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
          Select a skill from the list to explore its full detail
        </p>
      </div>
    </div>
  )
}

// ─── Pie Chart ───────────────────────────────────────────────────────────────

function PieChart({ entries, total }: { entries: Array<[string, number]>; total: number }) {
  const size = 140
  const cx = size / 2
  const cy = size / 2
  const r = 54
  const innerR = 34

  if (total === 0) return null

  let cumAngle = -Math.PI / 2 // start at top
  const slices = entries.map(([domain, count]) => {
    const angle = (count / total) * 2 * Math.PI
    const startAngle = cumAngle
    const endAngle = cumAngle + angle
    cumAngle = endAngle

    const x1 = cx + r * Math.cos(startAngle)
    const y1 = cy + r * Math.sin(startAngle)
    const x2 = cx + r * Math.cos(endAngle)
    const y2 = cy + r * Math.sin(endAngle)
    const ix1 = cx + innerR * Math.cos(endAngle)
    const iy1 = cy + innerR * Math.sin(endAngle)
    const ix2 = cx + innerR * Math.cos(startAngle)
    const iy2 = cy + innerR * Math.sin(startAngle)

    const largeArc = angle > Math.PI ? 1 : 0
    const color = getDomainColor(domain)

    const d = [
      `M ${x1} ${y1}`,
      `A ${r} ${r} 0 ${largeArc} 1 ${x2} ${y2}`,
      `L ${ix1} ${iy1}`,
      `A ${innerR} ${innerR} 0 ${largeArc} 0 ${ix2} ${iy2}`,
      'Z',
    ].join(' ')

    return { domain, d, color }
  })

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      {slices.map(s => (
        <path
          key={s.domain}
          d={s.d}
          fill={s.color}
          opacity={0.8}
          stroke="var(--color-bg-card)"
          strokeWidth={1.5}
        />
      ))}
      {/* Center label */}
      <text
        x={cx}
        y={cy - 6}
        textAnchor="middle"
        style={{ fontSize: 18, fontWeight: 800, fill: 'var(--color-text-primary)', fontFamily: 'var(--font-display)' }}
      >
        {total}
      </text>
      <text
        x={cx}
        y={cy + 10}
        textAnchor="middle"
        style={{ fontSize: 10, fill: 'var(--color-text-secondary)', fontFamily: 'var(--font-body)' }}
      >
        skills
      </text>
    </svg>
  )
}

// ─── StatCard ────────────────────────────────────────────────────────────────

function StatCard({ icon: Icon, label, value }: { icon: typeof Sparkles; label: string; value: number | string }) {
  return (
    <div style={{ background: 'var(--color-bg-inset)', borderRadius: 8, padding: '10px 12px' }}>
      <div className="flex items-center gap-2" style={{ marginBottom: 4 }}>
        <Icon size={14} style={{ color: 'var(--color-text-secondary)' }} />
        <span className="font-body" style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>{label}</span>
      </div>
      <span className="font-display" style={{ fontSize: 20, fontWeight: 800, color: 'var(--color-text-primary)' }}>
        {value}
      </span>
    </div>
  )
}
