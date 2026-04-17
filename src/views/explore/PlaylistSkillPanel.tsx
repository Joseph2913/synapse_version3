import { useState, useEffect } from 'react'
import { X, FileText, Sparkles, BarChart3, ChevronDown, ChevronRight } from 'lucide-react'
import { SourceIcon } from '../../components/shared/SourceIcon'
import { supabase } from '../../services/supabase'
import { useAuth } from '../../hooks/useAuth'
import type { PlaylistGraphSkill } from '../../types/explore'

interface PlaylistSkillPanelProps {
  skill: PlaylistGraphSkill
  onClose: () => void
}

const DOMAIN_COLORS: Record<string, string> = {
  'ai-tooling':              '#3b82f6',
  'ai-prompting':            '#8b5cf6',
  'consulting-methodology':  '#d63a00',
  'change-management':       '#059669',
  'financial-analysis':      '#d97706',
  'risk-management':         '#ef4444',
  'sales-methodology':       '#ec4899',
  'project-management':      '#0891b2',
  'product-design':          '#6366f1',
  'general':                 '#6b7280',
}

function getDomainColor(domain: string | null): string {
  if (!domain) return '#6b7280'
  return DOMAIN_COLORS[domain] ?? '#6b7280'
}

interface ContentSection {
  heading: string
  body: string
}

