import { useState } from 'react'
import { FlameMark } from './shared/FlameMark'
import { SocialGlyph } from './shared/SocialGlyph'

interface LandingClosingProps {
  accent: string
  displayFont: string
  onSignIn: () => void
}

/* ─── colour tokens ─── */
const ink2 = 'rgba(255,255,255,0.62)'
const ink3 = 'rgba(255,255,255,0.34)'
const mono = 'JetBrains Mono, monospace'

/* ─── TrustRow ─── */
function TrustRow() {
  const items = ['Free tier, no card', 'Ingest in minutes', 'MCP-ready']
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12,
      fontFamily: mono, fontSize: 11, color: ink3,
      letterSpacing: '0.08em', textTransform: 'uppercase' as const,
    }}>
      {items.map((item, i) => (
        <span key={item} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {i > 0 && (
            <span style={{
              display: 'inline-block', width: 3, height: 3, borderRadius: '50%',
              background: ink3,
            }} />
          )}
          {item}
        </span>
      ))}
    </div>
  )
}

/* ─── SocialButton ─── */
function SocialButton({ kind, accent }: { kind: string; accent: string }) {
  const [hovered, setHovered] = useState(false)
  return (
    <a
      href="#"
      aria-label={kind}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        width: 32, height: 32, borderRadius: '50%',
        border: `1px solid ${hovered ? accent : 'rgba(26,22,18,0.15)'}`,
        color: hovered ? accent : '#9A9087',
        background: 'transparent',
        transition: 'border-color 0.18s ease, color 0.18s ease',
        cursor: 'pointer', textDecoration: 'none',
      }}
    >
      <SocialGlyph kind={kind} />
    </a>
  )
}

/* ─── FinalCTA ─── */
function FinalCTA({ accent, displayFont, onSignIn }: LandingClosingProps) {
  return (
    <section style={{ background: '#0B0A07' }}>
      <div style={{
        maxWidth: 1280, margin: '0 auto',
        padding: 'clamp(28px, 4vw, 56px) clamp(24px, 6vw, 80px) clamp(56px, 6vw, 88px)',
        textAlign: 'center' as const,
        display: 'flex', flexDirection: 'column' as const, alignItems: 'center', gap: 36,
      }}>
        {/* Manifesto quote */}
        <div style={{ maxWidth: 720 }}>
          <p style={{
            fontFamily: `${displayFont}, serif`,
            fontStyle: 'italic',
            fontSize: 'clamp(22px, 2.4vw, 32px)',
            lineHeight: 1.5,
            color: ink2,
            margin: 0,
          }}>
            {'\u201C'}The raw material of your best thinking already exists. We built the infrastructure to remember it{'\u00A0'}{'\u2014'}{'\u00A0'}for you, and for every agent you work with.{'\u201D'}
          </p>
          <p style={{
            fontFamily: mono, fontSize: 11, color: ink3,
            letterSpacing: '0.10em', textTransform: 'uppercase' as const,
            marginTop: 16, marginBottom: 0,
          }}>
            {'\u2014'} Synapse founding note
          </p>
        </div>

        {/* Subline */}
        <p style={{
          fontSize: 'clamp(16px, 1.3vw, 19px)',
          lineHeight: 1.65,
          color: ink2,
          maxWidth: 560,
          margin: 0,
        }}>
          Ingest your meetings, docs, and calls. Query your graph. Give your agents a real memory. Free to start{'\u00A0'}{'\u2014'}{'\u00A0'}your workspace, in minutes.
        </p>

        {/* CTA button */}
        <button onClick={onSignIn} style={{
          display: 'inline-flex', alignItems: 'center', gap: 10,
          padding: '16px 36px', borderRadius: 999,
          background: accent, color: '#fff', border: 'none',
          fontSize: 16, fontWeight: 600, cursor: 'pointer',
          fontFamily: 'DM Sans, sans-serif',
          boxShadow: '0 24px 64px -24px rgba(217,119,87,0.4)',
          transition: 'transform 150ms, box-shadow 150ms',
        }}>
          Start your graph
          <svg width={16} height={16} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 8 h10 M9 4 l4 4 -4 4"/>
          </svg>
        </button>

        {/* Trust row */}
        <TrustRow />
      </div>
    </section>
  )
}

/* ─── Footer ─── */
function Footer({ accent }: { accent: string }) {
  return (
    <footer style={{
      background: '#F7F3EC', color: '#1A1612',
      borderTop: '1px solid rgba(26,22,18,0.08)',
    }}>
      <div style={{
        maxWidth: 1280, margin: '0 auto',
        padding: 'clamp(40px, 4vw, 56px) clamp(24px, 6vw, 80px) 28px',
        display: 'flex', flexDirection: 'column' as const, gap: 32,
      }}>
        {/* Brand row */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          flexWrap: 'wrap' as const, gap: 16,
        }}>
          {/* Left: brand */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <FlameMark size={16} />
            <span style={{ fontWeight: 700, fontSize: 17, letterSpacing: '-0.01em' }}>
              Synapse
            </span>
            <span style={{
              fontFamily: mono, fontSize: 11, color: accent,
              letterSpacing: '0.04em',
            }}>
              {'\u2014'} Knowledge graph {'\u00B7'} Infrastructure for thinking
            </span>
          </div>

          {/* Right: social icons */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {(['x', 'github', 'linkedin', 'rss'] as const).map((kind) => (
              <SocialButton key={kind} kind={kind} accent={accent} />
            ))}
          </div>
        </div>

        {/* Fine print strip */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          flexWrap: 'wrap' as const, gap: 12,
          fontFamily: mono, fontSize: 11, color: '#9A9087',
          letterSpacing: '0.06em', textTransform: 'uppercase' as const,
        }}>
          {/* Left */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span>{'\u00A9'} 2026 SYNAPSE LABS, INC.</span>
            <span style={{
              display: 'inline-block', width: 3, height: 3,
              borderRadius: '50%', background: '#9A9087',
            }} />
            <span>MADE FOR PEOPLE WHO THINK</span>
          </div>

          {/* Right */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            {/* Green pulse dot */}
            <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{
                display: 'inline-block', width: 6, height: 6, borderRadius: '50%',
                background: '#22c55e',
                boxShadow: '0 0 6px rgba(34,197,94,0.5)',
                animation: 'pulse-dot 2s ease-in-out infinite',
              }} />
              ALL SYSTEMS OPERATIONAL
            </span>
            <span style={{
              display: 'inline-block', width: 3, height: 3,
              borderRadius: '50%', background: '#9A9087',
            }} />
            <span>V 0.8 {'\u00B7'} BETA</span>
          </div>
        </div>
      </div>

      {/* Pulse animation */}
      <style>{`
        @keyframes pulse-dot {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.4; }
        }
      `}</style>
    </footer>
  )
}

/* ─── Main export ─── */
export function LandingClosing({ accent, displayFont, onSignIn }: LandingClosingProps) {
  return (
    <>
      <FinalCTA accent={accent} displayFont={displayFont} onSignIn={onSignIn} />
      <Footer accent={accent} />
    </>
  )
}
