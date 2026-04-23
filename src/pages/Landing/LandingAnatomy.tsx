import { useEffect, useRef, useState } from 'react'
// Entity colors used via TINT_MAP locally
import { EntityIcon } from './shared/EntityIcon'

/* ------------------------------------------------------------------ */
/*  Data                                                               */
/* ------------------------------------------------------------------ */

interface SentenceSegment {
  type: 'text' | 'entity'
  text?: string
  id?: string
  label?: string
  kind?: string
}

const ANATOMY_SENTENCE: SentenceSegment[] = [
  { type: 'text', text: 'The ' },
  { type: 'entity', id: 'mobile_redesign', label: 'mobile redesign', kind: 'project' },
  { type: 'text', text: ' supports the ' },
  { type: 'entity', id: 'q4_roadmap', label: 'Q4 roadmap', kind: 'anchor' },
  { type: 'text', text: ', first raised in ' },
  { type: 'entity', id: 'planning_call', label: 'Friday\u2019s planning call', kind: 'call' },
  { type: 'text', text: '.' },
]

type ConnectedNode = { label: string; kind: string }
type Signal = { label: string; value: number }
type TopEntity = { label: string; kind: string; confidence: number }

type EntityDetail = {
  variant: 'entity'
  kind: string
  typeLabel: string
  label: string
  confidence: number
  metaRow: string
  description: string
  relatedAnchors: string[]
  tags: string[]
  outcome: string
}

type AnchorDetail = {
  variant: 'anchor'
  kind: 'anchor'
  label: string
  badges: Array<{ label: string; tone: 'neutral' | 'confirmed' }>
  signalBanner: string
  signals: Signal[]
  connected: ConnectedNode[]
  crossAnchor: string
  outcome: string
}

type SourceDetail = {
  variant: 'source'
  kind: string
  label: string
  platform: string
  timeAgo: string
  meta: string
  summary: string
  topEntities: TopEntity[]
  relatedSources: string[]
  outcome: string
}

type AnatomyDetailData = EntityDetail | AnchorDetail | SourceDetail

const ANATOMY_DETAIL: Record<string, AnatomyDetailData> = {
  mobile_redesign: {
    variant: 'entity',
    kind: 'project',
    typeLabel: 'Project',
    label: 'Mobile redesign',
    confidence: 0.94,
    metaRow: 'Owned by Priya N. \u00b7 In progress \u00b7 Seen 2w ago',
    description: 'A full overhaul of the mobile app. Focused on a faster checkout, simpler navigation, and a cleaner visual system across iOS and Android.',
    relatedAnchors: ['Q4 roadmap', 'Mobile platform'],
    tags: ['ux', 'mobile', 'q4', 'priority'],
    outcome: 'Your agents can cite this, trace its dependencies, and surface related work across the graph.',
  },
  q4_roadmap: {
    variant: 'anchor',
    kind: 'anchor',
    label: 'Q4 roadmap',
    badges: [
      { label: 'Initiative', tone: 'neutral' },
      { label: 'Active', tone: 'confirmed' },
    ],
    signalBanner: 'A central node shaping what matters this quarter.',
    signals: [
      { label: 'Centrality', value: 0.72 },
      { label: 'Diversity',  value: 0.91 },
      { label: 'Velocity',   value: 0.68 },
      { label: 'Richness',   value: 0.85 },
    ],
    connected: [
      { label: 'Mobile redesign', kind: 'project' },
      { label: 'Priya N.', kind: 'person' },
      { label: 'Pricing update', kind: 'project' },
      { label: 'Churn signal', kind: 'risk' },
    ],
    crossAnchor: 'Connected to 3 other anchors',
    outcome: 'Anchors are how your agents know what this cycle is really about.',
  },
  planning_call: {
    variant: 'source',
    kind: 'call',
    platform: 'Meeting',
    label: 'Friday\u2019s planning call',
    timeAgo: '3d ago',
    meta: '48 min \u00b7 5 participants \u00b7 transcript ready',
    summary: 'The team walked through Q4 priorities, agreed that the mobile redesign should lead the quarter, and flagged the churn signal as a watch item.',
    topEntities: [
      { label: 'Mobile redesign', kind: 'project', confidence: 0.94 },
      { label: 'Q4 roadmap', kind: 'anchor', confidence: 0.99 },
      { label: 'Churn signal', kind: 'risk', confidence: 0.82 },
    ],
    relatedSources: ['Mon product sync', 'Q4 kickoff doc'],
    outcome: 'Every source becomes permanent, citable context your agents can reference.',
  },
}

