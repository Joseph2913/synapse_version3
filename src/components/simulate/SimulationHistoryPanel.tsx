import type { SimulationJob } from '../../types/simulate'

interface SimulationHistoryPanelProps {
  jobs: SimulationJob[]
  loading: boolean
  onSelectJob: (jobId: string) => void
}

function statusPill(status: string): { label: string; bg: string; color: string } {
  switch (status) {
    case 'completed': return { label: 'Completed', bg: '#f0fdf4', color: '#15803d' }
    case 'failed': return { label: 'Failed', bg: '#fef2f2', color: '#b91c1c' }
    case 'running':
    case 'preparing': return { label: 'Running', bg: '#fffbeb', color: '#b45309' }
    default: return { label: 'Pending', bg: 'var(--color-bg-inset)', color: 'var(--color-text-secondary)' }
  }
}

export function SimulationHistoryPanel({ jobs, loading, onSelectJob }: SimulationHistoryPanelProps) {
  return (
    <div style={{ padding: '20px 16px' }}>
      <div
        className="font-display"
        style={{ fontSize: 10, fontWeight: 700, color: 'var(--color-text-secondary)', letterSpacing: '0.08em', marginBottom: 14 }}
      >
        SIMULATION HISTORY
      </div>

      {loading && (
        <div className="flex flex-col gap-2">
          {[1, 2, 3].map(i => (
            <div
              key={i}
              style={{
                height: 56, borderRadius: 10,
                background: 'var(--color-bg-inset)',
                animation: 'pulse 1.5s ease-in-out infinite',
              }}
            />
          ))}
        </div>
      )}

      {!loading && jobs.length === 0 && (
        <p className="font-body" style={{ fontSize: 13, color: 'var(--color-text-secondary)' }}>
          No simulations run yet. Build your first simulation above.
        </p>
      )}

      {!loading && jobs.length > 0 && (
        <div className="flex flex-col gap-2">
          {jobs.map(job => {
            const sp = statusPill(job.status)
            return (
              <button
                key={job.id}
                type="button"
                onClick={() => onSelectJob(job.id)}
                className="text-left cursor-pointer w-full"
                style={{
                  padding: '10px 12px', borderRadius: 10,
                  background: 'white',
                  border: '1px solid rgba(0,0,0,0.06)',
                  transition: 'all 0.15s ease',
                }}
                onMouseEnter={e => {
                  e.currentTarget.style.borderColor = 'rgba(0,0,0,0.12)'
                  e.currentTarget.style.transform = 'translateY(-1px)'
                }}
                onMouseLeave={e => {
                  e.currentTarget.style.borderColor = 'rgba(0,0,0,0.06)'
                  e.currentTarget.style.transform = 'translateY(0)'
                }}
              >
                <div className="flex items-center justify-between" style={{ marginBottom: 4 }}>
                  <span className="font-body truncate" style={{ fontSize: 13, fontWeight: 500, color: 'var(--color-text-primary)' }}>
                    {job.title}
                  </span>
                  <span
                    className="font-body font-semibold shrink-0"
                    style={{
                      fontSize: 10, padding: '1px 8px', borderRadius: 20,
                      background: sp.bg, color: sp.color,
                      animation: (job.status === 'running' || job.status === 'preparing') ? 'pulse 2s ease-in-out infinite' : 'none',
                    }}
                  >
                    {sp.label}
                  </span>
                </div>
                <span className="font-body" style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
                  {new Date(job.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
                </span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
