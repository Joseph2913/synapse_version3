import { useMemo } from 'react'
import { AlertTriangle, Play, ChevronLeft } from 'lucide-react'
import { AgentCard } from './AgentCard'
import type { SimulationPersona, PersonaSetDiversity, StanceCategory } from '../../types/simulate'

interface AgentReviewProps {
  personas: SimulationPersona[]
  diversity: PersonaSetDiversity | null
  excludedAgentIds: Set<string>
  onToggleExclude: (agentId: string) => void
  onConfirm: () => void
  onBack: () => void
}

const STANCE_LABELS: Record<StanceCategory, string> = {
  pro: 'Pro',
  anti: 'Anti',
  conditional: 'Conditional',
  uncertain: 'Uncertain',
  orthogonal: 'Orthogonal',
}

const STANCE_COLORS: Record<StanceCategory, string> = {
  pro: '#15803d',
  anti: '#dc2626',
  conditional: '#b45309',
  uncertain: '#6b7280',
  orthogonal: '#6366f1',
}

function diversityLabel(diversity: PersonaSetDiversity): { text: string; color: string } {
  if (diversity.warning === 'single_source') {
    return { text: 'Single-source bias', color: '#d97706' }
  }
  if (diversity.warning === 'low_diversity') {
    return { text: 'Low diversity', color: '#d97706' }
  }
  return { text: 'Strong diversity', color: '#15803d' }
}

function recommendationText(recommendation: PersonaSetDiversity['recommendation']): string {
  switch (recommendation) {
    case 'inject_contrarian':
      return 'Consider adding an external agent with a contrarian position to increase perspective diversity.'
    case 'broaden_scope':
      return 'Most evidence comes from a single source. Consider broadening your scope or adding more source types.'
    case 'proceed':
      return ''
  }
}

