import { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { X, ChevronRight, ChevronDown, ArrowRight, Link2, Loader2, Sparkles, MessageCircle, ExternalLink } from 'lucide-react'
import { getSourceConfig } from '../../config/sourceTypes'
import { getEntityColor } from '../../config/entityTypes'
import { formatSourceSummary } from '../../utils/sourceDisplay'
import { buildSourceChatContext, buildMultiSourceCompareContext } from '../../config/chatEntryContexts'
import { useAuth } from '../../hooks/useAuth'
import { fetchSourceCardDetail } from '../../services/exploreQueries'
import type { SourceCardDetail, SourceCardRelatedSource } from '../../services/exploreQueries'

interface SourceDetailCardProps {
  sourceId: string
  onClose: () => void
  onNavigateToSource: (sourceId: string) => void
  /** When true, renders content only without the absolute-positioned panel wrapper */
  bare?: boolean
  /** Override default "Chat with this source" behavior (default navigates to /ask) */
  onChatWithSourceOverride?: (source: { id: string; title: string; summary: string | null }) => void
  /** Override default "Compare with related sources" behavior */
  onCompareWithSourcesOverride?: (primarySource: { id: string; title: string }, relatedSources: { id: string; title: string }[]) => void
}

const PANEL_WIDTH = 370
const DEFAULT_VISIBLE = 6

/** Pull a YouTube video id from any watch / shorts / youtu.be / embed variant. */
function extractYouTubeVideoId(url: string): string | null {
  const patterns = [
    /youtube\.com\/watch\?v=([a-zA-Z0-9_-]+)/,
    /youtu\.be\/([a-zA-Z0-9_-]+)/,
    /youtube\.com\/embed\/([a-zA-Z0-9_-]+)/,
    /youtube\.com\/shorts\/([a-zA-Z0-9_-]+)/,
  ]
  for (const p of patterns) {
    const m = url.match(p)
    if (m) return m[1] ?? null
  }
  return null
}

/** Friendly label + hostname for the "open source" link row. */
function getLinkLabel(
  sourceType: string,
  url: string,
  provider: string | null
): { label: string; hostname: string } | null {
  try {
    const u = new URL(url)
    const hostname = u.hostname.replace(/^www\./, '')
    if (sourceType === 'YouTube') return { label: 'Open on YouTube', hostname }
    if (sourceType === 'GitHub') return { label: 'Open on GitHub', hostname }
    if (sourceType === 'Meeting') {
      if (provider) {
        const name = provider.charAt(0).toUpperCase() + provider.slice(1)
        return { label: `Open in ${name}`, hostname }
      }
      return { label: 'Open meeting', hostname }
    }
    if (sourceType === 'Research') return { label: 'Open source', hostname }
    return { label: 'Open source', hostname }
  } catch {
    return null
  }
}

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
  bare = false,
  onChatWithSourceOverride,
  onCompareWithSourcesOverride,
}: SourceDetailCardProps) {
  const { user } = useAuth()
  const navigate = useNavigate()
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

  const handleWheel = useCallback((e: WheelEvent) => { e.stopPropagation() }, [])

  useEffect(() => {
    if (bare) return // Skip wheel capture in bare mode
    const el = panelRef.current
    if (!el) return
    el.addEventListener('wheel', handleWheel, { passive: false })
    return () => el.removeEventListener('wheel', handleWheel)
  }, [handleWheel, bare])

  // Chat with source
  const handleChatWithSource = useCallback(() => {
    if (!detail) return
    if (onChatWithSourceOverride) {
      onChatWithSourceOverride({ id: detail.sourceId, title: detail.title, summary: detail.summary })
      return
    }
    const context = buildSourceChatContext({
      id: detail.sourceId,
      title: detail.title,
      summary: detail.summary,
    })
    navigate('/ask', { state: { chatContext: context } })
  }, [detail, navigate, onChatWithSourceOverride])

  // Compare with ALL related sources
  const handleCompareWithSources = useCallback(() => {
    if (!detail || detail.relatedSources.length === 0) return
    const primary = { id: detail.sourceId, title: detail.title }
    const related = detail.relatedSources.map(rs => ({ id: rs.sourceId, title: rs.title }))
    if (onCompareWithSourcesOverride) {
      onCompareWithSourcesOverride(primary, related)
      return
    }
    const context = buildMultiSourceCompareContext(primary, related)
    navigate('/ask', { state: { chatContext: context } })
  }, [detail, navigate, onCompareWithSourcesOverride])

  const content = loading ? (
    <div className="flex items-center justify-center flex-1">
      <Loader2 size={20} style={{ color: 'var(--color-text-secondary)', animation: 'spin 1s linear infinite' }} />
    </div>
  ) : !detail ? (
    <div className="flex items-center justify-center flex-1">
      <span className="font-body" style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>Source not found</span>
    </div>
  ) : (
    <CardContent
      detail={detail}
      onClose={onClose}
      onNavigateToSource={onNavigateToSource}
      onChatWithSource={handleChatWithSource}
      onCompareWithSources={handleCompareWithSources}
    />
  )

  if (bare) {
    return <div className="flex flex-col h-full" style={{ overflowY: 'auto', overflowX: 'hidden' }}>{content}</div>
  }

  return (
    <div
      ref={panelRef}
      data-panel
      style={{
        position: 'absolute', top: 0, right: 0, bottom: 0, width: PANEL_WIDTH,
        background: 'rgba(255,255,255,0.97)', backdropFilter: 'blur(20px)',
        borderLeft: '1px solid var(--border-subtle)', boxShadow: '-4px 0 24px rgba(0,0,0,0.06)',
        zIndex: 40, display: 'flex', flexDirection: 'column',
        overflowY: 'auto', overflowX: 'hidden',
        animation: 'slideInRight 0.2s ease',
      }}
      onClick={e => e.stopPropagation()}
    >
      {content}
    </div>
  )
}

