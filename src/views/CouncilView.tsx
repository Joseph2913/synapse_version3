import { useState, useRef, useCallback } from 'react'
import { GripVertical, ChevronDown, ChevronRight, ArrowLeft, Sparkles, Clock, Search, RefreshCw, Bot, Globe, Landmark, Trophy, Dice5, Brain, HelpCircle, Zap, ArrowUpRight, Circle, Check, type LucideIcon } from 'lucide-react'

// ── Design tokens (inline for mockup) ───────────────────────────────────────

const HEALTH_COLORS: Record<string, { bg: string; text: string; label: string }> = {
  strong:       { bg: '#dcfce7', text: '#15803d', label: 'Strong' },
  growing:      { bg: '#d1fae5', text: '#047857', label: 'Growing' },
  thin:         { bg: '#fef3c7', text: '#b45309', label: 'Thin' },
  stale:        { bg: '#fee2e2', text: '#dc2626', label: 'Stale' },
  initialising: { bg: '#f3f4f6', text: '#6b7280', label: 'Init' },
}

const ENTITY_COLORS = {
  topic: '#6366f1',
  concept: '#8b5cf6',
  person: '#ec4899',
  technology: '#06b6d4',
  organization: '#f59e0b',
  insight: '#10b981',
  decision: '#ef4444',
  project: '#3b82f6',
  risk: '#dc2626',
  action: '#14b8a6',
  goal: '#84cc16',
  product: '#f97316',
} as const

const QUESTION_DOT_COLORS: Record<string, string> = {
  gap_driven: '#d63a00',
  frontier: '#0d9488',
  cross_domain: '#7c3aed',
  user_defined: '#6b7280',
}

const INSIGHT_BADGE: Record<string, { bg: string; text: string; label: string }> = {
  tension:          { bg: '#fef3c7', text: '#b45309', label: 'TENSION' },
  convergence:      { bg: '#dcfce7', text: '#15803d', label: 'CONVERGENCE' },
  novel_connection: { bg: '#e0e7ff', text: '#4338ca', label: 'CONNECTION' },
}

// ── Data Types ──────────────────────────────────────────────────────────────

interface Advisor {
  id: string
  name: string
  icon: LucideIcon
  iconBg: string
  iconColor: string
  description: string
  reasoningStyle: string
  playlistName: string
  videoCount: number
  entityCount: number
  health: string
  updatedAgo: string
  themes: Array<{ label: string; color: string }>
  standingQuestions: number
  newInsights: number
  signalsOut: number
  gaps: number
  expertiseIndex?: Array<{ area: string; confidence: number }>
  weakAreas?: string[]
  coreThemes?: string[]
  crossDomainBridges?: Array<{ target: string; description: string }>
  linkedAnchors?: string[]
  awarenessRegister?: Array<{ agent: string; summary: string }>
  questions?: StandingQuestion[]
  insights?: AgentInsight[]
  agentGaps?: AgentGap[]
  signals?: AgentSignal[]
}

interface StandingQuestion {
  id: string
  question: string
  type: string
  status: string
  age: string
  trigger?: string
  evidence?: string
}

interface AgentInsight {
  id: string
  type: string
  claim: string
  confidence: number
  sourceCount: number
  sourceAttribution: string
}

interface AgentGap {
  id: string
  type: string
  severity: string
  topic: string
  description: string
  suggestion: string
}

interface AgentSignal {
  id: string
  target: string
  reason: string
  status: string
  timestamp: string
}

// ── Sample Data ─────────────────────────────────────────────────────────────

