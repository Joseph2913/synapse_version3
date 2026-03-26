import {
  Zap,
  Youtube,
  CheckCircle2,
  Clock,
  AlertCircle,
  Loader2,
  FileText,
  Link,
  Video,
  Mic,
  Globe,
  Search,
  ArrowRight,
  Sparkles,
  TrendingUp,
  Users,
  Target,
  Lightbulb,
  BarChart3,
  Calendar,
  Sun,
  BookOpen,
  Plus,
  ThumbsUp,
  ThumbsDown,
  GripVertical,
} from 'lucide-react'

/* ─── Shared helpers ─────────────────────────────────────────── */

const CARD: React.CSSProperties = {
  background: 'var(--color-bg-card)',
  border: '1px solid var(--border-subtle)',
  borderRadius: 12,
  padding: '16px 20px',
}

const SL: React.CSSProperties = {
  fontFamily: 'var(--font-display)',
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  color: 'var(--color-text-secondary)',
  marginBottom: 10,
}

const PILL_ACTIVE: React.CSSProperties = {
  padding: '5px 13px',
  borderRadius: 20,
  fontSize: 12,
  fontFamily: 'var(--font-body)',
  fontWeight: 600,
  border: '1px solid rgba(214,58,0,0.15)',
  background: 'var(--color-accent-50)',
  color: 'var(--color-accent-500)',
  cursor: 'default',
}

const PILL_INACTIVE: React.CSSProperties = {
  padding: '5px 13px',
  borderRadius: 20,
  fontSize: 12,
  fontFamily: 'var(--font-body)',
  fontWeight: 600,
  border: '1px solid var(--border-subtle)',
  background: 'transparent',
  color: 'var(--color-text-secondary)',
  cursor: 'default',
}

const CONTROL_BAR: React.CSSProperties = {
  minHeight: 44,
  padding: '8px 24px',
  gap: 8,
  background: 'var(--color-bg-card)',
  borderBottom: '1px solid var(--border-subtle)',
  display: 'flex',
  alignItems: 'center',
  flexShrink: 0,
  flexWrap: 'wrap',
}

const DIVIDER: React.CSSProperties = {
  width: 1,
  height: 24,
  background: 'var(--border-subtle)',
}

const BODY_13: React.CSSProperties = {
  fontFamily: 'var(--font-body)',
  fontSize: 13,
  color: 'var(--color-text-body)',
  lineHeight: 1.5,
}

const HEADING_15: React.CSSProperties = {
  fontFamily: 'var(--font-display)',
  fontSize: 15,
  fontWeight: 700,
  color: 'var(--color-text-primary)',
}

const STAT: React.CSSProperties = {
  fontFamily: 'var(--font-body)',
  fontSize: 11,
  fontWeight: 500,
  color: 'var(--color-text-secondary)',
}

function Badge({ color, label }: { color: string; label: string }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        padding: '2px 8px',
        borderRadius: 10,
        fontSize: 11,
        fontFamily: 'var(--font-body)',
        fontWeight: 600,
        background: `${color}15`,
        color,
      }}
    >
      <span style={{ width: 6, height: 6, borderRadius: 3, background: color }} />
      {label}
    </span>
  )
}

function StatusDot({ color }: { color: string }) {
  return (
    <span style={{ width: 8, height: 8, borderRadius: 4, background: color, flexShrink: 0 }} />
  )
}

function TwoColumnLayout({ left, right }: { left: React.ReactNode; right: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
      <div style={{ width: '64%', overflowY: 'auto', padding: '20px 36px', background: 'var(--color-bg-content)', flexShrink: 0 }}>
        {left}
      </div>
      {/* Drag handle — matches real app (12px, GripVertical, borderLeft) */}
      <div
        style={{
          width: 12,
          height: '100%',
          cursor: 'col-resize',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'var(--color-bg-content)',
          borderLeft: '1px solid var(--border-subtle)',
          flexShrink: 0,
          zIndex: 10,
        }}
      >
        <GripVertical size={14} style={{ color: 'var(--color-text-placeholder)', pointerEvents: 'none' }} />
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px', background: 'var(--color-bg-content)', minWidth: 0 }}>
        {right}
      </div>
    </div>
  )
}

/* ─── 0: Automate ────────────────────────────────────────────── */

