import { useState, useRef, useEffect, useCallback } from 'react'
import { ChevronDown, Eye, EyeOff, Anchor as AnchorIcon, Search, X, LayoutGrid, List } from 'lucide-react'
import { getEntityColor, ENTITY_TYPE_COLORS } from '../../config/entityTypes'
import { getSourceConfig } from '../../config/sourceTypes'
import type { ExploreViewMode, ExploreFilters, ClusterData, SourceConnectionType, SourceGraphAnchor } from '../../types/explore'
import type { EntityBrowserState } from '../../hooks/useEntityBrowser'
import type { EntitySortOption } from '../../hooks/useEntityBrowser'

// Connection-type metadata for the dropdown (tag removed — too noisy)
const CONN_TYPE_META: { type: SourceConnectionType; color: string; label: string }[] = [
  { type: 'entity', color: '#6366f1', label: 'Shared entities' },
  { type: 'anchor', color: '#b45309', label: 'Common anchors' },
]

// Neighborhood edge-type metadata for the Connection Types dropdown
const NEIGHBORHOOD_EDGE_META = [
  { type: 'direct', color: 'var(--color-accent-500)', label: 'Knowledge' },
  { type: 'source', color: 'rgba(37,99,235,0.9)',     label: 'Same source' },
  { type: 'tag',    color: 'rgba(124,58,237,0.9)',    label: 'Shared tag' },
]

interface ExploreToolbarProps {
  viewMode: ExploreViewMode
  onViewModeChange: (mode: ExploreViewMode) => void
  filters: ExploreFilters
  onToggleAnchor: (anchorId: string) => void
  onEnterNeighborhood?: (anchorId: string) => void
  onClearAnchor?: () => void
  onToggleSpotlight: (entityType: string | null) => void
  onRecencyChange: (recency: ExploreFilters['recency']) => void
  clusters: ClusterData[]
  // Neighborhood-specific
  isNeighborhood?: boolean
  showEdges?: boolean
  onToggleShowEdges?: () => void
  visibleEdgeTypes?: Set<string>
  onToggleNeighborhoodEdgeType?: (type: string) => void
  onClearAllFilters?: () => void
  // Source-mode filter props
  sourceTypesPresent?: string[]
  sourceGraphAnchors?: SourceGraphAnchor[]
  onToggleSourceType?: (type: string) => void
  onToggleConnType?: (type: SourceConnectionType) => void
  onSetSourceAnchorFilter?: (anchorId: string | null) => void
  // Entity browser state (passed from ExploreView, controls rendered inline)
  entityBrowser?: EntityBrowserState
  suggestedCount?: number
  showCrossEdges?: boolean
  onToggleShowCrossEdges?: () => void
}

const RECENCY_OPTIONS: { key: ExploreFilters['recency']; label: string }[] = [
  { key: '7d', label: '7 days' },
  { key: '30d', label: '30 days' },
  { key: 'all', label: 'All' },
]

// Entity types to show in spotlight dropdown
const SPOTLIGHT_TYPES = Object.keys(ENTITY_TYPE_COLORS).filter(t => t !== 'Anchor')

