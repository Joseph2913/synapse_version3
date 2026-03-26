import { useState, useEffect } from 'react'
import { Check, Link2, AlertTriangle } from 'lucide-react'
import { supabase } from '../../services/supabase'
import { getEntityColor } from '../../config/entityTypes'
import type { KnowledgeNode } from '../../types/database'
import type { SourceTypeFilter, OutputHorizon } from '../../types/simulate'

interface ScopeSelectorProps {
  selectedAnchorIds: string[]
  timeWindowDays: number
  sourceTypeFilter: SourceTypeFilter[] | null
  outputHorizon: OutputHorizon
  onAnchorToggle: (id: string) => void
  onTimeWindowChange: (days: number) => void
  onSourceTypeFilterChange: (filter: SourceTypeFilter[] | null) => void
  onOutputHorizonChange: (horizon: OutputHorizon) => void
}

interface ScopeStats {
  nodeCount: number
  edgeCount: number
  sourceCount: number
  chunkBreakdown: Record<string, number>
  distinctSourceCount: number
}

const TIME_OPTIONS = [
  { label: '30 days', value: 30 },
  { label: '90 days', value: 90 },
  { label: '6 months', value: 180 },
  { label: 'All time', value: 3650 },
]

const SOURCE_TYPE_OPTIONS: { label: string; value: SourceTypeFilter }[] = [
  { label: 'Meetings', value: 'meetings' },
  { label: 'Documents', value: 'documents' },
  { label: 'YouTube', value: 'youtube' },
  { label: 'Notes', value: 'notes' },
]

const OUTPUT_HORIZON_OPTIONS: { label: string; value: OutputHorizon }[] = [
  { label: '30 days', value: '30d' },
  { label: '90 days', value: '90d' },
  { label: '6 months', value: '6m' },
  { label: '1 year', value: '1y' },
  { label: '2+ years', value: '2y+' },
]

