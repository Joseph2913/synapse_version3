import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { MoreHorizontal, Copy, Check, Pencil, Archive, Sparkles, RotateCcw, ChevronDown, ChevronRight, FileText, LayoutList } from 'lucide-react'
import { SourceIcon } from '../shared/SourceIcon'
import type { KnowledgeSkillDetail, KnowledgeSkillSource } from '../../types/skills'

// ─── Domain Colors ───────────────────────────────────────────────────────────

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

function getConfidenceColor(v: number): string {
  if (v >= 0.8) return 'var(--color-accent-500)'
  if (v >= 0.6) return '#10b981'
  if (v >= 0.4) return '#3b82f6'
  return '#808080'
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

// ─── Parse content into sections ─────────────────────────────────────────────

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
    // Match both ## and ### as section breaks
    const h2Match = line.match(/^## (.+)/)
    const h3Match = !h2Match ? line.match(/^### (.+)/) : null
    const heading = h2Match?.[1]?.trim() ?? h3Match?.[1]?.trim() ?? null

    if (heading) {
      // Save previous section
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

  // Save last section
  if (currentHeading || currentBody.length > 0) {
    const body = currentBody.join('\n').trim()
    if (body.length > 0) {
      sections.push({ heading: currentHeading || 'Overview', body })
    }
  }

  // Filter out the Synapse source attribution footer — we already show sources at top
  return sections.filter(s => {
    const h = s.heading.toLowerCase()
    if (h.includes('source attribution') || h.includes('synapse source')) return false
    // Also filter footer lines like "*Domain: ... | Confidence: ...*"
    if (s.body.startsWith('*Domain:') || s.body.startsWith('*domain:')) return false
    return true
  })
}

// ─── Simple markdown renderer ────────────────────────────────────────────────

function renderMarkdown(content: string, skipTopHeadings = true): React.ReactNode {
  const lines = content.split('\n')
  const elements: React.ReactNode[] = []
  let i = 0
  let key = 0

  while (i < lines.length) {
    const line = lines[i] ?? ''

    // ## headings — render only in full view mode
    if (line.startsWith('## ')) {
      if (skipTopHeadings) {
        i++
        continue
      }
      elements.push(
        <h2
          key={key++}
          className="font-display"
          style={{ fontSize: 16, fontWeight: 700, color: 'var(--color-text-primary)', marginTop: 24, marginBottom: 8 }}
        >
          {renderInline(line.slice(3))}
        </h2>
      )
      i++
      continue
    }

    if (line.startsWith('### ')) {
      elements.push(
        <h3
          key={key++}
          className="font-display"
          style={{ fontSize: 14, fontWeight: 700, color: 'var(--color-text-primary)', marginTop: 16, marginBottom: 6 }}
        >
          {renderInline(line.slice(4))}
        </h3>
      )
      i++
      continue
    }

    // Code blocks
    if (line.startsWith('```')) {
      const codeLines: string[] = []
      i++
      while (i < lines.length) {
        const codeLine = lines[i] ?? ''
        if (codeLine.startsWith('```')) break
        codeLines.push(codeLine)
        i++
      }
      i++
      elements.push(
        <pre
          key={key++}
          style={{
            fontSize: 12,
            background: 'var(--color-bg-inset)',
            borderRadius: 6,
            padding: '12px 16px',
            fontFamily: 'monospace',
            overflowX: 'auto',
            lineHeight: 1.5,
            margin: '8px 0',
            color: 'var(--color-text-body)',
          }}
        >
          {codeLines.join('\n')}
        </pre>
      )
      continue
    }

    // Blockquotes
    if (line.startsWith('> ')) {
      const quoteLines: string[] = []
      while (i < lines.length && (lines[i] ?? '').startsWith('> ')) {
        quoteLines.push((lines[i] ?? '').slice(2))
        i++
      }
      elements.push(
        <blockquote
          key={key++}
          className="font-body"
          style={{
            fontSize: 13,
            color: 'var(--color-text-body)',
            lineHeight: 1.65,
            margin: '8px 0',
            paddingLeft: 14,
            borderLeft: '3px solid var(--color-accent-500)',
            fontStyle: 'italic',
            opacity: 0.9,
          }}
        >
          {renderInline(quoteLines.join(' '))}
        </blockquote>
      )
      continue
    }

    // Horizontal rules
    if (line.trim() === '---' || line.trim() === '***') {
      elements.push(
        <hr key={key++} style={{ border: 'none', borderTop: '1px solid var(--border-subtle)', margin: '16px 0' }} />
      )
      i++
      continue
    }

    // Footer attribution lines (skip)
    if (line.startsWith('*Domain:') || line.startsWith('*domain:')) {
      i++
      continue
    }

    // Numbered lists
    if (/^\d+\.\s/.test(line)) {
      const listItems: string[] = []
      while (i < lines.length && /^\d+\.\s/.test(lines[i] ?? '')) {
        listItems.push((lines[i] ?? '').replace(/^\d+\.\s/, ''))
        i++
      }
      elements.push(
        <ol
          key={key++}
          className="font-body"
          style={{ fontSize: 13, color: 'var(--color-text-body)', lineHeight: 1.65, paddingLeft: 20, margin: '6px 0' }}
        >
          {listItems.map((item, j) => (
            <li key={j} style={{ marginBottom: 2 }}>{renderInline(item)}</li>
          ))}
        </ol>
      )
      continue
    }

    // Bullet lists
    if (line.startsWith('- ') || line.startsWith('* ')) {
      const listItems: string[] = []
      while (i < lines.length && ((lines[i] ?? '').startsWith('- ') || (lines[i] ?? '').startsWith('* '))) {
        listItems.push((lines[i] ?? '').slice(2))
        i++
      }
      elements.push(
        <ul
          key={key++}
          className="font-body"
          style={{ fontSize: 13, color: 'var(--color-text-body)', lineHeight: 1.65, paddingLeft: 20, margin: '6px 0' }}
        >
          {listItems.map((item, j) => (
            <li key={j} style={{ marginBottom: 2 }}>{renderInline(item)}</li>
          ))}
        </ul>
      )
      continue
    }

    // Empty line
    if (line.trim() === '') {
      i++
      continue
    }

    // Paragraph
    elements.push(
      <p
        key={key++}
        className="font-body"
        style={{ fontSize: 13, color: 'var(--color-text-body)', lineHeight: 1.65, margin: '6px 0' }}
      >
        {renderInline(line)}
      </p>
    )
    i++
  }

  return elements
}

function renderSectionBody(body: string): React.ReactNode {
  // Inside a section, don't skip any headings
  return renderMarkdown(body, false)
}

function renderFullView(content: string): React.ReactNode {
  // Render everything including ## headings, but filter out source attribution footer
  const filtered = content.split('\n').filter(line => {
    if (line.startsWith('*Domain:') || line.startsWith('*domain:')) return false
    return true
  }).join('\n')
  return renderMarkdown(filtered, false)
}

function renderInline(text: string): React.ReactNode {
  const parts = text.split(/(\*\*[^*]+\*\*)/)
  return parts.map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={i} style={{ fontWeight: 600 }}>{part.slice(2, -2)}</strong>
    }
    const codeParts = part.split(/(`[^`]+`)/)
    if (codeParts.length > 1) {
      return codeParts.map((cp, j) => {
        if (cp.startsWith('`') && cp.endsWith('`')) {
          return (
            <code
              key={`${i}-${j}`}
              style={{
                fontSize: '0.9em',
                background: 'var(--color-bg-inset)',
                padding: '1px 4px',
                borderRadius: 3,
                fontFamily: 'monospace',
              }}
            >
              {cp.slice(1, -1)}
            </code>
          )
        }
        return cp
      })
    }
    return part
  })
}

// ─── Collapsible Section ─────────────────────────────────────────────────────

function CollapsibleSection({ heading, body, defaultOpen = false }: { heading: string; body: string; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen)

  return (
    <div
      style={{
        border: '1px solid var(--border-subtle)',
        borderRadius: 8,
        overflow: 'hidden',
        marginBottom: 6,
      }}
    >
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 font-body font-semibold"
        style={{
          width: '100%',
          textAlign: 'left',
          padding: '10px 14px',
          border: 'none',
          background: open ? 'var(--color-bg-inset)' : 'var(--color-bg-card)',
          cursor: 'pointer',
          fontSize: 13,
          color: 'var(--color-text-primary)',
          transition: 'background 0.15s ease',
        }}
      >
        {open ? <ChevronDown size={14} style={{ color: 'var(--color-text-secondary)', flexShrink: 0 }} /> : <ChevronRight size={14} style={{ color: 'var(--color-text-secondary)', flexShrink: 0 }} />}
        {heading}
      </button>
      {open && (
        <div style={{ padding: '8px 14px 14px', background: 'var(--color-bg-card)' }}>
          {renderSectionBody(body)}
        </div>
      )}
    </div>
  )
}

// ─── Component ───────────────────────────────────────────────────────────────

interface SkillDetailPanelProps {
  skill: KnowledgeSkillDetail
  sources: KnowledgeSkillSource[]
  loading: boolean
  onActivate: (id: string) => Promise<void>
  onArchive: (id: string) => Promise<void>
  onReactivate: (id: string) => Promise<void>
  onUpdateContent: (id: string, content: string) => Promise<void>
  onUpdateFromSource?: (skillId: string, sourceId: string) => Promise<void>
  availableSources?: KnowledgeSkillSource[]
  onSearchSources?: (query: string) => Promise<KnowledgeSkillSource[]>
}

export function SkillDetailPanel({
  skill,
  sources,
  loading,
  onActivate,
  onArchive,
  onReactivate,
  onUpdateContent,
  onUpdateFromSource: _onUpdateFromSource,
  availableSources: _availableSources,
  onSearchSources: _onSearchSources,
}: SkillDetailPanelProps) {
  // Suppress unused warnings for source picker props (UI not yet wired)
  void _onUpdateFromSource; void _availableSources; void _onSearchSources
  const [menuOpen, setMenuOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const [editContent, setEditContent] = useState('')
  const [copied, setCopied] = useState<'skill' | 'name' | 'content' | null>(null)
  const [viewMode, setViewMode] = useState<'sections' | 'markdown'>('sections')
  const [sourcePickerOpen, setSourcePickerOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const sourcePickerRef = useRef<HTMLDivElement>(null)

  const domainColor = getDomainColor(skill.domain)
  const confColor = getConfidenceColor(skill.confidence)
  const domainLabel = skill.domain ?? 'general'

  // Parse content into sections for collapsible view
  const sections = useMemo(() => parseContentSections(skill.content), [skill.content])

  // Close menu on outside click / escape
  useEffect(() => {
    if (!menuOpen) return
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false)
    }
    const handleEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenuOpen(false) }
    document.addEventListener('mousedown', handleClick)
    document.addEventListener('keydown', handleEsc)
    return () => {
      document.removeEventListener('mousedown', handleClick)
      document.removeEventListener('keydown', handleEsc)
    }
  }, [menuOpen])

  // Auto-resize textarea
  useEffect(() => {
    if (editing && textareaRef.current) {
      textareaRef.current.style.height = 'auto'
      textareaRef.current.style.height = Math.max(400, textareaRef.current.scrollHeight) + 'px'
    }
  }, [editing, editContent])

  const handleStartEdit = useCallback(() => {
    setEditContent(skill.content)
    setEditing(true)
    setMenuOpen(false)
  }, [skill.content])

  const handleSave = useCallback(async () => {
    await onUpdateContent(skill.id, editContent)
    setEditing(false)
  }, [skill.id, editContent, onUpdateContent])

  const handleCancel = useCallback(() => {
    setEditing(false)
    setEditContent('')
  }, [])

  const copyAsSkillMd = useCallback(async () => {
    const md = `---\nname: ${skill.name}\ndescription: ${skill.description}\ntype: skill\n---\n\n${skill.content}`
    await navigator.clipboard.writeText(md)
    setCopied('skill')
    setMenuOpen(false)
    setTimeout(() => setCopied(null), 2000)
  }, [skill])

  const copyName = useCallback(async () => {
    await navigator.clipboard.writeText(skill.name)
    setCopied('name')
    setMenuOpen(false)
    setTimeout(() => setCopied(null), 2000)
  }, [skill.name])

  const copyContent = useCallback(async () => {
    await navigator.clipboard.writeText(skill.content)
    setCopied('content')
    setTimeout(() => setCopied(null), 2000)
  }, [skill.content])

  useEffect(() => {
    if (!sourcePickerOpen) return
    const handleClick = (e: MouseEvent) => {
      if (sourcePickerRef.current && !sourcePickerRef.current.contains(e.target as Node)) {
        setSourcePickerOpen(false)
      }
    }
    const handleEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') setSourcePickerOpen(false) }
    document.addEventListener('mousedown', handleClick)
    document.addEventListener('keydown', handleEsc)
    return () => {
      document.removeEventListener('mousedown', handleClick)
      document.removeEventListener('keydown', handleEsc)
    }
  }, [sourcePickerOpen])

  // Signal scores
  const signals: Array<{ label: string; value: number | null }> = [
    { label: 'IR', value: skill.instructional_ratio },
    { label: 'G', value: skill.generalizability },
    { label: 'SD', value: skill.structural_density },
    { label: 'AR', value: skill.anchor_relevance },
  ]

  if (loading) {
    return (
      <div style={{ padding: '24px 20px' }}>
        {[0, 1, 2, 3, 4].map(i => (
          <div
            key={i}
            className="animate-pulse"
            style={{
              height: i === 0 ? 24 : 14,
              width: i === 0 ? '60%' : `${70 + i * 5}%`,
              borderRadius: 4,
              background: 'var(--color-bg-inset)',
              marginBottom: 10,
            }}
          />
        ))}
      </div>
    )
  }

  return (
    <div style={{ padding: '24px 20px', overflowY: 'auto', height: '100%' }}>
      {/* ── Header row: domain/status left, Edit + Actions right ── */}
      <div className="flex items-start justify-between" style={{ marginBottom: 12 }}>
        <div className="flex items-center gap-2">
          <span className="flex items-center gap-1" style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', color: domainColor }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: domainColor }} />
            {domainLabel}
          </span>
          {skill.status === 'draft' && (
            <span style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', padding: '2px 6px', borderRadius: 4, background: 'rgba(245,158,11,0.1)', color: 'var(--semantic-amber-500, #f59e0b)' }}>
              Draft
            </span>
          )}
          {skill.status === 'archived' && (
            <span style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', padding: '2px 6px', borderRadius: 4, background: 'rgba(128,128,128,0.1)', color: 'var(--color-text-secondary)' }}>
              Archived
            </span>
          )}
        </div>

        {/* Right side: Edit button + Actions menu */}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={editing ? undefined : handleStartEdit}
            className="font-body font-semibold"
            style={{
              padding: '4px 12px',
              borderRadius: 20,
              fontSize: 12,
              border: editing ? '1px solid rgba(214,58,0,0.15)' : '1px solid var(--border-subtle)',
              background: editing ? 'var(--color-accent-50)' : 'transparent',
              color: editing ? 'var(--color-accent-500)' : 'var(--color-text-secondary)',
              cursor: editing ? 'default' : 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: 4,
            }}
          >
            <Pencil size={11} />
            {editing ? 'Editing...' : 'Edit'}
          </button>

          <div ref={menuRef} style={{ position: 'relative' }}>
            <button
              type="button"
              onClick={() => setMenuOpen(!menuOpen)}
              style={{
                width: 28,
                height: 28,
                borderRadius: 6,
                border: '1px solid var(--border-subtle)',
                background: 'transparent',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <MoreHorizontal size={14} style={{ color: 'var(--color-text-secondary)' }} />
            </button>

            {menuOpen && (
              <div
                style={{
                  position: 'absolute',
                  top: '100%',
                  right: 0,
                  marginTop: 4,
                  background: 'var(--color-bg-card)',
                  border: '1px solid var(--border-strong, var(--border-subtle))',
                  borderRadius: 10,
                  boxShadow: '0 4px 16px rgba(0,0,0,0.08)',
                  padding: 4,
                  zIndex: 50,
                  minWidth: 170,
                }}
              >
                {skill.status === 'draft' && (
                  <MenuButton icon={Sparkles} label="Activate" onClick={() => { onActivate(skill.id); setMenuOpen(false) }} />
                )}
                {skill.status === 'archived' && (
                  <MenuButton icon={RotateCcw} label="Reactivate" onClick={() => { onReactivate(skill.id); setMenuOpen(false) }} />
                )}
                {skill.status !== 'archived' && (
                  <MenuButton icon={Archive} label="Archive" onClick={() => { onArchive(skill.id); setMenuOpen(false) }} />
                )}
                <MenuButton
                  icon={copied === 'skill' ? Check : Copy}
                  label={copied === 'skill' ? 'Copied!' : 'Copy as SKILL.md'}
                  onClick={copyAsSkillMd}
                />
                <MenuButton
                  icon={copied === 'name' ? Check : Copy}
                  label={copied === 'name' ? 'Copied!' : 'Copy Name'}
                  onClick={copyName}
                />
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Title */}
      <h2
        className="font-display"
        style={{ fontSize: 20, fontWeight: 800, color: 'var(--color-text-primary)', margin: '0 0 4px' }}
      >
        {skill.title}
      </h2>

      {/* Meta line */}
      <p className="font-body" style={{ fontSize: 12, color: 'var(--color-text-secondary)', margin: '0 0 12px' }}>
        {domainLabel} · {skill.source_count} source{skill.source_count !== 1 ? 's' : ''}
        {skill.usage_count > 0 && (
          <span style={{ color: 'var(--color-accent-500)', fontWeight: 600 }}>
            {' · '}{skill.usage_count} use{skill.usage_count !== 1 ? 's' : ''}
          </span>
        )}
        {' · '}Created {formatDate(skill.created_at)}
        {skill.last_used_at && (
          <span> · Last used {formatDate(skill.last_used_at)}</span>
        )}
      </p>

      {/* ── Contributing Sources (at the top) ─────────────────────── */}
      <div
        style={{
          background: 'var(--color-bg-inset)',
          borderRadius: 8,
          padding: '10px 14px',
          marginBottom: 16,
        }}
      >
        <h3
          className="font-display"
          style={{ fontSize: 11, fontWeight: 700, color: 'var(--color-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.04em', margin: '0 0 8px' }}
        >
          Sources ({sources.length})
        </h3>
        {sources.length === 0 ? (
          <p className="font-body" style={{ fontSize: 12, color: 'var(--color-text-secondary)', margin: 0 }}>
            {skill.source_ids.length > 0
              ? `${skill.source_ids.length} source ID${skill.source_ids.length !== 1 ? 's' : ''} referenced — sources may have been removed or are from extraction sessions.`
              : 'No sources linked to this skill.'}
          </p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {sources.map(source => (
              <div
                key={source.id}
                className="flex items-center gap-2"
                style={{ padding: '3px 0', fontSize: 12, color: 'var(--color-text-secondary)' }}
              >
                <SourceIcon sourceType={source.source_type} size={20} />
                <span
                  className="font-body"
                  style={{
                    flex: 1,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    color: 'var(--color-text-primary)',
                  }}
                >
                  {source.title}
                </span>
                <span style={{ flexShrink: 0, fontSize: 11 }}>
                  {formatDate(source.created_at)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Draft activation banner ─────────────────────────────── */}
      {skill.status === 'draft' && (
        <div
          style={{
            background: 'rgba(245,158,11,0.06)',
            border: '1px solid rgba(245,158,11,0.15)',
            borderRadius: 8,
            padding: '10px 14px',
            marginBottom: 16,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 10,
          }}
        >
          <p className="font-body" style={{ fontSize: 12, color: 'var(--semantic-amber-500, #d97706)', margin: 0 }}>
            This skill is in <strong>draft</strong> — it won&apos;t appear in MCP search or skill listings until activated.
          </p>
          <button
            type="button"
            onClick={() => onActivate(skill.id)}
            className="font-body font-semibold"
            style={{
              padding: '5px 14px',
              borderRadius: 20,
              fontSize: 12,
              border: '1px solid rgba(214,58,0,0.15)',
              background: 'var(--color-accent-500)',
              color: '#fff',
              cursor: 'pointer',
              flexShrink: 0,
              whiteSpace: 'nowrap',
            }}
          >
            Activate
          </button>
        </div>
      )}

      {/* ── Usage Statistics ───────────────────────────────────────── */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr 1fr',
          gap: 6,
          marginBottom: 16,
        }}
      >
        <div style={{ background: 'var(--color-bg-inset)', borderRadius: 8, padding: '8px 12px' }}>
          <div className="font-body" style={{ fontSize: 10, color: 'var(--color-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 2 }}>
            Uses
          </div>
          <div className="font-display" style={{ fontSize: 18, fontWeight: 800, color: skill.usage_count > 0 ? 'var(--color-accent-500)' : 'var(--color-text-primary)' }}>
            {skill.usage_count}
          </div>
        </div>
        <div style={{ background: 'var(--color-bg-inset)', borderRadius: 8, padding: '8px 12px' }}>
          <div className="font-body" style={{ fontSize: 10, color: 'var(--color-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 2 }}>
            Sources
          </div>
          <div className="font-display" style={{ fontSize: 18, fontWeight: 800, color: 'var(--color-text-primary)' }}>
            {skill.source_count}
          </div>
        </div>
        <div style={{ background: 'var(--color-bg-inset)', borderRadius: 8, padding: '8px 12px' }}>
          <div className="font-body" style={{ fontSize: 10, color: 'var(--color-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 2 }}>
            Last Used
          </div>
          <div className="font-display" style={{ fontSize: 14, fontWeight: 700, color: 'var(--color-text-primary)' }}>
            {skill.last_used_at ? formatDate(skill.last_used_at) : '—'}
          </div>
        </div>
      </div>

      {/* Confidence bar */}
      <div style={{ marginBottom: 4 }}>
        <div className="flex items-center gap-2" style={{ marginBottom: 4 }}>
          <span className="font-body" style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>Confidence:</span>
          <span className="font-body" style={{ fontSize: 12, fontWeight: 700, color: confColor }}>{skill.confidence.toFixed(2)}</span>
          <div style={{ flex: 1, height: 4, borderRadius: 2, background: 'var(--color-bg-inset)', overflow: 'hidden' }}>
            <div style={{ width: `${Math.min(skill.confidence * 100, 100)}%`, height: '100%', borderRadius: 2, background: confColor }} />
          </div>
        </div>
        <div className="flex items-center gap-3" style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>
          {signals.map(s => (
            <span key={s.label}>
              {s.label}:{' '}
              <span style={{ fontWeight: 600, color: s.value !== null ? getConfidenceColor(s.value) : 'var(--color-text-secondary)' }}>
                {s.value !== null ? s.value.toFixed(2) : '—'}
              </span>
            </span>
          ))}
        </div>
      </div>

      {/* Tags */}
      {skill.tags.length > 0 && (
        <div className="flex items-center gap-1 flex-wrap" style={{ marginTop: 10, marginBottom: 16 }}>
          {skill.tags.map(tag => (
            <span
              key={tag}
              className="font-body"
              style={{
                fontSize: 11,
                padding: '3px 8px',
                borderRadius: 12,
                background: 'var(--color-bg-inset)',
                color: 'var(--color-text-secondary)',
              }}
            >
              #{tag}
            </span>
          ))}
        </div>
      )}

      {/* ── Content area ──────────────────────────────────────────── */}
      {editing ? (
        <div style={{ marginTop: 12 }}>
          <textarea
            ref={textareaRef}
            value={editContent}
            onChange={e => setEditContent(e.target.value)}
            className="font-body"
            style={{
              width: '100%',
              minHeight: 400,
              padding: '12px 16px',
              borderRadius: 8,
              border: '1px solid var(--border-subtle)',
              background: 'var(--color-bg-inset)',
              color: 'var(--color-text-body)',
              fontSize: 13,
              lineHeight: 1.65,
              resize: 'none',
              fontFamily: 'monospace',
              outline: 'none',
            }}
            onFocus={e => { e.currentTarget.style.borderColor = 'rgba(214,58,0,0.3)'; e.currentTarget.style.boxShadow = '0 0 0 3px var(--color-accent-50)' }}
            onBlur={e => { e.currentTarget.style.borderColor = 'var(--border-subtle)'; e.currentTarget.style.boxShadow = 'none' }}
          />
          <div className="flex items-center gap-2" style={{ marginTop: 10 }}>
            <button
              type="button"
              onClick={handleSave}
              className="font-body font-semibold"
              style={{
                padding: '6px 16px',
                borderRadius: 20,
                fontSize: 12,
                border: '1px solid rgba(214,58,0,0.15)',
                background: 'var(--color-accent-500)',
                color: '#fff',
                cursor: 'pointer',
              }}
            >
              Save
            </button>
            <button
              type="button"
              onClick={handleCancel}
              className="font-body font-semibold"
              style={{
                padding: '6px 16px',
                borderRadius: 20,
                fontSize: 12,
                border: '1px solid var(--border-subtle)',
                background: 'transparent',
                color: 'var(--color-text-secondary)',
                cursor: 'pointer',
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div style={{ marginTop: 12 }}>
          {/* View mode toggle + Copy button */}
          <div className="flex items-center justify-between" style={{ marginBottom: 10 }}>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setViewMode('sections')}
                className="font-body font-semibold"
                title="Collapsible sections"
                style={{
                  padding: '4px 10px',
                  borderRadius: 20,
                  fontSize: 12,
                  border: `1px solid ${viewMode === 'sections' ? 'rgba(214,58,0,0.15)' : 'var(--border-subtle)'}`,
                  background: viewMode === 'sections' ? 'var(--color-accent-50)' : 'transparent',
                  color: viewMode === 'sections' ? 'var(--color-accent-500)' : 'var(--color-text-secondary)',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                }}
              >
                <LayoutList size={11} />
                Sections
              </button>
              <button
                type="button"
                onClick={() => setViewMode('markdown')}
                className="font-body font-semibold"
                title="Full markdown view"
                style={{
                  padding: '4px 10px',
                  borderRadius: 20,
                  fontSize: 12,
                  border: `1px solid ${viewMode === 'markdown' ? 'rgba(214,58,0,0.15)' : 'var(--border-subtle)'}`,
                  background: viewMode === 'markdown' ? 'var(--color-accent-50)' : 'transparent',
                  color: viewMode === 'markdown' ? 'var(--color-accent-500)' : 'var(--color-text-secondary)',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                }}
              >
                <FileText size={11} />
                Full View
              </button>
            </div>

            <button
              type="button"
              onClick={copyContent}
              className="font-body font-semibold"
              style={{
                padding: '4px 10px',
                borderRadius: 20,
                fontSize: 12,
                border: '1px solid var(--border-subtle)',
                background: 'transparent',
                color: copied === 'content' ? 'var(--color-accent-500)' : 'var(--color-text-secondary)',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                transition: 'all 0.15s ease',
              }}
            >
              {copied === 'content' ? <Check size={11} /> : <Copy size={11} />}
              {copied === 'content' ? 'Copied!' : 'Copy'}
            </button>
          </div>

          {/* Sections view */}
          {viewMode === 'sections' ? (
            <div>
              {sections.length > 0 ? (
                sections.map((section, idx) => (
                  <CollapsibleSection
                    key={section.heading}
                    heading={section.heading}
                    body={section.body}
                    defaultOpen={idx === 0}
                  />
                ))
              ) : (
                <div style={{ maxWidth: 700 }}>
                  {renderFullView(skill.content)}
                </div>
              )}
            </div>
          ) : (
            /* Full markdown view */
            <div style={{ maxWidth: 700 }}>
              {renderFullView(skill.content)}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Menu Button ─────────────────────────────────────────────────────────────

function MenuButton({ icon: Icon, label, onClick }: { icon: typeof Copy; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="font-body"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        width: '100%',
        textAlign: 'left',
        padding: '8px 14px',
        borderRadius: 6,
        border: 'none',
        background: 'transparent',
        color: 'var(--color-text-body)',
        fontSize: 12,
        cursor: 'pointer',
        transition: 'background 0.1s ease',
      }}
      onMouseEnter={e => { e.currentTarget.style.background = 'var(--color-bg-hover, var(--color-bg-inset))' }}
      onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
    >
      <Icon size={13} style={{ color: 'var(--color-text-secondary)', flexShrink: 0 }} />
      {label}
    </button>
  )
}
