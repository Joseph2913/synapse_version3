import { useState } from 'react'
import { TrendingUp, BarChart3, Clock, Star, AlertTriangle, Target, GitMerge, X, Anchor, ArrowRight, Check } from 'lucide-react'
import { ProviderIcon } from '../shared/ProviderIcon'
import { getEntityColor } from '../../config/entityTypes'
import type { PipelineMetrics, PipelineHistoryItem } from '../../types/pipeline'
import type { PotentialDuplicatePair } from '../../services/deduplication'

// ─── Match type badge colors ─────────────────────────────────────────────────

const MATCH_TYPE_STYLES: Record<string, { bg: string; color: string }> = {
  exact:    { bg: 'rgba(34,197,94,0.1)',  color: 'var(--semantic-green-500, #22c55e)' },
  fuzzy:    { bg: 'rgba(245,158,11,0.1)', color: 'var(--semantic-amber-500, #f59e0b)' },
  semantic: { bg: 'rgba(59,130,246,0.1)', color: '#3b82f6' },
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function resolveCanonicalAndMerge(pair: PotentialDuplicatePair): {
  canonical: PotentialDuplicatePair['nodeA']
  toMerge: PotentialDuplicatePair['nodeB']
} {
  if (pair.recommendation === 'merge_into_a') {
    return { canonical: pair.nodeA, toMerge: pair.nodeB }
  }
  if (pair.recommendation === 'merge_into_b') {
    return { canonical: pair.nodeB, toMerge: pair.nodeA }
  }
  const aScore = (pair.nodeA.isAnchor ? 100 : 0) + pair.nodeA.connectionCount
  const bScore = (pair.nodeB.isAnchor ? 100 : 0) + pair.nodeB.connectionCount
  return aScore >= bScore
    ? { canonical: pair.nodeA, toMerge: pair.nodeB }
    : { canonical: pair.nodeB, toMerge: pair.nodeA }
}

// ─── Anchor Badge ─────────────────────────────────────────────────────────────

function AnchorBadge() {
  return (
    <span
      className="font-body"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 3,
        fontSize: 9,
        fontWeight: 600,
        background: 'rgba(180,83,9,0.08)',
        color: '#b45309',
        borderRadius: 10,
        padding: '1px 6px',
      }}
    >
      <Anchor size={8} />
      Anchor
    </span>
  )
}

// ─── Match Type Badge ─────────────────────────────────────────────────────────

function MatchTypeBadge({ type }: { type: string }) {
  const style = MATCH_TYPE_STYLES[type] ?? MATCH_TYPE_STYLES.semantic!
  return (
    <span
      className="font-body"
      style={{
        fontSize: 9,
        fontWeight: 600,
        background: style.bg,
        color: style.color,
        borderRadius: 10,
        padding: '1px 6px',
      }}
    >
      {type}
    </span>
  )
}

// ─── Merge Preview Panel ──────────────────────────────────────────────────────

