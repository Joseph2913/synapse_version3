import type { InlineCitation } from './rag'

export interface AgentToolCall {
  index: number
  tool: string
  params: Record<string, unknown>
  result: Record<string, unknown> | null
  status: 'running' | 'complete' | 'error'
  duration_ms?: number
  error?: string
}

export interface AgentQueryState {
  status: 'idle' | 'running' | 'complete' | 'error'
  toolCalls: AgentToolCall[]
  thinking: string | null
  answer: string | null
  citations: InlineCitation[]
  error: string | null
}

/** SSE event types streamed from /api/agent/run */
export type AgentSSEEvent =
  | { type: 'tool_start'; tool: string; params: Record<string, unknown>; call_index: number }
  | { type: 'tool_result'; call_index: number; result: Record<string, unknown>; duration_ms: number }
  | { type: 'tool_error'; call_index: number; error: string }
  | { type: 'thinking'; text: string }
  | { type: 'answer'; text: string; citations?: InlineCitation[] }
  | { type: 'error'; message: string }
  | { type: 'done' }

export const INITIAL_AGENT_STATE: AgentQueryState = {
  status: 'idle',
  toolCalls: [],
  thinking: null,
  answer: null,
  citations: [],
  error: null,
}
