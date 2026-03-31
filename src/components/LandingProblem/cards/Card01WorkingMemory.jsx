export default function Card01WorkingMemory() {
  const rows = [
    { dot: 1.0, label: 'Follow up with Sarah re: Q2 strategy', labelColor: '#B5AFA8', badge: 'UNRESOLVED', badgeBg: 'rgba(232,98,42,0.18)', badgeColor: '#E8622A' },
    { dot: 0.55, label: 'Framework from Thursday\'s call', labelColor: '#857D78', badge: 'FADING', badgeBg: 'rgba(255,255,255,0.06)', badgeColor: '#6B6560' },
    { dot: 0.35, label: 'Insight: pricing model pattern', labelColor: '#6B6560', badge: 'AT RISK', badgeBg: 'rgba(255,255,255,0.06)', badgeColor: '#6B6560' },
    { dot: 0, label: '3 more items suppressed...', labelColor: '#3A3830', badge: 'OVERFLOW', badgeBg: 'rgba(255,255,255,0.03)', badgeColor: '#3A3830', italic: true },
  ];

  return (
    <svg viewBox="0 0 460 300" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ width: '100%', height: '100%' }}>
      <rect width="460" height="300" rx="12" fill="#1C1B14" />

      {/* Header */}
      <text x="20" y="28" fontFamily="'JetBrains Mono', monospace" fontSize="10" fill="#6B6560" fontWeight="500">WORKING_MEMORY</text>
      <rect x="340" y="14" width="100" height="20" rx="10" fill="rgba(232,98,42,0.18)" />
      <text x="390" y="27" fontFamily="'JetBrains Mono', monospace" fontSize="9" fill="#E8622A" fontWeight="500" textAnchor="middle">&#9888; NEAR LIMIT</text>

      {/* Progress bar */}
      <rect x="20" y="46" width="420" height="10" rx="5" fill="rgba(255,255,255,0.06)" />
      <rect x="20" y="46" width="395" height="10" rx="5" fill="#E8622A" />

      <text x="230" y="74" fontFamily="'JetBrains Mono', monospace" fontSize="10" fill="#E8622A" textAnchor="middle" fontWeight="500">94% capacity used</text>

      {/* Divider */}
      <line x1="20" y1="86" x2="440" y2="86" stroke="rgba(255,255,255,0.07)" strokeWidth="1" />

      {/* OPEN_LOOPS label */}
      <text x="20" y="104" fontFamily="'JetBrains Mono', monospace" fontSize="10" fill="#6B6560" fontWeight="500">OPEN_LOOPS</text>

      {/* Rows */}
      {rows.map((row, i) => {
        const y = 124 + i * 40;
        return (
          <g key={i}>
            <circle cx="30" cy={y} r="5" fill={row.dot === 0 ? '#2A2820' : '#E8622A'} opacity={row.dot || 0.15} />
            <text
              x="44"
              y={y + 4}
              fontFamily="'JetBrains Mono', monospace"
              fontSize="10.5"
              fill={row.labelColor}
              fontStyle={row.italic ? 'italic' : 'normal'}
            >
              {row.label}
            </text>
            <rect x="360" y={y - 10} width="80" height="20" rx="10" fill={row.badgeBg} />
            <text x="400" y={y + 3} fontFamily="'JetBrains Mono', monospace" fontSize="8" fill={row.badgeColor} textAnchor="middle" fontWeight="500">{row.badge}</text>
            {i < rows.length - 1 && (
              <line x1="20" y1={y + 20} x2="440" y2={y + 20} stroke="rgba(255,255,255,0.05)" strokeWidth="1" />
            )}
          </g>
        );
      })}

      {/* Bottom stats */}
      <text x="20" y="288" fontFamily="'JetBrains Mono', monospace" fontSize="10" fill="#E8622A" fontWeight="500">AVAILABLE_COMPUTE: 6%</text>
      <text x="440" y="288" fontFamily="'JetBrains Mono', monospace" fontSize="10" fill="#E8622A" fontWeight="500" textAnchor="end">LAST_OFFLOADED: NEVER</text>
    </svg>
  );
}