export function AgentReview({
  personas,
  diversity,
  excludedAgentIds,
  onToggleExclude,
  onConfirm,
  onBack,
}: AgentReviewProps) {
  // Sort: high → medium → low influence, synthetics at bottom
  const sortedPersonas = useMemo(() => {
    const tierOrder: Record<string, number> = { high: 0, medium: 1, low: 2 }
    return [...personas].sort((a, b) => {
      // Synthetic agents go to bottom
      if (a.is_synthetic !== b.is_synthetic) return a.is_synthetic ? 1 : -1
      return (tierOrder[a.influence_tier] ?? 3) - (tierOrder[b.influence_tier] ?? 3)
    })
  }, [personas])

  const graphPersonas = sortedPersonas.filter(p => !p.is_synthetic)
  const syntheticPersonas = sortedPersonas.filter(p => p.is_synthetic)

  const activeCount = personas.filter(p => !excludedAgentIds.has(p.agent_id)).length
  const totalCount = personas.length
  const noActiveAgents = activeCount === 0

  // Recalculate stance distribution from active agents only
  const activeDistribution = useMemo(() => {
    const dist: Record<StanceCategory, number> = { pro: 0, anti: 0, conditional: 0, uncertain: 0, orthogonal: 0 }
    personas.forEach(p => {
      if (!excludedAgentIds.has(p.agent_id)) {
        dist[p.stance_category] = (dist[p.stance_category] ?? 0) + 1
      }
    })
    return dist
  }, [personas, excludedAgentIds])

  const divLabel = diversity ? diversityLabel(diversity) : null

  return (
    <div className="flex flex-col" style={{ gap: 0 }}>
      {/* Agent cards */}
      <div className="flex flex-col" style={{ gap: 8 }}>
        {/* Graph-derived agents */}
        {graphPersonas.map((persona, i) => (
          <AgentCard
            key={persona.agent_id}
            persona={persona}
            isExcluded={excludedAgentIds.has(persona.agent_id)}
            onToggleExclude={onToggleExclude}
            animationDelay={i * 0.05}
          />
        ))}

        {/* External participants section */}
        {syntheticPersonas.length > 0 && (
          <>
            <div
              className="font-display"
              style={{
                fontSize: 10,
                fontWeight: 700,
                color: 'var(--color-text-secondary)',
                letterSpacing: '0.08em',
                marginTop: 12,
                marginBottom: 4,
              }}
            >
              EXTERNAL PARTICIPANTS
            </div>
            {syntheticPersonas.map((persona, i) => (
              <AgentCard
                key={persona.agent_id}
                persona={persona}
                isExcluded={excludedAgentIds.has(persona.agent_id)}
                onToggleExclude={onToggleExclude}
                animationDelay={(graphPersonas.length + i) * 0.05}
              />
            ))}
          </>
        )}
      </div>

      {/* Sticky review footer */}
      <div
        style={{
          position: 'sticky',
          bottom: 0,
          marginTop: 20,
          padding: '16px 20px',
          background: 'var(--color-bg-card)',
          borderRadius: 12,
          border: '1px solid rgba(0,0,0,0.06)',
          boxShadow: '0 -2px 12px rgba(0,0,0,0.04)',
        }}
      >
        {/* Diversity + stance distribution */}
        <div className="flex items-center gap-3 flex-wrap" style={{ marginBottom: diversity?.warning !== 'none' ? 10 : 12 }}>
          {divLabel && (
            <span
              className="font-body font-semibold"
              style={{ fontSize: 12, color: divLabel.color }}
            >
              {divLabel.text}
            </span>
          )}

          {/* Stance distribution pills */}
          <div className="flex items-center gap-1 flex-wrap">
            {(Object.keys(STANCE_LABELS) as StanceCategory[])
              .filter(cat => activeDistribution[cat] > 0)
              .map(cat => (
                <span
                  key={cat}
                  className="font-body"
                  style={{
                    fontSize: 11,
                    padding: '1px 8px',
                    borderRadius: 10,
                    background: `${STANCE_COLORS[cat]}10`,
                    color: STANCE_COLORS[cat],
                  }}
                >
                  {activeDistribution[cat]} {STANCE_LABELS[cat]}
                </span>
              ))}
          </div>
        </div>

        {/* Warning block */}
        {diversity && diversity.warning !== 'none' && (
          <div
            className="flex items-start gap-2"
            style={{
              padding: '10px 12px',
              borderRadius: 8,
              background: '#fffbeb',
              border: '1px solid #fde68a',
              marginBottom: 12,
            }}
          >
            <AlertTriangle size={14} style={{ color: '#d97706', flexShrink: 0, marginTop: 1 }} />
            <span className="font-body" style={{ fontSize: 12, color: '#92400e' }}>
              {recommendationText(diversity.recommendation)}
            </span>
          </div>
        )}

        {/* Actions row */}
        <div className="flex items-center justify-between">
          <span className="font-body" style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
            {activeCount} of {totalCount} agents active
          </span>

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={onBack}
              className="flex items-center gap-1 cursor-pointer font-body font-semibold"
              style={{
                fontSize: 13,
                padding: '8px 16px',
                borderRadius: 20,
                background: 'transparent',
                border: '1px solid var(--border-subtle)',
                color: 'var(--color-text-secondary)',
              }}
            >
              <ChevronLeft size={14} />
              Back to setup
            </button>

            <button
              type="button"
              onClick={onConfirm}
              disabled={noActiveAgents}
              className="flex items-center gap-2 cursor-pointer font-body font-semibold"
              style={{
                fontSize: 13,
                padding: '8px 20px',
                borderRadius: 20,
                background: noActiveAgents ? 'var(--color-bg-inset)' : 'var(--color-accent-500)',
                border: 'none',
                color: noActiveAgents ? 'var(--color-text-placeholder)' : 'white',
                opacity: noActiveAgents ? 0.6 : 1,
                transition: 'all 0.15s ease',
              }}
            >
              <Play size={14} />
              Run simulation
            </button>
          </div>
        </div>

        {noActiveAgents && (
          <p className="font-body" style={{ fontSize: 11, color: '#dc2626', margin: '6px 0 0 0', textAlign: 'right' }}>
            At least one agent must be active.
          </p>
        )}
      </div>
    </div>
  )
}
