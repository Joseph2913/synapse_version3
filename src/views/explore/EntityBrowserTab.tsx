import { useState, useEffect } from 'react'
import { X, Sparkles, Loader2, Compass } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { EntityCard } from '../../components/explore/EntityCard'
import { EntityListRow } from '../../components/explore/EntityListRow'
import { LocalGraph } from '../../components/explore/LocalGraph'
import { TypeDistributionBar } from '../../components/explore/TypeDistributionBar'
import { getEntityColor } from '../../config/entityTypes'
import { getSourceConfig } from '../../config/sourceTypes'
import { fetchEntityNeighbors } from '../../services/exploreQueries'
import { useAuth } from '../../hooks/useAuth'
import { buildBrowseEntityExploreContext } from '../../config/chatEntryContexts'
import type { EntityBrowserState } from '../../hooks/useEntityBrowser'
import type { EntityNeighbor } from '../../services/exploreQueries'
// KnowledgeNode import removed — buildBrowseEntityExploreContext takes a lightweight param

interface EntityBrowserTabProps {
  browser: EntityBrowserState
}

// ─── Main EntityBrowserTab ────────────────────────────────────────────────────

export function EntityBrowserTab({ browser }: EntityBrowserTabProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {/* Type distribution bar */}
      <TypeDistributionBar
        distribution={browser.typeDistribution}
        total={browser.entities.length}
      />

      {/* Main content */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden', minHeight: 0 }}>
        {/* Entity grid / list */}
        <div style={{ flex: 1, overflow: 'auto', padding: '16px 20px', minWidth: 0 }}>
          <EntityGrid browser={browser} />
        </div>

        {/* Detail panel */}
        {browser.selectedEntity && (
          <EntityDetailPanel
            entity={browser.selectedEntity}
            onClose={() => browser.setSelectedEntityId(null)}
          />
        )}
      </div>
    </div>
  )
}

// ─── Entity Grid / List ───────────────────────────────────────────────────────

function EntityGrid({ browser }: { browser: EntityBrowserState }) {
  if (browser.loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 8 }}>
        <Loader2 size={16} style={{ animation: 'spin 1s linear infinite', color: 'var(--color-text-secondary)' }} />
        <span style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-secondary)' }}>
          Loading entities…
        </span>
      </div>
    )
  }

  if (browser.error) {
    return (
      <div style={{ textAlign: 'center', padding: 40 }}>
        <p style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-semantic-red-500)' }}>
          {browser.error}
        </p>
      </div>
    )
  }

  if (browser.totalCount === 0) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 12, textAlign: 'center' }}>
        <Compass size={32} style={{ color: 'var(--color-text-placeholder)' }} />
        <h3 style={{ fontFamily: 'var(--font-display)', fontSize: 15, fontWeight: 700, color: 'var(--color-text-primary)', margin: 0 }}>
          No entities yet
        </h3>
        <p style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-secondary)', maxWidth: 280, lineHeight: 1.5, margin: 0 }}>
          Ingest your first source to start building your knowledge graph.
        </p>
      </div>
    )
  }

  if (browser.entities.length === 0) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 10, textAlign: 'center' }}>
        <span style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-secondary)' }}>
          No entities match your filters.
        </span>
        <button type="button" onClick={browser.clearAllFilters}
          style={{ padding: '5px 12px', borderRadius: 8, fontSize: 12, border: '1px solid var(--border-subtle)', background: 'none', color: 'var(--color-text-body)', cursor: 'pointer', fontFamily: 'var(--font-body)' }}
        >
          Clear filters
        </button>
      </div>
    )
  }

  if (browser.viewMode === 'list') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {browser.entities.map((entity, i) => (
          <EntityListRow
            key={entity.id}
            entity={entity}
            isSelected={entity.id === browser.selectedEntityId}
            onSelect={() => browser.setSelectedEntityId(entity.id === browser.selectedEntityId ? null : entity.id)}
            animationDelay={Math.min(i * 0.02, 0.15)}
          />
        ))}
      </div>
    )
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 8 }}>
      {browser.entities.map((entity, i) => (
        <EntityCard
          key={entity.id}
          entity={entity}
          isSelected={entity.id === browser.selectedEntityId}
          onSelect={() => browser.setSelectedEntityId(entity.id === browser.selectedEntityId ? null : entity.id)}
          animationDelay={Math.min(i * 0.03, 0.2)}
        />
      ))}
    </div>
  )
}

