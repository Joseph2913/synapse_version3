import type { CouncilAgentPerspective } from '../../types/rag'

const CONFIDENCE_STYLES: Record<string, { bg: string; text: string }> = {
  high: { bg: 'rgba(5,150,105,0.08)', text: '#059669' },
  medium: { bg: 'rgba(217,119,6,0.08)', text: '#d97706' },
  low: { bg: 'rgba(220,38,38,0.08)', text: '#dc2626' },
}

const COVERAGE_STYLES: Record<string, { dot: string; text: string }> = {
  strong: { dot: '#059669', text: '#059669' },
  adequate: { dot: '#d97706', text: '#d97706' },
  thin: { dot: '#dc2626', text: '#dc2626' },
  gap: { dot: '#dc2626', text: '#dc2626' },
}

interface CouncilAgentCardProps {
  perspective: CouncilAgentPerspective & { status: 'loading' | 'complete' | 'error' }
  visible: boolean
  onAgentClick?: (agentId: string) => void
}

export function CouncilAgentCard({ perspective, visible, onAgentClick }: CouncilAgentCardProps) {
  const isLoading = perspective.status === 'loading'
  const isError = perspective.status === 'error'
  const coverage = COVERAGE_STYLES[perspective.coverage_assessment] ?? { dot: '#d97706', text: '#d97706' }

  return (
    <div
      style={{
        opacity: visible ? 1 : 0,
        transform: visible ? 'translateY(0)' : 'translateY(8px)',
        transition: 'opacity 0.4s ease, transform 0.4s ease',
        background: 'var(--color-bg-card)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 12,
        padding: '16px 22px',
        minWidth: 0,
      }}
    >
      {/* Header */}
      <div className="flex items-center" style={{ gap: 10, marginBottom: 12 }}>
        <div
          style={{
            width: 28,
            height: 28,
            borderRadius: 8,
            background: 'var(--color-accent-50)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 14,
            flexShrink: 0,
          }}
        >
          🧠
        </div>
        <div style={{ minWidth: 0 }}>
          <button
            type="button"
            onClick={() => onAgentClick?.(perspective.agent_id)}
            className="font-display font-bold cursor-pointer"
            style={{
              fontSize: 14,
              color: 'var(--color-text-primary)',
              background: 'none',
              border: 'none',
              padding: 0,
              textAlign: 'left',
            }}
          >
            {perspective.agent_name}
          </button>
          <div
            className="font-body"
            style={{ fontSize: 11, color: 'var(--color-text-secondary)', fontStyle: 'italic' }}
          >
            {perspective.reasoning_style}
          </div>
        </div>
      </div>

      {/* Loading skeleton */}
      {isLoading && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {[100, 85, 92, 60].map((w, i) => (
            <div
              key={i}
              style={{
                height: 12,
                width: `${w}%`,
                background: 'var(--color-bg-inset)',
                borderRadius: 4,
                animation: 'councilPulse 1.5s ease-in-out infinite',
                animationDelay: `${i * 0.15}s`,
              }}
            />
          ))}
          <style>{`
            @keyframes councilPulse {
              0%, 100% { opacity: 0.4; }
              50% { opacity: 0.8; }
            }
          `}</style>
        </div>
      )}

      {/* Error state */}
      {isError && (
        <p
          className="font-body"
          style={{ fontSize: 12, color: 'var(--color-text-secondary)', lineHeight: 1.6 }}
        >
          This advisor encountered an error and couldn&apos;t provide a perspective.
          The synthesis will work with available responses.
        </p>
      )}

      {/* Analysis content */}
      {!isLoading && !isError && (
        <>
          {/* Analysis text */}
          <div
            className="font-body"
            style={{
              fontSize: 13,
              color: 'var(--color-text-body)',
              lineHeight: 1.6,
              marginBottom: 16,
              whiteSpace: 'pre-wrap',
            }}
          >
            {perspective.analysis}
          </div>

          {/* Key claims */}
          {perspective.key_claims.length > 0 && (
            <>
              <div
                style={{
                  borderTop: '1px solid var(--border-subtle)',
                  paddingTop: 12,
                  marginBottom: 8,
                }}
              >
                <span
                  className="font-display font-bold uppercase"
                  style={{
                    fontSize: 10,
                    letterSpacing: '0.08em',
                    color: 'var(--color-text-secondary)',
                  }}
                >
                  Key Claims
                </span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 14 }}>
                {perspective.key_claims.map((claim, i) => {
                  const conf = CONFIDENCE_STYLES[claim.confidence] ?? { bg: 'rgba(217,119,6,0.08)', text: '#d97706' }
                  return (
                    <div key={i} className="flex items-start" style={{ gap: 8 }}>
                      <span className="font-body" style={{ fontSize: 12, color: 'var(--color-text-body)', flex: 1 }}>
                        {claim.claim}
                      </span>
                      <span
                        className="font-body font-semibold shrink-0"
                        style={{
                          fontSize: 10,
                          background: conf.bg,
                          color: conf.text,
                          padding: '2px 8px',
                          borderRadius: 10,
                        }}
                      >
                        {claim.confidence}
                      </span>
                    </div>
                  )
                })}
              </div>
            </>
          )}

          {/* Coverage assessment */}
          <div className="flex items-center" style={{ gap: 6, marginBottom: 4 }}>
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: coverage.dot,
                flexShrink: 0,
              }}
            />
            <span
              className="font-body font-semibold"
              style={{ fontSize: 11, color: coverage.text }}
            >
              {perspective.coverage_assessment.charAt(0).toUpperCase() + perspective.coverage_assessment.slice(1)} coverage
            </span>
          </div>
          {perspective.coverage_note && (
            <p
              className="font-body"
              style={{ fontSize: 11, color: 'var(--color-text-secondary)', margin: '0 0 8px 12px' }}
            >
              {perspective.coverage_note}
            </p>
          )}

          {/* Cross-domain flags */}
          {perspective.cross_domain_flags.length > 0 && (
            <div style={{ marginTop: 8 }}>
              {perspective.cross_domain_flags.map((flag, i) => (
                <div
                  key={i}
                  className="font-body"
                  style={{
                    fontSize: 11,
                    color: 'var(--color-accent-600)',
                    background: 'var(--color-accent-50)',
                    padding: '6px 10px',
                    borderRadius: 6,
                    marginBottom: 4,
                  }}
                >
                  ↗ {flag}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}
