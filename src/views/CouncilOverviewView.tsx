import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { CouncilSummaryStrip } from '../components/council/CouncilSummaryStrip'
import { CouncilControlsBar, type FilterValue, type SortValue, type ViewMode } from '../components/council/CouncilControlsBar'
import { ExpertGrid } from '../components/council/ExpertGrid'
import { useCouncilOverview } from '../hooks/useCouncilOverview'
import type { CouncilOverviewAgent, CouncilHealthStatus } from '../types/council'

const VIEW_MODE_STORAGE_KEY = 'synapse:council:viewMode'

const HEALTH_RANK: Record<CouncilHealthStatus, number> = {
  strong: 0,
  growing: 1,
  thin: 2,
  stale: 3,
  initialising: 4,
}

function isActiveThisWeek(a: CouncilOverviewAgent): boolean {
  return (
    a.insights_this_week + a.answered_this_week + a.novel_this_week + a.new_skills_this_week > 0
  )
}

function needsAttention(a: CouncilOverviewAgent): boolean {
  return a.health_status === 'thin' || a.health_status === 'stale' || a.significant_gap_count > 0
}

function hydrateViewMode(): ViewMode {
  if (typeof window === 'undefined') return 'cards'
  const raw = window.localStorage.getItem(VIEW_MODE_STORAGE_KEY)
  return raw === 'list' ? 'list' : 'cards'
}

export function CouncilOverviewView() {
  const navigate = useNavigate()
  const { summary, agents, loading, error, refresh } = useCouncilOverview()

  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<FilterValue>('all')
  const [sort, setSort] = useState<SortValue>('recent')
  const [viewMode, setViewMode] = useState<ViewMode>(hydrateViewMode)
  const [isRecalibrating, setIsRecalibrating] = useState(false)

  useEffect(() => {
    if (typeof window === 'undefined') return
    window.localStorage.setItem(VIEW_MODE_STORAGE_KEY, viewMode)
  }, [viewMode])

  const filteredAgents = useMemo(() => {
    const q = search.trim().toLowerCase()
    let result = agents

    if (q) {
      result = result.filter(a =>
        a.name.toLowerCase().includes(q) ||
        (a.description ?? '').toLowerCase().includes(q),
      )
    }

    if (filter === 'active') {
      result = result.filter(isActiveThisWeek)
    } else if (filter === 'needs_attention') {
      result = result.filter(needsAttention)
    }

    const sorted = [...result]
    switch (sort) {
      case 'alpha':
        sorted.sort((a, b) => a.name.localeCompare(b.name))
        break
      case 'sources':
        sorted.sort((a, b) => b.source_count - a.source_count || a.name.localeCompare(b.name))
        break
      case 'health':
        sorted.sort((a, b) => (HEALTH_RANK[a.health_status] ?? 5) - (HEALTH_RANK[b.health_status] ?? 5) || a.name.localeCompare(b.name))
        break
      case 'recent':
      default:
        sorted.sort((a, b) => {
          const at = a.last_activity_at ? new Date(a.last_activity_at).getTime() : -Infinity
          const bt = b.last_activity_at ? new Date(b.last_activity_at).getTime() : -Infinity
          if (at === bt) return a.name.localeCompare(b.name)
          return bt - at
        })
        break
    }

    if (sort !== 'alpha') {
      const active = sorted.filter(isActiveThisWeek)
      const quiet = sorted.filter(a => !isActiveThisWeek(a))
      return [...active, ...quiet]
    }
    return sorted
  }, [agents, search, filter, sort])

  const handleRecalibrate = useCallback(async () => {
    setIsRecalibrating(true)
    try {
      const res = await fetch('/api/council/cron', { method: 'POST', headers: { 'Content-Type': 'application/json' } })
      if (!res.ok) console.error('[CouncilOverview] Recalibrate failed:', await res.text())
    } catch (err) {
      console.error('[CouncilOverview] Recalibrate failed:', err)
    } finally {
      await refresh()
      setIsRecalibrating(false)
    }
  }, [refresh])

  const handleOpenAgent = useCallback((agentId: string) => {
    navigate(`/council/${agentId}`)
  }, [navigate])

  const handleOpenNovel = useCallback((agentId: string) => {
    navigate(`/council/${agentId}?focus=novel`)
  }, [navigate])

  const handleClearFilters = useCallback(() => {
    setSearch('')
    setFilter('all')
  }, [])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <style>{`@keyframes spin { from { transform: rotate(0deg) } to { transform: rotate(360deg) } }`}</style>

      <CouncilSummaryStrip
        summary={summary}
        isRecalibrating={isRecalibrating}
        onRecalibrate={handleRecalibrate}
      />

      <CouncilControlsBar
        search={search}
        onSearchChange={setSearch}
        filter={filter}
        onFilterChange={setFilter}
        sort={sort}
        onSortChange={setSort}
        viewMode={viewMode}
        onViewModeChange={setViewMode}
      />

      <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', background: 'var(--color-bg-content)' }}>
        {loading && agents.length === 0 ? (
          <div style={{ padding: '64px 24px', textAlign: 'center', fontSize: 13, color: 'var(--color-text-secondary)', fontFamily: 'var(--font-body)' }}>
            Loading council...
          </div>
        ) : error ? (
          <div style={{ padding: '64px 24px', textAlign: 'center', fontSize: 13, color: '#dc2626', fontFamily: 'var(--font-body)' }}>
            {error}
          </div>
        ) : (
          <ExpertGrid
            agents={filteredAgents}
            viewMode={viewMode}
            onOpenAgent={handleOpenAgent}
            onOpenNovel={handleOpenNovel}
            onClearFilters={handleClearFilters}
            hasAnyAgents={agents.length > 0}
          />
        )}
      </div>
    </div>
  )
}