const ADVISORS: Advisor[] = [
  { id: 'ai-upskilling', name: 'AI Upskilling', icon: Bot, iconBg: '#ede9fe', iconColor: '#7c3aed', description: 'Tracks developments in AI engineering, LLM capabilities, agent architectures, and practical AI implementation patterns.', reasoningStyle: 'Technical-analytical with emphasis on practical implementation over theory.', playlistName: 'AI Upskilling Playlist', videoCount: 46, entityCount: 1284, health: 'strong', updatedAgo: '2 hours ago', themes: [{ label: 'LLM Agents', color: ENTITY_COLORS.technology }, { label: 'RAG Pipelines', color: ENTITY_COLORS.concept }, { label: 'Prompt Engineering', color: ENTITY_COLORS.topic }], standingQuestions: 3, newInsights: 2, signalsOut: 3, gaps: 1, expertiseIndex: [{ area: 'LLM Agent Architectures', confidence: 0.92 }, { area: 'RAG Pipeline Design', confidence: 0.88 }, { area: 'Prompt Engineering', confidence: 0.85 }], weakAreas: ['Multimodal models', 'On-device inference'], coreThemes: ['Agent autonomy', 'Knowledge retrieval', 'Evaluation methods'], crossDomainBridges: [{ target: 'Philosophy', description: 'Agent autonomy ethics' }, { target: 'Second Brain', description: 'Knowledge graph as RAG substrate' }], linkedAnchors: ['Personal AI Infrastructure', 'Agent Reliability'], awarenessRegister: [{ agent: 'Geopolitics', summary: 'Tracking AI governance and US-China chip competition' }, { agent: 'Philosophy', summary: 'Epistemology of AI reasoning' }], questions: [{ id: 'q1', question: 'What are the failure modes when LLM agents are given long-horizon tasks with ambiguous success criteria?', type: 'gap_driven', status: 'open', age: '3 days', trigger: 'No sources cover agent failure taxonomy beyond simple retry logic' }, { id: 'q2', question: 'How does Karpathy\'s "wiki" approach compare with vector-based RAG for factual accuracy?', type: 'frontier', status: 'partially_addressed', age: '1 week', evidence: '2 sources partially address this' }, { id: 'q3', question: 'Can philosophical frameworks for epistemic humility improve agent self-assessment?', type: 'cross_domain', status: 'open', age: '5 days' }], insights: [{ id: 'i1', type: 'tension', claim: 'Sources disagree on whether autonomous agents should self-correct or defer to human review.', confidence: 0.82, sourceCount: 4, sourceAttribution: 'Karpathy Lecture #12, LangChain Webinar, Anthropic Safety Paper' }, { id: 'i2', type: 'novel_connection', claim: 'Karpathy\'s wiki-style knowledge maps directly onto Synapse\'s entity-relationship pipeline.', confidence: 0.76, sourceCount: 2, sourceAttribution: 'Karpathy Lecture #8 ↔ Synapse Architecture Notes' }], agentGaps: [{ id: 'g1', type: 'structural', severity: 'significant', topic: 'Agent reliability in production', description: 'No sources cover monitoring or failure recovery for deployed LLM agents.', suggestion: 'Seek content on LLMOps or production post-mortems.' }], signals: [{ id: 's1', target: 'Philosophy', reason: 'Bridge entity "epistemic humility"', status: 'pending', timestamp: '2 hours ago' }, { id: 's2', target: 'Second Brain', reason: 'Karpathy wiki ↔ knowledge graph methodology', status: 'processed', timestamp: '1 day ago' }, { id: 's3', target: 'Geopolitics', reason: 'US AI executive order → open-source model access', status: 'pending', timestamp: '3 hours ago' }] },
  { id: 'geopolitics', name: 'Geopolitics', icon: Globe, iconBg: '#dbeafe', iconColor: '#2563eb', description: 'Monitors geopolitical dynamics, great power competition, and economic statecraft.', reasoningStyle: 'Multi-stakeholder analysis with emphasis on second-order effects.', playlistName: 'Geopolitics Playlist', videoCount: 9, entityCount: 312, health: 'growing', updatedAgo: '1 day ago', themes: [{ label: 'US-China Relations', color: ENTITY_COLORS.topic }, { label: 'Chip Wars', color: ENTITY_COLORS.concept }], standingQuestions: 2, newInsights: 1, signalsOut: 1, gaps: 2 },
  { id: 'philosophy', name: 'Philosophy', icon: Landmark, iconBg: '#fce7f3', iconColor: '#db2777', description: 'Explores epistemology, ethics, philosophy of mind, and reasoning frameworks.', reasoningStyle: 'Socratic questioning, dialectical analysis.', playlistName: 'Philosophy Playlist', videoCount: 4, entityCount: 89, health: 'thin', updatedAgo: '5 days ago', themes: [{ label: 'Epistemology', color: ENTITY_COLORS.concept }, { label: 'Ethics', color: ENTITY_COLORS.topic }], standingQuestions: 1, newInsights: 0, signalsOut: 0, gaps: 3 },
  { id: 'sports', name: 'Sports Analytics', icon: Trophy, iconBg: '#d1fae5', iconColor: '#059669', description: 'Tracks sports performance analysis and statistical modelling in athletics.', reasoningStyle: 'Data-driven with statistical rigour.', playlistName: 'Sports Playlist', videoCount: 11, entityCount: 198, health: 'growing', updatedAgo: '3 days ago', themes: [{ label: 'Expected Goals', color: ENTITY_COLORS.concept }, { label: 'Player Tracking', color: ENTITY_COLORS.technology }], standingQuestions: 1, newInsights: 1, signalsOut: 0, gaps: 1 },
  { id: 'betting', name: 'Betting Markets', icon: Dice5, iconBg: '#fef3c7', iconColor: '#b45309', description: 'Analyses prediction markets, betting strategy, and odds modelling.', reasoningStyle: 'Probabilistic reasoning, expected value calculations.', playlistName: 'Betting Playlist', videoCount: 2, entityCount: 34, health: 'thin', updatedAgo: '2 weeks ago', themes: [{ label: 'Prediction Markets', color: ENTITY_COLORS.concept }], standingQuestions: 0, newInsights: 0, signalsOut: 0, gaps: 2 },
  { id: 'second-brain', name: 'Second Brain', icon: Brain, iconBg: '#ede9fe', iconColor: '#7c3aed', description: 'Explores personal knowledge management, Zettelkasten methodology, and augmented cognition.', reasoningStyle: 'Systems thinking, emphasis on interconnection and emergence.', playlistName: 'Second Brain Playlist', videoCount: 15, entityCount: 421, health: 'strong', updatedAgo: '6 hours ago', themes: [{ label: 'Zettelkasten', color: ENTITY_COLORS.concept }, { label: 'Knowledge Graphs', color: ENTITY_COLORS.technology }, { label: 'PKM', color: ENTITY_COLORS.topic }], standingQuestions: 2, newInsights: 1, signalsOut: 1, gaps: 0 },
]

const GLOBAL_SIGNALS = [
  { source: 'AI Upskilling', target: 'Philosophy', reason: 'Epistemic humility ↔ confidence calibration', status: 'pending' },
  { source: 'AI Upskilling', target: 'Second Brain', reason: 'Karpathy wiki ↔ knowledge graph methodology', status: 'processed' },
  { source: 'AI Upskilling', target: 'Geopolitics', reason: 'AI regulation ↔ open-source model access', status: 'pending' },
  { source: 'Sports Analytics', target: 'Betting Markets', reason: 'xG models ↔ odds calibration', status: 'pending' },
  { source: 'Second Brain', target: 'AI Upskilling', reason: 'RAG substrate ↔ personal knowledge infra', status: 'processed' },
]

