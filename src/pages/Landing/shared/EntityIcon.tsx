interface EntityIconProps {
  type: string
  size?: number
  color?: string
}

export function EntityIcon({ type, size = 14, color = 'currentColor' }: EntityIconProps) {
  const s = size
  switch (type) {
    case 'decision':
      return (
        <svg width={s} height={s} viewBox="0 0 16 16" fill="none" stroke={color} strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
          <path d="M13 4 L6.5 11 L3 7.5"/>
        </svg>
      )
    case 'anchor':
      return (
        <svg width={s} height={s} viewBox="0 0 16 16" fill="none" stroke={color} strokeWidth="1.4" strokeLinecap="round">
          <circle cx="8" cy="4" r="2"/>
          <path d="M8 6 L8 14"/>
          <path d="M4 10 L8 14 L12 10"/>
        </svg>
      )
    case 'risk':
      return (
        <svg width={s} height={s} viewBox="0 0 16 16" fill="none" stroke={color} strokeWidth="1.4" strokeLinejoin="round">
          <path d="M8 2 L14.5 13 H1.5 Z"/>
          <path d="M8 7 L8 9.5" strokeLinecap="round"/>
          <circle cx="8" cy="11.5" r="0.5" fill={color} stroke="none"/>
        </svg>
      )
    case 'person':
      return (
        <svg width={s} height={s} viewBox="0 0 16 16" fill="none" stroke={color} strokeWidth="1.4" strokeLinecap="round">
          <circle cx="8" cy="5" r="2.5"/>
          <path d="M3.5 14 C3.5 11 5.5 9 8 9 C10.5 9 12.5 11 12.5 14"/>
        </svg>
      )
    case 'event':
      return (
        <svg width={s} height={s} viewBox="0 0 16 16" fill="none" stroke={color} strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
          <rect x="2" y="3" width="12" height="11" rx="1.5"/>
          <path d="M5 1.5 V4.5"/>
          <path d="M11 1.5 V4.5"/>
          <path d="M2 7 H14"/>
        </svg>
      )
    default:
      return (
        <svg width={s} height={s} viewBox="0 0 16 16" fill="none" stroke={color} strokeWidth="1.4">
          <circle cx="8" cy="8" r="5"/>
        </svg>
      )
  }
}
