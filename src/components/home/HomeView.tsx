import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { Database, GitBranch, Anchor, Zap, Youtube, FileText, BookOpen, StickyNote, Video, Globe, Mail, MessageSquare } from 'lucide-react'
import { useGraphContext } from '../../hooks/useGraphContext'
import { useHomeDashboard } from '../../hooks/useHomeDashboard'
import { useAuth } from '../../hooks/useAuth'
import { PROVIDER_CONFIG } from '../../config/sourceTypes'
import { supabase } from '../../services/supabase'
import { RecentSourcesPanel } from './RecentSourcesPanel'
import { SignalsToggleCard } from './SignalsToggleCard'
import { OrientSummaryPanel } from './OrientSummaryPanel'
import { buildSourceChatContext } from '../../config/chatEntryContexts'
import type { KnowledgeNode, KnowledgeSkill, KnowledgeSource } from '../../types/database'

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

// ── Main component ───────────────────────────────────────────────────────────

export function HomeView() {
  const { user } = useAuth()
  const { setRightPanelContent } = useGraphContext()
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
  const handleChatWithSource = (source: KnowledgeSource) => {
    const context = buildSourceChatContext({ id: source.id, title: source.title, summary: source.summary })
    navigate('/ask', { state: { chatContext: context } })
  }
  const handleAnchorClick = (node: KnowledgeNode) => { setRightPanelContent({ type: 'node', data: node }) }
  const handleSkillClick = (_skill: KnowledgeSkill) => { navigate('/signals?mode=skills') }

  const firstName = user?.user_metadata?.full_name?.split(' ')[0] ?? user?.email?.split('@')[0] ?? ''
  const stats = dashboard.stats
  const pipeline = dashboard.pipelineStatus
  const snapshot = dashboard.snapshot

  // Source badges (exclude Meeting — replaced by providers)
  const activeSourceTypes = (snapshot?.sourceTypeCounts ?? []).filter(s => s.count > 0 && s.source_type !== 'Meeting')

  return (
    <div className="flex flex-col h-full" style={{ background: 'var(--color-bg-content)' }}>
      {/* ══════ SCROLLABLE PAGE — no control bar ══════ */}
      <div className="flex-1 overflow-y-auto">

        {/* ── HERO CARD ── */}
        <div style={{ padding: '20px 36px 0 36px' }}>
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

        {/* ══════ FIXED TWO-COLUMN LAYOUT — stretch to match heights ══════ */}
        <div className="flex items-stretch" style={{ padding: '20px 36px 36px 36px', gap: 20 }}>
          {/* Left column: Recent Sources — stretches to match right column height */}
          <div className="animate-[fadeUp_0.4s_ease] flex flex-col" style={{ flex: '0 0 60%', animationDelay: '0.05s', animationFillMode: 'both' }}>
            <RecentSourcesPanel
              sources={dashboard.recentSources}
              entityCounts={dashboard.sourceEntityCounts}
              loading={dashboard.loading.sources}
              error={dashboard.errors.sources}
              onSourceClick={handleSourceClick}
              onExploreSource={handleExploreSource}
              onChatWithSource={handleChatWithSource}
              stretch
            />
          </div>

          {/* Right column: Quick Ask → Orient → Signals */}
          <div className="flex-1 flex flex-col" style={{ gap: 12, minWidth: 0 }}>
            {/* Want to chat? */}
            <div className="animate-[fadeUp_0.4s_ease]" style={{ animationDelay: '0.05s', animationFillMode: 'both' }}>
              <button
                type="button"
                onClick={() => navigate('/ask')}
                className="flex items-center w-full bg-bg-card border border-border-subtle cursor-pointer hover:bg-bg-hover transition-all duration-150"
                style={{ borderRadius: 12, padding: '12px 18px', gap: 10 }}
              >
                <div
                  className="shrink-0 flex items-center justify-center"
                  style={{ width: 28, height: 28, borderRadius: 8, background: 'var(--color-accent-50)' }}
                >
                  <MessageSquare size={13} style={{ color: 'var(--color-accent-500)' }} />
                </div>
                <div className="flex-1 text-left">
                  <span className="font-body text-text-primary" style={{ fontSize: 13, fontWeight: 600 }}>
                    Want to chat?
                  </span>
                  <span className="font-body text-text-secondary" style={{ fontSize: 12, marginLeft: 6 }}>
                    Ask your knowledge base anything →
                  </span>
                </div>
              </button>
            </div>

            {/* Orient summary */}
            <div className="animate-[fadeUp_0.4s_ease]" style={{ animationDelay: '0.1s', animationFillMode: 'both' }}>
              <OrientSummaryPanel />
            </div>

            {/* Signals */}
            <div className="animate-[fadeUp_0.4s_ease]" style={{ animationDelay: '0.15s', animationFillMode: 'both' }}>
              <SignalsToggleCard
                anchors={dashboard.recentAnchors}
                anchorConnectionCounts={dashboard.anchorConnectionCounts}
                skills={dashboard.recentSkills}
                loading={dashboard.loading.signals}
                error={dashboard.errors.signals}
                onAnchorClick={handleAnchorClick}
                onSkillClick={handleSkillClick}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
