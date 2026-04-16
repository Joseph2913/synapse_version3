import { forwardRef } from 'react'
import { Home, Compass, MessageSquare, Database, Radio, Users } from 'lucide-react'
import type { PageDefinition } from './onboardingMockData'

interface Step0PagePreviewProps {
  page: PageDefinition
  pageIndex: number
  isLast: boolean
  onNext: () => void
  onContinueToSetup: () => void
  children: React.ReactNode
}

const NAV_ICONS = [Home, Compass, MessageSquare, Database, Radio, Users]

export const Step0PagePreview = forwardRef<HTMLDivElement, Step0PagePreviewProps>(
  function Step0PagePreview({ page, pageIndex, isLast, onNext, onContinueToSetup, children }, ref) {
    const PageIcon = page.icon

    return (
      <div
        ref={ref}
        className="relative flex flex-col min-h-screen"
        style={{ background: '#111', paddingTop: '24px', paddingBottom: '48px' }}
      >
        {/* Page counter */}
        <div
          className="absolute top-6 left-8 font-semibold"
          style={{ color: 'rgba(255,255,255,0.25)', fontSize: '13px' }}
        >
          {pageIndex + 1} / 6
        </div>

        {/* App frame */}
        <div
          className="mx-6 flex flex-col overflow-hidden"
          style={{
            borderRadius: '12px 12px 0 0',
            background: 'var(--color-bg-content, #f8f7f5)',
            border: '1px solid rgba(255,255,255,0.08)',
            marginTop: '48px',
            minHeight: 'calc(100vh - 120px)',
          }}
        >
          {/* Fake topbar */}
          <div
            className="flex items-center px-4 flex-shrink-0"
            style={{
              height: '42px',
              background: 'var(--color-accent-50, #fff5f0)',
              borderBottom: '1px solid rgba(214,58,0,0.1)',
            }}
          >
            <span
              className="font-bold"
              style={{
                fontSize: '14px',
                color: 'var(--color-text-primary, #1a1a1a)',
                fontFamily: 'Cabinet Grotesk, sans-serif',
              }}
            >
              {page.name}
            </span>
          </div>

          {/* Below topbar: nav rail + content */}
          <div className="flex flex-1 overflow-hidden">
            {/* Fake nav rail */}
            <div
              className="flex flex-col items-center py-3 gap-1 flex-shrink-0"
              style={{ width: '48px', background: '#f0f0f0', borderRight: '1px solid #e8e8e8' }}
            >
              {NAV_ICONS.map((Icon, i) => {
                const isActive = i === pageIndex
                return (
                  <div
                    key={i}
                    className="relative flex items-center justify-center rounded-lg"
                    style={{
                      width: '36px',
                      height: '36px',
                      background: isActive ? 'var(--color-accent-50, #fff5f0)' : 'transparent',
                      color: isActive
                        ? 'var(--color-accent-500, #d63a00)'
                        : 'rgba(0,0,0,0.35)',
                    }}
                  >
                    {/* Active left bar indicator */}
                    {isActive && (
                      <div
                        className="absolute left-0 rounded-r"
                        style={{
                          width: '3px',
                          height: '20px',
                          background: 'var(--color-accent-500, #d63a00)',
                        }}
                      />
                    )}
                    <Icon size={15} />
                  </div>
                )
              })}
            </div>

            {/* Content area */}
            <div className="flex-1 relative overflow-hidden">
              {/* Mock page content */}
              {children}

              {/* Floating description card */}
              <div
                className="absolute rounded-xl"
                style={{
                  bottom: '64px',
                  right: '16px',
                  width: '320px',
                  background: '#ffffff',
                  border: '1px solid rgba(0,0,0,0.08)',
                  boxShadow: '0 8px 32px rgba(0,0,0,0.14)',
                  padding: '14px',
                  zIndex: 20,
                }}
              >
                {/* Icon + name row */}
                <div className="flex items-center gap-2 mb-2">
                  <div
                    className="flex items-center justify-center rounded-lg flex-shrink-0"
                    style={{
                      width: '28px',
                      height: '28px',
                      background: 'var(--color-accent-50, #fff5f0)',
                    }}
                  >
                    <PageIcon size={14} style={{ color: 'var(--color-accent-500, #d63a00)' }} />
                  </div>
                  <span
                    className="font-bold"
                    style={{
                      fontSize: '13px',
                      color: 'var(--color-text-primary, #1a1a1a)',
                      fontFamily: 'Cabinet Grotesk, sans-serif',
                    }}
                  >
                    {page.name}
                  </span>
                </div>

                {/* Description */}
                <p
                  className="mb-3 leading-relaxed"
                  style={{
                    fontSize: '11px',
                    color: 'var(--color-text-secondary, #666)',
                    lineHeight: '1.5',
                  }}
                >
                  {page.description}
                </p>

                {/* Feature pills */}
                <div className="flex flex-wrap gap-1 mb-3">
                  {page.accentFeatures.map(f => (
                    <span
                      key={f}
                      className="rounded-full font-semibold"
                      style={{
                        fontSize: '10px',
                        padding: '3px 8px',
                        background: 'var(--color-accent-50, #fff5f0)',
                        color: 'var(--color-accent-500, #d63a00)',
                        border: '1px solid rgba(214,58,0,0.15)',
                      }}
                    >
                      {f}
                    </span>
                  ))}
                  {page.features.map(f => (
                    <span
                      key={f}
                      className="rounded-full font-semibold"
                      style={{
                        fontSize: '10px',
                        padding: '3px 8px',
                        background: '#f5f5f5',
                        color: 'rgba(0,0,0,0.5)',
                        border: '1px solid rgba(0,0,0,0.08)',
                      }}
                    >
                      {f}
                    </span>
                  ))}
                </div>

                {/* CTA button */}
                <button
                  onClick={isLast ? onContinueToSetup : onNext}
                  className="w-full font-semibold transition-opacity duration-150 rounded-full"
                  style={{
                    padding: '8px 16px',
                    background: 'var(--color-accent-500, #d63a00)',
                    color: '#ffffff',
                    fontSize: '12px',
                    border: 'none',
                    cursor: 'pointer',
                  }}
                  onMouseEnter={e => {
                    ;(e.currentTarget as HTMLButtonElement).style.opacity = '0.88'
                  }}
                  onMouseLeave={e => {
                    ;(e.currentTarget as HTMLButtonElement).style.opacity = '1'
                  }}
                >
                  {isLast ? 'Continue to Setup →' : 'Next →'}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    )
  }
)
