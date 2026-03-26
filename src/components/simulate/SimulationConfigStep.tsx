import type { SimulationMode, SimulationDepth, SurpriseSensitivity } from '../../types/simulate'

interface SimulationConfigStepProps {
  mode: SimulationMode
  depth: SimulationDepth
  surpriseSensitivity: SurpriseSensitivity
  presetUsed: string | null
  onModeChange: (mode: SimulationMode) => void
  onDepthChange: (depth: SimulationDepth) => void
  onSurpriseSensitivityChange: (s: SurpriseSensitivity) => void
  onPresetSelect: (preset: string | null) => void
}

// ─── Mode definitions ─────────────────────────────────────────────────────────

interface ModeOption {
  value: SimulationMode
  label: string
  description: string
  bestFor: string
}

const MODES: ModeOption[] = [
  { value: 'prediction', label: 'Prediction', description: 'What is most likely to happen? Agents converge on probability-weighted outcomes.', bestFor: 'Decision support' },
  { value: 'hypothesis_test', label: 'Hypothesis Test', description: 'Stress-test a specific belief. Agents evaluate supporting and refuting evidence.', bestFor: 'Validating assumptions' },
  { value: 'contrarian_scan', label: 'Contrarian Scan', description: 'What is everyone getting wrong? Agents hunt for overlooked signals and minority positions.', bestFor: 'Blind spot discovery' },
  { value: 'optimisation', label: 'Optimisation', description: 'What should happen? Agents evaluate available courses of action.', bestFor: 'Strategic planning' },
  { value: 'consensus_mapping', label: 'Consensus Mapping', description: 'What does the evidence actually agree on? Agents resolve contradictions.', bestFor: 'Settling debates' },
]

// ─── Depth definitions ────────────────────────────────────────────────────────

interface DepthOption {
  value: SimulationDepth
  label: string
  rounds: string
  time: string
}

const DEPTHS: DepthOption[] = [
  { value: 'quick_scan', label: 'Quick Scan', rounds: '2–3', time: '~1 min' },
  { value: 'standard', label: 'Standard', rounds: '5–6', time: '~3 min' },
  { value: 'deep_dive', label: 'Deep Dive', rounds: '8–10', time: '~6 min' },
  { value: 'exhaustive', label: 'Exhaustive', rounds: '12–15', time: '~10 min' },
]

// ─── Sensitivity definitions ──────────────────────────────────────────────────

interface SensitivityOption {
  value: SurpriseSensitivity
  label: string
  description: string
}

const SENSITIVITIES: SensitivityOption[] = [
  { value: 'conservative', label: 'Conservative', description: 'High-confidence findings only. Surprises section will be short.' },
  { value: 'balanced', label: 'Balanced', description: 'Mix of confident forecasts and notable outlier signals.' },
  { value: 'expansive', label: 'Expansive', description: 'Actively surfaces weak signals and second-order effects. Report will be longer and more speculative.' },
]

// ─── Presets ──────────────────────────────────────────────────────────────────

interface Preset {
  name: string
  mode: SimulationMode
  depth: SimulationDepth
  sensitivity: SurpriseSensitivity
}

const PRESETS: Preset[] = [
  { name: 'Quick Read', mode: 'prediction', depth: 'quick_scan', sensitivity: 'conservative' },
  { name: 'Strategic Brief', mode: 'prediction', depth: 'standard', sensitivity: 'balanced' },
  { name: 'Stress Test', mode: 'hypothesis_test', depth: 'deep_dive', sensitivity: 'balanced' },
  { name: 'Blind Spot Hunt', mode: 'contrarian_scan', depth: 'deep_dive', sensitivity: 'expansive' },
  { name: 'Scenario Planning', mode: 'optimisation', depth: 'exhaustive', sensitivity: 'expansive' },
]

