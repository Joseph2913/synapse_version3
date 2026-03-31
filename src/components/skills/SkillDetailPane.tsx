import { useState } from 'react'
import { MoreHorizontal, AlertCircle } from 'lucide-react'
import { EntityBadge } from '../shared/EntityBadge'
import { SkillExposureBadge } from './SkillExposureBadge'
import { SkillConfidenceBar } from './SkillConfidenceBar'
import { SkillConfidenceTrajectory } from './SkillConfidenceTrajectory'
import { DomainBadge } from './SkillCard'
import { SectionLabel } from '../ui/SectionLabel'
import type { SkillWithSources, Skill } from '../../hooks/useSkills'

interface SkillDetailPaneProps {
  skill: SkillWithSources
  loading: boolean
  onDismiss: () => Promise<void>
  onUpdateExposureLevel: (level: Skill['exposure_level']) => Promise<void>
  onUpdateLabel: (label: string) => Promise<void>
  onSelectRelatedSkill: (id: string) => void
}

const SOURCE_EMOJIS: Record<string, string> = {
  YouTube:  '📺',
  Meeting:  '💬',
  Document: '📄',
  Research: '🔬',
  Note:     '📄',
}

interface ContributionStyle { bg: string; color: string; label: string }

const CONTRIBUTION_STYLES: Record<string, ContributionStyle> = {
  created:    { bg: 'rgba(214,58,0,0.08)',   color: 'var(--color-accent-500)', label: 'Created' },
  reinforced: { bg: 'rgba(59,130,246,0.08)',  color: '#2563eb',                 label: 'Reinforced' },
  upgraded:   { bg: 'rgba(16,185,129,0.08)',  color: '#059669',                 label: 'Upgraded' },
  corrected:  { bg: 'rgba(128,128,128,0.08)', color: '#808080',                 label: 'Corrected' },
}

const DEFAULT_CONTRIBUTION_STYLE: ContributionStyle = {
  bg: 'rgba(59,130,246,0.08)', color: '#2563eb', label: 'Reinforced',
}

const SIGNAL_LABELS: Record<string, string> = {
  anchorAlignment: 'Anchor Alignment',
  nodeDensity:     'Node Density',
  sourceHistory:   'Source History',
  graphProximity:  'Graph Proximity',
  profileContext:  'Profile Match',
  velocity:        'Recent Activity',
}

const EXPOSURE_LEVELS: Skill['exposure_level'][] = ['novice', 'developing', 'proficient', 'advanced']

function getConfidenceColor(confidence: number): string {
  if (confidence < 0.40) return '#808080'
  if (confidence < 0.60) return '#3b82f6'
  if (confidence < 0.80) return '#10b981'
  return '#d63a00'
}

