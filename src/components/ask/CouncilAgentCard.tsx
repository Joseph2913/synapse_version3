import { useState } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import type { CouncilAgentPerspective } from '../../types/rag'

const CONFIDENCE_STYLES: Record<string, { bg: string; text: string }> = {
  high: { bg: 'rgba(5,150,105,0.08)', text: '#059669' },
  medium: { bg: 'rgba(217,119,6,0.08)', text: '#d97706' },
  low: { bg: 'rgba(220,38,38,0.08)', text: '#dc2626' },
}

const COVERAGE_STYLES: Record<string, { dot: string; text: string; label: string }> = {
  strong: { dot: '#059669', text: '#059669', label: 'Strong coverage' },
  adequate: { dot: '#d97706', text: '#d97706', label: 'Adequate coverage' },
  thin: { dot: '#dc2626', text: '#dc2626', label: 'Thin coverage' },
  gap: { dot: '#dc2626', text: '#dc2626', label: 'Knowledge gap' },
}

interface CouncilAgentCardProps {
  perspective: CouncilAgentPerspective & { status: 'loading' | 'complete' | 'error' }
  visible: boolean
  onAgentClick?: (agentId: string) => void
}

export function CouncilAgentCard({ perspective, visible, onAgentClick }: CouncilAgentCardProps) {
  const [expanded, setExpanded] = useState(false)
  const isLoading = perspective.status === 'loading'
  const isError = perspective.status === 'error'
  const coverage = COVERAGE_STYLES[perspective.coverage_assessment] ?? { dot: '#d97706', text: '#d97706', label: 'Adequate' }

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
      <div className="flex items-center" style={{ gap: 10, marginBottom: isLoading ? 12 : 10 }}>
        <div
          style={{
            width: 28, height: 28, borderRadius: 8,
            background: 'var(--color-accent-50)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 14, flexShrink: 0,
          }}
        >
          🧠
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <button
            type="button"
            onClick={() => onAgentClick?.(perspective.agent_id)}
            className="font-display font-bold cursor-pointer"
            style={{
              fontSize: 14, color: 'var(--color-text-primary)',
              background: 'none', border: 'none', padding: 0, textAlign: 'left',
            }}
          >
            {perspective.agent_name}
          </button>
        </div>
        {!isLoading && !isError && (
          <div className="flex items-center" style={{ gap: 4 }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: coverage.dot, flexShrink: 0 }} />
            <span className="font-body font-semibold" style={{ fontSize: 10, color: coverage.text }}>
              {coverage.label}
            </span>
          </div>
        )}
      </div>

      {/* Loading skeleton */}
      {isLoading && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {[100, 85, 92, 60].map((w, i) => (
            <div
              key={i}
              style={{
                height: 12, width: `${w}%`,
                background: 'var(--color-bg-inset)', borderRadius: 4,
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
        <p className="font-body" style={{ fontSize: 12, color: 'var(--color-text-secondary)', lineHeight: 1.6, margin: 0 }}>
          This advisor encountered an error and couldn&apos;t provide a perspective.
        </p>
      )}

      {/* Compact view — key claims only */}
      {!isLoading && !isError && (
        <>
          {/* Key claims list */}
          {perspective.key_claims.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 10 }}>
              {perspective.key_claims.map((claim, i) => {
                const conf = CONFIDENCE_STYLES[claim.confidence] ?? { bg: 'rgba(217,119,6,0.08)', text: '#d97706' }
                return (
                  <div key={i} className="flex items-start" style={{ gap: 8 }}>
                    <span style={{ color: conf.text, fontSize: 10, marginTop: 3, flexShrink: 0 }}>●</span>
                    <span className="font-body" style={{ fontSize: 12, color: 'var(--color-text-body)', flex: 1, lineHeight: 1.5 }}>
                      {claim.claim}
                    </span>
                    <span
                      className="font-body font-semibold shrink-0"
                      style={{
                        fontSize: 9, background: conf.bg, color: conf.text,
                        padding: '2px 7px', borderRadius: 10, marginTop: 2,
                      }}
                    >
                      {claim.confidence}
                    </span>
                  </div>
                )
              })}
            </div>
          )}

          {/* Cross-domain flags (always visible — these are important) */}
          {perspective.cross_domain_flags.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3, marginBottom: 8 }}>
              {perspective.cross_domain_flags.map((flag, i) => (
                <div
                  key={i}
                  className="font-body"
                  style={{
                    fontSize: 11, color: 'var(--color-accent-600)',
                    background: 'var(--color-accent-50)',
                    padding: '5px 10px', borderRadius: 6,
                  }}
                >
                  ↗ {flag}
                </div>
              ))}
            </div>
          )}

          {/* Expand/collapse toggle for full analysis */}
          <button
            type="button"
            onClick={() => setExpanded(prev => !prev)}
            className="flex items-center font-body font-semibold cursor-pointer w-full"
            style={{
              gap: 4, fontSize: 11, color: 'var(--color-text-secondary)',
              background: 'none', border: 'none', padding: '4px 0',
              borderTop: '1px solid var(--border-subtle)',
              marginTop: 4, paddingTop: 10,
            }}
          >
            {expanded ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
            {expanded ? 'Hide full analysis' : 'Show full analysis'}
          </button>

          {/* Expanded: full analysis text + coverage note */}
          {expanded && (
            <div style={{ marginTop: 10 }}>
              <div
                className="font-body"
                style={{
                  fontSize: 13, color: 'var(--color-text-body)',
                  lineHeight: 1.6, whiteSpace: 'pre-wrap', marginBottom: 12,
                }}
              >
                {perspective.analysis}
              </div>

              {perspective.coverage_note && (
                <p className="font-body" style={{ fontSize: 11, color: 'var(--color-text-secondary)', margin: 0 }}>
                  {perspective.coverage_note}
                </p>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}
