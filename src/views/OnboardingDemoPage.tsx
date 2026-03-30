import { useState } from 'react'
import {
  Home,
  Compass,
  MessageSquare,
  Plus,
  Zap,
  Navigation,
  Activity,
  Radio,
  Search,
  Settings,
  ChevronRight,
  ChevronLeft,
  type LucideIcon,
} from 'lucide-react'
import { SynapseLogo } from '../components/shared/SynapseLogo'
import { DemoContent } from '../components/onboarding/DemoContent'
import { STEPS } from '../components/onboarding/OnboardingOverlay'

/* ─── Static nav items matching real NavRail ─────────────────── */

const NAV_ITEMS: Array<{ id: string; label: string; path: string; icon: LucideIcon }> = [
  { id: 'home', label: 'Home', path: '/', icon: Home },
  { id: 'explore', label: 'Explore', path: '/explore', icon: Compass },
  { id: 'ask', label: 'Ask', path: '/ask', icon: MessageSquare },
  { id: 'capture', label: 'Capture', path: '/capture', icon: Plus },
  { id: 'automate', label: 'Automate', path: '/automate', icon: Zap },
  { id: 'orient', label: 'Orient', path: '/orient', icon: Navigation },
  { id: 'pipeline', label: 'Pipeline', path: '/pipeline', icon: Activity },
  { id: 'signals', label: 'Signals', path: '/signals', icon: Radio },
]

/* ─── Mini NavRail (visual only) ─────────────────────────────── */

function DemoNavItem({
  item,
  isActive,
  expanded,
  onClick,
}: {
  item: (typeof NAV_ITEMS)[number]
  isActive: boolean
  expanded: boolean
  onClick: () => void
}) {
  const [hovered, setHovered] = useState(false)
  const Icon = item.icon

  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className="relative flex items-center cursor-pointer border-none"
      style={{
        height: 40,
        width: expanded ? '100%' : 40,
        paddingLeft: expanded ? 10 : 0,
        paddingRight: expanded ? 12 : 0,
        gap: 12,
        borderRadius: 10,
        justifyContent: expanded ? 'flex-start' : 'center',
        background: isActive
          ? 'var(--color-accent-50)'
          : hovered
            ? 'rgba(0,0,0,0.04)'
            : 'transparent',
        transition: 'background 0.15s ease, width 0.2s ease, padding 0.2s ease',
      }}
    >
      {isActive && (
        <div
          className="absolute"
          style={{
            left: expanded ? -8 : -8,
            top: '50%',
            transform: 'translateY(-50%)',
            width: 3,
            height: 16,
            background: 'var(--color-accent-500)',
            borderRadius: '0 2px 2px 0',
          }}
        />
      )}
      <Icon
        size={20}
        strokeWidth={1.8}
        className="shrink-0"
        style={{
          color: isActive
            ? 'var(--color-accent-500)'
            : hovered
              ? 'var(--color-text-body)'
              : 'var(--color-text-secondary)',
          transition: 'color 0.15s ease',
        }}
      />
      {expanded && (
        <span
          className="whitespace-nowrap overflow-hidden"
          style={{
            fontFamily: 'var(--font-body)',
            fontSize: 12,
            fontWeight: 500,
            color: isActive ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
          }}
        >
          {item.label}
        </span>
      )}
    </button>
  )
}

function DemoNavRail({
  activePath,
  onNavigate,
}: {
  activePath: string
  onNavigate: (stepIndex: number) => void
}) {
  const [expanded, setExpanded] = useState(false)

  return (
    <div className="flex-shrink-0 relative" style={{ width: 56, zIndex: 100 }}>
      <nav
        onMouseEnter={() => setExpanded(true)}
        onMouseLeave={() => setExpanded(false)}
        className="absolute left-0 top-0 h-full flex flex-col overflow-hidden"
        style={{
          width: expanded ? 190 : 56,
          background: 'var(--color-bg-frame)',
          borderRight: '1px solid var(--border-subtle)',
          transition: 'width 0.2s ease-out',
          zIndex: 200,
          boxShadow: expanded ? '4px 0 16px rgba(0,0,0,0.06)' : 'none',
        }}
      >
        {/* Logo */}
        <div
          className="flex items-center shrink-0"
          style={{
            height: 52,
            borderBottom: '1px solid var(--border-subtle)',
            paddingLeft: expanded ? 14 : 13,
            gap: 10,
            transition: 'padding 0.2s ease',
          }}
        >
          <SynapseLogo size={30} />
          {expanded && (
            <span
              className="whitespace-nowrap overflow-hidden"
              style={{
                fontFamily: 'var(--font-display)',
                fontSize: 14,
                fontWeight: 700,
                color: 'var(--color-text-primary)',
              }}
            >
              Synapse
            </span>
          )}
        </div>

        {/* Nav items */}
        <div
          className="flex flex-col gap-1 pt-7"
          style={{
            alignItems: expanded ? 'stretch' : 'center',
            paddingLeft: expanded ? 8 : 0,
            paddingRight: expanded ? 8 : 0,
            transition: 'padding 0.2s ease',
          }}
        >
          {NAV_ITEMS.map((item) => {
            const stepIndex = STEPS.findIndex((s) => s.path === item.path)
            return (
              <DemoNavItem
                key={item.id}
                item={item}
                isActive={
                  item.path === '/'
                    ? activePath === '/'
                    : activePath.startsWith(item.path)
                }
                expanded={expanded}
                onClick={() => {
                  if (stepIndex >= 0) onNavigate(stepIndex)
                }}
              />
            )
          })}
        </div>

        <div className="flex-1" />

        {/* Bottom utilities (visual only) */}
        <div
          className="flex flex-col gap-1 pb-3 pt-2"
          style={{
            borderTop: '1px solid var(--border-subtle)',
            alignItems: expanded ? 'stretch' : 'center',
            paddingLeft: expanded ? 8 : 0,
            paddingRight: expanded ? 8 : 0,
            transition: 'padding 0.2s ease',
          }}
        >
          {[
            { icon: Search, label: 'Search' },
            { icon: Settings, label: 'Settings' },
          ].map(({ icon: Icon, label }) => (
            <div
              key={label}
              className="flex items-center border-none rounded-[10px]"
              style={{
                height: 40,
                width: expanded ? '100%' : 40,
                paddingLeft: expanded ? 10 : 0,
                paddingRight: expanded ? 12 : 0,
                gap: 12,
                justifyContent: expanded ? 'flex-start' : 'center',
                opacity: 0.5,
                cursor: 'default',
              }}
            >
              <Icon size={16} strokeWidth={1.8} className="shrink-0" style={{ color: 'var(--color-text-secondary)' }} />
              {expanded && (
                <span style={{ fontFamily: 'var(--font-body)', fontSize: 12, fontWeight: 500, color: 'var(--color-text-secondary)' }}>
                  {label}
                </span>
              )}
            </div>
          ))}
        </div>
      </nav>
    </div>
  )
}

