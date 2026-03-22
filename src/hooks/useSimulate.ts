import { useState, useCallback, useEffect, useRef } from 'react'
import type {
  SimulationBuilderState, SimulationJob, SimulationStage,
  SimulationPersona, PersonaSetDiversity,
} from '../types/simulate'
import {
  createSimulationJob,
  buildSeedGraph,
  buildSimulationConfig,
  triggerSidecarSimulation,
  updateSimulationJobStatus,
  checkSidecarHealth,
  generatePersonas,
} from '../services/simulate'
import { supabase } from '../services/supabase'
import type { PersonaGenerationProgress } from '../services/simulate'

export type { SimulationStage }

const ROUND_TYPE_LABELS: Record<string, string> = {
  opening: 'Initial positions established',
  reaction: 'Agents responding to each other',
  challenge: 'Minority position presented',
  revision: 'Position revision round',
  closing: 'Final positions locked',
}

interface RoundLogEntry {
  round: number
  label: string
  note: string
  updatedAgentCount: number
}

interface UseSimulateReturn {
  stage: SimulationStage
  activeJob: SimulationJob | null
  sidecarOnline: boolean
  isCheckingSidecar: boolean
  error: string | null
  personas: SimulationPersona[]
  diversity: PersonaSetDiversity | null
  excludedAgentIds: Set<string>
  activeRound: number
  roundLog: RoundLogEntry[]
  personaProgress: PersonaGenerationProgress | null
  checkSidecar: () => Promise<void>
  startPersonaGeneration: (state: SimulationBuilderState) => Promise<void>
  confirmAndRun: (state: SimulationBuilderState) => Promise<void>
  resumeJob: (job: SimulationJob) => Promise<void>
  cancelSimulation: () => Promise<void>
  exitSimulation: () => void
  toggleAgentExclusion: (agentId: string) => void
  backToSetup: () => void
  resetBuilder: () => void
  setStage: (stage: SimulationStage) => void
  setActiveJob: (job: SimulationJob | null) => void
}

