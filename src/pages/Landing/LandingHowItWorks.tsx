import { useEffect, useRef, useState } from 'react'
import { ENTITY_COLOR, PIPELINE_STEPS } from './landing-data'
import type { PipelineStep } from './landing-data'

/* ------------------------------------------------------------------ */
/*  Graph data                                                         */
/* ------------------------------------------------------------------ */

const W = 640, H = 520

// 3 sources for ingest (reduced from 5 to avoid crowding)
interface SourceDef {
  label: string; kind: string; color: string
  // Start position (off-screen or edge) and landing position
  startX: number; startY: number
  landX: number; landY: number
}

const SOURCES: SourceDef[] = [
  { label: 'Meeting', kind: 'meeting', color: '#d63a00', startX: -0.08, startY: 0.45, landX: 0.22, landY: 0.45 },
  { label: 'Document', kind: 'document', color: '#2563eb', startX: 0.50, startY: -0.08, landX: 0.50, landY: 0.42 },
  { label: 'Video', kind: 'video', color: '#7c3aed', startX: 1.08, startY: 0.45, landX: 0.78, landY: 0.45 },
]

// Entities that burst from sources in extract phase
// Centered around the middle of the canvas (y: 0.25-0.72)
interface EntityDef {
  x: number; y: number; type: string; label: string; fromSource: number
}

const ENTITIES: EntityDef[] = [
  // From Meeting (0)
  { x: 0.14, y: 0.32, type: 'person',   label: 'Sarah K.',   fromSource: 0 },
  { x: 0.22, y: 0.60, type: 'decision', label: 'Ship v3',    fromSource: 0 },
  { x: 0.10, y: 0.66, type: 'risk',     label: 'Latency',    fromSource: 0 },
  // From Document (1)
  { x: 0.44, y: 0.26, type: 'anchor',   label: 'GTM',        fromSource: 1 },
  { x: 0.56, y: 0.56, type: 'project',  label: 'InfoCert',   fromSource: 1 },
  { x: 0.38, y: 0.52, type: 'topic',    label: 'Pricing',    fromSource: 1 },
  // From Video (2)
  { x: 0.76, y: 0.30, type: 'person',   label: 'Ben R.',     fromSource: 2 },
  { x: 0.86, y: 0.58, type: 'insight',  label: 'Retention',  fromSource: 2 },
  { x: 0.66, y: 0.64, type: 'concept',  label: 'TAM',        fromSource: 2 },
]

// Edges (connect phase) - within and across sources
const EDGES: [number, number][] = [
  // Within source 0
  [0, 1], [1, 2],
  // Within source 1
  [3, 4], [3, 5],
  // Within source 2
  [6, 7], [7, 8],
  // Cross-source
  [0, 3], [1, 4], [1, 3], [5, 8], [4, 8], [2, 5], [6, 3],
]

// GTM (index 3) becomes the promoted anchor
const ANCHOR_IDX = 3

/* ------------------------------------------------------------------ */
/*  Source icon                                                        */
/* ------------------------------------------------------------------ */

function SourceIcon({ kind, color, size }: { kind: string; color: string; size: number }) {
  const r = size / 2
  const iconScale = size * 0.38
  return (
    <g>
      {/* Dashed circle */}
      <circle r={r} fill="none" stroke={color} strokeWidth={1.2}
        strokeDasharray="4 3" opacity={0.5}/>
      {/* Filled inner circle */}
      <circle r={r * 0.65} fill={`${color}15`} stroke={color} strokeWidth={0.8}/>
      {/* Icon */}
      {kind === 'meeting' && (
        <g transform={`translate(${-iconScale/2},${-iconScale/2})`}>
          {[0.2, 0.4, 0.6, 0.8].map((f, i) => {
            const h = [0.25, 0.55, 0.7, 0.35][i]!
            return <line key={i} x1={f * iconScale} y1={iconScale * (0.5 - h/2)}
              x2={f * iconScale} y2={iconScale * (0.5 + h/2)}
              stroke={color} strokeWidth={1.5} strokeLinecap="round"/>
          })}
        </g>
      )}
      {kind === 'document' && (
        <g transform={`translate(${-iconScale * 0.35},${-iconScale * 0.45})`}>
          <path d={`M0 0 h${iconScale * 0.45} l${iconScale * 0.25} ${iconScale * 0.25} v${iconScale * 0.65} h-${iconScale * 0.7} Z`}
            fill="none" stroke={color} strokeWidth={1.2} strokeLinejoin="round"/>
          <line x1={iconScale * 0.12} y1={iconScale * 0.55} x2={iconScale * 0.55} y2={iconScale * 0.55}
            stroke={color} strokeWidth={0.8} opacity={0.5}/>
          <line x1={iconScale * 0.12} y1={iconScale * 0.7} x2={iconScale * 0.42} y2={iconScale * 0.7}
            stroke={color} strokeWidth={0.8} opacity={0.5}/>
        </g>
      )}
      {kind === 'video' && (
        <g transform={`translate(${-iconScale * 0.3},${-iconScale * 0.35})`}>
          <path d={`M0 0 L${iconScale * 0.6} ${iconScale * 0.35} L0 ${iconScale * 0.7} Z`}
            fill={color} opacity={0.6}/>
        </g>
      )}
    </g>
  )
}