// ─── Card Content ─────────────────────────────────────────────────────────────

function CardContent({
  detail,
  onClose,
  onNavigateToSource,
  onChatWithSource,
  onCompareWithSources,
}: {
  detail: SourceCardDetail
  onClose: () => void
  onNavigateToSource: (sourceId: string) => void
  onChatWithSource: () => void
  onCompareWithSources: () => void
}) {
  const cfg = getSourceConfig(detail.sourceType)
  const [showAllEntities, setShowAllEntities] = useState(false)
  const [showAllConnections, setShowAllConnections] = useState(false)
  const [showAllRelated, setShowAllRelated] = useState(false)

  const visibleEntities = showAllEntities ? detail.entities : detail.entities.slice(0, DEFAULT_VISIBLE)
  const visibleConnections = showAllConnections ? detail.connections : detail.connections.slice(0, DEFAULT_VISIBLE)
  const visibleRelated = showAllRelated ? detail.relatedSources : detail.relatedSources.slice(0, DEFAULT_VISIBLE)

  const linkLabel = detail.sourceUrl ? getLinkLabel(detail.sourceType, detail.sourceUrl, detail.provider) : null
  const youtubeVideoId = detail.sourceType === 'YouTube' && detail.sourceUrl
    ? extractYouTubeVideoId(detail.sourceUrl)
    : null
  // Start with maxresdefault (HD, 1280x720, 16:9). If the video has no HD thumb,
  // the <img onError> below swaps to hqdefault (480x360, letterbox cropped by object-fit: cover).
  const [thumbSrc, setThumbSrc] = useState<string | null>(null)
  useEffect(() => {
    setThumbSrc(youtubeVideoId ? `https://img.youtube.com/vi/${youtubeVideoId}/maxresdefault.jpg` : null)
  }, [youtubeVideoId])
  const handleThumbError = () => {
    if (!youtubeVideoId) return
    const hqFallback = `https://img.youtube.com/vi/${youtubeVideoId}/hqdefault.jpg`
    if (thumbSrc !== hqFallback) setThumbSrc(hqFallback)
  }

  return (
    <>
      {/* YouTube thumbnail banner — clickable, opens the video */}
      {thumbSrc && detail.sourceUrl && (
        <a
          href={detail.sourceUrl}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            display: 'block',
            margin: '10px 16px 0',
            maxWidth: 280,
            marginLeft: 'auto',
            marginRight: 'auto',
            width: 'calc(100% - 32px)',
            borderRadius: 10,
            overflow: 'hidden',
            position: 'relative',
            aspectRatio: '16 / 9',
            background: '#000',
            textDecoration: 'none',
            flexShrink: 0,
          }}
        >
          <img
            src={thumbSrc}
            alt=""
            loading="lazy"
            onError={handleThumbError}
            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
          />
          <div
            style={{
              position: 'absolute', inset: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: 'linear-gradient(to bottom, rgba(0,0,0,0) 45%, rgba(0,0,0,0.35) 100%)',
            }}
          >
            <img
              src="/logos/youtube.svg"
              alt="YouTube"
              style={{
                width: 54,
                height: 'auto',
                filter: 'drop-shadow(0 2px 8px rgba(0,0,0,0.4))',
                pointerEvents: 'none',
              }}
            />
          </div>
          {/* Subtle "click to open" badge */}
          <span style={{
            position: 'absolute', bottom: 8, right: 8,
            padding: '3px 8px', borderRadius: 999,
            background: 'rgba(0,0,0,0.7)', color: '#fff',
            fontFamily: 'var(--font-body)',
            fontSize: 9, fontWeight: 600, letterSpacing: '0.04em',
            display: 'inline-flex', alignItems: 'center', gap: 4,
            pointerEvents: 'none',
          }}>
            Watch on YouTube
            <ExternalLink size={9} />
          </span>
        </a>
      )}

      {/* Header — matches EntityDetailCard */}
      <div style={{ padding: '16px 16px 12px', borderBottom: '1px solid var(--border-subtle)', flexShrink: 0 }}>
        <div className="flex items-center justify-between" style={{ marginBottom: 8 }}>
          <div className="flex items-center gap-2" style={{ minWidth: 0 }}>
            <span style={{
              width: 28, height: 28, borderRadius: 7,
              background: detail.sourceType === 'YouTube' ? 'transparent' : `${cfg.color}14`,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 14, flexShrink: 0,
            }}>
              {detail.sourceType === 'YouTube'
                ? <img src="/logos/youtube.svg" alt="YouTube" style={{ width: 22, height: 'auto' }}/>
                : cfg.icon}
            </span>
            <span className="font-display" style={{ fontSize: 14, fontWeight: 700, color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {detail.title}
            </span>
          </div>
          <button type="button" onClick={onClose} className="flex items-center justify-center cursor-pointer"
            style={{ width: 24, height: 24, borderRadius: 6, background: 'transparent', border: '1px solid var(--border-subtle)', color: 'var(--color-text-secondary)', flexShrink: 0 }}>
            <X size={12} />
          </button>
        </div>

        {/* Meta row — type badge + relative time + all stats inline */}
        <div className="flex items-center flex-wrap" style={{ gap: '4px 8px', marginBottom: 8 }}>
          <span className="font-body" style={{
            fontSize: 9.5, fontWeight: 600, padding: '1px 7px', borderRadius: 3,
            color: cfg.color, background: `${cfg.color}10`, border: `1px solid ${cfg.color}20`,
          }}>
            {detail.sourceType}
          </span>
          <span className="font-body" style={{ fontSize: 10.5, color: 'var(--color-text-secondary)' }}>
            {formatRelativeTime(detail.createdAt)}
          </span>
          <InlineStat n={detail.entities.length} label="entities" />
          <InlineStat n={detail.connections.length} label="connections" />
          <InlineStat n={detail.relatedSources.length} label="related" />
        </div>

        {/* Summary */}
        {detail.summary && (
          <p className="font-body" style={{ fontSize: 11, color: 'var(--color-text-secondary)', lineHeight: 1.45, margin: 0 }}>
            {(() => {
              const text = formatSourceSummary(detail.summary)
              return text.length > 180 ? text.slice(0, 177) + '…' : text
            })()}
          </p>
        )}
      </div>

      {/* Anchor chips */}
      {detail.anchorLabels.length > 0 && (
        <div style={{ padding: '8px 16px', borderBottom: '1px solid var(--border-subtle)', flexShrink: 0 }}>
          <div className="flex items-center flex-wrap" style={{ gap: '4px 6px' }}>
            <span className="font-display" style={{ fontSize: 8, fontWeight: 700, letterSpacing: '0.07em', color: '#b45309', textTransform: 'uppercase', flexShrink: 0 }}>
              Anchors
            </span>
            {detail.anchorLabels.map(label => (
              <span key={label} className="font-body" style={{
                fontSize: 9, fontWeight: 600, padding: '1px 7px', borderRadius: 12,
                border: '1px solid rgba(180,83,9,0.25)', background: 'rgba(180,83,9,0.07)', color: '#b45309', whiteSpace: 'nowrap',
              }}>
                {label}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Action buttons — Chat + Compare on one row */}
      <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--border-subtle)', flexShrink: 0, display: 'flex', gap: 6 }}>
        <button type="button" onClick={onChatWithSource}
          className="flex items-center justify-center gap-1.5 font-body cursor-pointer"
          style={{ flex: 1, fontSize: 11.5, fontWeight: 600, color: 'var(--color-accent-500)', background: 'var(--color-accent-50)', border: '1px solid rgba(214,58,0,0.15)', borderRadius: 8, padding: '7px 8px', transition: 'background 0.12s ease' }}>
          <Sparkles size={12} />
          Chat with source
        </button>
        {detail.relatedSources.length > 0 && (
          <button type="button" onClick={onCompareWithSources}
            className="flex items-center justify-center gap-1.5 font-body cursor-pointer"
            style={{ flex: 1, fontSize: 11.5, fontWeight: 600, color: 'var(--color-text-secondary)', background: 'var(--color-bg-inset)', border: '1px solid var(--border-subtle)', borderRadius: 8, padding: '7px 8px', transition: 'background 0.12s ease' }}>
            <MessageCircle size={12} />
            Compare related
          </button>
        )}
      </div>

      {/* "Open on X" link row — only when the source has a URL AND there's no
          clickable YouTube thumbnail already (the thumbnail is the CTA for YouTube). */}
      {detail.sourceUrl && linkLabel && !thumbSrc && (
        <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--border-subtle)', flexShrink: 0 }}>
          <a
            href={detail.sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 w-full font-body"
            style={{
              fontSize: 11, fontWeight: 600,
              color: 'var(--color-text-secondary)',
              background: 'var(--color-bg-inset)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 8,
              padding: '7px 10px',
              textDecoration: 'none',
              transition: 'background 0.12s ease',
            }}
          >
            <ExternalLink size={12} />
            <span style={{ flex: 1, textAlign: 'left' }}>{linkLabel.label}</span>
            <span
              style={{
                fontFamily: 'var(--font-mono, "JetBrains Mono", monospace)',
                fontSize: 10, fontWeight: 500,
                color: 'var(--color-text-placeholder)',
                letterSpacing: '0.02em',
              }}
            >
              {linkLabel.hostname}
            </span>
          </a>
        </div>
      )}

      {/* Content sections — no inner scroll; outer card scrolls the whole thing */}
      <div>

        {/* Entities */}
        {detail.entities.length > 0 && (
          <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--border-subtle)' }}>
            <SectionLabel>Top entities ({detail.entities.length})</SectionLabel>
            <div className="flex flex-col" style={{ gap: 3 }}>
              {visibleEntities.map(e => {
                const color = getEntityColor(e.entityType)
                return (
                  <div key={e.id} className="flex items-center gap-2" style={{
                    padding: '4px 8px', borderRadius: 6, background: 'rgba(255,255,255,0.6)', border: '1px solid var(--border-subtle)',
                  }}>
                    <span style={{ width: 6, height: 6, borderRadius: '50%', background: `${color}22`, border: `1.5px solid ${color}`, flexShrink: 0 }} />
                    <span className="font-body" style={{ fontSize: 10, fontWeight: 600, color: 'var(--color-text-primary)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {e.label}
                    </span>
                    <span className="font-body" style={{ fontSize: 7, fontWeight: 600, padding: '0px 4px', borderRadius: 2, color, background: `${color}10`, flexShrink: 0 }}>
                      {e.entityType}
                    </span>
                    {e.isAnchor && (
                      <span className="font-body" style={{ fontSize: 7, fontWeight: 600, padding: '0px 4px', borderRadius: 2, color: '#b45309', background: 'rgba(180,83,9,0.08)', flexShrink: 0 }}>
                        Anchor
                      </span>
                    )}
                  </div>
                )
              })}
            </div>
            {detail.entities.length > DEFAULT_VISIBLE && (
              <button type="button" onClick={() => setShowAllEntities(!showAllEntities)} className="font-body cursor-pointer"
                style={{ fontSize: 9, fontWeight: 600, color: 'var(--color-accent-500)', background: 'none', border: 'none', padding: '6px 0 0' }}>
                {showAllEntities ? `Show top ${DEFAULT_VISIBLE}` : `Show all ${detail.entities.length}`}
              </button>
            )}
          </div>
        )}

        {/* Connections */}
        {detail.connections.length > 0 && (
          <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--border-subtle)' }}>
            <SectionLabel>Top connections ({detail.connections.length})</SectionLabel>
            <div className="flex flex-col" style={{ gap: 3 }}>
              {visibleConnections.map(c => (
                <ConnectionRow key={c.id} from={c.fromLabel} fromType={c.fromEntityType} to={c.toLabel} toType={c.toEntityType} relation={c.relationType} />
              ))}
            </div>
            {detail.connections.length > DEFAULT_VISIBLE && (
              <button type="button" onClick={() => setShowAllConnections(!showAllConnections)} className="font-body cursor-pointer"
                style={{ fontSize: 9, fontWeight: 600, color: 'var(--color-accent-500)', background: 'none', border: 'none', padding: '6px 0 0' }}>
                {showAllConnections ? `Show top ${DEFAULT_VISIBLE}` : `Show all ${detail.connections.length}`}
              </button>
            )}
          </div>
        )}

        {/* Related Sources */}
        {detail.relatedSources.length > 0 && (
          <div style={{ padding: '10px 16px' }}>
            <SectionLabel>Related sources ({detail.relatedSources.length})</SectionLabel>
            <div className="flex flex-col" style={{ gap: 2 }}>
              {visibleRelated.map(rs => (
                <RelatedSourceRow key={rs.sourceId} rs={rs} onNavigate={() => onNavigateToSource(rs.sourceId)} />
              ))}
            </div>
            {detail.relatedSources.length > DEFAULT_VISIBLE && (
              <button type="button" onClick={() => setShowAllRelated(!showAllRelated)} className="font-body cursor-pointer"
                style={{ fontSize: 9, fontWeight: 600, color: 'var(--color-accent-500)', background: 'none', border: 'none', padding: '6px 0 0' }}>
                {showAllRelated ? `Show top ${DEFAULT_VISIBLE}` : `Show all ${detail.relatedSources.length}`}
              </button>
            )}
          </div>
        )}
      </div>
    </>
  )
}

// ─── Sub-components ─────────────────────────────────────────────────────────────

/** Inline stat chip for the meta row: bold number + muted label. */
function InlineStat({ n, label }: { n: number; label: string }) {
  return (
    <span className="font-body" style={{ fontSize: 10.5, color: 'var(--color-text-secondary)', whiteSpace: 'nowrap' }}>
      <span style={{ fontWeight: 700, color: 'var(--color-text-primary)' }}>{n.toLocaleString()}</span>{' '}
      {label}
    </span>
  )
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="font-display" style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--color-text-secondary)', display: 'block', marginBottom: 6 }}>
      {children}
    </span>
  )
}

function RelatedSourceRow({ rs, onNavigate }: { rs: SourceCardRelatedSource; onNavigate: () => void }) {
  const [expanded, setExpanded] = useState(false)
  const rsCfg = getSourceConfig(rs.sourceType)
  const hasConnections = rs.crossConnections.length > 0

  return (
    <div style={{ borderRadius: 6, overflow: 'hidden' }}>
      <div className="flex items-center gap-2 font-body" style={{
        padding: '5px 8px', fontSize: 11,
        background: expanded ? 'var(--color-bg-inset)' : 'none',
        borderRadius: expanded ? '6px 6px 0 0' : 6,
        border: '1px solid var(--border-subtle)',
      }}>
        {hasConnections && (
          <button type="button" onClick={() => setExpanded(!expanded)} className="cursor-pointer flex items-center justify-center"
            style={{ width: 16, height: 16, borderRadius: 4, background: 'none', border: 'none', color: 'var(--color-text-secondary)', flexShrink: 0, padding: 0 }}>
            {expanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
          </button>
        )}
        {!hasConnections && <span style={{ width: 16, flexShrink: 0 }} />}
        <span style={{ width: 18, height: 18, borderRadius: 4, background: `${rsCfg.color}14`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 9, flexShrink: 0 }}>
          {rsCfg.icon}
        </span>
        <span className="flex-1" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 500, color: 'var(--color-text-body)', fontSize: 10 }}>
          {rs.title}
        </span>
        <span style={{ fontSize: 8, fontWeight: 600, color: 'var(--color-text-secondary)', background: 'var(--color-bg-inset)', padding: '1px 5px', borderRadius: 3, flexShrink: 0 }}>
          {rs.sharedEntityCount} shared
        </span>
        <button type="button" onClick={onNavigate} className="cursor-pointer flex items-center justify-center"
          style={{ width: 18, height: 18, borderRadius: 4, background: 'none', border: 'none', color: 'var(--color-accent-500)', flexShrink: 0, padding: 0 }}>
          <ArrowRight size={10} />
        </button>
      </div>
      {expanded && hasConnections && (
        <div style={{ padding: '4px 8px 8px 42px', background: 'var(--color-bg-inset)', borderRadius: '0 0 6px 6px', border: '1px solid var(--border-subtle)', borderTop: 'none' }}>
          <div className="flex flex-col" style={{ gap: 3 }}>
            {rs.crossConnections.slice(0, 6).map(cc => (
              <ConnectionRow key={cc.id} from={cc.localLabel} fromType={cc.localEntityType} to={cc.remoteLabel} toType={cc.remoteEntityType} relation={cc.relationType} />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function ConnectionRow({ from, fromType, to, toType, relation }: {
  from: string; fromType: string; to: string; toType: string; relation: string
}) {
  return (
    <div className="flex items-center font-body" style={{
      fontSize: 10, gap: 4, padding: '3px 7px', borderRadius: 5,
      background: 'rgba(255,255,255,0.6)', border: '1px solid var(--border-subtle)',
    }}>
      <span style={{ color: getEntityColor(fromType), fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 90 }}>{from}</span>
      <Link2 size={8} style={{ color: 'var(--color-text-placeholder)', flexShrink: 0 }} />
      <span style={{ color: 'var(--color-text-secondary)', fontSize: 8, fontStyle: 'italic', flexShrink: 0 }}>{relation.replace(/_/g, ' ')}</span>
      <ArrowRight size={8} style={{ color: 'var(--color-text-placeholder)', flexShrink: 0 }} />
      <span style={{ color: getEntityColor(toType), fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{to}</span>
    </div>
  )
}
