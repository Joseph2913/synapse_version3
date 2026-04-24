import { useState } from 'react'
import { ChevronRight } from 'lucide-react'
import type {
  CouncilOverviewAgent,
  CouncilHealthStatus,
  CouncilOverviewNovelPeer,
} from '../../types/council'

const HEALTH_CONFIG: Record<CouncilHealthStatus, { bg: string; text: string; label: string }> = {
  strong: { bg: '#dcfce7', text: '#15803d', label: 'Strong' },
  growing: { bg: '#d1fae5', text: '#047857', label: 'Growing' },
  thin: { bg: '#fef3c7', text: '#b45309', label: 'Thin' },
  stale: { bg: '#fee2e2', text: '#dc2626', label: 'Stale' },
  initialising: { bg: '#f3f4f6', text: '#6b7280', label: 'Init' },
}

function formatCount(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

function HealthPill({ status }: { status: CouncilHealthStatus }) {
  const c = HEALTH_CONFIG[status] ?? HEALTH_CONFIG.initialising
  return (
    <span
      style={{
        display: 'inline-flex', alignItems: 'center',
        fontSize: 10, fontWeight: 600, fontFamily: 'var(--font-body)',
        padding: '2px 8px', borderRadius: 20,
        background: c.bg, color: c.text,
        flexShrink: 0,
      }}
    >
      {c.label}
    </span>
  )
}

interface AggCellProps {
  value: number | string
  label: string
  onClick: (e: React.MouseEvent | React.KeyboardEvent) => void
  tooltip?: React.ReactNode
  onHoverChange?: (hovered: boolean) => void
}

function AggCell({ value, label, onClick, tooltip, onHoverChange }: AggCellProps) {
  const [hovered, setHovered] = useState(false)
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={(e) => { e.stopPropagation(); onClick(e) }}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); onClick(e) } }}
      onMouseEnter={() => { setHovered(true); onHoverChange?.(true) }}
      onMouseLeave={() => { setHovered(false); onHoverChange?.(false) }}
      onFocus={() => { setHovered(true); onHoverChange?.(true) }}
      onBlur={() => { setHovered(false); onHoverChange?.(false) }}
      style={{
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        cursor: 'pointer',
        padding: '8px 10px',
        borderRadius: 8,
        background: hovered ? 'var(--color-bg-inset)' : 'transparent',
        transition: 'background 0.15s ease',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
        <span
          style={{
            fontFamily: 'var(--font-display)',
            fontWeight: 700,
            fontSize: 24,
            lineHeight: 1,
            letterSpacing: '-0.02em',
            fontVariantNumeric: 'tabular-nums',
            color: 'var(--color-text-primary)',
          }}
        >
          {value}
        </span>
        <ChevronRight
          size={14}
          style={{
            color: hovered ? 'var(--color-accent-500)' : 'var(--color-text-placeholder)',
            transform: hovered ? 'translateX(2px)' : 'none',
            transition: 'transform 0.15s ease, color 0.15s ease',
          }}
        />
      </div>
      <span
        style={{
          marginTop: 4,
          fontSize: 11,
          fontFamily: 'var(--font-body)',
          fontWeight: 500,
          color: 'var(--color-text-secondary)',
        }}
      >
        {label}
      </span>
      {tooltip}
    </div>
  )
}

function NovelPeersTooltip({ peers, visible }: { peers: CouncilOverviewNovelPeer[]; visible: boolean }) {
  if (!visible || peers.length === 0) return null
  return (
    <div
      role="tooltip"
      style={{
        position: 'absolute',
        bottom: '100%',
        left: 0,
        marginBottom: 6,
        background: 'var(--color-bg-card)',
        border: '1px solid var(--border-strong)',
        borderRadius: 8,
        padding: 10,
        fontSize: 12,
        fontFamily: 'var(--font-body)',
        color: 'var(--color-text-body)',
        boxShadow: '0 4px 12px rgba(0,0,0,0.08)',
        zIndex: 30,
        minWidth: 200,
        whiteSpace: 'nowrap',
      }}
    >
      <div
        style={{
          fontSize: 10,
          textTransform: 'uppercase',
          letterSpacing: '0.04em',
          fontWeight: 600,
          color: 'var(--color-text-tertiary)',
          marginBottom: 6,
        }}
      >
        Connected to
      </div>
      {peers.slice(0, 5).map(p => (
        <div
          key={p.peer_agent_id}
          style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '2px 0' }}
        >
          <span style={{ color: 'var(--color-text-primary)' }}>{p.peer_name}</span>
          <span style={{ color: 'var(--color-text-secondary)', fontVariantNumeric: 'tabular-nums' }}>{p.connection_count}</span>
        </div>
      ))}
    </div>
  )
}

