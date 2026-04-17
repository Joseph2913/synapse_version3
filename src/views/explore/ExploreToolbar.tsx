import { useState, useRef, useEffect } from 'react'
import { ChevronDown, Anchor as AnchorIcon, X } from 'lucide-react'
import { getEntityColor } from '../../config/entityTypes'
import type { ExploreViewMode, ExploreFilters, ClusterData, SourceConnectionType } from '../../types/explore'

// Connection-type metadata for sources view
const CONN_TYPE_META: { type: SourceConnectionType; color: string; label: string }[] = [
  { type: 'entity', color: '#6366f1', label: 'Shared entities' },
  { type: 'anchor', color: '#b45309', label: 'Common anchors' },
]

// Edge type metadata for anchors neighborhood view
const NEIGHBORHOOD_EDGE_META = [
  { type: 'direct', color: 'var(--color-accent-500)', label: 'Knowledge' },
  { type: 'source', color: 'rgba(37,99,235,0.9)',     label: 'Same source' },
  { type: 'tag',    color: 'rgba(124,58,237,0.9)',    label: 'Shared tag' },
]

interface ExploreToolbarProps {
  viewMode: ExploreViewMode
  onViewModeChange: (mode: ExploreViewMode) => void
  filters: ExploreFilters
  clusters: ClusterData[]
  showEdges: boolean
  onToggleShowEdges: () => void
  // Anchors view filters
  onToggleAnchor: (anchorId: string) => void
  onEnterNeighborhood?: (anchorId: string) => void
  onClearAnchor?: () => void
  visibleEdgeTypes?: Set<string>
  onToggleNeighborhoodEdgeType?: (type: string) => void
  // Sources view filters
  onToggleConnType?: (type: SourceConnectionType) => void
  // Clear all
  onClearAllFilters?: () => void
}

const PILL_BASE: React.CSSProperties = {
  padding: '5px 13px',
  borderRadius: 20,
  fontSize: 12,
  fontFamily: 'var(--font-body)',
  fontWeight: 600,
  cursor: 'pointer',
  transition: 'all 0.15s ease',
  border: '1px solid var(--border-subtle)',
  background: 'transparent',
  color: 'var(--color-text-secondary)',
  flexShrink: 0,
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  whiteSpace: 'nowrap',
}

const PILL_ACTIVE: React.CSSProperties = {
  ...PILL_BASE,
  border: '1px solid rgba(214,58,0,0.15)',
  background: 'var(--color-accent-50)',
  color: 'var(--color-accent-500)',
}