export function ScopeSelector({
  selectedAnchorIds,
  timeWindowDays,
  sourceTypeFilter,
  outputHorizon,
  onAnchorToggle,
  onTimeWindowChange,
  onSourceTypeFilterChange,
  onOutputHorizonChange,
}: ScopeSelectorProps) {
  const [anchors, setAnchors] = useState<KnowledgeNode[]>([])
  const [loading, setLoading] = useState(true)
  const [scopeStats, setScopeStats] = useState<ScopeStats | null>(null)
  const [statsLoading, setStatsLoading] = useState(false)
  const [edgeCounts, setEdgeCounts] = useState<Record<string, number>>({})

  // Load anchors
  useEffect(() => {
    async function loadAnchors() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return

      const { data } = await supabase
        .from('knowledge_nodes')
        .select('*')
        .eq('user_id', user.id)
        .eq('is_anchor', true)
        .eq('is_merged', false)
        .order('label')
      if (data) {
        setAnchors(data as KnowledgeNode[])
        const counts: Record<string, number> = {}
        for (const node of data) {
          const { count: srcCount } = await supabase
            .from('knowledge_edges')
            .select('*', { count: 'exact', head: true })
            .eq('source_node_id', node.id)
          const { count: tgtCount } = await supabase
            .from('knowledge_edges')
            .select('*', { count: 'exact', head: true })
            .eq('target_node_id', node.id)
          counts[node.id] = (srcCount ?? 0) + (tgtCount ?? 0)
        }
        setEdgeCounts(counts)
      }
      setLoading(false)
    }
    loadAnchors()
  }, [])

  // Load scope stats when selection changes
  useEffect(() => {
    if (selectedAnchorIds.length === 0) {
      setScopeStats(null)
      return
    }
    async function loadStats() {
      setStatsLoading(true)
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { setStatsLoading(false); return }

      const cutoff = new Date()
      cutoff.setDate(cutoff.getDate() - timeWindowDays)
      const cutoffISO = cutoff.toISOString()

      const { count: nodeCount } = await supabase
        .from('knowledge_nodes')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', user.id)
        .gte('created_at', cutoffISO)

      const { count: edgeCount } = await supabase
        .from('knowledge_edges')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', user.id)
        .gte('created_at', cutoffISO)

      // Fetch sources with their type for breakdown
      let sourcesQuery = supabase
        .from('knowledge_sources')
        .select('id, source_type')
        .eq('user_id', user.id)
        .gte('created_at', cutoffISO)

      if (sourceTypeFilter && sourceTypeFilter.length > 0) {
        sourcesQuery = sourcesQuery.in('source_type', sourceTypeFilter)
      }

      const { data: sources } = await sourcesQuery

      // Build source type breakdown
      const sourceBreakdown: Record<string, number> = {}
      for (const s of sources ?? []) {
        const st = (s.source_type as string) ?? 'other'
        sourceBreakdown[st] = (sourceBreakdown[st] ?? 0) + 1
      }

      // Get chunk count (source_chunks doesn't have source_type, so filter via source IDs)
      const sourceIds = (sources ?? []).map(s => s.id as string)
      let chunkCount = 0
      if (sourceIds.length > 0) {
        const { count } = await supabase
          .from('source_chunks')
          .select('*', { count: 'exact', head: true })
          .eq('user_id', user.id)
          .in('source_id', sourceIds)
        chunkCount = count ?? 0
      } else if (!sourceTypeFilter) {
        // No filter — count all chunks in time window
        const { count } = await supabase
          .from('source_chunks')
          .select('*', { count: 'exact', head: true })
          .eq('user_id', user.id)
          .gte('created_at', cutoffISO)
        chunkCount = count ?? 0
      }

      setScopeStats({
        nodeCount: nodeCount ?? 0,
        edgeCount: edgeCount ?? 0,
        sourceCount: chunkCount,
        chunkBreakdown: sourceBreakdown,
        distinctSourceCount: (sources ?? []).length,
      })
      setStatsLoading(false)
    }
    loadStats()
  }, [selectedAnchorIds, timeWindowDays, sourceTypeFilter])

  const handleSourceTypeToggle = (type: SourceTypeFilter) => {
    if (!sourceTypeFilter) {
      // Switching from "All" to a specific type
      onSourceTypeFilterChange([type])
    } else if (sourceTypeFilter.includes(type)) {
      const next = sourceTypeFilter.filter(t => t !== type)
      onSourceTypeFilterChange(next.length === 0 ? null : next)
    } else {
      onSourceTypeFilterChange([...sourceTypeFilter, type])
    }
  }

  const isAllSelected = sourceTypeFilter === null

  if (loading) {
    return (
      <div>
        <div
          className="font-display"
          style={{ fontSize: 10, fontWeight: 700, color: 'var(--color-text-secondary)', letterSpacing: '0.08em', marginBottom: 12 }}
        >
          KNOWLEDGE SCOPE
        </div>
        <div className="grid grid-cols-2 gap-3">
          {[1, 2, 3, 4].map(i => (
            <div
              key={i}
              style={{
                height: 72,
                borderRadius: 12,
                background: 'var(--color-bg-inset)',
                animation: 'pulse 1.5s ease-in-out infinite',
              }}
            />
          ))}
        </div>
      </div>
    )
  }

  if (anchors.length === 0) {
    return (
      <div>
        <div
          className="font-display"
          style={{ fontSize: 10, fontWeight: 700, color: 'var(--color-text-secondary)', letterSpacing: '0.08em', marginBottom: 12 }}
        >
          KNOWLEDGE SCOPE
        </div>
        <div
          style={{
            padding: '24px 20px',
            background: 'var(--color-bg-inset)',
            borderRadius: 12,
            textAlign: 'center',
          }}
        >
          <p className="font-body" style={{ fontSize: 13, color: 'var(--color-text-secondary)', margin: 0 }}>
            No anchors in your graph yet. Promote key nodes to anchors in Explore or Settings.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div>
      <div
        className="font-display"
        style={{ fontSize: 10, fontWeight: 700, color: 'var(--color-text-secondary)', letterSpacing: '0.08em', marginBottom: 12 }}
      >
        KNOWLEDGE SCOPE
      </div>

      {/* Anchor cards grid */}
      <div className="grid grid-cols-2 gap-3" style={{ marginBottom: 16 }}>
        {anchors.map(anchor => {
          const isSelected = selectedAnchorIds.includes(anchor.id)
          const color = getEntityColor(anchor.entity_type)
          return (
            <button
              key={anchor.id}
              type="button"
              onClick={() => onAnchorToggle(anchor.id)}
              className="relative text-left cursor-pointer"
              style={{
                padding: '12px 14px',
                borderRadius: 12,
                border: isSelected
                  ? '1px solid var(--color-accent-500)'
                  : '1px solid rgba(0,0,0,0.10)',
                background: isSelected ? 'var(--color-accent-50)' : 'white',
                transition: 'all 0.15s ease',
              }}
            >
              {isSelected && (
                <div
                  className="absolute flex items-center justify-center"
                  style={{
                    top: 8, right: 8, width: 18, height: 18,
                    borderRadius: 9, background: 'var(--color-accent-500)',
                  }}
                >
                  <Check size={11} color="white" strokeWidth={2.5} />
                </div>
              )}
              <div className="flex items-center gap-2" style={{ marginBottom: 4 }}>
                <div style={{ width: 6, height: 6, borderRadius: 3, background: color, flexShrink: 0 }} />
                <span className="font-body" style={{ fontSize: 14, fontWeight: 500, color: 'var(--color-text-primary)' }}>
                  {anchor.label}
                </span>
              </div>
              {anchor.description && (
                <p
                  className="font-body"
                  style={{
                    fontSize: 12, color: 'var(--color-text-secondary)', margin: '0 0 6px 0',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}
                >
                  {anchor.description}
                </p>
              )}
              <div className="flex items-center gap-1">
                <Link2 size={11} style={{ color: 'var(--color-text-secondary)' }} />
                <span className="font-body" style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>
                  {edgeCounts[anchor.id] ?? 0} connections
                </span>
              </div>
            </button>
          )
        })}
      </div>

      {/* Time window selector */}
      <div
        style={{
          display: 'flex', alignItems: 'center', gap: 4,
          padding: 4, borderRadius: 20,
          background: 'var(--color-bg-inset)',
          marginBottom: 16,
        }}
      >
        {TIME_OPTIONS.map(opt => {
          const isActive = opt.value === timeWindowDays
          return (
            <button
              key={opt.value}
              type="button"
              onClick={() => onTimeWindowChange(opt.value)}
              className="font-body font-semibold cursor-pointer"
              style={{
                flex: 1,
                padding: '5px 13px',
                borderRadius: 16,
                fontSize: 12,
                border: 'none',
                background: isActive ? 'white' : 'transparent',
                color: isActive ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
                boxShadow: isActive ? '0 1px 3px rgba(0,0,0,0.08)' : 'none',
                transition: 'all 0.15s ease',
              }}
            >
              {opt.label}
            </button>
          )
        })}
      </div>

      {/* Source type filter */}
      <div style={{ marginBottom: 16 }}>
        <div
          className="font-display"
          style={{ fontSize: 10, fontWeight: 700, color: 'var(--color-text-secondary)', letterSpacing: '0.08em', marginBottom: 8 }}
        >
          SOURCE TYPE FILTER
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => onSourceTypeFilterChange(null)}
            className="font-body font-semibold cursor-pointer"
            style={{
              fontSize: 12,
              padding: '5px 13px',
              borderRadius: 20,
              border: isAllSelected
                ? '1px solid rgba(214,58,0,0.15)'
                : '1px solid var(--border-subtle)',
              background: isAllSelected ? 'var(--color-accent-50)' : 'transparent',
              color: isAllSelected ? 'var(--color-accent-500)' : 'var(--color-text-secondary)',
              transition: 'all 0.15s ease',
            }}
          >
            All
          </button>
          {SOURCE_TYPE_OPTIONS.map(opt => {
            const isActive = sourceTypeFilter?.includes(opt.value) ?? false
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => handleSourceTypeToggle(opt.value)}
                className="font-body font-semibold cursor-pointer"
                style={{
                  fontSize: 12,
                  padding: '5px 13px',
                  borderRadius: 20,
                  border: isActive
                    ? '1px solid rgba(214,58,0,0.15)'
                    : '1px solid var(--border-subtle)',
                  background: isActive ? 'var(--color-accent-50)' : 'transparent',
                  color: isActive ? 'var(--color-accent-500)' : 'var(--color-text-secondary)',
                  transition: 'all 0.15s ease',
                }}
              >
                {opt.label}
              </button>
            )
          })}
        </div>
      </div>

      {/* Output horizon */}
      <div style={{ marginBottom: 16 }}>
        <div
          className="font-display"
          style={{ fontSize: 10, fontWeight: 700, color: 'var(--color-text-secondary)', letterSpacing: '0.08em', marginBottom: 8 }}
        >
          FORECAST SHOULD BE VALID FOR
        </div>
        <div
          style={{
            display: 'flex', alignItems: 'center', gap: 4,
            padding: 4, borderRadius: 20,
            background: 'var(--color-bg-inset)',
          }}
        >
          {OUTPUT_HORIZON_OPTIONS.map(opt => {
            const isActive = opt.value === outputHorizon
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => onOutputHorizonChange(opt.value)}
                className="font-body font-semibold cursor-pointer"
                style={{
                  flex: 1,
                  padding: '5px 13px',
                  borderRadius: 16,
                  fontSize: 12,
                  border: 'none',
                  background: isActive ? 'white' : 'transparent',
                  color: isActive ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
                  boxShadow: isActive ? '0 1px 3px rgba(0,0,0,0.08)' : 'none',
                  transition: 'all 0.15s ease',
                }}
              >
                {opt.label}
              </button>
            )
          })}
        </div>
      </div>

      {/* Scope stats preview */}
      {selectedAnchorIds.length > 0 && (
        <div
          style={{
            padding: '10px 14px',
            borderRadius: 12,
            background: 'var(--color-bg-inset)',
          }}
        >
          {statsLoading ? (
            <span className="font-body" style={{ fontSize: 12, color: 'var(--color-text-placeholder)', opacity: 0.5 }}>
              Loading scope…
            </span>
          ) : scopeStats ? (
            <div className="flex flex-col gap-1">
              <div className="font-body flex flex-wrap gap-2" style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
                <span>~{scopeStats.nodeCount} entities</span>
                <span>·</span>
                <span>~{scopeStats.edgeCount} relationships</span>
                <span>·</span>
                <span>{scopeStats.distinctSourceCount} sources</span>
                <span>·</span>
                <span>{scopeStats.sourceCount} chunks</span>
              </div>
              {/* Source type breakdown */}
              {Object.keys(scopeStats.chunkBreakdown).length > 0 && (
                <div className="font-body flex flex-wrap gap-2" style={{ fontSize: 11, color: 'var(--color-text-placeholder)' }}>
                  {Object.entries(scopeStats.chunkBreakdown).map(([type, count]) => (
                    <span key={type}>{count} {type}</span>
                  ))}
                </div>
              )}
              {/* Low source diversity warning */}
              {scopeStats.distinctSourceCount < 3 && (
                <div className="flex items-center gap-1" style={{ marginTop: 4 }}>
                  <AlertTriangle size={12} style={{ color: '#d97706', flexShrink: 0 }} />
                  <span className="font-body" style={{ fontSize: 11, color: '#b45309' }}>
                    Low source diversity may limit emergence.
                  </span>
                </div>
              )}
            </div>
          ) : null}
        </div>
      )}
    </div>
  )
}
