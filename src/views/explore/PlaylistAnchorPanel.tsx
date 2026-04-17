import { useState, useEffect } from 'react'
import { X, Network, FileText, Link2 } from 'lucide-react'
import { EntityBadge } from '../../components/shared/EntityBadge'
import { getEntityColor } from '../../config/entityTypes'
import { supabase } from '../../services/supabase'
import { useAuth } from '../../hooks/useAuth'
import type { PlaylistGraphAnchor } from '../../types/explore'

interface PlaylistAnchorPanelProps {
  anchor: PlaylistGraphAnchor
  onClose: () => void
}

interface ConnectedAnchor {
  id: string
  label: string
  entityType: string
  edgeCount: number
}

export function PlaylistAnchorPanel({ anchor, onClose }: PlaylistAnchorPanelProps) {
  const { user } = useAuth()
  const [connections, setConnections] = useState<ConnectedAnchor[]>([])
  const [totalEdges, setTotalEdges] = useState(0)
  const color = getEntityColor(anchor.entityType)

  // Fetch connections to other anchors
  useEffect(() => {
    if (!user) return
    let cancelled = false

    const fetchConnections = async () => {
      // Get edges from this anchor node
      const [outRes, inRes] = await Promise.all([
        supabase.from('knowledge_edges').select('target_node_id').eq('source_node_id', anchor.nodeId).eq('user_id', user.id),
        supabase.from('knowledge_edges').select('source_node_id').eq('target_node_id', anchor.nodeId).eq('user_id', user.id),
      ])

      if (cancelled) return

      const edgeCounts = new Map<string, number>()
      for (const r of outRes.data ?? []) {
        const id = r.target_node_id as string
        edgeCounts.set(id, (edgeCounts.get(id) ?? 0) + 1)
      }
      for (const r of inRes.data ?? []) {
        const id = r.source_node_id as string
        edgeCounts.set(id, (edgeCounts.get(id) ?? 0) + 1)
      }
      edgeCounts.delete(anchor.nodeId)
      setTotalEdges(edgeCounts.size)

      // Check which connected nodes are anchors
      const connIds = Array.from(edgeCounts.keys()).slice(0, 50)
      if (connIds.length === 0) { setConnections([]); return }

      const { data: nodes } = await supabase
        .from('knowledge_nodes')
        .select('id, label, entity_type, is_anchor')
        .in('id', connIds)
        .eq('is_anchor', true)

      if (cancelled) return

      const anchorConns: ConnectedAnchor[] = (nodes ?? []).map((n: Record<string, unknown>) => ({
        id: n.id as string,
        label: n.label as string,
        entityType: n.entity_type as string,
        edgeCount: edgeCounts.get(n.id as string) ?? 0,
      }))
      anchorConns.sort((a, b) => b.edgeCount - a.edgeCount)
      setConnections(anchorConns.slice(0, 10))
    }

    fetchConnections()
    return () => { cancelled = true }
  }, [anchor.nodeId, user])

  return (
    <div
      style={{
        position: 'absolute',
        top: 0,
        right: 0,
        width: 320,
        height: '100%',
        background: 'var(--color-bg-card)',
        borderLeft: '1px solid var(--border-subtle)',
        zIndex: 40,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      {/* Header */}
      <div style={{ padding: '16px 16px 12px', borderBottom: '1px solid var(--border-subtle)' }}>
        <div className="flex items-center justify-between" style={{ marginBottom: 8 }}>
          <EntityBadge type={anchor.entityType} />
          <button
            type="button"
            onClick={onClose}
            className="flex items-center justify-center cursor-pointer"
            style={{ width: 24, height: 24, borderRadius: 6, background: 'none', border: 'none', color: 'var(--color-text-secondary)' }}
          >
            <X size={14} />
          </button>
        </div>
        <h3 className="font-display" style={{ fontSize: 15, fontWeight: 700, color: 'var(--color-text-primary)', margin: 0 }}>
          {anchor.label}
        </h3>
        {anchor.description && (
          <p className="font-body" style={{ fontSize: 12, color: 'var(--color-text-secondary)', margin: '6px 0 0', lineHeight: 1.5 }}>
            {anchor.description}
          </p>
        )}
      </div>

      {/* Stats row */}
      <div className="flex items-center gap-4" style={{ padding: '10px 16px', borderBottom: '1px solid var(--border-subtle)' }}>
        <div className="flex items-center gap-1.5">
          <Network size={12} style={{ color: 'var(--color-text-placeholder)' }} />
          <span className="font-body" style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>
            <strong style={{ color: 'var(--color-text-primary)', fontWeight: 600 }}>{connections.length}</strong> anchor connections
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <Link2 size={12} style={{ color: 'var(--color-text-placeholder)' }} />
          <span className="font-body" style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>
            <strong style={{ color: 'var(--color-text-primary)', fontWeight: 600 }}>{totalEdges}</strong> edges
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <FileText size={12} style={{ color: 'var(--color-text-placeholder)' }} />
          <span className="font-body" style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>
            <strong style={{ color: 'var(--color-text-primary)', fontWeight: 600 }}>{anchor.connectedSourceIds.length}</strong> sources
          </span>
        </div>
      </div>

      {/* Score bar */}
      <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--border-subtle)' }}>
        <div className="flex items-center justify-between" style={{ marginBottom: 4 }}>
          <span className="font-body" style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>Composite Score</span>
          <span className="font-body" style={{ fontSize: 11, fontWeight: 600, color }}>
            {Math.round(anchor.compositeScore * 100)}%
          </span>
        </div>
        <div style={{ height: 4, borderRadius: 2, background: 'var(--color-bg-content)' }}>
          <div style={{ height: '100%', width: `${anchor.compositeScore * 100}%`, borderRadius: 2, background: color }} />
        </div>
      </div>

      {/* Connected anchors */}
      <div style={{ flex: 1, overflow: 'auto', padding: '12px 16px' }}>
        {connections.length > 0 && (
          <>
            <div className="font-display" style={{ fontSize: 10, fontWeight: 700, color: 'var(--color-text-placeholder)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>
              Top Connections ({connections.length})
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {connections.map(conn => (
                <div key={conn.id} className="flex items-center gap-2" style={{ padding: '4px 0' }}>
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: getEntityColor(conn.entityType), flexShrink: 0 }} />
                  <span className="font-body" style={{ fontSize: 11, color: 'var(--color-text-primary)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {conn.label}
                  </span>
                  <span className="font-body" style={{ fontSize: 10, color: 'var(--color-text-placeholder)', flexShrink: 0 }}>
                    {conn.edgeCount} edge{conn.edgeCount !== 1 ? 's' : ''}
                  </span>
                </div>
              ))}
            </div>
          </>
        )}
        {connections.length === 0 && (
          <div className="font-body" style={{ fontSize: 11, color: 'var(--color-text-placeholder)', textAlign: 'center', padding: '20px 0' }}>
            No anchor connections found
          </div>
        )}
      </div>
    </div>
  )
}
