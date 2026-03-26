import { useState, useEffect, useRef } from 'react'
import {
  Save, FileText, Sparkles, Eye, Database, Cpu, Scissors, Zap,
  Check, X, CheckCircle, MessageSquare, type LucideIcon,
} from 'lucide-react'
import { EntityReview } from '../shared/EntityReview'
import type { ExtractionStep, ReviewEntity, ExtractedRelationship } from '../../types/extraction'

// ─── Props ────────────────────────────────────────────────────────────────────

interface ExtractionPipelineProps {
  step: ExtractionStep
  statusText: string
  elapsedMs: number
  embeddingProgress: { completed: number; total: number } | null
  error: Error | null

  // Review step
  entities: ReviewEntity[] | null
  relationships: ExtractedRelationship[] | null
  onSave: (entities: ReviewEntity[]) => void
  onReExtract: () => void

  // Complete step
  savedNodeCount: number
  savedEdgeCount: number
  crossConnectionCount: number
  duplicatesSkipped: number

  // Error actions
  onRetry?: () => void
  onCancel?: () => void

  // Complete actions
  onViewInBrowse: () => void
  onIngestAnother: () => void
  onChatWithCapture?: () => void
}

// ─── Step config ──────────────────────────────────────────────────────────────

const STEPS: { key: string; label: string; Icon: LucideIcon }[] = [
  { key: 'saving_source',           label: 'Saving source',           Icon: Save      },
  { key: 'composing_prompt',        label: 'Composing prompt',        Icon: FileText  },
  { key: 'extracting',              label: 'Extracting entities',     Icon: Sparkles  },
  { key: 'reviewing',               label: 'Review entities',         Icon: Eye       },
  { key: 'saving_nodes',            label: 'Saving to graph',         Icon: Database  },
  { key: 'generating_embeddings',   label: 'Generating embeddings',   Icon: Cpu       },
  { key: 'chunking_source',         label: 'Chunking source',         Icon: Scissors  },
  { key: 'discovering_connections', label: 'Discovering connections', Icon: Zap       },
]

const STEP_KEYS = STEPS.map(s => s.key)

function getStepIndex(step: ExtractionStep): number {
  return STEP_KEYS.indexOf(step)
}

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

// ─── Component ────────────────────────────────────────────────────────────────

