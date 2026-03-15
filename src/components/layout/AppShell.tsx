import { useState, useEffect } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import { NavRail } from './NavRail'
import { TopBar } from './TopBar'
import { RightPanel } from './RightPanel'
import { CommandPalette } from '../modals/CommandPalette'
import { SettingsModal } from '../modals/SettingsModal'
import { useGraphContext } from '../../hooks/useGraphContext'
import { useAuth } from '../../hooks/useAuth'
import { fetchSuggestedCount } from '../../services/anchorCandidates'

export function AppShell() {
  const location = useLocation()
  const { rightPanelContent } = useGraphContext()
  const { user } = useAuth()
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [suggestedAnchorCount, setSuggestedAnchorCount] = useState(0)

  // Fetch anchor suggestion count (non-blocking — table may not exist yet)
  useEffect(() => {
    if (user) {
      try {
        fetchSuggestedCount(user.id).then(setSuggestedAnchorCount).catch(() => {})
      } catch { /* table may not exist */ }
    }
  }, [user])

  // Listen for anchor suggestion changes
  useEffect(() => {
    const handler = () => {
      if (user) {
        try {
          fetchSuggestedCount(user.id).then(setSuggestedAnchorCount).catch(() => {})
        } catch { /* ignore */ }
      }
    }
    window.addEventListener('synapse:anchor-suggestions-changed', handler)
    return () => window.removeEventListener('synapse:anchor-suggestions-changed', handler)
  }, [user])

  const isAskView = location.pathname === '/ask'
  // Ask view has its own internal right panel, so skip the AppShell one
  const showRightPanel = !isAskView && rightPanelContent !== null

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
          anchorSuggestionCount={suggestedAnchorCount}
        />

        <main className="flex-1 h-full overflow-hidden flex flex-col min-w-0">
          <TopBar
            onOpenSettings={() => setSettingsOpen(true)}
            onOpenCommandPalette={() => setCommandPaletteOpen(true)}
          />
          <div className="flex-1 overflow-hidden">
            <Outlet />
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
    </>
  )
}
