import { useState, useCallback, useRef, useEffect } from 'react'
import { GripVertical, FlaskConical, AlertCircle, CheckCircle2, RefreshCw, ChevronDown, ChevronRight, ChevronLeft, Copy, Check, Loader2 } from 'lucide-react'
import { useSimulate } from '../hooks/useSimulate'
import { useSimulationJobs } from '../hooks/useSimulationJobs'
import { buildSeedGraph } from '../services/simulate'
import { ScopeSelector } from '../components/simulate/ScopeSelector'
import { PredictionInput } from '../components/simulate/PredictionInput'
import { PersonaPreview } from '../components/simulate/PersonaPreview'
import { SimulationConfigStep } from '../components/simulate/SimulationConfigStep'
import { ConfigSummary } from '../components/simulate/ConfigSummary'
import { SimulationRunner } from '../components/simulate/SimulationRunner'
import { SimulationReport } from '../components/simulate/SimulationReport'
import { SimulationHistoryPanel } from '../components/simulate/SimulationHistoryPanel'
import { SimulationDetailPanel } from '../components/simulate/SimulationDetailPanel'
import { PipelineStages } from '../components/simulate/PipelineStages'
import { AgentReview } from '../components/simulate/AgentReview'
import type { SimulationBuilderState, SimulationSeedGraph, SimulationJob, SourceTypeFilter, OutputHorizon, SimulationMode, SimulationDepth, SurpriseSensitivity, ExternalAgent } from '../types/simulate'

// ─── Layout constants ────────────────────────────────────────────────────────
const DEFAULT_LEFT_PCT = 64
const MIN_LEFT_PCT = 30
const MAX_LEFT_PCT = 80

// ─── Wizard steps ────────────────────────────────────────────────────────────
const WIZARD_STEPS = [
  { key: 'scope', label: 'Scope' },
  { key: 'question', label: 'Question' },
  { key: 'config', label: 'Configuration' },
] as const

type WizardStep = typeof WIZARD_STEPS[number]['key']

// ─── Step indicator ──────────────────────────────────────────────────────────
function StepIndicator({ currentStep, onStepClick }: { currentStep: WizardStep; onStepClick: (step: WizardStep) => void }) {
  const currentIndex = WIZARD_STEPS.findIndex(s => s.key === currentStep)
  return (
    <div className="flex items-center justify-center gap-0" style={{ marginBottom: 24 }}>
      {WIZARD_STEPS.map((step, i) => {
        const isActive = step.key === currentStep
        const isCompleted = i < currentIndex
        const isClickable = i <= currentIndex
        return (
          <div key={step.key} className="flex items-center">
            {i > 0 && (
              <div
                style={{
                  width: 40,
                  height: 2,
                  background: isCompleted ? 'var(--color-accent-500)' : 'rgba(0,0,0,0.10)',
                  transition: 'background 0.15s ease',
                }}
              />
            )}
            <button
              type="button"
              onClick={() => isClickable ? onStepClick(step.key) : undefined}
              className="flex items-center gap-2 cursor-pointer"
              disabled={!isClickable}
              style={{ background: 'none', border: 'none', padding: '4px 8px', opacity: isClickable ? 1 : 0.5 }}
            >
              <div
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: 5,
                  background: isActive
                    ? 'var(--color-accent-500)'
                    : isCompleted
                      ? 'var(--color-text-secondary)'
                      : 'transparent',
                  border: isActive || isCompleted
                    ? 'none'
                    : '1.5px solid rgba(0,0,0,0.20)',
                  transition: 'all 0.15s ease',
                }}
              />
              <span
                className="font-body font-semibold"
                style={{
                  fontSize: 12,
                  color: isActive
                    ? 'var(--color-accent-500)'
                    : isCompleted
                      ? 'var(--color-text-secondary)'
                      : 'var(--color-text-placeholder)',
                }}
              >
                {step.label}
              </span>
            </button>
          </div>
        )
      })}
    </div>
  )
}

