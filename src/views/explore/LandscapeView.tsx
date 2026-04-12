import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { ClusterBubble } from '../../components/explore/ClusterBubble'
import { NodeTooltip } from '../../components/explore/NodeTooltip'
import { AnchorConnectionsCard } from '../../components/explore/AnchorConnectionsCard'
import { getEntityColor } from '../../config/entityTypes'
import { useClusterLayout } from '../../hooks/useClusterLayout'
import type { ClusterData } from '../../types/explore'
import type { TooltipData } from '../../components/explore/NodeTooltip'
import type { GraphStats, UnclusteredEntity } from '../../services/exploreQueries'

interface SuggestedClusterData {
  candidateId:             string
  nodeId:                  string
  label:                   string
  entityType:              string
  compositeScore:          number
  reasoningText:           string | null
  mentionCount:            number
  sourceCount:             number
  velocityDirection:       'rising' | 'stable' | 'falling'
  suggestedParentAnchorId: string | null
  duplicateCount:          number
}

interface LandscapeViewProps {
  clusters: ClusterData[]
  stats: GraphStats
  unclustered: UnclusteredEntity[]
  isClusterVisible: (cluster: ClusterData) => boolean
  onClusterClick: (cluster: ClusterData) => void
  onClusterDoubleClick?: (cluster: ClusterData) => void
  onExploreCluster?: (clusterId: string) => void
  selectedClusterId?: string | null
  onClearSelection?: () => void
  suggestedClusters?: SuggestedClusterData[]
  showCrossEdges?: boolean
  onSuggestedClusterClick?: (candidate: SuggestedClusterData) => void
}

const MIN_ZOOM = 0.2
const MAX_ZOOM = 4.0

interface Camera { zoom: number; panX: number; panY: number }

// Live node positions for drag interactions
interface LiveNode {
  id: string
  x: number
  y: number
  vx: number
  vy: number
}

