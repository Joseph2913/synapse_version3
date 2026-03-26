import { useCallback, useState, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { ChevronRight, Loader2 } from 'lucide-react'
import { useGraphData } from '../../hooks/useGraphData'
import { GraphCanvas } from './GraphCanvas'
import type { SimulationNode, GraphLevel, BreadcrumbSegment, DetailPanelContent } from '../../types/graph'

// ─── Overlay base style ──────────────────────────────────────────────────────

const overlayStyle: React.CSSProperties = {
  position: 'absolute',
  background: 'rgba(255,255,255,0.92)',
  backdropFilter: 'blur(12px)',
  border: '1px solid var(--border-subtle)',
  borderRadius: 10,
  padding: '10px 14px',
  zIndex: 10,
  pointerEvents: 'none',
  boxShadow: '0 2px 8px rgba(0,0,0,0.04)',
}

// ─── Stats Overlay (top-right) ───────────────────────────────────────────────

function StatsOverlay({ stats }: { stats: Record<string, number> }) {
  const entries = Object.entries(stats)
  return (
    <div style={{ ...overlayStyle, top: 16, right: 16 }}>
      {entries.map(([label, count], i) => (
        <div
          key={label}
          className="flex items-center gap-2"
          style={{ marginBottom: i < entries.length - 1 ? 6 : 0 }}
        >
          <span
            className="font-display"
            style={{ fontSize: 20, fontWeight: 800, color: 'var(--color-text-primary)' }}
          >
            {count.toLocaleString()}
          </span>
          <span
            className="font-body"
            style={{ fontSize: 9, fontWeight: 600, textTransform: 'uppercase', color: 'var(--color-text-secondary)', letterSpacing: '0.05em' }}
          >
            {label}
          </span>
        </div>
      ))}
    </div>
  )
}

// ─── Legend Overlay (bottom-left) ─────────────────────────────────────────────

function LegendOverlay({ level }: { level: GraphLevel }) {
  return (
    <div style={{ ...overlayStyle, bottom: 16, left: 16 }}>
      {level === 'anchors' && (
        <>
          <LegendRow icon={<circle cx="5" cy="5" r="4" fill="rgba(100,100,100,0.2)" />} label="Anchor" />
          <LegendRow icon={<line x1="0" y1="5" x2="14" y2="5" stroke="rgba(0,0,0,0.15)" strokeWidth="2" />} label="Shared connections" />
          <div className="font-body" style={{ fontSize: 9, color: 'var(--color-text-secondary)', marginTop: 4 }}>
            Size = entity count
          </div>
        </>
      )}
      {(level === 'sources' || level === 'all_sources') && (
        <>
          <LegendRow icon={<circle cx="5" cy="5" r="4" fill="rgba(100,100,100,0.2)" />} label="Source" />
          <LegendRow icon={<line x1="0" y1="5" x2="14" y2="5" stroke="rgba(0,0,0,0.15)" strokeWidth="2" />} label="Shared entities" />
        </>
      )}
      {level === 'entities' && (
        <>
          <LegendRow icon={<circle cx="5" cy="5" r="4" fill="rgba(100,100,100,0.15)" />} label="Entity" />
          <LegendRow icon={<circle cx="5" cy="5" r="4" fill="rgba(100,100,100,0.15)" stroke="rgba(214,58,0,0.2)" />} label="Cross-source bridge" />
          <LegendRow icon={<line x1="0" y1="5" x2="14" y2="5" stroke="rgba(214,58,0,0.2)" strokeWidth="1" strokeDasharray="3 3" />} label="Cross-source edge" />
        </>
      )}
    </div>
  )
}

function RootViewToggle({ current, onSwitch }: { current: 'anchors' | 'all_sources'; onSwitch: (level: 'anchors' | 'all_sources') => void }) {
  const options: { label: string; value: 'anchors' | 'all_sources' }[] = [
    { label: 'Anchors', value: 'anchors' },
    { label: 'Sources', value: 'all_sources' },
  ]
  return (
    <div
      style={{
        ...overlayStyle,
        top: 16,
        left: 16,
        pointerEvents: 'all',
        display: 'flex',
        gap: 2,
        padding: '4px 5px',
        borderRadius: 20,
      }}
    >
      {options.map(opt => (
        <button
          key={opt.value}
          type="button"
          onClick={() => onSwitch(opt.value)}
          className="font-body font-semibold cursor-pointer"
          style={{
            fontSize: 11,
            padding: '4px 12px',
            borderRadius: 16,
            border: 'none',
            background: current === opt.value ? 'var(--color-accent-50)' : 'transparent',
            color: current === opt.value ? 'var(--color-accent-500)' : 'var(--color-text-secondary)',
            transition: 'all 0.15s ease',
          }}
        >
          {opt.label}
        </button>
      ))}
    </div>
  )
}

function LegendRow({ icon, label }: { icon: React.ReactElement; label: string }) {
  return (
    <div className="flex items-center gap-2" style={{ marginBottom: 5 }}>
      <svg width="14" height="10" viewBox="0 0 14 10">{icon}</svg>
      <span className="font-body" style={{ fontSize: 10, color: 'var(--color-text-body)' }}>{label}</span>
    </div>
  )
}

// ─── Help Hint (bottom-right, above zoom) ────────────────────────────────────

function HelpHint({ level }: { level: GraphLevel }) {
  const hints: Record<GraphLevel, string> = {
    anchors: 'Click anchor to explore \u00B7 Hover for details',
    all_sources: 'Click source for details \u00B7 Drag to rearrange',
    sources: 'Click source to explore \u00B7 Right-click to go back',
    entities: 'Click entity for details \u00B7 Right-click to go back',
  }
  return (
    <div style={{ ...overlayStyle, bottom: 56, right: 16, padding: '6px 12px' }}>
      <span className="font-body" style={{ fontSize: 10, color: 'var(--color-text-secondary)' }}>
        {hints[level]}
      </span>
    </div>
  )
}

// ─── Breadcrumb ──────────────────────────────────────────────────────────────

function Breadcrumb({ segments, onNavigate }: {
  segments: BreadcrumbSegment[]
  onNavigate: (level: GraphLevel, id?: string) => void
}) {
  if (segments.length <= 1) return null

  return (
    <div
      style={{
        ...overlayStyle,
        top: 16,
        left: 16,
        pointerEvents: 'all',
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        padding: '8px 14px',
      }}
    >
      {segments.map((seg, i) => {
        const isLast = i === segments.length - 1
        return (
          <span key={`${seg.level}-${i}`} className="flex items-center gap-1">
            {i > 0 && <ChevronRight size={10} style={{ color: 'var(--color-text-secondary)' }} />}
            {isLast ? (
              <span
                className="font-body"
                style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-primary)' }}
              >
                {seg.label}
              </span>
            ) : (
              <button
                type="button"
                onClick={() => onNavigate(seg.level, seg.id)}
                className="font-body cursor-pointer"
                style={{
                  fontSize: 11,
                  fontWeight: 500,
                  color: 'var(--color-accent-500)',
                  background: 'none',
                  border: 'none',
                  padding: 0,
                }}
              >
                {seg.label}
              </button>
            )}
          </span>
        )
      })}
    </div>
  )
}

