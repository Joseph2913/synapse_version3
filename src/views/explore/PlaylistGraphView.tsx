import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { ListMusic, ArrowLeft, Loader2 } from 'lucide-react'
import { usePlaylistLayout, playlistRadius } from '../../hooks/usePlaylistLayout'
import { useAuth } from '../../hooks/useAuth'
import { fetchPlaylistGraph } from '../../services/exploreQueries'
import { SourceDetailCard } from '../../components/explore/SourceDetailCard'
import { PlaylistDetailPanel } from '../../components/explore/PlaylistDetailPanel'
import type {
  PlaylistNode,
  PlaylistEdge,
  PlaylistVideoNode,
  PlaylistVideoEdge,
} from '../../types/explore'

const MIN_ZOOM = 0.15
const MAX_ZOOM = 6.0

// Colors for playlists — cycle through these
const PLAYLIST_COLORS = [
  '#d63a00', '#2563eb', '#7c3aed', '#059669', '#d97706',
  '#dc2626', '#0891b2', '#4f46e5', '#16a34a', '#ea580c',
]

function getPlaylistColor(index: number): string {
  return PLAYLIST_COLORS[index % PLAYLIST_COLORS.length]!
}

interface Camera { zoom: number; panX: number; panY: number }

// Live node for floating animation
interface LiveNode {
  id: string
  x: number
  y: number
  vx: number
  vy: number
  radius: number
}

interface PlaylistGraphViewProps {
  showEdges?: boolean
}

type ViewLevel = 'map' | 'expanded'

