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
  { type: 'text', text: 'Ship ' },
  { type: 'entity', id: 'ship_v3', label: 'v3 in May', kind: 'decision' },
  { type: 'text', text: ' supports ' },
  { type: 'entity', id: 'gtm', label: 'GTM', kind: 'anchor' },
  { type: 'text', text: ', but ' },
  { type: 'entity', id: 'latency', label: 'latency risk', kind: 'risk' },
  { type: 'text', text: ' \u2014 raised by ' },
  { type: 'entity', id: 'sarah', label: 'Sarah K.', kind: 'person' },
  { type: 'text', text: ' in ' },
  { type: 'entity', id: 'exec_sync', label: "Thursday\u2019s exec sync", kind: 'call' },
  { type: 'text', text: ' \u2014 may push it to June.' },
]

interface AnatomyFacets {
  relations: Array<{ verb: string; target: string; kind: string }>
  sources: Array<{ label: string; kind: string; loc: string }>
  mentions: { total: number; peak: number; trend: number[]; weeks: number; delta: string }
  agents: { tools: string[]; citable: boolean; writable: boolean }
}

interface AnatomyDetailData {
  kind: string
  label: string
  confidence: number
  summary: string
  facets: AnatomyFacets
}

const ANATOMY_DETAIL: Record<string, AnatomyDetailData> = {
  ship_v3: {
    kind: 'decision', label: 'Ship v3 in May', confidence: 0.91,
    summary: 'A commitment logged on Apr 14. Owned by Ben R. Spans four adjacent anchors.',
    facets: {
      relations: [
        { verb: 'supports', target: 'GTM', kind: 'anchor' },
        { verb: 'owned_by', target: 'Ben R.', kind: 'person' },
        { verb: 'blocked_by', target: 'latency risk', kind: 'risk' },
        { verb: 'ties_to', target: 'Q2 Strategy', kind: 'anchor' },
      ],
      sources: [
        { label: 'call \u00b7 exec-sync', kind: 'call', loc: '00:42:10' },
        { label: 'doc \u00b7 may-launch-plan', kind: 'doc', loc: 'p.1' },
        { label: 'slack \u00b7 #launches', kind: 'doc', loc: '2d ago' },
      ],
      mentions: { total: 34, peak: 12, trend: [2,3,4,5,7,12,9,8], weeks: 8, delta: '+18 vs prior' },
      agents: { tools: ['graph.find', 'graph.trace', 'graph.cite'], citable: true, writable: false },
    },
  },
  gtm: {
    kind: 'anchor', label: 'GTM', confidence: 0.97,
    summary: 'The Q2 go-to-market anchor. Referenced in 23 sources. Central to the current cycle.',
    facets: {
      relations: [
        { verb: 'supported_by', target: 'Ship v3 in May', kind: 'decision' },
        { verb: 'blocked_by', target: 'churn signal', kind: 'risk' },
        { verb: 'owned_by', target: 'Sarah K.', kind: 'person' },
        { verb: 'parent', target: 'Q2 Strategy', kind: 'anchor' },
      ],
      sources: [
        { label: 'doc \u00b7 q2-okrs', kind: 'doc', loc: 'p.3' },
        { label: 'video \u00b7 all-hands', kind: 'call', loc: '22:15' },
        { label: 'call \u00b7 sarah k.', kind: 'call', loc: '00:14:22' },
      ],
      mentions: { total: 142, peak: 18, trend: [6,9,11,14,12,16,18,15], weeks: 8, delta: '+42 vs prior' },
      agents: { tools: ['graph.find', 'graph.subgraph', 'graph.skill(onboarding)'], citable: true, writable: false },
    },
  },
  latency: {
    kind: 'risk', label: 'latency risk', confidence: 0.84,
    summary: 'First raised Apr 11. Trending up for 3 weeks. Blocks the May ship window.',
    facets: {
      relations: [
        { verb: 'blocks', target: 'Ship v3 in May', kind: 'decision' },
        { verb: 'owned_by', target: 'eng platform', kind: 'org' },
        { verb: 'raised_by', target: 'Sarah K.', kind: 'person' },
      ],
      sources: [
        { label: 'doc \u00b7 q2-risk-register', kind: 'doc', loc: 'row 4' },
        { label: 'call \u00b7 eng-sync', kind: 'call', loc: '00:08:44' },
        { label: 'slack \u00b7 #risks', kind: 'doc', loc: '3d ago' },
      ],
      mentions: { total: 19, peak: 6, trend: [0,0,1,3,5,6,4,5], weeks: 8, delta: '+11 vs prior' },
      agents: { tools: ['graph.find', 'graph.filter(risk)', 'graph.alert'], citable: true, writable: true },
    },
  },
}

