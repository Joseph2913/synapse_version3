import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { ListMusic, Loader2 } from 'lucide-react'
import { usePlaylistLayout } from '../../hooks/usePlaylistLayout'
import { useAuth } from '../../hooks/useAuth'
import { fetchPlaylistGraph, fetchSourceGraph } from '../../services/exploreQueries'
import { SourceDetailCard } from '../../components/explore/SourceDetailCard'
import { PlaylistDetailPanel } from '../../components/explore/PlaylistDetailPanel'
import { getSourceConfig } from '../../config/sourceTypes'
import type {
  PlaylistNode,
  PlaylistEdge,
  PlaylistVideoNode,
  PlaylistVideoEdge,
} from '../../types/explore'

const MIN_ZOOM = 0.08
const MAX_ZOOM = 6.0

const PLAYLIST_COLORS = [
  '#d63a00', '#2563eb', '#7c3aed', '#059669', '#d97706',
  '#dc2626', '#0891b2', '#4f46e5', '#16a34a', '#ea580c',
]

function getPlaylistColor(index: number): string {
  return PLAYLIST_COLORS[index % PLAYLIST_COLORS.length]!
}

// ─── Dynamic SVG icon paths based on playlist name keywords ──────────────────
// Each returns an SVG path `d` string sized for a 24x24 viewBox

interface PlaylistIconDef { path: string; viewBox?: string }