const GLOBAL_INSIGHTS = [
  { type: 'tension', agent: 'AI Upskilling', claim: 'Autonomous agents vs. human-in-the-loop — sources disagree on safety boundaries' },
  { type: 'convergence', agent: 'Second Brain', claim: 'Zettelkasten atomic notes converge with LLM chunk-level retrieval' },
]

// ── Section Label Component ─────────────────────────────────────────────────

function SL({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="font-display font-bold uppercase"
      style={{ fontSize: 10, letterSpacing: '0.08em', color: 'var(--color-text-secondary)', marginBottom: 10 }}
    >
      {children}
    </div>
  )
}

// ── Collapsible Section ─────────────────────────────────────────────────────

function CollapsibleSection({ title, children, defaultOpen = false }: { title: string; children: React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: 14, marginTop: 14 }}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 w-full cursor-pointer border-none bg-transparent"
        style={{ padding: 0 }}
      >
        <div style={{ transform: open ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 0.15s ease' }}>
          <ChevronRight size={14} style={{ color: 'var(--color-text-secondary)' }} />
        </div>
        <span
          className="font-display font-bold uppercase"
          style={{ fontSize: 10, letterSpacing: '0.08em', color: 'var(--color-text-secondary)' }}
        >
          {title}
        </span>
      </button>
      {open && <div style={{ marginTop: 12 }}>{children}</div>}
    </div>
  )
}

// ── Entity Badge ────────────────────────────────────────────────────────────

function EntityBadge({ label, color }: { label: string; color: string }) {
  return (
    <span
      className="font-body inline-block"
      style={{
        fontSize: 10,
        fontWeight: 600,
        padding: '3px 9px',
        borderRadius: 5,
        background: `${color}0f`,
        border: `1px solid ${color}28`,
        color,
        lineHeight: 1.2,
      }}
    >
      {label}
    </span>
  )
}

// ── Health Badge ────────────────────────────────────────────────────────────

function HealthBadge({ health }: { health: string }) {
  const fallback = { bg: '#f3f4f6', text: '#6b7280', label: 'Init' }
  const h = HEALTH_COLORS[health] ?? fallback
  return (
    <span
      className="font-body"
      style={{
        fontSize: 10,
        fontWeight: 600,
        padding: '3px 10px',
        borderRadius: 20,
        background: h.bg,
        color: h.text,
      }}
    >
      {h.label}
    </span>
  )
}

// ── Insight Type Badge ──────────────────────────────────────────────────────

function InsightBadge({ type }: { type: string }) {
  const fallback = { bg: '#e0e7ff', text: '#4338ca', label: 'CONNECTION' }
  const b = INSIGHT_BADGE[type] ?? fallback
  return (
    <span
      className="font-body"
      style={{
        fontSize: 9,
        fontWeight: 700,
        padding: '2px 7px',
        borderRadius: 4,
        background: b.bg,
        color: b.text,
        letterSpacing: '0.04em',
      }}
    >
      {b.label}
    </span>
  )
}

// ── Gap Type Badge ──────────────────────────────────────────────────────────

function GapBadge({ label }: { label: string }) {
  return (
    <span
      className="font-body uppercase"
      style={{
        fontSize: 9,
        fontWeight: 700,
        padding: '2px 7px',
        borderRadius: 4,
        background: '#fee2e2',
        color: '#dc2626',
        letterSpacing: '0.04em',
      }}
    >
      {label}
    </span>
  )
}

// ── Advisor Card (List View) ────────────────────────────────────────────────

function AdvisorCard({ advisor, index, onClick }: { advisor: Advisor; index: number; onClick: () => void }) {
  const [hovered, setHovered] = useState(false)

  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className="cursor-pointer"
      style={{
        background: 'var(--color-bg-card)',
        borderRadius: 12,
        border: `1px solid ${hovered ? 'rgba(0,0,0,0.10)' : 'var(--border-subtle)'}`,
        padding: '16px 22px',
        transform: hovered ? 'translateY(-1px)' : 'translateY(0)',
        boxShadow: hovered ? '0 2px 8px rgba(0,0,0,0.04)' : 'none',
        transition: 'all 0.18s ease',
        animation: `fadeUp 0.4s ease ${index * 0.05}s both`,
      }}
    >
      {/* Row 1: Icon + Name + Health */}
      <div className="flex items-start justify-between" style={{ marginBottom: 8 }}>
        <div className="flex items-center gap-3">
          <div
            className="flex items-center justify-center shrink-0"
            style={{ width: 32, height: 32, borderRadius: 8, background: advisor.iconBg }}
          >
            <advisor.icon size={16} strokeWidth={2} style={{ color: advisor.iconColor }} />
          </div>
          <div>
            <div className="font-display font-bold" style={{ fontSize: 14, color: 'var(--color-text-primary)' }}>
              {advisor.name}
            </div>
            <div className="font-body" style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>
              {advisor.videoCount} videos · {advisor.entityCount.toLocaleString()} entities · Updated {advisor.updatedAgo}
            </div>
          </div>
        </div>
        <HealthBadge health={advisor.health} />
      </div>

      {/* Row 2: Description */}
      <div
        className="font-body"
        style={{
          fontSize: 12,
          color: 'var(--color-text-body)',
          lineHeight: 1.5,
          marginBottom: 10,
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
        }}
      >
        {advisor.description}
      </div>

      {/* Row 3: Theme badges */}
      <div className="flex flex-wrap gap-1.5" style={{ marginBottom: 12 }}>
        {advisor.themes.map((t) => (
          <EntityBadge key={t.label} label={t.label} color={t.color} />
        ))}
      </div>

      {/* Row 4: Stats */}
      <div
        className="flex items-center font-body"
        style={{
          borderTop: '1px solid var(--border-subtle)',
          paddingTop: 10,
          fontSize: 11,
          color: 'var(--color-text-secondary)',
          gap: 14,
        }}
      >
        <span className="flex items-center gap-1"><HelpCircle size={11} /> {advisor.standingQuestions} standing questions</span>
        <span className="flex items-center gap-1"><Zap size={11} /> {advisor.newInsights} new insights</span>
        <span className="flex items-center gap-1" style={{ color: 'var(--color-accent-500)', fontWeight: 600 }}><ArrowUpRight size={11} /> {advisor.signalsOut} signals out</span>
        <span className="ml-auto" style={{ color: advisor.gaps > 0 ? '#dc2626' : undefined, fontWeight: advisor.gaps > 0 ? 600 : undefined }}>
          {advisor.gaps} gaps
        </span>
      </div>
    </div>
  )
}

