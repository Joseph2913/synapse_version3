import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Search, Home, Compass, MessageSquare, Plus, Radio, Settings,
  ArrowRight, Loader2, type LucideIcon,
} from 'lucide-react'
import { useSettings } from '../../hooks/useSettings'
import { useGraphContext } from '../../hooks/useGraphContext'
import { Dot } from '../ui/Dot'
import { SectionLabel } from '../ui/SectionLabel'
import { searchNodesByLabel } from '../../services/supabase'
import type { KnowledgeNode } from '../../types/database'

interface CommandPaletteProps {
  onClose: () => void
  onOpenSettings: () => void
}

interface PaletteItem {
  id: string
  label: string
  category: 'Anchors' | 'Recent' | 'Nodes' | 'Navigation'
  entityType?: string
  nodeData?: KnowledgeNode
  icon?: LucideIcon
  action: () => void
}

const NAV_ITEMS: Array<{ id: string; label: string; icon: LucideIcon; route?: string }> = [
  { id: 'nav-home',     label: 'Go to Home',    icon: Home,          route: '/'        },
  { id: 'nav-explore',  label: 'Go to Explore',  icon: Compass,       route: '/explore' },
  { id: 'nav-ask',      label: 'Open Ask',        icon: MessageSquare, route: '/ask'     },
  { id: 'nav-signals',  label: 'Go to Signals',  icon: Radio,         route: '/signals' },
  { id: 'nav-ingest',   label: 'Quick Capture',   icon: Plus,          route: '/ingest'  },
  { id: 'nav-settings', label: 'Open Settings',   icon: Settings                         },
]