/* ------------------------------------------------------------------ */
/*  PipelineGraph                                                      */
/* ------------------------------------------------------------------ */

function PipelineGraph({ active, accent, ink, ink2, ink3, border, activeStep }: {
  active: string; accent: string; ink: string; ink2: string; ink3: string
  border: string; activeStep: PipelineStep
}) {
  const [tick, setTick] = useState(0)

  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 40)
    return () => clearInterval(id)
  }, [])

  const isIngest = active === 'ingest'
  const isExtract = active === 'extract'
  const isConnect = active === 'connect'
  const isAnchor = active === 'anchor'
  const isQuery = active === 'query'

  const showEntities = isExtract || isConnect || isAnchor || isQuery
  const showEdges = isConnect || isAnchor || isQuery
  const showAnchorPromo = isAnchor || isQuery

  // Smooth interpolation for source positions (animate in from edges)
  // Sources land at their position after ~1s, then stay
  const sourceT = Math.min(1, tick / 25) // 0->1 over ~1s
  const easeOut = (t: number) => 1 - Math.pow(1 - t, 3)
  const sT = easeOut(sourceT)

  // Query pulse
  const queryPhase = isQuery ? (tick % 80) / 80 : 0

  return (
    <div style={{
      flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column',
      borderRadius: 12, border: `1px solid ${border}`,
      background: 'rgba(240,237,230,0.03)', overflow: 'hidden',
    }}>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ flex: 1, display: 'block', width: '100%' }}>
        <defs>
          <pattern id="pg-g" width="24" height="24" patternUnits="userSpaceOnUse">
            <path d="M 24 0 L 0 0 0 24" fill="none" stroke="rgba(240,237,230,0.04)" strokeWidth="0.5"/>
          </pattern>
          <radialGradient id="pg-promo-glow">
            <stop offset="0%" stopColor={accent} stopOpacity="0.30"/>
            <stop offset="100%" stopColor={accent} stopOpacity="0"/>
          </radialGradient>
        </defs>
        <rect width={W} height={H} fill="url(#pg-g)"/>

        {/* ── INGEST: Sources slide in from edges ── */}
        {SOURCES.map((src, i) => {
          // In ingest: animate from start to land. After ingest: stay at land but shrink.
          const x = isIngest
            ? (src.startX + (src.landX - src.startX) * sT) * W
            : src.landX * W
          const y = isIngest
            ? (src.startY + (src.landY - src.startY) * sT) * W * (H / W)
            : src.landY * H
          const scale = isIngest ? 1 : (isExtract ? 0.65 : 0.5)
          const opacity = isIngest ? sT : (isExtract ? 0.6 : 0.35)

          return (
            <g key={`src-${i}`}
              transform={`translate(${x}, ${y})`}
              opacity={opacity}
              style={{ transition: isIngest ? undefined : 'opacity 500ms, transform 500ms' }}>
              <g transform={`scale(${scale})`}
                style={{ transition: isIngest ? undefined : 'transform 500ms' }}>
                <SourceIcon kind={src.kind} color={src.color} size={48}/>
              </g>
              {/* Label only during ingest */}
              {isIngest && sT > 0.5 && (
                <text y={34} textAnchor="middle" fill={ink2}
                  fontSize={10} fontFamily="DM Sans, sans-serif" fontWeight={500}
                  opacity={Math.min(1, (sT - 0.5) * 4)}
                  style={{ pointerEvents: 'none', userSelect: 'none' }}>
                  {src.label}
                </text>
              )}
              {/* Type label */}
              {isIngest && sT > 0.7 && (
                <text y={45} textAnchor="middle" fill={ink3}
                  fontSize={7.5} fontFamily="JetBrains Mono, monospace" letterSpacing="0.08em"
                  opacity={Math.min(1, (sT - 0.7) * 5)}
                  style={{ pointerEvents: 'none', userSelect: 'none' }}>
                  {src.kind.toUpperCase()}
                </text>
              )}
            </g>
          )
        })}

        {/* ── EXTRACT: Entities burst out from source positions ── */}
        {showEntities && ENTITIES.map((ent, i) => {
          const ex = ent.x * W, ey = ent.y * H
          const c = ENTITY_COLOR[ent.type] || ink3
          const isAnchorNode = i === ANCHOR_IDX
          const r = isAnchorNode && showAnchorPromo ? 16 : 8

          // In extract phase, show burst lines from source to entity
          const src = SOURCES[ent.fromSource]!

          return (
            <g key={`ent-${i}`}>
              {/* Burst line from source (extract only) */}
              {isExtract && (
                <line x1={src.landX * W} y1={src.landY * H} x2={ex} y2={ey}
                  stroke={`${c}22`} strokeWidth={0.6} strokeDasharray="3 3"/>
              )}

              {/* Entity node */}
              {isAnchorNode && showAnchorPromo ? (
                // ── Promoted anchor ──
                <g style={{ animation: isAnchor ? 'lp-fade-up 500ms ease both' : undefined }}>
                  <circle cx={ex} cy={ey} r={32} fill="url(#pg-promo-glow)"/>
                  <circle cx={ex} cy={ey} r={22} fill="none" stroke={accent} strokeWidth={1}
                    strokeDasharray="5 3" opacity={0.4}
                    style={{ animation: 'lp-glow-breathe 2.5s ease-in-out infinite' }}/>
                  <circle cx={ex} cy={ey} r={r} fill={`${accent}25`} stroke={accent} strokeWidth={2}/>
                  {/* Anchor icon */}
                  <circle cx={ex} cy={ey - 4.5} r={2.5} fill="none" stroke="#fff" strokeWidth={1.2}/>
                  <line x1={ex} y1={ey - 2} x2={ex} y2={ey + 7} stroke="#fff" strokeWidth={1.2}/>
                  <path d={`M${ex - 5} ${ey + 3} a5 5 0 0 0 10 0`} fill="none" stroke="#fff" strokeWidth={1}/>
                  {/* Label */}
                  <text x={ex} y={ey + r + 14} textAnchor="middle" fill={accent}
                    fontSize={10.5} fontFamily="DM Sans, sans-serif" fontWeight={700}
                    style={{ pointerEvents: 'none', userSelect: 'none' }}>
                    {ent.label}
                  </text>
                  <text x={ex} y={ey + r + 25} textAnchor="middle" fill={ink3}
                    fontSize={7.5} fontFamily="JetBrains Mono, monospace" letterSpacing="0.1em"
                    style={{ pointerEvents: 'none', userSelect: 'none' }}>
                    ANCHOR
                  </text>
                </g>
              ) : (
                // ── Normal entity ──
                <g style={{
                  animation: isExtract ? `lp-fade-up 400ms ease ${i * 50}ms both` : undefined,
                }}>
                  <circle cx={ex} cy={ey} r={r + 2.5} fill={c} opacity={0.12}/>
                  <circle cx={ex} cy={ey} r={r} fill="rgba(11,10,7,0.85)" stroke={c} strokeWidth={1.5}/>
                  <circle cx={ex} cy={ey} r={2.2} fill={c} opacity={0.5}/>
                  <text x={ex} y={ey + r + 12} textAnchor="middle" fill={ink3}
                    fontSize={8.5} fontFamily="DM Sans, sans-serif" fontWeight={500}
                    style={{ pointerEvents: 'none', userSelect: 'none' }}>
                    {ent.label}
                  </text>
                </g>
              )}
            </g>
          )
        })}

        {/* ── CONNECT+: Edges between entities ── */}
        {showEdges && EDGES.map(([a, b], ei) => {
          const ea = ENTITIES[a]!, eb = ENTITIES[b]!
          const ax = ea.x * W, ay = ea.y * H
          const bx = eb.x * W, by = eb.y * H
          const len = Math.hypot(bx - ax, by - ay)

          // Cross-source edges are slightly more prominent
          const isCross = ea.fromSource !== eb.fromSource
          const baseColor = isCross ? 'rgba(240,237,230,0.22)' : 'rgba(240,237,230,0.12)'

          if (isQuery) {
            // Query: pulse dots traveling along edges
            const offset = ((queryPhase + ei * 0.06) % 1)
            const dotX = ax + (bx - ax) * offset
            const dotY = ay + (by - ay) * offset
            return (
              <g key={`e-${ei}`}>
                <line x1={ax} y1={ay} x2={bx} y2={by}
                  stroke={`${accent}35`} strokeWidth={1}/>
                <circle cx={dotX} cy={dotY} r={2} fill={accent} opacity={0.85}/>
              </g>
            )
          }

          return (
            <line key={`e-${ei}`}
              x1={ax} y1={ay} x2={bx} y2={by}
              stroke={baseColor} strokeWidth={isCross ? 0.9 : 0.6}
              strokeDasharray={len} strokeDashoffset={0}
              style={{
                animation: isConnect ? `lp-fade-up 500ms ease ${ei * 30}ms both` : undefined,
              }}
            />
          )
        })}

        {/* ── QUERY: Question + answer tooltip ── */}
        {isQuery && (() => {
          const ae = ENTITIES[ANCHOR_IDX]!
          const tx = ae.x * W + 28, ty = Math.max(8, ae.y * H - 70)
          const answerReady = (tick % 120) > 50
          return (
            <g style={{ animation: 'lp-fade-up 400ms ease both' }}>
              <rect x={tx} y={ty} width={230} height={answerReady ? 56 : 40} rx={8}
                fill="rgba(11,10,7,0.94)" stroke={`${accent}44`} strokeWidth={1}
                style={{ transition: 'height 300ms' }}/>
              <text x={tx + 11} y={ty + 16} fill={accent} fontSize={9.5}
                fontFamily="JetBrains Mono, monospace"
                style={{ pointerEvents: 'none', userSelect: 'none' }}>
                &gt; Why did we decide to ship v3?
              </text>
              <text x={tx + 11} y={ty + 31} fill={ink3} fontSize={8.5}
                fontFamily="JetBrains Mono, monospace"
                style={{ pointerEvents: 'none', userSelect: 'none' }}>
                {answerReady ? '' : 'Querying 9 entities across 3 sources...'}
              </text>
              {answerReady && (
                <text x={tx + 11} y={ty + 31} fill={ink} fontSize={8.5}
                  fontFamily="JetBrains Mono, monospace"
                  style={{ pointerEvents: 'none', userSelect: 'none' }}>
                  Decided Apr 14 in exec sync. Owned by Ben R.
                </text>
              )}
              {answerReady && (
                <text x={tx + 11} y={ty + 46} fill={ink3} fontSize={8}
                  fontFamily="JetBrains Mono, monospace"
                  style={{ pointerEvents: 'none', userSelect: 'none' }}>
                  Cited: call &middot; 00:42:10 &middot; doc &middot; p.1
                </text>
              )}
            </g>
          )
        })()}
      </svg>

      {/* Bottom bar */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '8px 14px',
        borderTop: `1px solid ${border}`,
        background: 'rgba(11,10,7,0.6)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{
            width: 6, height: 6, borderRadius: '50%', background: accent,
            boxShadow: `0 0 6px ${accent}`,
          }}/>
          <span style={{
            fontFamily: 'JetBrains Mono, monospace', fontSize: 10,
            color: ink, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em',
          }}>{activeStep.label}</span>
          <span style={{
            fontFamily: 'JetBrains Mono, monospace', fontSize: 9, color: ink3,
          }}>{activeStep.caption}</span>
        </div>
        <span style={{
          fontFamily: 'JetBrains Mono, monospace', fontSize: 9, color: ink3,
        }}>Step {activeStep.n} / {String(PIPELINE_STEPS.length).padStart(2, '0')}</span>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  LandingHowItWorks (wrapper - unchanged)                            */
