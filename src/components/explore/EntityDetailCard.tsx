import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { X, ChevronDown, ChevronRight, Sparkles, ExternalLink, Link2 } from 'lucide-react'
import { getEntityColor } from '../../config/entityTypes'
import { buildBrowseEntityExploreContext } from '../../config/chatEntryContexts'
import { useAuth } from '../../hooks/useAuth'
import { fetchEntityNeighbors } from '../../services/exploreQueries'
import { supabase } from '../../services/supabase'
import type { EntityNode, ClusterData } from '../../types/explore'
import type { EntityEdge, EntityNeighbor } from '../../services/exploreQueries'

interface EntityDetailCardProps {
  entity: EntityNode
  allEntities: EntityNode[]
  edges: EntityEdge[]
  cluster: ClusterData
  allClusters: ClusterData[]
  onClose: () => void
  onNavigateToEntityBrowser?: (entityLabel: string) => void
}

const PANEL_WIDTH = 370
const MAX_TAGS = 10
const DEFAULT_VISIBLE = 6

interface InternalConnection {
  id: string
  label: string
  entityType: string
  relationType: string | null
  weight: number
  direction: 'outgoing' | 'incoming'
}

interface ExternalConnection {
  id: string
  label: string
  entityType: string
  anchorLabel: string | null
  anchorColor: string | null
  direction: 'outgoing' | 'incoming'
}