function getSignalBarColor(score: number): string {
  if (score >= 0.6) return '#10b981'
  if (score >= 0.3) return '#d97706'
  return '#808080'
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

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

export function SkillDetailPane({
  skill,
  loading,
  onDismiss,
  onUpdateExposureLevel,
  onUpdateLabel,
  onSelectRelatedSkill,
}: SkillDetailPaneProps) {
  const [actionsOpen, setActionsOpen] = useState(false)
  const [editingLabel, setEditingLabel] = useState(false)
  const [labelDraft, setLabelDraft] = useState(skill.label)
  const [editingExposure, setEditingExposure] = useState(false)
  const [labelError, setLabelError] = useState<string | null>(null)

  const pct = Math.round(skill.confidence * 100)
  const color = getConfidenceColor(skill.confidence)

  const handleSaveLabel = async () => {
    const trimmed = labelDraft.trim()
    if (!trimmed) return
    setLabelError(null)
    try {
      await onUpdateLabel(trimmed)
      setEditingLabel(false)
    } catch (err) {
      setLabelError(err instanceof Error ? err.message : 'Failed to update label')
    }
  }

  if (loading) {
    return (
      <div style={{ padding: '36px 40px', maxWidth: 860 }}>
        <div className="flex flex-col gap-3">
          {[120, 80, 200, 160].map((w, i) => (
            <div
              key={i}
              style={{
                height: 14,
                width: w,
                background: 'var(--color-bg-inset)',
                borderRadius: 6,
                animation: 'pulse 1.4s ease-in-out infinite',
                animationDelay: `${i * 0.08}s`,
              }}
            />
          ))}
        </div>
      </div>
    )
  }

  return (
    <div style={{ padding: '36px 40px', maxWidth: 860 }}>

      {/* ── Header ───────────────────────────────────────────────── */}
      <div style={{ marginBottom: 24 }}>
        <div className="flex items-center justify-between" style={{ marginBottom: 12 }}>
          <div className="flex items-center" style={{ gap: 6 }}>
            <DomainBadge domain={skill.domain} />
            <SkillExposureBadge level={skill.exposure_level} />
          </div>

          {/* Actions menu */}
          <div style={{ position: 'relative' }}>
            <button
              type="button"
              onClick={() => setActionsOpen(prev => !prev)}
              className="flex items-center justify-center border cursor-pointer"
              style={{
                width: 32,
                height: 32,
                borderRadius: 8,
                background: 'transparent',
                borderColor: 'var(--border-subtle)',
                color: 'var(--color-text-secondary)',
                transition: 'background 0.15s ease',
              }}
              onMouseEnter={e => { e.currentTarget.style.background = 'var(--color-bg-hover)' }}
              onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
            >
              <MoreHorizontal size={16} />
            </button>

            {actionsOpen && (
              <>
                {/* Backdrop */}
                <div
                  style={{ position: 'fixed', inset: 0, zIndex: 10 }}
                  onClick={() => setActionsOpen(false)}
                />
                <div
                  style={{
                    position: 'absolute',
                    right: 0,
                    top: 36,
                    zIndex: 20,
                    background: 'var(--color-bg-card)',
                    border: '1px solid var(--border-strong)',
                    borderRadius: 10,
                    boxShadow: '0 4px 12px rgba(0,0,0,0.08)',
                    minWidth: 160,
                    overflow: 'hidden',
                  }}
                >
                  {[
                    {
                      label: 'Edit label',
                      action: () => {
                        setLabelDraft(skill.label)
                        setEditingLabel(true)
                        setActionsOpen(false)
                      },
                    },
                    {
                      label: 'Change exposure level',
                      action: () => {
                        setEditingExposure(true)
                        setActionsOpen(false)
                      },
                    },
                    {
                      label: 'Dismiss skill',
                      action: async () => {
                        setActionsOpen(false)
                        await onDismiss()
                      },
                      danger: true,
                    },
                  ].map(item => (
                    <button
                      key={item.label}
                      type="button"
                      onClick={item.action}
                      className="w-full text-left border-none cursor-pointer font-body"
                      style={{
                        fontSize: 12,
                        padding: '10px 14px',
                        background: 'transparent',
                        color: item.danger ? 'var(--color-semantic-red-500)' : 'var(--color-text-body)',
                        transition: 'background 0.15s ease',
                      }}
                      onMouseEnter={e => { e.currentTarget.style.background = 'var(--color-bg-hover)' }}
                      onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>

        {/* Label */}
        {editingLabel ? (
          <div style={{ marginBottom: 8 }}>
            <input
              type="text"
              value={labelDraft}
              onChange={e => setLabelDraft(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') handleSaveLabel()
                if (e.key === 'Escape') { setEditingLabel(false); setLabelError(null) }
              }}
              autoFocus
              className="font-display font-bold w-full"
              style={{
                fontSize: 20,
                letterSpacing: '-0.02em',
                color: 'var(--color-text-primary)',
                border: '1px solid var(--color-accent-500)',
                borderRadius: 6,
                padding: '4px 8px',
                background: 'var(--color-bg-inset)',
                outline: 'none',
              }}
            />
            <div className="flex items-center gap-2 mt-2">
              <button
                type="button"
                onClick={handleSaveLabel}
                className="font-body font-semibold cursor-pointer border-none"
                style={{
                  fontSize: 11,
                  padding: '4px 10px',
                  borderRadius: 6,
                  background: 'var(--color-accent-500)',
                  color: 'white',
                }}
              >
                Save
              </button>
              <button
                type="button"
                onClick={() => { setEditingLabel(false); setLabelError(null) }}
                className="font-body cursor-pointer border-none"
                style={{ fontSize: 11, padding: '4px 8px', background: 'transparent', color: 'var(--color-text-secondary)' }}
              >
                Cancel
              </button>
              {labelError && (
                <span className="flex items-center gap-1 font-body" style={{ fontSize: 11, color: 'var(--color-semantic-red-500)' }}>
                  <AlertCircle size={11} /> {labelError}
                </span>
              )}
            </div>
          </div>
        ) : (
          <h2
            className="font-display"
            style={{
              fontSize: 20,
              fontWeight: 800,
              color: 'var(--color-text-primary)',
              letterSpacing: '-0.02em',
              margin: '0 0 8px 0',
            }}
          >
            {skill.label}
          </h2>
        )}

        {/* Description */}
        {skill.description && (
          <p className="font-body" style={{ fontSize: 13, color: 'var(--color-text-body)', lineHeight: 1.6, margin: 0 }}>
            {skill.description}
          </p>
        )}

        {/* Exposure level inline editor */}
        {editingExposure && (
          <div className="flex items-center gap-2 mt-3" style={{ flexWrap: 'wrap' }}>
            <span className="font-body" style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>Exposure level:</span>
            {EXPOSURE_LEVELS.map(level => (
              <button
                key={level}
                type="button"
                onClick={async () => {
                  await onUpdateExposureLevel(level)
                  setEditingExposure(false)
                }}
                className="font-body font-semibold capitalize cursor-pointer border-none"
                style={{
                  fontSize: 11,
                  padding: '4px 10px',
                  borderRadius: 20,
                  background: skill.exposure_level === level ? 'var(--color-accent-500)' : 'var(--color-bg-inset)',
                  color: skill.exposure_level === level ? 'white' : 'var(--color-text-secondary)',
                  border: '1px solid var(--border-subtle)',
                  transition: 'background 0.15s ease',
                }}
              >
                {level}
              </button>
            ))}
            <button
              type="button"
              onClick={() => setEditingExposure(false)}
              className="font-body cursor-pointer border-none"
              style={{ fontSize: 11, color: 'var(--color-text-secondary)', background: 'transparent', padding: '4px 8px' }}
            >
              Cancel
            </button>
          </div>
        )}
      </div>

      {/* Divider */}
      <div style={{ borderTop: '1px solid var(--border-subtle)', marginBottom: 20 }} />

      {/* ── Two-column grid: Confidence + Signal Breakdown ────── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, marginBottom: 20 }}>

        {/* Confidence card */}
        <div
          style={{
            background: 'var(--color-bg-card)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 12,
            padding: 20,
          }}
        >
          <SectionLabel>Confidence</SectionLabel>
          <div
            className="font-display"
            style={{ fontSize: 36, fontWeight: 800, color, lineHeight: 1, marginTop: 8, marginBottom: 4 }}
          >
            {pct}%
          </div>
          <p className="font-body" style={{ fontSize: 11, color: 'var(--color-text-secondary)', marginBottom: 12 }}>
            Based on {skill.evidence_count} source{skill.evidence_count !== 1 ? 's' : ''} · {skill.exposure_level}
          </p>
          <SkillConfidenceBar confidence={skill.confidence} variant="full" />
          <div style={{ borderTop: '1px solid var(--border-subtle)', marginTop: 12, paddingTop: 10 }}>
            <p className="font-body" style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>
              Last reinforced {formatRelativeTime(skill.last_reinforced_at)} · First detected {formatDate(skill.first_detected_at)}
            </p>
          </div>
        </div>

        {/* Signal Breakdown card */}
        <div
          style={{
            background: 'var(--color-bg-card)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 12,
            padding: 20,
          }}
        >
          <SectionLabel>Relevance Signals</SectionLabel>
          <div style={{ marginTop: 12 }}>
            {!skill.signal_breakdown ? (
              <p className="font-body" style={{ fontSize: 11, color: 'var(--color-text-secondary)', fontStyle: 'italic' }}>
                Signal data available after next re-score
              </p>
            ) : (
              <div className="flex flex-col" style={{ gap: 8 }}>
                {Object.entries(skill.signal_breakdown).map(([key, score]) => (
                  <div key={key} className="flex items-center" style={{ gap: 8 }}>
                    <span
                      className="font-body font-semibold shrink-0"
                      style={{ fontSize: 12, color: 'var(--color-text-primary)', width: 120 }}
                    >
                      {SIGNAL_LABELS[key] ?? key}
                    </span>
                    <div
                      style={{
                        flex: 1,
                        height: 5,
                        borderRadius: 6,
                        background: 'var(--color-bg-inset)',
                        overflow: 'hidden',
                      }}
                    >
                      <div
                        style={{
                          width: `${Math.round(score * 100)}%`,
                          height: '100%',
                          borderRadius: 6,
                          background: getSignalBarColor(score),
                          transition: 'width 0.4s ease',
                        }}
                      />
                    </div>
                    <span
                      className="font-body font-semibold shrink-0"
                      style={{ fontSize: 11, color: 'var(--color-text-secondary)', width: 32, textAlign: 'right' }}
                    >
                      {Math.round(score * 100)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── When to Apply ─────────────────────────────────────── */}
      <div
        style={{
          background: 'var(--color-bg-card)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 12,
          padding: 20,
          marginBottom: 20,
        }}
      >
        <SectionLabel>When to Apply</SectionLabel>
        <div style={{ marginTop: 10 }}>
          {skill.when_to_apply ? (
            <p className="font-body" style={{ fontSize: 13, color: 'var(--color-text-body)', lineHeight: 1.6, margin: 0 }}>
              {skill.when_to_apply}
            </p>
          ) : (
            <div
              className="flex items-center gap-2"
              style={{
                padding: '12px 16px',
                background: 'var(--color-bg-inset)',
                borderRadius: 8,
              }}
            >
              <p className="font-body" style={{ fontSize: 11, color: 'var(--color-text-secondary)', fontStyle: 'italic', margin: 0 }}>
                Generating on next weekly re-score
              </p>
            </div>
          )}
        </div>
      </div>

      {/* ── How to Apply ──────────────────────────────────────── */}
      <div
        style={{
          background: 'var(--color-bg-card)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 12,
          padding: 20,
          marginBottom: 20,
        }}
      >
        <SectionLabel>How to Apply</SectionLabel>
        <div style={{ marginTop: 10 }}>
          {skill.how_to_apply ? (
            <p className="font-body" style={{ fontSize: 13, color: 'var(--color-text-body)', lineHeight: 1.6, margin: 0 }}>
              {skill.how_to_apply}
            </p>
          ) : (
            <div
              className="flex items-center gap-2"
              style={{
                padding: '12px 16px',
                background: 'var(--color-bg-inset)',
                borderRadius: 8,
              }}
            >
              <p className="font-body" style={{ fontSize: 11, color: 'var(--color-text-secondary)', fontStyle: 'italic', margin: 0 }}>
                Generating on next weekly re-score
              </p>
            </div>
          )}
        </div>
      </div>

      {/* ── Confidence Trajectory ─────────────────────────────── */}
      <div
        style={{
          background: 'var(--color-bg-card)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 12,
          padding: 20,
          marginBottom: 20,
        }}
      >
        <SectionLabel>Confidence Over Time</SectionLabel>
        <div style={{ marginTop: 12 }}>
          <SkillConfidenceTrajectory skill={skill} />
        </div>
      </div>

      {/* ── Contributing Sources ──────────────────────────────── */}
      <div
        style={{
          background: 'var(--color-bg-card)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 12,
          padding: 20,
          marginBottom: 20,
        }}
      >
        <SectionLabel>Contributing Sources {skill.evidence_count > 0 ? skill.evidence_count : ''}</SectionLabel>
        <div style={{ marginTop: 12 }}>
          {skill.contributing_sources.length === 0 ? (
            <p className="font-body" style={{ fontSize: 11, color: 'var(--color-text-secondary)', fontStyle: 'italic' }}>
              No source data available for this skill
            </p>
          ) : (
            skill.contributing_sources.map((source, idx) => {
              const badge = CONTRIBUTION_STYLES[source.contribution] ?? DEFAULT_CONTRIBUTION_STYLE
              return (
                <div
                  key={source.id}
                  className="flex items-center"
                  style={{
                    padding: '12px 0',
                    borderBottom:
                      idx < skill.contributing_sources.length - 1 ? '1px solid var(--border-subtle)' : 'none',
                    gap: 12,
                  }}
                >
                  <div
                    className="flex items-center justify-center shrink-0"
                    style={{
                      width: 28,
                      height: 28,
                      borderRadius: 7,
                      background: 'var(--color-bg-inset)',
                      fontSize: 14,
                    }}
                  >
                    {SOURCE_EMOJIS[source.source_type] ?? '📄'}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div
                      className="font-body font-semibold truncate"
                      style={{ fontSize: 13, color: 'var(--color-text-primary)' }}
                    >
                      {source.title}
                    </div>
                    <div className="flex items-center gap-2 mt-1">
                      <span
                        className="font-body font-semibold"
                        style={{
                          fontSize: 10,
                          padding: '2px 6px',
                          borderRadius: 6,
                          background: badge.bg,
                          color: badge.color,
                        }}
                      >
                        {badge.label}
                      </span>
                      <span className="font-body" style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>
                        {formatDate(source.created_at)}
                      </span>
                    </div>
                  </div>
                </div>
              )
            })
          )}
        </div>
      </div>

      {/* ── Related Anchors + Related Skills ──────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, marginBottom: 20 }}>

        {/* Related Anchors */}
        <div
          style={{
            background: 'var(--color-bg-card)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 12,
            padding: 20,
          }}
        >
          <SectionLabel>Related Anchors</SectionLabel>
          <div style={{ marginTop: 12 }}>
            {skill.related_anchors.length === 0 ? (
              <p className="font-body" style={{ fontSize: 11, color: 'var(--color-text-secondary)', fontStyle: 'italic' }}>
                No anchor alignment detected
              </p>
            ) : (
              <div className="flex flex-wrap" style={{ gap: 6 }}>
                {skill.related_anchors.map(anchor => (
                  <EntityBadge
                    key={anchor.id}
                    type={anchor.entity_type}
                    label={anchor.label}
                    size="sm"
                  />
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Related Skills */}
        <div
          style={{
            background: 'var(--color-bg-card)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 12,
            padding: 20,
          }}
        >
          <SectionLabel>Related Skills</SectionLabel>
          <div style={{ marginTop: 12 }}>
            {skill.related_skills.length === 0 ? (
              <p className="font-body" style={{ fontSize: 11, color: 'var(--color-text-secondary)', fontStyle: 'italic' }}>
                Related skills identified on next re-score
              </p>
            ) : (
              <div className="flex flex-wrap" style={{ gap: 6 }}>
                {skill.related_skills.map(related => {
                  const relPct = Math.round(related.confidence * 100)
                  const relColor = related.confidence < 0.4 ? '#808080'
                    : related.confidence < 0.6 ? '#3b82f6'
                    : related.confidence < 0.8 ? '#10b981'
                    : '#d63a00'
                  return (
                    <button
                      key={related.id}
                      type="button"
                      onClick={() => onSelectRelatedSkill(related.id)}
                      className="border cursor-pointer text-left"
                      style={{
                        background: 'var(--color-bg-inset)',
                        borderColor: 'var(--border-subtle)',
                        borderRadius: 8,
                        padding: '10px 12px',
                        transition: 'border-color 0.15s ease',
                      }}
                      onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--border-default)' }}
                      onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border-subtle)' }}
                    >
                      <div className="flex items-center gap-1.5 mb-1.5">
                        <DomainBadge domain={related.domain} />
                        <span
                          className="font-body font-semibold"
                          style={{ fontSize: 12, color: 'var(--color-text-primary)' }}
                        >
                          {related.label}
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        <div
                          style={{
                            width: 32,
                            height: 3,
                            borderRadius: 2,
                            background: 'var(--color-bg-card)',
                          }}
                        >
                          <div
                            style={{
                              width: `${relPct}%`,
                              height: '100%',
                              borderRadius: 2,
                              background: relColor,
                            }}
                          />
                        </div>
                        <span
                          className="font-body font-semibold"
                          style={{ fontSize: 10, color: relColor }}
                        >
                          {relPct}%
                        </span>
                      </div>
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Entity Cluster ────────────────────────────────────── */}
      {skill.related_anchors.length > 0 && (
        <div
          style={{
            background: 'var(--color-bg-card)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 12,
            padding: 20,
            marginBottom: 20,
          }}
        >
          <SectionLabel>Cluster Entities</SectionLabel>
          <div className="flex flex-wrap" style={{ gap: 6, marginTop: 12 }}>
            {skill.related_anchors.map(anchor => (
              <span
                key={anchor.id}
                className="inline-flex items-center font-body font-semibold"
                style={{
                  fontSize: 11,
                  padding: '4px 10px',
                  borderRadius: 20,
                  background: 'var(--color-bg-inset)',
                  border: '1px solid var(--border-subtle)',
                  color: 'var(--color-text-body)',
                  gap: 5,
                }}
              >
                <span
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: '50%',
                    background: 'var(--color-accent-500)',
                    flexShrink: 0,
                    display: 'inline-block',
                  }}
                />
                {anchor.label}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
