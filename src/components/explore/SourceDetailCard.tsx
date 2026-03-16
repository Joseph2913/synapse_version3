import { useState, useEffect, useRef, useCallback } from 'react'
import { X, ChevronRight, ChevronDown, ArrowRight, Link2, Loader2 } from 'lucide-react'
import { getSourceConfig } from '../../config/sourceTypes'
import { getEntityColor } from '../../config/entityTypes'
import { stripMarkdown } from '../../utils/stripMarkdown'
import { useAuth } from '../../hooks/useAuth'
import { fetchSourceCardDetail } from '../../services/exploreQueries'
import type { SourceCardDetail, SourceCardRelatedSource } from '../../services/exploreQueries'

interface SourceDetailCardProps {
  sourceId: string
  onClose: () => void
  onNavigateToSource: (sourceId: string) => void
}

const PANEL_WIDTH = 370

function formatRelativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime()
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  const weeks = Math.floor(days / 7)
  if (weeks < 4) return `${weeks}w ago`
  return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

export function SourceDetailCard({
  sourceId,
  onClose,
  onNavigateToSource,
}: SourceDetailCardProps) {
  const { user } = useAuth()
  const [detail, setDetail] = useState<SourceCardDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!user) return
    let cancelled = false
    setLoading(true)
    fetchSourceCardDetail(user.id, sourceId)
      .then(data => { if (!cancelled) setDetail(data) })
      .catch(err => console.warn('SourceDetailCard fetch error:', err))
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [user, sourceId])

  // Prevent wheel events on the panel from propagating to the graph (which zooms)
  const handleWheel = useCallback((e: WheelEvent) => {
    e.stopPropagation()
  }, [])

  useEffect(() => {
    const el = panelRef.current
    if (!el) return
    el.addEventListener('wheel', handleWheel, { passive: false })
    return () => el.removeEventListener('wheel', handleWheel)
  }, [handleWheel])

  return (
    <div
      ref={panelRef}
      style={{
        position: 'absolute',
        top: 0,
        right: 0,
        bottom: 0,
        width: PANEL_WIDTH,
        background: 'rgba(255,255,255,0.97)',
        backdropFilter: 'blur(20px)',
        borderLeft: '1px solid var(--border-subtle)',
        boxShadow: '-4px 0 24px rgba(0,0,0,0.06)',
        zIndex: 40,
        display: 'flex',
        flexDirection: 'column',
        animation: 'slideInRight 0.2s ease',
      }}
      onClick={e => e.stopPropagation()}
    >
      {/* Close button */}
      <div className="flex items-center justify-end" style={{ padding: '10px 12px 0' }}>
        <button
          type="button"
          onClick={onClose}
          className="cursor-pointer flex items-center justify-center"
          style={{
            width: 26,
            height: 26,
            borderRadius: 6,
            background: 'var(--color-bg-inset)',
            border: '1px solid var(--border-subtle)',
            color: 'var(--color-text-secondary)',
            transition: 'background 0.12s ease',
          }}
          onMouseEnter={e => { ;(e.currentTarget as HTMLButtonElement).style.background = 'var(--color-bg-card)' }}
          onMouseLeave={e => { ;(e.currentTarget as HTMLButtonElement).style.background = 'var(--color-bg-inset)' }}
        >
          <X size={14} />
        </button>
      </div>

      {/* Scrollable content */}
      <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden' }}>
        {loading ? (
          <div className="flex items-center justify-center" style={{ padding: 60 }}>
            <Loader2 size={20} style={{ color: 'var(--color-text-secondary)', animation: 'spin 1s linear infinite' }} />
          </div>
        ) : !detail ? (
          <div className="flex items-center justify-center" style={{ padding: 60 }}>
            <span className="font-body" style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
              Source not found
            </span>
          </div>
        ) : (
          <CardContent detail={detail} onNavigateToSource={onNavigateToSource} />
        )}
      </div>

      <style>{`
        @keyframes slideInRight {
          from { transform: translateX(100%); opacity: 0; }
          to   { transform: translateX(0);    opacity: 1; }
        }
      `}</style>
    </div>
  )
}

// ─── Card Content ─────────────────────────────────────────────────────────────