const PLAYLIST_ICON_KEYWORDS: [string[], PlaylistIconDef][] = [
  // AI / Tech
  [['ai', 'artificial intelligence', 'machine learning', 'claude', 'gpt', 'upskill'],
    { path: 'M12 2a2 2 0 0 1 2 2c0 .74-.4 1.39-1 1.73V7h1a7 7 0 0 1 7 7h1a1 1 0 0 1 0 2h-1.27a7 7 0 0 1-4.73 5.47V22a1 1 0 0 1-2 0v-.17a7.1 7.1 0 0 1-2 0V22a1 1 0 0 1-2 0v-.53A7 7 0 0 1 5.27 16H4a1 1 0 0 1 0-2h1a7 7 0 0 1 7-7h1V5.73A2 2 0 0 1 12 2m0 7a5 5 0 0 0-5 5 5 5 0 0 0 5 5 5 5 0 0 0 5-5 5 5 0 0 0-5-5m-1 2h2v3h3v2h-3v3h-2v-3H8v-2h3z' }], // Brain/chip
  // India / Geography / Countries
  [['india', 'geography', 'country', 'nation', 'geopolitical', 'global'],
    { path: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z' }], // Globe
  // Finance / Economics / Wealth
  [['finance', 'econ', 'wealth', 'invest', 'money', 'stock', 'crypto', 'bitcoin'],
    { path: 'M11.8 10.9c-2.27-.59-3-1.2-3-2.15 0-1.09 1.01-1.85 2.7-1.85 1.78 0 2.44.85 2.5 2.1h2.21c-.07-1.72-1.12-3.3-3.21-3.81V3h-3v2.16c-1.94.42-3.5 1.68-3.5 3.61 0 2.31 1.91 3.46 4.7 4.13 2.5.6 3 1.48 3 2.41 0 .69-.49 1.79-2.7 1.79-2.06 0-2.87-.92-2.98-2.1h-2.2c.12 2.19 1.76 3.42 3.68 3.83V21h3v-2.15c1.95-.37 3.5-1.5 3.5-3.55 0-2.84-2.43-3.81-4.7-4.4z' }], // Dollar
  // Design / Creative
  [['design', 'creative', 'ux', 'ui', 'art', 'visual'],
    { path: 'M12 22C6.49 22 2 17.51 2 12S6.49 2 12 2s10 4.04 10 9c0 3.31-2.69 6-6 6h-1.77c-.28 0-.5.22-.5.5 0 .12.05.23.13.33.41.47.64 1.06.64 1.67A2.5 2.5 0 0 1 12 22zm0-18c-4.41 0-8 3.59-8 8s3.59 8 8 8c.28 0 .5-.22.5-.5a.54.54 0 0 0-.14-.35c-.41-.46-.63-1.05-.63-1.65a2.5 2.5 0 0 1 2.5-2.5H16c2.21 0 4-1.79 4-4 0-3.86-3.59-7-8-7zM6.5 13a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm3-4a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm5 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm3 4a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3z' }], // Palette
  // Sports / Fitness
  [['sport', 'fitness', 'gym', 'workout', 'athletic', 'football', 'soccer', 'basketball', 'cricket'],
    { path: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zM5.61 16.78C4.6 15.45 4 13.8 4 12s.6-3.45 1.61-4.78a9.97 9.97 0 0 0 2.79 4.78 9.97 9.97 0 0 0-2.79 4.78zM12 20c-1.48 0-2.87-.41-4.06-1.12a7.98 7.98 0 0 1 3.06-4.63V18c0 .55.45 1 1 1s1-.45 1-1v-3.75a7.98 7.98 0 0 1 3.06 4.63A7.93 7.93 0 0 1 12 20zm0-8a3 3 0 1 1 0-6 3 3 0 0 1 0 6zm6.39 4.78a9.97 9.97 0 0 0-2.79-4.78 9.97 9.97 0 0 0 2.79-4.78C19.4 8.55 20 10.2 20 12s-.6 3.45-1.61 4.78z' }], // Activity
  // Nutrition / Health
  [['nutrition', 'health', 'diet', 'wellness', 'medical', 'mental'],
    { path: 'M16.5 3c-1.74 0-3.41.81-4.5 2.09C10.91 3.81 9.24 3 7.5 3 4.42 3 2 5.42 2 8.5c0 3.78 3.4 6.86 8.55 11.54L12 21.35l1.45-1.32C18.6 15.36 22 12.28 22 8.5 22 5.42 19.58 3 16.5 3zm-4.4 15.55l-.1.1-.1-.1C7.14 14.24 4 11.39 4 8.5 4 6.5 5.5 5 7.5 5c1.54 0 3.04.99 3.57 2.36h1.87C13.46 5.99 14.96 5 16.5 5c2 0 3.5 1.5 3.5 3.5 0 2.89-3.14 5.74-7.9 10.05z' }], // Heart
  // Second Brain / Knowledge / PKM
  [['second brain', 'knowledge', 'pkm', 'note', 'zettelkasten', 'obsidian'],
    { path: 'M12 3L1 9l4 2.18v6L12 21l7-3.82v-6l2-1.09V17h2V9L12 3zm6.82 6L12 12.72 5.18 9 12 5.28 18.82 9zM17 15.99l-5 2.73-5-2.73v-3.72L12 15l5-2.73v3.72z' }], // School/learn
  // LinkedIn / Professional / Career
  [['linkedin', 'career', 'professional', 'resume', 'job', 'networking'],
    { path: 'M19 3a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h14zm-.5 15.5v-5.3a3.26 3.26 0 0 0-3.26-3.26c-.85 0-1.84.52-2.32 1.3v-1.11h-2.79v8.37h2.79v-4.93c0-.77.62-1.4 1.39-1.4a1.4 1.4 0 0 1 1.4 1.4v4.93h2.79zM6.88 8.56a1.68 1.68 0 0 0 1.68-1.68c0-.93-.75-1.69-1.68-1.69a1.69 1.69 0 0 0-1.69 1.69c0 .93.76 1.68 1.69 1.68zm1.39 9.94v-8.37H5.5v8.37h2.77z' }], // LinkedIn
  // Psychology / Mind
  [['psychology', 'mind', 'cognitive', 'behavior', 'therapy'],
    { path: 'M13 1.07V9h7c0-4.08-3.05-7.44-7-7.93zM4 15c0 4.42 3.58 8 8 8s8-3.58 8-8v-4H4v4zm7-13.93C7.05 1.56 4 4.92 4 9h7V1.07z' }], // Brain-half
  // Meeting / Transcripts
  [['meeting'],
    { path: 'M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z' }], // Chat bubble
  // Document
  [['document'],
    { path: 'M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zM6 20V4h7v5h5v11H6zm2-6h8v2H8v-2zm0-3h8v2H8v-2z' }], // Document
  // Research
  [['research'],
    { path: 'M15.5 14h-.79l-.28-.27A6.47 6.47 0 0016 9.5 6.5 6.5 0 109.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z' }], // Magnifying glass
]

/** Resolve an SVG icon path based on playlist name keywords */
function resolvePlaylistIcon(name: string): PlaylistIconDef {
  const lower = name.toLowerCase()
  for (const [keywords, icon] of PLAYLIST_ICON_KEYWORDS) {
    for (const kw of keywords) {
      if (lower.includes(kw)) return icon
    }
  }
  // Default: list-music icon
  return { path: 'M21 15V6c0-1.1-.9-2-2-2H8c-1.1 0-2 .9-2 2v9c-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V8h9v7c-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4z' }
}

interface Camera { zoom: number; panX: number; panY: number }

// Live node for drag + drift animation
interface LiveNode {
  id: string
  x: number
  y: number
  vx: number
  vy: number
}

interface PlaylistGraphViewProps {
  showEdges?: boolean
}

/** Video node radius — scaled by entity count (compact) */
function videoRadius(entityCount: number, maxEntityCount: number = 30): number {
  if (entityCount <= 0) return 3
  return 3 + Math.sqrt(entityCount / Math.max(maxEntityCount, 1)) * 5
}

/** Playlist center button radius — scaled by video count (compact) */
function playlistCenterRadius(videoCount: number): number {
  return 12 + Math.min(videoCount * 0.4, 12)
}

export function PlaylistGraphView({ showEdges = true }: PlaylistGraphViewProps) {
  const { user } = useAuth()
  const containerRef = useRef<HTMLDivElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const sizeRef = useRef({ width: 0, height: 0 })

  // Camera
  const [camera, setCamera] = useState<Camera>({ zoom: 1, panX: 0, panY: 0 })
  const cameraRef = useRef<Camera>({ zoom: 1, panX: 0, panY: 0 })
  useEffect(() => { cameraRef.current = camera }, [camera])

  // Data
  const [playlists, setPlaylists] = useState<PlaylistNode[]>([])
  const [playlistEdges, setPlaylistEdges] = useState<PlaylistEdge[]>([])
  const [videos, setVideos] = useState<PlaylistVideoNode[]>([])
  const [videoEdges, setVideoEdges] = useState<PlaylistVideoEdge[]>([])
  const [loading, setLoading] = useState(true)

  // Interaction
  const [hoveredVideoId, setHoveredVideoId] = useState<string | null>(null)
  const [selectedPlaylistId, setSelectedPlaylistId] = useState<string | null>(null)
  const [exploringVideoId, setExploringVideoId] = useState<string | null>(null)
  const [legendOpen, setLegendOpen] = useState(false)

  const hasDraggedRef = useRef(false)
  const panStartRef = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null)

  // Drag infrastructure — live positions for all nodes (playlist centers + videos)
  const liveNodesRef = useRef<LiveNode[]>([])
  const [livePositions, setLivePositions] = useState<Map<string, { x: number; y: number }>>(new Map())
  const dragRef = useRef<{ id: string; offsetX: number; offsetY: number; type: 'playlist' | 'video' } | null>(null)
  const dragPrevPos = useRef<{ x: number; y: number } | null>(null)
  const rafRef = useRef<number>(0)

  // Playlist/cluster color map — use source-type colors for virtual clusters
  const playlistColorMap = useMemo(() => {
    const map = new Map<string, string>()
    let colorIdx = 0
    playlists.forEach(p => {
      if (p.id.startsWith('__type__')) {
        const sourceType = p.id.replace('__type__', '')
        map.set(p.id, getSourceConfig(sourceType).color)
      } else {
        map.set(p.id, getPlaylistColor(colorIdx++))
      }
    })
    return map
  }, [playlists])

  // Use the existing layout hook to position playlist centers
  const playlistCenterPositions = usePlaylistLayout(playlists, playlistEdges, size.width, size.height)

  // Videos grouped by playlist
  const videosByPlaylist = useMemo(() => {
    const map = new Map<string, PlaylistVideoNode[]>()
    for (const v of videos) {
      const list = map.get(v.playlistId) ?? []
      list.push(v)
      map.set(v.playlistId, list)
    }
    return map
  }, [videos])

  // Global max entity count for consistent video sizing
  const maxEntityCount = useMemo(() => Math.max(...videos.map(v => v.entityCount), 1), [videos])

  // ─── Compute all video positions around their playlist centers ──────────────

  const videoPositions = useMemo(() => {
    if (playlistCenterPositions.size === 0 || videos.length === 0) return new Map<string, { x: number; y: number; r: number }>()

    const result = new Map<string, { x: number; y: number; r: number }>()

    for (const [playlistId, center] of playlistCenterPositions) {
      const pVideos = videosByPlaylist.get(playlistId) ?? []
      if (pVideos.length === 0) continue

      const centerR = playlistCenterRadius(pVideos.length)
      // Arrange videos in concentric rings around the center
      const ringGap = 20 // tight gap between rings
      let ringIdx = 0
      let placed = 0

      while (placed < pVideos.length) {
        ringIdx++
        const ringRadius = centerR + 8 + ringIdx * ringGap
        const circumference = 2 * Math.PI * ringRadius
        const maxInRing = Math.max(1, Math.floor(circumference / 18))
        const countInRing = Math.min(maxInRing, pVideos.length - placed)

        for (let j = 0; j < countInRing; j++) {
          const video = pVideos[placed + j]!
          const angle = (j / countInRing) * Math.PI * 2 - Math.PI / 2
          const r = videoRadius(video.entityCount, maxEntityCount)
          result.set(video.sourceId, {
            x: center.x + Math.cos(angle) * ringRadius,
            y: center.y + Math.sin(angle) * ringRadius,
            r,
          })
        }
        placed += countInRing
      }
    }

    return result
  }, [playlistCenterPositions, videosByPlaylist, videos, maxEntityCount])

  // Cluster boundary radius per playlist (enclosing all videos)
  const clusterRadii = useMemo(() => {
    const result = new Map<string, number>()
    for (const [playlistId, center] of playlistCenterPositions) {
      const pVideos = videosByPlaylist.get(playlistId) ?? []
      let maxDist = playlistCenterRadius(pVideos.length) + 10
      for (const v of pVideos) {
        const vPos = videoPositions.get(v.sourceId)
        if (!vPos) continue
        const dx = vPos.x - center.x
        const dy = vPos.y - center.y
        const dist = Math.sqrt(dx * dx + dy * dy) + vPos.r + 14
        if (dist > maxDist) maxDist = dist
      }
      result.set(playlistId, maxDist)
    }
    return result
  }, [playlistCenterPositions, videosByPlaylist, videoPositions])

  // Cross-playlist video edges only
  // Classify edges: intra-cluster (same playlist/type) vs cross-cluster
  const sourceToPlaylist = useMemo(() => {
    const map = new Map<string, string>()
    for (const v of videos) map.set(v.sourceId, v.playlistId)
    return map
  }, [videos])

  const classifiedEdges = useMemo(() => {
    return videoEdges
      .filter(e => sourceToPlaylist.has(e.fromSourceId) && sourceToPlaylist.has(e.toSourceId))
      .map(e => ({
        ...e,
        isCrossCluster: sourceToPlaylist.get(e.fromSourceId) !== sourceToPlaylist.get(e.toSourceId),
      }))
  }, [videoEdges, sourceToPlaylist])

  // Keep cross-cluster subset for stats
  const crossPlaylistVideoEdges = useMemo(
    () => classifiedEdges.filter(e => e.isCrossCluster),
    [classifiedEdges]
  )

  // Hovered video's connected video IDs (for highlighting)
  const hoveredConnections = useMemo(() => {
    if (!hoveredVideoId) return new Set<string>()
    const ids = new Set<string>()
    for (const e of videoEdges) {
      if (e.fromSourceId === hoveredVideoId) ids.add(e.toSourceId)
      if (e.toSourceId === hoveredVideoId) ids.add(e.fromSourceId)
    }
    return ids
  }, [hoveredVideoId, videoEdges])

  // ─── Live nodes: drag + drift animation ─────────────────────────────────────

  // Connectivity: which nodes should drift when a node is dragged
  // Playlist center → all its videos; Video → its playlist center + cross-playlist connected videos
  const connectivityRef = useRef(new Map<string, Map<string, number>>())
  useEffect(() => {
    const map = new Map<string, Map<string, number>>()
    const addLink = (a: string, b: string, weight: number) => {
      if (!map.has(a)) map.set(a, new Map())
      if (!map.has(b)) map.set(b, new Map())
      const ex = map.get(a)!.get(b) ?? 0
      if (weight > ex) { map.get(a)!.set(b, weight); map.get(b)!.set(a, weight) }
    }
    // Playlist center ↔ its videos (strong link)
    for (const [playlistId, pVideos] of videosByPlaylist) {
      for (const v of pVideos) addLink(`p:${playlistId}`, `v:${v.sourceId}`, 0.8)
    }
    // Cross-playlist video edges (weaker)
    const maxShared = Math.max(...crossPlaylistVideoEdges.map(e => e.sharedEntityCount), 1)
    for (const e of crossPlaylistVideoEdges) {
      addLink(`v:${e.fromSourceId}`, `v:${e.toSourceId}`, Math.min(e.sharedEntityCount / maxShared, 1) * 0.4)
    }
    connectivityRef.current = map
  }, [videosByPlaylist, crossPlaylistVideoEdges])

  // Initialize live nodes from computed positions
  useEffect(() => {
    if (playlistCenterPositions.size === 0) return
    const nodes: LiveNode[] = []
    for (const [pid, pos] of playlistCenterPositions) {
      nodes.push({ id: `p:${pid}`, x: pos.x, y: pos.y, vx: 0, vy: 0 })
    }
    for (const [sourceId, pos] of videoPositions) {
      nodes.push({ id: `v:${sourceId}`, x: pos.x, y: pos.y, vx: 0, vy: 0 })
    }
    liveNodesRef.current = nodes
  }, [playlistCenterPositions, videoPositions])

  // Animation loop
  useEffect(() => {
    const tick = () => {
      const nodes = liveNodesRef.current
      if (nodes.length === 0) { rafRef.current = requestAnimationFrame(tick); return }

      const nodeMap = new Map<string, LiveNode>()
      for (const n of nodes) nodeMap.set(n.id, n)

      // Directional drag drift
      if (dragRef.current && dragPrevPos.current) {
        const dragNode = nodeMap.get(
          dragRef.current.type === 'playlist' ? `p:${dragRef.current.id}` : `v:${dragRef.current.id}`
        )
        if (dragNode) {
          const moveDx = dragNode.x - dragPrevPos.current.x
          const moveDy = dragNode.y - dragPrevPos.current.y
          if (Math.abs(moveDx) > 0.1 || Math.abs(moveDy) > 0.1) {
            const connections = connectivityRef.current.get(dragNode.id)
            if (connections) {
              for (const [connId, weight] of connections) {
                const connNode = nodeMap.get(connId)
                if (!connNode) continue
                const strength = 0.002 + weight * 0.008
                connNode.vx += moveDx * strength
                connNode.vy += moveDy * strength
              }
            }
            // If dragging a playlist center, also move its videos more directly
            if (dragRef.current.type === 'playlist') {
              const pVideos = videosByPlaylist.get(dragRef.current.id) ?? []
              for (const v of pVideos) {
                const vNode = nodeMap.get(`v:${v.sourceId}`)
                if (vNode) {
                  vNode.x += moveDx
                  vNode.y += moveDy
                }
              }
            }
          }
          dragPrevPos.current = { x: dragNode.x, y: dragNode.y }
        }
      }

      // Update velocities
      for (const n of nodes) {
        const dragId = dragRef.current
          ? (dragRef.current.type === 'playlist' ? `p:${dragRef.current.id}` : `v:${dragRef.current.id}`)
          : null
        if (n.id === dragId) { n.vx = 0; n.vy = 0; continue }
        // Also freeze videos of a dragged playlist (they move directly above)
        if (dragRef.current?.type === 'playlist' && n.id.startsWith('v:')) {
          const vid = n.id.slice(2)
          const isChild = (videosByPlaylist.get(dragRef.current.id) ?? []).some(v => v.sourceId === vid)
          if (isChild) { n.vx = 0; n.vy = 0; continue }
        }
        n.vx *= 0.97
        n.vy *= 0.97
        n.x += n.vx
        n.y += n.vy
      }

      const newPos = new Map<string, { x: number; y: number }>()
      for (const n of nodes) newPos.set(n.id, { x: n.x, y: n.y })
      setLivePositions(newPos)
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafRef.current)
  }, [videosByPlaylist])

  // ─── Auto-fit camera ───────────────────────────────────────────────────────

  const hasAutoFitRef = useRef(false)
  useEffect(() => {
    if (videoPositions.size === 0 || size.width === 0 || size.height === 0) return
    if (hasAutoFitRef.current) return
    hasAutoFitRef.current = true

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const [playlistId, center] of playlistCenterPositions) {
      const r = clusterRadii.get(playlistId) ?? 50
      minX = Math.min(minX, center.x - r - 30)
      minY = Math.min(minY, center.y - r - 30)
      maxX = Math.max(maxX, center.x + r + 30)
      maxY = Math.max(maxY, center.y + r + 30)
    }

    const contentW = maxX - minX
    const contentH = maxY - minY
    if (contentW <= 0 || contentH <= 0) return

    const scaleX = size.width / contentW
    const scaleY = size.height / contentH
    const zoom = Math.max(MIN_ZOOM, Math.min(1.2, Math.min(scaleX, scaleY) * 0.88))

    setCamera({
      zoom,
      panX: size.width / 2 - ((minX + maxX) / 2) * zoom,
      panY: size.height / 2 - ((minY + maxY) / 2) * zoom,
    })
  }, [videoPositions, playlistCenterPositions, clusterRadii, size])

  useEffect(() => { hasAutoFitRef.current = false }, [playlists, videos])

  // ─── ResizeObserver ────────────────────────────────────────────────────────

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const obs = new ResizeObserver(entries => {
      const entry = entries[0]
      if (entry) {
        const s = { width: entry.contentRect.width, height: entry.contentRect.height }
        setSize(s)
        sizeRef.current = s
      }
    })
    obs.observe(el)
    return () => obs.disconnect()
  }, [])

  // ─── Fetch data ────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!user) return
    let cancelled = false
    setLoading(true)

    Promise.all([
      fetchPlaylistGraph(user.id),
      fetchSourceGraph(user.id),
    ])
      .then(([playlistData, sourceData]) => {
        if (cancelled) return
        // 1. Set playlist data as-is
        setPlaylists(playlistData.playlists)
        setPlaylistEdges(playlistData.playlistEdges)

        // 2. Get YouTube source IDs already covered by playlists
        const playlistVideoIds = new Set(playlistData.videos.map(v => v.sourceId))

        // 3. Group non-YouTube sources by type into virtual playlists
        const nonYouTubeSources = sourceData.sources.filter(
          s => s.sourceType !== 'YouTube' && !playlistVideoIds.has(s.id)
        )

        const groupedByType = new Map<string, typeof nonYouTubeSources>()
        for (const s of nonYouTubeSources) {
          const key = s.sourceType || 'Other'
          const list = groupedByType.get(key) ?? []
          list.push(s)
          groupedByType.set(key, list)
        }

        // Create virtual PlaylistNodes for each source type
        const virtualPlaylists: PlaylistNode[] = []
        const virtualVideos: PlaylistVideoNode[] = []

        for (const [sourceType, sources] of groupedByType) {
          const virtualId = `__type__${sourceType}`
          virtualPlaylists.push({
            id: virtualId,
            playlistName: sourceType,
            playlistUrl: '',
            synapseCode: null,
            isActive: true,
            videoCount: sources.length,
          })
          for (const s of sources) {
            virtualVideos.push({
              sourceId: s.id,
              videoTitle: s.title,
              videoUrl: '',
              thumbnailUrl: null,
              playlistId: virtualId,
              entityCount: s.entityCount,
              publishedAt: s.createdAt,
            })
          }
        }

        // Convert source edges into PlaylistVideoEdge format
        // Include edges where at least one end is a non-YouTube source
        const nonYouTubeIds = new Set(nonYouTubeSources.map(s => s.id))
        const sourceEdgesAsVideoEdges: PlaylistVideoEdge[] = sourceData.edges
          .filter(e => nonYouTubeIds.has(e.fromSourceId) || nonYouTubeIds.has(e.toSourceId))
          .map(e => ({
            fromSourceId: e.fromSourceId,
            toSourceId: e.toSourceId,
            sharedEntityCount: e.totalWeight,
          }))

        setPlaylists(prev => [...prev, ...virtualPlaylists])
        setVideos([...playlistData.videos, ...virtualVideos])
        setVideoEdges([...playlistData.videoEdges, ...sourceEdgesAsVideoEdges])
      })
      .catch(err => console.warn('PlaylistGraphView fetch error:', err))
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [user])

  // ─── Camera helpers ────────────────────────────────────────────────────────

  const zoomAround = useCallback((factor: number, cx: number, cy: number) => {
    setCamera(prev => {
      const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, prev.zoom * factor))
      return {
        zoom: newZoom,
        panX: cx - (cx - prev.panX) / prev.zoom * newZoom,
        panY: cy - (cy - prev.panY) / prev.zoom * newZoom,
      }
    })
  }, [])

  const zoomIn = useCallback(() => {
    zoomAround(1.3, sizeRef.current.width / 2, sizeRef.current.height / 2)
  }, [zoomAround])

  const zoomOut = useCallback(() => {
    zoomAround(0.75, sizeRef.current.width / 2, sizeRef.current.height / 2)
  }, [zoomAround])

  const resetCamera = useCallback(() => {
    hasAutoFitRef.current = false
    setCamera({ zoom: 1, panX: 0, panY: 0 })
  }, [])

  // Wheel zoom
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const svg = svgRef.current
      if (!svg) return
      const rect = svg.getBoundingClientRect()
      const sx = e.clientX - rect.left
      const sy = e.clientY - rect.top
      if (e.ctrlKey) {
        zoomAround(1 - e.deltaY * 0.004, sx, sy)
      } else if (Math.abs(e.deltaX) > Math.abs(e.deltaY) * 0.5 && Math.abs(e.deltaX) > 2) {
        setCamera(prev => ({ ...prev, panX: prev.panX - e.deltaX, panY: prev.panY - e.deltaY }))
      } else {
        zoomAround(e.deltaY < 0 ? 1.06 : 0.94, sx, sy)
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [zoomAround])

  // Keyboard
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      if (e.key === '+' || e.key === '=') { zoomIn(); e.preventDefault() }
      else if (e.key === '-' || e.key === '_') { zoomOut(); e.preventDefault() }
      else if (e.key === '0') { resetCamera(); e.preventDefault() }
      else if (e.key === 'Escape') {
        if (exploringVideoId) setExploringVideoId(null)
        else if (selectedPlaylistId) setSelectedPlaylistId(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [zoomIn, zoomOut, resetCamera, exploringVideoId, selectedPlaylistId])

  // ─── SVG pan ──────────────────────────────────────────────────────────────

  const handleSvgMouseDown = (e: React.MouseEvent<SVGSVGElement>) => {
    if (e.target !== e.currentTarget) return
    hasDraggedRef.current = false
    const cam = cameraRef.current
    panStartRef.current = { x: e.clientX, y: e.clientY, panX: cam.panX, panY: cam.panY }
    if (svgRef.current) svgRef.current.style.cursor = 'grab'
  }

  const handleSvgMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const start = panStartRef.current
    if (!start) return
    const dx = e.clientX - start.x
    const dy = e.clientY - start.y
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) hasDraggedRef.current = true
    setCamera(prev => ({ ...prev, panX: start.panX + dx, panY: start.panY + dy }))
  }

  const handleSvgMouseUp = () => {
    panStartRef.current = null
    if (svgRef.current) svgRef.current.style.cursor = 'default'
  }

  const handleSvgClick = (e: React.MouseEvent<SVGSVGElement>) => {
    if (e.target === e.currentTarget && !hasDraggedRef.current) {
      setSelectedPlaylistId(null)
      setExploringVideoId(null)
    }
  }

  // ─── Drag handler ──────────────────────────────────────────────────────────

  const handleNodeMouseDown = useCallback((e: React.MouseEvent, nodeId: string, nodeType: 'playlist' | 'video') => {
    e.stopPropagation()
    hasDraggedRef.current = false
    const cam = cameraRef.current
    const rect = svgRef.current?.getBoundingClientRect()
    if (!rect) return
    const worldX = (e.clientX - rect.left - cam.panX) / cam.zoom
    const worldY = (e.clientY - rect.top - cam.panY) / cam.zoom
    const liveId = nodeType === 'playlist' ? `p:${nodeId}` : `v:${nodeId}`
    const node = liveNodesRef.current.find(n => n.id === liveId)
    if (!node) return
    dragRef.current = { id: nodeId, offsetX: worldX - node.x, offsetY: worldY - node.y, type: nodeType }
    dragPrevPos.current = { x: node.x, y: node.y }

    const onMove = (ev: MouseEvent) => {
      if (!dragRef.current || !svgRef.current) return
      hasDraggedRef.current = true
      const cam2 = cameraRef.current
      const r2 = svgRef.current.getBoundingClientRect()
      const wx = (ev.clientX - r2.left - cam2.panX) / cam2.zoom
      const wy = (ev.clientY - r2.top - cam2.panY) / cam2.zoom
      const lid = dragRef.current.type === 'playlist' ? `p:${dragRef.current.id}` : `v:${dragRef.current.id}`
      const n = liveNodesRef.current.find(nd => nd.id === lid)
      if (n) { n.x = wx - dragRef.current.offsetX; n.y = wy - dragRef.current.offsetY }
    }
    const onUp = () => {
      if (dragRef.current) {
        const lid = dragRef.current.type === 'playlist' ? `p:${dragRef.current.id}` : `v:${dragRef.current.id}`
        const n = liveNodesRef.current.find(nd => nd.id === lid)
        if (n) { n.vx = 0; n.vy = 0 }
      }
      dragRef.current = null
      dragPrevPos.current = null
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [])

  // ─── Click handlers ───────────────────────────────────────────────────────

  const handleVideoClick = useCallback((sourceId: string) => {
    if (hasDraggedRef.current) return
    setExploringVideoId(prev => prev === sourceId ? null : sourceId)
  }, [])

  const handlePlaylistCenterClick = useCallback((playlistId: string) => {
    if (hasDraggedRef.current) return
    setSelectedPlaylistId(prev => prev === playlistId ? null : playlistId)
    setExploringVideoId(null)
  }, [])

  // Loading
  if (loading) {
    return (
      <div ref={containerRef} className="relative w-full h-full flex items-center justify-center">
        <span className="flex items-center gap-2" style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-secondary)' }}>
          <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} />
          Loading sources…
        </span>
      </div>
    )
  }

  // Empty
  if (playlists.length === 0) {
    return (
      <div ref={containerRef} className="relative w-full h-full flex items-center justify-center">
        <div className="flex flex-col items-center gap-3" style={{ maxWidth: 320, textAlign: 'center' }}>
          <ListMusic size={32} style={{ color: 'var(--color-text-placeholder)' }} />
          <h3 style={{ fontFamily: 'var(--font-display)', fontSize: 16, fontWeight: 700, color: 'var(--color-text-primary)' }}>
            No sources yet
          </h3>
          <p style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-secondary)', lineHeight: 1.5 }}>
            Ingest content to see your sources clustered by type and playlist.
          </p>
        </div>
      </div>
    )
  }

  // ─── RENDER ────────────────────────────────────────────────────────────────

  return (
    <div ref={containerRef} className="relative w-full h-full" style={{ overflow: 'hidden', background: 'var(--color-bg-content)', userSelect: 'none', WebkitUserSelect: 'none' }}>

      {size.width > 0 && size.height > 0 && (
        <svg
          ref={svgRef}
          width={size.width}
          height={size.height}
          style={{ display: 'block', userSelect: 'none', WebkitUserSelect: 'none' }}
          onMouseDown={handleSvgMouseDown}
          onMouseMove={handleSvgMouseMove}
          onMouseUp={handleSvgMouseUp}
          onMouseLeave={handleSvgMouseUp}
          onClick={handleSvgClick}
        >
          <g transform={`translate(${camera.panX},${camera.panY}) scale(${camera.zoom})`}>

            {/* 1. Spoke lines — center to each video (use live positions) */}
            {playlists.map(playlist => {
              const centerLive = livePositions.get(`p:${playlist.id}`)
              const center = centerLive ?? playlistCenterPositions.get(playlist.id)
              if (!center) return null
              const pVideos = videosByPlaylist.get(playlist.id) ?? []
              const color = playlistColorMap.get(playlist.id) ?? PLAYLIST_COLORS[0]!

              return pVideos.map(video => {
                const vLive = livePositions.get(`v:${video.sourceId}`)
                const vPos = vLive ?? videoPositions.get(video.sourceId)
                if (!vPos) return null
                return (
                  <line
                    key={`spoke-${video.sourceId}`}
                    x1={center.x} y1={center.y}
                    x2={vPos.x} y2={vPos.y}
                    stroke={color}
                    strokeWidth={1.2}
                    strokeOpacity={0.18}
                  />
                )
              })
            })}

            {/* 2. All source edges — intra-cluster (subtle) + cross-cluster (prominent) */}
            {showEdges && classifiedEdges.map(edge => {
              const fromLive = livePositions.get(`v:${edge.fromSourceId}`)
              const toLive = livePositions.get(`v:${edge.toSourceId}`)
              const fromPos = fromLive ?? videoPositions.get(edge.fromSourceId)
              const toPos = toLive ?? videoPositions.get(edge.toSourceId)
              if (!fromPos || !toPos) return null

              const isHighlighted = hoveredVideoId === edge.fromSourceId || hoveredVideoId === edge.toSourceId
              const hasHover = !!hoveredVideoId
              const maxShared = Math.max(...classifiedEdges.map(e => e.sharedEntityCount), 1)
              const weightNorm = edge.sharedEntityCount / maxShared

              // Cross-cluster edges are thicker and more visible; intra-cluster are subtler
              const baseWidth = edge.isCrossCluster
                ? 0.8 + weightNorm * 1.5
                : 0.4 + weightNorm * 0.8
              const baseOpacity = edge.isCrossCluster ? 0.15 : 0.07

              // When hovering, highlighted edges pop, others fade
              let stroke = 'rgba(120,130,145,1)'
              let strokeWidth = baseWidth
              let strokeOpacity = hasHover ? 0.03 : baseOpacity

              if (isHighlighted) {
                stroke = edge.isCrossCluster ? 'var(--color-accent-500)' : playlistColorMap.get(sourceToPlaylist.get(edge.fromSourceId)!) ?? 'var(--color-accent-500)'
                strokeWidth = edge.isCrossCluster ? 2 : 1.5
                strokeOpacity = edge.isCrossCluster ? 0.6 : 0.45
              }

              return (
                <line
                  key={`ve-${edge.fromSourceId}-${edge.toSourceId}`}
                  x1={fromPos.x} y1={fromPos.y} x2={toPos.x} y2={toPos.y}
                  stroke={stroke}
                  strokeWidth={strokeWidth}
                  strokeOpacity={strokeOpacity}
                  style={{ transition: 'stroke-opacity 0.15s ease, stroke-width 0.15s ease' }}
                />
              )
            })}

            {/* 3. Video nodes per playlist (draggable) */}
            {playlists.map(playlist => {
              const pVideos = videosByPlaylist.get(playlist.id) ?? []
              const color = playlistColorMap.get(playlist.id) ?? PLAYLIST_COLORS[0]!

              return pVideos.map(video => {
                const vLive = livePositions.get(`v:${video.sourceId}`)
                const staticPos = videoPositions.get(video.sourceId)
                const pos = vLive ?? staticPos
                if (!pos || !staticPos) return null

                const r = staticPos.r
                const isHovered = hoveredVideoId === video.sourceId
                const isExploring = exploringVideoId === video.sourceId
                const isConnectedToHovered = hoveredConnections.has(video.sourceId)
                const isDimmed = hoveredVideoId !== null && !isHovered && !isConnectedToHovered
                const isDragging = dragRef.current?.type === 'video' && dragRef.current?.id === video.sourceId
                const scale = isHovered ? 1.15 : 1
                const label = video.videoTitle.length > 22 ? video.videoTitle.slice(0, 21) + '…' : video.videoTitle

                return (
                  <g
                    key={video.sourceId}
                    onMouseDown={e => handleNodeMouseDown(e, video.sourceId, 'video')}
                    onMouseEnter={() => { if (!dragRef.current) setHoveredVideoId(video.sourceId) }}
                    onMouseLeave={() => { if (!dragRef.current) setHoveredVideoId(null) }}
                    onClick={() => handleVideoClick(video.sourceId)}
                    style={{
                      cursor: isDragging ? 'grabbing' : 'pointer',
                      opacity: isDimmed ? 0.15 : 1,
                      transition: 'opacity 0.18s ease',
                    }}
                  >
                    <g transform={`translate(${pos.x}, ${pos.y})`}>
                      <g transform={`scale(${scale})`} style={{ transition: 'transform 0.15s ease' }}>
                        {isExploring && (
                          <circle r={r + 4} fill="none" stroke="var(--color-accent-500)" strokeWidth={1.5} opacity={0.6} />
                        )}
                        {isHovered && !isExploring && (
                          <circle r={r + 3} fill="none" stroke={`${color}40`} strokeWidth={1.5} />
                        )}
                        {isConnectedToHovered && !isHovered && !isExploring && (
                          <circle r={r + 3} fill="none" stroke="var(--color-accent-500)" strokeWidth={1} opacity={0.3} />
                        )}
                        <circle r={r} fill={`${color}20`} stroke={color} strokeWidth={1.5} />
                      </g>

                      <text
                        y={r + 10}
                        textAnchor="middle"
                        style={{
                          fontFamily: 'var(--font-body)',
                          fontSize: 7,
                          fontWeight: isHovered ? 600 : 500,
                          fill: isExploring ? 'var(--color-accent-500)' : isHovered ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
                          pointerEvents: 'none',
                          userSelect: 'none',
                          transition: 'fill 0.15s ease',
                        }}
                      >
                        {label}
                      </text>
                    </g>
                  </g>
                )
              })
            })}

            {/* 4. Playlist center buttons — dynamic icon (draggable) */}
            {playlists.map(playlist => {
              const centerLive = livePositions.get(`p:${playlist.id}`)
              const center = centerLive ?? playlistCenterPositions.get(playlist.id)
              if (!center) return null
              const pVideos = videosByPlaylist.get(playlist.id) ?? []
              const r = playlistCenterRadius(pVideos.length)
              const color = playlistColorMap.get(playlist.id) ?? PLAYLIST_COLORS[0]!
              const isSelected = selectedPlaylistId === playlist.id
              const isDragging = dragRef.current?.type === 'playlist' && dragRef.current?.id === playlist.id
              const iconDef = resolvePlaylistIcon(playlist.playlistName)
              const iconSize = r * 0.65

              return (
                <g
                  key={`center-${playlist.id}`}
                  onMouseDown={e => handleNodeMouseDown(e, playlist.id, 'playlist')}
                  onClick={() => handlePlaylistCenterClick(playlist.id)}
                  style={{ cursor: isDragging ? 'grabbing' : 'pointer' }}
                >
                  <g transform={`translate(${center.x}, ${center.y})`}>
                    {isSelected && (
                      <circle r={r + 4} fill="none" stroke="var(--color-accent-500)" strokeWidth={2} opacity={0.5} />
                    )}

                    <circle r={r} fill="white" stroke={color} strokeWidth={2.5} />

                    {/* Dynamic SVG icon based on playlist name */}
                    <g transform={`translate(${-iconSize / 2}, ${-iconSize / 2})`}>
                      <svg width={iconSize} height={iconSize} viewBox="0 0 24 24">
                        <path d={iconDef.path} fill={color} opacity={0.7} />
                      </svg>
                    </g>

                    <text
                      y={r + 14}
                      textAnchor="middle"
                      style={{
                        fontFamily: 'var(--font-display)',
                        fontSize: 10,
                        fontWeight: 700,
                        fill: isSelected ? 'var(--color-accent-500)' : color,
                        pointerEvents: 'none',
                        userSelect: 'none',
                      }}
                    >
                      {playlist.playlistName.length > 24 ? playlist.playlistName.slice(0, 23) + '…' : playlist.playlistName}
                    </text>

                    <text
                      y={r + 25}
                      textAnchor="middle"
                      style={{
                        fontFamily: 'var(--font-body)',
                        fontSize: 8,
                        fontWeight: 500,
                        fill: 'var(--color-text-placeholder)',
                        pointerEvents: 'none',
                        userSelect: 'none',
                      }}
                    >
                      {pVideos.length} {playlist.id.startsWith('__type__') ? 'sources' : 'videos'}
                    </text>
                  </g>
                </g>
              )
            })}

          </g>
        </svg>
      )}

      {/* Hover tooltip for video */}
      {hoveredVideoId && !exploringVideoId && (() => {
        const hVideo = videos.find(v => v.sourceId === hoveredVideoId)
        if (!hVideo) return null
        const posLive = livePositions.get(`v:${hVideo.sourceId}`)
        const pos = posLive ?? videoPositions.get(hVideo.sourceId)
        if (!pos) return null
        const color = playlistColorMap.get(hVideo.playlistId) ?? '#94a3b8'
        const playlist = playlists.find(p => p.id === hVideo.playlistId)

        // Count connections for this video
        const totalConns = hoveredConnections.size
        const crossConns = crossPlaylistVideoEdges.filter(
          e => e.fromSourceId === hVideo.sourceId || e.toSourceId === hVideo.sourceId
        ).length
        const intraConns = totalConns - crossConns

        const screenX = pos.x * camera.zoom + camera.panX
        const screenY = pos.y * camera.zoom + camera.panY
        const cardWidth = 250
        const left = Math.max(8, Math.min(size.width - cardWidth - 8, screenX - cardWidth / 2))
        const top = Math.max(8, screenY - 20)

        return (
          <div
            style={{
              position: 'absolute',
              left,
              bottom: size.height - top,
              zIndex: 30,
              width: cardWidth,
              background: 'rgba(255,255,255,0.96)',
              backdropFilter: 'blur(12px)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 10,
              padding: '8px 12px',
              boxShadow: '0 4px 16px rgba(0,0,0,0.08)',
              pointerEvents: 'none',
            }}
          >
            <div className="flex items-center gap-2" style={{ marginBottom: 3 }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: color, flexShrink: 0 }} />
              <span className="font-display" style={{ fontSize: 11, fontWeight: 700, color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {hVideo.videoTitle}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className="font-body" style={{ fontSize: 9, color: 'var(--color-text-secondary)' }}>
                {hVideo.entityCount} entities
                {intraConns > 0 && ` · ${intraConns} within cluster`}
                {crossConns > 0 && ` · ${crossConns} cross-cluster`}
              </span>
            </div>
            {playlist && (
              <div className="font-body" style={{ fontSize: 8, color: 'var(--color-text-placeholder)', marginTop: 2 }}>
                {playlist.playlistName}
              </div>
            )}
          </div>
        )
      })()}

      {/* Right-side detail panel: playlist */}
      {selectedPlaylistId && !exploringVideoId && (() => {
        const selected = playlists.find(p => p.id === selectedPlaylistId)
        if (!selected) return null
        return (
          <PlaylistDetailPanel
            playlist={selected}
            playlists={playlists}
            playlistEdges={playlistEdges}
            videos={videos}
            videoEdges={videoEdges}
            playlistColorMap={playlistColorMap}
            onClose={() => setSelectedPlaylistId(null)}
            onNavigateToPlaylist={(id) => setSelectedPlaylistId(id)}
            onNavigateToVideo={(sourceId) => setExploringVideoId(sourceId)}
          />
        )
      })()}

      {/* Right-side detail panel: video */}
      {exploringVideoId && (
        <SourceDetailCard
          sourceId={exploringVideoId}
          onClose={() => setExploringVideoId(null)}
          onNavigateToSource={(sourceId) => setExploringVideoId(sourceId)}
        />
      )}

      {/* Legend — bottom-left, collapsed by default */}
      <div
        style={{
          position: 'absolute', bottom: 16, left: 16,
          background: 'rgba(255,255,255,0.92)',
          backdropFilter: 'blur(8px)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 8,
          zIndex: 20,
          overflow: 'hidden',
        }}
      >
        <button
          type="button"
          onClick={() => setLegendOpen(prev => !prev)}
          className="flex items-center gap-1.5 w-full cursor-pointer"
          style={{
            padding: '6px 10px',
            background: 'none', border: 'none',
            fontFamily: 'var(--font-display)', fontSize: 8, fontWeight: 700,
            color: 'var(--color-text-secondary)', letterSpacing: '0.06em',
            textTransform: 'uppercase' as const,
          }}
        >
          <svg width={8} height={8} viewBox="0 0 8 8" style={{ flexShrink: 0, transition: 'transform 0.15s ease', transform: legendOpen ? 'rotate(90deg)' : 'rotate(0deg)' }}>
            <path d="M2 1l4 3-4 3z" fill="currentColor" />
          </svg>
          Sources ({playlists.length})
        </button>
        {legendOpen && (
          <div style={{ padding: '0 10px 8px', display: 'flex', flexDirection: 'column', gap: 3, maxHeight: 240, overflowY: 'auto' }}>
            {playlists.map(p => {
              const color = playlistColorMap.get(p.id) ?? '#6b7280'
              return (
                <div key={p.id} className="flex items-center gap-2">
                  <span style={{ width: 7, height: 7, borderRadius: '50%', background: `${color}22`, border: `1.5px solid ${color}`, flexShrink: 0 }} />
                  <span style={{ fontFamily: 'var(--font-body)', fontSize: 9, fontWeight: 500, color: 'var(--color-text-body)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 140 }}>
                    {p.playlistName}
                  </span>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Stats — top-right */}
      <div
        style={{
          position: 'absolute', top: 16, right: 16,
          background: 'rgba(255,255,255,0.92)',
          backdropFilter: 'blur(8px)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 8, padding: '6px 10px',
          display: 'flex', gap: 12, alignItems: 'center',
          pointerEvents: 'none',
        }}
      >
        <span style={{ fontFamily: 'var(--font-body)', fontSize: 9, color: 'var(--color-text-secondary)' }}>
          <strong style={{ fontFamily: 'var(--font-display)', fontWeight: 700, color: 'var(--color-text-primary)' }}>{playlists.length}</strong> clusters
        </span>
        <span style={{ fontFamily: 'var(--font-body)', fontSize: 9, color: 'var(--color-text-secondary)' }}>
          <strong style={{ fontFamily: 'var(--font-display)', fontWeight: 700, color: 'var(--color-text-primary)' }}>{videos.length}</strong> sources
        </span>
        <span style={{ fontFamily: 'var(--font-body)', fontSize: 9, color: 'var(--color-text-secondary)' }}>
          <strong style={{ fontFamily: 'var(--font-display)', fontWeight: 700, color: 'var(--color-text-primary)' }}>{crossPlaylistVideoEdges.length}</strong> cross-connections
        </span>
      </div>

      {/* Zoom controls — bottom-right */}
      <div style={{ position: 'absolute', bottom: 16, right: 16, display: 'flex', flexDirection: 'column', gap: 3, zIndex: 20 }}>
        {[
          { label: '+', title: 'Zoom in', action: zoomIn },
          { label: '−', title: 'Zoom out', action: zoomOut },
          { label: '⊙', title: 'Fit to screen', action: resetCamera },
        ].map(({ label, title, action }) => (
          <button
            key={label}
            type="button"
            onClick={action}
            title={title}
            className="flex items-center justify-center font-body font-bold cursor-pointer"
            style={{
              width: 26, height: 26, borderRadius: 6,
              background: 'rgba(255,255,255,0.92)',
              border: '1px solid rgba(0,0,0,0.08)',
              color: 'var(--color-text-secondary)',
              fontSize: 14, lineHeight: 1,
              backdropFilter: 'blur(8px)',
            }}
          >
            {label}
          </button>
        ))}
      </div>

    </div>
  )
}
