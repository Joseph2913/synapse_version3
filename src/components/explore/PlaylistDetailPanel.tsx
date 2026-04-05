import { useState, useRef, useEffect, useCallback } from 'react'
import { X, ChevronRight, ChevronDown, ListMusic, Link2, ExternalLink } from 'lucide-react'
import type { PlaylistNode, PlaylistEdge, PlaylistVideoNode, PlaylistVideoEdge } from '../../types/explore'

interface PlaylistDetailPanelProps {
  playlist: PlaylistNode
  playlists: PlaylistNode[]
  playlistEdges: PlaylistEdge[]
  videos: PlaylistVideoNode[]
  videoEdges: PlaylistVideoEdge[]
  playlistColorMap: Map<string, string>
  onClose: () => void
  onNavigateToPlaylist: (playlistId: string) => void
  onNavigateToVideo: (sourceId: string) => void
}

const PANEL_WIDTH = 370
const DEFAULT_VISIBLE = 6

export function PlaylistDetailPanel({
  playlist,
  playlists,
  playlistEdges,
  videos,
  videoEdges,
  playlistColorMap,
  onClose,
  onNavigateToPlaylist,
  onNavigateToVideo,
}: PlaylistDetailPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null)

  const handleWheel = useCallback((e: WheelEvent) => { e.stopPropagation() }, [])

  useEffect(() => {
    const el = panelRef.current
    if (!el) return
    el.addEventListener('wheel', handleWheel, { passive: false })
    return () => el.removeEventListener('wheel', handleWheel)
  }, [handleWheel])

  const color = playlistColorMap.get(playlist.id) ?? '#d63a00'

  // Videos in this playlist
  const playlistVideos = videos.filter(v => v.playlistId === playlist.id)
  const totalEntities = playlistVideos.reduce((sum, v) => sum + v.entityCount, 0)

  // Connected playlists
  const connectedPlaylists = playlistEdges
    .filter(e => e.fromPlaylistId === playlist.id || e.toPlaylistId === playlist.id)
    .map(e => {
      const otherId = e.fromPlaylistId === playlist.id ? e.toPlaylistId : e.fromPlaylistId
      const other = playlists.find(p => p.id === otherId)
      if (!other) return null
      return {
        playlist: other,
        connectionCount: e.connectionCount,
        videoPairCount: e.videoPairCount,
        color: playlistColorMap.get(otherId) ?? '#94a3b8',
      }
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .sort((a, b) => b.connectionCount - a.connectionCount)

  // Video-level cross-connections: for each connected playlist, which videos connect
  const videoConnectionsByPlaylist = connectedPlaylists.map(cp => {
    const thisSourceIds = new Set(playlistVideos.map(v => v.sourceId))
    const otherVideos = videos.filter(v => v.playlistId === cp.playlist.id)
    const otherSourceIds = new Set(otherVideos.map(v => v.sourceId))

    const relevantEdges = videoEdges.filter(e =>
      (thisSourceIds.has(e.fromSourceId) && otherSourceIds.has(e.toSourceId)) ||
      (otherSourceIds.has(e.fromSourceId) && thisSourceIds.has(e.toSourceId))
    )

    // Group by video pairs
    const videoPairs = relevantEdges.map(e => {
      const thisSourceId = thisSourceIds.has(e.fromSourceId) ? e.fromSourceId : e.toSourceId
      const otherSourceId = thisSourceIds.has(e.fromSourceId) ? e.toSourceId : e.fromSourceId
      const thisVideo = playlistVideos.find(v => v.sourceId === thisSourceId)
      const otherVideo = otherVideos.find(v => v.sourceId === otherSourceId)
      return thisVideo && otherVideo ? {
        thisVideo,
        otherVideo,
        sharedEntityCount: e.sharedEntityCount,
      } : null
    }).filter((x): x is NonNullable<typeof x> => x !== null)
      .sort((a, b) => b.sharedEntityCount - a.sharedEntityCount)

    return { ...cp, videoPairs }
  })

  return (
    <div
      ref={panelRef}
      style={{
        position: 'absolute', top: 0, right: 0, bottom: 0, width: PANEL_WIDTH,
        background: 'rgba(255,255,255,0.97)', backdropFilter: 'blur(20px)',
        borderLeft: '1px solid var(--border-subtle)', boxShadow: '-4px 0 24px rgba(0,0,0,0.06)',
        zIndex: 40, display: 'flex', flexDirection: 'column',
        animation: 'slideInRight 0.2s ease',
      }}
      onClick={e => e.stopPropagation()}
    >
      {/* Header */}
      <div style={{ padding: '16px 16px 12px', borderBottom: '1px solid var(--border-subtle)', flexShrink: 0 }}>
        <div className="flex items-center justify-between" style={{ marginBottom: 8 }}>
          <div className="flex items-center gap-2" style={{ minWidth: 0 }}>
            <span style={{
              width: 28, height: 28, borderRadius: 7,
              background: `${color}14`, display: 'flex', alignItems: 'center', justifyContent: 'center',
              flexShrink: 0,
            }}>
              <ListMusic size={14} style={{ color }} />
            </span>
            <span className="font-display" style={{ fontSize: 14, fontWeight: 700, color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {playlist.playlistName}
            </span>
          </div>
          <button type="button" onClick={onClose} className="flex items-center justify-center cursor-pointer"
            style={{ width: 24, height: 24, borderRadius: 6, background: 'transparent', border: '1px solid var(--border-subtle)', color: 'var(--color-text-secondary)', flexShrink: 0 }}>
            <X size={12} />
          </button>
        </div>

        {/* Status + code */}
        <div className="flex items-center gap-2" style={{ marginBottom: 6 }}>
          <span className="font-body" style={{
            fontSize: 9, fontWeight: 600, padding: '1px 6px', borderRadius: 3,
            color: playlist.isActive ? '#059669' : '#94a3b8',
            background: playlist.isActive ? 'rgba(5,150,105,0.08)' : 'rgba(148,163,184,0.08)',
            border: `1px solid ${playlist.isActive ? 'rgba(5,150,105,0.2)' : 'rgba(148,163,184,0.2)'}`,
          }}>
            {playlist.isActive ? 'Active' : 'Paused'}
          </span>
          {playlist.synapseCode && (
            <span className="font-body" style={{ fontSize: 10, color: 'var(--color-text-placeholder)' }}>
              {playlist.synapseCode}
            </span>
          )}
          {playlist.playlistUrl && (
            <a
              href={playlist.playlistUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1"
              style={{ fontSize: 10, color: 'var(--color-accent-500)', textDecoration: 'none' }}
            >
              <ExternalLink size={9} />
              <span className="font-body" style={{ fontWeight: 500 }}>YouTube</span>
            </a>
          )}
        </div>
      </div>

      {/* Summary stats */}
      <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--border-subtle)', display: 'flex', gap: 12, flexShrink: 0 }}>
        <StatBlock label="Videos" value={playlistVideos.length} />
        <StatBlock label="Entities" value={totalEntities} />
        <StatBlock label="Connected playlists" value={connectedPlaylists.length} />
      </div>

      {/* Scrollable content */}
      <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden' }}>

        {/* Connected playlists section */}
        {videoConnectionsByPlaylist.length > 0 && (
          <Section title="Cross-Playlist Connections" count={connectedPlaylists.length}>
            {videoConnectionsByPlaylist.map(cp => (
              <ConnectedPlaylistRow
                key={cp.playlist.id}
                connectedPlaylist={cp.playlist}
                connectionCount={cp.connectionCount}
                videoPairCount={cp.videoPairCount}
                color={cp.color}
                videoPairs={cp.videoPairs}
                onNavigateToPlaylist={onNavigateToPlaylist}
                onNavigateToVideo={onNavigateToVideo}
              />
            ))}
          </Section>
        )}

        {/* Videos in this playlist */}
        <VideoListSection
          title="Videos"
          videos={playlistVideos}
          color={color}
          onNavigateToVideo={onNavigateToVideo}
        />

      </div>
    </div>
  )
}

// ─── Sub-components ──────────────────────────────────────────────────────────

function StatBlock({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex flex-col">
      <span className="font-display" style={{ fontSize: 16, fontWeight: 700, color: 'var(--color-text-primary)', lineHeight: 1 }}>
        {value}
      </span>
      <span className="font-body" style={{ fontSize: 9, color: 'var(--color-text-secondary)', marginTop: 2 }}>
        {label}
      </span>
    </div>
  )
}

function Section({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  return (
    <div style={{ borderBottom: '1px solid var(--border-subtle)' }}>
      <div style={{ padding: '10px 16px 4px' }}>
        <div className="flex items-center justify-between">
          <span className="font-display" style={{ fontSize: 10, fontWeight: 700, color: 'var(--color-text-primary)', letterSpacing: '0.03em', textTransform: 'uppercase' as const }}>
            {title}
          </span>
          <span className="font-body" style={{ fontSize: 9, color: 'var(--color-text-placeholder)' }}>
            {count}
          </span>
        </div>
      </div>
      <div style={{ padding: '4px 12px 10px' }}>
        {children}
      </div>
    </div>
  )
}

function ConnectedPlaylistRow({
  connectedPlaylist,
  connectionCount,
  videoPairCount,
  color,
  videoPairs,
  onNavigateToPlaylist,
  onNavigateToVideo,
}: {
  connectedPlaylist: PlaylistNode
  connectionCount: number
  videoPairCount: number
  color: string
  videoPairs: Array<{
    thisVideo: PlaylistVideoNode
    otherVideo: PlaylistVideoNode
    sharedEntityCount: number
  }>
  onNavigateToPlaylist: (playlistId: string) => void
  onNavigateToVideo: (sourceId: string) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const visiblePairs = expanded ? videoPairs : videoPairs.slice(0, 3)

  return (
    <div style={{ marginBottom: 4 }}>
      {/* Playlist header row */}
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 w-full cursor-pointer font-body"
        style={{
          padding: '6px 8px', borderRadius: 8,
          background: expanded ? `${color}06` : 'transparent',
          border: 'none', textAlign: 'left',
          transition: 'background 0.1s ease',
        }}
      >
        {expanded ? <ChevronDown size={11} style={{ color: 'var(--color-text-secondary)', flexShrink: 0 }} /> : <ChevronRight size={11} style={{ color: 'var(--color-text-secondary)', flexShrink: 0 }} />}
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: color, flexShrink: 0 }} />
        <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-primary)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {connectedPlaylist.playlistName}
        </span>
        <span className="flex items-center gap-1" style={{ flexShrink: 0 }}>
          <Link2 size={9} style={{ color: 'var(--color-text-placeholder)' }} />
          <span style={{ fontSize: 9, fontWeight: 600, color: 'var(--color-text-secondary)' }}>
            {connectionCount}
          </span>
        </span>
      </button>

      {/* Expanded: show video pairs */}
      {expanded && (
        <div style={{ paddingLeft: 22, paddingTop: 2, paddingBottom: 4 }}>
          {/* Summary line */}
          <div className="font-body" style={{ fontSize: 9, color: 'var(--color-text-placeholder)', marginBottom: 4 }}>
            {videoPairCount} video pair{videoPairCount !== 1 ? 's' : ''} connected · {connectionCount} entity connections
          </div>

          {/* Video pairs */}
          {visiblePairs.map((pair, i) => (
            <div key={i} style={{ marginBottom: 4 }}>
              <div className="flex items-center gap-1.5" style={{ fontSize: 10 }}>
                <button
                  type="button"
                  onClick={() => onNavigateToVideo(pair.thisVideo.sourceId)}
                  className="font-body cursor-pointer"
                  style={{
                    background: 'none', border: 'none', padding: 0,
                    color: 'var(--color-text-body)', fontWeight: 500,
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    maxWidth: 120, textAlign: 'left',
                  }}
                >
                  {pair.thisVideo.videoTitle.length > 28 ? pair.thisVideo.videoTitle.slice(0, 27) + '…' : pair.thisVideo.videoTitle}
                </button>
                <span style={{ color: 'var(--color-text-placeholder)', fontSize: 8, flexShrink: 0 }}>↔</span>
                <button
                  type="button"
                  onClick={() => onNavigateToVideo(pair.otherVideo.sourceId)}
                  className="font-body cursor-pointer"
                  style={{
                    background: 'none', border: 'none', padding: 0,
                    color: color, fontWeight: 500,
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    maxWidth: 120, textAlign: 'left',
                  }}
                >
                  {pair.otherVideo.videoTitle.length > 28 ? pair.otherVideo.videoTitle.slice(0, 27) + '…' : pair.otherVideo.videoTitle}
                </button>
              </div>
              <span className="font-body" style={{ fontSize: 8, color: 'var(--color-text-placeholder)', paddingLeft: 2 }}>
                {pair.sharedEntityCount} shared entities
              </span>
            </div>
          ))}

          {videoPairs.length > 3 && !expanded && (
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="font-body cursor-pointer"
              style={{ background: 'none', border: 'none', padding: 0, fontSize: 9, fontWeight: 600, color: 'var(--color-accent-500)' }}
            >
              +{videoPairs.length - 3} more
            </button>
          )}

          {/* Navigate to this playlist */}
          <button
            type="button"
            onClick={() => onNavigateToPlaylist(connectedPlaylist.id)}
            className="flex items-center gap-1 font-body cursor-pointer"
            style={{
              background: 'none', border: 'none', padding: '4px 0 0',
              fontSize: 9, fontWeight: 600, color: 'var(--color-accent-500)',
            }}
          >
            Explore playlist <ChevronRight size={9} />
          </button>
        </div>
      )}
    </div>
  )
}

function VideoListSection({
  title,
  videos,
  color,
  onNavigateToVideo,
}: {
  title: string
  videos: PlaylistVideoNode[]
  color: string
  onNavigateToVideo: (sourceId: string) => void
}) {
  const [showAll, setShowAll] = useState(false)
  const visible = showAll ? videos : videos.slice(0, DEFAULT_VISIBLE)

  return (
    <div style={{ borderBottom: '1px solid var(--border-subtle)' }}>
      <div style={{ padding: '10px 16px 4px' }}>
        <div className="flex items-center justify-between">
          <span className="font-display" style={{ fontSize: 10, fontWeight: 700, color: 'var(--color-text-primary)', letterSpacing: '0.03em', textTransform: 'uppercase' as const }}>
            {title}
          </span>
          <span className="font-body" style={{ fontSize: 9, color: 'var(--color-text-placeholder)' }}>
            {videos.length}
          </span>
        </div>
      </div>
      <div style={{ padding: '4px 12px 10px' }}>
        {visible.map(video => (
          <button
            key={video.sourceId}
            type="button"
            onClick={() => onNavigateToVideo(video.sourceId)}
            className="flex items-center gap-2 w-full cursor-pointer font-body"
            style={{
              padding: '5px 8px', borderRadius: 6,
              background: 'transparent', border: 'none', textAlign: 'left',
              transition: 'background 0.1s ease',
            }}
            onMouseOver={e => (e.currentTarget.style.background = `${color}06`)}
            onMouseOut={e => (e.currentTarget.style.background = 'transparent')}
          >
            {video.thumbnailUrl ? (
              <img
                src={video.thumbnailUrl}
                alt=""
                style={{ width: 36, height: 20, borderRadius: 3, objectFit: 'cover', flexShrink: 0 }}
              />
            ) : (
              <span style={{ width: 36, height: 20, borderRadius: 3, background: `${color}12`, flexShrink: 0 }} />
            )}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {video.videoTitle}
              </div>
              <div style={{ fontSize: 8, color: 'var(--color-text-placeholder)' }}>
                {video.entityCount} entities
                {video.publishedAt && ` · ${new Date(video.publishedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`}
              </div>
            </div>
          </button>
        ))}

        {videos.length > DEFAULT_VISIBLE && (
          <button
            type="button"
            onClick={() => setShowAll(!showAll)}
            className="font-body cursor-pointer"
            style={{
              background: 'none', border: 'none', padding: '4px 8px',
              fontSize: 9, fontWeight: 600, color: 'var(--color-accent-500)',
            }}
          >
            {showAll ? 'Show less' : `+${videos.length - DEFAULT_VISIBLE} more videos`}
          </button>
        )}
      </div>
    </div>
  )
}
