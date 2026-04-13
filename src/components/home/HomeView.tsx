import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { Database, GitBranch, Anchor, Zap, Youtube, FileText, BookOpen, StickyNote, Video, Globe, Mail, ArrowUpRight, Search, MessageSquare, Users } from 'lucide-react'
import { useGraphContext } from '../../hooks/useGraphContext'
import { useHomeDashboard } from '../../hooks/useHomeDashboard'
import { useAuth } from '../../hooks/useAuth'
import { PROVIDER_CONFIG } from '../../config/sourceTypes'
import { supabase, fetchDomainAgents, fetchAgentCounts } from '../../services/supabase'
import { RecentSourcesPanel } from './RecentSourcesPanel'
import { buildSourceChatContext, buildInsightChatContext, buildSignalChatContext, buildSkillChatContext } from '../../config/chatEntryContexts'
import type { KnowledgeSource, AgentInsightRow, AgentSignalRow } from '../../types/database'

// Fixed layout — no resizing on dashboard

function formatRelativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime()
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

function getGreeting(): string {
  const hour = new Date().getHours()
  if (hour < 12) return 'Good morning'
  if (hour < 18) return 'Good afternoon'
  return 'Good evening'
}

// ── Source badge helpers ──────────────────────────────────────────────────────

interface SourceBadgeInfo {
  label: string
  icon: React.ReactNode
  logo: string | null
  color: string
  bg: string
}

const SOURCE_BADGE_MAP: Record<string, SourceBadgeInfo> = {
  YouTube:  { label: 'YouTube',   icon: <Youtube size={14} />,    logo: PROVIDER_CONFIG.youtube?.logo ?? null,  color: '#ef4444', bg: '#fef2f2' },
  Document: { label: 'Documents', icon: <FileText size={14} />,   logo: null,                                   color: '#d97706', bg: '#fffbeb' },
  Note:     { label: 'Notes',     icon: <StickyNote size={14} />, logo: null,                                   color: '#10b981', bg: '#f0fdf4' },
  Research: { label: 'Research',  icon: <BookOpen size={14} />,   logo: null,                                   color: '#8b5cf6', bg: '#faf5ff' },
  API:      { label: 'API',       icon: <Globe size={14} />,      logo: null,                                   color: '#6366f1', bg: '#eef2ff' },
  Email:    { label: 'Email',     icon: <Mail size={14} />,       logo: PROVIDER_CONFIG.microsoft?.logo ?? null, color: '#0078d4', bg: '#eff6ff' },
}

function getSourceBadge(sourceType: string): SourceBadgeInfo {
  return SOURCE_BADGE_MAP[sourceType] ?? {
    label: sourceType,
    icon: <FileText size={14} />,
    logo: null,
    color: '#6b7280',
    bg: '#f3f4f6',
  }
}

// ── Resolve Meeting sources into providers ───────────────────────────────────

interface ResolvedSource {
  key: string
  label: string
  count: number
  icon: React.ReactNode
  logo: string | null
  color: string
  bg: string
}

function useMeetingProviders(): ResolvedSource[] {
  const [resolved, setResolved] = useState<ResolvedSource[]>([])

  useEffect(() => {
    async function load() {
      const { data } = await supabase
        .from('knowledge_sources')
        .select('metadata')
        .eq('source_type', 'Meeting')

      if (!data) return

      const counts = new Map<string, number>()
      for (const row of data as { metadata: Record<string, unknown> | null }[]) {
        const provider = (row.metadata?.provider as string) ?? 'unknown'
        counts.set(provider, (counts.get(provider) ?? 0) + 1)
      }

      const result: ResolvedSource[] = []
      for (const [key, count] of counts) {
        const config = PROVIDER_CONFIG[key]
        if (config) {
          result.push({ key, label: config.label, count, icon: <Video size={14} />, logo: config.logo, color: config.color, bg: `${config.color}08` })
        } else if (key !== 'unknown') {
          result.push({ key, label: key.charAt(0).toUpperCase() + key.slice(1), count, icon: <Video size={14} />, logo: null, color: '#3b82f6', bg: '#eff6ff' })
        }
      }
      if (result.length === 0 && data.length > 0) {
        result.push({ key: 'meeting', label: 'Meetings', count: data.length, icon: <Video size={14} />, logo: null, color: '#3b82f6', bg: '#eff6ff' })
      }
      result.sort((a, b) => b.count - a.count)
      setResolved(result)
    }
    load()
  }, [])

  return resolved
}

