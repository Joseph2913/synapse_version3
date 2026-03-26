import { useState, useEffect, useRef } from 'react'
import { AlertTriangle, CheckCircle2, Loader2, Clock, Zap, Users, MessageSquare, Square, ArrowLeft } from 'lucide-react'
import type { SimulationJob, SimulationStage } from '../../types/simulate'

interface RoundLogEntry {
  round: number
  label: string
  note: string
  updatedAgentCount: number
}

interface SimulationRunnerProps {
  job: SimulationJob
  stage: SimulationStage
  roundLog: RoundLogEntry[]
  activeRound: number
  error: string | null
  onCancel?: () => void
  onExit?: () => void
}

// ─── Pipeline stages with descriptions ──────────────────────────────────────
const PIPELINE_STAGES: { key: string; label: string; description: string }[] = [
  { key: 'preparing', label: 'Preparing', description: 'Exporting knowledge graph and configuring agents' },
  { key: 'running', label: 'Simulating', description: 'Agents deliberating across rounds' },
  { key: 'generating_report', label: 'Generating report', description: 'Analysing interaction log and writing findings' },
]

function stageIndex(status: string, stage: SimulationStage): number {
  if (stage === 'generating_report') return 2
  if (status === 'running') return 1
  return 0
}

// ─── Elapsed time formatting ────────────────────────────────────────────────
function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const mins = Math.floor(seconds / 60)
  const secs = seconds % 60
  return `${mins}m ${secs.toString().padStart(2, '0')}s`
}

// ─── Round type icons ───────────────────────────────────────────────────────
function RoundIcon({ label }: { label: string }) {
  if (label.includes('Initial')) return <Users size={12} style={{ color: 'var(--color-accent-500)' }} />
  if (label.includes('responding')) return <MessageSquare size={12} style={{ color: '#6366f1' }} />
  if (label.includes('Minority')) return <Zap size={12} style={{ color: '#f59e0b' }} />
  if (label.includes('revision')) return <Loader2 size={12} style={{ color: '#10b981' }} />
  if (label.includes('Final')) return <CheckCircle2 size={12} style={{ color: '#15803d' }} />
  return <MessageSquare size={12} style={{ color: 'var(--color-text-secondary)' }} />
}

// ─── Stale warning threshold (seconds with no progress update) ──────────────
const STALE_THRESHOLD = 90

