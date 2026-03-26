import { useState } from 'react'
import { Play, AlertTriangle, FlaskConical } from 'lucide-react'
import type { SimulationBuilderState, SimulationSeedGraph } from '../../types/simulate'

interface ConfigSummaryProps {
  builderState: SimulationBuilderState
  seedGraph: SimulationSeedGraph | null
  anchorLabels: Record<string, string>
  sidecarOnline: boolean
  onRun: () => void
}

const MODE_LABELS: Record<string, string> = {
  prediction: 'Prediction',
  hypothesis_test: 'Hypothesis Test',
  contrarian_scan: 'Contrarian Scan',
  optimisation: 'Optimisation',
  consensus_mapping: 'Consensus Mapping',
}

const DEPTH_LABELS: Record<string, string> = {
  quick_scan: 'Quick Scan',
  standard: 'Standard',
  deep_dive: 'Deep Dive',
  exhaustive: 'Exhaustive',
}

const SENSITIVITY_LABELS: Record<string, string> = {
  conservative: 'Conservative',
  balanced: 'Balanced',
  expansive: 'Expansive',
}

const SENSITIVITY_DESCRIPTIONS: Record<string, string> = {
  conservative: 'high-confidence findings only',
  balanced: 'mix of confident and outlier signals',
  expansive: 'actively surfacing weak signals',
}

const HORIZON_LABELS: Record<string, string> = {
  '30d': '30 days',
  '90d': '90 days',
  '6m': '6 months',
  '1y': '1 year',
  '2y+': '2+ years',
}