export function useSimulate(): UseSimulateReturn {
  const [stage, setStage] = useState<SimulationStage>('idle')
  const [activeJob, setActiveJob] = useState<SimulationJob | null>(null)
  const [sidecarOnline, setSidecarOnline] = useState(false)
  const [isCheckingSidecar, setIsCheckingSidecar] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // PRD-D persona state
  const [personas, setPersonas] = useState<SimulationPersona[]>([])
  const [diversity, setDiversity] = useState<PersonaSetDiversity | null>(null)
  const [excludedAgentIds, setExcludedAgentIds] = useState<Set<string>>(new Set())
  const [activeRound, setActiveRound] = useState(0)
  const [roundLog, setRoundLog] = useState<RoundLogEntry[]>([])
  const [personaProgress, setPersonaProgress] = useState<PersonaGenerationProgress | null>(null)

  // ─── PRD-Simulate-E: Supabase realtime subscription for round progress ───
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null)

  useEffect(() => {
    if (!activeJob || stage !== 'running_simulation') {
      // Tear down any existing subscription when not running
      if (channelRef.current) {
        supabase.removeChannel(channelRef.current)
        channelRef.current = null
      }
      return
    }

    const channel = supabase
      .channel(`simulation-progress-${activeJob.id}`)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'simulation_jobs',
          filter: `id=eq.${activeJob.id}`,
        },
        (payload) => {
          const row = payload.new as Record<string, unknown>

          // Round progress updates from sidecar
          const progress = row.progress as Record<string, unknown> | null
          if (progress && typeof progress === 'object' && 'current_round' in progress) {
            const currentRound = progress.current_round as number
            const roundType = progress.round_type as string
            const deltaCount = progress.delta_count as number

            const label = ROUND_TYPE_LABELS[roundType] ?? roundType
            const note = deltaCount > 0
              ? `${deltaCount} agent${deltaCount > 1 ? 's' : ''} revised their position`
              : 'Positions held'

            setActiveRound(currentRound)
            setRoundLog(prev => {
              // Avoid duplicate entries for the same round
              if (prev.some(e => e.round === currentRound)) return prev
              return [...prev, { round: currentRound, label, note, updatedAgentCount: deltaCount }]
            })
          }

          // Status transitions
          const status = row.status as string
          if (status === 'generating_report') {
            setStage('generating_report')
          } else if (status === 'completed') {
            setStage('complete')
          } else if (status === 'failed' || status === 'timeout' || status === 'simulation_stagnated') {
            if (status === 'simulation_stagnated') {
              // Not a failure — simulation ended early due to consensus
              setStage('complete')
            } else {
              setError((row.error_message as string) ?? 'Simulation failed')
              setStage('failed')
            }
          }
        }
      )
      .subscribe()

    channelRef.current = channel

    return () => {
      supabase.removeChannel(channel)
      channelRef.current = null
    }
  }, [activeJob?.id, stage])

  const checkSidecar = useCallback(async () => {
    setIsCheckingSidecar(true)
    const online = await checkSidecarHealth()
    setSidecarOnline(online)
    setIsCheckingSidecar(false)
  }, [])

  // Step 1: User clicks Run → generate personas
  const startPersonaGeneration = useCallback(async (state: SimulationBuilderState) => {
    setError(null)
    setStage('generating_personas')
    setExcludedAgentIds(new Set())

    try {
      const seedGraph = await buildSeedGraph(
        state.selectedAnchorIds,
        state.timeWindowDays,
        state.excludedNodeIds,
        state.sourceTypeFilter
      )

      const config = buildSimulationConfig(state)
      const { data: { user } } = await (await import('../services/supabase')).supabase.auth.getUser()
      if (!user) throw new Error('Not authenticated')

      setPersonaProgress({ current: 0, total: 0, currentLabel: 'Preparing…', phase: 'filtering' })
      const result = await generatePersonas(seedGraph, config, user.id, (p) => setPersonaProgress(p))

      setPersonas(result.personas)
      setDiversity(result.diversity)
      setPersonaProgress(null)
      setStage('awaiting_review')
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Agent generation failed'
      setError(message)
      setStage('failed')
    }
  }, [])

  // Step 2: User reviews and clicks "Run simulation"
  const confirmAndRun = useCallback(async (state: SimulationBuilderState) => {
    setError(null)
    setStage('confirmed')

    // Track job ID outside try so the catch block can persist failure to Supabase
    let createdJobId: string | null = null

    try {
      // Filter out excluded agents
      const activePersonas = personas.filter(p => !excludedAgentIds.has(p.agent_id))

      // Build seed graph
      const seedGraph = await buildSeedGraph(
        state.selectedAnchorIds,
        state.timeWindowDays,
        state.excludedNodeIds,
        state.sourceTypeFilter
      )

      // Auto-generate title
      const title = `Simulation — ${new Date().toLocaleDateString('en-GB', {
        day: 'numeric', month: 'short', year: 'numeric',
      })}`

      // Create job record
      const job = await createSimulationJob(state, title)
      createdJobId = job.id

      // Log diversity override if user proceeded past a warning
      if (diversity && diversity.warning !== 'none') {
        console.log('[SIMULATE] User proceeded past diversity warning:', diversity.warning)
      }

      await updateSimulationJobStatus(job.id, {
        status: 'preparing',
        progress: 10,
        progressMessage: 'Preparing knowledge graph export…',
        seedGraph,
        personas: activePersonas,
        scopeNodeCount: seedGraph.nodes.length,
        scopeEdgeCount: seedGraph.edges.length,
        scopeSourceCount: [...new Set(seedGraph.nodes.map(n => n.sourceId).filter(Boolean))].length,
      })

      setActiveJob({ ...job, status: 'preparing', progress: 10 })
      setStage('running_simulation')
      setActiveRound(0)
      setRoundLog([])

      const config = buildSimulationConfig(state)

      // Fire to sidecar with personas
      console.log('[SIMULATE] About to call triggerSidecarSimulation for job:', job.id)
      console.log('[SIMULATE] Active personas:', activePersonas.length)
      await triggerSidecarSimulation(
        job.id,
        seedGraph,
        state.predictionQuestion,
        state.whatIfVariables,
        config,
        activePersonas
      )
      console.log('[SIMULATE] Sidecar call completed successfully')
    } catch (err) {
      console.error('[SIMULATE] confirmAndRun failed:', err)
      const message = err instanceof Error ? err.message : 'Unknown error occurred'
      setError(message)
      setStage('failed')

      // Persist failure to Supabase so the job doesn't stay stuck as "preparing"
      if (createdJobId) {
        try {
          await updateSimulationJobStatus(createdJobId, {
            status: 'failed',
            errorMessage: message,
          })
        } catch (updateErr) {
          console.error('[SIMULATE] Failed to persist error status to Supabase:', updateErr)
        }
      }
    }
  }, [personas, excludedAgentIds, diversity])

  // Resume a failed job — reuses existing seed graph + personas, skips to sidecar call
  const resumeJob = useCallback(async (job: SimulationJob) => {
    if (!job.seedGraph || !job.personas || job.personas.length === 0) {
      throw new Error('Cannot resume: job is missing seed graph or personas.')
    }

    setError(null)
    setStage('confirmed')

    try {
      // Reset job status from 'failed' back to 'preparing'
      await updateSimulationJobStatus(job.id, {
        status: 'preparing',
        progress: 10,
        progressMessage: 'Resuming — retrying sidecar call…',
        errorMessage: '',
      })

      setActiveJob({ ...job, status: 'preparing', progress: 10 })
      setStage('running_simulation')
      setActiveRound(0)
      setRoundLog([])

      const config = job.config ?? {
        anchorNodeIds: job.scopeAnchorIds,
        timeWindow: '90d' as const,
        sourceTypeFilter: null,
        outputHorizon: '90d' as const,
        question: job.predictionQuestion,
        whatIfVariables: job.whatIfVariables,
        externalAgents: [],
        mode: 'prediction' as const,
        depth: 'standard' as const,
        surpriseSensitivity: 'balanced' as const,
        presetUsed: null,
      }

      await triggerSidecarSimulation(
        job.id,
        job.seedGraph,
        job.predictionQuestion,
        job.whatIfVariables,
        config,
        job.personas
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error occurred'
      setError(message)
      setStage('failed')

      try {
        await updateSimulationJobStatus(job.id, {
          status: 'failed',
          errorMessage: message,
        })
      } catch (updateErr) {
        console.error('[SIMULATE] Failed to persist error status to Supabase:', updateErr)
      }
    }
  }, [])

  const toggleAgentExclusion = useCallback((agentId: string) => {
    setExcludedAgentIds(prev => {
      const next = new Set(prev)
      if (next.has(agentId)) {
        next.delete(agentId)
      } else {
        next.add(agentId)
      }
      return next
    })
  }, [])

  // Cancel a running simulation — marks it as failed in Supabase and resets UI
  const cancelSimulation = useCallback(async () => {
    if (activeJob?.id) {
      try {
        await updateSimulationJobStatus(activeJob.id, {
          status: 'failed',
          errorMessage: 'Cancelled by user.',
        })
      } catch (err) {
        console.error('[SIMULATE] Failed to cancel job in Supabase:', err)
      }
    }
    setStage('idle')
    setActiveJob(null)
    setError(null)
    setActiveRound(0)
    setRoundLog([])
  }, [activeJob])

  // Exit the simulation view — go back to builder, simulation continues in background
  const exitSimulation = useCallback(() => {
    setStage('idle')
    setActiveJob(null)
    setError(null)
    setActiveRound(0)
    setRoundLog([])
  }, [])

  const backToSetup = useCallback(() => {
    setStage('idle')
    setPersonas([])
    setDiversity(null)
    setExcludedAgentIds(new Set())
    setPersonaProgress(null)
  }, [])

  const resetBuilder = useCallback(() => {
    setStage('idle')
    setActiveJob(null)
    setError(null)
    setPersonas([])
    setDiversity(null)
    setExcludedAgentIds(new Set())
    setActiveRound(0)
    setRoundLog([])
    setPersonaProgress(null)
  }, [])

  return {
    stage, activeJob, sidecarOnline, isCheckingSidecar, error,
    personas, diversity, excludedAgentIds, activeRound, roundLog,
    personaProgress,
    checkSidecar, startPersonaGeneration, confirmAndRun, resumeJob,
    cancelSimulation, exitSimulation,
    toggleAgentExclusion, backToSetup, resetBuilder,
    setStage, setActiveJob,
  }
}