const ANATOMY_SCENES = ['mobile_redesign', 'q4_roadmap', 'planning_call'] as const

const TINT_MAP: Record<string, string> = {
  anchor: '#D63A00',
  person: '#B8673F',
  decision: '#6B8E70',
  risk: '#B84A2E',
  call: '#8F7050',
  doc: '#6B6B6B',
  document: '#6B6B6B',
  org: '#5A5148',
  product: '#2E7D5B',
  technology: '#5A7A8F',
  concept: '#7A6B8A',
  location: '#5A9080',
  project: '#C97845',
  topic: '#6B8BC9',
  video: '#E6425C',
}

/* ------------------------------------------------------------------ */
/*  Sub-components                                                     */
/* ------------------------------------------------------------------ */

function SentenceChip({ seg, active, dim, accent, onClick }: {
  seg: SentenceSegment; active: boolean; dim: boolean
  accent: string; ink?: string; onClick?: () => void
}) {
  const [hover, setHover] = useState(false)
  const tint = TINT_MAP[seg.kind ?? ''] || accent
  const interactive = !dim

  return (
    <span
      onClick={interactive ? onClick : undefined}
      onMouseEnter={() => interactive && setHover(true)}
      onMouseLeave={() => interactive && setHover(false)}
      style={{
        display: 'inline-flex', alignItems: 'baseline', gap: 6,
        padding: '2px 10px 3px', margin: '0 2px', borderRadius: 4,
        cursor: interactive ? 'pointer' : 'default',
        position: 'relative',
        color: active ? '#fff' : tint,
        background: active ? tint : (hover ? `${tint}14` : 'transparent'),
        borderBottom: active ? 'none' : `2px solid ${tint}`,
        opacity: dim ? 0.55 : 1,
        fontStyle: 'normal',
        fontFamily: 'DM Sans, sans-serif',
        fontSize: '0.78em', fontWeight: 600,
        letterSpacing: '-0.01em', verticalAlign: '0.08em',
        transition: 'all 220ms', whiteSpace: 'nowrap',
      }}
    >
      <span style={{ display: 'inline-flex', alignItems: 'center', transform: 'translateY(1px)' }}>
        <EntityIcon type={seg.kind ?? 'default'} size={12} color={active ? '#fff' : tint}/>
      </span>
      {seg.label}
    </span>
  )
}

function SectionLabel({ children, ink }: { children: React.ReactNode; ink: string }) {
  return (
    <div style={{
      fontFamily: 'DM Sans, sans-serif', fontSize: 12, fontWeight: 600,
      color: ink, marginBottom: 10,
      textTransform: 'uppercase', letterSpacing: '0.08em',
    }}>{children}</div>
  )
}

function TypePill({ kindTint, icon, label }: {
  kindTint: string; icon: string; label: string
}) {
  return (
    <div style={{
      display: 'inline-flex', alignItems: 'center', gap: 6,
      padding: '4px 10px 4px 8px', borderRadius: 999,
      background: `${kindTint}12`, border: `1px solid ${kindTint}30`,
      color: kindTint, fontFamily: 'DM Sans, sans-serif',
      fontSize: 11, fontWeight: 600,
      textTransform: 'uppercase', letterSpacing: '0.08em',
    }}>
      <EntityIcon type={icon} size={12} color={kindTint}/>
      <span>{label}</span>
    </div>
  )
}

