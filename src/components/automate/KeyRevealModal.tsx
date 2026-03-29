import { useState, useEffect } from 'react'
import { KeyRound, Copy, Check } from 'lucide-react'

interface KeyRevealModalProps {
  rawKey: string
  label: string
  onConfirm: () => void
}

export function KeyRevealModal({ rawKey, label, onConfirm }: KeyRevealModalProps) {
  const [copied, setCopied] = useState(false)

  // Block ESC key from closing the modal
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
      }
    }
    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [])

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(rawKey)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Fallback: select the text manually
    }
  }

  return (
    // Backdrop — does NOT close on click, fixed to viewport
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.4)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 9999,
        padding: 16,
      }}
    >
      {/* Modal */}
      <div
        style={{
          background: 'var(--color-bg-card)',
          border: '1px solid var(--border-strong, var(--border-default))',
          borderRadius: 12,
          padding: 24,
          width: '100%',
          maxWidth: 340,
        }}
      >
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
          <KeyRound size={18} style={{ color: 'var(--color-accent-500)' }} />
          <span
            className="font-display"
            style={{ fontSize: 14, fontWeight: 700, color: 'var(--color-text-primary)' }}
          >
            API Key Created
          </span>
        </div>

        {/* Warning */}
        <p
          className="font-body"
          style={{ fontSize: 13, color: 'var(--color-text-body)', marginBottom: 16, lineHeight: 1.5 }}
        >
          Copy this key now. It will not be shown again.
        </p>

        {/* Key display */}
        <div
          style={{
            background: 'var(--color-bg-inset)',
            borderRadius: 10,
            padding: 12,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            marginBottom: 12,
          }}
        >
          <span
            className="font-body"
            style={{
              fontSize: 11,
              fontFamily: 'monospace',
              color: 'var(--color-text-primary)',
              flex: 1,
              wordBreak: 'break-all',
              lineHeight: 1.4,
            }}
          >
            {rawKey}
          </span>
          <button
            type="button"
            onClick={() => void handleCopy()}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 28,
              height: 28,
              borderRadius: 6,
              border: 'none',
              background: 'transparent',
              cursor: 'pointer',
              flexShrink: 0,
              color: copied ? '#10b981' : 'var(--color-text-secondary)',
              transition: 'color 0.15s',
            }}
          >
            {copied ? <Check size={14} /> : <Copy size={14} />}
          </button>
        </div>

        {/* Copied confirmation */}
        {copied && (
          <p
            className="font-body"
            style={{ fontSize: 11, color: '#10b981', marginBottom: 8, textAlign: 'center' }}
          >
            Copied!
          </p>
        )}

        {/* Label */}
        <p
          className="font-body"
          style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginBottom: 20 }}
        >
          Label: &ldquo;{label}&rdquo;
        </p>

        {/* Confirm button */}
        <button
          type="button"
          onClick={onConfirm}
          className="font-body font-semibold"
          style={{
            width: '100%',
            height: 36,
            borderRadius: 8,
            border: 'none',
            background: 'var(--color-accent-500)',
            color: 'white',
            fontSize: 13,
            cursor: 'pointer',
            transition: 'opacity 0.15s',
          }}
        >
          I&apos;ve copied my key
        </button>
      </div>
    </div>
  )
}