/* ------------------------------------------------------------------ */

interface LandingHowItWorksProps {
  accent: string
  displayFont: string
}

export function LandingHowItWorks({ accent, displayFont }: LandingHowItWorksProps) {
  const sectionRef = useRef<HTMLDivElement>(null)
  const [activeIdx, setActiveIdx] = useState(0)

  const scenesCount = PIPELINE_STEPS.length
  const sectionMinHeight = `${scenesCount * 70 + 40}vh`

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
      const idx = Math.min(PIPELINE_STEPS.length - 1, Math.floor(p * PIPELINE_STEPS.length))
      setActiveIdx(idx)
    }
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onScroll)
    return () => {
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onScroll)
    }
  }, [])

  const scrollToStep = (i: number) => {
    if (window.matchMedia('(max-width: 768px)').matches) {
      setActiveIdx(i)
      return
    }
    const el = sectionRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const vh = window.innerHeight
    const sectionTop = window.scrollY + rect.top
    const maxScroll = rect.height - vh
    const target = sectionTop + (i / scenesCount) * maxScroll + 2
    window.scrollTo({ top: target, behavior: 'smooth' })
  }

  const active = PIPELINE_STEPS[activeIdx] ?? PIPELINE_STEPS[0]!
  const activeKey = active.k

  const bg = '#0B0A07'
  const ink = '#F0EDE6'
  const ink2 = 'rgba(240,237,230,0.64)'
  const ink3 = 'rgba(240,237,230,0.36)'
  const border = 'rgba(240,237,230,0.1)'

  return (
    <section ref={sectionRef} data-screen-label="03 How it works" className="lp-howitworks" style={{
      position: 'relative', zIndex: 2,
      background: bg, color: ink,
      marginTop: 0,
      minHeight: sectionMinHeight,
    }}>
      <div className="lp-howitworks-sticky" style={{
        position: 'sticky', top: 0,
        height: '100vh',
        overflow: 'hidden',
        padding: '96px clamp(24px, 5vw, 64px) 56px',
        display: 'flex', flexDirection: 'column',
      }}>
        <svg width="100%" height="100%" style={{ position: 'absolute', inset: 0, zIndex: 0, pointerEvents: 'none' }}>
          <defs>
            <pattern id="hiw-grid" width="32" height="32" patternUnits="userSpaceOnUse">
              <path d="M 32 0 L 0 0 0 32" fill="none" stroke="rgba(240,237,230,0.05)" strokeWidth="0.5"/>
            </pattern>
            <pattern id="hiw-grid-lg" width="128" height="128" patternUnits="userSpaceOnUse">
              <path d="M 128 0 L 0 0 0 128" fill="none" stroke="rgba(240,237,230,0.08)" strokeWidth="0.5"/>
            </pattern>
          </defs>
          <rect width="100%" height="100%" fill="url(#hiw-grid)"/>
          <rect width="100%" height="100%" fill="url(#hiw-grid-lg)"/>
        </svg>

        <div style={{
          position: 'absolute', inset: 0, zIndex: 0, pointerEvents: 'none',
          background: `radial-gradient(ellipse 45% 60% at 10% 100%, ${accent}22 0%, ${accent}08 40%, transparent 70%)`,
        }}/>

        <div style={{ maxWidth: 1400, width: '100%', margin: '0 auto', position: 'relative', zIndex: 1, flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 18 }}>
            <span style={{
              fontFamily: 'JetBrains Mono, monospace', fontSize: 11,
              color: accent, letterSpacing: '0.16em', textTransform: 'uppercase',
            }}>&mdash; Method &middot; &sect;02</span>
            <span style={{ flex: 1, height: 1, background: border }}/>
            <span className="lp-hide-mobile" style={{
              fontFamily: 'JetBrains Mono, monospace', fontSize: 10,
              color: ink3, letterSpacing: '0.14em',
            }}>FIG. 02 / PIPELINE &middot; {active.n} of {String(PIPELINE_STEPS.length).padStart(2, '0')}</span>
          </div>

          <h2 style={{
            fontFamily: `${displayFont}, sans-serif`, fontWeight: 800,
            fontSize: 'clamp(32px, 3.6vw, 56px)', lineHeight: 1.04,
            letterSpacing: '-0.03em', margin: 0, maxWidth: 880, color: ink,
          }}>
            Five passes between a source{' '}
            <em style={{
              fontFamily: 'Instrument Serif, Georgia, serif',
              fontStyle: 'italic', fontWeight: 400, color: accent,
            }}>and an answer that cites itself.</em>
          </h2>

          <div className="lp-howitworks-grid" style={{
            marginTop: 28, flex: 1, minHeight: 0,
            display: 'grid', gridTemplateColumns: '0.9fr 1.1fr', gap: 48,
            alignItems: 'stretch',
          }}>
            {/* Left: steps */}
            <div style={{
              display: 'flex', flexDirection: 'column', justifyContent: 'center', minHeight: 0,
            }}>
              <p style={{
                fontSize: 15, lineHeight: 1.6, color: ink2, maxWidth: 480,
                margin: '0 0 32px',
              }}>
                Every source runs through five passes. What enters as a raw meeting, doc, or video leaves as a queryable graph &mdash; typed, linked, and cited back to the moment it came from.
              </p>
              {PIPELINE_STEPS.map((s, i) => {
                const isActive = i === activeIdx
                const isPast = i < activeIdx
                return (
                  <button key={s.k} onClick={() => scrollToStep(i)} style={{
                    display: 'block', width: '100%', textAlign: 'left',
                    padding: '12px 18px',
                    background: isActive ? 'rgba(240,237,230,0.04)' : 'transparent',
                    border: `1px solid ${isActive ? `${accent}66` : 'transparent'}`,
                    borderLeft: `2px solid ${isActive ? accent : (isPast ? `${accent}40` : border)}`,
                    borderRadius: 0, marginBottom: 2, cursor: 'pointer',
                    color: ink, fontFamily: 'DM Sans, sans-serif',
                    transition: 'all 320ms',
                    opacity: isActive ? 1 : (isPast ? 0.7 : 0.45),
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                      <div style={{
                        fontFamily: 'JetBrains Mono, monospace', fontSize: 10,
                        color: isActive ? accent : ink3, letterSpacing: '0.12em', minWidth: 24,
                      }}>{s.n}</div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{
                          fontFamily: `${displayFont}, sans-serif`, fontWeight: 800,
                          fontSize: 20, letterSpacing: '-0.02em', color: ink, lineHeight: 1.15,
                        }}>{s.label}</div>
                        <div style={{
                          fontSize: 11, color: ink2, marginTop: 1,
                          fontFamily: 'JetBrains Mono, monospace', letterSpacing: '0.02em',
                          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        }}>{s.caption}</div>
                      </div>
                      <div style={{
                        width: 7, height: 7, borderRadius: '50%',
                        background: isActive ? accent : 'rgba(240,237,230,0.14)',
                        boxShadow: isActive ? `0 0 0 4px ${accent}22` : 'none',
                        transition: 'background 260ms, box-shadow 260ms', flexShrink: 0,
                      }}/>
                    </div>
                    {isActive && (
                      <div style={{ paddingLeft: 36, marginTop: 8, animation: 'lp-fade-up 320ms ease' }}>
                        <p style={{ fontSize: 13, lineHeight: 1.5, color: ink2, margin: 0 }}>{s.blurb}</p>
                        <div style={{
                          marginTop: 6, fontFamily: 'JetBrains Mono, monospace', fontSize: 10,
                          color: accent, letterSpacing: '0.12em',
                        }}>{s.meta}</div>
                      </div>
                    )}
                  </button>
                )
              })}
              <div className="lp-hide-mobile" style={{
                marginTop: 14, paddingLeft: 20,
                display: 'flex', alignItems: 'center', gap: 8,
                fontFamily: 'JetBrains Mono, monospace', fontSize: 10,
                color: ink3, letterSpacing: '0.14em', textTransform: 'uppercase',
              }}>
                <span style={{ display: 'inline-block', width: 14, height: 1, background: ink3 }}/>
                <span>Scroll to advance</span>
              </div>
            </div>

            <div className="lp-howitworks-graph" style={{
              minHeight: 0, display: 'flex',
              alignItems: 'center', justifyContent: 'center',
            }}>
              <div style={{
                width: '100%', height: '100%',
                maxHeight: 560,
                display: 'flex', flexDirection: 'column',
              }}>
                <PipelineGraph active={activeKey} accent={accent}
                  ink={ink} ink2={ink2} ink3={ink3} border={border} activeStep={active}/>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
