export default function McpSVG() {
  return (
    <svg viewBox="0 0 240 180" fill="none" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <pattern id="mcp-hatch" x="0" y="0" width="6" height="6" patternUnits="userSpaceOnUse">
          <path d="M0 6L6 0" stroke="rgba(26,22,18,0.06)" strokeWidth="0.5" />
        </pattern>
        <pattern id="mcp-dots" x="0" y="0" width="8" height="8" patternUnits="userSpaceOnUse">
          <circle cx="1" cy="1" r="0.5" fill="rgba(26,22,18,0.10)" />
        </pattern>
      </defs>

      {/* Left side — knowledge graph (organic polygon) */}
      <path
        d="M 30 45 L 65 25 L 100 40 L 95 85 L 55 95 Z"
        fill="url(#mcp-hatch)"
        stroke="rgba(26,22,18,0.20)"
        strokeWidth="1"
      />
      {/* Anchor dot inside polygon */}
      <circle cx="72" cy="60" r="3" fill="#E8622A" />

      {/* Label */}
      <text x="40" y="115" fontFamily="'JetBrains Mono', monospace" fontSize="7" fill="rgba(26,22,18,0.30)">YOUR GRAPH</text>

      {/* MCP boundary — dashed vertical line */}
      <line x1="130" y1="10" x2="130" y2="170" stroke="rgba(26,22,18,0.15)" strokeWidth="1" strokeDasharray="4 4" />
      <text x="123" y="175" fontFamily="'JetBrains Mono', monospace" fontSize="5" fill="rgba(26,22,18,0.20)">MCP</text>

      {/* Right side — agent circles with dot fill */}
      <circle cx="185" cy="40" r="16" fill="url(#mcp-dots)" stroke="rgba(26,22,18,0.18)" strokeWidth="1" />
      <circle cx="185" cy="90" r="16" fill="url(#mcp-dots)" stroke="rgba(26,22,18,0.18)" strokeWidth="1" />
      <circle cx="185" cy="140" r="16" fill="url(#mcp-dots)" stroke="rgba(26,22,18,0.18)" strokeWidth="1" />

      {/* Agent labels */}
      <text x="175" y="43" fontFamily="'JetBrains Mono', monospace" fontSize="6" fill="rgba(26,22,18,0.35)" textAnchor="middle">AI</text>
      <text x="175" y="93" fontFamily="'JetBrains Mono', monospace" fontSize="6" fill="rgba(26,22,18,0.35)" textAnchor="middle">AI</text>
      <text x="175" y="143" fontFamily="'JetBrains Mono', monospace" fontSize="6" fill="rgba(26,22,18,0.35)" textAnchor="middle">AI</text>

      {/* Connection paths across boundary */}
      <line x1="95" y1="60" x2="169" y2="40" stroke="rgba(26,22,18,0.08)" strokeWidth="1" />
      <line x1="95" y1="65" x2="169" y2="90" stroke="rgba(26,22,18,0.08)" strokeWidth="1" />
      <line x1="95" y1="70" x2="169" y2="140" stroke="rgba(26,22,18,0.08)" strokeWidth="1" />

      {/* Tiny orange dot travelling on middle path */}
      <circle cx="132" cy="78" r="2.5" fill="#E8622A" />
    </svg>
  );
}