export function LandscapeView({
  clusters,
  stats,
  unclustered,
  isClusterVisible,
  onClusterClick,
  onClusterDoubleClick,
  onExploreCluster,
  selectedClusterId,
  onClearSelection,
  suggestedClusters,
  showCrossEdges = true,
  onSuggestedClusterClick,
}: LandscapeViewProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const sizeRef = useRef({ width: 0, height: 0 })

  // Camera (zoom + pan)
  const [camera, setCamera] = useState<Camera>({ zoom: 1, panX: 0, panY: 0 })
  const cameraRef = useRef<Camera>({ zoom: 1, panX: 0, panY: 0 })
  useEffect(() => { cameraRef.current = camera }, [camera])

  // Pan drag ref
  const panStartRef = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null)

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

  // Only show root anchors — memoize to keep a stable reference
  const rootClusters = useMemo(
    () => clusters.filter(c => !c.anchor.isSubAnchor),
    [clusters]
  )
  const layoutClusters = useClusterLayout(rootClusters, size.width, size.height)

  // ── Live floating positions ──────────────────────────────────────────────
  const liveNodesRef = useRef<LiveNode[]>([])
  const [livePositions, setLivePositions] = useState<Map<string, { x: number; y: number }>>(new Map())
  const dragRef = useRef<{ id: string; offsetX: number; offsetY: number } | null>(null)
  const dragPrevPos = useRef<{ x: number; y: number } | null>(null)
  const rafRef = useRef<number>(0)
  const startAnimRef = useRef<(() => void) | null>(null)

  // Initialize live nodes when layout changes — all nodes get the same floating params
  useEffect(() => {
    liveNodesRef.current = layoutClusters.map(c => ({
      id: c.anchor.id,
      x: c.position.cx,
      y: c.position.cy,
      vx: 0,
      vy: 0,
    }))
    // Sync positions immediately
    const newPos = new Map<string, { x: number; y: number }>()
    for (const c of layoutClusters) newPos.set(c.anchor.id, { x: c.position.cx, y: c.position.cy })
    setLivePositions(newPos)
  }, [layoutClusters])

  // Animation loop — only runs when a node is being dragged (nodes are static otherwise)
  useEffect(() => {
    let running = false

    const tick = () => {
      const nodes = liveNodesRef.current
      if (nodes.length === 0) return

      const nodeMap = new Map<string, LiveNode>()
      for (const n of nodes) nodeMap.set(n.id, n)

      let anyMoving = false

      // Directional drag drift — connected nodes follow in same direction
      if (dragRef.current && dragPrevPos.current) {
        anyMoving = true
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
        if (dragRef.current?.id === n.id) {
          n.vx = 0
          n.vy = 0
          continue
        }

        // Damping — settle to a stop
        n.vx *= 0.9
        n.vy *= 0.9

        // Kill tiny velocities so nodes fully stop
        if (Math.abs(n.vx) < 0.01) n.vx = 0
        if (Math.abs(n.vy) < 0.01) n.vy = 0

        if (n.vx !== 0 || n.vy !== 0) {
          n.x += n.vx
          n.y += n.vy
          anyMoving = true
        }
      }

      const newPos = new Map<string, { x: number; y: number }>()
      for (const n of nodes) newPos.set(n.id, { x: n.x, y: n.y })
      setLivePositions(newPos)

      if (anyMoving || dragRef.current) {
        rafRef.current = requestAnimationFrame(tick)
      } else {
        running = false
      }
    }

    // Expose a way to kick the animation when drag starts
    startAnimRef.current = () => {
      if (!running) {
        running = true
        rafRef.current = requestAnimationFrame(tick)
      }
    }

    // Initial position sync (one frame)
    rafRef.current = requestAnimationFrame(() => {
      const newPos = new Map<string, { x: number; y: number }>()
      for (const n of liveNodesRef.current) newPos.set(n.id, { x: n.x, y: n.y })
      setLivePositions(newPos)
    })

    return () => cancelAnimationFrame(rafRef.current)
  }, [])

  // ── Node dragging ────────────────────────────────────────────────────────
  const handleNodeMouseDown = useCallback((e: React.MouseEvent, nodeId: string) => {
    e.stopPropagation()
    const cam = cameraRef.current
    const rect = svgRef.current?.getBoundingClientRect()
    if (!rect) return

    const worldX = (e.clientX - rect.left - cam.panX) / cam.zoom
    const worldY = (e.clientY - rect.top - cam.panY) / cam.zoom
    const node = liveNodesRef.current.find(n => n.id === nodeId)
    if (!node) return

    dragRef.current = { id: nodeId, offsetX: worldX - node.x, offsetY: worldY - node.y }
    dragPrevPos.current = { x: node.x, y: node.y }
    startAnimRef.current?.()

    const onMove = (ev: MouseEvent) => {
      if (!dragRef.current || !svgRef.current) return
      const cam2 = cameraRef.current
      const r2 = svgRef.current.getBoundingClientRect()
      const wx = (ev.clientX - r2.left - cam2.panX) / cam2.zoom
      const wy = (ev.clientY - r2.top - cam2.panY) / cam2.zoom
      const n = liveNodesRef.current.find(nd => nd.id === dragRef.current!.id)
      if (n) {
        n.x = wx - dragRef.current.offsetX
        n.y = wy - dragRef.current.offsetY
      }
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
  }, [])

  const layoutClustersRef = useRef(layoutClusters)
  useEffect(() => { layoutClustersRef.current = layoutClusters }, [layoutClusters])

  // Connectivity map for drag drift — weight based on cross-cluster edge weight
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
    const maxWeight = Math.max(...clusters.flatMap(c => c.crossClusterEdges.map(e => e.totalWeight)), 1)
    for (const c of clusters) {
      for (const edge of c.crossClusterEdges) {
        addLink(c.anchor.id, edge.targetClusterId, Math.min(edge.totalWeight / maxWeight, 1))
      }
    }
    // Parent-child links
    for (const c of clusters) {
      if (c.anchor.parentAnchorId) addLink(c.anchor.id, c.anchor.parentAnchorId, 0.8)
    }
    connectivityRef.current = map
  }, [clusters])

  // Tooltip state
  const [tooltip, setTooltip] = useState<{ data: TooltipData; x: number; y: number } | null>(null)

  const handleClusterHover = useCallback((cluster: ClusterData | null, event: React.MouseEvent) => {
    if (cluster) {
      setTooltip({ data: { kind: 'cluster', data: cluster }, x: event.clientX, y: event.clientY })
    } else {
      setTooltip(null)
    }
  }, [])

  // ── Camera helpers ──────────────────────────────────────────────────────
  const zoomAround = useCallback((factor: number, cx: number, cy: number) => {
    setCamera(prev => {
      const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, prev.zoom * factor))
      return { zoom: newZoom, panX: cx - (cx - prev.panX) / prev.zoom * newZoom, panY: cy - (cy - prev.panY) / prev.zoom * newZoom }
    })
  }, [])

  const zoomIn = useCallback(() => { zoomAround(1.25, sizeRef.current.width / 2, sizeRef.current.height / 2) }, [zoomAround])
  const zoomOut = useCallback(() => { zoomAround(0.8, sizeRef.current.width / 2, sizeRef.current.height / 2) }, [zoomAround])
  const resetCamera = useCallback(() => { setCamera({ zoom: 1, panX: 0, panY: 0 }) }, [])
  const resetNodes = useCallback(() => {
    const clusterMap = new Map(layoutClusters.map(c => [c.anchor.id, c]))
    for (const n of liveNodesRef.current) {
      const c = clusterMap.get(n.id)
      if (c) {
        n.x = c.position.cx
        n.y = c.position.cy
      }
      n.vx = 0
      n.vy = 0
    }
    const newPos = new Map<string, { x: number; y: number }>()
    for (const n of liveNodesRef.current) newPos.set(n.id, { x: n.x, y: n.y })
    setLivePositions(newPos)
  }, [layoutClusters])

  // Wheel zoom
  useEffect(() => {
    const el = svgRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      const sx = e.clientX - rect.left
      const sy = e.clientY - rect.top

      if (e.ctrlKey) {
        // Trackpad pinch or Ctrl+scroll → zoom around cursor
        setCamera(prev => {
          const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, prev.zoom * (1 - e.deltaY * 0.01)))
          return { zoom: newZoom, panX: sx - (sx - prev.panX) / prev.zoom * newZoom, panY: sy - (sy - prev.panY) / prev.zoom * newZoom }
        })
      } else if (Math.abs(e.deltaY) < 50 || Math.abs(e.deltaX) > 0) {
        // Trackpad two-finger swipe → pan
        setCamera(prev => ({ ...prev, panX: prev.panX - e.deltaX, panY: prev.panY - e.deltaY }))
      } else {
        // Mouse scroll wheel → zoom around cursor
        setCamera(prev => {
          const factor = e.deltaY < 0 ? 1.12 : 0.9
          const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, prev.zoom * factor))
          return { zoom: newZoom, panX: sx - (sx - prev.panX) / prev.zoom * newZoom, panY: sy - (sy - prev.panY) / prev.zoom * newZoom }
        })
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [size.width, size.height])

  // Keyboard zoom
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      if (e.key === '+' || e.key === '=') { zoomIn(); e.preventDefault() }
      else if (e.key === '-' || e.key === '_') { zoomOut(); e.preventDefault() }
      else if (e.key === '0') { resetCamera(); e.preventDefault() }
      else if (e.key === 'r' || e.key === 'R') { resetNodes(); e.preventDefault() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [zoomIn, zoomOut, resetCamera, resetNodes])

  // Pan on SVG background drag
  const handleSvgMouseDown = (e: React.MouseEvent<SVGSVGElement>) => {
    if (e.target !== e.currentTarget) return
    const cam = cameraRef.current
    panStartRef.current = { x: e.clientX, y: e.clientY, panX: cam.panX, panY: cam.panY }
    if (svgRef.current) svgRef.current.style.cursor = 'grab'
  }
  const handleSvgMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const start = panStartRef.current
    if (!start) return
    const dx = e.clientX - start.x
    const dy = e.clientY - start.y
    setCamera(prev => ({ ...prev, panX: start.panX + dx, panY: start.panY + dy }))
  }
  const handleSvgMouseUp = () => {
    panStartRef.current = null
    if (svgRef.current) svgRef.current.style.cursor = 'default'
  }

  const unclusteredX = size.width - 100
  const unclusteredY = size.height - 60
  const hasActiveFilter = clusters.some(c => !isClusterVisible(c))

  return (
    <div
      ref={containerRef}
      className="relative w-full h-full"
      style={{ overflow: 'hidden', background: 'var(--color-bg-content)', userSelect: 'none', WebkitUserSelect: 'none' }}
    >
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
        >
          <g transform={`translate(${camera.panX},${camera.panY}) scale(${camera.zoom})`}>
            {/* 1. Cross-cluster edges */}
            {showCrossEdges && layoutClusters.map(cluster => {
              const pos1 = livePositions.get(cluster.anchor.id)
              return cluster.crossClusterEdges.map(edge => {
                const target = layoutClusters.find(c => c.anchor.id === edge.targetClusterId)
                if (!target) return null
                if (cluster.anchor.id > edge.targetClusterId) return null
                const pos2 = livePositions.get(target.anchor.id)

                const bothVisible = isClusterVisible(cluster) && isClusterVisible(target)
                const baseOpacity = Math.min(0.03 + (edge.totalWeight / 30) * 0.07, 0.10)
                const opacity = hasActiveFilter && !bothVisible ? 0.01 : baseOpacity
                const strokeWidth = Math.min(0.3 + edge.totalWeight * 0.1, 1.5)

                return (
                  <line
                    key={`${cluster.anchor.id}-${edge.targetClusterId}`}
                    x1={pos1?.x ?? cluster.position.cx}
                    y1={pos1?.y ?? cluster.position.cy}
                    x2={pos2?.x ?? target.position.cx}
                    y2={pos2?.y ?? target.position.cy}
                    stroke={`rgba(100,116,139,${opacity})`}
                    strokeWidth={strokeWidth}
                  />
                )
              })
            })}

            {/* 2. Cluster bubbles — using live positions */}
            {layoutClusters.map(cluster => {
              const pos = livePositions.get(cluster.anchor.id)
              const liveCluster = pos ? {
                ...cluster,
                position: { ...cluster.position, cx: pos.x, cy: pos.y },
              } : cluster

              return (
                <g
                  key={cluster.anchor.id}
                  onMouseDown={e => handleNodeMouseDown(e, cluster.anchor.id)}
                  style={{ cursor: 'grab' }}
                >
                  <ClusterBubble
                    cluster={liveCluster}
                    dimmed={!isClusterVisible(cluster)}
                    cameraZoom={camera.zoom}
                    isSubAnchor={cluster.anchor.isSubAnchor}
                    subAnchorCount={cluster.subAnchorIds.length}
                    isSelected={selectedClusterId === cluster.anchor.id}
                    onHover={handleClusterHover}
                    onClick={onClusterClick}
                    onDoubleClick={onClusterDoubleClick}
                  />
                </g>
              )
            })}

            {/* Suggested clusters moved to bottom-left panel */}

            {/* 3. Unclustered zone */}
            {unclustered.length > 0 && (
              <g>
                <text x={unclusteredX} y={unclusteredY - 20} textAnchor="middle"
                  style={{ fontFamily: 'var(--font-display)', fontSize: 8, fontWeight: 700, fill: 'var(--color-text-secondary)', letterSpacing: '0.08em', textTransform: 'uppercase' as const }}>
                  UNCLUSTERED
                </text>
                {unclustered.slice(0, 20).map((entity, i) => {
                  const angle = (i / Math.min(unclustered.length, 20)) * Math.PI * 2
                  const spreadR = 10 + Math.random() * 15
                  return (
                    <circle key={entity.id} cx={unclusteredX + Math.cos(angle) * spreadR} cy={unclusteredY + Math.sin(angle) * spreadR}
                      r={2} fill={getEntityColor(entity.entityType)} opacity={0.4} />
                  )
                })}
              </g>
            )}
          </g>
        </svg>
      )}

      {/* Stats overlay */}
      <div style={{ position: 'absolute', top: 16, right: 16, background: 'rgba(255,255,255,0.9)', border: '1px solid var(--border-subtle)', borderRadius: 10, padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: 3, pointerEvents: 'none', backdropFilter: 'blur(8px)' }}>
        <StatRow label="Clusters" value={stats.anchorCount} />
        <StatRow label="Entities" value={stats.nodeCount} />
        <StatRow label="Edges" value={stats.edgeCount} />
      </div>

      {/* Zoom controls */}
      <div style={{ position: 'absolute', bottom: 16, right: 16, display: 'flex', flexDirection: 'column', gap: 3, zIndex: 20 }}>
        {[
          { label: '+', title: 'Zoom in (+ key)', action: zoomIn },
          { label: '−', title: 'Zoom out (− key)', action: zoomOut },
          { label: '⊙', title: 'Reset view (0 key)', action: resetCamera },
          { label: '↺', title: 'Reset node positions (R key)', action: resetNodes },
        ].map(({ label, title, action }) => (
          <button key={label} type="button" onClick={action} title={title}
            className="flex items-center justify-center font-body font-bold cursor-pointer"
            style={{ width: 26, height: 26, borderRadius: 6, background: 'rgba(255,255,255,0.9)', border: '1px solid rgba(0,0,0,0.08)', color: 'var(--color-text-secondary)', fontSize: 14, lineHeight: 1, backdropFilter: 'blur(8px)' }}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Selected cluster card — positioned above the node */}
      {selectedClusterId && (() => {
        const sel = clusters.find(c => c.anchor.id === selectedClusterId)
        if (!sel) return null
        const livePos = livePositions.get(selectedClusterId)
        const wx = livePos?.x ?? sel.position.cx
        const wy = livePos?.y ?? sel.position.cy
        // Convert world coords to screen coords
        const screenX = wx * camera.zoom + camera.panX
        const screenY = wy * camera.zoom + camera.panY
        const cardWidth = 220
        // Position card centered above the node, clamped to viewport
        const left = Math.max(8, Math.min(size.width - cardWidth - 8, screenX - cardWidth / 2))
        const top = Math.max(8, screenY - sel.position.r * camera.zoom - 14)
        const color = getEntityColor(sel.anchor.entityType)

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
              border: `1px solid ${color}40`,
              borderRadius: 10,
              padding: '12px 14px',
              boxShadow: '0 6px 24px rgba(0,0,0,0.08)',
              animation: 'fadeUp 0.15s ease',
              pointerEvents: 'auto',
            }}
          >
            <div className="flex items-center justify-between" style={{ marginBottom: 6 }}>
              <span className="font-display" style={{ fontSize: 13, fontWeight: 700, color: 'var(--color-text-primary)' }}>
                {sel.anchor.label}
              </span>
              <button type="button" onClick={() => onClearSelection?.()}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-text-secondary)', fontSize: 14, lineHeight: 1, padding: 2 }}>
                ×
              </button>
            </div>
            <div className="flex items-center gap-2" style={{ marginBottom: 6 }}>
              <span className="font-body" style={{
                fontSize: 9, fontWeight: 600, padding: '1px 5px', borderRadius: 3,
                color, background: `${color}12`, border: `1px solid ${color}29`,
              }}>
                {sel.anchor.entityType}
              </span>
              <span className="font-body" style={{ fontSize: 10, color: 'var(--color-text-secondary)' }}>
                {sel.entityCount} entities
              </span>
            </div>
            {sel.anchor.description && (
              <p className="font-body" style={{ fontSize: 10, color: 'var(--color-text-secondary)', lineHeight: 1.4, margin: '0 0 8px 0' }}>
                {sel.anchor.description.length > 100 ? sel.anchor.description.slice(0, 97) + '…' : sel.anchor.description}
              </p>
            )}
            <button
              type="button"
              onClick={() => onExploreCluster?.(sel.anchor.id)}
              className="font-body w-full"
              style={{
                background: 'var(--color-accent-500)', color: 'white',
                fontSize: 11, fontWeight: 600, padding: '6px 0', borderRadius: 6,
                border: 'none', cursor: 'pointer',
              }}
            >
              Explore Cluster →
            </button>
          </div>
        )
      })()}

      {/* Suggested anchors panel — bottom-left corner */}
      {suggestedClusters && suggestedClusters.length > 0 && (
        <SuggestedAnchorsPanel
          suggestions={suggestedClusters}
          onAdd={onSuggestedClusterClick}
        />
      )}

      {/* Tooltip */}
      {tooltip && <NodeTooltip tooltip={tooltip.data} x={tooltip.x} y={tooltip.y} />}

      {/* Right-side connections card — opens when a cluster is selected */}
      {selectedClusterId && (() => {
        const sel = clusters.find(c => c.anchor.id === selectedClusterId)
        if (!sel) return null
        return (
          <AnchorConnectionsCard
            cluster={sel}
            allClusters={clusters}
            onClose={() => onClearSelection?.()}
            onNavigateToCluster={(clusterId) => {
              // Select the target cluster and scroll to it
              const target = clusters.find(c => c.anchor.id === clusterId)
              if (target) {
                onClusterClick(target)
              }
            }}
          />
        )
      })()}
    </div>
  )
}

