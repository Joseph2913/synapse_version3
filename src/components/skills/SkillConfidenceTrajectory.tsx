import type { SkillWithSources } from '../../hooks/useSkills'

interface SkillConfidenceTrajectoryProps {
  skill: SkillWithSources
}

function getConfidenceColor(confidence: number): string {
  if (confidence < 0.40) return '#808080'
  if (confidence < 0.60) return '#3b82f6'
  if (confidence < 0.80) return '#10b981'
  return '#d63a00'
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

const CONTRIBUTION_LABELS: Record<string, string> = {
  created:    'Created',
  reinforced: 'Reinforced',
  upgraded:   'Upgraded',
  corrected:  'Corrected',
}

export function SkillConfidenceTrajectory({ skill }: SkillConfidenceTrajectoryProps) {
  const events = skill.contributing_sources

  if (!events || events.length < 2) {
    return (
      <p
        className="font-body"
        style={{ fontSize: 11, color: 'var(--color-text-secondary)', fontStyle: 'italic' }}
      >
        Trajectory builds as more sources reinforce this skill
      </p>
    )
  }

  const current = skill.confidence
  const n = events.length
  // Linearly approximate confidence from 40% of current up to current
  const startConf = Math.max(0.1, current * 0.4)

  const points = events.map((ev, i) => ({
    ...ev,
    confidence: i === n - 1
      ? current
      : startConf + ((current - startConf) * i) / Math.max(n - 1, 1),
  }))

  const SVG_W = 600
  const SVG_H = 80
  const PAD_X = 30
  const LINE_Y = 30
  const xStep = n > 1 ? (SVG_W - PAD_X * 2) / (n - 1) : 0

  const dots = points.map((p, i) => ({
    x: PAD_X + i * xStep,
    y: LINE_Y,
    confidence: p.confidence,
    contribution: p.contribution,
    created_at: p.created_at,
  }))

  return (
    <div style={{ width: '100%', overflowX: 'auto' }}>
      <svg
        viewBox={`0 0 ${SVG_W} ${SVG_H}`}
        style={{ width: '100%', height: SVG_H, display: 'block' }}
        xmlns="http://www.w3.org/2000/svg"
      >
        {/* Segment lines between dots */}
        {dots.map((dot, i) => {
          if (i === 0) return null
          const prev = dots[i - 1]
          if (!prev) return null
          return (
            <line
              key={`seg-${i}`}
              x1={prev.x} y1={LINE_Y}
              x2={dot.x}  y2={LINE_Y}
              stroke="rgba(214,58,0,0.3)"
              strokeWidth={2}
            />
          )
        })}

        {/* Dots */}
        {dots.map((dot, i) => (
          <g key={`dot-${i}`}>
            <circle
              cx={dot.x}
              cy={dot.y}
              r={6}
              fill={getConfidenceColor(dot.confidence)}
            />
            {/* Confidence value above dot */}
            <text
              x={dot.x}
              y={dot.y - 12}
              textAnchor="middle"
              fontSize={9}
              fontFamily="var(--font-body)"
              fontWeight={600}
              fill="var(--color-text-secondary)"
            >
              {Math.round(dot.confidence * 100)}%
            </text>
            {/* Event type below dot */}
            <text
              x={dot.x}
              y={dot.y + 18}
              textAnchor="middle"
              fontSize={9}
              fontFamily="var(--font-body)"
              fontWeight={600}
              fill="var(--color-text-secondary)"
            >
              {CONTRIBUTION_LABELS[dot.contribution] ?? dot.contribution}
            </text>
            {/* Date */}
            <text
              x={dot.x}
              y={dot.y + 29}
              textAnchor="middle"
              fontSize={9}
              fontFamily="var(--font-body)"
              fill="var(--color-text-secondary)"
            >
              {formatDate(dot.created_at)}
            </text>
          </g>
        ))}
      </svg>
    </div>
  )
}
