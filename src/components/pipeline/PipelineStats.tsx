import { TrendingUp, BarChart3, Clock, Star, AlertTriangle, Target, GitMerge, X } from 'lucide-react'
import { ProviderIcon } from '../shared/ProviderIcon'
import { getEntityColor } from '../../config/entityTypes'
import type { PipelineMetrics, PipelineHistoryItem } from '../../types/pipeline'
import type { PotentialDuplicatePair } from '../../services/deduplication'

interface PipelineStatsProps {
  metrics: PipelineMetrics
  allItems: PipelineHistoryItem[]
  loading: boolean
  pendingDuplicatesCount?: number
  pendingDuplicates?: PotentialDuplicatePair[]
  onMerge?: (canonicalId: string, mergeId: string, pairId: string) => void
  onKeepSeparate?: (pairId: string) => void
}

export function PipelineStats({
  metrics,
  allItems,
  loading,
  pendingDuplicatesCount = 0,
  pendingDuplicates = [],
  onMerge,
  onKeepSeparate,
}: PipelineStatsProps) {
  const avgSec = metrics.avgDuration > 0 ? (metrics.avgDuration / 1000).toFixed(1) : '—'
  const ratingDisplay = metrics.ratedCount > 0 ? metrics.avgRating.toFixed(1) : '—'

  // Compute average confidence across all completed items
  const completedItems = allItems.filter(i => i.status === 'completed' && i.confidence > 0)
  const avgConfidence = completedItems.length > 0
    ? Math.round(completedItems.reduce((sum, i) => sum + i.confidence, 0) / completedItems.length * 100)
    : 0

  const confidenceColor = avgConfidence > 85
    ? 'var(--semantic-green-500, #22c55e)'
    : avgConfidence > 70
      ? 'var(--semantic-amber-500, #f59e0b)'
      : avgConfidence > 0
        ? 'var(--semantic-red-500, #ef4444)'
        : 'var(--color-text-secondary)'

  // Source distribution
  const sourceAgg: Record<string, number> = {}
  for (const item of allItems) {
    if (item.status === 'pending' || item.status === 'processing') continue
    const t = item.sourceType
    sourceAgg[t] = (sourceAgg[t] ?? 0) + 1
  }
  const sourceEntries = Object.entries(sourceAgg).sort((a, b) => b[1] - a[1])
  const maxSourceCount = sourceEntries.length > 0 ? (sourceEntries[0]?.[1] ?? 0) : 0

  const stats = [
    {
      label: 'Sources This Week',
      value: String(metrics.sourcesThisWeek),
      icon: TrendingUp,
      color: 'var(--color-text-primary)',
    },
    {
      label: 'Entities Extracted',
      value: String(metrics.entitiesThisWeek),
      icon: BarChart3,
      color: 'var(--color-text-primary)',
    },
    {
      label: 'Avg Processing Time',
      value: `${avgSec}s`,
      icon: Clock,
      color: 'var(--color-text-primary)',
    },
    {
      label: 'Quality Score',
      value: ratingDisplay,
      icon: Star,
      color: 'var(--color-text-primary)',
    },
    {
      label: 'Failed',
      value: String(metrics.failedThisWeek),
      icon: AlertTriangle,
      color: metrics.failedThisWeek > 0 ? 'var(--semantic-red-500, #ef4444)' : 'var(--color-text-primary)',
    },
    {
      label: 'Avg Confidence',
      value: avgConfidence > 0 ? `${avgConfidence}%` : '—',
      icon: Target,
      color: confidenceColor,
    },
  ]

  return (
    <div style={{ padding: '24px 20px 0' }}>
      {/* Stats Grid */}
      <span
        className="font-body"
        style={{
          fontSize: 10,
          fontWeight: 600,
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          color: 'var(--color-text-secondary)',
          display: 'block',
          marginBottom: 10,
        }}
      >
        Pipeline Stats
      </span>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginBottom: 20 }}>
        {stats.map((stat, i) => (
          <div
            key={stat.label}
            style={{
              background: 'var(--color-bg-inset)',
              borderRadius: 8,
              padding: '10px 12px',
              animation: loading ? undefined : `fadeUp 0.4s ease ${i * 0.04}s both`,
            }}
          >
            {loading ? (
              <div className="animate-pulse" style={{ width: 40, height: 18, background: 'var(--color-bg-card)', borderRadius: 4 }} />
            ) : (
              <div className="font-display" style={{ fontSize: 18, fontWeight: 800, color: stat.color, letterSpacing: '-0.02em' }}>
                {stat.value}
              </div>
            )}
            <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 2 }}>
              <stat.icon size={10} style={{ color: 'var(--color-text-placeholder)' }} />
              <span className="font-body" style={{ fontSize: 9, fontWeight: 600, color: 'var(--color-text-secondary)' }}>
                {stat.label}
              </span>
            </div>
          </div>
        ))}
      </div>

      {/* Source Distribution */}
      {sourceEntries.length > 0 && (
        <div style={{ marginBottom: 20 }}>
          <span
            className="font-body"
            style={{
              fontSize: 10,
              fontWeight: 600,
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
              color: 'var(--color-text-secondary)',
              display: 'block',
              marginBottom: 10,
            }}
          >
            Source Distribution
          </span>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {sourceEntries.map(([type, count]) => {
              const pct = maxSourceCount > 0 ? (count / maxSourceCount) * 100 : 0
              return (
                <div key={type}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
                    <ProviderIcon sourceType={type} size={18} borderRadius={4} />
                    <span className="font-body" style={{ fontSize: 11, fontWeight: 500, color: 'var(--color-text-body)', flex: 1 }}>
                      {type}
                    </span>
                    <span className="font-body" style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-secondary)' }}>
                      {count}
                    </span>
                  </div>
                  <div style={{ height: 4, borderRadius: 2, background: 'var(--color-bg-inset)', overflow: 'hidden' }}>
                    <div
                      style={{
                        width: `${pct}%`,
                        height: '100%',
                        borderRadius: 2,
                        background: 'var(--color-accent-400, #ea580c)',
                        transition: 'width 0.3s ease',
                      }}
                    />
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Potential Duplicates Review */}
      {pendingDuplicatesCount > 0 && (
        <div style={{ marginTop: 20, marginBottom: 20 }}>
          <span
            className="font-body"
            style={{
              fontSize: 10,
              fontWeight: 600,
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
              color: 'var(--semantic-amber-500, #f59e0b)',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              marginBottom: 10,
            }}
          >
            <GitMerge size={11} />
            Potential Duplicates
            <span
              style={{
                fontSize: 9,
                fontWeight: 700,
                background: 'rgba(245,158,11,0.1)',
                color: 'var(--semantic-amber-500, #f59e0b)',
                borderRadius: 10,
                padding: '1px 6px',
              }}
            >
              {pendingDuplicatesCount}
            </span>
          </span>

          <p className="font-body" style={{ fontSize: 11, color: 'var(--color-text-secondary)', marginBottom: 10 }}>
            {pendingDuplicatesCount} pair{pendingDuplicatesCount !== 1 ? 's' : ''} of nodes may be the same entity
          </p>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {pendingDuplicates.map(pair => {
              const simPct = Math.round(pair.similarity * 100)
              const simColor = simPct >= 90
                ? 'var(--semantic-green-500, #22c55e)'
                : 'var(--semantic-amber-500, #f59e0b)'

              return (
                <div
                  key={pair.id}
                  style={{
                    background: 'var(--color-bg-inset)',
                    borderRadius: 8,
                    padding: '10px 12px',
                    border: '1px solid var(--border-subtle)',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                    {/* Node A */}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <span className="font-body font-semibold" style={{ fontSize: 12, color: 'var(--color-text-primary)', display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {pair.nodeA.label}
                      </span>
                      <span className="font-body" style={{ fontSize: 9, fontWeight: 600, color: getEntityColor(pair.nodeA.entityType) }}>
                        {pair.nodeA.entityType}
                      </span>
                    </div>

                    {/* Similarity */}
                    <span className="font-body font-semibold" style={{ fontSize: 11, color: simColor, flexShrink: 0 }}>
                      {simPct}%
                    </span>

                    {/* Node B */}
                    <div style={{ flex: 1, minWidth: 0, textAlign: 'right' }}>
                      <span className="font-body font-semibold" style={{ fontSize: 12, color: 'var(--color-text-primary)', display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {pair.nodeB.label}
                      </span>
                      <span className="font-body" style={{ fontSize: 9, fontWeight: 600, color: getEntityColor(pair.nodeB.entityType) }}>
                        {pair.nodeB.entityType}
                      </span>
                    </div>
                  </div>

                  {/* Actions */}
                  <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                    <button
                      type="button"
                      onClick={() => onKeepSeparate?.(pair.id)}
                      className="font-body font-semibold cursor-pointer"
                      style={{
                        fontSize: 10,
                        padding: '4px 10px',
                        borderRadius: 6,
                        background: 'transparent',
                        border: '1px solid var(--border-subtle)',
                        color: 'var(--color-text-secondary)',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 4,
                      }}
                    >
                      <X size={10} />
                      Keep Separate
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        // Pick higher connection count as canonical
                        const canonical = pair.nodeA.connectionCount >= pair.nodeB.connectionCount
                          ? pair.nodeA : pair.nodeB
                        const toMerge = canonical === pair.nodeA ? pair.nodeB : pair.nodeA
                        onMerge?.(canonical.id, toMerge.id, pair.id)
                      }}
                      className="font-body font-semibold cursor-pointer"
                      style={{
                        fontSize: 10,
                        padding: '4px 10px',
                        borderRadius: 6,
                        background: 'var(--color-accent-50)',
                        border: '1px solid rgba(214,58,0,0.15)',
                        color: 'var(--color-accent-500)',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 4,
                      }}
                    >
                      <GitMerge size={10} />
                      Merge
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Divider */}
      <div style={{ borderBottom: '1px solid var(--border-subtle)', marginBottom: 0 }} />
    </div>
  )
}
