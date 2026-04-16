import { type ReactNode } from 'react'
import { SynapseLogo } from '../shared/SynapseLogo'

interface OnboardingStepLayoutProps {
  stepNumber: number
  totalSteps: number
  title: string
  subtitle: string
  maxWidth?: number
  children: ReactNode
  onSkipAll: () => void
  onSkip: () => void
  onNext: () => void
  nextLabel?: string
  skipLabel?: string
  nextDisabled?: boolean
}

export function OnboardingStepLayout({
  stepNumber,
  totalSteps,
  title,
  subtitle,
  maxWidth = 600,
  children,
  onSkipAll,
  onSkip,
  onNext,
  nextLabel = 'Continue',
  skipLabel = 'Skip for now',
  nextDisabled = false,
}: OnboardingStepLayoutProps) {
  return (
    <div
      className="fixed inset-0 z-50 overflow-y-auto"
      style={{ background: 'var(--color-bg-content)' }}
    >
      {/* Top bar */}
      <div className="flex items-center justify-between px-6 py-4">
        <SynapseLogo size={28} />
        <button
          onClick={onSkipAll}
          className="font-body font-semibold text-[13px] transition-colors duration-150 hover:opacity-80"
          style={{ color: 'var(--color-text-secondary)' }}
        >
          Skip onboarding
        </button>
      </div>

      {/* Step progress indicator */}
      <div className="flex items-center justify-center gap-2 mt-2 mb-8">
        {Array.from({ length: totalSteps }, (_, i) => {
          const isActive = i + 1 === stepNumber
          return (
            <div
              key={i}
              className="rounded-full transition-all duration-200"
              style={{
                width: isActive ? 32 : 16,
                height: 4,
                background: isActive
                  ? 'var(--color-accent-500)'
                  : 'var(--border-subtle)',
              }}
            />
          )
        })}
      </div>

      {/* Centered card */}
      <div className="flex justify-center px-4 pb-12">
        <div
          className="w-full rounded-2xl overflow-hidden"
          style={{
            maxWidth,
            background: 'var(--color-bg-card)',
            border: '1px solid var(--border-subtle)',
            boxShadow: '0 2px 12px rgba(0,0,0,0.06)',
          }}
        >
          {/* Card header */}
          <div style={{ padding: '36px 32px 24px' }}>
            <h2
              className="font-display font-bold mb-2"
              style={{
                fontSize: 20,
                color: 'var(--color-text-primary)',
                lineHeight: '1.3',
              }}
            >
              {title}
            </h2>
            <p
              className="font-body"
              style={{
                fontSize: 13,
                color: 'var(--color-text-secondary)',
                lineHeight: '1.5',
              }}
            >
              {subtitle}
            </p>
          </div>

          {/* Card content */}
          <div style={{ padding: '0 32px 8px' }}>
            {children}
          </div>

          {/* Bottom button row */}
          <div
            className="flex items-center justify-between"
            style={{
              padding: '16px 32px',
              borderTop: '1px solid var(--border-subtle)',
              marginTop: 16,
            }}
          >
            <button
              onClick={onSkip}
              className="font-body font-semibold rounded-full transition-colors duration-150 hover:opacity-80"
              style={{
                fontSize: 13,
                padding: '7px 18px',
                background: 'transparent',
                border: '1px solid var(--border-subtle)',
                color: 'var(--color-text-secondary)',
                cursor: 'pointer',
              }}
            >
              {skipLabel}
            </button>
            <button
              onClick={onNext}
              disabled={nextDisabled}
              className="font-body font-semibold rounded-full transition-all duration-150"
              style={{
                fontSize: 13,
                padding: '7px 22px',
                background: nextDisabled ? 'var(--border-subtle)' : 'var(--color-accent-500)',
                color: nextDisabled ? 'var(--color-text-secondary)' : '#ffffff',
                border: 'none',
                cursor: nextDisabled ? 'not-allowed' : 'pointer',
                opacity: nextDisabled ? 0.6 : 1,
              }}
            >
              {nextLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
