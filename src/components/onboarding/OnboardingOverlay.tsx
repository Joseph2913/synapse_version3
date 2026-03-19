import { useState, useEffect, useCallback } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import {
  Zap,
  Plus,
  Activity,
  Compass,
  MessageSquare,
  Navigation,
  Anchor,
  Home,
  ChevronRight,
  ChevronLeft,
} from 'lucide-react'

const ONBOARDING_KEY = 'synapse:onboarding-complete'

export interface OnboardingStep {
  path: string
  title: string
  description: string
  icon: typeof Zap
}

export const STEPS: OnboardingStep[] = [
  {
    path: '/automate',
    title: 'Automate',
    description:
      'Connect your tools to automatically ingest content. Here you can see Circleback and YouTube are already set up — meetings and videos flow into your knowledge base without any manual work.',
    icon: Zap,
  },
  {
    path: '/capture',
    title: 'Capture',
    description:
      'For anything that isn\'t automated, Capture lets you manually add content. Paste text, drop a URL, upload a document, or add a transcript — it all gets extracted into your knowledge graph.',
    icon: Plus,
  },
  {
    path: '/pipeline',
    title: 'Pipeline',
    description:
      'Pipeline shows you everything in the queue. Track what\'s been completed, what\'s still processing, and troubleshoot anything that\'s failed. This is your ingestion control centre.',
    icon: Activity,
  },
  {
    path: '/explore',
    title: 'Explore',
    description:
      'This is where your knowledge comes alive. Browse anchors — the core concepts that structure everything — click into one to see its entities, switch between card and list views, and explore how sources connect.',
    icon: Compass,
  },
  {
    path: '/ask',
    title: 'Ask',
    description:
      'Chat with your entire knowledge base. Ask a question and get answers grounded in your extracted entities and sources, with citations so you can trace every insight back to its origin.',
    icon: MessageSquare,
  },
  {
    path: '/orient',
    title: 'Orient',
    description:
      'Set up daily, weekly, or monthly briefings tailored to your anchors. Orient keeps you aligned with what matters most, surfacing key developments without you having to search.',
    icon: Navigation,
  },
  {
    path: '/anchors',
    title: 'Anchors',
    description:
      'Anchors are the fundamental concepts that structure your knowledge — they shape how content is visualised, organised, and retrieved. New anchors are surfaced automatically using entity co-occurrence and centrality analysis. You choose which ones to keep.',
    icon: Anchor,
  },
  {
    path: '/',
    title: 'Home',
    description:
      'Your daily home base. See every source ingested over the past day or two at a glance — designed to be the first thing you check each morning for a quick recap of what\'s new.',
    icon: Home,
  },
]

export function useOnboarding() {
  const [active, setActive] = useState(false)
  const [step, setStep] = useState(0)

  useEffect(() => {
    const done = localStorage.getItem(ONBOARDING_KEY)
    if (!done) setActive(true)
  }, [])

  const complete = useCallback(() => {
    localStorage.setItem(ONBOARDING_KEY, 'true')
    setActive(false)
    setStep(0)
  }, [])

  const restart = useCallback(() => {
    localStorage.removeItem(ONBOARDING_KEY)
    setStep(0)
    setActive(true)
  }, [])

  return { active, complete, restart, step, setStep }
}

interface OnboardingOverlayProps {
  step: number
  setStep: (step: number) => void
  onComplete: () => void
}

