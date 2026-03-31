export default function Card02SiloMap() {
  const nodes = [
    { x: 80, y: 80, label: 'Q2_STRATEGY' },
    { x: 220, y: 60, label: 'COMPETITOR_REPORT' },
    { x: 370, y: 90, label: 'BOARD_MEETING_NOV' },
    { x: 130, y: 150, label: 'MARKET_RESEARCH' },
    { x: 310, y: 145, label: 'PODCAST_TRANSCRIPT' },
    { x: 400, y: 180, label: 'CLIENT_CALL_FEB' },
    { x: 60, y: 220, label: 'FRAMEWORK_DOC' },
    { x: 230, y: 215, label: 'INVESTOR_UPDATE' },
    { x: 350, y: 240, label: 'WEEKLY_NOTES' },
  ];

  // Dashed arc between Q2_STRATEGY (0) and CLIENT_CALL_FEB (5)
  const n0 = nodes[0];
  const n5 = nodes[5];
  const midX = (n0.x + n5.x) / 2;
  const midY = (n0.y + n5.y) / 2 - 30;

  return (
    <svg viewBox="0 0 460 300" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ width: '100%', height: '100%' }}>
      <rect width="460" height="300" rx="12" fill="#1C1B14" />

      {/* Header */}
      <text x="20" y="28" fontFamily="'JetBrains Mono', monospace" fontSize="10" fill="#6B6560" fontWeight="500">KNOWLEDGE_GRAPH</text>
      <rect x="340" y="14" width="100" height="20" rx="10" fill="rgba(232,98,42,0.18)" />
      <text x="390" y="27" fontFamily="'JetBrains Mono', monospace" fontSize="9" fill="#E8622A" fontWeight="500" textAnchor="middle">TOPOLOGY_VIEW</text>

      {/* Dashed arc hint */}
      <path
        d={`M ${n0.x} ${n0.y} Q ${midX} ${midY} ${n5.x} ${n5.y}`}
        stroke="#E8622A"
        strokeDasharray="4 4"
        strokeWidth="1"
        opacity="0.3"
        fill="none"
      />
      <text
        x={midX}
        y={midY + 4}
        fontFamily="'JetBrains Mono', monospace"
        fontSize="10"
        fill="#E8622A"
        opacity="0.5"
        textAnchor="middle"
      >
        ?
      </text>

      {/* Nodes */}
      {nodes.map((node, i) => (
        <g key={i}>
          <circle cx={node.x} cy={node.y} r="8" fill="#1C1B14" stroke="rgba(122,112,103,0.3)" strokeWidth="1.5" />
          <text
            x={node.x}
            y={node.y + 20}
            fontFamily="'JetBrains Mono', monospace"
            fontSize="8"
            fill="#4A4540"
            textAnchor="middle"
          >
            {node.label}
          </text>
        </g>
      ))}

      {/* Bottom stats */}
      <text x="150" y="282" fontFamily="'JetBrains Mono', monospace" fontSize="12" fill="#E8622A" fontWeight="500" textAnchor="middle">CONNECTIONS: 0</text>
      <text x="340" y="282" fontFamily="'JetBrains Mono', monospace" fontSize="10" fill="#4A4540" textAnchor="middle">ISOLATED_NODES: 9</text>
    </svg>
  );
}