// ── Council List View (Center) ──────────────────────────────────────────────

function CouncilListCenter({ filtered, onSelectAdvisor }: { filtered: Advisor[]; onSelectAdvisor: (id: string) => void }) {
  return (
    <div style={{ padding: '24px 28px', overflowY: 'auto', height: '100%' }}>
      {/* Section label */}
      <SL>Advisors · {filtered.length}</SL>

      {/* Cards */}
      <div className="flex flex-col" style={{ gap: 8 }}>
        {filtered.map((advisor, i) => (
          <AdvisorCard
            key={advisor.id}
            advisor={advisor}
            index={i}
            onClick={() => onSelectAdvisor(advisor.id)}
          />
        ))}
      </div>

      {/* Bottom link */}
      <div className="font-body" style={{ marginTop: 16, fontSize: 12, color: 'var(--color-accent-500)', cursor: 'pointer', fontWeight: 500 }}>
        Show all {filtered.length} advisors ›
      </div>
    </div>
  )
}

// ── Council List View (Right Panel) ─────────────────────────────────────────

function CouncilListRight({ advisors, globalSignals, globalInsights }: {
  advisors: Advisor[]
  globalSignals: Array<{ source: string; target: string; reason: string; status: string }>
  globalInsights: Array<{ type: string; agent: string; claim: string }>
}) {
  const healthCounts = {
    strong: advisors.filter((a) => a.health === 'strong').length,
    growing: advisors.filter((a) => a.health === 'growing').length,
    thin: advisors.filter((a) => a.health === 'thin').length,
    stale: advisors.filter((a) => a.health === 'stale').length,
  }

  return (
    <div style={{ padding: 24, overflowY: 'auto', height: '100%' }}>
      {/* Header */}
      <div className="flex items-center gap-2" style={{ marginBottom: 20 }}>
        <Sparkles size={18} style={{ color: 'var(--color-accent-500)' }} />
        <span className="font-display font-bold" style={{ fontSize: 16, color: 'var(--color-text-primary)' }}>
          Council Overview
        </span>
      </div>

      {/* HEALTH */}
      <SL>Health</SL>
      <div className="grid grid-cols-2" style={{ gap: 8, marginBottom: 20 }}>
        {(Object.entries(healthCounts) as [string, number][]).map(([key, count]) => (
          <div
            key={key}
            style={{
              background: 'var(--color-bg-inset)',
              borderRadius: 8,
              padding: 12,
            }}
          >
            <div className="font-body" style={{ fontSize: 11, color: 'var(--color-text-secondary)', marginBottom: 4 }}>
              {key.charAt(0).toUpperCase() + key.slice(1)}
            </div>
            <div
              className="font-display"
              style={{ fontSize: 22, fontWeight: 800, color: HEALTH_COLORS[key]?.text ?? '#1a1a1a' }}
            >
              {count}
            </div>
          </div>
        ))}
      </div>

      {/* ACTIVE SIGNALS */}
      <div style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: 16, marginBottom: 20 }}>
        <SL>Active Signals</SL>
        <div className="flex flex-col" style={{ gap: 8 }}>
          {globalSignals.slice(0, 3).map((s, i) => (
            <div
              key={i}
              style={{
                background: 'var(--color-bg-inset)',
                borderRadius: 8,
                padding: '10px 12px',
              }}
            >
              <div className="font-body" style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-primary)' }}>
                {s.source} → {s.target}
              </div>
              <div className="font-body" style={{ fontSize: 11, color: 'var(--color-text-secondary)', marginTop: 2 }}>
                {s.reason}
              </div>
              <div
                className="font-body flex items-center gap-1"
                style={{
                  fontSize: 10,
                  marginTop: 4,
                  color: s.status === 'pending' ? 'var(--color-accent-500)' : '#15803d',
                  fontWeight: 500,
                }}
              >
                {s.status === 'pending' ? <><Circle size={8} fill="currentColor" /> Pending</> : <><Check size={10} /> Processed</>}
              </div>
            </div>
          ))}
        </div>
        <div className="font-body" style={{ marginTop: 10, fontSize: 11, color: 'var(--color-accent-500)', cursor: 'pointer', fontWeight: 500 }}>
          View all {globalSignals.length} signals ›
        </div>
      </div>

      {/* RECENT INSIGHTS */}
      <div style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: 16, marginBottom: 20 }}>
        <SL>Recent Insights</SL>
        <div className="flex flex-col" style={{ gap: 8 }}>
          {globalInsights.map((ins, i) => (
            <div
              key={i}
              style={{
                background: 'var(--color-bg-inset)',
                borderRadius: 8,
                padding: '10px 12px',
              }}
            >
              <div className="flex items-center gap-2" style={{ marginBottom: 4 }}>
                <InsightBadge type={ins.type} />
                <span className="font-body" style={{ fontSize: 10, color: 'var(--color-text-secondary)' }}>
                  {ins.agent}
                </span>
              </div>
              <div className="font-body" style={{ fontSize: 11, color: 'var(--color-text-body)', lineHeight: 1.4 }}>
                {ins.claim}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* NIGHTLY CRON */}
      <div style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: 16 }}>
        <SL>Nightly Cron</SL>
        <div
          style={{
            background: 'var(--color-bg-inset)',
            borderRadius: 8,
            padding: '10px 12px',
          }}
        >
          <div className="flex items-center gap-2" style={{ marginBottom: 4 }}>
            <Clock size={12} style={{ color: '#15803d' }} />
            <span className="font-body" style={{ fontSize: 11, fontWeight: 600, color: '#15803d' }}>
              Last run: Success
            </span>
          </div>
          <div className="font-body" style={{ fontSize: 10, color: 'var(--color-text-secondary)', lineHeight: 1.5 }}>
            Ran at 03:00 UTC · 5 signals processed · 2 extractions completed
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Advisor Detail View (Center) ────────────────────────────────────────────

