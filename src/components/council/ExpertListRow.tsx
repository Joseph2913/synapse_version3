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

export const LIST_GRID_COLUMNS = 'minmax(200px, 1fr) 80px 100px 80px 80px 70px 80px 70px'

interface Props {
  agent: CouncilOverviewAgent
  onClick: () => void
}

export function ExpertListRow({ agent, onClick }: Props) {
  const [hovered, setHovered] = useState(false)
  const [weekHovered, setWeekHovered] = useState(false)

  const weekTotal =
    agent.insights_this_week +
    agent.answered_this_week +
    agent.novel_this_week +
    agent.new_skills_this_week
  const quiet = weekTotal === 0
  const h = HEALTH_CONFIG[agent.health_status] ?? HEALTH_CONFIG.initialising

  const cellStyle: React.CSSProperties = {
    fontSize: 12,
    fontFamily: 'var(--font-body)',
    color: 'var(--color-text-body)',
    fontVariantNumeric: 'tabular-nums',
  }
  const rightCell: React.CSSProperties = { ...cellStyle, textAlign: 'right' }

  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'grid',
        gridTemplateColumns: LIST_GRID_COLUMNS,
        alignItems: 'center',
        gap: 12,
        padding: '10px 24px',
        borderBottom: '1px solid var(--border-subtle)',
        background: hovered ? 'var(--color-bg-subtle)' : 'transparent',
        cursor: 'pointer',
        border: 'none',
        borderRadius: 0,
        width: '100%',
        textAlign: 'left',
        opacity: quiet ? 0.7 : 1,
        transition: 'background 0.15s ease',
      }}
    >
      <span
        style={{
          ...cellStyle,
          fontWeight: 600,
          color: 'var(--color-text-primary)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {agent.name}
      </span>

      <span>
        <span
          style={{
            display: 'inline-flex', alignItems: 'center',
            fontSize: 10, fontWeight: 600, fontFamily: 'var(--font-body)',
            padding: '2px 8px', borderRadius: 20,
            background: h.bg, color: h.text,
          }}
        >
          {h.label}
        </span>
      </span>

      <span
        style={{ position: 'relative', ...cellStyle }}
        onMouseEnter={() => setWeekHovered(true)}
        onMouseLeave={() => setWeekHovered(false)}
      >
        {weekTotal} active
        {weekHovered && !quiet && (
          <div
            role="tooltip"
            style={{
              position: 'absolute',
              top: '100%',
              left: 0,
              marginTop: 4,
              background: 'var(--color-bg-card)',
              border: '1px solid var(--border-strong)',
              borderRadius: 8,
              padding: 10,
              fontSize: 12,
              fontFamily: 'var(--font-body)',
              boxShadow: '0 4px 12px rgba(0,0,0,0.08)',
              zIndex: 30,
              whiteSpace: 'nowrap',
              color: 'var(--color-text-body)',
            }}
          >
            <div>{agent.insights_this_week} insights</div>
            <div>{agent.answered_this_week} answered</div>
            <div>{agent.novel_this_week} novel</div>
            <div>{agent.new_skills_this_week} new skills</div>
          </div>
        )}
      </span>

      <span style={rightCell}>{agent.source_count}</span>
      <span style={rightCell}>{formatCount(agent.entity_count)}</span>
      <span style={rightCell}>{agent.total_skills}</span>
      <span style={rightCell}>{agent.total_insights}</span>
      <span style={rightCell}>{agent.total_novel}</span>
    </button>
  )
}