function parseContentSections(content: string): ContentSection[] {
  const sections: ContentSection[] = []
  const lines = content.split('\n')
  let currentHeading = ''
  let currentBody: string[] = []

  for (const line of lines) {
    const h2Match = line.match(/^## (.+)/)
    const h3Match = !h2Match ? line.match(/^### (.+)/) : null
    const heading = h2Match?.[1]?.trim() ?? h3Match?.[1]?.trim() ?? null

    if (heading) {
      if (currentHeading || currentBody.length > 0) {
        const body = currentBody.join('\n').trim()
        if (body.length > 0) {
          sections.push({ heading: currentHeading || 'Overview', body })
        }
      }
      currentHeading = heading
      currentBody = []
    } else {
      currentBody.push(line)
    }
  }

  if (currentHeading || currentBody.length > 0) {
    const body = currentBody.join('\n').trim()
    if (body.length > 0) {
      sections.push({ heading: currentHeading || 'Overview', body })
    }
  }

  return sections
}

interface SkillSource {
  id: string
  title: string
  sourceType: string
}

export function PlaylistSkillPanel({ skill, onClose }: PlaylistSkillPanelProps) {
  const { user } = useAuth()
  const [content, setContent] = useState<string | null>(null)
  const [sources, setSources] = useState<SkillSource[]>([])
  const [loading, setLoading] = useState(true)
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set(['Overview']))

  const domainColor = getDomainColor(skill.domain)

  // Fetch full skill content + sources
  useEffect(() => {
    if (!user) return
    let cancelled = false
    setLoading(true)

    const fetchDetail = async () => {
      // Get full content
      const { data: skillData } = await supabase
        .from('knowledge_skills')
        .select('content')
        .eq('id', skill.id)
        .maybeSingle()

      if (cancelled) return
      setContent((skillData as { content: string } | null)?.content ?? null)

      // Get source details
      if (skill.sourceIds.length > 0) {
        const { data: sourceData } = await supabase
          .from('knowledge_sources')
          .select('id, title, source_type')
          .in('id', skill.sourceIds)

        if (cancelled) return
        setSources((sourceData ?? []).map((s: Record<string, unknown>) => ({
          id: s.id as string,
          title: s.title as string,
          sourceType: s.source_type as string,
        })))
      }

      setLoading(false)
    }

    fetchDetail()
    return () => { cancelled = true }
  }, [skill.id, user])

  const sections = content ? parseContentSections(content) : []

  const toggleSection = (heading: string) => {
    setExpandedSections(prev => {
      const next = new Set(prev)
      if (next.has(heading)) next.delete(heading)
      else next.add(heading)
      return next
    })
  }

  return (
    <div
      onWheel={e => e.stopPropagation()}
      style={{
        position: 'absolute',
        top: 0,
        right: 0,
        width: 320,
        height: '100%',
        background: 'var(--color-bg-card)',
        borderLeft: '1px solid var(--border-subtle)',
        zIndex: 40,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      {/* Header */}
      <div style={{ padding: '16px 16px 12px', borderBottom: '1px solid var(--border-subtle)' }}>
        <div className="flex items-center justify-between" style={{ marginBottom: 8 }}>
          {skill.domain && (
            <span
              className="font-body"
              style={{
                fontSize: 10,
                fontWeight: 600,
                color: domainColor,
                padding: '2px 8px',
                borderRadius: 10,
                background: `${domainColor}12`,
                border: `1px solid ${domainColor}25`,
                textTransform: 'uppercase',
                letterSpacing: '0.04em',
              }}
            >
              {skill.domain}
            </span>
          )}
          <button
            type="button"
            onClick={onClose}
            className="flex items-center justify-center cursor-pointer"
            style={{ width: 24, height: 24, borderRadius: 6, background: 'none', border: 'none', color: 'var(--color-text-secondary)' }}
          >
            <X size={14} />
          </button>
        </div>
        <h3 className="font-display" style={{ fontSize: 15, fontWeight: 700, color: 'var(--color-text-primary)', margin: 0 }}>
          {skill.title}
        </h3>
        <p className="font-body" style={{ fontSize: 12, color: 'var(--color-text-secondary)', margin: '6px 0 0', lineHeight: 1.5 }}>
          {skill.description}
        </p>
      </div>

      {/* Stats row */}
      <div className="flex items-center gap-4" style={{ padding: '10px 16px', borderBottom: '1px solid var(--border-subtle)' }}>
        <div className="flex items-center gap-1.5">
          <FileText size={12} style={{ color: 'var(--color-text-placeholder)' }} />
          <span className="font-body" style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>
            <strong style={{ color: 'var(--color-text-primary)', fontWeight: 600 }}>{skill.sourceCount}</strong> sources
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <Sparkles size={12} style={{ color: 'var(--color-text-placeholder)' }} />
          <span className="font-body" style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>
            <strong style={{ color: 'var(--color-text-primary)', fontWeight: 600 }}>{skill.usageCount}</strong> uses
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <BarChart3 size={12} style={{ color: 'var(--color-text-placeholder)' }} />
          <span className="font-body" style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>
            <strong style={{ color: 'var(--color-text-primary)', fontWeight: 600 }}>{Math.round(skill.confidence * 100)}%</strong>
          </span>
        </div>
      </div>

      {/* Tags */}
      {skill.tags.length > 0 && (
        <div style={{ padding: '8px 16px', borderBottom: '1px solid var(--border-subtle)', display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {skill.tags.slice(0, 8).map(tag => (
            <span
              key={tag}
              className="font-body"
              style={{
                fontSize: 10,
                color: 'var(--color-text-secondary)',
                padding: '2px 6px',
                borderRadius: 8,
                background: 'var(--color-bg-content)',
              }}
            >
              #{tag}
            </span>
          ))}
        </div>
      )}

      {/* Content sections */}
      <div style={{ flex: 1, overflow: 'auto' }}>
        {loading && (
          <div className="font-body" style={{ fontSize: 11, color: 'var(--color-text-placeholder)', textAlign: 'center', padding: '20px 0' }}>
            Loading skill content...
          </div>
        )}
        {!loading && sections.map(section => {
          const isExpanded = expandedSections.has(section.heading)
          return (
            <div key={section.heading} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
              <button
                type="button"
                onClick={() => toggleSection(section.heading)}
                className="flex items-center gap-2 w-full cursor-pointer"
                style={{
                  padding: '10px 16px',
                  background: 'none',
                  border: 'none',
                  textAlign: 'left',
                }}
              >
                {isExpanded ? <ChevronDown size={12} style={{ color: 'var(--color-text-placeholder)', flexShrink: 0 }} /> : <ChevronRight size={12} style={{ color: 'var(--color-text-placeholder)', flexShrink: 0 }} />}
                <span className="font-display" style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text-primary)' }}>
                  {section.heading}
                </span>
              </button>
              {isExpanded && (
                <div
                  className="font-body"
                  style={{
                    padding: '0 16px 12px 32px',
                    fontSize: 11,
                    lineHeight: 1.7,
                    color: 'var(--color-text-body)',
                    whiteSpace: 'pre-wrap',
                  }}
                >
                  {section.body}
                </div>
              )}
            </div>
          )
        })}

        {/* Sources */}
        {sources.length > 0 && (
          <div style={{ padding: '12px 16px' }}>
            <div className="font-display" style={{ fontSize: 10, fontWeight: 700, color: 'var(--color-text-placeholder)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>
              Sources ({sources.length})
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {sources.map(source => (
                <div key={source.id} className="flex items-center gap-2" style={{ padding: '4px 0' }}>
                  <SourceIcon sourceType={source.sourceType} size={12} />
                  <span className="font-body" style={{ fontSize: 11, color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {source.title}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
