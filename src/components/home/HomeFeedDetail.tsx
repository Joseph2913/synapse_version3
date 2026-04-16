import { useState, useEffect, useMemo, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { X, MessageSquare, MessageCircle, GitBranch, ArrowRight, Search, Link2, ChevronRight, Loader2 } from 'lucide-react'
import { getSourceConfig } from '../../config/sourceTypes'
import { getEntityColor } from '../../config/entityTypes'
import { ProviderIcon } from '../shared/ProviderIcon'
import { useSettings } from '../../hooks/useSettings'
import { fetchNodeById, supabase } from '../../services/supabase'
import { stripMarkdown } from '../../utils/stripMarkdown'
import { resolveSummary } from '../../utils/summarize'
import type { FeedItem } from '../../types/feed'
import type { KnowledgeNode } from '../../types/database'
import {
  buildEntityExploreContext,
  buildEntityFindSimilarContext,
  buildRelationshipChatContext,
  buildSourceChatContext,
  buildSourceAnchorRelateContext,
  buildSourceCompareContext,
  buildMultiSourceCompareContext,
} from '../../config/chatEntryContexts'

const PROVENANCE_LABELS: Record<string, string> = {
  extracted: 'From source',
  generated: 'AI generated',
  user: 'Edited',
  truncated: 'Preview',
}

function formatRelativeTime(dateStr: string): string {
  const now = Date.now()
  const then = new Date(dateStr).getTime()
  const diff = now - then
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

// ─── Types ────────────────────────────────────────────────────────────────────

type ConnectionFilter = 'all' | 'anchors' | 'external'

type UnifiedConnection = {
  id: string
  fromNodeId: string
  fromLabel: string
  fromEntityType: string
  toNodeId: string
  toLabel: string
  toEntityType: string
  relationType: string
  isExternal: boolean
  isAnchor: boolean
  sourceName: string | null
  toSourceId: string | null
}

// ─── Shared sub-components ────────────────────────────────────────────────────

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <span
      className="font-display font-bold uppercase"
      style={{ fontSize: 9, letterSpacing: '0.07em', color: 'var(--color-text-secondary)' }}
    >
      {children}
    </span>
  )
}

function SectionCard({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div
      style={{
        background: 'var(--color-bg-card)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 12,
        padding: '14px 16px',
        marginBottom: 10,
        ...style,
      }}
    >
      {children}
    </div>
  )
}

function FilterTab({
  active,
  label,
  count,
  onClick,
}: {
  active: boolean
  label: string
  count: number
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="font-body font-semibold cursor-pointer"
      style={{
        fontSize: 10,
        padding: '2px 8px',
        borderRadius: 6,
        border: active ? '1px solid rgba(214,58,0,0.2)' : '1px solid transparent',
        background: active ? 'rgba(214,58,0,0.07)' : 'transparent',
        color: active ? 'var(--color-accent-500)' : 'var(--color-text-secondary)',
        transition: 'all 0.12s ease',
      }}
    >
      {label} <span style={{ opacity: 0.7 }}>({count})</span>
    </button>
  )
}

// ─── Connection Row ───────────────────────────────────────────────────────────

