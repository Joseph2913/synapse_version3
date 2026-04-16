import { SynapseLogo } from '../shared/SynapseLogo'
import { PAGES } from './onboardingMockData'

interface Step0WelcomeHeroProps {
  onSkipAll: () => void
}

export function Step0WelcomeHero({ onSkipAll }: Step0WelcomeHeroProps) {
  return (
    <div
      className="relative flex flex-col min-h-screen"
      style={{
        background: 'linear-gradient(165deg, #1a1a1a 0%, #2a1a14 50%, #1a1a1a 100%)',
      }}
    >
      {/* Skip link */}
      <div className="absolute top-6 right-8">
        <button
          onClick={onSkipAll}
          className="text-sm font-semibold transition-colors duration-150"
          style={{ color: 'rgba(255,255,255,0.4)' }}
          onMouseEnter={e => {
            ;(e.currentTarget as HTMLButtonElement).style.color = 'rgba(255,255,255,0.75)'
          }}
          onMouseLeave={e => {
            ;(e.currentTarget as HTMLButtonElement).style.color = 'rgba(255,255,255,0.4)'
          }}
        >
          Skip onboarding
        </button>
      </div>

      {/* Centered content */}
      <div className="flex flex-col items-center justify-center flex-1 px-6 py-24 text-center">
        {/* Logo */}
        <div
          className="flex items-center justify-center w-16 h-16 rounded-2xl mb-8"
          style={{
            background: 'rgba(214,58,0,0.15)',
            boxShadow: '0 0 40px rgba(214,58,0,0.35), 0 0 80px rgba(214,58,0,0.15)',
          }}
        >
          <SynapseLogo size={36} />
        </div>

        {/* Heading */}
        <h1
          className="font-extrabold leading-tight mb-4"
          style={{ fontSize: '36px', color: '#ffffff' }}
        >
          Welcome to Synapse
        </h1>

        {/* Tagline */}
        <p
          className="mb-10 leading-relaxed"
          style={{
            fontSize: '16px',
            color: 'rgba(255,255,255,0.5)',
            maxWidth: '440px',
          }}
        >
          Your personal knowledge graph. Ingest anything, extract what matters, and chat with everything you know.
        </p>

        {/* Page pills */}
        <div className="flex flex-wrap justify-center gap-2 mb-12" style={{ maxWidth: '520px' }}>
          {PAGES.map(page => {
            const Icon = page.icon
            return (
              <div
                key={page.id}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-full"
                style={{
                  background: 'rgba(255,255,255,0.07)',
                  border: '1px solid rgba(255,255,255,0.1)',
                  color: 'rgba(255,255,255,0.65)',
                  fontSize: '13px',
                  fontWeight: 600,
                }}
              >
                <Icon size={13} style={{ color: 'rgba(255,255,255,0.45)' }} />
                <span>{page.name}</span>
              </div>
            )
          })}
        </div>

        {/* Scroll cue */}
        <p
          className="text-sm font-semibold"
          style={{
            color: 'rgba(255,255,255,0.3)',
            animation: 'bounce 2s infinite',
          }}
        >
          Scroll to preview each page ↓
        </p>
      </div>

      {/* Tailwind bounce keyframes are built-in via animate-bounce — inject inline for the custom style */}
      <style>{`
        @keyframes bounce {
          0%, 100% { transform: translateY(0); }
          50% { transform: translateY(6px); }
        }
      `}</style>
    </div>
  )
}
