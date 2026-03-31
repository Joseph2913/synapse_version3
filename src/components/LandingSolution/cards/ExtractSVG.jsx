export default function ExtractSVG() {
  // Node positions in a loose graph
  const nodes = [
    { x: 120, y: 60, r: 14, accent: true },  // anchor node — orange
    { x: 55, y: 110, r: 10 },
    { x: 190, y: 100, r: 10 },
    { x: 80, y: 180, r: 8 },
    { x: 160, y: 175, r: 8 },
    { x: 230, y: 170, r: 7 },
    { x: 40, y: 50, r: 6 },
    { x: 210, y: 45, r: 6 },
    { x: 130, y: 230, r: 7 },
    { x: 260, y: 120, r: 5 },
  ];

  // Edges connecting them
  const edges = [
    [0, 1], [0, 2], [0, 4], [1, 3], [2, 4], [2, 5],
    [1, 6], [0, 7], [3, 8], [4, 8], [5, 9], [2, 9],
  ];

  return (
    <svg viewBox="0 0 300 290" fill="none" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <pattern id="ext-grid" x="0" y="0" width="16" height="16" patternUnits="userSpaceOnUse">
          <path d="M16 0H0V16" stroke="rgba(26,22,18,0.04)" strokeWidth="0.5" fill="none" />
        </pattern>
        <pattern id="ext-dots" x="0" y="0" width="10" height="10" patternUnits="userSpaceOnUse">
          <circle cx="1" cy="1" r="0.6" fill="rgba(26,22,18,0.08)" />
        </pattern>
      </defs>

      {/* Background grid */}
      <rect x="10" y="10" width="280" height="270" rx="6" fill="url(#ext-grid)" />

      {/* Entity type labels scattered faintly */}
      <text x="32" y="38" fontFamily="'JetBrains Mono', monospace" fontSize="6" fill="rgba(26,22,18,0.20)" transform="rotate(-8, 32, 38)">Person</text>
      <text x="200" y="35" fontFamily="'JetBrains Mono', monospace" fontSize="6" fill="rgba(26,22,18,0.20)">Decision</text>
      <text x="50" y="155" fontFamily="'JetBrains Mono', monospace" fontSize="6" fill="rgba(26,22,18,0.20)">Risk</text>
      <text x="220" y="155" fontFamily="'JetBrains Mono', monospace" fontSize="6" fill="rgba(26,22,18,0.20)">Insight</text>
      <text x="110" y="260" fontFamily="'JetBrains Mono', monospace" fontSize="6" fill="rgba(26,22,18,0.20)">Topic</text>

      {/* Edges */}
      {edges.map(([a, b], i) => (
        <line
          key={i}
          x1={nodes[a].x} y1={nodes[a].y}
          x2={nodes[b].x} y2={nodes[b].y}
          stroke="rgba(26,22,18,0.10)"
          strokeWidth="1"
        />
      ))}

      {/* Nodes */}
      {nodes.map((n, i) => (
        <g key={i}>
          {/* Dot-filled circle for non-accent nodes */}
          <circle
            cx={n.x} cy={n.y} r={n.r}
            fill={n.accent ? 'none' : 'url(#ext-dots)'}
            stroke={n.accent ? '#E8622A' : 'rgba(26,22,18,0.18)'}
            strokeWidth={n.accent ? 2 : 1}
          />
          {n.accent && (
            <>
              <circle cx={n.x} cy={n.y} r="4" fill="#E8622A" />
              <circle cx={n.x} cy={n.y} r={n.r + 6} stroke="rgba(232,98,42,0.12)" strokeWidth="1" fill="none" />
            </>
          )}
        </g>
      ))}

      {/* Decorative: tiny + marks at some intersections */}
      <text x="85" y="88" fontFamily="'JetBrains Mono', monospace" fontSize="8" fill="rgba(26,22,18,0.12)">+</text>
      <text x="175" y="140" fontFamily="'JetBrains Mono', monospace" fontSize="8" fill="rgba(26,22,18,0.12)">+</text>
      <text x="100" y="210" fontFamily="'JetBrains Mono', monospace" fontSize="8" fill="rgba(26,22,18,0.12)">+</text>
    </svg>
  );
}
