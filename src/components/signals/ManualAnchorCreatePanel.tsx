import { useState } from 'react'
import { ArrowRight, FileText, Settings2, X } from 'lucide-react'

interface ManualAnchorCreatePanelProps {
  onClose: () => void
  onCreate: (input: { title: string; description: string; settings: string }) => Promise<void>
  onUseExisting?: () => void
}

const INPUT_STYLE: React.CSSProperties = {
  width: '100%',
  borderRadius: 10,
  border: '1px solid var(--border-subtle)',
  background: 'var(--color-bg-inset)',
  color: 'var(--color-text-body)',
  fontSize: 13,
  outline: 'none',
  padding: '10px 12px',
  boxSizing: 'border-box',
}

function SectionTitle({
  icon,
  label,
  hint,
}: {
  icon: React.ReactNode
  label: string
  hint: string
}) {
  return (
    <div style={{ marginBottom: 8 }}>
      <div className="flex items-center gap-2" style={{ marginBottom: 4 }}>
        {icon}
        <span className="font-body" style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text-primary)' }}>
          {label}
        </span>
      </div>
      <p className="font-body" style={{ fontSize: 11, color: 'var(--color-text-secondary)', margin: 0, lineHeight: 1.5 }}>
        {hint}
      </p>
    </div>
  )
}

export function ManualAnchorCreatePanel({
  onClose,
  onCreate,
  onUseExisting,
}: ManualAnchorCreatePanelProps) {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [settings, setSettings] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const canSave = title.trim().length > 0 && description.trim().length > 0 && !saving

  const handleSubmit = async () => {
    if (!canSave) return
    setSaving(true)
    setError(null)
    try {
      await onCreate({
        title: title.trim(),
        description: description.trim(),
        settings: settings.trim(),
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create anchor.')
      setSaving(false)
    }
  }

  return (
    <div style={{ height: '100%', overflowY: 'auto', padding: '24px 20px' }}>
      <div className="flex items-start justify-between gap-4" style={{ marginBottom: 18 }}>
        <div>
          <h2 className="font-display" style={{ fontSize: 18, fontWeight: 700, color: 'var(--color-text-primary)', margin: 0 }}>
            Add Manual Anchor
          </h2>
          <p className="font-body" style={{ fontSize: 12, color: 'var(--color-text-secondary)', margin: '6px 0 0 0', lineHeight: 1.55 }}>
            Define an anchor directly from Signals. This creates a dedicated anchor node and stores your notes with it.
          </p>
        </div>

        <button
          type="button"
          onClick={onClose}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-text-secondary)', padding: 4 }}
        >
          <X size={16} />
        </button>
      </div>

      <div
        style={{
          background: 'var(--color-bg-card)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 12,
          padding: '16px 18px',
          marginBottom: 14,
        }}
      >
        <SectionTitle
          icon={<span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--color-accent-500)', display: 'block' }} />}
          label="Anchor Name"
          hint="Use a concise label that should appear in the Signals list and the knowledge graph."
        />
        <input
          type="text"
          value={title}
          onChange={event => setTitle(event.target.value)}
          placeholder="e.g. Client Delivery Operating System"
          className="font-body"
          style={INPUT_STYLE}
        />
      </div>

      <div
        style={{
          background: 'var(--color-bg-card)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 12,
          padding: '16px 18px',
          marginBottom: 14,
        }}
      >
        <SectionTitle
          icon={<FileText size={14} style={{ color: 'var(--color-accent-500)' }} />}
          label="Anchor Description"
          hint="Describe what this anchor represents, why it matters, and what kinds of information should map back to it."
        />
        <textarea
          value={description}
          onChange={event => setDescription(event.target.value)}
          rows={6}
          placeholder="Summarize the domain, intent, or recurring theme this anchor should capture."
          className="font-body"
          style={{ ...INPUT_STYLE, resize: 'vertical', lineHeight: 1.6 }}
        />
      </div>

      <div
        style={{
          background: 'var(--color-bg-card)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 12,
          padding: '16px 18px',
          marginBottom: 14,
        }}
      >
        <SectionTitle
          icon={<Settings2 size={14} style={{ color: 'var(--color-accent-500)' }} />}
          label="Settings and Notes"
          hint="Capture the operating rules, boundaries, reminders, or any other relevant configuration tied to this anchor."
        />
        <textarea
          value={settings}
          onChange={event => setSettings(event.target.value)}
          rows={8}
          placeholder="Add the specific settings or context that should live with this anchor."
          className="font-body"
          style={{ ...INPUT_STYLE, resize: 'vertical', lineHeight: 1.6 }}
        />
      </div>

      {error && (
        <div
          style={{
            background: 'rgba(239,68,68,0.06)',
            border: '1px solid rgba(239,68,68,0.18)',
            borderRadius: 10,
            padding: '10px 12px',
            marginBottom: 14,
          }}
        >
          <p className="font-body" style={{ margin: 0, fontSize: 12, color: 'var(--semantic-red-500, #ef4444)' }}>
            {error}
          </p>
        </div>
      )}

      {onUseExisting && (
        <button
          type="button"
          onClick={onUseExisting}
          className="font-body"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            marginBottom: 18,
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
            color: 'var(--color-accent-500)',
            fontSize: 12,
            fontWeight: 600,
            padding: 0,
          }}
        >
          Promote an existing node instead
          <ArrowRight size={12} />
        </button>
      )}

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => void handleSubmit()}
          disabled={!canSave}
          className="font-body"
          style={{
            background: canSave ? 'var(--color-accent-500)' : 'var(--color-bg-inset)',
            color: canSave ? '#fff' : 'var(--color-text-secondary)',
            fontSize: 12,
            fontWeight: 600,
            padding: '9px 18px',
            borderRadius: 8,
            border: 'none',
            cursor: canSave ? 'pointer' : 'not-allowed',
            opacity: saving ? 0.8 : 1,
          }}
        >
          {saving ? 'Creating…' : 'Create Anchor'}
        </button>

        <button
          type="button"
          onClick={onClose}
          className="font-body"
          style={{
            background: 'transparent',
            color: 'var(--color-text-secondary)',
            fontSize: 12,
            fontWeight: 600,
            padding: '9px 14px',
            borderRadius: 8,
            border: 'none',
            cursor: 'pointer',
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  )
}
