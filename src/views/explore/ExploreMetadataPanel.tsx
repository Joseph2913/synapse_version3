import { useState, useRef, useEffect, useMemo, useCallback } from 'react'
import { ArrowLeft, ChevronRight, ChevronDown, Link2, MessageSquare, ArrowRight, Anchor as AnchorIcon, X } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { EntityBadge } from '../../components/shared/EntityBadge'
import { getEntityColor } from '../../config/entityTypes'
import { getSourceConfig } from '../../config/sourceTypes'
import { fetchNodesByIds } from '../../services/supabase'
import { buildSourceConnectionContext } from '../../config/chatEntryContexts'
import type {
  ExploreViewMode,
  ZoomLevel,
  ClusterData,
  EntityNode,
  SourceNode,
  SourceEdge,
  SourceConnectionType,
  ExploreFilters,
} from '../../types/explore'
import type { KnowledgeNode } from '../../types/database'
import type { EntityEdge } from '../../services/exploreQueries'
import type { AnchorCandidateWithNode } from '../../types/anchors'

// Connection-type color map
const CONN_COLORS: Record<SourceConnectionType, string> = {
  entity: '#6366f1',
  anchor: '#b45309',
}

const CONN_LABELS: Record<SourceConnectionType, string> = {
  entity: 'entity edges',
  anchor: 'common anchors',
}

interface ExploreMetadataPanelProps {
  viewMode: ExploreViewMode
  zoomLevel: ZoomLevel
  activeCluster: ClusterData | null
  // Neighborhood data
  neighborhoodEntities: EntityNode[]
  neighborhoodEdges: EntityEdge[]
  // Source data
  allSources: SourceNode[]
  sourceEdges: SourceEdge[]
  // Selection
  selectedEntityId: string | null
  selectedSourceId: string | null
  onSelectEntity: (entity: EntityNode | null) => void
  onSelectSource: (source: SourceNode | null) => void
  onBack: () => void
  filters?: ExploreFilters
  onClearSpotlight?: () => void
  selectedSuggestedCandidate?: AnchorCandidateWithNode | null
  onConfirmSuggested?: (candidateId: string, nodeId: string) => Promise<void>
  onDismissSuggested?: (candidateId: string, dismissCount: number) => Promise<void>
  onClearSuggested?: () => void
}

export function ExploreMetadataPanel({
  viewMode,
  zoomLevel,
  activeCluster,
  neighborhoodEntities,
  neighborhoodEdges,
  allSources,
  sourceEdges,
  selectedEntityId,
  selectedSourceId,
  onSelectEntity,
  onSelectSource,
  onBack,
  filters,
  onClearSpotlight,
  selectedSuggestedCandidate,
  onConfirmSuggested,
  onDismissSuggested,
  onClearSuggested,
}: ExploreMetadataPanelProps) {
  // Suggested anchor selected — highest priority
  if (selectedSuggestedCandidate && viewMode === 'anchors') {
    return (
      <SuggestedAnchorPanel
        candidate={selectedSuggestedCandidate}
        onConfirm={onConfirmSuggested ?? (async () => {})}
        onDismiss={onDismissSuggested ?? (async () => {})}
        onClose={onClearSuggested ?? (() => {})}
      />
    )
  }

  // Landscape: entities + landscape — show CTA
  if (viewMode === 'anchors' && zoomLevel === 'landscape') {
    return <ExploreSelectAnchorCTA />
  }

  // Neighborhood: entities + neighborhood
  if (viewMode === 'anchors' && zoomLevel === 'neighborhood' && activeCluster) {
    return (
      <EntityTablePanel
        cluster={activeCluster}
        entities={neighborhoodEntities}
        edges={neighborhoodEdges}
        selectedEntityId={selectedEntityId}
        onSelectEntity={onSelectEntity}
        onBack={onBack}
        filters={filters}
        onClearSpotlight={onClearSpotlight}
      />
    )
  }

  // Sources
  if (viewMode === 'sources') {
    return (
      <SourceListPanel
        sources={allSources}
        sourceEdges={sourceEdges}
        selectedSourceId={selectedSourceId}
        onSelectSource={onSelectSource}
        filters={filters}
      />
    )
  }

  return null
}

// ─── Explore CTA (Landscape Level) ───────────────────────────────────────────