/** Video node radius — scaled by entity count */
function videoRadius(entityCount: number, maxEntityCount: number = 30): number {
  if (entityCount <= 0) return 5
  const minR = 5
  const maxR = 14
  return minR + Math.sqrt(entityCount / Math.max(maxEntityCount, 1)) * (maxR - minR)
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

  // View level
  const [viewLevel, setViewLevel] = useState<ViewLevel>('map')
  const [expandedPlaylistId, setExpandedPlaylistId] = useState<string | null>(null)
  const [expandedOuterClusterId, setExpandedOuterClusterId] = useState<string | null>(null)

  // Interaction
  const [hoveredPlaylistId, setHoveredPlaylistId] = useState<string | null>(null)
  const [selectedPlaylistId, setSelectedPlaylistId] = useState<string | null>(null)
  const [hoveredVideoId, setHoveredVideoId] = useState<string | null>(null)
  const [exploringVideoId, setExploringVideoId] = useState<string | null>(null)

  // Playlist color map
  const playlistColorMap = useMemo(() => {
    const map = new Map<string, string>()
    playlists.forEach((p, i) => map.set(p.id, getPlaylistColor(i)))
    return map
  }, [playlists])

  // Layout (Level 1)
  const layoutPositions = usePlaylistLayout(playlists, playlistEdges, size.width, size.height)

  // Live positions
  const liveNodesRef = useRef<LiveNode[]>([])
  const [livePositions, setLivePositions] = useState<Map<string, { x: number; y: number }>>(new Map())
  const dragRef = useRef<{ id: string; offsetX: number; offsetY: number } | null>(null)
  const rafRef = useRef<number>(0)
  const hasDraggedRef = useRef(false)
  const panStartRef = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null)
  const dragPrevPos = useRef<{ x: number; y: number } | null>(null)

  // Connectivity map for drag drift
  const connectivityRef = useRef(new Map<string, Map<string, number>>())
  useEffect(() => {
    const map = new Map<string, Map<string, number>>()
    const addLink = (a: string, b: string, weight: number) => {
      if (!map.has(a)) map.set(a, new Map())
      if (!map.has(b)) map.set(b, new Map())
      const existing = map.get(a)!.get(b) ?? 0
      if (weight > existing) {
        map.get(a)!.set(b, weight)
        map.get(b)!.set(a, weight)
      }
    }
    const maxWeight = Math.max(...playlistEdges.map(e => e.connectionCount), 1)
    for (const e of playlistEdges) {
      addLink(e.fromPlaylistId, e.toPlaylistId, Math.min(e.connectionCount / maxWeight, 1))
    }
    connectivityRef.current = map
  }, [playlistEdges])

  // Initialize live nodes from layout
  useEffect(() => {
    if (layoutPositions.size === 0) return
    liveNodesRef.current = Array.from(layoutPositions.entries()).map(([id, pos]) => ({
      id,
      x: pos.x,
      y: pos.y,
      vx: 0,
      vy: 0,
      radius: pos.radius,
    }))
  }, [layoutPositions])

  // Animation loop
  useEffect(() => {
    const tick = () => {
      const nodes = liveNodesRef.current
      if (nodes.length === 0) { rafRef.current = requestAnimationFrame(tick); return }

      const nodeMap = new Map<string, LiveNode>()
      for (const n of nodes) nodeMap.set(n.id, n)

      // Directional drag drift
      if (dragRef.current && dragPrevPos.current) {
        const dragNode = nodeMap.get(dragRef.current.id)
        if (dragNode) {
          const moveDx = dragNode.x - dragPrevPos.current.x
          const moveDy = dragNode.y - dragPrevPos.current.y
          if (Math.abs(moveDx) > 0.1 || Math.abs(moveDy) > 0.1) {
            const connections = connectivityRef.current.get(dragRef.current.id)
            if (connections) {
              for (const [connId, weight] of connections) {
                const connNode = nodeMap.get(connId)
                if (!connNode) continue
                const strength = 0.0005 + weight * 0.004
                connNode.vx += moveDx * strength
                connNode.vy += moveDy * strength
              }
            }
          }
          dragPrevPos.current = { x: dragNode.x, y: dragNode.y }
        }
      }

      for (const n of nodes) {
        if (dragRef.current?.id === n.id) { n.vx = 0; n.vy = 0; continue }
        const w = sizeRef.current.width
        const h = sizeRef.current.height
        if (w > 0 && h > 0) {
          const pad = 40
          if (n.x < pad) n.vx += (pad - n.x) * 0.01
          if (n.x > w - pad) n.vx -= (n.x - (w - pad)) * 0.01
          if (n.y < pad) n.vy += (pad - n.y) * 0.01
          if (n.y > h - pad) n.vy -= (n.y - (h - pad)) * 0.01
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
  }, [])

  // Auto-fit camera
  const hasAutoFitRef = useRef(false)
  useEffect(() => {
    if (layoutPositions.size === 0 || size.width === 0 || size.height === 0) return
    if (hasAutoFitRef.current) return
    hasAutoFitRef.current = true

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const [, pos] of layoutPositions) {
      const r = pos.radius + 30
      minX = Math.min(minX, pos.x - r)
      minY = Math.min(minY, pos.y - r)
      maxX = Math.max(maxX, pos.x + r)
      maxY = Math.max(maxY, pos.y + r)
    }

    const contentW = maxX - minX
    const contentH = maxY - minY
    if (contentW <= 0 || contentH <= 0) return

    const scaleX = size.width / contentW
    const scaleY = size.height / contentH
    const zoom = Math.max(MIN_ZOOM, Math.min(1.5, Math.min(scaleX, scaleY) * 0.88))

    setCamera({
      zoom,
      panX: size.width / 2 - ((minX + maxX) / 2) * zoom,
      panY: size.height / 2 - ((minY + maxY) / 2) * zoom,
    })
  }, [layoutPositions, size])

  useEffect(() => { hasAutoFitRef.current = false }, [playlists])

  // ResizeObserver
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

  // Fetch
  useEffect(() => {
    if (!user) return
    let cancelled = false
    setLoading(true)
    fetchPlaylistGraph(user.id)
      .then(data => {
        if (cancelled) return
        setPlaylists(data.playlists)
        setPlaylistEdges(data.playlistEdges)
        setVideos(data.videos)
        setVideoEdges(data.videoEdges)
      })
      .catch(err => console.warn('PlaylistGraphView fetch error:', err))
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [user])

  // ─── Edges for a given playlist ────────────────────────────────────────────

  const edgesForPlaylist = useMemo(() => {
    const map = new Map<string, PlaylistEdge[]>()
    for (const e of playlistEdges) {
      const a = map.get(e.fromPlaylistId) ?? []
      a.push(e); map.set(e.fromPlaylistId, a)
      const b = map.get(e.toPlaylistId) ?? []
      b.push(e); map.set(e.toPlaylistId, b)
    }
    return map
  }, [playlistEdges])

  const activePlaylistId = hoveredPlaylistId || selectedPlaylistId
  const highlightedEdges = useMemo(() => {
    if (!activePlaylistId) return new Set<string>()
    const relevant = edgesForPlaylist.get(activePlaylistId) ?? []
    return new Set(relevant.map(e => `${e.fromPlaylistId}-${e.toPlaylistId}`))
  }, [activePlaylistId, edgesForPlaylist])

  // ─── Level 2: Expanded playlist data ──────────────────────────────────────

  const expandedPlaylist = useMemo(() => {
    if (!expandedPlaylistId) return null
    return playlists.find(p => p.id === expandedPlaylistId) ?? null
  }, [expandedPlaylistId, playlists])

  const innerVideos = useMemo(() => {
    if (!expandedPlaylistId) return []
    return videos.filter(v => v.playlistId === expandedPlaylistId)
  }, [expandedPlaylistId, videos])

  const outerPlaylists = useMemo(() => {
    if (!expandedPlaylistId) return []
    // All other playlists, with their connection count to the expanded one
    return playlists
      .filter(p => p.id !== expandedPlaylistId)
      .map(p => {
        const edge = playlistEdges.find(
          e => (e.fromPlaylistId === expandedPlaylistId && e.toPlaylistId === p.id) ||
               (e.toPlaylistId === expandedPlaylistId && e.fromPlaylistId === p.id)
        )
        return { ...p, connectionCount: edge?.connectionCount ?? 0 }
      })
      .sort((a, b) => b.connectionCount - a.connectionCount)
  }, [expandedPlaylistId, playlists, playlistEdges])

  // Videos from the expanded outer cluster
  const outerClusterVideos = useMemo(() => {
    if (!expandedOuterClusterId) return []
    return videos.filter(v => v.playlistId === expandedOuterClusterId)
  }, [expandedOuterClusterId, videos])

  // Cross-connections between inner videos and expanded outer cluster videos
  const crossVideoEdges = useMemo(() => {
    if (!expandedOuterClusterId || innerVideos.length === 0 || outerClusterVideos.length === 0) return []
    const innerSourceIds = new Set(innerVideos.map(v => v.sourceId))
    const outerSourceIds = new Set(outerClusterVideos.map(v => v.sourceId))
    return videoEdges.filter(e =>
      (innerSourceIds.has(e.fromSourceId) && outerSourceIds.has(e.toSourceId)) ||
      (outerSourceIds.has(e.fromSourceId) && innerSourceIds.has(e.toSourceId))
    )
  }, [expandedOuterClusterId, innerVideos, outerClusterVideos, videoEdges])

  // Internal video edges (within expanded playlist)
  const internalVideoEdges = useMemo(() => {
    if (innerVideos.length === 0) return []
    const innerSourceIds = new Set(innerVideos.map(v => v.sourceId))
    return videoEdges.filter(e =>
      innerSourceIds.has(e.fromSourceId) && innerSourceIds.has(e.toSourceId)
    )
  }, [innerVideos, videoEdges])

  // Connected inner video source IDs (when outer cluster is expanded)
  const connectedInnerSourceIds = useMemo(() => {
    if (crossVideoEdges.length === 0) return new Set<string>()
    const innerSourceIds = new Set(innerVideos.map(v => v.sourceId))
    const ids = new Set<string>()
    for (const e of crossVideoEdges) {
      if (innerSourceIds.has(e.fromSourceId)) ids.add(e.fromSourceId)
      if (innerSourceIds.has(e.toSourceId)) ids.add(e.toSourceId)
    }
    return ids
  }, [crossVideoEdges, innerVideos])

  // ─── Level 2 layout: position inner videos in center, outer playlists around ──

  // Ellipse parameters — shared between video layout, outer playlist placement, and SVG rendering
  const ellipseCx = size.width * 0.45
  const ellipseCy = size.height / 2
  const ellipseRx = size.width * 0.35
  const ellipseRy = size.height * 0.42

  const innerVideoPositions = useMemo(() => {
    if (innerVideos.length === 0 || size.width === 0 || size.height === 0) return new Map<string, { x: number; y: number; r: number }>()

    const cx = ellipseCx
    const cy = ellipseCy
    const rx = ellipseRx * 0.85  // Use most of the ellipse interior
    const ry = ellipseRy * 0.85
    const maxEntity = Math.max(...innerVideos.map(v => v.entityCount), 1)

    // Build edge lookup for inner edges
    const edgeLookup = new Map<string, { targetId: string; weight: number }[]>()
    const maxW = Math.max(...internalVideoEdges.map(e => e.sharedEntityCount), 1)
    for (const e of internalVideoEdges) {
      if (!edgeLookup.has(e.fromSourceId)) edgeLookup.set(e.fromSourceId, [])
      if (!edgeLookup.has(e.toSourceId)) edgeLookup.set(e.toSourceId, [])
      const w = e.sharedEntityCount / maxW
      edgeLookup.get(e.fromSourceId)!.push({ targetId: e.toSourceId, weight: w })
      edgeLookup.get(e.toSourceId)!.push({ targetId: e.fromSourceId, weight: w })
    }

    // Initial placement: golden angle spiral to fill the ellipse evenly
    interface SimNode { id: string; x: number; y: number; r: number }
    const goldenAngle = Math.PI * (3 - Math.sqrt(5))
    const nodes: SimNode[] = innerVideos.map((v, i) => {
      const t = (i + 0.5) / innerVideos.length  // 0..1, slightly offset from center
      const spiralR = Math.sqrt(t)  // Square root for uniform area distribution
      const angle = i * goldenAngle
      const r = videoRadius(v.entityCount, maxEntity)
      return {
        id: v.sourceId,
        x: cx + Math.cos(angle) * spiralR * rx,
        y: cy + Math.sin(angle) * spiralR * ry,
        r,
      }
    })

    const nodeIndex = new Map(nodes.map((n, i) => [n.id, i]))

    // Force sim: 80 ticks — stronger repulsion for better spread
    for (let tick = 0; tick < 80; tick++) {
      const alpha = 1 - tick / 80

      // Repulsion — stronger to spread nodes apart
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i]!, b = nodes[j]!
          const dx = b.x - a.x, dy = b.y - a.y
          const dist = Math.sqrt(dx * dx + dy * dy) || 0.1
          const minDist = a.r + b.r + 28
          const rep = Math.max(0, (minDist * 3.5 - dist)) * 0.15 * alpha
          if (rep > 0) {
            const nx = dx / dist, ny = dy / dist
            a.x -= nx * rep; a.y -= ny * rep
            b.x += nx * rep; b.y += ny * rep
          }
        }
      }

      // Attraction — weaker to let repulsion dominate
      for (const [srcId, targets] of edgeLookup) {
        const ai = nodeIndex.get(srcId)
        if (ai === undefined) continue
        const a = nodes[ai]!
        for (const { targetId, weight } of targets) {
          const bi = nodeIndex.get(targetId)
          if (bi === undefined) continue
          const b = nodes[bi]!
          const dx = b.x - a.x, dy = b.y - a.y
          const dist = Math.sqrt(dx * dx + dy * dy) || 0.1
          const idealDist = a.r + b.r + 40
          if (dist > idealDist) {
            const pull = (dist - idealDist) * 0.012 * weight * alpha
            const nx = dx / dist, ny = dy / dist
            a.x += nx * pull; a.y += ny * pull
            b.x -= nx * pull; b.y -= ny * pull
          }
        }
      }

      // Very gentle center gravity — keep nodes loosely centered
      for (const n of nodes) {
        n.x += (cx - n.x) * 0.005 * alpha
        n.y += (cy - n.y) * 0.005 * alpha
      }

      // Ellipse containment — push nodes back inside the ellipse boundary
      for (const n of nodes) {
        const dx = (n.x - cx) / rx
        const dy = (n.y - cy) / ry
        const d = dx * dx + dy * dy
        if (d > 1) {
          const scale = 1 / Math.sqrt(d) * 0.95
          n.x = cx + (n.x - cx) * scale
          n.y = cy + (n.y - cy) * scale
        }
      }
    }

    const result = new Map<string, { x: number; y: number; r: number }>()
    for (const n of nodes) result.set(n.id, { x: n.x, y: n.y, r: n.r })
    return result
  }, [innerVideos, internalVideoEdges, size, ellipseCx, ellipseCy, ellipseRx, ellipseRy])

  // Outer playlist positions — evenly distributed along the ellipse perimeter
  const outerPlaylistPositions = useMemo(() => {
    if (outerPlaylists.length === 0 || size.width === 0 || size.height === 0) return new Map<string, { x: number; y: number; r: number }>()

    const cx = ellipseCx
    const cy = ellipseCy
    // Place on the ellipse boundary + a small outward offset so they sit just outside the dashed line
    const rx = ellipseRx + 40
    const ry = ellipseRy + 40

    const result = new Map<string, { x: number; y: number; r: number }>()
    outerPlaylists.forEach((p, i) => {
      // Distribute evenly around the full ellipse, starting from the top
      const angle = (i / outerPlaylists.length) * Math.PI * 2 - Math.PI / 2
      const r = 14 + Math.min(p.connectionCount * 0.5, 20)
      result.set(p.id, {
        x: cx + Math.cos(angle) * rx,
        y: cy + Math.sin(angle) * ry,
        r,
      })
    })
    return result
  }, [outerPlaylists, size, ellipseCx, ellipseCy, ellipseRx, ellipseRy])

  // Outer cluster expanded video positions
  const outerVideoPositions = useMemo(() => {
    if (!expandedOuterClusterId || outerClusterVideos.length === 0 || size.width === 0) return new Map<string, { x: number; y: number; r: number }>()

    const clusterPos = outerPlaylistPositions.get(expandedOuterClusterId)
    if (!clusterPos) return new Map<string, { x: number; y: number; r: number }>()

    const maxEntity = Math.max(...outerClusterVideos.map(v => v.entityCount), 1)
    const spreadR = 40 + outerClusterVideos.length * 6
    const result = new Map<string, { x: number; y: number; r: number }>()

    outerClusterVideos.forEach((v, i) => {
      const angle = (i / outerClusterVideos.length) * Math.PI * 2 - Math.PI / 2
      const r = videoRadius(v.entityCount, maxEntity)
      result.set(v.sourceId, {
        x: clusterPos.x + Math.cos(angle) * spreadR,
        y: clusterPos.y + Math.sin(angle) * spreadR,
        r,
      })
    })
    return result
  }, [expandedOuterClusterId, outerClusterVideos, outerPlaylistPositions, size])

  // ─── Camera helpers ──────────────────────────────────────────────────────────

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
        const factor = 1 - e.deltaY * 0.004
        zoomAround(factor, sx, sy)
      } else if (Math.abs(e.deltaX) > Math.abs(e.deltaY) * 0.5 && Math.abs(e.deltaX) > 2) {
        setCamera(prev => ({ ...prev, panX: prev.panX - e.deltaX, panY: prev.panY - e.deltaY }))
      } else {
        const factor = e.deltaY < 0 ? 1.06 : 0.94
        zoomAround(factor, sx, sy)
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
        else if (expandedOuterClusterId) setExpandedOuterClusterId(null)
        else if (viewLevel === 'expanded') handleBackToMap()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [zoomIn, zoomOut, resetCamera, viewLevel, exploringVideoId, expandedOuterClusterId])

  // ─── Node dragging (Level 1) ──────────────────────────────────────────────

  const handleNodeMouseDown = useCallback((e: React.MouseEvent, nodeId: string) => {
    if (viewLevel !== 'map') return
    e.stopPropagation()
    hasDraggedRef.current = false
    const cam = cameraRef.current
    const rect = svgRef.current?.getBoundingClientRect()
    if (!rect) return
    const worldX = (e.clientX - rect.left - cam.panX) / cam.zoom
    const worldY = (e.clientY - rect.top - cam.panY) / cam.zoom
    const node = liveNodesRef.current.find(n => n.id === nodeId)
    if (!node) return
    dragRef.current = { id: nodeId, offsetX: worldX - node.x, offsetY: worldY - node.y }
    dragPrevPos.current = { x: node.x, y: node.y }

    const onMove = (ev: MouseEvent) => {
      if (!dragRef.current || !svgRef.current) return
      hasDraggedRef.current = true
      const cam2 = cameraRef.current
      const r2 = svgRef.current.getBoundingClientRect()
      const wx = (ev.clientX - r2.left - cam2.panX) / cam2.zoom
      const wy = (ev.clientY - r2.top - cam2.panY) / cam2.zoom
      const n = liveNodesRef.current.find(nd => nd.id === dragRef.current!.id)
      if (n) { n.x = wx - dragRef.current.offsetX; n.y = wy - dragRef.current.offsetY }
    }
    const onUp = () => {
      const n = liveNodesRef.current.find(nd => nd.id === dragRef.current?.id)
      if (n) { n.vx = 0; n.vy = 0 }
      dragRef.current = null
      dragPrevPos.current = null
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [viewLevel])

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
      setHoveredPlaylistId(null)
      setExpandedOuterClusterId(null)
      setExploringVideoId(null)
    }
  }

  // ─── Playlist interactions (Level 1) ──────────────────────────────────────

  const lastClickTime = useRef<number>(0)
  const lastClickId = useRef<string | null>(null)

  const handlePlaylistClick = useCallback((playlist: PlaylistNode) => {
    if (hasDraggedRef.current) return
    const now = Date.now()
    if (lastClickId.current === playlist.id && now - lastClickTime.current < 400) {
      // Double click — expand
      setExpandedPlaylistId(playlist.id)
      setViewLevel('expanded')
      setSelectedPlaylistId(null)
      setExpandedOuterClusterId(null)
      setExploringVideoId(null)
      hasAutoFitRef.current = false
      setCamera({ zoom: 1, panX: 0, panY: 0 })
    } else {
      // Single click — select
      setSelectedPlaylistId(prev => prev === playlist.id ? null : playlist.id)
    }
    lastClickTime.current = now
    lastClickId.current = playlist.id
  }, [])

  const handleBackToMap = useCallback(() => {
    setViewLevel('map')
    setExpandedPlaylistId(null)
    setExpandedOuterClusterId(null)
    setExploringVideoId(null)
    hasAutoFitRef.current = false
  }, [])

  const handleOuterClusterClick = useCallback((playlistId: string) => {
    setExpandedOuterClusterId(prev => prev === playlistId ? null : playlistId)
  }, [])

  const handleOuterClusterNavigate = useCallback((playlistId: string) => {
    setExpandedPlaylistId(playlistId)
    setExpandedOuterClusterId(null)
    setExploringVideoId(null)
    hasAutoFitRef.current = false
    setCamera({ zoom: 1, panX: 0, panY: 0 })
  }, [])

  const handleVideoClick = useCallback((sourceId: string) => {
    if (hasDraggedRef.current) return
    setExploringVideoId(prev => prev === sourceId ? null : sourceId)
  }, [])

  // Loading
  if (loading) {
    return (
      <div ref={containerRef} className="relative w-full h-full flex items-center justify-center">
        <span className="flex items-center gap-2" style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-secondary)' }}>
          <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} />
          Loading playlists…
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
            No playlists connected
          </h3>
          <p style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-secondary)', lineHeight: 1.5 }}>
            Connect YouTube playlists in Automate to see cross-playlist connections.
          </p>
        </div>
      </div>
    )
  }

  // ─── RENDER ─────────────────────────────────────────────────────────────────

  return (
    <div ref={containerRef} className="relative w-full h-full" style={{ overflow: 'hidden', background: 'var(--color-bg-content)', userSelect: 'none', WebkitUserSelect: 'none' }}>

      {/* ── LEVEL 1: Playlist Map ── */}
      {viewLevel === 'map' && size.width > 0 && size.height > 0 && (
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

            {/* Playlist-to-playlist edges */}
            {showEdges && playlistEdges.map(edge => {
              const fromPos = livePositions.get(edge.fromPlaylistId)
              const toPos = livePositions.get(edge.toPlaylistId)
              if (!fromPos || !toPos) return null

              const edgeKey = `${edge.fromPlaylistId}-${edge.toPlaylistId}`
              const isHighlighted = highlightedEdges.has(edgeKey)
              const isActive = isHighlighted
              const hasActive = !!activePlaylistId
              const maxConn = Math.max(...playlistEdges.map(e => e.connectionCount), 1)
              const thickness = 1 + (edge.connectionCount / maxConn) * 3

              return (
                <line
                  key={edgeKey}
                  x1={fromPos.x} y1={fromPos.y} x2={toPos.x} y2={toPos.y}
                  stroke={isActive ? 'var(--color-accent-500)' : 'rgba(100,116,139,1)'}
                  strokeWidth={isActive ? thickness : thickness * 0.5}
                  strokeOpacity={isActive ? 0.5 : hasActive ? 0.04 : 0.12}
                  style={{ transition: 'stroke-opacity 0.15s ease' }}
                />
              )
            })}

            {/* Playlist nodes */}
            {playlists.map((playlist) => {
              const pos = livePositions.get(playlist.id)
              if (!pos) return null

              const r = layoutPositions.get(playlist.id)?.radius ?? playlistRadius(playlist.videoCount)
              const color = playlistColorMap.get(playlist.id) ?? PLAYLIST_COLORS[0]!
              const isSelected = selectedPlaylistId === playlist.id
              const isHovered = hoveredPlaylistId === playlist.id
              const scale = isHovered ? 1.06 : 1
              const label = playlist.playlistName.length > 22
                ? playlist.playlistName.slice(0, 21) + '…'
                : playlist.playlistName

              return (
                <g
                  key={playlist.id}
                  onMouseDown={e => handleNodeMouseDown(e, playlist.id)}
                  onMouseEnter={() => setHoveredPlaylistId(playlist.id)}
                  onMouseLeave={() => setHoveredPlaylistId(null)}
                  onClick={() => handlePlaylistClick(playlist)}
                  style={{ cursor: dragRef.current?.id === playlist.id ? 'grabbing' : 'pointer' }}
                >
                  <g transform={`translate(${pos.x}, ${pos.y})`}>
                    <g transform={`scale(${scale})`} style={{ transition: 'transform 0.15s ease' }}>

                      {/* Selection ring */}
                      {isSelected && (
                        <circle r={r + 5} fill="none" stroke="var(--color-accent-500)" strokeWidth={2} opacity={0.6} />
                      )}

                      {/* Hover glow ring */}
                      {isHovered && !isSelected && (
                        <circle r={r + 4} fill="none" stroke={`${color}35`} strokeWidth={2} />
                      )}

                      {/* Main circle */}
                      <circle r={r} fill={`${color}18`} stroke={color} strokeWidth={2.5} />

                      {/* Video count inside */}
                      <text
                        y={-2}
                        textAnchor="middle"
                        dominantBaseline="middle"
                        style={{
                          fontFamily: 'var(--font-display)',
                          fontSize: Math.max(10, r * 0.45),
                          fontWeight: 700,
                          fill: color,
                          opacity: 0.7,
                          pointerEvents: 'none',
                          userSelect: 'none',
                        }}
                      >
                        {playlist.videoCount}
                      </text>
                      <text
                        y={r * 0.35}
                        textAnchor="middle"
                        dominantBaseline="middle"
                        style={{
                          fontFamily: 'var(--font-body)',
                          fontSize: Math.max(6, r * 0.22),
                          fontWeight: 500,
                          fill: color,
                          opacity: 0.45,
                          pointerEvents: 'none',
                          userSelect: 'none',
                        }}
                      >
                        videos
                      </text>
                    </g>

                    {/* Label below */}
                    <text
                      y={r + 14}
                      textAnchor="middle"
                      style={{
                        fontFamily: 'var(--font-display)',
                        fontSize: 10,
                        fontWeight: 600,
                        fill: isSelected ? 'var(--color-accent-500)'
                          : isHovered ? 'var(--color-text-primary)'
                          : 'var(--color-text-secondary)',
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
            })}

          </g>
        </svg>
      )}

      {/* ── LEVEL 2: Expanded Playlist ── */}
      {viewLevel === 'expanded' && expandedPlaylist && size.width > 0 && size.height > 0 && (
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

            {/* Inner zone boundary */}
            <ellipse
              cx={ellipseCx}
              cy={ellipseCy}
              rx={ellipseRx}
              ry={ellipseRy}
              fill="none"
              stroke={playlistColorMap.get(expandedPlaylistId!) ?? PLAYLIST_COLORS[0]}
              strokeWidth={1.5}
              strokeDasharray="6 4"
              opacity={0.15}
            />

            {/* Inner zone label */}
            <text
              x={ellipseCx}
              y={ellipseCy - ellipseRy - 12}
              textAnchor="middle"
              style={{
                fontFamily: 'var(--font-display)',
                fontSize: 12,
                fontWeight: 700,
                fill: playlistColorMap.get(expandedPlaylistId!) ?? PLAYLIST_COLORS[0],
                opacity: 0.5,
                pointerEvents: 'none',
                userSelect: 'none',
              }}
            >
              {expandedPlaylist.playlistName}
            </text>

            {/* Internal video edges */}
            {showEdges && internalVideoEdges.map(edge => {
              const fromPos = innerVideoPositions.get(edge.fromSourceId)
              const toPos = innerVideoPositions.get(edge.toSourceId)
              if (!fromPos || !toPos) return null

              const dimmed = expandedOuterClusterId !== null
              return (
                <line
                  key={`iv-${edge.fromSourceId}-${edge.toSourceId}`}
                  x1={fromPos.x} y1={fromPos.y} x2={toPos.x} y2={toPos.y}
                  stroke="rgba(100,116,139,1)"
                  strokeWidth={0.8}
                  strokeOpacity={dimmed ? 0.04 : 0.12}
                  style={{ transition: 'stroke-opacity 0.2s ease' }}
                />
              )
            })}

            {/* Cross-connection lines (when outer cluster expanded) */}
            {showEdges && crossVideoEdges.map(edge => {
              const innerSrcIds = new Set(innerVideos.map(v => v.sourceId))
              const innerSourceId = innerSrcIds.has(edge.fromSourceId) ? edge.fromSourceId : edge.toSourceId
              const outerSourceId = innerSrcIds.has(edge.fromSourceId) ? edge.toSourceId : edge.fromSourceId
              const fromPos = innerVideoPositions.get(innerSourceId)
              const toPos = outerVideoPositions.get(outerSourceId)
              if (!fromPos || !toPos) return null

              return (
                <line
                  key={`cv-${edge.fromSourceId}-${edge.toSourceId}`}
                  x1={fromPos.x} y1={fromPos.y} x2={toPos.x} y2={toPos.y}
                  stroke="var(--color-accent-500)"
                  strokeWidth={1.2}
                  strokeOpacity={0.35}
                  strokeDasharray="4 3"
                />
              )
            })}

            {/* Inner video nodes */}
            {innerVideos.map(video => {
              const pos = innerVideoPositions.get(video.sourceId)
              if (!pos) return null

              const r = pos.r
              const color = playlistColorMap.get(expandedPlaylistId!) ?? PLAYLIST_COLORS[0]!
              const isHovered = hoveredVideoId === video.sourceId
              const isExploring = exploringVideoId === video.sourceId
              const isDimmed = expandedOuterClusterId !== null && !connectedInnerSourceIds.has(video.sourceId)
              const scale = isHovered ? 1.12 : 1
              const label = video.videoTitle.length > 24 ? video.videoTitle.slice(0, 23) + '…' : video.videoTitle

              return (
                <g
                  key={video.sourceId}
                  onMouseEnter={() => setHoveredVideoId(video.sourceId)}
                  onMouseLeave={() => setHoveredVideoId(null)}
                  onClick={() => handleVideoClick(video.sourceId)}
                  style={{
                    cursor: 'pointer',
                    opacity: isDimmed ? 0.2 : 1,
                    transition: 'opacity 0.2s ease',
                  }}
                >
                  <g transform={`translate(${pos.x}, ${pos.y})`}>
                    <g transform={`scale(${scale})`} style={{ transition: 'transform 0.15s ease' }}>
                      {isExploring && (
                        <circle r={r + 4} fill="none" stroke="var(--color-accent-500)" strokeWidth={1.5} opacity={0.6} />
                      )}
                      {isHovered && !isExploring && (
                        <circle r={r + 3} fill="none" stroke={`${color}35`} strokeWidth={1.5} />
                      )}
                      <circle r={r} fill={`${color}22`} stroke={color} strokeWidth={1.5} />
                    </g>
                    <text
                      y={r + 10}
                      textAnchor="middle"
                      style={{
                        fontFamily: 'var(--font-body)',
                        fontSize: 8,
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
            })}

            {/* Outer playlist clusters */}
            {outerPlaylists.map(op => {
              const pos = outerPlaylistPositions.get(op.id)
              if (!pos) return null

              const color = playlistColorMap.get(op.id) ?? '#94a3b8'
              const isExpanded = expandedOuterClusterId === op.id
              const r = pos.r
              const label = op.playlistName.length > 18 ? op.playlistName.slice(0, 17) + '…' : op.playlistName

              return (
                <g key={op.id}>
                  {/* Cluster bubble */}
                  <g
                    onClick={() => handleOuterClusterClick(op.id)}
                    style={{ cursor: 'pointer' }}
                  >
                    <g transform={`translate(${pos.x}, ${pos.y})`}>
                      {isExpanded && (
                        <circle r={r + 4} fill="none" stroke={color} strokeWidth={1.5} strokeDasharray="3 2" opacity={0.4} />
                      )}
                      <circle r={r} fill={`${color}15`} stroke={color} strokeWidth={1.5} strokeDasharray={isExpanded ? 'none' : '4 3'} />

                      {/* Connection count */}
                      <text
                        y={1}
                        textAnchor="middle"
                        dominantBaseline="middle"
                        style={{
                          fontFamily: 'var(--font-display)',
                          fontSize: Math.max(8, r * 0.5),
                          fontWeight: 700,
                          fill: color,
                          opacity: 0.6,
                          pointerEvents: 'none',
                          userSelect: 'none',
                        }}
                      >
                        {op.connectionCount}
                      </text>

                      {/* Label below */}
                      <text
                        y={r + 12}
                        textAnchor="middle"
                        style={{
                          fontFamily: 'var(--font-display)',
                          fontSize: 9,
                          fontWeight: 600,
                          fill: color,
                          pointerEvents: 'none',
                          userSelect: 'none',
                        }}
                      >
                        {label}
                      </text>

                      {/* Navigate arrow (below label) */}
                      <text
                        y={r + 24}
                        textAnchor="middle"
                        onClick={(e) => { e.stopPropagation(); handleOuterClusterNavigate(op.id) }}
                        style={{
                          fontFamily: 'var(--font-body)',
                          fontSize: 8,
                          fontWeight: 600,
                          fill: 'var(--color-accent-500)',
                          cursor: 'pointer',
                          opacity: 0.7,
                        }}
                      >
                        Enter →
                      </text>
                    </g>
                  </g>

                  {/* Expanded outer cluster videos */}
                  {isExpanded && outerClusterVideos.map(video => {
                    const vPos = outerVideoPositions.get(video.sourceId)
                    if (!vPos) return null

                    const vr = vPos.r
                    const isVHovered = hoveredVideoId === video.sourceId
                    const isVExploring = exploringVideoId === video.sourceId
                    const vLabel = video.videoTitle.length > 18 ? video.videoTitle.slice(0, 17) + '…' : video.videoTitle

                    return (
                      <g
                        key={video.sourceId}
                        onMouseEnter={() => setHoveredVideoId(video.sourceId)}
                        onMouseLeave={() => setHoveredVideoId(null)}
                        onClick={() => handleVideoClick(video.sourceId)}
                        style={{ cursor: 'pointer' }}
                      >
                        <g transform={`translate(${vPos.x}, ${vPos.y})`}>
                          {isVExploring && (
                            <circle r={vr + 3} fill="none" stroke="var(--color-accent-500)" strokeWidth={1.5} opacity={0.6} />
                          )}
                          {isVHovered && !isVExploring && (
                            <circle r={vr + 2} fill="none" stroke={`${color}35`} strokeWidth={1} />
                          )}
                          <circle r={vr} fill={`${color}22`} stroke={color} strokeWidth={1.2} />
                          {isVHovered && (
                            <text
                              y={vr + 9}
                              textAnchor="middle"
                              style={{
                                fontFamily: 'var(--font-body)',
                                fontSize: 7,
                                fontWeight: 500,
                                fill: 'var(--color-text-secondary)',
                                pointerEvents: 'none',
                                userSelect: 'none',
                              }}
                            >
                              {vLabel}
                            </text>
                          )}
                        </g>
                      </g>
                    )
                  })}
                </g>
              )
            })}

          </g>
        </svg>
      )}

      {/* Hover tooltip (Level 1: playlist) */}
      {viewLevel === 'map' && hoveredPlaylistId && !selectedPlaylistId && (() => {
        const hPlaylist = playlists.find(p => p.id === hoveredPlaylistId)
        if (!hPlaylist) return null
        const livePos = livePositions.get(hPlaylist.id)
        if (!livePos) return null
        const r = layoutPositions.get(hPlaylist.id)?.radius ?? 20
        const color = playlistColorMap.get(hPlaylist.id) ?? PLAYLIST_COLORS[0]!
        const connCount = edgesForPlaylist.get(hPlaylist.id)?.length ?? 0

        const screenX = livePos.x * camera.zoom + camera.panX
        const screenY = livePos.y * camera.zoom + camera.panY
        const cardWidth = 240
        const left = Math.max(8, Math.min(size.width - cardWidth - 8, screenX - cardWidth / 2))
        const top = Math.max(8, screenY - r * camera.zoom - 12)

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
              <span className="font-display" style={{ fontSize: 12, fontWeight: 700, color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {hPlaylist.playlistName}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className="font-body" style={{ fontSize: 9, color: 'var(--color-text-secondary)' }}>
                {hPlaylist.videoCount} videos · {connCount} playlist connections
              </span>
            </div>
            <div className="font-body" style={{ fontSize: 8, color: 'var(--color-text-placeholder)', marginTop: 2 }}>
              Double-click to expand
            </div>
          </div>
        )
      })()}

      {/* Hover tooltip (Level 2: video) */}
      {viewLevel === 'expanded' && hoveredVideoId && !exploringVideoId && (() => {
        const hVideo = videos.find(v => v.sourceId === hoveredVideoId)
        if (!hVideo) return null
        const pos = innerVideoPositions.get(hVideo.sourceId) ?? outerVideoPositions.get(hVideo.sourceId)
        if (!pos) return null
        const color = playlistColorMap.get(hVideo.playlistId) ?? '#94a3b8'

        const screenX = pos.x * camera.zoom + camera.panX
        const screenY = pos.y * camera.zoom + camera.panY
        const cardWidth = 240
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
            <span className="font-body" style={{ fontSize: 9, color: 'var(--color-text-secondary)' }}>
              {hVideo.entityCount} entities
            </span>
          </div>
        )
      })()}

      {/* Back button (Level 2) */}
      {viewLevel === 'expanded' && (
        <button
          type="button"
          onClick={handleBackToMap}
          className="flex items-center gap-1.5 font-body font-semibold cursor-pointer"
          style={{
            position: 'absolute', top: 16, left: 16, zIndex: 20,
            padding: '6px 12px', borderRadius: 20,
            background: 'rgba(255,255,255,0.92)',
            border: '1px solid var(--border-subtle)',
            backdropFilter: 'blur(8px)',
            fontSize: 11,
            color: 'var(--color-text-secondary)',
          }}
        >
          <ArrowLeft size={12} />
          All Playlists
        </button>
      )}

      {/* Right-side detail panel: playlist (Level 1) */}
      {viewLevel === 'map' && selectedPlaylistId && !exploringVideoId && (() => {
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
            onNavigateToPlaylist={(id) => {
              setExpandedPlaylistId(id)
              setViewLevel('expanded')
              setSelectedPlaylistId(null)
              setExpandedOuterClusterId(null)
              hasAutoFitRef.current = false
              setCamera({ zoom: 1, panX: 0, panY: 0 })
            }}
            onNavigateToVideo={(sourceId) => setExploringVideoId(sourceId)}
          />
        )
      })()}

      {/* Right-side detail panel: video (Level 2) */}
      {exploringVideoId && (
        <SourceDetailCard
          sourceId={exploringVideoId}
          onClose={() => setExploringVideoId(null)}
          onNavigateToSource={(sourceId) => setExploringVideoId(sourceId)}
        />
      )}

      {/* Legend (Level 1) */}
      {viewLevel === 'map' && (
        <div
          style={{
            position: 'absolute', bottom: 16, left: 16,
            background: 'rgba(255,255,255,0.92)',
            backdropFilter: 'blur(8px)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 8,
            padding: '8px 10px',
            display: 'flex', flexDirection: 'column', gap: 4,
            zIndex: 20,
          }}
        >
          <span style={{ fontFamily: 'var(--font-display)', fontSize: 8, fontWeight: 700, color: 'var(--color-text-secondary)', letterSpacing: '0.06em', textTransform: 'uppercase' as const }}>
            Playlists
          </span>
          {playlists.map((p, i) => (
            <div key={p.id} className="flex items-center gap-2">
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: `${getPlaylistColor(i)}22`, border: `1.5px solid ${getPlaylistColor(i)}`, flexShrink: 0 }} />
              <span style={{ fontFamily: 'var(--font-body)', fontSize: 9, fontWeight: 500, color: 'var(--color-text-body)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 140 }}>
                {p.playlistName}
              </span>
            </div>
          ))}
        </div>
      )}

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
          <strong style={{ fontFamily: 'var(--font-display)', fontWeight: 700, color: 'var(--color-text-primary)' }}>{playlists.length}</strong> playlists
        </span>
        <span style={{ fontFamily: 'var(--font-body)', fontSize: 9, color: 'var(--color-text-secondary)' }}>
          <strong style={{ fontFamily: 'var(--font-display)', fontWeight: 700, color: 'var(--color-text-primary)' }}>{videos.length}</strong> videos
        </span>
        <span style={{ fontFamily: 'var(--font-body)', fontSize: 9, color: 'var(--color-text-secondary)' }}>
          <strong style={{ fontFamily: 'var(--font-display)', fontWeight: 700, color: 'var(--color-text-primary)' }}>{playlistEdges.length}</strong> connections
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
