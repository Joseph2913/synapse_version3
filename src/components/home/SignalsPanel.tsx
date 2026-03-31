import { useNavigate } from 'react-router-dom'
import { SignalItem } from './SignalItem'
import type { KnowledgeNode, KnowledgeSkill } from '../../types/database'

interface SignalsPanelProps {
  anchors: KnowledgeNode[]
  anchorConnectionCounts: Record<string, number>
  skills: KnowledgeSkill[]
  loading: boolean
  error?: string
  onAnchorClick: (node: KnowledgeNode) => void
  onSkillClick: (skill: KnowledgeSkill) => void
}

function SectionCard({
  title,
  onViewAll,
  loading,
  emptyText,
  isEmpty,
  children,
}: {
  title: string
  onViewAll: () => void
  loading: boolean
  emptyText: string
  isEmpty: boolean
  children: React.ReactNode
}) {
  return (
    <div className="bg-bg-card border border-border-subtle overflow-hidden" style={{ borderRadius: 12 }}>
      <div
        className="flex items-center justify-between"
        style={{ padding: '16px 22px', borderBottom: '1px solid var(--border-subtle)' }}
      >
        <span
          className="font-display text-text-secondary uppercase"
          style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.08em' }}
        >
          {title}
        </span>
        <button
          type="button"
          onClick={onViewAll}
          className="font-body cursor-pointer bg-transparent border-none"
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: 'var(--color-accent-500)',
            padding: '4px 12px',
            borderRadius: 6,
            border: '1px solid rgba(214,58,0,0.15)',
            background: 'var(--color-accent-50)',
            transition: 'all 0.15s ease',
          }}
        >
          View all →
        </button>
      </div>

      {loading ? (
        <div style={{ padding: '18px 22px' }} className="flex flex-col gap-[10px]">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="bg-bg-inset animate-pulse" style={{ height: 16, borderRadius: 4, width: `${75 - i * 10}%` }} />
          ))}
        </div>
      ) : isEmpty ? (
        <div style={{ padding: '20px 22px' }}>
          <p className="font-body text-text-secondary" style={{ fontSize: 13 }}>{emptyText}</p>
        </div>
      ) : (
        <div>{children}</div>
      )}
    </div>
  )
}

export function SignalsPanel({
  anchors,
  anchorConnectionCounts,
  skills,
  loading,
  error,
  onAnchorClick,
  onSkillClick,
}: SignalsPanelProps) {
  const navigate = useNavigate()

  if (error) {
    return (
      <div className="bg-bg-card border border-border-subtle" style={{ borderRadius: 12, padding: '20px 22px' }}>
        <p className="font-body text-text-secondary" style={{ fontSize: 13, fontStyle: 'italic' }}>{error}</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col" style={{ gap: 16 }}>
      <SectionCard
        title="Anchors"
        onViewAll={() => navigate('/anchors')}
        loading={loading}
        isEmpty={anchors.length === 0}
        emptyText="No anchors yet. Anchors are promoted from your most important entities after ingestion."
      >
        {anchors.map((anchor) => (
          <SignalItem
            key={anchor.id}
            label={anchor.label}
            entityType={anchor.entity_type}
            connectionCount={anchorConnectionCounts[anchor.id] ?? 0}
            status="active"
            onClick={() => onAnchorClick(anchor)}
          />
        ))}
      </SectionCard>

      <SectionCard
        title="Skills"
        onViewAll={() => navigate('/skills')}
        loading={loading}
        isEmpty={skills.length === 0}
        emptyText="Skills emerge after multiple ingestions. Check back after processing a few more sources."
      >
        {skills.map((skill) => (
          <SignalItem
            key={skill.id}
            label={skill.title || skill.name}
            entityType="Concept"
            status={skill.status === 'active' ? 'active' : skill.status === 'draft' ? 'suggested' : 'dormant'}
            onClick={() => onSkillClick(skill)}
          />
        ))}
      </SectionCard>
    </div>
  )
}
