import type { SimulationJob } from '../../types/simulate'

interface SimulationRunnerProps {
  job: SimulationJob
}

function statusLabel(status: string): string {
  switch (status) {
    case 'preparing': return 'Preparing your knowledge graph…'
    case 'running': return 'Running simulation…'
    case 'pending': return 'Queuing simulation…'
    default: return 'Processing…'
  }
}

export function SimulationRunner({ job }: SimulationRunnerProps) {
  return (
    <div
      className="flex flex-col items-center justify-center"
      style={{ flex: 1, padding: 48, textAlign: 'center' }}
    >
      {/* Pulsing circle */}
      <div
        style={{
          width: 64, height: 64, borderRadius: 32,
          background: 'var(--color-accent-50)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          marginBottom: 24,
          animation: 'pulse 2s ease-in-out infinite',
        }}
      >
        <div
          style={{
            width: 24, height: 24, borderRadius: 12,
            background: 'var(--color-accent-500)',
            animation: 'pulse 2s ease-in-out infinite',
          }}
        />
      </div>

      {/* Status label */}
      <h2
        className="font-display"
        style={{ fontSize: 18, fontWeight: 700, color: 'var(--color-text-primary)', margin: '0 0 16px 0' }}
      >
        {statusLabel(job.status)}
      </h2>

      {/* Progress bar */}
      <div
        style={{
          width: '100%', maxWidth: 400, height: 4,
          background: 'var(--color-bg-inset)', borderRadius: 2,
          marginBottom: 8, overflow: 'hidden',
        }}
      >
        <div
          style={{
            width: `${job.progress}%`, height: '100%',
            background: 'var(--color-accent-500)',
            borderRadius: 2,
            transition: 'width 0.5s ease',
          }}
        />
      </div>

      {/* Progress percentage */}
      <div className="w-full flex justify-end" style={{ maxWidth: 400 }}>
        <span className="font-body" style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
          {job.progress}%
        </span>
      </div>

      {/* Progress message */}
      {job.progressMessage && (
        <p
          className="font-body"
          style={{
            fontSize: 13, color: 'var(--color-text-secondary)',
            fontStyle: 'italic', marginTop: 12,
          }}
        >
          {job.progressMessage}
        </p>
      )}

      {/* Scope summary */}
      {(job.scopeNodeCount !== null || job.scopeEdgeCount !== null) && (
        <p
          className="font-body"
          style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 16 }}
        >
          {job.scopeNodeCount ?? 0} entities · {job.scopeEdgeCount ?? 0} relationships · {job.scopeTimeWindowDays}-day window
        </p>
      )}

      {/* Estimate note */}
      <p
        className="font-body"
        style={{
          fontSize: 12, color: 'var(--color-text-placeholder)',
          marginTop: 24, maxWidth: 360,
        }}
      >
        Simulations typically take 5–15 minutes. You can leave this page — we'll notify you when it's ready.
      </p>
    </div>
  )
}