function MergePreviewPanel({
  pair,
  onConfirm,
  onCancel,
}: {
  pair: PotentialDuplicatePair
  onConfirm: () => void
  onCancel: () => void
}) {
  const { canonical, toMerge } = resolveCanonicalAndMerge(pair)
  const combinedConns = canonical.connectionCount + toMerge.connectionCount

  return (
    <div
      style={{
        background: 'var(--color-bg-card)',
        border: '1px solid rgba(214,58,0,0.15)',
        borderRadius: 8,
        padding: '12px 14px',
        marginBottom: 10,
      }}
    >
      <span
        className="font-body font-semibold"
        style={{ fontSize: 11, color: 'var(--color-text-primary)', display: 'block', marginBottom: 8 }}
      >
        Merge Preview
      </span>

      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
        <span className="font-body" style={{ fontSize: 10, color: 'var(--semantic-green-500, #22c55e)', fontWeight: 600 }}>
          Keep:
        </span>
        <span className="font-body font-semibold" style={{ fontSize: 11, color: 'var(--color-text-primary)' }}>
          {canonical.label}
        </span>
        <span className="font-body" style={{ fontSize: 10, color: 'var(--color-text-secondary)' }}>
          ({canonical.connectionCount})
        </span>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
        <span className="font-body" style={{ fontSize: 10, color: 'var(--color-text-secondary)', fontWeight: 600 }}>
          Absorb:
        </span>
        <span className="font-body" style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>
          {toMerge.label}
        </span>
        <ArrowRight size={10} style={{ color: 'var(--color-text-placeholder)' }} />
        <span className="font-body" style={{ fontSize: 10, color: 'var(--color-text-secondary)' }}>
          {toMerge.connectionCount} edges repointed
        </span>
      </div>

      <div
        className="font-body"
        style={{ fontSize: 10, color: 'var(--color-text-secondary)', marginBottom: 10 }}
      >
        Combined: <span style={{ fontWeight: 600, color: 'var(--color-text-primary)' }}>{combinedConns}</span> connections
      </div>

      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
        <button
          type="button"
          onClick={onCancel}
          className="font-body font-semibold cursor-pointer"
          style={{
            fontSize: 10,
            padding: '5px 12px',
            borderRadius: 6,
            background: 'transparent',
            border: '1px solid var(--border-subtle)',
            color: 'var(--color-text-secondary)',
          }}
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onConfirm}
          className="font-body font-semibold cursor-pointer"
          style={{
            fontSize: 10,
            padding: '5px 12px',
            borderRadius: 6,
            background: 'var(--color-accent-500)',
            border: '1px solid var(--color-accent-500)',
            color: '#fff',
            display: 'flex',
            alignItems: 'center',
            gap: 4,
          }}
        >
          <Check size={10} />
          Confirm Merge
        </button>
      </div>
    </div>
  )
}

// ─── Batch Merge Dialog ───────────────────────────────────────────────────────

