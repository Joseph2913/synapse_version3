import { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import { Plus, GripVertical, Anchor, ChevronDown } from 'lucide-react'
import { useAnchorCandidates, type AnchorFilterKey, type AnchorSortKey } from '../hooks/useAnchorCandidates'
import { promoteToSubAnchor } from '../services/anchorCandidates'
import { supabase } from '../services/supabase'
import { AnchorCard } from '../components/anchors/AnchorCard'
import { AnchorDetailPanel } from '../components/anchors/AnchorDetailPanel'
import { AnchorHealthPanel } from '../components/anchors/AnchorHealthPanel'
import { AnchorCreateForm } from '../components/anchors/AnchorCreateForm'

const DEFAULT_LEFT_PCT = 65
const MIN_LEFT_PCT = 30
const MAX_LEFT_PCT = 80

const FILTER_KEYS: AnchorFilterKey[] = ['all', 'confirmed', 'suggested', 'manual', 'dormant', 'archived']
const FILTER_LABELS: Record<AnchorFilterKey, string> = {
  all: 'All',
  confirmed: 'Confirmed',
  suggested: 'Suggested',
  manual: 'Manual',
  dormant: 'Dormant',
  archived: 'Archived',
}

const SORT_OPTIONS: { value: AnchorSortKey; label: string }[] = [
  { value: 'most_connected', label: 'Most Connected' },
  { value: 'recently_added', label: 'Recently Added' },
  { value: 'alphabetical', label: 'Alphabetical' },
  { value: 'dormant_first', label: 'Dormant First' },
]

function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="font-display font-bold uppercase"
      style={{ fontSize: 10, letterSpacing: '0.08em', color: 'var(--color-text-secondary)', marginBottom: 10 }}
    >
      {children}
    </div>
  )
}

