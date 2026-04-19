import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../../services/supabase'
import { LandingNav } from './LandingNav'
import { LandingHero } from './LandingHero'
import { LandingHowItWorks } from './LandingHowItWorks'
import { LandingAnatomy } from './LandingAnatomy'
import { LandingAgents } from './LandingAgents'
import { LandingClosing } from './LandingClosing'
import { HEADLINES } from './landing-data'
import './landing.css'

const ACCENT = '#D63A00'
const SURFACE = '#FAFAF7'
const DISPLAY_FONT = 'Cabinet Grotesk'

export function LandingPage() {
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    requestAnimationFrame(() => setMounted(true))
  }, [])

  const handleSignIn = useCallback(async () => {
    await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.origin },
    })
  }, [])

  const dark = false
  const surface = SURFACE
  const ink = '#1A1612'
  const ink2 = '#5A5148'
  const ink3 = '#9A9087'
  const border = 'rgba(26,22,18,0.10)'
  const borderStrong = 'rgba(26,22,18,0.18)'
  const card = '#FFFFFF'
  const accent = ACCENT
  const gridAlpha = 0.06

  const headline = HEADLINES['second-brain'] ?? { main: 'Your second brain,', emph: 'compounding.' }

  return (
    <div style={{
      minHeight: '100vh',
      background: surface,
      color: ink,
      fontFamily: 'DM Sans, -apple-system, sans-serif',
      position: 'relative',
    }}>
      {/* Medium grid background */}
      <svg width="100%" height="100%" style={{ position: 'fixed', inset: 0, zIndex: 0, pointerEvents: 'none' }}>
        <defs>
          <pattern id="unified-grid" width="32" height="32" patternUnits="userSpaceOnUse">
            <path d="M 32 0 L 0 0 0 32" fill="none" stroke={`rgba(26,22,18,${gridAlpha})`} strokeWidth="0.5"/>
          </pattern>
          <pattern id="unified-grid-lg" width="128" height="128" patternUnits="userSpaceOnUse">
            <path d="M 128 0 L 0 0 0 128" fill="none" stroke={`rgba(26,22,18,${gridAlpha * 1.6})`} strokeWidth="0.5"/>
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#unified-grid)" />
        <rect width="100%" height="100%" fill="url(#unified-grid-lg)" />
      </svg>

      <LandingNav ink={ink} ink2={ink2} border={border} accent={accent} dark={dark} onSignIn={handleSignIn} />

      <LandingHero
        mounted={mounted}
        accent={accent}
        ink={ink}
        ink2={ink2}
        ink3={ink3}
        border={border}
        borderStrong={borderStrong}
        card={card}
        surface={surface}
        displayFont={DISPLAY_FONT}
        headline={headline}
        dark={dark}
        onSignIn={handleSignIn}
      />

      <LandingHowItWorks accent={accent} displayFont={DISPLAY_FONT} />

      <LandingAnatomy
        accent={accent}
        surface={surface}
        ink={ink}
        ink2={ink2}
        ink3={ink3}
        border={border}
        borderStrong={borderStrong}
        card={card}
        dark={dark}
        displayFont={DISPLAY_FONT}
      />

      <LandingAgents accent={accent} displayFont={DISPLAY_FONT} dark={dark} />

      <LandingClosing accent={accent} displayFont={DISPLAY_FONT} onSignIn={handleSignIn} />
    </div>
  )
}
