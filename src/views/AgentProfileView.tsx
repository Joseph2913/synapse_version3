import { useState, useEffect, useCallback, useRef } from 'react'
import { useParams, useNavigate, useSearchParams } from 'react-router-dom'
import { ArrowLeft, GripVertical, ChevronDown, ChevronRight, MessageSquare } from 'lucide-react'
import {
  fetchAgentWithPlaylist,
  fetchAgentQuestions,
  fetchAgentInsights,
  fetchAgentGaps,
  fetchAgentSkillAssignments,
  type AgentSkillAssignment,
} from '../services/supabase'
import type { DomainAgent, AgentStandingQuestion, AgentInsightRow, AgentGapRow, HealthStatus } from '../types/database'
import type { AddressingEvidenceEntry } from '../types/council'
import { QuestionStatusBadge } from '../components/council/QuestionStatusBadge'

// ─── CONSTANTS ──────────────────────────────────────────────────────────────

const DEFAULT_LEFT_PCT = 64
const MIN_LEFT_PCT = 50
const MAX_LEFT_PCT = 75
const TOP_N = 5

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

const QUESTION_TYPE_COLORS: Record<string, string> = {
  gap_driven: '#d63a00', frontier: '#0d9488', cross_domain: '#7c3aed', user_defined: '#6b7280',
}

interface ExpertiseIndex {
  summary?: string
  core_themes?: string[]
  reasoning_approach?: string
  strongest_areas?: Array<{ topic: string; source_count: number; key_entities: string[] }>
  weakest_areas?: Array<{ topic: string; reason: string }>
}

// ─── HELPERS ────────────────────────────────────────────────────────────────

function timeAgo(dateStr: string): string {
  const s = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  if (s < 604800) return `${Math.floor(s / 86400)}d ago`
  return new Date(dateStr).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}

function formatCount(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

// ─── SMALL COMPONENTS ───────────────────────────────────────────────────────

const sectionLabelBase: React.CSSProperties = {
  fontSize: 10, fontWeight: 700, fontFamily: 'var(--font-display)',
  textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--color-text-secondary)',
}

function SectionHeader({ label, count, total, expanded, onToggle }: {
  label: string; count?: number; total: number; expanded: boolean; onToggle: () => void
}) {
  return (
    <div style={{ ...sectionLabelBase, display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, marginTop: 20 }}>
      {label}
      {count != null && (
        <span style={{ fontSize: 10, fontWeight: 600, fontFamily: 'var(--font-body)', padding: '1px 7px', borderRadius: 10, background: 'var(--color-bg-inset)', color: 'var(--color-text-secondary)' }}>
          {count}
        </span>
      )}
      {total > TOP_N && (
        <button type="button" onClick={onToggle} style={{
          marginLeft: 'auto', fontSize: 11, fontWeight: 600, fontFamily: 'var(--font-body)',
          color: 'var(--color-accent-500)', background: 'transparent', border: 'none', cursor: 'pointer', padding: 0,
        }}>
          {expanded ? 'Show less' : `View all ${total}`}
        </button>
      )}
    </div>
  )
}

function HealthBadge({ status }: { status: HealthStatus }) {
  const c = HEALTH_CONFIG[status] || HEALTH_CONFIG.initialising
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 600, fontFamily: 'var(--font-body)', padding: '2px 8px', borderRadius: 20, background: c.bg, color: c.text }}>
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: c.text }} />
      {c.label}
    </span>
  )
}

function InsightTypeBadge({ type }: { type: string }) {
  const c = INSIGHT_TYPE_CONFIG[type] ?? INSIGHT_TYPE_CONFIG.novel_connection!
  return (
    <span style={{ fontSize: 10, fontWeight: 700, fontFamily: 'var(--font-body)', textTransform: 'uppercase' as const, padding: '2px 8px', borderRadius: 4, background: c!.bg, color: c!.text, letterSpacing: '0.02em', flexShrink: 0 }}>
      {c!.label}
    </span>
  )
}

// ─── LEFT: IDENTITY ─────────────────────────────────────────────────────────

