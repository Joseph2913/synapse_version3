import { Check } from 'lucide-react'
import type { SimulationStage } from '../../types/simulate'

interface PipelineStagesProps {
  currentStage: SimulationStage
  onStageClick?: (stage: SimulationStage) => void
}

const PIPELINE_STAGES: { key: SimulationStage; label: string }[] = [
  { key: 'awaiting_review', label: 'Agents' },
  { key: 'running_simulation', label: 'Simulation' },
  { key: 'generating_report', label: 'Report' },
  { key: 'complete', label: 'Done' },
]

function stageIndex(stage: SimulationStage): number {
  switch (stage) {
    case 'idle': return -1
    case 'generating_personas': return -1
    case 'awaiting_review': return 0
    case 'confirmed': return 0
    case 'running_simulation': return 1
    case 'generating_report': return 2
    case 'complete': return 3
    case 'failed': return -1
    default: return -1
  }
}

export function PipelineStages({ currentStage, onStageClick }: PipelineStagesProps) {
  const activeIndex = stageIndex(currentStage)

  if (activeIndex < 0) return null

  return (
    <div className="flex items-center justify-center gap-0" style={{ marginBottom: 20 }}>
      {PIPELINE_STAGES.map((stage, i) => {
        const isCompleted = i < activeIndex
        const isActive = i === activeIndex
        const isPending = i > activeIndex
        const isClickable = isCompleted && onStageClick

        return (
          <div key={stage.key} className="flex items-center">
            {i > 0 && (
              <div
                style={{
                  width: 48,
                  height: 2,
                  background: isCompleted
                    ? 'var(--color-accent-500)'
                    : 'rgba(0,0,0,0.08)',
                  transition: 'background 0.3s ease',
                }}
              />
            )}
            <button
              type="button"
              onClick={() => isClickable ? onStageClick(stage.key) : undefined}
              className="flex items-center gap-2"
              disabled={!isClickable}
              style={{
                background: 'none',
                border: 'none',
                padding: '4px 8px',
                cursor: isClickable ? 'pointer' : 'default',
              }}
            >
              {/* Dot / check */}
              <div
                style={{
                  width: 12,
                  height: 12,
                  borderRadius: 6,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  background: isCompleted
                    ? 'var(--color-text-secondary)'
                    : isActive
                      ? 'var(--color-accent-500)'
                      : 'transparent',
                  border: isPending ? '1.5px solid rgba(0,0,0,0.15)' : 'none',
                  animation: isActive ? 'pulse 2s ease-in-out infinite' : undefined,
                  transition: 'all 0.3s ease',
                }}
              >
                {isCompleted && <Check size={8} style={{ color: 'white' }} />}
              </div>

              {/* Label */}
              <span
                className="font-body font-semibold"
                style={{
                  fontSize: 12,
                  color: isCompleted
                    ? 'var(--color-text-secondary)'
                    : isActive
                      ? 'var(--color-accent-500)'
                      : 'var(--color-text-placeholder)',
                  transition: 'color 0.15s ease',
                }}
              >
                {stage.label}
              </span>
            </button>
          </div>
        )
      })}
    </div>
  )
}
