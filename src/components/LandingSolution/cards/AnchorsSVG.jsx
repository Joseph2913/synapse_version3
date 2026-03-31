export default function AnchorsSVG() {
  return (
    <svg viewBox="0 0 240 160" fill="none" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <pattern id="anc-grid" x="0" y="0" width="16" height="16" patternUnits="userSpaceOnUse">
          <path d="M16 0H0V16" stroke="rgba(26,22,18,0.04)" strokeWidth="0.5" fill="none" />
        </pattern>
      </defs>

      {/* Background grid */}
      <rect x="0" y="0" width="240" height="160" fill="url(#anc-grid)" />

      {/* Concentric rings from centre */}
      <circle cx="120" cy="80" r="60" stroke="rgba(26,22,18,0.04)" strokeWidth="0.5" fill="none" />
      <circle cx="120" cy="80" r="48" stroke="rgba(26,22,18,0.06)" strokeWidth="0.75" fill="none" />
      <circle cx="120" cy="80" r="36" stroke="rgba(26,22,18,0.10)" strokeWidth="1" fill="none" />
      <circle cx="120" cy="80" r="24" stroke="rgba(232,98,42,0.20)" strokeWidth="1.5" fill="none" />
      <circle cx="120" cy="80" r="12" stroke="rgba(232,98,42,0.40)" strokeWidth="2" fill="none" />

      {/* Centre anchor dot */}
      <circle cx="120" cy="80" r="5" fill="#E8622A" />

      {/* Scattered peripheral nodes */}
      <circle cx="52" cy="55" r="3" fill="none" stroke="rgba(26,22,18,0.10)" strokeWidth="1" />
      <circle cx="75" cy="120" r="4" fill="none" stroke="rgba(26,22,18,0.12)" strokeWidth="1" />
      <circle cx="185" cy="45" r="3" fill="none" stroke="rgba(26,22,18,0.08)" strokeWidth="1" />
      <circle cx="195" cy="110" r="4" fill="none" stroke="rgba(26,22,18,0.10)" strokeWidth="1" />
      <circle cx="155" cy="135" r="3" fill="none" stroke="rgba(26,22,18,0.08)" strokeWidth="1" />
      <circle cx="90" cy="40" r="3" fill="none" stroke="rgba(26,22,18,0.10)" strokeWidth="1" />

      {/* Faint radial lines from centre to some peripheral nodes */}
      <line x1="120" y1="80" x2="52" y2="55" stroke="rgba(26,22,18,0.04)" strokeWidth="0.5" />
      <line x1="120" y1="80" x2="185" y2="45" stroke="rgba(26,22,18,0.04)" strokeWidth="0.5" />
      <line x1="120" y1="80" x2="195" y2="110" stroke="rgba(26,22,18,0.04)" strokeWidth="0.5" />
      <line x1="120" y1="80" x2="75" y2="120" stroke="rgba(26,22,18,0.04)" strokeWidth="0.5" />

      {/* Score label */}
      <text x="108" y="150" fontFamily="'JetBrains Mono', monospace" fontSize="6" fill="rgba(26,22,18,0.20)">ANCHOR</text>
    </svg>
  );
}