// ─── Detail Panel (slides from right) ────────────────────────────────────────

function DetailPanel({ content, onExplore, onClose }: {
  content: DetailPanelContent
  onExplore?: () => void
  onClose: () => void
}) {
  if (!content) return null

  return (
    <div
      style={{
        position: 'absolute',
        top: 0,
        right: 0,
        bottom: 0,
        width: 360,
        background: 'var(--color-bg-card)',
        borderLeft: '1px solid var(--border-subtle)',
        zIndex: 30,
        overflowY: 'auto',
        overflowX: 'hidden',
        transform: 'translateX(0)',
        transition: 'transform 0.25s ease',
        padding: 24,
      }}
    >
      <button
        type="button"
        onClick={onClose}
        className="font-body cursor-pointer"
        style={{
          position: 'absolute',
          top: 12,
          right: 12,
          fontSize: 14,
          background: 'none',
          border: 'none',
          color: 'var(--color-text-secondary)',
        }}
      >
        &#x2715;
      </button>

      {content.type === 'anchor' && (() => {
        const strongest = content.connectedAnchors.length > 0
          ? [...content.connectedAnchors].sort((a, b) => b.strength - a.strength)[0]
          : null
        const lastAct = content.data.lastActivity
          ? new Date(content.data.lastActivity).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
          : null
        return (
          <>
            {/* Header */}
            <div style={{ marginBottom: 16 }}>
              <div
                style={{
                  width: 36, height: 36, borderRadius: '50%',
                  background: `${content.data.color}20`,
                  border: `2px solid ${content.data.color}50`,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  marginBottom: 10,
                }}
              >
                <span style={{ fontSize: 16, lineHeight: 1 }}>{content.data.entityCount}</span>
              </div>
              <div className="font-display" style={{ fontSize: 17, fontWeight: 700, color: 'var(--color-text-primary)', marginBottom: 4 }}>
                {content.data.label}
              </div>
              <div className="font-body" style={{ fontSize: 12, color: 'var(--color-text-secondary)', lineHeight: 1.5 }}>
                {content.data.entityType}
                {content.data.confidence != null && ` \u00B7 ${Math.round(content.data.confidence * 100)}% confidence`}
              </div>
            </div>

            {/* Description */}
            {content.data.description && (
              <div
                className="font-body"
                style={{
                  fontSize: 13, color: 'var(--color-text-body)', lineHeight: 1.6,
                  marginBottom: 20, padding: '12px 14px',
                  background: 'var(--color-bg-inset)', borderRadius: 8,
                }}
              >
                {content.data.description}
              </div>
            )}

            {/* Stats grid */}
            <div
              style={{
                display: 'grid', gridTemplateColumns: '1fr 1fr 1fr',
                gap: 8, marginBottom: 20,
              }}
            >
              <StatCard label="Entities" value={content.data.entityCount} />
              <StatCard label="Sources" value={content.data.sourceCount} />
              <StatCard label="Links" value={content.data.connectionCount} />
            </div>

            {/* Strongest connection */}
            {strongest && (
              <div style={{ marginBottom: 16 }}>
                <SectionLabel>Strongest Connection</SectionLabel>
                <div
                  className="flex items-center gap-3"
                  style={{
                    padding: '10px 12px', borderRadius: 8,
                    background: 'var(--color-bg-inset)',
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="font-body" style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {strongest.label}
                    </div>
                    <div className="font-body" style={{ fontSize: 11, color: 'var(--color-text-secondary)', marginTop: 2 }}>
                      {Math.round(strongest.strength * 100)}% strength
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Activity */}
            {lastAct && (
              <div style={{ marginBottom: 20 }}>
                <SectionLabel>Last Activity</SectionLabel>
                <div className="font-body" style={{ fontSize: 13, color: 'var(--color-text-body)' }}>
                  {lastAct}
                </div>
              </div>
            )}

            {/* Explore button */}
            {onExplore && (
              <button
                type="button"
                onClick={onExplore}
                className="font-body font-semibold cursor-pointer"
                style={{
                  fontSize: 13,
                  padding: '10px 16px',
                  borderRadius: 10,
                  background: 'var(--color-accent-50)',
                  border: '1px solid rgba(214,58,0,0.15)',
                  color: 'var(--color-accent-500)',
                  width: '100%',
                }}
              >
                Explore Sources &#x2192;
              </button>
            )}
          </>
        )
      })()}

      {content.type === 'source' && (
        <>
          <div className="flex items-center gap-2" style={{ marginBottom: 12 }}>
            <span style={{ fontSize: 14 }}>{content.data.icon}</span>
            <span className="font-display" style={{ fontSize: 15, fontWeight: 700 }}>{content.data.label}</span>
          </div>
          <div className="font-body" style={{ fontSize: 11, color: 'var(--color-text-secondary)', marginBottom: 16 }}>
            {content.data.sourceType} {'\u00B7'} {content.data.entityCount} entities
          </div>
          {content.entityBreakdown.length > 0 && (
            <div style={{ marginBottom: 16 }}>
              <div className="font-body" style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', color: 'var(--color-text-secondary)', marginBottom: 6 }}>
                Entity Composition
              </div>
              {content.entityBreakdown.map(seg => (
                <div key={seg.entityType} className="flex items-center gap-2 font-body" style={{ fontSize: 11, marginBottom: 3 }}>
                  <span style={{
                    width: 8, height: 8, borderRadius: '50%',
                    background: seg.entityType, // will use inline color
                    display: 'inline-block',
                  }} />
                  <span style={{ color: 'var(--color-text-body)' }}>{seg.entityType}</span>
                  <span style={{ color: 'var(--color-text-secondary)', marginLeft: 'auto' }}>{seg.count}</span>
                </div>
              ))}
            </div>
          )}
          {onExplore && (
            <button
              type="button"
              onClick={onExplore}
              className="font-body font-semibold cursor-pointer"
              style={{
                fontSize: 12,
                padding: '8px 16px',
                borderRadius: 20,
                background: 'var(--color-accent-50)',
                border: '1px solid rgba(214,58,0,0.15)',
                color: 'var(--color-accent-500)',
                width: '100%',
              }}
            >
              Explore Entities {'\u2192'}
            </button>
          )}
        </>
      )}

      {content.type === 'entity' && (
        <>
          <div className="flex items-center gap-2" style={{ marginBottom: 12 }}>
            <span
              style={{
                width: 10, height: 10, borderRadius: '50%',
                background: content.data.color,
                display: 'inline-block',
              }}
            />
            <span className="font-display" style={{ fontSize: 15, fontWeight: 700 }}>{content.data.label}</span>
          </div>
          <div className="font-body" style={{ fontSize: 11, color: 'var(--color-text-secondary)', marginBottom: 8 }}>
            {content.data.entityType}
            {content.data.confidence != null && ` \u00B7 ${Math.round(content.data.confidence * 100)}% confidence`}
          </div>
          {content.data.isBridge && (
            <div
              className="font-body"
              style={{
                fontSize: 11,
                color: 'var(--color-accent-500)',
                background: 'var(--color-accent-50)',
                padding: '4px 10px',
                borderRadius: 12,
                display: 'inline-block',
                marginBottom: 12,
              }}
            >
              {'\u2197'} Cross-source bridge ({content.data.sourceCount} sources)
            </div>
          )}
          {content.data.description && (
            <div className="font-body" style={{ fontSize: 12, color: 'var(--color-text-body)', marginBottom: 16, lineHeight: 1.5 }}>
              {content.data.description}
            </div>
          )}
          {content.relationships.length > 0 && (
            <div style={{ marginBottom: 16 }}>
              <div className="font-body" style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', color: 'var(--color-text-secondary)', marginBottom: 6 }}>
                Relationships
              </div>
              {content.relationships.slice(0, 10).map((rel, i) => (
                <div key={i} className="font-body" style={{ fontSize: 11, color: 'var(--color-text-body)', marginBottom: 3 }}>
                  <span style={{ color: 'var(--color-text-secondary)' }}>{rel.direction === 'out' ? '\u2192' : '\u2190'}</span>
                  {' '}{rel.type?.replace(/_/g, ' ')} {'\u2192'} {rel.label}
                </div>
              ))}
            </div>
          )}
          {content.sources.length > 0 && (
            <div>
              <div className="font-body" style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', color: 'var(--color-text-secondary)', marginBottom: 6 }}>
                Found In
              </div>
              {content.sources.map(s => (
                <div key={s.id} className="font-body" style={{ fontSize: 11, color: 'var(--color-text-body)', marginBottom: 3 }}>
                  {s.title}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div style={{ padding: '10px 8px', background: 'var(--color-bg-inset)', borderRadius: 8, textAlign: 'center' }}>
      <div className="font-display" style={{ fontSize: 20, fontWeight: 800, color: 'var(--color-text-primary)' }}>
        {value.toLocaleString()}
      </div>
      <div className="font-body" style={{ fontSize: 10, fontWeight: 600, color: 'var(--color-text-secondary)', marginTop: 2 }}>
        {label}
      </div>
    </div>
  )
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="font-body" style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', color: 'var(--color-text-secondary)', letterSpacing: '0.04em', marginBottom: 8 }}>
      {children}
    </div>
  )
}

// ─── Empty State ─────────────────────────────────────────────────────────────

function EmptyState() {
  const navigate = useNavigate()
  return (
    <div
      className="absolute inset-0 flex flex-col items-center justify-center text-center"
      style={{ pointerEvents: 'none' }}
    >
      <p className="font-body" style={{ fontSize: 14, fontWeight: 500, color: 'var(--color-text-secondary)', marginBottom: 6 }}>
        Your knowledge graph will appear here
      </p>
      <p className="font-body" style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginBottom: 16 }}>
        Ingest sources and create anchors to see your knowledge graph
      </p>
      <button
        type="button"
        onClick={() => navigate('/capture')}
        className="font-body font-semibold rounded-md cursor-pointer"
        style={{
          fontSize: 12,
          padding: '6px 14px',
          background: 'var(--color-bg-inset)',
          border: '1px solid var(--border-default)',
          color: 'var(--color-text-body)',
          pointerEvents: 'all',
        }}
      >
        Go to Capture {'\u2192'}
      </button>
    </div>
  )
}

// ─── Main GraphTab Component ─────────────────────────────────────────────────

export function GraphTab() {
  const {
    levelData,
    loading,
    error,
    nav,
    drillToSources,
    drillToEntities,
    navigateBack,
    navigateToLevel,
    switchRootView,
    refetch,
  } = useGraphData()

  const [detailPanel, setDetailPanel] = useState<DetailPanelContent>(null)
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)

  // Build breadcrumb segments
  const breadcrumbs = useMemo<BreadcrumbSegment[]>(() => {
    if (nav.level === 'all_sources') return []
    const segs: BreadcrumbSegment[] = [{ label: 'All Anchors', level: 'anchors' }]
    if (nav.level === 'sources' || nav.level === 'entities') {
      segs.push({ label: nav.anchorLabel ?? 'Anchor', level: 'sources', id: nav.anchorId })
    }
    if (nav.level === 'entities') {
      segs.push({ label: nav.sourceTitle ?? 'Source', level: 'entities', id: nav.sourceId })
    }
    return segs
  }, [nav])

  // Build stats from current level data with human-readable labels
  const stats = useMemo(() => {
    if (!levelData) return null
    const raw = levelData.data.stats as Record<string, number>
    const labelMap: Record<string, string> = {
      anchorCount: 'Anchors',
      sourceCount: 'Sources',
      entityCount: 'Entities',
      edgeCount: 'Edges',
      bridgeCount: 'Bridges',
      connectionCount: 'Connections',
    }
    const result: Record<string, number> = {}
    for (const [key, value] of Object.entries(raw)) {
      result[labelMap[key] ?? key] = value
    }
    return result
  }, [levelData])

  // Get parent anchor color for source-level rendering
  const parentAnchorColor = useMemo(() => {
    if (levelData?.level === 'sources') return levelData.data.parentAnchor.color
    return undefined
  }, [levelData])

  const handleClickNode = useCallback((nodeId: string, kind: SimulationNode['kind']) => {
    if (kind === 'anchor') {
      // Show detail panel on click
      if (levelData?.level === 'anchors') {
        const anchor = levelData.data.anchors.find(a => a.id === nodeId)
        if (anchor) {
          setSelectedNodeId(nodeId)
          const connectedAnchors = levelData.data.edges
            .filter(e => e.fromAnchorId === nodeId || e.toAnchorId === nodeId)
            .map(e => {
              const otherId = e.fromAnchorId === nodeId ? e.toAnchorId : e.fromAnchorId
              const other = levelData.data.anchors.find(a => a.id === otherId)
              return { id: otherId, label: other?.label ?? 'Unknown', strength: e.strength }
            })
          setDetailPanel({ type: 'anchor', data: anchor, connectedAnchors })
          return
        }
      }
    }

    if (kind === 'source') {
      if (levelData?.level === 'sources' || levelData?.level === 'all_sources') {
        const source = levelData.data.sources.find(s => s.id === nodeId)
        if (source) {
          setSelectedNodeId(nodeId)
          setDetailPanel({ type: 'source', data: source, entityBreakdown: source.typeDistribution })
          return
        }
      }
    }

    if (kind === 'ghost_anchor') {
      if (levelData?.level === 'sources') {
        const ghost = levelData.data.ghostAnchors.find(g => g.id === nodeId)
        if (ghost) {
          drillToSources(nodeId, ghost.label)
          setDetailPanel(null)
          setSelectedNodeId(null)
          return
        }
      }
    }

    if (kind === 'entity') {
      setSelectedNodeId(nodeId)
      if (levelData?.level === 'entities') {
        const entity = levelData.data.entities.find(e => e.id === nodeId)
        if (entity) {
          const relationships = levelData.data.intraEdges
            .filter(e => e.fromEntityId === nodeId || e.toEntityId === nodeId)
            .map(e => {
              const otherId = e.fromEntityId === nodeId ? e.toEntityId : e.fromEntityId
              const other = levelData.data.entities.find(en => en.id === otherId)
              return {
                label: other?.label ?? 'Unknown',
                type: e.relationType ?? 'relates_to',
                direction: (e.fromEntityId === nodeId ? 'out' : 'in') as 'in' | 'out',
              }
            })
          const sources = levelData.data.ghostSources.map(s => ({ id: s.id, title: s.label }))
          setDetailPanel({ type: 'entity', data: entity, relationships, sources })
        }
      }
    }
  }, [levelData, drillToSources])

  // Hover only changes cursor (handled by interaction hook) — no detail panel on hover
  const handleHoverNode = useCallback((_nodeId: string | null) => {
    // Detail panel is shown on click only
  }, [])

  const handleRightClick = useCallback(() => {
    navigateBack()
    setDetailPanel(null)
    setSelectedNodeId(null)
  }, [navigateBack])

  const handleClickEmpty = useCallback(() => {
    setDetailPanel(null)
    setSelectedNodeId(null)
  }, [])

  const handleBreadcrumbNav = useCallback((level: GraphLevel, id?: string) => {
    navigateToLevel(level, id)
    setDetailPanel(null)
    setSelectedNodeId(null)
  }, [navigateToLevel])

  const handleDetailExplore = useCallback(() => {
    if (detailPanel?.type === 'anchor') {
      drillToSources(detailPanel.data.id, detailPanel.data.label)
      setDetailPanel(null)
      setSelectedNodeId(null)
    } else if (detailPanel?.type === 'source') {
      drillToEntities(detailPanel.data.id, detailPanel.data.label)
      setDetailPanel(null)
      setSelectedNodeId(null)
    }
  }, [detailPanel, drillToSources, drillToEntities])

  const isEmpty = (levelData?.level === 'anchors' && levelData.data.anchors.length === 0) ||
    (levelData?.level === 'all_sources' && levelData.data.sources.length === 0)

  return (
    <div className="h-full relative overflow-hidden" style={{ background: '#f7f7f7' }}>
      {/* Loading */}
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center" style={{ zIndex: 40 }}>
          <span className="font-body flex items-center gap-2" style={{ fontSize: 13, color: 'var(--color-text-secondary)' }}>
            <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} />
            Loading graph\u2026
          </span>
        </div>
      )}

      {/* Error */}
      {error && !loading && (
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <p className="font-body" style={{ fontSize: 14, color: 'var(--color-text-body)', marginBottom: 10 }}>
            Failed to load graph data
          </p>
          <button
            type="button"
            onClick={refetch}
            className="font-body font-semibold rounded-md cursor-pointer"
            style={{
              fontSize: 12,
              padding: '6px 14px',
              background: 'var(--color-bg-inset)',
              border: '1px solid var(--border-default)',
              color: 'var(--color-text-body)',
            }}
          >
            Retry
          </button>
        </div>
      )}

      {/* Graph canvas */}
      {!loading && !error && levelData && !isEmpty && (
        <GraphCanvas
          levelData={levelData}
          level={nav.level}
          selectedNodeId={selectedNodeId}
          parentAnchorColor={parentAnchorColor}
          onClickNode={handleClickNode}
          onRightClick={handleRightClick}
          onClickEmpty={handleClickEmpty}
          onHoverNode={handleHoverNode}
        />
      )}

      {/* Empty state */}
      {!loading && !error && isEmpty && <EmptyState />}

      {/* Overlays */}
      {!loading && !error && levelData && !isEmpty && (
        <>
          {(nav.level === 'anchors' || nav.level === 'all_sources') ? (
            <RootViewToggle current={nav.level} onSwitch={(lvl) => { switchRootView(lvl); setDetailPanel(null); setSelectedNodeId(null) }} />
          ) : (
            <Breadcrumb segments={breadcrumbs} onNavigate={handleBreadcrumbNav} />
          )}
          {stats && <StatsOverlay stats={stats} />}
          <LegendOverlay level={nav.level} />
          <HelpHint level={nav.level} />
        </>
      )}

      {/* Detail panel */}
      <DetailPanel
        content={detailPanel}
        onExplore={
          detailPanel?.type === 'anchor' ? handleDetailExplore
            : (detailPanel?.type === 'source' && nav.level === 'sources') ? handleDetailExplore
            : undefined
        }
        onClose={handleClickEmpty}
      />
    </div>
  )
}
