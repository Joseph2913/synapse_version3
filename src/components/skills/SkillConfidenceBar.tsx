interface SkillConfidenceBarProps {
  confidence: number
  variant: 'compact' | 'full'
}

function getConfidenceColor(confidence: number): string {
  if (confidence < 0.40) return '#808080'
  if (confidence < 0.60) return '#3b82f6'
  if (confidence < 0.80) return '#10b981'
  return '#d63a00'
}

export function SkillConfidenceBar({ confidence, variant }: SkillConfidenceBarProps) {
  const pct = Math.round(confidence * 100)
  const color = getConfidenceColor(confidence)

  if (variant === 'compact') {
    return (
      <div className="flex flex-col items-end">
        <span className="font-body font-semibold" style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>
          {pct}%
        </span>
        <div style={{ width: 48, height: 3, borderRadius: 2, backgroundColor: 'var(--color-bg-inset)', marginTop: 4 }}>
          <div
            style={{
              width: `${pct}%`,
              height: '100%',
              borderRadius: 2,
              backgroundColor: color,
              transition: 'width 0.3s ease',
            }}
          />
        </div>
      </div>
    )
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <span
          className="font-display font-bold uppercase tracking-[0.06em]"
          style={{ fontSize: 10, color: 'var(--color-text-secondary)' }}
        >
          Confidence
        </span>
        <span className="font-display font-extrabold" style={{ fontSize: 18, color }}>
          {pct}%
        </span>
      </div>
      <div style={{ width: '100%', height: 6, borderRadius: 6, backgroundColor: 'var(--color-bg-inset)' }}>
        <div
          style={{
            width: `${pct}%`,
            height: '100%',
            borderRadius: 6,
            backgroundColor: color,
            transition: 'width 0.3s ease',
          }}
        />
      </div>
    </div>
  )
}
