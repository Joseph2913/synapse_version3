import { useState, useCallback, useRef } from 'react'
import { supabase } from '../services/supabase'
import type {
  CouncilQueryState,
  CouncilRouting,
  CouncilAgentPerspective,
  CouncilSynthesis,
} from '../types/rag'

const INITIAL_STATE: CouncilQueryState = {
  status: 'idle',
  routing: null,
  availableAgents: [],
  selectedAgentIds: [],
  metaAnswer: null,
  agentPerspectives: [],
  synthesis: null,
  error: null,
}

async function getAuthHeaders(): Promise<Record<string, string>> {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session?.access_token) throw new Error('Not authenticated')
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${session.access_token}`,
  }
}

export function useCouncilQuery() {
  const [state, setState] = useState<CouncilQueryState>(INITIAL_STATE)
  const queryRef = useRef<string>('')
  const abortRef = useRef<AbortController | null>(null)

  // ── Step 1: Route — classify and get suggested agents ──
  const sendQuery = useCallback(async (
    query: string,
    opts?: { mode?: string; agent_names?: string[] }
  ) => {
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    queryRef.current = query

    setState({
      ...INITIAL_STATE,
      status: 'routing',
    })

    try {
      const headers = await getAuthHeaders()
      const resp = await fetch('/api/council/route', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          query,
          mode: opts?.mode ?? 'auto',
          agent_names: opts?.agent_names,
        }),
        signal: controller.signal,
      })

      if (!resp.ok) {
        const err = await resp.json().catch(() => null)
        throw new Error(err?.message ?? `Server error ${resp.status}`)
      }

      const data = await resp.json()

      if (data.error === 'no_agents') {
        setState(prev => ({ ...prev, status: 'error', error: data.message }))
        return
      }

      const routing: CouncilRouting = data.routing
      const availableAgents = data.available_agents ?? []
      const selectedIds = routing.agents_consulted.map((a: { agent_id: string }) => a.agent_id)

      // Meta answer — done immediately
      if (routing.classification === 'meta' && data.meta_answer) {
        setState(prev => ({
          ...prev,
          status: 'complete',
          routing,
          availableAgents,
          selectedAgentIds: [],
          metaAnswer: data.meta_answer,
        }))
        return
      }

      // Pause for user approval
      setState(prev => ({
        ...prev,
        status: 'awaiting_approval',
        routing,
        availableAgents,
        selectedAgentIds: selectedIds,
      }))

    } catch (err) {
      if ((err as Error).name === 'AbortError') return
      setState(prev => ({
        ...prev,
        status: 'error',
        error: err instanceof Error ? err.message : 'Unknown error',
      }))
    }
  }, [])

  // ── User modifies agent selection ──
  const toggleAgent = useCallback((agentId: string) => {
    setState(prev => {
      const current = prev.selectedAgentIds
      const next = current.includes(agentId)
        ? current.filter(id => id !== agentId)
        : [...current, agentId]
      return { ...prev, selectedAgentIds: next }
    })
  }, [])

  // ── Step 2: Analyse — run after user approves agent selection ──
  const approveAndAnalyse = useCallback(async () => {
    const query = queryRef.current

    setState(prev => {
      // Create loading skeleton for each selected agent
      const skeletons = prev.selectedAgentIds.map(id => {
        const agent = prev.availableAgents.find(a => a.id === id)
        const consulted = prev.routing?.agents_consulted.find(a => a.agent_id === id)
        return {
          agent_name: consulted?.agent_name ?? agent?.name ?? 'Agent',
          agent_id: id,
          reasoning_style: '',
          analysis: '',
          key_claims: [] as CouncilAgentPerspective['key_claims'],
          coverage_assessment: 'adequate' as const,
          coverage_note: '',
          cross_domain_flags: [] as string[],
          sources_cited: [] as string[],
          status: 'loading' as const,
        }
      })
      return { ...prev, status: 'agents_working', agentPerspectives: skeletons }
    })

    try {
      const headers = await getAuthHeaders()
      const agentIds = state.selectedAgentIds

      const resp = await fetch('/api/council/analyse', {
        method: 'POST',
        headers,
        body: JSON.stringify({ query, agent_ids: agentIds }),
        signal: abortRef.current?.signal,
      })

      if (!resp.ok) {
        const err = await resp.json().catch(() => null)
        throw new Error(err?.message ?? `Server error ${resp.status}`)
      }

      const data = await resp.json()
      const perspectives: CouncilAgentPerspective[] = data.agent_perspectives ?? []

      // Reveal agent perspectives
      setState(prev => ({
        ...prev,
        agentPerspectives: perspectives.map(p => ({ ...p, status: 'complete' as const })),
        status: 'synthesising',
      }))

      // ── Step 3: Synthesise ──
      const synthResp = await fetch('/api/council/synthesise', {
        method: 'POST',
        headers,
        body: JSON.stringify({ query, perspectives }),
        signal: abortRef.current?.signal,
      })

      if (!synthResp.ok) {
        // Synthesis failed but we still have agent perspectives
        setState(prev => ({
          ...prev,
          status: 'complete',
          synthesis: {
            answer: 'Synthesis could not be generated. Review the individual advisor perspectives above.',
            agreements: [],
            tensions: [],
            emergent_insight: null,
            blind_spots: [],
            follow_up_suggestions: [],
            status: 'complete' as const,
          },
        }))
        return
      }

      const synthData = await synthResp.json()
      const synthesis: CouncilSynthesis = synthData.synthesis

      setState(prev => ({
        ...prev,
        status: 'complete',
        synthesis: { ...synthesis, status: 'complete' as const },
      }))

    } catch (err) {
      if ((err as Error).name === 'AbortError') return
      setState(prev => ({
        ...prev,
        status: 'error',
        error: err instanceof Error ? err.message : 'Unknown error',
      }))
    }
  }, [state.selectedAgentIds])

  // ── Skip approval — auto-proceed with suggested agents ──
  const skipAndAnalyse = useCallback(() => {
    void approveAndAnalyse()
  }, [approveAndAnalyse])

  const reset = useCallback(() => {
    abortRef.current?.abort()
    setState(INITIAL_STATE)
  }, [])

  return {
    councilState: state,
    sendCouncilQuery: sendQuery,
    toggleAgent,
    approveAndAnalyse,
    skipAndAnalyse,
    resetCouncil: reset,
  }
}