// ─── Entity Detail Panel ──────────────────────────────────────────────────────

function EntityDetailPanel({
  entity,
  onClose,
}: {
  entity: NonNullable<EntityBrowserState['selectedEntity']>
  onClose: () => void
}) {
  const { user } = useAuth()
  const navigate = useNavigate()
  const [neighbors, setNeighbors] = useState<EntityNeighbor[]>([])
  const color = getEntityColor(entity.entityType)

  useEffect(() => {
    if (!user) return
    let cancelled = false
    fetchEntityNeighbors(user.id, entity.id)
      .then(data => { if (!cancelled) setNeighbors(data) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [entity.id, user])

  const sourceConfig = entity.sourceType ? getSourceConfig(entity.sourceType) : null

  return (
    <div style={{
      width: 300, flexShrink: 0,
      borderLeft: '1px solid var(--border-subtle)',
      overflow: 'auto', background: 'var(--color-bg-card)',
      display: 'flex', flexDirection: 'column',
    }}>
      {/* Header */}
      <div style={{ padding: '16px 18px 12px', borderBottom: '1px solid var(--border-subtle)' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8, marginBottom: 6 }}>
          <h2 style={{ fontFamily: 'var(--font-display)', fontSize: 16, fontWeight: 800, color: 'var(--color-text-primary)', letterSpacing: '-0.02em', lineHeight: 1.3, margin: 0 }}>
            {entity.label}
          </h2>
          <button type="button" onClick={onClose}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-text-placeholder)', padding: 4, flexShrink: 0 }}>
            <X size={14} />
          </button>
        </div>
        <span style={{ display: 'inline-flex', alignItems: 'center', padding: '2px 8px', borderRadius: 4, fontFamily: 'var(--font-body)', fontSize: 10, fontWeight: 600, background: color + '10', border: `1px solid ${color}28`, color }}>
          {entity.entityType}
        </span>
        {entity.description && (
          <p style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-body)', lineHeight: 1.55, marginTop: 10, marginBottom: 0 }}>
            {entity.description}
          </p>
        )}
      </div>

      {/* Stats */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, padding: '12px 18px', borderBottom: '1px solid var(--border-subtle)' }}>
        <StatCard label="Connections" value={String(entity.connectionCount)} />
        <StatCard label="Confidence" value={entity.confidence != null ? `${Math.round(entity.confidence * 100)}%` : '—'} />
      </div>

      {/* Local graph */}
      <div style={{ padding: '12px 18px', borderBottom: '1px solid var(--border-subtle)' }}>
        <SectionLabel>Graph</SectionLabel>
        <div style={{ borderRadius: 8, overflow: 'hidden', background: 'var(--color-bg-inset)', marginTop: 8 }}>
          <LocalGraph entity={entity} neighbors={neighbors} width={264} height={180} />
        </div>
      </div>

      {/* Connections list */}
      {neighbors.length > 0 && (
        <div style={{ padding: '12px 18px', borderBottom: '1px solid var(--border-subtle)' }}>
          <SectionLabel>Connections ({neighbors.length})</SectionLabel>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginTop: 8 }}>
            {neighbors.map(n => <ConnectionRow key={n.node.id} neighbor={n} />)}
          </div>
        </div>
      )}

      {/* Source */}
      {(entity.sourceName || entity.sourceType) && (
        <div style={{ padding: '12px 18px', borderBottom: '1px solid var(--border-subtle)' }}>
          <SectionLabel>Source</SectionLabel>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, padding: '8px 10px', borderRadius: 8, background: 'var(--color-bg-inset)' }}>
            {sourceConfig && (
              <span style={{ width: 28, height: 28, borderRadius: 6, background: sourceConfig.color + '20', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, flexShrink: 0 }}>
                {sourceConfig.icon}
              </span>
            )}
            <div style={{ minWidth: 0 }}>
              <div style={{ fontFamily: 'var(--font-body)', fontSize: 12, fontWeight: 500, color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {entity.sourceName ?? entity.sourceType}
              </div>
              <div style={{ fontFamily: 'var(--font-body)', fontSize: 10, color: 'var(--color-text-secondary)' }}>
                {entity.sourceType} · {new Date(entity.createdAt).toLocaleDateString()}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Tags */}
      {entity.tags.length > 0 && (
        <div style={{ padding: '12px 18px', borderBottom: '1px solid var(--border-subtle)' }}>
          <SectionLabel>Tags</SectionLabel>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 8 }}>
            {entity.tags.map(tag => (
              <span key={tag} style={{ padding: '2px 8px', borderRadius: 4, background: 'var(--color-bg-inset)', border: '1px solid var(--border-subtle)', fontFamily: 'var(--font-body)', fontSize: 10, color: 'var(--color-text-secondary)' }}>
                #{tag}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Actions */}
      <div style={{ padding: '12px 18px' }}>
        <button type="button"
          onClick={() => {
            navigate('/ask', { state: { chatContext: buildBrowseEntityExploreContext({
              id: entity.id, label: entity.label, entity_type: entity.entityType, source_id: entity.sourceId,
            }) } })
          }}
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
            width: '100%', padding: '8px 12px', borderRadius: 8,
            background: 'var(--color-accent-50)', border: '1px solid rgba(214,58,0,0.15)',
            color: 'var(--color-accent-600)', fontFamily: 'var(--font-body)',
            fontSize: 12, fontWeight: 600, cursor: 'pointer',
          }}
        >
          <Sparkles size={13} />
          Explore with AI
        </button>
      </div>
    </div>
  )
}

