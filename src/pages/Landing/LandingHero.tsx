import { ProductWindow } from './ProductWindow'

interface LandingHeroProps {
  mounted: boolean
  accent: string
  ink: string
  ink2: string
  ink3: string
  border: string
  borderStrong: string
  card: string
  surface: string
  displayFont: string
  headline: { main: string; emph: string }
  dark: boolean
  onSignIn: () => void
}

export function LandingHero({
  mounted, accent, ink, ink2, ink3, border, borderStrong, card, surface, displayFont, headline, dark, onSignIn,
}: LandingHeroProps) {

  const at = (delayMs: number): React.CSSProperties => ({
    opacity: mounted ? 1 : 0,
    transform: mounted ? 'translateY(0)' : 'translateY(14px)',
    transition: `opacity 700ms cubic-bezier(.2,.8,.2,1) ${delayMs}ms, transform 700ms cubic-bezier(.2,.8,.2,1) ${delayMs}ms`,
  })

  return (
    <section className="lp-hero" style={{
      position: 'relative', zIndex: 2,
      height: 'calc(100vh - 61px)',
      overflow: 'hidden',
      padding: 'clamp(12px, 2vh, 24px) clamp(24px, 5vw, 64px) clamp(8px, 1.5vh, 16px)',
      boxSizing: 'border-box',
    }}>
      <div className="lp-hero-grid" style={{
        maxWidth: 1400, width: '100%', height: '100%', margin: '0 auto',
        display: 'grid',
        gridTemplateColumns: '0.82fr 1.18fr',
        gridTemplateRows: 'auto 1fr',
        gap: '0 clamp(24px, 3vw, 48px)',
      }}>

        {/* Eyebrow - spans full width */}
        <div style={{
          ...at(0), gridColumn: '1 / -1',
          display: 'flex', alignItems: 'center', gap: 14,
          marginBottom: 'clamp(6px, 1vh, 12px)',
        }}>
          <span style={{
            fontFamily: 'JetBrains Mono, monospace', fontSize: 11,
            color: accent, letterSpacing: '0.16em', textTransform: 'uppercase',
          }}>&mdash; Knowledge graph &middot; Infrastructure for thinking</span>
          <span style={{ flex: 1, height: 1, background: border }}/>
          <span style={{
            fontFamily: 'JetBrains Mono, monospace', fontSize: 10,
            color: ink3, letterSpacing: '0.14em',
          }}>FIG. 01</span>
        </div>

        {/* Left: headline + lede + CTA */}
        <div style={{
          ...at(120),
          display: 'flex', flexDirection: 'column', justifyContent: 'center',
          minHeight: 0, overflow: 'hidden',
        }}>
          <h1 style={{
            fontFamily: `${displayFont}, sans-serif`, fontWeight: 800,
            fontSize: 'clamp(32px, 3.8vw, 56px)', lineHeight: 0.96,
            letterSpacing: '-0.035em', margin: 0, color: ink,
          }}>
            {headline.main}<br/>
            <em style={{
              fontFamily: 'Instrument Serif, Georgia, serif',
              fontStyle: 'italic', fontWeight: 400,
              color: accent, letterSpacing: '-0.02em',
            }}>{headline.emph}</em>
          </h1>

          <p style={{
            fontSize: 'clamp(13px, 1vw, 15px)', lineHeight: 1.5,
            color: ink2, margin: 'clamp(10px, 1.5vh, 20px) 0 0', maxWidth: 420,
          }}>
            Synapse ingests your meetings, videos, documents, and notes &mdash; extracts
            every entity and relationship &mdash; and assembles them into a living
            knowledge graph. Queryable by you. Readable by your agents.
          </p>

          <div style={{ display: 'flex', gap: 10, marginTop: 'clamp(10px, 1.5vh, 20px)' }}>
            <button onClick={onSignIn} style={{
              padding: '9px 18px', borderRadius: 10, border: 'none',
              background: ink, color: surface,
              fontSize: 13, fontWeight: 600, cursor: 'pointer',
              fontFamily: 'DM Sans, sans-serif',
            }}>Start free &rarr;</button>
            <button style={{
              padding: '9px 16px', borderRadius: 10,
              background: 'transparent', color: ink, border: `1px solid ${borderStrong}`,
              fontSize: 13, fontWeight: 500, cursor: 'pointer',
            }}>&#9654; Watch the 2-min</button>
          </div>
        </div>

        {/* Right: product window - height-capped to ~65% of viewport content area */}
        <div className="lp-hero-product" style={{
          ...at(300),
          overflow: 'hidden',
          height: 'clamp(420px, 62vh, 660px)',
          alignSelf: 'center',
        }}>
          <ProductWindow
            accent={accent} ink={ink} ink2={ink2} ink3={ink3}
            border={border} borderStrong={borderStrong} card={card}
            dark={dark} mounted={mounted}
          />
        </div>
      </div>
    </section>
  )
}
