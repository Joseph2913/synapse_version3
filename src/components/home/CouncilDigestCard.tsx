import { useState, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { Users, AlertTriangle, HelpCircle, CircleDashed, ArrowRight, CheckCircle2 } from 'lucide-react'
import { useHomeDashboard } from '../../hooks/useHomeDashboard'
import type {
  CouncilDigest,
  CouncilDigestTension,
  CouncilDigestQuestion,
  CouncilDigestGap,
  CouncilDigestAgentSummary,
  CouncilDigestRecentlyAnswered,
  CouncilGapSeverity,
} from '../../types/council'

// ── Color conventions ───────────────────────────────────────────────────────

const TENSION_COLOR = { accent: '#b45309' }
const FRONTIER_COLOR = { accent: '#0d9488' }

const GAP_SEVERITY_COLOR: Record<CouncilGapSeverity, string> = {
  significant: '#dc2626',
  moderate:    '#b45309',
  minor:       '#6b7280',
}

const GAP_SEVERITY_LABEL: Record<CouncilGapSeverity, string> = {
  significant: 'Significant',
  moderate:    'Moderate',
  minor:       'Minor',
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function buildCouncilLink(agentId: string, focusId?: string): string {
  if (focusId) return `/council/${agentId}?focus=${focusId}`
  return `/council/${agentId}`
}

function formatConfidence(c: number | null): string | null {
  if (c == null) return null
  return `${Math.round(c * 100)}%`
}

function formatRelative(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime()
  const hours = Math.floor(diff / 3_600_000)
  if (hours < 1) return 'just now'
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

// ── Hover detail card ───────────────────────────────────────────────────────

interface HoverAnchor {
  rect: DOMRect
  content: React.ReactNode
}

function HoverCard({ anchor }: { anchor: HoverAnchor | null }) {
  if (!anchor) return null
  const width = 320
  const gap = 6
  const viewportW = window.innerWidth
  const viewportH = window.innerHeight
  const estimatedH = 200

  // Horizontal: prefer right of row, else left; clamp so the card stays in-viewport
  let left: number
  const rightCandidate = anchor.rect.right + gap
  if (rightCandidate + width <= viewportW - 8) {
    left = rightCandidate
  } else {
    const leftCandidate = anchor.rect.left - width - gap
    if (leftCandidate >= 8) {
      left = leftCandidate
    } else {
      // Clamp to viewport right edge but keep adjacent to row
      left = Math.max(8, viewportW - width - 8)
    }
  }

  // Vertical: align with row top, but keep card within viewport
  let top = anchor.rect.top
  if (top + estimatedH > viewportH - 8) {
    top = Math.max(8, viewportH - estimatedH - 8)
  }

  const node = (
    <div
      className="bg-bg-card border border-border-subtle"
      style={{
        position: 'fixed',
        top,
        left,
        width,
        padding: '12px 14px',
        borderRadius: 10,
        boxShadow: '0 12px 32px rgba(15, 23, 42, 0.16), 0 2px 6px rgba(15, 23, 42, 0.08)',
        zIndex: 9999,
        pointerEvents: 'none',
      }}
    >
      {anchor.content}
    </div>
  )

  return createPortal(node, document.body)
}

// ── Row (generic, no pills) ─────────────────────────────────────────────────

interface DigestRowProps {
  primaryText: string
  agentName: string
  rightMeta?: string | null
  hoverContent: React.ReactNode
  onClick: () => void
  setHoverAnchor: (a: HoverAnchor | null) => void
}

function DigestRow({ primaryText, agentName, rightMeta, hoverContent, onClick, setHoverAnchor }: DigestRowProps) {
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  return (
    <button
      ref={buttonRef}
      type="button"
      onClick={onClick}
      onMouseEnter={() => {
        const el = buttonRef.current
        if (!el) return
        setHoverAnchor({ rect: el.getBoundingClientRect(), content: hoverContent })
      }}
      onMouseLeave={() => setHoverAnchor(null)}
      className="flex w-full text-left bg-transparent border-none cursor-pointer hover:bg-bg-hover"
      style={{ gap: 10, padding: '9px 16px', alignItems: 'center', transition: 'background 0.15s ease' }}
    >
      <span className="font-body text-text-primary truncate" style={{ fontSize: 12, fontWeight: 600, lineHeight: 1.35, flex: 1, minWidth: 0 }}>
        {primaryText}
      </span>
      <span className="font-body text-text-secondary shrink-0" style={{ fontSize: 11 }}>
        {agentName}
      </span>
      {rightMeta && (
        <span className="font-body text-text-placeholder shrink-0" style={{ fontSize: 11, fontVariantNumeric: 'tabular-nums' }}>
          {rightMeta}
        </span>
      )}
    </button>
  )
}

// ── Hover content builders ──────────────────────────────────────────────────

function TensionHoverContent({ item }: { item: CouncilDigestTension }) {
  const conf = formatConfidence(item.confidence)
  return (
    <div>
      <div className="flex items-center" style={{ gap: 8, marginBottom: 8 }}>
        <span className="font-body" style={{ fontSize: 9, fontWeight: 700, padding: '2px 6px', borderRadius: 4, background: '#fef3c7', color: TENSION_COLOR.accent, letterSpacing: '0.04em', textTransform: 'uppercase' }}>
          Tension
        </span>
        <span className="font-body text-text-secondary" style={{ fontSize: 11 }}>{item.agent_name}</span>
        {conf && (
          <span className="font-body text-text-placeholder" style={{ fontSize: 11, marginLeft: 'auto', fontVariantNumeric: 'tabular-nums' }}>{conf} confidence</span>
        )}
      </div>
      <div className="font-display text-text-primary" style={{ fontSize: 13, fontWeight: 700, lineHeight: 1.4, marginBottom: 6 }}>
        {item.claim}
      </div>
      {item.evidence_summary && (
        <p className="font-body text-text-secondary" style={{ fontSize: 12, lineHeight: 1.5, margin: 0 }}>
          {item.evidence_summary}
        </p>
      )}
      <div className="font-body text-text-placeholder" style={{ fontSize: 11, marginTop: 10 }}>
        {formatRelative(item.created_at)} · Click to open in Council
      </div>
    </div>
  )
}

function QuestionHoverContent({ item }: { item: CouncilDigestQuestion }) {
  return (
    <div>
      <div className="flex items-center" style={{ gap: 8, marginBottom: 8 }}>
        <span className="font-body" style={{ fontSize: 9, fontWeight: 700, padding: '2px 6px', borderRadius: 4, background: '#ccfbf1', color: FRONTIER_COLOR.accent, letterSpacing: '0.04em', textTransform: 'uppercase' }}>
          Frontier
        </span>
        <span className="font-body text-text-secondary" style={{ fontSize: 11 }}>{item.agent_name}</span>
        {item.priority != null && (
          <span className="font-body text-text-placeholder" style={{ fontSize: 11, marginLeft: 'auto', fontVariantNumeric: 'tabular-nums' }}>Priority {item.priority}</span>
        )}
      </div>
      <div className="font-display text-text-primary" style={{ fontSize: 13, fontWeight: 700, lineHeight: 1.4 }}>
        {item.question}
      </div>
      <div className="font-body text-text-placeholder" style={{ fontSize: 11, marginTop: 10 }}>
        {formatRelative(item.created_at)} · Click to open in Council
      </div>
    </div>
  )
}

function GapHoverContent({ item }: { item: CouncilDigestGap }) {
  const sevColor = GAP_SEVERITY_COLOR[item.severity] ?? GAP_SEVERITY_COLOR.moderate
  const sevLabel = GAP_SEVERITY_LABEL[item.severity] ?? 'Moderate'
  const sevBg = item.severity === 'significant' ? '#fee2e2' : item.severity === 'moderate' ? '#fef3c7' : '#f3f4f6'
  return (
    <div>
      <div className="flex items-center" style={{ gap: 8, marginBottom: 8 }}>
        <span className="font-body" style={{ fontSize: 9, fontWeight: 700, padding: '2px 6px', borderRadius: 4, background: sevBg, color: sevColor, letterSpacing: '0.04em', textTransform: 'uppercase' }}>
          {sevLabel}
        </span>
        <span className="font-body text-text-secondary" style={{ fontSize: 11 }}>{item.agent_name}</span>
        <span className="font-body text-text-placeholder" style={{ fontSize: 11, marginLeft: 'auto' }}>{item.gap_type}</span>
      </div>
      <div className="font-display text-text-primary" style={{ fontSize: 13, fontWeight: 700, lineHeight: 1.4, marginBottom: 6 }}>
        {item.topic}
      </div>
      {item.description && (
        <p className="font-body text-text-secondary" style={{ fontSize: 12, lineHeight: 1.5, margin: 0 }}>
          {item.description}
        </p>
      )}
      <div className="font-body text-text-placeholder" style={{ fontSize: 11, marginTop: 10 }}>
        {formatRelative(item.created_at)} · Click to open in Council
      </div>
    </div>
  )
}

// ── Active agent chip ───────────────────────────────────────────────────────

function ActiveAgentChip({ agent, onClick }: { agent: CouncilDigestAgentSummary; onClick: () => void }) {
  const total = agent.new_insights + agent.new_questions + agent.new_gaps
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center shrink-0 bg-transparent border cursor-pointer hover:bg-bg-hover"
      style={{
        gap: 6,
        padding: '4px 10px',
        borderRadius: 20,
        borderColor: 'var(--border-subtle)',
        transition: 'background 0.15s ease, border-color 0.15s ease',
      }}
    >
      <span className="font-body text-text-primary" style={{ fontSize: 11, fontWeight: 600 }}>
        {agent.agent_name}
      </span>
      <span
        className="font-body"
        style={{
          fontSize: 10,
          fontWeight: 700,
          padding: '1px 6px',
          borderRadius: 10,
          background: 'var(--color-accent-50)',
          color: 'var(--color-accent-500)',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {total}
      </span>
    </button>
  )
}

// ── Section wrapper ─────────────────────────────────────────────────────────

function DigestSection({ title, icon, accent, children }: { title: string; icon: React.ReactNode; accent: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col min-w-0" style={{ flex: '1 1 0' }}>
      <div className="flex items-center" style={{ gap: 6, padding: '8px 16px 4px 16px' }}>
        <span style={{ color: accent, display: 'flex' }}>{icon}</span>
        <span className="font-display text-text-primary" style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.03em', textTransform: 'uppercase' }}>
          {title}
        </span>
      </div>
      <div className="flex flex-col">{children}</div>
    </div>
  )
}

// ── Main card ───────────────────────────────────────────────────────────────

export function CouncilDigestCard() {
  const { councilDigest, loading, errors } = useHomeDashboard()
  const navigate = useNavigate()
  const [hoverAnchor, setHoverAnchor] = useState<HoverAnchor | null>(null)

  const goto = (agentId: string, focusId?: string) => {
    navigate(buildCouncilLink(agentId, focusId))
  }

  // Loading skeleton
  if (loading.councilDigest && !councilDigest) {
    return (
      <div
        className="bg-bg-card border border-border-subtle"
        style={{ borderRadius: 12, padding: 0, overflow: 'hidden' }}
      >
        <div style={{ padding: '12px 20px', borderBottom: '1px solid var(--border-subtle)' }}>
          <div className="bg-bg-inset animate-pulse" style={{ height: 14, width: 320, borderRadius: 4 }} />
        </div>
        <div className="flex">
          {[0, 1, 2].map(i => (
            <div key={i} className="flex-1" style={{ padding: '10px 16px', borderRight: i < 2 ? '1px solid var(--border-subtle)' : 'none' }}>
              <div className="bg-bg-inset animate-pulse" style={{ height: 10, width: 80, borderRadius: 4, marginBottom: 8 }} />
              {[0, 1, 2].map(j => (
                <div key={j} className="bg-bg-inset animate-pulse" style={{ height: 12, borderRadius: 4, marginBottom: 6 }} />
              ))}
            </div>
          ))}
        </div>
      </div>
    )
  }

  if (errors.councilDigest && !councilDigest) return null

  const digest: CouncilDigest | null = councilDigest
  if (!digest) return null

  const { summary, top_tensions, top_frontier_questions, top_gaps, active_agents, recently_answered_questions } = digest
  const recentlyAnswered: CouncilDigestRecentlyAnswered[] = recently_answered_questions ?? []
  const isEmpty =
    summary.insights_count === 0 &&
    summary.questions_count === 0 &&
    summary.gaps_count === 0

  if (isEmpty) {
    return (
      <div
        className="bg-bg-card border border-border-subtle"
        style={{ borderRadius: 12, padding: '14px 20px' }}
      >
        <div className="flex items-center" style={{ gap: 10, marginBottom: 4 }}>
          <div className="shrink-0 flex items-center justify-center" style={{ width: 22, height: 22, borderRadius: 6, background: 'var(--color-accent-50)' }}>
            <Users size={12} style={{ color: 'var(--color-accent-500)' }} />
          </div>
          <span className="font-display text-text-primary" style={{ fontSize: 13, fontWeight: 700 }}>
            Council Digest
          </span>
        </div>
        <p className="font-body text-text-secondary" style={{ fontSize: 12 }}>
          Your Council is quiet this week. Ingest new content to see fresh analysis.
        </p>
      </div>
    )
  }

  return (
    <>
      <div
        className="bg-bg-card border border-border-subtle overflow-hidden"
        style={{ borderRadius: 12 }}
      >
        {/* Headline row */}
        <div
          className="flex items-center justify-between"
          style={{ padding: '10px 20px', borderBottom: '1px solid var(--border-subtle)', gap: 16 }}
        >
          <div className="flex items-center shrink-0" style={{ gap: 10 }}>
            <div className="shrink-0 flex items-center justify-center" style={{ width: 22, height: 22, borderRadius: 6, background: 'var(--color-accent-50)' }}>
              <Users size={12} style={{ color: 'var(--color-accent-500)' }} />
            </div>
            <span className="font-display text-text-primary shrink-0" style={{ fontSize: 13, fontWeight: 700 }}>
              Council Digest
            </span>
            <span className="text-text-placeholder shrink-0" style={{ fontSize: 11 }}>·</span>
            <span className="font-body text-text-secondary" style={{ fontSize: 12 }}>
              <strong className="text-text-primary" style={{ fontWeight: 700 }}>{summary.insights_count}</strong> insights ·{' '}
              <strong className="text-text-primary" style={{ fontWeight: 700 }}>{summary.questions_count}</strong> questions ·{' '}
              <strong className="text-text-primary" style={{ fontWeight: 700 }}>{summary.gaps_count}</strong> gaps ·{' '}
              <strong className="text-text-primary" style={{ fontWeight: 700 }}>{summary.active_agents_count}</strong> agents
            </span>
          </div>

          {active_agents.length > 0 && (
            <div className="flex items-center min-w-0 overflow-hidden" style={{ gap: 6, flex: '1 1 auto', justifyContent: 'flex-end' }}>
              <span className="font-body text-text-placeholder shrink-0" style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.04em', fontWeight: 600, marginRight: 2 }}>
                Most active
              </span>
              {active_agents.slice(0, 5).map(a => (
                <ActiveAgentChip key={a.agent_id} agent={a} onClick={() => goto(a.agent_id)} />
              ))}
            </div>
          )}

          <button
            type="button"
            onClick={() => navigate('/council')}
            className="font-body cursor-pointer bg-transparent border shrink-0 flex items-center"
            style={{
              fontSize: 12,
              fontWeight: 600,
              color: 'var(--color-accent-500)',
              padding: '4px 10px',
              borderRadius: 20,
              borderColor: 'rgba(214,58,0,0.15)',
              background: 'var(--color-accent-50)',
              gap: 4,
            }}
          >
            Open <ArrowRight size={12} />
          </button>
        </div>

        {/* 3 columns */}
        <div className="flex items-stretch">
          <DigestSection title="Top Tensions" icon={<AlertTriangle size={12} />} accent={TENSION_COLOR.accent}>
            {top_tensions.length === 0 ? (
              <div className="font-body text-text-placeholder" style={{ fontSize: 11, padding: '6px 16px 10px 16px' }}>No tensions this week.</div>
            ) : (
              top_tensions.map(t => (
                <DigestRow
                  key={t.id}
                  primaryText={t.claim}
                  agentName={t.agent_name}
                  rightMeta={formatConfidence(t.confidence)}
                  hoverContent={<TensionHoverContent item={t} />}
                  onClick={() => goto(t.agent_id, t.id)}
                  setHoverAnchor={setHoverAnchor}
                />
              ))
            )}
          </DigestSection>

          <div style={{ width: 1, background: 'var(--border-subtle)' }} />

          <DigestSection title="Frontier Questions" icon={<HelpCircle size={12} />} accent={FRONTIER_COLOR.accent}>
            {top_frontier_questions.length === 0 ? (
              <div className="font-body text-text-placeholder" style={{ fontSize: 11, padding: '6px 16px 10px 16px' }}>No new frontier questions.</div>
            ) : (
              top_frontier_questions.map(q => (
                <DigestRow
                  key={q.id}
                  primaryText={q.question}
                  agentName={q.agent_name}
                  hoverContent={<QuestionHoverContent item={q} />}
                  onClick={() => goto(q.agent_id, q.id)}
                  setHoverAnchor={setHoverAnchor}
                />
              ))
            )}
          </DigestSection>

          <div style={{ width: 1, background: 'var(--border-subtle)' }} />

          <DigestSection title="Gaps Flagged" icon={<CircleDashed size={12} />} accent={GAP_SEVERITY_COLOR.significant}>
            {top_gaps.length === 0 ? (
              <div className="font-body text-text-placeholder" style={{ fontSize: 11, padding: '6px 16px 10px 16px' }}>No new gaps.</div>
            ) : (
              top_gaps.map(g => (
                <DigestRow
                  key={g.id}
                  primaryText={g.topic}
                  agentName={g.agent_name}
                  hoverContent={<GapHoverContent item={g} />}
                  onClick={() => goto(g.agent_id, g.id)}
                  setHoverAnchor={setHoverAnchor}
                />
              ))
            )}
          </DigestSection>
        </div>

        {recentlyAnswered.length > 0 && (
          <div
            className="flex items-center flex-wrap"
            style={{
              borderTop: '1px solid var(--border-subtle)',
              padding: '8px 16px',
              gap: 10,
              background: 'var(--color-bg-subtle)',
            }}
          >
            <span
              className="font-body flex items-center shrink-0"
              style={{
                fontSize: 10,
                textTransform: 'uppercase',
                letterSpacing: '0.04em',
                fontWeight: 600,
                color: '#1f6f43',
                gap: 4,
              }}
            >
              <CheckCircle2 size={11} /> Recently answered
            </span>
            {recentlyAnswered.slice(0, 3).map(q => (
              <button
                key={q.id}
                type="button"
                onClick={() => goto(q.agent_id, q.id)}
                className="font-body cursor-pointer text-left flex items-center truncate"
                style={{
                  fontSize: 12,
                  color: 'var(--color-text-secondary)',
                  background: 'transparent',
                  border: 'none',
                  padding: 0,
                  maxWidth: 280,
                  gap: 6,
                }}
                title={q.question}
              >
                <span
                  className="shrink-0 rounded-full"
                  style={{
                    width: 6,
                    height: 6,
                    background: q.status === 'answered' ? '#1f6f43' : 'var(--color-accent-500)',
                  }}
                />
                <span className="truncate">{q.question}</span>
                <span className="text-text-placeholder shrink-0" style={{ fontSize: 11 }}>· {q.agent_name}</span>
              </button>
            ))}
            {recentlyAnswered.length > 3 && (
              <span className="font-body text-text-placeholder" style={{ fontSize: 11 }}>
                +{recentlyAnswered.length - 3} more
              </span>
            )}
          </div>
        )}
      </div>

      <HoverCard anchor={hoverAnchor} />
    </>
  )
}