// ── Row components with hover slide-in actions (matching SourceFeedItem) ─────

function HoverActionOverlay({ onExplore, onChat }: { onExplore: () => void; onChat: () => void }) {
  return (
    <>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onExplore() }}
        className="flex flex-col items-center justify-center cursor-pointer"
        style={{ width: 66, height: '100%', background: 'transparent', border: 'none', gap: 4, color: 'var(--color-text-secondary)', transition: 'color 0.15s ease, background 0.15s ease', borderRadius: 6 }}
        onMouseEnter={e => { e.currentTarget.style.color = 'var(--color-accent-500)'; e.currentTarget.style.background = 'var(--color-accent-50)' }}
        onMouseLeave={e => { e.currentTarget.style.color = 'var(--color-text-secondary)'; e.currentTarget.style.background = 'transparent' }}
      >
        <Search size={16} />
        <span className="font-body" style={{ fontSize: 9, fontWeight: 600 }}>Explore</span>
      </button>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onChat() }}
        className="flex flex-col items-center justify-center cursor-pointer"
        style={{ width: 66, height: '100%', background: 'transparent', border: 'none', gap: 4, color: 'var(--color-text-secondary)', transition: 'color 0.15s ease, background 0.15s ease', borderRadius: 6 }}
        onMouseEnter={e => { e.currentTarget.style.color = 'var(--color-accent-500)'; e.currentTarget.style.background = 'var(--color-accent-50)' }}
        onMouseLeave={e => { e.currentTarget.style.color = 'var(--color-text-secondary)'; e.currentTarget.style.background = 'transparent' }}
      >
        <MessageSquare size={16} />
        <span className="font-body" style={{ fontSize: 9, fontWeight: 600 }}>Chat</span>
      </button>
    </>
  )
}

