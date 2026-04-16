import { useState, useCallback, useRef } from 'react'
import { supabase } from '../services/supabase'
import {
  INITIAL_AGENT_STATE,
  type AgentQueryState,
  type AgentToolCall,
} from '../types/agent'
import type { ChatMessage } from '../types/rag'

async function getAuthHeaders(): Promise<Record<string, string>> {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session?.access_token) throw new Error('Not authenticated')
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${session.access_token}`,
  }
}

export function useAgentQuery() {
  const [agentState, setAgentState] = useState<AgentQueryState>(INITIAL_AGENT_STATE)
  const abortRef = useRef<AbortController | null>(null)
  // Track tool call count so we can assign stable indices
  const callCountRef = useRef(0)

  const processEvent = useCallback((eventType: string, data: Record<string, unknown>) => {
    switch (eventType) {
      case 'tool_start': {
        const idx = callCountRef.current++
        const newCall: AgentToolCall = {
          index: idx,
          tool: (data.tool as string) ?? 'unknown',
          params: (data.params as Record<string, unknown>) ?? {},
          result: null,
          status: 'running',
        }
        setAgentState(prev => ({
          ...prev,
          toolCalls: [...prev.toolCalls, newCall],
          thinking: (data.reasoning as string) ?? prev.thinking,
        }))
        break
      }

      case 'tool_result': {
        setAgentState(prev => ({
          ...prev,
          toolCalls: prev.toolCalls.map((tc, i, arr) => {
            // Find the last running tool call
            const isLastRunning = tc.status === 'running' &&
              !arr.slice(i + 1).some(t => t.status === 'running')
            if (!isLastRunning) return tc
            return {
              ...tc,
              status: 'complete' as const,
              result: (data.result as Record<string, unknown>) ?? {},
            }
          }),
        }))
        break
      }

      case 'tool_error': {
        setAgentState(prev => ({
          ...prev,
          toolCalls: prev.toolCalls.map((tc, i, arr) => {
            const isLastRunning = tc.status === 'running' &&
              !arr.slice(i + 1).some(t => t.status === 'running')
            if (!isLastRunning) return tc
            return {
              ...tc,
              status: 'error' as const,
              error: (data.error as string) ?? 'Unknown tool error',
            }
          }),
        }))
        break
      }

      case 'thinking':
        setAgentState(prev => ({ ...prev, thinking: (data.text as string) ?? null }))
        break

      case 'answer':
        setAgentState(prev => ({
          ...prev,
          // The server sends 'answer' field, not 'text'
          answer: (data.answer as string) ?? (data.text as string) ?? null,
          citations: [],
          thinking: null,
        }))
        break

      case 'error':
        setAgentState(prev => ({
          ...prev,
          status: 'error',
          error: (data.message as string) ?? (data.error as string) ?? 'Unknown error',
        }))
        break

      case 'done':
        setAgentState(prev =>
          prev.status === 'error' ? prev : { ...prev, status: 'complete' }
        )
        break
    }
  }, [])

  const sendAgentQuery = useCallback(async (
    query: string,
    conversationHistory: ChatMessage[] = [],
  ) => {
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    callCountRef.current = 0

    setAgentState({ ...INITIAL_AGENT_STATE, status: 'running' })

    try {
      const headers = await getAuthHeaders()

      const resp = await fetch('/api/agent/run', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          query,
          conversation_history: conversationHistory.map(m => ({
            role: m.role,
            content: m.content,
          })),
        }),
        signal: controller.signal,
      })

      if (!resp.ok) {
        const errBody = await resp.text().catch(() => '')
        throw new Error(`Server error ${resp.status}: ${errBody}`)
      }

      if (!resp.body) throw new Error('No response body')

      const reader = resp.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })

        // SSE format: "event: <type>\ndata: <json>\n\n"
        // Split on double newline to get complete events
        const events = buffer.split('\n\n')
        // Keep the last chunk (may be incomplete)
        buffer = events.pop() ?? ''

        for (const eventBlock of events) {
          if (!eventBlock.trim()) continue

          let eventType = ''
          let dataStr = ''

          for (const line of eventBlock.split('\n')) {
            const trimmed = line.trim()
            if (trimmed.startsWith('event:')) {
              eventType = trimmed.slice(6).trim()
            } else if (trimmed.startsWith('data:')) {
              dataStr = trimmed.slice(5).trim()
            }
          }

          if (eventType && dataStr) {
            try {
              const parsed = JSON.parse(dataStr) as Record<string, unknown>
              processEvent(eventType, parsed)
            } catch {
              // Malformed JSON, skip
            }
          }
        }
      }

      // Mark complete if not already in error state
      setAgentState(prev =>
        prev.status === 'error' ? prev : { ...prev, status: 'complete' }
      )
    } catch (err) {
      if ((err as Error).name === 'AbortError') return
      setAgentState(prev => ({
        ...prev,
        status: 'error',
        error: err instanceof Error ? err.message : 'Unknown error',
      }))
    }
  }, [processEvent])

  const resetAgent = useCallback(() => {
    abortRef.current?.abort()
    callCountRef.current = 0
    setAgentState(INITIAL_AGENT_STATE)
  }, [])

  return { agentState, sendAgentQuery, resetAgent }
}
