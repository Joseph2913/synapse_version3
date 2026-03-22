import { useEffect, useState } from 'react'
import { RotateCcw } from 'lucide-react'
import { useAuth } from '../../hooks/useAuth'
import { getGraphStats } from '../../services/supabase'

interface StatusBarProps {
  hasError?: boolean
  hasMessages?: boolean
  onClearChat?: () => void
  contextLabel?: string
}

export function StatusBar({ hasError = false, hasMessages = false, onClearChat, contextLabel }: StatusBarProps) {
  const { user } = useAuth()
  const [stats, setStats] = useState<{ nodeCount: number; chunkCount: number } | null>(null)

  useEffect(() => {
    if (!user) return
    getGraphStats(user.id)
      .then(s => setStats({ nodeCount: s.nodeCount, chunkCount: s.chunkCount }))
      .catch(err => console.warn('[StatusBar] Failed to fetch stats:', err))
  }, [user])

  const isEmpty = stats !== null && stats.nodeCount === 0
  const dotColor = hasError ? '#f59e0b' : isEmpty ? 'var(--color-text-secondary)' : '#10b981'
  const pulseSpeed = hasError ? '1s' : '2s'

  const label = hasError
    ? 'RAG Degraded — Check connection'
    : isEmpty
    ? 'No knowledge yet — ingest content to start querying'
    : 'Graph RAG Active'

  return (
    <div
      className="shrink-0 flex items-center font-body"
      style={{
        height: 44,
        padding: '0 24px',
        background: 'var(--color-bg-card)',
        borderBottom: '1px solid var(--border-subtle)',
        gap: 8,
      }}
    >
      <style>{`
        @keyframes rag-pulse {
          0% { opacity: 1 }
          50% { opacity: 0.6 }
          100% { opacity: 1 }
        }
      `}</style>

      <div
        style={{
          width: 7,
          height: 7,
          borderRadius: '50%',
          background: dotColor,
          animation: `rag-pulse ${pulseSpeed} ease infinite`,
          flexShrink: 0,
        }}
      />

      <span
        className="font-body font-semibold"
        style={{ fontSize: 12, color: 'var(--color-text-primary)' }}
      >
        {label}
      </span>

      {stats && !isEmpty && !hasError && (
        <span style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
          · {stats.nodeCount.toLocaleString()} nodes · {stats.chunkCount.toLocaleString()} chunks
        </span>
      )}

      {contextLabel && (
        <span
          className="font-body"
          style={{
            fontSize: 11,
            fontWeight: 500,
            color: 'var(--color-text-secondary)',
            marginLeft: 'auto',
            maxWidth: 300,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {contextLabel}
        </span>
      )}

      {hasMessages && onClearChat && (
        <button
          type="button"
          onClick={onClearChat}
          className="font-body font-semibold cursor-pointer flex items-center"
          style={{
            gap: 5,
            fontSize: 12,
            color: 'var(--color-text-secondary)',
            background: 'none',
            border: '1px solid var(--border-subtle)',
            borderRadius: 20,
            padding: '5px 13px',
            marginLeft: contextLabel ? undefined : 'auto',
            cursor: 'pointer',
            transition: 'color 0.15s ease, border-color 0.15s ease',
          }}
          onMouseEnter={e => {
            const el = e.currentTarget as HTMLButtonElement
            el.style.color = 'var(--color-text-primary)'
            el.style.borderColor = 'var(--border-default)'
          }}
          onMouseLeave={e => {
            const el = e.currentTarget as HTMLButtonElement
            el.style.color = 'var(--color-text-secondary)'
            el.style.borderColor = 'var(--border-subtle)'
          }}
        >
          <RotateCcw size={11} />
          New chat
        </button>
      )}
    </div>
  )
}