function LivePill({ ink3 }: { ink3: string }) {
  return (
    <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
      <span style={{
        width: 6, height: 6, borderRadius: '50%',
        background: '#22c55e', boxShadow: '0 0 6px rgba(34,197,94,0.55)',
        animation: 'lp-pulse-dot 2.2s ease-in-out infinite',
      }}/>
      <span style={{
        fontFamily: 'JetBrains Mono, monospace', fontSize: 10,
        color: ink3, letterSpacing: '0.14em',
      }}>LIVE</span>
    </div>
  )
}

function AnatomyPanel({ detail, accent, ink, ink2, ink3, border }: {
  detail: AnatomyDetailData; accent: string; ink: string; ink2: string; ink3: string
  border: string; borderStrong: string; compact: boolean
}) {
  const kindTint = TINT_MAP[detail.kind] || accent

  return (
    <div key={detail.label} style={{
      animation: 'lp-fade-up 360ms ease-out',
      display: 'flex', flexDirection: 'column', height: '100%',
    }}>
      {/* ─── ENTITY VARIANT ───────────────────────── */}
      {detail.variant === 'entity' && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
            <TypePill kindTint={kindTint} icon={detail.kind} label={detail.typeLabel}/>
            <LivePill ink3={ink3}/>
          </div>
          <h3 style={{
            margin: 0, fontFamily: 'DM Sans, sans-serif', fontWeight: 700,
            fontSize: 26, lineHeight: 1.15, letterSpacing: '-0.015em', color: ink,
          }}>{detail.label}</h3>

          <div style={{
            marginTop: 6, fontSize: 12, color: ink3,
            fontFamily: 'DM Sans, sans-serif', letterSpacing: '0.01em',
          }}>{detail.metaRow}</div>

          {/* Confidence bar */}
          <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 12 }}>
            <span style={{
              fontFamily: 'JetBrains Mono, monospace', fontSize: 10,
              color: ink3, letterSpacing: '0.12em', minWidth: 78,
            }}>CONFIDENCE</span>
            <div style={{
              flex: 1, height: 4, borderRadius: 2,
              background: 'rgba(26,22,18,0.08)', overflow: 'hidden',
            }}>
              <div style={{
                width: `${detail.confidence * 100}%`, height: '100%',
                background: kindTint, borderRadius: 2,
                animation: 'lp-bar-fill 900ms cubic-bezier(.2,.8,.2,1) both',
                transformOrigin: 'left',
              }}/>
            </div>
            <span style={{
              fontFamily: 'DM Sans, sans-serif', fontSize: 12, color: ink, fontWeight: 600,
            }}>{Math.round(detail.confidence * 100)}%</span>
          </div>

          <div style={{ height: 1, background: border, margin: '16px 0 12px' }}/>

          <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div>
              <SectionLabel ink={ink}>Description</SectionLabel>
              <p style={{ margin: 0, fontSize: 13, lineHeight: 1.55, color: ink2 }}>
                {detail.description}
              </p>
            </div>

            <div>
              <SectionLabel ink={ink}>Related anchors</SectionLabel>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {detail.relatedAnchors.map((a, i) => (
                  <span key={i} style={{
                    display: 'inline-flex', alignItems: 'center', gap: 6,
                    padding: '4px 10px', borderRadius: 999,
                    background: `${accent}10`, border: `1px solid ${accent}30`,
                    color: accent, fontFamily: 'DM Sans, sans-serif',
                    fontSize: 12, fontWeight: 600,
                  }}>
                    <EntityIcon type="anchor" size={11} color={accent}/>
                    {a}
                  </span>
                ))}
              </div>
            </div>

            <div>
              <SectionLabel ink={ink}>Tags</SectionLabel>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {detail.tags.map((tag, i) => (
                  <span key={i} style={{
                    padding: '4px 10px', borderRadius: 999,
                    background: 'rgba(0,0,0,0.04)', border: `1px solid ${border}`,
                    fontFamily: 'DM Sans, sans-serif', fontSize: 12, color: ink2, fontWeight: 500,
                  }}>{tag}</span>
                ))}
              </div>
            </div>
          </div>
        </>
      )}

      {/* ─── ANCHOR VARIANT ───────────────────────── */}
      {detail.variant === 'anchor' && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
            <TypePill kindTint={kindTint} icon="anchor" label="Anchor"/>
            <LivePill ink3={ink3}/>
          </div>
          <h3 style={{
            margin: 0, fontFamily: 'DM Sans, sans-serif', fontWeight: 700,
            fontSize: 26, lineHeight: 1.15, letterSpacing: '-0.015em', color: ink,
          }}>{detail.label}</h3>

          <div style={{ marginTop: 8, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {detail.badges.map((b, i) => {
              const tone = b.tone === 'confirmed' ? '#6B8E70' : TINT_MAP.technology!
              return (
                <span key={i} style={{
                  padding: '2px 9px', borderRadius: 4,
                  background: `${tone}12`, border: `1px solid ${tone}40`,
                  color: tone, fontFamily: 'DM Sans, sans-serif',
                  fontSize: 11, fontWeight: 600,
                }}>{b.label}</span>
              )
            })}
          </div>

          <div style={{ height: 1, background: border, margin: '16px 0 12px' }}/>

          <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div>
              <SectionLabel ink={ink}>Signal scores</SectionLabel>
              <p style={{
                margin: '0 0 10px', fontSize: 12.5,
                fontFamily: 'Instrument Serif, Georgia, serif', fontStyle: 'italic',
                color: ink2,
              }}>{detail.signalBanner}</p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {detail.signals.map((s, i) => {
                  const color = s.value >= 0.66 ? '#6B8E70' : s.value >= 0.33 ? '#C97845' : '#B84A2E'
                  return (
                    <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <span style={{
                        fontFamily: 'JetBrains Mono, monospace', fontSize: 9.5,
                        color: ink3, letterSpacing: '0.1em', textTransform: 'uppercase',
                        minWidth: 70,
                      }}>{s.label}</span>
                      <div style={{
                        flex: 1, height: 3, borderRadius: 2,
                        background: 'rgba(26,22,18,0.08)', overflow: 'hidden',
                      }}>
                        <div style={{
                          width: `${s.value * 100}%`, height: '100%', background: color,
                          animation: `lp-bar-fill ${700 + i * 120}ms cubic-bezier(.2,.8,.2,1) both`,
                          transformOrigin: 'left',
                        }}/>
                      </div>
                      <span style={{
                        fontFamily: 'DM Sans, sans-serif', fontSize: 11,
                        color: ink, fontWeight: 600, minWidth: 32, textAlign: 'right',
                      }}>{s.value.toFixed(2)}</span>
                    </div>
                  )
                })}
              </div>
            </div>

            <div>
              <SectionLabel ink={ink}>Top connected nodes</SectionLabel>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                {detail.connected.map((n, i) => {
                  const t = TINT_MAP[n.kind] || accent
                  return (
                    <div key={i} style={{
                      display: 'flex', alignItems: 'center', gap: 8,
                      padding: '4px 2px',
                    }}>
                      <span style={{ width: 6, height: 6, borderRadius: '50%', background: t }}/>
                      <span style={{
                        flex: 1, fontFamily: 'DM Sans, sans-serif', fontSize: 13,
                        color: ink, fontWeight: 500,
                      }}>{n.label}</span>
                      <span style={{
                        padding: '2px 8px', borderRadius: 4,
                        background: `${t}14`, border: `1px solid ${t}30`,
                        color: t, fontFamily: 'DM Sans, sans-serif',
                        fontSize: 10.5, fontWeight: 600,
                      }}>{n.kind}</span>
                    </div>
                  )
                })}
              </div>
              <div style={{
                marginTop: 8,
                fontFamily: 'JetBrains Mono, monospace', fontSize: 10,
                color: ink3, letterSpacing: '0.1em', textTransform: 'uppercase',
              }}>{detail.crossAnchor}</div>
            </div>
          </div>
        </>
      )}

      {/* ─── SOURCE VARIANT ───────────────────────── */}
      {detail.variant === 'source' && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
            <TypePill kindTint={kindTint} icon={detail.kind} label={detail.platform}/>
            <span style={{
              fontFamily: 'JetBrains Mono, monospace', fontSize: 10,
              color: ink3, letterSpacing: '0.08em',
            }}>{detail.timeAgo}</span>
            <LivePill ink3={ink3}/>
          </div>
          <h3 style={{
            margin: 0, fontFamily: 'DM Sans, sans-serif', fontWeight: 700,
            fontSize: 22, lineHeight: 1.2, letterSpacing: '-0.015em', color: ink,
          }}>{detail.label}</h3>

          <div style={{
            marginTop: 6, fontSize: 12, color: ink3,
            fontFamily: 'DM Sans, sans-serif',
          }}>{detail.meta}</div>

          <div style={{ height: 1, background: border, margin: '14px 0 12px' }}/>

          <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div>
              <SectionLabel ink={ink}>Summary</SectionLabel>
              <p style={{ margin: 0, fontSize: 13, lineHeight: 1.55, color: ink2 }}>
                {detail.summary}
              </p>
            </div>

            <div>
              <SectionLabel ink={ink}>Top entities</SectionLabel>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                {detail.topEntities.map((e, i) => {
                  const t = TINT_MAP[e.kind] || accent
                  return (
                    <div key={i} style={{
                      display: 'flex', alignItems: 'center', gap: 8, padding: '4px 2px',
                    }}>
                      <span style={{ width: 6, height: 6, borderRadius: '50%', background: t }}/>
                      <span style={{
                        flex: 1, fontFamily: 'DM Sans, sans-serif', fontSize: 13,
                        color: ink, fontWeight: 500,
                      }}>{e.label}</span>
                      <span style={{
                        padding: '2px 8px', borderRadius: 4,
                        background: `${t}14`, border: `1px solid ${t}30`,
                        color: t, fontFamily: 'DM Sans, sans-serif',
                        fontSize: 10.5, fontWeight: 600,
                      }}>{e.kind}</span>
                      <span style={{
                        fontFamily: 'JetBrains Mono, monospace', fontSize: 10.5,
                        color: ink3, minWidth: 32, textAlign: 'right',
                      }}>{Math.round(e.confidence * 100)}%</span>
                    </div>
                  )
                })}
              </div>
            </div>

            <div>
              <SectionLabel ink={ink}>Related sources</SectionLabel>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {detail.relatedSources.map((s, i) => (
                  <span key={i} style={{
                    display: 'inline-flex', alignItems: 'center', gap: 6,
                    padding: '4px 10px', borderRadius: 6,
                    background: 'rgba(0,0,0,0.03)', border: `1px solid ${border}`,
                    fontFamily: 'DM Sans, sans-serif', fontSize: 12, color: ink, fontWeight: 500,
                  }}>
                    <EntityIcon type="doc" size={11} color={ink3}/>
                    {s}
                  </span>
                ))}
              </div>
            </div>
          </div>
        </>
      )}

      <div style={{ height: 1, background: border, margin: '16px 0 12px' }}/>

      <p style={{
        margin: 0,
        fontFamily: 'Instrument Serif, Georgia, serif',
        fontStyle: 'italic', fontSize: 14, lineHeight: 1.5,
        color: ink2,
      }}>{detail.outcome}</p>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Main Section                                                       */
