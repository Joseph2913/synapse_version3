import type { CouncilRouting } from '../../types/rag'

interface CouncilRoutingCardProps {
  routing: CouncilRouting
  visible: boolean
}

export function CouncilRoutingCard({ routing, visible }: CouncilRoutingCardProps) {
  const classificationLabel = {
    single_domain: 'Single-domain',
    cross_domain: 'Cross-domain',
    meta: 'Meta',
  }[routing.classification] ?? routing.classification

  return (
    <div
      style={{
        opacity: visible ? 1 : 0,
        transform: visible ? 'translateY(0)' : 'translateY(8px)',
        transition: 'opacity 0.4s ease, transform 0.4s ease',
        background: 'var(--color-bg-card)',
        border: '1px solid var(--border-subtle)',
        borderLeft: '2px solid rgba(214,58,0,0.1)',
        borderRadius: 12,
        padding: '16px 22px',
      }}
    >
      {/* Header */}
      <div className="flex items-center" style={{ gap: 6, marginBottom: 12 }}>
        <span style={{ color: 'var(--color-accent-500)', fontSize: 12 }}>✦</span>
        <span
          className="font-body font-semibold"
          style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}
        >
          Routing
        </span>
      </div>

      {/* Classification */}
      <div className="flex items-center" style={{ gap: 6, marginBottom: 14 }}>
        <span
          className="font-body"
          style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}
        >
          Classification:
        </span>
        <span
          className="font-body font-semibold"
          style={{ fontSize: 12, color: 'var(--color-text-primary)' }}
        >
          {classificationLabel}
        </span>
      </div>

      {/* Meta answer — shown inline */}
      {routing.classification === 'meta' && (
        <p
          className="font-body"
          style={{
            fontSize: 12,
            color: 'var(--color-text-body)',
            lineHeight: 1.6,
            fontStyle: 'italic',
          }}
        >
          Answering directly from the master index.
        </p>
      )}

      {/* Agent pills */}
      {routing.agents_consulted.length > 0 && (
        <div className="flex flex-wrap" style={{ gap: 8, marginBottom: 14 }}>
          {routing.agents_consulted.map(agent => (
            <div
              key={agent.agent_id}
              style={{
                background: 'var(--color-bg-inset)',
                borderRadius: 8,
                padding: 12,
                display: 'flex',
                flexDirection: 'column',
                gap: 4,
                minWidth: 120,
              }}
            >
              <span
                className="font-body font-semibold"
                style={{ fontSize: 12, color: 'var(--color-text-primary)' }}
              >
                {agent.agent_name}
              </span>
              <span
                className="font-body"
                style={{ fontSize: 10, color: 'var(--color-text-secondary)' }}
              >
                {agent.relevance === 'primary' ? 'Primary' : 'Secondary'}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Routing rationale */}
      <p
        className="font-body"
        style={{
          fontSize: 12,
          color: 'var(--color-text-body)',
          lineHeight: 1.5,
          fontStyle: 'italic',
          margin: 0,
        }}
      >
        &ldquo;{routing.routing_rationale}&rdquo;
      </p>
    </div>
  )
}