export function InsightRow({ insight, isLast }: { insight: AgentInsightRow; isLast: boolean }) {
  const [hovered, setHovered] = useState(false)
  const navigate = useNavigate()

  const handleChat = () => {
    const context = buildInsightChatContext(insight)
    navigate('/ask', { state: { chatContext: context } })
  }

  return (
    <div
      className="relative overflow-hidden"
      style={{ borderBottom: isLast ? 'none' : '1px solid var(--border-subtle)', flex: '1 1 0' }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <button
        type="button"
        onClick={() => navigate('/council')}
        className="flex w-full text-left bg-transparent cursor-pointer border-none"
        style={{ gap: 14, padding: '14px 20px', alignItems: 'flex-start', background: hovered ? 'var(--color-bg-hover)' : 'transparent', transition: 'background 0.15s ease' }}
      >
        <div className="flex-1 min-w-0">
          <div className="font-display text-text-primary" style={{ fontSize: 13, fontWeight: 700, lineHeight: 1.4, marginBottom: 3, display: '-webkit-box', WebkitLineClamp: 1, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
            {insight.claim}
          </div>
          <div className="font-body text-text-secondary" style={{ fontSize: 12, lineHeight: 1.5, display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
            {insight.evidence_summary ?? ''}
          </div>
        </div>
      </button>
      <div
        style={{
          position: 'absolute', top: 0, right: 0, bottom: 0, width: 144,
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 2,
          transform: hovered ? 'translateX(0)' : 'translateX(144px)',
          transition: 'transform 0.2s ease',
          background: 'var(--color-bg-card)', borderLeft: '1px solid var(--border-subtle)',
        }}
      >
        <HoverActionOverlay onExplore={() => navigate('/council')} onChat={handleChat} />
      </div>
    </div>
  )
}

export function SignalRow({ signal, isLast }: { signal: AgentSignalRow & { source_name?: string; target_name?: string }; isLast: boolean }) {
  const [hovered, setHovered] = useState(false)
  const navigate = useNavigate()

  const handleChat = () => {
    const context = buildSignalChatContext(signal, signal.source_name ?? 'Unknown', signal.target_name ?? 'Unknown')
    navigate('/ask', { state: { chatContext: context } })
  }

  return (
    <div
      className="relative overflow-hidden"
      style={{ borderBottom: isLast ? 'none' : '1px solid var(--border-subtle)', flex: '1 1 0' }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <button
        type="button"
        onClick={() => navigate('/council')}
        className="flex w-full text-left bg-transparent cursor-pointer border-none"
        style={{ gap: 14, padding: '14px 20px', alignItems: 'flex-start', background: hovered ? 'var(--color-bg-hover)' : 'transparent', transition: 'background 0.15s ease' }}
      >
        <div className="shrink-0 flex items-center justify-center" style={{ width: 36, height: 36, borderRadius: '50%', border: '2px solid var(--color-accent-500)', background: 'var(--color-accent-50)' }}>
          <ArrowUpRight size={15} style={{ color: 'var(--color-accent-500)' }} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center" style={{ gap: 6, marginBottom: 3 }}>
            <span className="font-body text-text-primary" style={{ fontSize: 13, fontWeight: 700, lineHeight: 1.4 }}>
              {signal.source_name} → {signal.target_name}
            </span>
            {(signal.extracted_entity_ids?.length ?? 0) > 0 && (
              <span className="font-body" style={{ fontSize: 10, fontWeight: 600, color: '#15803d', background: '#dcfce7', padding: '1px 6px', borderRadius: 10 }}>
                {signal.extracted_entity_ids.length} extracted
              </span>
            )}
          </div>
          <div className="font-body text-text-secondary" style={{ fontSize: 12, lineHeight: 1.5, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
            {signal.reason}
          </div>
        </div>
      </button>
      <div
        style={{
          position: 'absolute', top: 0, right: 0, bottom: 0, width: 144,
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 2,
          transform: hovered ? 'translateX(0)' : 'translateX(144px)',
          transition: 'transform 0.2s ease',
          background: 'var(--color-bg-card)', borderLeft: '1px solid var(--border-subtle)',
        }}
      >
        <HoverActionOverlay onExplore={() => navigate('/council')} onChat={handleChat} />
      </div>
    </div>
  )
}

export interface TopSkill {
  id: string
  name: string
  title: string
  description: string
  source_count: number
  agent_name: string | null
}

export function SkillRow({ skill, isLast }: { skill: TopSkill; isLast: boolean }) {
  const [hovered, setHovered] = useState(false)
  const navigate = useNavigate()

  const handleChat = () => {
    const context = buildSkillChatContext(skill)
    navigate('/ask', { state: { chatContext: context } })
  }

  return (
    <div
      className="relative overflow-hidden"
      style={{ borderBottom: isLast ? 'none' : '1px solid var(--border-subtle)', flex: '1 1 0' }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <button
        type="button"
        onClick={() => navigate('/explore')}
        className="flex w-full text-left bg-transparent cursor-pointer border-none"
        style={{ gap: 14, padding: '14px 20px', alignItems: 'flex-start', background: hovered ? 'var(--color-bg-hover)' : 'transparent', transition: 'background 0.15s ease' }}
      >
        <div className="shrink-0 flex items-center justify-center" style={{ width: 36, height: 36, borderRadius: 9, background: '#f0fdf4' }}>
          <Anchor size={15} style={{ color: '#15803d' }} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center" style={{ gap: 8, marginBottom: 3 }}>
            <span className="font-display text-text-primary truncate" style={{ fontSize: 13, fontWeight: 700 }}>
              {skill.title || skill.name}
            </span>
            {skill.agent_name && (
              <span className="font-body shrink-0" style={{ fontSize: 10, color: 'var(--color-text-placeholder)' }}>
                {skill.agent_name}
              </span>
            )}
            <span className="font-body shrink-0" style={{ fontSize: 10, color: 'var(--color-text-placeholder)' }}>
              {skill.source_count} sources
            </span>
          </div>
          <div className="font-body text-text-secondary" style={{ fontSize: 12, lineHeight: 1.5, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
            {skill.description}
          </div>
        </div>
      </button>
      <div
        style={{
          position: 'absolute', top: 0, right: 0, bottom: 0, width: 144,
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 2,
          transform: hovered ? 'translateX(0)' : 'translateX(144px)',
          transition: 'transform 0.2s ease',
          background: 'var(--color-bg-card)', borderLeft: '1px solid var(--border-subtle)',
        }}
      >
        <HoverActionOverlay onExplore={() => navigate('/explore')} onChat={handleChat} />
      </div>
    </div>
  )
}

// ── Home Council Card — Agent-centric view ──────────────────────────────────

const HEALTH_BADGE: Record<string, { bg: string; text: string; label: string }> = {
  strong:       { bg: '#dcfce7', text: '#15803d', label: 'Strong' },
  growing:      { bg: '#d1fae5', text: '#047857', label: 'Growing' },
  thin:         { bg: '#fef3c7', text: '#b45309', label: 'Thin' },
  stale:        { bg: '#fee2e2', text: '#dc2626', label: 'Stale' },
  initialising: { bg: '#f3f4f6', text: '#6b7280', label: 'Init' },
}

interface AgentSummary {
  id: string
  name: string
  description: string | null
  health_status: string
  source_count: number
  entity_count: number
  insights: number
  signalsOut: number
}

function AgentRow({ agent, isLast }: { agent: AgentSummary; isLast: boolean }) {
  const [hovered, setHovered] = useState(false)
  const navigate = useNavigate()
  const health = HEALTH_BADGE[agent.health_status] ?? HEALTH_BADGE.initialising!

  const handleChat = () => {
    const context: import('../../types/chatRouting').ChatEntryContext = {
      autoQuery: `As my "${agent.name}" advisor, give me a briefing. What are the most important insights, open questions, and cross-domain connections in your domain right now?`,
      systemDirective: `The user wants a briefing from their "${agent.name}" domain advisor. This advisor covers: ${agent.description ?? 'their domain'}. It has ${agent.source_count} sources and ${agent.entity_count} entities. Provide a concise but substantive briefing covering: (1) the most important recent insights or patterns, (2) any open questions or gaps, (3) notable cross-domain connections to other advisors. Speak as this advisor — use "I" and reflect its reasoning style.`,
      queryConfig: { mindset: 'analytical', toolMode: 'deep' },
      entryPoint: 'council_insight_chat',
      displayLabel: `Advisor: ${agent.name}`,
    }
    navigate('/ask', { state: { chatContext: context } })
  }

  return (
    <div
      className="relative overflow-hidden"
      style={{ borderBottom: isLast ? 'none' : '1px solid var(--border-subtle)', flex: '1 1 0' }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <button
        type="button"
        onClick={() => navigate('/council')}
        className="flex w-full text-left bg-transparent cursor-pointer border-none"
        style={{ gap: 14, padding: '14px 20px', alignItems: 'flex-start', background: hovered ? 'var(--color-bg-hover)' : 'transparent', transition: 'background 0.15s ease' }}
      >
        <div className="shrink-0 flex items-center justify-center" style={{ width: 36, height: 36, borderRadius: 9, background: 'var(--color-accent-50)' }}>
          <Users size={15} style={{ color: 'var(--color-accent-500)' }} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center" style={{ gap: 8, marginBottom: 3 }}>
            <span className="font-display text-text-primary truncate" style={{ fontSize: 13, fontWeight: 700 }}>
              {agent.name}
            </span>
            <span
              className="font-body shrink-0"
              style={{ fontSize: 9, fontWeight: 600, padding: '1px 7px', borderRadius: 20, background: health.bg, color: health.text }}
            >
              {health.label}
            </span>
          </div>
          <div className="font-body text-text-secondary" style={{ fontSize: 12, lineHeight: 1.5, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
            {agent.description ?? ''}
          </div>
          <div className="flex items-center" style={{ gap: 10, marginTop: 4 }}>
            <span className="font-body" style={{ fontSize: 10, color: 'var(--color-text-placeholder)' }}>
              {agent.source_count} sources
            </span>
            {agent.insights > 0 && (
              <span className="font-body" style={{ fontSize: 10, color: '#b45309' }}>
                {agent.insights} insights
              </span>
            )}
            {agent.signalsOut > 0 && (
              <span className="font-body" style={{ fontSize: 10, color: 'var(--color-accent-500)' }}>
                {agent.signalsOut} signals
              </span>
            )}
          </div>
        </div>
      </button>
      <div
        style={{
          position: 'absolute', top: 0, right: 0, bottom: 0, width: 144,
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 2,
          transform: hovered ? 'translateX(0)' : 'translateX(144px)',
          transition: 'transform 0.2s ease',
          background: 'var(--color-bg-card)', borderLeft: '1px solid var(--border-subtle)',
        }}
      >
        <HoverActionOverlay onExplore={() => navigate('/council')} onChat={handleChat} />
      </div>
    </div>
  )
}

function HomeInsightsCard() {
  const navigate = useNavigate()
  const [agents, setAgents] = useState<AgentSummary[]>([])
  const [dataLoading, setDataLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const rawAgents = await fetchDomainAgents()
        if (cancelled) return

        // Fetch counts for top agents (limit to 5 by source_count — already sorted from fetchDomainAgents)
        const top = rawAgents.slice(0, 5)
        const counts = await Promise.all(top.map(a => fetchAgentCounts(a.id)))
        if (cancelled) return

        setAgents(top.map((a, i) => ({
          id: a.id,
          name: a.name,
          description: a.description,
          health_status: a.health_status,
          source_count: a.source_count,
          entity_count: a.entity_count,
          insights: counts[i]!.insights,
          signalsOut: counts[i]!.signalsOut,
        })))
      } catch { /* ignore */ }
      finally { if (!cancelled) setDataLoading(false) }
    }
    load()
    return () => { cancelled = true }
  }, [])

  return (
    <div className="bg-bg-card border border-border-subtle overflow-hidden flex flex-col flex-1" style={{ borderRadius: 12, minHeight: 0 }}>
      {/* Header */}
      <div
        className="flex items-center justify-between shrink-0"
        style={{ padding: '12px 20px' }}
      >
        <div className="flex items-center" style={{ gap: 10 }}>
          <div
            className="shrink-0 flex items-center justify-center"
            style={{ width: 28, height: 28, borderRadius: 8, background: 'var(--color-accent-50)' }}
          >
            <Users size={14} style={{ color: 'var(--color-accent-500)' }} />
          </div>
          <span className="font-display text-text-primary" style={{ fontSize: 13, fontWeight: 700, letterSpacing: '-0.01em' }}>
            Council
          </span>
        </div>

        <button
          type="button"
          onClick={() => navigate('/council')}
          className="font-body cursor-pointer bg-transparent border-none"
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: 'var(--color-accent-500)',
            padding: '4px 12px',
            borderRadius: 6,
            border: '1px solid rgba(214,58,0,0.15)',
            background: 'var(--color-accent-50)',
          }}
        >
          View all →
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {dataLoading ? (
          <div className="flex flex-col flex-1">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="flex items-center" style={{ flex: '1 1 0', gap: 14, padding: '14px 20px', borderBottom: i < 4 ? '1px solid var(--border-subtle)' : 'none' }}>
                <div className="bg-bg-inset animate-pulse" style={{ width: 36, height: 36, borderRadius: 9 }} />
                <div className="flex-1">
                  <div className="bg-bg-inset animate-pulse" style={{ height: 13, borderRadius: 4, marginBottom: 6 }} />
                  <div className="bg-bg-inset animate-pulse" style={{ height: 11, borderRadius: 4, width: '70%' }} />
                </div>
              </div>
            ))}
          </div>
        ) : agents.length === 0 ? (
          <div className="flex-1 flex items-center justify-center" style={{ padding: '24px 20px', textAlign: 'center' }}>
            <p className="font-body text-text-secondary" style={{ fontSize: 13 }}>
              No advisors yet. Connect YouTube playlists to build your council.
            </p>
          </div>
        ) : (
          <div className="flex flex-col flex-1">
            {agents.map((agent, i) => (
              <AgentRow key={agent.id} agent={agent} isLast={i === agents.length - 1} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Main component ───────────────────────────────────────────────────────────

export function HomeView() {
  const { user } = useAuth()
  useGraphContext() // maintain context subscription
  const dashboard = useHomeDashboard()
  const meetingProviders = useMeetingProviders()

  // No resizable layout — fixed columns on dashboard

  const navigate = useNavigate()

  // Click handlers — sources navigate to /sources page
  const handleSourceClick = (source: KnowledgeSource) => {
    navigate(`/sources?sourceId=${source.id}`)
  }
  const handleExploreSource = (source: KnowledgeSource) => {
    navigate(`/sources?sourceId=${source.id}`)
  }
  const handleGraphSource = (source: KnowledgeSource) => {
    navigate(`/explore?viewMode=sources&sourceId=${source.id}`)
  }
  const handleChatWithSource = (source: KnowledgeSource) => {
    const context = buildSourceChatContext({ id: source.id, title: source.title, summary: source.summary })
    navigate('/ask', { state: { chatContext: context } })
  }


  const firstName = user?.user_metadata?.full_name?.split(' ')[0] ?? user?.email?.split('@')[0] ?? ''
  const stats = dashboard.stats
  const pipeline = dashboard.pipelineStatus
  const snapshot = dashboard.snapshot

  // Source badges (exclude Meeting — replaced by providers)
  const activeSourceTypes = (snapshot?.sourceTypeCounts ?? []).filter(s => s.count > 0 && s.source_type !== 'Meeting')

  return (
    <div className="flex flex-col h-full" style={{ background: 'var(--color-bg-content)' }}>
      {/* ══════ PAGE CONTENT — fills viewport ══════ */}
      <div className="flex-1 flex flex-col overflow-hidden">

        {/* ── HERO CARD ── */}
        <div className="shrink-0" style={{ padding: '20px 36px 0 36px' }}>
          <div
            className="bg-bg-card border border-border-subtle animate-[fadeUp_0.4s_ease]"
            style={{ borderRadius: 14, animationFillMode: 'both' }}
          >
            {/* Row 1: Greeting + Stats */}
            <div className="flex items-center justify-between" style={{ padding: '20px 28px', gap: 24 }}>
              <div className="shrink-0">
                <p className="font-body text-text-secondary" style={{ fontSize: 12, marginBottom: 2 }}>{getGreeting()}</p>
                <h1 className="font-display text-text-primary" style={{ fontSize: 22, fontWeight: 800, letterSpacing: '-0.03em', lineHeight: 1.15 }}>
                  {firstName ? `${firstName}.` : 'Welcome.'}
                </h1>
              </div>

              {stats && !dashboard.loading.stats ? (
                <div className="flex items-center" style={{ gap: 6 }}>
                  {[
                    { icon: <Database size={12} style={{ color: 'var(--color-text-secondary)' }} />, value: stats.totalSources, label: 'Sources' },
                    { icon: <GitBranch size={12} style={{ color: 'var(--color-text-secondary)' }} />, value: stats.totalNodes, label: 'Nodes' },
                    { icon: <Anchor size={12} style={{ color: 'var(--color-text-secondary)' }} />, value: stats.activeAnchors, label: 'Anchors' },
                    { icon: <Zap size={12} style={{ color: 'var(--color-text-secondary)' }} />, value: stats.activeSkills, label: 'Skills' },
                  ].map((stat, i) => (
                    <div key={stat.label} className="flex items-center">
                      {i > 0 && <div style={{ width: 1, height: 22, background: 'var(--border-subtle)', margin: '0 10px' }} />}
                      <div className="flex items-center" style={{ gap: 7 }}>
                        <div className="shrink-0 flex items-center justify-center" style={{ width: 26, height: 26, borderRadius: 6, background: 'var(--color-bg-inset)' }}>
                          {stat.icon}
                        </div>
                        <div>
                          <div className="font-display text-text-primary" style={{ fontSize: 16, fontWeight: 800, letterSpacing: '-0.02em', lineHeight: 1 }}>
                            {stat.value.toLocaleString()}
                          </div>
                          <div className="font-body text-text-secondary" style={{ fontSize: 10 }}>{stat.label}</div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>

            {/* Row 2: Source badges (left) + Status (right) — single row */}
            {(activeSourceTypes.length > 0 || meetingProviders.length > 0 || pipeline) && (
              <div
                className="flex items-center justify-between"
                style={{ padding: '12px 28px', borderTop: '1px solid var(--border-subtle)' }}
              >
                {/* Left: Ingested from badges */}
                <div className="flex items-center flex-wrap" style={{ gap: 8 }}>
                  <span className="font-body text-text-secondary shrink-0" style={{ fontSize: 11, fontWeight: 500, marginRight: 2 }}>
                    Ingested from
                  </span>
                  {activeSourceTypes.map(({ source_type, count }) => {
                    const badge = getSourceBadge(source_type)
                    return (
                      <div key={source_type} className="flex items-center" style={{ gap: 5, padding: '4px 10px', borderRadius: 16, background: badge.bg, border: `1px solid ${badge.color}20` }}>
                        {badge.logo ? (
                          <img src={badge.logo} alt={badge.label} style={{ width: 13, height: 13, borderRadius: 2, objectFit: 'contain' }} />
                        ) : (
                          <span style={{ color: badge.color, display: 'flex' }}>{badge.icon}</span>
                        )}
                        <span className="font-body" style={{ fontSize: 11, fontWeight: 600, color: badge.color }}>{badge.label}</span>
                        <span className="font-body" style={{ fontSize: 10, fontWeight: 500, color: `${badge.color}99` }}>{count}</span>
                      </div>
                    )
                  })}
                  {meetingProviders.map((p) => (
                    <div key={p.key} className="flex items-center" style={{ gap: 5, padding: '4px 10px', borderRadius: 16, background: p.bg, border: `1px solid ${p.color}20` }}>
                      {p.logo ? (
                        <img src={p.logo} alt={p.label} style={{ width: 13, height: 13, borderRadius: 2, objectFit: 'contain' }} />
                      ) : (
                        <span style={{ color: p.color, display: 'flex' }}>{p.icon}</span>
                      )}
                      <span className="font-body" style={{ fontSize: 11, fontWeight: 600, color: p.color }}>{p.label}</span>
                      <span className="font-body" style={{ fontSize: 10, fontWeight: 500, color: `${p.color}99` }}>{p.count}</span>
                    </div>
                  ))}
                </div>

                {/* Right: Last ingested */}
                {pipeline?.lastProcessedSource && (
                  <div className="flex items-center shrink-0 font-body text-text-secondary" style={{ fontSize: 11, gap: 6 }}>
                    <span style={{ fontWeight: 500 }}>Last ingested</span>
                    <span style={{ fontWeight: 600, color: 'var(--color-text-body)' }}>
                      {pipeline.lastProcessedSource.title}
                    </span>
                    <span>·</span>
                    <span>{formatRelativeTime(pipeline.lastProcessedSource.created_at)}</span>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* ══════ TWO-COLUMN LAYOUT — fills remaining viewport height ══════ */}
        <div className="flex items-stretch flex-1 min-h-0" style={{ padding: '20px 36px 36px 36px', gap: 20 }}>
          {/* Left column: Recent Sources — fills available height */}
          <div className="animate-[fadeUp_0.4s_ease] flex flex-col min-h-0" style={{ flex: '0 0 60%', animationDelay: '0.05s', animationFillMode: 'both' }}>
            <RecentSourcesPanel
              sources={dashboard.recentSources}
              entityCounts={dashboard.sourceEntityCounts}
              loading={dashboard.loading.sources}
              error={dashboard.errors.sources}
              onSourceClick={handleSourceClick}
              onExploreSource={handleExploreSource}
              onChatWithSource={handleChatWithSource}
              onGraphSource={handleGraphSource}
              stretch
            />
          </div>

          {/* Right column: Insights / Signals / Skills toggle card */}
          <div className="flex-1 flex flex-col min-h-0 animate-[fadeUp_0.4s_ease]" style={{ minWidth: 0, animationDelay: '0.05s', animationFillMode: 'both' }}>
            <HomeInsightsCard />
          </div>
        </div>
      </div>
    </div>
  )
}
