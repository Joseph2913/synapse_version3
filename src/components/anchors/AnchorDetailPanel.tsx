import { useState, useEffect } from 'react'
import { X, ArrowRight, GitBranch, Compass, RotateCcw, Sparkles } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { EntityBadge } from '../shared/EntityBadge'
import { AnchorSignalBar } from './AnchorSignalBar'
import { getEntityColor } from '../../config/entityTypes'
import { buildAnchorExploreContext } from '../../config/chatEntryContexts'
import { supabase } from '../../services/supabase'
import { fetchAnchorHierarchyInfo, removeSubAnchorRelationship } from '../../services/anchorCandidates'
import type { AnchorCandidateWithNode, AnchorHierarchyInfo } from '../../types/anchors'

interface AnchorDetailPanelProps {
  candidate: AnchorCandidateWithNode
  onClose: () => void
  onConfirm: (candidateId: string, nodeId: string) => void
  onConfirmAsSubAnchor?: (candidateId: string, nodeId: string, parentId: string) => void
  onDismiss: (candidateId: string, dismissCount: number) => void
  onArchive: (candidateId: string, nodeId: string) => void
  onSelectSubAnchor?: (nodeId: string) => void
  onRefresh?: () => void
  onDelete?: (candidateId: string) => void
  onRestore?: (candidateId: string, nodeId: string) => void
}

interface NeighbourNode {
  id: string
  label: string
  entity_type: string
}

