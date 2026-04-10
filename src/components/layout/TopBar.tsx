import { useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { useAuth } from '../../hooks/useAuth'
import { useSettings } from '../../hooks/useSettings'
import { supabase } from '../../services/supabase'

const VIEW_TITLES: Record<string, string> = {
  '/': 'Home',
  '/explore': 'Explore',
  '/ask': 'Ask',
  '/ingest': 'Ingest',
  '/orient': 'Orient',
  '/sources': 'Sources',
  '/signals': 'Signals',
  '/skills': 'Signals',
  '/anchors': 'Signals',
  '/council': 'Council',
}

interface TopBarProps {
  onOpenSettings: () => void
  onOpenCommandPalette: () => void
}

export function TopBar({ onOpenSettings }: TopBarProps) {
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
    if (!user) return
    async function fetchCounts() {
      const [nodes, edges] = await Promise.all([
        supabase.from('knowledge_nodes').select('id', { count: 'exact', head: true }).eq('user_id', user!.id).eq('is_merged', false),
        supabase.from('knowledge_edges').select('id', { count: 'exact', head: true }).eq('user_id', user!.id),
      ])
      setNodeCount(nodes.count ?? 0)
      setEdgeCount(edges.count ?? 0)
    }
    fetchCounts()
  }, [user])

  return (
    <header
      className="flex items-center justify-between shrink-0"
      style={{
        height: 52,
        background: 'var(--color-accent-50)',
        borderBottom: '1px solid var(--border-subtle)',
        paddingLeft: 24,
        paddingRight: 24,
      }}
    >
      {/* View title */}
      <span
        className="font-display font-bold text-text-primary shrink-0"
        style={{ fontSize: 15, letterSpacing: '-0.01em' }}
      >
        {viewTitle}
      </span>

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
