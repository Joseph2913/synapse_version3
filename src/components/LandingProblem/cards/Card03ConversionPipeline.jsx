export default function Card03ConversionPipeline() {
  const breakdown = [
    { label: 'VIDEOS', value: '34' },
    { label: 'DOCUMENTS', value: '12' },
    { label: 'MEETINGS', value: '28' },
    { label: 'ARTICLES', value: '61' },
    { label: 'HIGHLIGHTS', value: '712' },
  ];

  return (
    <svg viewBox="0 0 460 300" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ width: '100%', height: '100%' }}>
      <rect width="460" height="300" rx="12" fill="#1C1B14" />

      {/* Left half — CONSUMED */}
      <text x="20" y="28" fontFamily="'JetBrains Mono', monospace" fontSize="10" fill="#6B6560" fontWeight="500">CONSUMED</text>
      <text x="20" y="110" fontFamily="'Cabinet Grotesk', system-ui, sans-serif" fontSize="72" fill="#F0EDE6" fontWeight="800" letterSpacing="-0.03em">847</text>
      <text x="20" y="130" fontFamily="'JetBrains Mono', monospace" fontSize="9" fill="#4A4540">items this month</text>

      {/* Divider above breakdown */}
      <line x1="20" y1="148" x2="210" y2="148" stroke="rgba(255,255,255,0.07)" strokeWidth="1" />

      {/* Breakdown list */}
      {breakdown.map((item, i) => (
        <g key={i}>
          <text x="20" y={168 + i * 22} fontFamily="'JetBrains Mono', monospace" fontSize="10" fill="#4A4540">{item.label}</text>
          <text x="210" y={168 + i * 22} fontFamily="'JetBrains Mono', monospace" fontSize="10" fill="#7A7067" textAnchor="end">{item.value}</text>
        </g>
      ))}

      {/* Vertical divider */}
      <line x1="230" y1="16" x2="230" y2="284" stroke="rgba(255,255,255,0.07)" strokeWidth="1" />

      {/* Right half — RETAINED */}
      <text x="250" y="28" fontFamily="'JetBrains Mono', monospace" fontSize="10" fill="#3A3428" fontWeight="500">RETAINED</text>
      <text x="250" y="110" fontFamily="'Cabinet Grotesk', system-ui, sans-serif" fontSize="72" fill="#2A2820" fontWeight="800" letterSpacing="-0.03em">3</text>
      <text x="250" y="130" fontFamily="'JetBrains Mono', monospace" fontSize="9" fill="#2A2820">items structured</text>

      {/* Conversion rate */}
      <text x="250" y="190" fontFamily="'JetBrains Mono', monospace" fontSize="10" fill="#4A4540">CONVERSION_RATE</text>
      <text x="250" y="236" fontFamily="'Cabinet Grotesk', system-ui, sans-serif" fontSize="36" fill="#E8622A" fontWeight="800">0.4%</text>
    </svg>
  );
}
