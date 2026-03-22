import { useState, useEffect, useRef } from 'react'
import { Pencil, X, Check, AlertCircle, ExternalLink, GitBranch, MessageSquare } from 'lucide-react'
import { SectionLabel } from '../ui/SectionLabel'
import { EntityDot } from '../shared/EntityDot'
import { EntityBadge } from '../shared/EntityBadge'
import { SourceIcon } from '../shared/SourceIcon'
import { RelationshipTag } from '../shared/RelationshipTag'
import { useNodeNeighbors } from '../../hooks/useNodeNeighbors'
import { useSettings } from '../../hooks/useSettings'
import { supabase, updateNode, fetchNodeById } from '../../services/supabase'
import { useGraphContext } from '../../hooks/useGraphContext'
import type { KnowledgeNode } from '../../types/database'

function formatTime(dateStr: string): string {
  const now = Date.now()
  const then = new Date(dateStr).getTime()
  const diff = now - then
  const minutes = Math.floor(diff / 60000)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function TagPill({ label, onRemove }: { label: string; onRemove?: () => void }) {
  return (
    <span
      className="inline-flex items-center gap-1 font-body font-semibold text-text-secondary rounded-xl"
      style={{
        fontSize: '10px',
        padding: '3px 10px',
        background: 'var(--color-bg-inset)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 12,
      }}
    >
      {label}
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          className="inline-flex items-center cursor-pointer ml-0.5"
          style={{ background: 'none', border: 'none', padding: 0 }}
        >
          <X size={9} style={{ color: 'var(--color-text-secondary)' }} />
        </button>
      )}
    </span>
  )
}

interface NodeDetailProps {
  node: KnowledgeNode
  onClose?: () => void
  onNavigateToNode?: (nodeId: string) => void
  isAskView?: boolean
  onAskAbout?: (node: KnowledgeNode) => void
}

