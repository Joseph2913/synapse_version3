import { ArrowLeft, RotateCcw, ExternalLink } from 'lucide-react'
import type { SimulationJob } from '../../types/simulate'

interface SimulationDetailPanelProps {
  job: SimulationJob
  onBack: () => void
  onViewReport: (job: SimulationJob) => void
  onRerun: () => void
  onResume?: () => void
}

function statusLabel(status: string): { label: string; color: string } {
  switch (status) {
    case 'completed': return { label: 'Completed', color: '#15803d' }
    case 'failed': return { label: 'Failed', color: '#b91c1c' }
    case 'running':
    case 'preparing': return { label: 'Running', color: '#b45309' }
    default: return { label: 'Pending', color: 'var(--color-text-secondary)' }
  }
}

export function SimulationDetailPanel({ job, onBack, onViewReport, onRerun, onResume }: SimulationDetailPanelProps) {
  const sl = statusLabel(job.status)
  const canResume = job.status === 'failed' && job.seedGraph && job.personas && job.personas.length > 0

  return (
    <div style={{ padding: '16px 16px' }}>
      {/* Back button */}
      <button
        type="button"
        onClick={onBack}
        className="flex items-center gap-1 cursor-pointer font-body"
        style={{
          fontSize: 12, color: 'var(--color-text-secondary)',
          background: 'none', border: 'none', padding: 0,
          marginBottom: 16,
        }}
      >
        <ArrowLeft size={13} />
        History
      </button>

      {/* Title + date */}
      <h3
        className="font-display"
        style={{ fontSize: 15, fontWeight: 700, color: 'var(--color-text-primary)', margin: '0 0 4px 0' }}
      >
        {job.title}
      </h3>
      <span className="font-body" style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
        {new Date(job.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
      </span>

      {/* Scope summary */}
      <div style={{ marginTop: 16 }}>
        <div
          className="font-display"
          style={{ fontSize: 10, fontWeight: 700, color: 'var(--color-text-secondary)', letterSpacing: '0.08em', marginBottom: 6 }}
        >
          SCOPE
        </div>
        <div className="flex flex-wrap gap-2" style={{ marginBottom: 8 }}>
          <span className="font-body" style={{ fontSize: 12, color: 'var(--color-text-secondary)', background: 'var(--color-bg-inset)', padding: '2px 10px', borderRadius: 20 }}>
            {job.scopeTimeWindowDays}-day window
          </span>
          {job.scopeNodeCount !== null && (
            <span className="font-body" style={{ fontSize: 12, color: 'var(--color-text-secondary)', background: 'var(--color-bg-inset)', padding: '2px 10px', borderRadius: 20 }}>
              {job.scopeNodeCount} entities
            </span>
          )}
          {job.scopeEdgeCount !== null && (
            <span className="font-body" style={{ fontSize: 12, color: 'var(--color-text-secondary)', background: 'var(--color-bg-inset)', padding: '2px 10px', borderRadius: 20 }}>
              {job.scopeEdgeCount} relationships
            </span>
          )}
        </div>
      </div>

      {/* Prediction question */}
      <div style={{ marginTop: 14 }}>
        <div
          className="font-display"
          style={{ fontSize: 10, fontWeight: 700, color: 'var(--color-text-secondary)', letterSpacing: '0.08em', marginBottom: 6 }}
        >
          QUESTION
        </div>
        <blockquote
          className="font-body"
          style={{
            fontSize: 13, color: 'var(--color-text-body)',
            fontStyle: 'italic', margin: 0,
            paddingLeft: 12, borderLeft: '3px solid var(--color-accent-200, rgba(214,58,0,0.20))',
          }}
        >
          {job.predictionQuestion}
        </blockquote>
      </div>

      {/* What-if variables */}
      {job.whatIfVariables.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <div
            className="font-display"
            style={{ fontSize: 10, fontWeight: 700, color: 'var(--color-text-secondary)', letterSpacing: '0.08em', marginBottom: 6 }}
          >
            WHAT-IF VARIABLES
          </div>
          <div className="flex flex-col gap-1">
            {job.whatIfVariables.map((v, i) => (
              <span key={i} className="font-body" style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
                • {v}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Status */}
      <div style={{ marginTop: 14 }}>
        <div className="flex items-center gap-2">
          <span className="font-body" style={{ fontSize: 12, color: sl.color, fontWeight: 500 }}>
            {sl.label}
          </span>
          {job.completedAt && (
            <span className="font-body" style={{ fontSize: 11, color: 'var(--color-text-placeholder)' }}>
              {new Date(job.completedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
            </span>
          )}
        </div>
      </div>

      {/* Action buttons */}
      <div className="flex flex-col gap-2" style={{ marginTop: 20 }}>
        {job.status === 'completed' && job.result && (
          <button
            type="button"
            onClick={() => onViewReport(job)}
            className="flex items-center justify-center gap-2 cursor-pointer font-body font-semibold w-full"
            style={{
              fontSize: 12, padding: '8px 14px', borderRadius: 20,
              background: 'var(--color-accent-500)', border: 'none',
              color: 'white',
              transition: 'all 0.15s ease',
            }}
          >
            <ExternalLink size={13} />
            View Full Report
          </button>
        )}
        {canResume && onResume && (
          <button
            type="button"
            onClick={onResume}
            className="flex items-center justify-center gap-2 cursor-pointer font-body font-semibold w-full"
            style={{
              fontSize: 12, padding: '8px 14px', borderRadius: 20,
              background: 'var(--color-accent-500)', border: 'none',
              color: 'white',
              transition: 'all 0.15s ease',
            }}
          >
            <RotateCcw size={13} />
            Resume Simulation
          </button>
        )}
        <button
          type="button"
          onClick={onRerun}
          className="flex items-center justify-center gap-2 cursor-pointer font-body font-semibold w-full"
          style={{
            fontSize: 12, padding: '8px 14px', borderRadius: 20,
            background: 'transparent', border: '1px solid var(--border-subtle)',
            color: 'var(--color-text-secondary)',
            transition: 'all 0.15s ease',
          }}
        >
          <RotateCcw size={13} />
          Re-run from scratch
        </button>
      </div>
    </div>
  )
}