function ConnectionRow({
  conn,
  isSelected,
  onClick,
}: {
  conn: UnifiedConnection
  isSelected: boolean
  onClick: () => void
}) {
  const fromColor = getEntityColor(conn.fromEntityType)
  const toColor = conn.isAnchor ? '#b45309' : getEntityColor(conn.toEntityType)
  const relationLabel = conn.relationType.replace(/_/g, ' ')

  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full text-left rounded-lg cursor-pointer"
      style={{
        display: 'grid',
        gridTemplateColumns: '1fr auto 1fr auto',
        gap: '0 6px',
        padding: '5px 8px',
        background: isSelected ? 'rgba(214,58,0,0.05)' : 'transparent',
        border: isSelected ? '1px solid rgba(214,58,0,0.18)' : '1px solid transparent',
        borderRadius: 8,
        transition: 'all 0.12s ease',
        alignItems: 'center',
        marginBottom: 2,
      }}
      onMouseEnter={e => {
        if (!isSelected) (e.currentTarget as HTMLButtonElement).style.background = 'var(--color-bg-inset)'
      }}
      onMouseLeave={e => {
        if (!isSelected) (e.currentTarget as HTMLButtonElement).style.background = 'transparent'
      }}
    >
      <span
        className="font-body"
        style={{ fontSize: 11, fontWeight: 500, color: fromColor, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
      >
        {conn.fromLabel}
      </span>
      <span
        className="font-body"
        style={{ fontSize: 9, color: 'var(--color-text-placeholder)', fontStyle: 'italic', whiteSpace: 'nowrap', textAlign: 'center' }}
      >
        {relationLabel}
      </span>
      <span
        className="font-body"
        style={{ fontSize: 11, fontWeight: 500, color: toColor, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'right' }}
      >
        {conn.isAnchor ? '⚓ ' : ''}{conn.toLabel}
      </span>
      <ChevronRight size={10} style={{ color: 'var(--color-text-placeholder)', flexShrink: 0 }} />
    </button>
  )
}

// ─── Entity Detail Panel ──────────────────────────────────────────────────────

function EntityDetailPanel({
  node,
  onClose,
}: {
  node: KnowledgeNode
  onClose: () => void
}) {
  const navigate = useNavigate()
  const { promoteToAnchor, demoteAnchor, refreshAnchors } = useSettings()
  const [anchorLoading, setAnchorLoading] = useState(false)
  const color = getEntityColor(node.entity_type)

  const handleAnchorToggle = async () => {
    setAnchorLoading(true)
    try {
      if (node.is_anchor) await demoteAnchor(node.id)
      else await promoteToAnchor(node.id)
      await refreshAnchors()
    } finally {
      setAnchorLoading(false)
    }
  }

  const allTags = [...(node.tags ?? []), ...(node.user_tags ?? [])].filter(Boolean)

  const panelBtnStyle = (primary = false): React.CSSProperties => ({
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    width: '100%',
    padding: '7px 10px',
    borderRadius: 7,
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
    border: primary ? '1px solid var(--color-accent-500)' : '1px solid var(--border-subtle)',
    background: primary ? 'rgba(214,58,0,0.06)' : 'var(--color-bg-inset)',
    color: primary ? 'var(--color-accent-500)' : 'var(--color-text-body)',
    transition: 'background 0.12s ease',
    textAlign: 'left',
  })

  return (
    <div
      style={{
        width: 300,
        borderLeft: '1px solid var(--border-subtle)',
        height: '100%',
        overflowY: 'auto',
        padding: '20px 18px',
        flexShrink: 0,
        background: 'var(--color-bg-content)',
      }}
    >
      {/* Header */}
      <div className="flex items-center justify-between" style={{ marginBottom: 16 }}>
        <SectionLabel>Entity Detail</SectionLabel>
        <button
          type="button"
          onClick={onClose}
          className="flex items-center justify-center cursor-pointer rounded"
          style={{ width: 22, height: 22, background: 'none', border: 'none', color: 'var(--color-text-secondary)', transition: 'background 0.12s ease' }}
          onMouseEnter={e => { ;(e.currentTarget as HTMLButtonElement).style.background = 'var(--color-bg-inset)' }}
          onMouseLeave={e => { ;(e.currentTarget as HTMLButtonElement).style.background = 'none' }}
        >
          <X size={13} />
        </button>
      </div>

      {/* Node title */}
      <div style={{ marginBottom: 14 }}>
        <div className="flex items-start gap-2" style={{ marginBottom: 6 }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: color, flexShrink: 0, marginTop: 5, display: 'inline-block' }} />
          <h3
            className="font-display font-bold"
            style={{ fontSize: 16, color: 'var(--color-text-primary)', margin: 0, lineHeight: 1.2 }}
          >
            {node.label}
          </h3>
        </div>
        <div className="flex items-center flex-wrap gap-1" style={{ paddingLeft: 14 }}>
          <span
            className="font-body font-semibold"
            style={{ fontSize: 10, padding: '1px 6px', borderRadius: 4, color, background: `${color}15`, border: `1px solid ${color}30` }}
          >
            {node.entity_type}
          </span>
          {node.is_anchor && (
            <span
              className="font-body font-semibold"
              style={{ fontSize: 10, padding: '1px 6px', borderRadius: 4, color: '#b45309', background: 'rgba(180,83,9,0.1)', border: '1px solid rgba(180,83,9,0.2)' }}
            >
              ⚓ Anchor
            </span>
          )}
        </div>
      </div>

      {/* Confidence */}
      {node.confidence != null && (
        <div style={{ marginBottom: 14 }}>
          <SectionLabel>Confidence</SectionLabel>
          <div className="flex items-center gap-2" style={{ marginTop: 6 }}>
            <div style={{ flex: 1, height: 4, borderRadius: 2, background: 'var(--color-bg-inset)', overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${Math.round(node.confidence * 100)}%`, background: color, borderRadius: 2 }} />
            </div>
            <span className="font-body" style={{ fontSize: 11, color: 'var(--color-text-secondary)', flexShrink: 0 }}>
              {Math.round(node.confidence * 100)}%
            </span>
          </div>
        </div>
      )}

      {/* Description */}
      {node.description && (
        <div style={{ marginBottom: 14 }}>
          <SectionLabel>Description</SectionLabel>
          <p
            className="font-body"
            style={{ fontSize: 12, color: 'var(--color-text-body)', lineHeight: 1.6, margin: '6px 0 0' }}
          >
            {node.description}
          </p>
        </div>
      )}

      {/* Source */}
      {node.source && (
        <div style={{ marginBottom: 14 }}>
          <SectionLabel>Source</SectionLabel>
          <p className="font-body" style={{ fontSize: 12, color: 'var(--color-text-secondary)', margin: '4px 0 0' }}>
            {node.source}
          </p>
        </div>
      )}

      {/* Tags */}
      {allTags.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          <SectionLabel>Tags</SectionLabel>
          <div className="flex flex-wrap gap-1" style={{ marginTop: 6 }}>
            {allTags.map(tag => (
              <span
                key={tag}
                className="font-body"
                style={{
                  fontSize: 10,
                  padding: '2px 7px',
                  borderRadius: 5,
                  background: 'var(--color-bg-inset)',
                  border: '1px solid var(--border-subtle)',
                  color: 'var(--color-text-secondary)',
                }}
              >
                {tag}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Actions */}
      <div style={{ marginTop: 16, borderTop: '1px solid var(--border-subtle)', paddingTop: 14, display: 'flex', flexDirection: 'column', gap: 6 }}>
        <button
          type="button"
          className="font-body font-semibold cursor-pointer"
          style={panelBtnStyle()}
          onClick={() => navigate('/ask', {
            state: { chatContext: buildEntityExploreContext(node) },
          })}
          onMouseEnter={e => { ;(e.currentTarget as HTMLButtonElement).style.background = 'var(--color-bg-card)' }}
          onMouseLeave={e => { ;(e.currentTarget as HTMLButtonElement).style.background = 'var(--color-bg-inset)' }}
        >
          <MessageSquare size={12} /> Explore with AI
        </button>
        <button
          type="button"
          className="font-body font-semibold cursor-pointer"
          style={panelBtnStyle()}
          onClick={() => navigate('/ask', {
            state: { chatContext: buildEntityFindSimilarContext(node) },
          })}
          onMouseEnter={e => { ;(e.currentTarget as HTMLButtonElement).style.background = 'var(--color-bg-card)' }}
          onMouseLeave={e => { ;(e.currentTarget as HTMLButtonElement).style.background = 'var(--color-bg-inset)' }}
        >
          <Search size={12} /> Find Similar
        </button>
        <button
          type="button"
          className="font-body font-semibold cursor-pointer"
          style={panelBtnStyle()}
          onClick={handleAnchorToggle}
          disabled={anchorLoading}
          onMouseEnter={e => { ;(e.currentTarget as HTMLButtonElement).style.background = 'var(--color-bg-card)' }}
          onMouseLeave={e => { ;(e.currentTarget as HTMLButtonElement).style.background = 'var(--color-bg-inset)' }}
        >
          <span style={{ fontSize: 12 }}>⚓</span>
          {anchorLoading ? '…' : node.is_anchor ? 'Demote from Anchor' : 'Promote to Anchor'}
        </button>
        <button
          type="button"
          className="font-body font-semibold"
          style={{ ...panelBtnStyle(), opacity: 0.4, cursor: 'not-allowed' }}
          disabled
        >
          <Link2 size={12} /> Relink
        </button>
      </div>
    </div>
  )
}

// ─── Relationship Detail Panel ─────────────────────────────────────────────────

function RelationshipDetailPanel({
  conn,
  onClose,
  onSourceSelect,
}: {
  conn: UnifiedConnection
  onClose: () => void
  onSourceSelect?: (sourceId: string) => void
}) {
  const navigate = useNavigate()
  const fromColor = getEntityColor(conn.fromEntityType)
  const toColor = conn.isAnchor ? '#b45309' : getEntityColor(conn.toEntityType)
  const relationLabel = conn.relationType.replace(/_/g, ' ')

  return (
    <div
      style={{
        width: 300,
        borderLeft: '1px solid var(--border-subtle)',
        height: '100%',
        overflowY: 'auto',
        padding: '20px 18px',
        flexShrink: 0,
        background: 'var(--color-bg-content)',
      }}
    >
      {/* Header */}
      <div className="flex items-center justify-between" style={{ marginBottom: 16 }}>
        <SectionLabel>Relationship</SectionLabel>
        <button
          type="button"
          onClick={onClose}
          className="flex items-center justify-center cursor-pointer rounded"
          style={{ width: 22, height: 22, background: 'none', border: 'none', color: 'var(--color-text-secondary)', transition: 'background 0.12s ease' }}
          onMouseEnter={e => { ;(e.currentTarget as HTMLButtonElement).style.background = 'var(--color-bg-inset)' }}
          onMouseLeave={e => { ;(e.currentTarget as HTMLButtonElement).style.background = 'none' }}
        >
          <X size={13} />
        </button>
      </div>

      {/* Relationship chain */}
      <div style={{ marginBottom: 16 }}>
        {/* From entity */}
        <div
          style={{
            padding: '8px 12px',
            borderRadius: 8,
            background: `${fromColor}12`,
            border: `1px solid ${fromColor}28`,
            marginBottom: 3,
          }}
        >
          <div className="font-body font-semibold" style={{ fontSize: 12, color: fromColor }}>{conn.fromLabel}</div>
          <div className="font-body" style={{ fontSize: 10, color: 'var(--color-text-placeholder)', marginTop: 1 }}>{conn.fromEntityType}</div>
        </div>

        {/* Relation arrow */}
        <div style={{ textAlign: 'center', padding: '4px 0', fontSize: 10, color: 'var(--color-text-placeholder)', fontStyle: 'italic' }}>
          ↓ {relationLabel}
        </div>

        {/* To entity */}
        <div
          style={{
            padding: '8px 12px',
            borderRadius: 8,
            background: conn.isAnchor ? 'rgba(180,83,9,0.06)' : `${toColor}12`,
            border: conn.isAnchor ? '1px solid rgba(180,83,9,0.22)' : `1px solid ${toColor}28`,
            marginTop: 3,
          }}
        >
          <div className="font-body font-semibold" style={{ fontSize: 12, color: toColor }}>
            {conn.isAnchor ? '⚓ ' : ''}{conn.toLabel}
          </div>
          <div className="font-body" style={{ fontSize: 10, color: 'var(--color-text-placeholder)', marginTop: 1 }}>{conn.toEntityType}</div>
        </div>
      </div>

      {/* Why they're related */}
      <div style={{ marginBottom: 14 }}>
        <SectionLabel>Why they're related</SectionLabel>
        <div
          style={{
            marginTop: 8,
            padding: '10px 12px',
            background: 'var(--color-bg-inset)',
            borderRadius: 8,
          }}
        >
          <p className="font-body" style={{ fontSize: 12, color: 'var(--color-text-body)', lineHeight: 1.6, margin: 0 }}>
            <strong>{conn.fromLabel}</strong> {relationLabel} <strong>{conn.toLabel}</strong>.
            {conn.isAnchor && ` "${conn.toLabel}" is a key anchor concept in your knowledge graph — this connection reinforces its significance.`}
            {conn.isExternal && conn.sourceName && ` This relationship spans sources, linking this document to "${conn.sourceName}".`}
            {!conn.isExternal && !conn.isAnchor && ' This relationship was discovered within the same source document.'}
          </p>
        </div>
      </div>

      {/* Connected source */}
      {conn.isExternal && conn.sourceName && (
        <div style={{ marginBottom: 14 }}>
          <SectionLabel>Connected Source</SectionLabel>
          {conn.toSourceId && onSourceSelect ? (
            <button
              type="button"
              onClick={() => onSourceSelect(conn.toSourceId!)}
              className="font-body cursor-pointer"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                marginTop: 5,
                fontSize: 12,
                fontWeight: 500,
                color: 'var(--color-accent-500)',
                background: 'none',
                border: 'none',
                padding: 0,
                textAlign: 'left',
                textDecoration: 'underline',
                textDecorationColor: 'rgba(214,58,0,0.3)',
                textUnderlineOffset: 2,
                transition: 'opacity 0.12s ease',
              }}
              onMouseEnter={e => { ;(e.currentTarget as HTMLButtonElement).style.opacity = '0.7' }}
              onMouseLeave={e => { ;(e.currentTarget as HTMLButtonElement).style.opacity = '1' }}
            >
              {conn.sourceName}
              <ArrowRight size={11} />
            </button>
          ) : (
            <p className="font-body" style={{ fontSize: 12, color: 'var(--color-text-secondary)', margin: '4px 0 0' }}>
              {conn.sourceName}
            </p>
          )}
        </div>
      )}

      {/* Action */}
      <div style={{ marginTop: 16, borderTop: '1px solid var(--border-subtle)', paddingTop: 14 }}>
        <button
          type="button"
          className="font-body font-semibold cursor-pointer flex items-center justify-center gap-2 w-full"
          style={{
            padding: '8px 12px',
            borderRadius: 7,
            border: '1px solid var(--color-accent-500)',
            background: 'rgba(214,58,0,0.06)',
            color: 'var(--color-accent-500)',
            fontSize: 12,
            transition: 'background 0.12s ease',
          }}
          onClick={() => navigate('/ask', {
            state: { chatContext: buildRelationshipChatContext(conn) },
          })}
          onMouseEnter={e => { ;(e.currentTarget as HTMLButtonElement).style.background = 'rgba(214,58,0,0.1)' }}
          onMouseLeave={e => { ;(e.currentTarget as HTMLButtonElement).style.background = 'rgba(214,58,0,0.06)' }}
        >
          <MessageSquare size={12} />
          Chat about this relationship
        </button>
      </div>
    </div>
  )
}

// ─── Main Component ────────────────────────────────────────────────────────────

interface HomeFeedDetailProps {
  item: FeedItem
  onClose: () => void
  onSourceSelect?: (sourceId: string) => void
}

export function HomeFeedDetail({ item, onClose, onSourceSelect }: HomeFeedDetailProps) {
  const navigate = useNavigate()
  const [connectionFilter, setConnectionFilter] = useState<ConnectionFilter>('all')
  const [selectedEntity, setSelectedEntity] = useState<KnowledgeNode | null>(null)
  const [entityLoading, setEntityLoading] = useState(false)
  const [loadingEntityId, setLoadingEntityId] = useState<string | null>(null)
  const [selectedConnection, setSelectedConnection] = useState<UnifiedConnection | null>(null)

  // Summary state
  const [currentSummary, setCurrentSummary] = useState<string | null>(item.source.summary ?? null)
  const [currentSummarySource, setCurrentSummarySource] = useState<string | null>(item.source.summary_source ?? null)
  const [isEditingSummary, setIsEditingSummary] = useState(false)
  const [draftSummary, setDraftSummary] = useState('')
  const [generationStatus, setGenerationStatus] = useState<'idle' | 'generating' | 'error'>('idle')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const cfg = getSourceConfig(item.source.source_type)
  const sourceProvider = (item.source.metadata as Record<string, unknown> | null)?.provider as string | undefined

  // Reset summary state when item changes
  useEffect(() => {
    setCurrentSummary(item.source.summary ?? null)
    setCurrentSummarySource(item.source.summary_source ?? null)
    setIsEditingSummary(false)
    setGenerationStatus('idle')
  }, [item.source.id, item.source.summary, item.source.summary_source])

  const handleEntityClick = async (entityId: string) => {
    setLoadingEntityId(entityId)
    setEntityLoading(true)
    setSelectedConnection(null)
    const node = await fetchNodeById(entityId)
    if (node) setSelectedEntity(node)
    setEntityLoading(false)
    setLoadingEntityId(null)
  }

  const handleConnectionClick = (conn: UnifiedConnection) => {
    setSelectedEntity(null)
    setSelectedConnection(conn)
  }

  // Summary handlers
  const handleEditStart = () => {
    setDraftSummary(currentSummary ?? '')
    setIsEditingSummary(true)
    setTimeout(() => textareaRef.current?.focus(), 50)
  }

  const handleEditSave = async () => {
    const trimmed = draftSummary.trim()
    if (!trimmed) return
    const { error } = await supabase
      .from('knowledge_sources')
      .update({ summary: trimmed, summary_source: 'user' })
      .eq('id', item.source.id)
    if (!error) {
      setCurrentSummary(trimmed)
      setCurrentSummarySource('user')
    }
    setIsEditingSummary(false)
  }

  const handleEditCancel = () => {
    setIsEditingSummary(false)
  }

  const handleGenerateSummary = async () => {
    setGenerationStatus('generating')
    try {
      const result = await resolveSummary(
        item.source.source_type ?? null,
        item.source.content ?? null,
        item.source.metadata ?? null,
      )
      if (result) {
        const { error } = await supabase
          .from('knowledge_sources')
          .update({ summary: result.summary, summary_source: result.source })
          .eq('id', item.source.id)
        if (!error) {
          setCurrentSummary(result.summary)
          setCurrentSummarySource(result.source)
        }
      }
      setGenerationStatus('idle')
    } catch {
      setGenerationStatus('error')
    }
  }

  const contentPreview = item.source.content
    ? item.source.content.replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 180) + '...'
    : null

  // Unified connections
  const allConnections: UnifiedConnection[] = useMemo(() => [
    ...item.withinSourceConnections.map(cc => ({
      ...cc,
      isExternal: false,
      sourceName: null,
      toSourceId: null,
    })),
    ...item.crossConnections.map(cc => ({
      ...cc,
      isExternal: true,
      sourceName: cc.toSourceTitle,
      toSourceId: cc.toSourceId,
    })),
  ], [item.withinSourceConnections, item.crossConnections])

  const anchorCount = useMemo(() => allConnections.filter(c => c.isAnchor).length, [allConnections])
  const otherSourceCount = useMemo(() => allConnections.filter(c => c.isExternal && !c.isAnchor).length, [allConnections])

  const filteredConnections = useMemo(() => {
    if (connectionFilter === 'anchors') return allConnections.filter(c => c.isAnchor)
    if (connectionFilter === 'external') return allConnections.filter(c => c.isExternal && !c.isAnchor)
    return allConnections
  }, [allConnections, connectionFilter])

  const uniqueAnchors = useMemo(() => {
    const seen = new Set<string>()
    const result: { nodeId: string; label: string }[] = []
    allConnections.forEach(c => {
      if (c.isAnchor && !seen.has(c.toNodeId)) {
        seen.add(c.toNodeId)
        result.push({ nodeId: c.toNodeId, label: c.toLabel })
      }
    })
    return result
  }, [allConnections])

  const uniqueExternalSources = useMemo(() => {
    const seen = new Set<string>()
    const result: { sourceId: string; title: string }[] = []
    allConnections.forEach(c => {
      if (!c.isAnchor && c.isExternal && c.toSourceId && !seen.has(c.toSourceId)) {
        seen.add(c.toSourceId)
        result.push({ sourceId: c.toSourceId, title: c.sourceName ?? 'Source' })
      }
    })
    return result
  }, [allConnections])

  const hasDetailPanel = selectedEntity !== null || selectedConnection !== null || entityLoading

  const actionBtnStyle: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    fontSize: 12,
    fontWeight: 600,
    padding: '6px 12px',
    borderRadius: 7,
    border: '1px solid var(--border-subtle)',
    background: 'var(--color-bg-inset)',
    color: 'var(--color-text-body)',
    cursor: 'pointer',
    transition: 'background 0.12s ease',
  }

  return (
    <div className="flex h-full overflow-hidden">

      {/* ── Main content column ── */}
      <div
        className="h-full overflow-y-auto flex-1 min-w-0"
        style={{ padding: '24px 24px' }}
      >

        {/* ── Metadata card (header + actions) ── */}
        <SectionCard>
          <div className="flex items-start gap-3">
            <ProviderIcon sourceType={item.source.source_type} provider={sourceProvider} size={36} />
            <div className="flex-1 min-w-0">
              <h2
                className="font-display font-bold"
                style={{ fontSize: 17, color: 'var(--color-text-primary)', lineHeight: 1.2, margin: 0 }}
              >
                {item.source.title ?? 'Untitled Source'}
              </h2>
              <div className="flex items-center gap-2" style={{ marginTop: 4 }}>
                <span
                  className="font-body font-semibold"
                  style={{
                    fontSize: 10,
                    padding: '1px 6px',
                    borderRadius: 4,
                    background: cfg.color + '1A',
                    color: cfg.color,
                    border: `1px solid ${cfg.color}29`,
                  }}
                >
                  {item.source.source_type ?? 'source'}
                </span>
                <span className="font-body" style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>
                  {formatRelativeTime(item.source.created_at)}
                </span>
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="flex items-center justify-center cursor-pointer rounded-md shrink-0"
              style={{ width: 28, height: 28, background: 'none', border: 'none', color: 'var(--color-text-secondary)', transition: 'background 0.12s ease' }}
              onMouseEnter={e => { ;(e.currentTarget as HTMLButtonElement).style.background = 'var(--color-bg-inset)' }}
              onMouseLeave={e => { ;(e.currentTarget as HTMLButtonElement).style.background = 'none' }}
              title="Close"
            >
              <X size={16} />
            </button>
          </div>

          {/* Action bar */}
          <div className="flex items-center flex-wrap" style={{ gap: 8, marginTop: 14 }}>
            <button
              type="button"
              className="font-body cursor-pointer"
              style={actionBtnStyle}
              onClick={() => navigate('/ask', {
                state: { chatContext: buildSourceChatContext(item.source) },
              })}
              onMouseEnter={e => { ;(e.currentTarget as HTMLButtonElement).style.background = 'var(--color-bg-card)' }}
              onMouseLeave={e => { ;(e.currentTarget as HTMLButtonElement).style.background = 'var(--color-bg-inset)' }}
            >
              <MessageSquare size={12} /> Chat with source
            </button>
            <button
              type="button"
              className="font-body cursor-pointer"
              style={actionBtnStyle}
              onClick={() => navigate(`/explore?viewMode=sources&sourceId=${item.source.id}`)}
              onMouseEnter={e => { ;(e.currentTarget as HTMLButtonElement).style.background = 'var(--color-bg-card)' }}
              onMouseLeave={e => { ;(e.currentTarget as HTMLButtonElement).style.background = 'var(--color-bg-inset)' }}
            >
              <GitBranch size={12} /> View in Graph
            </button>
            {(() => {
              const relatedSources = Array.from(
                new Map(
                  item.crossConnections
                    .filter(cc => cc.toSourceId && cc.toSourceTitle)
                    .map(cc => [cc.toSourceId!, { id: cc.toSourceId!, title: cc.toSourceTitle! }])
                ).values()
              )
              if (relatedSources.length === 0) return null
              return (
                <button
                  type="button"
                  className="font-body cursor-pointer"
                  style={actionBtnStyle}
                  onClick={() => {
                    const primary = { id: item.source.id, title: item.source.title ?? 'Untitled' }
                    const context = buildMultiSourceCompareContext(primary, relatedSources)
                    navigate('/ask', { state: { chatContext: context } })
                  }}
                  onMouseEnter={e => { ;(e.currentTarget as HTMLButtonElement).style.background = 'var(--color-bg-card)' }}
                  onMouseLeave={e => { ;(e.currentTarget as HTMLButtonElement).style.background = 'var(--color-bg-inset)' }}
                >
                  <MessageCircle size={12} /> Compare with related sources
                </button>
              )
            })()}
          </div>

        </SectionCard>

        {/* ── Summary card ── */}
        <SectionCard>
          <div className="flex items-center justify-between" style={{ marginBottom: 8 }}>
            <div className="flex items-center gap-2">
              <SectionLabel>Summary</SectionLabel>
              {currentSummary && currentSummarySource && (
                <span
                  className="font-body"
                  style={{
                    fontSize: 10,
                    fontWeight: 500,
                    color: 'var(--color-text-secondary)',
                    background: 'var(--color-bg-inset)',
                    borderRadius: 4,
                    padding: '2px 6px',
                  }}
                >
                  {PROVENANCE_LABELS[currentSummarySource] ?? currentSummarySource}
                </span>
              )}
            </div>
            {currentSummary && !isEditingSummary && (
              <button
                type="button"
                onClick={handleEditStart}
                className="font-body cursor-pointer"
                style={{
                  fontSize: 11,
                  color: 'var(--color-accent-500)',
                  background: 'none',
                  border: 'none',
                  padding: 0,
                  textDecoration: 'none',
                }}
                onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.textDecoration = 'underline' }}
                onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.textDecoration = 'none' }}
              >
                Edit
              </button>
            )}
          </div>

          {isEditingSummary ? (
            <div>
              <textarea
                ref={textareaRef}
                value={draftSummary}
                onChange={e => setDraftSummary(e.target.value)}
                className="font-body w-full"
                style={{
                  fontSize: 13,
                  color: 'var(--color-text-body)',
                  background: 'var(--color-bg-inset)',
                  border: '1px solid var(--border-subtle)',
                  borderRadius: 8,
                  padding: '8px 10px',
                  resize: 'vertical',
                  minHeight: 80,
                  maxHeight: 200,
                  lineHeight: 1.5,
                  outline: 'none',
                }}
                onFocus={e => { (e.currentTarget as HTMLTextAreaElement).style.borderColor = 'rgba(214,58,0,0.3)' }}
                onBlur={e => { (e.currentTarget as HTMLTextAreaElement).style.borderColor = 'var(--border-subtle)' }}
              />
              <div className="flex items-center gap-2 mt-2">
                <button
                  type="button"
                  onClick={handleEditSave}
                  className="font-body font-semibold cursor-pointer"
                  style={{
                    fontSize: 11,
                    padding: '5px 14px',
                    borderRadius: 6,
                    background: 'var(--color-bg-inset)',
                    border: '1px solid var(--border-default)',
                    color: 'var(--color-text-body)',
                  }}
                >
                  Save
                </button>
                <button
                  type="button"
                  onClick={handleEditCancel}
                  className="font-body cursor-pointer"
                  style={{
                    fontSize: 11,
                    padding: '5px 14px',
                    borderRadius: 6,
                    background: 'transparent',
                    border: 'none',
                    color: 'var(--color-text-secondary)',
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : currentSummary ? (
            <p
              className="font-body"
              style={{ fontSize: 13, color: 'var(--color-text-body)', lineHeight: 1.6, marginTop: 0, marginBottom: 0 }}
            >
              {stripMarkdown(currentSummary)}
            </p>
          ) : contentPreview ? (
            <div>
              <p
                className="font-body"
                style={{
                  fontSize: 13,
                  color: 'var(--color-text-secondary)',
                  fontStyle: 'italic',
                  lineHeight: 1.6,
                  marginTop: 0,
                  marginBottom: 0,
                }}
              >
                {contentPreview}
              </p>
              <button
                type="button"
                onClick={handleGenerateSummary}
                disabled={generationStatus === 'generating'}
                className="font-body cursor-pointer inline-flex items-center gap-1.5"
                style={{
                  fontSize: 11,
                  color: 'var(--color-accent-500)',
                  background: 'none',
                  border: 'none',
                  padding: 0,
                  marginTop: 8,
                  opacity: generationStatus === 'generating' ? 0.6 : 1,
                }}
              >
                {generationStatus === 'generating' ? (
                  <>
                    <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} />
                    Generating...
                  </>
                ) : (
                  'Generate summary'
                )}
              </button>
              {generationStatus === 'error' && (
                <p className="font-body" style={{ fontSize: 11, color: 'var(--color-semantic-red-500)', marginTop: 4, marginBottom: 0 }}>
                  Summary generation failed —{' '}
                  <button
                    type="button"
                    onClick={handleGenerateSummary}
                    className="font-body cursor-pointer"
                    style={{
                      fontSize: 11,
                      color: 'var(--color-accent-500)',
                      background: 'none',
                      border: 'none',
                      padding: 0,
                      textDecoration: 'underline',
                    }}
                  >
                    Retry
                  </button>
                </p>
              )}
            </div>
          ) : (
            <p className="font-body" style={{ fontSize: 12, color: 'var(--color-text-placeholder)', marginTop: 0, marginBottom: 0 }}>
              No content available
            </p>
          )}
        </SectionCard>

        {/* ── Entities card ── */}
        {item.entities.length > 0 && (
          <SectionCard>
            <div className="flex items-center justify-between" style={{ marginBottom: 10 }}>
              <SectionLabel>Entities ({item.entityCount})</SectionLabel>
            </div>
            <div>
              {item.entities.map(entity => {
                const color = getEntityColor(entity.entityType)
                const isLoading = loadingEntityId === entity.id
                return (
                  <button
                    key={entity.id}
                    type="button"
                    onClick={() => handleEntityClick(entity.id)}
                    className="w-full text-left flex items-center justify-between cursor-pointer rounded-md"
                    style={{
                      padding: '5px 8px',
                      background: 'transparent',
                      border: '1px solid transparent',
                      transition: 'all 0.12s ease',
                      marginBottom: 2,
                      borderRadius: 8,
                      opacity: isLoading ? 0.6 : 1,
                    }}
                    onMouseEnter={e => { ;(e.currentTarget as HTMLButtonElement).style.background = 'var(--color-bg-inset)' }}
                    onMouseLeave={e => { ;(e.currentTarget as HTMLButtonElement).style.background = 'transparent' }}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <span style={{ width: 6, height: 6, borderRadius: '50%', background: color, flexShrink: 0, display: 'inline-block' }} />
                      <span
                        className="font-body"
                        style={{ fontSize: 12, fontWeight: 500, color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                      >
                        {entity.label}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 shrink-0" style={{ marginLeft: 8 }}>
                      <span
                        className="font-body font-semibold"
                        style={{ fontSize: 10, padding: '1px 6px', borderRadius: 4, color, background: `${color}10`, border: `1px solid ${color}29`, lineHeight: 1.4 }}
                      >
                        {entity.entityType}
                      </span>
                      {entity.confidence != null && (
                        <span className="font-body" style={{ fontSize: 10, color: 'var(--color-text-placeholder)', minWidth: 30, textAlign: 'right' }}>
                          {Math.round(entity.confidence * 100)}%
                        </span>
                      )}
                      <ChevronRight size={10} style={{ color: 'var(--color-text-placeholder)' }} />
                    </div>
                  </button>
                )
              })}
            </div>
          </SectionCard>
        )}

        {/* ── Connections card ── */}
        {allConnections.length > 0 && (
          <SectionCard>
            <div className="flex items-center justify-between" style={{ marginBottom: 8 }}>
              <SectionLabel>Connections ({allConnections.length})</SectionLabel>
              <div className="flex items-center gap-1">
                <FilterTab
                  active={connectionFilter === 'all'}
                  label="All"
                  count={allConnections.length}
                  onClick={() => setConnectionFilter('all')}
                />
                {anchorCount > 0 && (
                  <FilterTab
                    active={connectionFilter === 'anchors'}
                    label="Anchors"
                    count={anchorCount}
                    onClick={() => setConnectionFilter('anchors')}
                  />
                )}
                {otherSourceCount > 0 && (
                  <FilterTab
                    active={connectionFilter === 'external'}
                    label="Other sources"
                    count={otherSourceCount}
                    onClick={() => setConnectionFilter('external')}
                  />
                )}
              </div>
            </div>

            {filteredConnections.map(conn => (
              <ConnectionRow
                key={conn.id}
                conn={conn}
                isSelected={selectedConnection?.id === conn.id}
                onClick={() => handleConnectionClick(conn)}
              />
            ))}
          </SectionCard>
        )}

        {/* ── Related Anchors card ── */}
        {uniqueAnchors.length > 0 && (
          <SectionCard>
            <SectionLabel>Related Anchors</SectionLabel>
            <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
              {uniqueAnchors.map(a => (
                <div
                  key={a.nodeId}
                  className="flex items-center justify-between rounded-lg"
                  style={{ padding: '6px 8px', background: 'rgba(180,83,9,0.04)', border: '1px solid rgba(180,83,9,0.12)', borderRadius: 8 }}
                >
                  <button
                    type="button"
                    onClick={() => handleEntityClick(a.nodeId)}
                    className="flex items-center gap-2 min-w-0 cursor-pointer"
                    style={{ background: 'none', border: 'none', padding: 0 }}
                  >
                    <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#b45309', flexShrink: 0, display: 'inline-block' }} />
                    <span
                      className="font-body font-semibold"
                      style={{ fontSize: 12, color: '#b45309', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textDecoration: 'underline', textDecorationColor: 'rgba(180,83,9,0.3)', textUnderlineOffset: 2 }}
                    >
                      {a.label}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => navigate('/ask', {
                      state: { chatContext: buildSourceAnchorRelateContext(item.source, a) },
                    })}
                    className="inline-flex items-center gap-1 font-body font-semibold cursor-pointer shrink-0"
                    style={{ fontSize: 11, marginLeft: 8, padding: '2px 8px', borderRadius: 6, border: 'none', background: 'none', color: 'var(--color-accent-500)', transition: 'opacity 0.12s ease' }}
                    onMouseEnter={e => { ;(e.currentTarget as HTMLButtonElement).style.opacity = '0.7' }}
                    onMouseLeave={e => { ;(e.currentTarget as HTMLButtonElement).style.opacity = '1' }}
                  >
                    Ask how this relates <ArrowRight size={10} />
                  </button>
                </div>
              ))}
            </div>
          </SectionCard>
        )}

        {/* ── Related Sources card ── */}
        {uniqueExternalSources.length > 0 && (
          <SectionCard>
            <SectionLabel>Related Sources</SectionLabel>
            <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
              {uniqueExternalSources.map(s => (
                <div
                  key={s.sourceId}
                  className="flex items-center justify-between rounded-lg"
                  style={{ padding: '6px 8px', background: 'var(--color-bg-inset)', border: '1px solid var(--border-subtle)', borderRadius: 8 }}
                >
                  <span
                    className="font-body font-semibold"
                    style={{ fontSize: 12, color: 'var(--color-text-body)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}
                  >
                    {s.title}
                  </span>
                  <button
                    type="button"
                    onClick={() => navigate('/ask', {
                      state: { chatContext: buildSourceCompareContext(item.source, { id: s.sourceId, title: s.title }) },
                    })}
                    className="inline-flex items-center gap-1 font-body font-semibold cursor-pointer shrink-0"
                    style={{ fontSize: 11, marginLeft: 8, padding: '2px 8px', borderRadius: 6, border: 'none', background: 'none', color: 'var(--color-accent-500)', transition: 'opacity 0.12s ease' }}
                    onMouseEnter={e => { ;(e.currentTarget as HTMLButtonElement).style.opacity = '0.7' }}
                    onMouseLeave={e => { ;(e.currentTarget as HTMLButtonElement).style.opacity = '1' }}
                  >
                    Compare sources <ArrowRight size={10} />
                  </button>
                </div>
              ))}
            </div>
          </SectionCard>
        )}

      </div>

      {/* ── Detail panel (entity or relationship) ── */}
      {hasDetailPanel && (
        entityLoading ? (
          <div
            style={{
              width: 300,
              borderLeft: '1px solid var(--border-subtle)',
              height: '100%',
              flexShrink: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: 'var(--color-bg-content)',
            }}
          >
            <span className="font-body" style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>Loading…</span>
          </div>
        ) : selectedEntity ? (
          <EntityDetailPanel
            node={selectedEntity}
            onClose={() => setSelectedEntity(null)}
          />
        ) : selectedConnection ? (
          <RelationshipDetailPanel
            conn={selectedConnection}
            onClose={() => setSelectedConnection(null)}
            onSourceSelect={onSourceSelect}
          />
        ) : null
      )}

    </div>
  )
}