export function NodeDetail({ node: initialNode, onClose, onNavigateToNode, isAskView, onAskAbout }: NodeDetailProps) {
  const [node, setNode] = useState<KnowledgeNode>(initialNode)
  const [isEditing, setIsEditing] = useState(false)
  const [editLabel, setEditLabel] = useState(initialNode.label)
  const [editDescription, setEditDescription] = useState(initialNode.description ?? '')
  const [editUserTags, setEditUserTags] = useState<string[]>(initialNode.user_tags ?? [])
  const [newTag, setNewTag] = useState('')
  const [isSaving, setIsSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saveSuccess, setSaveSuccess] = useState(false)
  const [showAllConnections, setShowAllConnections] = useState(false)
  const [isAnchorLoading, setIsAnchorLoading] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const [sourceSummary, setSourceSummary] = useState<string | null>(null)

  const { neighbors, isLoading: neighborsLoading, error: neighborsError } = useNodeNeighbors(node.id)
  const { promoteToAnchor, demoteAnchor, refreshAnchors } = useSettings()
  const { setRightPanelContent, setSelectedNodeId } = useGraphContext()

  // Sync when prop changes
  useEffect(() => {
    setNode(initialNode)
    setEditLabel(initialNode.label)
    setEditDescription(initialNode.description ?? '')
    setEditUserTags(initialNode.user_tags ?? [])
    setIsEditing(false)
    setSaveError(null)
    setSaveSuccess(false)
    setSourceSummary(null)
  }, [initialNode.id, initialNode])

  // Fetch source summary for provenance
  useEffect(() => {
    if (!initialNode.source_id) return
    setSourceSummary(null)
    supabase
      .from('knowledge_sources')
      .select('summary')
      .eq('id', initialNode.source_id)
      .maybeSingle()
      .then(({ data }) => {
        if (data?.summary) setSourceSummary(data.summary as string)
      })
  }, [initialNode.source_id])

  // Auto-resize textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
      textareaRef.current.style.height = `${textareaRef.current.scrollHeight}px`
    }
  }, [editDescription, isEditing])

  const handleSave = async () => {
    setIsSaving(true)
    setSaveError(null)
    try {
      const updated = await updateNode(node.id, {
        label: editLabel,
        description: editDescription || null,
        user_tags: editUserTags.length > 0 ? editUserTags : undefined,
      })
      setNode(updated)
      setSaveSuccess(true)
      setIsEditing(false)
      setTimeout(() => setSaveSuccess(false), 2000)
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setIsSaving(false)
    }
  }

  const handleCancel = () => {
    setEditLabel(node.label)
    setEditDescription(node.description ?? '')
    setEditUserTags(node.user_tags ?? [])
    setNewTag('')
    setSaveError(null)
    setIsEditing(false)
  }

  const handleAnchorToggle = async () => {
    setIsAnchorLoading(true)
    try {
      if (node.is_anchor) {
        await demoteAnchor(node.id)
      } else {
        await promoteToAnchor(node.id)
      }
      await refreshAnchors()
      const refreshed = await fetchNodeById(node.id)
      if (refreshed) {
        setNode(refreshed)
        setRightPanelContent({ type: 'node', data: refreshed })
      }
    } catch (err) {
      console.error('Anchor toggle failed:', err)
    } finally {
      setIsAnchorLoading(false)
    }
  }

  const handleNavigateToNode = async (neighborId: string) => {
    try {
      const neighbor = await fetchNodeById(neighborId)
      if (neighbor) {
        setSelectedNodeId(neighborId)
        setRightPanelContent({ type: 'node', data: neighbor })
        onNavigateToNode?.(neighborId)
      }
    } catch (err) {
      console.error('Navigate to node failed:', err)
    }
  }

  const handleAddTag = () => {
    const tag = newTag.trim()
    if (tag && !editUserTags.includes(tag)) {
      setEditUserTags(prev => [...prev, tag])
    }
    setNewTag('')
  }

  const visibleNeighbors = showAllConnections ? neighbors : neighbors.slice(0, 10)
  const confidence = node.confidence != null ? Math.round(node.confidence * 100) : null
  const allTags = node.tags ?? []
  const userTags = node.user_tags ?? []

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-start justify-between mb-4" style={{ gap: 12 }}>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <EntityDot type={node.entity_type} size={12} />
            {isEditing ? (
              <input
                type="text"
                value={editLabel}
                onChange={e => setEditLabel(e.target.value)}
                className="font-display font-bold text-text-primary flex-1 min-w-0 rounded-md px-2 py-0.5"
                style={{
                  fontSize: '18px',
                  letterSpacing: '-0.02em',
                  background: 'var(--color-bg-inset)',
                  border: '1px solid var(--border-default)',
                  outline: 'none',
                }}
              />
            ) : (
              <h2
                className="font-display font-bold text-text-primary leading-tight"
                style={{ fontSize: '18px', letterSpacing: '-0.02em' }}
              >
                {node.label}
              </h2>
            )}
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <EntityBadge type={node.entity_type} />
            {node.is_anchor && (
              <span
                className="inline-flex items-center gap-1 font-body font-semibold rounded-md"
                style={{
                  fontSize: '10px',
                  padding: '2px 8px',
                  background: '#fef3c7',
                  color: '#b45309',
                  border: '1px solid #fde68a',
                }}
              >
                ⚓ Anchor
              </span>
            )}
            {saveSuccess && (
              <span className="inline-flex items-center gap-1 font-body text-[11px]" style={{ color: '#059669' }}>
                <Check size={12} />
                Saved
              </span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-1 shrink-0">
          {!isEditing && (
            <button
              type="button"
              onClick={() => setIsEditing(true)}
              className="flex items-center justify-center w-7 h-7 rounded-md cursor-pointer hover:bg-bg-hover"
              style={{ background: 'transparent', border: 'none', transition: 'background 0.15s ease' }}
              aria-label="Edit entity"
            >
              <Pencil size={14} style={{ color: 'var(--color-text-secondary)' }} />
            </button>
          )}
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="flex items-center justify-center w-7 h-7 rounded-md cursor-pointer hover:bg-bg-hover"
              style={{ background: 'transparent', border: 'none', transition: 'background 0.15s ease' }}
              aria-label="Close"
            >
              <X size={14} style={{ color: 'var(--color-text-secondary)' }} />
            </button>
          )}
        </div>
      </div>

      {/* Description */}
      <div className="mb-5">
        <SectionLabel>Description</SectionLabel>
        <div className="mt-2">
          {isEditing ? (
            <textarea
              ref={textareaRef}
              value={editDescription}
              onChange={e => setEditDescription(e.target.value)}
              placeholder="Add a description…"
              className="w-full font-body text-[13px] text-text-body rounded-md px-3 py-2 resize-none leading-relaxed"
              style={{
                background: 'var(--color-bg-inset)',
                border: '1px solid var(--border-default)',
                outline: 'none',
                minHeight: 64,
              }}
            />
          ) : (
            <p className="font-body text-[13px] text-text-body leading-relaxed">
              {node.description ?? (
                <span className="text-text-placeholder italic">
                  No description yet. Click edit to add one.
                </span>
              )}
            </p>
          )}
        </div>
      </div>

      {/* Confidence */}
      <div className="mb-5">
        <SectionLabel>Confidence</SectionLabel>
        <div className="mt-2 flex items-center gap-3">
          <div
            className="flex-1 rounded-full overflow-hidden"
            style={{ height: 6, background: 'var(--color-bg-inset)' }}
          >
            <div
              className="h-full rounded-full"
              style={{
                width: `${confidence ?? 0}%`,
                background: 'var(--color-accent-500)',
              }}
            />
          </div>
          <span className="font-body text-[11px] text-text-secondary shrink-0 w-10 text-right">
            {confidence != null ? `${confidence}%` : '—'}
          </span>
        </div>
      </div>

      {/* Source */}
      <div className="mb-5">
        <SectionLabel>Source</SectionLabel>
        <div className="mt-2">
          {node.source || node.source_type ? (
            <div className="flex items-start gap-2">
              <SourceIcon sourceType={node.source_type} size={28} />
              <div className="flex-1 min-w-0">
                <div className="font-body text-[13px] font-medium text-text-body truncate">
                  {node.source ?? 'Unknown source'}
                </div>
                {node.source_url && (
                  <a
                    href={node.source_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 font-body text-[11px] underline truncate max-w-full"
                    style={{ color: 'var(--color-accent-500)' }}
                  >
                    <span className="truncate">{node.source_url}</span>
                    <ExternalLink size={10} className="shrink-0" />
                  </a>
                )}
                <div className="font-body text-[11px] text-text-secondary mt-0.5">
                  {formatTime(node.created_at)}
                </div>
                {sourceSummary && (
                  <p
                    className="font-body text-[12px] text-text-secondary mt-1"
                    style={{
                      lineHeight: 1.45,
                      display: '-webkit-box',
                      WebkitLineClamp: 2,
                      WebkitBoxOrient: 'vertical',
                      overflow: 'hidden',
                    }}
                  >
                    {sourceSummary}
                  </p>
                )}
              </div>
            </div>
          ) : (
            <p className="font-body text-[13px] text-text-placeholder">Unknown source</p>
          )}
        </div>
      </div>

      {/* Quote */}
      {node.quote && (
        <div className="mb-5">
          <SectionLabel>Quote</SectionLabel>
          <blockquote
            className="mt-2 font-body text-[13px] italic text-text-body leading-relaxed"
            style={{
              borderLeft: '3px solid var(--color-accent-200)',
              paddingLeft: 12,
            }}
          >
            {node.quote}
          </blockquote>
        </div>
      )}

      {/* Tags */}
      {(allTags.length > 0 || userTags.length > 0 || isEditing) && (
        <div className="mb-5">
          <SectionLabel>Tags</SectionLabel>
          <div className="mt-2 flex flex-col gap-2">
            {allTags.length > 0 && (
              <div>
                <span className="font-body text-[10px] text-text-placeholder mb-1 block">AI Tags</span>
                <div className="flex flex-wrap gap-1">
                  {allTags.map(tag => (
                    <TagPill key={tag} label={tag} />
                  ))}
                </div>
              </div>
            )}
            {(isEditing ? editUserTags : userTags).length > 0 && (
              <div>
                <span className="font-body text-[10px] text-text-placeholder mb-1 block">User Tags</span>
                <div className="flex flex-wrap gap-1">
                  {(isEditing ? editUserTags : userTags).map(tag => (
                    <TagPill
                      key={tag}
                      label={tag}
                      onRemove={isEditing ? () => setEditUserTags(prev => prev.filter(t => t !== tag)) : undefined}
                    />
                  ))}
                </div>
              </div>
            )}
            {isEditing && (
              <div className="flex items-center gap-2 mt-1">
                <input
                  type="text"
                  value={newTag}
                  onChange={e => setNewTag(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleAddTag() } }}
                  placeholder="Add tag…"
                  className="font-body text-[12px] text-text-body rounded-md px-2 py-1"
                  style={{
                    background: 'var(--color-bg-inset)',
                    border: '1px solid var(--border-default)',
                    outline: 'none',
                    flex: 1,
                  }}
                />
                <button
                  type="button"
                  onClick={handleAddTag}
                  className="font-body text-[11px] text-text-secondary cursor-pointer rounded-md px-2 py-1 hover:bg-bg-hover"
                  style={{ background: 'transparent', border: '1px solid var(--border-subtle)' }}
                >
                  Add
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Connections */}
      <div className="mb-5">
        <div className="flex items-center gap-2 mb-2">
          <SectionLabel>Connections</SectionLabel>
          <span
            className="font-body text-[10px] text-text-secondary rounded-md px-1.5 py-0.5"
            style={{ background: 'var(--color-bg-inset)' }}
          >
            {neighbors.length}
          </span>
        </div>

        {neighborsLoading && (
          <div className="flex flex-col gap-1">
            {[1, 2, 3].map(i => (
              <div key={i} className="h-8 rounded-md animate-pulse" style={{ background: 'var(--color-bg-inset)' }} />
            ))}
          </div>
        )}

        {neighborsError && (
          <div className="flex items-center gap-2 font-body text-[12px] text-text-secondary">
            <AlertCircle size={12} style={{ color: '#ef4444' }} />
            Couldn't load connections.
            <button
              type="button"
              className="underline cursor-pointer"
              style={{ background: 'none', border: 'none', padding: 0, color: 'var(--color-accent-500)' }}
              onClick={() => window.location.reload()}
            >
              Retry
            </button>
          </div>
        )}

        {!neighborsLoading && !neighborsError && neighbors.length === 0 && (
          <p className="font-body text-[12px] text-text-placeholder">No connections yet.</p>
        )}

        {!neighborsLoading && !neighborsError && neighbors.length > 0 && (
          <div className="flex flex-col gap-0.5">
            {visibleNeighbors.map(({ node: neighbor, edge, direction }) => (
              <button
                key={neighbor.id}
                type="button"
                onClick={() => handleNavigateToNode(neighbor.id)}
                className="flex items-center gap-2 w-full px-2 py-1.5 rounded-md cursor-pointer text-left"
                style={{
                  background: 'transparent',
                  border: 'none',
                  height: 32,
                  transition: 'background 0.15s ease',
                }}
                onMouseEnter={e => {
                  (e.currentTarget as HTMLButtonElement).style.background = 'var(--color-bg-hover)'
                }}
                onMouseLeave={e => {
                  (e.currentTarget as HTMLButtonElement).style.background = 'transparent'
                }}
                title={edge.evidence ?? undefined}
              >
                <EntityDot type={neighbor.entity_type} size={6} />
                <span className="font-body text-[12px] font-medium text-text-primary flex-1 min-w-0 truncate">
                  {neighbor.label}
                </span>
                <RelationshipTag type={edge.relation_type} />
                <span className="font-body text-[10px] text-text-placeholder shrink-0">
                  {direction === 'outgoing' ? '→' : '←'}
                </span>
              </button>
            ))}
          </div>
        )}

        {!neighborsLoading && neighbors.length > 10 && (
          <button
            type="button"
            onClick={() => setShowAllConnections(prev => !prev)}
            className="font-body text-[11px] text-text-secondary mt-2 cursor-pointer hover:text-text-primary"
            style={{ background: 'none', border: 'none', padding: 0 }}
          >
            {showAllConnections ? 'Show less' : `Show all ${neighbors.length} connections`}
          </button>
        )}
      </div>

      {/* Action Buttons */}
      {!isEditing && (
        <div className="flex flex-col gap-2 mt-auto">
          {isAskView && onAskAbout && (
            <button
              type="button"
              onClick={() => onAskAbout(node)}
              className="w-full font-body text-[12px] font-semibold rounded-md py-2 cursor-pointer flex items-center justify-center gap-1.5"
              style={{
                background: 'var(--color-bg-inset)',
                border: '1px solid var(--border-subtle)',
                color: 'var(--color-text-body)',
                transition: 'background 0.15s ease',
              }}
              onMouseEnter={e => { e.currentTarget.style.background = 'var(--color-bg-card)' }}
              onMouseLeave={e => { e.currentTarget.style.background = 'var(--color-bg-inset)' }}
            >
              <MessageSquare size={12} /> Ask about this
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              const { toast } = window as unknown as { toast?: (msg: string) => void }
              if (typeof toast === 'function') {
                toast('Coming in PRD 8')
              } else {
                alert('Coming in PRD 8')
              }
            }}
            className="w-full font-body text-[11px] font-semibold rounded-md py-2 cursor-pointer"
            style={{
              background: 'var(--color-accent-50)',
              color: 'var(--color-accent-600)',
              border: '1px solid var(--color-accent-200)',
            }}
          >
            Explore with AI
          </button>
          <div className="flex gap-2">
            <button
              type="button"
              className="flex-1 font-body text-[11px] font-semibold rounded-md py-2 cursor-pointer"
              style={{
                background: 'var(--color-bg-card)',
                border: '1px solid var(--border-subtle)',
                color: 'var(--color-text-body)',
              }}
            >
              Re-link
            </button>
            <button
              type="button"
              className="flex-1 font-body text-[11px] font-semibold rounded-md py-2 cursor-pointer"
              style={{
                background: 'var(--color-bg-card)',
                border: '1px solid var(--border-subtle)',
                color: 'var(--color-text-body)',
              }}
            >
              Find Similar
            </button>
          </div>
          <button
            type="button"
            onClick={handleAnchorToggle}
            disabled={isAnchorLoading}
            className="w-full font-body text-[11px] font-semibold rounded-md py-2 cursor-pointer"
            style={{
              background: 'transparent',
              border: '1px solid var(--border-subtle)',
              color: node.is_anchor ? '#b45309' : 'var(--color-text-secondary)',
              opacity: isAnchorLoading ? 0.6 : 1,
            }}
          >
            {node.is_anchor ? '⚓ Demote from Anchor' : '⚓ Promote to Anchor'}
          </button>
        </div>
      )}

      {/* Edit Controls */}
      {isEditing && (
        <div className="flex flex-col gap-2 mt-4">
          {saveError && (
            <div
              className="flex items-center gap-2 font-body text-[12px] text-text-body rounded-md px-3 py-2"
              style={{ background: '#fef2f2', border: '1px solid rgba(239,68,68,0.2)' }}
            >
              <AlertCircle size={12} style={{ color: '#ef4444' }} />
              {saveError}
            </div>
          )}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={handleSave}
              disabled={isSaving}
              className="flex-1 font-body text-[12px] font-semibold rounded-md py-2 cursor-pointer"
              style={{
                background: 'var(--color-accent-500)',
                color: '#fff',
                border: 'none',
                opacity: isSaving ? 0.7 : 1,
              }}
            >
              {isSaving ? 'Saving…' : 'Save'}
            </button>
            <button
              type="button"
              onClick={handleCancel}
              disabled={isSaving}
              className="font-body text-[12px] font-semibold rounded-md py-2 px-4 cursor-pointer"
              style={{
                background: 'transparent',
                border: '1px solid var(--border-subtle)',
                color: 'var(--color-text-secondary)',
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Connections section spacer */}
      <div className="mt-4 pt-4" style={{ borderTop: '1px solid var(--border-subtle)' }}>
        <div className="flex items-center gap-1.5 font-body text-[11px] text-text-secondary">
          <GitBranch size={11} />
          <span>{neighbors.length} connections</span>
        </div>
      </div>
    </div>
  )
}
