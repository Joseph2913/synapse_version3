import { useRef, useEffect, useState, useCallback } from 'react'
import { Plus, X, ChevronDown, ChevronRight } from 'lucide-react'
import { ExternalAgents } from './ExternalAgents'
import type { ExternalAgent } from '../../types/simulate'

interface PredictionInputProps {
  predictionQuestion: string
  whatIfVariables: string[]
  currentWhatIfInput: string
  externalAgents: ExternalAgent[]
  onQuestionChange: (q: string) => void
  onWhatIfAdd: (variable: string) => void
  onWhatIfRemove: (index: number) => void
  onWhatIfInputChange: (value: string) => void
  onExternalAgentsChange: (agents: ExternalAgent[]) => void
}

const EXAMPLE_QUESTIONS = [
  'Where is this field heading in 6 months?',
  'Which players are likely to make a major move?',
  'What risks could derail current momentum?',
]

// Question quality gate: checks for named entity and temporal reference
function assessQuestionQuality(question: string): string | null {
  const trimmed = question.trim()
  if (!trimmed || trimmed.length < 10) return null

  const words = trimmed.split(/\s+/)
  if (words.length < 5) return null

  // Check for named entity (capitalised word that isn't the first word or common starters)
  const commonStarters = new Set(['what', 'will', 'how', 'when', 'where', 'which', 'who', 'why', 'is', 'are', 'can', 'could', 'should', 'do', 'does', 'the', 'a', 'an', 'in', 'on', 'at', 'to', 'for', 'of', 'and', 'or', 'if', 'this', 'that'])
  const hasNamedEntity = words.some((w, i) => {
    if (i === 0) return false
    const clean = w.replace(/[^a-zA-Z]/g, '')
    if (!clean) return false
    const first = clean[0]
    if (!first) return false
    return first === first.toUpperCase() && first !== first.toLowerCase() && !commonStarters.has(clean.toLowerCase())
  })

  // Check for temporal reference
  const temporalPatterns = /\b(\d+\s*(days?|weeks?|months?|years?|quarters?)|Q[1-4]\s*\d{4}|\d{4}|next\s+(year|quarter|month)|within\s+\d|by\s+(end|mid|start)|short[- ]term|long[- ]term|near[- ]term|mid[- ]term|timeline|timeframe|forecast|horizon)\b/i
  const hasTemporalRef = temporalPatterns.test(trimmed)

  if (!hasNamedEntity && !hasTemporalRef) {
    return 'Strong questions name at least one entity and a timeframe. Example: "Will [entity] expand into [market] within 18 months?"'
  }
  if (!hasNamedEntity) {
    return 'Consider naming a specific entity for more targeted results. Example: "Will [entity] expand into [market] within 18 months?"'
  }
  if (!hasTemporalRef) {
    return 'Adding a timeframe helps ground the simulation. Example: "Will [entity] expand into [market] within 18 months?"'
  }

  return null
}

