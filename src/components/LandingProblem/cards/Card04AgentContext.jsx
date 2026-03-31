export default function Card04AgentContext() {
  const sessions = [
    { label: 'SESSION_01', labelColor: '#4A4540', valueColor: '#4A4540' },
    { label: 'SESSION_02', labelColor: '#3A3428', valueColor: '#2A2820' },
    { label: 'SESSION_03', labelColor: '#2A2820', valueColor: '#1C1B14' },
  ];

  const fields = ['CONTEXT', 'ENTITIES', 'HISTORY'];
  const values = ['NULL', '0', 'NONE'];

  return (
    <svg viewBox="0 0 460 300" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ width: '100%', height: '100%' }}>
      <rect width="460" height="300" rx="12" fill="#1C1B14" />

      {/* Header */}
      <text x="20" y="28" fontFamily="'JetBrains Mono', monospace" fontSize="10" fill="#6B6560" fontWeight="500">SESSION_HISTORY</text>

      {/* Session blocks */}
      {sessions.map((session, i) => {
        const blockY = 48 + i * 72;
        return (
          <g key={i}>
            {/* Session label */}
            <text x="20" y={blockY + 20} fontFamily="'JetBrains Mono', monospace" fontSize="9" fill={session.labelColor} fontWeight="500">{session.label}</text>

            {/* Data readout columns */}
            {fields.map((field, j) => (
              <g key={j}>
                <text x={160 + j * 100} y={blockY + 12} fontFamily="'JetBrains Mono', monospace" fontSize="9" fill="#3A3428">{field}</text>
                <text x={160 + j * 100} y={blockY + 28} fontFamily="'JetBrains Mono', monospace" fontSize="10" fill={session.valueColor} fontWeight="500">{values[j]}</text>
              </g>
            ))}

            {/* Divider */}
            {i < sessions.length - 1 && (
              <line x1="20" y1={blockY + 52} x2="440" y2={blockY + 52} stroke="rgba(255,255,255,0.05)" strokeWidth="1" />
            )}
          </g>
        );
      })}

      {/* Bottom stats */}
      <text x="20" y="280" fontFamily="'JetBrains Mono', monospace" fontSize="10" fill="#E8622A" fontWeight="500">MEMORY_PERSISTENCE: NONE</text>
      <text x="440" y="280" fontFamily="'JetBrains Mono', monospace" fontSize="10" fill="#4A4540" textAnchor="end">SESSIONS_LOGGED: 0</text>
    </svg>
  );
}
