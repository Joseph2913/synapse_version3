import { useEffect, useState } from 'react'
import type { CouncilOverviewAgent } from '../../types/council'
import { ExpertCard } from './ExpertCard'
import { ExpertListRow, LIST_GRID_COLUMNS } from './ExpertListRow'

interface Props {
  agents: CouncilOverviewAgent[]
  viewMode: 'cards' | 'list'
  onOpenAgent: (agentId: string) => void
  onOpenNovel: (agentId: string) => void
  onClearFilters: () => void
  hasAnyAgents: boolean
}

function useColumnCount(): 1 | 2 | 3 {
  const [count, setCount] = useState<1 | 2 | 3>(() => {
    if (typeof window === 'undefined') return 2
    if (window.innerWidth >= 1600) return 3
    if (window.innerWidth >= 1200) return 2
    return 1
  })

  useEffect(() => {
    const handler = () => {
      if (window.innerWidth >= 1600) setCount(3)
      else if (window.innerWidth >= 1200) setCount(2)
      else setCount(1)
    }
    window.addEventListener('resize', handler)
    return () => window.removeEventListener('resize', handler)
  }, [])

  return count
}

export function ExpertGrid({ agents, viewMode, onOpenAgent, onOpenNovel, onClearFilters, hasAnyAgents }: Props) {
  const columns = useColumnCount()

  if (agents.length === 0) {
    if (!hasAnyAgents) {
      return (
        <div style={{ padding: '64px 24px', textAlign: 'center' }}>
          <div style={{ fontSize: 14, color: 'var(--color-text-secondary)', fontFamily: 'var(--font-body)', marginBottom: 12 }}>
            No experts yet.
          </div>
          <div style={{ fontSize: 13, color: 'var(--color-text-primary)', fontFamily: 'var(--font-body)' }}>
            Create your first Council expert.
          </div>
        </div>
      )
    }
    return (
      <div style={{ padding: '64px 24px', textAlign: 'center' }}>
        <div style={{ fontSize: 14, color: 'var(--color-text-secondary)', fontFamily: 'var(--font-body)', marginBottom: 12 }}>
          No experts match these filters.
        </div>
        <button
          type="button"
          onClick={onClearFilters}
          style={{
            padding: '5px 13px',
            borderRadius: 20,
            fontSize: 12,
            fontWeight: 600,
            fontFamily: 'var(--font-body)',
            border: '1px solid rgba(214,58,0,0.15)',
            background: 'var(--color-accent-50)',
            color: 'var(--color-accent-500)',
            cursor: 'pointer',
          }}
        >
          Clear filters
        </button>
      </div>
    )
  }

  if (viewMode === 'cards') {
    return (
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: `repeat(${columns}, 1fr)`,
          gridAutoRows: '1fr',
          gap: 16,
          padding: '16px 24px 40px',
        }}
      >
        {agents.map(a => (
          <ExpertCard
            key={a.id}
            agent={a}
            onClick={() => onOpenAgent(a.id)}
            onNovelClick={() => onOpenNovel(a.id)}
          />
        ))}
      </div>
    )
  }

  return (
    <div>
      <div
        role="row"
        style={{
          display: 'grid',
          gridTemplateColumns: LIST_GRID_COLUMNS,
          alignItems: 'center',
          gap: 12,
          padding: '8px 24px',
          background: 'var(--color-bg-card)',
          borderBottom: '1px solid var(--border-subtle)',
          position: 'sticky',
          top: 0,
          zIndex: 1,
        }}
      >
        {(['Name', 'Health', 'This week', 'Sources', 'Entities', 'Skills', 'Insights', 'Novel'] as const).map((label, i) => (
          <span
            key={label}
            role="columnheader"
            style={{
              fontSize: 10,
              textTransform: 'uppercase',
              letterSpacing: '0.04em',
              fontWeight: 600,
              fontFamily: 'var(--font-body)',
              color: 'var(--color-text-tertiary)',
              textAlign: i >= 3 ? 'right' : 'left',
            }}
          >
            {label}
          </span>
        ))}
      </div>
      {agents.map(a => (
        <ExpertListRow key={a.id} agent={a} onClick={() => onOpenAgent(a.id)} />
      ))}
    </div>
  )
}