/* ------------------------------------------------------------------ */

interface LandingAnatomyProps {
  accent: string; surface: string; ink: string; ink2: string; ink3: string
  border: string; borderStrong: string; card: string; dark: boolean; displayFont: string
}

export function LandingAnatomy({ accent, surface, ink, ink2, ink3, border, borderStrong, card, dark, displayFont }: LandingAnatomyProps) {
  const sectionRef = useRef<HTMLDivElement>(null)
  const [activeIdx, setActiveIdx] = useState(0)

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
      const idx = Math.min(ANATOMY_SCENES.length - 1, Math.floor(p * ANATOMY_SCENES.length))
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

  const activeId = ANATOMY_SCENES[activeIdx] ?? 'ship_v3'
  const detail = ANATOMY_DETAIL[activeId] as AnatomyDetailData

  const scrollToScene = (i: number) => {
    const el = sectionRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const sectionTop = window.scrollY + rect.top
    const maxScroll = rect.height - window.innerHeight
    const target = sectionTop + (i / ANATOMY_SCENES.length) * maxScroll + 2
    window.scrollTo({ top: target, behavior: 'smooth' })
  }

  const sectionMinHeight = `${ANATOMY_SCENES.length * 85 + 30}vh` // ~285vh

  return (
    <section ref={sectionRef} data-screen-label="04 Anatomy" className="lp-anatomy" style={{
      position: 'relative', zIndex: 1,
      borderTop: `1px solid ${border}`,
      background: surface,
      minHeight: sectionMinHeight,
    }}>
      <div className="lp-anatomy-sticky" style={{
        position: 'sticky', top: 0,
        height: '100vh',
        padding: '96px clamp(24px, 5vw, 64px) 56px',
        display: 'flex', flexDirection: 'column',
        boxSizing: 'border-box',
      }}>
        <div style={{ maxWidth: 1400, width: '100%', margin: '0 auto', flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          {/* Eyebrow */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 18, flexShrink: 0 }}>
            <span style={{
              fontFamily: 'JetBrains Mono, monospace', fontSize: 11,
              color: accent, letterSpacing: '0.16em', textTransform: 'uppercase',
            }}>&mdash; Anatomy &middot; &sect;03</span>
            <span style={{ flex: 1, height: 1, background: border }}/>
            <span className="lp-hide-mobile" style={{
              fontFamily: 'JetBrains Mono, monospace', fontSize: 10,
              color: ink3, letterSpacing: '0.14em',
            }}>FIG. 03 / INSIGHT &middot; {String(activeIdx + 1).padStart(2, '0')} of {String(ANATOMY_SCENES.length).padStart(2, '0')}</span>
          </div>

          {/* Heading */}
          <h2 style={{
            fontFamily: `${displayFont}, sans-serif`, fontWeight: 800,
            fontSize: 'clamp(32px, 3.6vw, 56px)', lineHeight: 1.04,
            letterSpacing: '-0.03em', margin: 0, maxWidth: 880, color: ink,
          }}>
            Every answer is an aggregate of sources, people, and decisions.{' '}
            <em style={{
              fontFamily: 'Instrument Serif, Georgia, serif',
              fontStyle: 'italic', fontWeight: 400, color: accent,
            }}>Traced back to the moment it entered the graph.</em>
          </h2>

          {/* Two columns */}
          <div className="lp-anatomy-grid" style={{
            marginTop: 28, flex: 1, minHeight: 0,
            display: 'grid', gridTemplateColumns: '0.9fr 1.1fr', gap: 48,
            alignItems: 'stretch',
          }}>
            {/* LEFT */}
            <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', minHeight: 0 }}>
              <p style={{
                margin: '0 0 28px', fontSize: 14.5, lineHeight: 1.6,
                color: ink2, maxWidth: 520,
              }}>
                Below, a sentence Synapse produced. Each underlined piece is a typed entity. Scroll to watch three of them unfold.
              </p>

              {/* The sentence */}
              <div style={{
                padding: 'clamp(22px, 2.2vw, 32px) clamp(24px, 2.6vw, 40px)',
                background: dark ? 'rgba(240,237,230,0.02)' : 'rgba(26,22,18,0.02)',
                borderLeft: `2px solid ${accent}`, borderRadius: 2,
                position: 'relative',
              }}>
                <span style={{
                  position: 'absolute', top: 8, left: -1,
                  fontFamily: 'Instrument Serif, Georgia, serif',
                  fontSize: 72, lineHeight: 1, color: accent,
                  opacity: 0.15, pointerEvents: 'none',
                }}>&ldquo;</span>

                <div style={{
                  fontFamily: 'Instrument Serif, Georgia, serif',
                  fontSize: 'clamp(20px, 1.9vw, 30px)',
                  lineHeight: 1.38, color: ink,
                }}>
                  {ANATOMY_SENTENCE.map((seg, i) => {
                    if (seg.type === 'text') return <span key={i}>{seg.text}</span>
                    const isActive = activeId === seg.id
                    const inScenes = ANATOMY_SCENES.includes(seg.id as typeof ANATOMY_SCENES[number])
                    return (
                      <SentenceChip
                        key={i}
                        seg={seg}
                        active={isActive}
                        dim={!inScenes}
                        accent={accent} ink={ink}
                        onClick={() => {
                          const idx = ANATOMY_SCENES.indexOf(seg.id as typeof ANATOMY_SCENES[number])
                          if (idx >= 0) scrollToScene(idx)
                        }}
                      />
                    )
                  })}
                </div>

                <div style={{
                  marginTop: 20, display: 'flex', alignItems: 'center',
                  columnGap: 14, rowGap: 6,
                  fontFamily: 'JetBrains Mono, monospace', fontSize: 9.5,
                  color: ink3, letterSpacing: '0.14em', textTransform: 'uppercase',
                  flexWrap: 'wrap',
                }}>
                  <span>8 sources</span>
                  <span style={{ opacity: 0.4 }}>&middot;</span>
                  <span>confidence 0.88</span>
                  <span style={{ opacity: 0.4 }}>&middot;</span>
                  <span>2 min ago</span>
                </div>
              </div>

              {/* Scene progress dots */}
              <div className="lp-anatomy-scene-dots" style={{ marginTop: 24, display: 'flex', alignItems: 'center', gap: 12 }}>
                {ANATOMY_SCENES.map((id, i) => {
                  const isActive = i === activeIdx
                  const isPast = i < activeIdx
                  const label = ANATOMY_DETAIL[id]?.label ?? ''
                  return (
                    <button key={id} onClick={() => scrollToScene(i)} style={{
                      display: 'flex', alignItems: 'center', gap: 8,
                      padding: '6px 12px 6px 10px', borderRadius: 999,
                      border: `1px solid ${isActive ? accent : border}`,
                      background: isActive ? `${accent}10` : 'transparent',
                      color: isActive ? ink : (isPast ? ink2 : ink3),
                      cursor: 'pointer', transition: 'all 220ms',
                      fontFamily: 'JetBrains Mono, monospace', fontSize: 10,
                      letterSpacing: '0.14em', textTransform: 'uppercase',
                    }}>
                      <span style={{
                        width: 6, height: 6, borderRadius: '50%',
                        background: isActive ? accent : (isPast ? `${accent}66` : ink3),
                        transition: 'background 220ms',
                      }}/>
                      <span>0{i + 1} &middot; {label}</span>
                    </button>
                  )
                })}
                <span style={{
                  marginLeft: 8,
                  fontFamily: 'JetBrains Mono, monospace', fontSize: 10,
                  color: ink3, letterSpacing: '0.14em', textTransform: 'uppercase',
                }}>&darr; scroll</span>
              </div>
            </div>

            {/* RIGHT: the panel */}
            <div style={{
              minHeight: 0, display: 'flex',
              alignItems: 'center', justifyContent: 'center',
            }}>
              <div style={{
                width: '100%', height: '100%',
                maxHeight: 560,
                display: 'flex', flexDirection: 'column',
              }}>
                <div style={{
                  flex: 1, minHeight: 0, overflow: 'hidden',
                  border: `1px solid ${border}`, borderRadius: 12,
                  background: card,
                  padding: 'clamp(20px, 1.8vw, 28px) clamp(22px, 2vw, 32px)',
                  boxShadow: dark ? 'none' : '0 24px 60px -28px rgba(26,22,18,0.14)',
                }}>
                  <AnatomyPanel
                    key={detail.label}
                    detail={detail}
                    accent={accent} ink={ink} ink2={ink2} ink3={ink3}
                    border={border} borderStrong={borderStrong}
                    compact
                  />
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