function AdvisorDetailCenter({ advisor }: { advisor: Advisor }) {
  return (
    <div style={{ padding: '24px 28px', overflowY: 'auto', height: '100%' }}>
      {/* Identity card */}
      <div
        style={{
          background: 'var(--color-bg-card)',
          borderRadius: 12,
          border: '1px solid var(--border-subtle)',
          padding: '16px 22px',
          marginBottom: 0,
          animation: 'fadeUp 0.4s ease both',
        }}
      >
        <div className="flex items-start justify-between" style={{ marginBottom: 10 }}>
          <div className="flex items-center gap-3">
            <div
              className="flex items-center justify-center shrink-0"
              style={{ width: 36, height: 36, borderRadius: 8, background: advisor.iconBg }}
            >
              <advisor.icon size={18} strokeWidth={2} style={{ color: advisor.iconColor }} />
            </div>
            <div>
              <div className="font-display font-bold" style={{ fontSize: 16, color: 'var(--color-text-primary)' }}>
                {advisor.name}
              </div>
              <div className="font-body" style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
                Linked to playlist: {advisor.playlistName} ({advisor.videoCount} videos)
              </div>
            </div>
          </div>
          <button
            type="button"
            className="font-body cursor-pointer border-none"
            style={{
              fontSize: 11,
              fontWeight: 500,
              padding: '4px 10px',
              borderRadius: 6,
              background: 'transparent',
              color: 'var(--color-text-secondary)',
            }}
          >
            Edit description
          </button>
        </div>
        <div className="font-body" style={{ fontSize: 12, color: 'var(--color-text-body)', lineHeight: 1.5, marginBottom: 8 }}>
          {advisor.description}
        </div>
        <div className="font-body italic" style={{ fontSize: 12, color: 'var(--color-text-secondary)', lineHeight: 1.5 }}>
          {advisor.reasoningStyle}
        </div>
      </div>

      {/* Collapsible sections */}
      {advisor.expertiseIndex && (
        <CollapsibleSection title="Expertise Index">
          <div className="flex flex-col" style={{ gap: 8 }}>
            {advisor.expertiseIndex.map((e) => (
              <div key={e.area} className="flex items-center justify-between">
                <span className="font-body" style={{ fontSize: 12, color: 'var(--color-text-body)' }}>{e.area}</span>
                <div className="flex items-center gap-2">
                  <div style={{ width: 40, height: 4, borderRadius: 2, background: 'var(--color-bg-inset)', overflow: 'hidden' }}>
                    <div style={{ width: `${e.confidence * 100}%`, height: '100%', borderRadius: 2, background: 'var(--color-accent-500)' }} />
                  </div>
                  <span className="font-body" style={{ fontSize: 10, color: 'var(--color-text-secondary)', width: 28, textAlign: 'right' }}>
                    {Math.round(e.confidence * 100)}%
                  </span>
                </div>
              </div>
            ))}
          </div>
          {advisor.weakAreas && (
            <div style={{ marginTop: 12 }}>
              <div className="font-body" style={{ fontSize: 10, fontWeight: 600, color: 'var(--color-text-secondary)', marginBottom: 6 }}>Weak areas</div>
              <div className="flex flex-wrap gap-1.5">
                {advisor.weakAreas.map((a) => (
                  <span
                    key={a}
                    className="font-body"
                    style={{ fontSize: 10, padding: '2px 8px', borderRadius: 4, background: '#fee2e2', color: '#dc2626' }}
                  >
                    {a}
                  </span>
                ))}
              </div>
            </div>
          )}
          {advisor.coreThemes && (
            <div style={{ marginTop: 12 }}>
              <div className="font-body" style={{ fontSize: 10, fontWeight: 600, color: 'var(--color-text-secondary)', marginBottom: 6 }}>Core themes</div>
              <div className="flex flex-wrap gap-1.5">
                {advisor.coreThemes.map((t) => (
                  <EntityBadge key={t} label={t} color={ENTITY_COLORS.topic} />
                ))}
              </div>
            </div>
          )}
        </CollapsibleSection>
      )}

      {advisor.crossDomainBridges && (
        <CollapsibleSection title="Cross-Domain Bridges">
          <div className="flex flex-col" style={{ gap: 8 }}>
            {advisor.crossDomainBridges.map((b) => (
              <div
                key={b.target}
                style={{
                  background: 'var(--color-bg-inset)',
                  borderRadius: 8,
                  padding: '10px 12px',
                }}
              >
                <div className="font-body" style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-primary)' }}>
                  → {b.target}
                </div>
                <div className="font-body" style={{ fontSize: 11, color: 'var(--color-text-secondary)', marginTop: 2 }}>
                  {b.description}
                </div>
              </div>
            ))}
          </div>
        </CollapsibleSection>
      )}

      {advisor.linkedAnchors && (
        <CollapsibleSection title="Linked Anchors">
          <div className="flex flex-wrap gap-1.5">
            {advisor.linkedAnchors.map((a) => (
              <EntityBadge key={a} label={a} color="#d97706" />
            ))}
          </div>
        </CollapsibleSection>
      )}

      {advisor.awarenessRegister && (
        <CollapsibleSection title="Awareness Register">
          <div className="flex flex-col" style={{ gap: 8 }}>
            {advisor.awarenessRegister.map((r) => (
              <div
                key={r.agent}
                style={{
                  background: 'var(--color-bg-inset)',
                  borderRadius: 8,
                  padding: '10px 12px',
                }}
              >
                <div className="font-body" style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-primary)' }}>
                  {r.agent}
                </div>
                <div className="font-body" style={{ fontSize: 11, color: 'var(--color-text-secondary)', marginTop: 2 }}>
                  {r.summary}
                </div>
              </div>
            ))}
          </div>
        </CollapsibleSection>
      )}
    </div>
  )
}

