import { useState } from 'react'
import type { CouncilOverviewAgent, CouncilHealthStatus } from '../../types/council'

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

const sectionLabel: React.CSSProperties = {
  fontSize: 10,
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
  fontWeight: 600,
  color: 'var(--color-text-tertiary)',
  marginTop: 14,
  marginBottom: 8,
}

function Stat({ value, label, dim }: { value: number; label: string; dim: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline' }}>
      <span
        style={{
          fontWeight: 700,
          fontSize: 14,
          fontFamily: 'var(--font-body)',
          fontVariantNumeric: 'tabular-nums',
          color: dim ? 'var(--color-text-placeholder)' : 'var(--color-text-primary)',
        }}
      >
        {value}
      </span>
      <span
        style={{
          fontSize: 11,
          fontFamily: 'var(--font-body)',
          color: 'var(--color-text-secondary)',
          marginLeft: 6,
        }}
      >
        {label}
      </span>
    </div>
  )
}

interface Props {
  agent: CouncilOverviewAgent
  onClick: () => void
  onNovelClick: () => void
}

export function ExpertCard({ agent, onClick, onNovelClick }: Props) {
  const [hovered, setHovered] = useState(false)
  const [novelHovered, setNovelHovered] = useState(false)

  const weekTotal =
    agent.insights_this_week +
    agent.answered_this_week +
    agent.novel_this_week +
    agent.new_skills_this_week
  const quiet = weekTotal === 0

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
        padding: '16px 20px',
        cursor: 'pointer',
        transition: 'border-color 0.15s ease, transform 0.15s ease',
        transform: hovered ? 'translateY(-1px)' : 'none',
        display: 'flex',
        flexDirection: 'column',
        opacity: quiet ? 0.6 : 1,
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

      <div style={sectionLabel}>This Week</div>
      {quiet ? (
        <div
          style={{
            fontSize: 12,
            fontStyle: 'italic',
            color: 'var(--color-text-placeholder)',
            textAlign: 'center',
            padding: '8px 0',
          }}
        >
          Quiet this week
        </div>
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: '4px 16px',
          }}
        >
          <Stat value={agent.insights_this_week} label="insights" dim={agent.insights_this_week === 0} />
          <Stat value={agent.novel_this_week} label="novel connections" dim={agent.novel_this_week === 0} />
          <Stat value={agent.answered_this_week} label="answered" dim={agent.answered_this_week === 0} />
          <Stat value={agent.new_skills_this_week} label="new skills" dim={agent.new_skills_this_week === 0} />
        </div>
      )}

      <div style={sectionLabel}>Totals</div>
      <div
        style={{
          fontSize: 12,
          color: 'var(--color-text-secondary)',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {agent.source_count} sources · {formatCount(agent.entity_count)} entities
      </div>
      <div
        style={{
          fontSize: 12,
          color: 'var(--color-text-secondary)',
          fontVariantNumeric: 'tabular-nums',
          marginTop: 2,
          position: 'relative',
        }}
      >
        <span
          role="button"
          tabIndex={0}
          onClick={e => { e.stopPropagation(); onNovelClick() }}
          onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); onNovelClick() } }}
          onMouseEnter={() => setNovelHovered(true)}
          onMouseLeave={() => setNovelHovered(false)}
          onFocus={() => setNovelHovered(true)}
          onBlur={() => setNovelHovered(false)}
          style={{
            cursor: 'pointer',
            textDecoration: novelHovered ? 'underline' : 'none',
            color: 'var(--color-text-secondary)',
          }}
        >
          <strong style={{ fontWeight: 700, color: 'var(--color-text-primary)' }}>{agent.total_novel}</strong> novel total
        </span>
        <span> · </span>
        <strong style={{ fontWeight: 700, color: 'var(--color-text-primary)' }}>{agent.total_skills}</strong> skills

        {novelHovered && agent.novel_peers.length > 0 && (
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
            {agent.novel_peers.slice(0, 5).map(p => (
              <div
                key={p.peer_agent_id}
                style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '2px 0' }}
              >
                <span style={{ color: 'var(--color-text-primary)' }}>{p.peer_name}</span>
                <span style={{ color: 'var(--color-text-secondary)', fontVariantNumeric: 'tabular-nums' }}>{p.connection_count}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </button>
  )
}
