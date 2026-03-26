import { useEffect, useState, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { X, RefreshCw, Loader2, MessageSquare } from 'lucide-react'
import { SectionLabel } from '../ui/SectionLabel'
import { getEntityColor } from '../../config/entityTypes'
import { getSourceConfig } from '../../config/sourceTypes'
import { supabase, fetchNodeById, fetchCrossConnectionsForSource } from '../../services/supabase'
import { useGraphContext } from '../../hooks/useGraphContext'
import { resolveSummary } from '../../utils/summarize'
import type { KnowledgeSource, KnowledgeNode } from '../../types/database'
import type { CrossConnection } from '../../types/feed'

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
  if (days < 30) return `${days}d ago`
  const months = Math.floor(days / 30)
  return `${months}mo ago`
}

interface SourceDetailProps {
  source: KnowledgeSource
  onClose?: () => void
  isAskView?: boolean
  onAskAbout?: (source: KnowledgeSource) => void
}

const PROVENANCE_LABELS: Record<string, string> = {
  extracted: 'From source',
  generated: 'AI generated',
  user: 'Edited',
  truncated: 'Preview',
}

export function SourceDetail({ source, onClose, isAskView, onAskAbout }: SourceDetailProps) {
  const navigate = useNavigate()
  const { setRightPanelContent } = useGraphContext()
  const [entities, setEntities] = useState<KnowledgeNode[]>([])
  const [loadingEntities, setLoadingEntities] = useState(true)
  const [crossConnections, setCrossConnections] = useState<CrossConnection[]>([])

  // Re-extract state
  const [showReExtract, setShowReExtract] = useState(false)
  const [reExtractInstructions, setReExtractInstructions] = useState('')

  // Summary state
  const [currentSummary, setCurrentSummary] = useState<string | null>(source.summary ?? null)
  const [currentSummarySource, setCurrentSummarySource] = useState<string | null>(source.summary_source ?? null)
  const [isEditingSummary, setIsEditingSummary] = useState(false)
  const [draftSummary, setDraftSummary] = useState('')
  const [generationStatus, setGenerationStatus] = useState<'idle' | 'generating' | 'error'>('idle')
  const [regenStatus, setRegenStatus] = useState<'idle' | 'confirming' | 'regenerating' | 'error'>('idle')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const cfg = getSourceConfig(source.source_type)

  // Reset summary state when source changes
  useEffect(() => {
    setCurrentSummary(source.summary ?? null)
    setCurrentSummarySource(source.summary_source ?? null)
    setIsEditingSummary(false)
    setGenerationStatus('idle')
    setRegenStatus('idle')
  }, [source.id, source.summary, source.summary_source])

  useEffect(() => {
    setLoadingEntities(true)
    setEntities([])
    setCrossConnections([])

    supabase
      .from('knowledge_nodes')
      .select('id, label, entity_type, confidence, created_at, description, is_anchor, user_id, source, source_type, source_url, source_id, tags, user_tags, quote')
      .eq('source_id', source.id)
      .order('confidence', { ascending: false })
      .limit(20)
      .then(({ data }) => {
        setEntities((data ?? []) as KnowledgeNode[])
        setLoadingEntities(false)
      })

    fetchCrossConnectionsForSource(source.id).then(setCrossConnections)
  }, [source.id])

  const handleEntityClick = async (nodeId: string) => {
    const node = await fetchNodeById(nodeId)
    if (node) setRightPanelContent({ type: 'node', data: node })
  }

  const handleCrossConnEntityClick = async (nodeId: string) => {
    const node = await fetchNodeById(nodeId)
    if (node) setRightPanelContent({ type: 'node', data: node })
  }

  // Summary edit handlers
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
      .eq('id', source.id)
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
        source.source_type ?? null,
        source.content ?? null,
        source.metadata ?? null,
      )
      if (result) {
        const { error } = await supabase
          .from('knowledge_sources')
          .update({ summary: result.summary, summary_source: result.source })
          .eq('id', source.id)
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

  const handleRegenerateClick = () => {
    if (currentSummarySource === 'user') {
      setRegenStatus('confirming')
    } else {
      void handleRegenerateSummary()
    }
  }

  const handleRegenerateSummary = async () => {
    setRegenStatus('regenerating')
    try {
      const result = await resolveSummary(
        source.source_type ?? null,
        source.content ?? null,
        source.metadata ?? null,
      )
      if (result) {
        const { error } = await supabase
          .from('knowledge_sources')
          .update({ summary: result.summary, summary_source: result.source })
          .eq('id', source.id)
        if (!error) {
          setCurrentSummary(result.summary)
          setCurrentSummarySource(result.source)
        }
      }
      setRegenStatus('idle')
    } catch {
      setRegenStatus('error')
    }
  }

  const contentPreview = source.content
    ? source.content.replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 180) + '...'
    : null

  return (
    <div className="flex flex-col gap-5">
      {/* Header */}
      <div className="flex items-start justify-between" style={{ gap: 8 }}>
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <div
            className="flex items-center justify-center shrink-0"
            style={{
              width: 28,
              height: 28,
              borderRadius: 7,
              background: cfg.color + '12',
              fontSize: 14,
            }}
          >
            {cfg.icon}
          </div>
          <h2
            className="font-display font-bold text-text-primary leading-tight truncate"
            style={{ fontSize: 14 }}
          >
            {source.title ?? 'Untitled Source'}
          </h2>
        </div>

        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="flex items-center justify-center w-7 h-7 rounded-md cursor-pointer hover:bg-bg-hover shrink-0"
            style={{ background: 'transparent', border: 'none', transition: 'background 0.15s ease' }}
            aria-label="Close"
          >
            <X size={14} style={{ color: 'var(--color-text-secondary)' }} />
          </button>
        )}
      </div>

      {/* Metadata row */}
      <div className="font-body" style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>
        {cfg.label}
        {source.created_at && (
          <>
            <span style={{ margin: '0 6px' }}>·</span>
            {formatRelativeTime(source.created_at)}
          </>
        )}
      </div>

      {/* Summary section */}
      <div>
        <div className="flex items-center justify-between mb-2">
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
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleEditStart}
                disabled={regenStatus === 'regenerating'}
                className="font-body cursor-pointer"
                style={{
                  fontSize: 11,
                  color: 'var(--color-accent-500)',
                  background: 'none',
                  border: 'none',
                  padding: 0,
                  textDecoration: 'none',
                  opacity: regenStatus === 'regenerating' ? 0.4 : 1,
                }}
                onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.textDecoration = 'underline' }}
                onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.textDecoration = 'none' }}
              >
                Edit
              </button>
              <button
                type="button"
                onClick={handleRegenerateClick}
                disabled={regenStatus === 'regenerating'}
                className="font-body cursor-pointer inline-flex items-center gap-1"
                style={{
                  fontSize: 11,
                  color: regenStatus === 'regenerating' ? 'var(--color-text-secondary)' : 'var(--color-text-secondary)',
                  background: 'none',
                  border: 'none',
                  padding: 0,
                  textDecoration: 'none',
                  opacity: regenStatus === 'regenerating' ? 0.6 : 1,
                }}
                onMouseEnter={e => {
                  if (regenStatus !== 'regenerating') (e.currentTarget as HTMLButtonElement).style.color = 'var(--color-accent-500)'
                }}
                onMouseLeave={e => {
                  (e.currentTarget as HTMLButtonElement).style.color = 'var(--color-text-secondary)'
                }}
              >
                {regenStatus === 'regenerating' ? (
                  <>
                    <Loader2 size={10} style={{ animation: 'spin 1s linear infinite' }} />
                    Regenerating...
                  </>
                ) : (
                  'Regenerate'
                )}
              </button>
            </div>
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
          <div>
            <p
              className="font-body leading-relaxed"
              style={{
                fontSize: 13,
                color: 'var(--color-text-body)',
                opacity: regenStatus === 'regenerating' ? 0.5 : 1,
                transition: 'opacity 0.15s ease',
              }}
            >
              {currentSummary}
            </p>
            {regenStatus === 'confirming' && (
              <div
                className="flex items-center justify-between mt-2"
                style={{
                  padding: '8px 10px',
                  borderRadius: 6,
                  background: 'var(--color-semantic-amber-50, #fffbeb)',
                  border: '1px solid var(--color-semantic-amber-200, #fde68a)',
                }}
              >
                <span className="font-body" style={{ fontSize: 12, color: 'var(--color-text-body)' }}>
                  This summary was manually edited.
                </span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setRegenStatus('idle')}
                    className="font-body font-semibold cursor-pointer"
                    style={{
                      fontSize: 11,
                      padding: '4px 10px',
                      borderRadius: 5,
                      background: 'var(--color-bg-inset)',
                      border: '1px solid var(--border-default)',
                      color: 'var(--color-text-body)',
                    }}
                  >
                    Keep mine
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleRegenerateSummary()}
                    className="font-body cursor-pointer"
                    style={{
                      fontSize: 11,
                      padding: '4px 10px',
                      borderRadius: 5,
                      background: 'none',
                      border: 'none',
                      color: 'var(--color-semantic-red-500, #ef4444)',
                    }}
                  >
                    Regenerate anyway
                  </button>
                </div>
              </div>
            )}
            {regenStatus === 'error' && (
              <p className="font-body mt-1" style={{ fontSize: 11, color: 'var(--color-semantic-red-500, #ef4444)' }}>
                Regeneration failed
              </p>
            )}
          </div>
        ) : contentPreview ? (
          <div>
            <p
              className="font-body leading-relaxed"
              style={{
                fontSize: 13,
                color: 'var(--color-text-secondary)',
                fontStyle: 'italic',
              }}
            >
              {contentPreview}
            </p>
            <button
              type="button"
              onClick={handleGenerateSummary}
              disabled={generationStatus === 'generating'}
              className="font-body cursor-pointer mt-2 inline-flex items-center gap-1.5"
              style={{
                fontSize: 11,
                color: 'var(--color-accent-500)',
                background: 'none',
                border: 'none',
                padding: 0,
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
              <p className="font-body mt-1" style={{ fontSize: 11, color: 'var(--color-semantic-red-500)' }}>
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
          <p className="font-body" style={{ fontSize: 12, color: 'var(--color-text-placeholder)' }}>
            No content available
          </p>
        )}
      </div>

      {/* Divider below summary */}
      <div style={{ borderBottom: '1px solid var(--border-subtle)' }} />

      {/* Extracted entities */}
      <div>
        <div className="flex items-center gap-1.5 mb-2">
          <SectionLabel>Extracted Entities</SectionLabel>
          {!loadingEntities && entities.length > 0 && (
            <span
              className="font-body"
              style={{ fontSize: 10, color: 'var(--color-text-secondary)' }}
            >
              ({entities.length})
            </span>
          )}
        </div>

        {loadingEntities ? (
          <div className="flex flex-wrap gap-1.5">
            {[1, 2, 3, 4].map(i => (
              <div
                key={i}
                className="rounded-md animate-pulse"
                style={{ width: 60, height: 22, background: 'var(--color-bg-inset)' }}
              />
            ))}
          </div>
        ) : entities.length === 0 ? (
          <p className="font-body" style={{ fontSize: 12, color: 'var(--color-text-placeholder)' }}>
            No entities extracted yet.
          </p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {entities.map(entity => {
              const color = getEntityColor(entity.entity_type)
              return (
                <button
                  key={entity.id}
                  type="button"
                  onClick={() => handleEntityClick(entity.id)}
                  className="inline-flex items-center gap-1 font-body font-semibold rounded cursor-pointer"
                  style={{
                    fontSize: 11,
                    padding: '3px 9px',
                    borderRadius: 5,
                    color,
                    backgroundColor: `${color}0f`,
                    border: `1px solid ${color}29`,
                    background: `${color}0f`,
                  }}
                >
                  <span
                    style={{
                      width: 5,
                      height: 5,
                      borderRadius: '50%',
                      backgroundColor: color,
                      display: 'inline-block',
                      flexShrink: 0,
                    }}
                  />
                  {entity.label}
                </button>
              )
            })}
          </div>
        )}
      </div>

      {/* Cross-connections */}
      {crossConnections.length > 0 && (
        <div>
          <SectionLabel>Cross-Connections</SectionLabel>
          <div className="flex flex-col gap-1 mt-2">
            {crossConnections.map(cc => (
              <div
                key={cc.id}
                className="flex items-center flex-wrap"
                style={{ gap: '2px 3px' }}
              >
                <button
                  type="button"
                  onClick={() => handleCrossConnEntityClick(cc.fromNodeId)}
                  className="font-body font-medium cursor-pointer"
                  style={{
                    fontSize: 11,
                    color: 'var(--color-accent-500)',
                    background: 'none',
                    border: 'none',
                    padding: 0,
                  }}
                >
                  {cc.fromLabel}
                </button>
                <span
                  className="font-body"
                  style={{ fontSize: 10, color: 'var(--color-text-secondary)' }}
                >
                  → {cc.relationType.replace(/_/g, ' ')} →
                </span>
                <button
                  type="button"
                  onClick={() => handleCrossConnEntityClick(cc.toNodeId)}
                  className="font-body font-medium cursor-pointer"
                  style={{
                    fontSize: 11,
                    color: 'var(--color-accent-500)',
                    background: 'none',
                    border: 'none',
                    padding: 0,
                  }}
                >
                  {cc.toLabel}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Ask about this source — only in Ask view (PRD-D §2.5) */}
      {isAskView && onAskAbout && (
        <div style={{ marginTop: 8 }}>
          <button
            type="button"
            onClick={() => onAskAbout(source)}
            className="w-full font-body font-semibold rounded-md cursor-pointer flex items-center justify-center gap-1.5"
            style={{
              fontSize: 12,
              padding: '7px 0',
              background: 'var(--color-bg-inset)',
              border: '1px solid var(--border-subtle)',
              color: 'var(--color-text-body)',
              transition: 'background 0.15s ease',
            }}
            onMouseEnter={e => { e.currentTarget.style.background = 'var(--color-bg-card)' }}
            onMouseLeave={e => { e.currentTarget.style.background = 'var(--color-bg-inset)' }}
          >
            <MessageSquare size={12} /> Ask about this source
          </button>
        </div>
      )}

      {/* Re-extract */}
      <div className="mt-auto pt-2" style={{ borderTop: '1px solid var(--border-subtle)' }}>
        <button
          type="button"
          className="w-full font-body font-semibold rounded-md cursor-pointer flex items-center justify-center gap-1.5"
          style={{
            fontSize: 12,
            padding: '7px 0',
            background: showReExtract ? 'var(--color-accent-50)' : 'var(--color-bg-inset)',
            border: showReExtract ? '1px solid rgba(214,58,0,0.2)' : '1px solid var(--border-default)',
            color: showReExtract ? 'var(--color-accent-500)' : 'var(--color-text-body)',
            ...(!source.content ? { opacity: 0.4, cursor: 'not-allowed' } : {}),
            transition: 'all 0.15s ease',
          }}
          disabled={!source.content}
          title={!source.content ? 'No source content available' : 'Re-run extraction with new settings'}
          onClick={() => setShowReExtract(v => !v)}
        >
          <RefreshCw size={12} />
          Re-extract
        </button>

        {showReExtract && (
          <div style={{ marginTop: 8, padding: '10px 12px', background: 'var(--color-bg-inset)', borderRadius: 8, border: '1px solid var(--border-subtle)' }}>
            <label className="font-body font-semibold" style={{ fontSize: 11, color: 'var(--color-text-secondary)', display: 'block', marginBottom: 6 }}>
              Custom instructions (optional)
            </label>
            <textarea
              value={reExtractInstructions}
              onChange={e => setReExtractInstructions(e.target.value)}
              placeholder="e.g., Focus on technical concepts, ignore personal names…"
              className="font-body w-full"
              style={{
                fontSize: 12,
                color: 'var(--color-text-body)',
                background: 'var(--color-bg-card)',
                border: '1px solid var(--border-subtle)',
                borderRadius: 6,
                padding: '6px 8px',
                resize: 'vertical',
                minHeight: 56,
                maxHeight: 120,
                lineHeight: 1.4,
                outline: 'none',
              }}
              onFocus={e => { e.currentTarget.style.borderColor = 'rgba(214,58,0,0.3)' }}
              onBlur={e => { e.currentTarget.style.borderColor = 'var(--border-subtle)' }}
            />
            <div className="flex items-center gap-2" style={{ marginTop: 8 }}>
              <button
                type="button"
                className="font-body font-semibold cursor-pointer"
                style={{
                  fontSize: 11,
                  padding: '5px 14px',
                  borderRadius: 6,
                  background: 'var(--color-accent-500)',
                  border: 'none',
                  color: '#fff',
                }}
                onClick={() => {
                  navigate('/capture', {
                    state: {
                      reExtractSource: {
                        id: source.id,
                        title: source.title,
                        content: source.content,
                        sourceType: source.source_type,
                        sourceUrl: source.source_url,
                        customInstructions: reExtractInstructions.trim() || undefined,
                      },
                    },
                  })
                }}
              >
                Start Re-extraction
              </button>
              <button
                type="button"
                className="font-body cursor-pointer"
                style={{
                  fontSize: 11,
                  padding: '5px 10px',
                  borderRadius: 6,
                  background: 'transparent',
                  border: 'none',
                  color: 'var(--color-text-secondary)',
                }}
                onClick={() => { setShowReExtract(false); setReExtractInstructions('') }}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
