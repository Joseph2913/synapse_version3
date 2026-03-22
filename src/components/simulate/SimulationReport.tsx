import { useState } from 'react'
import { ChevronDown, ChevronUp, RotateCcw, Download, Copy, Check } from 'lucide-react'
import { getEntityColor } from '../../config/entityTypes'
import type { SimulationJob, SimulationForecast, SimulationAgentMove } from '../../types/simulate'

interface SimulationReportProps {
  job: SimulationJob
  onRerun: () => void
  onIngest: (jobId: string) => Promise<void>
}

function confidenceColor(level: 'low' | 'medium' | 'high'): { bg: string; text: string; border: string } {
  switch (level) {
    case 'high': return { bg: '#f0fdf4', text: '#15803d', border: '#22c55e' }
    case 'medium': return { bg: '#eff6ff', text: '#1d4ed8', border: '#3b82f6' }
    case 'low': return { bg: '#fffbeb', text: '#b45309', border: '#f59e0b' }
  }
}

function influenceDotColor(influence: 'low' | 'medium' | 'high'): string {
  switch (influence) {
    case 'high': return 'var(--color-accent-500)'
    case 'medium': return '#d97706'
    case 'low': return '#22c55e'
  }
}

export function SimulationReport({ job, onRerun, onIngest }: SimulationReportProps) {
  const [rationaleOpen, setRationaleOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const [ingesting, setIngesting] = useState(false)

  const report = job.result
  if (!report) return null

  const conf = confidenceColor(report.confidenceLevel)

  const handleCopy = async () => {
    const text = [
      report.headline,
      '',
      report.summary,
      '',
      '## Forecasts',
      ...report.forecasts.map(f => `- ${f.direction} (${f.timeframe}, ${f.confidence}): ${f.rationale}`),
      '',
      '## Surprises',
      ...report.surprises.map(s => `- ${s}`),
    ].join('\n')
    await navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const handleIngest = async () => {
    setIngesting(true)
    try {
      await onIngest(job.id)
    } finally {
      setIngesting(false)
    }
  }

  return (
    <div className="flex flex-col gap-4" style={{ paddingBottom: 80 }}>
      {/* Header card */}
      <div
        style={{
          background: 'white', borderRadius: 12,
          border: '1px solid rgba(0,0,0,0.06)',
          padding: '20px 24px',
        }}
      >
        <div
          className="font-display"
          style={{ fontSize: 10, fontWeight: 700, color: 'var(--color-text-secondary)', letterSpacing: '0.08em', marginBottom: 8 }}
        >
          SIMULATION COMPLETE
        </div>
        <h2
          className="font-display"
          style={{ fontSize: 20, fontWeight: 700, color: 'var(--color-text-primary)', lineHeight: 1.25, margin: '0 0 12px 0' }}
        >
          {report.headline}
        </h2>
        <p className="font-body" style={{ fontSize: 14, color: 'var(--color-text-body)', margin: '0 0 12px 0' }}>
          {report.summary}
        </p>
        <div className="flex items-center gap-3 flex-wrap">
          <span className="font-body" style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
            {new Date(report.generatedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
          </span>
          <span style={{ color: 'var(--color-text-placeholder)' }}>·</span>
          <span className="font-body" style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
            {report.agentCount} agents
          </span>
          <span style={{ color: 'var(--color-text-placeholder)' }}>·</span>
          <span className="font-body" style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
            {report.simulationRounds} rounds
          </span>
          <span
            className="font-body font-semibold"
            style={{
              fontSize: 11, padding: '2px 10px', borderRadius: 20,
              background: conf.bg, color: conf.text, border: `1px solid ${conf.border}`,
            }}
          >
            {report.confidenceLevel} confidence
          </span>
        </div>
      </div>

      {/* Forecasts */}
      <div>
        <div
          className="font-display"
          style={{ fontSize: 10, fontWeight: 700, color: 'var(--color-text-secondary)', letterSpacing: '0.08em', marginBottom: 10 }}
        >
          KEY FORECASTS
        </div>
        <div className="flex flex-col gap-3">
          {report.forecasts.map((f: SimulationForecast, i: number) => {
            const fc = confidenceColor(f.confidence)
            return (
              <div
                key={i}
                style={{
                  background: 'white', borderRadius: 10,
                  border: '1px solid rgba(0,0,0,0.06)',
                  borderLeft: `3px solid ${fc.border}`,
                  padding: '12px 16px',
                }}
              >
                <div className="flex items-center justify-between" style={{ marginBottom: 4 }}>
                  <span className="font-body" style={{ fontSize: 15, fontWeight: 500, color: 'var(--color-text-primary)' }}>
                    {f.direction}
                  </span>
                  <div className="flex items-center gap-2">
                    <span
                      className="font-body"
                      style={{ fontSize: 11, color: 'var(--color-text-secondary)', background: 'var(--color-bg-inset)', padding: '2px 8px', borderRadius: 20 }}
                    >
                      {f.timeframe}
                    </span>
                    <div style={{ width: 6, height: 6, borderRadius: 3, background: fc.border }} title={`${f.confidence} confidence`} />
                  </div>
                </div>
                <p className="font-body" style={{ fontSize: 13, color: 'var(--color-text-secondary)', margin: 0 }}>
                  {f.rationale}
                </p>
              </div>
            )
          })}
        </div>
      </div>

      {/* Agent moves */}
      <div>
        <div
          className="font-display"
          style={{ fontSize: 10, fontWeight: 700, color: 'var(--color-text-secondary)', letterSpacing: '0.08em', marginBottom: 10 }}
        >
          LIKELY MOVES
        </div>
        <div className="flex flex-col gap-2">
          {report.agentMoves.map((m: SimulationAgentMove, i: number) => {
            const color = getEntityColor(m.entityType)
            return (
              <div
                key={i}
                className="flex items-start gap-3"
                style={{
                  background: 'white', borderRadius: 10,
                  border: '1px solid rgba(0,0,0,0.06)',
                  padding: '10px 14px',
                }}
              >
                <div className="flex items-center gap-1 shrink-0" style={{ marginTop: 2 }}>
                  <div style={{ width: 6, height: 6, borderRadius: 3, background: color }} />
                  <span className="font-body" style={{ fontSize: 10, color: 'var(--color-text-secondary)' }}>
                    {m.entityType}
                  </span>
                </div>
                <div className="flex-1 min-w-0">
                  <span className="font-body" style={{ fontSize: 14 }}>
                    <span style={{ fontWeight: 500, color: 'var(--color-text-primary)' }}>{m.agentLabel}</span>
                    <span style={{ color: 'var(--color-text-secondary)' }}> is likely to </span>
                    <span style={{ color: 'var(--color-text-body)' }}>{m.likelyAction}</span>
                  </span>
                  <p className="font-body" style={{ fontSize: 12, color: 'var(--color-text-secondary)', margin: '2px 0 0 0' }}>
                    {m.rationale}
                  </p>
                </div>
                <div
                  style={{
                    width: 6, height: 6, borderRadius: 3, marginTop: 6, flexShrink: 0,
                    background: influenceDotColor(m.influence),
                  }}
                  title={`${m.influence} influence`}
                />
              </div>
            )
          })}
        </div>
      </div>

      {/* Surprises */}
      {report.surprises.length > 0 && (
        <div>
          <div
            className="font-display"
            style={{ fontSize: 10, fontWeight: 700, color: 'var(--color-text-secondary)', letterSpacing: '0.08em', marginBottom: 10 }}
          >
            UNEXPECTED SIGNALS
          </div>
          <div className="flex flex-col gap-2">
            {report.surprises.map((s: string, i: number) => (
              <div
                key={i}
                style={{
                  background: 'white', borderRadius: 10,
                  border: '1px solid rgba(0,0,0,0.06)',
                  borderLeft: '3px solid #f59e0b',
                  padding: '10px 14px',
                }}
              >
                <span className="font-body" style={{ fontSize: 14, color: 'var(--color-text-body)' }}>
                  {s}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Confidence rationale (collapsible) */}
      <div
        style={{
          background: 'white', borderRadius: 10,
          border: '1px solid rgba(0,0,0,0.06)',
          overflow: 'hidden',
        }}
      >
        <button
          type="button"
          onClick={() => setRationaleOpen(!rationaleOpen)}
          className="w-full flex items-center justify-between cursor-pointer"
          style={{
            padding: '12px 16px', background: 'none', border: 'none',
          }}
        >
          <span className="font-body" style={{ fontSize: 13, fontWeight: 500, color: 'var(--color-text-body)' }}>
            Why this confidence level?
          </span>
          {rationaleOpen ? <ChevronUp size={14} color="var(--color-text-secondary)" /> : <ChevronDown size={14} color="var(--color-text-secondary)" />}
        </button>
        {rationaleOpen && (
          <div style={{ padding: '0 16px 14px 16px' }}>
            <p className="font-body" style={{ fontSize: 13, color: 'var(--color-text-secondary)', margin: 0 }}>
              {report.confidenceRationale}
            </p>
          </div>
        )}
      </div>

      {/* Action bar */}
      <div
        className="flex items-center gap-3"
        style={{
          position: 'sticky', bottom: 0,
          padding: '12px 20px',
          background: 'white',
          borderTop: '1px solid rgba(0,0,0,0.06)',
          borderRadius: '0 0 12px 12px',
        }}
      >
        <button
          type="button"
          onClick={onRerun}
          className="flex items-center gap-2 cursor-pointer font-body font-semibold"
          style={{
            fontSize: 12, padding: '7px 14px', borderRadius: 20,
            background: 'transparent', border: '1px solid var(--border-subtle)',
            color: 'var(--color-text-secondary)',
            transition: 'all 0.15s ease',
          }}
        >
          <RotateCcw size={13} />
          Re-run with same scope
        </button>
        <button
          type="button"
          onClick={handleIngest}
          disabled={ingesting || !!job.ingestedSourceId}
          className="flex items-center gap-2 cursor-pointer font-body font-semibold"
          style={{
            fontSize: 12, padding: '7px 14px', borderRadius: 20,
            background: job.ingestedSourceId ? 'var(--color-bg-inset)' : 'var(--color-accent-50)',
            border: job.ingestedSourceId ? '1px solid var(--border-subtle)' : '1px solid rgba(214,58,0,0.15)',
            color: job.ingestedSourceId ? 'var(--color-text-secondary)' : 'var(--color-accent-500)',
            transition: 'all 0.15s ease',
            opacity: ingesting ? 0.6 : 1,
          }}
        >
          <Download size={13} />
          {job.ingestedSourceId ? 'Already ingested' : ingesting ? 'Ingesting…' : 'Ingest report into graph'}
        </button>
        <button
          type="button"
          onClick={handleCopy}
          className="flex items-center gap-2 cursor-pointer font-body font-semibold"
          style={{
            fontSize: 12, padding: '7px 14px', borderRadius: 20,
            background: 'transparent', border: '1px solid var(--border-subtle)',
            color: 'var(--color-text-secondary)',
            transition: 'all 0.15s ease',
          }}
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
          {copied ? 'Copied' : 'Share'}
        </button>
      </div>
    </div>
  )
}