interface Props {
  agent: CouncilOverviewAgent
  onClick: () => void
  onFocus: (focus: 'insights' | 'novel' | 'skills' | 'sources' | 'entities') => void
}

export function ExpertCard({ agent, onClick, onFocus }: Props) {
  const [hovered, setHovered] = useState(false)
  const [novelPeerHover, setNovelPeerHover] = useState(false)

  const weekTotal =
    agent.insights_this_week +
    agent.answered_this_week +
    agent.novel_this_week +
    agent.new_skills_this_week

  const sectionLabel: React.CSSProperties = {
    fontSize: 10,
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
    fontWeight: 700,
    color: 'var(--color-text-tertiary)',
    marginBottom: 6,
  }

  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        textAlign: 'left',
        background: 'var(--color-bg-card)',
        border: `1px solid ${hovered ? 'var(--color-accent-500)' : 'var(--border-subtle)'}`,
        borderRadius: 12,
        padding: '16px 18px 14px',
        cursor: 'pointer',
        transition: 'border-color 0.15s ease, transform 0.15s ease',
        transform: hovered ? 'translateY(-1px)' : 'none',
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        width: '100%',
        fontFamily: 'var(--font-body)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span
          style={{
            fontFamily: 'var(--font-display)',
            fontWeight: 700,
            fontSize: 15,
            color: 'var(--color-text-primary)',
            flex: 1,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {agent.name}
        </span>
        <HealthPill status={agent.health_status} />
      </div>

      <div
        style={{
          marginTop: 10,
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          columnGap: 6,
          rowGap: 4,
        }}
      >
        <AggCell
          value={agent.total_insights}
          label="insights"
          onClick={() => onFocus('insights')}
        />
        <AggCell
          value={agent.total_novel}
          label="novel connections"
          onClick={() => onFocus('novel')}
          onHoverChange={setNovelPeerHover}
          tooltip={<NovelPeersTooltip peers={agent.novel_peers} visible={novelPeerHover} />}
        />
        <AggCell
          value={agent.total_skills}
          label="skills"
          onClick={() => onFocus('skills')}
        />
        <AggCell
          value={formatCount(agent.entity_count)}
          label={`entities · ${agent.source_count} sources`}
          onClick={() => onFocus('entities')}
        />
      </div>

      {agent.top_skills.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div style={sectionLabel}>Strongest Areas</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {agent.top_skills.slice(0, 3).map((s, i) => (
              <span
                key={`${s.skill_title}-${i}`}
                style={{
                  fontSize: 11,
                  fontFamily: 'var(--font-body)',
                  fontWeight: 500,
                  color: 'var(--color-text-body)',
                  background: 'var(--color-bg-inset)',
                  border: '1px solid var(--border-subtle)',
                  borderRadius: 20,
                  padding: '2px 8px',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  maxWidth: '100%',
                }}
                title={s.skill_title}
              >
                {s.skill_title}
              </span>
            ))}
          </div>
        </div>
      )}

      <div
        style={{
          marginTop: 'auto',
          paddingTop: 10,
          fontSize: 11,
          color: 'var(--color-text-placeholder)',
          fontVariantNumeric: 'tabular-nums',
          fontFamily: 'var(--font-body)',
        }}
      >
        {weekTotal === 0 ? (
          <span style={{ fontStyle: 'italic' }}>Quiet this week</span>
        ) : (
          <>
            This week: {agent.insights_this_week} ins · {agent.novel_this_week} nov · {agent.answered_this_week} ans · {agent.new_skills_this_week} skills
          </>
        )}
      </div>
    </button>
  )
}
