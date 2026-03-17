import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { X, ChevronDown, ChevronRight, Network, ArrowRight, Sparkles } from 'lucide-react'
import { getEntityColor } from '../../config/entityTypes'
import { buildAnchorConnectionsContext } from '../../config/chatEntryContexts'
import type { ClusterData, CrossClusterEdge } from '../../types/explore'

interface AnchorConnectionsCardProps {
  cluster: ClusterData
  allClusters: ClusterData[]
  onClose: () => void
  onNavigateToCluster: (clusterId: string) => void
}

const PANEL_WIDTH = 370
const DEFAULT_VISIBLE = 8

interface ConnectionRow {
  targetCluster: ClusterData
  edge: CrossClusterEdge
  relativeStrength: number
  sharedTypes: { entityType: string; sourceCount: number; targetCount: number }[]
}

export function AnchorConnectionsCard({
  cluster,
  allClusters,
  onClose,
  onNavigateToCluster,
}: AnchorConnectionsCardProps) {
  const navigate = useNavigate()
  const panelRef = useRef<HTMLDivElement>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [showAll, setShowAll] = useState(false)

  // Prevent wheel events on the panel from zooming the graph
  const handleWheel = useCallback((e: WheelEvent) => {
    e.stopPropagation()
  }, [])

  useEffect(() => {
    const el = panelRef.current
    if (!el) return
    el.addEventListener('wheel', handleWheel, { passive: false })
    return () => el.removeEventListener('wheel', handleWheel)
  }, [handleWheel])

  // Reset state when cluster changes
  useEffect(() => {
    setExpandedId(null)
    setShowAll(false)
  }, [cluster.anchor.id])

  // Build sorted connection rows
  const connections: ConnectionRow[] = useMemo(() => {
    const maxWeight = Math.max(...cluster.crossClusterEdges.map(e => e.totalWeight), 1)

    const sourceTypeMap = new Map<string, number>()
    for (const td of cluster.typeDistribution) {
      sourceTypeMap.set(td.entityType, td.count)
    }

    return cluster.crossClusterEdges
      .map(edge => {
        const targetCluster = allClusters.find(c => c.anchor.id === edge.targetClusterId)
        if (!targetCluster) return null

        const sharedTypes: ConnectionRow['sharedTypes'] = []
        for (const td of targetCluster.typeDistribution) {
          const sourceCount = sourceTypeMap.get(td.entityType) ?? 0
          if (sourceCount > 0) {
            sharedTypes.push({ entityType: td.entityType, sourceCount, targetCount: td.count })
          }
        }
        sharedTypes.sort((a, b) => (b.sourceCount + b.targetCount) - (a.sourceCount + a.targetCount))

        return { targetCluster, edge, relativeStrength: edge.totalWeight / maxWeight, sharedTypes }
      })
      .filter((r): r is ConnectionRow => r !== null)
      .sort((a, b) => b.edge.totalWeight - a.edge.totalWeight)
  }, [cluster, allClusters])

  const visibleConnections = showAll ? connections : connections.slice(0, DEFAULT_VISIBLE)
  const hasMore = connections.length > DEFAULT_VISIBLE

  // Summary stats
  const totalConnections = connections.reduce((s, c) => s + c.edge.crossEdgeCount, 0)
  const totalSharedEntities = connections.reduce((s, c) => s + c.edge.sharedEntityCount, 0)
  const strongestConnection = connections[0] ?? null

  const entityColor = getEntityColor(cluster.anchor.entityType)

  // "Learn more" button — navigates to Ask with full anchor connections context
  const handleLearnMore = useCallback(() => {
    const context = buildAnchorConnectionsContext({
      anchorId: cluster.anchor.id,
      anchorLabel: cluster.anchor.label,
      entityType: cluster.anchor.entityType,
      description: cluster.anchor.description,
      entityCount: cluster.entityCount,
      connectedAnchors: connections.map(c => ({
        label: c.targetCluster.anchor.label,
        entityType: c.targetCluster.anchor.entityType,
        sharedEntityCount: c.edge.sharedEntityCount,
        crossEdgeCount: c.edge.crossEdgeCount,
      })),
    })
    navigate('/ask', { state: { chatContext: context } })
  }, [cluster, connections, navigate])

  return (
    <div
      ref={panelRef}
      style={{
        position: 'absolute',
        top: 0,
        right: 0,
        bottom: 0,
        width: PANEL_WIDTH,
        background: 'var(--color-bg-card)',
        borderLeft: '1px solid var(--border-subtle)',
        zIndex: 40,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        boxShadow: '-4px 0 24px rgba(0,0,0,0.06)',
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: '16px 16px 12px',
          borderBottom: '1px solid var(--border-subtle)',
          flexShrink: 0,
        }}
      >
        <div className="flex items-center justify-between" style={{ marginBottom: 8 }}>
          <div className="flex items-center gap-2" style={{ minWidth: 0 }}>
            <span
              style={{
                width: 10,
                height: 10,
                borderRadius: '50%',
                background: `${entityColor}22`,
                border: `2px solid ${entityColor}`,
                flexShrink: 0,
              }}
            />
            <span
              className="font-display"
              style={{
                fontSize: 14,
                fontWeight: 700,
                color: 'var(--color-text-primary)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {cluster.anchor.label}
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex items-center justify-center cursor-pointer"
            style={{
              width: 24,
              height: 24,
              borderRadius: 6,
              background: 'transparent',
              border: '1px solid var(--border-subtle)',
              color: 'var(--color-text-secondary)',
              flexShrink: 0,
            }}
          >
            <X size={12} />
          </button>
        </div>

        {/* Type badge + entity count */}
        <div className="flex items-center gap-2" style={{ marginBottom: 10 }}>
          <span
            className="font-body"
            style={{
              fontSize: 9,
              fontWeight: 600,
              padding: '1px 6px',
              borderRadius: 3,
              color: entityColor,
              background: `${entityColor}12`,
              border: `1px solid ${entityColor}25`,
            }}
          >
            {cluster.anchor.entityType}
          </span>
          <span className="font-body" style={{ fontSize: 10, color: 'var(--color-text-secondary)' }}>
            {cluster.entityCount} entities
          </span>
          {cluster.subAnchorIds.length > 0 && (
            <span className="font-body" style={{ fontSize: 10, color: 'var(--color-text-secondary)' }}>
              · {cluster.subAnchorIds.length} sub-anchors
            </span>
          )}
        </div>

        {/* Description */}
        {cluster.anchor.description && (
          <p
            className="font-body"
            style={{
              fontSize: 11,
              color: 'var(--color-text-secondary)',
              lineHeight: 1.45,
              margin: 0,
            }}
          >
            {cluster.anchor.description.length > 150
              ? cluster.anchor.description.slice(0, 147) + '…'
              : cluster.anchor.description}
          </p>
        )}
      </div>

      {/* Learn more action button */}
      <div
        style={{
          padding: '10px 16px',
          borderBottom: '1px solid var(--border-subtle)',
          flexShrink: 0,
        }}
      >
        <button
          type="button"
          onClick={handleLearnMore}
          className="flex items-center justify-center gap-1.5 w-full font-body cursor-pointer"
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: 'var(--color-accent-500)',
            background: 'var(--color-accent-50)',
            border: '1px solid rgba(214,58,0,0.15)',
            borderRadius: 8,
            padding: '8px 0',
            transition: 'background 0.12s ease',
          }}
        >
          <Sparkles size={13} />
          Learn how this connects to other anchors
        </button>
      </div>

      {/* Summary stats */}
      <div
        style={{
          padding: '10px 16px',
          borderBottom: '1px solid var(--border-subtle)',
          display: 'flex',
          gap: 12,
          flexShrink: 0,
        }}
      >
        <StatBlock label="Connected anchors" value={connections.length} />
        <StatBlock label="Cross-edges" value={totalConnections} />
        <StatBlock label="Shared entities" value={totalSharedEntities} />
      </div>

      {/* Strongest connection callout */}
      {strongestConnection && (
        <div
          style={{
            padding: '10px 16px',
            borderBottom: '1px solid var(--border-subtle)',
            background: 'var(--color-accent-50)',
            flexShrink: 0,
          }}
        >
          <div className="flex items-center gap-1.5" style={{ marginBottom: 3 }}>
            <Network size={10} style={{ color: 'var(--color-accent-500)' }} />
            <span className="font-body" style={{ fontSize: 9, fontWeight: 600, color: 'var(--color-accent-500)', letterSpacing: '0.04em', textTransform: 'uppercase' }}>
              Strongest connection
            </span>
          </div>
          <div className="flex items-center gap-2">
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: getEntityColor(strongestConnection.targetCluster.anchor.entityType),
                flexShrink: 0,
              }}
            />
            <span className="font-display" style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text-primary)' }}>
              {strongestConnection.targetCluster.anchor.label}
            </span>
            <span className="font-body" style={{ fontSize: 9, color: 'var(--color-text-secondary)', marginLeft: 'auto' }}>
              {strongestConnection.edge.sharedEntityCount} shared · {strongestConnection.edge.crossEdgeCount} edges
            </span>
          </div>
        </div>
      )}

      {/* Section title */}
      <div
        style={{
          padding: '10px 16px 6px',
          flexShrink: 0,
        }}
      >
        <span
          className="font-display"
          style={{
            fontSize: 9,
            fontWeight: 700,
            color: 'var(--color-text-secondary)',
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
          }}
        >
          Top connections ({Math.min(connections.length, showAll ? connections.length : DEFAULT_VISIBLE)} of {connections.length})
        </span>
      </div>

      {/* Connection list — scrollable */}
      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '0 16px 16px',
        }}
      >
        {connections.length === 0 ? (
          <div className="flex flex-col items-center justify-center" style={{ padding: '24px 0', textAlign: 'center' }}>
            <Network size={20} style={{ color: 'var(--color-text-placeholder)', marginBottom: 8 }} />
            <span className="font-body" style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>
              No cross-cluster connections yet
            </span>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {visibleConnections.map(conn => (
              <ConnectionItem
                key={conn.targetCluster.anchor.id}
                conn={conn}
                isExpanded={expandedId === conn.targetCluster.anchor.id}
                onToggle={() => setExpandedId(
                  expandedId === conn.targetCluster.anchor.id ? null : conn.targetCluster.anchor.id
                )}
                onNavigate={() => onNavigateToCluster(conn.targetCluster.anchor.id)}
              />
            ))}

            {/* Show all / Show less toggle */}
            {hasMore && (
              <button
                type="button"
                onClick={() => setShowAll(!showAll)}
                className="font-body cursor-pointer"
                style={{
                  fontSize: 10,
                  fontWeight: 600,
                  color: 'var(--color-accent-500)',
                  background: 'none',
                  border: 'none',
                  padding: '6px 0',
                  textAlign: 'center',
                }}
              >
                {showAll ? 'Show top 5' : `Show all ${connections.length} connections`}
              </button>
            )}
          </div>
        )}
      </div>

      {/* Entity type composition footer */}
      <div
        style={{
          padding: '10px 16px',
          borderTop: '1px solid var(--border-subtle)',
          flexShrink: 0,
        }}
      >
        <span
          className="font-display"
          style={{
            fontSize: 8,
            fontWeight: 700,
            color: 'var(--color-text-secondary)',
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
            display: 'block',
            marginBottom: 6,
          }}
        >
          Entity composition
        </span>
        <div style={{ display: 'flex', gap: 2, height: 4, borderRadius: 2, overflow: 'hidden' }}>
          {cluster.typeDistribution
            .filter(td => td.percentage > 0.02)
            .sort((a, b) => b.percentage - a.percentage)
            .map(td => (
              <div
                key={td.entityType}
                title={`${td.entityType}: ${td.count} (${Math.round(td.percentage * 100)}%)`}
                style={{
                  flex: td.percentage,
                  background: getEntityColor(td.entityType),
                  opacity: 0.7,
                  borderRadius: 1,
                }}
              />
            ))}
        </div>
        <div className="flex flex-wrap gap-x-3 gap-y-1" style={{ marginTop: 5 }}>
          {cluster.typeDistribution
            .filter(td => td.percentage > 0.02)
            .sort((a, b) => b.count - a.count)
            .slice(0, 6)
            .map(td => (
              <span key={td.entityType} className="flex items-center gap-1">
                <span style={{ width: 5, height: 5, borderRadius: '50%', background: getEntityColor(td.entityType) }} />
                <span className="font-body" style={{ fontSize: 8, color: 'var(--color-text-secondary)' }}>
                  {td.entityType} ({td.count})
                </span>
              </span>
            ))}
        </div>
      </div>
    </div>
  )
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function StatBlock({ label, value }: { label: string; value: number }) {
  return (
    <div style={{ flex: 1 }}>
      <div className="font-display" style={{ fontSize: 15, fontWeight: 700, color: 'var(--color-text-primary)' }}>
        {value.toLocaleString()}
      </div>
      <div className="font-body" style={{ fontSize: 8, color: 'var(--color-text-secondary)', marginTop: 1 }}>
        {label}
      </div>
    </div>
  )
}

