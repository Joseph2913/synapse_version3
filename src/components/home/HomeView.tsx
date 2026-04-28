import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { Database, GitBranch, Anchor, Zap, Youtube, FileText, BookOpen, StickyNote, Video, Globe, Mail, Search, MessageSquare } from 'lucide-react'
import { useGraphContext } from '../../hooks/useGraphContext'
import { useHomeDashboard } from '../../hooks/useHomeDashboard'
import { useAuth } from '../../hooks/useAuth'
import { PROVIDER_CONFIG } from '../../config/sourceTypes'
import { supabase } from '../../services/supabase'
import { RecentSourcesPanel } from './RecentSourcesPanel'
import { CouncilDigestCard } from './CouncilDigestCard'
import { HomeSignalsCard } from './HomeSignalsCard'
import { buildSourceChatContext, buildInsightChatContext, buildSkillChatContext } from '../../config/chatEntryContexts'
import type { KnowledgeSource, AgentInsightRow } from '../../types/database'

// Fixed layout — no resizing on dashboard

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
  youtube:  { label: 'YouTube',   icon: <Youtube size={14} />,    logo: PROVIDER_CONFIG.youtube?.logo ?? null,  color: '#ef4444', bg: '#fef2f2' },
  file:     { label: 'Documents', icon: <FileText size={14} />,   logo: null,                                   color: '#d97706', bg: '#fffbeb' },
  paste:    { label: 'Notes',     icon: <StickyNote size={14} />, logo: null,                                   color: '#10b981', bg: '#f0fdf4' },
  url:      { label: 'Web',       icon: <Globe size={14} />,      logo: null,                                   color: '#0ea5e9', bg: '#eff6ff' },
  research: { label: 'Research',  icon: <BookOpen size={14} />,   logo: null,                                   color: '#8b5cf6', bg: '#faf5ff' },
  github:   { label: 'GitHub',    icon: <FileText size={14} />,   logo: PROVIDER_CONFIG.github?.logo ?? null,   color: '#24292f', bg: '#f6f8fa' },
  api:      { label: 'API',       icon: <Globe size={14} />,      logo: null,                                   color: '#6366f1', bg: '#eef2ff' },
  email:    { label: 'Email',     icon: <Mail size={14} />,       logo: PROVIDER_CONFIG.microsoft?.logo ?? null, color: '#0078d4', bg: '#eff6ff' },
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
        .eq('source_type', 'meeting')

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
  const snapshot = dashboard.snapshot

  // Source badges (exclude Meeting — replaced by providers)
  const activeSourceTypes = (snapshot?.sourceTypeCounts ?? []).filter(s => s.count > 0 && s.source_type !== 'meeting')

  return (
    <div className="flex flex-col h-full" style={{ background: 'var(--color-bg-content)' }}>
      {/* ══════ PAGE CONTENT — fills viewport ══════ */}
      <div className="flex-1 flex flex-col overflow-hidden">

        {/* ── HERO CARD ── */}
        <div className="shrink-0" style={{ padding: '20px 36px 0 36px' }}>
          <div
            className="bg-bg-card border border-border-subtle animate-[fadeUp_0.4s_var(--ease-out-expo)]"
            style={{ borderRadius: 14, animationFillMode: 'both', boxShadow: 'var(--shadow-md)' }}
          >
            {/* Single row: Greeting + Source badges + Stats */}
            <div className="flex items-center justify-between" style={{ padding: '18px 24px', gap: 20 }}>
              <div className="shrink-0">
                <p className="font-body text-text-secondary" style={{ fontSize: 11, marginBottom: 2 }}>{getGreeting()}</p>
                <h1 className="font-display text-text-primary" style={{ fontSize: 22, fontWeight: 800, letterSpacing: '-0.035em', lineHeight: 1.1 }}>
                  {firstName ? `${firstName}.` : 'Welcome.'}
                </h1>
              </div>

              {/* Source badges — compact, inline */}
              {(activeSourceTypes.length > 0 || meetingProviders.length > 0) && (
                <div className="flex items-center flex-wrap min-w-0" style={{ gap: 6, flex: '1 1 auto', justifyContent: 'center' }}>
                  {activeSourceTypes.map(({ source_type, count }) => {
                    const badge = getSourceBadge(source_type)
                    return (
                      <div key={source_type} className="flex items-center shrink-0" style={{ gap: 4, padding: '3px 8px', borderRadius: 20, background: badge.bg, border: `1px solid ${badge.color}20` }}>
                        {badge.logo ? (
                          <img src={badge.logo} alt={badge.label} style={{ width: 11, height: 11, borderRadius: 2, objectFit: 'contain' }} />
                        ) : (
                          <span style={{ color: badge.color, display: 'flex' }}>{badge.icon}</span>
                        )}
                        <span className="font-body" style={{ fontSize: 10, fontWeight: 600, color: badge.color }}>{badge.label}</span>
                        <span className="font-body" style={{ fontSize: 10, fontWeight: 500, color: `${badge.color}99`, fontVariantNumeric: 'tabular-nums' }}>{count}</span>
                      </div>
                    )
                  })}
                  {meetingProviders.map((p) => (
                    <div key={p.key} className="flex items-center shrink-0" style={{ gap: 4, padding: '3px 8px', borderRadius: 20, background: p.bg, border: `1px solid ${p.color}20` }}>
                      {p.logo ? (
                        <img src={p.logo} alt={p.label} style={{ width: 11, height: 11, borderRadius: 2, objectFit: 'contain' }} />
                      ) : (
                        <span style={{ color: p.color, display: 'flex' }}>{p.icon}</span>
                      )}
                      <span className="font-body" style={{ fontSize: 10, fontWeight: 600, color: p.color }}>{p.label}</span>
                      <span className="font-body" style={{ fontSize: 10, fontWeight: 500, color: `${p.color}99`, fontVariantNumeric: 'tabular-nums' }}>{p.count}</span>
                    </div>
                  ))}
                </div>
              )}

              {stats && !dashboard.loading.stats ? (
                <div className="flex items-center shrink-0" style={{ gap: 6 }}>
                  {[
                    { icon: <Database size={12} style={{ color: 'var(--color-accent-500)' }} />, value: stats.totalSources, label: 'Sources' },
                    { icon: <GitBranch size={12} style={{ color: 'var(--color-accent-500)' }} />, value: stats.totalNodes, label: 'Nodes' },
                    { icon: <Anchor size={12} style={{ color: 'var(--color-accent-500)' }} />, value: stats.activeAnchors, label: 'Anchors' },
                    { icon: <Zap size={12} style={{ color: 'var(--color-accent-500)' }} />, value: stats.activeSkills, label: 'Skills' },
                  ].map((stat, i) => (
                    <div key={stat.label} className="flex items-center">
                      {i > 0 && <div style={{ width: 1, height: 22, background: 'var(--border-subtle)', margin: '0 10px' }} />}
                      <div className="flex items-center" style={{ gap: 7 }}>
                        <div className="shrink-0 flex items-center justify-center" style={{ width: 24, height: 24, borderRadius: 6, background: 'var(--color-accent-50)' }}>
                          {stat.icon}
                        </div>
                        <div>
                          <div className="font-display text-text-primary" style={{ fontSize: 15, fontWeight: 800, letterSpacing: '-0.02em', lineHeight: 1, fontVariantNumeric: 'tabular-nums' }}>
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
          </div>
        </div>

        {/* ── COUNCIL DIGEST — full-width weekly brief ── */}
        <div
          className="shrink-0 animate-[fadeUp_0.4s_ease]"
          style={{ padding: '20px 36px 0 36px', animationDelay: '0.08s', animationFillMode: 'both' }}
        >
          <CouncilDigestCard />
        </div>

        {/* ══════ TWO-COLUMN LAYOUT — fills remaining viewport height ══════ */}
        <div className="flex items-stretch flex-1 min-h-0" style={{ padding: '20px 36px 36px 36px', gap: 20 }}>
          {/* Left column: Recent Sources — fills available height */}
          <div className="animate-[fadeUp_0.4s_ease] flex flex-col min-h-0" style={{ flex: '0 0 50%', animationDelay: '0.05s', animationFillMode: 'both' }}>
            <RecentSourcesPanel
              sources={dashboard.recentSources}
              entityCounts={dashboard.sourceEntityCounts}
              crossConnectionCounts={dashboard.sourceCrossConnectionCounts}
              relatedSourceCounts={dashboard.sourceRelatedSourceCounts}
              loading={dashboard.loading.sources}
              error={dashboard.errors.sources}
              onSourceClick={handleSourceClick}
              onExploreSource={handleExploreSource}
              onChatWithSource={handleChatWithSource}
              onGraphSource={handleGraphSource}
              stretch
            />
          </div>

          {/* Right column: Signals — split pane (Anchors + Skills) */}
          <div className="flex-1 flex flex-col min-h-0 animate-[fadeUp_0.4s_ease]" style={{ minWidth: 0, animationDelay: '0.05s', animationFillMode: 'both' }}>
            <HomeSignalsCard />
          </div>
        </div>
      </div>
    </div>
  )
}