export function SimulationConfigStep({
  mode,
  depth,
  surpriseSensitivity,
  presetUsed,
  onModeChange,
  onDepthChange,
  onSurpriseSensitivityChange,
  onPresetSelect,
}: SimulationConfigStepProps) {

  const handlePreset = (preset: Preset) => {
    onModeChange(preset.mode)
    onDepthChange(preset.depth)
    onSurpriseSensitivityChange(preset.sensitivity)
    onPresetSelect(preset.name)
  }

  const handleModeChange = (m: SimulationMode) => {
    onModeChange(m)
    onPresetSelect(null)
  }

  const handleDepthChange = (d: SimulationDepth) => {
    onDepthChange(d)
    onPresetSelect(null)
  }

  const handleSensitivityChange = (s: SurpriseSensitivity) => {
    onSurpriseSensitivityChange(s)
    onPresetSelect(null)
  }

  return (
    <div>
      {/* Presets */}
      <div style={{ marginBottom: 24 }}>
        <div
          className="font-display"
          style={{ fontSize: 10, fontWeight: 700, color: 'var(--color-text-secondary)', letterSpacing: '0.08em', marginBottom: 8 }}
        >
          PRESETS
        </div>
        <div className="flex flex-wrap gap-2">
          {PRESETS.map(preset => {
            const isActive = presetUsed === preset.name
            return (
              <button
                key={preset.name}
                type="button"
                onClick={() => handlePreset(preset)}
                className="font-body font-semibold cursor-pointer"
                style={{
                  fontSize: 12,
                  padding: '5px 13px',
                  borderRadius: 20,
                  border: isActive
                    ? '1px solid rgba(214,58,0,0.15)'
                    : '1px solid var(--border-subtle)',
                  background: isActive ? 'var(--color-accent-50)' : 'transparent',
                  color: isActive ? 'var(--color-accent-500)' : 'var(--color-text-secondary)',
                  transition: 'all 0.15s ease',
                }}
              >
                {preset.name}
              </button>
            )
          })}
        </div>
      </div>

      {/* Simulation Mode */}
      <div style={{ marginBottom: 24 }}>
        <div
          className="font-display"
          style={{ fontSize: 10, fontWeight: 700, color: 'var(--color-text-secondary)', letterSpacing: '0.08em', marginBottom: 8 }}
        >
          SIMULATION MODE
        </div>
        <div className="grid grid-cols-1 gap-2">
          {MODES.map(m => {
            const isActive = m.value === mode
            return (
              <button
                key={m.value}
                type="button"
                onClick={() => handleModeChange(m.value)}
                className="text-left cursor-pointer"
                style={{
                  padding: '12px 16px',
                  borderRadius: 12,
                  border: isActive
                    ? '1px solid var(--color-accent-500)'
                    : '1px solid rgba(0,0,0,0.10)',
                  background: isActive ? 'var(--color-accent-50)' : 'white',
                  transition: 'all 0.15s ease',
                }}
              >
                <div className="flex items-center justify-between" style={{ marginBottom: 4 }}>
                  <span
                    className="font-body font-semibold"
                    style={{
                      fontSize: 13,
                      color: isActive ? 'var(--color-accent-500)' : 'var(--color-text-primary)',
                    }}
                  >
                    {m.label}
                  </span>
                  <span
                    className="font-body"
                    style={{
                      fontSize: 11,
                      color: 'var(--color-text-placeholder)',
                      background: 'var(--color-bg-inset)',
                      padding: '1px 8px',
                      borderRadius: 10,
                    }}
                  >
                    {m.bestFor}
                  </span>
                </div>
                <p className="font-body" style={{ fontSize: 12, color: 'var(--color-text-secondary)', margin: 0 }}>
                  {m.description}
                </p>
              </button>
            )
          })}
        </div>
      </div>

      {/* Simulation Depth */}
      <div style={{ marginBottom: 24 }}>
        <div
          className="font-display"
          style={{ fontSize: 10, fontWeight: 700, color: 'var(--color-text-secondary)', letterSpacing: '0.08em', marginBottom: 8 }}
        >
          SIMULATION DEPTH
        </div>
        <div
          style={{
            display: 'flex', alignItems: 'center', gap: 4,
            padding: 4, borderRadius: 20,
            background: 'var(--color-bg-inset)',
          }}
        >
          {DEPTHS.map(d => {
            const isActive = d.value === depth
            return (
              <button
                key={d.value}
                type="button"
                onClick={() => handleDepthChange(d.value)}
                className="font-body font-semibold cursor-pointer flex flex-col items-center"
                style={{
                  flex: 1,
                  padding: '6px 8px',
                  borderRadius: 16,
                  fontSize: 12,
                  border: 'none',
                  background: isActive ? 'white' : 'transparent',
                  color: isActive ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
                  boxShadow: isActive ? '0 1px 3px rgba(0,0,0,0.08)' : 'none',
                  transition: 'all 0.15s ease',
                }}
              >
                <span>{d.label}</span>
                <span style={{ fontSize: 10, fontWeight: 400, color: 'var(--color-text-placeholder)', marginTop: 1 }}>
                  {d.rounds} rounds · {d.time}
                </span>
              </button>
            )
          })}
        </div>
      </div>

      {/* Surprise Sensitivity */}
      <div>
        <div
          className="font-display"
          style={{ fontSize: 10, fontWeight: 700, color: 'var(--color-text-secondary)', letterSpacing: '0.08em', marginBottom: 8 }}
        >
          SURPRISE SENSITIVITY
        </div>
        <div
          style={{
            display: 'flex', alignItems: 'stretch', gap: 4,
            padding: 4, borderRadius: 20,
            background: 'var(--color-bg-inset)',
          }}
        >
          {SENSITIVITIES.map(s => {
            const isActive = s.value === surpriseSensitivity
            return (
              <button
                key={s.value}
                type="button"
                onClick={() => handleSensitivityChange(s.value)}
                className="font-body font-semibold cursor-pointer flex flex-col items-center text-center"
                style={{
                  flex: 1,
                  padding: '6px 10px',
                  borderRadius: 16,
                  fontSize: 12,
                  border: 'none',
                  background: isActive ? 'white' : 'transparent',
                  color: isActive ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
                  boxShadow: isActive ? '0 1px 3px rgba(0,0,0,0.08)' : 'none',
                  transition: 'all 0.15s ease',
                }}
              >
                <span>{s.label}</span>
                <span style={{ fontSize: 10, fontWeight: 400, color: 'var(--color-text-placeholder)', marginTop: 2, lineHeight: 1.3 }}>
                  {s.description}
                </span>
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}
