import { AgentToolChain } from './AgentToolChain'
import type { AgentQueryState } from '../../types/agent'

interface Props {
  state: AgentQueryState
}

export function AgentResponse({ state }: Props) {
  const { status, toolCalls, thinking, answer, error } = state
  const isComplete = status === 'complete'
  const isRunning = status === 'running'
  const hasToolCalls = toolCalls.length > 0
  const hasThinking = !!thinking

  return (
    <div style={{ maxWidth: 1020, margin: '0 auto', padding: '0 24px' }}>
      {/* Tool chain card */}
      {(hasToolCalls || hasThinking) && (
        <div
          style={{
            background: 'var(--color-bg-card)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 12,
            padding: '12px 16px',
            marginBottom: 12,
          }}
        >
          <AgentToolChain
            toolCalls={toolCalls}
            isComplete={isComplete}
            thinking={thinking}
          />
        </div>
      )}

      {/* Running with nothing to show yet */}
      {isRunning && !hasToolCalls && !hasThinking && (
        <p
          className="font-body"
          style={{
            fontSize: 13,
            color: 'var(--color-text-secondary)',
            fontStyle: 'italic',
            margin: 0,
          }}
        >
          Analyzing your question...
        </p>
      )}

      {/* Final answer */}
      {answer && (
        <div
          className="font-body"
          style={{
            fontSize: 14,
            lineHeight: 1.65,
            color: 'var(--color-text-primary)',
            whiteSpace: 'pre-wrap',
          }}
        >
          {answer}
        </div>
      )}

      {/* Error state */}
      {error && (
        <div
          className="font-body"
          style={{
            fontSize: 13,
            color: '#dc2626',
            background: 'rgba(220,38,38,0.05)',
            borderRadius: 8,
            padding: '10px 14px',
          }}
        >
          {error}
        </div>
      )}
    </div>
  )
}
