import { CheckCircle2 } from 'lucide-react'
import { AgentToolBlock } from './AgentToolBlock'
import type { AgentToolCall } from '../../types/agent'

interface Props {
  toolCalls: AgentToolCall[]
  isComplete: boolean
  thinking?: string | null
}

export function AgentToolChain({ toolCalls, isComplete, thinking }: Props) {
  if (toolCalls.length === 0 && !thinking) return null

  return (
    <div style={{ paddingLeft: 12, position: 'relative' }}>
      {/* Vertical line */}
      <div
        style={{
          position: 'absolute',
          left: 12,
          top: 8,
          bottom: isComplete ? 28 : 0,
          width: 2,
          background: 'var(--border-subtle)',
          borderRadius: 1,
        }}
      />

      {/* Tool blocks */}
      {toolCalls.map(tc => (
        <AgentToolBlock key={tc.index} toolCall={tc} />
      ))}

      {/* Thinking indicator (while running) */}
      {thinking && !isComplete && (
        <p
          className="font-body"
          style={{
            marginLeft: 20,
            marginTop: 6,
            fontSize: 12,
            color: 'var(--color-text-secondary)',
            fontStyle: 'italic',
            margin: '6px 0 0 20px',
          }}
        >
          {thinking}
        </p>
      )}

      {/* Done indicator */}
      {isComplete && toolCalls.length > 0 && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            marginLeft: 20,
            marginTop: 8,
          }}
        >
          <CheckCircle2 size={16} style={{ color: 'var(--color-text-secondary)', flexShrink: 0 }} />
          <span
            className="font-body"
            style={{
              fontSize: 13,
              fontWeight: 600,
              color: 'var(--color-text-secondary)',
            }}
          >
            Done
          </span>
        </div>
      )}
    </div>
  )
}
