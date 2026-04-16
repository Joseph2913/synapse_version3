import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Anchor, ChevronDown, GripVertical, Plus, Radio, Search, Sparkles, type LucideIcon } from 'lucide-react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'
import { useAnchorCandidates } from '../hooks/useAnchorCandidates'
import { useKnowledgeSkills } from '../hooks/useKnowledgeSkills'
import { promoteToSubAnchor } from '../services/anchorCandidates'
import {
  createAndProcessSkillSource,
  createManualAnchorFromScratch,
} from '../services/manualSignals'
import { supabase } from '../services/supabase'
import { AnchorCard } from '../components/anchors/AnchorCard'
import { AnchorCreateForm } from '../components/anchors/AnchorCreateForm'
import { AnchorDetailPanel } from '../components/anchors/AnchorDetailPanel'
import { AnchorHealthPanel } from '../components/anchors/AnchorHealthPanel'
import { ManualAnchorCreatePanel } from '../components/signals/ManualAnchorCreatePanel'
import { SkillCreatePanel } from '../components/signals/SkillCreatePanel'
import { SkillCard } from '../components/skills/SkillCard'
import { SkillDetailPanel } from '../components/skills/SkillDetailPanel'
import { SkillOverviewPanel } from '../components/skills/SkillOverviewPanel'
import { CombinedOverviewPanel } from '../components/signals/CombinedOverviewPanel'
import { ProcessingCard } from '../components/signals/ProcessingCard'
import { ToggleGroup } from '../components/shared/ToggleGroup'
import { StaggerList, StaggerItem } from '../components/ui/StaggerList'
import { SectionLabel } from '../components/ui/SectionLabel'
import type { AnchorCandidateWithNode } from '../types/anchors'
import { useProcessingItems } from '../app/providers/ProcessingProvider'
import type { KnowledgeSkillListItem } from '../types/skills'

type SignalMode = 'all' | 'anchors' | 'skills'
type UnifiedStatus = 'all' | 'suggested' | 'active' | 'dormant' | 'archived'
type UnifiedSort = 'recently_updated' | 'recently_added' | 'score' | 'alphabetical'
type AnchorTypeFilter = 'all' | 'manual' | 'system'
type Selection =
  | { type: 'anchor'; id: string }
  | { type: 'skill'; id: string }
  | null
type CreatePanel = 'anchor-manual' | 'anchor-existing' | 'skill' | null

const DEFAULT_LEFT_PCT = 65
const MIN_LEFT_PCT = 30
const MAX_LEFT_PCT = 80

const MODE_OPTIONS: Array<{ key: SignalMode; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'anchors', label: 'Anchors' },
  { key: 'skills', label: 'Skills' },
]

interface DropdownOption<T extends string> {
  value: T
  label: string
  count?: number
}

function isSignalMode(value: string | null): value is SignalMode {
  return value === 'all' || value === 'anchors' || value === 'skills'
}

function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

function isManualAnchor(candidate: AnchorCandidateWithNode): boolean {
  return candidate.compositeScore === 1
}

function matchesAnchorStatus(candidate: AnchorCandidateWithNode, status: UnifiedStatus): boolean {
  if (status === 'all') return true
  if (status === 'suggested') return candidate.status === 'suggested'
  if (status === 'active') return candidate.status === 'confirmed'
  if (status === 'dormant') return candidate.status === 'dormant'
  if (status === 'archived') return candidate.status === 'archived'
  return true
}

function matchesSkillStatus(skill: KnowledgeSkillListItem, status: UnifiedStatus): boolean {
  if (status === 'all') return true
  if (status === 'suggested') return skill.status === 'draft'
  if (status === 'active') return skill.status === 'active'
  if (status === 'dormant') return false
  if (status === 'archived') return skill.status === 'archived'
  return true
}

function matchesAnchorSearch(candidate: AnchorCandidateWithNode, query: string): boolean {
  if (!query) return true
  return (candidate.node?.label ?? '').toLowerCase().includes(query)
}

function matchesSkillSearch(skill: KnowledgeSkillListItem, query: string): boolean {
  if (!query) return true
  const haystack = [skill.title, skill.name, skill.description].join(' ').toLowerCase()
  return haystack.includes(query)
}

function sortAnchors(items: AnchorCandidateWithNode[], sortKey: UnifiedSort): AnchorCandidateWithNode[] {
  const result = [...items]

  result.sort((a, b) => {
    switch (sortKey) {
      case 'recently_updated':
        return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
      case 'recently_added':
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      case 'score':
        return b.compositeScore - a.compositeScore || b.connectionCount - a.connectionCount
      case 'alphabetical':
        return (a.node?.label ?? '').localeCompare(b.node?.label ?? '')
      default:
        return 0
    }
  })

  return result
}

function sortSkills(items: KnowledgeSkillListItem[], sortKey: UnifiedSort): KnowledgeSkillListItem[] {
  const result = [...items]

  result.sort((a, b) => {
    switch (sortKey) {
      case 'recently_updated':
        return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
      case 'recently_added':
        return new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      case 'score':
        return b.confidence - a.confidence || b.usage_count - a.usage_count
      case 'alphabetical':
        return a.title.localeCompare(b.title)
      default:
        return 0
    }
  })

  return result
}

