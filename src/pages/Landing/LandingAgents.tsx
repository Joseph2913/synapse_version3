import { useState, useEffect, useRef } from 'react'
import { AGENT_SCENARIOS } from './landing-data'
import type { AgentScenario } from './landing-data'

/* ------------------------------------------------------------------ */
/*  Palette                                                            */
/* ------------------------------------------------------------------ */

const BG = '#0B0A07'
const INK = '#F0EDE6'
const INK2 = 'rgba(240,237,230,0.64)'
const INK3 = 'rgba(240,237,230,0.36)'
const BORDER = 'rgba(240,237,230,0.1)'
const BORDER_STRONG = 'rgba(240,237,230,0.18)'
const CARD_BG = 'rgba(240,237,230,0.03)'

/* ------------------------------------------------------------------ */
/*  AgentCard                                                          */
/* ------------------------------------------------------------------ */

function AgentCard({ scenario, accent, isActive }: {
  scenario: AgentScenario; accent: string; isActive: boolean
}) {
  const [tick, setTick] = useState(0)
  const [citesOpen, setCitesOpen] = useState(false)
  const [hoveredCite, setHoveredCite] = useState<number | null>(null)
  const duration = 4600

  // Only animate when active
  useEffect(() => {
    if (!isActive) { setTick(0); setCitesOpen(false); return }
    const start = performance.now()
    let raf: number
    const loop = (now: number) => {
      const elapsed = (now - start) % duration
      setTick(elapsed)
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [isActive])

  const t = Math.max(0, tick)
  const visibleSteps = scenario.steps.filter(s => t >= s.t)

  const typeColor: Record<string, string> = {
    call: 'rgba(240,237,230,0.5)',
    out: 'rgba(240,237,230,0.78)',
    answer: INK,
  }

  return (
    <div style={{
      borderRadius: 12,
      background: CARD_BG, border: `1px solid ${isActive ? `${accent}66` : BORDER_STRONG}`,
      overflow: 'hidden',
      display: 'flex', flexDirection: 'column',
      boxShadow: isActive
        ? `0 20px 60px -20px rgba(0,0,0,0.6), 0 0 0 1px ${accent}22`
        : '0 10px 30px -15px rgba(0,0,0,0.3)',
      opacity: isActive ? 1 : 0.4,
      transform: isActive ? 'scale(1)' : 'scale(0.97)',
      transition: 'all 500ms cubic-bezier(.4,0,.2,1)',
    }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '14px 16px',
        borderBottom: `1px solid ${BORDER}`,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
          <span style={{
            fontFamily: 'JetBrains Mono, monospace', fontSize: 9,
            letterSpacing: '0.16em', fontWeight: 600,
            padding: '3px 7px', borderRadius: 3,
            color: accent,
            background: `${accent}18`,
            border: `1px solid ${accent}40`,
          }}>{scenario.badge}</span>
          <span style={{ fontSize: 14, fontWeight: 600, color: INK, fontFamily: 'DM Sans', whiteSpace: 'nowrap' }}>
            {scenario.title}
          </span>
        </div>
        <span style={{
          fontFamily: 'JetBrains Mono, monospace', fontSize: 9,
          color: INK3, letterSpacing: '0.14em',
          padding: '2px 6px', borderRadius: 3,
          border: `1px solid ${BORDER}`,
        }}>MCP</span>
      </div>

      {/* Tagline */}
      <div style={{
        padding: '10px 16px 12px',
        borderBottom: `1px solid ${BORDER}`,
        fontSize: 12, color: INK2, fontStyle: 'italic',
        fontFamily: 'Instrument Serif, Georgia, serif',
      }}>{scenario.tagline}</div>

      {/* Prompt */}
      <div style={{
        padding: '16px',
        borderBottom: `1px solid ${BORDER}`,
      }}>
        <div style={{
          fontFamily: 'JetBrains Mono, monospace', fontSize: 9,
          color: INK3, letterSpacing: '0.14em', marginBottom: 6,
        }}>USER</div>
        <div style={{
          fontSize: 14, lineHeight: 1.4, color: INK, fontWeight: 500,
          fontFamily: 'DM Sans',
        }}>{scenario.prompt}</div>
      </div>

      {/* Terminal output */}
      <div style={{
        padding: '14px 16px',
        fontFamily: 'JetBrains Mono, monospace',
        fontSize: 11.5, lineHeight: 1.65,
        minHeight: 200,
        display: 'flex', flexDirection: 'column', gap: 3,
        flex: 1,
      }}>
        {visibleSteps.map((step, i) => {
          const isLast = i === visibleSteps.length - 1
          const age = t - step.t
          const fade = Math.min(1, age / 200)
          return (
            <div key={i} style={{
              color: typeColor[step.kind] ?? INK,
              opacity: fade,
              transform: `translateY(${(1 - fade) * 4}px)`,
              transition: 'opacity 180ms, transform 180ms',
              display: 'flex', gap: 8, alignItems: 'baseline',
            }}>
              <span style={{
                color: step.kind === 'call' ? accent : INK3,
                fontSize: 10,
              }}>
                {step.kind === 'call' ? '\u203A' : step.kind === 'answer' ? '\u2726' : '\u00b7'}
              </span>
              <span style={{ flex: 1 }}>
                {step.line}
                {isLast && step.kind !== 'answer' && (
                  <span style={{
                    display: 'inline-block', width: 6, height: 11, marginLeft: 3,
                    background: accent, verticalAlign: 'baseline',
                    animation: 'lp-cursor-blink 1.2s infinite',
                  }}/>
                )}
              </span>
            </div>
          )
        })}
      </div>

      {/* Footer: cites */}
      <div style={{
        padding: '10px 16px',
        borderTop: `1px solid ${BORDER}`,
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        background: 'rgba(240,237,230,0.02)',
      }}>
        <button
          onClick={() => setCitesOpen(v => !v)}
          style={{
            background: 'transparent', border: 'none', cursor: 'pointer',
            padding: '4px 8px', margin: '-4px -8px', borderRadius: 4,
            display: 'flex', alignItems: 'center', gap: 8,
            fontFamily: 'JetBrains Mono, monospace', fontSize: 10,
            color: citesOpen ? INK : accent, letterSpacing: '0.12em',
          }}
        >
          <span style={{ fontSize: 11 }}>{citesOpen ? '\u25BE' : '\u25B8'}</span>
          <span>{scenario.cites.length} CITES</span>
          <span style={{ color: INK3, letterSpacing: '0.06em', textTransform: 'none' }}>
            {'\u2014'} {citesOpen ? 'hover any to preview' : 'click to open'}
          </span>
        </button>
        <span style={{
          fontFamily: 'JetBrains Mono, monospace', fontSize: 10,
          color: INK3, letterSpacing: '0.1em',
          display: 'flex', alignItems: 'center', gap: 6,
        }}>
          <span style={{
            width: 6, height: 6, borderRadius: '50%',
            background: '#4ADE80', boxShadow: '0 0 6px #4ADE80',
          }}/>
          live
        </span>
      </div>

      {/* Cites drawer */}
      {citesOpen && (
        <div style={{
          borderTop: `1px solid ${BORDER}`,
          padding: '14px 16px 16px',
          background: 'rgba(240,237,230,0.015)',
          animation: 'lp-fade-up 260ms ease',
          display: 'flex', flexDirection: 'column', gap: 6,
          maxHeight: 280, overflow: 'auto',
        }}>
          {scenario.cites.map((c, i) => (
            <div key={i}
              onMouseEnter={() => setHoveredCite(i)}
              onMouseLeave={() => setHoveredCite(null)}
              style={{
                padding: '8px 10px', borderRadius: 6,
                border: `1px solid ${hoveredCite === i ? `${accent}40` : BORDER}`,
                background: hoveredCite === i ? `${accent}08` : 'transparent',
                cursor: 'default', transition: 'all 180ms',
              }}
            >
              <div style={{
                display: 'flex', alignItems: 'center', gap: 8,
                fontFamily: 'JetBrains Mono, monospace', fontSize: 10.5,
              }}>
                <span style={{ color: INK }}>{c.src}</span>
                <span style={{ color: INK3 }}>{c.loc}</span>
              </div>
              {hoveredCite === i && (
                <div style={{
                  marginTop: 8, paddingTop: 8,
                  borderTop: `1px solid ${BORDER}`,
                  fontFamily: 'Instrument Serif, Georgia, serif',
                  fontStyle: 'italic', fontSize: 13, lineHeight: 1.45,
                  color: INK2,
                }}>
                  {c.quote}
                  <span style={{
                    display: 'block', marginTop: 4,
                    fontFamily: 'JetBrains Mono, monospace',
                    fontStyle: 'normal', fontSize: 9.5,
                    color: INK3, letterSpacing: '0.12em',
                  }}>{'\u2014'} {c.who}</span>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Main Section                                                       */
/* ------------------------------------------------------------------ */

interface LandingAgentsProps {
  accent: string
  displayFont: string
  dark: boolean
}

export function LandingAgents({ accent, displayFont }: LandingAgentsProps) {
  const sectionRef = useRef<HTMLDivElement>(null)
  const [activeIdx, setActiveIdx] = useState(0)

  const scenesCount = AGENT_SCENARIOS.length // 3
  const sectionMinHeight = `${scenesCount * 85 + 30}vh` // ~285vh

  useEffect(() => {
    const onScroll = () => {
      const el = sectionRef.current
      if (!el) return
      if (window.matchMedia('(max-width: 768px)').matches) return
      const rect = el.getBoundingClientRect()
      const vh = window.innerHeight
      const scrolled = Math.max(0, -rect.top)
      const maxScroll = Math.max(1, rect.height - vh)
      const p = Math.min(1, scrolled / maxScroll)
      const idx = Math.min(scenesCount - 1, Math.floor(p * scenesCount))
      setActiveIdx(idx)
    }
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onScroll)
    return () => {
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onScroll)
    }
  }, [scenesCount])

  const scrollToScene = (i: number) => {
    const el = sectionRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const sectionTop = window.scrollY + rect.top
    const maxScroll = rect.height - window.innerHeight
    const target = sectionTop + (i / scenesCount) * maxScroll + 2
    window.scrollTo({ top: target, behavior: 'smooth' })
  }

  const activeScenario = AGENT_SCENARIOS[activeIdx] ?? AGENT_SCENARIOS[0]!

  return (
    <section ref={sectionRef} data-screen-label="05 For Agents" className="lp-agents" style={{
      position: 'relative', zIndex: 2,
      background: BG, color: INK,
      marginTop: 60,
      minHeight: sectionMinHeight,
    }}>
      {/* Sticky viewport */}
      <div className="lp-agents-sticky" style={{
        position: 'sticky', top: 0,
        height: '100vh',
        overflow: 'hidden',
        padding: '64px clamp(24px, 5vw, 64px) 56px',
        display: 'flex', flexDirection: 'column',
      }}>
        {/* Grid background */}
        <svg width="100%" height="100%" style={{ position: 'absolute', inset: 0, zIndex: 0, pointerEvents: 'none' }}>
          <defs>
            <pattern id="ag-grid" width="32" height="32" patternUnits="userSpaceOnUse">
              <path d="M 32 0 L 0 0 0 32" fill="none" stroke="rgba(240,237,230,0.05)" strokeWidth="0.5"/>
            </pattern>
            <pattern id="ag-grid-lg" width="128" height="128" patternUnits="userSpaceOnUse">
              <path d="M 128 0 L 0 0 0 128" fill="none" stroke="rgba(240,237,230,0.08)" strokeWidth="0.5"/>
            </pattern>
          </defs>
          <rect width="100%" height="100%" fill="url(#ag-grid)"/>
          <rect width="100%" height="100%" fill="url(#ag-grid-lg)"/>
        </svg>

        {/* Ember glow top-right */}
        <div style={{
          position: 'absolute', inset: 0, zIndex: 0, pointerEvents: 'none',
          background: `radial-gradient(ellipse 40% 50% at 92% 0%, ${accent}22 0%, ${accent}08 40%, transparent 70%)`,
        }}/>

        <div style={{ maxWidth: 1400, width: '100%', margin: '0 auto', position: 'relative', zIndex: 1, flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          {/* Eyebrow */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 18 }}>
            <span style={{
              fontFamily: 'JetBrains Mono, monospace', fontSize: 11,
              color: accent, letterSpacing: '0.16em', textTransform: 'uppercase',
            }}>&mdash; For agents &middot; &sect;04</span>
            <span style={{ flex: 1, height: 1, background: BORDER }}/>
            <span className="lp-hide-mobile" style={{
              fontFamily: 'JetBrains Mono, monospace', fontSize: 10,
              color: INK3, letterSpacing: '0.14em',
            }}>FIG. 04 / MCP &middot; {activeScenario.badge}</span>
          </div>

          {/* Heading */}
          <h2 style={{
            fontFamily: `${displayFont}, sans-serif`, fontWeight: 800,
            fontSize: 'clamp(32px, 3.6vw, 56px)', lineHeight: 1.04,
            letterSpacing: '-0.03em', margin: 0, maxWidth: 880, color: INK,
          }}>
            Your agents read the{' '}
            <em style={{
              fontFamily: 'Instrument Serif, Georgia, serif',
              fontStyle: 'italic', fontWeight: 400, color: accent,
            }}>same graph</em> you do.
          </h2>

          {/* Two-column: left = description + scene pills, right = active card */}
          <div className="lp-agents-grid" style={{
            marginTop: 28, flex: 1, minHeight: 0,
            display: 'grid', gridTemplateColumns: '0.85fr 1.15fr', gap: 48,
            alignItems: 'stretch',
          }}>
            {/* Left column */}
            <div style={{
              display: 'flex', flexDirection: 'column',
              justifyContent: 'center',
              minHeight: 0,
            }}>
              <p style={{
                fontSize: 15, lineHeight: 1.6, color: INK2, maxWidth: 480,
                margin: '0 0 32px',
              }}>
                Any MCP-compatible client speaks to the graph through one endpoint.
                Agents can read cited knowledge, apply skills you&rsquo;ve authored,
                and write back new decisions.
              </p>

              {/* Scene buttons */}
              <div className="lp-agents-scene-list" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {AGENT_SCENARIOS.map((s, i) => {
                  const isActive = i === activeIdx
                  const isPast = i < activeIdx
                  return (
                    <button key={s.k} onClick={() => scrollToScene(i)} style={{
                      display: 'flex', alignItems: 'center', gap: 12,
                      padding: '14px 18px', textAlign: 'left',
                      background: isActive ? 'rgba(240,237,230,0.04)' : 'transparent',
                      border: `1px solid ${isActive ? `${accent}66` : 'transparent'}`,
                      borderLeft: `2px solid ${isActive ? accent : (isPast ? `${accent}40` : BORDER)}`,
                      borderRadius: 0, cursor: 'pointer',
                      color: INK, fontFamily: 'DM Sans, sans-serif',
                      transition: 'all 320ms',
                      opacity: isActive ? 1 : (isPast ? 0.7 : 0.45),
                    }}>
                      <span style={{
                        fontFamily: 'JetBrains Mono, monospace', fontSize: 9,
                        letterSpacing: '0.16em', fontWeight: 600,
                        padding: '3px 7px', borderRadius: 3,
                        color: accent,
                        background: `${accent}18`,
                        border: `1px solid ${accent}40`,
                        flexShrink: 0,
                      }}>{s.badge}</span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{
                          fontFamily: `${displayFont}, sans-serif`, fontWeight: 800,
                          fontSize: 18, letterSpacing: '-0.02em', color: INK,
                          lineHeight: 1.15,
                        }}>{s.title}</div>
                        <div style={{
                          fontSize: 12, color: INK2, marginTop: 2,
                          fontFamily: 'Instrument Serif, Georgia, serif',
                          fontStyle: 'italic',
                        }}>{s.tagline}</div>
                      </div>
                      <div style={{
                        width: 7, height: 7, borderRadius: '50%',
                        background: isActive ? accent : 'rgba(240,237,230,0.14)',
                        boxShadow: isActive ? `0 0 0 4px ${accent}22` : 'none',
                        transition: 'background 260ms, box-shadow 260ms',
                        flexShrink: 0,
                      }}/>
                    </button>
                  )
                })}
              </div>

              {/* Scroll hint */}
              <div className="lp-hide-mobile" style={{
                marginTop: 14, paddingLeft: 20,
                display: 'flex', alignItems: 'center', gap: 8,
                fontFamily: 'JetBrains Mono, monospace', fontSize: 10,
                color: INK3, letterSpacing: '0.14em', textTransform: 'uppercase',
              }}>
                <span style={{ display: 'inline-block', width: 14, height: 1, background: INK3 }}/>
                <span>Scroll to advance</span>
              </div>
            </div>

            {/* Right column: active agent card */}
            <div style={{ minHeight: 0, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
              {AGENT_SCENARIOS.map((s, i) => (
                <div key={s.k} style={{
                  display: i === activeIdx ? 'block' : 'none',
                }}>
                  <AgentCard
                    scenario={s}
                    accent={accent}
                    isActive={i === activeIdx}
                  />
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