export function CommandPalette({ onClose, onOpenSettings }: CommandPaletteProps) {
  const navigate = useNavigate()
  const { anchors } = useSettings()
  const { recentNodes, addRecentNode, setSelectedNodeId, setRightPanelContent } = useGraphContext()

  const [query, setQuery] = useState('')
  const [searchResults, setSearchResults] = useState<KnowledgeNode[]>([])
  const [isSearching, setIsSearching] = useState(false)
  const [highlightedIndex, setHighlightedIndex] = useState(0)

  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // Auto-focus on mount
  useEffect(() => {
    requestAnimationFrame(() => inputRef.current?.focus())
  }, [])

  // Debounced search — 250ms
  useEffect(() => {
    if (!query.trim()) {
      setSearchResults([])
      setIsSearching(false)
      return
    }
    setIsSearching(true)
    const timer = setTimeout(async () => {
      const results = await searchNodesByLabel(query.trim(), 15)
      setSearchResults(results)
      setIsSearching(false)
    }, 250)
    return () => clearTimeout(timer)
  }, [query])

  // Select a node: close → track → open right panel → navigate
  const selectNode = useCallback((node: KnowledgeNode) => {
    onClose()
    addRecentNode(node)
    setSelectedNodeId(node.id)
    setRightPanelContent({ type: 'node', data: node })
    navigate('/explore')
  }, [onClose, addRecentNode, setSelectedNodeId, setRightPanelContent, navigate])

  // Build sections
  const sections = useMemo(() => {
    const q = query.trim().toLowerCase()
    const anchorIds = new Set(anchors.map(a => a.id))
    const result: Array<{ category: PaletteItem['category']; items: PaletteItem[] }> = []

    // 1. ANCHORS — always show, filter by query when active
    const anchorItems: PaletteItem[] = (
      q ? anchors.filter(a => a.label.toLowerCase().includes(q)) : anchors
    ).map(a => ({
      id: `anchor-${a.id}`,
      label: a.label,
      category: 'Anchors' as const,
      entityType: a.entity_type,
      nodeData: a as KnowledgeNode,
      action: () => selectNode(a as KnowledgeNode),
    }))
    if (anchorItems.length > 0) result.push({ category: 'Anchors', items: anchorItems })

    // 2. RECENT — exclude anchors to prevent duplication
    const recentFiltered = (
      q ? recentNodes.filter(n => n.label.toLowerCase().includes(q)) : recentNodes
    ).filter(n => !anchorIds.has(n.id))
    const recentIds = new Set(recentFiltered.map(n => n.id))
    const recentItems: PaletteItem[] = recentFiltered.map(n => ({
      id: `recent-${n.id}`,
      label: n.label,
      category: 'Recent' as const,
      entityType: n.entity_type,
      nodeData: n,
      action: () => selectNode(n),
    }))
    if (recentItems.length > 0) result.push({ category: 'Recent', items: recentItems })

    // 3. NODES — only when query active; exclude anchors + recent
    if (q) {
      const shownIds = new Set([...anchorIds, ...recentIds])
      const nodeItems: PaletteItem[] = searchResults
        .filter(n => !shownIds.has(n.id))
        .map(n => ({
          id: `node-${n.id}`,
          label: n.label,
          category: 'Nodes' as const,
          entityType: n.entity_type,
          nodeData: n,
          action: () => selectNode(n),
        }))
      if (nodeItems.length > 0) result.push({ category: 'Nodes', items: nodeItems })
    }

    // 4. NAVIGATION — always
    const navItems: PaletteItem[] = NAV_ITEMS.map(nav => ({
      id: nav.id,
      label: nav.label,
      category: 'Navigation' as const,
      icon: nav.icon,
      action: () => {
        if (nav.id === 'nav-settings') { onOpenSettings(); return }
        onClose()
        navigate(nav.route!)
      },
    }))
    result.push({ category: 'Navigation', items: navItems })

    return result
  }, [query, anchors, recentNodes, searchResults, selectNode, onClose, onOpenSettings, navigate])

  const allItems = useMemo(() => sections.flatMap(s => s.items), [sections])

  // Reset highlight when result set changes
  useEffect(() => { setHighlightedIndex(0) }, [allItems.length, query])

  // Keyboard navigation with wrap-around
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (!allItems.length) {
      if (e.key === 'Escape') onClose()
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlightedIndex(prev => (prev + 1) % allItems.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlightedIndex(prev => (prev - 1 + allItems.length) % allItems.length)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      allItems[highlightedIndex]?.action()
    } else if (e.key === 'Escape') {
      onClose()
    }
  }, [allItems, highlightedIndex, onClose])

  // Scroll highlighted item into view
  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-index="${highlightedIndex}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [highlightedIndex])

  const hasQuery = query.trim().length > 0
  const hasNodeMatches = sections.some(s => s.category !== 'Navigation')
  const showEmptySearch = hasQuery && !isSearching && !hasNodeMatches

  let flatIndex = -1

  return (
    <div
      className="fixed inset-0 flex justify-center z-50"
      style={{
        background: 'rgba(0,0,0,0.55)',
        backdropFilter: 'blur(8px)',
        paddingTop: 100,
        alignItems: 'flex-start',
      }}
      onClick={onClose}
    >
      <div
        className="flex flex-col overflow-hidden"
        style={{
          width: 520,
          maxHeight: 460,
          background: 'var(--color-bg-card)',
          border: '1px solid var(--border-strong)',
          borderRadius: 16,
          boxShadow: '0 25px 60px rgba(0,0,0,0.2)',
        }}
        onClick={e => e.stopPropagation()}
      >
        {/* Search input bar */}
        <div
          className="flex items-center gap-3 shrink-0"
          style={{ padding: '14px 18px', borderBottom: '1px solid var(--border-subtle)' }}
        >
          <Search size={15} style={{ color: 'var(--color-text-secondary)', flexShrink: 0 }} />
          <input
            ref={inputRef}
            type="text"
            placeholder="Search nodes, navigate, capture..."
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            className="flex-1 bg-transparent border-none outline-none font-body text-[14px] text-text-primary placeholder:text-text-placeholder"
          />
          {isSearching && (
            <Loader2
              size={12}
              className="animate-spin shrink-0"
              style={{ color: 'var(--color-text-secondary)' }}
            />
          )}
          <span
            className="inline-flex items-center rounded border font-body text-[10px] shrink-0"
            style={{
              padding: '2px 6px',
              background: 'var(--color-bg-inset)',
              borderColor: 'var(--border-subtle)',
              color: 'var(--color-text-secondary)',
            }}
          >
            ESC
          </span>
        </div>

        {/* Results area */}
        <div ref={listRef} className="flex-1 overflow-y-auto" style={{ padding: 6 }}>
          {showEmptySearch && (
            <p
              className="font-body text-center"
              style={{ fontSize: 12, color: 'var(--color-text-placeholder)', padding: '16px 12px 4px' }}
            >
              No nodes found for &ldquo;{query.trim()}&rdquo;
            </p>
          )}

          {sections.map(section => (
            <div key={section.category} className="mb-1">
              <div style={{ padding: '8px 12px 4px' }}>
                <SectionLabel>{section.category}</SectionLabel>
              </div>

              {section.items.map(item => {
                flatIndex++
                const idx = flatIndex
                const isHighlighted = idx === highlightedIndex
                const isNode = item.category !== 'Navigation'

                return (
                  <button
                    key={item.id}
                    type="button"
                    data-index={idx}
                    onClick={item.action}
                    onMouseEnter={() => setHighlightedIndex(idx)}
                    className="flex items-center gap-2.5 w-full border-none cursor-pointer"
                    style={{
                      padding: '7px 12px',
                      borderRadius: 8,
                      background: isHighlighted ? 'var(--color-bg-hover)' : 'transparent',
                      transition: 'background 0.1s ease',
                    }}
                  >
                    {/* Left icon — entity dot for nodes, lucide icon for nav */}
                    {isNode ? (
                      <Dot type={item.entityType ?? ''} size={7} />
                    ) : (
                      <span style={{ color: 'var(--color-text-secondary)', display: 'flex', flexShrink: 0 }}>
                        {item.icon && <item.icon size={14} strokeWidth={1.8} />}
                      </span>
                    )}

                    {/* Label + subtitle */}
                    <div className="flex-1 min-w-0 text-left">
                      <span
                        className="font-body font-medium text-text-primary block truncate"
                        style={{ fontSize: 13 }}
                      >
                        {item.label}
                      </span>
                      {isNode && item.nodeData?.description && (
                        <span
                          className="font-body block truncate"
                          style={{ fontSize: 11, color: 'var(--color-text-secondary)', marginTop: 1 }}
                        >
                          {item.nodeData.description}
                        </span>
                      )}
                    </div>

                    {/* Entity type badge (nodes only) */}
                    {isNode && (
                      <span
                        className="font-body shrink-0"
                        style={{ fontSize: 10, color: 'var(--color-text-secondary)' }}
                      >
                        {item.entityType}
                      </span>
                    )}

                    {/* ArrowRight affordance on highlighted node items */}
                    {isNode && isHighlighted && (
                      <ArrowRight
                        size={12}
                        style={{ color: 'var(--color-text-placeholder)', flexShrink: 0 }}
                      />
                    )}
                  </button>
                )
              })}
            </div>
          ))}

          {allItems.length === 0 && !showEmptySearch && (
            <p className="font-body text-center text-[12px] text-text-placeholder py-8">
              No results
            </p>
          )}
        </div>

        {/* Footer */}
        <div
          className="flex items-center gap-4 shrink-0"
          style={{ padding: '8px 16px', borderTop: '1px solid var(--border-subtle)' }}
        >
          <span className="font-body text-[10px] text-text-secondary">↑↓ Navigate</span>
          <span className="font-body text-[10px] text-text-secondary">↵ Select</span>
          <span className="font-body text-[10px] text-text-secondary">Esc Close</span>
        </div>
      </div>
    </div>
  )
}
