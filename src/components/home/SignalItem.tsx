import { Dot } from '../ui/Dot'

interface SignalItemProps {
  label: string
  entityType: string
  connectionCount?: number
  status?: 'active' | 'suggested' | 'dormant'
  onClick: () => void
}

const STATUS_COLORS: Record<string, { bg: string; text: string; border: string }> = {
  active: { bg: 'rgba(5,150,105,0.08)', text: '#059669', border: 'rgba(5,150,105,0.16)' },
  suggested: { bg: 'var(--color-accent-50)', text: 'var(--color-accent-500)', border: 'rgba(214,58,0,0.15)' },
  dormant: { bg: 'rgba(0,0,0,0.04)', text: 'var(--color-text-secondary)', border: 'var(--border-subtle)' },
}

export function SignalItem({ label, entityType, connectionCount, status, onClick }: SignalItemProps) {
  const colors = STATUS_COLORS[status ?? 'dormant'] ?? { bg: 'rgba(0,0,0,0.04)', text: 'var(--color-text-secondary)', border: 'var(--border-subtle)' }

  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center w-full text-left bg-transparent cursor-pointer hover:bg-bg-hover transition-all duration-150 border-none"
      style={{ gap: 12, padding: '12px 22px', borderBottom: '1px solid var(--border-subtle)' }}
    >
      <Dot type={entityType} size={9} />
      <span
        className="font-body text-text-primary flex-1 truncate"
        style={{ fontSize: 14, fontWeight: 600, letterSpacing: '-0.01em' }}
      >
        {label}
      </span>
      {connectionCount !== undefined && (
        <span className="font-body text-text-secondary" style={{ fontSize: 12, fontWeight: 500, marginRight: 6 }}>
          {connectionCount}
        </span>
      )}
      {status && (
        <span
          style={{
            fontSize: 10,
            fontWeight: 700,
            padding: '3px 8px',
            borderRadius: 4,
            background: colors.bg,
            color: colors.text,
            border: `1px solid ${colors.border}`,
            textTransform: 'uppercase',
            letterSpacing: '0.03em',
          }}
        >
          {status}
        </span>
      )}
    </button>
  )
}
