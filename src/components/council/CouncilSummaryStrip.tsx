import { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { useAuth } from '../../hooks/useAuth'
import { fetchLatestCouncilRun } from '../../services/supabase'
import type { CouncilCronRun, CouncilOverviewSummary } from '../../types/council'

const STATUS_COLOUR: Record<CouncilCronRun['status'], string> = {
  ok: '#1f6f43',
  partial_failure: '#b45309',
  failed: '#dc2626',
  running: 'var(--color-accent-500)',
}

function relativeTime(iso: string): string {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  if (s < 604800) return `${Math.floor(s / 86400)}d`
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}

interface Props {
  summary: CouncilOverviewSummary | null
  isRecalibrating: boolean
  onRecalibrate: () => void
}

export function CouncilSummaryStrip({ summary, isRecalibrating, onRecalibrate }: Props) {
  const { user } = useAuth()
  const [run, setRun] = useState<CouncilCronRun | null>(null)

  useEffect(() => {
    if (!user) return
    fetchLatestCouncilRun(user.id).then(setRun)
  }, [user, isRecalibrating])

  const dot = <span style={{ color: 'var(--color-text-placeholder)', margin: '0 4px' }}>·</span>
  const s = summary

  return (
    <div
      style={{
        height: 40,
        padding: '0 24px',
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        background: 'var(--color-bg-card)',
        borderBottom: '1px solid var(--border-subtle)',
        fontSize: 12,
        fontFamily: 'var(--font-body)',
        color: 'var(--color-text-body)',
        flexShrink: 0,
      }}
    >
      <span style={{ fontWeight: 600, color: 'var(--color-text-primary)' }}>Council</span>
      {run && (
        <>
          {dot}
          <span style={{ color: 'var(--color-text-secondary)' }}>
            last run {relativeTime(run.started_at)} ago
          </span>
          {dot}
          <span style={{ color: STATUS_COLOUR[run.status], fontWeight: 600 }}>{run.status}</span>
        </>
      )}
      {s && (
        <>
          {dot}
          <span style={{ color: 'var(--color-text-secondary)' }}>
            This week: <strong style={{ color: 'var(--color-text-primary)', fontWeight: 700 }}>{s.insights_this_week}</strong> insights
            {dot}
            <strong style={{ color: 'var(--color-text-primary)', fontWeight: 700 }}>{s.answered_this_week}</strong> answered
            {dot}
            <strong style={{ color: 'var(--color-text-primary)', fontWeight: 700 }}>{s.novel_this_week}</strong> novel
            {dot}
            <strong style={{ color: 'var(--color-text-primary)', fontWeight: 700 }}>{s.new_skills_this_week}</strong> new skills
          </span>
        </>
      )}

      <button
        type="button"
        onClick={onRecalibrate}
        disabled={isRecalibrating}
        style={{
          marginLeft: 'auto',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 5,
          padding: '5px 13px',
          borderRadius: 20,
          fontSize: 12,
          fontWeight: 600,
          fontFamily: 'var(--font-body)',
          cursor: isRecalibrating ? 'wait' : 'pointer',
          border: '1px solid rgba(214,58,0,0.15)',
          background: 'var(--color-accent-50)',
          color: 'var(--color-accent-500)',
          opacity: isRecalibrating ? 0.6 : 1,
        }}
      >
        <RefreshCw size={12} style={{ animation: isRecalibrating ? 'spin 1s linear infinite' : 'none' }} />
        {isRecalibrating ? 'Running...' : 'Recalibrate'}
      </button>
    </div>
  )
}
