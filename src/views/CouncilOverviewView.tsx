import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { Search, ChevronDown, GripVertical, RefreshCw, X } from 'lucide-react'
import { CouncilTelemetryStrip } from '../components/council/CouncilTelemetryStrip'
import {
  fetchDomainAgents,
  fetchAgentSkills,
  fetchBriefingInsights,
  fetchBriefingSkillAssignments,
  type AgentSkillAssignment,
  type BriefingInsight,
  type BriefingSkillAssignment,
} from '../services/supabase'
import type { DomainAgent, HealthStatus } from '../types/database'

// ─── CONSTANTS ──────────────────────────────────────────────────────────────

const DEFAULT_LEFT_PCT = 64
const MIN_LEFT_PCT = 45
const MAX_LEFT_PCT = 80
const DEFAULT_VISIBLE = 5

const HEALTH_CONFIG: Record<HealthStatus, { bg: string; text: string; label: string }> = {
  strong: { bg: '#dcfce7', text: '#15803d', label: 'Strong' },
  growing: { bg: '#d1fae5', text: '#047857', label: 'Growing' },
  thin: { bg: '#fef3c7', text: '#b45309', label: 'Thin' },
  stale: { bg: '#fee2e2', text: '#dc2626', label: 'Stale' },
  initialising: { bg: '#f3f4f6', text: '#6b7280', label: 'Init' },
}

const INSIGHT_TYPE_CONFIG: Record<string, { bg: string; text: string; label: string }> = {
  tension: { bg: '#fef3c7', text: '#b45309', label: 'TENSION' },
  convergence: { bg: '#dcfce7', text: '#15803d', label: 'CONVERGENCE' },
  novel_connection: { bg: '#e0e7ff', text: '#4338ca', label: 'CONNECTION' },
}

type SortKey = 'sources' | 'skills' | 'health' | 'alpha'
type HealthFilter = 'all' | HealthStatus
type Selection =
  | { type: 'insight'; data: BriefingInsight }
  | { type: 'skill'; data: BriefingSkillAssignment }
  | null

// ─── HELPERS ────────────────────────────────────────────────────────────────

function timeAgo(dateStr: string): string {
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000)
  if (seconds < 60) return 'just now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`
  return new Date(dateStr).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}

function formatCount(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

// ─── SMALL COMPONENTS ───────────────────────────────────────────────────────

function InsightTypeBadge({ type }: { type: string }) {
  const config = INSIGHT_TYPE_CONFIG[type] ?? INSIGHT_TYPE_CONFIG.novel_connection!
  return (
    <span style={{
      fontSize: 10, fontWeight: 700, fontFamily: 'var(--font-body)',
      textTransform: 'uppercase' as const, padding: '2px 8px', borderRadius: 4,
      background: config!.bg, color: config!.text, letterSpacing: '0.02em', flexShrink: 0,
    }}>
      {config!.label}
    </span>
  )
}

function HealthBadge({ status }: { status: HealthStatus }) {
  const config = HEALTH_CONFIG[status] || HEALTH_CONFIG.initialising
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 3,
      fontSize: 10, fontWeight: 600, fontFamily: 'var(--font-body)',
      padding: '1px 6px', borderRadius: 20, background: config.bg, color: config.text,
    }}>
      <span style={{ width: 5, height: 5, borderRadius: '50%', background: config.text }} />
      {config.label}
    </span>
  )
}

function SectionHeader({ label, total, showingAll, onToggle }: {
  label: string; total: number; showingAll: boolean; onToggle: () => void
}) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8,
      marginBottom: 10, marginTop: 20,
    }}>
      <span style={{
        fontSize: 10, fontWeight: 700, fontFamily: 'var(--font-display)',
        textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--color-text-secondary)',
      }}>
        {label}
      </span>
      <span style={{
        fontSize: 10, fontWeight: 600, fontFamily: 'var(--font-body)',
        padding: '1px 7px', borderRadius: 10,
        background: 'var(--color-bg-inset)', color: 'var(--color-text-secondary)',
      }}>
        {total}
      </span>
      {total > DEFAULT_VISIBLE && (
        <button type="button" onClick={onToggle} style={{
          marginLeft: 'auto', fontSize: 11, fontWeight: 600, fontFamily: 'var(--font-body)',
          color: 'var(--color-accent-500)', background: 'transparent', border: 'none',
          cursor: 'pointer', padding: 0,
        }}>
          {showingAll ? 'Show less' : `View all ${total}`}
        </button>
      )}
    </div>
  )
}