export function AnchorDetailPanel({ candidate, onClose, onConfirm, onConfirmAsSubAnchor, onDismiss, onArchive, onSelectSubAnchor, onRefresh, onDelete, onRestore }: AnchorDetailPanelProps) {
  const navigate = useNavigate()
  const [neighbours, setNeighbours] = useState<NeighbourNode[]>([])
  const [hierarchyInfo, setHierarchyInfo] = useState<AnchorHierarchyInfo | null>(null)
  const [showParentPicker, setShowParentPicker] = useState(false)
  const [rootAnchors, setRootAnchors] = useState<Array<{ id: string; label: string; entity_type: string }>>([])
  const node = candidate.node
  const isSuggested = candidate.status === 'suggested'
  const isDormant = candidate.status === 'dormant'

  // Fetch connected nodes
  useEffect(() => {
    if (!node) return
    const fetchNeighbours = async () => {
      const [outRes, inRes] = await Promise.all([
        supabase.from('knowledge_edges').select('target_node_id').eq('source_node_id', node.id).limit(8),
        supabase.from('knowledge_edges').select('source_node_id').eq('target_node_id', node.id).limit(8),
      ])
      const ids = new Set<string>()
      for (const r of outRes.data ?? []) ids.add(r.target_node_id)
      for (const r of inRes.data ?? []) ids.add(r.source_node_id)
      ids.delete(node.id)
      if (ids.size === 0) { setNeighbours([]); return }
      const { data } = await supabase.from('knowledge_nodes').select('id, label, entity_type').in('id', Array.from(ids)).limit(8)
      setNeighbours((data ?? []) as NeighbourNode[])
    }
    fetchNeighbours()
  }, [node])

  // Fetch hierarchy info
  useEffect(() => {
    if (!node || !candidate.userId) return
    fetchAnchorHierarchyInfo(candidate.userId, node.id)
      .then(setHierarchyInfo)
      .catch(() => setHierarchyInfo(null))
  }, [node?.id, candidate.userId])

  // Fetch root anchors when picker opens
  useEffect(() => {
    if (!showParentPicker || !candidate.userId) return
    const fetchRoots = async () => {
      const { data } = await supabase
        .from('knowledge_nodes')
        .select('id, label, entity_type')
        .eq('user_id', candidate.userId)
        .eq('is_anchor', true)
        .eq('is_merged', false)
        .is('parent_anchor_id', null)
        .order('label')
      setRootAnchors((data ?? []).filter(a => a.id !== node?.id) as Array<{ id: string; label: string; entity_type: string }>)
    }
    fetchRoots()
  }, [showParentPicker, candidate.userId, node?.id])

  const handleRemoveParent = async () => {
    if (!node) return
    const success = await removeSubAnchorRelationship(node.id)
    if (success) {
      setHierarchyInfo(prev => prev ? { ...prev, parentAnchorId: null, parentLabel: null, parentEntityType: null } : null)
      window.dispatchEvent(new CustomEvent('synapse:anchor-confirmed'))
      onRefresh?.()
    }
  }

  if (!node) {
    return (
      <div style={{ padding: '24px 20px' }}>
        <div className="flex items-center justify-between" style={{ marginBottom: 16 }}>
          <span className="font-display" style={{ fontSize: 15, fontWeight: 700 }}>Node Deleted</span>
          <button type="button" onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-text-secondary)' }}><X size={16} /></button>
        </div>
        <p className="font-body" style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginBottom: 16 }}>The source node for this candidate has been deleted.</p>
        <button
          type="button"
          onClick={() => onDelete?.(candidate.id)}
          className="font-body"
          style={{
            fontSize: 12, fontWeight: 600, color: 'var(--semantic-red-500, #ef4444)',
            background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.2)',
            borderRadius: 8, padding: '8px 16px', cursor: 'pointer', width: '100%',
          }}
        >
          Remove from list
        </button>
      </div>
    )
  }

  const dormantDays = isDormant && candidate.dormantSince
    ? Math.floor((Date.now() - new Date(candidate.dormantSince).getTime()) / 86400000)
    : 0

  return (
    <div style={{ height: '100%', overflowY: 'auto', padding: '24px 20px', animation: 'slideInRight 0.2s ease' }}>
      {/* Header */}
      <div className="flex items-start justify-between" style={{ marginBottom: 12 }}>
        <div>
          <h2 className="font-display" style={{ fontSize: 18, fontWeight: 700, color: 'var(--color-text-primary)', margin: 0 }}>
            {node.label}
          </h2>
          <div className="flex items-center gap-2" style={{ marginTop: 4 }}>
            <EntityBadge type={node.entity_type} size="xs" />
            <span className="font-body" style={{
              fontSize: 10, fontWeight: 600, padding: '2px 7px', borderRadius: 4,
              background: isSuggested ? 'rgba(245,158,11,0.08)' : isDormant ? 'rgba(245,158,11,0.08)' : 'var(--color-accent-50)',
              color: isSuggested ? '#d97706' : isDormant ? '#d97706' : 'var(--color-accent-500)',
              border: `1px solid ${isSuggested || isDormant ? 'rgba(245,158,11,0.2)' : 'rgba(214,58,0,0.15)'}`,
            }}>
              {isSuggested ? '✦ Suggested' : isDormant ? '◑ Dormant' : candidate.compositeScore === 1.0 ? 'Manual' : 'Confirmed'}
            </span>
          </div>
        </div>
        <button type="button" onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-text-secondary)', padding: 4 }}>
          <X size={16} />
        </button>
      </div>

      {/* Why suggested? */}
      {isSuggested && candidate.reasoningText && (
        <div style={{ marginBottom: 16 }}>
          <div style={{
            background: 'rgba(245,158,11,0.05)', border: '1px solid rgba(245,158,11,0.15)',
            borderRadius: 8, padding: '10px 12px',
          }}>
            <p className="font-body" style={{ fontSize: 12, color: 'var(--color-text-body)', lineHeight: 1.6, margin: 0 }}>
              ✦ {candidate.reasoningText}
            </p>
          </div>
        </div>
      )}

      {/* Signal bars */}
      <div style={{ marginBottom: 20 }}>
        <div className="font-display font-bold uppercase" style={{ fontSize: 10, letterSpacing: '0.08em', color: 'var(--color-text-secondary)', marginBottom: 8 }}>
          Signal Scores
        </div>

        {/* Lead signal summary */}
        {(() => {
          const scores: Record<string, number> = {
            centrality: candidate.centralityScore,
            diversity: candidate.diversityScore,
            velocity: candidate.velocityScore,
            richness: candidate.richnessScore,
          }
          const top = Object.entries(scores).sort((a, b) => b[1] - a[1])[0]
          const labels: Record<string, string> = {
            centrality: 'a structurally important hub in your graph',
            diversity: 'well-evidenced across multiple sources',
            velocity: 'actively growing in your recent content',
            richness: 'a conceptually rich node with diverse relationships',
          }
          const summary = top && top[1] > 0
            ? `This concept is ${labels[top[0]] ?? 'a strong anchor candidate'}.`
            : null
          return summary ? (
            <div style={{ background: 'var(--color-bg-inset)', borderRadius: 8, padding: '8px 12px', marginBottom: 12 }}>
              <p className="font-body" style={{ fontSize: 12, color: 'var(--color-text-body)', fontStyle: 'italic', margin: 0 }}>
                {summary}
              </p>
            </div>
          ) : null
        })()}

        <AnchorSignalBar
          centralityScore={candidate.centralityScore}
          diversityScore={candidate.diversityScore}
          velocityScore={candidate.velocityScore}
          richnessScore={candidate.richnessScore}
          velocityDirection={candidate.velocityDirection}
        />
      </div>

      {/* Dormant warning */}
      {isDormant && (
        <div style={{
          background: 'rgba(245,158,11,0.05)', border: '1px solid rgba(245,158,11,0.15)',
          borderRadius: 8, padding: '10px 12px', marginBottom: 16,
        }}>
          <p className="font-body" style={{ fontSize: 12, color: '#d97706', margin: 0 }}>
            ◑ This anchor has been quiet for {dormantDays} days.
          </p>
          <button
            type="button"
            onClick={() => navigate(`/explore?node=${node.id}`)}
            className="font-body"
            style={{ fontSize: 11, color: 'var(--color-accent-500)', background: 'none', border: 'none', cursor: 'pointer', padding: 0, marginTop: 4, fontWeight: 600 }}
          >
            Reactivate →
          </button>
        </div>
      )}

      {/* Suggested parent indicator */}
      {isSuggested && candidate.suggestedParentAnchorId && (
        <div style={{
          background: 'rgba(100,116,139,0.05)',
          border: '1px solid rgba(100,116,139,0.2)',
          borderRadius: 8, padding: '8px 12px', marginBottom: 12,
        }}>
          <p className="font-body" style={{ fontSize: 11, color: 'var(--color-text-secondary)', margin: 0, lineHeight: 1.5 }}>
            ⊃ This concept may belong under an existing anchor. See confirmation options below.
          </p>
        </div>
      )}

      {/* Hierarchy section */}
      {hierarchyInfo && (hierarchyInfo.parentAnchorId || hierarchyInfo.subAnchors.length > 0) && (
        <div style={{ marginBottom: 16 }}>
          <div className="font-display font-bold uppercase" style={{ fontSize: 10, letterSpacing: '0.08em', color: 'var(--color-text-secondary)', marginBottom: 8 }}>
            Hierarchy
          </div>

          {/* Parent relationship */}
          {hierarchyInfo.parentAnchorId && (
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '8px 10px', borderRadius: 8,
              background: 'var(--color-bg-inset)', marginBottom: 6,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                <span className="font-body" style={{ fontSize: 11, color: 'var(--color-text-secondary)', flexShrink: 0 }}>
                  Parent:
                </span>
                <span style={{
                  width: 6, height: 6, borderRadius: '50%',
                  background: getEntityColor(hierarchyInfo.parentEntityType ?? 'Anchor'),
                  flexShrink: 0,
                }} />
                <span className="font-body font-semibold truncate" style={{ fontSize: 12, color: 'var(--color-text-primary)' }}>
                  {hierarchyInfo.parentLabel}
                </span>
              </div>
              <button
                type="button"
                onClick={handleRemoveParent}
                className="font-body"
                style={{
                  fontSize: 10, fontWeight: 600,
                  color: 'var(--color-text-secondary)',
                  background: 'none', border: 'none', cursor: 'pointer', flexShrink: 0,
                }}
              >
                Remove
              </button>
            </div>
          )}

          {/* Sub-anchors list */}
          {hierarchyInfo.subAnchors.length > 0 && (
            <div>
              <span className="font-body" style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>
                Sub-anchors ({hierarchyInfo.subAnchors.length}):
              </span>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 6 }}>
                {hierarchyInfo.subAnchors.map(sa => (
                  <div
                    key={sa.id}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 8,
                      padding: '6px 10px', borderRadius: 6,
                      background: 'var(--color-bg-inset)',
                      cursor: 'pointer',
                    }}
                    onClick={() => onSelectSubAnchor?.(sa.id)}
                  >
                    <span style={{
                      width: 6, height: 6, borderRadius: '50%',
                      background: getEntityColor(sa.entityType), flexShrink: 0,
                    }} />
                    <span className="font-body" style={{ fontSize: 12, color: 'var(--color-text-primary)', flex: 1 }}>
                      {sa.label}
                    </span>
                    <EntityBadge type={sa.entityType} size="xs" />
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Connected Nodes */}
      <div style={{ marginBottom: 20 }}>
        <div className="font-display font-bold uppercase" style={{ fontSize: 10, letterSpacing: '0.08em', color: 'var(--color-text-secondary)', marginBottom: 8 }}>
          Connected Nodes
        </div>
        {neighbours.length === 0 ? (
          <p className="font-body" style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>No connected nodes found.</p>
        ) : (
          <div className="flex flex-col gap-0">
            {neighbours.map(nb => (
              <button
                key={nb.id}
                type="button"
                onClick={() => navigate(`/explore?node=${nb.id}`)}
                className="flex items-center justify-between font-body w-full text-left"
                style={{
                  fontSize: 12, color: 'var(--color-text-body)', padding: '6px 8px',
                  borderRadius: 6, background: 'transparent', border: 'none', cursor: 'pointer',
                  transition: 'background 0.1s ease',
                }}
                onMouseEnter={e => { e.currentTarget.style.background = 'var(--color-bg-inset)' }}
                onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
              >
                <span className="flex items-center gap-2 truncate">
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: getEntityColor(nb.entity_type), flexShrink: 0 }} />
                  {nb.label}
                </span>
                <span className="flex items-center gap-2 shrink-0">
                  <EntityBadge type={nb.entity_type} size="xs" />
                  <ArrowRight size={10} style={{ color: 'var(--color-text-secondary)' }} />
                </span>
              </button>
            ))}
            {candidate.connectionCount > 8 && (
              <button
                type="button"
                onClick={() => navigate(`/explore?node=${node.id}`)}
                className="font-body"
                style={{ fontSize: 11, color: 'var(--color-accent-500)', background: 'none', border: 'none', cursor: 'pointer', padding: '6px 8px', textAlign: 'left', fontWeight: 600 }}
              >
                View all in Explore →
              </button>
            )}
          </div>
        )}
      </div>

      {/* Source Distribution */}
      {candidate.sourceCount === 1 && (
        <div style={{ marginBottom: 16 }}>
          <p className="font-body" style={{ fontSize: 11, color: '#d97706', margin: 0 }}>
            ⚠ Single source — consider ingesting more content on this topic
          </p>
        </div>
      )}

      {/* Cross-Anchor Connections */}
      <div style={{ marginBottom: 20 }}>
        <div className="font-display font-bold uppercase" style={{ fontSize: 10, letterSpacing: '0.08em', color: 'var(--color-text-secondary)', marginBottom: 8 }}>
          Cross-Anchor Connections
        </div>
        {candidate.anchorConnections === 0 ? (
          <p className="font-body" style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>Not yet connected to other anchors</p>
        ) : (
          <p className="font-body" style={{ fontSize: 12, color: 'var(--color-text-body)' }}>
            Connected to {candidate.anchorConnections} other anchor{candidate.anchorConnections !== 1 ? 's' : ''}
          </p>
        )}
      </div>

      {/* Actions */}
      <div style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: 16, marginTop: 20, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {/* Explore with AI — PRD-B §3.13 */}
        <button
          type="button"
          onClick={() => {
            const ctx = buildAnchorExploreContext({
              nodeId: node.id,
              label: node.label,
              entityType: node.entity_type,
              description: node.description ?? null,
            })
            navigate('/ask', { state: { chatContext: ctx } })
          }}
          className="font-body w-full flex items-center justify-center gap-1.5"
          style={{
            background: 'var(--color-accent-50)',
            color: 'var(--color-accent-500)',
            fontSize: 12, fontWeight: 600, padding: '8px 16px', borderRadius: 8,
            border: '1px solid rgba(214,58,0,0.15)', cursor: 'pointer',
            transition: 'background 0.12s ease',
          }}
          onMouseEnter={e => { e.currentTarget.style.background = 'rgba(214,58,0,0.1)' }}
          onMouseLeave={e => { e.currentTarget.style.background = 'var(--color-accent-50)' }}
        >
          <Sparkles size={13} /> Explore with AI
        </button>

        {isSuggested ? (
          <>
            <button
              type="button"
              onClick={() => onConfirm(candidate.id, node.id)}
              className="font-body w-full"
              style={{
                background: 'var(--color-accent-500)', color: 'white',
                fontSize: 12, fontWeight: 600, padding: '8px 16px', borderRadius: 8, border: 'none', cursor: 'pointer',
              }}
            >
              Confirm Anchor
            </button>
            <button
              type="button"
              onClick={() => setShowParentPicker(!showParentPicker)}
              className="font-body w-full flex items-center justify-center gap-1.5"
              style={{
                background: showParentPicker ? 'var(--color-accent-50)' : 'var(--color-bg-inset)',
                color: showParentPicker ? 'var(--color-accent-500)' : 'var(--color-text-body)',
                fontSize: 12, fontWeight: 600, padding: '8px 16px', borderRadius: 8,
                border: `1px solid ${showParentPicker ? 'rgba(214,58,0,0.15)' : 'var(--border-subtle)'}`,
                cursor: 'pointer',
              }}
            >
              <GitBranch size={12} /> Add as Sub-anchor
            </button>

            {/* Inline parent anchor picker */}
            {showParentPicker && (
              <div style={{
                background: 'var(--color-bg-card)',
                border: '1px solid var(--border-subtle)',
                borderRadius: 8, padding: 6,
                maxHeight: 200, overflowY: 'auto',
              }}>
                <p className="font-body" style={{ fontSize: 10, color: 'var(--color-text-secondary)', margin: '2px 6px 6px', fontWeight: 600 }}>
                  Select parent anchor:
                </p>
                {rootAnchors.length === 0 ? (
                  <p className="font-body" style={{ fontSize: 11, color: 'var(--color-text-secondary)', padding: '8px 6px' }}>
                    No root anchors available
                  </p>
                ) : (
                  rootAnchors.map(anchor => (
                    <button
                      key={anchor.id}
                      type="button"
                      onClick={() => {
                        onConfirmAsSubAnchor?.(candidate.id, node.id, anchor.id)
                        setShowParentPicker(false)
                      }}
                      className="font-body w-full flex items-center gap-2 text-left"
                      style={{
                        fontSize: 12, padding: '6px 8px', borderRadius: 6,
                        background: 'transparent', border: 'none', cursor: 'pointer',
                        color: 'var(--color-text-body)',
                      }}
                      onMouseEnter={e => { e.currentTarget.style.background = 'var(--color-bg-inset)' }}
                      onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
                    >
                      <span style={{ width: 6, height: 6, borderRadius: '50%', background: getEntityColor(anchor.entity_type), flexShrink: 0 }} />
                      <span className="truncate" style={{ flex: 1 }}>{anchor.label}</span>
                      <EntityBadge type={anchor.entity_type} size="xs" />
                    </button>
                  ))
                )}
              </div>
            )}

            <button
              type="button"
              onClick={() => onDismiss(candidate.id, candidate.dismissCount)}
              className="font-body w-full"
              style={{
                background: 'transparent', color: 'var(--color-text-secondary)',
                fontSize: 12, fontWeight: 600, padding: '8px 16px', borderRadius: 8, border: 'none', cursor: 'pointer',
              }}
            >
              Dismiss
            </button>
          </>
        ) : candidate.status === 'archived' ? (
          <>
            <button
              type="button"
              onClick={() => onRestore?.(candidate.id, node.id)}
              className="font-body w-full flex items-center justify-center gap-1.5"
              style={{
                background: 'var(--color-accent-500)', color: 'white',
                fontSize: 12, fontWeight: 600, padding: '8px 16px', borderRadius: 8, border: 'none', cursor: 'pointer',
              }}
            >
              <RotateCcw size={12} /> Restore Anchor
            </button>
            <button
              type="button"
              onClick={() => onDelete?.(candidate.id)}
              className="font-body w-full"
              style={{
                background: 'transparent', color: 'var(--semantic-red-500, #ef4444)',
                fontSize: 12, fontWeight: 600, padding: '8px 16px', borderRadius: 8, border: 'none', cursor: 'pointer',
              }}
            >
              Delete Permanently
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={() => navigate(`/explore?node=${node.id}`)}
              className="font-body w-full flex items-center justify-center gap-1.5"
              style={{
                background: 'var(--color-bg-inset)', color: 'var(--color-accent-500)',
                fontSize: 12, fontWeight: 600, padding: '8px 16px', borderRadius: 8,
                border: '1px solid rgba(214,58,0,0.15)', cursor: 'pointer',
              }}
            >
              <Compass size={12} /> View in Explore
            </button>
            {!candidate.node?.parent_anchor_id && (
              <>
                <button
                  type="button"
                  onClick={() => setShowParentPicker(!showParentPicker)}
                  className="font-body w-full flex items-center justify-center gap-1.5"
                  style={{
                    background: showParentPicker ? 'var(--color-accent-50)' : 'var(--color-bg-inset)',
                    color: showParentPicker ? 'var(--color-accent-500)' : 'var(--color-text-body)',
                    fontSize: 12, fontWeight: 600, padding: '8px 16px', borderRadius: 8,
                    border: `1px solid ${showParentPicker ? 'rgba(214,58,0,0.15)' : 'var(--border-subtle)'}`,
                    cursor: 'pointer',
                  }}
                >
                  <GitBranch size={12} /> Make Sub-anchor
                </button>

                {showParentPicker && (
                  <div style={{
                    background: 'var(--color-bg-card)',
                    border: '1px solid var(--border-subtle)',
                    borderRadius: 8, padding: 6,
                    maxHeight: 200, overflowY: 'auto',
                  }}>
                    <p className="font-body" style={{ fontSize: 10, color: 'var(--color-text-secondary)', margin: '2px 6px 6px', fontWeight: 600 }}>
                      Select parent anchor:
                    </p>
                    {rootAnchors.length === 0 ? (
                      <p className="font-body" style={{ fontSize: 11, color: 'var(--color-text-secondary)', padding: '8px 6px' }}>
                        No root anchors available
                      </p>
                    ) : (
                      rootAnchors.map(anchor => (
                        <button
                          key={anchor.id}
                          type="button"
                          onClick={async () => {
                            const { promoteToSubAnchor: promote } = await import('../../services/anchorCandidates')
                            const success = await promote(candidate.id, node.id, anchor.id)
                            if (success) {
                              setShowParentPicker(false)
                              onRefresh?.()
                              window.dispatchEvent(new CustomEvent('synapse:anchor-confirmed'))
                            }
                          }}
                          className="font-body w-full flex items-center gap-2 text-left"
                          style={{
                            fontSize: 12, padding: '6px 8px', borderRadius: 6,
                            background: 'transparent', border: 'none', cursor: 'pointer',
                            color: 'var(--color-text-body)',
                          }}
                          onMouseEnter={e => { e.currentTarget.style.background = 'var(--color-bg-inset)' }}
                          onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
                        >
                          <span style={{ width: 6, height: 6, borderRadius: '50%', background: getEntityColor(anchor.entity_type), flexShrink: 0 }} />
                          <span className="truncate" style={{ flex: 1 }}>{anchor.label}</span>
                          <EntityBadge type={anchor.entity_type} size="xs" />
                        </button>
                      ))
                    )}
                  </div>
                )}
              </>
            )}
            <button
              type="button"
              onClick={() => onArchive(candidate.id, node.id)}
              className="font-body w-full"
              style={{
                background: 'transparent', color: 'var(--color-text-secondary)',
                fontSize: 12, fontWeight: 600, padding: '8px 16px', borderRadius: 8, border: 'none', cursor: 'pointer',
              }}
            >
              Archive
            </button>
          </>
        )}
      </div>
    </div>
  )
}