export function PredictionInput({
  predictionQuestion,
  whatIfVariables,
  currentWhatIfInput,
  externalAgents,
  onQuestionChange,
  onWhatIfAdd,
  onWhatIfRemove,
  onWhatIfInputChange,
  onExternalAgentsChange,
}: PredictionInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [qualityWarning, setQualityWarning] = useState<string | null>(null)
  const [agentsExpanded, setAgentsExpanded] = useState(false)

  // Auto-resize textarea
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(Math.max(el.scrollHeight, 80), 160)}px`
  }, [predictionQuestion])

  const handleQuestionBlur = useCallback(() => {
    const warning = assessQuestionQuality(predictionQuestion)
    setQualityWarning(warning)
  }, [predictionQuestion])

  const handleWhatIfKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && currentWhatIfInput.trim() && whatIfVariables.length < 5) {
      e.preventDefault()
      onWhatIfAdd(currentWhatIfInput.trim())
      onWhatIfInputChange('')
    }
  }

  const handleAddClick = () => {
    if (currentWhatIfInput.trim() && whatIfVariables.length < 5) {
      onWhatIfAdd(currentWhatIfInput.trim())
      onWhatIfInputChange('')
    }
  }

  return (
    <div>
      {/* Prediction question section */}
      <div
        className="font-display"
        style={{ fontSize: 10, fontWeight: 700, color: 'var(--color-text-secondary)', letterSpacing: '0.08em', marginBottom: 8 }}
      >
        PREDICTION QUESTION
      </div>
      <textarea
        ref={textareaRef}
        value={predictionQuestion}
        onChange={e => {
          onQuestionChange(e.target.value)
          if (qualityWarning) setQualityWarning(null)
        }}
        onBlur={handleQuestionBlur}
        placeholder="What do you want to predict or explore?"
        className="font-body w-full resize-none"
        style={{
          fontSize: 15,
          color: 'var(--color-text-primary)',
          background: 'var(--color-bg-inset)',
          border: '1px solid rgba(0,0,0,0.10)',
          borderRadius: 12,
          padding: '12px 14px',
          minHeight: 80,
          maxHeight: 160,
          outline: 'none',
          transition: 'border-color 0.15s ease, box-shadow 0.15s ease',
        }}
        onFocus={e => {
          e.currentTarget.style.borderColor = 'var(--color-accent-500)'
          e.currentTarget.style.boxShadow = '0 0 0 2px rgba(214,58,0,0.30)'
        }}
      />

      {/* Question quality warning */}
      {qualityWarning && (
        <p className="font-body" style={{ fontSize: 12, color: '#b45309', margin: '6px 0 0 0' }}>
          {qualityWarning}
        </p>
      )}

      {/* Example questions */}
      {!predictionQuestion && (
        <div className="flex flex-wrap gap-2" style={{ marginTop: 8 }}>
          {EXAMPLE_QUESTIONS.map(q => (
            <button
              key={q}
              type="button"
              onClick={() => onQuestionChange(q)}
              className="font-body cursor-pointer"
              style={{
                fontSize: 12,
                color: 'var(--color-text-placeholder)',
                background: 'transparent',
                border: '1px dashed rgba(0,0,0,0.10)',
                borderRadius: 20,
                padding: '4px 12px',
                transition: 'all 0.15s ease',
              }}
              onMouseEnter={e => {
                e.currentTarget.style.borderColor = 'var(--color-accent-500)'
                e.currentTarget.style.color = 'var(--color-accent-500)'
              }}
              onMouseLeave={e => {
                e.currentTarget.style.borderColor = 'rgba(0,0,0,0.10)'
                e.currentTarget.style.color = 'var(--color-text-placeholder)'
              }}
            >
              {q}
            </button>
          ))}
        </div>
      )}

      {/* What-if variables — renamed "Environmental conditions" */}
      <div style={{ marginTop: 20 }}>
        <div className="flex items-center gap-2" style={{ marginBottom: 6 }}>
          <span
            className="font-display"
            style={{ fontSize: 10, fontWeight: 700, color: 'var(--color-text-secondary)', letterSpacing: '0.08em' }}
          >
            ENVIRONMENTAL CONDITIONS
          </span>
          <span className="font-body" style={{ fontSize: 11, color: 'var(--color-text-placeholder)' }}>
            (optional)
          </span>
        </div>
        <p className="font-body" style={{ fontSize: 12, color: 'var(--color-text-secondary)', margin: '0 0 8px 0' }}>
          Inject assumptions into the simulation as established facts
        </p>

        {/* Input row */}
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={currentWhatIfInput}
            onChange={e => onWhatIfInputChange(e.target.value)}
            onKeyDown={handleWhatIfKeyDown}
            placeholder="e.g. Assume GPT-5 launches in Q2 2026"
            disabled={whatIfVariables.length >= 5}
            className="font-body flex-1"
            style={{
              fontSize: 13,
              color: 'var(--color-text-primary)',
              background: 'var(--color-bg-inset)',
              border: '1px solid rgba(0,0,0,0.10)',
              borderRadius: 20,
              padding: '6px 14px',
              outline: 'none',
            }}
          />
          <button
            type="button"
            onClick={handleAddClick}
            disabled={!currentWhatIfInput.trim() || whatIfVariables.length >= 5}
            className="flex items-center justify-center cursor-pointer"
            style={{
              width: 30, height: 30, borderRadius: 15,
              background: currentWhatIfInput.trim() ? 'var(--color-accent-500)' : 'var(--color-bg-inset)',
              border: 'none',
              color: currentWhatIfInput.trim() ? 'white' : 'var(--color-text-secondary)',
              transition: 'all 0.15s ease',
              opacity: whatIfVariables.length >= 5 ? 0.4 : 1,
            }}
          >
            <Plus size={14} />
          </button>
        </div>

        {/* Variable pills */}
        {whatIfVariables.length > 0 && (
          <div className="flex flex-wrap gap-2" style={{ marginTop: 8 }}>
            {whatIfVariables.map((v, i) => (
              <span
                key={i}
                className="font-body flex items-center gap-1"
                style={{
                  fontSize: 12,
                  color: 'var(--color-text-body)',
                  background: 'var(--color-bg-inset)',
                  border: '1px solid rgba(0,0,0,0.10)',
                  borderRadius: 20,
                  padding: '4px 10px',
                }}
              >
                {v}
                <button
                  type="button"
                  onClick={() => onWhatIfRemove(i)}
                  className="cursor-pointer flex items-center justify-center"
                  style={{
                    background: 'none', border: 'none',
                    color: 'var(--color-text-secondary)',
                    padding: 0, marginLeft: 2,
                  }}
                >
                  <X size={12} />
                </button>
              </span>
            ))}
          </div>
        )}

        {whatIfVariables.length >= 5 && (
          <p className="font-body" style={{ fontSize: 11, color: 'var(--color-text-placeholder)', marginTop: 4 }}>
            Maximum 5 conditions reached
          </p>
        )}
      </div>

      {/* External agents — collapsible */}
      <div style={{ marginTop: 20 }}>
        <button
          type="button"
          onClick={() => setAgentsExpanded(prev => !prev)}
          className="flex items-center gap-2 cursor-pointer"
          style={{ background: 'none', border: 'none', padding: 0 }}
        >
          {agentsExpanded
            ? <ChevronDown size={14} style={{ color: 'var(--color-text-secondary)' }} />
            : <ChevronRight size={14} style={{ color: 'var(--color-text-secondary)' }} />
          }
          <span
            className="font-display"
            style={{ fontSize: 10, fontWeight: 700, color: 'var(--color-text-secondary)', letterSpacing: '0.08em' }}
          >
            ADD EXTERNAL PARTICIPANTS
          </span>
          <span className="font-body" style={{ fontSize: 11, color: 'var(--color-text-placeholder)' }}>
            (optional)
          </span>
          {externalAgents.length > 0 && (
            <span
              className="font-body font-semibold"
              style={{
                fontSize: 11, color: 'var(--color-accent-500)',
                background: 'var(--color-accent-50)',
                padding: '1px 8px', borderRadius: 10,
              }}
            >
              {externalAgents.length}
            </span>
          )}
        </button>
        {agentsExpanded && (
          <div style={{ marginTop: 10 }}>
            <ExternalAgents
              agents={externalAgents}
              onChange={onExternalAgentsChange}
            />
          </div>
        )}
      </div>
    </div>
  )
}