function BatchMergeDialog({
  pairs,
  onConfirm,
  onClose,
  merging,
}: {
  pairs: PotentialDuplicatePair[]
  onConfirm: () => void
  onClose: () => void
  merging: boolean
}) {
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 200,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(0,0,0,0.35)',
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: 'var(--color-bg-card)',
          borderRadius: 12,
          padding: 24,
          maxWidth: 420,
          width: '90%',
          maxHeight: '70vh',
          overflowY: 'auto',
          boxShadow: '0 8px 32px rgba(0,0,0,0.15)',
        }}
        onClick={e => e.stopPropagation()}
      >
        <h3 className="font-display" style={{ fontSize: 15, fontWeight: 700, color: 'var(--color-text-primary)', marginBottom: 8 }}>
          Merge {pairs.length} high-confidence pairs?
        </h3>
        <p className="font-body" style={{ fontSize: 11, color: 'var(--color-text-secondary)', marginBottom: 14 }}>
          All pairs below have similarity {'>'}= 95%. This action cannot be undone.
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 16 }}>
          {pairs.map(pair => {
            const { canonical, toMerge } = resolveCanonicalAndMerge(pair)
            return (
              <div
                key={pair.id}
                style={{
                  background: 'var(--color-bg-inset)',
                  borderRadius: 6,
                  padding: '6px 10px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                }}
              >
                <span className="font-body" style={{ fontSize: 10, color: 'var(--color-text-secondary)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {toMerge.label}
                </span>
                <ArrowRight size={10} style={{ color: 'var(--color-text-placeholder)', flexShrink: 0 }} />
                <span className="font-body font-semibold" style={{ fontSize: 10, color: 'var(--color-text-primary)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {canonical.label}
                </span>
                <span className="font-body" style={{ fontSize: 9, color: 'var(--semantic-green-500, #22c55e)', fontWeight: 600, flexShrink: 0 }}>
                  {Math.round(pair.similarity * 100)}%
                </span>
              </div>
            )
          })}
        </div>

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button
            type="button"
            onClick={onClose}
            disabled={merging}
            className="font-body font-semibold cursor-pointer"
            style={{
              fontSize: 11,
              padding: '6px 16px',
              borderRadius: 8,
              background: 'transparent',
              border: '1px solid var(--border-subtle)',
              color: 'var(--color-text-secondary)',
              opacity: merging ? 0.5 : 1,
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={merging}
            className="font-body font-semibold cursor-pointer"
            style={{
              fontSize: 11,
              padding: '6px 16px',
              borderRadius: 8,
              background: 'var(--color-accent-500)',
              border: '1px solid var(--color-accent-500)',
              color: '#fff',
              opacity: merging ? 0.6 : 1,
              display: 'flex',
              alignItems: 'center',
              gap: 4,
            }}
          >
            <GitMerge size={12} />
            {merging ? 'Merging...' : `Merge ${pairs.length} pairs`}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── DuplicatePairCard ────────────────────────────────────────────────────────

function DuplicatePairCard({
  pair,
  isSelected,
  onSelect,
  onMerge,
  onKeepSeparate,
}: {
  pair: PotentialDuplicatePair
  isSelected: boolean
  onSelect: () => void
  onMerge: () => void
  onKeepSeparate: () => void
}) {
  const simPct = Math.round(pair.similarity * 100)
  const simColor = simPct >= 95
    ? 'var(--semantic-green-500, #22c55e)'
    : simPct >= 85
      ? 'var(--semantic-amber-500, #f59e0b)'
      : '#3b82f6'
  const { canonical } = resolveCanonicalAndMerge(pair)

  return (
    <div
      style={{
        background: isSelected ? 'var(--color-bg-card)' : 'var(--color-bg-inset)',
        borderRadius: 8,
        padding: '10px 12px',
        border: isSelected ? '1px solid rgba(214,58,0,0.2)' : '1px solid var(--border-subtle)',
        cursor: 'pointer',
        transition: 'border-color 0.15s ease',
      }}
      onClick={onSelect}
    >
      {/* Header: match type + similarity */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
        <MatchTypeBadge type={pair.matchType} />
        <span className="font-body font-semibold" style={{ fontSize: 11, color: simColor }}>
          {simPct}%
        </span>
        <div style={{ flex: 1 }} />
        <span className="font-body" style={{ fontSize: 9, color: 'var(--color-text-placeholder)' }}>
          click to preview
        </span>
      </div>

      {/* Node A */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
        <div
          style={{
            width: 6, height: 6, borderRadius: '50%',
            background: getEntityColor(pair.nodeA.entityType),
            flexShrink: 0,
          }}
        />
        <span
          className="font-body"
          style={{
            fontSize: 11,
            fontWeight: canonical.id === pair.nodeA.id ? 600 : 400,
            color: canonical.id === pair.nodeA.id ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            flex: 1, minWidth: 0,
          }}
        >
          {pair.nodeA.label}
        </span>
        <span className="font-body" style={{ fontSize: 9, color: 'var(--color-text-placeholder)', flexShrink: 0 }}>
          ({pair.nodeA.connectionCount})
        </span>
        {pair.nodeA.isAnchor && <AnchorBadge />}
      </div>

      {/* Node B */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
        <div
          style={{
            width: 6, height: 6, borderRadius: '50%',
            background: getEntityColor(pair.nodeB.entityType),
            flexShrink: 0,
          }}
        />
        <span
          className="font-body"
          style={{
            fontSize: 11,
            fontWeight: canonical.id === pair.nodeB.id ? 600 : 400,
            color: canonical.id === pair.nodeB.id ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            flex: 1, minWidth: 0,
          }}
        >
          {pair.nodeB.label}
        </span>
        <span className="font-body" style={{ fontSize: 9, color: 'var(--color-text-placeholder)', flexShrink: 0 }}>
          ({pair.nodeB.connectionCount})
        </span>
        {pair.nodeB.isAnchor && <AnchorBadge />}
      </div>

      {/* Actions */}
      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }} onClick={e => e.stopPropagation()}>
        <button
          type="button"
          onClick={onKeepSeparate}
          className="font-body font-semibold cursor-pointer"
          style={{
            fontSize: 10, padding: '4px 10px', borderRadius: 6,
            background: 'transparent', border: '1px solid var(--border-subtle)',
            color: 'var(--color-text-secondary)',
            display: 'flex', alignItems: 'center', gap: 4,
          }}
        >
          <X size={10} />
          Keep Separate
        </button>
        <button
          type="button"
          onClick={onMerge}
          className="font-body font-semibold cursor-pointer"
          style={{
            fontSize: 10, padding: '4px 10px', borderRadius: 6,
            background: 'var(--color-accent-50)',
            border: '1px solid rgba(214,58,0,0.15)',
            color: 'var(--color-accent-500)',
            display: 'flex', alignItems: 'center', gap: 4,
          }}
        >
          <GitMerge size={10} />
          Merge
        </button>
      </div>
    </div>
  )
}

// ─── Main Component ───────────────────────────────────────────────────────────

interface PipelineStatsProps {
  metrics: PipelineMetrics
  allItems: PipelineHistoryItem[]
  loading: boolean
  pendingDuplicatesCount?: number
  pendingDuplicates?: PotentialDuplicatePair[]
  onMerge?: (canonicalId: string, mergeId: string, pairId: string) => void
  onKeepSeparate?: (pairId: string) => void
  onBatchMerge?: (pairs: Array<{ canonicalId: string; mergeId: string; pairId: string }>) => void
}

export function PipelineStats({
  metrics,
  allItems,
  loading,
  pendingDuplicatesCount = 0,
  pendingDuplicates = [],
  onMerge,
  onKeepSeparate,
  onBatchMerge,
}: PipelineStatsProps) {
  const [selectedPairId, setSelectedPairId] = useState<string | null>(null)
  const [batchConfirmOpen, setBatchConfirmOpen] = useState(false)
  const [batchMerging, setBatchMerging] = useState(false)

  const avgSec = metrics.avgDuration > 0 ? (metrics.avgDuration / 1000).toFixed(1) : '—'
  const ratingDisplay = metrics.ratedCount > 0 ? metrics.avgRating.toFixed(1) : '—'

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
    sourceAgg[item.sourceType] = (sourceAgg[item.sourceType] ?? 0) + 1
  }
  const sourceEntries = Object.entries(sourceAgg).sort((a, b) => b[1] - a[1])
  const maxSourceCount = sourceEntries.length > 0 ? (sourceEntries[0]?.[1] ?? 0) : 0

  // High-confidence pairs for batch merge
  const highConfidencePairs = pendingDuplicates.filter(p => p.similarity >= 0.95)
  const selectedPair = selectedPairId ? pendingDuplicates.find(p => p.id === selectedPairId) ?? null : null

  const handleBatchMergeConfirm = () => {
    if (!onBatchMerge) return
    setBatchMerging(true)
    const batchPayload = highConfidencePairs.map(pair => {
      const { canonical, toMerge } = resolveCanonicalAndMerge(pair)
      return { canonicalId: canonical.id, mergeId: toMerge.id, pairId: pair.id }
    })
    onBatchMerge(batchPayload)
    setBatchMerging(false)
    setBatchConfirmOpen(false)
  }

  const stats = [
    { label: 'Sources This Week', value: String(metrics.sourcesThisWeek), icon: TrendingUp, color: 'var(--color-text-primary)' },
    { label: 'Entities Extracted', value: String(metrics.entitiesThisWeek), icon: BarChart3, color: 'var(--color-text-primary)' },
    { label: 'Avg Processing Time', value: `${avgSec}s`, icon: Clock, color: 'var(--color-text-primary)' },
    { label: 'Quality Score', value: ratingDisplay, icon: Star, color: 'var(--color-text-primary)' },
    { label: 'Failed', value: String(metrics.failedThisWeek), icon: AlertTriangle, color: metrics.failedThisWeek > 0 ? 'var(--semantic-red-500, #ef4444)' : 'var(--color-text-primary)' },
    { label: 'Avg Confidence', value: avgConfidence > 0 ? `${avgConfidence}%` : '—', icon: Target, color: confidenceColor },
  ]

  return (
    <div style={{ padding: '24px 20px 0' }}>
      {/* Stats Grid */}
      <span
        className="font-body"
        style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--color-text-secondary)', display: 'block', marginBottom: 10 }}
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
            style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--color-text-secondary)', display: 'block', marginBottom: 10 }}
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
                    <span className="font-body" style={{ fontSize: 11, fontWeight: 500, color: 'var(--color-text-body)', flex: 1 }}>{type}</span>
                    <span className="font-body" style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-secondary)' }}>{count}</span>
                  </div>
                  <div style={{ height: 4, borderRadius: 2, background: 'var(--color-bg-inset)', overflow: 'hidden' }}>
                    <div style={{ width: `${pct}%`, height: '100%', borderRadius: 2, background: 'var(--color-accent-400, #ea580c)', transition: 'width 0.3s ease' }} />
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* ── Potential Duplicates Review ──────────────────────────────────────── */}
      {pendingDuplicatesCount > 0 && (
        <div style={{ marginTop: 20, marginBottom: 20 }}>
          {/* Section Header */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
            <span
              className="font-body"
              style={{
                fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em',
                color: 'var(--semantic-amber-500, #f59e0b)',
                display: 'flex', alignItems: 'center', gap: 6,
              }}
            >
              <GitMerge size={11} />
              Potential Duplicates
              <span style={{ fontSize: 9, fontWeight: 700, background: 'rgba(245,158,11,0.1)', color: 'var(--semantic-amber-500, #f59e0b)', borderRadius: 10, padding: '1px 6px' }}>
                {pendingDuplicatesCount}
              </span>
            </span>

            {highConfidencePairs.length > 0 && onBatchMerge && (
              <button
                type="button"
                onClick={() => setBatchConfirmOpen(true)}
                className="font-body font-semibold cursor-pointer"
                style={{
                  marginLeft: 'auto', fontSize: 9, padding: '3px 8px', borderRadius: 6,
                  background: 'var(--color-accent-50)', border: '1px solid rgba(214,58,0,0.15)',
                  color: 'var(--color-accent-500)', display: 'flex', alignItems: 'center', gap: 3,
                }}
              >
                <GitMerge size={9} />
                Merge All ({highConfidencePairs.length})
              </button>
            )}
          </div>

          <p className="font-body" style={{ fontSize: 11, color: 'var(--color-text-secondary)', marginBottom: 10 }}>
            {pendingDuplicatesCount} pair{pendingDuplicatesCount !== 1 ? 's' : ''} of nodes may be the same entity
          </p>

          {/* Merge Preview Panel */}
          {selectedPair && (
            <MergePreviewPanel
              pair={selectedPair}
              onConfirm={() => {
                const { canonical, toMerge } = resolveCanonicalAndMerge(selectedPair)
                onMerge?.(canonical.id, toMerge.id, selectedPair.id)
                setSelectedPairId(null)
              }}
              onCancel={() => setSelectedPairId(null)}
            />
          )}

          {/* Pair Cards */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {pendingDuplicates.map(pair => {
              const { canonical, toMerge } = resolveCanonicalAndMerge(pair)
              return (
                <DuplicatePairCard
                  key={pair.id}
                  pair={pair}
                  isSelected={selectedPairId === pair.id}
                  onSelect={() => setSelectedPairId(prev => prev === pair.id ? null : pair.id)}
                  onMerge={() => onMerge?.(canonical.id, toMerge.id, pair.id)}
                  onKeepSeparate={() => onKeepSeparate?.(pair.id)}
                />
              )
            })}
          </div>
        </div>
      )}

      {/* Divider */}
      <div style={{ borderBottom: '1px solid var(--border-subtle)', marginBottom: 0 }} />

      {/* Batch Merge Confirmation Dialog */}
      {batchConfirmOpen && highConfidencePairs.length > 0 && (
        <BatchMergeDialog
          pairs={highConfidencePairs}
          onConfirm={handleBatchMergeConfirm}
          onClose={() => setBatchConfirmOpen(false)}
          merging={batchMerging}
        />
      )}
    </div>
  )
}
