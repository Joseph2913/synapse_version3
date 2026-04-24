import { useState, useRef, useCallback, useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'
import { SpotlightCard } from '../components/ui/SpotlightCard'
import { GripVertical, ChevronDown, ChevronRight, ArrowLeft, Sparkles, Clock, Search, RefreshCw, Bot, HelpCircle, Zap, type LucideIcon } from 'lucide-react'
import {
  fetchDomainAgents,
  fetchAgentQuestions,
  fetchAgentInsights,
  fetchAgentGaps,
  fetchGlobalInsights,
  fetchAgentCounts,
} from '../services/supabase'
import type { DomainAgent, AgentStandingQuestion, AgentInsightRow, AgentGapRow } from '../types/database'
import type { AddressingEvidenceEntry } from '../types/council'
import { QuestionStatusBadge } from '../components/council/QuestionStatusBadge'
import { CouncilTelemetryStrip } from '../components/council/CouncilTelemetryStrip'

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
}

interface StandingQuestion {
  id: string
  question: string
  type: string
  status: 'open' | 'partially_addressed' | 'answered' | 'dismissed'
  age: string
  trigger?: string
  addressingEvidence: AddressingEvidenceEntry[] | null
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

// ── Helpers to map DB → UI ──────────────────────────────────────────────────

function timeAgo(dateStr: string | null): string {
  if (!dateStr) return 'never'
  const diff = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  const weeks = Math.floor(days / 7)
  return `${weeks}w ago`
}

const THEME_COLORS = [
  ENTITY_COLORS.topic, ENTITY_COLORS.concept, ENTITY_COLORS.technology,
  ENTITY_COLORS.person, ENTITY_COLORS.organization, ENTITY_COLORS.insight,
  ENTITY_COLORS.product, ENTITY_COLORS.action,
]

function mapAgentToAdvisor(agent: DomainAgent, counts: { standingQuestions: number; insights: number; gaps: number }): Advisor {
  const exp = agent.expertise_index as {
    summary?: string
    core_themes?: string[]
    reasoning_approach?: string
    strongest_areas?: Array<{ topic: string; source_count: number; key_entities: string[] }>
    weakest_areas?: Array<{ topic: string; reason: string }>
    cross_domain_bridges?: Array<{ target_agent_name: string; bridge_description: string }>
  } | null

  const awareness = (agent.awareness_register as unknown) as Array<{
    sibling_name: string
    relevance_summary: string
  }> | null

  const themes = (exp?.core_themes ?? []).slice(0, 5).map((t, i) => ({
    label: t,
    color: THEME_COLORS[i % THEME_COLORS.length]!,
  }))

  const expertiseIndex = (exp?.strongest_areas ?? []).map(a => ({
    area: a.topic,
    confidence: Math.min(1, (a.source_count || 1) / Math.max(agent.source_count, 1)),
  }))

  const weakAreas = (exp?.weakest_areas ?? []).map(w => w.topic)
  const coreThemes = exp?.core_themes ?? []
  const crossDomainBridges = (exp?.cross_domain_bridges ?? []).map(b => ({
    target: b.target_agent_name,
    description: b.bridge_description,
  }))

  const awarenessRegister = (awareness ?? []).map(a => ({
    agent: a.sibling_name,
    summary: a.relevance_summary,
  }))

  return {
    id: agent.id,
    name: agent.name,
    icon: Bot,
    iconBg: '#ede9fe',
    iconColor: '#7c3aed',
    description: agent.description ?? exp?.summary ?? '',
    reasoningStyle: agent.reasoning_style ?? exp?.reasoning_approach ?? '',
    playlistName: agent.name,
    videoCount: agent.source_count,
    entityCount: agent.entity_count,
    health: agent.health_status,
    updatedAgo: timeAgo(agent.updated_at),
    themes,
    standingQuestions: counts.standingQuestions,
    newInsights: counts.insights,
    gaps: counts.gaps,
    expertiseIndex: expertiseIndex.length > 0 ? expertiseIndex : undefined,
    weakAreas: weakAreas.length > 0 ? weakAreas : undefined,
    coreThemes: coreThemes.length > 0 ? coreThemes : undefined,
    crossDomainBridges: crossDomainBridges.length > 0 ? crossDomainBridges : undefined,
    linkedAnchors: undefined,
    awarenessRegister: awarenessRegister.length > 0 ? awarenessRegister : undefined,
  }
}

function mapQuestion(q: AgentStandingQuestion): StandingQuestion {
  return {
    id: q.id,
    question: q.question,
    type: q.question_type,
    status: q.status,
    age: timeAgo(q.generated_at),
    trigger: q.trigger_description ?? undefined,
    addressingEvidence: q.addressing_evidence ?? null,
  }
}

function mapInsight(ins: AgentInsightRow): AgentInsight {
  return {
    id: ins.id,
    type: ins.insight_type,
    claim: ins.claim,
    confidence: ins.confidence ?? 0,
    sourceCount: ins.related_source_ids?.length ?? 0,
    sourceAttribution: ins.evidence_summary ?? '',
  }
}

function mapGap(g: AgentGapRow): AgentGap {
  return {
    id: g.id,
    type: g.gap_type,
    severity: g.severity,
    topic: g.topic,
    description: g.description ?? '',
    suggestion: g.content_suggestion ?? '',
  }
}

// (Data is fetched from Supabase — see CouncilView component below)

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

function AdvisorCard({ advisor, onClick }: { advisor: Advisor; onClick: () => void }) {
  const [hovered, setHovered] = useState(false)

  return (
    <SpotlightCard
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className="cursor-pointer"
      color="rgba(214, 58, 0, 0.4)"
      style={{
        background: 'var(--color-bg-card)',
        borderRadius: 12,
        border: `1px solid ${hovered ? 'rgba(0,0,0,0.10)' : 'var(--border-subtle)'}`,
        padding: '16px 22px',
        transform: hovered ? 'translateY(-1px)' : 'translateY(0)',
        boxShadow: hovered ? '0 2px 8px rgba(0,0,0,0.04)' : 'none',
        transition: 'all 0.18s ease',
      }}
    >
      {/* Row 1: Icon + Name + Stats + Health */}
      <div className="flex items-start justify-between" style={{ marginBottom: 8 }}>
        <div className="flex items-center gap-3">
          <div
            className="flex items-center justify-center shrink-0"
            style={{ width: 32, height: 32, borderRadius: 8, background: advisor.iconBg }}
          >
            <advisor.icon size={16} strokeWidth={2} style={{ color: advisor.iconColor }} />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="font-display font-bold" style={{ fontSize: 14, color: 'var(--color-text-primary)' }}>
                {advisor.name}
              </span>
              <HealthBadge health={advisor.health} />
            </div>
            <div className="font-body flex items-center gap-1" style={{ fontSize: 11, color: 'var(--color-text-secondary)', marginTop: 2 }}>
              <span>{advisor.videoCount} sources</span>
              <span style={{ opacity: 0.4 }}>·</span>
              <span>{advisor.newInsights} insights</span>
            </div>
          </div>
        </div>
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

      {/* Row 4: Secondary stats */}
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
        <span className="flex items-center gap-1"><HelpCircle size={11} /> {advisor.standingQuestions} questions</span>
        <span className="flex items-center gap-1"><Zap size={11} /> {advisor.entityCount.toLocaleString()} entities</span>
        <span className="font-body" style={{ fontSize: 10, color: 'var(--color-text-placeholder)' }}>Updated {advisor.updatedAgo}</span>
        {advisor.gaps > 0 && (
          <span className="ml-auto" style={{ color: '#dc2626', fontWeight: 600 }}>
            {advisor.gaps} gaps
          </span>
        )}
      </div>
    </SpotlightCard>
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
        {filtered.map((advisor) => (
          <AdvisorCard
            key={advisor.id}
            advisor={advisor}
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

function CouncilListRight({ advisors, globalInsights }: {
  advisors: Advisor[]
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
            Ran at 03:00 UTC · answer-check and insight refresh completed
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
                id={`council-item-${q.id}`}
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
                    <QuestionStatusBadge status={q.status} addressingEvidence={q.addressingEvidence} />
                  </div>
                  <span
                    className="font-body"
                    style={{ fontSize: 10, color: 'var(--color-text-secondary)' }}
                  >
                    {q.age}
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
                id={`council-item-${ins.id}`}
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
                id={`council-item-${g.id}`}
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

    </div>
  )
}

// ── Main Council View ───────────────────────────────────────────────────────

const DEFAULT_LEFT_PCT = 64
const MIN_LEFT_PCT = 30
const MAX_LEFT_PCT = 80

export function CouncilView() {
  const [advisors, setAdvisors] = useState<Advisor[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedAdvisorId, setSelectedAdvisorId] = useState<string | null>(null)
  const [globalInsights, setGlobalInsights] = useState<Array<{ type: string; agent: string; claim: string }>>([])

  // Deep-linking from Home Council Digest: ?agent=<id>&focus=<itemId>
  const [searchParams] = useSearchParams()
  const paramAgentId = searchParams.get('agent')
  const paramFocusId = searchParams.get('focus')
  const appliedParamAgentRef = useRef<string | null>(null)
  const scrolledFocusRef = useRef<string | null>(null)

  // Load all advisors from DB
  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const agents = await fetchDomainAgents()
        const nameMap = new Map(agents.map(a => [a.id, a.name]))
        if (cancelled) return

        // Fetch counts for all agents in parallel
        const countsArr = await Promise.all(agents.map(a => fetchAgentCounts(a.id)))
        if (cancelled) return

        const mapped = agents.map((a, i) => mapAgentToAdvisor(a, countsArr[i]!))
        setAdvisors(mapped)

        // Fetch global insights
        const insData = await fetchGlobalInsights(10)
        if (cancelled) return

        setGlobalInsights(insData.map(ins => ({
          type: ins.insight_type,
          agent: nameMap.get(ins.agent_id) ?? 'Unknown',
          claim: ins.claim,
        })))
      } catch (err) {
        console.error('Failed to load council data:', err)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [])

  // Pre-select agent from ?agent= query param once advisors are loaded
  useEffect(() => {
    if (!paramAgentId) return
    if (appliedParamAgentRef.current === paramAgentId) return
    if (advisors.length === 0) return
    const match = advisors.find(a => a.id === paramAgentId)
    if (match) {
      setSelectedAdvisorId(paramAgentId)
      appliedParamAgentRef.current = paramAgentId
    }
  }, [paramAgentId, advisors])

  // After detail loads for the selected agent, scroll the focused item into view
  useEffect(() => {
    if (!paramFocusId || !selectedAdvisorId) return
    if (scrolledFocusRef.current === paramFocusId) return
    // Poll briefly: item renders after detail fetch resolves
    let attempts = 0
    const handle = window.setInterval(() => {
      const el = document.getElementById(`council-item-${paramFocusId}`)
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' })
        el.style.transition = 'box-shadow 0.3s ease'
        el.style.boxShadow = '0 0 0 2px var(--color-accent-500)'
        window.setTimeout(() => { el.style.boxShadow = '' }, 1800)
        scrolledFocusRef.current = paramFocusId
        window.clearInterval(handle)
      } else if (++attempts > 40) {
        window.clearInterval(handle)
      }
    }, 100)
    return () => window.clearInterval(handle)
  }, [paramFocusId, selectedAdvisorId])

  // Load detail data when an advisor is selected
  const selectedAdvisor = advisors.find((a) => a.id === selectedAdvisorId) ?? null

  useEffect(() => {
    if (!selectedAdvisorId) return
    const agentId = selectedAdvisorId
    let cancelled = false
    async function loadDetail() {
      try {
        const [questions, insights, gaps] = await Promise.all([
          fetchAgentQuestions(agentId),
          fetchAgentInsights(agentId),
          fetchAgentGaps(agentId),
        ])
        if (cancelled) return

        setAdvisors(prev => prev.map(a => {
          if (a.id !== agentId) return a
          return {
            ...a,
            questions: questions.map(mapQuestion),
            insights: insights.map(mapInsight),
            agentGaps: gaps.map(mapGap),
          }
        }))
      } catch (err) {
        console.error('Failed to load advisor detail:', err)
      }
    }
    loadDetail()
    return () => { cancelled = true }
  }, [selectedAdvisorId])

  // List filters
  const [searchTerm, setSearchTerm] = useState('')
  const [healthFilter, setHealthFilter] = useState<string>('all')
  const [toggleFilter, setToggleFilter] = useState<'all' | 'strong'>('all')

  const filtered = advisors.filter((a) => {
    if (searchTerm && !a.name.toLowerCase().includes(searchTerm.toLowerCase())) return false
    if (healthFilter !== 'all' && a.health !== healthFilter) return false
    if (toggleFilter === 'strong' && !['strong', 'growing'].includes(a.health)) return false
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

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="font-body" style={{ fontSize: 13, color: 'var(--color-text-secondary)' }}>
          Loading council data...
        </div>
      </div>
    )
  }

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
            {(['all', 'strong'] as const).map((key) => (
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
                {key === 'all' ? 'All' : 'Strong'}
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
              {advisors.length} advisors · {advisors.reduce((s, a) => s + a.videoCount, 0)} videos
            </span>
          </>
        )}
      </div>

      <CouncilTelemetryStrip />

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
            <CouncilListRight advisors={advisors} globalInsights={globalInsights} />
          )}
        </div>
      </div>
    </div>
  )
}
