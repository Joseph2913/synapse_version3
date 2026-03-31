export default function AskSVG() {
  return (
    <svg viewBox="0 0 240 180" fill="none" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <pattern id="ask-dots" x="0" y="0" width="10" height="10" patternUnits="userSpaceOnUse">
          <circle cx="1" cy="1" r="0.6" fill="rgba(26,22,18,0.08)" />
        </pattern>
      </defs>

      {/* Dot field background */}
      <rect x="10" y="10" width="220" height="160" rx="6" fill="url(#ask-dots)" />

      {/* Sonar arcs radiating from bottom-left */}
      <path d="M 35 145 A 50 50 0 0 1 75 105" stroke="rgba(26,22,18,0.06)" strokeWidth="1" fill="none" />
      <path d="M 35 145 A 80 80 0 0 1 100 80" stroke="rgba(26,22,18,0.08)" strokeWidth="1" fill="none" />
      <path d="M 35 145 A 115 115 0 0 1 130 55" stroke="rgba(26,22,18,0.10)" strokeWidth="1" fill="none" />
      <path d="M 35 145 A 155 155 0 0 1 165 35" stroke="rgba(26,22,18,0.12)" strokeWidth="1.5" fill="none" />

      {/* Origin point */}
      <circle cx="35" cy="145" r="3" fill="rgba(26,22,18,0.25)" />
      <text x="22" y="160" fontFamily="'JetBrains Mono', monospace" fontSize="6" fill="rgba(26,22,18,0.25)">query</text>

      {/* Miss markers along arcs */}
      <text x="78" y="100" fontFamily="'JetBrains Mono', monospace" fontSize="7" fill="rgba(26,22,18,0.10)">x</text>
      <text x="108" y="73" fontFamily="'JetBrains Mono', monospace" fontSize="7" fill="rgba(26,22,18,0.10)">x</text>
      <text x="140" y="52" fontFamily="'JetBrains Mono', monospace" fontSize="7" fill="rgba(26,22,18,0.10)">x</text>

      {/* Found answer — orange terminus */}
      <circle cx="175" cy="32" r="5" fill="#E8622A" />
      <circle cx="175" cy="32" r="10" stroke="rgba(232,98,42,0.18)" strokeWidth="1" fill="none" />

      {/* Citation line back to origin */}
      <line x1="170" y1="37" x2="38" y2="142" stroke="rgba(232,98,42,0.10)" strokeWidth="1" strokeDasharray="4 3" />

      {/* Decorative: tiny brackets around answer */}
      <text x="160" y="25" fontFamily="'JetBrains Mono', monospace" fontSize="8" fill="rgba(26,22,18,0.15)">[</text>
      <text x="185" y="25" fontFamily="'JetBrains Mono', monospace" fontSize="8" fill="rgba(26,22,18,0.15)">]</text>
    </svg>
  );
}
