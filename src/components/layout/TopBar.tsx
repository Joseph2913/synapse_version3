import { useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { Search } from 'lucide-react'
import { useAuth } from '../../hooks/useAuth'
import { useSettings } from '../../hooks/useSettings'
import { supabase } from '../../services/supabase'
import { Kbd } from '../ui/Kbd'

const VIEW_TITLES: Record<string, string> = {
  '/': 'Home',
  '/explore': 'Explore',
  '/ask': 'Ask',
  '/ingest': 'Ingest',
  '/orient': 'Orient',
  '/signals': 'Signals',
  '/skills': 'Signals',
  '/anchors': 'Signals',
}

interface TopBarProps {
  onOpenSettings: () => void
  onOpenCommandPalette: () => void
}

export function TopBar({ onOpenSettings, onOpenCommandPalette }: TopBarProps) {
  const location = useLocation()
  const { user } = useAuth()
  const { profile } = useSettings()
  const [nodeCount, setNodeCount] = useState(0)
  const [edgeCount, setEdgeCount] = useState(0)

  const viewTitle = VIEW_TITLES[location.pathname] ?? 'Synapse'

  const profileName = profile?.professional_context?.role
  const displayName = profileName ?? user?.email ?? ''
  const initial = displayName.charAt(0).toUpperCase() || '?'

  useEffect(() => {
    async function fetchCounts() {
      const [nodes, edges] = await Promise.all([
        supabase.from('knowledge_nodes').select('*', { count: 'exact', head: true }),
        supabase.from('knowledge_edges').select('*', { count: 'exact', head: true }),
      ])
      setNodeCount(nodes.count ?? 0)
      setEdgeCount(edges.count ?? 0)
    }
    fetchCounts()
  }, [])

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
      {/* View title — left side, next to Synapse logo */}
      <span
        className="font-display font-bold text-text-primary shrink-0"
        style={{ fontSize: 15, letterSpacing: '-0.01em', marginRight: 24 }}
      >
        {viewTitle}
      </span>

      {/* Search bar — centered */}
      <div className="flex-1 flex justify-center">
        <button
          type="button"
          onClick={onOpenCommandPalette}
          className="flex items-center gap-2 cursor-pointer font-body"
          style={{
            width: '100%',
            maxWidth: 420,
            padding: '7px 12px',
            fontSize: 13,
            background: 'rgba(255,255,255,0.7)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 10,
            color: 'var(--color-text-placeholder)',
            transition: 'border-color 0.15s ease, box-shadow 0.15s ease, background 0.15s ease',
          }}
          onMouseEnter={e => {
            e.currentTarget.style.borderColor = 'rgba(214,58,0,0.2)'
            e.currentTarget.style.background = 'rgba(255,255,255,0.9)'
          }}
          onMouseLeave={e => {
            e.currentTarget.style.borderColor = 'var(--border-subtle)'
            e.currentTarget.style.background = 'rgba(255,255,255,0.7)'
          }}
        >
          <Search size={14} style={{ flexShrink: 0, color: 'var(--color-text-secondary)' }} />
          <span className="flex-1" style={{ textAlign: 'left' }}>
            Search graph…
          </span>
          <Kbd>⌘K</Kbd>
        </button>
      </div>

      {/* Right side — metadata + avatar */}
      <div className="flex items-center gap-4 shrink-0">
        <span className="font-body text-[12px]" style={{ whiteSpace: 'nowrap', color: 'var(--color-text-secondary)' }}>
          {nodeCount.toLocaleString()} nodes · {edgeCount.toLocaleString()} edges
        </span>

        <button
          type="button"
          onClick={onOpenSettings}
          title="Settings"
          className="flex items-center justify-center border-none cursor-pointer"
          style={{
            width: 28,
            height: 28,
            borderRadius: '50%',
            background: 'linear-gradient(135deg, var(--color-accent-500), var(--color-accent-300))',
            color: '#ffffff',
            fontFamily: 'var(--font-display)',
            fontSize: 11,
            fontWeight: 700,
            lineHeight: 1,
            marginRight: 4,
          }}
        >
          {initial}
        </button>
      </div>
    </header>
  )
}
