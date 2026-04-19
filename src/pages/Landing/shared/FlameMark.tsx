interface FlameMarkProps {
  size?: number
  color?: string
  style?: React.CSSProperties
}

export function FlameMark({ size = 20, color, style }: FlameMarkProps) {
  return (
    <svg width={size} height={size * 1.4} viewBox="0 0 200 280" style={style} aria-hidden="true">
      <defs>
        <linearGradient id={`fm-main-${size}`} x1="0.5" y1="1" x2="0.5" y2="0">
          <stop offset="0%" stopColor="#8B2500"/>
          <stop offset="30%" stopColor="#c23400"/>
          <stop offset="60%" stopColor={color || '#d63a00'}/>
          <stop offset="100%" stopColor="#f06830"/>
        </linearGradient>
        <linearGradient id={`fm-left-${size}`} x1="0" y1="0.3" x2="1" y2="0.7">
          <stop offset="0%" stopColor="#a62e00"/><stop offset="100%" stopColor="#c23400"/>
        </linearGradient>
        <linearGradient id={`fm-right-${size}`} x1="1" y1="0.3" x2="0" y2="0.7">
          <stop offset="0%" stopColor="#e04a10"/><stop offset="100%" stopColor="#d63a00"/>
        </linearGradient>
      </defs>
      <g transform="translate(100,140)">
        <polygon points="0,-130 -52,20 -30,60 0,-40" fill={`url(#fm-left-${size})`}/>
        <polygon points="0,-130 52,20 30,60 0,-40" fill={`url(#fm-right-${size})`}/>
        <polygon points="-52,20 -30,60 -48,100 -60,60" fill="#9a2800"/>
        <polygon points="52,20 30,60 48,100 60,60" fill="#b83200"/>
        <polygon points="-30,60 30,60 48,100 0,130 -48,100" fill="#8B2500"/>
        <polygon points="0,-130 -30,60 0,20 30,60" fill={`url(#fm-main-${size})`}/>
        <polygon points="0,-80 -16,30 0,10 16,30" fill="#ff8044" opacity="0.5"/>
      </g>
    </svg>
  )
}
