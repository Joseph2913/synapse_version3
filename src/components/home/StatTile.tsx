import { TrendingUp } from 'lucide-react'

interface StatTileProps {
  label: string
  value: number
  delta: number
}

export function StatTile({ label, value, delta }: StatTileProps) {
  const isPositive = delta > 0

  return (
    <div
      className="bg-bg-card border border-border-subtle rounded-[12px]"
      style={{ padding: '20px 24px' }}
    >
      <div
        className="font-body text-text-secondary uppercase"
        style={{ fontSize: 11, fontWeight: 500, letterSpacing: '0.06em', marginBottom: 10 }}
      >
        {label}
      </div>
      <div
        className="font-display text-text-primary"
        style={{ fontSize: 32, fontWeight: 800, letterSpacing: '-0.03em', lineHeight: 1, marginBottom: 8 }}
      >
        {value.toLocaleString()}
      </div>
      {isPositive ? (
        <div
          className="flex items-center"
          style={{ gap: 4, fontSize: 12, fontWeight: 600, color: 'var(--color-e-project)' }}
        >
          <TrendingUp size={12} />
          <span>+{delta} this week</span>
        </div>
      ) : (
        <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--color-text-secondary)' }}>
          0 this week
        </div>
      )}
    </div>
  )
}
