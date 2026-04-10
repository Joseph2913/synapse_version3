import { useState, useCallback, useRef } from 'react'
import { supabase } from '../services/supabase'
import type {
  CouncilQueryState,
  CouncilResponse,
  CouncilRouting,
} from '../types/rag'

const INITIAL_STATE: CouncilQueryState = {
  status: 'idle',
  routing: null,
  agentPerspectives: [],
  synthesis: null,
  error: null,
}

export function useCouncilQuery() {
  const [state, setState] = useState<CouncilQueryState>(INITIAL_STATE)
  const [history, setHistory] = useState<Array<{
    id: string
    query: string
    response: CouncilResponse
    timestamp: Date
  }>>([])
  const abortRef = useRef<AbortController | null>(null)

  const sendQuery = useCallback(async (
    query: string,
    opts?: { mode?: string; agent_names?: string[]; include_agent_reasoning?: boolean }
  ) => {
    // Abort any in-flight request
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller

    // Reset state, show routing phase
    setState({
      status: 'routing',
      routing: null,
      agentPerspectives: [],
      synthesis: null,
      error: null,
    })

    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) {
        setState(prev => ({ ...prev, status: 'error', error: 'Not authenticated' }))
        return
      }

      const response = await fetch('/api/council/consult', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          query,
          mode: opts?.mode ?? 'auto',
          agent_names: opts?.agent_names,
          include_agent_reasoning: opts?.include_agent_reasoning !== false,
        }),
        signal: controller.signal,
      })

      if (!response.ok) {
        const errData = await response.json().catch(() => null)
        throw new Error(errData?.message ?? `Server error ${response.status}`)
      }

      const data = await response.json()

      // Check for error responses
      if (data.error === 'no_agents') {
        setState({
          status: 'error',
          routing: null,
          agentPerspectives: [],
          synthesis: null,
          error: data.message ?? 'No advisory council agents found.',
        })
        return
      }

      if (data.error === 'all_agents_failed') {
        setState({
          status: 'error',
          routing: data.routing ?? null,
          agentPerspectives: [],
          synthesis: null,
          error: data.message ?? 'All agent analyses failed.',
        })
        return
      }

      if (data.error === 'pipeline_failed') {
        throw new Error(data.message ?? 'Pipeline failed')
      }

      // Success — populate state with simulated progressive reveal
      const councilResponse = data as CouncilResponse
      const routing: CouncilRouting = councilResponse.routing

      // Phase 1: Show routing
      setState(prev => ({
        ...prev,
        status: 'agents_working',
        routing,
        agentPerspectives: (councilResponse.agent_perspectives ?? []).map(ap => ({
          ...ap,
          status: 'loading' as const,
        })),
      }))

      // Phase 2: Reveal agent perspectives (staggered, 400ms between each)
      const perspectives = councilResponse.agent_perspectives ?? []
      for (let i = 0; i < perspectives.length; i++) {
        await new Promise(resolve => setTimeout(resolve, 400))
        if (controller.signal.aborted) return
        const p = perspectives[i]
        if (!p) continue
        setState(prev => ({
          ...prev,
          agentPerspectives: prev.agentPerspectives.map((ap, idx) =>
            idx === i ? {
              agent_name: p.agent_name,
              agent_id: p.agent_id,
              reasoning_style: p.reasoning_style,
              analysis: p.analysis,
              key_claims: p.key_claims,
              coverage_assessment: p.coverage_assessment,
              coverage_note: p.coverage_note,
              cross_domain_flags: p.cross_domain_flags,
              sources_cited: p.sources_cited,
              status: 'complete' as const,
            } : ap
          ),
        }))
      }

      // Phase 3: Show synthesis
      if (controller.signal.aborted) return
      await new Promise(resolve => setTimeout(resolve, 600))
      setState(prev => ({
        ...prev,
        status: 'complete',
        synthesis: {
          ...councilResponse.synthesis,
          status: 'complete' as const,
        },
      }))

      // Add to history
      const entry = {
        id: `council-${Date.now()}`,
        query,
        response: councilResponse,
        timestamp: new Date(),
      }
      setHistory(prev => [...prev, entry])

    } catch (err) {
      if ((err as Error).name === 'AbortError') return
      setState(prev => ({
        ...prev,
        status: 'error',
        error: err instanceof Error ? err.message : 'Unknown error',
      }))
    }
  }, [])

  const reset = useCallback(() => {
    abortRef.current?.abort()
    setState(INITIAL_STATE)
  }, [])

  return {
    councilState: state,
    councilHistory: history,
    sendCouncilQuery: sendQuery,
    resetCouncil: reset,
  }
}
