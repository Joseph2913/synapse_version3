import type { PipelineStatus } from '../../services/supabase'

interface PipelineStatusStripProps {
  status: PipelineStatus | null
  loading: boolean
  error?: string
}

function formatRelativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime()
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

export function PipelineStatusStrip({ status, loading, error }: PipelineStatusStripProps) {
  if (loading) {
    return (
      <div className="bg-bg-card border border-border-subtle" style={{ borderRadius: 12, padding: '16px 22px' }}>
        <div className="bg-bg-inset animate-pulse" style={{ height: 13, borderRadius: 4, width: '60%' }} />
      </div>
    )
  }

  if (error) {
    return (
      <div className="bg-bg-card border border-border-subtle" style={{ borderRadius: 12, padding: '16px 22px' }}>
        <span className="font-body text-text-secondary" style={{ fontSize: 13, fontStyle: 'italic' }}>{error}</span>
      </div>
    )
  }

  const noYouTube = !status?.lastScanAt

  return (
    <div
      className="bg-bg-card border border-border-subtle flex items-center flex-wrap font-body text-text-secondary"
      style={{ borderRadius: 12, padding: '14px 22px', gap: 16, fontSize: 13 }}
    >
      {/* YouTube */}
      <div className="flex items-center" style={{ gap: 8 }}>
        {noYouTube ? (
          <span>Automation not configured — set up in Automate</span>
        ) : (
          <>
            <span className="shrink-0" style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--color-semantic-green-500)' }} />
            <span>
              YouTube — scanned {formatRelativeTime(status.lastScanAt!)} · {status.lastScanVideosFound} videos found
            </span>
          </>
        )}
      </div>

      {!noYouTube && (
        <>
          <div style={{ width: 1, height: 18, background: 'var(--border-subtle)', flexShrink: 0 }} />
          <span>
            Queue — {status.pendingQueueCount} pending
            {status.failedQueueCount > 0 && (
              <span style={{ color: 'var(--color-semantic-red-500)', fontWeight: 600 }}> · {status.failedQueueCount} failed</span>
            )}
          </span>
        </>
      )}

      {status?.lastProcessedSource && (
        <>
          <div style={{ width: 1, height: 18, background: 'var(--border-subtle)', flexShrink: 0 }} />
          <span>
            Last processed — {status.lastProcessedSource.title}, {formatRelativeTime(status.lastProcessedSource.created_at)}
          </span>
        </>
      )}
    </div>
  )
}
