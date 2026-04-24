import { useState, useRef, useEffect } from 'react'
import { Search, ChevronDown, LayoutGrid, List } from 'lucide-react'

export type FilterValue = 'all' | 'active' | 'needs_attention'
export type SortValue = 'recent' | 'alpha' | 'sources' | 'health'
export type ViewMode = 'cards' | 'list'

interface Props {
  search: string
  onSearchChange: (v: string) => void
  filter: FilterValue
  onFilterChange: (v: FilterValue) => void
  sort: SortValue
  onSortChange: (v: SortValue) => void
  viewMode: ViewMode
  onViewModeChange: (v: ViewMode) => void
}

const FILTER_OPTIONS: { value: FilterValue; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'active', label: 'Active this week' },
  { value: 'needs_attention', label: 'Needs attention' },
]

const SORT_OPTIONS: { value: SortValue; label: string }[] = [
  { value: 'recent', label: 'Most recent activity' },
  { value: 'alpha', label: 'Alphabetical' },
  { value: 'sources', label: 'Sources' },
  { value: 'health', label: 'Health status' },
]

const pillStyle = (active: boolean): React.CSSProperties => ({
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  padding: '5px 13px',
  borderRadius: 20,
  fontSize: 12,
  fontWeight: 600,
  fontFamily: 'var(--font-body)',
  border: active ? '1px solid rgba(214,58,0,0.15)' : '1px solid var(--border-subtle)',
  background: active ? 'var(--color-accent-50)' : 'transparent',
  color: active ? 'var(--color-accent-500)' : 'var(--color-text-secondary)',
  cursor: 'pointer',
})

const dropdownStyle: React.CSSProperties = {
  position: 'absolute',
  top: '100%',
  right: 0,
  marginTop: 4,
  background: 'var(--color-bg-card)',
  border: '1px solid var(--border-strong)',
  borderRadius: 8,
  padding: 4,
  zIndex: 20,
  minWidth: 180,
  boxShadow: '0 4px 12px rgba(0,0,0,0.08)',
}

const itemStyle = (active: boolean): React.CSSProperties => ({
  display: 'block',
  width: '100%',
  padding: '6px 12px',
  fontSize: 12,
  fontFamily: 'var(--font-body)',
  fontWeight: active ? 600 : 400,
  color: active ? 'var(--color-accent-500)' : 'var(--color-text-body)',
  background: 'transparent',
  border: 'none',
  borderRadius: 4,
  cursor: 'pointer',
  textAlign: 'left',
})

const toggleBtn = (active: boolean): React.CSSProperties => ({
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 26,
  height: 26,
  borderRadius: 20,
  border: active ? '1px solid rgba(214,58,0,0.15)' : '1px solid var(--border-subtle)',
  background: active ? 'var(--color-accent-50)' : 'transparent',
  color: active ? 'var(--color-accent-500)' : 'var(--color-text-secondary)',
  cursor: 'pointer',
  padding: 0,
})

export function CouncilControlsBar({
  search, onSearchChange,
  filter, onFilterChange,
  sort, onSortChange,
  viewMode, onViewModeChange,
}: Props) {
  const [sortOpen, setSortOpen] = useState(false)
  const sortRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!sortOpen) return
    const onClick = (e: MouseEvent) => {
      if (sortRef.current && !sortRef.current.contains(e.target as Node)) setSortOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [sortOpen])

  const activeSort = SORT_OPTIONS.find(o => o.value === sort)

  return (
    <div
      style={{
        minHeight: 44,
        padding: '8px 24px',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        background: 'var(--color-bg-card)',
        borderBottom: '1px solid var(--border-subtle)',
        flexShrink: 0,
      }}
    >
      <div style={{ position: 'relative' }}>
        <Search
          size={12}
          style={{
            position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)',
            color: 'var(--color-text-secondary)', pointerEvents: 'none',
          }}
        />
        <input
          type="text"
          aria-label="Search experts"
          placeholder="Search experts…"
          value={search}
          onChange={e => onSearchChange(e.target.value)}
          style={{
            padding: '5px 26px 5px 28px',
            borderRadius: 20,
            fontSize: 12,
            fontFamily: 'var(--font-body)',
            border: '1px solid var(--border-subtle)',
            background: 'var(--color-bg-inset)',
            color: 'var(--color-text-body)',
            outline: 'none',
            width: 240,
          }}
        />
      </div>

      <div style={{ display: 'flex', gap: 6, marginLeft: 4 }}>
        {FILTER_OPTIONS.map(o => (
          <button
            key={o.value}
            type="button"
            aria-pressed={filter === o.value}
            onClick={() => onFilterChange(o.value)}
            style={pillStyle(filter === o.value)}
          >
            {o.label}
          </button>
        ))}
      </div>

      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ position: 'relative' }} ref={sortRef}>
          <button
            type="button"
            onClick={() => setSortOpen(v => !v)}
            style={pillStyle(false)}
          >
            Sort: {activeSort?.label ?? 'Most recent activity'} <ChevronDown size={12} />
          </button>
          {sortOpen && (
            <div style={dropdownStyle}>
              {SORT_OPTIONS.map(o => (
                <button
                  key={o.value}
                  type="button"
                  onClick={() => { onSortChange(o.value); setSortOpen(false) }}
                  style={itemStyle(sort === o.value)}
                >
                  {o.label}
                </button>
              ))}
            </div>
          )}
        </div>

        <div style={{ display: 'flex', gap: 4 }}>
          <button
            type="button"
            aria-label="Card view"
            aria-pressed={viewMode === 'cards'}
            onClick={() => onViewModeChange('cards')}
            style={toggleBtn(viewMode === 'cards')}
          >
            <LayoutGrid size={12} />
          </button>
          <button
            type="button"
            aria-label="List view"
            aria-pressed={viewMode === 'list'}
            onClick={() => onViewModeChange('list')}
            style={toggleBtn(viewMode === 'list')}
          >
            <List size={12} />
          </button>
        </div>
      </div>
    </div>
  )
}
