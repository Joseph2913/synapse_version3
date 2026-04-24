import { useEffect, useState } from 'react'
import type { CouncilCronRun } from '../../types/council'
import { fetchLatestCouncilRun } from '../../services/supabase'
import { useAuth } from '../../hooks/useAuth'

export function CouncilTelemetryStrip() {
  const { user } = useAuth()
  const [run, setRun] = useState<CouncilCronRun | null>(null)

  useEffect(() => {
    if (!user) return
    fetchLatestCouncilRun(user.id).then(setRun)
  }, [user])

  if (!run) return null
  const p0 = run.phase_counts.phase0
  const hoursAgo = Math.max(0, Math.round((Date.now() - new Date(run.started_at).getTime()) / 3600_000))

  return (
    <div className="flex items-center gap-3 border-b border-[var(--border-subtle)] bg-[var(--color-bg-card)] px-6 py-2 text-[12px] font-body text-[var(--color-text-secondary)]">
      <span>Last run {hoursAgo}h ago · {run.status}</span>
      {p0 && (
        <>
          <span className="h-4 w-px bg-[var(--border-subtle)]" />
          <span>{p0.questions_answered} answered · {p0.questions_partially_addressed} partial · {p0.novel_connections_written} novel connections · {p0.tensions_written ?? 0} tensions</span>
        </>
      )}
    </div>
  )
}
