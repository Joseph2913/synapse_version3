import { useState, useCallback, useRef, useMemo, useEffect } from 'react'
import { Sparkles, GripVertical, ChevronDown, Search } from 'lucide-react'
import { useKnowledgeSkills } from '../hooks/useKnowledgeSkills'
import { SkillCard } from '../components/skills/SkillCard'
import { SkillOverviewPanel } from '../components/skills/SkillOverviewPanel'
import { SkillDetailPanel } from '../components/skills/SkillDetailPanel'
import type { KnowledgeSkillStatus, SkillSortOption } from '../types/skills'

const DEFAULT_LEFT_PCT = 65
const MIN_LEFT_PCT = 30
const MAX_LEFT_PCT = 80

// ─── Filter Dropdown ─────────────────────────────────────────────────────────

interface DropdownOption<T extends string> {
  value: T
  label: string
  count?: number
}

function FilterDropdown<T extends string>({
  options,
  value,
  onChange,
  isOpen,
  onToggle,
}: {
  options: DropdownOption<T>[]
  value: T
  onChange: (v: T) => void
  isOpen: boolean
  onToggle: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const currentOption = options.find(o => o.value === value)
  const isFiltered = value !== options[0]?.value

  useEffect(() => {
    if (!isOpen) return
    const handleClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onToggle()
    }
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onToggle()
    }
    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('keydown', handleEscape)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleEscape)
    }
  }, [isOpen, onToggle])

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        type="button"
        onClick={onToggle}
        className="font-body font-semibold"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          padding: '5px 13px',
          borderRadius: 20,
          fontSize: 12,
          background: isFiltered ? 'var(--color-accent-50)' : 'transparent',
          border: `1px solid ${isFiltered ? 'rgba(214,58,0,0.15)' : 'var(--border-subtle)'}`,
          color: isFiltered ? 'var(--color-accent-500)' : 'var(--color-text-secondary)',
          cursor: 'pointer',
          transition: 'all 0.15s ease',
        }}
      >
        {currentOption?.label}
        <ChevronDown size={12} style={{ color: 'var(--color-text-secondary)' }} />
      </button>

      {isOpen && (
        <div
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            marginTop: 4,
            background: 'var(--color-bg-card)',
            border: '1px solid var(--border-strong, var(--border-subtle))',
            borderRadius: 10,
            boxShadow: '0 4px 16px rgba(0,0,0,0.08)',
            padding: 4,
            zIndex: 50,
            minWidth: 160,
          }}
        >
          {options.map(opt => {
            const isActive = opt.value === value
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => { onChange(opt.value); onToggle() }}
                className="font-body"
                style={{
                  display: 'block',
                  width: '100%',
                  textAlign: 'left',
                  padding: '8px 14px',
                  borderRadius: 6,
                  border: 'none',
                  background: isActive ? 'var(--color-accent-50)' : 'transparent',
                  color: isActive ? 'var(--color-accent-500)' : 'var(--color-text-body)',
                  fontSize: 12,
                  fontWeight: isActive ? 600 : 500,
                  cursor: 'pointer',
                  transition: 'background 0.1s ease',
                }}
                onMouseEnter={e => { if (!isActive) e.currentTarget.style.background = 'var(--color-bg-hover, var(--color-bg-inset))' }}
                onMouseLeave={e => { if (!isActive) e.currentTarget.style.background = 'transparent' }}
              >
                {opt.label}{opt.count !== undefined ? ` (${opt.count})` : ''}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ─── Multi-select Domain Dropdown ────────────────────────────────────────────

function DomainDropdown({
  domains,
  selected,
  onChange,
  isOpen,
  onToggle,
}: {
  domains: Array<{ value: string; label: string; count: number }>
  selected: string[]
  onChange: (domains: string[]) => void
  isOpen: boolean
  onToggle: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const isFiltered = selected.length > 0

  useEffect(() => {
    if (!isOpen) return
    const handleClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onToggle()
    }
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onToggle()
    }
    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('keydown', handleEscape)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleEscape)
    }
  }, [isOpen, onToggle])

  const toggleDomain = (domain: string) => {
    if (selected.includes(domain)) {
      onChange(selected.filter(d => d !== domain))
    } else {
      onChange([...selected, domain])
    }
  }

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        type="button"
        onClick={onToggle}
        className="font-body font-semibold"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          padding: '5px 13px',
          borderRadius: 20,
          fontSize: 12,
          background: isFiltered ? 'var(--color-accent-50)' : 'transparent',
          border: `1px solid ${isFiltered ? 'rgba(214,58,0,0.15)' : 'var(--border-subtle)'}`,
          color: isFiltered ? 'var(--color-accent-500)' : 'var(--color-text-secondary)',
          cursor: 'pointer',
          transition: 'all 0.15s ease',
        }}
      >
        {isFiltered ? `Domains (${selected.length})` : 'All Domains'}
        <ChevronDown size={12} style={{ color: 'var(--color-text-secondary)' }} />
      </button>

      {isOpen && (
        <div
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            marginTop: 4,
            background: 'var(--color-bg-card)',
            border: '1px solid var(--border-strong, var(--border-subtle))',
            borderRadius: 10,
            boxShadow: '0 4px 16px rgba(0,0,0,0.08)',
            padding: 4,
            zIndex: 50,
            minWidth: 180,
          }}
        >
          {/* Clear */}
          {isFiltered && (
            <button
              type="button"
              onClick={() => onChange([])}
              className="font-body"
              style={{
                display: 'block',
                width: '100%',
                textAlign: 'left',
                padding: '8px 14px',
                borderRadius: 6,
                border: 'none',
                background: 'transparent',
                color: 'var(--color-accent-500)',
                fontSize: 12,
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              Clear all
            </button>
          )}
          {domains.map(d => {
            const isChecked = selected.includes(d.value)
            return (
              <button
                key={d.value}
                type="button"
                onClick={() => toggleDomain(d.value)}
                className="font-body flex items-center gap-2"
                style={{
                  width: '100%',
                  textAlign: 'left',
                  padding: '8px 14px',
                  borderRadius: 6,
                  border: 'none',
                  background: isChecked ? 'var(--color-accent-50)' : 'transparent',
                  color: isChecked ? 'var(--color-accent-500)' : 'var(--color-text-body)',
                  fontSize: 12,
                  fontWeight: isChecked ? 600 : 500,
                  cursor: 'pointer',
                  transition: 'background 0.1s ease',
                }}
                onMouseEnter={e => { if (!isChecked) e.currentTarget.style.background = 'var(--color-bg-hover, var(--color-bg-inset))' }}
                onMouseLeave={e => { if (!isChecked) e.currentTarget.style.background = isChecked ? 'var(--color-accent-50)' : 'transparent' }}
              >
                <span style={{
                  width: 14,
                  height: 14,
                  borderRadius: 3,
                  border: `1.5px solid ${isChecked ? 'var(--color-accent-500)' : 'var(--border-subtle)'}`,
                  background: isChecked ? 'var(--color-accent-500)' : 'transparent',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                  color: '#fff',
                  fontSize: 9,
                }}>
                  {isChecked ? '✓' : ''}
                </span>
                <span style={{ flex: 1 }}>{d.label}</span>
                <span style={{ color: 'var(--color-text-secondary)' }}>({d.count})</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ─── Main View ───────────────────────────────────────────────────────────────

export function SkillsView() {
  const {
    skills,
    loading,
    error,
    counts,
    selectedSkill,
    selectedSkillLoading,
    selectedSkillSources,
    selectSkill,
    activateSkill,
    archiveSkill,
    updateSkillContent,
    updateSkillStatus,
    updateSkillFromSource,
    searchSources,
    refresh,
  } = useKnowledgeSkills()

  // Filters
  const [searchQuery, setSearchQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | KnowledgeSkillStatus>('all')
  const [domainFilter, setDomainFilter] = useState<string[]>([])
  const [sortBy, setSortBy] = useState<SkillSortOption>('confidence')
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null)
  const [openDropdown, setOpenDropdown] = useState<'status' | 'domain' | 'sort' | null>(null)

  // Drag resize
  const containerRef = useRef<HTMLDivElement>(null)
  const [leftWidthPct, setLeftWidthPct] = useState(DEFAULT_LEFT_PCT)
  const [isDragging, setIsDragging] = useState(false)
  const dragStartX = useRef(0)
  const dragStartPct = useRef(DEFAULT_LEFT_PCT)

  // ── Client-side filtering & sorting ────────────────────────────────────────

  const filteredSkills = useMemo(() => {
    let result = [...skills]

    // Search
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase()
      result = result.filter(s =>
        s.title.toLowerCase().includes(q) || s.description.toLowerCase().includes(q)
      )
    }

    // Status filter
    if (statusFilter !== 'all') {
      result = result.filter(s => s.status === statusFilter)
    }

    // Domain filter
    if (domainFilter.length > 0) {
      result = result.filter(s => domainFilter.includes(s.domain ?? 'general'))
    }

    // Sort (status grouping: active → archived → draft at bottom)
    const statusOrder = (s: string) => s === 'active' ? 0 : s === 'archived' ? 1 : 2

    result.sort((a, b) => {
      const statusDiff = statusOrder(a.status) - statusOrder(b.status)
      if (statusDiff !== 0) return statusDiff

      switch (sortBy) {
        case 'confidence':
          return b.confidence - a.confidence
        case 'usage':
          return b.usage_count - a.usage_count
        case 'updated':
          return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
        case 'created':
          return new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
        case 'sources':
          return b.source_count - a.source_count
        case 'alpha':
          return a.title.localeCompare(b.title)
        default:
          return 0
      }
    })

    return result
  }, [skills, searchQuery, statusFilter, domainFilter, sortBy])

  // ── Domain options ─────────────────────────────────────────────────────────

  const domainOptions = useMemo(() => {
    return Object.entries(counts.byDomain)
      .sort(([, a], [, b]) => b - a)
      .map(([domain, count]) => ({ value: domain, label: domain, count }))
  }, [counts.byDomain])

  // ── Handlers ───────────────────────────────────────────────────────────────

  const handleDividerMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    dragStartX.current = e.clientX
    dragStartPct.current = leftWidthPct
    setIsDragging(true)

    const onMove = (ev: MouseEvent) => {
      if (!containerRef.current) return
      const containerW = containerRef.current.getBoundingClientRect().width
      const delta = ev.clientX - dragStartX.current
      const deltaPct = (delta / containerW) * 100
      setLeftWidthPct(Math.min(MAX_LEFT_PCT, Math.max(MIN_LEFT_PCT, dragStartPct.current + deltaPct)))
    }
    const onUp = () => {
      setIsDragging(false)
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [leftWidthPct])

  const handleCardClick = useCallback((id: string) => {
    const newId = selectedSkillId === id ? null : id
    setSelectedSkillId(newId)
    selectSkill(newId)
  }, [selectedSkillId, selectSkill])

  const handleSelectFromOverview = useCallback((id: string) => {
    setSelectedSkillId(id)
    selectSkill(id)
  }, [selectSkill])

  const toggleDropdown = useCallback((id: 'status' | 'domain' | 'sort') => {
    setOpenDropdown(prev => prev === id ? null : id)
  }, [])

  // Escape key
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (openDropdown) setOpenDropdown(null)
        else if (selectedSkillId) {
          setSelectedSkillId(null)
          selectSkill(null)
        }
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [openDropdown, selectedSkillId, selectSkill])

  const handleReactivate = useCallback(async (id: string) => {
    await updateSkillStatus(id, 'active')
  }, [updateSkillStatus])

  // ── Dropdown options ───────────────────────────────────────────────────────

  const statusOptions: DropdownOption<'all' | KnowledgeSkillStatus>[] = [
    { value: 'all', label: 'All Statuses' },
    { value: 'draft', label: 'Draft', count: counts.draft },
    { value: 'active', label: 'Active', count: counts.active },
    { value: 'archived', label: 'Archived', count: counts.archived },
  ]

  const sortOptions: DropdownOption<SkillSortOption>[] = [
    { value: 'confidence', label: 'Confidence' },
    { value: 'usage', label: 'Most Used' },
    { value: 'updated', label: 'Recently Updated' },
    { value: 'created', label: 'Recently Created' },
    { value: 'sources', label: 'Most Sources' },
    { value: 'alpha', label: 'Alphabetical' },
  ]

  // ── Right panel content ────────────────────────────────────────────────────

  const rightContent = selectedSkill ? (
    <SkillDetailPanel
      skill={selectedSkill}
      sources={selectedSkillSources}
      loading={selectedSkillLoading}
      onActivate={activateSkill}
      onArchive={archiveSkill}
      onReactivate={handleReactivate}
      onUpdateContent={updateSkillContent}
      onUpdateFromSource={updateSkillFromSource}
      onSearchSources={searchSources}
    />
  ) : (
    <SkillOverviewPanel
      skills={skills}
      counts={counts}
      onSelectSkill={handleSelectFromOverview}
    />
  )

  return (
    <div className="flex flex-col h-full">
      <style>{`
        @keyframes fadeUp {
          from { opacity: 0; transform: translateY(8px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>

      {/* ── Control bar — full width above split ── */}
      <div
        className="flex items-center shrink-0 flex-wrap"
        style={{
          background: 'var(--color-bg-card)',
          borderBottom: '1px solid var(--border-subtle)',
          padding: '8px 24px',
          minHeight: 44,
          gap: 8,
        }}
      >
        {/* Search */}
        <div style={{ position: 'relative' }}>
          <Search
            size={12}
            style={{
              position: 'absolute',
              left: 10,
              top: '50%',
              transform: 'translateY(-50%)',
              color: 'var(--color-text-secondary)',
              pointerEvents: 'none',
            }}
          />
          <input
            type="text"
            placeholder="Search skills…"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            className="font-body font-semibold"
            style={{
              padding: '5px 26px 5px 28px',
              borderRadius: 20,
              fontSize: 12,
              border: '1px solid var(--border-subtle)',
              background: 'transparent',
              color: 'var(--color-text-primary)',
              outline: 'none',
              width: 160,
              transition: 'border-color 0.15s ease',
            }}
            onFocus={e => { e.currentTarget.style.borderColor = 'rgba(214,58,0,0.3)' }}
            onBlur={e => { e.currentTarget.style.borderColor = 'var(--border-subtle)' }}
          />
        </div>

        {/* Divider */}
        <div style={{ width: 1, height: 24, background: 'var(--border-subtle)', flexShrink: 0 }} />

        {/* Status filter */}
        <FilterDropdown
          options={statusOptions}
          value={statusFilter}
          onChange={setStatusFilter}
          isOpen={openDropdown === 'status'}
          onToggle={() => toggleDropdown('status')}
        />

        {/* Domain filter */}
        <DomainDropdown
          domains={domainOptions}
          selected={domainFilter}
          onChange={setDomainFilter}
          isOpen={openDropdown === 'domain'}
          onToggle={() => toggleDropdown('domain')}
        />

        {/* Sort */}
        <FilterDropdown
          options={sortOptions}
          value={sortBy}
          onChange={setSortBy}
          isOpen={openDropdown === 'sort'}
          onToggle={() => toggleDropdown('sort')}
        />

        {/* Divider */}
        <div style={{ width: 1, height: 24, background: 'var(--border-subtle)', flexShrink: 0 }} />

        {/* Stats strip */}
        <span className="font-body" style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
          <span style={{ fontWeight: 600 }}>{filteredSkills.length}</span>
          {' skill'}{filteredSkills.length !== 1 ? 's' : ''}
        </span>
      </div>

      {/* ── Split layout ── */}
      <div
        ref={containerRef}
        className="flex flex-1 overflow-hidden"
        style={{
          background: 'var(--color-bg-content)',
          userSelect: isDragging ? 'none' : undefined,
          cursor: isDragging ? 'col-resize' : undefined,
        }}
      >
        {/* ── Left: scrollable card list ── */}
        <div
          style={{
            width: `${leftWidthPct}%`,
            height: '100%',
            overflowY: 'auto',
            overflowX: 'hidden',
            flexShrink: 0,
            transition: isDragging ? 'none' : 'width 0.2s ease',
          }}
        >
          <div style={{ padding: '20px 36px' }}>
            {loading && skills.length === 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {[0, 1, 2].map(i => (
                  <div
                    key={i}
                    className="animate-pulse"
                    style={{
                      height: 120,
                      borderRadius: 10,
                      background: 'var(--color-bg-inset)',
                      animation: `fadeUp 0.4s ease ${i * 0.05}s both`,
                    }}
                  />
                ))}
              </div>
            ) : error ? (
              <div style={{ textAlign: 'center', padding: '48px 0' }}>
                <p className="font-body" style={{ fontSize: 13, color: 'var(--color-text-secondary)', marginBottom: 12 }}>
                  Couldn&apos;t load skills.
                </p>
                <button
                  type="button"
                  onClick={refresh}
                  className="font-body font-semibold"
                  style={{
                    padding: '8px 20px',
                    borderRadius: 8,
                    border: '1px solid var(--border-subtle)',
                    background: 'var(--color-bg-card)',
                    color: 'var(--color-text-body)',
                    fontSize: 12,
                    cursor: 'pointer',
                  }}
                >
                  Retry
                </button>
              </div>
            ) : filteredSkills.length === 0 && skills.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '48px 0' }}>
                <Sparkles size={48} style={{ color: 'var(--color-text-placeholder)', margin: '0 auto 14px', display: 'block' }} />
                <h2 className="font-display" style={{ fontSize: 18, fontWeight: 700, color: 'var(--color-text-primary)', marginBottom: 8 }}>
                  Your skill library is empty
                </h2>
                <p className="font-body" style={{ fontSize: 13, color: 'var(--color-text-secondary)', maxWidth: 400, margin: '0 auto' }}>
                  Skills are generated automatically when you run the backfill engine. Head to Pipeline to ingest content first.
                </p>
              </div>
            ) : filteredSkills.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '48px 0' }}>
                <p className="font-body" style={{ fontSize: 13, color: 'var(--color-text-secondary)', marginBottom: 12 }}>
                  No skills match your filters.
                </p>
                <button
                  type="button"
                  onClick={() => { setSearchQuery(''); setStatusFilter('all'); setDomainFilter([]) }}
                  className="font-body font-semibold"
                  style={{
                    padding: '8px 20px',
                    borderRadius: 8,
                    border: '1px solid var(--border-subtle)',
                    background: 'var(--color-bg-card)',
                    color: 'var(--color-text-body)',
                    fontSize: 12,
                    cursor: 'pointer',
                  }}
                >
                  Clear filters
                </button>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {filteredSkills.map((skill, i) => (
                  <SkillCard
                    key={skill.id}
                    skill={skill}
                    isSelected={selectedSkillId === skill.id}
                    onClick={() => handleCardClick(skill.id)}
                    index={i}
                  />
                ))}
              </div>
            )}
          </div>
        </div>

        {/* ── Drag handle ── */}
        <div
          onMouseDown={handleDividerMouseDown}
          style={{
            width: 12,
            flexShrink: 0,
            cursor: 'col-resize',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            position: 'relative',
            zIndex: 1,
          }}
        >
          <div
            style={{
              position: 'absolute',
              left: '50%',
              transform: 'translateX(-50%)',
              top: 0,
              bottom: 0,
              width: 2,
              background: isDragging ? 'var(--color-accent-500)' : 'var(--border-subtle)',
              transition: 'background 0.15s ease',
              borderRadius: 1,
            }}
          />
          <GripVertical
            size={14}
            style={{
              position: 'relative',
              zIndex: 1,
              color: isDragging ? 'var(--color-accent-500)' : 'var(--color-text-placeholder)',
              transition: 'color 0.15s ease',
              background: 'var(--color-bg-content)',
              borderRadius: 2,
            }}
          />
        </div>

        {/* ── Right panel ── */}
        <div style={{ flex: 1, height: '100%', overflow: 'hidden', minWidth: 0 }}>
          {rightContent}
        </div>
      </div>
    </div>
  )
}
