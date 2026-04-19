import { useState } from 'react'
import { FlameMark } from './shared/FlameMark'

interface LandingNavProps {
  ink: string
  ink2: string
  border: string
  accent: string
  dark: boolean
  onSignIn: () => void
}

const NAV_LINKS = [
  { label: 'Product', href: '#product' },
  { label: 'Method', href: '#method' },
  { label: 'For agents', href: '#agents' },
  { label: 'Changelog', href: '#changelog' },
]

export function LandingNav({ ink, ink2, border, accent, dark, onSignIn }: LandingNavProps) {
  const [hoveredLink, setHoveredLink] = useState<string | null>(null)

  return (
    <nav style={{
      position: 'sticky', top: 0, zIndex: 50,
      display: 'flex', alignItems: 'center',
      padding: '0 clamp(24px, 5vw, 64px)',
      height: 61,
      borderBottom: `1px solid ${border}`,
      background: dark ? 'rgba(11,10,7,0.80)' : 'rgba(250,250,247,0.80)',
      backdropFilter: 'blur(16px)',
      WebkitBackdropFilter: 'blur(16px)',
    }}>
      {/* Left: flame mark + wordmark + version badge */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <FlameMark size={18} color={accent} />
        <span style={{
          fontFamily: 'Cabinet Grotesk, sans-serif', fontWeight: 900,
          fontSize: 18, letterSpacing: '-0.02em', color: ink,
        }}>synapse</span>
        <div style={{
          marginLeft: 6,
          fontFamily: 'JetBrains Mono, monospace', fontSize: 9,
          padding: '2px 7px', borderRadius: 20,
          color: accent, letterSpacing: '0.1em', textTransform: 'uppercase',
          background: `${accent}0c`,
          border: `1px solid ${accent}25`,
        }}>beta</div>
      </div>

      {/* Center: nav links with pill hover */}
      <div style={{
        flex: 1,
        display: 'flex', justifyContent: 'center', gap: 4,
      }}>
        {NAV_LINKS.map(link => {
          const isHovered = hoveredLink === link.label
          return (
            <a
              key={link.label}
              href={link.href}
              onMouseEnter={() => setHoveredLink(link.label)}
              onMouseLeave={() => setHoveredLink(null)}
              style={{
                padding: '6px 14px',
                borderRadius: 20,
                fontSize: 13, fontWeight: 500,
                color: isHovered ? ink : ink2,
                background: isHovered
                  ? (dark ? 'rgba(240,237,230,0.06)' : 'rgba(26,22,18,0.04)')
                  : 'transparent',
                textDecoration: 'none',
                fontFamily: 'DM Sans, sans-serif',
                transition: 'all 180ms',
                cursor: 'pointer',
                whiteSpace: 'nowrap',
              }}
            >
              {link.label}
            </a>
          )
        })}
      </div>

      {/* Right: sign in + CTA */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button onClick={onSignIn} style={{
          padding: '6px 14px', borderRadius: 20,
          fontSize: 13, fontWeight: 500, color: ink2,
          background: 'transparent', border: 'none',
          fontFamily: 'DM Sans, sans-serif',
          cursor: 'pointer', transition: 'color 180ms',
        }}>Sign in</button>

        <button onClick={onSignIn} style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          padding: '7px 16px', borderRadius: 20,
          background: accent, color: '#fff',
          fontSize: 12.5, fontWeight: 600,
          fontFamily: 'DM Sans, sans-serif',
          border: 'none', cursor: 'pointer',
          boxShadow: `0 2px 10px -4px ${accent}`,
          transition: 'transform 150ms, box-shadow 150ms',
        }}>
          <span>Get started</span>
          <svg width={12} height={12} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 8 h10 M9 4 l4 4 -4 4"/>
          </svg>
        </button>
      </div>
    </nav>
  )
}
