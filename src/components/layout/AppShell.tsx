import { useCallback, useEffect, useState } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import { NavRail } from './NavRail'
import { TopBar } from './TopBar'
import { RightPanel } from './RightPanel'
import { CommandPalette } from '../modals/CommandPalette'
import { SettingsModal } from '../modals/SettingsModal'
import { OnboardingOverlay, useOnboarding } from '../onboarding/OnboardingOverlay'
import { DemoContent } from '../onboarding/DemoContent'
import { useGraphContext } from '../../hooks/useGraphContext'
import { useAuth } from '../../hooks/useAuth'
import { fetchSuggestedCount } from '../../services/anchorCandidates'
import { supabase } from '../../services/supabase'

export function AppShell() {
  const location = useLocation()
  const { rightPanelContent } = useGraphContext()
  const { user } = useAuth()
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [suggestedAnchorCount, setSuggestedAnchorCount] = useState(0)
  const [skillDraftCount, setSkillDraftCount] = useState(0)
  const {
    active: onboardingActive,
    complete: completeOnboarding,
    step: onboardingStep,
    setStep: setOnboardingStep,
  } = useOnboarding()

  const refreshAnchorSuggestionCount = useCallback(async () => {
    if (!user?.id) {
      setSuggestedAnchorCount(0)
      return
    }

    try {
      const count = await fetchSuggestedCount(user.id)
      setSuggestedAnchorCount(count)
    } catch {
      setSuggestedAnchorCount(0)
    }
  }, [user?.id])

  const refreshSkillDraftCount = useCallback(async () => {
    if (!user?.id) {
      setSkillDraftCount(0)
      return
    }

    try {
      const { count } = await supabase
        .from('knowledge_skills')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'draft')
      setSkillDraftCount(count ?? 0)
    } catch {
      setSkillDraftCount(0)
    }
  }, [user?.id])

  // Fetch anchor suggestion count (non-blocking — table may not exist yet)
  useEffect(() => {
    void refreshAnchorSuggestionCount()
  }, [refreshAnchorSuggestionCount])

  // Fetch skill draft count for nav badge
  useEffect(() => {
    void refreshSkillDraftCount()
  }, [refreshSkillDraftCount])

  // Listen for anchor suggestion changes
  useEffect(() => {
    const handler = () => {
      void refreshAnchorSuggestionCount()
    }
    window.addEventListener('synapse:anchor-suggestions-changed', handler)
    return () => window.removeEventListener('synapse:anchor-suggestions-changed', handler)
  }, [refreshAnchorSuggestionCount])

  useEffect(() => {
    const handler = () => {
      void refreshSkillDraftCount()
    }
    window.addEventListener('synapse:skill-drafts-changed', handler)
    return () => window.removeEventListener('synapse:skill-drafts-changed', handler)
  }, [refreshSkillDraftCount])

  const isAskView = location.pathname === '/ask'
  // Ask view has its own internal right panel, so skip the AppShell one
  const showRightPanel = !onboardingActive && !isAskView && rightPanelContent !== null

  // Global keyboard listener
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        setCommandPaletteOpen(prev => !prev)
      }
      if (e.key === 'Escape') {
        setCommandPaletteOpen(false)
        setSettingsOpen(false)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  return (
    <>
      <div className="flex w-full h-screen overflow-hidden" style={{ background: 'var(--color-bg-content)' }}>
        <NavRail
          onOpenCommandPalette={() => setCommandPaletteOpen(true)}
          onOpenSettings={() => setSettingsOpen(true)}
          signalsPendingCount={suggestedAnchorCount + skillDraftCount}
        />

        <main className="flex-1 h-full overflow-hidden flex flex-col min-w-0">
          <TopBar
            onOpenSettings={() => setSettingsOpen(true)}
            onOpenCommandPalette={() => setCommandPaletteOpen(true)}
          />
          <div className="flex-1 overflow-hidden" style={{ position: 'relative' }}>
            <Outlet />
            {onboardingActive && (
              <div
                style={{
                  position: 'absolute',
                  inset: 0,
                  zIndex: 50,
                  background: 'var(--color-bg-content)',
                  overflow: 'hidden',
                }}
              >
                <DemoContent step={onboardingStep} />
              </div>
            )}
          </div>
        </main>

        {showRightPanel && <RightPanel />}
      </div>

      {commandPaletteOpen && (
        <CommandPalette
          onClose={() => setCommandPaletteOpen(false)}
          onOpenSettings={() => { setCommandPaletteOpen(false); setSettingsOpen(true) }}
        />
      )}

      {settingsOpen && (
        <SettingsModal onClose={() => setSettingsOpen(false)} />
      )}

      {onboardingActive && (
        <OnboardingOverlay
          step={onboardingStep}
          setStep={setOnboardingStep}
          onComplete={completeOnboarding}
        />
      )}
    </>
  )
}
