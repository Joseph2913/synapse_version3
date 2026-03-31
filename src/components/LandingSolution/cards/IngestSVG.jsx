export default function IngestSVG() {
  return (
    <svg viewBox="0 0 340 320" fill="none" xmlns="http://www.w3.org/2000/svg">
      {/* Dot grid background pattern */}
      <defs>
        <pattern id="ing-dots" x="0" y="0" width="12" height="12" patternUnits="userSpaceOnUse">
          <circle cx="1" cy="1" r="0.7" fill="rgba(26,22,18,0.10)" />
        </pattern>
        <pattern id="ing-crosshatch" x="0" y="0" width="8" height="8" patternUnits="userSpaceOnUse">
          <path d="M0 8L8 0M-1 1L1 -1M7 9L9 7" stroke="rgba(26,22,18,0.06)" strokeWidth="0.5" />
        </pattern>
      </defs>

      {/* Background dot field */}
      <rect x="20" y="10" width="300" height="300" rx="8" fill="url(#ing-dots)" />

      {/* Central funnel shape — crosshatch filled */}
      <path
        d="M 90 40 L 250 40 L 200 160 L 140 160 Z"
        fill="url(#ing-crosshatch)"
        stroke="rgba(26,22,18,0.18)"
        strokeWidth="1"
      />

      {/* Incoming format lines — converging to funnel top */}
      <line x1="30" y1="20" x2="110" y2="40" stroke="rgba(26,22,18,0.15)" strokeWidth="1" />
      <line x1="60" y1="8" x2="130" y2="40" stroke="rgba(26,22,18,0.12)" strokeWidth="1" />
      <line x1="310" y1="15" x2="230" y2="40" stroke="rgba(26,22,18,0.15)" strokeWidth="1" />
      <line x1="280" y1="5" x2="210" y2="40" stroke="rgba(26,22,18,0.12)" strokeWidth="1" />
      <line x1="170" y1="0" x2="170" y2="40" stroke="rgba(26,22,18,0.10)" strokeWidth="1" />

      {/* Source format labels at line origins */}
      <text x="14" y="18" fontFamily="'JetBrains Mono', monospace" fontSize="7" fill="rgba(26,22,18,0.35)">YT</text>
      <text x="48" y="7" fontFamily="'JetBrains Mono', monospace" fontSize="7" fill="rgba(26,22,18,0.35)">PDF</text>
      <text x="296" y="13" fontFamily="'JetBrains Mono', monospace" fontSize="7" fill="rgba(26,22,18,0.35)">DOC</text>
      <text x="270" y="4" fontFamily="'JetBrains Mono', monospace" fontSize="7" fill="rgba(26,22,18,0.35)">WEB</text>
      <text x="162" y="0" fontFamily="'JetBrains Mono', monospace" fontSize="7" fill="rgba(26,22,18,0.35)">MTG</text>

      {/* Output pipe from funnel */}
      <rect x="155" y="160" width="30" height="60" fill="url(#ing-crosshatch)" stroke="rgba(26,22,18,0.18)" strokeWidth="1" />

      {/* Orange accent dot — the processed output */}
      <circle cx="170" cy="240" r="6" fill="#E8622A" />
      <circle cx="170" cy="240" r="12" stroke="rgba(232,98,42,0.2)" strokeWidth="1" fill="none" />

      {/* Output line extending down */}
      <line x1="170" y1="252" x2="170" y2="295" stroke="rgba(26,22,18,0.12)" strokeWidth="1" strokeDasharray="3 3" />

      {/* Tiny decorative squares (processed nodes) */}
      <rect x="150" y="270" width="4" height="4" fill="rgba(26,22,18,0.12)" />
      <rect x="160" y="280" width="4" height="4" fill="rgba(26,22,18,0.12)" />
      <rect x="176" y="275" width="4" height="4" fill="rgba(26,22,18,0.12)" />
      <rect x="186" y="268" width="4" height="4" fill="rgba(26,22,18,0.08)" />
      <rect x="140" y="282" width="4" height="4" fill="rgba(26,22,18,0.08)" />
    </svg>
  );
}