export function AnchorsView() {
  const {
    suggested, confirmed, archived, health, suggestedCount,
    loading, healthLoading, error,
    filter, setFilter, sortKey, setSortKey,
    filteredConfirmed, filteredSuggested, filteredArchived, totalCount, lastScoredAt,
    confirm, dismiss, dismissAll, archive, restore, createManual, refetch,
  } = useAnchorCandidates()

  const [selectedCandidateId, setSelectedCandidateId] = useState<string | null>(null)
  const [showCreateForm, setShowCreateForm] = useState(false)
  const [leftWidthPct, setLeftWidthPct] = useState(DEFAULT_LEFT_PCT)
  const [isDragging, setIsDragging] = useState(false)
  const [toast, setToast] = useState<{ text: string; color: string } | null>(null)
  const [sortOpen, setSortOpen] = useState(false)

  const containerRef = useRef<HTMLDivElement>(null)
  const dragStartX = useRef(0)
  const dragStartPct = useRef(DEFAULT_LEFT_PCT)
  const sortRef = useRef<HTMLDivElement>(null)

  // All candidates combined for lookup
  const allCandidates = useMemo(() => [...suggested, ...confirmed, ...archived], [suggested, confirmed, archived])
  const selectedCandidate = selectedCandidateId ? allCandidates.find(c => c.id === selectedCandidateId) ?? null : null

  // Filter counts
  const filterCounts = useMemo(() => ({
    all: confirmed.length + suggested.length,
    confirmed: confirmed.filter(c => c.status === 'confirmed').length,
    suggested: suggested.length,
    manual: confirmed.filter(c => c.compositeScore === 1.0).length,
    dormant: confirmed.filter(c => c.status === 'dormant').length,
    archived: archived.length,
  }), [confirmed, suggested, archived])

  // Toast helper
  const showToast = useCallback((text: string, color: string) => {
    setToast({ text, color })
    setTimeout(() => setToast(null), 2000)
  }, [])

  // Handlers
  const handleCardClick = (id: string) => {
    setShowCreateForm(false)
    setSelectedCandidateId(prev => prev === id ? null : id)
  }

  const handleNewAnchor = () => {
    setSelectedCandidateId(null)
    setShowCreateForm(true)
  }

  const handleConfirm = useCallback(async (candidateId: string, nodeId: string) => {
    await confirm(candidateId, nodeId)
    if (selectedCandidateId === candidateId) setSelectedCandidateId(null)
    showToast('✦ Anchor confirmed', '#22c55e')
  }, [confirm, selectedCandidateId, showToast])

  const handleDismiss = useCallback(async (candidateId: string, dismissCount: number) => {
    await dismiss(candidateId, dismissCount)
    if (selectedCandidateId === candidateId) setSelectedCandidateId(null)
  }, [dismiss, selectedCandidateId])

  const handleArchive = useCallback(async (candidateId: string, nodeId: string) => {
    await archive(candidateId, nodeId)
    if (selectedCandidateId === candidateId) setSelectedCandidateId(null)
  }, [archive, selectedCandidateId])

  const handleCreateSaved = useCallback(async (nodeId: string) => {
    await createManual(nodeId)
    setShowCreateForm(false)
    showToast('✦ Anchor created', '#22c55e')
  }, [createManual, showToast])

  const handleConfirmAsSubAnchor = useCallback(async (candidateId: string, nodeId: string, parentId: string) => {
    const success = await promoteToSubAnchor(candidateId, nodeId, parentId)
    if (success) {
      if (selectedCandidateId === candidateId) setSelectedCandidateId(null)
      showToast('✦ Sub-anchor confirmed', '#22c55e')
      refetch()
      window.dispatchEvent(new CustomEvent('synapse:anchor-confirmed', { detail: { nodeId } }))
      window.dispatchEvent(new CustomEvent('synapse:anchor-suggestions-changed'))
    }
  }, [selectedCandidateId, showToast, refetch])

  const handleRestore = useCallback(async (candidateId: string, nodeId: string) => {
    await restore(candidateId, nodeId)
    if (selectedCandidateId === candidateId) setSelectedCandidateId(null)
    showToast('✦ Anchor restored', '#22c55e')
  }, [restore, selectedCandidateId, showToast])

  const handleDeleteCandidate = useCallback(async (candidateId: string) => {
    await supabase.from('anchor_candidates').delete().eq('id', candidateId)
    if (selectedCandidateId === candidateId) setSelectedCandidateId(null)
    refetch()
  }, [selectedCandidateId, refetch])

  // Escape key
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setSelectedCandidateId(null)
        setShowCreateForm(false)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  // Click outside sort dropdown
  useEffect(() => {
    if (!sortOpen) return
    const handler = (e: MouseEvent) => {
      if (sortRef.current && !sortRef.current.contains(e.target as Node)) setSortOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [sortOpen])

  // Drag resize
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

  // Right panel content
  let rightContent: React.ReactNode
  if (showCreateForm) {
    rightContent = <AnchorCreateForm onSave={handleCreateSaved} onClose={() => setShowCreateForm(false)} />
  } else if (selectedCandidate) {
    rightContent = (
      <AnchorDetailPanel
        candidate={selectedCandidate}
        onClose={() => setSelectedCandidateId(null)}
        onConfirm={handleConfirm}
        onConfirmAsSubAnchor={handleConfirmAsSubAnchor}
        onDismiss={handleDismiss}
        onArchive={handleArchive}
        onDelete={handleDeleteCandidate}
        onRestore={handleRestore}
        onRefresh={refetch}
        onSelectSubAnchor={(nodeId) => {
          const target = [...filteredConfirmed, ...filteredSuggested].find(c => c.nodeId === nodeId)
          if (target) setSelectedCandidateId(target.id)
        }}
      />
    )
  } else {
    rightContent = (
      <AnchorHealthPanel
        health={health}
        loading={healthLoading}
        suggestedCount={suggestedCount}
        onSelectCandidate={id => { setShowCreateForm(false); setSelectedCandidateId(id) }}
      />
    )
  }

  const isEmpty = !loading && totalCount === 0

  return (
    <div className="flex flex-col h-full">
      {/* Control bar */}
      <div
        className="flex items-center shrink-0"
        style={{
          background: 'var(--color-bg-card)',
          borderBottom: '1px solid var(--border-subtle)',
          padding: '8px 24px',
          minHeight: 44,
          gap: 8,
          flexWrap: 'wrap',
        }}
      >
        {/* Filter pills */}
        {FILTER_KEYS.map(key => {
          const isActive = filter === key
          const count = filterCounts[key]
          const isSuggestedAmber = (key === 'suggested' && count > 0) || key === 'archived'

          return (
            <button
              key={key}
              type="button"
              onClick={() => setFilter(key)}
              className="font-body font-semibold"
              style={{
                padding: '5px 13px',
                borderRadius: 20,
                fontSize: 12,
                border: `1px solid ${
                  isActive
                    ? isSuggestedAmber ? 'rgba(245,158,11,0.25)' : 'rgba(214,58,0,0.15)'
                    : 'var(--border-subtle)'
                }`,
                background: isActive
                  ? isSuggestedAmber ? 'rgba(245,158,11,0.08)' : 'var(--color-accent-50)'
                  : 'transparent',
                color: isActive
                  ? isSuggestedAmber ? '#d97706' : 'var(--color-accent-500)'
                  : 'var(--color-text-secondary)',
                cursor: 'pointer',
                transition: 'all 0.15s ease',
              }}
            >
              {FILTER_LABELS[key]} {count > 0 ? `(${count})` : ''}
            </button>
          )
        })}

        {/* Divider */}
        <div style={{ width: 1, height: 24, background: 'var(--border-subtle)', margin: '0 4px' }} />

        {/* Stats strip */}
        <div className="flex items-center gap-2 font-body" style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
          <span>{confirmed.length} anchors</span>
          <span>·</span>
          <span style={{ color: suggestedCount > 0 ? '#d97706' : undefined, fontWeight: suggestedCount > 0 ? 600 : undefined }}>
            {suggestedCount} suggested
          </span>
          {lastScoredAt && (
            <>
              <span>·</span>
              <span>scored {formatRelativeTime(lastScoredAt)}</span>
            </>
          )}
        </div>

        <div className="flex-1" />

        {/* New Anchor button */}
        <button
          type="button"
          onClick={handleNewAnchor}
          className="flex items-center gap-1 font-body font-semibold"
          style={{
            background: showCreateForm ? 'var(--color-accent-50)' : 'var(--color-accent-500)',
            color: showCreateForm ? 'var(--color-accent-500)' : 'white',
            border: showCreateForm ? '1px solid rgba(214,58,0,0.15)' : '1px solid transparent',
            fontSize: 12, padding: '7px 14px', borderRadius: 8, cursor: 'pointer',
          }}
        >
          <Plus size={14} /> New Anchor
        </button>
      </div>

      {/* Main content */}
      <div
        ref={containerRef}
        className="flex flex-1 overflow-hidden"
        style={{ cursor: isDragging ? 'col-resize' : undefined, userSelect: isDragging ? 'none' : undefined }}
      >
        {/* Left column */}
        <div style={{ width: `${leftWidthPct}%`, overflowY: 'auto', background: 'var(--color-bg-content)', flexShrink: 0 }}>
          <div style={{ padding: '20px 36px' }}>
            {/* Loading state */}
            {loading && (
              <div className="flex flex-col gap-2">
                {[0, 1, 2].map(i => (
                  <div key={i} style={{ height: 80, background: 'var(--color-bg-inset)', borderRadius: 12, animation: 'pulse 1.5s ease infinite' }} />
                ))}
              </div>
            )}

            {/* Error state */}
            {error && (
              <div style={{ textAlign: 'center', padding: '40px 0' }}>
                <p className="font-body" style={{ fontSize: 13, color: '#ef4444', marginBottom: 12 }}>{error}</p>
                <button type="button" onClick={refetch} className="font-body" style={{
                  background: 'var(--color-accent-500)', color: 'white', fontSize: 12, fontWeight: 600,
                  padding: '8px 16px', borderRadius: 8, border: 'none', cursor: 'pointer',
                }}>Retry</button>
              </div>
            )}

            {/* Empty state */}
            {isEmpty && !error && (
              <div style={{ textAlign: 'center', padding: '60px 0' }}>
                <Anchor size={36} style={{ color: 'var(--color-text-placeholder, var(--color-text-secondary))', margin: '0 auto 12px', display: 'block', opacity: 0.4 }} />
                <h3 className="font-display" style={{ fontSize: 15, fontWeight: 700, color: 'var(--color-text-primary)', marginBottom: 6 }}>
                  Your knowledge graph has no anchors
                </h3>
                <p className="font-body" style={{ fontSize: 13, color: 'var(--color-text-secondary)', maxWidth: 320, margin: '0 auto 16px' }}>
                  The system will suggest anchors automatically after you ingest content. Or create your first one manually.
                </p>
                <button type="button" onClick={handleNewAnchor} className="font-body" style={{
                  background: 'var(--color-accent-500)', color: 'white', fontSize: 12, fontWeight: 600,
                  padding: '8px 16px', borderRadius: 8, border: 'none', cursor: 'pointer',
                }}>Create Your First Anchor</button>
              </div>
            )}

            {/* SUGGESTED section */}
            {!loading && filteredSuggested.length > 0 && (
              <div style={{ marginBottom: 24 }}>
                <SectionLabel>Suggested</SectionLabel>

                {/* Batch review bar */}
                {filteredSuggested.length >= 3 && (
                  <div
                    className="flex items-center justify-between"
                    style={{
                      background: 'rgba(245,158,11,0.06)', border: '1px solid rgba(245,158,11,0.2)',
                      borderRadius: 10, padding: '10px 14px', marginBottom: 8,
                    }}
                  >
                    <span className="font-body" style={{ fontSize: 12, color: '#d97706' }}>
                      ✦ {filteredSuggested.length} new clusters detected from recent ingestion
                    </span>
                    <div className="flex items-center gap-2">
                      <button type="button" onClick={() => { if (filteredSuggested[0]) handleCardClick(filteredSuggested[0].id) }}
                        className="font-body font-semibold" style={{ fontSize: 11, color: '#d97706', background: 'none', border: 'none', cursor: 'pointer' }}>
                        Review All
                      </button>
                      <button type="button" onClick={() => { if (window.confirm('Dismiss all suggestions?')) dismissAll() }}
                        className="font-body" style={{ fontSize: 11, color: 'var(--color-text-secondary)', background: 'none', border: 'none', cursor: 'pointer' }}>
                        Skip All
                      </button>
                    </div>
                  </div>
                )}

                <div className="flex flex-col gap-2" style={{ contentVisibility: 'auto' }}>
                  {filteredSuggested.map((c, i) => (
                    <AnchorCard
                      key={c.id}
                      candidate={c}
                      isSelected={selectedCandidateId === c.id}
                      onClick={() => handleCardClick(c.id)}
                      onConfirm={handleConfirm}
                      onDismiss={handleDismiss}
                      onDelete={handleDeleteCandidate}
                      index={i}
                    />
                  ))}
                </div>
              </div>
            )}

            {/* YOUR ANCHORS section */}
            {!loading && filteredConfirmed.length > 0 && (
              <div>
                <div className="flex items-center justify-between" style={{ marginBottom: 10 }}>
                  <SectionLabel>Your Anchors</SectionLabel>

                  {/* Sort dropdown */}
                  <div ref={sortRef} style={{ position: 'relative' }}>
                    <button
                      type="button"
                      onClick={() => setSortOpen(p => !p)}
                      className="font-body font-semibold flex items-center gap-1"
                      style={{
                        fontSize: 11, color: 'var(--color-text-secondary)',
                        background: 'transparent', border: '1px solid var(--border-subtle)',
                        borderRadius: 20, padding: '3px 10px', cursor: 'pointer',
                      }}
                    >
                      {SORT_OPTIONS.find(o => o.value === sortKey)?.label}
                      <ChevronDown size={10} />
                    </button>

                    {sortOpen && (
                      <div style={{
                        position: 'absolute', top: '100%', right: 0, marginTop: 4,
                        background: 'var(--color-bg-card)', border: '1px solid var(--border-strong, var(--border-subtle))',
                        borderRadius: 10, boxShadow: '0 4px 16px rgba(0,0,0,0.08)', padding: 4, zIndex: 50, minWidth: 150,
                      }}>
                        {SORT_OPTIONS.map(opt => (
                          <button
                            key={opt.value}
                            type="button"
                            onClick={() => { setSortKey(opt.value); setSortOpen(false) }}
                            className="font-body block w-full text-left"
                            style={{
                              padding: '8px 14px', borderRadius: 6, border: 'none', fontSize: 12,
                              background: opt.value === sortKey ? 'var(--color-accent-50)' : 'transparent',
                              color: opt.value === sortKey ? 'var(--color-accent-500)' : 'var(--color-text-body)',
                              fontWeight: opt.value === sortKey ? 600 : 500, cursor: 'pointer',
                            }}
                            onMouseEnter={e => { if (opt.value !== sortKey) e.currentTarget.style.background = 'var(--color-bg-inset)' }}
                            onMouseLeave={e => { if (opt.value !== sortKey) e.currentTarget.style.background = 'transparent' }}
                          >
                            {opt.label}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                <div className="flex flex-col gap-2" style={{ contentVisibility: 'auto' }}>
                  {(() => {
                    // Build hierarchical list: root anchors + their sub-anchors inline
                    const roots = filteredConfirmed.filter(c => !c.node?.parent_anchor_id)
                    const subs  = filteredConfirmed.filter(c => !!c.node?.parent_anchor_id)
                    const ordered: Array<typeof filteredConfirmed[0] & { _parentLabel?: string }> = []
                    for (const root of roots) {
                      ordered.push(root)
                      const children = subs.filter(s => s.node?.parent_anchor_id === root.nodeId)
                      for (const child of children) {
                        ordered.push({ ...child, _parentLabel: root.node?.label ?? undefined })
                      }
                    }
                    const addedIds = new Set(ordered.map(r => r.id))
                    for (const sub of subs) {
                      if (!addedIds.has(sub.id)) ordered.push(sub)
                    }
                    return ordered
                  })().map((c, i) => (
                    <div key={c.id} style={{ marginLeft: (c as { _parentLabel?: string })._parentLabel ? 16 : 0 }}>
                    <AnchorCard
                      candidate={c}
                      isSelected={selectedCandidateId === c.id}
                      onClick={() => handleCardClick(c.id)}
                      onConfirm={handleConfirm}
                      onDismiss={handleDismiss}
                      onDelete={handleDeleteCandidate}
                      index={i + filteredSuggested.length}
                      parentLabel={(c as { _parentLabel?: string })._parentLabel}
                    />
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Archived section */}
            {!loading && filteredArchived.length > 0 && (
              <div style={{ marginTop: 16 }}>
                <SectionLabel>
                  <span style={{ color: '#d97706' }}>Archived ({filteredArchived.length})</span>
                </SectionLabel>
                <div className="flex flex-col gap-2" style={{ marginTop: 8, opacity: 0.7 }}>
                  {filteredArchived.map((c, i) => (
                    <AnchorCard
                      key={c.id}
                      candidate={c}
                      isSelected={selectedCandidateId === c.id}
                      onClick={() => handleCardClick(c.id)}
                      onConfirm={handleConfirm}
                      onDismiss={handleDismiss}
                      onDelete={handleDeleteCandidate}
                      index={i + filteredSuggested.length + filteredConfirmed.length}
                    />
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Drag divider */}
        <div
          onMouseDown={handleDividerMouseDown}
          className="flex items-center justify-center shrink-0"
          style={{
            width: 12,
            cursor: 'col-resize',
            background: isDragging ? 'rgba(214,58,0,0.04)' : 'transparent',
            transition: 'background 0.15s ease',
          }}
          onMouseEnter={e => { if (!isDragging) e.currentTarget.style.background = 'rgba(0,0,0,0.02)' }}
          onMouseLeave={e => { if (!isDragging) e.currentTarget.style.background = 'transparent' }}
        >
          <GripVertical
            size={14}
            style={{ color: isDragging ? 'var(--color-accent-500)' : 'var(--color-text-placeholder, var(--color-text-secondary))', transition: 'color 0.15s ease' }}
          />
        </div>

        {/* Right panel */}
        <div style={{ flex: 1, height: '100%', overflow: 'hidden', minWidth: 0, background: 'var(--color-bg-card)' }}>
          {rightContent}
        </div>
      </div>

      {/* Toast */}
      {toast && (
        <div
          style={{
            position: 'fixed', bottom: 24, left: 80, zIndex: 999,
            background: 'var(--color-bg-card)', border: `1px solid ${toast.color}30`,
            borderRadius: 8, padding: '8px 16px', boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
            animation: 'fadeUp 0.3s ease',
          }}
        >
          <span className="font-body" style={{ fontSize: 12, fontWeight: 600, color: toast.color }}>
            {toast.text}
          </span>
        </div>
      )}

      {/* Keyframe animations */}
      <style>{`
        @keyframes fadeUp {
          from { opacity: 0; transform: translateY(8px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @keyframes slideInRight {
          from { opacity: 0; transform: translateX(12px); }
          to { opacity: 1; transform: translateX(0); }
        }
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.5; }
        }
      `}</style>
    </div>
  )
}