// ─── Small helpers ────────────────────────────────────────────────────────────

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ padding: '8px 10px', borderRadius: 8, background: 'var(--color-bg-inset)', border: '1px solid var(--border-subtle)' }}>
      <div style={{ fontFamily: 'var(--font-display)', fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--color-text-secondary)', marginBottom: 2 }}>
        {label}
      </div>
      <div style={{ fontFamily: 'var(--font-display)', fontSize: 20, fontWeight: 800, letterSpacing: '-0.03em', color: 'var(--color-text-primary)' }}>
        {value}
      </div>
    </div>
  )
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontFamily: 'var(--font-display)', fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--color-text-secondary)' }}>
      {children}
    </div>
  )
}

function ConnectionRow({ neighbor }: { neighbor: EntityNeighbor }) {
  const color = getEntityColor(neighbor.node.entityType)
  return (
    <div
      style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '5px 8px', borderRadius: 6, border: '1px solid transparent', cursor: 'default', transition: 'background 0.1s ease, border-color 0.1s ease' }}
      onMouseEnter={e => { const el = e.currentTarget as HTMLDivElement; el.style.background = 'var(--color-bg-hover)'; el.style.borderColor = 'var(--border-subtle)' }}
      onMouseLeave={e => { const el = e.currentTarget as HTMLDivElement; el.style.background = 'transparent'; el.style.borderColor = 'transparent' }}
    >
      <span style={{ width: 7, height: 7, borderRadius: '50%', background: color, flexShrink: 0 }} />
      <span style={{ flex: 1, fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {neighbor.node.label}
      </span>
      {neighbor.relationType && (
        <span style={{ padding: '1px 5px', borderRadius: 3, background: 'var(--color-bg-inset)', fontFamily: 'var(--font-body)', fontSize: 9, color: 'var(--color-text-secondary)', flexShrink: 0, maxWidth: 80, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {neighbor.relationType}
        </span>
      )}
    </div>
  )
}