/* ─── Demo TopBar ────────────────────────────────────────────── */

function DemoTopBar({ title }: { title: string }) {
  return (
    <header
      className="flex items-center shrink-0"
      style={{
        height: 52,
        background: 'var(--color-accent-50)',
        borderBottom: '1px solid var(--border-subtle)',
        paddingLeft: 24,
        paddingRight: 24,
      }}
    >
      <span
        className="font-display font-bold shrink-0"
        style={{ fontSize: 15, letterSpacing: '-0.01em', color: 'var(--color-text-primary)', marginRight: 24 }}
      >
        {title}
      </span>

      <div className="flex-1 flex justify-center">
        <div
          className="flex items-center gap-2"
          style={{
            width: '100%',
            maxWidth: 420,
            padding: '7px 12px',
            fontSize: 13,
            fontFamily: 'var(--font-body)',
            background: 'rgba(255,255,255,0.7)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 10,
            color: 'var(--color-text-placeholder)',
          }}
        >
          <Search size={14} style={{ flexShrink: 0, color: 'var(--color-text-secondary)' }} />
          <span className="flex-1" style={{ textAlign: 'left' }}>Search graph…</span>
        </div>
      </div>

      <div className="flex items-center gap-4 shrink-0">
        <span style={{ fontFamily: 'var(--font-body)', fontSize: 12, whiteSpace: 'nowrap', color: 'var(--color-text-secondary)' }}>
          847 nodes · 1,204 edges
        </span>
        <div
          className="flex items-center justify-center"
          style={{
            width: 28,
            height: 28,
            borderRadius: '50%',
            background: 'linear-gradient(135deg, var(--color-accent-500), var(--color-accent-300))',
            color: '#ffffff',
            fontFamily: 'var(--font-display)',
            fontSize: 11,
            fontWeight: 700,
          }}
        >
          J
        </div>
      </div>
    </header>
  )
}

/* ─── Bottom Onboarding Bar ──────────────────────────────────── */

function DemoOnboardingBar({
  step,
  setStep,
}: {
  step: number
  setStep: (s: number) => void
}) {
  const current = STEPS[step]!
  const Icon = current.icon

  const handleNext = () => {
    if (step < STEPS.length - 1) setStep(step + 1)
  }
  const handleBack = () => {
    if (step > 0) setStep(step - 1)
  }

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
        {/* Progress */}
        <div style={{ height: 3, background: 'var(--color-bg-inset)', position: 'relative' }}>
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
        <div style={{ padding: '16px 20px 12px', display: 'flex', alignItems: 'flex-start', gap: 14 }}>
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
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
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
        <div style={{ padding: '0 20px 14px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          {/* Dots */}
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

          {/* Buttons */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
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
                cursor: step === STEPS.length - 1 ? 'default' : 'pointer',
                opacity: step === STEPS.length - 1 ? 0.5 : 1,
                transition: 'background 0.15s ease',
              }}
              onMouseEnter={(e) => {
                if (step < STEPS.length - 1) e.currentTarget.style.background = 'var(--color-accent-600)'
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'var(--color-accent-500)'
              }}
            >
              {step === STEPS.length - 1 ? 'End of tour' : 'Next'}
              {step < STEPS.length - 1 && <ChevronRight size={12} />}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

/* ─── Main page ──────────────────────────────────────────────── */

export default function OnboardingDemoPage() {
  const [step, setStep] = useState(0)
  const currentPath = STEPS[step]!.path

  const VIEW_TITLES: Record<string, string> = {
    '/': 'Home',
    '/explore': 'Explore',
    '/ask': 'Ask',
    '/capture': 'Capture',
    '/automate': 'Automate',
    '/orient': 'Orient',
    '/pipeline': 'Pipeline',
    '/signals': 'Signals',
  }

  return (
    <div className="flex w-full h-screen overflow-hidden" style={{ background: 'var(--color-bg-content)' }}>
      <DemoNavRail activePath={currentPath} onNavigate={setStep} />

      <main className="flex-1 h-full overflow-hidden flex flex-col" style={{ minWidth: 0 }}>
        <DemoTopBar title={VIEW_TITLES[currentPath] ?? 'Synapse'} />
        <div className="flex-1 overflow-hidden">
          <DemoContent step={step} />
        </div>
      </main>

      <DemoOnboardingBar step={step} setStep={setStep} />
    </div>
  )
}
