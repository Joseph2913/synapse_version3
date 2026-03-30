import { useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, Layers3, Plus, Radio, Sparkles } from 'lucide-react'
import { SectionLabel } from '../ui/SectionLabel'
import type { AnchorCandidateWithNode } from '../../types/anchors'
import type { KnowledgeSkillListItem } from '../../types/skills'

interface CombinedOverviewPanelProps {
  onCreateAnchor: () => void
  onCreateSkill: () => void
  skillCounts: {
    total: number
    draft: number
    active: number
    archived: number
    byDomain: Record<string, number>
  }
  recentSkills: KnowledgeSkillListItem[]
  avgActiveSkillConfidence: number
  onSelectSkill: (id: string) => void
  anchorCounts: {
    total: number
    confirmed: number
    suggested: number
    dormant: number
  }
  avgAnchorConnections: number
  dormantAnchors: AnchorCandidateWithNode[]
  lowScoreAnchors: AnchorCandidateWithNode[]
  recentAnchors: AnchorCandidateWithNode[]
  onSelectAnchor: (id: string) => void
  totalSourcesIngested: number
  totalSignalUses: number
}

function StatCard({ value, label, amber }: { value: string | number; label: string; amber?: boolean }) {
  return (
    <div
      style={{
        background: 'var(--color-bg-inset)',
        borderRadius: 8,
        padding: '12px 14px',
      }}
    >
      <div
        className="font-display"
        style={{
          fontSize: 22,
          fontWeight: 700,
          color: amber ? '#d97706' : 'var(--color-text-primary)',
        }}
      >
        {value}
      </div>
      <div className="font-body" style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>
        {label}
      </div>
    </div>
  )
}

function ExpandableSection({
  label,
  expanded,
  onToggle,
  children,
}: {
  label: string
  expanded: boolean
  onToggle: () => void
  children: React.ReactNode
}) {
  return (
    <div style={{ marginTop: 16 }}>
      <button
        type="button"
        onClick={onToggle}
        className="flex items-center gap-2 font-body"
        style={{
          width: '100%',
          border: 'none',
          background: 'transparent',
          cursor: 'pointer',
          padding: 0,
          textAlign: 'left',
          fontSize: 12,
          fontWeight: 600,
          color: 'var(--color-text-body)',
        }}
      >
        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        {label}
      </button>

      <div
        style={{
          overflow: 'hidden',
          maxHeight: expanded ? 320 : 0,
          opacity: expanded ? 1 : 0,
          transition: 'max-height 0.15s ease, opacity 0.15s ease',
        }}
      >
        <div style={{ paddingTop: 10 }}>{children}</div>
      </div>
    </div>
  )
}

function EmptySectionMessage({ children }: { children: React.ReactNode }) {
  return (
    <p className="font-body" style={{ fontSize: 12, color: 'var(--color-text-secondary)', lineHeight: 1.55 }}>
      {children}
    </p>
  )
}