function ExploreSelectAnchorCTA() {
  return (
    <div
      className="flex flex-col items-center justify-center h-full"
      style={{ padding: '40px 32px', textAlign: 'center', background: 'var(--color-bg-card)' }}
    >
      {/* Three overlapping circles — cluster icon */}
      <svg
        width="48"
        height="48"
        viewBox="0 0 48 48"
        fill="none"
        style={{ marginBottom: 20, opacity: 0.2 }}
      >
        <circle cx="16" cy="28" r="11" stroke="var(--color-text-primary)" strokeWidth="1.5" />
        <circle cx="32" cy="28" r="11" stroke="var(--color-text-primary)" strokeWidth="1.5" />
        <circle cx="24" cy="16" r="11" stroke="var(--color-text-primary)" strokeWidth="1.5" />
      </svg>
      <h3
        className="font-display"
        style={{
          fontSize: 16,
          fontWeight: 700,
          color: 'var(--color-text-primary)',
          marginBottom: 10,
          marginTop: 0,
        }}
      >
        Select an anchor to explore
      </h3>
      <p
        className="font-body"
        style={{
          fontSize: 13,
          color: 'var(--color-text-secondary)',
          lineHeight: 1.6,
          maxWidth: 240,
          marginTop: 0,
          marginBottom: 0,
        }}
      >
        Anchors are key concepts that organize your knowledge into clusters. Click any bubble
        in the graph — or zoom into one — to explore its entities and connections.
      </p>
      <div style={{ marginTop: 24, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {[
          { key: 'Click bubble', desc: 'Enter cluster view' },
          { key: 'Zoom in', desc: 'Auto-enter cluster view' },
          { key: 'Scroll / drag', desc: 'Pan & zoom the graph' },
        ].map(({ key, desc }) => (
          <div
            key={key}
            className="flex items-center gap-2 font-body"
            style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}
          >
            <span
              style={{
                fontWeight: 600,
                color: 'var(--color-text-primary)',
                background: 'var(--color-bg-inset)',
                borderRadius: 4,
                padding: '1px 6px',
                fontSize: 10,
                flexShrink: 0,
              }}
            >
              {key}
            </span>
            <span>{desc}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Entity Table (Neighborhood Level) ───────────────────────────────────────

function EntityTablePanel({
  cluster,
  entities,
  edges,
  selectedEntityId,
  onSelectEntity,
  onBack,
  filters,
  onClearSpotlight,
}: {
  cluster: ClusterData
  entities: EntityNode[]
  edges: EntityEdge[]
  selectedEntityId: string | null
  onSelectEntity: (entity: EntityNode | null) => void
  onBack: () => void
  filters?: ExploreFilters
  onClearSpotlight?: () => void
}) {
  const [expandedEntityId, setExpandedEntityId] = useState<string | null>(null)
  const rowRefs = useRef<Map<string, HTMLDivElement>>(new Map())

  // Reset when switching clusters
  useEffect(() => { setExpandedEntityId(null) }, [cluster.anchor.id])

  // Auto-expand + auto-scroll when graph selection changes
  useEffect(() => {
    if (!selectedEntityId) return
    setExpandedEntityId(selectedEntityId)
    setTimeout(() => {
      const el = rowRefs.current.get(selectedEntityId)
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }, 50)
  }, [selectedEntityId])

  // Filtered entity list — respects spotlightEntityType
  const visibleEntities = useMemo(() => {
    if (!filters?.spotlightEntityType) return entities
    return entities.filter(e => e.entityType === filters.spotlightEntityType)
  }, [entities, filters?.spotlightEntityType])

  const handleNavigateToEntity = (id: string) => {
    const target = entities.find(e => e.id === id)
    if (!target) return
    setExpandedEntityId(id)
    onSelectEntity(target)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--color-bg-card)' }}>
      {/* Header */}
      <div
        className="flex items-center gap-2 shrink-0"
        style={{ padding: '12px 14px', borderBottom: '1px solid var(--border-subtle)' }}
      >
        <button
          type="button"
          onClick={onBack}
          className="flex items-center cursor-pointer"
          style={{ background: 'none', border: 'none', padding: 2, color: 'var(--color-text-secondary)' }}
        >
          <ArrowLeft size={14} />
        </button>
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: getEntityColor(cluster.anchor.entityType), flexShrink: 0 }} />
        <span
          className="font-display"
          style={{ fontSize: 13, fontWeight: 700, color: 'var(--color-text-primary)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        >
          {cluster.anchor.label}
        </span>
        <CountBadge>{visibleEntities.length}</CountBadge>
      </div>

      {/* Active filter chips row */}
      {(selectedEntityId || filters?.spotlightEntityType) && (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          padding: '5px 14px',
          borderBottom: '1px solid var(--border-subtle)',
          flexWrap: 'wrap',
          flexShrink: 0,
        }}>
          {selectedEntityId && (() => {
            const sel = entities.find(e => e.id === selectedEntityId)
            return sel ? (
              <button
                type="button"
                onClick={() => onSelectEntity(null)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 4,
                  fontFamily: 'var(--font-body)', fontSize: 10, fontWeight: 500,
                  color: 'var(--color-accent-500)',
                  background: 'var(--color-accent-50)',
                  border: '1px solid rgba(214,58,0,0.2)',
                  borderRadius: 20, padding: '2px 8px',
                  cursor: 'pointer',
                  maxWidth: 140,
                }}
              >
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {sel.label}
                </span>
                <X size={10} style={{ flexShrink: 0 }} />
              </button>
            ) : null
          })()}
          {filters?.spotlightEntityType && (
            <button
              type="button"
              onClick={() => onClearSpotlight?.()}
              style={{
                display: 'flex', alignItems: 'center', gap: 4,
                fontFamily: 'var(--font-body)', fontSize: 10, fontWeight: 500,
                color: 'var(--color-text-secondary)',
                background: 'var(--color-bg-inset)',
                border: '1px solid var(--border-subtle)',
                borderRadius: 20, padding: '2px 8px',
                cursor: 'pointer',
              }}
            >
              <span style={{ width: 5, height: 5, borderRadius: '50%', background: getEntityColor(filters.spotlightEntityType), flexShrink: 0 }} />
              {filters.spotlightEntityType}
              <X size={10} style={{ flexShrink: 0 }} />
            </button>
          )}
        </div>
      )}

      {/* Entity list — single scrollable column */}
      <div className="flex-1 overflow-y-auto" style={{ padding: '4px 0' }}>
        {visibleEntities.map(entity => {
          const isSelected = selectedEntityId === entity.id
          const isExpanded = expandedEntityId === entity.id
          return (
            <div key={entity.id}>
              {/* Entity card */}
              <div
                ref={el => {
                  if (el) rowRefs.current.set(entity.id, el)
                  else rowRefs.current.delete(entity.id)
                }}
                style={{
                  borderBottom: isExpanded ? 'none' : '1px solid var(--border-subtle)',
                  background: isExpanded
                    ? 'var(--color-accent-50)'
                    : isSelected
                      ? 'rgba(0,0,0,0.02)'
                      : 'transparent',
                  transition: 'background 0.1s ease',
                }}
              >
                <button
                  type="button"
                  onClick={() => onSelectEntity(isSelected ? null : entity)}
                  className="w-full cursor-pointer font-body"
                  style={{
                    padding: '10px 14px 4px 14px',
                    textAlign: 'left',
                    background: 'none',
                    border: 'none',
                    width: '100%',
                  }}
                >
                  {/* Label + confidence */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                    <span style={{ width: 6, height: 6, borderRadius: '50%', background: getEntityColor(entity.entityType), flexShrink: 0 }} />
                    <span style={{
                      fontFamily: 'var(--font-body)', fontSize: 12,
                      fontWeight: isExpanded ? 700 : isSelected ? 600 : 500,
                      color: isExpanded ? 'var(--color-accent-600)' : isSelected ? 'var(--color-accent-500)' : 'var(--color-text-primary)',
                      flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>
                      {entity.label}
                    </span>
                    {entity.confidence !== null && (
                      <span style={{ fontFamily: 'var(--font-display)', fontSize: 10, fontWeight: 700, color: 'var(--color-text-secondary)', flexShrink: 0 }}>
                        {Math.round(entity.confidence * 100)}%
                      </span>
                    )}
                  </div>

                  {/* Type badge */}
                  <div style={{ marginBottom: entity.description ? 4 : 0 }}>
                    <EntityBadge type={entity.entityType} size="xs" />
                  </div>

                  {/* Description */}
                  {entity.description && (
                    <p style={{
                      fontFamily: 'var(--font-body)', fontSize: 11,
                      color: 'var(--color-text-secondary)', lineHeight: '1.45em',
                      maxHeight: '2.9em', overflow: 'hidden',
                      margin: '0 0 4px 0',
                    }}>
                      {entity.description}
                    </p>
                  )}

                  {/* Source */}
                  {entity.sourceName && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 3, fontFamily: 'var(--font-body)', fontSize: 10, color: 'var(--color-text-secondary)' }}>
                      <span>{getSourceConfig(entity.sourceType ?? 'paste').icon}</span>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{entity.sourceName}</span>
                    </div>
                  )}

                  {/* Tags */}
                  {entity.tags.length > 0 && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3, marginBottom: 2 }}>
                      {entity.tags.slice(0, 4).map(tag => (
                        <span key={tag} style={{ fontFamily: 'var(--font-body)', fontSize: 9, background: 'var(--color-bg-inset)', borderRadius: 4, padding: '1px 5px', color: 'var(--color-text-secondary)' }}>
                          #{tag}
                        </span>
                      ))}
                    </div>
                  )}
                </button>

                {/* Learn more / Close toggle */}
                <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '2px 14px 8px' }}>
                  <button
                    type="button"
                    onClick={e => {
                      e.stopPropagation()
                      if (isExpanded) {
                        setExpandedEntityId(null)
                      } else {
                        setExpandedEntityId(entity.id)
                        onSelectEntity(entity)
                      }
                    }}
                    style={{
                      fontFamily: 'var(--font-body)',
                      fontSize: 10,
                      fontWeight: 600,
                      color: isExpanded ? 'var(--color-text-secondary)' : 'var(--color-accent-500)',
                      background: 'none',
                      border: 'none',
                      cursor: 'pointer',
                      padding: '2px 0',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 3,
                    }}
                  >
                    {isExpanded ? 'Close ↑' : 'Learn more'}
                    {!isExpanded && <ChevronRight size={10} />}
                  </button>
                </div>
              </div>

              {/* Inline accordion — connection detail */}
              {isExpanded && (
                <div style={{
                  borderBottom: '1px solid var(--border-subtle)',
                  background: 'var(--color-bg-inset)',
                  maxHeight: 340,
                  overflowY: 'auto',
                }}>
                  <ConnectionDetailPanel
                    entity={entity}
                    entities={visibleEntities}
                    edges={edges}
                    onClose={() => setExpandedEntityId(null)}
                    onNavigate={handleNavigateToEntity}
                  />
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ─── Connection Detail Panel ──────────────────────────────────────────────────

function ConnectionDetailPanel({
  entity,
  entities,
  edges,
  onClose,
  onNavigate,
}: {
  entity: EntityNode
  entities: EntityNode[]
  edges: EntityEdge[]
  onClose: () => void
  onNavigate: (id: string) => void
}) {
  const directEdges = edges.filter(e =>
    e.sourceNodeId === entity.id || e.targetNodeId === entity.id
  )

  const coSourcePeers = entity.sourceId
    ? entities.filter(e => e.id !== entity.id && e.sourceId === entity.sourceId)
    : []

  const coTagPeers = entity.tags.length > 0
    ? entities.filter(e =>
        e.id !== entity.id &&
        e.tags.some(t => entity.tags.includes(t))
      )
    : []

  const getEntityById = (id: string) => entities.find(e => e.id === id)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Header */}
      <div style={{
        padding: '10px 12px',
        borderBottom: '1px solid var(--border-subtle)',
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        flexShrink: 0,
      }}>
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: getEntityColor(entity.entityType), flexShrink: 0 }} />
        <span style={{
          fontFamily: 'var(--font-body)', fontSize: 12, fontWeight: 700,
          flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          color: 'var(--color-text-primary)',
        }}>
          {entity.label}
        </span>
        <button
          type="button"
          onClick={onClose}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-text-secondary)', padding: 2, flexShrink: 0 }}
        >
          <X size={14} />
        </button>
      </div>

      {/* Scrollable connection content */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '6px 0' }}>

        {/* Knowledge edges */}
        {directEdges.length === 0 ? (
          <ZeroRow label="Knowledge edges" />
        ) : (
          <>
            <SectionLabel>Knowledge edges ({directEdges.length})</SectionLabel>
            {directEdges.map(edge => {
              const otherId = edge.sourceNodeId === entity.id ? edge.targetNodeId : edge.sourceNodeId
              const other = getEntityById(otherId)
              if (!other) return null
              return (
                <button
                  key={`${edge.sourceNodeId}-${edge.targetNodeId}`}
                  type="button"
                  onClick={() => onNavigate(other.id)}
                  style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', background: 'none', border: 'none', cursor: 'pointer', width: '100%', textAlign: 'left' }}
                  onMouseEnter={e => { e.currentTarget.style.background = 'var(--color-bg-inset)' }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'none' }}
                >
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: getEntityColor(other.entityType), flexShrink: 0 }} />
                  <span style={{ fontFamily: 'var(--font-body)', fontSize: 11, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--color-text-primary)' }}>
                    {other.label}
                  </span>
                  {edge.relationType && (
                    <span style={{ fontFamily: 'var(--font-body)', fontSize: 9, color: 'var(--color-text-secondary)', flexShrink: 0 }}>{edge.relationType}</span>
                  )}
                  <ChevronRight size={10} style={{ color: 'var(--color-text-placeholder)', flexShrink: 0 }} />
                </button>
              )
            })}
          </>
        )}

        {/* Same source */}
        {coSourcePeers.length === 0 ? (
          <ZeroRow label="Same source" />
        ) : (
          <>
            <SectionLabel>Same source ({coSourcePeers.length})</SectionLabel>
            {coSourcePeers.map(peer => (
              <button
                key={peer.id}
                type="button"
                onClick={() => onNavigate(peer.id)}
                style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', background: 'none', border: 'none', cursor: 'pointer', width: '100%', textAlign: 'left' }}
                onMouseEnter={e => { e.currentTarget.style.background = 'var(--color-bg-inset)' }}
                onMouseLeave={e => { e.currentTarget.style.background = 'none' }}
              >
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: getEntityColor(peer.entityType), flexShrink: 0 }} />
                <span style={{ fontFamily: 'var(--font-body)', fontSize: 11, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--color-text-primary)' }}>
                  {peer.label}
                </span>
                <EntityBadge type={peer.entityType} size="xs" />
                <ChevronRight size={10} style={{ color: 'var(--color-text-placeholder)', flexShrink: 0 }} />
              </button>
            ))}
          </>
        )}

        {/* Shared tags */}
        {coTagPeers.length === 0 ? (
          <ZeroRow label="Shared tags" />
        ) : (
          <>
            <SectionLabel>Shared tags ({coTagPeers.length})</SectionLabel>
            {coTagPeers.map(peer => {
              const shared = peer.tags.filter(t => entity.tags.includes(t))
              return (
                <button
                  key={peer.id}
                  type="button"
                  onClick={() => onNavigate(peer.id)}
                  style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', background: 'none', border: 'none', cursor: 'pointer', width: '100%', textAlign: 'left' }}
                  onMouseEnter={e => { e.currentTarget.style.background = 'var(--color-bg-inset)' }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'none' }}
                >
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: getEntityColor(peer.entityType), flexShrink: 0 }} />
                  <span style={{ fontFamily: 'var(--font-body)', fontSize: 11, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--color-text-primary)' }}>
                    {peer.label}
                  </span>
                  <span style={{ fontFamily: 'var(--font-body)', fontSize: 9, color: 'rgba(100,40,200,0.8)', flexShrink: 0, maxWidth: 80, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    #{shared.join(', #')}
                  </span>
                  <ChevronRight size={10} style={{ color: 'var(--color-text-placeholder)', flexShrink: 0 }} />
                </button>
              )
            })}
          </>
        )}

      </div>
    </div>
  )
}