export function ExploreToolbar({
  viewMode,
  onViewModeChange,
  filters,
  onToggleAnchor,
  onEnterNeighborhood,
  onClearAnchor,
  onToggleSpotlight,
  onRecencyChange,
  clusters,
  isNeighborhood,
  showEdges,
  onToggleShowEdges,
  visibleEdgeTypes,
  onToggleNeighborhoodEdgeType,
  onClearAllFilters,
  sourceTypesPresent,
  sourceGraphAnchors,
  onToggleSourceType,
  onToggleConnType,
  onSetSourceAnchorFilter,
  entityBrowser,
  suggestedCount,
  showCrossEdges,
  onToggleShowCrossEdges,
}: ExploreToolbarProps) {
  const [spotlightOpen, setSpotlightOpen] = useState(false)
  const spotlightRef = useRef<HTMLDivElement>(null)
  const [anchorOpen, setAnchorOpen] = useState(false)
  const anchorRef = useRef<HTMLDivElement>(null)

  // Neighborhood edge-type dropdown state
  const [nbEdgeOpen, setNbEdgeOpen] = useState(false)
  const nbEdgeRef = useRef<HTMLDivElement>(null)

  // Source-mode dropdown state
  const [srcTypeOpen, setSrcTypeOpen] = useState(false)
  const srcTypeRef = useRef<HTMLDivElement>(null)
  const [connTypeOpen, setConnTypeOpen] = useState(false)
  const connTypeRef = useRef<HTMLDivElement>(null)
  const [srcAnchorOpen, setSrcAnchorOpen] = useState(false)
  const srcAnchorRef = useRef<HTMLDivElement>(null)

  // Entity browser dropdown state
  const [ebTypeOpen, setEbTypeOpen] = useState(false)
  const ebTypeRef = useRef<HTMLDivElement>(null)
  const [ebSrcOpen, setEbSrcOpen] = useState(false)
  const ebSrcRef = useRef<HTMLDivElement>(null)
  const [ebTagOpen, setEbTagOpen] = useState(false)
  const ebTagRef = useRef<HTMLDivElement>(null)
  const [ebSortOpen, setEbSortOpen] = useState(false)
  const ebSortRef = useRef<HTMLDivElement>(null)

  const closeEbDropdowns = useCallback((e: MouseEvent) => {
    if (ebTypeRef.current && !ebTypeRef.current.contains(e.target as Node)) setEbTypeOpen(false)
    if (ebSrcRef.current && !ebSrcRef.current.contains(e.target as Node)) setEbSrcOpen(false)
    if (ebTagRef.current && !ebTagRef.current.contains(e.target as Node)) setEbTagOpen(false)
    if (ebSortRef.current && !ebSortRef.current.contains(e.target as Node)) setEbSortOpen(false)
  }, [])

  useEffect(() => {
    if (!ebTypeOpen && !ebSrcOpen && !ebTagOpen && !ebSortOpen) return
    document.addEventListener('mousedown', closeEbDropdowns)
    return () => document.removeEventListener('mousedown', closeEbDropdowns)
  }, [ebTypeOpen, ebSrcOpen, ebTagOpen, ebSortOpen, closeEbDropdowns])

  // Close spotlight dropdown on outside click
  useEffect(() => {
    if (!spotlightOpen) return
    const handler = (e: MouseEvent) => {
      if (spotlightRef.current && !spotlightRef.current.contains(e.target as Node)) {
        setSpotlightOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [spotlightOpen])

  // Close anchor dropdown on outside click
  useEffect(() => {
    if (!anchorOpen) return
    const handler = (e: MouseEvent) => {
      if (anchorRef.current && !anchorRef.current.contains(e.target as Node)) {
        setAnchorOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [anchorOpen])

  // Close neighborhood edge-type dropdown on outside click
  useEffect(() => {
    if (!nbEdgeOpen) return
    const handler = (e: MouseEvent) => {
      if (nbEdgeRef.current && !nbEdgeRef.current.contains(e.target as Node)) setNbEdgeOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [nbEdgeOpen])

  // Close source-mode dropdowns on outside click
  useEffect(() => {
    if (!srcTypeOpen) return
    const handler = (e: MouseEvent) => {
      if (srcTypeRef.current && !srcTypeRef.current.contains(e.target as Node)) setSrcTypeOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [srcTypeOpen])

  useEffect(() => {
    if (!connTypeOpen) return
    const handler = (e: MouseEvent) => {
      if (connTypeRef.current && !connTypeRef.current.contains(e.target as Node)) setConnTypeOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [connTypeOpen])

  useEffect(() => {
    if (!srcAnchorOpen) return
    const handler = (e: MouseEvent) => {
      if (srcAnchorRef.current && !srcAnchorRef.current.contains(e.target as Node)) setSrcAnchorOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [srcAnchorOpen])

  const activeAnchor = clusters.find(c => c.anchor.id === filters.activeAnchorId)
  const activeSourceAnchor = sourceGraphAnchors?.find(a => a.id === filters.sourceAnchorFilter)
  const activeSourceTypeCount = filters.sourceTypes.size
  const activeConnTypeCount = filters.connTypes.size

  return (
    <div
      className="flex items-center shrink-0"
      style={{
        background: 'var(--color-bg-card)',
        borderBottom: '1px solid var(--border-subtle)',
        padding: '8px 24px',
        minHeight: 44,
        gap: 8,
      }}
    >
      {/* 1. Tab switcher: Anchors / Entities / Sources — pill buttons */}
      {(['anchors', 'entity-browser', 'sources', 'graph'] as const).map(mode => {
        const labels: Record<string, string> = { anchors: 'Anchors', 'entity-browser': 'Entities', sources: 'Sources', graph: 'Graph' }
        const isActive = viewMode === mode
        return (
          <button
            key={mode}
            type="button"
            onClick={() => onViewModeChange(mode)}
            className="font-body font-semibold"
            style={{
              padding: '5px 13px',
              borderRadius: 20,
              fontSize: 12,
              border: isActive ? '1px solid rgba(214,58,0,0.15)' : '1px solid var(--border-subtle)',
              background: isActive ? 'var(--color-accent-50)' : 'transparent',
              color: isActive ? 'var(--color-accent-500)' : 'var(--color-text-secondary)',
              cursor: 'pointer',
              transition: 'all 0.15s',
              flexShrink: 0,
            }}
          >
            {labels[mode]}
          </button>
        )
      })}

      <Divider />

      {/* Suggested clusters notification */}
      {(suggestedCount ?? 0) > 0 && viewMode === 'anchors' && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 6,
          padding: '4px 10px', borderRadius: 20,
          background: 'rgba(245,158,11,0.08)',
          border: '1px solid rgba(245,158,11,0.25)',
          flexShrink: 0,
        }}>
          <span style={{
            fontFamily: 'var(--font-body)', fontSize: 11, fontWeight: 600, color: '#d97706',
          }}>
            ✦ {suggestedCount} new cluster{suggestedCount !== 1 ? 's' : ''} detected
          </span>
          <button
            type="button"
            onClick={() => { window.location.href = '/anchors' }}
            style={{
              fontFamily: 'var(--font-body)', fontSize: 11, fontWeight: 600, color: '#d97706',
              background: 'none', border: 'none', padding: 0, cursor: 'pointer',
              textDecoration: 'underline', textUnderlineOffset: 2,
            }}
          >
            Review →
          </button>
        </div>
      )}

      {/* Cross-edges toggle */}
      {viewMode === 'anchors' && !isNeighborhood && onToggleShowCrossEdges && (
        <button
          type="button"
          onClick={onToggleShowCrossEdges}
          style={{
            display: 'flex', alignItems: 'center', gap: 5,
            padding: '4px 10px', borderRadius: 20,
            fontSize: 11, fontWeight: 600,
            fontFamily: 'var(--font-body)',
            border: `1px solid ${showCrossEdges ? 'rgba(100,116,139,0.3)' : 'var(--border-subtle)'}`,
            background: showCrossEdges ? 'rgba(100,116,139,0.06)' : 'transparent',
            color: showCrossEdges ? 'rgb(71,85,105)' : 'var(--color-text-secondary)',
            cursor: 'pointer',
            transition: 'all 0.15s ease',
            flexShrink: 0,
          }}
        >
          <svg width={14} height={10} viewBox="0 0 14 10" style={{ flexShrink: 0 }}>
            <circle cx={2} cy={5} r={2} fill="currentColor" opacity={0.6} />
            <line x1={4} y1={5} x2={10} y2={5} stroke="currentColor" strokeWidth={1.5} opacity={0.6} />
            <circle cx={12} cy={5} r={2} fill="currentColor" opacity={0.6} />
          </svg>
          Connections
        </button>
      )}

      {/* 2. Anchor dropdown (entities mode only) */}
      {viewMode === 'anchors' && clusters.length > 0 && (
        <>
          <div ref={anchorRef} className="relative">
            <button
              type="button"
              onClick={() => setAnchorOpen(prev => !prev)}
              className="flex items-center gap-2 cursor-pointer font-body font-semibold"
              style={{
                padding: '5px 13px',
                fontSize: 12,
                borderRadius: 20,
                border: activeAnchor
                  ? '1px solid rgba(214,58,0,0.15)'
                  : '1px solid var(--border-subtle)',
                background: activeAnchor
                  ? 'var(--color-accent-50)'
                  : 'transparent',
                color: activeAnchor
                  ? 'var(--color-accent-500)'
                  : 'var(--color-text-secondary)',
                transition: 'all 0.15s ease',
                whiteSpace: 'nowrap',
              }}
            >
              <AnchorIcon size={13} style={{ flexShrink: 0 }} />
              {activeAnchor ? activeAnchor.anchor.label : 'Anchors'}
              <ChevronDown size={12} style={{ flexShrink: 0, opacity: 0.6 }} />
            </button>

            {anchorOpen && (
              <div
                style={{
                  position: 'absolute',
                  top: '100%',
                  left: 0,
                  marginTop: 4,
                  background: 'var(--color-bg-card)',
                  border: '1px solid var(--border-strong)',
                  borderRadius: 10,
                  boxShadow: '0 8px 24px rgba(0,0,0,0.1)',
                  padding: 6,
                  zIndex: 40,
                  minWidth: 200,
                  maxHeight: 300,
                  overflowY: 'auto',
                }}
              >
                {/* Clear option */}
                {activeAnchor && (
                  <button
                    type="button"
                    onClick={() => {
                      if (onClearAnchor) onClearAnchor()
                      else onToggleAnchor(activeAnchor.anchor.id)
                      setAnchorOpen(false)
                    }}
                    className="flex items-center gap-2 w-full cursor-pointer font-body"
                    style={{
                      padding: '7px 10px',
                      fontSize: 11,
                      color: 'var(--color-text-secondary)',
                      background: 'none',
                      border: 'none',
                      borderRadius: 6,
                      textAlign: 'left',
                    }}
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
                    className="flex items-center gap-2 w-full cursor-pointer font-body"
                    style={{
                      padding: '7px 10px',
                      fontSize: 11,
                      fontWeight: filters.activeAnchorId === c.anchor.id ? 600 : 400,
                      color: filters.activeAnchorId === c.anchor.id
                        ? 'var(--color-text-primary)'
                        : 'var(--color-text-body)',
                      background: filters.activeAnchorId === c.anchor.id
                        ? 'var(--color-bg-active)'
                        : 'none',
                      border: 'none',
                      borderRadius: 6,
                      textAlign: 'left',
                      transition: 'background 0.1s ease',
                    }}
                  >
                    <span
                      style={{
                        width: 7,
                        height: 7,
                        borderRadius: '50%',
                        background: getEntityColor(c.anchor.entityType),
                        flexShrink: 0,
                      }}
                    />
                    <span className="flex-1" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {c.anchor.label}
                    </span>
                    <span
                      style={{
                        fontSize: 9,
                        color: 'var(--color-text-secondary)',
                        flexShrink: 0,
                      }}
                    >
                      {c.entityCount}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <Divider />
        </>
      )}

      {/* 3. Entity Types dropdown (entities mode only) */}
      {viewMode === 'anchors' && (
        <div ref={spotlightRef} className="relative">
          <button
            type="button"
            onClick={() => setSpotlightOpen(prev => !prev)}
            className="flex items-center gap-1.5 cursor-pointer font-body font-semibold"
            style={{
              padding: '5px 13px',
              fontSize: 12,
              borderRadius: 20,
              border: filters.spotlightEntityType
                ? '1px solid rgba(214,58,0,0.15)'
                : '1px solid var(--border-subtle)',
              background: filters.spotlightEntityType
                ? 'var(--color-accent-50)'
                : 'transparent',
              color: filters.spotlightEntityType
                ? 'var(--color-accent-500)'
                : 'var(--color-text-secondary)',
              transition: 'all 0.15s ease',
              whiteSpace: 'nowrap',
            }}
          >
            {filters.spotlightEntityType && (
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  background: getEntityColor(filters.spotlightEntityType),
                  flexShrink: 0,
                }}
              />
            )}
            {filters.spotlightEntityType || 'Entity Types'}
            <ChevronDown size={12} />
          </button>

          {spotlightOpen && (
            <div
              style={{
                position: 'absolute',
                top: '100%',
                left: 0,
                marginTop: 4,
                background: 'var(--color-bg-card)',
                border: '1px solid var(--border-strong)',
                borderRadius: 10,
                boxShadow: '0 8px 24px rgba(0,0,0,0.1)',
                padding: 6,
                zIndex: 40,
                minWidth: 160,
                maxHeight: 280,
                overflowY: 'auto',
              }}
            >
              {/* Clear option */}
              {filters.spotlightEntityType && (
                <button
                  type="button"
                  onClick={() => {
                    onToggleSpotlight(null)
                    setSpotlightOpen(false)
                  }}
                  className="flex items-center gap-2 w-full cursor-pointer font-body"
                  style={{
                    padding: '6px 10px',
                    fontSize: 11,
                    color: 'var(--color-text-secondary)',
                    background: 'none',
                    border: 'none',
                    borderRadius: 6,
                    textAlign: 'left',
                  }}
                >
                  Clear filter
                </button>
              )}
              {SPOTLIGHT_TYPES.map(type => (
                <button
                  key={type}
                  type="button"
                  onClick={() => {
                    onToggleSpotlight(type)
                    setSpotlightOpen(false)
                  }}
                  className="flex items-center gap-2 w-full cursor-pointer font-body"
                  style={{
                    padding: '6px 10px',
                    fontSize: 11,
                    fontWeight: filters.spotlightEntityType === type ? 600 : 400,
                    color: filters.spotlightEntityType === type
                      ? 'var(--color-text-primary)'
                      : 'var(--color-text-body)',
                    background: filters.spotlightEntityType === type
                      ? 'var(--color-bg-active)'
                      : 'none',
                    border: 'none',
                    borderRadius: 6,
                    textAlign: 'left',
                    transition: 'background 0.1s ease',
                  }}
                >
                  <span
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: '50%',
                      background: getEntityColor(type),
                      flexShrink: 0,
                    }}
                  />
                  {type}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Neighborhood Connection Types dropdown */}
      {viewMode === 'anchors' && isNeighborhood && visibleEdgeTypes && onToggleNeighborhoodEdgeType && (
        <>
          <Divider />
          <div ref={nbEdgeRef} className="relative">
            <button
              type="button"
              onClick={() => setNbEdgeOpen(prev => !prev)}
              className="flex items-center gap-1.5 cursor-pointer font-body font-semibold"
              style={{
                padding: '5px 13px',
                fontSize: 12,
                borderRadius: 20,
                border: visibleEdgeTypes.size < 3
                  ? '1px solid rgba(214,58,0,0.15)'
                  : '1px solid var(--border-subtle)',
                background: visibleEdgeTypes.size < 3 ? 'var(--color-accent-50)' : 'transparent',
                color: visibleEdgeTypes.size < 3 ? 'var(--color-accent-500)' : 'var(--color-text-secondary)',
                transition: 'all 0.15s ease',
                whiteSpace: 'nowrap',
              }}
            >
              Connection Types
              <ChevronDown size={12} />
            </button>

            {nbEdgeOpen && (
              <div
                style={{
                  position: 'absolute',
                  top: '100%',
                  left: 0,
                  marginTop: 4,
                  background: 'var(--color-bg-card)',
                  border: '1px solid var(--border-strong)',
                  borderRadius: 10,
                  boxShadow: '0 8px 24px rgba(0,0,0,0.1)',
                  padding: 6,
                  zIndex: 40,
                  minWidth: 160,
                }}
              >
                {NEIGHBORHOOD_EDGE_META.map(({ type, color, label }) => {
                  const isOn = visibleEdgeTypes.has(type)
                  return (
                    <button
                      key={type}
                      type="button"
                      onClick={() => onToggleNeighborhoodEdgeType(type)}
                      className="flex items-center gap-2 w-full cursor-pointer font-body"
                      style={{
                        padding: '7px 10px',
                        fontSize: 11,
                        fontWeight: isOn ? 600 : 400,
                        color: isOn ? 'var(--color-text-primary)' : 'var(--color-text-body)',
                        background: isOn ? 'var(--color-bg-active)' : 'none',
                        border: 'none',
                        borderRadius: 6,
                        textAlign: 'left',
                        transition: 'background 0.1s ease',
                      }}
                    >
                      <span style={{ width: 7, height: 7, borderRadius: '50%', background: color, flexShrink: 0 }} />
                      <span className="flex-1">{label}</span>
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        </>
      )}

      {/* ── Source-mode filter dropdowns ── */}
      {viewMode === 'sources' && sourceTypesPresent && onToggleSourceType && (
        <>
          {/* Source Types dropdown (multi-select) */}
          <div ref={srcTypeRef} className="relative">
            <button
              type="button"
              onClick={() => setSrcTypeOpen(prev => !prev)}
              className="flex items-center gap-1.5 cursor-pointer font-body font-semibold"
              style={{
                padding: '5px 13px',
                fontSize: 12,
                borderRadius: 20,
                border: activeSourceTypeCount > 0
                  ? '1px solid rgba(214,58,0,0.15)'
                  : '1px solid var(--border-subtle)',
                background: activeSourceTypeCount > 0 ? 'var(--color-accent-50)' : 'transparent',
                color: activeSourceTypeCount > 0 ? 'var(--color-accent-500)' : 'var(--color-text-secondary)',
                transition: 'all 0.15s ease',
                whiteSpace: 'nowrap',
              }}
            >
              {activeSourceTypeCount > 0 ? `${activeSourceTypeCount} type${activeSourceTypeCount > 1 ? 's' : ''}` : 'Source Types'}
              <ChevronDown size={12} style={{ flexShrink: 0, opacity: 0.6 }} />
            </button>

            {srcTypeOpen && (
              <div
                style={{
                  position: 'absolute', top: '100%', left: 0, marginTop: 4,
                  background: 'var(--color-bg-card)', border: '1px solid var(--border-strong)',
                  borderRadius: 10, boxShadow: '0 8px 24px rgba(0,0,0,0.1)',
                  padding: 6, zIndex: 40, minWidth: 180,
                }}
              >
                {sourceTypesPresent.map(type => {
                  const cfg = getSourceConfig(type)
                  const isOn = filters.sourceTypes.has(type)
                  return (
                    <button
                      key={type}
                      type="button"
                      onClick={() => onToggleSourceType(type)}
                      className="flex items-center gap-2 w-full cursor-pointer font-body"
                      style={{
                        padding: '7px 10px', fontSize: 11,
                        fontWeight: isOn ? 600 : 400,
                        color: isOn ? 'var(--color-text-primary)' : 'var(--color-text-body)',
                        background: isOn ? 'var(--color-bg-active)' : 'none',
                        border: 'none', borderRadius: 6, textAlign: 'left',
                        transition: 'background 0.1s ease',
                      }}
                    >
                      <span style={{
                        width: 7, height: 7, borderRadius: '50%',
                        background: cfg.color, flexShrink: 0,
                      }} />
                      <span className="flex-1">{type}</span>
                    </button>
                  )
                })}
                {/* Clear filters */}
                {activeSourceTypeCount > 0 && (
                  <>
                    <div style={{ height: 1, background: 'var(--border-subtle)', margin: '4px 0' }} />
                    <button
                      type="button"
                      onClick={() => {
                        for (const st of Array.from(filters.sourceTypes)) onToggleSourceType(st)
                      }}
                      className="flex items-center gap-2 w-full cursor-pointer font-body"
                      style={{
                        padding: '7px 10px', fontSize: 11, fontWeight: 500,
                        color: 'var(--color-text-secondary)',
                        background: 'none', border: 'none', borderRadius: 6, textAlign: 'left',
                      }}
                    >
                      <X size={10} style={{ flexShrink: 0, opacity: 0.5 }} />
                      <span>Clear filters</span>
                    </button>
                  </>
                )}
              </div>
            )}
          </div>

          <Divider />
        </>
      )}

      {viewMode === 'sources' && onToggleConnType && (
        <>
          {/* Connection Types dropdown (multi-select) */}
          <div ref={connTypeRef} className="relative">
            <button
              type="button"
              onClick={() => setConnTypeOpen(prev => !prev)}
              className="flex items-center gap-1.5 cursor-pointer font-body font-semibold"
              style={{
                padding: '5px 13px',
                fontSize: 12,
                borderRadius: 20,
                border: activeConnTypeCount > 0
                  ? '1px solid rgba(214,58,0,0.15)'
                  : '1px solid var(--border-subtle)',
                background: activeConnTypeCount > 0 ? 'var(--color-accent-50)' : 'transparent',
                color: activeConnTypeCount > 0 ? 'var(--color-accent-500)' : 'var(--color-text-secondary)',
                transition: 'all 0.15s ease',
                whiteSpace: 'nowrap',
              }}
            >
              {activeConnTypeCount > 0 ? `${activeConnTypeCount} conn type${activeConnTypeCount > 1 ? 's' : ''}` : 'Connection Types'}
              <ChevronDown size={12} style={{ flexShrink: 0, opacity: 0.6 }} />
            </button>

            {connTypeOpen && (
              <div
                style={{
                  position: 'absolute', top: '100%', left: 0, marginTop: 4,
                  background: 'var(--color-bg-card)', border: '1px solid var(--border-strong)',
                  borderRadius: 10, boxShadow: '0 8px 24px rgba(0,0,0,0.1)',
                  padding: 6, zIndex: 40, minWidth: 180,
                }}
              >
                {CONN_TYPE_META.map(({ type, color, label }) => {
                  const isOn = filters.connTypes.has(type)
                  return (
                    <button
                      key={type}
                      type="button"
                      onClick={() => onToggleConnType(type)}
                      className="flex items-center gap-2 w-full cursor-pointer font-body"
                      style={{
                        padding: '7px 10px', fontSize: 11,
                        fontWeight: isOn ? 600 : 400,
                        color: isOn ? 'var(--color-text-primary)' : 'var(--color-text-body)',
                        background: isOn ? 'var(--color-bg-active)' : 'none',
                        border: 'none', borderRadius: 6, textAlign: 'left',
                        transition: 'background 0.1s ease',
                      }}
                    >
                      <span style={{
                        width: 7, height: 7, borderRadius: '50%',
                        background: color, flexShrink: 0,
                      }} />
                      <span className="flex-1">{label}</span>
                    </button>
                  )
                })}
                {/* Clear filters */}
                {activeConnTypeCount > 0 && (
                  <>
                    <div style={{ height: 1, background: 'var(--border-subtle)', margin: '4px 0' }} />
                    <button
                      type="button"
                      onClick={() => {
                        for (const ct of Array.from(filters.connTypes)) onToggleConnType(ct)
                      }}
                      className="flex items-center gap-2 w-full cursor-pointer font-body"
                      style={{
                        padding: '7px 10px', fontSize: 11, fontWeight: 500,
                        color: 'var(--color-text-secondary)',
                        background: 'none', border: 'none', borderRadius: 6, textAlign: 'left',
                      }}
                    >
                      <X size={10} style={{ flexShrink: 0, opacity: 0.5 }} />
                      <span>Clear filters</span>
                    </button>
                  </>
                )}
              </div>
            )}
          </div>

          <Divider />
        </>
      )}

      {viewMode === 'sources' && sourceGraphAnchors && sourceGraphAnchors.length > 0 && onSetSourceAnchorFilter && (
        <>
          {/* Source Anchor filter dropdown (single-select) */}
          <div ref={srcAnchorRef} className="relative">
            <button
              type="button"
              onClick={() => setSrcAnchorOpen(prev => !prev)}
              className="flex items-center gap-2 cursor-pointer font-body font-semibold"
              style={{
                padding: '5px 13px',
                fontSize: 12,
                borderRadius: 20,
                border: activeSourceAnchor
                  ? '1px solid rgba(180,83,9,0.25)'
                  : '1px solid var(--border-subtle)',
                background: activeSourceAnchor ? 'rgba(180,83,9,0.08)' : 'transparent',
                color: activeSourceAnchor ? '#b45309' : 'var(--color-text-secondary)',
                transition: 'all 0.15s ease',
                whiteSpace: 'nowrap',
              }}
            >
              <AnchorIcon size={13} style={{ flexShrink: 0 }} />
              {activeSourceAnchor ? activeSourceAnchor.label : 'Anchors'}
              <ChevronDown size={12} style={{ flexShrink: 0, opacity: 0.6 }} />
            </button>

            {srcAnchorOpen && (
              <div
                style={{
                  position: 'absolute', top: '100%', left: 0, marginTop: 4,
                  background: 'var(--color-bg-card)', border: '1px solid var(--border-strong)',
                  borderRadius: 10, boxShadow: '0 8px 24px rgba(0,0,0,0.1)',
                  padding: 6, zIndex: 40, minWidth: 200, maxHeight: 300, overflowY: 'auto',
                }}
              >
                {/* Clear option */}
                {activeSourceAnchor && (
                  <button
                    type="button"
                    onClick={() => {
                      onSetSourceAnchorFilter(null)
                      setSrcAnchorOpen(false)
                    }}
                    className="flex items-center gap-2 w-full cursor-pointer font-body"
                    style={{
                      padding: '7px 10px', fontSize: 11,
                      color: 'var(--color-text-secondary)',
                      background: 'none', border: 'none', borderRadius: 6, textAlign: 'left',
                    }}
                  >
                    All anchors
                  </button>
                )}
                {sourceGraphAnchors.map(a => (
                  <button
                    key={a.id}
                    type="button"
                    onClick={() => {
                      onSetSourceAnchorFilter(filters.sourceAnchorFilter === a.id ? null : a.id)
                      setSrcAnchorOpen(false)
                    }}
                    className="flex items-center gap-2 w-full cursor-pointer font-body"
                    style={{
                      padding: '7px 10px', fontSize: 11,
                      fontWeight: filters.sourceAnchorFilter === a.id ? 600 : 400,
                      color: filters.sourceAnchorFilter === a.id
                        ? 'var(--color-text-primary)'
                        : 'var(--color-text-body)',
                      background: filters.sourceAnchorFilter === a.id
                        ? 'var(--color-bg-active)'
                        : 'none',
                      border: 'none', borderRadius: 6, textAlign: 'left',
                      transition: 'background 0.1s ease',
                    }}
                  >
                    <span style={{
                      width: 7, height: 7, borderRadius: '50%',
                      background: getEntityColor(a.entityType), flexShrink: 0,
                    }} />
                    <span className="flex-1" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {a.label}
                    </span>
                    <span style={{ fontSize: 9, color: 'var(--color-text-secondary)', flexShrink: 0 }}>
                      {a.connectedSourceIds.length}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <Divider />
        </>
      )}

      {/* Clear filters button — appears when any filter is active */}
      {onClearAllFilters && (filters.spotlightEntityType || (visibleEdgeTypes && visibleEdgeTypes.size < 3)) && (
        <button
          type="button"
          onClick={onClearAllFilters}
          className="flex items-center gap-1.5 cursor-pointer font-body font-semibold"
          style={{
            padding: '5px 13px',
            fontSize: 12,
            borderRadius: 20,
            border: '1px solid rgba(214,58,0,0.15)',
            background: 'var(--color-accent-50)',
            color: 'var(--color-accent-500)',
            transition: 'all 0.15s ease',
          }}
        >
          Clear filters
        </button>
      )}

      {/* Show edges toggle (neighborhood only) */}
      {isNeighborhood && onToggleShowEdges && (
        <button
          type="button"
          onClick={onToggleShowEdges}
          className="flex items-center gap-1.5 cursor-pointer font-body font-semibold"
          title={showEdges ? 'Hide edges' : 'Show edges'}
          style={{
            padding: '5px 13px',
            fontSize: 12,
            borderRadius: 20,
            border: '1px solid var(--border-subtle)',
            background: showEdges ? 'var(--color-semantic-blue-50)' : 'transparent',
            color: showEdges ? 'var(--color-semantic-blue-700)' : 'var(--color-text-secondary)',
            transition: 'all 0.15s ease',
          }}
        >
          {showEdges ? <Eye size={12} /> : <EyeOff size={12} />}
          Edges
        </button>
      )}

      {/* ── Entity browser controls (entity-browser mode only) ── */}
      {viewMode === 'entity-browser' && entityBrowser && (
        <>
          {/* Search */}
          <div style={{ position: 'relative', flexShrink: 0 }}>
            <Search size={12} style={{
              position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)',
              color: 'var(--color-text-placeholder)', pointerEvents: 'none',
            }} />
            <input
              type="text"
              value={entityBrowser.searchQuery}
              onChange={e => entityBrowser.setSearchQuery(e.target.value)}
              placeholder="Search entities…"
              style={{
                width: 160, padding: '5px 26px 5px 28px',
                fontFamily: 'var(--font-body)', fontSize: 12,
                borderRadius: 20, border: '1px solid var(--border-subtle)',
                background: 'var(--color-bg-inset)', color: 'var(--color-text-primary)', outline: 'none',
              }}
            />
            {entityBrowser.searchQuery && (
              <button type="button" onClick={() => entityBrowser.setSearchQuery('')}
                style={{ position: 'absolute', right: 7, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-text-placeholder)', padding: 2 }}>
                <X size={10} />
              </button>
            )}
          </div>

          <Divider />

          {/* Entity Type filter */}
          <EbDropdown
            ref={ebTypeRef}
            label="Entity Types"
            isOpen={ebTypeOpen}
            onToggle={() => setEbTypeOpen(p => !p)}
            activeCount={entityBrowser.typeFilter.length}
          >
            {[...new Set(entityBrowser.entities.map(e => e.entityType))].sort().map(type => (
              <EbFilterOption
                key={type}
                label={type}
                dot={getEntityColor(type)}
                isActive={entityBrowser.typeFilter.includes(type)}
                onClick={() => entityBrowser.toggleTypeFilter(type)}
              />
            ))}
          </EbDropdown>

          {/* Source Types filter */}
          {entityBrowser.allSourceTypes.length > 0 && (
            <EbDropdown
              ref={ebSrcRef}
              label="Source Types"
              isOpen={ebSrcOpen}
              onToggle={() => setEbSrcOpen(p => !p)}
              activeCount={entityBrowser.srcFilter.length}
            >
              {entityBrowser.allSourceTypes.map(type => {
                const cfg = getSourceConfig(type)
                return (
                  <EbFilterOption
                    key={type}
                    label={type}
                    icon={cfg.icon}
                    isActive={entityBrowser.srcFilter.includes(type)}
                    onClick={() => entityBrowser.toggleSrcFilter(type)}
                  />
                )
              })}
            </EbDropdown>
          )}

          {/* Tags filter */}
          {entityBrowser.allTags.length > 0 && (
            <EbDropdown
              ref={ebTagRef}
              label="Tags"
              isOpen={ebTagOpen}
              onToggle={() => setEbTagOpen(p => !p)}
              activeCount={entityBrowser.tagFilter.length}
            >
              {entityBrowser.allTags.map(tag => (
                <EbFilterOption
                  key={tag}
                  label={`#${tag}`}
                  isActive={entityBrowser.tagFilter.includes(tag)}
                  onClick={() => entityBrowser.toggleTagFilter(tag)}
                />
              ))}
            </EbDropdown>
          )}

          {/* Clear filters */}
          {entityBrowser.activeFilterCount > 0 && (
            <button type="button" onClick={entityBrowser.clearAllFilters}
              className="font-body font-semibold"
              style={{
                padding: '5px 13px', fontSize: 12, borderRadius: 20, cursor: 'pointer',
                border: '1px solid rgba(214,58,0,0.15)', background: 'var(--color-accent-50)',
                color: 'var(--color-accent-500)', whiteSpace: 'nowrap',
              }}
            >
              Clear ({entityBrowser.activeFilterCount})
            </button>
          )}

          {/* Spacer */}
          <div className="flex-1" />

          {/* Result count */}
          <span className="font-body" style={{ fontSize: 12, color: 'var(--color-text-secondary)', whiteSpace: 'nowrap', flexShrink: 0 }}>
            {entityBrowser.entities.length} result{entityBrowser.entities.length !== 1 ? 's' : ''}
          </span>

          <Divider />

          {/* Sort selector */}
          <div ref={ebSortRef} style={{ position: 'relative', flexShrink: 0 }}>
            <button type="button" onClick={() => setEbSortOpen(p => !p)}
              className="font-body font-semibold"
              style={{
                display: 'flex', alignItems: 'center', gap: 5, padding: '5px 13px', borderRadius: 20,
                border: '1px solid var(--border-subtle)', background: 'transparent',
                fontSize: 12, color: 'var(--color-text-secondary)', cursor: 'pointer', whiteSpace: 'nowrap',
              }}
            >
              {EB_SORT_OPTIONS.find(o => o.key === entityBrowser.sortBy)?.label}
              <ChevronDown size={11} />
            </button>
            {ebSortOpen && (
              <div style={{
                position: 'absolute', top: '100%', right: 0, marginTop: 4,
                background: 'var(--color-bg-card)', border: '1px solid var(--border-strong)',
                borderRadius: 10, boxShadow: '0 8px 24px rgba(0,0,0,0.1)', padding: 6, zIndex: 40, minWidth: 170,
              }}>
                {EB_SORT_OPTIONS.map(opt => (
                  <button key={opt.key} type="button"
                    onClick={() => { entityBrowser.setSortBy(opt.key); setEbSortOpen(false) }}
                    style={{
                      display: 'block', width: '100%', textAlign: 'left', padding: '7px 10px', fontSize: 11, borderRadius: 6,
                      fontWeight: entityBrowser.sortBy === opt.key ? 600 : 400,
                      color: entityBrowser.sortBy === opt.key ? 'var(--color-text-primary)' : 'var(--color-text-body)',
                      background: entityBrowser.sortBy === opt.key ? 'var(--color-bg-active)' : 'none',
                      border: 'none', cursor: 'pointer', fontFamily: 'var(--font-body)',
                    }}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Grid / List toggle */}
          <div style={{ display: 'flex', borderRadius: 20, overflow: 'hidden', border: '1px solid var(--border-subtle)', flexShrink: 0 }}>
            {([
              { mode: 'grid' as const, icon: <LayoutGrid size={12} />, title: 'Grid view' },
              { mode: 'list' as const, icon: <List size={12} />, title: 'List view' },
            ]).map(({ mode, icon, title }) => (
              <button key={mode} type="button" title={title} onClick={() => entityBrowser.setViewMode(mode)}
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  width: 26, height: 26, border: 'none', cursor: 'pointer',
                  background: entityBrowser.viewMode === mode ? 'var(--color-accent-500)' : 'transparent',
                  color: entityBrowser.viewMode === mode ? '#ffffff' : 'var(--color-text-secondary)',
                  transition: 'background 0.15s ease, color 0.15s ease',
                }}
              >
                {icon}
              </button>
            ))}
          </div>
        </>
      )}

      {/* Spacer (non-entity-browser modes) */}
      {viewMode !== 'entity-browser' && <div className="flex-1" />}

      {/* 4. Right section: Recency pills (not shown in entity-browser mode) */}
      {viewMode !== 'entity-browser' && RECENCY_OPTIONS.map(opt => {
        const isActive = filters.recency === opt.key
        return (
          <button
            key={opt.key}
            type="button"
            onClick={() => onRecencyChange(opt.key)}
            className="font-body font-semibold"
            style={{
              padding: '5px 13px',
              borderRadius: 20,
              fontSize: 12,
              border: isActive ? '1px solid rgba(214,58,0,0.15)' : '1px solid var(--border-subtle)',
              background: isActive ? 'var(--color-accent-50)' : 'transparent',
              color: isActive ? 'var(--color-accent-500)' : 'var(--color-text-secondary)',
              cursor: 'pointer',
              transition: 'all 0.15s',
              flexShrink: 0,
            }}
          >
            {opt.label}
          </button>
        )
      })}
    </div>
  )
}

// ─── Entity browser sort options ─────────────────────────────────────────────

const EB_SORT_OPTIONS: { key: EntitySortOption; label: string }[] = [
  { key: 'connections', label: 'Most Connected' },
  { key: 'recent', label: 'Most Recent' },
  { key: 'confidence', label: 'Highest Confidence' },
  { key: 'alpha', label: 'Alphabetical' },
]

// ─── Entity browser dropdown helpers ─────────────────────────────────────────

import { forwardRef } from 'react'

const EbDropdown = forwardRef<
  HTMLDivElement,
  { label: string; isOpen: boolean; onToggle: () => void; activeCount: number; children: React.ReactNode }
>(({ label, isOpen, onToggle, activeCount, children }, ref) => (
  <div ref={ref} style={{ position: 'relative', flexShrink: 0 }}>
    <button type="button" onClick={onToggle}
      className="font-body font-semibold"
      style={{
        display: 'flex', alignItems: 'center', gap: 5, padding: '5px 13px', borderRadius: 20, cursor: 'pointer',
        border: activeCount > 0 ? '1px solid rgba(214,58,0,0.15)' : '1px solid var(--border-subtle)',
        background: activeCount > 0 ? 'var(--color-accent-50)' : 'transparent',
        color: activeCount > 0 ? 'var(--color-accent-500)' : 'var(--color-text-secondary)',
        fontSize: 12, whiteSpace: 'nowrap',
        transition: 'all 0.15s ease',
      }}
    >
      {activeCount > 0 ? `${label} (${activeCount})` : label}
      <ChevronDown size={11} style={{ opacity: 0.6 }} />
    </button>
    {isOpen && (
      <div style={{
        position: 'absolute', top: '100%', left: 0, marginTop: 4,
        background: 'var(--color-bg-card)', border: '1px solid var(--border-strong)',
        borderRadius: 10, boxShadow: '0 8px 24px rgba(0,0,0,0.1)',
        padding: 6, zIndex: 40, minWidth: 160, maxHeight: 280, overflowY: 'auto',
      }}>
        {children}
      </div>
    )}
  </div>
))
EbDropdown.displayName = 'EbDropdown'

function EbFilterOption({ label, dot, icon, isActive, onClick }: {
  label: string; dot?: string; icon?: string; isActive: boolean; onClick: () => void
}) {
  return (
    <button type="button" onClick={onClick}
      style={{
        display: 'flex', alignItems: 'center', gap: 7, width: '100%', textAlign: 'left',
        padding: '6px 10px', fontSize: 11, borderRadius: 6,
        fontWeight: isActive ? 600 : 400,
        color: isActive ? 'var(--color-text-primary)' : 'var(--color-text-body)',
        background: isActive ? 'var(--color-bg-active)' : 'none',
        border: 'none', cursor: 'pointer', fontFamily: 'var(--font-body)',
        transition: 'background 0.1s ease',
      }}
    >
      {dot && <span style={{ width: 6, height: 6, borderRadius: '50%', background: dot, flexShrink: 0 }} />}
      {icon && <span style={{ fontSize: 12 }}>{icon}</span>}
      {label}
    </button>
  )
}

function Divider() {
  return (
    <div
      style={{
        width: 1,
        height: 24,
        background: 'var(--border-subtle)',
        flexShrink: 0,
      }}
    />
  )
}
