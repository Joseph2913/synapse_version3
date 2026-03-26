import { useState } from 'react'
import { Key, X } from 'lucide-react'
import type { ApiKey } from '../../hooks/useApiKeys'

interface ApiKeyRowProps {
  apiKey: ApiKey
  onRevoke: (id: string) => Promise<boolean>
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

function formatRelativeTime(dateStr: string): string {
  const now = Date.now()
  const then = new Date(dateStr).getTime()
  const diff = now - then
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  return `${Math.floor(days / 30)}mo ago`
}

export function ApiKeyRow({ apiKey, onRevoke }: ApiKeyRowProps) {
  const [hovered, setHovered] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [revoking, setRevoking] = useState(false)

  const handleRevoke = async () => {
    setRevoking(true)
    await onRevoke(apiKey.id)
    setRevoking(false)
    setConfirming(false)
  }

  if (confirming) {
    return (
      <div
        style={{
          padding: '12px 0',
          borderBottom: '1px solid var(--border-subtle)',
        }}
      >
        <p
          className="font-body"
          style={{ fontSize: 12, color: 'var(--color-text-primary)', marginBottom: 8 }}
        >
          Revoke this key? This cannot be undone.
        </p>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            type="button"
            onClick={() => void handleRevoke()}
            disabled={revoking}
            className="font-body font-semibold"
            style={{
              fontSize: 11,
              padding: '4px 12px',
              borderRadius: 6,
              border: 'none',
              background: '#ef4444',
              color: 'white',
              cursor: revoking ? 'not-allowed' : 'pointer',
              opacity: revoking ? 0.6 : 1,
            }}
          >
            {revoking ? 'Revoking…' : 'Revoke'}
          </button>
          <button
            type="button"
            onClick={() => setConfirming(false)}
            disabled={revoking}
            className="font-body"
            style={{
              fontSize: 11,
              padding: '4px 12px',
              borderRadius: 6,
              border: 'none',
              background: 'transparent',
              color: 'var(--color-text-secondary)',
              cursor: 'pointer',
            }}
          >
            Cancel
          </button>
        </div>
      </div>
    )
  }

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        padding: '12px 0',
        borderBottom: '1px solid var(--border-subtle)',
        position: 'relative',
      }}
    >
      {/* Top line: icon + prefix + label + revoke */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <Key
          size={14}
          style={{ color: 'var(--color-text-secondary)', flexShrink: 0 }}
        />
        <span
          className="font-body font-semibold"
          style={{ fontSize: 12, fontFamily: 'monospace', color: 'var(--color-text-primary)' }}
        >
          {apiKey.key_prefix}…
        </span>
        <span
          className="font-body"
          style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}
        >
          · {apiKey.label}
        </span>
        <div style={{ flex: 1 }} />
        <button
          type="button"
          onClick={() => setConfirming(true)}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 20,
            height: 20,
            borderRadius: 4,
            border: 'none',
            background: 'transparent',
            cursor: 'pointer',
            opacity: hovered ? 1 : 0,
            transition: 'opacity 0.15s',
            color: '#ef4444',
            flexShrink: 0,
          }}
        >
          <X size={13} />
        </button>
      </div>

      {/* Bottom line: dates */}
      <div
        className="font-body"
        style={{
          fontSize: 11,
          color: 'var(--color-text-secondary)',
          marginTop: 3,
          paddingLeft: 20,
        }}
      >
        Created {formatDate(apiKey.created_at)}
        {' · '}
        Last used: {apiKey.last_used_at ? formatRelativeTime(apiKey.last_used_at) : 'Never used'}
      </div>
    </div>
  )
}
