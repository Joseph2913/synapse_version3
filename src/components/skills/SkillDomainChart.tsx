import type { Skill } from '../../hooks/useSkills'

const DOMAIN_COLORS: Record<string, string> = {
  technical:      'rgba(59,130,246,0.7)',
  consulting:     'rgba(16,185,129,0.7)',
  strategic:      'rgba(124,58,237,0.7)',
  interpersonal:  'rgba(245,158,11,0.7)',
  domain_specific:'rgba(249,115,22,0.7)',
}

const DOMAIN_LABELS: Record<string, string> = {
  technical:      'Technical',
  consulting:     'Consulting',
  strategic:      'Strategic',
  interpersonal:  'Interpersonal',
  domain_specific:'Domain Expert',
}

interface SkillDomainChartProps {
  skills: Skill[]
}

export function SkillDomainChart({ skills }: SkillDomainChartProps) {
  const counts: Record<string, number> = {}
  for (const s of skills) {
    counts[s.domain] = (counts[s.domain] ?? 0) + 1
  }

  const domains = Object.keys(DOMAIN_LABELS)
  const maxCount = Math.max(...domains.map(d => counts[d] ?? 0), 1)
  const total = skills.length || 1

  return (
    <div className="flex flex-col" style={{ gap: 8 }}>
      {domains.map(domain => {
        const count = counts[domain] ?? 0
        const pct = Math.round((count / total) * 100)
        const barWidth = (count / maxCount) * 100

        return (
          <div key={domain} className="flex items-center" style={{ gap: 8 }}>
            <span
              className="font-body font-semibold shrink-0"
              style={{ fontSize: 11, color: 'var(--color-text-primary)', width: 80 }}
            >
              {DOMAIN_LABELS[domain]}
            </span>
            <div
              style={{
                flex: 1,
                height: 6,
                borderRadius: 6,
                background: 'var(--color-bg-inset)',
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  width: `${barWidth}%`,
                  height: '100%',
                  borderRadius: 6,
                  background: DOMAIN_COLORS[domain] ?? 'var(--color-accent-500)',
                  transition: 'width 0.6s ease',
                }}
              />
            </div>
            <span
              className="font-body font-semibold shrink-0"
              style={{ fontSize: 10, color: 'var(--color-text-secondary)', width: 28, textAlign: 'right' }}
            >
              {count}
            </span>
            <span
              className="font-body shrink-0"
              style={{ fontSize: 10, color: 'var(--color-text-secondary)', width: 36, textAlign: 'right' }}
            >
              ({pct}%)
            </span>
          </div>
        )
      })}
    </div>
  )
}