export function ExtractionPipeline({
  step,
  statusText,
  elapsedMs,
  embeddingProgress,
  error,
  entities,
  relationships,
  onSave,
  onReExtract,
  savedNodeCount,
  savedEdgeCount,
  crossConnectionCount,
  duplicatesSkipped,
  onRetry,
  onCancel,
  onViewInBrowse,
  onIngestAnother,
  onChatWithCapture,
}: ExtractionPipelineProps) {
  const currentIdx = getStepIndex(step)
  const isError    = step === 'error'
  const isComplete = step === 'complete'

  // ── Local entity state for review ─────────────────────────────────────────
  const [reviewEntities, setReviewEntities] = useState<ReviewEntity[] | null>(null)
  const [pendingSave, setPendingSave]       = useState(false)
  const prevEntitiesRef = useRef<ReviewEntity[] | null>(null)

  // Sync when fresh entities arrive from extraction (or re-extract)
  useEffect(() => {
    if (entities && entities !== prevEntitiesRef.current) {
      prevEntitiesRef.current = entities
      setReviewEntities(entities)
      setPendingSave(false)
    }
  }, [entities])

  const displayEntities  = reviewEntities ?? entities
  const approvedCount    = displayEntities?.filter(e => !e.removed).length ?? 0
  const extractedCount   = entities?.length ?? 0

  const handleSaveClick = () => {
    const toSave = reviewEntities ?? entities
    if (!toSave) return
    setPendingSave(true)
    onSave(toSave)
  }

  return (
    <div style={{ padding: '24px 24px 28px' }}>
      <style>{`
        @keyframes pipelinePulse {
          0%, 100% { opacity: 1; }
          50%       { opacity: 0.55; }
        }
        @keyframes stepBodyIn {
          from { opacity: 0; transform: translateY(5px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>

      {/* ── Title ── */}
      <div style={{ marginBottom: 22 }}>
        <div
          className="font-display font-bold"
          style={{ fontSize: 15, color: 'var(--color-text-primary)', marginBottom: 3 }}
        >
          {isComplete ? 'Extraction complete' : isError ? 'Extraction failed' : 'Processing…'}
        </div>
        <div className="font-body" style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
          {isComplete
            ? `${savedNodeCount} entities · ${savedEdgeCount} relationships · ${crossConnectionCount} connections`
            : formatElapsed(elapsedMs)}
        </div>
      </div>

      {/* ── Timeline ── */}
      <div>
        {STEPS.map((s, i) => {
          let state: 'pending' | 'active' | 'done' | 'error' = 'pending'
          if (isError && i === currentIdx)        state = 'error'
          else if (isComplete || i < currentIdx)  state = 'done'
          else if (i === currentIdx)              state = 'active'

          const isLast          = i === STEPS.length - 1
          const isExpandedState = state === 'active' || state === 'error'
          const Icon            = s.Icon

          // Badge shown on completed steps
          let doneBadge: string | null = null
          if (state === 'done') {
            if (s.key === 'extracting')              doneBadge = `${extractedCount} found`
            else if (s.key === 'reviewing')          doneBadge = `${approvedCount} approved`
            else if (s.key === 'saving_nodes')       doneBadge = `${savedNodeCount} saved`
            else if (s.key === 'discovering_connections' && crossConnectionCount > 0)
                                                     doneBadge = `${crossConnectionCount} linked`
          }

          return (
            <div key={s.key} style={{ display: 'flex', gap: 12 }}>
              {/* ── Left: dot + connector ── */}
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: 28, flexShrink: 0 }}>
                {/* Dot */}
                <div
                  style={{
                    width: 28,
                    height: 28,
                    borderRadius: '50%',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexShrink: 0,
                    background:
                      state === 'done'   ? 'var(--color-semantic-green-500)'
                      : state === 'active' ? 'var(--color-accent-500)'
                      : state === 'error'  ? 'var(--color-semantic-red-500)'
                      : 'var(--color-bg-inset)',
                    border: state === 'pending' ? '1.5px solid var(--border-subtle)' : 'none',
                    animation: state === 'active' ? 'pipelinePulse 1.8s ease-in-out infinite' : 'none',
                    transition: 'background 0.3s ease',
                  }}
                >
                  {state === 'done' ? (
                    <Check size={13} color="white" strokeWidth={3} />
                  ) : state === 'error' ? (
                    <X size={13} color="white" strokeWidth={3} />
                  ) : (
                    <Icon
                      size={12}
                      color={state === 'active' ? 'white' : 'var(--color-text-placeholder)'}
                      strokeWidth={2}
                    />
                  )}
                </div>

                {/* Connector line */}
                {!isLast && (
                  <div
                    style={{
                      width: 2,
                      flex: 1,
                      minHeight: isExpandedState ? 12 : 8,
                      background:
                        i < currentIdx || isComplete
                          ? 'var(--color-semantic-green-500)'
                          : i === currentIdx
                            ? 'rgba(214,58,0,0.2)'
                            : 'var(--border-subtle)',
                      transition: 'background 0.3s ease',
                    }}
                  />
                )}
              </div>

              {/* ── Right: label + body ── */}
              <div style={{ flex: 1, paddingBottom: isLast ? 0 : 4 }}>
                {/* Header row */}
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    minHeight: 28,
                    paddingBottom: isExpandedState ? 10 : 0,
                  }}
                >
                  <span
                    className="font-body font-semibold"
                    style={{
                      fontSize: 13,
                      flex: 1,
                      color:
                        state === 'active'  ? 'var(--color-text-primary)'
                        : state === 'error' ? 'var(--color-semantic-red-500)'
                        : state === 'done'  ? 'var(--color-text-body)'
                        : 'var(--color-text-secondary)',
                    }}
                  >
                    {s.label}
                  </span>

                  {/* Done badge */}
                  {doneBadge && (
                    <span
                      className="font-body"
                      style={{
                        fontSize: 10,
                        fontWeight: 600,
                        color: '#16a34a',
                        background: 'rgba(22,163,74,0.08)',
                        border: '1px solid rgba(22,163,74,0.15)',
                        borderRadius: 5,
                        padding: '2px 7px',
                      }}
                    >
                      {doneBadge}
                    </span>
                  )}

                  {/* Elapsed timer for non-review active steps */}
                  {state === 'active' && s.key !== 'reviewing' && (
                    <span
                      className="font-body"
                      style={{ fontSize: 11, color: 'var(--color-text-secondary)', fontWeight: 500 }}
                    >
                      {formatElapsed(elapsedMs)}
                    </span>
                  )}
                </div>

                {/* ── Active body ── */}
                {state === 'active' && (
                  <div style={{ animation: 'stepBodyIn 0.2s ease', marginBottom: 8 }}>
                    {s.key === 'reviewing' ? (
                      displayEntities && relationships ? (
                        <div
                          style={{
                            background: 'var(--color-bg-card)',
                            border: '1px solid var(--border-subtle)',
                            borderRadius: 10,
                            padding: '4px 16px 16px',
                          }}
                        >
                          <EntityReview
                            entities={displayEntities}
                            relationships={relationships}
                            onEntitiesChange={setReviewEntities}
                            onSave={handleSaveClick}
                            onReExtract={onReExtract}
                            saving={pendingSave}
                          />
                        </div>
                      ) : (
                        <StatusBody text="Preparing entities for review…" />
                      )
                    ) : s.key === 'generating_embeddings' && embeddingProgress ? (
                      <EmbeddingBody
                        embeddingProgress={embeddingProgress}
                        statusText={statusText}
                      />
                    ) : (
                      <StatusBody text={statusText} />
                    )}
                  </div>
                )}

                {/* ── Error body ── */}
                {state === 'error' && (
                  <div style={{ animation: 'stepBodyIn 0.2s ease', marginBottom: 8 }}>
                    <div
                      className="font-body"
                      style={{
                        fontSize: 12,
                        color: 'var(--color-semantic-red-500)',
                        padding: '10px 14px',
                        background: 'rgba(239,68,68,0.06)',
                        border: '1px solid rgba(239,68,68,0.15)',
                        borderRadius: 8,
                        marginBottom: 10,
                        lineHeight: 1.5,
                      }}
                    >
                      {error?.message ?? 'An unexpected error occurred.'}
                    </div>
                    {(onRetry || onCancel) && (
                      <div style={{ display: 'flex', gap: 8 }}>
                        {onRetry && (
                          <button
                            type="button"
                            onClick={onRetry}
                            className="font-body font-semibold cursor-pointer"
                            style={{
                              fontSize: 12,
                              padding: '7px 16px',
                              borderRadius: 8,
                              background: 'var(--color-bg-inset)',
                              border: '1px solid var(--border-default)',
                              color: 'var(--color-text-body)',
                            }}
                          >
                            Retry
                          </button>
                        )}
                        {onCancel && (
                          <button
                            type="button"
                            onClick={onCancel}
                            className="font-body font-semibold cursor-pointer"
                            style={{
                              fontSize: 12,
                              padding: '7px 16px',
                              borderRadius: 8,
                              background: 'transparent',
                              border: '1px solid var(--border-subtle)',
                              color: 'var(--color-text-secondary)',
                            }}
                          >
                            Cancel
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {/* ── Complete summary card ── */}
      {isComplete && (
        <div
          style={{
            marginTop: 20,
            background: 'var(--color-bg-card)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 12,
            padding: '18px 20px',
            animation: 'stepBodyIn 0.3s ease',
          }}
        >
          {/* Header */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
            <CheckCircle
              size={20}
              style={{ color: 'var(--color-semantic-green-500)', flexShrink: 0 }}
            />
            <div>
              <div
                className="font-display font-bold"
                style={{ fontSize: 14, color: 'var(--color-text-primary)' }}
              >
                Saved to graph
              </div>
              {duplicatesSkipped > 0 && (
                <div
                  className="font-body"
                  style={{ fontSize: 11, color: 'var(--color-text-secondary)', marginTop: 1 }}
                >
                  {duplicatesSkipped} entities merged with existing nodes
                </div>
              )}
            </div>
          </div>

          {/* Stats grid */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              gap: 8,
              marginBottom: 16,
            }}
          >
            {[
              { value: savedNodeCount,                           label: 'Entities'        },
              { value: savedEdgeCount,                           label: 'Relationships'   },
              { value: crossConnectionCount,                     label: 'Cross-connections' },
              { value: `${(elapsedMs / 1000).toFixed(1)}s`,     label: 'Processing time' },
            ].map(stat => (
              <div
                key={stat.label}
                style={{
                  background: 'var(--color-bg-inset)',
                  borderRadius: 8,
                  padding: '10px 12px',
                }}
              >
                <div
                  className="font-display font-extrabold"
                  style={{ fontSize: 20, color: 'var(--color-text-primary)', lineHeight: 1 }}
                >
                  {stat.value}
                </div>
                <div
                  className="font-body"
                  style={{ fontSize: 10, color: 'var(--color-text-secondary)', marginTop: 3 }}
                >
                  {stat.label}
                </div>
              </div>
            ))}
          </div>

          {/* Actions */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                type="button"
                onClick={onViewInBrowse}
                className="font-body font-semibold cursor-pointer"
                style={{
                  flex: 1,
                  fontSize: 12,
                  padding: '9px 0',
                  borderRadius: 8,
                  background: 'var(--color-bg-inset)',
                  border: '1px solid var(--border-default)',
                  color: 'var(--color-text-body)',
                  textAlign: 'center',
                }}
              >
                View in Browse
              </button>
              <button
                type="button"
                onClick={onIngestAnother}
                className="font-body font-semibold cursor-pointer"
                style={{
                  flex: 1,
                  fontSize: 12,
                  padding: '9px 0',
                  borderRadius: 8,
                  background: 'var(--color-accent-500)',
                  border: 'none',
                  color: 'white',
                  textAlign: 'center',
                  boxShadow: '0 2px 8px rgba(214,58,0,0.18)',
                }}
              >
                Capture another
              </button>
            </div>
            {onChatWithCapture && (
              <button
                type="button"
                onClick={onChatWithCapture}
                className="font-body font-semibold cursor-pointer flex items-center justify-center gap-1.5"
                style={{
                  width: '100%',
                  fontSize: 12,
                  padding: '9px 0',
                  borderRadius: 7,
                  background: 'var(--color-bg-inset)',
                  border: '1px solid var(--border-subtle)',
                  color: 'var(--color-text-body)',
                  textAlign: 'center',
                  transition: 'background 0.12s ease',
                }}
                onMouseEnter={e => { e.currentTarget.style.background = 'var(--color-bg-card)' }}
                onMouseLeave={e => { e.currentTarget.style.background = 'var(--color-bg-inset)' }}
              >
                <MessageSquare size={12} />
                Chat with what you captured
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function StatusBody({ text }: { text: string }) {
  return (
    <div
      className="font-body"
      style={{
        fontSize: 12,
        color: 'var(--color-text-secondary)',
        padding: '10px 14px',
        background: 'var(--color-bg-inset)',
        borderRadius: 8,
        lineHeight: 1.5,
      }}
    >
      {text}
    </div>
  )
}

function EmbeddingBody({
  embeddingProgress,
  statusText,
}: {
  embeddingProgress: { completed: number; total: number }
  statusText: string
}) {
  const pct = Math.round(
    (embeddingProgress.completed / Math.max(1, embeddingProgress.total)) * 100
  )
  return (
    <div
      style={{
        background: 'var(--color-bg-inset)',
        borderRadius: 8,
        padding: '10px 14px',
      }}
    >
      <div
        className="font-body"
        style={{
          fontSize: 11,
          color: 'var(--color-text-secondary)',
          marginBottom: 8,
          display: 'flex',
          justifyContent: 'space-between',
        }}
      >
        <span>{statusText}</span>
        <span>{embeddingProgress.completed}/{embeddingProgress.total}</span>
      </div>
      <div
        style={{
          height: 4,
          background: 'var(--border-subtle)',
          borderRadius: 4,
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            height: '100%',
            width: `${pct}%`,
            background: 'var(--color-accent-500)',
            borderRadius: 4,
            transition: 'width 0.2s ease',
          }}
        />
      </div>
    </div>
  )
}