export function EntityDetailCard({
  entity,
  allEntities,
  edges,
  cluster,
  allClusters,
  onClose,
  onNavigateToEntityBrowser,
}: EntityDetailCardProps) {
  const navigate = useNavigate()
  const { user } = useAuth()
  const panelRef = useRef<HTMLDivElement>(null)
  const [showAllInternal, setShowAllInternal] = useState(false)
  const [showAllExternal, setShowAllExternal] = useState(false)
  const [expandedSection, setExpandedSection] = useState<'internal' | 'external' | null>('internal')
  const [externalNeighbors, setExternalNeighbors] = useState<EntityNeighbor[]>([])
  const [anchorMap, setAnchorMap] = useState<Map<string, { label: string; color: string }>>(new Map())
  const [loadingExternal, setLoadingExternal] = useState(false)

  // Prevent wheel events on the panel from zooming the graph
  const handleWheel = useCallback((e: WheelEvent) => { e.stopPropagation() }, [])

  useEffect(() => {
    const el = panelRef.current
    if (!el) return
    el.addEventListener('wheel', handleWheel, { passive: false })
    return () => el.removeEventListener('wheel', handleWheel)
  }, [handleWheel])

  // Reset state on entity change
  useEffect(() => {
    setShowAllInternal(false)
    setShowAllExternal(false)
    setExpandedSection('internal')
    setExternalNeighbors([])
    setAnchorMap(new Map())
  }, [entity.id])

  // Build anchor lookup from allClusters
  const clusterAnchorMap = useMemo(() => {
    const map = new Map<string, { label: string; entityType: string }>()
    for (const c of allClusters) {
      map.set(c.anchor.id, { label: c.anchor.label, entityType: c.anchor.entityType })
    }
    return map
  }, [allClusters])

  // Set of entity IDs in this cluster
  const clusterEntityIds = useMemo(() => new Set(allEntities.map(e => e.id)), [allEntities])

  // Fetch ALL neighbors + their anchor memberships
  useEffect(() => {
    if (!user) return
    let cancelled = false
    setLoadingExternal(true)

    async function load() {
      try {
        const neighbors = await fetchEntityNeighbors(user!.id, entity.id)
        if (cancelled) return
        setExternalNeighbors(neighbors)

        // Get external neighbor IDs (not in this cluster)
        const externalIds = neighbors
          .filter(n => !clusterEntityIds.has(n.node.id))
          .map(n => n.node.id)

        if (externalIds.length === 0) {
          setAnchorMap(new Map())
          return
        }

        // Find which anchors each external neighbor connects to
        // Query edges where one side is an external neighbor and the other is an anchor
        const { data: anchorEdges } = await supabase
          .from('knowledge_edges')
          .select('source_node_id, target_node_id')
          .eq('user_id', user!.id)
          .or(
            externalIds.map(id => `source_node_id.eq.${id},target_node_id.eq.${id}`).join(',')
          )

        if (cancelled) return

        // Build nodeId → anchorLabel map
        const nodeAnchorMap = new Map<string, { label: string; color: string }>()
        for (const edge of anchorEdges ?? []) {
          const src = edge.source_node_id as string
          const tgt = edge.target_node_id as string

          // Check if either side is a known anchor
          for (const [nodeId, anchorId] of [[src, tgt], [tgt, src]] as [string, string][]) {
            if (externalIds.includes(nodeId) && !nodeAnchorMap.has(nodeId)) {
              const anchor = clusterAnchorMap.get(anchorId)
              if (anchor) {
                nodeAnchorMap.set(nodeId, {
                  label: anchor.label,
                  color: getEntityColor(anchor.entityType),
                })
              }
            }
          }
        }
        if (!cancelled) setAnchorMap(nodeAnchorMap)
      } catch (err) {
        console.warn('EntityDetailCard fetch error:', err)
      } finally {
        if (!cancelled) setLoadingExternal(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [user, entity.id, clusterEntityIds, clusterAnchorMap])

  const entityColor = getEntityColor(entity.entityType)

  // Build entity lookup for cluster entities
  const entityMap = useMemo(() => {
    const map = new Map<string, EntityNode>()
    for (const e of allEntities) map.set(e.id, e)
    return map
  }, [allEntities])

  // Within-anchor connections (from the cluster's edge set)
  const internalConnections: InternalConnection[] = useMemo(() => {
    const result: InternalConnection[] = []
    for (const edge of edges) {
      let connectedId: string | null = null
      let direction: 'outgoing' | 'incoming' = 'outgoing'

      if (edge.sourceNodeId === entity.id) {
        connectedId = edge.targetNodeId
        direction = 'outgoing'
      } else if (edge.targetNodeId === entity.id) {
        connectedId = edge.sourceNodeId
        direction = 'incoming'
      } else {
        continue
      }

      const connectedEntity = entityMap.get(connectedId)
      if (!connectedEntity) continue
      if (!clusterEntityIds.has(connectedId)) continue

      result.push({
        id: connectedEntity.id,
        label: connectedEntity.label,
        entityType: connectedEntity.entityType,
        relationType: edge.relationType,
        weight: edge.weight ?? 1,
        direction,
      })
    }
    result.sort((a, b) => b.weight - a.weight)
    return result
  }, [edges, entity.id, entityMap, clusterEntityIds])

  // Cross-anchor connections (from full neighbor fetch, excluding cluster members)
  const externalConnections: ExternalConnection[] = useMemo(() => {
    return externalNeighbors
      .filter(n => !clusterEntityIds.has(n.node.id))
      .map(n => {
        const anchorInfo = anchorMap.get(n.node.id)
        return {
          id: n.node.id,
          label: n.node.label,
          entityType: n.node.entityType,
          anchorLabel: anchorInfo?.label ?? null,
          anchorColor: anchorInfo?.color ?? null,
          direction: n.direction,
        }
      })
  }, [externalNeighbors, clusterEntityIds, anchorMap])

  // Tags — limit to top 10
  const tags = entity.tags.filter(t => t.trim()).slice(0, MAX_TAGS)
  const totalTags = entity.tags.filter(t => t.trim()).length

  // Chat action
  const handleExploreWithAI = useCallback(() => {
    const context = buildBrowseEntityExploreContext({
      id: entity.id,
      label: entity.label,
      entity_type: entity.entityType,
      source_id: entity.sourceId,
    })
    navigate('/ask', { state: { chatContext: context } })
  }, [entity, navigate])

  // Source link
  const handleSourceClick = useCallback(() => { navigate('/') }, [navigate])

  // "Show all" navigates to entity browser
  const handleShowAllExternal = useCallback(() => {
    if (onNavigateToEntityBrowser) {
      onNavigateToEntityBrowser(entity.label)
    }
  }, [entity.label, onNavigateToEntityBrowser])

  return (
    <div
      ref={panelRef}
      style={{
        position: 'absolute', top: 0, right: 0, bottom: 0, width: PANEL_WIDTH,
        background: 'rgba(255,255,255,0.97)', backdropFilter: 'blur(20px)',
        borderLeft: '1px solid var(--border-subtle)', zIndex: 40,
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
        boxShadow: '-4px 0 24px rgba(0,0,0,0.06)', animation: 'slideInRight 0.2s ease',
      }}
    >
      {/* Header */}
      <div style={{ padding: '16px 16px 12px', borderBottom: '1px solid var(--border-subtle)', flexShrink: 0 }}>
        <div className="flex items-center justify-between" style={{ marginBottom: 8 }}>
          <div className="flex items-center gap-2" style={{ minWidth: 0 }}>
            <span style={{ width: 10, height: 10, borderRadius: '50%', background: `${entityColor}22`, border: `2px solid ${entityColor}`, flexShrink: 0 }} />
            <span className="font-display" style={{ fontSize: 14, fontWeight: 700, color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {entity.label}
            </span>
          </div>
          <button type="button" onClick={onClose} className="flex items-center justify-center cursor-pointer"
            style={{ width: 24, height: 24, borderRadius: 6, background: 'transparent', border: '1px solid var(--border-subtle)', color: 'var(--color-text-secondary)', flexShrink: 0 }}>
            <X size={12} />
          </button>
        </div>

        <div className="flex items-center gap-2 flex-wrap" style={{ marginBottom: 8 }}>
          <span className="font-body" style={{ fontSize: 9, fontWeight: 600, padding: '1px 6px', borderRadius: 3, color: entityColor, background: `${entityColor}12`, border: `1px solid ${entityColor}25` }}>
            {entity.entityType}
          </span>
          <span className="font-body" style={{ fontSize: 10, color: 'var(--color-text-secondary)' }}>
            {entity.connectionCount} connections
          </span>
          {entity.confidence !== null && (
            <span className="font-body" style={{ fontSize: 10, color: 'var(--color-text-secondary)' }}>
              · {Math.round(entity.confidence * 100)}% confidence
            </span>
          )}
          {entity.isBridge && (
            <span className="font-body" style={{ fontSize: 8, fontWeight: 600, padding: '1px 5px', borderRadius: 3, color: '#059669', background: '#05966912', border: '1px solid #05966925' }}>
              Bridge
            </span>
          )}
        </div>

        {entity.description && (
          <p className="font-body" style={{ fontSize: 11, color: 'var(--color-text-secondary)', lineHeight: 1.45, margin: 0 }}>
            {entity.description.length > 180 ? entity.description.slice(0, 177) + '…' : entity.description}
          </p>
        )}
      </div>

      {/* Summary stats */}
      <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--border-subtle)', display: 'flex', gap: 12, flexShrink: 0 }}>
        <StatBlock label="Within anchor" value={internalConnections.length} />
        <StatBlock label="Cross-anchor" value={loadingExternal ? '…' : externalConnections.length} />
        <StatBlock label="Anchors" value={entity.clusters.length} />
      </div>

      {/* Source info */}
      {entity.sourceName && (
        <button type="button" onClick={handleSourceClick} className="flex items-center gap-2 w-full cursor-pointer"
          style={{ padding: '8px 16px', background: 'transparent', border: 'none', borderBottom: '1px solid var(--border-subtle)', textAlign: 'left', transition: 'background 0.12s ease' }}>
          <ExternalLink size={10} style={{ color: 'var(--color-accent-500)', flexShrink: 0 }} />
          <span className="font-body" style={{ fontSize: 10, color: 'var(--color-text-secondary)', flex: 1 }}>
            From: <strong style={{ fontWeight: 600, color: 'var(--color-accent-500)' }}>
              {entity.sourceName.length > 35 ? entity.sourceName.slice(0, 33) + '…' : entity.sourceName}
            </strong>
            {entity.sourceType && <span> ({entity.sourceType})</span>}
          </span>
        </button>
      )}

      {/* Explore with AI */}
      <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--border-subtle)', flexShrink: 0 }}>
        <button type="button" onClick={handleExploreWithAI}
          className="flex items-center justify-center gap-1.5 w-full font-body cursor-pointer"
          style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-accent-500)', background: 'var(--color-accent-50)', border: '1px solid rgba(214,58,0,0.15)', borderRadius: 8, padding: '8px 0', transition: 'background 0.12s ease' }}>
          <Sparkles size={13} />
          Explore with AI
        </button>
      </div>

      {/* Scrollable connections area */}
      <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden' }}>

        {/* Within-anchor connections */}
        <CollapsibleSection
          title={`Within "${cluster.anchor.label.length > 18 ? cluster.anchor.label.slice(0, 16) + '…' : cluster.anchor.label}"`}
          icon={<Link2 size={10} />}
          count={internalConnections.length}
          isExpanded={expandedSection === 'internal'}
          onToggleExpand={() => setExpandedSection(expandedSection === 'internal' ? null : 'internal')}
        >
          {internalConnections.length === 0 ? (
            <span className="font-body" style={{ fontSize: 10, color: 'var(--color-text-placeholder)' }}>No connections within this anchor</span>
          ) : (
            <>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                {(showAllInternal ? internalConnections : internalConnections.slice(0, DEFAULT_VISIBLE)).map((conn, i) => (
                  <InternalRow key={`${conn.id}-${i}`} conn={conn} />
                ))}
              </div>
              {internalConnections.length > DEFAULT_VISIBLE && (
                <button type="button" onClick={() => setShowAllInternal(!showAllInternal)} className="font-body cursor-pointer"
                  style={{ fontSize: 9, fontWeight: 600, color: 'var(--color-accent-500)', background: 'none', border: 'none', padding: '6px 0 0' }}>
                  {showAllInternal ? `Show top ${DEFAULT_VISIBLE}` : `Show all ${internalConnections.length}`}
                </button>
              )}
            </>
          )}
        </CollapsibleSection>

        {/* Cross-anchor connections */}
        <CollapsibleSection
          title="Cross-anchor connections"
          icon={<ExternalLink size={10} />}
          count={loadingExternal ? '…' : externalConnections.length}
          isExpanded={expandedSection === 'external'}
          onToggleExpand={() => setExpandedSection(expandedSection === 'external' ? null : 'external')}
        >
          {loadingExternal ? (
            <span className="font-body" style={{ fontSize: 10, color: 'var(--color-text-placeholder)' }}>Loading connections…</span>
          ) : externalConnections.length === 0 ? (
            <span className="font-body" style={{ fontSize: 10, color: 'var(--color-text-placeholder)' }}>No cross-anchor connections</span>
          ) : (
            <>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                {(showAllExternal ? externalConnections.slice(0, 30) : externalConnections.slice(0, DEFAULT_VISIBLE)).map((conn, i) => (
                  <ExternalRow key={`${conn.id}-${i}`} conn={conn} />
                ))}
              </div>
              {externalConnections.length > DEFAULT_VISIBLE && (
                <button type="button"
                  onClick={onNavigateToEntityBrowser ? handleShowAllExternal : () => setShowAllExternal(!showAllExternal)}
                  className="font-body cursor-pointer"
                  style={{ fontSize: 9, fontWeight: 600, color: 'var(--color-accent-500)', background: 'none', border: 'none', padding: '6px 0 0' }}>
                  {showAllExternal && !onNavigateToEntityBrowser
                    ? `Show top ${DEFAULT_VISIBLE}`
                    : `View all ${externalConnections.length} in entity browser →`}
                </button>
              )}
            </>
          )}
        </CollapsibleSection>

        {/* Tags */}
        {tags.length > 0 && (
          <div style={{ padding: '10px 16px', borderTop: '1px solid var(--border-subtle)' }}>
            <SectionLabel>Tags{totalTags > MAX_TAGS ? ` (${MAX_TAGS} of ${totalTags})` : ''}</SectionLabel>
            <div className="flex flex-wrap gap-1.5">
              {tags.map(tag => (
                <span key={tag} className="font-body"
                  style={{ fontSize: 9, fontWeight: 500, padding: '2px 7px', borderRadius: 4, background: 'var(--color-bg-inset)', color: 'var(--color-text-secondary)', border: '1px solid var(--border-subtle)' }}>
                  #{tag}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function StatBlock({ label, value }: { label: string; value: number | string }) {
  return (
    <div style={{ flex: 1 }}>
      <div className="font-display" style={{ fontSize: 15, fontWeight: 700, color: 'var(--color-text-primary)' }}>
        {typeof value === 'number' ? value.toLocaleString() : value}
      </div>
      <div className="font-body" style={{ fontSize: 8, color: 'var(--color-text-secondary)', marginTop: 1 }}>{label}</div>
    </div>
  )
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="font-display" style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--color-text-secondary)', display: 'block', marginBottom: 6 }}>
      {children}
    </span>
  )
}

function CollapsibleSection({ title, icon, count, isExpanded, onToggleExpand, children }: {
  title: string; icon: React.ReactNode; count: number | string
  isExpanded: boolean; onToggleExpand: () => void; children: React.ReactNode
}) {
  return (
    <div style={{ borderBottom: '1px solid var(--border-subtle)' }}>
      <button type="button" onClick={onToggleExpand} className="flex items-center gap-2 w-full cursor-pointer"
        style={{ padding: '10px 16px', background: 'transparent', border: 'none', textAlign: 'left' }}>
        {isExpanded ? <ChevronDown size={10} style={{ color: 'var(--color-text-secondary)', flexShrink: 0 }} /> : <ChevronRight size={10} style={{ color: 'var(--color-text-secondary)', flexShrink: 0 }} />}
        <span style={{ color: 'var(--color-text-secondary)', flexShrink: 0 }}>{icon}</span>
        <span className="font-display" style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--color-text-secondary)' }}>{title}</span>
        <span className="font-body" style={{ fontSize: 9, color: 'var(--color-text-placeholder)', marginLeft: 'auto' }}>{count}</span>
      </button>
      {isExpanded && <div style={{ padding: '0 16px 10px' }}>{children}</div>}
    </div>
  )
}

function InternalRow({ conn }: { conn: InternalConnection }) {
  const color = getEntityColor(conn.entityType)
  const arrow = conn.direction === 'outgoing' ? '→' : '←'
  return (
    <div className="flex items-center gap-2" style={{ padding: '4px 8px', borderRadius: 6, background: 'rgba(255,255,255,0.6)', border: '1px solid var(--border-subtle)' }}>
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: `${color}22`, border: `1.5px solid ${color}`, flexShrink: 0 }} />
      <span className="font-body" style={{ fontSize: 10, fontWeight: 600, color: 'var(--color-text-primary)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {conn.label}
      </span>
      {conn.relationType && (
        <span className="font-body" style={{ fontSize: 8, fontWeight: 500, color: 'var(--color-text-placeholder)', flexShrink: 0, maxWidth: 80, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {arrow} {conn.relationType}
        </span>
      )}
      <span className="font-body" style={{ fontSize: 7, fontWeight: 600, padding: '0px 4px', borderRadius: 2, color, background: `${color}10`, flexShrink: 0 }}>
        {conn.entityType}
      </span>
    </div>
  )
}

function ExternalRow({ conn }: { conn: ExternalConnection }) {
  const color = getEntityColor(conn.entityType)
  return (
    <div className="flex items-center gap-2" style={{ padding: '4px 8px', borderRadius: 6, background: 'rgba(255,255,255,0.6)', border: '1px solid var(--border-subtle)' }}>
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: `${color}22`, border: `1.5px solid ${color}`, flexShrink: 0 }} />
      <span className="font-body" style={{ fontSize: 10, fontWeight: 600, color: 'var(--color-text-primary)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {conn.label}
      </span>
      {/* Show which anchor this entity belongs to instead of relation type */}
      {conn.anchorLabel ? (
        <span className="font-body flex items-center gap-1" style={{ fontSize: 8, fontWeight: 500, color: 'var(--color-text-placeholder)', flexShrink: 0, maxWidth: 100 }}>
          <span style={{ width: 4, height: 4, borderRadius: '50%', background: conn.anchorColor ?? '#808080', flexShrink: 0 }} />
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {conn.anchorLabel}
          </span>
        </span>
      ) : (
        <span className="font-body" style={{ fontSize: 7, fontWeight: 600, padding: '0px 4px', borderRadius: 2, color, background: `${color}10`, flexShrink: 0 }}>
          {conn.entityType}
        </span>
      )}
    </div>
  )
}