function CardContent({
  detail,
  onNavigateToSource,
}: {
  detail: SourceCardDetail
  onNavigateToSource: (sourceId: string) => void
}) {
  const cfg = getSourceConfig(detail.sourceType)
  const [showAllEntities, setShowAllEntities] = useState(false)
  const [showAllConnections, setShowAllConnections] = useState(false)

  const visibleEntities = showAllEntities ? detail.entities : detail.entities.slice(0, 12)
  const visibleConnections = showAllConnections ? detail.connections : detail.connections.slice(0, 6)

  return (
    <div style={{ padding: '8px 16px 20px' }}>
      {/* ── Header ── */}
      <div className="flex items-center gap-3" style={{ marginBottom: 10 }}>
        <span
          style={{
            width: 34,
            height: 34,
            borderRadius: 8,
            background: `${cfg.color}14`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 16,
            flexShrink: 0,
          }}
        >
          {cfg.icon}
        </span>
        <div className="min-w-0 flex-1">
          <p
            className="font-display font-bold text-text-primary"
            style={{ fontSize: 15, lineHeight: 1.3 }}
          >
            {detail.title}
          </p>
          <p className="font-body" style={{ fontSize: 11, color: 'var(--color-text-secondary)', marginTop: 2 }}>
            <span
              style={{
                fontWeight: 600,
                padding: '1px 5px',
                borderRadius: 3,
                color: cfg.color,
                background: `${cfg.color}10`,
                border: `1px solid ${cfg.color}20`,
                marginRight: 6,
              }}
            >
              {detail.sourceType}
            </span>
            {formatRelativeTime(detail.createdAt)}
          </p>
        </div>
      </div>

      {/* ── Summary ── */}
      {detail.summary && (
        <p
          className="font-body"
          style={{
            fontSize: 12,
            color: 'var(--color-text-body)',
            lineHeight: 1.6,
            marginBottom: 14,
          }}
        >
          {stripMarkdown(detail.summary)}
        </p>
      )}

      {/* ── Anchor chips ── */}
      {detail.anchorLabels.length > 0 && (
        <div className="flex items-center flex-wrap" style={{ gap: '4px 6px', marginBottom: 12 }}>
          <span
            className="font-display font-bold uppercase"
            style={{ fontSize: 9, letterSpacing: '0.07em', color: '#b45309', flexShrink: 0 }}
          >
            Anchors
          </span>
          {detail.anchorLabels.map(label => (
            <span
              key={label}
              className="font-body font-semibold"
              style={{
                fontSize: 10,
                padding: '2px 8px',
                borderRadius: 12,
                border: '1px solid rgba(180,83,9,0.25)',
                background: 'rgba(180,83,9,0.07)',
                color: '#b45309',
                whiteSpace: 'nowrap',
              }}
            >
              {label}
            </span>
          ))}
        </div>
      )}

      {/* ── Entities ── */}
      {detail.entities.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          <SectionLabel>
            Entities ({detail.entities.length})
          </SectionLabel>
          <div className="flex flex-wrap" style={{ gap: 5 }}>
            {visibleEntities.map(e => (
              <span
                key={e.id}
                className="inline-flex items-center gap-1 font-body"
                style={{
                  fontSize: 10,
                  fontWeight: 500,
                  padding: '3px 7px',
                  borderRadius: 5,
                  background: `${getEntityColor(e.entityType)}10`,
                  color: getEntityColor(e.entityType),
                  border: `1px solid ${getEntityColor(e.entityType)}20`,
                }}
              >
                <span
                  style={{
                    width: 5,
                    height: 5,
                    borderRadius: '50%',
                    background: getEntityColor(e.entityType),
                    flexShrink: 0,
                  }}
                />
                {e.label}
              </span>
            ))}
          </div>
          {detail.entities.length > 12 && !showAllEntities && (
            <button
              type="button"
              onClick={() => setShowAllEntities(true)}
              className="font-body cursor-pointer"
              style={{
                fontSize: 10,
                fontWeight: 600,
                color: 'var(--color-accent-500)',
                background: 'none',
                border: 'none',
                padding: '3px 0',
                marginTop: 4,
              }}
            >
              +{detail.entities.length - 12} more
            </button>
          )}
        </div>
      )}

      {/* ── Connections (within-source + anchor) ── */}
      {detail.connections.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          <SectionLabel>
            Connections ({detail.connections.length})
          </SectionLabel>
          <div className="flex flex-col" style={{ gap: 4 }}>
            {visibleConnections.map(c => (
              <ConnectionRow key={c.id} from={c.fromLabel} fromType={c.fromEntityType} to={c.toLabel} toType={c.toEntityType} relation={c.relationType} />
            ))}
          </div>
          {detail.connections.length > 6 && !showAllConnections && (
            <button
              type="button"
              onClick={() => setShowAllConnections(true)}
              className="font-body cursor-pointer"
              style={{
                fontSize: 10,
                fontWeight: 600,
                color: 'var(--color-accent-500)',
                background: 'none',
                border: 'none',
                padding: '3px 0',
                marginTop: 4,
              }}
            >
              +{detail.connections.length - 6} more
            </button>
          )}
        </div>
      )}

      {/* ── Related Sources ── */}
      {detail.relatedSources.length > 0 && (
        <div>
          <SectionLabel>
            Related Sources ({detail.relatedSources.length})
          </SectionLabel>
          <div className="flex flex-col" style={{ gap: 2 }}>
            {detail.relatedSources.map(rs => (
              <RelatedSourceRow
                key={rs.sourceId}
                rs={rs}
                onNavigate={() => onNavigateToSource(rs.sourceId)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Related Source Row (expandable) ──────────────────────────────────────────

function RelatedSourceRow({
  rs,
  onNavigate,
}: {
  rs: SourceCardRelatedSource
  onNavigate: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const rsCfg = getSourceConfig(rs.sourceType)
  const hasConnections = rs.crossConnections.length > 0

  return (
    <div style={{ borderRadius: 6, overflow: 'hidden' }}>
      {/* Main row */}
      <div
        className="flex items-center gap-2 font-body"
        style={{
          padding: '6px 8px',
          fontSize: 11,
          background: expanded ? 'var(--color-bg-inset)' : 'none',
          borderRadius: expanded ? '6px 6px 0 0' : 6,
          transition: 'background 0.12s ease',
        }}
      >
        {/* Expand toggle */}
        {hasConnections && (
          <button
            type="button"
            onClick={() => setExpanded(!expanded)}
            className="cursor-pointer flex items-center justify-center"
            style={{
              width: 18,
              height: 18,
              borderRadius: 4,
              background: 'none',
              border: 'none',
              color: 'var(--color-text-secondary)',
              flexShrink: 0,
              padding: 0,
              transition: 'color 0.1s ease',
            }}
          >
            {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </button>
        )}
        {!hasConnections && <span style={{ width: 18, flexShrink: 0 }} />}

        {/* Source icon + title */}
        <span
          style={{
            width: 20,
            height: 20,
            borderRadius: 5,
            background: `${rsCfg.color}14`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 10,
            flexShrink: 0,
          }}
        >
          {rsCfg.icon}
        </span>
        <span
          className="flex-1"
          style={{
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            fontWeight: 500,
            color: 'var(--color-text-body)',
          }}
        >
          {rs.title}
        </span>

        {/* Shared count */}
        <span
          style={{
            fontSize: 9,
            fontWeight: 600,
            color: 'var(--color-text-secondary)',
            background: expanded ? 'rgba(255,255,255,0.7)' : 'var(--color-bg-inset)',
            padding: '2px 6px',
            borderRadius: 4,
            flexShrink: 0,
          }}
        >
          {rs.sharedEntityCount} shared
        </span>

        {/* Navigate button */}
        <button
          type="button"
          onClick={onNavigate}
          className="cursor-pointer flex items-center justify-center"
          title="Go to source"
          style={{
            width: 20,
            height: 20,
            borderRadius: 4,
            background: 'none',
            border: 'none',
            color: 'var(--color-accent-500)',
            flexShrink: 0,
            padding: 0,
          }}
        >
          <ArrowRight size={12} />
        </button>
      </div>

      {/* Expanded: cross-source connections */}
      {expanded && hasConnections && (
        <div
          style={{
            padding: '4px 8px 8px 46px',
            background: 'var(--color-bg-inset)',
            borderRadius: '0 0 6px 6px',
          }}
        >
          <div className="flex flex-col" style={{ gap: 3 }}>
            {rs.crossConnections.map(cc => (
              <ConnectionRow
                key={cc.id}
                from={cc.localLabel}
                fromType={cc.localEntityType}
                to={cc.remoteLabel}
                toType={cc.remoteEntityType}
                relation={cc.relationType}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Shared connection row ───────────────────────────────────────────────────

function ConnectionRow({
  from,
  fromType,
  to,
  toType,
  relation,
}: {
  from: string
  fromType: string
  to: string
  toType: string
  relation: string
}) {
  return (
    <div
      className="flex items-center font-body"
      style={{
        fontSize: 10,
        gap: 4,
        padding: '3px 7px',
        borderRadius: 5,
        background: 'rgba(255,255,255,0.6)',
        border: '1px solid var(--border-subtle)',
      }}
    >
      <span style={{ color: getEntityColor(fromType), fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 100 }}>
        {from}
      </span>
      <Link2 size={8} style={{ color: 'var(--color-text-placeholder)', flexShrink: 0 }} />
      <span style={{ color: 'var(--color-text-secondary)', fontSize: 9, fontStyle: 'italic', flexShrink: 0 }}>
        {relation.replace(/_/g, ' ')}
      </span>
      <ArrowRight size={8} style={{ color: 'var(--color-text-placeholder)', flexShrink: 0 }} />
      <span
        style={{
          color: getEntityColor(toType),
          fontWeight: 600,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {to}
      </span>
    </div>
  )
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <span
      className="font-display font-bold uppercase"
      style={{
        fontSize: 9,
        letterSpacing: '0.07em',
        color: 'var(--color-text-secondary)',
        marginBottom: 6,
        display: 'block',
      }}
    >
      {children}
    </span>
  )
}
