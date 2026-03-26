import { X, Loader2, MessageSquare } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { EntityBadge } from '../shared/EntityBadge'
import { buildDigestDrilldownContext } from '../../config/chatEntryContexts'
import type { DigestHistoryEntry, DigestOutput, ModuleOutput } from '../../types/digest'
import type { DigestProfile } from '../../types/feed'

interface DigestViewerProps {
  profile: DigestProfile
  entry?: DigestHistoryEntry
  output?: DigestOutput
  generating: boolean
  generationProgress?: { current: number; total: number; name: string }
  onClose: () => void
  onRegenerate?: () => void
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function ModuleSection({ mod }: { mod: ModuleOutput }) {
  return (
    <div
      style={{
        paddingTop: 20,
        paddingBottom: 20,
        borderBottom: '1px solid var(--border-subtle)',
      }}
    >
      <p
        className="font-display font-semibold"
        style={{ fontSize: 14, color: 'var(--color-text-primary)', marginBottom: 8 }}
      >
        {mod.templateName}
      </p>

      {mod.error ? (
        <p
          className="font-body"
          style={{ fontSize: 13, color: 'var(--color-text-secondary)', fontStyle: 'italic' }}
        >
          {mod.content}
        </p>
      ) : (
        <div
          className="font-body"
          style={{
            fontSize: 13,
            color: 'var(--color-text-body)',
            lineHeight: 1.6,
            whiteSpace: 'pre-wrap',
          }}
        >
          {mod.content}
        </div>
      )}

      {mod.citations.length > 0 && (
        <div className="flex flex-wrap gap-1.5" style={{ marginTop: 12 }}>
          {mod.citations.map((c, i) => (
            <EntityBadge
              key={`${c.node_id ?? i}`}
              type={c.entity_type}
              label={c.label}
              size="xs"
            />
          ))}
        </div>
      )}
    </div>
  )
}

export function DigestViewer({
  profile,
  entry,
  output,
  generating,
  generationProgress,
  onClose,
  onRegenerate,
}: DigestViewerProps) {
  const navigate = useNavigate()
  const digest: DigestOutput | undefined = output ?? entry?.content

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9000,
        background: 'rgba(0,0,0,0.55)',
        backdropFilter: 'blur(4px)',
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        paddingTop: 60,
        paddingBottom: 60,
        overflowY: 'auto',
      }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: 720,
          background: 'var(--color-bg-card)',
          border: '1px solid var(--border-default)',
          borderRadius: 16,
          overflow: 'hidden',
          boxShadow: '0 20px 60px rgba(0,0,0,0.15)',
        }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between"
          style={{
            padding: '16px 24px',
            borderBottom: '1px solid var(--border-subtle)',
          }}
        >
          <div>
            <p
              className="font-display font-bold"
              style={{ fontSize: 16, color: 'var(--color-text-primary)' }}
            >
              {profile.title}
            </p>
            <div className="flex items-center gap-2" style={{ marginTop: 4 }}>
              <span
                className="font-body font-bold uppercase"
                style={{
                  fontSize: 10,
                  padding: '2px 8px',
                  borderRadius: 20,
                  background: 'var(--color-bg-inset)',
                  border: '1px solid var(--border-subtle)',
                  color: 'var(--color-text-secondary)',
                  letterSpacing: '0.06em',
                }}
              >
                {profile.frequency}
              </span>
              <span
                className="font-body font-bold uppercase"
                style={{
                  fontSize: 10,
                  padding: '2px 8px',
                  borderRadius: 20,
                  background: 'var(--color-bg-inset)',
                  border: '1px solid var(--border-subtle)',
                  color: 'var(--color-text-secondary)',
                  letterSpacing: '0.06em',
                }}
              >
                {profile.density}
              </span>
              {digest && (
                <span className="font-body" style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>
                  {new Date(digest.generatedAt).toLocaleString()}
                </span>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex items-center justify-center rounded-lg cursor-pointer"
            style={{
              width: 32,
              height: 32,
              background: 'var(--color-bg-inset)',
              border: '1px solid var(--border-subtle)',
              color: 'var(--color-text-secondary)',
            }}
          >
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div style={{ padding: '20px 24px' }}>
          {/* Generation progress */}
          {generating && (
            <div
              className="flex items-center gap-2"
              style={{
                padding: '12px 16px',
                background: 'var(--color-bg-inset)',
                border: '1px solid var(--border-subtle)',
                borderRadius: 8,
                marginBottom: 20,
              }}
            >
              <Loader2
                size={14}
                className="animate-spin shrink-0"
                style={{ color: 'var(--color-accent-500)' }}
              />
              <span className="font-body" style={{ fontSize: 13, color: 'var(--color-text-body)' }}>
                {generationProgress
                  ? `Generating module ${generationProgress.current} of ${generationProgress.total}: ${generationProgress.name}…`
                  : 'Preparing digest…'}
              </span>
            </div>
          )}

          {/* Executive Summary */}
          {digest && (
            <>
              <div
                style={{
                  background: 'var(--color-accent-50)',
                  borderLeft: '4px solid var(--color-accent-500)',
                  borderRadius: '0 8px 8px 0',
                  padding: '14px 16px',
                  marginBottom: 20,
                }}
              >
                <p
                  className="font-display font-semibold"
                  style={{ fontSize: 11, color: 'var(--color-accent-500)', marginBottom: 6, letterSpacing: '0.06em', textTransform: 'uppercase' }}
                >
                  Executive Summary
                </p>
                <p
                  className="font-body"
                  style={{ fontSize: 13, color: 'var(--color-text-body)', lineHeight: 1.6 }}
                >
                  {digest.executiveSummary}
                </p>
              </div>

              {/* Dig deeper button (PRD-B §3.12) */}
              {digest.modules.length > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    const ctx = buildDigestDrilldownContext({
                      profileTitle: profile.title,
                      executiveSummary: digest!.executiveSummary,
                      moduleTitles: digest!.modules.map(m => m.templateName),
                      frequency: profile.frequency,
                    })
                    navigate('/ask', { state: { chatContext: ctx } })
                    onClose()
                  }}
                  className="font-body font-semibold cursor-pointer flex items-center justify-center gap-1.5 w-full"
                  style={{
                    padding: '10px 16px',
                    borderRadius: 8,
                    background: 'var(--color-accent-50)',
                    border: '1px solid rgba(214,58,0,0.15)',
                    color: 'var(--color-accent-500)',
                    fontSize: 12,
                    marginBottom: 20,
                    transition: 'background 0.12s ease',
                  }}
                  onMouseEnter={e => { e.currentTarget.style.background = 'rgba(214,58,0,0.1)' }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'var(--color-accent-50)' }}
                >
                  <MessageSquare size={13} />
                  Dig deeper
                </button>
              )}

              {/* Module sections */}
              <div>
                {digest.modules.map((mod, i) => (
                  <ModuleSection key={`${mod.templateId}-${i}`} mod={mod} />
                ))}
              </div>
            </>
          )}

          {/* Empty state while generating (no digest yet) */}
          {generating && !digest && (
            <div
              className="flex flex-col items-center justify-center"
              style={{ minHeight: 200, color: 'var(--color-text-secondary)' }}
            >
              <p className="font-body" style={{ fontSize: 13 }}>
                Modules will appear as they complete…
              </p>
            </div>
          )}
        </div>

        {/* Footer */}
        {digest && !generating && (
          <div
            className="flex items-center justify-between"
            style={{
              padding: '12px 24px',
              borderTop: '1px solid var(--border-subtle)',
              background: 'var(--color-bg-inset)',
            }}
          >
            <span className="font-body" style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>
              Generated in {formatDuration(digest.totalDurationMs)}
            </span>
            {onRegenerate && (
              <button
                type="button"
                onClick={onRegenerate}
                className="font-body font-semibold cursor-pointer rounded-md"
                style={{
                  fontSize: 12,
                  padding: '5px 12px',
                  background: 'var(--color-bg-card)',
                  border: '1px solid var(--border-default)',
                  color: 'var(--color-text-body)',
                }}
              >
                Regenerate
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