function IdentitySection({ agent, expertise, playlistName }: { agent: DomainAgent; expertise: ExpertiseIndex; playlistName: string | null }) {
  return (
    <div style={{ background: 'var(--color-bg-card)', border: '1px solid var(--border-subtle)', borderRadius: 12, padding: '16px 20px' }}>
      <div style={{ fontSize: 13, fontFamily: 'var(--font-body)', color: 'var(--color-text-body)', lineHeight: 1.6, marginBottom: 12 }}>
        {agent.description || expertise.summary || 'No description available.'}
      </div>
      {expertise.reasoning_approach && (
        <div style={{ fontSize: 12, fontFamily: 'var(--font-body)', color: 'var(--color-text-secondary)', marginBottom: 12 }}>
          <span style={{ fontWeight: 600 }}>Reasoning:</span> {expertise.reasoning_approach}
        </div>
      )}
      <div style={{ display: 'flex', gap: 16, fontSize: 12, fontFamily: 'var(--font-body)', color: 'var(--color-text-secondary)' }}>
        <span>{agent.source_count} sources</span>
        <span>{formatCount(agent.entity_count)} entities</span>
        {playlistName && <span>Playlist: {playlistName}</span>}
        {agent.last_index_rebuild_at && <span>Rebuilt: {timeAgo(agent.last_index_rebuild_at)}</span>}
      </div>
    </div>
  )
}

// ─── LEFT: EXPERTISE ────────────────────────────────────────────────────────