export function CombinedOverviewPanel({
  onCreateAnchor,
  onCreateSkill,
  skillCounts,
  recentSkills,
  avgActiveSkillConfidence,
  onSelectSkill,
  anchorCounts,
  avgAnchorConnections,
  dormantAnchors,
  lowScoreAnchors,
  recentAnchors,
  onSelectAnchor,
  totalSourcesIngested,
  totalSignalUses,
}: CombinedOverviewPanelProps) {
  const [showSkillMore, setShowSkillMore] = useState(false)
  const [showAnchorAttention, setShowAnchorAttention] = useState(false)
  const [showRecentAnchors, setShowRecentAnchors] = useState(false)

  const domainEntries = useMemo(() => (
    Object.entries(skillCounts.byDomain).sort(([, a], [, b]) => b - a)
  ), [skillCounts.byDomain])

  return (
    <div style={{ padding: '24px 20px', height: '100%', overflowY: 'auto' }}>
      <div className="flex items-center gap-2" style={{ marginBottom: 12 }}>
        <Sparkles size={16} style={{ color: 'var(--color-accent-500)' }} />
        <h2 className="font-display" style={{ fontSize: 18, fontWeight: 700, color: 'var(--color-text-primary)', margin: 0 }}>
          Signals Overview
        </h2>
      </div>

      <div
        style={{
          background: 'var(--color-bg-card)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 12,
          padding: '16px 18px',
          marginBottom: 18,
        }}
      >
        <div style={{ marginBottom: 12 }}>
          <SectionLabel>Manual Add</SectionLabel>
        </div>

        <div
          className="font-body"
          style={{ fontSize: 12, color: 'var(--color-text-secondary)', lineHeight: 1.55, marginBottom: 14 }}
        >
          Add important anchors yourself or turn fresh source material into a reusable skill without leaving Signals.
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <button
            type="button"
            onClick={onCreateAnchor}
            className="font-body"
            style={{
              borderRadius: 10,
              border: '1px solid var(--border-subtle)',
              background: 'var(--color-bg-inset)',
              padding: '12px 14px',
              cursor: 'pointer',
              textAlign: 'left',
            }}
          >
            <div className="flex items-center gap-2" style={{ marginBottom: 6 }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--color-accent-500)', flexShrink: 0 }} />
              <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text-primary)' }}>
                New Anchor
              </span>
            </div>
            <div style={{ fontSize: 11, color: 'var(--color-text-secondary)', lineHeight: 1.5 }}>
              Add a manual anchor with its description and operating notes.
            </div>
          </button>

          <button
            type="button"
            onClick={onCreateSkill}
            className="font-body"
            style={{
              borderRadius: 10,
              border: '1px solid var(--border-subtle)',
              background: 'var(--color-bg-inset)',
              padding: '12px 14px',
              cursor: 'pointer',
              textAlign: 'left',
            }}
          >
            <div className="flex items-center gap-2" style={{ marginBottom: 6 }}>
              <Plus size={13} style={{ color: 'var(--color-accent-500)', flexShrink: 0 }} />
              <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text-primary)' }}>
                New Skill
              </span>
            </div>
            <div style={{ fontSize: 11, color: 'var(--color-text-secondary)', lineHeight: 1.5 }}>
              Submit text, URLs, documents, transcripts, or YouTube videos for skill extraction.
            </div>
          </button>
        </div>
      </div>

      <div>
        <div className="flex items-center gap-2" style={{ marginBottom: 12 }}>
          <SectionLabel>Skills</SectionLabel>
        </div>

        <div
          className="font-body"
          style={{ fontSize: 12, color: 'var(--color-text-secondary)', lineHeight: 1.5, marginBottom: 14 }}
        >
          {skillCounts.active} active, {skillCounts.draft} suggested, {skillCounts.archived} archived
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <StatCard value={skillCounts.total} label="Total Skills" />
          <StatCard value={skillCounts.draft} label="Pending Review" amber={skillCounts.draft > 0} />
        </div>

        <div className="font-body" style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 14 }}>
          Avg confidence across active skills:{' '}
          <span style={{ color: 'var(--color-text-primary)', fontWeight: 600 }}>
            {skillCounts.active > 0 ? `${Math.round(avgActiveSkillConfidence * 100)}%` : '—'}
          </span>
        </div>

        <ExpandableSection
          label="View More"
          expanded={showSkillMore}
          onToggle={() => setShowSkillMore(prev => !prev)}
        >
          {domainEntries.length > 0 ? (
            <div style={{ marginBottom: 12 }}>
              <div style={{ marginBottom: 8 }}>
                <SectionLabel>Domains</SectionLabel>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {domainEntries.map(([domain, count]) => (
                  <div key={domain} className="flex items-center justify-between gap-3">
                    <span className="font-body" style={{ fontSize: 12, color: 'var(--color-text-body)' }}>
                      {domain}
                    </span>
                    <span className="font-body" style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
                      {count}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <EmptySectionMessage>No skill domains yet.</EmptySectionMessage>
          )}

          {recentSkills.length > 0 ? (
            <div>
              <div style={{ marginBottom: 8 }}>
                <SectionLabel>Recently Generated</SectionLabel>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {recentSkills.map(skill => (
                  <button
                    key={skill.id}
                    type="button"
                    onClick={() => onSelectSkill(skill.id)}
                    className="flex items-center gap-2 font-body"
                    style={{
                      width: '100%',
                      border: 'none',
                      background: 'transparent',
                      cursor: 'pointer',
                      padding: '6px 8px',
                      borderRadius: 6,
                      textAlign: 'left',
                      color: 'var(--color-text-body)',
                    }}
                    onMouseEnter={e => { e.currentTarget.style.background = 'var(--color-bg-hover)' }}
                    onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
                  >
                    <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--color-accent-500)', flexShrink: 0 }} />
                    <span className="truncate" style={{ flex: 1, minWidth: 0, fontSize: 12 }}>
                      {skill.title}
                    </span>
                    <span style={{ fontSize: 11, color: 'var(--color-text-secondary)', flexShrink: 0 }}>
                      {Math.round(skill.confidence * 100)}%
                    </span>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <EmptySectionMessage>No recent skills yet.</EmptySectionMessage>
          )}
        </ExpandableSection>
      </div>

      <div style={{ borderTop: '1px solid var(--border-subtle)', margin: '20px 0' }} />

      <div>
        <div className="flex items-center gap-2" style={{ marginBottom: 12 }}>
          <SectionLabel>Anchors</SectionLabel>
        </div>

        <div
          className="font-body"
          style={{ fontSize: 12, color: 'var(--color-text-secondary)', lineHeight: 1.5, marginBottom: 14 }}
        >
          {anchorCounts.confirmed} confirmed, {anchorCounts.suggested} suggested, {anchorCounts.dormant} dormant
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <StatCard value={anchorCounts.total} label="Total Anchors" />
          <StatCard value={anchorCounts.suggested} label="Pending Review" amber={anchorCounts.suggested > 0} />
        </div>

        <div className="font-body" style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 14 }}>
          Avg node connection count:{' '}
          <span style={{ color: 'var(--color-text-primary)', fontWeight: 600 }}>
            {anchorCounts.confirmed + anchorCounts.dormant > 0 ? avgAnchorConnections.toFixed(1) : '—'}
          </span>
        </div>

        <ExpandableSection
          label="Needs Attention"
          expanded={showAnchorAttention}
          onToggle={() => setShowAnchorAttention(prev => !prev)}
        >
          {dormantAnchors.length === 0 && lowScoreAnchors.length === 0 ? (
            <EmptySectionMessage>No anchors need attention right now.</EmptySectionMessage>
          ) : (
            <>
              {dormantAnchors.length > 0 && (
                <div style={{ marginBottom: lowScoreAnchors.length > 0 ? 12 : 0 }}>
                  <div style={{ marginBottom: 8 }}>
                    <SectionLabel>Dormant</SectionLabel>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {dormantAnchors.map(anchor => (
                      <button
                        key={anchor.id}
                        type="button"
                        onClick={() => onSelectAnchor(anchor.id)}
                        className="flex items-center justify-between gap-3 font-body"
                        style={{
                          width: '100%',
                          border: 'none',
                          background: 'transparent',
                          cursor: 'pointer',
                          padding: '6px 8px',
                          borderRadius: 6,
                          textAlign: 'left',
                        }}
                        onMouseEnter={e => { e.currentTarget.style.background = 'var(--color-bg-hover)' }}
                        onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
                      >
                        <span className="truncate" style={{ flex: 1, minWidth: 0, fontSize: 12, color: 'var(--color-text-body)' }}>
                          {anchor.node?.label ?? 'Deleted node'}
                        </span>
                        <span style={{ fontSize: 11, color: '#d97706', flexShrink: 0 }}>
                          Dormant
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {lowScoreAnchors.length > 0 && (
                <div>
                  <div style={{ marginBottom: 8 }}>
                    <SectionLabel>Low Score</SectionLabel>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {lowScoreAnchors.map(anchor => (
                      <button
                        key={anchor.id}
                        type="button"
                        onClick={() => onSelectAnchor(anchor.id)}
                        className="flex items-center justify-between gap-3 font-body"
                        style={{
                          width: '100%',
                          border: 'none',
                          background: 'transparent',
                          cursor: 'pointer',
                          padding: '6px 8px',
                          borderRadius: 6,
                          textAlign: 'left',
                        }}
                        onMouseEnter={e => { e.currentTarget.style.background = 'var(--color-bg-hover)' }}
                        onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
                      >
                        <span className="truncate" style={{ flex: 1, minWidth: 0, fontSize: 12, color: 'var(--color-text-body)' }}>
                          {anchor.node?.label ?? 'Deleted node'}
                        </span>
                        <span style={{ fontSize: 11, color: 'var(--color-text-secondary)', flexShrink: 0 }}>
                          {Math.round(anchor.compositeScore * 100)}%
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </ExpandableSection>

        <ExpandableSection
          label="Recently Generated"
          expanded={showRecentAnchors}
          onToggle={() => setShowRecentAnchors(prev => !prev)}
        >
          {recentAnchors.length > 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {recentAnchors.map(anchor => (
                <button
                  key={anchor.id}
                  type="button"
                  onClick={() => onSelectAnchor(anchor.id)}
                  className="flex items-center gap-2 font-body"
                  style={{
                    width: '100%',
                    border: 'none',
                    background: 'transparent',
                    cursor: 'pointer',
                    padding: '6px 8px',
                    borderRadius: 6,
                    textAlign: 'left',
                  }}
                  onMouseEnter={e => { e.currentTarget.style.background = 'var(--color-bg-hover)' }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
                >
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--color-accent-500)', flexShrink: 0 }} />
                  <span className="truncate" style={{ flex: 1, minWidth: 0, fontSize: 12, color: 'var(--color-text-body)' }}>
                    {anchor.node?.label ?? 'Deleted node'}
                  </span>
                  <span style={{ fontSize: 11, color: 'var(--color-text-secondary)', flexShrink: 0 }}>
                    {anchor.connectionCount} links
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <EmptySectionMessage>No recent anchors yet.</EmptySectionMessage>
          )}
        </ExpandableSection>
      </div>

      <div
        className="font-body"
        style={{
          borderTop: '1px solid var(--border-subtle)',
          marginTop: 20,
          paddingTop: 16,
          fontSize: 11,
          color: 'var(--color-text-secondary)',
          textAlign: 'center',
        }}
      >
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <Layers3 size={12} />
          {totalSourcesIngested} sources ingested
        </span>
        <span style={{ margin: '0 8px' }}>·</span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <Radio size={12} />
          {totalSignalUses} total uses across all signals
        </span>
      </div>
    </div>
  )
}