export function ExploreToolbar({
  viewMode,
  onViewModeChange,
  filters,
  clusters,
  showEdges,
  onToggleShowEdges,
  onToggleAnchor,
  onEnterNeighborhood,
  onClearAnchor,
  visibleEdgeTypes,
  onToggleNeighborhoodEdgeType,
  onToggleConnType,
  onClearAllFilters,
}: ExploreToolbarProps) {
  const [anchorOpen, setAnchorOpen] = useState(false)
  const anchorRef = useRef<HTMLDivElement>(null)
  const [connTypeOpen, setConnTypeOpen] = useState(false)
  const connTypeRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!anchorOpen) return
    const handler = (e: MouseEvent) => {
      if (anchorRef.current && !anchorRef.current.contains(e.target as Node)) setAnchorOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [anchorOpen])

  useEffect(() => {
    if (!connTypeOpen) return
    const handler = (e: MouseEvent) => {
      if (connTypeRef.current && !connTypeRef.current.contains(e.target as Node)) setConnTypeOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [connTypeOpen])

  // Derive active filter states
  const anchorsActiveCluster = clusters.find(c => c.anchor.id === filters.activeAnchorId)
  const isAnchorFilterActive = viewMode === 'anchors' ? !!anchorsActiveCluster : false

  const isConnTypeFilterActive = viewMode === 'sources'
    ? filters.connTypes.size > 0
    : (visibleEdgeTypes ? visibleEdgeTypes.size < NEIGHBORHOOD_EDGE_META.length : false)

  const hasActiveFilters = isAnchorFilterActive || isConnTypeFilterActive

  return (
    <div
      className="shrink-0"
      style={{
        position: 'relative',
        background: 'var(--color-bg-card)',
        borderBottom: '1px solid var(--border-subtle)',
        padding: '0 24px',
        minHeight: 44,
        display: 'flex',
        alignItems: 'center',
      }}
    >
      {/* ── LEFT: Filters ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1 }}>

        {/* 1. Show connections toggle */}
        <button
          type="button"
          onClick={onToggleShowEdges}
          style={showEdges ? PILL_ACTIVE : PILL_BASE}
        >
          <svg width={14} height={10} viewBox="0 0 14 10" style={{ flexShrink: 0 }}>
            <circle cx={2} cy={5} r={2} fill="currentColor" opacity={0.7} />
            <line x1={4} y1={5} x2={10} y2={5} stroke="currentColor" strokeWidth={1.5} opacity={0.7} />
            <circle cx={12} cy={5} r={2} fill="currentColor" opacity={0.7} />
          </svg>
          Connections
        </button>

        <Divider />

        {/* 2. Anchors dropdown */}
        <div ref={anchorRef} style={{ position: 'relative' }}>
          <button
            type="button"
            onClick={() => setAnchorOpen(prev => !prev)}
            style={isAnchorFilterActive ? PILL_ACTIVE : PILL_BASE}
          >
            <AnchorIcon size={13} style={{ flexShrink: 0 }} />
            {anchorsActiveCluster ? anchorsActiveCluster.anchor.label : 'Anchors'}
            <ChevronDown size={12} style={{ flexShrink: 0, opacity: 0.6 }} />
          </button>

          {anchorOpen && (
            <div style={{
              position: 'absolute', top: '100%', left: 0, marginTop: 4,
              background: 'var(--color-bg-card)', border: '1px solid var(--border-strong)',
              borderRadius: 10, boxShadow: '0 8px 24px rgba(0,0,0,0.1)',
              padding: 6, zIndex: 40, minWidth: 200, maxHeight: 300, overflowY: 'auto',
            }}>
              {viewMode === 'anchors' ? (
                <>
                  {anchorsActiveCluster && (
                    <button
                      type="button"
                      onClick={() => { onClearAnchor?.(); setAnchorOpen(false) }}
                      className="w-full font-body"
                      style={{ padding: '7px 10px', fontSize: 11, color: 'var(--color-text-secondary)', background: 'none', border: 'none', borderRadius: 6, textAlign: 'left', cursor: 'pointer' }}
                    >
                      All anchors
                    </button>
                  )}
                  {clusters.map(c => (
                    <button
                      key={c.anchor.id}
                      type="button"
                      onClick={() => {
                        if (onEnterNeighborhood) onEnterNeighborhood(c.anchor.id)
                        else onToggleAnchor(c.anchor.id)
                        setAnchorOpen(false)
                      }}
                      className="flex items-center gap-2 w-full font-body"
                      style={{
                        padding: '7px 10px', fontSize: 11,
                        fontWeight: filters.activeAnchorId === c.anchor.id ? 600 : 400,
                        color: filters.activeAnchorId === c.anchor.id ? 'var(--color-text-primary)' : 'var(--color-text-body)',
                        background: filters.activeAnchorId === c.anchor.id ? 'var(--color-bg-active)' : 'none',
                        border: 'none', borderRadius: 6, textAlign: 'left', cursor: 'pointer',
                        transition: 'background 0.1s ease',
                      }}
                    >
                      <span style={{ width: 7, height: 7, borderRadius: '50%', background: getEntityColor(c.anchor.entityType), flexShrink: 0 }} />
                      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.anchor.label}</span>
                      <span style={{ fontSize: 9, color: 'var(--color-text-secondary)', flexShrink: 0 }}>{c.entityCount}</span>
                    </button>
                  ))}
                </>
              ) : null}
            </div>
          )}
        </div>

        {/* 3. Connection Types dropdown */}
        <div ref={connTypeRef} style={{ position: 'relative' }}>
          <button
            type="button"
            onClick={() => setConnTypeOpen(prev => !prev)}
            style={isConnTypeFilterActive ? PILL_ACTIVE : PILL_BASE}
          >
            Connection Types
            <ChevronDown size={12} style={{ flexShrink: 0, opacity: 0.6 }} />
          </button>

          {connTypeOpen && (
            <div style={{
              position: 'absolute', top: '100%', left: 0, marginTop: 4,
              background: 'var(--color-bg-card)', border: '1px solid var(--border-strong)',
              borderRadius: 10, boxShadow: '0 8px 24px rgba(0,0,0,0.1)',
              padding: 6, zIndex: 40, minWidth: 180,
            }}>
              {viewMode === 'anchors' ? (
                visibleEdgeTypes && onToggleNeighborhoodEdgeType
                  ? NEIGHBORHOOD_EDGE_META.map(({ type, color, label }) => {
                      const isOn = visibleEdgeTypes.has(type)
                      return (
                        <button
                          key={type}
                          type="button"
                          onClick={() => onToggleNeighborhoodEdgeType(type)}
                          className="flex items-center gap-2 w-full font-body"
                          style={{
                            padding: '7px 10px', fontSize: 11,
                            fontWeight: isOn ? 600 : 400,
                            color: isOn ? 'var(--color-text-primary)' : 'var(--color-text-body)',
                            background: isOn ? 'var(--color-bg-active)' : 'none',
                            border: 'none', borderRadius: 6, textAlign: 'left', cursor: 'pointer',
                            transition: 'background 0.1s ease',
                          }}
                        >
                          <span style={{ width: 7, height: 7, borderRadius: '50%', background: color, flexShrink: 0 }} />
                          <span style={{ flex: 1 }}>{label}</span>
                        </button>
                      )
                    })
                  : null
              ) : (
                CONN_TYPE_META.map(({ type, color, label }) => {
                  const isOn = filters.connTypes.has(type)
                  return (
                    <button
                      key={type}
                      type="button"
                      onClick={() => onToggleConnType?.(type)}
                      className="flex items-center gap-2 w-full font-body"
                      style={{
                        padding: '7px 10px', fontSize: 11,
                        fontWeight: isOn ? 600 : 400,
                        color: isOn ? 'var(--color-text-primary)' : 'var(--color-text-body)',
                        background: isOn ? 'var(--color-bg-active)' : 'none',
                        border: 'none', borderRadius: 6, textAlign: 'left', cursor: 'pointer',
                        transition: 'background 0.1s ease',
                      }}
                    >
                      <span style={{ width: 7, height: 7, borderRadius: '50%', background: color, flexShrink: 0 }} />
                      <span style={{ flex: 1 }}>{label}</span>
                    </button>
                  )
                })
              )}
            </div>
          )}
        </div>

        {/* 4. Clear filters */}
        {hasActiveFilters && onClearAllFilters && (
          <>
            <Divider />
            <button
              type="button"
              onClick={onClearAllFilters}
              className="flex items-center gap-1.5 font-body font-semibold"
              style={{
                padding: '5px 13px', fontSize: 12, borderRadius: 20,
                border: '1px solid rgba(214,58,0,0.15)',
                background: 'var(--color-accent-50)',
                color: 'var(--color-accent-500)',
                cursor: 'pointer', transition: 'all 0.15s ease',
                display: 'flex', alignItems: 'center', gap: 5, flexShrink: 0,
              }}
            >
              <X size={11} />
              Clear
            </button>
          </>
        )}

      </div>

      {/* ── CENTER: Anchors / Sources tab toggle (absolutely centered) ── */}
      <div style={{
        position: 'absolute', left: '50%', transform: 'translateX(-50%)',
        display: 'flex', alignItems: 'center', gap: 2,
        background: 'var(--color-bg-inset)',
        borderRadius: 22, padding: 3,
        border: '1px solid var(--border-subtle)',
      }}>
        {(['sources', 'anchors'] as const).map(mode => {
          const isActive = viewMode === mode
          const labels: Record<string, string> = { anchors: 'Anchors', sources: 'Sources' }
          return (
            <button
              key={mode}
              type="button"
              onClick={() => onViewModeChange(mode)}
              className="font-body font-semibold"
              style={{
                padding: '4px 14px',
                borderRadius: 18,
                fontSize: 12,
                border: 'none',
                background: isActive ? 'var(--color-bg-card)' : 'transparent',
                color: isActive ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
                cursor: 'pointer',
                transition: 'all 0.15s ease',
                boxShadow: isActive ? '0 1px 3px rgba(0,0,0,0.08)' : 'none',
              }}
            >
              {labels[mode]}
            </button>
          )
        })}
      </div>

      {/* ── RIGHT: Spacer to balance layout ── */}
      <div style={{ flex: 1 }} />
    </div>
  )
}

function Divider() {
  return <div style={{ width: 1, height: 24, background: 'var(--border-subtle)', flexShrink: 0 }} />
}