function buildAnchorHierarchyList(items: AnchorCandidateWithNode[]) {
  const roots = items.filter(candidate => !candidate.node?.parent_anchor_id)
  const subs = items.filter(candidate => !!candidate.node?.parent_anchor_id)
  const ordered: Array<{ candidate: AnchorCandidateWithNode; parentLabel?: string }> = []

  for (const root of roots) {
    ordered.push({ candidate: root })
    const children = subs.filter(candidate => candidate.node?.parent_anchor_id === root.nodeId)
    for (const child of children) {
      ordered.push({ candidate: child, parentLabel: root.node?.label ?? undefined })
    }
  }

  const addedIds = new Set(ordered.map(entry => entry.candidate.id))
  for (const candidate of subs) {
    if (!addedIds.has(candidate.id)) ordered.push({ candidate })
  }

  return ordered
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
  onChange: (value: T) => void
  isOpen: boolean
  onToggle: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const currentOption = options.find(option => option.value === value)
  const isFiltered = value !== options[0]?.value

  useEffect(() => {
    if (!isOpen) return

    const handleClickOutside = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onToggle()
    }
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onToggle()
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
            border: '1px solid var(--border-strong)',
            borderRadius: 10,
            boxShadow: '0 4px 16px rgba(0,0,0,0.08)',
            padding: 4,
            zIndex: 50,
            minWidth: 170,
          }}
        >
          {options.map(option => {
            const isActive = option.value === value
            return (
              <button
                key={option.value}
                type="button"
                onClick={() => { onChange(option.value); onToggle() }}
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
                }}
                onMouseEnter={event => {
                  if (!isActive) event.currentTarget.style.background = 'var(--color-bg-hover)'
                }}
                onMouseLeave={event => {
                  if (!isActive) event.currentTarget.style.background = 'transparent'
                }}
              >
                {option.label}
                {option.count !== undefined ? ` (${option.count})` : ''}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

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

    const handleClickOutside = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onToggle()
    }
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onToggle()
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
      onChange(selected.filter(item => item !== domain))
      return
    }
    onChange([...selected, domain])
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
            border: '1px solid var(--border-strong)',
            borderRadius: 10,
            boxShadow: '0 4px 16px rgba(0,0,0,0.08)',
            padding: 4,
            zIndex: 50,
            minWidth: 180,
          }}
        >
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

          {domains.map(domain => {
            const isChecked = selected.includes(domain.value)
            return (
              <button
                key={domain.value}
                type="button"
                onClick={() => toggleDomain(domain.value)}
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
                }}
                onMouseEnter={event => {
                  if (!isChecked) event.currentTarget.style.background = 'var(--color-bg-hover)'
                }}
                onMouseLeave={event => {
                  if (!isChecked) event.currentTarget.style.background = 'transparent'
                }}
              >
                <span
                  style={{
                    width: 14,
                    height: 14,
                    borderRadius: 3,
                    border: `1.5px solid ${isChecked ? 'var(--color-accent-500)' : 'var(--border-subtle)'}`,
                    background: isChecked ? 'var(--color-accent-500)' : 'transparent',
                    color: '#fff',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexShrink: 0,
                    fontSize: 9,
                  }}
                >
                  {isChecked ? '✓' : ''}
                </span>
                <span style={{ flex: 1 }}>{domain.label}</span>
                <span style={{ color: 'var(--color-text-secondary)' }}>({domain.count})</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

function SearchField({
  value,
  onChange,
  placeholder,
}: {
  value: string
  onChange: (value: string) => void
  placeholder: string
}) {
  return (
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
        value={value}
        onChange={event => onChange(event.target.value)}
        placeholder={placeholder}
        className="font-body font-semibold"
        style={{
          width: 180,
          padding: '5px 26px 5px 28px',
          borderRadius: 20,
          fontSize: 12,
          border: '1px solid var(--border-subtle)',
          background: 'var(--color-bg-inset)',
          color: 'var(--color-text-primary)',
          outline: 'none',
          transition: 'border-color 0.15s ease',
        }}
        onFocus={event => { event.currentTarget.style.borderColor = 'rgba(214,58,0,0.3)' }}
        onBlur={event => { event.currentTarget.style.borderColor = 'var(--border-subtle)' }}
      />
    </div>
  )
}

function EmptyState({
  icon: Icon,
  title,
  description,
  actionLabel,
  onAction,
}: {
  icon: LucideIcon
  title: string
  description: string
  actionLabel?: string
  onAction?: () => void
}) {
  return (
    <div style={{ textAlign: 'center', padding: '56px 0' }}>
      <Icon size={40} style={{ color: 'var(--color-text-placeholder)', margin: '0 auto 14px', display: 'block', opacity: 0.5 }} />
      <h2 className="font-display" style={{ fontSize: 18, fontWeight: 700, color: 'var(--color-text-primary)', marginBottom: 8 }}>
        {title}
      </h2>
      <p className="font-body" style={{ fontSize: 13, color: 'var(--color-text-secondary)', maxWidth: 420, margin: '0 auto' }}>
        {description}
      </p>
      {actionLabel && onAction && (
        <button
          type="button"
          onClick={onAction}
          className="font-body font-semibold"
          style={{
            marginTop: 16,
            padding: '8px 16px',
            borderRadius: 8,
            border: 'none',
            background: 'var(--color-accent-500)',
            color: '#fff',
            fontSize: 12,
            cursor: 'pointer',
          }}
        >
          {actionLabel}
        </button>
      )}
    </div>
  )
}

function LoadingDetailPanel({ label }: { label: string }) {
  return (
    <div style={{ padding: '24px 20px' }}>
      <div className="font-display" style={{ fontSize: 18, fontWeight: 700, color: 'var(--color-text-primary)', marginBottom: 12 }}>
        {label}
      </div>
      <div style={{ display: 'grid', gap: 8 }}>
        {[0, 1, 2].map(index => (
          <div
            key={index}
            style={{
              height: 72,
              borderRadius: 10,
              background: 'var(--color-bg-inset)',
              animation: `pulse 1.5s ease ${index * 0.05}s infinite`,
            }}
          />
        ))}
      </div>
    </div>
  )
}

function AllModeList({
  anchors,
  skills,
  searchActive,
  selectedId,
  selectedType,
  processingItems,
  onSelectAnchor,
  onSelectSkill,
  onConfirmAnchor,
  onDismissAnchor,
  onDeleteAnchor,
}: {
  anchors: AnchorCandidateWithNode[]
  skills: KnowledgeSkillListItem[]
  searchActive: boolean
  selectedId: string | null
  selectedType: 'anchor' | 'skill' | null
  processingItems: Array<{ id: string; type: 'skill' | 'anchor'; title?: string }>
  onSelectAnchor: (id: string) => void
  onSelectSkill: (id: string) => void
  onConfirmAnchor: (candidateId: string, nodeId: string) => void
  onDismissAnchor: (candidateId: string, dismissCount: number) => void
  onDeleteAnchor: (candidateId: string) => void
}) {
  const [anchorsExpanded, setAnchorsExpanded] = useState(false)
  const [skillsExpanded, setSkillsExpanded] = useState(false)

  useEffect(() => {
    if (searchActive) {
      setAnchorsExpanded(false)
      setSkillsExpanded(false)
    }
  }, [searchActive])

  const showAllAnchors = searchActive || anchorsExpanded || anchors.length <= 3
  const showAllSkills = searchActive || skillsExpanded || skills.length <= 3
  const visibleAnchors = showAllAnchors ? anchors : anchors.slice(0, 3)
  const visibleSkills = showAllSkills ? skills : skills.slice(0, 3)

  return (
    <div style={{ padding: '20px 36px' }}>
      {/* Processing cards at the top */}
      {processingItems.length > 0 && (
        <div className="flex flex-col gap-2" style={{ marginBottom: 16 }}>
          {processingItems.map((item, i) => (
            <ProcessingCard key={item.id} type={item.type} title={item.title} index={i} />
          ))}
        </div>
      )}

      {anchors.length > 0 && (
        <div style={{ marginBottom: skills.length > 0 ? 24 : 0 }}>
          <div className="flex items-center gap-2" style={{ marginBottom: 10 }}>
            <SectionLabel>Anchors</SectionLabel>
            <span className="font-body" style={{ fontSize: 10, fontWeight: 600, color: 'var(--color-text-secondary)' }}>
              {anchors.length}
            </span>
          </div>

          <StaggerList className="flex flex-col gap-2">
            {visibleAnchors.map((candidate, index) => (
              <StaggerItem key={candidate.id}>
                <AnchorCard
                  candidate={candidate}
                  isSelected={selectedType === 'anchor' && selectedId === candidate.id}
                  onClick={() => onSelectAnchor(candidate.id)}
                  onConfirm={onConfirmAnchor}
                  onDismiss={onDismissAnchor}
                  onDelete={onDeleteAnchor}
                  index={index}
                />
              </StaggerItem>
            ))}
          </StaggerList>

          {!showAllAnchors && anchors.length > 3 && (
            <button
              type="button"
              onClick={() => setAnchorsExpanded(true)}
              className="font-body font-semibold"
              style={{
                marginTop: 8,
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                fontSize: 12,
                color: 'var(--color-accent-500)',
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                padding: 0,
              }}
            >
              Show all {anchors.length} anchors
              <ChevronDown size={12} style={{ transform: 'rotate(-90deg)' }} />
            </button>
          )}
        </div>
      )}

      {skills.length > 0 && (
        <div>
          <div className="flex items-center gap-2" style={{ marginBottom: 10 }}>
            <SectionLabel>Skills</SectionLabel>
            <span className="font-body" style={{ fontSize: 10, fontWeight: 600, color: 'var(--color-text-secondary)' }}>
              {skills.length}
            </span>
          </div>

          <StaggerList className="flex flex-col gap-2">
            {visibleSkills.map((skill, index) => (
              <StaggerItem key={skill.id}>
                <SkillCard
                  skill={skill}
                  isSelected={selectedType === 'skill' && selectedId === skill.id}
                  onClick={() => onSelectSkill(skill.id)}
                  index={index}
                />
              </StaggerItem>
            ))}
          </StaggerList>

          {!showAllSkills && skills.length > 3 && (
            <button
              type="button"
              onClick={() => setSkillsExpanded(true)}
              className="font-body font-semibold"
              style={{
                marginTop: 8,
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                fontSize: 12,
                color: 'var(--color-accent-500)',
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                padding: 0,
              }}
            >
              Show all {skills.length} skills
              <ChevronDown size={12} style={{ transform: 'rotate(-90deg)' }} />
            </button>
          )}
        </div>
      )}
    </div>
  )
}

export function SignalsView() {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const { user, session } = useAuth()
  const modeParam = searchParams.get('mode')
  const initialMode: SignalMode = isSignalMode(modeParam) ? modeParam : 'all'

  const {
    suggested,
    confirmed,
    archived,
    health,
    suggestedCount,
    loading: anchorLoading,
    healthLoading,
    error: anchorError,
    lastScoredAt,
    confirm,
    dismiss,
    dismissAll,
    archive,
    restore,
    createManual,
    refetch,
  } = useAnchorCandidates()

  const {
    skills,
    loading: skillLoading,
    error: skillError,
    counts: skillCounts,
    selectedSkill,
    selectedSkillLoading,
    selectedSkillSources,
    selectSkill,
    activateSkill,
    archiveSkill,
    updateSkillContent,
    updateSkillStatus,
    refresh,
  } = useKnowledgeSkills()

  const [mode, setMode] = useState<SignalMode>(initialMode)
  const [selection, setSelection] = useState<Selection>(null)
  const [createPanel, setCreatePanel] = useState<CreatePanel>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<UnifiedStatus>('all')
  const [sortKey, setSortKey] = useState<UnifiedSort>('recently_updated')
  const [anchorTypeFilter, setAnchorTypeFilter] = useState<AnchorTypeFilter>('all')
  const [domainFilter, setDomainFilter] = useState<string[]>([])
  const [openDropdown, setOpenDropdown] = useState<'status' | 'sort' | 'type' | 'domain' | null>(null)
  const [leftWidthPct, setLeftWidthPct] = useState(DEFAULT_LEFT_PCT)
  const [isDragging, setIsDragging] = useState(false)
  const [toast, setToast] = useState<{ text: string; color: string } | null>(null)
  const [totalSourcesIngested, setTotalSourcesIngested] = useState(0)
  const { items: processingItems, add: addProcessingItem, remove: removeProcessingItem } = useProcessingItems()

  const containerRef = useRef<HTMLDivElement>(null)
  const dragStartX = useRef(0)
  const dragStartPct = useRef(DEFAULT_LEFT_PCT)

  const allAnchors = useMemo(() => [...suggested, ...confirmed, ...archived], [suggested, confirmed, archived])
  const selectedId = selection?.id ?? null
  const selectedType = selection?.type ?? null
  const selectedAnchor = useMemo(
    () => (selection?.type === 'anchor' ? allAnchors.find(candidate => candidate.id === selection.id) ?? null : null),
    [allAnchors, selection],
  )

  const normalizedSearch = searchQuery.trim().toLowerCase()
  const searchActive = normalizedSearch.length > 0

  const clearSelection = useCallback(() => {
    setSelection(null)
    setCreatePanel(null)
    setOpenDropdown(null)
    void selectSkill(null)
  }, [selectSkill])

  const showToast = useCallback((text: string, color: string) => {
    setToast({ text, color })
    window.setTimeout(() => setToast(null), 2200)
  }, [])

  useEffect(() => {
    if (!user?.id) {
      setTotalSourcesIngested(0)
      return
    }

    void (async () => {
      try {
        const { count } = await supabase
          .from('knowledge_sources')
          .select('id', { count: 'exact', head: true })
          .eq('user_id', user.id)
        setTotalSourcesIngested(count ?? 0)
      } catch {
        setTotalSourcesIngested(0)
      }
    })()
  }, [user?.id])

  useEffect(() => {
    if (selection?.type === 'anchor' && !selectedAnchor) {
      setSelection(null)
    }
  }, [selection, selectedAnchor])

  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return

      if (openDropdown) {
        setOpenDropdown(null)
        return
      }

      if (selection || createPanel) {
        clearSelection()
      }
    }

    window.addEventListener('keydown', handleEscape)
    return () => window.removeEventListener('keydown', handleEscape)
  }, [clearSelection, createPanel, openDropdown, selection])

  const handleModeChange = useCallback((nextMode: SignalMode) => {
    setMode(nextMode)
    setSelection(null)
    setCreatePanel(null)
    setOpenDropdown(null)
    void selectSkill(null)
  }, [selectSkill])

  const handleDividerMouseDown = useCallback((event: React.MouseEvent) => {
    event.preventDefault()
    dragStartX.current = event.clientX
    dragStartPct.current = leftWidthPct
    setIsDragging(true)

    const onMove = (moveEvent: MouseEvent) => {
      if (!containerRef.current) return
      const containerWidth = containerRef.current.getBoundingClientRect().width
      const delta = moveEvent.clientX - dragStartX.current
      const deltaPct = (delta / containerWidth) * 100
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

  const handleSelectAnchor = useCallback((id: string) => {
    setCreatePanel(null)
    setSelection(current => {
      if (current?.type === 'anchor' && current.id === id) return null
      return { type: 'anchor', id }
    })
    void selectSkill(null)
  }, [selectSkill])

  const handleSelectSkill = useCallback((id: string) => {
    setCreatePanel(null)
    if (selection?.type === 'skill' && selection.id === id) {
      setSelection(null)
      void selectSkill(null)
      return
    }

    setSelection({ type: 'skill', id })
    void selectSkill(id)
  }, [selectSkill, selection])

  const openCreatePanel = useCallback((panel: NonNullable<CreatePanel>) => {
    setSelection(null)
    setCreatePanel(panel)
    setOpenDropdown(null)
    void selectSkill(null)
  }, [selectSkill])

  const handleNewAnchor = useCallback(() => {
    openCreatePanel('anchor-manual')
  }, [openCreatePanel])

  const handleUseExistingNode = useCallback(() => {
    openCreatePanel('anchor-existing')
  }, [openCreatePanel])

  const handleNewSkill = useCallback(() => {
    openCreatePanel('skill')
  }, [openCreatePanel])

  const handleConfirm = useCallback(async (candidateId: string, nodeId: string) => {
    await confirm(candidateId, nodeId)
    if (selection?.type === 'anchor' && selection.id === candidateId) setSelection(null)
    showToast('✦ Anchor confirmed', '#22c55e')
  }, [confirm, selection, showToast])

  const handleDismiss = useCallback(async (candidateId: string, dismissCount: number) => {
    await dismiss(candidateId, dismissCount)
    if (selection?.type === 'anchor' && selection.id === candidateId) setSelection(null)
  }, [dismiss, selection])

  const handleArchive = useCallback(async (candidateId: string, nodeId: string) => {
    await archive(candidateId, nodeId)
    if (selection?.type === 'anchor' && selection.id === candidateId) setSelection(null)
  }, [archive, selection])

  const handleCreateSaved = useCallback(async (nodeId: string) => {
    await createManual(nodeId)
    setCreatePanel(null)
    showToast('✦ Anchor created', '#22c55e')
  }, [createManual, showToast])

  const handleManualAnchorCreated = useCallback(async (
    input: { title: string; description: string; settings: string },
  ) => {
    if (!user?.id) throw new Error('Not authenticated.')

    const tempId = crypto.randomUUID()
    addProcessingItem({ id: tempId, type: 'anchor', title: input.title })
    setCreatePanel(null)

    try {
      const result = await createManualAnchorFromScratch({
        userId: user.id,
        title: input.title,
        description: input.description,
        settings: input.settings,
      })

      removeProcessingItem(tempId)
      setSelection({ type: 'anchor', id: result.candidateId })
      await refetch()
      showToast('✦ Anchor created', '#22c55e')
    } catch (err) {
      removeProcessingItem(tempId)
      showToast(err instanceof Error ? err.message : 'Failed to create anchor.', '#ef4444')
    }
  }, [addProcessingItem, refetch, removeProcessingItem, showToast, user?.id])

  const handleProcessSkillSource = useCallback(async (
    input: {
      title?: string
      content: string
      sourceType: 'Note' | 'Document' | 'Meeting' | 'YouTube'
      sourceUrl?: string
      inputType: 'text' | 'url' | 'document' | 'transcript' | 'youtube'
    },
  ) => {
    if (!user?.id || !session?.access_token) throw new Error('Not authenticated.')

    // Add a processing card immediately and close the create panel
    const tempId = crypto.randomUUID()
    addProcessingItem({ id: tempId, type: 'skill', title: input.title })
    setCreatePanel(null)

    // Run the full ingestion + skill extraction in the background
    try {
      const result = await createAndProcessSkillSource({
        userId: user.id,
        accessToken: session.access_token,
        title: input.title,
        content: input.content,
        sourceType: input.sourceType,
        sourceUrl: input.sourceUrl,
        inputType: input.inputType,
      })

      removeProcessingItem(tempId)
      await refresh()

      if (result.skillId) {
        setSelection({ type: 'skill', id: result.skillId })
        await selectSkill(result.skillId)
        showToast('✦ Skill created', '#22c55e')
      } else if (result.action === 'skipped_below_threshold') {
        showToast('Source ingested — content did not meet skill threshold.', '#d97706')
      } else if (result.action === 'updated') {
        showToast('✦ Existing skill reinforced', '#22c55e')
      } else {
        showToast('Source ingested — skill extraction pending.', '#3b82f6')
      }

      return result
    } catch (err) {
      removeProcessingItem(tempId)
      showToast(err instanceof Error ? err.message : 'Failed to process skill source.', '#ef4444')
      throw err
    }
  }, [addProcessingItem, refresh, removeProcessingItem, selectSkill, session?.access_token, showToast, user?.id])

  const handleConfirmAsSubAnchor = useCallback(async (candidateId: string, nodeId: string, parentId: string) => {
    const success = await promoteToSubAnchor(candidateId, nodeId, parentId)
    if (!success) return

    if (selection?.type === 'anchor' && selection.id === candidateId) setSelection(null)
    showToast('✦ Sub-anchor confirmed', '#22c55e')
    refetch()
    window.dispatchEvent(new CustomEvent('synapse:anchor-confirmed', { detail: { nodeId } }))
    window.dispatchEvent(new CustomEvent('synapse:anchor-suggestions-changed'))
  }, [refetch, selection, showToast])

  const handleRestore = useCallback(async (candidateId: string, nodeId: string) => {
    await restore(candidateId, nodeId)
    if (selection?.type === 'anchor' && selection.id === candidateId) setSelection(null)
    showToast('✦ Anchor restored', '#22c55e')
  }, [restore, selection, showToast])

  const handleDeleteCandidate = useCallback(async (candidateId: string) => {
    await supabase.from('anchor_candidates').delete().eq('id', candidateId)
    if (selection?.type === 'anchor' && selection.id === candidateId) setSelection(null)
    refetch()
  }, [refetch, selection])

  const handleReactivateSkill = useCallback(async (id: string) => {
    await updateSkillStatus(id, 'active')
  }, [updateSkillStatus])

  const anchorStatusCounts = useMemo(() => ({
    suggested: suggested.length,
    confirmed: confirmed.filter(candidate => candidate.status === 'confirmed').length,
    dormant: confirmed.filter(candidate => candidate.status === 'dormant').length,
    archived: archived.length,
  }), [archived.length, confirmed, suggested.length])

  const statusOptions: DropdownOption<UnifiedStatus>[] = useMemo(() => [
    { value: 'all', label: 'All Statuses' },
    { value: 'suggested', label: 'Suggested', count: suggested.length + skillCounts.draft },
    { value: 'active', label: 'Active', count: anchorStatusCounts.confirmed + skillCounts.active },
    { value: 'dormant', label: 'Dormant', count: anchorStatusCounts.dormant },
    { value: 'archived', label: 'Archived', count: archived.length + skillCounts.archived },
  ], [anchorStatusCounts.confirmed, anchorStatusCounts.dormant, archived.length, skillCounts.active, skillCounts.archived, skillCounts.draft, suggested.length])

  const sortOptions: DropdownOption<UnifiedSort>[] = useMemo(() => [
    { value: 'recently_updated', label: 'Recently Updated' },
    { value: 'recently_added', label: 'Recently Added' },
    { value: 'score', label: 'Score / Confidence' },
    { value: 'alphabetical', label: 'Alphabetical' },
  ], [])

  const anchorTypeOptions: DropdownOption<AnchorTypeFilter>[] = useMemo(() => [
    { value: 'all', label: 'All Types' },
    { value: 'manual', label: 'Manual' },
    { value: 'system', label: 'System-detected' },
  ], [])

  const domainOptions = useMemo(() => (
    Object.entries(skillCounts.byDomain)
      .sort(([, a], [, b]) => b - a)
      .map(([domain, count]) => ({ value: domain, label: domain, count }))
  ), [skillCounts.byDomain])

  const filteredAllAnchors = useMemo(() => (
    sortAnchors(
      allAnchors.filter(candidate =>
        matchesAnchorStatus(candidate, statusFilter) &&
        matchesAnchorSearch(candidate, normalizedSearch),
      ),
      sortKey,
    )
  ), [allAnchors, normalizedSearch, sortKey, statusFilter])

  const filteredAllSkills = useMemo(() => (
    sortSkills(
      skills.filter(skill =>
        matchesSkillStatus(skill, statusFilter) &&
        matchesSkillSearch(skill, normalizedSearch),
      ),
      sortKey,
    )
  ), [normalizedSearch, skills, sortKey, statusFilter])

  const filteredAnchorsForMode = useMemo(() => {
    const candidates = allAnchors.filter(candidate => {
      if (!matchesAnchorStatus(candidate, statusFilter)) return false
      if (!matchesAnchorSearch(candidate, normalizedSearch)) return false
      if (anchorTypeFilter === 'manual') return isManualAnchor(candidate)
      if (anchorTypeFilter === 'system') return !isManualAnchor(candidate)
      return true
    })

    return sortAnchors(candidates, sortKey)
  }, [allAnchors, anchorTypeFilter, normalizedSearch, sortKey, statusFilter])

  const filteredSkillsForMode = useMemo(() => {
    const filtered = skills.filter(skill => {
      if (!matchesSkillStatus(skill, statusFilter)) return false
      if (!matchesSkillSearch(skill, normalizedSearch)) return false
      if (domainFilter.length > 0 && !domainFilter.includes(skill.domain ?? 'general')) return false
      return true
    })

    return sortSkills(filtered, sortKey)
  }, [domainFilter, normalizedSearch, skills, sortKey, statusFilter])

  const suggestedAnchorsForMode = useMemo(
    () => filteredAnchorsForMode.filter(candidate => candidate.status === 'suggested'),
    [filteredAnchorsForMode],
  )
  const confirmedAnchorsForMode = useMemo(
    () => filteredAnchorsForMode.filter(candidate => candidate.status === 'confirmed' || candidate.status === 'dormant'),
    [filteredAnchorsForMode],
  )
  const archivedAnchorsForMode = useMemo(
    () => filteredAnchorsForMode.filter(candidate => candidate.status === 'archived'),
    [filteredAnchorsForMode],
  )

  const orderedConfirmedAnchors = useMemo(
    () => buildAnchorHierarchyList(confirmedAnchorsForMode),
    [confirmedAnchorsForMode],
  )

  const avgActiveSkillConfidence = useMemo(() => {
    const activeSkills = skills.filter(skill => skill.status === 'active')
    if (activeSkills.length === 0) return 0
    return activeSkills.reduce((sum, skill) => sum + skill.confidence, 0) / activeSkills.length
  }, [skills])

  const recentSkills = useMemo(() => (
    [...skills]
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      .slice(0, 5)
  ), [skills])

  const anchorCounts = useMemo(() => ({
    total: anchorStatusCounts.confirmed + anchorStatusCounts.suggested + anchorStatusCounts.dormant,
    confirmed: anchorStatusCounts.confirmed,
    suggested: anchorStatusCounts.suggested,
    dormant: anchorStatusCounts.dormant,
  }), [anchorStatusCounts.confirmed, anchorStatusCounts.dormant, anchorStatusCounts.suggested])

  const avgAnchorConnections = useMemo(() => {
    if (confirmed.length === 0) return 0
    return confirmed.reduce((sum, candidate) => sum + candidate.connectionCount, 0) / confirmed.length
  }, [confirmed])

  const recentAnchors = useMemo(() => (
    [...suggested, ...confirmed]
      .filter(candidate => candidate.compositeScore < 1)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, 5)
  ), [confirmed, suggested])

  const dormantAnchors = useMemo(() => (
    confirmed
      .filter(candidate => candidate.status === 'dormant')
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
      .slice(0, 5)
  ), [confirmed])

  const lowScoreAnchors = useMemo(() => (
    [...suggested, ...confirmed]
      .filter(candidate => candidate.compositeScore < 0.5)
      .sort((a, b) => a.compositeScore - b.compositeScore)
      .slice(0, 5)
  ), [confirmed, suggested])

  const totalSignalUses = useMemo(() => (
    skills.reduce((sum, skill) => sum + (skill.usage_count ?? 0), 0)
  ), [skills])

  const statsStrip = useMemo(() => {
    if (mode === 'anchors') {
      return (
        <>
          <span>{confirmedAnchorsForMode.length + suggestedAnchorsForMode.length} anchors</span>
          <span>·</span>
          <span style={{ color: suggestedAnchorsForMode.length > 0 ? '#d97706' : undefined, fontWeight: suggestedAnchorsForMode.length > 0 ? 600 : undefined }}>
            {suggestedAnchorsForMode.length} suggested
          </span>
          {lastScoredAt && (
            <>
              <span>·</span>
              <span>scored {formatRelativeTime(lastScoredAt)}</span>
            </>
          )}
        </>
      )
    }

    if (mode === 'skills') {
      return (
        <>
          <span>{filteredSkillsForMode.length} skills</span>
          <span>·</span>
          <span style={{ color: skillCounts.draft > 0 ? '#d97706' : undefined, fontWeight: skillCounts.draft > 0 ? 600 : undefined }}>
            {skillCounts.draft} suggested
          </span>
        </>
      )
    }

    return (
      <>
        <span>{filteredAllAnchors.length} anchors</span>
        <span>·</span>
        <span>{filteredAllSkills.length} skills</span>
      </>
    )
  }, [
    confirmedAnchorsForMode.length,
    filteredAllAnchors.length,
    filteredAllSkills.length,
    filteredSkillsForMode.length,
    lastScoredAt,
    mode,
    skillCounts.draft,
    suggestedAnchorsForMode.length,
  ])

  const allModeHasNoSignals = !anchorLoading && !skillLoading && allAnchors.length === 0 && skills.length === 0
  const allModeHasNoMatches = !anchorLoading && !skillLoading && !allModeHasNoSignals && filteredAllAnchors.length === 0 && filteredAllSkills.length === 0
  const anchorsModeEmpty = !anchorLoading && allAnchors.length === 0
  const anchorsModeNoMatches = !anchorLoading && !anchorsModeEmpty && suggestedAnchorsForMode.length === 0 && confirmedAnchorsForMode.length === 0 && archivedAnchorsForMode.length === 0
  const skillsModeEmpty = !skillLoading && skills.length === 0
  const skillsModeNoMatches = !skillLoading && !skillsModeEmpty && filteredSkillsForMode.length === 0

  let rightContent: React.ReactNode
  if (createPanel === 'anchor-existing') {
    rightContent = <AnchorCreateForm onSave={handleCreateSaved} onClose={() => setCreatePanel(null)} />
  } else if (createPanel === 'anchor-manual') {
    rightContent = (
      <ManualAnchorCreatePanel
        onClose={() => setCreatePanel(null)}
        onCreate={handleManualAnchorCreated}
        onUseExisting={handleUseExistingNode}
      />
    )
  } else if (createPanel === 'skill') {
    rightContent = (
      <SkillCreatePanel
        onClose={() => setCreatePanel(null)}
        onProcess={handleProcessSkillSource}
      />
    )
  } else if (selection?.type === 'anchor' && !selectedAnchor) {
    rightContent = <LoadingDetailPanel label="Loading anchor" />
  } else if (selectedAnchor) {
    rightContent = (
      <AnchorDetailPanel
        candidate={selectedAnchor}
        onClose={clearSelection}
        onConfirm={handleConfirm}
        onConfirmAsSubAnchor={handleConfirmAsSubAnchor}
        onDismiss={handleDismiss}
        onArchive={handleArchive}
        onDelete={handleDeleteCandidate}
        onRestore={handleRestore}
        onRefresh={refetch}
        onSelectSubAnchor={nodeId => {
          const target = allAnchors.find(candidate => candidate.nodeId === nodeId)
          if (target) handleSelectAnchor(target.id)
        }}
      />
    )
  } else if (selection?.type === 'skill') {
    if (selectedSkill?.id === selection.id) {
      rightContent = (
        <SkillDetailPanel
          skill={selectedSkill}
          sources={selectedSkillSources}
          loading={selectedSkillLoading}
          onActivate={activateSkill}
          onArchive={archiveSkill}
          onReactivate={handleReactivateSkill}
          onUpdateContent={updateSkillContent}
        />
      )
    } else {
      rightContent = <LoadingDetailPanel label="Loading skill" />
    }
  } else if (mode === 'anchors') {
    rightContent = (
      <AnchorHealthPanel
        health={health}
        loading={healthLoading}
        suggestedCount={suggestedCount}
        onSelectCandidate={handleSelectAnchor}
      />
    )
  } else if (mode === 'skills') {
    rightContent = (
      <SkillOverviewPanel
        skills={skills}
        counts={skillCounts}
        onSelectSkill={handleSelectSkill}
      />
    )
  } else {
    rightContent = (
      <CombinedOverviewPanel
        onCreateAnchor={handleNewAnchor}
        onCreateSkill={handleNewSkill}
        skillCounts={skillCounts}
        recentSkills={recentSkills}
        avgActiveSkillConfidence={avgActiveSkillConfidence}
        onSelectSkill={handleSelectSkill}
        anchorCounts={anchorCounts}
        avgAnchorConnections={avgAnchorConnections}
        dormantAnchors={dormantAnchors}
        lowScoreAnchors={lowScoreAnchors}
        recentAnchors={recentAnchors}
        onSelectAnchor={handleSelectAnchor}
        totalSourcesIngested={totalSourcesIngested}
        totalSignalUses={totalSignalUses}
      />
    )
  }

  return (
    <div className="flex flex-col h-full">
      <style>{`
        @keyframes fadeUp {
          from { opacity: 0; transform: translateY(8px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>

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
        <div className="flex items-center gap-2 flex-1 min-w-[220px]">
          <SearchField
            value={searchQuery}
            onChange={setSearchQuery}
            placeholder={mode === 'anchors' ? 'Search anchors…' : mode === 'skills' ? 'Search skills…' : 'Search signals…'}
          />
        </div>

        <div className="flex-1 flex justify-center min-w-[220px]">
          <ToggleGroup options={MODE_OPTIONS} value={mode} onChange={handleModeChange} style={{ minWidth: 250 }} />
        </div>

        <div className="flex items-center gap-2 flex-1 justify-end flex-wrap min-w-[260px]">
          <FilterDropdown
            options={statusOptions}
            value={statusFilter}
            onChange={setStatusFilter}
            isOpen={openDropdown === 'status'}
            onToggle={() => setOpenDropdown(current => current === 'status' ? null : 'status')}
          />

          {mode === 'anchors' && (
            <FilterDropdown
              options={anchorTypeOptions}
              value={anchorTypeFilter}
              onChange={setAnchorTypeFilter}
              isOpen={openDropdown === 'type'}
              onToggle={() => setOpenDropdown(current => current === 'type' ? null : 'type')}
            />
          )}

          {mode === 'skills' && (
            <DomainDropdown
              domains={domainOptions}
              selected={domainFilter}
              onChange={setDomainFilter}
              isOpen={openDropdown === 'domain'}
              onToggle={() => setOpenDropdown(current => current === 'domain' ? null : 'domain')}
            />
          )}

          <FilterDropdown
            options={sortOptions}
            value={sortKey}
            onChange={setSortKey}
            isOpen={openDropdown === 'sort'}
            onToggle={() => setOpenDropdown(current => current === 'sort' ? null : 'sort')}
          />

          <div style={{ width: 1, height: 24, background: 'var(--border-subtle)', flexShrink: 0 }} />

          <div className="font-body flex items-center gap-2" style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
            {statsStrip}
          </div>

          {mode === 'anchors' && (
            <button
              type="button"
              onClick={handleNewAnchor}
              className="flex items-center gap-1 font-body font-semibold"
              style={{
                background: createPanel === 'anchor-manual' || createPanel === 'anchor-existing'
                  ? 'var(--color-accent-50)'
                  : 'var(--color-accent-500)',
                color: createPanel === 'anchor-manual' || createPanel === 'anchor-existing'
                  ? 'var(--color-accent-500)'
                  : '#fff',
                border: createPanel === 'anchor-manual' || createPanel === 'anchor-existing'
                  ? '1px solid rgba(214,58,0,0.15)'
                  : '1px solid transparent',
                borderRadius: 8,
                fontSize: 12,
                padding: '7px 14px',
                cursor: 'pointer',
              }}
            >
              <Plus size={14} />
              New Anchor
            </button>
          )}

          {mode === 'skills' && (
            <button
              type="button"
              onClick={handleNewSkill}
              className="flex items-center gap-1 font-body font-semibold"
              style={{
                background: createPanel === 'skill' ? 'var(--color-accent-50)' : 'var(--color-accent-500)',
                color: createPanel === 'skill' ? 'var(--color-accent-500)' : '#fff',
                border: createPanel === 'skill' ? '1px solid rgba(214,58,0,0.15)' : '1px solid transparent',
                borderRadius: 8,
                fontSize: 12,
                padding: '7px 14px',
                cursor: 'pointer',
              }}
            >
              <Plus size={14} />
              New Skill
            </button>
          )}
        </div>
      </div>

      <div
        ref={containerRef}
        className="flex flex-1 overflow-hidden"
        style={{
          background: 'var(--color-bg-content)',
          userSelect: isDragging ? 'none' : undefined,
          cursor: isDragging ? 'col-resize' : undefined,
        }}
      >
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
          {mode === 'all' && (
            <>
              {allModeHasNoSignals ? (
                <div style={{ padding: '20px 36px' }}>
                  <EmptyState
                    icon={Radio}
                    title="No signals yet"
                    description="Anchors and skills are generated automatically when you ingest content. Head to Capture to get started."
                    actionLabel="Go to Capture"
                    onAction={() => navigate('/capture')}
                  />
                </div>
              ) : allModeHasNoMatches ? (
                <div style={{ padding: '20px 36px' }}>
                  <EmptyState
                    icon={Radio}
                    title="No signals match your filters"
                    description="Try clearing your search or switching the status filter to see more of your signal landscape."
                    actionLabel="Clear Filters"
                    onAction={() => {
                      setSearchQuery('')
                      setStatusFilter('all')
                    }}
                  />
                </div>
              ) : (
                <AllModeList
                  anchors={filteredAllAnchors}
                  skills={filteredAllSkills}
                  searchActive={searchActive}
                  selectedId={selectedId}
                  selectedType={selectedType}
                  processingItems={processingItems}
                  onSelectAnchor={handleSelectAnchor}
                  onSelectSkill={handleSelectSkill}
                  onConfirmAnchor={handleConfirm}
                  onDismissAnchor={handleDismiss}
                  onDeleteAnchor={handleDeleteCandidate}
                />
              )}
            </>
          )}

          {mode === 'anchors' && (
            <div style={{ padding: '20px 36px' }}>
              {processingItems.filter(p => p.type === 'anchor').length > 0 && (
                <div className="flex flex-col gap-2" style={{ marginBottom: 12 }}>
                  {processingItems.filter(p => p.type === 'anchor').map((item, i) => (
                    <ProcessingCard key={item.id} type="anchor" title={item.title} index={i} />
                  ))}
                </div>
              )}
              {anchorLoading ? (
                <div className="flex flex-col gap-2">
                  {[0, 1, 2].map(index => (
                    <div
                      key={index}
                      style={{
                        height: 80,
                        background: 'var(--color-bg-inset)',
                        borderRadius: 12,
                        animation: 'pulse 1.5s ease infinite',
                      }}
                    />
                  ))}
                </div>
              ) : anchorError ? (
                <div style={{ textAlign: 'center', padding: '40px 0' }}>
                  <p className="font-body" style={{ fontSize: 13, color: '#ef4444', marginBottom: 12 }}>
                    {anchorError}
                  </p>
                  <button
                    type="button"
                    onClick={refetch}
                    className="font-body"
                    style={{
                      background: 'var(--color-accent-500)',
                      color: '#fff',
                      fontSize: 12,
                      fontWeight: 600,
                      padding: '8px 16px',
                      borderRadius: 8,
                      border: 'none',
                      cursor: 'pointer',
                    }}
                  >
                    Retry
                  </button>
                </div>
              ) : anchorsModeEmpty ? (
                <EmptyState
                  icon={Anchor}
                  title="Your knowledge graph has no anchors"
                  description="The system will suggest anchors automatically after you ingest content. Or create your first one manually."
                  actionLabel="Create Your First Anchor"
                  onAction={handleNewAnchor}
                />
              ) : anchorsModeNoMatches ? (
                <EmptyState
                  icon={Anchor}
                  title="No anchors match your filters"
                  description="Try clearing your search, status, or type filter to bring more anchors back into view."
                  actionLabel="Clear Filters"
                  onAction={() => {
                    setSearchQuery('')
                    setStatusFilter('all')
                    setAnchorTypeFilter('all')
                  }}
                />
              ) : (
                <>
                  {suggestedAnchorsForMode.length > 0 && (
                    <div style={{ marginBottom: 24 }}>
                      <SectionLabel>Suggested</SectionLabel>

                      {suggestedAnchorsForMode.length >= 3 && (
                        <div
                          className="flex items-center justify-between"
                          style={{
                            background: 'rgba(245,158,11,0.06)',
                            border: '1px solid rgba(245,158,11,0.2)',
                            borderRadius: 10,
                            padding: '10px 14px',
                            marginTop: 10,
                            marginBottom: 8,
                          }}
                        >
                          <span className="font-body" style={{ fontSize: 12, color: '#d97706' }}>
                            ✦ {suggestedAnchorsForMode.length} new clusters detected from recent ingestion
                          </span>
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() => { if (suggestedAnchorsForMode[0]) handleSelectAnchor(suggestedAnchorsForMode[0].id) }}
                              className="font-body font-semibold"
                              style={{ fontSize: 11, color: '#d97706', background: 'none', border: 'none', cursor: 'pointer' }}
                            >
                              Review All
                            </button>
                            <button
                              type="button"
                              onClick={() => { if (window.confirm('Dismiss all suggestions?')) void dismissAll() }}
                              className="font-body"
                              style={{ fontSize: 11, color: 'var(--color-text-secondary)', background: 'none', border: 'none', cursor: 'pointer' }}
                            >
                              Skip All
                            </button>
                          </div>
                        </div>
                      )}

                      <StaggerList className="flex flex-col gap-2" style={{ marginTop: 10 }}>
                        {suggestedAnchorsForMode.map((candidate, index) => (
                          <StaggerItem key={candidate.id}>
                            <AnchorCard
                              candidate={candidate}
                              isSelected={selectedType === 'anchor' && selectedId === candidate.id}
                              onClick={() => handleSelectAnchor(candidate.id)}
                              onConfirm={handleConfirm}
                              onDismiss={handleDismiss}
                              onDelete={handleDeleteCandidate}
                              index={index}
                            />
                          </StaggerItem>
                        ))}
                      </StaggerList>
                    </div>
                  )}

                  {orderedConfirmedAnchors.length > 0 && (
                    <div>
                      <div style={{ marginBottom: 10 }}>
                        <SectionLabel>Your Anchors</SectionLabel>
                      </div>

                      <StaggerList className="flex flex-col gap-2">
                        {orderedConfirmedAnchors.map((entry, index) => (
                          <StaggerItem key={entry.candidate.id}>
                            <div style={{ marginLeft: entry.parentLabel ? 16 : 0 }}>
                              <AnchorCard
                                candidate={entry.candidate}
                                isSelected={selectedType === 'anchor' && selectedId === entry.candidate.id}
                                onClick={() => handleSelectAnchor(entry.candidate.id)}
                                onConfirm={handleConfirm}
                                onDismiss={handleDismiss}
                                onDelete={handleDeleteCandidate}
                                index={index + suggestedAnchorsForMode.length}
                                parentLabel={entry.parentLabel}
                              />
                            </div>
                          </StaggerItem>
                        ))}
                      </StaggerList>
                    </div>
                  )}

                  {archivedAnchorsForMode.length > 0 && (
                    <div style={{ marginTop: 16 }}>
                      <SectionLabel>Archived ({archivedAnchorsForMode.length})</SectionLabel>
                      <StaggerList className="flex flex-col gap-2" style={{ marginTop: 8, opacity: 0.7 }}>
                        {archivedAnchorsForMode.map((candidate, index) => (
                          <StaggerItem key={candidate.id}>
                            <AnchorCard
                              candidate={candidate}
                              isSelected={selectedType === 'anchor' && selectedId === candidate.id}
                              onClick={() => handleSelectAnchor(candidate.id)}
                              onConfirm={handleConfirm}
                              onDismiss={handleDismiss}
                              onDelete={handleDeleteCandidate}
                              index={index + suggestedAnchorsForMode.length + orderedConfirmedAnchors.length}
                            />
                          </StaggerItem>
                        ))}
                      </StaggerList>
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {mode === 'skills' && (
            <div style={{ padding: '20px 36px' }}>
              {processingItems.filter(p => p.type === 'skill').length > 0 && (
                <div className="flex flex-col gap-2" style={{ marginBottom: 12 }}>
                  {processingItems.filter(p => p.type === 'skill').map((item, i) => (
                    <ProcessingCard key={item.id} type="skill" title={item.title} index={i} />
                  ))}
                </div>
              )}
              {skillLoading && skills.length === 0 ? (
                <div className="flex flex-col gap-2">
                  {[0, 1, 2].map(index => (
                    <div
                      key={index}
                      style={{
                        height: 120,
                        borderRadius: 10,
                        background: 'var(--color-bg-inset)',
                        animation: `fadeUp 0.4s ease ${index * 0.05}s both`,
                      }}
                    />
                  ))}
                </div>
              ) : skillError ? (
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
              ) : skillsModeEmpty ? (
                <EmptyState
                  icon={Sparkles}
                  title="Your skill library is empty"
                  description="Add a source here to extract your first reusable skill, or keep ingesting content and let the backfill engine generate them automatically."
                  actionLabel="Add Your First Skill"
                  onAction={handleNewSkill}
                />
              ) : skillsModeNoMatches ? (
                <EmptyState
                  icon={Sparkles}
                  title="No skills match your filters"
                  description="Try clearing your search, status, or domain filters to see more skills."
                  actionLabel="Clear Filters"
                  onAction={() => {
                    setSearchQuery('')
                    setStatusFilter('all')
                    setDomainFilter([])
                  }}
                />
              ) : (
                <StaggerList className="flex flex-col gap-2">
                  {filteredSkillsForMode.map((skill, index) => (
                    <StaggerItem key={skill.id}>
                      <SkillCard
                        skill={skill}
                        isSelected={selectedType === 'skill' && selectedId === skill.id}
                        onClick={() => handleSelectSkill(skill.id)}
                        index={index}
                      />
                    </StaggerItem>
                  ))}
                </StaggerList>
              )}
            </div>
          )}
        </div>

        <div
          onMouseDown={handleDividerMouseDown}
          className="flex items-center justify-center shrink-0"
          style={{
            width: 12,
            cursor: 'col-resize',
            background: isDragging ? 'rgba(214,58,0,0.04)' : 'transparent',
            transition: 'background 0.15s ease',
          }}
          onMouseEnter={event => {
            if (!isDragging) event.currentTarget.style.background = 'rgba(0,0,0,0.02)'
          }}
          onMouseLeave={event => {
            if (!isDragging) event.currentTarget.style.background = 'transparent'
          }}
        >
          <GripVertical
            size={14}
            style={{
              color: isDragging ? 'var(--color-accent-500)' : 'var(--color-text-placeholder)',
              transition: 'color 0.15s ease',
            }}
          />
        </div>

        <div style={{ flex: 1, height: '100%', overflow: 'hidden', minWidth: 0, background: 'var(--color-bg-card)' }}>
          {rightContent}
        </div>
      </div>

      {toast && (
        <div
          style={{
            position: 'fixed',
            bottom: 24,
            left: 80,
            zIndex: 999,
            background: 'var(--color-bg-card)',
            border: `1px solid ${toast.color}30`,
            borderRadius: 8,
            padding: '8px 16px',
            boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
            animation: 'fadeUp 0.3s ease',
          }}
        >
          <span className="font-body" style={{ fontSize: 12, fontWeight: 600, color: toast.color }}>
            {toast.text}
          </span>
        </div>
      )}
    </div>
  )
}
