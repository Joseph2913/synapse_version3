import { useState, useCallback, useMemo } from 'react'
import { X, Loader2, MessageSquare, Send, Eye, CheckCircle2, AlertCircle } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../../hooks/useAuth'
import { EntityBadge } from '../shared/EntityBadge'
import { buildDigestDrilldownContext } from '../../config/chatEntryContexts'
import { supabase } from '../../services/supabase'
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

// ─── Markdown → React-safe HTML ─────────────────────────────────────────────

function renderMarkdown(text: string): string {
  let html = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')

  // Headers
  html = html.replace(/^### (.+)$/gm, '<h4 style="margin: 12px 0 4px 0; font-size: 13px; font-weight: 700; color: var(--color-text-primary);">$1</h4>')
  html = html.replace(/^## (.+)$/gm, '<h3 style="margin: 14px 0 6px 0; font-size: 14px; font-weight: 700; color: var(--color-text-primary);">$1</h3>')

  // Bold and italic
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong style="font-weight: 600; color: var(--color-text-primary);">$1</strong>')
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>')

  // Numbered lists
  html = html.replace(
    /((?:^\d+\..+$\n?)+)/gm,
    (block) => {
      const items = block.trim().split('\n').map(line => {
        const lineText = line.replace(/^\d+\.\s*/, '')
        return `<li style="margin-bottom: 4px; color: var(--color-text-body);">${lineText}</li>`
      }).join('')
      return `<ol style="margin: 6px 0 10px 0; padding-left: 20px; line-height: 1.6;">${items}</ol>`
    }
  )

  // Bullet lists
  html = html.replace(
    /((?:^[\-\*] .+$\n?)+)/gm,
    (block) => {
      const items = block.trim().split('\n').map(line => {
        const lineText = line.replace(/^[\-\*]\s*/, '')
        return `<li style="margin-bottom: 4px; color: var(--color-text-body);">${lineText}</li>`
      }).join('')
      return `<ul style="margin: 6px 0 10px 0; padding-left: 20px; line-height: 1.6; list-style-type: disc;">${items}</ul>`
    }
  )

  // Horizontal rules
  html = html.replace(/^---+$/gm, '<hr style="border: none; border-top: 1px solid var(--border-subtle); margin: 12px 0;">')

  // Paragraphs
  html = html.split(/\n{2,}/).map(block => {
    const trimmed = block.trim()
    if (!trimmed) return ''
    if (trimmed.startsWith('<')) return trimmed
    return `<p style="margin: 0 0 8px 0; line-height: 1.6;">${trimmed.replace(/\n/g, '<br>')}</p>`
  }).join('')

  return html
}

function RenderedMarkdown({ text, className, style }: { text: string; className?: string; style?: React.CSSProperties }) {
  const html = useMemo(() => renderMarkdown(text), [text])
  return (
    <div
      className={className}
      style={style}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}

// ─── Module Section ─────────────────────────────────────────────────────────

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
        <RenderedMarkdown
          text={mod.content}
          className="font-body"
          style={{ fontSize: 13, color: 'var(--color-text-body)', lineHeight: 1.6 }}
        />
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

// ─── Email Preview Modal ────────────────────────────────────────────────────

function EmailPreviewModal({ html, onClose }: { html: string; onClose: () => void }) {
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9500,
        background: 'rgba(0,0,0,0.6)',
        backdropFilter: 'blur(4px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 32,
      }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: 680,
          height: '80vh',
          background: 'var(--color-bg-card)',
          border: '1px solid var(--border-default)',
          borderRadius: 12,
          overflow: 'hidden',
          boxShadow: '0 20px 60px rgba(0,0,0,0.2)',
          display: 'flex',
          flexDirection: 'column',
        }}
        onClick={e => e.stopPropagation()}
      >
        <div
          className="flex items-center justify-between shrink-0"
          style={{
            padding: '12px 20px',
            borderBottom: '1px solid var(--border-subtle)',
            background: 'var(--color-bg-inset)',
          }}
        >
          <span className="font-display font-bold" style={{ fontSize: 13, color: 'var(--color-text-primary)' }}>
            Email Preview
          </span>
          <button
            type="button"
            onClick={onClose}
            className="flex items-center justify-center rounded-lg cursor-pointer"
            style={{
              width: 28,
              height: 28,
              background: 'var(--color-bg-card)',
              border: '1px solid var(--border-subtle)',
              color: 'var(--color-text-secondary)',
            }}
          >
            <X size={14} />
          </button>
        </div>
        <iframe
          srcDoc={html}
          title="Email Preview"
          style={{
            flex: 1,
            width: '100%',
            border: 'none',
            background: '#f5f5f4',
          }}
          sandbox="allow-same-origin"
        />
      </div>
    </div>
  )
}

