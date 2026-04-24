import { useState, useEffect } from 'react'
import { X, ChevronRight, ArrowRight, ExternalLink, Play } from 'lucide-react'
import { getSourceConfig } from '../../config/sourceTypes'
import { getEntityColor } from '../../config/entityTypes'
import { useAuth } from '../../hooks/useAuth'
import { fetchSourceEntities, fetchSourceLink } from '../../services/exploreQueries'
import type { SourceNode, SourceEdge } from '../../types/explore'
import type { SourceEntityBadge } from '../../services/exploreQueries'

/** Pull a YouTube video id from any watch / shorts / youtu.be variant. */
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

/** Friendly label + hostname for the "open source" row. */
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

interface SourceDetailPanelProps {
  source: SourceNode
  allSources: SourceNode[]
  sourceEdges: SourceEdge[]
  onNavigateToSource: (sourceId: string) => void
  onPivotToEntity: (entityId: string) => void
  onViewInEntityGraph: () => void
  onClose: () => void
}

export function SourceDetailPanel({
  source,
  allSources,
  sourceEdges,
  onNavigateToSource,
  onPivotToEntity,
  onViewInEntityGraph,
  onClose,
}: SourceDetailPanelProps) {
  const { user } = useAuth()
  const cfg = getSourceConfig(source.sourceType)

  // Fetch extracted entities
  const [entities, setEntities] = useState<SourceEntityBadge[]>([])
  useEffect(() => {
    if (!user) return
    let cancelled = false
    fetchSourceEntities(user.id, source.entityIds)
      .then(data => { if (!cancelled) setEntities(data) })
      .catch(err => console.warn('fetchSourceEntities error:', err))
    return () => { cancelled = true }
  }, [user, source.entityIds])

  // Fetch the original URL for this source (YouTube / meeting permalink / etc.)
  const [link, setLink] = useState<{ sourceUrl: string | null; provider: string | null }>({
    sourceUrl: null, provider: null,
  })
  useEffect(() => {
    if (!user) return
    let cancelled = false
    setLink({ sourceUrl: null, provider: null })
    fetchSourceLink(user.id, source.id)
      .then(data => { if (!cancelled) setLink(data) })
      .catch(err => console.warn('fetchSourceLink error:', err))
    return () => { cancelled = true }
  }, [user, source.id])

  const linkLabel = link.sourceUrl ? getLinkLabel(source.sourceType, link.sourceUrl, link.provider) : null
  const youtubeVideoId = source.sourceType === 'YouTube' && link.sourceUrl
    ? extractYouTubeVideoId(link.sourceUrl)
    : null
  const thumbnailUrl = youtubeVideoId
    ? `https://img.youtube.com/vi/${youtubeVideoId}/mqdefault.jpg`
    : null

  // Connected sources
  const connectedSources = sourceEdges
    .filter(e => e.fromSourceId === source.id || e.toSourceId === source.id)
    .map(e => {
      const otherId = e.fromSourceId === source.id ? e.toSourceId : e.fromSourceId
      const other = allSources.find(s => s.id === otherId)
      if (!other) return null
      return { source: other, sharedCount: e.totalWeight }
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .sort((a, b) => b.sharedCount - a.sharedCount)

  const date = new Date(source.createdAt).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })

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

      {/* 0. YouTube thumbnail banner — clickable, opens the video */}
      {thumbnailUrl && link.sourceUrl && (
        <a
          href={link.sourceUrl}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            display: 'block',
            marginBottom: 14,
            borderRadius: 10,
            overflow: 'hidden',
            position: 'relative',
            aspectRatio: '16 / 9',
            background: '#000',
            textDecoration: 'none',
            boxShadow: '0 2px 12px -4px rgba(0,0,0,0.15)',
          }}
        >
          <img
            src={thumbnailUrl}
            alt=""
            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
          />
          <div
            style={{
              position: 'absolute', inset: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: 'linear-gradient(to bottom, rgba(0,0,0,0) 40%, rgba(0,0,0,0.35) 100%)',
              transition: 'background 0.15s ease',
            }}
          >
            <div
              style={{
                width: 48, height: 48, borderRadius: '50%',
                background: 'rgba(214,58,0,0.92)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                boxShadow: '0 2px 10px rgba(0,0,0,0.3)',
              }}
            >
              <Play size={20} color="#fff" fill="#fff" style={{ marginLeft: 2 }} />
            </div>
          </div>
        </a>
      )}

      {/* 1. Header */}
      <div className="flex items-center gap-3" style={{ marginBottom: 8 }}>
        <span
          style={{
            width: 32,
            height: 32,
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
        <span
          style={{
            fontFamily: 'var(--font-display)',
            fontSize: 16,
            fontWeight: 700,
            color: 'var(--color-text-primary)',
            flex: 1,
          }}
        >
          {source.title}
        </span>
      </div>
      <span
        style={{
          fontFamily: 'var(--font-body)',
          fontSize: 11,
          color: 'var(--color-text-secondary)',
          marginBottom: 16,
          display: 'block',
        }}
      >
        {source.sourceType} · {date}
      </span>

      {/* 2. Stats */}
      <div className="flex gap-4" style={{ marginBottom: 20 }}>
        <StatBlock label="Entities" value={source.entityCount} />
        <StatBlock label="Connected" value={connectedSources.length} />
      </div>

      {/* 3. Extracted Entities */}
      {entities.length > 0 && (
        <>
          <SectionLabel>EXTRACTED ENTITIES</SectionLabel>
          <div className="flex flex-wrap gap-1.5" style={{ marginBottom: 20 }}>
            {entities.map(e => (
              <button
                key={e.id}
                type="button"
                onClick={() => onPivotToEntity(e.id)}
                className="flex items-center gap-1.5 cursor-pointer font-body"
                style={{
                  padding: '3px 8px',
                  fontSize: 10,
                  fontWeight: 500,
                  borderRadius: 6,
                  border: 'none',
                  background: `${getEntityColor(e.entityType)}14`,
                  color: getEntityColor(e.entityType),
                  transition: 'background 0.1s ease',
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
              </button>
            ))}
          </div>
        </>
      )}

      {/* 4. Connected Sources */}
      {connectedSources.length > 0 && (
        <>
          <SectionLabel>CONNECTED SOURCES ({connectedSources.length})</SectionLabel>
          <div className="flex flex-col gap-1" style={{ marginBottom: 20 }}>
            {connectedSources.map(({ source: other, sharedCount }) => {
              const otherCfg = getSourceConfig(other.sourceType)
              return (
                <button
                  key={other.id}
                  type="button"
                  onClick={() => onNavigateToSource(other.id)}
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
                      width: 22,
                      height: 22,
                      borderRadius: 5,
                      background: `${otherCfg.color}14`,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: 11,
                      flexShrink: 0,
                    }}
                  >
                    {otherCfg.icon}
                  </span>
                  <span className="flex-1" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {other.title}
                  </span>
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
                    {sharedCount} shared
                  </span>
                  <ChevronRight size={10} style={{ color: 'var(--color-text-placeholder)', flexShrink: 0 }} />
                </button>
              )
            })}
          </div>
        </>
      )}

      {/* 5. Actions */}
      <SectionLabel>ACTIONS</SectionLabel>
      <div className="flex flex-col gap-2">
        <button
          type="button"
          onClick={onViewInEntityGraph}
          className="flex items-center gap-2 w-full cursor-pointer font-body"
          style={{
            padding: '8px 12px',
            fontSize: 12,
            fontWeight: 500,
            borderRadius: 8,
            border: 'none',
            background: 'var(--color-accent-50)',
            color: 'var(--color-accent-500)',
            textAlign: 'left',
            transition: 'background 0.1s ease',
          }}
        >
          <ArrowRight size={13} />
          View in entity graph
        </button>
        {link.sourceUrl && linkLabel && (
          <a
            href={link.sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 w-full font-body"
            style={{
              padding: '8px 12px',
              fontSize: 12,
              fontWeight: 500,
              borderRadius: 8,
              border: '1px solid var(--border-subtle)',
              background: 'var(--color-bg-card)',
              color: 'var(--color-text-body)',
              textAlign: 'left',
              textDecoration: 'none',
              transition: 'background 0.1s ease, border-color 0.1s ease',
            }}
          >
            <ExternalLink size={13} />
            <span style={{ flex: 1 }}>{linkLabel.label}</span>
            <span
              style={{
                fontFamily: 'var(--font-mono, "JetBrains Mono", monospace)',
                fontSize: 10,
                color: 'var(--color-text-placeholder)',
                letterSpacing: '0.02em',
              }}
            >
              {linkLabel.hostname}
            </span>
          </a>
        )}
        <button
          type="button"
          className="flex items-center gap-2 w-full cursor-pointer font-body"
          style={{
            padding: '8px 12px',
            fontSize: 12,
            fontWeight: 500,
            borderRadius: 8,
            border: 'none',
            background: 'var(--color-bg-inset)',
            color: 'var(--color-text-body)',
            textAlign: 'left',
            opacity: 0.5,
            cursor: 'default',
          }}
          disabled
        >
          Re-extract
        </button>
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

function StatBlock({ label, value }: { label: string; value: number }) {
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
    </div>
  )
}