const ANATOMY_SCENES = ['ship_v3', 'gtm', 'latency'] as const

const TINT_MAP: Record<string, string> = {
  anchor: '#D63A00', person: '#5A7A8F', decision: '#6B8E70',
  risk: '#B84A2E', call: '#8F7050', doc: '#6B6B6B', org: '#5A5148',
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

function RelationRow({ verb, target, kind, ink, ink2, ink3, compact }: {
  verb: string; target: string; kind: string
  ink: string; ink2: string; ink3: string; compact: boolean
}) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: compact ? 8 : 12,
      padding: compact ? '6px 0' : '10px 0',
      borderBottom: '1px dashed rgba(0,0,0,0.06)',
    }}>
      <span style={{
        fontFamily: 'JetBrains Mono, monospace', fontSize: compact ? 10 : 11,
        color: ink3, letterSpacing: '0.08em',
        minWidth: compact ? 82 : 110, flexShrink: 0,
      }}>{verb}</span>
      <span style={{ display: 'inline-flex', alignItems: 'center', color: ink3 }}>
        <svg width="28" height="8" viewBox="0 0 28 8" aria-hidden="true">
          <line x1="0" y1="4" x2="22" y2="4" stroke="currentColor" strokeWidth="1" strokeDasharray="2 2"/>
          <path d="M20 1 L26 4 L20 7" fill="none" stroke="currentColor" strokeWidth="1"/>
        </svg>
      </span>
      <span style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        color: ink, fontWeight: 500, whiteSpace: 'nowrap',
      }}>
        <EntityIcon type={kind} size={13} color={ink2}/>
        <span>{target}</span>
      </span>
    </div>
  )
}

function SourceRow({ label, kind, loc, border, compact, ink, ink2, ink3 }: {
  label: string; kind: string; loc: string
  border: string; compact: boolean; ink: string; ink2: string; ink3: string
}) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: compact ? 8 : 12,
      padding: compact ? '7px 10px' : '10px 14px',
      background: 'rgba(0,0,0,0.02)', borderRadius: 6,
      border: `1px solid ${border}`,
    }}>
      <span style={{ color: ink2, display: 'flex' }}>
        <EntityIcon type={kind} size={compact ? 12 : 14}/>
      </span>
      <span style={{
        fontFamily: 'DM Sans, sans-serif', fontSize: compact ? 12 : 13, fontWeight: 500,
        color: ink, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>{label}</span>
      {loc && (
        <span style={{
          fontFamily: 'JetBrains Mono, monospace', fontSize: 10,
          color: ink3, letterSpacing: '0.08em',
        }}>{loc}</span>
      )}
    </div>
  )
}

function MentionsViz({ mentions, ink, ink3, kindTint, compact }: {
  mentions: AnatomyFacets['mentions']
  ink: string; ink3: string; kindTint: string; compact: boolean
}) {
  const max = Math.max(...mentions.trend, 1)
  return (
    <div>
      <div style={{
        display: 'flex', alignItems: 'flex-end', gap: compact ? 10 : 14, marginBottom: compact ? 12 : 18,
      }}>
        <span style={{
          fontFamily: 'Instrument Serif, Georgia, serif',
          fontWeight: 400, fontSize: compact ? 44 : 64, lineHeight: 0.9, color: ink,
        }}>{mentions.total}</span>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, paddingBottom: 6 }}>
          <span style={{
            fontFamily: 'JetBrains Mono, monospace', fontSize: 10,
            color: ink3, letterSpacing: '0.14em', textTransform: 'uppercase',
          }}>total mentions</span>
          <span style={{
            fontFamily: 'JetBrains Mono, monospace', fontSize: 10,
            color: kindTint, letterSpacing: '0.1em',
            padding: '3px 7px', borderRadius: 3,
            background: `${kindTint}14`, alignSelf: 'flex-start',
          }}>{mentions.delta}</span>
        </div>
      </div>

      <div style={{
        display: 'flex', alignItems: 'flex-end', gap: compact ? 4 : 6,
        height: compact ? 48 : 64, padding: '0 2px',
      }}>
        {mentions.trend.map((v, i) => {
          const h = (v / max) * 100
          const isPeak = v === max
          return (
            <div key={i} style={{
              flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 5,
              height: '100%',
            }}>
              <div style={{ flex: 1, display: 'flex', alignItems: 'flex-end', width: '100%' }}>
                <div style={{
                  width: '100%', height: `${h}%`,
                  background: isPeak ? kindTint : `${kindTint}60`,
                  borderRadius: '2px 2px 0 0',
                  minHeight: v > 0 ? 2 : 0,
                  transition: 'height 400ms',
                }}/>
              </div>
              <span style={{
                fontFamily: 'JetBrains Mono, monospace', fontSize: 9,
                color: ink3, letterSpacing: '0.08em',
              }}>W{i + 1}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function AgentFacet({ agents, accent, ink, ink3, compact }: {
  agents: AnatomyFacets['agents']
  accent: string; ink: string; ink3: string; compact: boolean
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: compact ? 8 : 12 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: compact ? 4 : 6 }}>
        {agents.tools.map((tool, i) => (
          <div key={i} style={{
            display: 'flex', alignItems: 'center', gap: compact ? 8 : 10,
            padding: compact ? '6px 10px' : '8px 12px', borderRadius: 6,
            background: 'rgba(0,0,0,0.025)',
            fontFamily: 'JetBrains Mono, monospace', fontSize: compact ? 11 : 12.5,
            color: ink,
          }}>
            <span style={{ color: accent }}>&rsaquo;</span>
            <span>{tool}</span>
            <span style={{ marginLeft: 'auto', color: ink3, fontSize: 10, letterSpacing: '0.1em' }}>CALL</span>
          </div>
        ))}
      </div>
      <div style={{
        display: 'flex', gap: 10, marginTop: 4,
        fontFamily: 'JetBrains Mono, monospace', fontSize: 10,
        letterSpacing: '0.14em', textTransform: 'uppercase',
      }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: agents.citable ? ink : ink3 }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: agents.citable ? '#6B8E70' : ink3 }}/>
          citable
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: agents.writable ? ink : ink3 }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: agents.writable ? '#6B8E70' : ink3 }}/>
          writable
        </span>
      </div>
    </div>
  )
}

