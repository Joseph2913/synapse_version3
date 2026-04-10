import { useState } from 'react'
import { Copy, Check } from 'lucide-react'
import type { CouncilSynthesis } from '../../types/rag'

interface CouncilSynthesisCardProps {
  synthesis: CouncilSynthesis & { status: 'waiting' | 'complete' }
  visible: boolean
  onFollowUpClick?: (question: string) => void
}

export function CouncilSynthesisCard({ synthesis, visible, onFollowUpClick }: CouncilSynthesisCardProps) {
  const [copied, setCopied] = useState(false)
  const isWaiting = synthesis.status === 'waiting'

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(synthesis.answer)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch { /* ignore */ }
  }

  return (
    <div
      style={{
        opacity: visible ? 1 : 0,
        transform: visible ? 'translateY(0)' : 'translateY(8px)',
        transition: 'opacity 0.4s ease, transform 0.4s ease',
        background: 'var(--color-bg-card)',
        border: '1px solid var(--border-subtle)',
        borderLeft: '3px solid var(--color-accent-500)',
        borderRadius: '0 12px 12px 0',
        padding: '16px 22px',
      }}
    >
      {/* Header */}
      <div className="flex items-center justify-between" style={{ marginBottom: 14 }}>
        <div className="flex items-center" style={{ gap: 6 }}>
          <span style={{ color: 'var(--color-accent-500)', fontSize: 13 }}>✦</span>
          <span
            className="font-display font-bold"
            style={{ fontSize: 14, color: 'var(--color-text-primary)' }}
          >
            Synthesis
          </span>
        </div>
        {!isWaiting && (
          <button
            type="button"
            onClick={handleCopy}
            className="flex items-center font-body cursor-pointer"
            style={{
              gap: 4,
              fontSize: 11,
              color: copied ? '#059669' : 'var(--color-text-secondary)',
              background: 'none',
              border: 'none',
              padding: '4px 8px',
              borderRadius: 6,
              transition: 'color 0.15s ease',
            }}
          >
            {copied ? <Check size={11} /> : <Copy size={11} />}
            {copied ? 'Copied' : 'Copy synthesis'}
          </button>
        )}
      </div>

      {/* Waiting skeleton */}
      {isWaiting && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '8px 0' }}>
          {[100, 95, 88, 76, 92, 50].map((w, i) => (
            <div
              key={i}
              style={{
                height: 12,
                width: `${w}%`,
                background: 'var(--color-bg-inset)',
                borderRadius: 4,
                animation: 'councilPulse 1.5s ease-in-out infinite',
                animationDelay: `${i * 0.12}s`,
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

      {/* Synthesis content */}
      {!isWaiting && (
        <>
          {/* Main synthesis text */}
          <div
            className="font-body"
            style={{
              fontSize: 13,
              color: 'var(--color-text-body)',
              lineHeight: 1.6,
              whiteSpace: 'pre-wrap',
              marginBottom: 16,
            }}
          >
            {synthesis.answer}
          </div>

          {/* Structured sections */}
          <div style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: 14 }}>
            {/* Agreements */}
            {synthesis.agreements.length > 0 && (
              <div style={{ marginBottom: 16 }}>
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
                  Where Advisors Agree
                </span>
                {synthesis.agreements.map((a, i) => (
                  <div key={i} className="font-body" style={{ fontSize: 12, color: 'var(--color-text-body)', marginBottom: 4 }}>
                    <span style={{ marginRight: 4 }}>•</span>
                    {a.point}
                    <span className="font-semibold" style={{ color: 'var(--color-text-secondary)' }}>
                      {' '}({a.supporting_agents.join(' + ')})
                    </span>
                  </div>
                ))}
              </div>
            )}

            {/* Tensions */}
            {synthesis.tensions.length > 0 && (
              <div style={{ marginBottom: 16 }}>
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
                  Where Advisors Diverge
                </span>
                {synthesis.tensions.map((t, i) => (
                  <div key={i} className="font-body" style={{ fontSize: 12, color: 'var(--color-text-body)', marginBottom: 6 }}>
                    <span style={{ marginRight: 4 }}>⚡</span>
                    {t.nature}
                    <span className="font-semibold" style={{ color: 'var(--color-text-secondary)' }}>
                      {' '}({t.agents_involved.join(' vs ')})
                    </span>
                  </div>
                ))}
              </div>
            )}

            {/* Emergent insight */}
            {synthesis.emergent_insight && (
              <div style={{ marginBottom: 16 }}>
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
                  Emergent Insight
                </span>
                <div className="font-body" style={{ fontSize: 12, color: 'var(--color-text-body)' }}>
                  {synthesis.emergent_insight}
                </div>
              </div>
            )}

            {/* Blind spots */}
            {synthesis.blind_spots.length > 0 && (
              <div style={{ marginBottom: 16 }}>
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
                  What Neither Could Address
                </span>
                {synthesis.blind_spots.map((b, i) => (
                  <div key={i} className="font-body" style={{ fontSize: 12, color: 'var(--color-text-body)', marginBottom: 4 }}>
                    <span style={{ marginRight: 4 }}>•</span>
                    {b.topic}
                    {b.relevant_gaps.length > 0 && (
                      <span style={{ color: 'var(--color-text-secondary)' }}>
                        {' '}(gaps in {b.relevant_gaps.join(', ')})
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* Follow-up suggestions */}
            {synthesis.follow_up_suggestions.length > 0 && (
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
                  Explore Further
                </span>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {synthesis.follow_up_suggestions.map((q, i) => (
                    <button
                      key={i}
                      type="button"
                      onClick={() => onFollowUpClick?.(q)}
                      className="flex items-center justify-between font-body text-left cursor-pointer"
                      style={{
                        fontSize: 12,
                        color: 'var(--color-text-body)',
                        background: 'var(--color-bg-inset)',
                        border: '1px solid var(--border-subtle)',
                        borderRadius: 8,
                        padding: '10px 14px',
                        transition: 'border-color 0.15s ease, transform 0.15s ease',
                      }}
                      onMouseEnter={e => {
                        e.currentTarget.style.borderColor = 'var(--border-default)'
                        e.currentTarget.style.transform = 'translateY(-1px)'
                      }}
                      onMouseLeave={e => {
                        e.currentTarget.style.borderColor = 'var(--border-subtle)'
                        e.currentTarget.style.transform = 'translateY(0)'
                      }}
                    >
                      <span style={{ flex: 1 }}>&ldquo;{q}&rdquo;</span>
                      <span style={{ color: 'var(--color-text-secondary)', marginLeft: 8, flexShrink: 0 }}>→</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}
