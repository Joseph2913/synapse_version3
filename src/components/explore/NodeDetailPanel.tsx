import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { Sparkles, Plus, Route, Pencil, Anchor, X, Check, ChevronRight } from 'lucide-react'
import { getEntityColor } from '../../config/entityTypes'
import { getSourceConfig } from '../../config/sourceTypes'
import { buildNodeDetailExploreContext } from '../../config/chatEntryContexts'
import { useAuth } from '../../hooks/useAuth'
import { fetchEntityNeighbors } from '../../services/exploreQueries'
import { updateNode, promoteToAnchor, demoteAnchor } from '../../services/supabase'
import type { EntityNode, ClusterData } from '../../types/explore'
import type { EntityNeighbor } from '../../services/exploreQueries'
import type { KnowledgeNode } from '../../types/database'

interface NodeDetailPanelProps {
  entity: EntityNode
  clusters: ClusterData[]
  onNavigateToEntity: (entityId: string) => void
  onClose: () => void
  onEntityUpdated: () => void
}

const HUB_THRESHOLD = 7

export function NodeDetailPanel({
  entity,
  clusters,
  onNavigateToEntity,
  onClose,
  onEntityUpdated,
}: NodeDetailPanelProps) {
  const { user } = useAuth()
  const navigate = useNavigate()
  const color = getEntityColor(entity.entityType)

  // Neighbors
  const [neighbors, setNeighbors] = useState<EntityNeighbor[]>([])
  const [showAllConnections, setShowAllConnections] = useState(false)

  // Edit mode
  const [editing, setEditing] = useState(false)
  const [editLabel, setEditLabel] = useState(entity.label)
  const [editDescription, setEditDescription] = useState(entity.description ?? '')
  const [editTags, setEditTags] = useState(entity.tags.join(', '))
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!user) return
    let cancelled = false
    fetchEntityNeighbors(user.id, entity.id)
      .then(data => { if (!cancelled) setNeighbors(data) })
      .catch(err => console.warn('fetchEntityNeighbors error:', err))
    return () => { cancelled = true }
  }, [user, entity.id])

  // Reset edit state when entity changes
  useEffect(() => {
    setEditing(false)
    setEditLabel(entity.label)
    setEditDescription(entity.description ?? '')
    setEditTags(entity.tags.join(', '))
    setShowAllConnections(false)
  }, [entity.id, entity.label, entity.description, entity.tags])

  const handleSave = useCallback(async () => {
    setSaving(true)
    try {
      const tagArray = editTags
        .split(',')
        .map(t => t.trim())
        .filter(Boolean)
      await updateNode(entity.id, {
        label: editLabel,
        description: editDescription || null,
        user_tags: tagArray.length > 0 ? tagArray : null,
      })
      setEditing(false)
      onEntityUpdated()
    } catch (err) {
      console.warn('Save error:', err)
    } finally {
      setSaving(false)
    }
  }, [entity.id, editLabel, editDescription, editTags, onEntityUpdated])

  const handleToggleAnchor = useCallback(async () => {
    try {
      // Simple heuristic: if entity has an anchor entityType, it's an anchor
      // Using clusters check for now
      const currentlyAnchor = entity.entityType === 'Anchor'
      if (currentlyAnchor) {
        await demoteAnchor(entity.id)
      } else {
        await promoteToAnchor(entity.id)
      }
      onEntityUpdated()
    } catch (err) {
      console.warn('Toggle anchor error:', err)
    }
  }, [entity.id, entity.entityType, onEntityUpdated])

  // Structural position
  const structuralPosition = getStructuralPosition(entity, clusters)

  // Visible connections
  const visibleConnections = showAllConnections ? neighbors : neighbors.slice(0, 6)

  return (
    <div
      className="flex flex-col h-full"
      style={{
        overflowY: 'auto',
        padding: 24,
      }}
    >
      {/* Close button */}
      <button
        type="button"
        onClick={onClose}
        className="cursor-pointer self-end"
        style={{
          background: 'none',
          border: 'none',
          padding: 4,
          color: 'var(--color-text-secondary)',
          marginBottom: 8,
        }}
      >
        <X size={16} />
      </button>

      {/* 1. Header */}
      <div className="flex items-center gap-2" style={{ marginBottom: 12 }}>
        <span
          style={{
            width: 12,
            height: 12,
            borderRadius: '50%',
            background: color,
            flexShrink: 0,
          }}
        />
        {editing ? (
          <input
            type="text"
            value={editLabel}
            onChange={e => setEditLabel(e.target.value)}
            className="font-display flex-1"
            style={{
              fontSize: 16,
              fontWeight: 700,
              color: 'var(--color-text-primary)',
              background: 'var(--color-bg-inset)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 6,
              padding: '2px 6px',
              outline: 'none',
            }}
          />
        ) : (
          <span
            style={{
              fontFamily: 'var(--font-display)',
              fontSize: 16,
              fontWeight: 700,
              color: 'var(--color-text-primary)',
              flex: 1,
            }}
          >
            {entity.label}
          </span>
        )}
      </div>

      {/* Entity type badge */}
      <span
        style={{
          fontFamily: 'var(--font-body)',
          fontSize: 10,
          fontWeight: 600,
          color,
          background: `${color}14`,
          padding: '3px 8px',
          borderRadius: 6,
          display: 'inline-block',
          marginBottom: 16,
          alignSelf: 'flex-start',
        }}
      >
        {entity.entityType}
      </span>

      {/* 2. Description */}
      {editing ? (
        <textarea
          value={editDescription}
          onChange={e => setEditDescription(e.target.value)}
          className="font-body"
          rows={3}
          style={{
            fontSize: 13,
            color: 'var(--color-text-body)',
            background: 'var(--color-bg-inset)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 8,
            padding: '8px 10px',
            outline: 'none',
            resize: 'vertical',
            lineHeight: 1.6,
            marginBottom: 16,
          }}
        />
      ) : entity.description ? (
        <p
          style={{
            fontFamily: 'var(--font-body)',
            fontSize: 13,
            color: 'var(--color-text-body)',
            lineHeight: 1.6,
            marginBottom: 16,
          }}
        >
          {entity.description}
        </p>
      ) : null}

      {/* 3. Stats */}
      <div
        className="flex gap-4"
        style={{ marginBottom: 20 }}
      >
        <StatBlock label="Connections" value={entity.connectionCount} />
        <StatBlock
          label="Confidence"
          value={entity.confidence != null ? `${Math.round(entity.confidence * 100)}%` : '—'}
          bar={entity.confidence}
        />
        <StatBlock label="Clusters" value={entity.clusters.length} />
      </div>

      {/* 4. Structural Position */}
      <SectionLabel>STRUCTURAL POSITION</SectionLabel>
      <div
        style={{
          background: 'var(--color-bg-inset)',
          borderRadius: 8,
          padding: '10px 12px',
          marginBottom: 20,
        }}
      >
        <p
          style={{
            fontFamily: 'var(--font-body)',
            fontSize: 12,
            color: 'var(--color-text-body)',
            lineHeight: 1.5,
          }}
          dangerouslySetInnerHTML={{ __html: structuralPosition }}
        />
      </div>

      {/* 5. Source */}
      {entity.sourceType && (
        <>
          <SectionLabel>SOURCE</SectionLabel>
          <SourceCard
            sourceName={entity.sourceName}
            sourceType={entity.sourceType}
            createdAt={entity.createdAt}
          />
        </>
      )}

      {/* 6. Connections */}
      <SectionLabel>CONNECTIONS ({neighbors.length})</SectionLabel>
      <div className="flex flex-col gap-1" style={{ marginBottom: 16 }}>
        {visibleConnections.map(n => (
          <button
            key={n.node.id}
            type="button"
            onClick={() => onNavigateToEntity(n.node.id)}
            className="flex items-center gap-2 w-full cursor-pointer font-body"
            style={{
              padding: '6px 8px',
              fontSize: 11,
              color: 'var(--color-text-body)',
              background: 'none',
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
                background: getEntityColor(n.node.entityType),
                flexShrink: 0,
              }}
            />
            <span className="flex-1" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {n.node.label}
            </span>
            {n.relationType && (
              <span
                style={{
                  fontSize: 9,
                  fontWeight: 500,
                  color: 'var(--color-text-secondary)',
                  background: 'var(--color-bg-inset)',
                  padding: '1px 5px',
                  borderRadius: 4,
                  flexShrink: 0,
                }}
              >
                {n.relationType}
              </span>
            )}
            <ChevronRight size={10} style={{ color: 'var(--color-text-placeholder)', flexShrink: 0 }} />
          </button>
        ))}
        {neighbors.length > 6 && !showAllConnections && (
          <button
            type="button"
            onClick={() => setShowAllConnections(true)}
            className="font-body cursor-pointer"
            style={{
              fontSize: 11,
              fontWeight: 500,
              color: 'var(--color-accent-500)',
              background: 'none',
              border: 'none',
              padding: '4px 8px',
              textAlign: 'left',
            }}
          >
            Show all {neighbors.length} →
          </button>
        )}
      </div>

      {/* 7. Tags */}
      {(entity.tags.length > 0 || editing) && (
        <>
          <SectionLabel>TAGS</SectionLabel>
          {editing ? (
            <input
              type="text"
              value={editTags}
              onChange={e => setEditTags(e.target.value)}
              placeholder="tag1, tag2, tag3"
              className="font-body"
              style={{
                fontSize: 11,
                color: 'var(--color-text-body)',
                background: 'var(--color-bg-inset)',
                border: '1px solid var(--border-subtle)',
                borderRadius: 6,
                padding: '6px 10px',
                outline: 'none',
                marginBottom: 16,
              }}
            />
          ) : (
            <div className="flex flex-wrap gap-1.5" style={{ marginBottom: 16 }}>
              {entity.tags.map(tag => (
                <span
                  key={tag}
                  style={{
                    fontFamily: 'var(--font-body)',
                    fontSize: 10,
                    fontWeight: 500,
                    color: 'var(--color-text-body)',
                    background: 'var(--color-bg-inset)',
                    border: '1px solid var(--border-subtle)',
                    borderRadius: 6,
                    padding: '2px 8px',
                  }}
                >
                  #{tag}
                </span>
              ))}
            </div>
          )}
        </>
      )}

      {/* 8. Actions */}
      <SectionLabel>ACTIONS</SectionLabel>
      <div className="flex flex-col gap-2">
        {/* Primary: Explore with AI */}
        <ActionButton
          icon={<Sparkles size={13} />}
          label="Explore with AI"
          primary
          onClick={() => {
            const node = { id: entity.id, label: entity.label, entity_type: entity.entityType, user_id: '', is_anchor: entity.entityType === 'Anchor', created_at: entity.createdAt } as KnowledgeNode
            navigate('/ask', { state: { chatContext: buildNodeDetailExploreContext(node) } })
          }}
        />

        {/* Edit / Save */}
        {editing ? (
          <div className="flex gap-2">
            <ActionButton
              icon={<Check size={13} />}
              label={saving ? 'Saving…' : 'Save'}
              onClick={handleSave}
            />
            <ActionButton
              icon={<X size={13} />}
              label="Cancel"
              onClick={() => {
                setEditing(false)
                setEditLabel(entity.label)
                setEditDescription(entity.description ?? '')
                setEditTags(entity.tags.join(', '))
              }}
            />
          </div>
        ) : (
          <>
            <ActionButton
              icon={<Plus size={13} />}
              label="Add to context basket"
              onClick={() => { /* PRD 4E */ }}
            />
            <ActionButton
              icon={<Route size={13} />}
              label="Find paths from here"
              onClick={() => { /* PRD 4E */ }}
            />
            <ActionButton
              icon={<Pencil size={13} />}
              label="Edit entity"
              onClick={() => setEditing(true)}
            />
            <ActionButton
              icon={<Anchor size={13} />}
              label={entity.entityType === 'Anchor' ? 'Demote anchor' : 'Promote to anchor'}
              onClick={handleToggleAnchor}
            />
          </>
        )}
      </div>
    </div>
  )
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <span
      style={{
        fontFamily: 'var(--font-display)',
        fontSize: 10,
        fontWeight: 700,
        color: 'var(--color-text-secondary)',
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
        marginBottom: 8,
        display: 'block',
      }}
    >
      {children}
    </span>
  )
}