// ─── Failed state with error details + debug panel ──────────────────────────
function FailedState({ error, activeJob, onReset }: {
  error: string | null
  activeJob: SimulationJob | null
  onReset: () => void
}) {
  const [debugOpen, setDebugOpen] = useState(false)
  const [copied, setCopied] = useState(false)

  const displayError = activeJob?.errorMessage || error
  const errorText = displayError || 'An unexpected error occurred. Check the sidecar terminal for details.'

  const handleCopyJobId = useCallback(async () => {
    if (!activeJob?.id) return
    await navigator.clipboard.writeText(activeJob.id)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }, [activeJob?.id])

  return (
    <div
      className="flex flex-col items-center justify-center"
      style={{ flex: 1, padding: 48, textAlign: 'center' }}
    >
      <AlertCircle size={48} style={{ color: '#ef4444', marginBottom: 16 }} />
      <h2
        className="font-display"
        style={{ fontSize: 18, fontWeight: 700, color: 'var(--color-text-primary)', margin: '0 0 8px 0' }}
      >
        Simulation Failed
      </h2>
      <p
        className="font-body"
        style={{
          fontSize: 13, color: 'var(--color-text-secondary)',
          fontStyle: 'italic', margin: '0 0 20px 0', maxWidth: 480,
        }}
      >
        {errorText}
      </p>

      {activeJob && (
        <div style={{ width: '100%', maxWidth: 480, marginBottom: 20 }}>
          <button
            type="button"
            onClick={() => setDebugOpen(o => !o)}
            className="flex items-center gap-1 cursor-pointer font-body"
            style={{
              fontSize: 12, color: 'var(--color-text-secondary)',
              background: 'none', border: 'none', padding: '4px 0',
            }}
          >
            {debugOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            Debug info
          </button>
          {debugOpen && (
            <div
              style={{
                background: 'var(--color-bg-inset)',
                borderRadius: 8,
                padding: '12px 16px',
                marginTop: 4,
                textAlign: 'left',
                fontFamily: 'monospace',
                fontSize: 11,
                color: 'var(--color-text-secondary)',
                lineHeight: 1.7,
              }}
            >
              <div className="flex items-center gap-2">
                <span>Job ID: {activeJob.id}</span>
                <button
                  type="button"
                  onClick={handleCopyJobId}
                  className="flex items-center cursor-pointer"
                  title="Copy Job ID"
                  style={{
                    background: 'none', border: 'none', padding: 2,
                    color: 'var(--color-text-secondary)',
                  }}
                >
                  {copied ? <Check size={11} style={{ color: '#22c55e' }} /> : <Copy size={11} />}
                </button>
              </div>
              <div>Progress: {activeJob.progress}%</div>
              {activeJob.progressMessage && <div>Last message: {activeJob.progressMessage}</div>}
              <div>Failed at: {activeJob.completedAt ? new Date(activeJob.completedAt).toLocaleString() : new Date().toLocaleString()}</div>
            </div>
          )}
        </div>
      )}

      <button
        type="button"
        onClick={onReset}
        className="flex items-center gap-2 cursor-pointer font-body font-semibold"
        style={{
          fontSize: 13, padding: '10px 20px', borderRadius: 20,
          background: 'var(--color-accent-500)', border: 'none',
          color: 'white',
        }}
      >
        Try Again
      </button>
    </div>
  )
}

// ─── Generating personas loading state ──────────────────────────────────────
function GeneratingPersonasState({ progress }: { progress: { current: number; total: number; currentLabel: string; phase: string } | null }) {
  const pct = progress && progress.total > 0
    ? Math.round((progress.current / progress.total) * 100)
    : 0
  const phaseLabel = progress?.phase === 'evidence'
    ? 'Extracting evidence'
    : progress?.phase === 'synthesis'
      ? 'Building profile'
      : progress?.phase === 'scoring'
        ? 'Scoring diversity'
        : 'Preparing'

  return (
    <div
      className="flex flex-col items-center justify-center"
      style={{ flex: 1, padding: 48, textAlign: 'center' }}
    >
      <div
        style={{
          width: 64, height: 64, borderRadius: 32,
          background: 'var(--color-accent-50)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          marginBottom: 24,
        }}
      >
        <Loader2
          size={24}
          style={{
            color: 'var(--color-accent-500)',
            animation: 'spin 1.2s linear infinite',
          }}
        />
      </div>
      <h2
        className="font-display"
        style={{ fontSize: 18, fontWeight: 700, color: 'var(--color-text-primary)', margin: '0 0 8px 0' }}
      >
        Generating agent profiles…
      </h2>

      {/* Progress details */}
      {progress && progress.total > 0 ? (
        <>
          {/* Progress bar */}
          <div
            style={{
              width: '100%', maxWidth: 360, height: 4,
              background: 'var(--color-bg-inset)', borderRadius: 2,
              marginTop: 16, overflow: 'hidden',
            }}
          >
            <div
              style={{
                width: `${pct}%`, height: '100%',
                background: 'var(--color-accent-500)',
                borderRadius: 2,
                transition: 'width 0.3s ease',
              }}
            />
          </div>

          {/* Counter */}
          <p
            className="font-body font-semibold"
            style={{ fontSize: 13, color: 'var(--color-text-primary)', margin: '10px 0 0 0' }}
          >
            {progress.current} of {progress.total} agents
          </p>

          {/* Current agent + phase */}
          <p
            className="font-body"
            style={{ fontSize: 12, color: 'var(--color-text-secondary)', margin: '4px 0 0 0' }}
          >
            {phaseLabel}: <span style={{ color: 'var(--color-text-primary)' }}>{progress.currentLabel}</span>
          </p>
        </>
      ) : (
        <p
          className="font-body"
          style={{ fontSize: 13, color: 'var(--color-text-secondary)', maxWidth: 400 }}
        >
          Building seed graph and identifying eligible agents…
        </p>
      )}
    </div>
  )
}

// ─── Default builder state ───────────────────────────────────────────────────
const DEFAULT_BUILDER_STATE: SimulationBuilderState = {
  selectedAnchorIds: [],
  timeWindowDays: 90,
  predictionQuestion: '',
  whatIfVariables: [],
  excludedNodeIds: [],
  currentWhatIfInput: '',
  sourceTypeFilter: null,
  outputHorizon: '90d',
  externalAgents: [],
  mode: 'prediction',
  depth: 'standard',
  surpriseSensitivity: 'balanced',
  presetUsed: null,
}

export function SimulateView() {
  const {
    stage, activeJob, sidecarOnline, isCheckingSidecar, error,
    personas, diversity, excludedAgentIds, personaProgress,
    activeRound, roundLog,
    checkSidecar, startPersonaGeneration, confirmAndRun, resumeJob,
    cancelSimulation, exitSimulation,
    toggleAgentExclusion, backToSetup, resetBuilder,
    setStage, setActiveJob,
  } = useSimulate()

  const { jobs, loading: jobsLoading } = useSimulationJobs()

  // Builder state
  const [builderState, setBuilderState] = useState<SimulationBuilderState>({ ...DEFAULT_BUILDER_STATE })

  // Wizard step
  const [wizardStep, setWizardStep] = useState<WizardStep>('scope')

  // Anchor labels for ConfigSummary — populated by ScopeSelector if it exposes a callback
  const [anchorLabels] = useState<Record<string, string>>({})

  const [selectedHistoryJobId, setSelectedHistoryJobId] = useState<string | null>(null)
  const [previewSeedGraph, setPreviewSeedGraph] = useState<SimulationSeedGraph | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)

  // Check sidecar on mount
  useEffect(() => {
    checkSidecar()
  }, [checkSidecar])

  // Load preview seed graph when anchors change
  useEffect(() => {
    if (builderState.selectedAnchorIds.length === 0) {
      setPreviewSeedGraph(null)
      return
    }
    let cancelled = false
    async function loadPreview() {
      setPreviewLoading(true)
      try {
        const graph = await buildSeedGraph(
          builderState.selectedAnchorIds,
          builderState.timeWindowDays,
          builderState.excludedNodeIds,
          builderState.sourceTypeFilter
        )
        if (!cancelled) setPreviewSeedGraph(graph)
      } catch {
        // Non-critical — preview can fail silently
      } finally {
        if (!cancelled) setPreviewLoading(false)
      }
    }
    loadPreview()
    return () => { cancelled = true }
  }, [builderState.selectedAnchorIds, builderState.timeWindowDays, builderState.excludedNodeIds, builderState.sourceTypeFilter])

  // Detect active running job on mount
  useEffect(() => {
    const runningJob = jobs.find(j => j.status === 'running' || j.status === 'preparing')
    if (runningJob && stage === 'idle') {
      setActiveJob(runningJob)
      setStage('running_simulation')
    }
  }, [jobs, stage, setActiveJob, setStage])

  // Watch for active job completion via realtime
  useEffect(() => {
    if (!activeJob) return
    const updated = jobs.find(j => j.id === activeJob.id)
    if (updated) {
      setActiveJob(updated)
      if (updated.status === 'completed') setStage('complete')
      if (updated.status === 'failed') setStage('failed')
    }
  }, [jobs, activeJob, setActiveJob, setStage])

  // ─── Builder state handlers ─────────────────────────────────────────

  const handleAnchorToggle = useCallback((id: string) => {
    setBuilderState(prev => ({
      ...prev,
      selectedAnchorIds: prev.selectedAnchorIds.includes(id)
        ? prev.selectedAnchorIds.filter(a => a !== id)
        : [...prev.selectedAnchorIds, id],
    }))
  }, [])

  const handleTimeWindowChange = useCallback((days: number) => {
    setBuilderState(prev => ({ ...prev, timeWindowDays: days }))
  }, [])

  const handleSourceTypeFilterChange = useCallback((filter: SourceTypeFilter[] | null) => {
    setBuilderState(prev => ({ ...prev, sourceTypeFilter: filter }))
  }, [])

  const handleOutputHorizonChange = useCallback((horizon: OutputHorizon) => {
    setBuilderState(prev => ({ ...prev, outputHorizon: horizon }))
  }, [])

  const handleQuestionChange = useCallback((q: string) => {
    setBuilderState(prev => ({ ...prev, predictionQuestion: q }))
  }, [])

  const handleWhatIfAdd = useCallback((variable: string) => {
    setBuilderState(prev => ({ ...prev, whatIfVariables: [...prev.whatIfVariables, variable] }))
  }, [])

  const handleWhatIfRemove = useCallback((index: number) => {
    setBuilderState(prev => ({ ...prev, whatIfVariables: prev.whatIfVariables.filter((_, i) => i !== index) }))
  }, [])

  const handleWhatIfInputChange = useCallback((value: string) => {
    setBuilderState(prev => ({ ...prev, currentWhatIfInput: value }))
  }, [])

  const handleExternalAgentsChange = useCallback((agents: ExternalAgent[]) => {
    setBuilderState(prev => ({ ...prev, externalAgents: agents }))
  }, [])

  const handleModeChange = useCallback((mode: SimulationMode) => {
    setBuilderState(prev => ({ ...prev, mode }))
  }, [])

  const handleDepthChange = useCallback((depth: SimulationDepth) => {
    setBuilderState(prev => ({ ...prev, depth }))
  }, [])

  const handleSurpriseSensitivityChange = useCallback((surpriseSensitivity: SurpriseSensitivity) => {
    setBuilderState(prev => ({ ...prev, surpriseSensitivity }))
  }, [])

  const handlePresetSelect = useCallback((presetUsed: string | null) => {
    setBuilderState(prev => ({ ...prev, presetUsed }))
  }, [])

  const handleExcludeToggle = useCallback((nodeId: string) => {
    setBuilderState(prev => ({
      ...prev,
      excludedNodeIds: prev.excludedNodeIds.includes(nodeId)
        ? prev.excludedNodeIds.filter(id => id !== nodeId)
        : [...prev.excludedNodeIds, nodeId],
    }))
  }, [])

  // ─── Wizard navigation ─────────────────────────────────────────────

  const currentStepIndex = WIZARD_STEPS.findIndex(s => s.key === wizardStep)

  const canProceedFromScope = builderState.selectedAnchorIds.length > 0
  const canProceedFromQuestion = builderState.predictionQuestion.trim().length > 0

  const handleNext = useCallback(() => {
    if (wizardStep === 'scope' && canProceedFromScope) {
      setWizardStep('question')
    } else if (wizardStep === 'question' && canProceedFromQuestion) {
      setWizardStep('config')
    }
  }, [wizardStep, canProceedFromScope, canProceedFromQuestion])

  const handleBack = useCallback(() => {
    if (wizardStep === 'question') setWizardStep('scope')
    else if (wizardStep === 'config') setWizardStep('question')
  }, [wizardStep])

  const handleStepClick = useCallback((step: WizardStep) => {
    const clickIndex = WIZARD_STEPS.findIndex(s => s.key === step)
    if (clickIndex < 2 && currentStepIndex >= 2) {
      setBuilderState(prev => ({
        ...prev,
        mode: 'prediction',
        depth: 'standard',
        surpriseSensitivity: 'balanced',
        presetUsed: null,
      }))
    }
    setWizardStep(step)
  }, [currentStepIndex])

  // PRD-D: Run now triggers persona generation first
  const handleRun = useCallback(async () => {
    await startPersonaGeneration(builderState)
  }, [startPersonaGeneration, builderState])

  // PRD-D: Confirm from agent review triggers actual simulation
  const handleConfirmRun = useCallback(async () => {
    await confirmAndRun(builderState)
  }, [confirmAndRun, builderState])

  const handleRerun = useCallback(() => {
    resetBuilder()
    setWizardStep('scope')
  }, [resetBuilder])

  // Re-run from a specific job — pre-populate builder with the job's config
  const handleRerunJob = useCallback((job: SimulationJob) => {
    resetBuilder()

    // Reconstruct builder state from the job's stored config + top-level fields
    const config = job.config

    setBuilderState({
      selectedAnchorIds: job.scopeAnchorIds,
      timeWindowDays: job.scopeTimeWindowDays,
      predictionQuestion: job.predictionQuestion,
      whatIfVariables: job.whatIfVariables,
      excludedNodeIds: job.excludedNodeIds,
      currentWhatIfInput: '',
      sourceTypeFilter: config?.sourceTypeFilter ?? null,
      outputHorizon: config?.outputHorizon ?? '90d',
      externalAgents: config?.externalAgents ?? [],
      mode: config?.mode ?? 'prediction',
      depth: config?.depth ?? 'standard',
      surpriseSensitivity: config?.surpriseSensitivity ?? 'balanced',
      presetUsed: config?.presetUsed ?? null,
    })

    // Jump to config step since all fields are pre-filled
    setWizardStep('config')
    setSelectedHistoryJobId(null)
  }, [resetBuilder])

  const handleIngest = useCallback(async (_jobId: string) => {
    console.log('Ingest report for job:', _jobId)
  }, [])

  const handleViewReport = useCallback((job: SimulationJob) => {
    setActiveJob(job)
    setStage('complete')
    setSelectedHistoryJobId(null)
  }, [setActiveJob, setStage])

  const selectedHistoryJob = jobs.find(j => j.id === selectedHistoryJobId) ?? null

  // Determine if we're in builder mode (idle stage with wizard)
  const isBuilderMode = stage === 'idle'

  // ─── Drag resize ─────────────────────────────────────────────────────
  const containerRef = useRef<HTMLDivElement>(null)
  const [leftWidthPct, setLeftWidthPct] = useState(DEFAULT_LEFT_PCT)
  const [isDragging, setIsDragging] = useState(false)
  const dragStartX = useRef(0)
  const dragStartPct = useRef(DEFAULT_LEFT_PCT)

  const handleDividerMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    dragStartX.current = e.clientX
    dragStartPct.current = leftWidthPct
    setIsDragging(true)

    const onMove = (ev: MouseEvent) => {
      if (!containerRef.current) return
      const containerW = containerRef.current.getBoundingClientRect().width
      const delta = ev.clientX - dragStartX.current
      const deltaPct = (delta / containerW) * 100
      setLeftWidthPct(Math.min(MAX_LEFT_PCT, Math.max(MIN_LEFT_PCT, dragStartPct.current + deltaPct)))
    }
    const onUp = () => {
      setIsDragging(false)
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [leftWidthPct])

  return (
    <div className="flex flex-col h-full">
      {/* Control bar */}
      <div
        className="flex items-center shrink-0"
        style={{
          background: 'var(--color-bg-card)',
          borderBottom: '1px solid var(--border-subtle)',
          padding: '8px 24px',
          minHeight: 44,
          gap: 8,
        }}
      >
        <FlaskConical size={16} style={{ color: 'var(--color-accent-500)' }} />
        <span className="font-display" style={{ fontSize: 12, fontWeight: 700, color: 'var(--color-text-primary)' }}>
          Simulate
        </span>

        <div style={{ flex: 1 }} />

        {/* Sidecar status */}
        {isCheckingSidecar ? (
          <span className="font-body" style={{ fontSize: 12, color: 'var(--color-text-placeholder)' }}>
            Checking engine…
          </span>
        ) : sidecarOnline ? (
          <div className="flex items-center gap-1">
            <CheckCircle2 size={12} style={{ color: '#22c55e' }} />
            <span className="font-body" style={{ fontSize: 12, color: '#15803d' }}>
              Simulation engine ready
            </span>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1">
              <AlertCircle size={12} style={{ color: '#d97706' }} />
              <span className="font-body" style={{ fontSize: 12, color: '#b45309' }}>
                Engine offline
              </span>
            </div>
            <button
              type="button"
              onClick={checkSidecar}
              className="flex items-center gap-1 cursor-pointer font-body font-semibold"
              style={{
                fontSize: 12, padding: '3px 10px', borderRadius: 20,
                background: 'transparent', border: '1px solid var(--border-subtle)',
                color: 'var(--color-text-secondary)',
              }}
            >
              <RefreshCw size={11} />
              Check Again
            </button>
          </div>
        )}
      </div>

      {/* Sidecar offline warning banner */}
      {!isCheckingSidecar && !sidecarOnline && isBuilderMode && (
        <div
          className="flex items-start gap-3"
          style={{
            padding: '10px 24px',
            background: '#fffbeb',
            borderBottom: '1px solid #fde68a',
          }}
        >
          <AlertCircle size={16} style={{ color: '#d97706', flexShrink: 0, marginTop: 1 }} />
          <div>
            <p className="font-body" style={{ fontSize: 13, color: '#92400e', margin: 0 }}>
              The simulation engine isn't responding. It may be starting up — Railway services can take 10–20 seconds on cold start.{' '}
              Click <strong>Check Again</strong> to retry.
            </p>
          </div>
        </div>
      )}

      {/* 2:1 column split */}
      <div ref={containerRef} className="flex flex-1 overflow-hidden">
        {/* Left column — main content */}
        <div
          style={{
            width: `${leftWidthPct}%`,
            overflowY: 'auto',
            padding: 24,
          }}
        >
          {/* BUILDER — Wizard (idle stage) */}
          {isBuilderMode && (
            <div className="flex flex-col gap-6">
              <StepIndicator currentStep={wizardStep} onStepClick={handleStepClick} />

              {/* Step 1: Scope */}
              {wizardStep === 'scope' && (
                <>
                  <ScopeSelector
                    selectedAnchorIds={builderState.selectedAnchorIds}
                    timeWindowDays={builderState.timeWindowDays}
                    sourceTypeFilter={builderState.sourceTypeFilter}
                    outputHorizon={builderState.outputHorizon}
                    onAnchorToggle={handleAnchorToggle}
                    onTimeWindowChange={handleTimeWindowChange}
                    onSourceTypeFilterChange={handleSourceTypeFilterChange}
                    onOutputHorizonChange={handleOutputHorizonChange}
                  />
                  <WizardNav
                    canNext={canProceedFromScope}
                    onNext={handleNext}
                    nextDisabledReason={!canProceedFromScope ? 'Select at least one anchor to continue.' : undefined}
                  />
                </>
              )}

              {/* Step 2: Question */}
              {wizardStep === 'question' && (
                <>
                  <PredictionInput
                    predictionQuestion={builderState.predictionQuestion}
                    whatIfVariables={builderState.whatIfVariables}
                    currentWhatIfInput={builderState.currentWhatIfInput}
                    externalAgents={builderState.externalAgents}
                    onQuestionChange={handleQuestionChange}
                    onWhatIfAdd={handleWhatIfAdd}
                    onWhatIfRemove={handleWhatIfRemove}
                    onWhatIfInputChange={handleWhatIfInputChange}
                    onExternalAgentsChange={handleExternalAgentsChange}
                  />

                  {/* Hypothesis Test tip */}
                  {builderState.mode === 'hypothesis_test' && builderState.whatIfVariables.length === 0 && (
                    <p className="font-body" style={{ fontSize: 12, color: '#b45309', margin: 0 }}>
                      Hypothesis Test works best when you add the specific belief you want to test as a condition above.
                    </p>
                  )}

                  <WizardNav
                    canBack
                    onBack={handleBack}
                    canNext={canProceedFromQuestion}
                    onNext={handleNext}
                    nextDisabledReason={!canProceedFromQuestion ? 'Enter a prediction question to continue.' : undefined}
                  />
                </>
              )}

              {/* Step 3: Configuration */}
              {wizardStep === 'config' && (
                <>
                  <SimulationConfigStep
                    mode={builderState.mode}
                    depth={builderState.depth}
                    surpriseSensitivity={builderState.surpriseSensitivity}
                    presetUsed={builderState.presetUsed}
                    onModeChange={handleModeChange}
                    onDepthChange={handleDepthChange}
                    onSurpriseSensitivityChange={handleSurpriseSensitivityChange}
                    onPresetSelect={handlePresetSelect}
                  />

                  {/* Persona preview */}
                  <PersonaPreview
                    seedGraph={previewSeedGraph}
                    excludedNodeIds={builderState.excludedNodeIds}
                    onExcludeToggle={handleExcludeToggle}
                    loading={previewLoading}
                  />

                  {/* Confirmation summary + run */}
                  <ConfigSummary
                    builderState={builderState}
                    seedGraph={previewSeedGraph}
                    anchorLabels={anchorLabels}
                    sidecarOnline={sidecarOnline}
                    onRun={handleRun}
                  />

                  <WizardNav
                    canBack
                    onBack={handleBack}
                  />
                </>
              )}
            </div>
          )}

          {/* GENERATING PERSONAS */}
          {stage === 'generating_personas' && (
            <div className="flex flex-col">
              <PipelineStages currentStage={stage} />
              <GeneratingPersonasState progress={personaProgress} />
            </div>
          )}

          {/* AWAITING REVIEW — agent cards + review footer */}
          {stage === 'awaiting_review' && (
            <div className="flex flex-col">
              <PipelineStages currentStage={stage} />
              <AgentReview
                personas={personas}
                diversity={diversity}
                excludedAgentIds={excludedAgentIds}
                onToggleExclude={toggleAgentExclusion}
                onConfirm={handleConfirmRun}
                onBack={backToSetup}
              />
            </div>
          )}

          {/* RUNNING SIMULATION */}
          {(stage === 'confirmed' || stage === 'running_simulation') && activeJob && (
            <div className="flex flex-col" style={{ flex: 1 }}>
              <PipelineStages currentStage="running_simulation" />
              <SimulationRunner
                job={activeJob}
                stage={stage}
                roundLog={roundLog}
                activeRound={activeRound}
                error={error}
                onCancel={cancelSimulation}
                onExit={exitSimulation}
              />
            </div>
          )}

          {/* GENERATING REPORT */}
          {stage === 'generating_report' && activeJob && (
            <div className="flex flex-col" style={{ flex: 1 }}>
              <PipelineStages currentStage={stage} />
              <SimulationRunner
                job={activeJob}
                stage={stage}
                roundLog={roundLog}
                activeRound={activeRound}
                error={error}
                onExit={exitSimulation}
              />
            </div>
          )}

          {/* COMPLETE */}
          {stage === 'complete' && activeJob && (
            <div className="flex flex-col">
              <PipelineStages currentStage={stage} />
              <SimulationReport
                job={activeJob}
                onRerun={handleRerun}
                onIngest={handleIngest}
              />
            </div>
          )}

          {/* FAILED */}
          {stage === 'failed' && (
            <FailedState
              error={error}
              activeJob={activeJob}
              onReset={() => {
                resetBuilder()
                setWizardStep('scope')
              }}
            />
          )}
        </div>

        {/* Drag handle */}
        <div
          onMouseDown={handleDividerMouseDown}
          className="flex items-center justify-center shrink-0"
          style={{
            width: 12,
            cursor: 'col-resize',
            background: isDragging ? 'rgba(0,0,0,0.04)' : 'transparent',
            borderLeft: '1px solid var(--border-subtle)',
            borderRight: '1px solid var(--border-subtle)',
            transition: 'background 0.15s',
          }}
        >
          <GripVertical size={12} style={{ color: 'var(--color-text-placeholder)' }} />
        </div>

        {/* Right column — history or detail */}
        <div
          style={{
            flex: 1,
            overflowY: 'auto',
            background: 'var(--color-bg-content)',
          }}
        >
          {selectedHistoryJob ? (
            <SimulationDetailPanel
              job={selectedHistoryJob}
              onBack={() => setSelectedHistoryJobId(null)}
              onViewReport={handleViewReport}
              onRerun={() => handleRerunJob(selectedHistoryJob)}
              onResume={
                selectedHistoryJob.seedGraph && selectedHistoryJob.personas && selectedHistoryJob.personas.length > 0
                  ? () => {
                      setSelectedHistoryJobId(null)
                      resumeJob(selectedHistoryJob)
                    }
                  : undefined
              }
            />
          ) : (
            <SimulationHistoryPanel
              jobs={jobs}
              loading={jobsLoading}
              onSelectJob={setSelectedHistoryJobId}
            />
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Wizard navigation buttons ───────────────────────────────────────────────
function WizardNav({
  canBack,
  onBack,
  canNext,
  onNext,
  nextDisabledReason,
}: {
  canBack?: boolean
  onBack?: () => void
  canNext?: boolean
  onNext?: () => void
  nextDisabledReason?: string
}) {
  return (
    <div className="flex items-center gap-3">
      {canBack && onBack && (
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-1 cursor-pointer font-body font-semibold"
          style={{
            fontSize: 13, padding: '8px 16px', borderRadius: 20,
            background: 'transparent',
            border: '1px solid var(--border-subtle)',
            color: 'var(--color-text-secondary)',
            transition: 'all 0.15s ease',
          }}
        >
          <ChevronLeft size={14} />
          Back
        </button>
      )}
      {onNext && (
        <button
          type="button"
          onClick={onNext}
          disabled={!canNext}
          className="flex items-center gap-1 cursor-pointer font-body font-semibold"
          style={{
            fontSize: 13, padding: '8px 20px', borderRadius: 20,
            background: canNext ? 'var(--color-accent-500)' : 'var(--color-bg-inset)',
            border: 'none',
            color: canNext ? 'white' : 'var(--color-text-placeholder)',
            transition: 'all 0.15s ease',
            opacity: canNext ? 1 : 0.6,
          }}
        >
          Next
          <ChevronRight size={14} />
        </button>
      )}
      {nextDisabledReason && !canNext && (
        <span className="font-body" style={{ fontSize: 12, color: 'var(--color-text-placeholder)' }}>
          {nextDisabledReason}
        </span>
      )}
    </div>
  )
}