function AutomateDemo() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={CONTROL_BAR}>
        <span style={PILL_ACTIVE}>All Sources <span style={{ opacity: 0.6, marginLeft: 4 }}>3</span></span>
        <span style={PILL_INACTIVE}>Active <span style={{ opacity: 0.6, marginLeft: 4 }}>2</span></span>
        <span style={PILL_INACTIVE}>Paused <span style={{ opacity: 0.6, marginLeft: 4 }}>1</span></span>
        <span style={DIVIDER} />
        <span style={STAT}>
          <span style={{ color: 'var(--color-semantic-green-500)', fontWeight: 600 }}>2 active</span>
          {' · '}59 sources processed
        </span>
        <span style={{ flex: 1 }} />
        <button
          style={{
            padding: '7px 14px',
            borderRadius: 8,
            fontSize: 12,
            fontFamily: 'var(--font-body)',
            fontWeight: 600,
            background: 'var(--color-accent-500)',
            color: '#fff',
            border: 'none',
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            cursor: 'default',
          }}
        >
          <Plus size={14} /> Connect Source
        </button>
      </div>

      <TwoColumnLayout
        left={
          <>
            <div style={SL}>CONNECTED INTEGRATIONS</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {/* Circleback */}
              <div style={CARD}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
                  <div style={{ width: 36, height: 36, borderRadius: 10, background: '#4F46E515', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <Mic size={18} style={{ color: '#4F46E5' }} />
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={HEADING_15}>Circleback</div>
                    <div style={{ ...STAT, marginTop: 2 }}>Meeting transcripts &amp; notes</div>
                  </div>
                  <Badge color="#22c55e" label="Connected" />
                </div>
                <div style={{ display: 'flex', gap: 24 }}>
                  <span style={STAT}>47 meetings synced</span>
                  <span style={STAT}>Last sync: 2h ago</span>
                  <span style={STAT}>Auto-extract: On</span>
                </div>
              </div>

              {/* YouTube */}
              <div style={CARD}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
                  <div style={{ width: 36, height: 36, borderRadius: 10, background: '#dc262615', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <Youtube size={18} style={{ color: '#dc2626' }} />
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={HEADING_15}>YouTube</div>
                    <div style={{ ...STAT, marginTop: 2 }}>Channel &amp; playlist monitoring</div>
                  </div>
                  <Badge color="#22c55e" label="Connected" />
                </div>
                <div style={{ display: 'flex', gap: 24 }}>
                  <span style={STAT}>12 channels monitored</span>
                  <span style={STAT}>Last sync: 30m ago</span>
                  <span style={STAT}>Auto-extract: On</span>
                </div>
              </div>

              {/* Web RSS */}
              <div style={CARD}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
                  <div style={{ width: 36, height: 36, borderRadius: 10, background: '#0891b215', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <Globe size={18} style={{ color: '#0891b2' }} />
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={HEADING_15}>RSS Feeds</div>
                    <div style={{ ...STAT, marginTop: 2 }}>Blog &amp; newsletter monitoring</div>
                  </div>
                  <Badge color="#f59e0b" label="Paused" />
                </div>
                <div style={{ display: 'flex', gap: 24 }}>
                  <span style={STAT}>8 feeds configured</span>
                  <span style={STAT}>Last sync: 3d ago</span>
                  <span style={STAT}>Auto-extract: Off</span>
                </div>
              </div>
            </div>
          </>
        }
        right={
          <div style={{ ...CARD, textAlign: 'center', padding: '40px 24px' }}>
            <Zap size={32} style={{ color: 'var(--color-text-placeholder)', marginBottom: 12 }} />
            <div style={{ ...HEADING_15, marginBottom: 8 }}>Source Details</div>
            <div style={BODY_13}>
              Click on a connected source to view its configuration, sync history, and processing stats.
            </div>
          </div>
        }
      />
    </div>
  )
}

/* ─── 1: Capture ─────────────────────────────────────────────── */

function CaptureDemo() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={CONTROL_BAR}>
        <span style={PILL_INACTIVE}><FileText size={12} style={{ marginRight: 4 }} />Text</span>
        <span style={PILL_INACTIVE}><Link size={12} style={{ marginRight: 4 }} />URL</span>
        <span style={PILL_ACTIVE}><FileText size={12} style={{ marginRight: 4 }} />Document</span>
        <span style={PILL_INACTIVE}><Mic size={12} style={{ marginRight: 4 }} />Transcript</span>
      </div>

      <TwoColumnLayout
        left={
          <>
            {/* Upload area */}
            <div
              style={{
                ...CARD,
                border: '2px dashed var(--color-accent-200)',
                textAlign: 'center',
                padding: '32px 20px',
                marginBottom: 16,
                background: 'var(--color-accent-50)',
              }}
            >
              <FileText size={28} style={{ color: 'var(--color-accent-400)', marginBottom: 10 }} />
              <div style={{ ...HEADING_15, marginBottom: 4 }}>Drop your document here</div>
              <div style={{ ...BODY_13, color: 'var(--color-text-secondary)' }}>
                PDF, DOCX, TXT, or Markdown up to 10MB
              </div>
            </div>

            {/* Uploaded file card */}
            <div style={{ ...CARD, marginBottom: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div style={{ width: 32, height: 32, borderRadius: 8, background: '#dc262610', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <FileText size={16} style={{ color: '#dc2626' }} />
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ ...BODY_13, fontWeight: 600, color: 'var(--color-text-primary)' }}>Q4-Strategy-Review.pdf</div>
                  <div style={STAT}>2.4 MB · 12 pages</div>
                </div>
                <Badge color="#22c55e" label="Ready" />
              </div>
            </div>

            {/* Extract button */}
            <button
              style={{
                width: '100%',
                padding: '9px 22px',
                borderRadius: 8,
                fontSize: 13,
                fontFamily: 'var(--font-body)',
                fontWeight: 600,
                background: 'var(--color-accent-500)',
                color: '#fff',
                border: 'none',
                cursor: 'default',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 8,
              }}
            >
              <Sparkles size={14} /> Extract Knowledge
            </button>

            {/* Extraction settings */}
            <div style={{ marginTop: 20 }}>
              <div style={SL}>EXTRACTION SETTINGS</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                <div style={{ ...CARD, padding: '10px 14px' }}>
                  <div style={{ ...STAT, marginBottom: 4 }}>Mode</div>
                  <div style={{ ...BODY_13, fontWeight: 600 }}>Balanced</div>
                </div>
                <div style={{ ...CARD, padding: '10px 14px' }}>
                  <div style={{ ...STAT, marginBottom: 4 }}>Emphasis</div>
                  <div style={{ ...BODY_13, fontWeight: 600 }}>Medium</div>
                </div>
              </div>
            </div>
          </>
        }
        right={
          <div>
            <div style={SL}>EXTRACTION PREVIEW</div>
            <div style={{ ...CARD, marginBottom: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                <Loader2 size={14} style={{ color: 'var(--color-accent-500)', animation: 'spin 1s linear infinite' }} />
                <span style={{ ...BODY_13, fontWeight: 600 }}>Extracting entities...</span>
              </div>
              <div style={{ height: 4, background: 'var(--color-bg-inset)', borderRadius: 2, marginBottom: 16 }}>
                <div style={{ height: '100%', width: '68%', background: 'var(--color-accent-500)', borderRadius: 2, transition: 'width 0.4s' }} />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <CheckCircle2 size={14} style={{ color: '#22c55e' }} />
                  <span style={BODY_13}>Document parsed (12 pages)</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <CheckCircle2 size={14} style={{ color: '#22c55e' }} />
                  <span style={BODY_13}>Chunked into 24 segments</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <Loader2 size={14} style={{ color: 'var(--color-accent-500)', animation: 'spin 1s linear infinite' }} />
                  <span style={BODY_13}>Extracting entities &amp; relations...</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, opacity: 0.4 }}>
                  <Clock size={14} />
                  <span style={BODY_13}>Embedding vectors</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, opacity: 0.4 }}>
                  <Clock size={14} />
                  <span style={BODY_13}>Merging into knowledge graph</span>
                </div>
              </div>
            </div>

            <div style={SL}>ENTITIES FOUND SO FAR</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              <Badge color="#d97706" label="Sarah Chen" />
              <Badge color="#7c3aed" label="Acme Corp" />
              <Badge color="#059669" label="Q4 Roadmap" />
              <Badge color="#0891b2" label="AI Strategy" />
              <Badge color="#e11d48" label="Revenue Target" />
              <Badge color="#2563eb" label="Hire ML Lead" />
              <Badge color="#db2777" label="Pivot to B2B" />
              <Badge color="#4f46e5" label="LLM Fine-tuning" />
            </div>
          </div>
        }
      />
    </div>
  )
}

/* ─── 2: Pipeline ────────────────────────────────────────────── */

function PipelineDemo() {
  const items = [
    { title: 'Q4 Strategy Review — Meeting Notes', type: 'Meeting', status: 'completed' as const, entities: 23, time: '2h ago' },
    { title: 'AI Agent Architecture Deep Dive', type: 'YouTube', status: 'completed' as const, entities: 31, time: '4h ago' },
    { title: 'Product Roadmap 2026 Planning', type: 'Document', status: 'completed' as const, entities: 18, time: '6h ago' },
    { title: 'Weekly Team Standup — March 18', type: 'Meeting', status: 'processing' as const, entities: 0, time: 'now' },
    { title: 'Investor Update Email Thread', type: 'Document', status: 'pending' as const, entities: 0, time: 'queued' },
    { title: 'Competitor Analysis Report', type: 'Document', status: 'failed' as const, entities: 0, time: '1h ago' },
  ]

  const icons: Record<string, React.ReactNode> = {
    Meeting: <Mic size={14} style={{ color: '#4F46E5' }} />,
    YouTube: <Video size={14} style={{ color: '#dc2626' }} />,
    Document: <FileText size={14} style={{ color: '#0891b2' }} />,
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={CONTROL_BAR}>
        <span style={PILL_ACTIVE}>All <span style={{ opacity: 0.6, marginLeft: 4 }}>6</span></span>
        <span style={PILL_INACTIVE}>Completed <span style={{ opacity: 0.6, marginLeft: 4 }}>3</span></span>
        <span style={PILL_INACTIVE}>Processing <span style={{ opacity: 0.6, marginLeft: 4 }}>1</span></span>
        <span style={{ ...PILL_INACTIVE, borderColor: '#fecaca', color: '#dc2626', background: '#fef2f2' }}>Failed <span style={{ opacity: 0.6, marginLeft: 4 }}>1</span></span>
        <span style={DIVIDER} />
        <span style={STAT}>72 entities extracted today</span>
      </div>

      <TwoColumnLayout
        left={
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {items.map((item, i) => (
              <div key={i} style={{ ...CARD, opacity: item.status === 'pending' ? 0.6 : 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <div style={{ width: 28, height: 28, borderRadius: 7, background: 'var(--color-bg-inset)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    {icons[item.type]}
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ ...BODY_13, fontWeight: 600, color: 'var(--color-text-primary)' }}>{item.title}</div>
                    <div style={{ ...STAT, display: 'flex', gap: 10, marginTop: 2 }}>
                      <span>{item.type}</span>
                      <span>{item.time}</span>
                      {item.entities > 0 && <span>{item.entities} entities</span>}
                    </div>
                  </div>
                  {item.status === 'completed' && <CheckCircle2 size={16} style={{ color: '#22c55e' }} />}
                  {item.status === 'processing' && <Loader2 size={16} style={{ color: 'var(--color-accent-500)', animation: 'spin 1s linear infinite' }} />}
                  {item.status === 'pending' && <Clock size={16} style={{ color: 'var(--color-text-placeholder)' }} />}
                  {item.status === 'failed' && <AlertCircle size={16} style={{ color: '#dc2626' }} />}
                </div>
              </div>
            ))}
          </div>
        }
        right={
          <div>
            <div style={SL}>FAILED EXTRACTION</div>
            <div style={{ ...CARD, borderColor: '#fecaca' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                <AlertCircle size={16} style={{ color: '#dc2626' }} />
                <span style={{ ...HEADING_15, color: '#dc2626' }}>Competitor Analysis Report</span>
              </div>
              <div style={{ ...BODY_13, marginBottom: 12 }}>
                Extraction failed due to a connection timeout while processing chunk 8 of 15. The document is likely too large to process in a single pass.
              </div>
              <div style={SL}>RECOMMENDED FIX</div>
              <div style={BODY_13}>
                Split the document into smaller sections or increase the extraction timeout in Settings. You can also retry with a lighter extraction mode.
              </div>
              <button
                style={{
                  marginTop: 12,
                  padding: '7px 14px',
                  borderRadius: 8,
                  fontSize: 12,
                  fontFamily: 'var(--font-body)',
                  fontWeight: 600,
                  background: 'var(--color-accent-500)',
                  color: '#fff',
                  border: 'none',
                  cursor: 'default',
                }}
              >
                Retry Extraction
              </button>
            </div>

            <div style={{ ...SL, marginTop: 20 }}>PIPELINE HEALTH</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <div style={{ ...CARD, padding: '10px 14px', textAlign: 'center' }}>
                <div style={{ fontFamily: 'var(--font-display)', fontSize: 22, fontWeight: 700, color: '#22c55e' }}>94%</div>
                <div style={STAT}>Success Rate</div>
              </div>
              <div style={{ ...CARD, padding: '10px 14px', textAlign: 'center' }}>
                <div style={{ fontFamily: 'var(--font-display)', fontSize: 22, fontWeight: 700, color: 'var(--color-text-primary)' }}>847</div>
                <div style={STAT}>Total Entities</div>
              </div>
            </div>
          </div>
        }
      />
    </div>
  )
}

/* ─── 3: Explore ─────────────────────────────────────────────── */

function ExploreDemo() {
  const anchors = [
    { label: 'AI Strategy', color: '#0891b2', entities: 84, connections: 142 },
    { label: 'Product Development', color: '#059669', entities: 67, connections: 98 },
    { label: 'Team Performance', color: '#d97706', entities: 45, connections: 71 },
    { label: 'Revenue Growth', color: '#e11d48', entities: 38, connections: 56 },
    { label: 'Market Research', color: '#7c3aed', entities: 29, connections: 43 },
  ]

  const entities = [
    { label: 'Sarah Chen', type: 'Person', color: '#d97706' },
    { label: 'LLM Fine-tuning', type: 'Topic', color: '#0891b2' },
    { label: 'Pivot to B2B', type: 'Decision', color: '#db2777' },
    { label: 'Hire ML Lead', type: 'Action', color: '#2563eb' },
    { label: 'Acme Corp', type: 'Organization', color: '#7c3aed' },
    { label: 'Series B Target', type: 'Goal', color: '#e11d48' },
  ]

  // Simple SVG graph
  const nodes = [
    { x: 200, y: 120, r: 24, label: 'AI Strategy', color: '#0891b2', isAnchor: true },
    { x: 380, y: 80, r: 14, label: 'LLMs', color: '#0891b2', isAnchor: false },
    { x: 420, y: 180, r: 14, label: 'Fine-tuning', color: '#4f46e5', isAnchor: false },
    { x: 120, y: 220, r: 20, label: 'Product Dev', color: '#059669', isAnchor: true },
    { x: 300, y: 240, r: 14, label: 'Roadmap', color: '#059669', isAnchor: false },
    { x: 80, y: 100, r: 14, label: 'Sarah Chen', color: '#d97706', isAnchor: false },
    { x: 480, y: 260, r: 16, label: 'Revenue', color: '#e11d48', isAnchor: true },
    { x: 260, y: 300, r: 12, label: 'B2B Pivot', color: '#db2777', isAnchor: false },
  ]
  const edges = [
    [0, 1], [0, 2], [0, 3], [0, 5], [3, 4], [3, 7], [4, 6], [1, 2], [6, 7],
  ]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={CONTROL_BAR}>
        <span style={PILL_ACTIVE}>Anchors</span>
        <span style={PILL_INACTIVE}>Entities</span>
        <span style={PILL_INACTIVE}>Sources</span>
        <span style={PILL_INACTIVE}>Graph</span>
        <span style={DIVIDER} />
        <span style={STAT}>847 nodes · 1,204 edges</span>
      </div>

      <TwoColumnLayout
        left={
          <>
            {/* Mini graph */}
            <div style={{ ...CARD, padding: 0, marginBottom: 16, overflow: 'hidden' }}>
              <svg width="100%" viewBox="0 0 560 340" style={{ display: 'block' }}>
                <defs>
                  {nodes.filter(n => n.isAnchor).map((n, i) => (
                    <radialGradient key={i} id={`glow-${i}`}>
                      <stop offset="0%" stopColor={n.color} stopOpacity="0.2" />
                      <stop offset="100%" stopColor={n.color} stopOpacity="0" />
                    </radialGradient>
                  ))}
                </defs>
                {/* Edges */}
                {edges.map(([a, b], i) => (
                  <line
                    key={i}
                    x1={nodes[a!]!.x} y1={nodes[a!]!.y}
                    x2={nodes[b!]!.x} y2={nodes[b!]!.y}
                    stroke="var(--color-border-default)"
                    strokeWidth={1.5}
                    opacity={0.4}
                  />
                ))}
                {/* Anchor glow */}
                {nodes.filter(n => n.isAnchor).map((n, i) => (
                  <circle key={`g${i}`} cx={n.x} cy={n.y} r={n.r + 12} fill={`url(#glow-${i})`} />
                ))}
                {/* Nodes */}
                {nodes.map((n, i) => (
                  <g key={i}>
                    <circle
                      cx={n.x} cy={n.y} r={n.r}
                      fill={`${n.color}22`}
                      stroke={n.color}
                      strokeWidth={n.isAnchor ? 2.5 : 1.5}
                    />
                    <text
                      x={n.x} y={n.y + n.r + 14}
                      textAnchor="middle"
                      style={{
                        fontSize: n.isAnchor ? 11 : 9,
                        fontFamily: 'var(--font-body)',
                        fontWeight: n.isAnchor ? 700 : 500,
                        fill: 'var(--color-text-body)',
                        pointerEvents: 'none',
                        userSelect: 'none',
                      }}
                    >
                      {n.label}
                    </text>
                  </g>
                ))}
              </svg>
            </div>

            <div style={SL}>ANCHOR OVERVIEW</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {anchors.map((a, i) => (
                <div key={i} style={{ ...CARD, display: 'flex', alignItems: 'center', gap: 12, cursor: 'default' }}>
                  <div style={{ width: 10, height: 10, borderRadius: 5, background: a.color, flexShrink: 0 }} />
                  <div style={{ flex: 1 }}>
                    <div style={{ ...BODY_13, fontWeight: 600, color: 'var(--color-text-primary)' }}>{a.label}</div>
                  </div>
                  <span style={STAT}>{a.entities} entities</span>
                  <span style={STAT}>{a.connections} connections</span>
                </div>
              ))}
            </div>
          </>
        }
        right={
          <div>
            <div style={SL}>ANCHOR DETAIL — AI STRATEGY</div>
            <div style={{ ...CARD, marginBottom: 16, borderLeft: '3px solid #0891b2' }}>
              <div style={{ ...HEADING_15, marginBottom: 4 }}>AI Strategy</div>
              <div style={{ ...BODY_13, color: 'var(--color-text-secondary)', marginBottom: 12 }}>
                Core anchor covering LLM strategy, model evaluation, deployment architecture, and AI product vision.
              </div>
              <div style={{ display: 'flex', gap: 16 }}>
                <div style={{ textAlign: 'center' }}>
                  <div style={{ fontFamily: 'var(--font-display)', fontSize: 20, fontWeight: 700, color: '#0891b2' }}>84</div>
                  <div style={STAT}>Entities</div>
                </div>
                <div style={{ textAlign: 'center' }}>
                  <div style={{ fontFamily: 'var(--font-display)', fontSize: 20, fontWeight: 700, color: '#0891b2' }}>142</div>
                  <div style={STAT}>Connections</div>
                </div>
                <div style={{ textAlign: 'center' }}>
                  <div style={{ fontFamily: 'var(--font-display)', fontSize: 20, fontWeight: 700, color: '#0891b2' }}>12</div>
                  <div style={STAT}>Sources</div>
                </div>
              </div>
            </div>

            <div style={SL}>ENTITIES IN THIS ANCHOR</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {entities.map((e, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', borderRadius: 8, background: 'var(--color-bg-card)', border: '1px solid var(--border-subtle)' }}>
                  <StatusDot color={e.color} />
                  <span style={{ ...BODY_13, fontWeight: 600, flex: 1 }}>{e.label}</span>
                  <Badge color={e.color} label={e.type} />
                </div>
              ))}
            </div>
          </div>
        }
      />
    </div>
  )
}

/* ─── 4: Ask ─────────────────────────────────────────────────── */

function AskDemo() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ ...CONTROL_BAR, minHeight: 40 }}>
        <span style={STAT}>3 messages · 12 sources referenced</span>
        <span style={{ flex: 1 }} />
        <span style={STAT}>Context: All knowledge</span>
      </div>

      <TwoColumnLayout
        left={
          <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 16, paddingBottom: 80 }}>
              {/* User message */}
              <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <div style={{ maxWidth: '75%', padding: '12px 16px', borderRadius: '14px 14px 4px 14px', background: 'var(--color-accent-500)', color: '#fff' }}>
                  <div style={{ ...BODY_13, color: '#fff' }}>
                    What were the key decisions from last week's strategy meeting?
                  </div>
                </div>
              </div>

              {/* AI response */}
              <div style={{ maxWidth: '85%' }}>
                <div style={{ ...CARD, borderRadius: '4px 14px 14px 14px' }}>
                  <div style={{ ...BODY_13, marginBottom: 12 }}>
                    Based on the Q4 Strategy Review meeting notes and related sources, here are the key decisions:
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12 }}>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                      <span style={{ ...BODY_13, color: 'var(--color-accent-500)', fontWeight: 700, flexShrink: 0 }}>1.</span>
                      <span style={BODY_13}><strong>Pivot to B2B focus</strong> — The team decided to shift primary go-to-market strategy from consumer to enterprise, targeting mid-market companies first. <sup style={{ color: 'var(--color-accent-500)', cursor: 'pointer' }}>[1]</sup></span>
                    </div>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                      <span style={{ ...BODY_13, color: 'var(--color-accent-500)', fontWeight: 700, flexShrink: 0 }}>2.</span>
                      <span style={BODY_13}><strong>Hire ML Lead by April</strong> — Sarah Chen proposed bringing in a dedicated ML engineering lead to accelerate the fine-tuning pipeline. Budget approved. <sup style={{ color: 'var(--color-accent-500)', cursor: 'pointer' }}>[2]</sup></span>
                    </div>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                      <span style={{ ...BODY_13, color: 'var(--color-accent-500)', fontWeight: 700, flexShrink: 0 }}>3.</span>
                      <span style={BODY_13}><strong>Deprecate legacy API</strong> — v1 API sunset moved to June, giving enterprise clients 90 days migration window. <sup style={{ color: 'var(--color-accent-500)', cursor: 'pointer' }}>[1][3]</sup></span>
                    </div>
                  </div>

                  {/* Source citations */}
                  <div style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: 10 }}>
                    <div style={{ ...STAT, marginBottom: 6 }}>Sources</div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      {[
                        { id: '1', title: 'Q4 Strategy Review — Meeting Notes', type: 'Meeting' },
                        { id: '2', title: 'Hiring Plan Q2 2026', type: 'Document' },
                        { id: '3', title: 'API Migration Playbook', type: 'Document' },
                      ].map(s => (
                        <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px', borderRadius: 6, background: 'var(--color-bg-inset)', fontSize: 11, fontFamily: 'var(--font-body)' }}>
                          <span style={{ color: 'var(--color-accent-500)', fontWeight: 700 }}>[{s.id}]</span>
                          <span style={{ color: 'var(--color-text-body)' }}>{s.title}</span>
                          <span style={{ color: 'var(--color-text-secondary)', marginLeft: 'auto' }}>{s.type}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Chat input */}
            <div style={{ position: 'relative' }}>
              <div
                style={{
                  ...CARD,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '10px 16px',
                  borderRadius: 14,
                }}
              >
                <Search size={16} style={{ color: 'var(--color-text-placeholder)', flexShrink: 0 }} />
                <span style={{ ...BODY_13, color: 'var(--color-text-placeholder)' }}>Ask anything about your knowledge base...</span>
                <ArrowRight size={16} style={{ color: 'var(--color-accent-500)', marginLeft: 'auto', flexShrink: 0 }} />
              </div>
            </div>
          </div>
        }
        right={
          <div>
            <div style={SL}>REFERENCED ENTITIES</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 20 }}>
              {[
                { label: 'Pivot to B2B', type: 'Decision', color: '#db2777' },
                { label: 'Sarah Chen', type: 'Person', color: '#d97706' },
                { label: 'ML Engineering Lead', type: 'Action', color: '#2563eb' },
                { label: 'Legacy API Sunset', type: 'Decision', color: '#db2777' },
              ].map((e, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', borderRadius: 8, background: 'var(--color-bg-card)', border: '1px solid var(--border-subtle)' }}>
                  <StatusDot color={e.color} />
                  <span style={{ ...BODY_13, fontWeight: 600, flex: 1 }}>{e.label}</span>
                  <Badge color={e.color} label={e.type} />
                </div>
              ))}
            </div>

            <div style={SL}>QUERY CONTEXT</div>
            <div style={{ ...CARD, padding: '12px 16px' }}>
              <div style={{ ...BODY_13, color: 'var(--color-text-secondary)' }}>
                Searched across <strong style={{ color: 'var(--color-text-primary)' }}>847 entities</strong> and <strong style={{ color: 'var(--color-text-primary)' }}>156 sources</strong>. Retrieved 12 relevant chunks using Graph RAG with anchor-weighted scoring.
              </div>
            </div>
          </div>
        }
      />
    </div>
  )
}

