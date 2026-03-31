interface SkillExposureBadgeProps {
  level: 'novice' | 'developing' | 'proficient' | 'advanced'
  size?: 'sm' | 'md'
}

type ExposureLevel = 'novice' | 'developing' | 'proficient' | 'advanced'

const EXPOSURE_COLORS: Record<ExposureLevel, { bg: string; border: string; text: string; dot: string }> = {
  novice:     { bg: 'rgba(128,128,128,0.08)', border: 'rgba(128,128,128,0.16)', text: '#808080', dot: '#808080' },
  developing: { bg: 'rgba(59,130,246,0.08)',  border: 'rgba(59,130,246,0.16)',  text: '#2563eb', dot: '#3b82f6' },
  proficient: { bg: 'rgba(16,185,129,0.08)',  border: 'rgba(16,185,129,0.16)',  text: '#059669', dot: '#10b981' },
  advanced:   { bg: 'rgba(214,58,0,0.08)',    border: 'rgba(214,58,0,0.16)',    text: '#d63a00', dot: '#d63a00' },
}

export function SkillExposureBadge({ level, size = 'sm' }: SkillExposureBadgeProps) {
  const colors = EXPOSURE_COLORS[level] ?? EXPOSURE_COLORS.novice
  const fontSize = size === 'sm' ? 10 : 11

  return (
    <span
      className="inline-flex items-center gap-1.5 font-body font-semibold capitalize"
      style={{
        fontSize,
        padding: '4px 8px',
        borderRadius: 20,
        backgroundColor: colors.bg,
        border: `1px solid ${colors.border}`,
        color: colors.text,
        lineHeight: 1,
      }}
    >
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: '50%',
          backgroundColor: colors.dot,
          flexShrink: 0,
        }}
      />
      {level}
    </span>
  )
}
