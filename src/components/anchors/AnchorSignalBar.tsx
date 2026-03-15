import type { VelocityDirection } from '../../types/anchors'

interface AnchorSignalBarProps {
  centralityScore: number
  diversityScore: number
  velocityScore: number
  richnessScore: number
  velocityDirection: VelocityDirection
}

function getBarColor(score: number): string {
  if (score >= 0.7) return '#22c55e'
  if (score >= 0.4) return '#f59e0b'
  return '#ef4444'
}

const SIGNAL_DESCRIPTIONS: Record<string, string> = {
  Centrality: 'How structurally important this concept is in your graph',
  Diversity: 'How many different sources and content types mention this',
  Velocity: 'How recently active and whether momentum is building',
  Richness: 'How many different types of relationships this participates in',
}

function SignalRow({
  label,
  score,
  suffix,
}: {
  label: string
  score: number
  suffix?: React.ReactNode
}) {
  const pct = Math.round(score * 100)
  return (
    <div style={{ marginBottom: 8 }}>
      <div className="flex items-center gap-2">
        <span
          className="font-display font-bold uppercase shrink-0"
          style={{ fontSize: 9, letterSpacing: '0.08em', color: 'var(--color-text-secondary)', width: 72 }}
        >
          {label}
        </span>
        <div className="flex-1" style={{ height: 4, background: 'var(--color-bg-inset)', borderRadius: 2 }}>
          <div style={{ height: 4, borderRadius: 2, width: `${pct}%`, background: getBarColor(score), transition: 'width 0.3s ease' }} />
        </div>
        <span className="font-body shrink-0" style={{ fontSize: 10, fontWeight: 600, color: 'var(--color-text-body)', width: 32, textAlign: 'right' }}>
          {score.toFixed(2)}
        </span>
        {suffix && <span className="shrink-0" style={{ width: 12 }}>{suffix}</span>}
      </div>
      <div className="font-body" style={{ fontSize: 10, color: 'var(--color-text-secondary)', marginTop: 2, paddingLeft: 0 }}>
        {SIGNAL_DESCRIPTIONS[label]}
      </div>
    </div>
  )
}

export function AnchorSignalBar({ centralityScore, diversityScore, velocityScore, richnessScore, velocityDirection }: AnchorSignalBarProps) {
  const velocitySuffix = velocityDirection === 'rising'
    ? <span style={{ color: '#22c55e', fontSize: 11 }}>↑</span>
    : velocityDirection === 'falling'
      ? <span style={{ color: '#ef4444', fontSize: 11 }}>↓</span>
      : null

  return (
    <div>
      <SignalRow label="Centrality" score={centralityScore} />
      <SignalRow label="Diversity" score={diversityScore} />
      <SignalRow label="Velocity" score={velocityScore} suffix={velocitySuffix} />
      <SignalRow label="Richness" score={richnessScore} />
    </div>
  )
}