/* ─── 5: Orient ──────────────────────────────────────────────── */

function OrientDemo() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={CONTROL_BAR}>
        <span style={PILL_ACTIVE}>All Digests <span style={{ opacity: 0.6, marginLeft: 4 }}>3</span></span>
        <span style={PILL_INACTIVE}>Daily <span style={{ opacity: 0.6, marginLeft: 4 }}>1</span></span>
        <span style={PILL_INACTIVE}>Weekly <span style={{ opacity: 0.6, marginLeft: 4 }}>1</span></span>
        <span style={PILL_INACTIVE}>Monthly <span style={{ opacity: 0.6, marginLeft: 4 }}>1</span></span>
        <span style={DIVIDER} />
        <span style={STAT}>
          <span style={{ color: 'var(--color-semantic-green-500)', fontWeight: 600 }}>3 active</span>
        </span>
        <span style={{ flex: 1 }} />
        <button
          style={{
            padding: '7px 14px',
            borderRadius: 8,
            fontSize: 12,
            fontFamily: 'var(--font-body)',
            fontWeight: 600,
            background: 'var(--color-accent-500)',
            color: '#fff',
            border: 'none',
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            cursor: 'default',
          }}
        >
          <Plus size={14} /> New Digest
        </button>
      </div>

      <TwoColumnLayout
        left={
          <>
            <div style={SL}>DAILY DIGESTS</div>
            <div style={{ ...CARD, marginBottom: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                <Sun size={16} style={{ color: '#f59e0b' }} />
                <div style={{ flex: 1 }}>
                  <div style={{ ...BODY_13, fontWeight: 600, color: 'var(--color-text-primary)' }}>Morning Briefing</div>
                  <div style={STAT}>Every day at 7:00 AM · Covers AI Strategy, Product Dev</div>
                </div>
                <Badge color="#22c55e" label="Active" />
              </div>
              <div style={{ ...BODY_13, color: 'var(--color-text-secondary)' }}>
                Surfaces key developments, new entities, and action items from the past 24 hours across your top anchors.
              </div>
            </div>

            <div style={SL}>WEEKLY DIGESTS</div>
            <div style={{ ...CARD, marginBottom: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                <Calendar size={16} style={{ color: '#3b82f6' }} />
                <div style={{ flex: 1 }}>
                  <div style={{ ...BODY_13, fontWeight: 600, color: 'var(--color-text-primary)' }}>Weekly Strategy Recap</div>
                  <div style={STAT}>Every Monday at 8:00 AM · All anchors</div>
                </div>
                <Badge color="#22c55e" label="Active" />
              </div>
              <div style={{ ...BODY_13, color: 'var(--color-text-secondary)' }}>
                Comprehensive review of the week: key decisions, emerging themes, knowledge graph growth, and recommended focus areas.
              </div>
            </div>

            <div style={SL}>MONTHLY DIGESTS</div>
            <div style={CARD}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                <BookOpen size={16} style={{ color: '#7c3aed' }} />
                <div style={{ flex: 1 }}>
                  <div style={{ ...BODY_13, fontWeight: 600, color: 'var(--color-text-primary)' }}>Monthly Intelligence Report</div>
                  <div style={STAT}>1st of each month · All anchors + trends</div>
                </div>
                <Badge color="#22c55e" label="Active" />
              </div>
              <div style={{ ...BODY_13, color: 'var(--color-text-secondary)' }}>
                Deep analysis of knowledge trends, anchor evolution, cross-domain connections, and strategic insights over the past month.
              </div>
            </div>
          </>
        }
        right={
          <div>
            <div style={SL}>DIGEST PREVIEW — MORNING BRIEFING</div>
            <div style={{ ...CARD, borderLeft: '3px solid #f59e0b' }}>
              <div style={{ ...HEADING_15, marginBottom: 8 }}>Morning Briefing — March 19</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div>
                  <div style={{ ...STAT, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4, fontWeight: 700 }}>AI Strategy</div>
                  <div style={BODY_13}>
                    New decision captured: team agreed to evaluate Claude 4 for production workloads. 3 new entities extracted from yesterday's architecture review.
                  </div>
                </div>
                <div>
                  <div style={{ ...STAT, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4, fontWeight: 700 }}>Product Development</div>
                  <div style={BODY_13}>
                    Roadmap updated with Q3 milestones. New risk identified: dependency on third-party embedding API. Action item: evaluate self-hosted alternatives.
                  </div>
                </div>
                <div>
                  <div style={{ ...STAT, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4, fontWeight: 700 }}>Quick Stats</div>
                  <div style={{ display: 'flex', gap: 16 }}>
                    <span style={STAT}>+14 entities</span>
                    <span style={STAT}>+3 sources</span>
                    <span style={STAT}>+22 connections</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        }
      />
    </div>
  )
}

/* ─── 6: Anchors ─────────────────────────────────────────────── */

function AnchorsDemo() {
  const confirmed = [
    { label: 'AI Strategy', color: '#0891b2', entities: 84, score: 0.94 },
    { label: 'Product Development', color: '#059669', entities: 67, score: 0.89 },
    { label: 'Team Performance', color: '#d97706', entities: 45, score: 0.82 },
    { label: 'Revenue Growth', color: '#e11d48', entities: 38, score: 0.78 },
  ]

  const suggested = [
    { label: 'Developer Experience', color: '#4f46e5', entities: 22, score: 0.71, reason: 'High co-occurrence with Product Development entities across 8 sources' },
    { label: 'Customer Feedback', color: '#0891b2', entities: 18, score: 0.67, reason: 'Central node in decision and insight clusters; connected to 4 existing anchors' },
    { label: 'Competitive Intelligence', color: '#dc2626', entities: 15, score: 0.63, reason: 'Emerging topic cluster with growing entity density over the past 2 weeks' },
  ]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={CONTROL_BAR}>
        <span style={PILL_ACTIVE}>All <span style={{ opacity: 0.6, marginLeft: 4 }}>7</span></span>
        <span style={PILL_INACTIVE}>Confirmed <span style={{ opacity: 0.6, marginLeft: 4 }}>4</span></span>
        <span style={{ ...PILL_INACTIVE, ...(true ? { borderColor: '#fef3c7', color: '#d97706', background: '#fffbeb' } : {}) }}>Suggested <span style={{ opacity: 0.6, marginLeft: 4 }}>3</span></span>
        <span style={DIVIDER} />
        <span style={STAT}>4 confirmed · <span style={{ color: '#d97706' }}>3 suggested</span></span>
        <span style={{ flex: 1 }} />
        <button
          style={{
            padding: '7px 14px',
            borderRadius: 8,
            fontSize: 12,
            fontFamily: 'var(--font-body)',
            fontWeight: 600,
            background: 'var(--color-accent-500)',
            color: '#fff',
            border: 'none',
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            cursor: 'default',
          }}
        >
          <Plus size={14} /> New Anchor
        </button>
      </div>

      <TwoColumnLayout
        left={
          <>
            {/* Suggested batch bar */}
            <div style={{ ...CARD, background: '#fffbeb', borderColor: '#fef3c7', marginBottom: 16, display: 'flex', alignItems: 'center', gap: 10 }}>
              <Sparkles size={16} style={{ color: '#d97706' }} />
              <span style={{ ...BODY_13, fontWeight: 600, color: '#92400e' }}>3 new anchors suggested</span>
              <span style={{ ...STAT, color: '#92400e' }}>Review below to accept or dismiss</span>
            </div>

            <div style={SL}>SUGGESTED</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 20 }}>
              {suggested.map((a, i) => (
                <div key={i} style={{ ...CARD, borderLeft: `3px solid ${a.color}` }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
                    <div style={{ width: 10, height: 10, borderRadius: 5, background: a.color }} />
                    <span style={{ ...BODY_13, fontWeight: 600, color: 'var(--color-text-primary)', flex: 1 }}>{a.label}</span>
                    <span style={STAT}>{a.entities} entities · score {a.score}</span>
                  </div>
                  <div style={{ ...STAT, marginBottom: 8, fontStyle: 'italic' }}>{a.reason}</div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '4px 10px', borderRadius: 6, fontSize: 11, fontFamily: 'var(--font-body)', fontWeight: 600, background: '#f0fdf4', color: '#15803d', border: '1px solid #bbf7d0', cursor: 'default' }}>
                      <ThumbsUp size={11} /> Accept
                    </button>
                    <button style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '4px 10px', borderRadius: 6, fontSize: 11, fontFamily: 'var(--font-body)', fontWeight: 600, background: 'var(--color-bg-inset)', color: 'var(--color-text-secondary)', border: '1px solid var(--border-subtle)', cursor: 'default' }}>
                      <ThumbsDown size={11} /> Dismiss
                    </button>
                  </div>
                </div>
              ))}
            </div>

            <div style={SL}>YOUR ANCHORS</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {confirmed.map((a, i) => (
                <div key={i} style={{ ...CARD, display: 'flex', alignItems: 'center', gap: 12 }}>
                  <div style={{ width: 10, height: 10, borderRadius: 5, background: a.color }} />
                  <span style={{ ...BODY_13, fontWeight: 600, color: 'var(--color-text-primary)', flex: 1 }}>{a.label}</span>
                  <span style={STAT}>{a.entities} entities</span>
                  <span style={STAT}>score {a.score}</span>
                </div>
              ))}
            </div>
          </>
        }
        right={
          <div>
            <div style={SL}>HOW ANCHORS ARE SURFACED</div>
            <div style={{ ...CARD, marginBottom: 16 }}>
              <div style={{ ...HEADING_15, marginBottom: 8 }}>Anchor Discovery</div>
              <div style={{ ...BODY_13, marginBottom: 10 }}>
                Synapse automatically identifies potential anchors by analysing your knowledge graph for high-centrality concept clusters. The scoring methodology combines:
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                  <TrendingUp size={14} style={{ color: 'var(--color-accent-500)', flexShrink: 0, marginTop: 2 }} />
                  <div>
                    <div style={{ ...BODY_13, fontWeight: 600 }}>Entity Co-occurrence</div>
                    <div style={STAT}>How frequently entities appear together across different sources</div>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                  <BarChart3 size={14} style={{ color: 'var(--color-accent-500)', flexShrink: 0, marginTop: 2 }} />
                  <div>
                    <div style={{ ...BODY_13, fontWeight: 600 }}>Graph Centrality</div>
                    <div style={STAT}>Betweenness and degree centrality within the knowledge graph</div>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                  <Users size={14} style={{ color: 'var(--color-accent-500)', flexShrink: 0, marginTop: 2 }} />
                  <div>
                    <div style={{ ...BODY_13, fontWeight: 600 }}>Cross-source Density</div>
                    <div style={STAT}>Topics that bridge multiple source types (meetings, docs, videos)</div>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                  <Target size={14} style={{ color: 'var(--color-accent-500)', flexShrink: 0, marginTop: 2 }} />
                  <div>
                    <div style={{ ...BODY_13, fontWeight: 600 }}>Momentum Scoring</div>
                    <div style={STAT}>Recent growth velocity — topics gaining traction get surfaced faster</div>
                  </div>
                </div>
              </div>
            </div>

            <div style={{ ...CARD, background: 'var(--color-accent-50)', borderColor: 'rgba(214,58,0,0.15)' }}>
              <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                <Lightbulb size={16} style={{ color: 'var(--color-accent-500)', flexShrink: 0, marginTop: 2 }} />
                <div style={BODY_13}>
                  <strong>You're always in control.</strong> Suggested anchors are recommendations — you decide which ones to add. You can also create anchors manually for topics that matter to you.
                </div>
              </div>
            </div>
          </div>
        }
      />
    </div>
  )
}

