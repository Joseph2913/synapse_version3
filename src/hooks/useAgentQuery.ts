import { useState, useCallback, useRef } from 'react'
import { supabase } from '../services/supabase'
import {
  INITIAL_AGENT_STATE,
  type AgentQueryState,
  type AgentSSEEvent,
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

  const processEvent = useCallback((event: AgentSSEEvent) => {
    switch (event.type) {
      case 'tool_start':
        setAgentState(prev => {
          const newCall: AgentToolCall = {
            index: event.call_index,
            tool: event.tool,
            params: event.params,
            result: null,
            status: 'running',
          }
          return { ...prev, toolCalls: [...prev.toolCalls, newCall] }
        })
        break

      case 'tool_result':
        setAgentState(prev => ({
          ...prev,
          toolCalls: prev.toolCalls.map(tc =>
            tc.index === event.call_index
              ? { ...tc, status: 'complete' as const, result: event.result, duration_ms: event.duration_ms }
              : tc
          ),
        }))
        break

      case 'tool_error':
        setAgentState(prev => ({
          ...prev,
          toolCalls: prev.toolCalls.map(tc =>
            tc.index === event.call_index
              ? { ...tc, status: 'error' as const, error: event.error }
              : tc
          ),
        }))
        break

      case 'thinking':
        setAgentState(prev => ({ ...prev, thinking: event.text }))
        break

      case 'answer':
        setAgentState(prev => ({
          ...prev,
          answer: event.text,
          citations: event.citations ?? [],
          thinking: null,
        }))
        break

      case 'error':
        setAgentState(prev => ({ ...prev, status: 'error', error: event.message }))
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
    conversationHistory: ChatMessage[]
  ) => {
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller

    setAgentState({ ...INITIAL_AGENT_STATE, status: 'running' })

    try {
      const headers = await getAuthHeaders()

      const resp = await fetch('/api/agent/run', {
        method: 'POST',
        headers,
        body: JSON.stringify({ query, conversation_history: conversationHistory }),
        signal: controller.signal,
      })

      if (!resp.ok) {
        const err = await resp.json().catch(() => null)
        throw new Error((err as { message?: string } | null)?.message ?? `Server error ${resp.status}`)
      }

      if (!resp.body) {
        throw new Error('No response body')
      }

      const reader = resp.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })

        // Split on double newline (SSE event boundary) but handle partial events
        const lines = buffer.split('\n')
        // Keep the last (potentially incomplete) line in the buffer
        buffer = lines.pop() ?? ''

        let eventType: string | null = null
        let dataLine: string | null = null

        for (const line of lines) {
          const trimmed = line.trim()
          if (trimmed === '') {
            // Empty line = end of SSE event — process what we have
            if (dataLine !== null) {
              try {
                const parsed = JSON.parse(dataLine) as AgentSSEEvent
                processEvent(parsed)
              } catch {
                // Malformed event — skip
              }
              eventType = null
              dataLine = null
            }
          } else if (trimmed.startsWith('event:')) {
            eventType = trimmed.slice('event:'.length).trim()
          } else if (trimmed.startsWith('data:')) {
            dataLine = trimmed.slice('data:'.length).trim()
          }
        }

        // If there's a pending event after the loop (no trailing blank line), keep it in the buffer
        if (eventType !== null || dataLine !== null) {
          const rebuiltLines: string[] = []
          if (eventType !== null) rebuiltLines.push(`event: ${eventType}`)
          if (dataLine !== null) rebuiltLines.push(`data: ${dataLine}`)
          buffer = rebuiltLines.join('\n') + '\n' + buffer
        }
      }

      // Flush any remaining buffered event
      if (buffer.trim()) {
        const lines = buffer.split('\n')
        let dataLine: string | null = null
        for (const line of lines) {
          const trimmed = line.trim()
          if (trimmed.startsWith('data:')) {
            dataLine = trimmed.slice('data:'.length).trim()
          }
        }
        if (dataLine) {
          try {
            const parsed = JSON.parse(dataLine) as AgentSSEEvent
            processEvent(parsed)
          } catch {
            // Malformed — skip
          }
        }
      }

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
    setAgentState(INITIAL_AGENT_STATE)
  }, [])

  return { agentState, sendAgentQuery, resetAgent }
}