export function OnboardingOverlay({ step, setStep, onComplete }: OnboardingOverlayProps) {
  const navigate = useNavigate()
  const location = useLocation()
  const [isExiting, setIsExiting] = useState(false)

  const current = STEPS[step]!

  // Navigate to the step's page when step changes
  useEffect(() => {
    if (location.pathname !== current.path) {
      navigate(current.path)
    }
  }, [step, current.path, navigate, location.pathname])

  const handleNext = () => {
    if (step < STEPS.length - 1) {
      setStep(step + 1)
    } else {
      handleFinish()
    }
  }

  const handleBack = () => {
    if (step > 0) setStep(step - 1)
  }

  const handleFinish = () => {
    setIsExiting(true)
    setTimeout(() => {
      onComplete()
    }, 300)
  }

  const Icon = current.icon

  return (
    <div
      style={{
        position: 'fixed',
        bottom: 0,
        left: 0,
        right: 0,
        zIndex: 9999,
        display: 'flex',
        justifyContent: 'center',
        padding: '0 24px 24px',
        pointerEvents: 'none',
        opacity: isExiting ? 0 : 1,
        transform: isExiting ? 'translateY(20px)' : 'translateY(0)',
        transition: 'opacity 0.3s ease, transform 0.3s ease',
      }}
    >
      <div
        style={{
          pointerEvents: 'auto',
          width: '100%',
          maxWidth: 680,
          background: 'var(--color-bg-card)',
          borderRadius: 16,
          border: '1px solid var(--border-subtle)',
          boxShadow: '0 8px 32px rgba(0,0,0,0.08), 0 2px 8px rgba(0,0,0,0.04)',
          overflow: 'hidden',
        }}
      >
        {/* Progress bar */}
        <div
          style={{
            height: 3,
            background: 'var(--color-bg-inset)',
            position: 'relative',
          }}
        >
          <div
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              height: '100%',
              width: `${((step + 1) / STEPS.length) * 100}%`,
              background: 'var(--color-accent-500)',
              borderRadius: 2,
              transition: 'width 0.4s ease',
            }}
          />
        </div>

        {/* Content */}
        <div
          style={{
            padding: '16px 20px 12px',
            display: 'flex',
            alignItems: 'flex-start',
            gap: 14,
          }}
        >
          <div
            style={{
              width: 36,
              height: 36,
              borderRadius: 10,
              background: 'var(--color-accent-50)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}
          >
            <Icon size={18} style={{ color: 'var(--color-accent-500)' }} />
          </div>

          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                marginBottom: 4,
              }}
            >
              <span
                style={{
                  fontFamily: 'var(--font-display)',
                  fontSize: 15,
                  fontWeight: 700,
                  color: 'var(--color-text-primary)',
                  lineHeight: 1.3,
                }}
              >
                {current.title}
              </span>
              <span
                style={{
                  fontFamily: 'var(--font-body)',
                  fontSize: 11,
                  fontWeight: 500,
                  color: 'var(--color-text-secondary)',
                }}
              >
                {step + 1} / {STEPS.length}
              </span>
            </div>
            <p
              style={{
                fontFamily: 'var(--font-body)',
                fontSize: 13,
                lineHeight: 1.5,
                color: 'var(--color-text-body)',
                margin: 0,
              }}
            >
              {current.description}
            </p>
          </div>
        </div>

        {/* Controls */}
        <div
          style={{
            padding: '0 20px 14px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <div style={{ display: 'flex', gap: 6 }}>
            {STEPS.map((_, i) => (
              <button
                key={i}
                onClick={() => setStep(i)}
                style={{
                  width: i === step ? 18 : 6,
                  height: 6,
                  borderRadius: 3,
                  border: 'none',
                  padding: 0,
                  cursor: 'pointer',
                  background:
                    i === step
                      ? 'var(--color-accent-500)'
                      : i < step
                        ? 'var(--color-accent-200)'
                        : 'var(--color-border-default)',
                  transition: 'all 0.3s ease',
                }}
                aria-label={`Go to step ${i + 1}: ${STEPS[i]!.title}`}
              />
            ))}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button
              onClick={handleFinish}
              style={{
                fontFamily: 'var(--font-body)',
                fontSize: 12,
                fontWeight: 500,
                color: 'var(--color-text-secondary)',
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                padding: '6px 10px',
                borderRadius: 8,
                transition: 'color 0.15s ease',
              }}
              onMouseEnter={(e) =>
                (e.currentTarget.style.color = 'var(--color-text-body)')
              }
              onMouseLeave={(e) =>
                (e.currentTarget.style.color = 'var(--color-text-secondary)')
              }
            >
              Skip tour
            </button>

            {step > 0 && (
              <button
                onClick={handleBack}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                  fontFamily: 'var(--font-body)',
                  fontSize: 12,
                  fontWeight: 600,
                  color: 'var(--color-text-secondary)',
                  background: 'none',
                  border: '1px solid var(--border-subtle)',
                  borderRadius: 20,
                  padding: '5px 13px',
                  cursor: 'pointer',
                  transition: 'all 0.15s ease',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.borderColor = 'var(--color-border-default)'
                  e.currentTarget.style.color = 'var(--color-text-body)'
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.borderColor = 'var(--border-subtle)'
                  e.currentTarget.style.color = 'var(--color-text-secondary)'
                }}
              >
                <ChevronLeft size={12} />
                Back
              </button>
            )}

            <button
              onClick={handleNext}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                fontFamily: 'var(--font-body)',
                fontSize: 12,
                fontWeight: 600,
                color: '#ffffff',
                background: 'var(--color-accent-500)',
                border: 'none',
                borderRadius: 20,
                padding: '6px 16px',
                cursor: 'pointer',
                transition: 'background 0.15s ease',
              }}
              onMouseEnter={(e) =>
                (e.currentTarget.style.background = 'var(--color-accent-600)')
              }
              onMouseLeave={(e) =>
                (e.currentTarget.style.background = 'var(--color-accent-500)')
              }
            >
              {step === STEPS.length - 1 ? 'Get started' : 'Next'}
              {step < STEPS.length - 1 && <ChevronRight size={12} />}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