/* ─── 7: Home ────────────────────────────────────────────────── */

function HomeDemo() {
  const sources = [
    { title: 'Q4 Strategy Review — Meeting Notes', type: 'Meeting', icon: Mic, color: '#4F46E5', time: '2 hours ago', entities: 23, summary: 'Key decisions on B2B pivot, ML hiring, and API migration timeline.' },
    { title: 'AI Agent Architecture Deep Dive', type: 'YouTube', icon: Video, color: '#dc2626', time: '4 hours ago', entities: 31, summary: 'Comprehensive breakdown of multi-agent orchestration patterns and tool-use frameworks.' },
    { title: 'Product Roadmap 2026 Planning', type: 'Document', icon: FileText, color: '#0891b2', time: '6 hours ago', entities: 18, summary: 'Q2-Q4 milestones, resource allocation, and dependency mapping for core platform.' },
    { title: 'Weekly Team Standup — March 17', type: 'Meeting', icon: Mic, color: '#4F46E5', time: 'Yesterday', entities: 14, summary: 'Sprint progress, blockers on data pipeline, and upcoming demo prep.' },
    { title: 'Investor Update Draft', type: 'Document', icon: FileText, color: '#0891b2', time: 'Yesterday', entities: 9, summary: 'Q1 metrics summary, user growth trajectory, and Series B positioning.' },
  ]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ ...CONTROL_BAR, gap: 16 }}>
        <span style={HEADING_15}>Good morning</span>
        <span style={DIVIDER} />
        <span style={STAT}>847 nodes · 1,204 edges · 156 sources</span>
        <span style={{ flex: 1 }} />
        <span style={STAT}>Last ingestion: 2h ago</span>
      </div>

      <TwoColumnLayout
        left={
          <>
            <div style={SL}>RECENT SOURCES</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {sources.map((s, i) => {
                const Icon = s.icon
                return (
                  <div key={i} style={{ ...CARD, cursor: 'default' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
                      <div style={{ width: 32, height: 32, borderRadius: 8, background: `${s.color}12`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        <Icon size={16} style={{ color: s.color }} />
                      </div>
                      <div style={{ flex: 1 }}>
                        <div style={{ ...BODY_13, fontWeight: 600, color: 'var(--color-text-primary)' }}>{s.title}</div>
                        <div style={{ ...STAT, display: 'flex', gap: 10, marginTop: 1 }}>
                          <span>{s.type}</span>
                          <span>{s.time}</span>
                          <span>{s.entities} entities</span>
                        </div>
                      </div>
                    </div>
                    <div style={{ ...BODY_13, color: 'var(--color-text-secondary)' }}>{s.summary}</div>
                  </div>
                )
              })}
            </div>
          </>
        }
        right={
          <div>
            <div style={SL}>SOURCE DETAIL</div>
            <div style={{ ...CARD, marginBottom: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                <div style={{ width: 32, height: 32, borderRadius: 8, background: '#4F46E512', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <Mic size={16} style={{ color: '#4F46E5' }} />
                </div>
                <div>
                  <div style={{ ...HEADING_15 }}>Q4 Strategy Review</div>
                  <div style={STAT}>Meeting · 2 hours ago · 23 entities</div>
                </div>
              </div>
              <div style={{ ...BODY_13, color: 'var(--color-text-secondary)', marginBottom: 12 }}>
                Key decisions on B2B pivot, ML hiring, and API migration timeline. Connected to AI Strategy and Product Development anchors.
              </div>

              <div style={{ ...SL, marginTop: 12 }}>KEY ENTITIES</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 16 }}>
                <Badge color="#db2777" label="Pivot to B2B" />
                <Badge color="#d97706" label="Sarah Chen" />
                <Badge color="#2563eb" label="Hire ML Lead" />
                <Badge color="#059669" label="Q4 Roadmap" />
                <Badge color="#dc2626" label="API Sunset Risk" />
              </div>

              <div style={SL}>CONNECTED ANCHORS</div>
              <div style={{ display: 'flex', gap: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 10px', borderRadius: 6, background: '#0891b210', border: '1px solid #0891b230' }}>
                  <StatusDot color="#0891b2" />
                  <span style={{ fontSize: 11, fontFamily: 'var(--font-body)', fontWeight: 600, color: '#0891b2' }}>AI Strategy</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 10px', borderRadius: 6, background: '#05966910', border: '1px solid #05966930' }}>
                  <StatusDot color="#059669" />
                  <span style={{ fontSize: 11, fontFamily: 'var(--font-body)', fontWeight: 600, color: '#059669' }}>Product Dev</span>
                </div>
              </div>
            </div>

            <div style={SL}>QUICK STATS TODAY</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <div style={{ ...CARD, padding: '10px 14px', textAlign: 'center' }}>
                <div style={{ fontFamily: 'var(--font-display)', fontSize: 20, fontWeight: 700, color: 'var(--color-accent-500)' }}>5</div>
                <div style={STAT}>Sources today</div>
              </div>
              <div style={{ ...CARD, padding: '10px 14px', textAlign: 'center' }}>
                <div style={{ fontFamily: 'var(--font-display)', fontSize: 20, fontWeight: 700, color: 'var(--color-accent-500)' }}>95</div>
                <div style={STAT}>Entities extracted</div>
              </div>
            </div>
          </div>
        }
      />
    </div>
  )
}

/* ─── Main export ────────────────────────────────────────────── */

const DEMO_VIEWS = [
  AutomateDemo,
  CaptureDemo,
  PipelineDemo,
  ExploreDemo,
  AskDemo,
  OrientDemo,
  AnchorsDemo,
  HomeDemo,
]

export function DemoContent({ step }: { step: number }) {
  const View = DEMO_VIEWS[step]
  if (!View) return null
  return <View />
}