// ─── INSIGHT CARD (compact) ─────────────────────────────────────────────────

function InsightCard({ insight, agentName, selected, onSelect }: {
  insight: BriefingInsight; agentName: string; selected: boolean; onSelect: () => void
}) {
  return (
    <div onClick={onSelect} style={{
      background: selected ? 'var(--color-accent-50)' : 'var(--color-bg-card)',
      border: `1px solid ${selected ? 'rgba(214,58,0,0.15)' : 'var(--border-subtle)'}`,
      borderRadius: 12, padding: '12px 16px', marginBottom: 6, cursor: 'pointer',
      transition: 'all 0.15s ease',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <InsightTypeBadge type={insight.insight_type} />
        <span style={{ fontSize: 12, fontWeight: 600, fontFamily: 'var(--font-body)', color: 'var(--color-text-primary)' }}>
          {agentName}
        </span>
      </div>
      <div style={{
        fontSize: 12, fontFamily: 'var(--font-body)', color: 'var(--color-text-body)', lineHeight: 1.5,
        overflow: 'hidden', textOverflow: 'ellipsis', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
      }}>
        &ldquo;{insight.claim}&rdquo;
      </div>
    </div>
  )
}

// ─── SKILL ASSIGNMENT CARD (compact) ────────────────────────────────────────

function SkillAssignmentCard({ assignment, agentName, selected, onSelect }: {
  assignment: BriefingSkillAssignment; agentName: string; selected: boolean; onSelect: () => void
}) {
  return (
    <div onClick={onSelect} style={{
      background: selected ? 'var(--color-accent-50)' : 'var(--color-bg-card)',
      border: `1px solid ${selected ? 'rgba(214,58,0,0.15)' : 'var(--border-subtle)'}`,
      borderRadius: 12, padding: '12px 16px', marginBottom: 6, cursor: 'pointer',
      transition: 'all 0.15s ease',
    }}>
      {/* Header: agent + score + meta */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <span style={{ fontSize: 12, fontWeight: 600, fontFamily: 'var(--font-body)', color: 'var(--color-text-primary)' }}>
          {agentName}
        </span>
        <span style={{
          fontSize: 11, fontWeight: 700, fontFamily: 'var(--font-display)',
          color: '#15803d', background: '#dcfce7', padding: '1px 7px', borderRadius: 20, flexShrink: 0,
        }}>
          +{assignment.relevance.toFixed(1)}
        </span>
        <span style={{ marginLeft: 'auto', fontSize: 11, fontFamily: 'var(--font-body)', color: 'var(--color-text-placeholder)', flexShrink: 0 }}>
          {assignment.match_method === 'gemini_match' ? 'semantic match' : 'shared sources'} · {assignment.skill_status} · {timeAgo(assignment.assigned_at)}
        </span>
      </div>
      {/* Skill title + description */}
      <div style={{ fontSize: 13, fontWeight: 600, fontFamily: 'var(--font-body)', color: 'var(--color-text-primary)', marginBottom: 2 }}>
        {assignment.skill_title}
      </div>
      <div style={{
        fontSize: 12, fontFamily: 'var(--font-body)', color: 'var(--color-text-secondary)', lineHeight: 1.4,
        overflow: 'hidden', textOverflow: 'ellipsis', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
      }}>
        {assignment.skill_description}
      </div>
    </div>
  )
}

// ─── RIGHT PANEL: DETAIL VIEW ───────────────────────────────────────────────

function DetailPanel({ selection, agentNameMap, onClose }: {
  selection: Selection; agentNameMap: Map<string, string>; onClose: () => void
}) {
  if (!selection) return null

  const labelStyle: React.CSSProperties = {
    fontSize: 10, fontWeight: 700, fontFamily: 'var(--font-display)',
    textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--color-text-secondary)',
    marginBottom: 4, marginTop: 16,
  }
  const valueStyle: React.CSSProperties = {
    fontSize: 13, fontFamily: 'var(--font-body)', color: 'var(--color-text-body)', lineHeight: 1.5,
  }
  const metaStyle: React.CSSProperties = {
    fontSize: 12, fontFamily: 'var(--font-body)', color: 'var(--color-text-secondary)', lineHeight: 1.4,
  }

  if (selection.type === 'insight') {
    const d = selection.data
    const agentName = agentNameMap.get(d.agent_id) || 'Unknown'
    return (
      <>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
          <InsightTypeBadge type={d.insight_type} />
          <span style={{ fontSize: 14, fontWeight: 700, fontFamily: 'var(--font-display)', color: 'var(--color-text-primary)' }}>
            Insight Detail
          </span>
          <button type="button" onClick={onClose} style={{ marginLeft: 'auto', background: 'transparent', border: 'none', cursor: 'pointer', padding: 4 }}>
            <X size={16} style={{ color: 'var(--color-text-secondary)' }} />
          </button>
        </div>

        <div style={labelStyle}>Domain Expert</div>
        <div style={valueStyle}>{agentName}</div>

        <div style={labelStyle}>Claim</div>
        <div style={valueStyle}>&ldquo;{d.claim}&rdquo;</div>

        {d.evidence_summary && (
          <>
            <div style={labelStyle}>Evidence</div>
            <div style={{ ...valueStyle, padding: '10px 14px', background: 'var(--color-bg-inset)', borderRadius: 8 }}>
              {d.evidence_summary}
            </div>
          </>
        )}

        <div style={labelStyle}>Type</div>
        <div style={metaStyle}>{d.insight_type.replace('_', ' ')}</div>

        <div style={labelStyle}>Confidence</div>
        <div style={metaStyle}>{d.confidence?.toFixed(2) ?? 'N/A'}</div>

        <div style={labelStyle}>Related Entities</div>
        <div style={metaStyle}>{d.related_entity_ids.length} entities</div>

        <div style={labelStyle}>Surfaced</div>
        <div style={metaStyle}>{formatDate(d.created_at)}</div>
      </>
    )
  }

  if (selection.type === 'skill') {
    const d = selection.data
    const agentName = agentNameMap.get(d.agent_id) || 'Unknown'
    return (
      <>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
          <span style={{
            fontSize: 11, fontWeight: 700, fontFamily: 'var(--font-display)',
            color: '#15803d', background: '#dcfce7', padding: '2px 8px', borderRadius: 20,
          }}>
            +{d.relevance.toFixed(1)}
          </span>
          <span style={{ fontSize: 14, fontWeight: 700, fontFamily: 'var(--font-display)', color: 'var(--color-text-primary)' }}>
            Skill Assignment
          </span>
          <button type="button" onClick={onClose} style={{ marginLeft: 'auto', background: 'transparent', border: 'none', cursor: 'pointer', padding: 4 }}>
            <X size={16} style={{ color: 'var(--color-text-secondary)' }} />
          </button>
        </div>

        <div style={labelStyle}>Assigned To</div>
        <div style={valueStyle}>{agentName}</div>

        <div style={labelStyle}>Skill</div>
        <div style={{ fontSize: 14, fontWeight: 600, fontFamily: 'var(--font-body)', color: 'var(--color-text-primary)', marginBottom: 4 }}>
          {d.skill_title}
        </div>

        <div style={labelStyle}>Description</div>
        <div style={valueStyle}>{d.skill_description}</div>

        <div style={labelStyle}>Match Method</div>
        <div style={metaStyle}>{d.match_method === 'gemini_match' ? 'Semantic match — no shared sources, matched by topic alignment' : 'Source overlap — skill was extracted from content this agent already has'}</div>

        <div style={labelStyle}>Relevance</div>
        <div style={metaStyle}>{d.relevance.toFixed(2)}</div>

        <div style={labelStyle}>Skill Status</div>
        <div style={metaStyle}>{d.skill_status}</div>

        <div style={labelStyle}>Assigned</div>
        <div style={metaStyle}>{formatDate(d.assigned_at)}</div>
      </>
    )
  }

  return null
}

// ─── RIGHT PANEL: AGENT LIST (default) ──────────────────────────────────────

function AgentMiniCard({ agent, skillCount, onNavigate }: { agent: DomainAgent; skillCount: number; onNavigate: () => void }) {
  const [hovered, setHovered] = useState(false)
  return (
    <div onClick={onNavigate} onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
      style={{
        background: 'var(--color-bg-card)',
        border: `1px solid ${hovered ? 'var(--border-default)' : 'var(--border-subtle)'}`,
        borderRadius: 12, padding: '10px 14px', cursor: 'pointer',
        transition: 'all 0.18s ease',
        transform: hovered ? 'translateY(-1px)' : 'none',
        boxShadow: hovered ? '0 2px 8px rgba(0,0,0,0.04)' : 'none', marginBottom: 5,
      }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
        <span style={{ fontSize: 12, fontWeight: 700, fontFamily: 'var(--font-display)', color: 'var(--color-text-primary)', letterSpacing: '-0.01em' }}>
          {agent.name}
        </span>
        <HealthBadge status={agent.health_status} />
      </div>
      <div style={{ fontSize: 11, fontFamily: 'var(--font-body)', color: 'var(--color-text-secondary)' }}>
        {skillCount} skills · {agent.source_count} sources · {formatCount(agent.entity_count)} ent
      </div>
    </div>
  )
}

// ─── CONTROL BAR ────────────────────────────────────────────────────────────

function ControlBar({
  searchTerm, onSearchChange,
  healthFilter, onHealthFilterChange,
  sortKey, onSortKeyChange,
  cycleDate, totalAgents, totalInsights, totalSkills,
  isRecalibrating, onRecalibrate,
}: {
  searchTerm: string; onSearchChange: (v: string) => void
  healthFilter: HealthFilter; onHealthFilterChange: (v: HealthFilter) => void
  sortKey: SortKey; onSortKeyChange: (v: SortKey) => void
  cycleDate: string; totalAgents: number; totalInsights: number; totalSkills: number
  isRecalibrating: boolean; onRecalibrate: () => void
}) {
  const [healthOpen, setHealthOpen] = useState(false)
  const [sortOpen, setSortOpen] = useState(false)

  const healthOptions: { value: HealthFilter; label: string }[] = [
    { value: 'all', label: 'All Health' }, { value: 'strong', label: 'Strong' },
    { value: 'growing', label: 'Growing' }, { value: 'thin', label: 'Thin' }, { value: 'stale', label: 'Stale' },
  ]
  const sortOptions: { value: SortKey; label: string }[] = [
    { value: 'sources', label: 'Sources' }, { value: 'skills', label: 'Skills' },
    { value: 'health', label: 'Health' }, { value: 'alpha', label: 'A-Z' },
  ]

  const pillStyle = (active: boolean): React.CSSProperties => ({
    display: 'inline-flex', alignItems: 'center', gap: 4,
    padding: '5px 13px', borderRadius: 20, fontSize: 12, fontWeight: 600,
    fontFamily: 'var(--font-body)',
    border: active ? '1px solid rgba(214,58,0,0.15)' : '1px solid var(--border-subtle)',
    background: active ? 'var(--color-accent-50)' : 'transparent',
    color: active ? 'var(--color-accent-500)' : 'var(--color-text-secondary)',
    cursor: 'pointer', position: 'relative',
  })
  const dropdownStyle: React.CSSProperties = {
    position: 'absolute', top: '100%', left: 0, marginTop: 4,
    background: 'var(--color-bg-card)', border: '1px solid var(--border-strong)',
    borderRadius: 8, padding: 4, zIndex: 10, minWidth: 120, boxShadow: '0 4px 12px rgba(0,0,0,0.08)',
  }
  const itemStyle = (active: boolean): React.CSSProperties => ({
    display: 'block', width: '100%', padding: '6px 12px', fontSize: 12,
    fontFamily: 'var(--font-body)', fontWeight: active ? 600 : 400,
    color: active ? 'var(--color-accent-500)' : 'var(--color-text-body)',
    background: 'transparent', border: 'none', borderRadius: 4, cursor: 'pointer', textAlign: 'left' as const,
  })

  const statStyle: React.CSSProperties = { fontSize: 12, fontFamily: 'var(--font-body)', color: 'var(--color-text-secondary)' }
  const divider = <div style={{ width: 1, height: 24, background: 'var(--border-subtle)', flexShrink: 0 }} />

  return (
    <div style={{
      minHeight: 44, padding: '6px 24px', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
      background: 'var(--color-bg-card)', borderBottom: '1px solid var(--border-subtle)', flexShrink: 0,
    }}>
      {/* Search */}
      <div style={{ position: 'relative' }}>
        <Search size={12} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--color-text-secondary)' }} />
        <input type="text" placeholder="Search agents..." value={searchTerm} onChange={e => onSearchChange(e.target.value)}
          style={{ padding: '5px 26px 5px 28px', borderRadius: 20, fontSize: 12, fontFamily: 'var(--font-body)', border: '1px solid var(--border-subtle)', background: 'var(--color-bg-inset)', color: 'var(--color-text-body)', outline: 'none', width: 140 }} />
      </div>

      {divider}

      {/* Cycle stats */}
      <span style={{ ...statStyle, fontWeight: 600, color: 'var(--color-text-primary)' }}>Latest Cycle</span>
      <span style={statStyle}>{cycleDate}</span>
      {divider}
      <span style={statStyle}>{totalAgents} agents</span>
      <span style={statStyle}>{totalInsights} insights</span>
      <span style={statStyle}>{totalSkills} skills</span>

      {divider}

      {/* Filters */}
      <div style={{ position: 'relative' }}>
        <button type="button" onClick={() => { setHealthOpen(!healthOpen); setSortOpen(false) }} style={pillStyle(healthFilter !== 'all')}>
          {healthOptions.find(o => o.value === healthFilter)?.label || 'All Health'} <ChevronDown size={12} />
        </button>
        {healthOpen && (
          <div style={dropdownStyle}>
            {healthOptions.map(o => <button key={o.value} type="button" onClick={() => { onHealthFilterChange(o.value); setHealthOpen(false) }} style={itemStyle(healthFilter === o.value)}>{o.label}</button>)}
          </div>
        )}
      </div>
      <div style={{ position: 'relative' }}>
        <button type="button" onClick={() => { setSortOpen(!sortOpen); setHealthOpen(false) }} style={pillStyle(false)}>
          Sort: {sortOptions.find(o => o.value === sortKey)?.label} <ChevronDown size={12} />
        </button>
        {sortOpen && (
          <div style={dropdownStyle}>
            {sortOptions.map(o => <button key={o.value} type="button" onClick={() => { onSortKeyChange(o.value); setSortOpen(false) }} style={itemStyle(sortKey === o.value)}>{o.label}</button>)}
          </div>
        )}
      </div>

      {/* Recalibrate */}
      <button type="button" onClick={onRecalibrate} disabled={isRecalibrating}
        style={{
          marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 5,
          padding: '5px 13px', borderRadius: 20, fontSize: 12, fontWeight: 600,
          fontFamily: 'var(--font-body)', cursor: isRecalibrating ? 'wait' : 'pointer',
          border: '1px solid rgba(214,58,0,0.15)', background: 'var(--color-accent-50)', color: 'var(--color-accent-500)',
          opacity: isRecalibrating ? 0.6 : 1,
        }}>
        <RefreshCw size={12} style={{ animation: isRecalibrating ? 'spin 1s linear infinite' : 'none' }} />
        {isRecalibrating ? 'Running...' : 'Recalibrate'}
      </button>
    </div>
  )
}

// ─── MAIN VIEW ──────────────────────────────────────────────────────────────

export function CouncilOverviewView() {
  const navigate = useNavigate()
  const [agents, setAgents] = useState<DomainAgent[]>([])
  const [agentSkills, setAgentSkills] = useState<AgentSkillAssignment[]>([])
  const [insights, setInsights] = useState<BriefingInsight[]>([])
  const [skillAssignments, setSkillAssignments] = useState<BriefingSkillAssignment[]>([])
  const [loading, setLoading] = useState(true)
  const [isRecalibrating, setIsRecalibrating] = useState(false)
  const [selection, setSelection] = useState<Selection>(null)

  // Visibility toggles
  const [insightsExpanded, setInsightsExpanded] = useState(false)
  const [skillsExpanded, setSkillsExpanded] = useState(false)

  // Filters
  const [searchTerm, setSearchTerm] = useState('')
  const [healthFilter, setHealthFilter] = useState<HealthFilter>('all')
  const [sortKey, setSortKey] = useState<SortKey>('sources')

  // Resizable columns
  const [leftWidthPct, setLeftWidthPct] = useState(DEFAULT_LEFT_PCT)
  const [isDragging, setIsDragging] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const dragStartX = useRef(0)
  const dragStartPct = useRef(DEFAULT_LEFT_PCT)

  const handleDividerMouseDown = useCallback((event: React.MouseEvent) => {
    event.preventDefault()
    dragStartX.current = event.clientX
    dragStartPct.current = leftWidthPct
    setIsDragging(true)
    const onMove = (e: MouseEvent) => {
      if (!containerRef.current) return
      const w = containerRef.current.getBoundingClientRect().width
      const delta = ((e.clientX - dragStartX.current) / w) * 100
      setLeftWidthPct(Math.min(MAX_LEFT_PCT, Math.max(MIN_LEFT_PCT, dragStartPct.current + delta)))
    }
    const onUp = () => { setIsDragging(false); document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp) }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [leftWidthPct])

  const agentNameMap = useMemo(() => new Map(agents.map(a => [a.id, a.name])), [agents])
  const skillCountByAgent = useMemo(() => {
    const m = new Map<string, number>()
    for (const s of agentSkills) m.set(s.agent_id, (m.get(s.agent_id) || 0) + 1)
    return m
  }, [agentSkills])

  const loadData = useCallback(async () => {
    setLoading(true)
    try {
      const [a, sk, ins, sa] = await Promise.all([
        fetchDomainAgents(), fetchAgentSkills(),
        fetchBriefingInsights(50), fetchBriefingSkillAssignments(50),
      ])
      setAgents(a); setAgentSkills(sk); setInsights(ins); setSkillAssignments(sa)
    } catch (err) { console.error('[CouncilOverview] Load failed:', err) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { loadData() }, [loadData])

  const handleRecalibrate = useCallback(async () => {
    setIsRecalibrating(true)
    try {
      const res = await fetch('/api/council/cron', { method: 'POST', headers: { 'Content-Type': 'application/json' } })
      if (res.ok) await loadData()
    } catch (err) { console.error('[CouncilOverview] Recalibrate failed:', err) }
    finally { setIsRecalibrating(false) }
  }, [loadData])

  const filteredAgents = useMemo(() => {
    let result = agents
    if (searchTerm) { const q = searchTerm.toLowerCase(); result = result.filter(a => a.name.toLowerCase().includes(q)) }
    if (healthFilter !== 'all') result = result.filter(a => a.health_status === healthFilter)
    const ho: Record<string, number> = { strong: 0, growing: 1, thin: 2, stale: 3, initialising: 4 }
    return [...result].sort((a, b) => {
      switch (sortKey) {
        case 'sources': return b.source_count - a.source_count
        case 'skills': return (skillCountByAgent.get(b.id) || 0) - (skillCountByAgent.get(a.id) || 0)
        case 'health': return (ho[a.health_status] ?? 5) - (ho[b.health_status] ?? 5)
        case 'alpha': return a.name.localeCompare(b.name)
        default: return 0
      }
    })
  }, [agents, searchTerm, healthFilter, sortKey, skillCountByAgent])

  const totalUniqueSkills = useMemo(() => new Set(agentSkills.map(s => s.skill_id)).size, [agentSkills])
  const cycleDate = agents.length > 0 && agents[0]?.last_index_rebuild_at
    ? new Date(agents[0].last_index_rebuild_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
    : '—'

  const insightsToShow = insightsExpanded ? insights : insights.slice(0, DEFAULT_VISIBLE)
  const skillsToShow = skillsExpanded ? skillAssignments : skillAssignments.slice(0, DEFAULT_VISIBLE)

  // ─── RENDER ─────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        <div style={{ height: 44, background: 'var(--color-bg-card)', borderBottom: '1px solid var(--border-subtle)', flexShrink: 0 }} />
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <span style={{ fontSize: 13, color: 'var(--color-text-secondary)', fontFamily: 'var(--font-body)' }}>Loading council...</span>
        </div>
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <style>{`@keyframes spin { from { transform: rotate(0deg) } to { transform: rotate(360deg) } }`}</style>

      <ControlBar
        searchTerm={searchTerm} onSearchChange={setSearchTerm}
        healthFilter={healthFilter} onHealthFilterChange={setHealthFilter}
        sortKey={sortKey} onSortKeyChange={setSortKey}
        cycleDate={cycleDate}
        totalAgents={agents.length} totalInsights={insights.length}
        totalSkills={totalUniqueSkills}
        isRecalibrating={isRecalibrating} onRecalibrate={handleRecalibrate}
      />

      <CouncilTelemetryStrip />

      <div ref={containerRef} className="flex flex-1 overflow-hidden"
        style={{ background: 'var(--color-bg-content)', userSelect: isDragging ? 'none' : undefined, cursor: isDragging ? 'col-resize' : undefined }}>

        {/* LEFT: Briefing */}
        <div style={{
          width: `${leftWidthPct}%`, height: '100%',
          overflowY: 'auto', overflowX: 'hidden', flexShrink: 0,
          transition: isDragging ? 'none' : 'width 0.2s ease',
          padding: '12px 28px 40px',
        }}>
          {/* Insights */}
          <SectionHeader label="Insights Surfaced" total={insights.length}
            showingAll={insightsExpanded} onToggle={() => setInsightsExpanded(v => !v)} />
          {insightsToShow.map(ins => (
            <InsightCard key={ins.id} insight={ins} agentName={agentNameMap.get(ins.agent_id) || 'Unknown'}
              selected={selection?.type === 'insight' && selection.data.id === ins.id}
              onSelect={() => setSelection(selection?.type === 'insight' && selection.data.id === ins.id ? null : { type: 'insight', data: ins })} />
          ))}

          {/* Skills */}
          <SectionHeader label="Skills Distributed" total={skillAssignments.length}
            showingAll={skillsExpanded} onToggle={() => setSkillsExpanded(v => !v)} />
          {skillsToShow.map(sa => (
            <SkillAssignmentCard key={sa.id} assignment={sa}
              agentName={agentNameMap.get(sa.agent_id) || 'Unknown'}
              selected={selection?.type === 'skill' && selection.data.id === sa.id}
              onSelect={() => setSelection(selection?.type === 'skill' && selection.data.id === sa.id ? null : { type: 'skill', data: sa })} />
          ))}
        </div>

        {/* Drag handle */}
        <div onMouseDown={handleDividerMouseDown} className="flex items-center justify-center shrink-0"
          style={{ width: 12, cursor: 'col-resize', background: isDragging ? 'rgba(214,58,0,0.04)' : 'transparent', transition: 'background 0.15s ease' }}
          onMouseEnter={e => { if (!isDragging) e.currentTarget.style.background = 'rgba(0,0,0,0.02)' }}
          onMouseLeave={e => { if (!isDragging) e.currentTarget.style.background = 'transparent' }}>
          <GripVertical size={14} style={{ color: isDragging ? 'var(--color-accent-500)' : 'var(--color-text-placeholder)', transition: 'color 0.15s ease' }} />
        </div>

        {/* RIGHT: Detail panel or Agent list */}
        <div style={{
          flex: 1, height: '100%', overflow: 'hidden', minWidth: 0,
          background: 'var(--color-bg-card)', display: 'flex', flexDirection: 'column',
        }}>
          <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', padding: '16px 20px' }}>
            {selection ? (
              <DetailPanel selection={selection} agentNameMap={agentNameMap} onClose={() => setSelection(null)} />
            ) : (
              <>
                <div style={{
                  fontSize: 10, fontWeight: 700, fontFamily: 'var(--font-display)',
                  textTransform: 'uppercase', letterSpacing: '0.08em',
                  color: 'var(--color-text-secondary)', marginBottom: 10,
                }}>
                  Domain Experts
                </div>
                {filteredAgents.map(agent => (
                  <AgentMiniCard key={agent.id} agent={agent} skillCount={skillCountByAgent.get(agent.id) || 0} onNavigate={() => navigate(`/council/${agent.id}`)} />
                ))}
                {filteredAgents.length === 0 && (
                  <div style={{ textAlign: 'center', padding: '32px 0', fontSize: 12, fontFamily: 'var(--font-body)', color: 'var(--color-text-secondary)' }}>
                    No agents match filters
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