function SuggestedAnchorsPanel({
  suggestions,
  onAdd,
}: {
  suggestions: SuggestedClusterData[]
  onAdd?: (candidate: SuggestedClusterData) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [dismissed, setDismissed] = useState<Set<string>>(new Set())

  const visible = suggestions.filter(s => !dismissed.has(s.candidateId))
  if (visible.length === 0) return null

  return (
    <div
      style={{
        position: 'absolute',
        bottom: 16,
        left: 16,
        zIndex: 20,
        width: expanded ? 240 : 'auto',
        background: 'rgba(255,255,255,0.95)',
        backdropFilter: 'blur(12px)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 10,
        overflow: 'hidden',
        boxShadow: '0 2px 12px rgba(0,0,0,0.06)',
      }}
    >
      {/* Header — always visible */}
      <button
        type="button"
        onClick={() => setExpanded(prev => !prev)}
        className="flex items-center gap-2 w-full"
        style={{
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          padding: '8px 12px',
          textAlign: 'left',
        }}
      >
        <span style={{ fontSize: 11, color: '#d97706', fontWeight: 700, fontFamily: 'var(--font-body)' }}>
          ✦
        </span>
        <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-primary)', fontFamily: 'var(--font-body)', flex: 1 }}>
          {visible.length} suggested anchor{visible.length !== 1 ? 's' : ''}
        </span>
        <span style={{ fontSize: 10, color: 'var(--color-text-secondary)', transform: expanded ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s ease' }}>
          ▾
        </span>
      </button>

      {/* Expanded list */}
      {expanded && (
        <div style={{ maxHeight: 240, overflowY: 'auto', padding: '0 8px 8px' }}>
          {visible.map(s => {
            const color = getEntityColor(s.entityType)
            return (
              <div
                key={s.candidateId}
                className="flex items-center gap-2"
                style={{
                  padding: '6px 6px',
                  borderRadius: 6,
                  marginBottom: 2,
                }}
              >
                <span style={{
                  width: 8, height: 8, borderRadius: '50%',
                  background: color, flexShrink: 0,
                }} />
                <span style={{
                  flex: 1, fontSize: 10, fontWeight: 500,
                  color: 'var(--color-text-primary)',
                  fontFamily: 'var(--font-body)',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>
                  {s.label}
                </span>
                <span style={{
                  fontSize: 8, color: 'var(--color-text-secondary)',
                  fontFamily: 'var(--font-body)', flexShrink: 0,
                }}>
                  {Math.round(s.compositeScore * 100)}%
                </span>
                <button
                  type="button"
                  onClick={() => onAdd?.(s)}
                  title="Review"
                  style={{
                    background: 'var(--color-accent-50)',
                    border: '1px solid rgba(214,58,0,0.15)',
                    borderRadius: 4,
                    padding: '2px 6px',
                    fontSize: 9,
                    fontWeight: 600,
                    color: 'var(--color-accent-500)',
                    cursor: 'pointer',
                    fontFamily: 'var(--font-body)',
                    flexShrink: 0,
                  }}
                >
                  Add
                </button>
                <button
                  type="button"
                  onClick={() => setDismissed(prev => new Set(prev).add(s.candidateId))}
                  title="Dismiss"
                  style={{
                    background: 'none',
                    border: 'none',
                    padding: '2px 4px',
                    fontSize: 12,
                    color: 'var(--color-text-secondary)',
                    cursor: 'pointer',
                    lineHeight: 1,
                    flexShrink: 0,
                  }}
                >
                  ×
                </button>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function StatRow({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span style={{ fontFamily: 'var(--font-body)', fontSize: 9, color: 'var(--color-text-secondary)' }}>{label}</span>
      <span style={{ fontFamily: 'var(--font-display)', fontSize: 11, fontWeight: 700, color: 'var(--color-text-primary)' }}>{value.toLocaleString()}</span>
    </div>
  )
}
