import { useState } from 'react'
import { AlignLeft, Loader2, ChevronDown, ChevronUp } from 'lucide-react'
import { useBackfillStatus } from '../../hooks/useBackfillStatus'

// Stage 2: filter values are lowercase canonical source_type strings.
// 'all' is a sentinel handled by the backfill API.
const SOURCE_TYPES: Array<{ label: string; value: string }> = [
  { label: 'Meeting',   value: 'meeting' },
  { label: 'YouTube',   value: 'youtube' },
  { label: 'Research',  value: 'research' },
  { label: 'Note',      value: 'paste' },
  { label: 'Document',  value: 'file' },
  { label: 'Web',       value: 'url' },
  { label: 'All',       value: 'all' },
]

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
  return `${days}d ago`
}

export function BackfillCard() {
  const { status, runBackfill, runFullBackfill } = useBackfillStatus()
  const [showTypeDropdown, setShowTypeDropdown] = useState(false)
  const [showErrors, setShowErrors] = useState(false)

  const summarized = status.totalSources - status.missingSummaries
  const progressPct = status.totalSources > 0
    ? Math.round((summarized / status.totalSources) * 100)
    : 0
  const isComplete = status.missingSummaries === 0 && status.totalSources > 0

  const statusDotColor = isComplete
    ? '#10b981'
    : status.missingSummaries > 0
      ? '#f59e0b'
      : '#9ca3af'
  const statusLabel = isComplete
    ? 'Complete'
    : status.totalSources === 0
      ? 'No sources'
      : `${status.missingSummaries} remaining`

  const handleTypeSelect = (type: string) => {
    setShowTypeDropdown(false)
    void runBackfill(type)
  }

  return (
    <div
      style={{
        background: 'var(--color-bg-card)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 12,
        padding: '16px 22px',
        marginBottom: 20,
      }}
    >
      {/* Header */}
      <div className="flex items-center justify-between" style={{ marginBottom: 10 }}>
        <div className="flex items-center gap-2">
          <div
            className="flex items-center justify-center"
            style={{
              width: 28,
              height: 28,
              borderRadius: 7,
              background: 'var(--color-bg-inset)',
            }}
          >
            <AlignLeft size={14} style={{ color: 'var(--color-text-secondary)' }} />
          </div>
          <span
            className="font-display font-bold"
            style={{ fontSize: 14, color: 'var(--color-text-primary)' }}
          >
            Source Summaries
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: '50%',
              background: statusDotColor,
              display: 'inline-block',
            }}
          />
          <span
            className="font-body"
            style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}
          >
            {statusLabel}
          </span>
        </div>
      </div>

      {/* Stats */}
      <p
        className="font-body"
        style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginBottom: 8 }}
      >
        {summarized} / {status.totalSources} sources summarized
        {status.missingSummaries > 0 && ` (${status.missingSummaries} remaining)`}
      </p>

      {/* Progress bar */}
      {status.missingSummaries > 0 && (
        <div
          style={{
            height: 4,
            borderRadius: 2,
            background: 'var(--color-bg-inset)',
            overflow: 'hidden',
            marginBottom: 12,
          }}
        >
          <div
            style={{
              height: '100%',
              width: `${progressPct}%`,
              background: 'var(--color-accent-500)',
              borderRadius: 2,
              transition: 'width 0.5s ease',
            }}
          />
        </div>
      )}

      {/* Batch progress */}
      {status.batchProgress && (
        <p
          className="font-body"
          style={{ fontSize: 11, color: 'var(--color-accent-500)', marginBottom: 8 }}
        >
          {status.batchProgress}
        </p>
      )}

      {/* Actions */}
      <div className="flex items-center gap-2" style={{ marginTop: status.missingSummaries === 0 ? 4 : 0 }}>
        <button
          type="button"
          onClick={() => void runFullBackfill()}
          disabled={status.isRunning}
          className="font-body font-semibold cursor-pointer inline-flex items-center gap-1.5"
          style={{
            fontSize: 12,
            padding: '6px 14px',
            borderRadius: 7,
            background: 'var(--color-bg-inset)',
            border: '1px solid var(--border-default)',
            color: 'var(--color-text-body)',
            opacity: status.isRunning ? 0.4 : 1,
            cursor: status.isRunning ? 'not-allowed' : 'pointer',
            transition: 'opacity 0.15s',
          }}
        >
          {status.isRunning ? (
            <>
              <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} />
              Processing...
            </>
          ) : (
            'Run Backfill'
          )}
        </button>

        <div style={{ position: 'relative' }}>
          <button
            type="button"
            onClick={() => setShowTypeDropdown(prev => !prev)}
            disabled={status.isRunning}
            className="font-body cursor-pointer"
            style={{
              fontSize: 11,
              color: status.isRunning ? 'var(--color-text-placeholder)' : 'var(--color-accent-500)',
              background: 'none',
              border: 'none',
              padding: 0,
              textDecoration: 'none',
              cursor: status.isRunning ? 'not-allowed' : 'pointer',
            }}
            onMouseEnter={e => {
              if (!status.isRunning) (e.currentTarget as HTMLButtonElement).style.textDecoration = 'underline'
            }}
            onMouseLeave={e => {
              (e.currentTarget as HTMLButtonElement).style.textDecoration = 'none'
            }}
          >
            Run by Type
          </button>

          {showTypeDropdown && (
            <div
              style={{
                position: 'absolute',
                top: '100%',
                left: 0,
                marginTop: 4,
                background: 'var(--color-bg-card)',
                border: '1px solid var(--border-default)',
                borderRadius: 8,
                boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
                padding: 4,
                zIndex: 20,
                minWidth: 120,
              }}
            >
              {SOURCE_TYPES.map(({ label, value }) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => handleTypeSelect(value)}
                  className="font-body w-full text-left cursor-pointer"
                  style={{
                    fontSize: 12,
                    padding: '6px 10px',
                    borderRadius: 5,
                    background: 'transparent',
                    border: 'none',
                    color: 'var(--color-text-body)',
                    transition: 'background 0.12s ease',
                  }}
                  onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = 'var(--color-bg-inset)' }}
                  onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = 'transparent' }}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Last run info */}
      {status.lastRun && (
        <p
          className="font-body"
          style={{ fontSize: 11, color: 'var(--color-text-secondary)', marginTop: 10 }}
        >
          Last run: {formatRelativeTime(status.lastRun.timestamp)} · {status.lastRun.processed} sources processed
          {status.lastRun.errors > 0 && ` · ${status.lastRun.errors} errors`}
        </p>
      )}

      {/* Errors */}
      {status.backfillErrors.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <button
            type="button"
            onClick={() => setShowErrors(prev => !prev)}
            className="font-body font-semibold cursor-pointer inline-flex items-center gap-1"
            style={{
              fontSize: 11,
              color: 'var(--color-semantic-red-500, #ef4444)',
              background: 'none',
              border: 'none',
              padding: 0,
            }}
          >
            {status.backfillErrors.length} error{status.backfillErrors.length !== 1 ? 's' : ''}
            {showErrors ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
          </button>

          {showErrors && (
            <div
              style={{
                marginTop: 6,
                padding: '8px 10px',
                borderRadius: 6,
                background: 'rgba(239,68,68,0.05)',
                border: '1px solid rgba(239,68,68,0.15)',
              }}
            >
              {status.backfillErrors.map((err, i) => (
                <p
                  key={i}
                  className="font-body"
                  style={{
                    fontSize: 11,
                    color: 'var(--color-text-secondary)',
                    lineHeight: 1.5,
                    margin: i > 0 ? '4px 0 0' : 0,
                  }}
                >
                  {err}
                </p>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