// ─── Main Viewer ────────────────────────────────────────────────────────────

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
  const { user } = useAuth()
  const digest: DigestOutput | undefined = output ?? entry?.content

  // Send email state
  const [sendingEmail, setSendingEmail] = useState(false)
  const [emailStatus, setEmailStatus] = useState<'idle' | 'success' | 'error'>('idle')
  const [emailError, setEmailError] = useState('')

  // Email preview state
  const [previewHtml, setPreviewHtml] = useState<string | null>(null)

  const handleSendEmail = useCallback(async () => {
    if (!digest || !user?.email) return

    setSendingEmail(true)
    setEmailStatus('idle')
    setEmailError('')

    try {
      const { data: sessionData } = await supabase.auth.getSession()
      const token = sessionData.session?.access_token
      if (!token) throw new Error('Not authenticated')

      const response = await fetch('/api/digest/send', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
          email: user.email,
          title: digest.title,
          executiveSummary: digest.executiveSummary,
          modules: digest.modules,
          generatedAt: digest.generatedAt,
        }),
      })

      const result = await response.json()

      // Always grab HTML for preview if available
      if (result.html) setPreviewHtml(result.html)

      if (!response.ok) {
        throw new Error(result.error || 'Failed to send email')
      }

      if (result.emailSent) {
        setEmailStatus('success')
      } else {
        // HTML rendered but email didn't send (e.g. Resend not configured)
        setEmailStatus('error')
        setEmailError(result.error || 'Email delivery not available')
      }
    } catch (err) {
      setEmailStatus('error')
      setEmailError(err instanceof Error ? err.message : 'Failed to send')
    } finally {
      setSendingEmail(false)
    }
  }, [digest, user])


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
                <RenderedMarkdown
                  text={digest.executiveSummary}
                  className="font-body"
                  style={{ fontSize: 13, color: 'var(--color-text-body)', lineHeight: 1.6 }}
                />
              </div>

              {/* Dig deeper button */}
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

          {/* Empty state while generating */}
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

            <div className="flex items-center gap-2">
              {/* Email status feedback */}
              {emailStatus === 'success' && (
                <span className="flex items-center gap-1 font-body" style={{ fontSize: 11, color: '#22c55e' }}>
                  <CheckCircle2 size={12} />
                  Sent to {user?.email}
                </span>
              )}
              {emailStatus === 'error' && (
                <span className="flex items-center gap-1 font-body" style={{ fontSize: 11, color: '#ef4444', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={emailError}>
                  <AlertCircle size={12} style={{ flexShrink: 0 }} />
                  {emailError || 'Failed to send'}
                </span>
              )}

              {/* Preview Email button (only shows after first send) */}
              {previewHtml && (
                <button
                  type="button"
                  onClick={() => setPreviewHtml(previewHtml)} // re-triggers modal
                  className="font-body font-semibold cursor-pointer rounded-md flex items-center gap-1.5"
                  style={{
                    fontSize: 12,
                    padding: '5px 12px',
                    background: 'var(--color-bg-card)',
                    border: '1px solid var(--border-default)',
                    color: 'var(--color-text-body)',
                  }}
                >
                  <Eye size={12} />
                  Preview Email
                </button>
              )}

              {/* Send Email button */}
              <button
                type="button"
                onClick={handleSendEmail}
                disabled={sendingEmail || !user?.email}
                className="font-body font-semibold cursor-pointer rounded-md flex items-center gap-1.5"
                style={{
                  fontSize: 12,
                  padding: '5px 12px',
                  background: emailStatus === 'success' ? 'var(--color-bg-card)' : 'var(--color-accent-50)',
                  border: emailStatus === 'success'
                    ? '1px solid var(--border-default)'
                    : '1px solid rgba(214,58,0,0.2)',
                  color: emailStatus === 'success' ? 'var(--color-text-body)' : 'var(--color-accent-500)',
                  opacity: sendingEmail ? 0.6 : 1,
                }}
              >
                {sendingEmail ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : (
                  <Send size={12} />
                )}
                {sendingEmail ? 'Sending…' : emailStatus === 'success' ? 'Resend' : 'Send Email'}
              </button>

              {/* Regenerate button */}
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
          </div>
        )}
      </div>

      {/* Email Preview Modal */}
      {previewHtml && (
        <EmailPreviewModal
          html={previewHtml}
          onClose={() => setPreviewHtml(null)}
        />
      )}
    </div>
  )
}