function ConnectionItem({
  conn,
  isExpanded,
  onToggle,
  onNavigate,
}: {
  conn: ConnectionRow
  isExpanded: boolean
  onToggle: () => void
  onNavigate: () => void
}) {
  const { targetCluster, edge, relativeStrength, sharedTypes } = conn
  const color = getEntityColor(targetCluster.anchor.entityType)

  return (
    <div
      style={{
        borderRadius: 8,
        border: '1px solid var(--border-subtle)',
        overflow: 'hidden',
        transition: 'border-color 0.15s ease',
      }}
    >
      {/* Main row */}
      <button
        type="button"
        onClick={onToggle}
        className="flex items-center gap-2 w-full cursor-pointer"
        style={{
          padding: '8px 10px',
          background: isExpanded ? 'var(--color-accent-50)' : 'transparent',
          border: 'none',
          textAlign: 'left',
          transition: 'background 0.15s ease',
        }}
      >
        {isExpanded ? <ChevronDown size={10} style={{ color: 'var(--color-text-secondary)', flexShrink: 0 }} /> : <ChevronRight size={10} style={{ color: 'var(--color-text-secondary)', flexShrink: 0 }} />}

        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: `${color}22`,
            border: `1.5px solid ${color}`,
            flexShrink: 0,
          }}
        />

        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="font-body" style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {targetCluster.anchor.label}
          </div>
          <div className="font-body" style={{ fontSize: 8, color: 'var(--color-text-secondary)' }}>
            {targetCluster.anchor.entityType} · {targetCluster.entityCount} entities
          </div>
        </div>

        <div style={{ width: 40, flexShrink: 0 }}>
          <div style={{ height: 3, borderRadius: 2, background: 'var(--border-subtle)', overflow: 'hidden' }}>
            <div
              style={{
                width: `${Math.max(relativeStrength * 100, 8)}%`,
                height: '100%',
                background: color,
                opacity: 0.7,
                borderRadius: 2,
              }}
            />
          </div>
          <div className="font-body" style={{ fontSize: 7, color: 'var(--color-text-secondary)', textAlign: 'right', marginTop: 1 }}>
            {edge.sharedEntityCount} shared
          </div>
        </div>
      </button>

      {/* Expanded detail */}
      {isExpanded && (
        <div
          style={{
            padding: '6px 10px 10px 28px',
            borderTop: '1px solid var(--border-subtle)',
            background: 'rgba(255,255,255,0.5)',
          }}
        >
          <div className="flex items-center gap-3" style={{ marginBottom: 8 }}>
            <MetricPill label="Edges" value={edge.crossEdgeCount} />
            <MetricPill label="Shared" value={edge.sharedEntityCount} />
            <MetricPill label="Weight" value={Math.round(edge.totalWeight * 10) / 10} />
          </div>

          {sharedTypes.length > 0 && (
            <>
              <span className="font-body" style={{ fontSize: 8, fontWeight: 600, color: 'var(--color-text-secondary)', display: 'block', marginBottom: 4 }}>
                Overlapping entity types
              </span>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 3, marginBottom: 8 }}>
                {sharedTypes.slice(0, 5).map(st => {
                  const typeColor = getEntityColor(st.entityType)
                  return (
                    <div key={st.entityType} className="flex items-center gap-2">
                      <span style={{ width: 5, height: 5, borderRadius: '50%', background: typeColor, flexShrink: 0 }} />
                      <span className="font-body" style={{ fontSize: 9, color: 'var(--color-text-primary)', flex: 1 }}>
                        {st.entityType}
                      </span>
                      <span className="font-body" style={{ fontSize: 8, color: 'var(--color-text-secondary)' }}>
                        {st.sourceCount} ↔ {st.targetCount}
                      </span>
                    </div>
                  )
                })}
              </div>
            </>
          )}

          <button
            type="button"
            onClick={onNavigate}
            className="flex items-center gap-1.5 font-body cursor-pointer"
            style={{
              fontSize: 10,
              fontWeight: 600,
              color: 'var(--color-accent-500)',
              background: 'none',
              border: 'none',
              padding: 0,
            }}
          >
            Explore cluster <ArrowRight size={10} />
          </button>
        </div>
      )}
    </div>
  )
}

function MetricPill({ label, value }: { label: string; value: number }) {
  return (
    <span
      className="font-body"
      style={{
        fontSize: 9,
        fontWeight: 500,
        color: 'var(--color-text-secondary)',
        background: 'var(--color-bg-content)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 4,
        padding: '1px 6px',
      }}
    >
      <strong style={{ fontWeight: 700, color: 'var(--color-text-primary)' }}>{value}</strong> {label}
    </span>
  )
}
