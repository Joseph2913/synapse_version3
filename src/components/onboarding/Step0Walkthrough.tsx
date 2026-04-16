import { useRef, useCallback } from 'react'
import { Step0WelcomeHero } from './Step0WelcomeHero'
import { Step0PagePreview } from './Step0PagePreview'
import { PAGES } from './onboardingMockData'
import {
  MockHomePage,
  MockExplorePage,
  MockAskPage,
  MockSourcesPage,
  MockSignalsPage,
  MockCouncilPage,
} from './Step0MockPages'

const MOCK_COMPONENTS = [
  MockHomePage,
  MockExplorePage,
  MockAskPage,
  MockSourcesPage,
  MockSignalsPage,
  MockCouncilPage,
]

interface Step0WalkthroughProps {
  onComplete: () => void
  onSkipAll: () => void
}

export function Step0Walkthrough({ onComplete, onSkipAll }: Step0WalkthroughProps) {
  const heroRef = useRef<HTMLDivElement | null>(null)
  const pageRefs = useRef<Array<HTMLDivElement | null>>([])

  const scrollToPage = useCallback((index: number) => {
    if (index === -1) {
      heroRef.current?.scrollIntoView({ behavior: 'smooth' })
    } else {
      pageRefs.current[index]?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [])

  return (
    <div
      className="fixed inset-0 z-50 overflow-y-auto"
      style={{ background: '#111' }}
    >
      {/* Dot nav — fixed right side */}
      <div
        className="fixed right-5 top-1/2 -translate-y-1/2 flex flex-col gap-2"
        style={{ zIndex: 60 }}
      >
        {/* Welcome dot */}
        <button
          onClick={() => scrollToPage(-1)}
          title="Welcome"
          style={{
            width: '10px',
            height: '10px',
            borderRadius: '50%',
            background: 'rgba(255,255,255,0.15)',
            border: '1px solid rgba(255,255,255,0.2)',
            padding: 0,
            cursor: 'pointer',
            transition: 'background 0.15s ease, border-color 0.15s ease',
          }}
          onMouseEnter={e => {
            const btn = e.currentTarget as HTMLButtonElement
            btn.style.background = 'var(--color-accent-500, #d63a00)'
            btn.style.borderColor = 'var(--color-accent-500, #d63a00)'
          }}
          onMouseLeave={e => {
            const btn = e.currentTarget as HTMLButtonElement
            btn.style.background = 'rgba(255,255,255,0.15)'
            btn.style.borderColor = 'rgba(255,255,255,0.2)'
          }}
        />

        {/* Page dots */}
        {PAGES.map((page, i) => (
          <button
            key={page.id}
            onClick={() => scrollToPage(i)}
            title={page.name}
            style={{
              width: '10px',
              height: '10px',
              borderRadius: '50%',
              background: 'rgba(255,255,255,0.15)',
              border: '1px solid rgba(255,255,255,0.2)',
              padding: 0,
              cursor: 'pointer',
              transition: 'background 0.15s ease, border-color 0.15s ease',
            }}
            onMouseEnter={e => {
              const btn = e.currentTarget as HTMLButtonElement
              btn.style.background = 'var(--color-accent-500, #d63a00)'
              btn.style.borderColor = 'var(--color-accent-500, #d63a00)'
            }}
            onMouseLeave={e => {
              const btn = e.currentTarget as HTMLButtonElement
              btn.style.background = 'rgba(255,255,255,0.15)'
              btn.style.borderColor = 'rgba(255,255,255,0.2)'
            }}
          />
        ))}
      </div>

      {/* Welcome hero */}
      <div ref={heroRef}>
        <Step0WelcomeHero onSkipAll={onSkipAll} />
      </div>

      {/* Page previews */}
      {PAGES.map((page, i) => {
        const MockComponent = MOCK_COMPONENTS[i]!
        const isLast = i === PAGES.length - 1

        return (
          <Step0PagePreview
            key={page.id}
            ref={el => {
              pageRefs.current[i] = el
            }}
            page={page}
            pageIndex={i}
            isLast={isLast}
            onNext={() => scrollToPage(i + 1)}
            onContinueToSetup={onComplete}
          >
            <MockComponent />
          </Step0PagePreview>
        )
      })}
    </div>
  )
}