// ── Advisor Detail View (Right Panel) ───────────────────────────────────────

function AdvisorDetailRight({ advisor }: { advisor: Advisor }) {
  return (
    <div style={{ padding: 24, overflowY: 'auto', height: '100%' }}>
      {/* Actions */}
      <div className="flex flex-col" style={{ gap: 8, marginBottom: 24 }}>
        <button
          type="button"
          className="font-body cursor-pointer w-full text-left"
          style={{
            fontSize: 12,
            fontWeight: 600,
            padding: '10px 14px',
            borderRadius: 8,
            background: 'var(--color-accent-50)',
            border: '1px solid rgba(214,58,0,0.15)',
            color: 'var(--color-accent-600)',
          }}
        >
          Ask this advisor a question
        </button>
        <button
          type="button"
          className="font-body cursor-pointer w-full text-left flex items-center gap-2"
          style={{
            fontSize: 12,
            fontWeight: 500,
            padding: '10px 14px',
            borderRadius: 8,
            background: 'var(--color-bg-card)',
            border: '1px solid var(--border-subtle)',
            color: 'var(--color-text-body)',
          }}
        >
          <RefreshCw size={12} />
          Rebuild expertise index
        </button>
      </div>

      {/* STANDING QUESTIONS */}
      {advisor.questions && advisor.questions.length > 0 && (
        <div style={{ marginBottom: 24 }}>
          <SL>Standing Questions · {advisor.questions.filter((q) => q.status === 'open' || q.status === 'partially_addressed').length} Open</SL>
          <div className="flex flex-col" style={{ gap: 10 }}>
            {advisor.questions.map((q) => (
              <div
                key={q.id}
                style={{
                  background: 'var(--color-bg-card)',
                  borderRadius: 8,
                  border: '1px solid var(--border-subtle)',
                  padding: '10px 14px',
                }}
              >
                <div className="flex items-center justify-between" style={{ marginBottom: 6 }}>
                  <div className="flex items-center gap-2">
                    <div
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: '50%',
                        background: QUESTION_DOT_COLORS[q.type] ?? '#6b7280',
                      }}
                    />
                    <span className="font-body" style={{ fontSize: 10, fontWeight: 600, color: 'var(--color-text-secondary)' }}>
                      {q.type.replace('_', ' ')}
                    </span>
                  </div>
                  <span
                    className="font-body"
                    style={{
                      fontSize: 10,
                      color: q.status === 'partially_addressed' ? '#15803d' : 'var(--color-text-secondary)',
                    }}
                  >
                    {q.status.replace('_', ' ')} · {q.age}
                  </span>
                </div>
                <div className="font-body" style={{ fontSize: 13, fontWeight: 500, color: 'var(--color-text-primary)', lineHeight: 1.5 }}>
                  {q.question}
                </div>
                {q.trigger && (
                  <div className="font-body" style={{ fontSize: 11, color: 'var(--color-text-secondary)', marginTop: 6, lineHeight: 1.4 }}>
                    {q.trigger}
                  </div>
                )}
                {q.evidence && (
                  <div className="font-body" style={{ fontSize: 11, color: '#15803d', marginTop: 6, lineHeight: 1.4 }}>
                    {q.evidence}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* EMERGING INSIGHTS */}
      {advisor.insights && advisor.insights.length > 0 && (
        <div style={{ marginBottom: 24 }}>
          <SL>Emerging Insights · {advisor.insights.length} Active</SL>
          <div className="flex flex-col" style={{ gap: 10 }}>
            {advisor.insights.map((ins) => (
              <div
                key={ins.id}
                style={{
                  background: 'var(--color-bg-card)',
                  borderRadius: 8,
                  border: '1px solid var(--border-subtle)',
                  padding: '10px 14px',
                }}
              >
                <div className="flex items-center gap-2" style={{ marginBottom: 6 }}>
                  <InsightBadge type={ins.type} />
                  <span className="font-body" style={{ fontSize: 10, color: 'var(--color-text-secondary)' }}>
                    {Math.round(ins.confidence * 100)}% · {ins.sourceCount} sources
                  </span>
                </div>
                <div className="font-body" style={{ fontSize: 13, fontWeight: 500, color: 'var(--color-text-primary)', lineHeight: 1.5 }}>
                  {ins.claim}
                </div>
                <div className="font-body" style={{ fontSize: 11, color: 'var(--color-text-secondary)', marginTop: 6, lineHeight: 1.4 }}>
                  {ins.sourceAttribution}
                </div>
                {/* Action buttons */}
                <div className="flex items-center gap-2" style={{ marginTop: 10 }}>
                  <button
                    type="button"
                    className="font-body cursor-pointer"
                    style={{
                      fontSize: 10,
                      fontWeight: 500,
                      padding: '4px 10px',
                      borderRadius: 6,
                      background: 'var(--color-accent-50)',
                      border: '1px solid rgba(214,58,0,0.15)',
                      color: 'var(--color-accent-500)',
                    }}
                  >
                    Explore deeper
                  </button>
                  {ins.type === 'novel_connection' && (
                    <button
                      type="button"
                      className="font-body cursor-pointer"
                      style={{
                        fontSize: 10,
                        fontWeight: 500,
                        padding: '4px 10px',
                        borderRadius: 6,
                        background: 'var(--color-accent-50)',
                        border: '1px solid rgba(214,58,0,0.15)',
                        color: 'var(--color-accent-500)',
                      }}
                    >
                      Promote to note
                    </button>
                  )}
                  <button
                    type="button"
                    className="font-body cursor-pointer"
                    style={{
                      fontSize: 10,
                      fontWeight: 500,
                      padding: '4px 10px',
                      borderRadius: 6,
                      background: 'var(--color-bg-inset)',
                      border: '1px solid var(--border-subtle)',
                      color: 'var(--color-text-secondary)',
                    }}
                  >
                    Dismiss
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* GAPS */}
      {advisor.agentGaps && advisor.agentGaps.length > 0 && (
        <div style={{ marginBottom: 24 }}>
          <SL>Gaps · {advisor.agentGaps.length} Active</SL>
          <div className="flex flex-col" style={{ gap: 10 }}>
            {advisor.agentGaps.map((g) => (
              <div
                key={g.id}
                style={{
                  background: 'var(--color-bg-card)',
                  borderRadius: 8,
                  border: '1px solid var(--border-subtle)',
                  padding: '10px 14px',
                }}
              >
                <div className="flex items-center gap-2" style={{ marginBottom: 6 }}>
                  <GapBadge label={g.type} />
                  <GapBadge label={g.severity} />
                </div>
                <div className="font-body" style={{ fontSize: 13, fontWeight: 500, color: 'var(--color-text-primary)', lineHeight: 1.5 }}>
                  {g.topic}
                </div>
                <div className="font-body" style={{ fontSize: 12, color: 'var(--color-text-secondary)', lineHeight: 1.5, marginTop: 4 }}>
                  {g.description}
                </div>
                <div className="font-body italic" style={{ fontSize: 11, color: 'var(--color-text-body)', marginTop: 6, lineHeight: 1.4 }}>
                  {g.suggestion}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* SIGNALS SENT */}
      {advisor.signals && advisor.signals.length > 0 && (
        <div>
          <SL>Signals Sent · {advisor.signals.length}</SL>
          <div className="flex flex-col" style={{ gap: 8 }}>
            {advisor.signals.map((s) => (
              <div
                key={s.id}
                style={{
                  background: 'var(--color-bg-inset)',
                  borderRadius: 8,
                  padding: '10px 12px',
                }}
              >
                <div className="font-body" style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-primary)' }}>
                  → {s.target}
                </div>
                <div className="font-body" style={{ fontSize: 11, color: 'var(--color-text-secondary)', marginTop: 2 }}>
                  {s.reason}
                </div>
                <div
                  className="font-body flex items-center gap-1"
                  style={{
                    fontSize: 10,
                    marginTop: 4,
                    color: s.status === 'pending' ? 'var(--color-accent-500)' : '#15803d',
                    fontWeight: 500,
                  }}
                >
                  {s.status === 'pending' ? <><Circle size={8} fill="currentColor" /> Pending</> : <><Check size={10} /> Processed</>} · {s.timestamp}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Main Council View ───────────────────────────────────────────────────────

const DEFAULT_LEFT_PCT = 64
const MIN_LEFT_PCT = 30
const MAX_LEFT_PCT = 80

export function CouncilView() {
  const [selectedAdvisorId, setSelectedAdvisorId] = useState<string | null>(null)
  const selectedAdvisor = ADVISORS.find((a) => a.id === selectedAdvisorId) ?? null

  // List filters
  const [searchTerm, setSearchTerm] = useState('')
  const [healthFilter, setHealthFilter] = useState<string>('all')
  const [toggleFilter, setToggleFilter] = useState<'all' | 'strong' | 'signals'>('all')

  const filtered = ADVISORS.filter((a) => {
    if (searchTerm && !a.name.toLowerCase().includes(searchTerm.toLowerCase())) return false
    if (healthFilter !== 'all' && a.health !== healthFilter) return false
    if (toggleFilter === 'strong' && !['strong', 'growing'].includes(a.health)) return false
    if (toggleFilter === 'signals' && a.signalsOut === 0) return false
    return true
  })

  // Drag resize
  const containerRef = useRef<HTMLDivElement>(null)
  const [leftWidthPct, setLeftWidthPct] = useState(DEFAULT_LEFT_PCT)
  const [isDragging, setIsDragging] = useState(false)
  const dragStartX = useRef(0)
  const dragStartPct = useRef(DEFAULT_LEFT_PCT)

  const onDragStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      setIsDragging(true)
      dragStartX.current = e.clientX
      dragStartPct.current = leftWidthPct

      const onMove = (ev: MouseEvent) => {
        if (!containerRef.current) return
        const dx = ev.clientX - dragStartX.current
        const containerW = containerRef.current.offsetWidth
        const newPct = dragStartPct.current + (dx / containerW) * 100
        setLeftWidthPct(Math.max(MIN_LEFT_PCT, Math.min(MAX_LEFT_PCT, newPct)))
      }
      const onUp = () => {
        setIsDragging(false)
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
      }
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    },
    [leftWidthPct],
  )

  return (
    <div className="flex flex-col h-full">
      {/* Control bar with back navigation for detail view */}
      <div
        className="flex items-center shrink-0"
        style={{
          minHeight: 44,
          padding: '8px 24px',
          background: 'var(--color-bg-card)',
          borderBottom: '1px solid var(--border-subtle)',
          gap: 8,
        }}
      >
        {selectedAdvisor ? (
          <>
            <button
              type="button"
              onClick={() => setSelectedAdvisorId(null)}
              className="flex items-center gap-1.5 font-body cursor-pointer border-none bg-transparent"
              style={{ fontSize: 12, fontWeight: 500, color: 'var(--color-accent-500)', padding: 0 }}
            >
              <ArrowLeft size={14} />
              Council
            </button>
            <div
              style={{
                width: 1,
                height: 24,
                background: 'var(--border-subtle)',
                margin: '0 4px',
              }}
            />
            <span className="font-display font-bold" style={{ fontSize: 13, color: 'var(--color-text-primary)' }}>
              {selectedAdvisor.name}
            </span>
            <HealthBadge health={selectedAdvisor.health} />
          </>
        ) : (
          <>
            {/* Search */}
            <div className="relative">
              <Search
                size={13}
                className="absolute"
                style={{ left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--color-text-placeholder)' }}
              />
              <input
                type="text"
                placeholder="Search advisors..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="font-body"
                style={{
                  width: 180,
                  padding: '5px 13px 5px 28px',
                  borderRadius: 20,
                  border: '1px solid var(--border-subtle)',
                  background: 'var(--color-bg-inset)',
                  fontSize: 12,
                  color: 'var(--color-text-primary)',
                  outline: 'none',
                }}
              />
            </div>

            {/* Toggle group */}
            {(['all', 'strong', 'signals'] as const).map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => setToggleFilter(key)}
                className="font-body font-semibold cursor-pointer"
                style={{
                  fontSize: 12,
                  padding: '5px 13px',
                  borderRadius: 20,
                  border: toggleFilter === key
                    ? '1px solid rgba(214,58,0,0.15)'
                    : '1px solid var(--border-subtle)',
                  background: toggleFilter === key ? 'var(--color-accent-50)' : 'transparent',
                  color: toggleFilter === key ? 'var(--color-accent-500)' : 'var(--color-text-secondary)',
                  transition: 'all 0.15s ease',
                }}
              >
                {key === 'all' ? 'All' : key === 'strong' ? 'Strong' : 'Signals'}
              </button>
            ))}

            {/* Health filter dropdown */}
            <div className="relative">
              <select
                value={healthFilter}
                onChange={(e) => setHealthFilter(e.target.value)}
                className="font-body font-semibold cursor-pointer appearance-none"
                style={{
                  fontSize: 12,
                  padding: '5px 26px 5px 13px',
                  borderRadius: 20,
                  border: '1px solid var(--border-subtle)',
                  background: 'transparent',
                  color: 'var(--color-text-secondary)',
                  outline: 'none',
                }}
              >
                <option value="all">All Health</option>
                <option value="strong">Strong</option>
                <option value="growing">Growing</option>
                <option value="thin">Thin</option>
                <option value="stale">Stale</option>
              </select>
              <ChevronDown
                size={12}
                className="absolute pointer-events-none"
                style={{ right: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--color-text-secondary)' }}
              />
            </div>

            {/* Spacer + summary */}
            <span className="ml-auto font-body" style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>
              {ADVISORS.length} advisors · {ADVISORS.reduce((s, a) => s + a.videoCount, 0)} videos
            </span>
          </>
        )}
      </div>

      {/* Two-column content */}
      <div ref={containerRef} className="flex flex-1 overflow-hidden">
        {/* Left column */}
        <div
          style={{
            width: `${leftWidthPct}%`,
            background: 'var(--color-bg-content)',
            overflow: 'hidden',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          {selectedAdvisor ? (
            <AdvisorDetailCenter advisor={selectedAdvisor} />
          ) : (
            <CouncilListCenter filtered={filtered} onSelectAdvisor={setSelectedAdvisorId} />
          )}
        </div>

        {/* Drag handle */}
        <div
          className="flex items-center justify-center shrink-0"
          style={{
            width: 12,
            cursor: 'col-resize',
            background: isDragging ? 'rgba(0,0,0,0.04)' : 'transparent',
            transition: 'background 0.15s ease',
            borderLeft: '1px solid var(--border-subtle)',
            borderRight: '1px solid var(--border-subtle)',
          }}
          onMouseDown={onDragStart}
        >
          <GripVertical size={12} style={{ color: 'var(--color-text-placeholder)', opacity: 0.5 }} />
        </div>

        {/* Right column */}
        <div
          style={{
            flex: 1,
            minWidth: 0,
            background: 'var(--color-bg-card)',
            borderLeft: '1px solid var(--border-subtle)',
            overflow: 'hidden',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          {selectedAdvisor ? (
            <AdvisorDetailRight advisor={selectedAdvisor} />
          ) : (
            <CouncilListRight advisors={ADVISORS} globalSignals={GLOBAL_SIGNALS} globalInsights={GLOBAL_INSIGHTS} />
          )}
        </div>
      </div>
    </div>
  )
}
