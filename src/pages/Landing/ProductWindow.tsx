import { useState, useEffect, useCallback, useRef } from 'react'

interface ProductWindowProps {
  accent: string
  ink: string
  ink2: string
  ink3: string
  border: string
  borderStrong: string
  card: string
  dark: boolean
  mounted: boolean
}

/* ------------------------------------------------------------------ */
/*  Data                                                               */
/* ------------------------------------------------------------------ */

interface Source {
  x: number; y: number; r: number; color: string
  label: string; entityCount: number; type: string
}

const SOURCES: Source[] = [
  { x: 0.48, y: 0.38, r: 42, color: '#d63a00', label: 'Q2 Strategy Calls',   entityCount: 22, type: 'meeting' },
  { x: 0.22, y: 0.30, r: 32, color: '#2563eb', label: 'Product Roadmap',     entityCount: 14, type: 'document' },
  { x: 0.74, y: 0.26, r: 28, color: '#059669', label: 'Customer Interviews', entityCount: 12, type: 'meeting' },
  { x: 0.14, y: 0.60, r: 24, color: '#7c3aed', label: 'Design Reviews',      entityCount: 9,  type: 'video' },
  { x: 0.64, y: 0.62, r: 36, color: '#d97706', label: 'GTM Launch Docs',     entityCount: 18, type: 'document' },
  { x: 0.36, y: 0.68, r: 22, color: '#dc2626', label: 'Risk Register',       entityCount: 7,  type: 'document' },
  { x: 0.86, y: 0.50, r: 22, color: '#0891b2', label: 'Weekly Syncs',        entityCount: 8,  type: 'meeting' },
  { x: 0.08, y: 0.20, r: 18, color: '#4f46e5', label: 'Onboarding Docs',     entityCount: 5,  type: 'document' },
  { x: 0.88, y: 0.76, r: 16, color: '#16a34a', label: 'Investor Deck',       entityCount: 4,  type: 'document' },
  { x: 0.40, y: 0.12, r: 20, color: '#ea580c', label: 'All-Hands Videos',    entityCount: 6,  type: 'video' },
]

const SOURCE_EDGES: [number, number, number][] = [
  [0, 1, 8], [0, 4, 12], [0, 2, 5], [0, 5, 4],
  [1, 3, 3], [1, 9, 4], [2, 4, 6], [2, 6, 3],
  [4, 5, 5], [4, 6, 4], [4, 8, 3], [7, 1, 2], [0, 9, 3],
]

interface HexItem {
  x: number; y: number; label: string; kind: 'anchor' | 'skill'
  connectedSources: number[]
  description: string
}

const ANCHOR_COLOR = '#d97706'
const SKILL_COLOR = '#0891b2'

const HEXAGONS: HexItem[] = [
  { x: 0.35, y: 0.34, label: 'GTM',         kind: 'anchor', connectedSources: [0, 1, 4], description: 'Go-to-market anchor. 89 mentions across 9 sources.' },
  { x: 0.56, y: 0.50, label: 'Ship v3',     kind: 'anchor', connectedSources: [0, 4, 5], description: 'Decision to ship v3 in May. Owned by Ben R.' },
  { x: 0.70, y: 0.42, label: 'Pricing',     kind: 'anchor', connectedSources: [0, 2, 4], description: 'Pricing strategy anchor. Under active review.' },
  { x: 0.26, y: 0.50, label: 'Team Health', kind: 'anchor', connectedSources: [1, 3, 5], description: 'Team pulse tracking. 3 open action items.' },
  { x: 0.80, y: 0.64, label: 'Churn Risk',  kind: 'anchor', connectedSources: [2, 6, 8], description: 'Active risk flag. Trending up 3 weeks.' },
  { x: 0.44, y: 0.54, label: 'Onboarding',  kind: 'skill',  connectedSources: [0, 1, 7], description: 'PM onboarding playbook v3.2. 7 steps, 3 templates.' },
  { x: 0.58, y: 0.30, label: 'Deck Builder', kind: 'skill', connectedSources: [1, 8, 9], description: 'Auto-generates investor slides from graph data.' },
  { x: 0.30, y: 0.18, label: 'Risk Scan',   kind: 'skill',  connectedSources: [0, 5, 9], description: 'Weekly risk scan across all active anchors.' },
]

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function clusterDots(src: Source, W: number, H: number): Array<{ cx: number; cy: number; r: number }> {
  const dots: Array<{ cx: number; cy: number; r: number }> = []
  const cx = src.x * W, cy = src.y * H
  let placed = 0, ring = 0
  dots.push({ cx, cy, r: 3 }); placed++
  while (placed < src.entityCount) {
    ring++
    const ringR = ring * 9
    const count = Math.min(Math.floor(2 * Math.PI * ringR / 7.5), src.entityCount - placed)
    for (let i = 0; i < count && placed < src.entityCount; i++) {
      const angle = (i / count) * Math.PI * 2 - Math.PI / 2
      dots.push({ cx: cx + Math.cos(angle) * ringR, cy: cy + Math.sin(angle) * ringR, r: 1.8 })
      placed++
    }
  }
  return dots
}