export function ConfigSummary({
  builderState,
  seedGraph,
  anchorLabels,
  sidecarOnline,
  onRun,
}: ConfigSummaryProps) {
  const [questionExpanded, setQuestionExpanded] = useState(false)

  const canRun = sidecarOnline &&
    builderState.selectedAnchorIds.length > 0 &&
    builderState.predictionQuestion.trim().length > 0

  // Derive agent count from seed graph
  const agentNodes = seedGraph?.nodes.filter(n =>
    ['Person', 'Organization', 'Team'].includes(n.entityType)
  ) ?? []
  const agentCount = agentNodes.length + builderState.externalAgents.length
  const sourceCount = seedGraph ? [...new Set(seedGraph.nodes.map(n => n.sourceId).filter(Boolean))].length : 0
  const chunkCount = seedGraph?.sourceChunks.length ?? 0

  // Low diversity check
  const distinctSources = sourceCount
  const lowDiversity = distinctSources < 3

  // Disabled reason
  let disabledReason: string | null = null
  if (!sidecarOnline) disabledReason = 'Simulation engine offline. Start the local sidecar to run.'
  else if (builderState.selectedAnchorIds.length === 0) disabledReason = 'Select at least one anchor.'
  else if (!builderState.predictionQuestion.trim()) disabledReason = 'Enter a prediction question.'

  // Natural language summary
  const nlSummary = `Running a ${MODE_LABELS[builderState.mode]} at ${DEPTH_LABELS[builderState.depth]} depth — ${SENSITIVITY_DESCRIPTIONS[builderState.surpriseSensitivity]}.`

  // Question display
  const questionTruncated = builderState.predictionQuestion.length > 140 && !questionExpanded
  const questionText = questionTruncated
    ? builderState.predictionQuestion.slice(0, 140) + '…'
    : builderState.predictionQuestion

  // Source type filter display
  const sourceFilterDisplay = builderState.sourceTypeFilter === null
    ? 'All'
    : builderState.sourceTypeFilter.map(t => t.charAt(0).toUpperCase() + t.slice(1)).join(', ')

  return (
    <div
      style={{
        padding: '16px 22px',
        borderRadius: 12,
        background: 'var(--color-bg-inset)',
        border: '1px solid rgba(0,0,0,0.06)',
      }}
    >
      {/* NL summary */}
      <p className="font-body" style={{ fontSize: 13, color: 'var(--color-text-primary)', margin: '0 0 16px 0', fontWeight: 500 }}>
        {nlSummary}
      </p>

      {/* Scope section */}
      <div style={{ marginBottom: 14 }}>
        <div
          className="font-display"
          style={{ fontSize: 10, fontWeight: 700, color: 'var(--color-text-secondary)', letterSpacing: '0.08em', marginBottom: 6 }}
        >
          SCOPE
        </div>
        <div className="font-body flex flex-wrap gap-x-4 gap-y-1" style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
          <span>
            <strong style={{ color: 'var(--color-text-primary)' }}>Anchors:</strong>{' '}
            {builderState.selectedAnchorIds.map(id => anchorLabels[id] ?? id.slice(0, 8)).join(', ')}
          </span>
          <span>
            <strong style={{ color: 'var(--color-text-primary)' }}>Time window:</strong>{' '}
            {builderState.timeWindowDays === 3650 ? 'All time' : `${builderState.timeWindowDays} days`}
          </span>
          <span>
            <strong style={{ color: 'var(--color-text-primary)' }}>Sources:</strong>{' '}
            {sourceFilterDisplay}
          </span>
          <span>
            <strong style={{ color: 'var(--color-text-primary)' }}>Horizon:</strong>{' '}
            {HORIZON_LABELS[builderState.outputHorizon]}
          </span>
        </div>
      </div>

      {/* Question */}
      <div style={{ marginBottom: 14 }}>
        <div
          className="font-display"
          style={{ fontSize: 10, fontWeight: 700, color: 'var(--color-text-secondary)', letterSpacing: '0.08em', marginBottom: 6 }}
        >
          QUESTION
        </div>
        <p className="font-body" style={{ fontSize: 13, color: 'var(--color-text-primary)', margin: 0, lineHeight: 1.5 }}>
          {questionText}
          {builderState.predictionQuestion.length > 140 && (
            <button
              type="button"
              onClick={() => setQuestionExpanded(prev => !prev)}
              className="cursor-pointer font-body"
              style={{
                background: 'none', border: 'none',
                color: 'var(--color-accent-500)',
                fontSize: 12, padding: '0 0 0 4px',
              }}
            >
              {questionExpanded ? 'Show less' : 'Show more'}
            </button>
          )}
        </p>
      </div>

      {/* What-if conditions */}
      {builderState.whatIfVariables.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          <div
            className="font-display"
            style={{ fontSize: 10, fontWeight: 700, color: 'var(--color-text-secondary)', letterSpacing: '0.08em', marginBottom: 6 }}
          >
            CONDITIONS
          </div>
          <div className="flex flex-wrap gap-2">
            {builderState.whatIfVariables.map((v, i) => (
              <span
                key={i}
                className="font-body"
                style={{
                  fontSize: 12,
                  color: 'var(--color-text-body)',
                  background: 'white',
                  border: '1px solid rgba(0,0,0,0.10)',
                  borderRadius: 20,
                  padding: '3px 10px',
                }}
              >
                {v}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* External agents */}
      {builderState.externalAgents.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          <div
            className="font-display"
            style={{ fontSize: 10, fontWeight: 700, color: 'var(--color-text-secondary)', letterSpacing: '0.08em', marginBottom: 6 }}
          >
            EXTERNAL AGENTS
          </div>
          <div className="flex flex-col gap-1">
            {builderState.externalAgents.map((agent, i) => (
              <div key={i} className="font-body flex items-center gap-2" style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
                <FlaskConical size={10} style={{ color: '#7c3aed' }} />
                <span style={{ color: 'var(--color-text-primary)', fontWeight: 500 }}>{agent.label}</span>
                <span>({agent.entity_type})</span>
                <span>— {agent.known_position}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Configuration badges */}
      <div style={{ marginBottom: 14 }}>
        <div
          className="font-display"
          style={{ fontSize: 10, fontWeight: 700, color: 'var(--color-text-secondary)', letterSpacing: '0.08em', marginBottom: 6 }}
        >
          CONFIGURATION
        </div>
        <div className="flex flex-wrap gap-2">
          <Badge label="Mode" value={MODE_LABELS[builderState.mode] ?? builderState.mode} />
          <Badge label="Depth" value={DEPTH_LABELS[builderState.depth] ?? builderState.depth} />
          <Badge label="Sensitivity" value={SENSITIVITY_LABELS[builderState.surpriseSensitivity] ?? builderState.surpriseSensitivity} />
        </div>
      </div>

      {/* Grounding quality summary */}
      <div
        className="font-body flex flex-wrap gap-2"
        style={{
          fontSize: 12, color: 'var(--color-text-secondary)',
          padding: '8px 12px', borderRadius: 20,
          background: 'white', border: '1px solid rgba(0,0,0,0.06)',
          marginBottom: 14,
        }}
      >
        <span>{agentCount} agents</span>
        <span>·</span>
        <span>{sourceCount} sources</span>
        <span>·</span>
        <span>{chunkCount} chunks</span>
      </div>

      {/* Low diversity warning */}
      {lowDiversity && seedGraph && (
        <div className="flex items-center gap-2" style={{ marginBottom: 14 }}>
          <AlertTriangle size={13} style={{ color: '#d97706', flexShrink: 0 }} />
          <span className="font-body" style={{ fontSize: 12, color: '#b45309' }}>
            Low source diversity may limit emergence.
          </span>
        </div>
      )}

      {/* No agents warning */}
      {agentCount === 0 && seedGraph && (
        <div className="flex items-center gap-2" style={{ marginBottom: 14 }}>
          <AlertTriangle size={13} style={{ color: '#d97706', flexShrink: 0 }} />
          <span className="font-body" style={{ fontSize: 12, color: '#b45309' }}>
            No eligible agents found in scope. Simulation will use synthetic personas only.
          </span>
        </div>
      )}

      {/* Run button */}
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onRun}
          disabled={!canRun}
          className="flex items-center gap-2 cursor-pointer font-body font-semibold"
          style={{
            fontSize: 13, padding: '10px 24px', borderRadius: 20,
            background: canRun ? 'var(--color-accent-500)' : 'var(--color-bg-inset)',
            border: 'none',
            color: canRun ? 'white' : 'var(--color-text-placeholder)',
            transition: 'all 0.15s ease',
            opacity: canRun ? 1 : 0.6,
          }}
        >
          <Play size={14} />
          Run Simulation
        </button>
        {disabledReason && (
          <span className="font-body" style={{ fontSize: 12, color: '#b45309' }}>
            {disabledReason}
          </span>
        )}
      </div>
    </div>
  )
}

function Badge({ label, value }: { label: string; value: string }) {
  return (
    <span
      className="font-body"
      style={{
        fontSize: 12,
        background: 'white',
        border: '1px solid rgba(0,0,0,0.10)',
        borderRadius: 20,
        padding: '3px 10px',
      }}
    >
      <span style={{ color: 'var(--color-text-placeholder)' }}>{label}: </span>
      <span style={{ color: 'var(--color-text-primary)', fontWeight: 500 }}>{value}</span>
    </span>
  )
}
