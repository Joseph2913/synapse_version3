import { useEffect, useState } from 'react'
import { MessageSquareText } from 'lucide-react'
import { useAuth } from '../../hooks/useAuth'
import { fetchTopAnchor } from '../../services/supabase'
import { QUERY_MINDSETS } from '../../config/queryMindsets'

import type { ChatSession } from '../../services/chatHistory'

interface EmptyAskStateProps {
  onSendSuggestion: (text: string) => void
  isEmpty?: boolean
  sessions?: ChatSession[]
  onLoadSession?: (sessionId: string) => void
}

const STATIC_SUGGESTIONS = [
  'What connections exist between my recent meeting notes?',
  'What are the key risks across my active projects?',
]

function formatRelativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  if (days < 30) return `${days}d ago`
  return `${Math.floor(days / 30)}mo ago`
}

export function EmptyAskState({ onSendSuggestion, isEmpty = false, sessions = [], onLoadSession }: EmptyAskStateProps) {
  const { user } = useAuth()
  const [topAnchorLabel, setTopAnchorLabel] = useState<string | null>(null)

  useEffect(() => {
    if (!user) return
    fetchTopAnchor(user.id)
      .then(setTopAnchorLabel)
      .catch(() => setTopAnchorLabel(null))
  }, [user])

  const dynamicSuggestion = topAnchorLabel
    ? `Summarize everything I know about ${topAnchorLabel}`
    : 'What are the most important themes in my knowledge?'

  const suggestions = [STATIC_SUGGESTIONS[0] ?? '', dynamicSuggestion, STATIC_SUGGESTIONS[1] ?? '']

  if (isEmpty) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center" style={{ padding: '40px 24px' }}>
        <MessageSquareText size={48} style={{ color: 'var(--color-text-placeholder)', marginBottom: 16 }} />
        <h2
          className="font-display font-bold"
          style={{ fontSize: 18, color: 'var(--color-text-primary)', marginBottom: 8 }}
        >
          Ask your knowledge graph
        </h2>
        <p
          className="font-body"
          style={{ fontSize: 13, color: 'var(--color-text-secondary)', maxWidth: 400, lineHeight: 1.6 }}
        >
          Start by ingesting content in the Ingest view. Once you have entities and source chunks,
          you can query them here.
        </p>
      </div>
    )
  }

  return (
    <div className="flex flex-col items-center justify-center h-full text-center" style={{ padding: '40px 24px' }}>
      <MessageSquareText size={48} style={{ color: 'var(--color-text-placeholder)', marginBottom: 16 }} />
      <h2
        className="font-display font-bold"
        style={{ fontSize: 18, color: 'var(--color-text-primary)', marginBottom: 8 }}
      >
        Ask your knowledge graph
      </h2>
      <p
        className="font-body"
        style={{ fontSize: 13, color: 'var(--color-text-secondary)', maxWidth: 400, lineHeight: 1.6, marginBottom: 24 }}
      >
        Ask questions and get answers grounded in your ingested content, with source citations and
        graph context.
      </p>

      {/* Suggestion pills */}
      <div className="flex flex-col items-center" style={{ gap: 8, width: '100%', maxWidth: 440 }}>
        <span
          className="font-display font-bold uppercase"
          style={{ fontSize: 10, color: 'var(--color-text-secondary)', letterSpacing: '0.08em', marginBottom: 4 }}
        >
          Try Asking
        </span>
        {suggestions.map((suggestion, i) => (
          <button
            key={i}
            type="button"
            onClick={() => onSendSuggestion(suggestion)}
            className="w-full font-body cursor-pointer text-left"
            style={{
              fontSize: 12,
              fontWeight: 500,
              color: 'var(--color-text-body)',
              background: 'var(--color-bg-card)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 10,
              padding: '10px 16px',
              transition: 'border-color 0.15s ease',
            }}
            onMouseEnter={e => {
              (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--border-default)'
            }}
            onMouseLeave={e => {
              (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--border-subtle)'
            }}
          >
            {suggestion}
          </button>
        ))}
      </div>

      {/* Mindset showcase */}
      <div style={{ marginTop: 32, width: '100%', maxWidth: 520 }}>
        <span
          className="font-display font-bold uppercase"
          style={{ fontSize: 10, color: 'var(--color-text-secondary)', letterSpacing: '0.08em', display: 'block', marginBottom: 10 }}
        >
          Query Mindsets
        </span>
        <div className="flex" style={{ gap: 8 }}>
          {QUERY_MINDSETS.map(mindset => (
            <div
              key={mindset.id}
              className="flex-1 text-left font-body"
              style={{
                padding: '10px 12px',
                borderRadius: 10,
                background: 'var(--color-bg-card)',
                border: '1px solid var(--border-subtle)',
                borderTop: `2px solid ${mindset.color}`,
              }}
            >
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--color-text-primary)', marginBottom: 4 }}>
                {mindset.label}
              </div>
              <div style={{ fontSize: 10, fontWeight: 400, color: 'var(--color-text-secondary)', lineHeight: 1.4 }}>
                {mindset.description.split('.')[0]}.
              </div>
            </div>
          ))}
        </div>
        <p
          className="font-body"
          style={{ fontSize: 10, color: 'var(--color-text-placeholder)', marginTop: 8, textAlign: 'center' }}
        >
          Customise via the toolbar below ↓
        </p>
      </div>

      {/* Recent Conversations (PRD-D §2.8) */}
      {sessions.length > 0 && onLoadSession && (
        <div style={{ marginTop: 32, width: '100%', maxWidth: 520 }}>
          <span
            className="font-display font-bold uppercase"
            style={{
              fontSize: 10,
              color: 'var(--color-text-secondary)',
              letterSpacing: '0.08em',
              display: 'block',
              marginBottom: 10,
            }}
          >
            Recent Conversations
          </span>
          <div className="flex flex-col" style={{ gap: 6 }}>
            {sessions.map(session => (
              <button
                key={session.id}
                type="button"
                onClick={() => onLoadSession(session.id)}
                className="w-full font-body cursor-pointer text-left"
                style={{
                  fontSize: 12,
                  fontWeight: 500,
                  color: 'var(--color-text-body)',
                  background: 'var(--color-bg-card)',
                  border: '1px solid var(--border-subtle)',
                  borderRadius: 10,
                  padding: '10px 16px',
                  transition: 'border-color 0.15s ease',
                }}
                onMouseEnter={e => {
                  e.currentTarget.style.borderColor = 'var(--border-default)'
                }}
                onMouseLeave={e => {
                  e.currentTarget.style.borderColor = 'var(--border-subtle)'
                }}
              >
                <div className="flex items-center justify-between">
                  <span style={{ fontWeight: 600 }}>
                    {session.title ?? 'Untitled conversation'}
                  </span>
                  <span style={{ fontSize: 10, color: 'var(--color-text-secondary)' }}>
                    {formatRelativeTime(session.updated_at)}
                  </span>
                </div>
                <div style={{ fontSize: 11, color: 'var(--color-text-secondary)', marginTop: 2 }}>
                  {session.message_count} messages
                </div>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
