import {
  MOCK_SOURCES,
  MOCK_ANCHORS,
  MOCK_ADVISORS,
  MOCK_SKILLS,
  MOCK_SOURCE_ENTITIES,
  MOCK_STATS,
} from './onboardingMockData'

// ─── Shared helpers ──────────────────────────────────────────────────────────

const HealthBadge = ({
  status,
}: {
  status: 'Strong' | 'Growing' | 'Thin' | 'Stale'
}) => {
  const styles: Record<string, { color: string; bg: string }> = {
    Strong: { color: '#2e7d32', bg: '#e8f5e9' },
    Growing: { color: '#e65100', bg: '#fff3e0' },
    Thin: { color: '#c62828', bg: '#fce4ec' },
    Stale: { color: '#757575', bg: '#f5f5f5' },
  }
  const s = styles[status] ?? { color: '#757575', bg: '#f5f5f5' }
  return (
    <span
      className="rounded-full font-semibold"
      style={{
        fontSize: '9px',
        padding: '2px 7px',
        background: s.bg,
        color: s.color,
      }}
    >
      {status}
    </span>
  )
}

// ─── MockHomePage ─────────────────────────────────────────────────────────────

export function MockHomePage() {
  const statPills = [
    { label: 'Sources', value: MOCK_STATS.totalSources },
    { label: 'Nodes', value: MOCK_STATS.totalNodes },
    { label: 'Anchors', value: MOCK_STATS.activeAnchors },
    { label: 'Skills', value: MOCK_STATS.activeSkills },
  ]

  const sourceTypeColors: Record<string, { color: string; bg: string }> = {
    YouTube: { color: '#dc2626', bg: '#fef2f2' },
    Meeting: { color: '#ea580c', bg: '#fff7ed' },
    Document: { color: '#2563eb', bg: '#eff6ff' },
    Note: { color: '#16a34a', bg: '#f0fdf4' },
    Research: { color: '#9333ea', bg: '#faf5ff' },
  }

  return (
    <div className="flex flex-col h-full overflow-hidden" style={{ fontSize: '11px' }}>
      {/* Hero card */}
      <div
        className="mx-3 mt-3 rounded-xl p-3 flex-shrink-0"
        style={{
          background: 'linear-gradient(120deg, #fff5f0 0%, #fffaf8 100%)',
          border: '1px solid rgba(214,58,0,0.12)',
        }}
      >
        <p className="font-bold mb-2" style={{ fontSize: '14px', color: '#1a1a1a' }}>
          Good morning, Sarah
        </p>
        <div className="flex flex-wrap gap-1.5 mb-2">
          {statPills.map(p => (
            <span
              key={p.label}
              className="rounded-full font-semibold"
              style={{
                fontSize: '10px',
                padding: '3px 9px',
                background: '#ffffff',
                border: '1px solid rgba(0,0,0,0.08)',
                color: '#444',
              }}
            >
              {p.label}: <span style={{ color: '#d63a00', fontWeight: 700 }}>{p.value}</span>
            </span>
          ))}
        </div>
        <div className="flex gap-1.5 flex-wrap">
          {Object.entries(MOCK_STATS.sourceBreakdown).map(([type, count]) => {
            const label = type.charAt(0).toUpperCase() + type.slice(1)
            const style = sourceTypeColors[label] ?? { color: '#555', bg: '#f0f0f0' }
            return (
              <span
                key={type}
                className="rounded-full font-semibold"
                style={{
                  fontSize: '9px',
                  padding: '2px 7px',
                  background: style.bg,
                  color: style.color,
                }}
              >
                {label} {count}
              </span>
            )
          })}
        </div>
      </div>

      {/* Two columns */}
      <div className="flex gap-3 px-3 mt-3 flex-1 overflow-hidden">
        {/* Left: Recent Sources */}
        <div className="flex flex-col flex-1 overflow-hidden">
          <p
            className="font-bold mb-2 flex-shrink-0"
            style={{ fontSize: '11px', color: '#1a1a1a' }}
          >
            Recent Sources
          </p>
          <div className="flex flex-col gap-1.5">
            {MOCK_SOURCES.map((src, i) => (
              <div
                key={i}
                className="flex items-start gap-2 rounded-lg p-2"
                style={{ background: '#ffffff', border: '1px solid rgba(0,0,0,0.06)' }}
              >
                <div
                  className="rounded flex-shrink-0 mt-0.5"
                  style={{
                    width: '8px',
                    height: '8px',
                    background: src.color,
                    borderRadius: '50%',
                    marginTop: '3px',
                  }}
                />
                <div className="flex-1 min-w-0">
                  <p
                    className="font-semibold leading-tight truncate"
                    style={{ fontSize: '10px', color: '#1a1a1a' }}
                  >
                    {src.title}
                  </p>
                  <p style={{ fontSize: '9px', color: '#888', marginTop: '1px' }}>
                    {src.type} · {src.entityCount} entities · {src.age}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Right: Council */}
        <div className="flex flex-col" style={{ width: '40%', flexShrink: 0 }}>
          <p
            className="font-bold mb-2 flex-shrink-0"
            style={{ fontSize: '11px', color: '#1a1a1a' }}
          >
            Council
          </p>
          <div className="flex flex-col gap-1.5">
            {MOCK_ADVISORS.slice(0, 4).map((advisor, i) => (
              <div
                key={i}
                className="rounded-lg p-2"
                style={{ background: '#ffffff', border: '1px solid rgba(0,0,0,0.06)' }}
              >
                <div className="flex items-center gap-1.5 mb-1">
                  <div
                    className="rounded flex-shrink-0"
                    style={{
                      width: '18px',
                      height: '18px',
                      background: advisor.iconBg,
                      borderRadius: '6px',
                    }}
                  />
                  <p
                    className="font-semibold leading-tight flex-1 truncate"
                    style={{ fontSize: '9px', color: '#1a1a1a' }}
                  >
                    {advisor.name}
                  </p>
                  <HealthBadge status={advisor.health} />
                </div>
                <p
                  className="leading-tight"
                  style={{ fontSize: '8px', color: '#888', paddingLeft: '24px' }}
                >
                  {advisor.insightCount} insights
                </p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── MockExplorePage ──────────────────────────────────────────────────────────

export function MockExplorePage() {
  const bubbles = [
    { anchor: MOCK_ANCHORS[0]!, x: 140, y: 120, r: 65 },
    { anchor: MOCK_ANCHORS[1]!, x: 310, y: 80, r: 52 },
    { anchor: MOCK_ANCHORS[2]!, x: 420, y: 180, r: 48 },
    { anchor: MOCK_ANCHORS[3]!, x: 240, y: 240, r: 44 },
    { anchor: MOCK_ANCHORS[4]!, x: 90, y: 250, r: 38 },
  ]

  const suggestedBubble = { name: 'UX Design', x: 370, y: 280, r: 36 }

  const lines: Array<[number, number, number, number]> = [
    [140, 120, 310, 80],
    [310, 80, 420, 180],
    [140, 120, 240, 240],
    [240, 240, 420, 180],
    [90, 250, 140, 120],
  ]

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Toolbar */}
      <div
        className="flex items-center gap-2 px-3 flex-shrink-0"
        style={{
          height: '40px',
          borderBottom: '1px solid rgba(0,0,0,0.07)',
          background: '#fff',
        }}
      >
        {['Anchors', 'Sources', 'Playlists'].map((label, i) => (
          <span
            key={label}
            className="rounded-full font-semibold cursor-pointer"
            style={{
              fontSize: '11px',
              padding: '4px 12px',
              background: i === 0 ? '#fff5f0' : 'transparent',
              color: i === 0 ? '#d63a00' : 'rgba(0,0,0,0.45)',
              border: i === 0 ? '1px solid rgba(214,58,0,0.15)' : '1px solid rgba(0,0,0,0.1)',
            }}
          >
            {label}
          </span>
        ))}
        <div className="flex-1" />
        <span
          className="rounded-full font-semibold"
          style={{
            fontSize: '11px',
            padding: '4px 12px',
            background: 'transparent',
            color: 'rgba(0,0,0,0.45)',
            border: '1px solid rgba(0,0,0,0.1)',
          }}
        >
          Connection Types ▾
        </span>
      </div>

      {/* Graph area */}
      <div className="flex-1 relative overflow-hidden" style={{ background: '#fafafa' }}>
        {/* SVG lines */}
        <svg
          className="absolute inset-0"
          width="100%"
          height="100%"
          style={{ pointerEvents: 'none' }}
        >
          {lines.map(([x1, y1, x2, y2], i) => (
            <line
              key={i}
              x1={x1}
              y1={y1}
              x2={x2}
              y2={y2}
              stroke="rgba(0,0,0,0.12)"
              strokeWidth="1.5"
              strokeDasharray="4 3"
            />
          ))}
        </svg>

        {/* Solid bubbles */}
        {bubbles.map(({ anchor, x, y, r }) => (
          <div
            key={anchor.name}
            className="absolute flex flex-col items-center justify-center rounded-full"
            style={{
              left: x - r,
              top: y - r,
              width: r * 2,
              height: r * 2,
              background: anchor.color + '14',
              border: `2px solid ${anchor.color}`,
            }}
          >
            <span
              className="font-bold text-center leading-tight px-1"
              style={{ fontSize: '9px', color: anchor.color }}
            >
              {anchor.name}
            </span>
            <span
              style={{ fontSize: '8px', color: anchor.color, opacity: 0.7 }}
            >
              {anchor.entityCount}
            </span>
          </div>
        ))}

        {/* Dashed bubble - suggested */}
        <div
          className="absolute flex flex-col items-center justify-center rounded-full"
          style={{
            left: suggestedBubble.x - suggestedBubble.r,
            top: suggestedBubble.y - suggestedBubble.r,
            width: suggestedBubble.r * 2,
            height: suggestedBubble.r * 2,
            background: 'rgba(0,0,0,0.03)',
            border: '2px dashed rgba(0,0,0,0.25)',
          }}
        >
          <span
            className="font-semibold text-center px-1"
            style={{ fontSize: '8px', color: 'rgba(0,0,0,0.4)' }}
          >
            {suggestedBubble.name}
          </span>
        </div>

        {/* Floating info card */}
        <div
          className="absolute rounded-xl"
          style={{
            top: '12px',
            right: '12px',
            width: '160px',
            background: '#ffffff',
            border: '1px solid rgba(0,0,0,0.08)',
            boxShadow: '0 4px 16px rgba(0,0,0,0.1)',
            padding: '10px',
          }}
        >
          <p
            className="font-bold mb-1"
            style={{ fontSize: '11px', color: '#1a1a1a' }}
          >
            {MOCK_ANCHORS[0]!.name}
          </p>
          <p style={{ fontSize: '9px', color: '#888', marginBottom: '6px' }}>
            {MOCK_ANCHORS[0]!.entityCount} entities · {MOCK_ANCHORS[0]!.connectionCount} connections
          </p>
          <div className="flex flex-wrap gap-1">
            {['Person', 'Topic', 'Concept', 'Technology'].map(type => (
              <span
                key={type}
                className="rounded-full"
                style={{
                  fontSize: '8px',
                  padding: '2px 6px',
                  background: '#f0f0f0',
                  color: '#555',
                  fontWeight: 600,
                }}
              >
                {type}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── MockAskPage ──────────────────────────────────────────────────────────────

export function MockAskPage() {
  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Mode bar */}
      <div
        className="flex items-center gap-2 px-3 flex-shrink-0"
        style={{
          height: '40px',
          borderBottom: '1px solid rgba(0,0,0,0.07)',
          background: '#fff',
        }}
      >
        {['Standard', 'Council'].map((label, i) => (
          <span
            key={label}
            className="rounded-full font-semibold"
            style={{
              fontSize: '11px',
              padding: '4px 12px',
              background: i === 0 ? '#fff5f0' : 'transparent',
              color: i === 0 ? '#d63a00' : 'rgba(0,0,0,0.45)',
              border: i === 0 ? '1px solid rgba(214,58,0,0.15)' : '1px solid rgba(0,0,0,0.1)',
            }}
          >
            {label}
          </span>
        ))}
        <div className="flex-1" />
        {['All Anchors ▾', 'Balanced ▾'].map(label => (
          <span
            key={label}
            className="rounded-full font-semibold"
            style={{
              fontSize: '11px',
              padding: '4px 12px',
              background: 'transparent',
              color: 'rgba(0,0,0,0.45)',
              border: '1px solid rgba(0,0,0,0.1)',
            }}
          >
            {label}
          </span>
        ))}
      </div>

      {/* Messages area */}
      <div className="flex-1 overflow-hidden px-3 py-3 flex flex-col gap-2">
        {/* User message */}
        <div className="flex justify-end">
          <div
            className="rounded-xl rounded-br-sm px-3 py-2"
            style={{
              maxWidth: '75%',
              background: '#d63a00',
              color: '#fff',
              fontSize: '10px',
              lineHeight: '1.5',
            }}
          >
            What are the key patterns across my AI agent research?
          </div>
        </div>

        {/* Assistant response */}
        <div
          className="rounded-xl rounded-tl-sm px-3 py-2"
          style={{
            maxWidth: '90%',
            background: '#ffffff',
            border: '1px solid rgba(0,0,0,0.08)',
            fontSize: '10px',
            lineHeight: '1.6',
            color: '#1a1a1a',
          }}
        >
          <p className="font-semibold mb-1" style={{ fontSize: '10px' }}>
            Three recurring patterns emerge across your 14 AI agent sources:
          </p>
          <p style={{ marginBottom: '4px' }}>
            <strong>1. Tool-use as the primary capability lever</strong> — cited in 9 of 14 sources{' '}
            <span
              className="rounded font-bold"
              style={{
                fontSize: '8px',
                padding: '1px 4px',
                background: '#fff5f0',
                color: '#d63a00',
                border: '1px solid rgba(214,58,0,0.2)',
              }}
            >
              [1]
            </span>{' '}
            <span
              className="rounded font-bold"
              style={{
                fontSize: '8px',
                padding: '1px 4px',
                background: '#fff5f0',
                color: '#d63a00',
                border: '1px solid rgba(214,58,0,0.2)',
              }}
            >
              [2]
            </span>
          </p>
          <p style={{ marginBottom: '4px' }}>
            <strong>2. ReAct pattern dominates orchestration</strong> — consistent across research and YouTube{' '}
            <span
              className="rounded font-bold"
              style={{
                fontSize: '8px',
                padding: '1px 4px',
                background: '#fff5f0',
                color: '#d63a00',
                border: '1px solid rgba(214,58,0,0.2)',
              }}
            >
              [3]
            </span>
          </p>
          <p>
            <strong>3. Memory architecture tension</strong> — short vs long-term trade-offs debated{' '}
            <span
              className="rounded font-bold"
              style={{
                fontSize: '8px',
                padding: '1px 4px',
                background: '#fff5f0',
                color: '#d63a00',
                border: '1px solid rgba(214,58,0,0.2)',
              }}
            >
              [4]
            </span>
          </p>
        </div>

        {/* Council perspectives */}
        <div>
          <div className="flex items-center gap-1.5 mb-1.5">
            <div
              style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#9333ea' }}
            />
            <span
              className="font-semibold"
              style={{ fontSize: '9px', color: '#9333ea' }}
            >
              Council Perspectives
            </span>
          </div>
          <div className="grid grid-cols-2 gap-1.5">
            {MOCK_ADVISORS.slice(0, 2).map((advisor, i) => (
              <div
                key={i}
                className="rounded-lg p-2"
                style={{ background: '#fafafa', border: '1px solid rgba(0,0,0,0.07)' }}
              >
                <div className="flex items-center gap-1 mb-1">
                  <div
                    className="rounded flex-shrink-0"
                    style={{ width: '14px', height: '14px', background: advisor.iconBg, borderRadius: '4px' }}
                  />
                  <span
                    className="font-semibold truncate"
                    style={{ fontSize: '8px', color: '#1a1a1a' }}
                  >
                    {advisor.name}
                  </span>
                  <span
                    className="font-bold ml-auto"
                    style={{ fontSize: '8px', color: '#16a34a' }}
                  >
                    {86 + i * 7}%
                  </span>
                </div>
                <p style={{ fontSize: '8px', color: '#777', lineHeight: '1.4' }}>
                  {i === 0
                    ? 'Tool use patterns align with ReAct — strong signal.'
                    : 'Memory tension reflects product architecture debate.'}
                </p>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Input bar */}
      <div
        className="flex items-center gap-2 px-3 flex-shrink-0"
        style={{
          height: '48px',
          borderTop: '1px solid rgba(0,0,0,0.07)',
          background: '#fff',
        }}
      >
        <div
          className="flex-1 rounded-full px-3"
          style={{
            height: '32px',
            background: '#f5f5f5',
            border: '1px solid rgba(0,0,0,0.08)',
            display: 'flex',
            alignItems: 'center',
          }}
        >
          <span style={{ fontSize: '10px', color: 'rgba(0,0,0,0.35)' }}>
            Ask your knowledge graph...
          </span>
        </div>
        <div
          className="flex items-center justify-center rounded-full flex-shrink-0"
          style={{ width: '30px', height: '30px', background: '#d63a00' }}
        >
          <span style={{ color: '#fff', fontSize: '12px' }}>↑</span>
        </div>
      </div>
    </div>
  )
}

// ─── MockSourcesPage ──────────────────────────────────────────────────────────

export function MockSourcesPage() {
  const selected = MOCK_SOURCES[0]!

  return (
    <div className="flex h-full overflow-hidden">
      {/* Left panel */}
      <div
        className="flex flex-col overflow-hidden"
        style={{ width: '60%', borderRight: '1px solid rgba(0,0,0,0.07)' }}
      >
        {/* Header */}
        <div
          className="flex items-center gap-2 px-3 flex-shrink-0"
          style={{
            height: '40px',
            borderBottom: '1px solid rgba(0,0,0,0.07)',
            background: '#fff',
          }}
        >
          <span className="font-bold" style={{ fontSize: '11px', color: '#1a1a1a' }}>
            All Sources · {MOCK_STATS.totalSources}
          </span>
          <div className="flex-1" />
          {['YouTube', 'Meeting', 'Document'].map(type => (
            <span
              key={type}
              className="rounded-full font-semibold"
              style={{
                fontSize: '9px',
                padding: '2px 8px',
                background: '#f0f0f0',
                color: 'rgba(0,0,0,0.45)',
                border: '1px solid rgba(0,0,0,0.08)',
              }}
            >
              {type}
            </span>
          ))}
        </div>

        {/* Source list */}
        <div className="flex flex-col overflow-hidden px-2 py-2 gap-1.5">
          {MOCK_SOURCES.map((src, i) => (
            <div
              key={i}
              className="flex items-start gap-2 rounded-lg p-2"
              style={{
                background: i === 0 ? '#fff5f0' : '#ffffff',
                border: i === 0 ? '1px solid rgba(214,58,0,0.2)' : '1px solid rgba(0,0,0,0.06)',
              }}
            >
              <div
                className="flex items-center justify-center rounded flex-shrink-0"
                style={{
                  width: '24px',
                  height: '24px',
                  background: src.bgColor,
                  borderRadius: '6px',
                  marginTop: '1px',
                }}
              >
                <div
                  style={{
                    width: '8px',
                    height: '8px',
                    borderRadius: '50%',
                    background: src.color,
                  }}
                />
              </div>
              <div className="flex-1 min-w-0">
                <p
                  className="font-semibold leading-tight"
                  style={{
                    fontSize: '10px',
                    color: i === 0 ? '#d63a00' : '#1a1a1a',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                >
                  {src.title}
                </p>
                <p style={{ fontSize: '9px', color: '#888', marginTop: '1px' }}>
                  {src.type} · {src.entityCount} entities · {src.age}
                </p>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Right detail panel */}
      <div className="flex-1 flex flex-col overflow-hidden px-3 py-3 gap-3" style={{ background: '#fff' }}>
        {/* Type badge + title */}
        <div>
          <span
            className="rounded-full font-semibold mb-1.5 inline-block"
            style={{
              fontSize: '9px',
              padding: '2px 8px',
              background: selected.bgColor,
              color: selected.color,
            }}
          >
            {selected.type}
          </span>
          <p className="font-bold" style={{ fontSize: '12px', color: '#1a1a1a', lineHeight: '1.3' }}>
            {selected.title}
          </p>
          <p style={{ fontSize: '9px', color: '#888', marginTop: '3px' }}>
            42 min · {selected.entityCount} entities · {selected.age}
          </p>
        </div>

        {/* Extracted entities */}
        <div>
          <p className="font-bold mb-1.5" style={{ fontSize: '10px', color: '#1a1a1a' }}>
            Extracted Entities
          </p>
          <div className="flex flex-wrap gap-1">
            {MOCK_SOURCE_ENTITIES.map(entity => (
              <span
                key={entity.name}
                className="rounded-full font-semibold"
                style={{
                  fontSize: '9px',
                  padding: '2px 8px',
                  background: entity.color + '18',
                  color: entity.color,
                  border: `1px solid ${entity.color}30`,
                }}
              >
                {entity.name}
              </span>
            ))}
          </div>
        </div>

        {/* Connected anchors */}
        <div>
          <p className="font-bold mb-1.5" style={{ fontSize: '10px', color: '#1a1a1a' }}>
            Connected Anchors
          </p>
          <div className="flex flex-wrap gap-1">
            {MOCK_ANCHORS.slice(0, 3).map(anchor => (
              <span
                key={anchor.name}
                className="rounded-full font-semibold"
                style={{
                  fontSize: '9px',
                  padding: '2px 8px',
                  background: '#fff5f0',
                  color: '#d63a00',
                  border: '1px solid rgba(214,58,0,0.15)',
                }}
              >
                {anchor.name}
              </span>
            ))}
          </div>
        </div>

        {/* Key takeaways */}
        <div>
          <p className="font-bold mb-1.5" style={{ fontSize: '10px', color: '#1a1a1a' }}>
            Key Takeaways
          </p>
          <ul className="flex flex-col gap-1">
            {[
              'ReAct pattern is now the dominant orchestration framework in production systems.',
              'Tool use reliability is the biggest bottleneck for autonomous agents.',
              'Memory architecture will bifurcate into episodic vs semantic layers.',
            ].map((takeaway, i) => (
              <li key={i} className="flex items-start gap-1.5">
                <span style={{ color: '#d63a00', flexShrink: 0, marginTop: '1px' }}>·</span>
                <span style={{ fontSize: '9px', color: '#444', lineHeight: '1.4' }}>{takeaway}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  )
}

// ─── MockSignalsPage ──────────────────────────────────────────────────────────

export function MockSignalsPage() {
  return (
    <div className="flex h-full overflow-hidden">
      {/* Left panel */}
      <div
        className="flex flex-col overflow-hidden"
        style={{ width: '60%', borderRight: '1px solid rgba(0,0,0,0.07)' }}
      >
        {/* Toolbar */}
        <div
          className="flex items-center gap-2 px-3 flex-shrink-0"
          style={{
            height: '40px',
            borderBottom: '1px solid rgba(0,0,0,0.07)',
            background: '#fff',
          }}
        >
          {['All', 'Anchors', 'Skills'].map((label, i) => (
            <span
              key={label}
              className="rounded-full font-semibold"
              style={{
                fontSize: '11px',
                padding: '4px 12px',
                background: i === 0 ? '#fff5f0' : 'transparent',
                color: i === 0 ? '#d63a00' : 'rgba(0,0,0,0.45)',
                border: i === 0 ? '1px solid rgba(214,58,0,0.15)' : '1px solid rgba(0,0,0,0.1)',
              }}
            >
              {label}
            </span>
          ))}
          <div className="flex-1" />
          {['Status ▾', 'Sort ▾'].map(label => (
            <span
              key={label}
              className="rounded-full font-semibold"
              style={{
                fontSize: '11px',
                padding: '4px 10px',
                background: 'transparent',
                color: 'rgba(0,0,0,0.45)',
                border: '1px solid rgba(0,0,0,0.1)',
              }}
            >
              {label}
            </span>
          ))}
        </div>

        <div className="flex flex-col overflow-hidden px-2 py-2 gap-2">
          {/* Anchors section */}
          <p
            className="font-bold flex-shrink-0"
            style={{ fontSize: '9px', color: 'rgba(0,0,0,0.35)', letterSpacing: '0.05em', padding: '0 4px' }}
          >
            ANCHORS
          </p>
          {MOCK_ANCHORS.slice(0, 3).map((anchor, i) => (
            <div
              key={i}
              className="rounded-lg p-2"
              style={{ background: '#ffffff', border: '1px solid rgba(0,0,0,0.06)' }}
            >
              <div className="flex items-center gap-1.5 mb-1">
                <div
                  style={{
                    width: '8px',
                    height: '8px',
                    borderRadius: '50%',
                    background: anchor.color,
                    flexShrink: 0,
                  }}
                />
                <span className="font-semibold flex-1" style={{ fontSize: '10px', color: '#1a1a1a' }}>
                  {anchor.name}
                </span>
                <span
                  className="font-bold rounded-full"
                  style={{
                    fontSize: '9px',
                    padding: '2px 7px',
                    background: '#fff5f0',
                    color: '#d63a00',
                  }}
                >
                  {anchor.score}
                </span>
                <HealthBadge status={anchor.status === 'Suggested' ? 'Thin' : anchor.status === 'Active' ? 'Strong' : 'Growing'} />
              </div>
              <p style={{ fontSize: '8px', color: '#888', paddingLeft: '16px' }}>
                {anchor.entityCount} entities · {anchor.connectionCount} connections
              </p>
            </div>
          ))}

          {/* Skills section */}
          <p
            className="font-bold flex-shrink-0"
            style={{ fontSize: '9px', color: 'rgba(0,0,0,0.35)', letterSpacing: '0.05em', padding: '4px 4px 0' }}
          >
            SKILLS
          </p>
          {MOCK_SKILLS.map((skill, i) => (
            <div
              key={i}
              className="rounded-lg p-2"
              style={{ background: '#ffffff', border: '1px solid rgba(0,0,0,0.06)' }}
            >
              <div className="flex items-center gap-2 mb-1">
                <p className="font-semibold flex-1" style={{ fontSize: '10px', color: '#1a1a1a' }}>
                  {skill.title}
                </p>
                <span
                  className="rounded-full font-semibold"
                  style={{
                    fontSize: '8px',
                    padding: '2px 6px',
                    background: skill.domainBg,
                    color: skill.domainColor,
                  }}
                >
                  {skill.domain}
                </span>
              </div>
              <p style={{ fontSize: '8px', color: '#888', lineHeight: '1.4' }}>
                {skill.description.substring(0, 80)}...
              </p>
            </div>
          ))}
        </div>
      </div>

      {/* Right: explainer panel */}
      <div className="flex-1 flex flex-col overflow-hidden px-3 py-3 gap-4" style={{ background: '#fff' }}>
        {/* Anchors explanation */}
        <div>
          <p className="font-bold mb-1" style={{ fontSize: '11px', color: '#1a1a1a' }}>
            What are Anchors?
          </p>
          <p style={{ fontSize: '9px', color: '#666', lineHeight: '1.5', marginBottom: '8px' }}>
            Anchors are your key focus areas — auto-detected themes that organize your knowledge graph into navigable clusters. Each anchor scores based on entity density and connection strength.
          </p>
          <div className="flex flex-wrap gap-1">
            {['Auto-detected themes', 'Cluster your graph', 'Score over time'].map(f => (
              <span
                key={f}
                className="rounded-full font-semibold"
                style={{
                  fontSize: '9px',
                  padding: '2px 8px',
                  background: '#fff5f0',
                  color: '#d63a00',
                  border: '1px solid rgba(214,58,0,0.15)',
                }}
              >
                {f}
              </span>
            ))}
          </div>
        </div>

        {/* Skills explanation */}
        <div>
          <p className="font-bold mb-1" style={{ fontSize: '11px', color: '#1a1a1a' }}>
            What are Skills?
          </p>
          <p style={{ fontSize: '9px', color: '#666', lineHeight: '1.5', marginBottom: '8px' }}>
            Skills are methodologies synthesized from your ingested content — frameworks, processes, and mental models extracted by Synapse and made reusable across queries and council reasoning.
          </p>
          <div className="flex flex-wrap gap-1">
            {['Synthesized frameworks', 'Used in Ask mode', 'Council-aware'].map(f => (
              <span
                key={f}
                className="rounded-full font-semibold"
                style={{
                  fontSize: '9px',
                  padding: '2px 8px',
                  background: '#f0f0f0',
                  color: 'rgba(0,0,0,0.5)',
                  border: '1px solid rgba(0,0,0,0.08)',
                }}
              >
                {f}
              </span>
            ))}
          </div>
        </div>

        {/* Health scoring */}
        <div>
          <p className="font-bold mb-1.5" style={{ fontSize: '11px', color: '#1a1a1a' }}>
            Health Scoring
          </p>
          <div className="flex flex-col gap-1.5">
            {(
              [
                ['Strong', 'Dense entity cluster, high connection count, recent activity.'],
                ['Growing', 'Active but still building density and connections.'],
                ['Thin', 'Few entities or connections — needs more content.'],
                ['Stale', 'No recent activity or new sources in this domain.'],
              ] as Array<['Strong' | 'Growing' | 'Thin' | 'Stale', string]>
            ).map(([status, desc]) => (
              <div key={status} className="flex items-center gap-2">
                <HealthBadge status={status} />
                <span style={{ fontSize: '9px', color: '#666' }}>{desc}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── MockCouncilPage ──────────────────────────────────────────────────────────

export function MockCouncilPage() {
  const signals = [
    {
      from: 'AI Systems Analyst',
      to: 'Product Strategist',
      text: 'ReAct pattern dominance suggests a platform-level architectural bet is needed now.',
    },
    {
      from: 'Market Researcher',
      to: 'AI Systems Analyst',
      text: 'Competitor products are converging on tool-use APIs — this is a timing signal.',
    },
    {
      from: 'Knowledge Architect',
      to: 'Product Strategist',
      text: 'Graph traversal costs are the hidden blocker to real-time agent memory.',
    },
  ]

  const insights = [
    {
      type: 'Convergence' as const,
      text: 'Tool-use as primary capability lever appears in 9 of 14 sources — strong consensus signal.',
    },
    {
      type: 'Tension' as const,
      text: 'Short-term vs long-term memory trade-offs debated across 4 separate sources without resolution.',
    },
  ]

  const overviewStats: Array<{ label: string; count: number; status: 'Strong' | 'Growing' | 'Thin' | 'Stale' }> = [
    { label: 'Strong', count: 3, status: 'Strong' },
    { label: 'Growing', count: 1, status: 'Growing' },
    { label: 'Thin', count: 1, status: 'Thin' },
    { label: 'Stale', count: 0, status: 'Stale' },
  ]

  return (
    <div className="flex h-full overflow-hidden">
      {/* Left panel */}
      <div
        className="flex flex-col overflow-hidden"
        style={{ width: '60%', borderRight: '1px solid rgba(0,0,0,0.07)' }}
      >
        {/* Toolbar */}
        <div
          className="flex items-center gap-2 px-3 flex-shrink-0"
          style={{
            height: '40px',
            borderBottom: '1px solid rgba(0,0,0,0.07)',
            background: '#fff',
          }}
        >
          {['All', 'Strong', 'Signals'].map((label, i) => (
            <span
              key={label}
              className="rounded-full font-semibold"
              style={{
                fontSize: '11px',
                padding: '4px 12px',
                background: i === 0 ? '#fff5f0' : 'transparent',
                color: i === 0 ? '#d63a00' : 'rgba(0,0,0,0.45)',
                border: i === 0 ? '1px solid rgba(214,58,0,0.15)' : '1px solid rgba(0,0,0,0.1)',
              }}
            >
              {label}
            </span>
          ))}
          <div className="flex-1" />
          <span
            className="rounded-full font-semibold"
            style={{
              fontSize: '11px',
              padding: '4px 10px',
              background: 'transparent',
              color: 'rgba(0,0,0,0.45)',
              border: '1px solid rgba(0,0,0,0.1)',
            }}
          >
            Health ▾
          </span>
        </div>

        {/* Advisor list */}
        <div className="flex flex-col overflow-hidden px-2 py-2 gap-1.5">
          {MOCK_ADVISORS.map((advisor, i) => (
            <div
              key={i}
              className="rounded-lg p-2"
              style={{ background: '#ffffff', border: '1px solid rgba(0,0,0,0.06)' }}
            >
              {/* Header row */}
              <div className="flex items-center gap-1.5 mb-1">
                <div
                  className="rounded flex-shrink-0"
                  style={{
                    width: '28px',
                    height: '28px',
                    background: advisor.iconBg,
                    borderRadius: '8px',
                  }}
                />
                <span className="font-semibold flex-1" style={{ fontSize: '10px', color: '#1a1a1a' }}>
                  {advisor.name}
                </span>
                <HealthBadge status={advisor.health} />
              </div>

              {/* Stats row */}
              <div className="flex gap-3 mb-1" style={{ paddingLeft: '36px' }}>
                <span style={{ fontSize: '8px', color: '#888' }}>{advisor.videoCount} sources</span>
                <span style={{ fontSize: '8px', color: '#888' }}>{advisor.insightCount} insights</span>
              </div>

              {/* Description */}
              <p
                style={{
                  fontSize: '9px',
                  color: '#666',
                  lineHeight: '1.4',
                  paddingLeft: '36px',
                  marginBottom: '6px',
                }}
              >
                {advisor.description.substring(0, 90)}...
              </p>

              {/* Theme pills */}
              <div className="flex flex-wrap gap-1" style={{ paddingLeft: '36px' }}>
                {advisor.themes.map(theme => (
                  <span
                    key={theme.label}
                    className="rounded-full font-semibold"
                    style={{
                      fontSize: '8px',
                      padding: '2px 6px',
                      background: theme.bgColor,
                      color: theme.color,
                    }}
                  >
                    {theme.label}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Right panel */}
      <div className="flex-1 flex flex-col overflow-hidden px-3 py-3 gap-3" style={{ background: '#fff' }}>
        {/* Council overview */}
        <div>
          <p className="font-bold mb-2" style={{ fontSize: '11px', color: '#1a1a1a' }}>
            Council Overview
          </p>
          <div className="grid grid-cols-2 gap-1.5">
            {overviewStats.map(({ label, count, status }) => (
              <div
                key={label}
                className="rounded-lg flex items-center gap-2 p-2"
                style={{ background: '#f8f8f8', border: '1px solid rgba(0,0,0,0.06)' }}
              >
                <HealthBadge status={status} />
                <span className="font-bold" style={{ fontSize: '13px', color: '#1a1a1a' }}>
                  {count}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Active signals */}
        <div>
          <p className="font-bold mb-1.5" style={{ fontSize: '11px', color: '#1a1a1a' }}>
            Active Signals
          </p>
          <div className="flex flex-col gap-1.5">
            {signals.map((signal, i) => (
              <div
                key={i}
                className="rounded-lg p-2"
                style={{ background: '#fafafa', border: '1px solid rgba(0,0,0,0.07)' }}
              >
                <p className="font-semibold mb-0.5" style={{ fontSize: '8px', color: '#d63a00' }}>
                  {signal.from} → {signal.to}:
                </p>
                <p style={{ fontSize: '8px', color: '#444', lineHeight: '1.4' }}>
                  &ldquo;{signal.text}&rdquo;
                </p>
              </div>
            ))}
          </div>
        </div>

        {/* Recent insights */}
        <div>
          <p className="font-bold mb-1.5" style={{ fontSize: '11px', color: '#1a1a1a' }}>
            Recent Insights
          </p>
          <div className="flex flex-col gap-1.5">
            {insights.map((insight, i) => (
              <div
                key={i}
                className="rounded-lg p-2"
                style={{ background: '#fafafa', border: '1px solid rgba(0,0,0,0.07)' }}
              >
                <span
                  className="rounded-full font-semibold inline-block mb-1"
                  style={{
                    fontSize: '8px',
                    padding: '2px 7px',
                    background: insight.type === 'Convergence' ? '#e8f5e9' : '#fff3e0',
                    color: insight.type === 'Convergence' ? '#2e7d32' : '#e65100',
                  }}
                >
                  {insight.type}
                </span>
                <p style={{ fontSize: '8px', color: '#444', lineHeight: '1.4' }}>
                  {insight.text}
                </p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