// ─── Connection Prompt Builder ────────────────────────────────────────────────


// ─── Source List (enhanced with drill-down) ──────────────────────────────────

function SourceListPanel({
  sources,
  sourceEdges,
  selectedSourceId,
  onSelectSource,
  filters,
}: {
  sources: SourceNode[]
  sourceEdges: SourceEdge[]
  selectedSourceId: string | null
  onSelectSource: (source: SourceNode | null) => void
  filters?: ExploreFilters
}) {
  const navigate = useNavigate()
  const listRef = useRef<HTMLDivElement>(null)
  const [expandedConnId, setExpandedConnId] = useState<string | null>(null)
  const [sharedEntities, setSharedEntities] = useState<KnowledgeNode[]>([])
  const [loadingShared, setLoadingShared] = useState(false)

  // Reset expanded connection when selected source changes
  useEffect(() => {
    setExpandedConnId(null)
    setSharedEntities([])
  }, [selectedSourceId])

  useEffect(() => {
    if (!selectedSourceId || !listRef.current) return
    const el = listRef.current.querySelector(`[data-source-id="${selectedSourceId}"]`)
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, [selectedSourceId])

  // ── Apply toolbar filters to sources ──
  const filteredSources = useMemo(() => {
    let result = sources
    // Source type filter
    if (filters && filters.sourceTypes.size > 0) {
      result = result.filter(s => filters.sourceTypes.has(s.sourceType))
    }
    // Anchor filter
    if (filters?.sourceAnchorFilter) {
      const anchorId = filters.sourceAnchorFilter
      result = result.filter(s => s.anchorIds.includes(anchorId))
    }
    return result
  }, [sources, filters])

  // ── Apply connection-type filter to edges ──
  const filteredEdges = useMemo(() => {
    if (!filters || filters.connTypes.size === 0) return sourceEdges
    // Keep edges that have at least one connection of an active type
    return sourceEdges.filter(e =>
      e.connections.some(c => filters.connTypes.has(c.type))
    )
  }, [sourceEdges, filters])

  // Set of filtered source IDs for fast lookup
  const filteredSourceIds = useMemo(() => new Set(filteredSources.map(s => s.id)), [filteredSources])

  // Connection counts (based on filtered edges + filtered sources)
  const connectionCounts = useMemo(() => {
    const map = new Map<string, number>()
    for (const e of filteredEdges) {
      if (filteredSourceIds.has(e.fromSourceId) && filteredSourceIds.has(e.toSourceId)) {
        map.set(e.fromSourceId, (map.get(e.fromSourceId) ?? 0) + 1)
        map.set(e.toSourceId, (map.get(e.toSourceId) ?? 0) + 1)
      }
    }
    return map
  }, [filteredEdges, filteredSourceIds])

  const selectedSource = sources.find(s => s.id === selectedSourceId)

  // Connected sources + edges for selected (use filtered edges + only show filtered peers)
  const connectedData = useMemo(() => {
    if (!selectedSourceId) return []
    return filteredEdges
      .filter(e => e.fromSourceId === selectedSourceId || e.toSourceId === selectedSourceId)
      .map(e => {
        const otherId = e.fromSourceId === selectedSourceId ? e.toSourceId : e.fromSourceId
        const other = filteredSources.find(s => s.id === otherId)
        if (!other) return null
        return { source: other, edge: e }
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
      .sort((a, b) => b.edge.totalWeight - a.edge.totalWeight)
  }, [selectedSourceId, filteredEdges, filteredSources])

  // Anchors removed from source graph view
  const sourceAnchors: { id: string; label: string; entityType: string }[] = []

  // Fetch shared entities when expanding a connection
  const handleToggleConnection = useCallback(async (otherId: string) => {
    if (expandedConnId === otherId) {
      setExpandedConnId(null)
      setSharedEntities([])
      return
    }
    setExpandedConnId(otherId)
    setLoadingShared(true)

    const other = sources.find(s => s.id === otherId)
    if (!selectedSource || !other) {
      setLoadingShared(false)
      return
    }

    // Compute shared entity IDs
    const selectedIds = new Set(selectedSource.entityIds)
    const sharedIds = other.entityIds.filter(id => selectedIds.has(id))

    if (sharedIds.length === 0) {
      setSharedEntities([])
      setLoadingShared(false)
      return
    }

    try {
      const nodes = await fetchNodesByIds(sharedIds.slice(0, 20))
      setSharedEntities(nodes)
    } catch {
      setSharedEntities([])
    } finally {
      setLoadingShared(false)
    }
  }, [expandedConnId, selectedSource, sources])

  const handleAskAboutConnection = useCallback((otherSource: SourceNode, _edge: SourceEdge) => {
    if (!selectedSource) return
    const connectionPrompt = `What is the connection between "${selectedSource.title}" and "${otherSource.title}"? What shared entities, themes, or insights link these two sources?`
    const ctx = buildSourceConnectionContext({
      sourceA: { id: selectedSource.id, title: selectedSource.title },
      sourceB: { id: otherSource.id, title: otherSource.title },
      connectionPrompt,
    })
    navigate('/ask', { state: { chatContext: ctx } })
  }, [selectedSource, navigate])

  // No source selected — show full source list
  if (!selectedSourceId || !selectedSource) {
    return (
      <div className="flex flex-col h-full" style={{ background: 'var(--color-bg-card)' }}>
        <PanelHeader>
          Sources
          <CountBadge>{filteredSources.length}</CountBadge>
        </PanelHeader>
        <div ref={listRef} className="flex-1 overflow-y-auto" style={{ padding: '4px 8px' }}>
          {filteredSources.length === 0 && (
            <EmptyText>
              {sources.length === 0
                ? 'No sources yet. Ingest content to see your source graph.'
                : 'No sources match the active filters.'}
            </EmptyText>
          )}
          {filteredSources.map(source => {
            const cfg = getSourceConfig(source.sourceType)
            const connCount = connectionCounts.get(source.id) ?? 0
            const date = new Date(source.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
            return (
              <button
                key={source.id}
                data-source-id={source.id}
                type="button"
                onClick={() => onSelectSource(source)}
                className="flex items-center w-full cursor-pointer font-body"
                style={{
                  padding: '10px 10px', background: 'transparent',
                  border: 'none', borderRadius: 8, textAlign: 'left',
                  transition: 'background 0.1s ease', gap: 8,
                }}
                onMouseEnter={e => { e.currentTarget.style.background = 'var(--color-bg-inset)' }}
                onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
              >
                <span style={{ width: 26, height: 26, borderRadius: 6, background: `${cfg.color}14`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, flexShrink: 0 }}>
                  {cfg.icon}
                </span>
                <div className="flex-1" style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {source.title}
                  </div>
                  <div style={{ fontSize: 10, color: 'var(--color-text-secondary)', marginTop: 1 }}>
                    {source.sourceType} · {date} · {source.entityCount} entities
                  </div>
                </div>
                {connCount > 0 && (
                  <span className="flex items-center gap-0.5" style={{ fontSize: 9, color: 'var(--color-text-secondary)', flexShrink: 0 }}>
                    <Link2 size={9} />
                    {connCount}
                  </span>
                )}
              </button>
            )
          })}
        </div>
      </div>
    )
  }

  // Source selected — show detail view with drill-down
  const cfg = getSourceConfig(selectedSource.sourceType)
  const date = new Date(selectedSource.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })

  return (
    <div className="flex flex-col h-full" style={{ background: 'var(--color-bg-card)' }}>
      {/* Header with back */}
      <div
        className="flex items-center gap-2 shrink-0"
        style={{ padding: '12px 16px', borderBottom: '1px solid var(--border-subtle)' }}
      >
        <button
          type="button"
          onClick={() => onSelectSource(null)}
          className="flex items-center cursor-pointer"
          style={{ background: 'none', border: 'none', padding: 2, color: 'var(--color-text-secondary)' }}
        >
          <ArrowLeft size={14} />
        </button>
        <span style={{ width: 26, height: 26, borderRadius: 6, background: `${cfg.color}14`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, flexShrink: 0 }}>
          {cfg.icon}
        </span>
        <span
          className="font-display flex-1"
          style={{ fontSize: 14, fontWeight: 700, color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        >
          {selectedSource.title}
        </span>
      </div>

      <div ref={listRef} className="flex-1 overflow-y-auto" style={{ padding: '0' }}>
        {/* Summary section */}
        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border-subtle)' }}>
          <div className="font-body" style={{ fontSize: 11, color: 'var(--color-text-secondary)', marginBottom: 8 }}>
            {selectedSource.sourceType} · {date} · {selectedSource.entityCount} entities
          </div>

          {/* Tags */}
          {selectedSource.tags.length > 0 && (
            <div style={{ marginBottom: 8 }}>
              <SectionLabel>TAGS</SectionLabel>
              <div className="flex flex-wrap gap-1" style={{ marginTop: 4 }}>
                {selectedSource.tags.slice(0, 8).map(tag => (
                  <span key={tag} style={{ fontFamily: 'var(--font-body)', fontSize: 9, background: 'var(--color-bg-inset)', borderRadius: 4, padding: '2px 6px', color: 'var(--color-text-secondary)' }}>
                    #{tag}
                  </span>
                ))}
                {selectedSource.tags.length > 8 && (
                  <span style={{ fontFamily: 'var(--font-body)', fontSize: 9, color: 'var(--color-text-placeholder)' }}>
                    +{selectedSource.tags.length - 8} more
                  </span>
                )}
              </div>
            </div>
          )}

          {/* Anchors */}
          {sourceAnchors.length > 0 && (
            <div>
              <SectionLabel>ANCHORS</SectionLabel>
              <div className="flex flex-wrap gap-1" style={{ marginTop: 4 }}>
                {sourceAnchors.map(a => (
                  <span
                    key={a.id}
                    className="flex items-center gap-1 font-body"
                    style={{
                      fontSize: 9, fontWeight: 500,
                      background: 'rgba(180,83,9,0.06)', border: '1px solid rgba(180,83,9,0.15)',
                      borderRadius: 4, padding: '2px 6px', color: '#b45309',
                    }}
                  >
                    <AnchorIcon size={8} />
                    {a.label}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Connected sources */}
        <div style={{ padding: '12px 16px 8px' }}>
          <SectionLabel>CONNECTED SOURCES ({connectedData.length})</SectionLabel>
        </div>

        {connectedData.length === 0 ? (
          <EmptyText>No connections to other sources yet.</EmptyText>
        ) : (
          <div style={{ padding: '0 8px 16px' }}>
            {connectedData.map(({ source: other, edge }) => {
              const otherCfg = getSourceConfig(other.sourceType)
              const isExpanded = expandedConnId === other.id

              return (
                <div key={other.id} style={{ marginBottom: 2 }}>
                  {/* Connected source row */}
                  <button
                    type="button"
                    onClick={() => handleToggleConnection(other.id)}
                    className="flex items-center w-full cursor-pointer font-body"
                    style={{
                      padding: '8px 10px',
                      background: isExpanded ? 'var(--color-bg-inset)' : 'transparent',
                      border: 'none', borderRadius: 8, textAlign: 'left',
                      transition: 'background 0.1s ease', gap: 6,
                    }}
                    onMouseEnter={e => { if (!isExpanded) e.currentTarget.style.background = 'var(--color-bg-inset)' }}
                    onMouseLeave={e => { if (!isExpanded) e.currentTarget.style.background = 'transparent' }}
                  >
                    <span style={{ fontSize: 12, flexShrink: 0 }}>{otherCfg.icon}</span>
                    <span className="flex-1" style={{ fontSize: 11, fontWeight: isExpanded ? 600 : 500, color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {other.title}
                    </span>
                    <span style={{
                      fontSize: 9, color: 'var(--color-text-secondary)',
                      background: 'var(--color-bg-inset)', padding: '1px 5px', borderRadius: 4, flexShrink: 0,
                    }}>
                      {edge.totalWeight} shared
                    </span>
                    <ChevronDown
                      size={12}
                      style={{
                        flexShrink: 0, color: 'var(--color-text-placeholder)',
                        transform: isExpanded ? 'rotate(180deg)' : 'none',
                        transition: 'transform 0.15s ease',
                      }}
                    />
                  </button>

                  {/* Expanded detail */}
                  {isExpanded && (
                    <div
                      style={{
                        margin: '0 8px 8px 8px', padding: '10px 12px',
                        background: 'var(--color-bg-content)', borderRadius: 8,
                        border: '1px solid var(--border-subtle)',
                      }}
                    >
                      {/* Connection breakdown */}
                      <SectionLabel>CONNECTION BREAKDOWN</SectionLabel>
                      <div className="flex flex-wrap gap-2" style={{ marginTop: 4, marginBottom: 10 }}>
                        {edge.connections.map(conn => (
                          <span
                            key={conn.type}
                            className="flex items-center gap-1 font-body"
                            style={{ fontSize: 10, color: 'var(--color-text-secondary)' }}
                          >
                            <span style={{
                              width: 6, height: 6, borderRadius: '50%',
                              background: CONN_COLORS[conn.type], flexShrink: 0,
                            }} />
                            {conn.count} {CONN_LABELS[conn.type]}
                          </span>
                        ))}
                      </div>

                      {/* Shared entities */}
                      <SectionLabel>
                        SHARED ENTITIES
                        {sharedEntities.length > 0 && ` (${sharedEntities.length})`}
                      </SectionLabel>
                      <div style={{ marginTop: 4, marginBottom: 10 }}>
                        {loadingShared ? (
                          <span className="font-body" style={{ fontSize: 10, color: 'var(--color-text-placeholder)' }}>Loading…</span>
                        ) : sharedEntities.length === 0 ? (
                          <span className="font-body" style={{ fontSize: 10, color: 'var(--color-text-placeholder)' }}>No directly shared entities</span>
                        ) : (
                          <div className="flex flex-col gap-0.5">
                            {sharedEntities.slice(0, 12).map(node => (
                              <div
                                key={node.id}
                                className="flex items-center gap-1.5 font-body"
                                style={{ fontSize: 10, color: 'var(--color-text-body)', padding: '2px 0' }}
                              >
                                <span style={{
                                  width: 5, height: 5, borderRadius: '50%',
                                  background: getEntityColor(node.entity_type), flexShrink: 0,
                                }} />
                                <span className="flex-1" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                  {node.label}
                                </span>
                                <EntityBadge type={node.entity_type} size="xs" />
                              </div>
                            ))}
                            {sharedEntities.length > 12 && (
                              <span className="font-body" style={{ fontSize: 9, color: 'var(--color-text-placeholder)', paddingTop: 2 }}>
                                +{sharedEntities.length - 12} more
                              </span>
                            )}
                          </div>
                        )}
                      </div>

                      {/* Action buttons */}
                      <div className="flex gap-2" style={{ marginTop: 4 }}>
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); handleAskAboutConnection(other, edge) }}
                          className="flex items-center gap-1.5 cursor-pointer font-body"
                          style={{
                            flex: 1, padding: '7px 10px', fontSize: 10, fontWeight: 600,
                            borderRadius: 6, border: '1px solid var(--border-subtle)',
                            background: 'var(--color-bg-card)', color: 'var(--color-text-body)',
                            transition: 'all 0.15s ease',
                          }}
                          onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--color-accent-500)'; e.currentTarget.style.color = 'var(--color-accent-500)' }}
                          onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border-subtle)'; e.currentTarget.style.color = 'var(--color-text-body)' }}
                        >
                          <MessageSquare size={10} />
                          Ask about connection
                        </button>
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); onSelectSource(other) }}
                          className="flex items-center gap-1.5 cursor-pointer font-body"
                          style={{
                            flex: 1, padding: '7px 10px', fontSize: 10, fontWeight: 600,
                            borderRadius: 6, border: '1px solid var(--color-accent-500)',
                            background: 'var(--color-accent-50)', color: 'var(--color-accent-500)',
                            transition: 'all 0.15s ease',
                          }}
                        >
                          <ArrowRight size={10} />
                          Navigate to source
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Shared Helpers ──────────────────────────────────────────────────────────

function PanelHeader({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="flex items-center gap-2 shrink-0 font-display"
      style={{
        padding: '14px 16px',
        fontSize: 14,
        fontWeight: 700,
        color: 'var(--color-text-primary)',
        borderBottom: '1px solid var(--border-subtle)',
      }}
    >
      {children}
    </div>
  )
}

function CountBadge({ children }: { children: React.ReactNode }) {
  return (
    <span
      className="font-body"
      style={{
        fontSize: 10,
        fontWeight: 600,
        padding: '1px 6px',
        borderRadius: 6,
        background: 'var(--color-bg-inset)',
        color: 'var(--color-text-secondary)',
      }}
    >
      {children}
    </span>
  )
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <span
      className="font-display"
      style={{
        fontSize: 9,
        fontWeight: 700,
        color: 'var(--color-text-secondary)',
        letterSpacing: '0.08em',
        textTransform: 'uppercase' as const,
        marginBottom: 4,
        display: 'block',
      }}
    >
      {children}
    </span>
  )
}

function EmptyText({ children }: { children: React.ReactNode }) {
  return (
    <p
      className="font-body"
      style={{
        fontSize: 12,
        color: 'var(--color-text-secondary)',
        textAlign: 'center',
        padding: '40px 20px',
        lineHeight: 1.5,
      }}
    >
      {children}
    </p>
  )
}

// Compact single-line placeholder for a section with zero items
function ZeroRow({ label }: { label: string }) {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '3px 12px 5px',
      fontFamily: 'var(--font-body)',
      fontSize: 10,
      color: 'var(--color-text-placeholder)',
    }}>
      <span>{label}</span>
      <span>0</span>
    </div>
  )
}

function SuggestedAnchorPanel({
  candidate, onConfirm, onDismiss, onClose,
}: {
  candidate: AnchorCandidateWithNode
  onConfirm: (candidateId: string, nodeId: string) => Promise<void>
  onDismiss: (candidateId: string, dismissCount: number) => Promise<void>
  onClose: () => void
}) {
  const [confirming, setConfirming] = useState(false)
  const [dismissing, setDismissing] = useState(false)
  const node = candidate.node

  const handleConfirm = async () => {
    if (!node) return
    setConfirming(true)
    await onConfirm(candidate.id, node.id)
    setConfirming(false)
  }

  const handleDismiss = async () => {
    setDismissing(true)
    await onDismiss(candidate.id, candidate.dismissCount)
    setDismissing(false)
  }

  const scorePct = Math.round(candidate.compositeScore * 100)
  const scoreColor = candidate.compositeScore >= 0.60 ? '#16a34a'
    : candidate.compositeScore >= 0.50 ? '#d97706'
    : 'var(--color-text-secondary)'

  return (
    <div style={{
      height: '100%', overflowY: 'auto', padding: '20px 18px',
      animation: 'slideInRight 0.2s ease',
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 14 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
            <div style={{
              display: 'inline-flex', alignItems: 'center', gap: 4,
              padding: '2px 8px', borderRadius: 4,
              background: 'rgba(245,158,11,0.08)',
              border: '1px solid rgba(245,158,11,0.2)',
            }}>
              <span style={{ fontSize: 10, fontWeight: 700, color: '#d97706', fontFamily: 'var(--font-body)' }}>
                ✦ Suggested
              </span>
            </div>
            <span style={{
              fontSize: 10, fontWeight: 700,
              color: scoreColor,
              background: `${scoreColor}12`,
              border: `1px solid ${scoreColor}28`,
              borderRadius: 4, padding: '2px 7px',
              fontFamily: 'var(--font-body)',
            }}>
              {scorePct}%
            </span>
          </div>
          <h2 style={{
            fontFamily: 'var(--font-display)', fontSize: 16, fontWeight: 700,
            color: 'var(--color-text-primary)', margin: 0, lineHeight: 1.3,
          }}>
            {node?.label ?? 'Unknown'}
          </h2>
          {node && (
            <div style={{ marginTop: 6 }}>
              <EntityBadge type={node.entity_type} size="xs" />
            </div>
          )}
        </div>
        <button
          type="button" onClick={onClose}
          style={{
            background: 'none', border: 'none', cursor: 'pointer',
            color: 'var(--color-text-secondary)', padding: 4, flexShrink: 0,
            fontSize: 18, lineHeight: 1,
          }}
        >
          ×
        </button>
      </div>

      {candidate.reasoningText && (
        <div style={{
          background: 'rgba(245,158,11,0.05)',
          border: '1px solid rgba(245,158,11,0.15)',
          borderRadius: 8, padding: '10px 12px', marginBottom: 16,
        }}>
          <p style={{
            fontFamily: 'var(--font-body)', fontSize: 12,
            color: 'var(--color-text-body)', lineHeight: 1.6, margin: 0,
          }}>
            {candidate.reasoningText}
          </p>
        </div>
      )}

      <div style={{ marginBottom: 16 }}>
        <div style={{
          fontFamily: 'var(--font-display)', fontSize: 10, fontWeight: 700,
          textTransform: 'uppercase' as const, letterSpacing: '0.08em',
          color: 'var(--color-text-secondary)', marginBottom: 8,
        }}>
          Signal Breakdown
        </div>
        {([
          ['Centrality', candidate.centralityScore],
          ['Diversity', candidate.diversityScore],
          ['Velocity', candidate.velocityScore],
          ['Richness', candidate.richnessScore],
        ] as [string, number][]).map(([label, value]) => {
          const fill = value >= 0.7 ? '#22c55e' : value >= 0.4 ? '#f59e0b' : '#ef4444'
          return (
            <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5 }}>
              <span style={{
                fontFamily: 'var(--font-display)', fontSize: 9, fontWeight: 700,
                color: 'var(--color-text-secondary)', width: 60, flexShrink: 0,
                textTransform: 'uppercase' as const, letterSpacing: '0.04em',
              }}>
                {label}
              </span>
              <div style={{
                flex: 1, height: 4, background: 'var(--color-bg-inset)', borderRadius: 2, overflow: 'hidden',
              }}>
                <div style={{
                  height: '100%', width: `${Math.round(value * 100)}%`,
                  background: fill, borderRadius: 2, transition: 'width 0.4s ease',
                }} />
              </div>
              <span style={{
                fontFamily: 'var(--font-body)', fontSize: 10, fontWeight: 600,
                color: 'var(--color-text-body)', width: 28, textAlign: 'right' as const, flexShrink: 0,
              }}>
                {Math.round(value * 100)}
              </span>
            </div>
          )
        })}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginBottom: 16 }}>
        {([
          ['Mentions', candidate.mentionCount],
          ['Sources', candidate.sourceCount],
          ['Edges', candidate.connectionCount],
          ['Score', `${scorePct}%`],
        ] as [string, number | string][]).map(([label, value]) => (
          <div key={label} style={{
            background: 'var(--color-bg-inset)', borderRadius: 8, padding: '8px 10px',
          }}>
            <div style={{
              fontFamily: 'var(--font-display)', fontSize: 14, fontWeight: 700,
              color: 'var(--color-text-primary)',
            }}>
              {value}
            </div>
            <div style={{
              fontFamily: 'var(--font-body)', fontSize: 10,
              color: 'var(--color-text-secondary)', marginTop: 2,
            }}>
              {label}
            </div>
          </div>
        ))}
      </div>

      {candidate.velocityDirection !== 'stable' && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 6, marginBottom: 16,
          padding: '7px 10px', borderRadius: 8,
          background: candidate.velocityDirection === 'rising'
            ? 'rgba(34,197,94,0.06)' : 'rgba(239,68,68,0.06)',
          border: `1px solid ${candidate.velocityDirection === 'rising'
            ? 'rgba(34,197,94,0.2)' : 'rgba(239,68,68,0.2)'}`,
        }}>
          <span style={{
            fontSize: 12,
            color: candidate.velocityDirection === 'rising' ? '#16a34a' : '#dc2626',
          }}>
            {candidate.velocityDirection === 'rising' ? '↑' : '↓'}
          </span>
          <span style={{
            fontFamily: 'var(--font-body)', fontSize: 11, fontWeight: 500,
            color: candidate.velocityDirection === 'rising' ? '#16a34a' : 'var(--color-text-secondary)',
          }}>
            {candidate.velocityDirection === 'rising'
              ? 'Activity increasing recently'
              : 'Activity has slowed recently'}
          </span>
        </div>
      )}

      <div style={{
        borderTop: '1px solid var(--border-subtle)',
        paddingTop: 14, marginTop: 4,
        display: 'flex', flexDirection: 'column', gap: 8,
      }}>
        {candidate.suggestedParentAnchorId ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <button
              type="button" onClick={handleConfirm}
              disabled={confirming || !node}
              style={{
                width: '100%', padding: '9px 0', borderRadius: 8, border: 'none',
                background: confirming ? 'var(--color-bg-inset)' : 'var(--color-accent-500)',
                color: confirming ? 'var(--color-text-secondary)' : 'white',
                fontFamily: 'var(--font-body)', fontSize: 13, fontWeight: 600,
                cursor: confirming ? 'default' : 'pointer',
                transition: 'all 0.15s ease',
              }}
            >
              {confirming ? 'Confirming…' : '✓ Confirm as Independent Anchor'}
            </button>
            <button
              type="button"
              onClick={async () => {
                if (!node || !candidate.suggestedParentAnchorId) return
                setConfirming(true)
                const { promoteToSubAnchor } = await import('../../services/anchorCandidates')
                const success = await promoteToSubAnchor(candidate.id, node.id, candidate.suggestedParentAnchorId)
                if (success) {
                  await onConfirm(candidate.id, node.id)
                }
                setConfirming(false)
              }}
              disabled={confirming || !node}
              style={{
                width: '100%', padding: '9px 0', borderRadius: 8,
                border: '1px solid var(--border-subtle)',
                background: 'var(--color-bg-inset)',
                color: 'var(--color-text-body)',
                fontFamily: 'var(--font-body)', fontSize: 12, fontWeight: 600,
                cursor: confirming ? 'default' : 'pointer',
              }}
            >
              ⊃ Add as sub-anchor
            </button>
          </div>
        ) : (
          <button
            type="button" onClick={handleConfirm}
            disabled={confirming || !node}
            style={{
              width: '100%', padding: '9px 0', borderRadius: 8, border: 'none',
              background: confirming ? 'var(--color-bg-inset)' : 'var(--color-accent-500)',
              color: confirming ? 'var(--color-text-secondary)' : 'white',
              fontFamily: 'var(--font-body)', fontSize: 13, fontWeight: 600,
              cursor: confirming ? 'default' : 'pointer',
              transition: 'all 0.15s ease',
            }}
          >
            {confirming ? 'Confirming…' : '✓ Confirm Anchor'}
          </button>
        )}
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            type="button"
            onClick={() => { window.location.href = '/anchors' }}
            style={{
              flex: 1, padding: '7px 0', borderRadius: 8,
              border: '1px solid var(--border-subtle)',
              background: 'var(--color-bg-inset)',
              color: 'var(--color-text-body)',
              fontFamily: 'var(--font-body)', fontSize: 12, fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Full Review →
          </button>
          <button
            type="button" onClick={handleDismiss}
            disabled={dismissing}
            style={{
              flex: 1, padding: '7px 0', borderRadius: 8,
              border: '1px solid var(--border-subtle)',
              background: 'transparent',
              color: 'var(--color-text-secondary)',
              fontFamily: 'var(--font-body)', fontSize: 12, fontWeight: 600,
              cursor: dismissing ? 'default' : 'pointer',
            }}
          >
            {dismissing ? 'Dismissing…' : 'Dismiss'}
          </button>
        </div>
      </div>

      <style>{`
        @keyframes slideInRight {
          from { opacity: 0; transform: translateX(12px); }
          to { opacity: 1; transform: translateX(0); }
        }
      `}</style>
    </div>
  )
}