function ExpertiseSection({ expertise }: { expertise: ExpertiseIndex }) {
  const strongest = expertise.strongest_areas || []
  const weakest = expertise.weakest_areas || []
  if (strongest.length === 0 && weakest.length === 0) return null
  return (
    <div style={{ display: 'flex', gap: 12 }}>
      {strongest.length > 0 && (
        <div style={{ flex: 1, background: 'var(--color-bg-card)', border: '1px solid var(--border-subtle)', borderRadius: 12, padding: '14px 18px' }}>
          <div style={{ ...sectionLabelBase, marginBottom: 8 }}>Strongest Areas</div>
          {strongest.map(a => (
            <div key={a.topic} style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 12, fontWeight: 600, fontFamily: 'var(--font-body)', color: 'var(--color-text-primary)' }}>{a.topic}</div>
              <div style={{ fontSize: 11, fontFamily: 'var(--font-body)', color: 'var(--color-text-secondary)' }}>{a.source_count} sources</div>
            </div>
          ))}
        </div>
      )}
      {weakest.length > 0 && (
        <div style={{ flex: 1, background: 'var(--color-bg-card)', border: '1px solid var(--border-subtle)', borderRadius: 12, padding: '14px 18px' }}>
          <div style={{ ...sectionLabelBase, marginBottom: 8 }}>Gaps in Knowledge</div>
          {weakest.map(a => (
            <div key={a.topic} style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 12, fontWeight: 600, fontFamily: 'var(--font-body)', color: 'var(--color-text-primary)' }}>{a.topic}</div>
              <div style={{ fontSize: 11, fontFamily: 'var(--font-body)', color: 'var(--color-text-secondary)' }}>{a.reason}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── RIGHT: INSIGHT CARD ────────────────────────────────────────────────────

function InsightActivityCard({ insight }: { insight: AgentInsightRow }) {
  const [expanded, setExpanded] = useState(false)
  return (
    <div style={{ background: 'var(--color-bg-card)', border: '1px solid var(--border-subtle)', borderRadius: 10, padding: '10px 14px', marginBottom: 6 }}>
      <div onClick={() => insight.evidence_summary && setExpanded(!expanded)}
        style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4, cursor: insight.evidence_summary ? 'pointer' : 'default' }}>
        <InsightTypeBadge type={insight.insight_type} />
        <span style={{ marginLeft: 'auto', fontSize: 11, fontFamily: 'var(--font-body)', color: 'var(--color-text-placeholder)' }}>
          {timeAgo(insight.created_at)}
        </span>
        {insight.evidence_summary && (expanded ? <ChevronDown size={12} style={{ color: 'var(--color-text-secondary)' }} /> : <ChevronRight size={12} style={{ color: 'var(--color-text-secondary)' }} />)}
      </div>
      <div style={{ fontSize: 12, fontFamily: 'var(--font-body)', color: 'var(--color-text-body)', lineHeight: 1.5 }}>
        &ldquo;{insight.claim}&rdquo;
      </div>
      {expanded && insight.evidence_summary && (
        <div style={{ marginTop: 8, padding: '8px 12px', background: 'var(--color-bg-inset)', borderRadius: 8, fontSize: 11, fontFamily: 'var(--font-body)', color: 'var(--color-text-body)', lineHeight: 1.5 }}>
          {insight.evidence_summary}
        </div>
      )}
    </div>
  )
}

// ─── MAIN VIEW ──────────────────────────────────────────────────────────────

export function AgentProfileView() {
  const { agentId } = useParams<{ agentId: string }>()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const focusId = searchParams.get('focus')
  const scrolledFocusRef = useRef<string | null>(null)

  const [agent, setAgent] = useState<DomainAgent | null>(null)
  const [playlistName, setPlaylistName] = useState<string | null>(null)
  const [questions, setQuestions] = useState<AgentStandingQuestion[]>([])
  const [insights, setInsights] = useState<AgentInsightRow[]>([])
  const [gaps, setGaps] = useState<AgentGapRow[]>([])
  const [skills, setSkills] = useState<AgentSkillAssignment[]>([])
  const [loading, setLoading] = useState(true)

  // Expand toggles
  const [themesExpanded, setThemesExpanded] = useState(false)
  const [skillsExpanded, setSkillsExpanded] = useState(false)
  const [questionsExpanded, setQuestionsExpanded] = useState(false)
  const [gapsExpanded, setGapsExpanded] = useState(false)
  const [insightsExpanded, setInsightsExpanded] = useState(false)

  // Resizable
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
      setLeftWidthPct(Math.min(MAX_LEFT_PCT, Math.max(MIN_LEFT_PCT, dragStartPct.current + ((e.clientX - dragStartX.current) / w) * 100)))
    }
    const onUp = () => { setIsDragging(false); document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp) }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [leftWidthPct])

  const loadData = useCallback(async () => {
    if (!agentId) return
    setLoading(true)
    try {
      const [agentData, questionsData, insightsData, gapsData, skillsData] = await Promise.all([
        fetchAgentWithPlaylist(agentId), fetchAgentQuestions(agentId), fetchAgentInsights(agentId),
        fetchAgentGaps(agentId),
        fetchAgentSkillAssignments(agentId),
      ])
      setAgent(agentData.agent); setPlaylistName(agentData.playlistName)
      setQuestions(questionsData); setInsights(insightsData); setGaps(gapsData)
      setSkills(skillsData)
    } catch (err) { console.error('[AgentProfile] Load failed:', err) }
    finally { setLoading(false) }
  }, [agentId])

  useEffect(() => { loadData() }, [loadData])

  // Deep-link from Home Council Digest: if ?focus=<itemId> matches a question, gap, or insight,
  // expand its section (in case it's past the top-N) and scroll/highlight it once rendered.
  useEffect(() => {
    if (!focusId) return
    if (scrolledFocusRef.current === focusId) return
    if (loading) return

    // Decide which section the focused item belongs to and expand if needed
    const isQuestion = questions.some(q => q.id === focusId)
    const isGap = gaps.some(g => g.id === focusId)
    const isInsight = insights.some(i => i.id === focusId)

    if (isQuestion) setQuestionsExpanded(true)
    if (isGap) setGapsExpanded(true)
    if (isInsight) setInsightsExpanded(true)

    if (!isQuestion && !isGap && !isInsight) return

    // Poll for the element: the section expansion triggers a re-render
    let attempts = 0
    const handle = window.setInterval(() => {
      const el = document.getElementById(`council-item-${focusId}`)
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' })
        const originalTransition = el.style.transition
        const originalShadow = el.style.boxShadow
        el.style.transition = 'box-shadow 0.3s ease'
        el.style.boxShadow = '0 0 0 2px var(--color-accent-500)'
        window.setTimeout(() => {
          el.style.boxShadow = originalShadow
          el.style.transition = originalTransition
        }, 1800)
        scrolledFocusRef.current = focusId
        window.clearInterval(handle)
      } else if (++attempts > 40) {
        window.clearInterval(handle)
      }
    }, 100)
    return () => window.clearInterval(handle)
  }, [focusId, loading, questions, gaps, insights])

  const expertise = (agent?.expertise_index || {}) as ExpertiseIndex
  const coreThemes = expertise.core_themes || []
  const openQuestions = questions.filter(q => q.status === 'open' || q.status === 'partially_addressed')

  // Sliced lists
  const themesToShow = themesExpanded ? coreThemes : coreThemes.slice(0, TOP_N)
  const skillsToShow = skillsExpanded ? skills : skills.slice(0, TOP_N)
  const questionsToShow = questionsExpanded ? openQuestions : openQuestions.slice(0, TOP_N)
  const gapsToShow = gapsExpanded ? gaps : gaps.slice(0, TOP_N)
  const insightsToShow = insightsExpanded ? insights : insights.slice(0, TOP_N)

  // ─── RENDER ─────────────────────────────────────────────────────────────────

  if (loading || !agent) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        <div style={{ height: 44, background: 'var(--color-bg-card)', borderBottom: '1px solid var(--border-subtle)', flexShrink: 0 }} />
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <span style={{ fontSize: 13, color: 'var(--color-text-secondary)', fontFamily: 'var(--font-body)' }}>Loading agent...</span>
        </div>
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Header bar */}
      <div style={{
        height: 44, padding: '0 24px', display: 'flex', alignItems: 'center', gap: 10,
        background: 'var(--color-bg-card)', borderBottom: '1px solid var(--border-subtle)', flexShrink: 0,
      }}>
        <button type="button" onClick={() => navigate('/council')} style={{
          display: 'inline-flex', alignItems: 'center', gap: 4, background: 'transparent', border: 'none',
          cursor: 'pointer', fontSize: 12, fontWeight: 600, fontFamily: 'var(--font-body)', color: 'var(--color-text-secondary)',
        }}>
          <ArrowLeft size={14} /> Council
        </button>
        <div style={{ width: 1, height: 24, background: 'var(--border-subtle)' }} />
        <span style={{ fontSize: 15, fontWeight: 700, fontFamily: 'var(--font-display)', color: 'var(--color-text-primary)', letterSpacing: '-0.01em' }}>
          {agent.name}
        </span>
        <HealthBadge status={agent.health_status} />
        <span style={{ fontSize: 12, fontFamily: 'var(--font-body)', color: 'var(--color-text-secondary)' }}>
          {skills.length} skills · {agent.source_count} sources · {formatCount(agent.entity_count)} entities
        </span>
        <button type="button" onClick={() => navigate(`/ask?agent=${agentId}`)} style={{
          marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 5,
          padding: '5px 13px', borderRadius: 20, fontSize: 12, fontWeight: 600,
          fontFamily: 'var(--font-body)', cursor: 'pointer',
          border: '1px solid rgba(214,58,0,0.15)', background: 'var(--color-accent-50)', color: 'var(--color-accent-500)',
        }}>
          <MessageSquare size={12} /> Chat with expert
        </button>
      </div>

      {/* Main: 2:1 split */}
      <div ref={containerRef} className="flex flex-1 overflow-hidden"
        style={{ background: 'var(--color-bg-content)', userSelect: isDragging ? 'none' : undefined, cursor: isDragging ? 'col-resize' : undefined }}>

        {/* LEFT: Static profile (2/3) */}
        <div style={{
          width: `${leftWidthPct}%`, height: '100%', overflowY: 'auto', overflowX: 'hidden',
          flexShrink: 0, transition: isDragging ? 'none' : 'width 0.2s ease', padding: '16px 24px 40px',
        }}>
          <IdentitySection agent={agent} expertise={expertise} playlistName={playlistName} />

          <SectionHeader label="Expertise Index" total={0} expanded={false} onToggle={() => {}} />
          <ExpertiseSection expertise={expertise} />

          {coreThemes.length > 0 && (
            <>
              <SectionHeader label="Core Themes" count={coreThemes.length} total={coreThemes.length} expanded={themesExpanded} onToggle={() => setThemesExpanded(v => !v)} />
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {themesToShow.map(t => (
                  <span key={t} style={{ fontSize: 11, fontWeight: 600, fontFamily: 'var(--font-body)', padding: '3px 10px', borderRadius: 20, background: 'rgba(0,0,0,0.04)', color: 'var(--color-text-body)' }}>{t}</span>
                ))}
              </div>
            </>
          )}

          {skills.length > 0 && (
            <>
              <SectionHeader label="Skills" count={skills.length} total={skills.length} expanded={skillsExpanded} onToggle={() => setSkillsExpanded(v => !v)} />
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {skillsToShow.map(s => (
                  <div key={s.skill_id} style={{
                    background: 'var(--color-bg-card)', border: '1px solid var(--border-subtle)',
                    borderRadius: 10, padding: '8px 12px', minWidth: 140, maxWidth: 220, flex: '0 0 auto',
                  }}>
                    <div style={{ fontSize: 12, fontWeight: 600, fontFamily: 'var(--font-body)', color: 'var(--color-text-primary)', marginBottom: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {s.skill?.title || s.skill_id}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, fontFamily: 'var(--font-body)', color: 'var(--color-text-secondary)' }}>
                      <span style={{ fontSize: 10, fontWeight: 700, color: '#15803d', background: '#dcfce7', padding: '0px 5px', borderRadius: 10 }}>+{s.relevance.toFixed(1)}</span>
                      {s.skill?.status || 'draft'}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}

          {openQuestions.length > 0 && (
            <>
              <SectionHeader label="Standing Questions" count={openQuestions.length} total={openQuestions.length} expanded={questionsExpanded} onToggle={() => setQuestionsExpanded(v => !v)} />
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {questionsToShow.map(q => (
                  <div key={q.id} id={`council-item-${q.id}`} style={{ background: 'var(--color-bg-card)', border: '1px solid var(--border-subtle)', borderRadius: 10, padding: '10px 14px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                      <span style={{ width: 6, height: 6, borderRadius: '50%', background: QUESTION_TYPE_COLORS[q.question_type] || '#6b7280', flexShrink: 0 }} />
                      <span style={{ fontSize: 11, fontWeight: 600, fontFamily: 'var(--font-body)', color: 'var(--color-text-secondary)' }}>{q.question_type.replace('_', ' ')}</span>
                      <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ fontSize: 11, fontFamily: 'var(--font-body)', color: 'var(--color-text-placeholder)' }}>P{q.priority}</span>
                        <QuestionStatusBadge status={q.status} addressingEvidence={q.addressing_evidence as AddressingEvidenceEntry[] | null} />
                      </span>
                    </div>
                    <div style={{ fontSize: 12, fontFamily: 'var(--font-body)', color: 'var(--color-text-body)', lineHeight: 1.5 }}>{q.question}</div>
                  </div>
                ))}
              </div>
            </>
          )}

          {gaps.length > 0 && (
            <>
              <SectionHeader label="Knowledge Gaps" count={gaps.length} total={gaps.length} expanded={gapsExpanded} onToggle={() => setGapsExpanded(v => !v)} />
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {gapsToShow.map(g => (
                  <div key={g.id} id={`council-item-${g.id}`} style={{ background: 'var(--color-bg-card)', border: '1px solid var(--border-subtle)', borderRadius: 10, padding: '10px 14px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ fontSize: 12, fontWeight: 600, fontFamily: 'var(--font-body)', color: 'var(--color-text-primary)' }}>{g.topic}</span>
                      <span style={{ marginLeft: 'auto', fontSize: 10, fontWeight: 600, fontFamily: 'var(--font-body)', padding: '1px 7px', borderRadius: 10, background: g.severity === 'significant' ? '#fee2e2' : g.severity === 'moderate' ? '#fef3c7' : '#f3f4f6', color: g.severity === 'significant' ? '#dc2626' : g.severity === 'moderate' ? '#b45309' : '#6b7280' }}>
                        {g.severity}
                      </span>
                    </div>
                    {g.description && <div style={{ fontSize: 11, fontFamily: 'var(--font-body)', color: 'var(--color-text-secondary)', marginTop: 4 }}>{g.description}</div>}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

        {/* Drag handle */}
        <div onMouseDown={handleDividerMouseDown} className="flex items-center justify-center shrink-0"
          style={{ width: 12, cursor: 'col-resize', background: isDragging ? 'rgba(214,58,0,0.04)' : 'transparent', transition: 'background 0.15s ease' }}
          onMouseEnter={e => { if (!isDragging) e.currentTarget.style.background = 'rgba(0,0,0,0.02)' }}
          onMouseLeave={e => { if (!isDragging) e.currentTarget.style.background = 'transparent' }}>
          <GripVertical size={14} style={{ color: isDragging ? 'var(--color-accent-500)' : 'var(--color-text-placeholder)', transition: 'color 0.15s ease' }} />
        </div>

        {/* RIGHT: Recent activity (1/3) */}
        <div style={{
          flex: 1, height: '100%', overflow: 'hidden', minWidth: 0,
          background: 'var(--color-bg-card)', display: 'flex', flexDirection: 'column',
        }}>
          <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', padding: '16px 20px 40px' }}>

            {/* Insights */}
            {insights.length > 0 && (
              <>
                <SectionHeader label="Insights Surfaced" count={insights.length} total={insights.length} expanded={insightsExpanded} onToggle={() => setInsightsExpanded(v => !v)} />
                {insightsToShow.map(ins => (
                  <div key={ins.id} id={`council-item-${ins.id}`}>
                    <InsightActivityCard insight={ins} />
                  </div>
                ))}
              </>
            )}

            {insights.length === 0 && (
              <div style={{ textAlign: 'center', padding: '48px 0', fontSize: 13, fontFamily: 'var(--font-body)', color: 'var(--color-text-secondary)' }}>
                No recent activity for this agent
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
