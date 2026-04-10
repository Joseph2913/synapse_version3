import type { CouncilQueryState } from '../../types/rag'

interface CouncilRightPanelProps {
  query: string
  state: CouncilQueryState
  onAgentClick?: (agentId: string) => void
}

const COVERAGE_COLORS: Record<string, string> = {
  strong: '#059669',
  adequate: '#d97706',
  thin: '#dc2626',
  gap: '#dc2626',
}

export function CouncilRightPanel({ query, state, onAgentClick }: CouncilRightPanelProps) {
  const { routing, agentPerspectives, synthesis } = state

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Section 1: Query Context */}
      <div>
        <span
          className="font-display font-bold uppercase"
          style={{
            fontSize: 10,
            letterSpacing: '0.08em',
            color: 'var(--color-text-secondary)',
            display: 'block',
            marginBottom: 8,
          }}
        >
          Query
        </span>
        <p
          className="font-body font-medium"
          style={{ fontSize: 13, color: 'var(--color-text-primary)', margin: 0, lineHeight: 1.5 }}
        >
          {query}
        </p>
        {routing && (
          <span
            className="font-body font-semibold"
            style={{
              display: 'inline-block',
              marginTop: 8,
              fontSize: 10,
              padding: '3px 10px',
              borderRadius: 10,
              background: 'var(--color-bg-inset)',
              color: 'var(--color-text-secondary)',
            }}
          >
            {routing.classification === 'single_domain'
              ? 'Single-domain'
              : routing.classification === 'cross_domain'
                ? 'Cross-domain'
                : 'Meta'}
          </span>
        )}
      </div>

      {/* Section 2: Advisors Consulted */}
      {routing && routing.agents_consulted.length > 0 && (
        <div>
          <span
            className="font-display font-bold uppercase"
            style={{
              fontSize: 10,
              letterSpacing: '0.08em',
              color: 'var(--color-text-secondary)',
              display: 'block',
              marginBottom: 8,
            }}
          >
            Advisors Consulted
          </span>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {routing.agents_consulted.map(agent => {
              const perspective = agentPerspectives.find(
                p => p.agent_id === agent.agent_id || p.agent_name === agent.agent_name
              )
              const coverageColor = perspective
                ? COVERAGE_COLORS[perspective.coverage_assessment] ?? 'var(--color-text-secondary)'
                : 'var(--color-text-secondary)'

              return (
                <button
                  key={agent.agent_id}
                  type="button"
                  onClick={() => onAgentClick?.(agent.agent_id)}
                  className="flex items-center font-body text-left cursor-pointer"
                  style={{
                    gap: 8,
                    padding: '8px 10px',
                    background: 'var(--color-bg-inset)',
                    border: '1px solid var(--border-subtle)',
                    borderRadius: 8,
                    transition: 'border-color 0.15s ease',
                  }}
                  onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--border-default)' }}
                  onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border-subtle)' }}
                >
                  <span style={{ fontSize: 14, flexShrink: 0 }}>🧠</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      className="font-semibold"
                      style={{ fontSize: 12, color: 'var(--color-text-primary)' }}
                    >
                      {agent.agent_name}
                    </div>
                    <div style={{ fontSize: 10, color: 'var(--color-text-secondary)' }}>
                      {agent.relevance === 'primary' ? 'Primary' : 'Secondary'}
                      {perspective && (
                        <span style={{ color: coverageColor, marginLeft: 6 }}>
                          • {perspective.coverage_assessment}
                        </span>
                      )}
                    </div>
                  </div>
                </button>
              )
            })}
          </div>
        </div>
      )}

      {/* Section 3: Cross-Domain Connections */}
      {agentPerspectives.some(p => p.cross_domain_flags.length > 0) && (
        <div>
          <span
            className="font-display font-bold uppercase"
            style={{
              fontSize: 10,
              letterSpacing: '0.08em',
              color: 'var(--color-text-secondary)',
              display: 'block',
              marginBottom: 8,
            }}
          >
            Cross-Domain Connections
          </span>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {agentPerspectives
              .filter(p => p.cross_domain_flags.length > 0)
              .flatMap(p =>
                p.cross_domain_flags.map((flag, i) => (
                  <div
                    key={`${p.agent_id}-${i}`}
                    className="font-body"
                    style={{
                      fontSize: 11,
                      color: 'var(--color-accent-600)',
                      background: 'var(--color-accent-50)',
                      padding: '6px 10px',
                      borderRadius: 6,
                    }}
                  >
                    <span className="font-semibold">{p.agent_name}:</span> {flag}
                  </div>
                ))
              )}
          </div>
        </div>
      )}

      {/* Section 4: Blind Spots */}
      {synthesis && synthesis.blind_spots.length > 0 && (
        <div>
          <span
            className="font-display font-bold uppercase"
            style={{
              fontSize: 10,
              letterSpacing: '0.08em',
              color: 'var(--color-text-secondary)',
              display: 'block',
              marginBottom: 8,
            }}
          >
            Knowledge Gaps
          </span>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {synthesis.blind_spots.map((b, i) => (
              <div
                key={i}
                className="font-body"
                style={{
                  fontSize: 11,
                  color: 'var(--color-text-body)',
                  padding: '6px 10px',
                  background: 'rgba(220,38,38,0.03)',
                  border: '1px solid rgba(220,38,38,0.08)',
                  borderRadius: 6,
                }}
              >
                {b.topic}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