function hexPath(cx: number, cy: number, r: number): string {
  const pts: string[] = []
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 3) * i - Math.PI / 2
    pts.push(`${cx + Math.cos(a) * r},${cy + Math.sin(a) * r}`)
  }
  return `M${pts.join('L')}Z`
}

type HoverTarget = { kind: 'source'; idx: number } | { kind: 'hex'; idx: number } | null

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

const W = 1000
const H = 500

export function ProductWindow({ accent, ink, ink2, ink3, border, borderStrong, card, dark, mounted }: ProductWindowProps) {
  const [tick, setTick] = useState(0)
  // Start with nothing highlighted; Q2 Strategy highlights after animation completes
  const [hovered, setHovered] = useState<HoverTarget>(null)
  const [userInteracted, setUserInteracted] = useState(false)
  const [animDone, setAnimDone] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!mounted) return
    const id = setInterval(() => setTick(t => t + 1), 50)
    return () => clearInterval(id)
  }, [mounted])

  const onHover = useCallback((target: HoverTarget) => {
    setUserInteracted(true)
    setHovered(target)
  }, [])
  const onLeave = useCallback(() => {
    // Return to default Q2 Strategy view when user stops hovering
    setHovered({ kind: 'source', idx: 0 })
  }, [])

  // Animation sequence:
  // 1. Sources/playlists appear
  // 2. Anchor hexagons appear
  // 3. Skill hexagons appear
  // 4. Connection edges draw in
  // 5. Q2 Strategy highlight activates
  const phase = Math.min(tick / 20, 6)
  const clusterP = Math.min(1, phase)                          // 1: sources first
  const labelP = Math.min(1, Math.max(0, phase - 0.6))         // labels follow sources
  const anchorHexP = Math.min(1, Math.max(0, phase - 1.2))     // 2: anchors
  const skillHexP = Math.min(1, Math.max(0, phase - 1.8))      // 3: skills
  const edgeP = Math.min(1, Math.max(0, phase - 2.4))          // 4: connections
  const highlightP = Math.min(1, Math.max(0, phase - 3.2))     // 5: Q2 highlight

  // Activate Q2 highlight once animation completes
  useEffect(() => {
    if (highlightP >= 1 && !animDone && !userInteracted) {
      setAnimDone(true)
      setHovered({ kind: 'source', idx: 0 })
    }
  }, [highlightP, animDone, userInteracted])

  // Compute highlighted state - only apply after highlight phase
  const highlightedSources = new Set<number>()
  const highlightedHexes = new Set<number>()
  const highlightedEdges = new Set<number>()

  if (hovered?.kind === 'source') {
    const si = hovered.idx
    highlightedSources.add(si)
    SOURCE_EDGES.forEach(([a, b], ei) => {
      if (a === si || b === si) {
        highlightedEdges.add(ei)
        highlightedSources.add(a)
        highlightedSources.add(b)
      }
    })
    HEXAGONS.forEach((h, hi) => {
      if (h.connectedSources.includes(si)) highlightedHexes.add(hi)
    })
  } else if (hovered?.kind === 'hex') {
    const hi = hovered.idx
    const hex = HEXAGONS[hi]!
    highlightedHexes.add(hi)
    hex.connectedSources.forEach(si => highlightedSources.add(si))
    SOURCE_EDGES.forEach(([a, b], ei) => {
      if (hex.connectedSources.includes(a) && hex.connectedSources.includes(b)) {
        highlightedEdges.add(ei)
      }
    })
  }

  const hasHighlight = hovered !== null

  // No tooltip - hover only highlights connections

  return (
    <div ref={containerRef} style={{
      borderRadius: 12, overflow: 'hidden',
      background: card, border: `1px solid ${borderStrong}`,
      boxShadow: dark
        ? '0 30px 60px -20px rgba(0,0,0,0.7)'
        : '0 30px 60px -20px rgba(26,22,18,0.18), 0 2px 8px -2px rgba(26,22,18,0.06)',
      position: 'relative',
      height: '100%', display: 'flex', flexDirection: 'column',
    }}>
      {/* Chrome bar */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '7px 12px',
        borderBottom: `1px solid ${border}`,
        background: dark ? 'rgba(240,237,230,0.02)' : 'rgba(26,22,18,0.015)',
        flexShrink: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ display: 'flex', gap: 5 }}>
            {['#FF5F57','#FEBC2E','#28C840'].map(c =>
              <span key={c} style={{ width: 8, height: 8, borderRadius: '50%', background: c }}/>
            )}
          </div>
          <span style={{
            fontFamily: 'JetBrains Mono, monospace', fontSize: 9.5, color: ink2, whiteSpace: 'nowrap',
          }}>
            <span style={{ color: ink3 }}>synapse.app /</span> explore / sources
          </span>
        </div>
        <div style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
          <span style={{
            fontFamily: 'JetBrains Mono, monospace', fontSize: 8,
            color: ink3, padding: '1px 6px', borderRadius: 3, border: `1px solid ${border}`,
          }}>Sources &middot; {SOURCES.length}</span>
          <span style={{
            fontFamily: 'JetBrains Mono, monospace', fontSize: 8,
            color: ANCHOR_COLOR, padding: '1px 6px', borderRadius: 3, border: `1px solid ${border}`,
          }}>Anchors</span>
          <span style={{
            fontFamily: 'JetBrains Mono, monospace', fontSize: 8,
            color: SKILL_COLOR, padding: '1px 6px', borderRadius: 3, border: `1px solid ${border}`,
          }}>Skills</span>
          <span style={{
            fontFamily: 'JetBrains Mono, monospace', fontSize: 8.5, color: accent, marginLeft: 2,
          }}>&bull; LIVE</span>
        </div>
      </div>

      {/* Interaction hint - shows after animation completes */}
      {animDone && !userInteracted && (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
          padding: '5px 12px',
          background: dark ? 'rgba(240,237,230,0.03)' : 'rgba(26,22,18,0.025)',
          borderBottom: `1px solid ${border}`,
          flexShrink: 0,
        }}>
          <span style={{
            width: 5, height: 5, borderRadius: '50%', background: accent,
            animation: 'lp-pulse-dot 2s ease-in-out infinite',
          }}/>
          <span style={{
            fontFamily: 'JetBrains Mono, monospace', fontSize: 9,
            color: ink2, letterSpacing: '0.06em',
          }}>
            Hover over other nodes to see how your knowledge is connected
          </span>
        </div>
      )}

      {/* Graph */}
      <div style={{
        position: 'relative', flex: 1, minHeight: 0,
        background: dark ? 'rgba(240,237,230,0.01)' : 'rgba(250,248,244,0.5)',
        overflow: 'hidden',
      }}>
        <svg width="100%" height="100%" viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="xMidYMid meet"
          style={{ display: 'block', position: 'absolute', inset: 0 }}>
          <defs>
            <pattern id="pw-grid" width="24" height="24" patternUnits="userSpaceOnUse">
              <path d="M 24 0 L 0 0 0 24" fill="none"
                stroke={dark ? 'rgba(240,237,230,0.03)' : 'rgba(26,22,18,0.03)'} strokeWidth="0.5"/>
            </pattern>
            {SOURCES.map((s, i) => (
              <radialGradient key={i} id={`sg-${i}`}>
                <stop offset="0%" stopColor={s.color} stopOpacity="0.08"/>
                <stop offset="100%" stopColor={s.color} stopOpacity="0"/>
              </radialGradient>
            ))}
          </defs>

          <rect width={W} height={H} fill="url(#pw-grid)"/>

          {/* Source connection edges */}
          {SOURCE_EDGES.map(([a, b], ei) => {
            const sa = SOURCES[a]!, sb = SOURCES[b]!
            const len = Math.hypot((sb.x - sa.x) * W, (sb.y - sa.y) * H)
            const drawT = Math.min(1, Math.max(0, edgeP * 1.3 - (ei * 0.05)))
            const lit = highlightedEdges.has(ei)
            const litColor = hovered?.kind === 'source' ? SOURCES[hovered.idx]!.color
              : hovered?.kind === 'hex' ? (HEXAGONS[hovered.idx]!.kind === 'anchor' ? ANCHOR_COLOR : SKILL_COLOR)
              : ink3
            return (
              <line key={`e-${ei}`}
                x1={sa.x * W} y1={sa.y * H} x2={sb.x * W} y2={sb.y * H}
                stroke={lit ? `${litColor}88` : (dark ? 'rgba(240,237,230,0.07)' : 'rgba(26,22,18,0.05)')}
                strokeWidth={lit ? 1.4 : 0.6}
                strokeDasharray={lit ? 'none' : '4 4'}
                strokeDashoffset={len * (1 - drawT)}
                style={{ transition: 'stroke 250ms, stroke-width 250ms' }}
              />
            )
          })}

          {/* Hex connector lines (always shown subtly, highlighted on hover) */}
          {HEXAGONS.map((hex, hi) => {
            const hx = hex.x * W, hy = hex.y * H
            const lit = highlightedHexes.has(hi)
            const col = hex.kind === 'anchor' ? ANCHOR_COLOR : SKILL_COLOR
            return hex.connectedSources.map(si => {
              const s = SOURCES[si]
              if (!s) return null
              return (
                <line key={`hl-${hi}-${si}`}
                  x1={hx} y1={hy} x2={s.x * W} y2={s.y * H}
                  stroke={lit ? `${col}55` : `${col}12`}
                  strokeWidth={lit ? 0.8 : 0.4}
                  strokeDasharray="3 3"
                  opacity={hex.kind === 'anchor' ? anchorHexP : skillHexP}
                  style={{ transition: 'stroke 250ms, stroke-width 250ms' }}
                />
              )
            })
          })}

          {/* Source clusters */}
          {SOURCES.map((src, si) => {
            const cx = src.x * W, cy = src.y * H
            const dots = clusterDots(src, W, H)
            const appear = Math.min(1, Math.max(0, clusterP * 1.4 - (si * 0.07)))
            const lit = highlightedSources.has(si)
            const dimmed = hasHighlight && !lit

            return (
              <g key={si}
                opacity={appear * (dimmed ? 0.2 : 1)}
                style={{ transition: 'opacity 250ms', cursor: 'pointer' }}
                onMouseEnter={() => onHover({ kind: 'source', idx: si })}
                onMouseLeave={onLeave}
              >
                <circle cx={cx} cy={cy} r={src.r + 14} fill={`url(#sg-${si})`}/>
                {[1, 2, 3].filter(r => r * 9 < src.r).map(ring => (
                  <circle key={ring} cx={cx} cy={cy} r={ring * 9}
                    fill="none" stroke={`${src.color}${lit ? '28' : '10'}`} strokeWidth="0.5"
                    style={{ transition: 'stroke 250ms' }}/>
                ))}
                {dots.map((d, di) => (
                  <circle key={di} cx={d.cx} cy={d.cy} r={d.r}
                    fill={`${src.color}${di === 0 ? 'bb' : '50'}`}
                    stroke={di === 0 ? src.color : `${src.color}28`}
                    strokeWidth={di === 0 ? 1.2 : 0.4}
                  />
                ))}
                {lit && (
                  <circle cx={cx} cy={cy} r={src.r + 5}
                    fill="none" stroke={src.color} strokeWidth={1.2}
                    strokeDasharray="5 3" opacity={0.45}
                    style={{ animation: 'lp-glow-breathe 2s ease-in-out infinite' }}
                  />
                )}
                <g opacity={labelP} style={{ transition: 'opacity 300ms' }}>
                  <text x={cx} y={cy + src.r + 16} textAnchor="middle"
                    fill={lit ? ink : (dimmed ? ink3 : ink2)}
                    fontSize={10} fontWeight={lit ? 700 : 500}
                    fontFamily="DM Sans, sans-serif"
                    style={{ pointerEvents: 'none', userSelect: 'none', transition: 'fill 250ms' }}>
                    {src.label}
                  </text>
                  <text x={cx} y={cy + src.r + 27} textAnchor="middle" fill={ink3}
                    fontSize={8} fontFamily="JetBrains Mono, monospace" letterSpacing="0.06em"
                    style={{ pointerEvents: 'none', userSelect: 'none' }}>
                    {src.entityCount} &middot; {src.type.toUpperCase()}
                  </text>
                </g>
              </g>
            )
          })}

          {/* Hexagons: anchors (amber) + skills (teal) */}
          {HEXAGONS.map((hex, hi) => {
            const hx = hex.x * W, hy = hex.y * H
            const col = hex.kind === 'anchor' ? ANCHOR_COLOR : SKILL_COLOR
            const lit = highlightedHexes.has(hi)
            const dimmed = hasHighlight && !lit
            const isDirectHover = hovered?.kind === 'hex' && hovered.idx === hi
            const sz = isDirectHover ? 16 : 13

            return (
              <g key={`hex-${hi}`}
                opacity={(hex.kind === 'anchor' ? anchorHexP : skillHexP) * (dimmed ? 0.25 : 1)}
                style={{ transition: 'opacity 250ms', cursor: 'pointer' }}
                onMouseEnter={() => onHover({ kind: 'hex', idx: hi })}
                onMouseLeave={onLeave}
              >
                {/* Glow on direct hover */}
                {isDirectHover && (
                  <circle cx={hx} cy={hy} r={sz + 8} fill={`${col}10`} stroke={`${col}30`} strokeWidth={0.8}
                    style={{ animation: 'lp-glow-breathe 2s ease-in-out infinite' }}/>
                )}
                <path d={hexPath(hx, hy, sz)}
                  fill={lit ? `${col}18` : 'transparent'}
                  stroke={lit ? col : `${col}44`}
                  strokeWidth={isDirectHover ? 2 : (lit ? 1.2 : 0.7)}
                  style={{ transition: 'stroke 250ms, fill 250ms, stroke-width 250ms' }}
                />
                {/* Icon inside: anchor=diamond, skill=gear */}
                {hex.kind === 'anchor' ? (
                  <path d={`M${hx} ${hy - 4} L${hx + 3} ${hy} L${hx} ${hy + 4} L${hx - 3} ${hy} Z`}
                    fill="none" stroke={lit ? col : `${col}66`} strokeWidth={0.8}
                    style={{ transition: 'stroke 250ms' }}/>
                ) : (
                  <circle cx={hx} cy={hy} r={3} fill="none" stroke={lit ? col : `${col}66`} strokeWidth={0.8}
                    style={{ transition: 'stroke 250ms' }}/>
                )}
                <text x={hx} y={hy + sz + 11} textAnchor="middle"
                  fill={lit ? col : ink3} fontSize={8}
                  fontFamily="JetBrains Mono, monospace" fontWeight={600}
                  letterSpacing="0.06em"
                  style={{ pointerEvents: 'none', userSelect: 'none', transition: 'fill 250ms' }}>
                  {hex.label.toUpperCase()}
                </text>
              </g>
            )
          })}
        </svg>

        {/* Bottom status */}
        <div style={{
          position: 'absolute', bottom: 0, left: 0, right: 0,
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          padding: '4px 10px',
          background: dark ? 'rgba(11,10,7,0.7)' : 'rgba(255,255,255,0.75)',
          backdropFilter: 'blur(6px)',
          borderTop: `1px solid ${border}`,
        }}>
          <span style={{
            fontFamily: 'JetBrains Mono, monospace', fontSize: 7.5,
            color: ink3, letterSpacing: '0.08em',
          }}>{SOURCES.length} SOURCES &middot; 105 ENTITIES &middot; {HEXAGONS.filter(h => h.kind === 'anchor').length} ANCHORS &middot; {HEXAGONS.filter(h => h.kind === 'skill').length} SKILLS</span>
          <span style={{
            fontFamily: 'JetBrains Mono, monospace', fontSize: 7.5,
            color: ink3, letterSpacing: '0.08em',
          }}>SOURCES VIEW</span>
        </div>
      </div>
    </div>
  )
}