export function SimulationRunner({ job, stage, roundLog, activeRound, error, onCancel, onExit }: SimulationRunnerProps) {
  // Elapsed timer
  const [elapsed, setElapsed] = useState(0)
  const startTimeRef = useRef(Date.now())

  useEffect(() => {
    startTimeRef.current = Date.now()
    setElapsed(0)
    const interval = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startTimeRef.current) / 1000))
    }, 1000)
    return () => clearInterval(interval)
  }, [job.id])

  // Track last progress change for stale detection
  const [lastProgressTime, setLastProgressTime] = useState(Date.now())
  const [isStale, setIsStale] = useState(false)
  const prevProgressRef = useRef(job.progress)
  const prevRoundRef = useRef(activeRound)

  useEffect(() => {
    if (job.progress !== prevProgressRef.current || activeRound !== prevRoundRef.current) {
      setLastProgressTime(Date.now())
      setIsStale(false)
      prevProgressRef.current = job.progress
      prevRoundRef.current = activeRound
    }
  }, [job.progress, activeRound])

  useEffect(() => {
    const interval = setInterval(() => {
      const sinceLastProgress = (Date.now() - lastProgressTime) / 1000
      setIsStale(sinceLastProgress > STALE_THRESHOLD)
    }, 5000)
    return () => clearInterval(interval)
  }, [lastProgressTime])

  const currentStageIdx = stageIndex(job.status, stage)
  const progressPct = job.progress ?? 0

  return (
    <div style={{ flex: 1, padding: '32px 48px', maxWidth: 640, margin: '0 auto', width: '100%' }}>

      {/* ── Header: status + elapsed timer ─────────────────────────────── */}
      <div className="flex items-center justify-between" style={{ marginBottom: 24 }}>
        <div className="flex items-center gap-3">
          <div
            style={{
              width: 40, height: 40, borderRadius: 20,
              background: error ? '#fef2f2' : 'var(--color-accent-50)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >
            {error ? (
              <AlertTriangle size={18} style={{ color: '#ef4444' }} />
            ) : (
              <Loader2
                size={18}
                style={{
                  color: 'var(--color-accent-500)',
                  animation: 'spin 1.2s linear infinite',
                }}
              />
            )}
          </div>
          <div>
            <h2
              className="font-display"
              style={{ fontSize: 16, fontWeight: 700, color: 'var(--color-text-primary)', margin: 0 }}
            >
              {error ? 'Simulation failed' : stage === 'generating_report' ? 'Generating report…' : 'Simulation running'}
            </h2>
            <span className="font-body" style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
              {job.title}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <Clock size={12} style={{ color: 'var(--color-text-placeholder)' }} />
          <span className="font-body" style={{ fontSize: 12, color: 'var(--color-text-secondary)', fontVariantNumeric: 'tabular-nums' }}>
            {formatElapsed(elapsed)}
          </span>
        </div>
      </div>

      {/* ── Pipeline stage indicators ──────────────────────────────────── */}
      <div
        style={{
          background: 'var(--color-bg-card)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 12,
          padding: '16px 20px',
          marginBottom: 20,
        }}
      >
        <div className="flex items-center gap-0" style={{ marginBottom: 12 }}>
          {PIPELINE_STAGES.map((ps, i) => {
            const isActive = i === currentStageIdx
            const isDone = i < currentStageIdx
            return (
              <div key={ps.key} className="flex items-center" style={{ flex: 1 }}>
                {i > 0 && (
                  <div
                    style={{
                      width: 32, height: 2, flexShrink: 0,
                      background: isDone ? 'var(--color-accent-500)' : 'rgba(0,0,0,0.08)',
                      transition: 'background 0.3s ease',
                    }}
                  />
                )}
                <div className="flex items-center gap-2" style={{ minWidth: 0 }}>
                  <div
                    style={{
                      width: 20, height: 20, borderRadius: 10, flexShrink: 0,
                      background: isDone ? 'var(--color-accent-500)' : isActive ? 'var(--color-accent-50)' : 'var(--color-bg-inset)',
                      border: isActive ? '2px solid var(--color-accent-500)' : isDone ? 'none' : '1.5px solid rgba(0,0,0,0.10)',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      transition: 'all 0.3s ease',
                    }}
                  >
                    {isDone ? (
                      <CheckCircle2 size={12} style={{ color: 'white' }} />
                    ) : isActive ? (
                      <div style={{ width: 6, height: 6, borderRadius: 3, background: 'var(--color-accent-500)' }} />
                    ) : null}
                  </div>
                  <div style={{ minWidth: 0 }}>
                    <span
                      className="font-body font-semibold"
                      style={{
                        fontSize: 11,
                        color: isActive ? 'var(--color-accent-500)' : isDone ? 'var(--color-text-primary)' : 'var(--color-text-placeholder)',
                      }}
                    >
                      {ps.label}
                    </span>
                  </div>
                </div>
              </div>
            )
          })}
        </div>

        {/* Current stage description */}
        <p className="font-body" style={{ fontSize: 12, color: 'var(--color-text-secondary)', margin: 0 }}>
          {PIPELINE_STAGES[currentStageIdx]?.description ?? 'Processing…'}
        </p>
      </div>

      {/* ── Progress bar ───────────────────────────────────────────────── */}
      <div style={{ marginBottom: 20 }}>
        <div className="flex items-center justify-between" style={{ marginBottom: 6 }}>
          <span className="font-body font-semibold" style={{ fontSize: 12, color: 'var(--color-text-primary)' }}>
            {job.progressMessage ?? 'Processing…'}
          </span>
          <span className="font-body" style={{ fontSize: 12, color: 'var(--color-text-secondary)', fontVariantNumeric: 'tabular-nums' }}>
            {progressPct}%
          </span>
        </div>
        <div
          style={{
            width: '100%', height: 6,
            background: 'var(--color-bg-inset)', borderRadius: 3,
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              width: `${progressPct}%`, height: '100%',
              background: error ? '#ef4444' : 'var(--color-accent-500)',
              borderRadius: 3,
              transition: 'width 0.5s ease',
            }}
          />
        </div>
      </div>

      {/* ── Scope pills ────────────────────────────────────────────────── */}
      {(job.scopeNodeCount !== null || job.scopeEdgeCount !== null) && (
        <div className="flex flex-wrap gap-2" style={{ marginBottom: 20 }}>
          {job.scopeNodeCount !== null && (
            <span className="font-body" style={{ fontSize: 11, color: 'var(--color-text-secondary)', background: 'var(--color-bg-inset)', padding: '3px 10px', borderRadius: 20 }}>
              {job.scopeNodeCount} entities
            </span>
          )}
          {job.scopeEdgeCount !== null && (
            <span className="font-body" style={{ fontSize: 11, color: 'var(--color-text-secondary)', background: 'var(--color-bg-inset)', padding: '3px 10px', borderRadius: 20 }}>
              {job.scopeEdgeCount} relationships
            </span>
          )}
          <span className="font-body" style={{ fontSize: 11, color: 'var(--color-text-secondary)', background: 'var(--color-bg-inset)', padding: '3px 10px', borderRadius: 20 }}>
            {job.scopeTimeWindowDays}-day window
          </span>
        </div>
      )}

      {/* ── Round activity feed ────────────────────────────────────────── */}
      {roundLog.length > 0 && (
        <div
          style={{
            background: 'var(--color-bg-card)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 12,
            padding: '14px 18px',
            marginBottom: 20,
          }}
        >
          <div className="flex items-center justify-between" style={{ marginBottom: 10 }}>
            <span className="font-display" style={{ fontSize: 10, fontWeight: 700, color: 'var(--color-text-secondary)', letterSpacing: '0.08em' }}>
              ROUND ACTIVITY
            </span>
            <span className="font-body" style={{ fontSize: 11, color: 'var(--color-text-placeholder)' }}>
              Round {activeRound}
            </span>
          </div>
          <div className="flex flex-col gap-0">
            {roundLog.map((entry, i) => {
              const isLatest = i === roundLog.length - 1
              return (
                <div key={entry.round} className="flex items-start gap-3" style={{ position: 'relative' }}>
                  {/* Timeline line */}
                  {i < roundLog.length - 1 && (
                    <div
                      style={{
                        position: 'absolute', left: 9, top: 20, bottom: -4,
                        width: 1, background: 'rgba(0,0,0,0.08)',
                      }}
                    />
                  )}
                  {/* Icon */}
                  <div
                    style={{
                      width: 20, height: 20, borderRadius: 10, flexShrink: 0,
                      background: isLatest ? 'var(--color-accent-50)' : 'var(--color-bg-inset)',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      marginTop: 1,
                    }}
                  >
                    <RoundIcon label={entry.label} />
                  </div>
                  {/* Content */}
                  <div style={{ flex: 1, paddingBottom: 10 }}>
                    <div className="flex items-center gap-2">
                      <span
                        className="font-body font-semibold"
                        style={{
                          fontSize: 12,
                          color: isLatest ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
                        }}
                      >
                        Round {entry.round}: {entry.label}
                      </span>
                    </div>
                    <span className="font-body" style={{ fontSize: 11, color: 'var(--color-text-placeholder)' }}>
                      {entry.note}
                    </span>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* ── Stale warning ──────────────────────────────────────────────── */}
      {isStale && !error && (
        <div
          className="flex items-start gap-3"
          style={{
            padding: '10px 14px',
            background: '#fffbeb',
            border: '1px solid #fde68a',
            borderRadius: 10,
            marginBottom: 16,
          }}
        >
          <AlertTriangle size={14} style={{ color: '#d97706', flexShrink: 0, marginTop: 1 }} />
          <div>
            <span className="font-body font-semibold" style={{ fontSize: 12, color: '#92400e' }}>
              No progress update for {Math.floor((Date.now() - lastProgressTime) / 1000)}s
            </span>
            <p className="font-body" style={{ fontSize: 12, color: '#92400e', margin: '2px 0 0 0' }}>
              The simulation engine may be processing a large round, or it may have stalled. If this persists, try cancelling and re-running.
            </p>
          </div>
        </div>
      )}

      {/* ── Error display ──────────────────────────────────────────────── */}
      {error && (
        <div
          className="flex items-start gap-3"
          style={{
            padding: '10px 14px',
            background: '#fef2f2',
            border: '1px solid #fecaca',
            borderRadius: 10,
            marginBottom: 16,
          }}
        >
          <AlertTriangle size={14} style={{ color: '#ef4444', flexShrink: 0, marginTop: 1 }} />
          <div>
            <span className="font-body font-semibold" style={{ fontSize: 12, color: '#991b1b' }}>
              Error
            </span>
            <p className="font-body" style={{ fontSize: 12, color: '#991b1b', margin: '2px 0 0 0' }}>
              {error}
            </p>
          </div>
        </div>
      )}

      {/* ── Action buttons ──────────────────────────────────────────────── */}
      <div className="flex items-center justify-center gap-3" style={{ marginBottom: 16 }}>
        {onExit && (
          <button
            type="button"
            onClick={onExit}
            className="flex items-center gap-2 cursor-pointer font-body font-semibold"
            style={{
              fontSize: 12, padding: '8px 16px', borderRadius: 20,
              background: 'transparent',
              border: '1px solid var(--border-subtle)',
              color: 'var(--color-text-secondary)',
              transition: 'all 0.15s ease',
            }}
          >
            <ArrowLeft size={13} />
            Exit to builder
          </button>
        )}
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="flex items-center gap-2 cursor-pointer font-body font-semibold"
            style={{
              fontSize: 12, padding: '8px 16px', borderRadius: 20,
              background: 'transparent',
              border: '1px solid #fecaca',
              color: '#b91c1c',
              transition: 'all 0.15s ease',
            }}
          >
            <Square size={11} style={{ fill: '#b91c1c' }} />
            Stop simulation
          </button>
        )}
      </div>

      {/* ── Footer note ────────────────────────────────────────────────── */}
      {!error && (
        <p
          className="font-body"
          style={{
            fontSize: 11, color: 'var(--color-text-placeholder)',
            textAlign: 'center', margin: 0,
          }}
        >
          The simulation runs on a hosted engine. You can exit and check progress from the history panel.
        </p>
      )}
    </div>
  )
}
