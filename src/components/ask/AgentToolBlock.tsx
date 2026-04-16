import { useState } from 'react'
import { Search, FileText, Database, Loader2, AlertCircle } from 'lucide-react'
import type { AgentToolCall } from '../../types/agent'

const TOOL_LABELS: Record<string, string> = {
  search_entities: 'Search entities',
  search_sources: 'Search sources',
  search_skills: 'Search skills',
  ask_synapse: 'Ask Synapse',
  get_source_content: 'Get source content',
  get_meeting_brief: 'Get meeting brief',
  get_meeting_notes: 'Get meeting notes',
  get_meeting_transcript: 'Get meeting transcript',
  get_skill_content: 'Get skill content',
  get_entity: 'Get entity',
  get_connections: 'Get connections',
  get_related_sources: 'Get related sources',
  get_recent_sources: 'Get recent sources',
  get_skills: 'Get skills',
  list_anchors: 'List anchors',
  consult_council: 'Consult council',
  send_to_synapse: 'Send to Synapse',
}

const SEARCH_TOOLS = new Set(['search_entities', 'search_sources', 'search_skills', 'ask_synapse'])
const CONTENT_TOOLS = new Set([
  'get_source_content',
  'get_meeting_brief',
  'get_meeting_notes',
  'get_meeting_transcript',
  'get_skill_content',
])

function getToolIcon(tool: string) {
  if (SEARCH_TOOLS.has(tool)) return Search
  if (CONTENT_TOOLS.has(tool)) return FileText
  return Database
}

interface Props {
  toolCall: AgentToolCall
}

export function AgentToolBlock({ toolCall }: Props) {
  const [expanded, setExpanded] = useState(false)

  const Icon = getToolIcon(toolCall.tool)
  const label = TOOL_LABELS[toolCall.tool] ?? toolCall.tool
  const isRunning = toolCall.status === 'running'
  const isError = toolCall.status === 'error'

  return (
    <div style={{ marginLeft: 20, marginBottom: 6 }}>
      {/* Collapsed row — always visible */}
      <button
        onClick={() => setExpanded(prev => !prev)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          background: 'none',
          border: 'none',
          padding: 0,
          cursor: 'pointer',
          width: '100%',
          textAlign: 'left',
        }}
      >
        {/* Icon container */}
        <div
          style={{
            width: 24,
            height: 24,
            borderRadius: 6,
            background: 'var(--color-bg-inset)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
          }}
        >
          {isRunning ? (
            <Loader2
              size={13}
              style={{ color: 'var(--color-text-secondary)', animation: 'spin 1s linear infinite' }}
              className="animate-spin"
            />
          ) : isError ? (
            <AlertCircle size={13} style={{ color: 'var(--color-error, #dc2626)' }} />
          ) : (
            <Icon size={13} style={{ color: 'var(--color-text-secondary)' }} />
          )}
        </div>

        {/* Tool label */}
        <span
          className="font-body"
          style={{
            fontSize: 13,
            fontWeight: 500,
            color: 'var(--color-text-primary)',
            flex: 1,
          }}
        >
          {label}
        </span>

        {/* Status badge */}
        {!isRunning && (
          <span
            className="font-body"
            style={{
              fontSize: 11,
              fontWeight: 600,
              padding: '2px 7px',
              borderRadius: 20,
              background: isError ? 'rgba(220,38,38,0.08)' : 'var(--color-bg-inset)',
              color: isError ? '#dc2626' : 'var(--color-text-secondary)',
              flexShrink: 0,
            }}
          >
            {isError ? 'Error' : 'Result'}
          </span>
        )}
      </button>

      {/* Expanded state */}
      {expanded && (
        <div
          style={{
            marginTop: 6,
            borderRadius: 10,
            border: '1px solid var(--border-subtle)',
            background: 'var(--color-bg-card)',
            overflow: 'hidden',
          }}
        >
          {/* Request section */}
          <div style={{ padding: '10px 12px' }}>
            <div
              className="font-body"
              style={{
                fontSize: 11,
                fontWeight: 600,
                color: 'var(--color-text-secondary)',
                marginBottom: 6,
                textTransform: 'uppercase',
                letterSpacing: '0.04em',
              }}
            >
              Request
            </div>
            <pre
              className="font-mono"
              style={{
                fontSize: 12,
                color: 'var(--color-text-primary)',
                margin: 0,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
            >
              {JSON.stringify(toolCall.params, null, 2)}
            </pre>
          </div>

          {/* Divider */}
          <div style={{ height: 1, background: 'var(--border-subtle)' }} />

          {/* Response section */}
          <div style={{ padding: '10px 12px' }}>
            <div
              className="font-body"
              style={{
                fontSize: 11,
                fontWeight: 600,
                color: 'var(--color-text-secondary)',
                marginBottom: 6,
                textTransform: 'uppercase',
                letterSpacing: '0.04em',
              }}
            >
              Response
            </div>
            {isError ? (
              <p
                className="font-body"
                style={{ fontSize: 12, color: '#dc2626', margin: 0 }}
              >
                {toolCall.error ?? 'An error occurred.'}
              </p>
            ) : toolCall.result !== null ? (
              <div style={{ maxHeight: 300, overflowY: 'auto' }}>
                <pre
                  className="font-mono"
                  style={{
                    fontSize: 12,
                    color: 'var(--color-text-primary)',
                    margin: 0,
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                  }}
                >
                  {JSON.stringify(toolCall.result, null, 2)}
                </pre>
              </div>
            ) : (
              <p
                className="font-body"
                style={{ fontSize: 12, color: 'var(--color-text-secondary)', margin: 0 }}
              >
                No result yet.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