function Facet({ n, label, hint, compact, ink, ink2, ink3, border, children }: {
  n: string; label: string; hint?: string | null; compact: boolean
  ink: string; ink2: string; ink3: string; border: string; children: React.ReactNode
}) {
  return (
    <div>
      <div style={{
        display: 'flex', alignItems: 'baseline', gap: compact ? 8 : 12,
        paddingBottom: compact ? 10 : 14, marginBottom: compact ? 12 : 16,
        borderBottom: `1px solid ${border}`,
      }}>
        <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 10, color: ink3, letterSpacing: '0.16em' }}>{n}</span>
        <span style={{ fontFamily: 'DM Sans, sans-serif', fontSize: compact ? 15 : 18, fontWeight: 700, color: ink, letterSpacing: '-0.01em' }}>{label}</span>
        {hint && (
          <span style={{ fontFamily: 'Instrument Serif, Georgia, serif', fontStyle: 'italic', fontSize: 14, color: ink2, marginLeft: 'auto' }}>{hint}</span>
        )}
      </div>
      {children}
    </div>
  )
}

function AnatomyPanel({ detail, accent, ink, ink2, ink3, border, borderStrong, compact }: {
  detail: AnatomyDetailData; accent: string; ink: string; ink2: string; ink3: string
  border: string; borderStrong: string; compact: boolean
}) {
  const kindTint = TINT_MAP[detail.kind] || accent

  return (
    <div key={detail.label} style={{ animation: 'lp-fade-up 360ms ease-out' }}>
      {/* Entity header */}
      <div style={{
        display: 'flex', alignItems: 'flex-start', gap: compact ? 14 : 20,
        paddingBottom: compact ? 18 : 24,
        borderBottom: `1px solid ${border}`,
        marginBottom: compact ? 20 : 28,
      }}>
        <div style={{
          width: compact ? 42 : 52, height: compact ? 42 : 52, borderRadius: compact ? 8 : 10,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: `${kindTint}12`, border: `1px solid ${kindTint}30`,
          color: kindTint, flexShrink: 0,
        }}>
          <EntityIcon type={detail.kind} size={compact ? 22 : 26} color={kindTint}/>
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4,
            fontFamily: 'JetBrains Mono, monospace', fontSize: 10,
            color: ink3, letterSpacing: '0.2em', textTransform: 'uppercase', flexWrap: 'wrap',
          }}>
            <span>{detail.kind}</span>
            <span style={{ opacity: 0.5 }}>&middot;</span>
            <span>confidence {detail.confidence.toFixed(2)}</span>
          </div>
          <div style={{
            fontFamily: 'DM Sans, sans-serif',
            fontSize: compact ? 22 : 26, fontWeight: 700, color: ink,
            letterSpacing: '-0.015em', lineHeight: 1.15,
          }}>{detail.label}</div>
          <p style={{
            margin: compact ? '8px 0 0' : '12px 0 0',
            fontSize: compact ? 13.5 : 15, lineHeight: 1.5, color: ink2, maxWidth: 680,
          }}>{detail.summary}</p>
        </div>
        {!compact && (
          <button style={{
            padding: '8px 16px', borderRadius: 999,
            background: 'transparent', border: `1px solid ${borderStrong}`,
            color: ink, cursor: 'pointer',
            fontFamily: 'JetBrains Mono, monospace', fontSize: 11,
            letterSpacing: '0.1em', textTransform: 'uppercase',
            display: 'flex', alignItems: 'center', gap: 8, whiteSpace: 'nowrap',
          }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: accent }}/>
            Open in graph
          </button>
        )}
      </div>

      {/* Four facets */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: compact ? '1fr 1fr' : '1.2fr 1fr',
        gridTemplateRows: 'auto auto',
        gap: compact ? '20px 24px' : '32px 40px',
      }}>
        <Facet n="01" label="Relations" hint={compact ? null : 'what this connects to'} compact={compact} ink={ink} ink2={ink2} ink3={ink3} border={border}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: compact ? 2 : 6 }}>
            {detail.facets.relations.map((r, i) => (
              <RelationRow key={i} verb={r.verb} target={r.target} kind={r.kind} ink={ink} ink2={ink2} ink3={ink3} compact={compact}/>
            ))}
          </div>
        </Facet>

        <Facet n="03" label="Mentions" hint={compact ? null : 'how loud, across 8 weeks'} compact={compact} ink={ink} ink2={ink2} ink3={ink3} border={border}>
          <MentionsViz mentions={detail.facets.mentions} ink={ink} ink3={ink3} kindTint={kindTint} compact={compact}/>
        </Facet>

        <Facet n="02" label="Sources" hint={compact ? null : 'where it came from'} compact={compact} ink={ink} ink2={ink2} ink3={ink3} border={border}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: compact ? 5 : 8 }}>
            {detail.facets.sources.map((s, i) => (
              <SourceRow key={i} label={s.label} kind={s.kind} loc={s.loc} border={border} compact={compact} ink={ink} ink2={ink2} ink3={ink3}/>
            ))}
          </div>
        </Facet>

        <Facet n="04" label="For agents" hint={compact ? null : 'what can be called on this entity'} compact={compact} ink={ink} ink2={ink2} ink3={ink3} border={border}>
          <AgentFacet agents={detail.facets.agents} accent={accent} ink={ink} ink3={ink3} compact={compact}/>
        </Facet>
      </div>
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
    <section ref={sectionRef} data-screen-label="04 Anatomy" style={{
      position: 'relative', zIndex: 1,
      borderTop: `1px solid ${border}`,
      background: surface,
      minHeight: sectionMinHeight,
    }}>
      <div style={{
        position: 'sticky', top: 0,
        height: '100vh',
        padding: 'clamp(48px, 6vw, 88px) clamp(24px, 6vw, 80px) clamp(40px, 5vw, 72px)',
        display: 'flex', flexDirection: 'column',
        boxSizing: 'border-box',
      }}>
        <div style={{ maxWidth: 1400, width: '100%', margin: '0 auto', flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          {/* Eyebrow */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 14,
            fontFamily: 'JetBrains Mono, monospace', fontSize: 10,
            color: ink3, letterSpacing: '0.28em', marginBottom: 18, flexShrink: 0,
          }}>
            <span style={{ width: 24, height: 1, background: borderStrong }}/>
            <span>&sect;03 &middot; ANATOMY OF AN INSIGHT</span>
            <span style={{ flex: 1, height: 1, background: border }}/>
            <span>{String(activeIdx + 1).padStart(2, '0')} / {String(ANATOMY_SCENES.length).padStart(2, '0')}</span>
          </div>

          {/* Two columns */}
          <div style={{
            flex: 1, minHeight: 0,
            display: 'grid',
            gridTemplateColumns: 'minmax(0, 0.95fr) minmax(0, 1.05fr)',
            gap: 'clamp(32px, 4vw, 64px)',
            alignItems: 'stretch',
          }}>
            {/* LEFT */}
            <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', minHeight: 0 }}>
              <h2 style={{
                fontFamily: `${displayFont}, sans-serif`, fontWeight: 800,
                fontSize: 'clamp(30px, 3.2vw, 48px)', lineHeight: 1.15,
                letterSpacing: '-0.03em', margin: '0 0 36px', color: ink,
              }}>
                Every answer is an{' '}
                <em style={{
                  fontFamily: 'Instrument Serif, Georgia, serif',
                  fontStyle: 'italic', fontWeight: 400, color: accent,
                }}>aggregate.</em>
              </h2>

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
              <div style={{ marginTop: 24, display: 'flex', alignItems: 'center', gap: 12 }}>
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
            <div style={{ minHeight: 0, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
              <div style={{
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
    </section>
  )
}