function StatBlock({
  label,
  value,
  bar,
}: {
  label: string
  value: number | string
  bar?: number | null
}) {
  return (
    <div className="flex flex-col flex-1">
      <span
        style={{
          fontFamily: 'var(--font-display)',
          fontSize: 20,
          fontWeight: 800,
          color: 'var(--color-text-primary)',
        }}
      >
        {value}
      </span>
      <span
        style={{
          fontFamily: 'var(--font-body)',
          fontSize: 10,
          color: 'var(--color-text-secondary)',
        }}
      >
        {label}
      </span>
      {bar != null && (
        <div
          style={{
            width: '100%',
            height: 4,
            borderRadius: 2,
            background: 'var(--color-bg-inset)',
            marginTop: 4,
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              width: `${bar * 100}%`,
              height: '100%',
              borderRadius: 2,
              background: 'var(--color-accent-500)',
            }}
          />
        </div>
      )}
    </div>
  )
}

function SourceCard({
  sourceName,
  sourceType,
  createdAt,
}: {
  sourceName: string | null
  sourceType: string
  createdAt: string
}) {
  const cfg = getSourceConfig(sourceType)
  const date = new Date(createdAt).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })

  return (
    <div
      className="flex items-center gap-3"
      style={{
        background: 'var(--color-bg-inset)',
        borderRadius: 8,
        padding: '10px 12px',
        marginBottom: 20,
      }}
    >
      <span
        style={{
          width: 28,
          height: 28,
          borderRadius: 6,
          background: `${cfg.color}14`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 14,
          flexShrink: 0,
        }}
      >
        {cfg.icon}
      </span>
      <div className="flex flex-col flex-1 overflow-hidden">
        <span
          style={{
            fontFamily: 'var(--font-body)',
            fontSize: 12,
            fontWeight: 500,
            color: 'var(--color-text-primary)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {sourceName ?? 'Unknown source'}
        </span>
        <span
          style={{
            fontFamily: 'var(--font-body)',
            fontSize: 10,
            color: 'var(--color-text-secondary)',
          }}
        >
          {sourceType} · {date}
        </span>
      </div>
    </div>
  )
}

function ActionButton({
  icon,
  label,
  primary,
  onClick,
}: {
  icon: React.ReactNode
  label: string
  primary?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-2 w-full cursor-pointer font-body"
      style={{
        padding: '8px 12px',
        fontSize: 12,
        fontWeight: 500,
        borderRadius: 8,
        border: 'none',
        background: primary ? 'var(--color-accent-50)' : 'var(--color-bg-inset)',
        color: primary ? 'var(--color-accent-500)' : 'var(--color-text-body)',
        textAlign: 'left',
        transition: 'background 0.1s ease',
      }}
    >
      {icon}
      {label}
    </button>
  )
}

// ─── Structural Position Logic ────────────────────────────────────────────────

function getStructuralPosition(entity: EntityNode, clusters: ClusterData[]): string {
  const clusterLabels = entity.clusters
    .map(cid => clusters.find(c => c.anchor.id === cid)?.anchor.label)
    .filter(Boolean)

  if (entity.isUnclustered) {
    return '<strong>Unclustered.</strong> Not connected to any anchor. Consider linking or ingesting related content.'
  }

  if (entity.isBridge && clusterLabels.length >= 2) {
    return `<strong>Bridge node</strong> connecting ${clusterLabels.slice(0, 2).map(l => `<strong>${l}</strong>`).join(' and ')}. High cross-cluster value — links separate domains.`
  }

  if (entity.connectionCount >= HUB_THRESHOLD) {
    const clusterName = clusterLabels[0] ?? 'this cluster'
    return `<strong>Hub node</strong> in ${clusterName}. Central to this knowledge domain with ${entity.connectionCount} connections.`
  }

  if (entity.connectionCount >= 4) {
    const clusterName = clusterLabels[0] ?? 'this cluster'
    const crossCount = entity.clusters.length > 1 ? entity.clusters.length - 1 : 0
    return `Connected node in <strong>${clusterName}</strong>. ${crossCount} cross-cluster connection${crossCount !== 1 ? 's' : ''}.`
  }

  const clusterName = clusterLabels[0] ?? 'this cluster'
  return `Peripheral in <strong>${clusterName}</strong>. May benefit from enrichment.`
}
