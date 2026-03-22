import { useState, useCallback, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { X, RefreshCw, Eye, Trash2, AlertCircle, MessageSquare } from 'lucide-react'
import { StarRating } from '../shared/StarRating'
import { getEntityColor } from '../../config/entityTypes'
import { ProviderIcon } from '../shared/ProviderIcon'
import { buildExtractionDetailContext } from '../../config/chatEntryContexts'
import { fetchExtractionEnrichment } from '../../services/supabase'
import type { PipelineHistoryItem } from '../../types/pipeline'

interface ExtractionDetailProps {
  item: PipelineHistoryItem
  onClose: () => void
  onRate: (rating: number) => void
  onDelete: () => void
}

function formatRelativeTime(dateStr: string): string {
  const now = Date.now()
  const then = new Date(dateStr).getTime()
  const diff = now - then
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

export function ExtractionDetail({ item, onClose, onRate, onDelete }: ExtractionDetailProps) {
  const navigate = useNavigate()
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [enrichment, setEnrichment] = useState<{ chunkCount: number; crossConnections: number } | null>(null)
  const isFailed = item.status === 'failed'

  // Lazy-load chunk count + cross-connection count for completed items
  useEffect(() => {
    if (isFailed || !item.extractedNodeIds.length) return
    let cancelled = false
    fetchExtractionEnrichment(item.extractedNodeIds, item.extractedEdgeIds).then(result => {
      if (!cancelled) setEnrichment(result)
    })
    return () => { cancelled = true }
  }, [item.id, item.extractedNodeIds, item.extractedEdgeIds, isFailed])

  const chunkCount = enrichment?.chunkCount ?? item.chunkCount
  const crossConnections = enrichment?.crossConnections ?? item.crossConnections

  const confidencePct = Math.round(item.confidence * 100)
  const confidenceColor = confidencePct > 85
    ? 'var(--semantic-green-500, #22c55e)'
    : confidencePct > 70
      ? 'var(--semantic-amber-500, #f59e0b)'
      : 'var(--semantic-red-500, #ef4444)'

  const entityEntries = Object.entries(item.entityBreakdown).sort((a, b) => b[1] - a[1])
  const totalEntities = entityEntries.reduce((sum, [, v]) => sum + v, 0)

  const handleDelete = useCallback(() => {
    onDelete()
    setShowDeleteConfirm(false)
  }, [onDelete])

  return (
    <div
      style={{
        height: '100%',
        overflowY: 'auto',
        padding: '24px 20px',
        animation: 'slideInRight 0.2s ease',
      }}
    >
      <style>{`
        @keyframes slideInRight {
          from { opacity: 0; transform: translateX(12px); }
          to { opacity: 1; transform: translateX(0); }
        }
      `}</style>

      {/* Header */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', marginBottom: 16 }}>
        <ProviderIcon sourceType={item.sourceType} provider={item.provider} size={40} borderRadius={10} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <h2
            className="font-display"
            style={{
              fontSize: 15,
              fontWeight: 700,
              color: 'var(--color-text-primary)',
              lineHeight: 1.3,
              margin: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {item.title}
          </h2>
          <span className="font-body" style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>
            {item.sourceType} · {formatRelativeTime(item.createdAt)}
          </span>
        </div>
        <button
          type="button"
          onClick={onClose}
          style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4, display: 'flex', flexShrink: 0 }}
        >
          <X size={14} style={{ color: 'var(--color-text-secondary)' }} />
        </button>
      </div>

      {/* Failed state */}
      {isFailed && (
        <div
          style={{
            background: 'var(--semantic-red-50, rgba(239,68,68,0.06))',
            border: '1px solid rgba(239,68,68,0.16)',
            borderRadius: 10,
            padding: '14px 16px',
            marginBottom: 20,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
            <AlertCircle size={14} style={{ color: 'var(--semantic-red-500, #ef4444)' }} />
            <span className="font-body" style={{ fontSize: 12, fontWeight: 600, color: 'var(--semantic-red-700, #b91c1c)' }}>
              Extraction Failed
            </span>
          </div>
          <p className="font-body" style={{ fontSize: 11, color: 'var(--semantic-red-700, #b91c1c)', lineHeight: 1.5, margin: 0 }}>
            {item.error ?? 'No entities were extracted from this source.'}
          </p>
        </div>
      )}

      {/* Completed state — full diagnostics */}
      {!isFailed && (
        <>
          {/* Metrics grid */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginBottom: 20 }}>
            {[
              { label: 'Entities', value: String(item.entityCount) },
              { label: 'Relationships', value: String(item.relationshipCount) },
              { label: 'Chunks', value: enrichment ? String(chunkCount) : '...' },
              { label: 'Duration', value: item.duration > 0 ? `${(item.duration / 1000).toFixed(1)}s` : '—' },
            ].map(stat => (
              <div
                key={stat.label}
                style={{
                  background: 'var(--color-bg-inset)',
                  borderRadius: 8,
                  padding: '12px 14px',
                  textAlign: 'center',
                }}
              >
                <div className="font-display" style={{ fontSize: 20, fontWeight: 800, color: 'var(--color-text-primary)' }}>
                  {stat.value}
                </div>
                <div className="font-body" style={{ fontSize: 10, fontWeight: 600, color: 'var(--color-text-secondary)' }}>
                  {stat.label}
                </div>
              </div>
            ))}
          </div>

          {/* Quality Rating */}
          <div style={{ marginBottom: 20 }}>
            <span className="font-body" style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--color-text-secondary)', display: 'block', marginBottom: 8 }}>
              Quality Rating
            </span>
            <div
              style={{
                background: 'var(--color-bg-inset)',
                border: '1px solid var(--border-subtle)',
                borderRadius: 8,
                padding: '10px 14px',
                display: 'flex',
                alignItems: 'center',
                gap: 8,
              }}
            >
              {item.rating !== null ? (
                <>
                  <StarRating rating={item.rating} size={14} />
                  <span className="font-body" style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text-primary)' }}>
                    {item.rating}/5
                  </span>
                </>
              ) : (
                <>
                  <span className="font-body" style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>Rate:</span>
                  <StarRating rating={null} size={14} interactive onChange={onRate} />
                </>
              )}
            </div>
          </div>

          {/* Avg Confidence */}
          {item.confidence > 0 && (
            <div style={{ marginBottom: 20 }}>
              <span className="font-body" style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--color-text-secondary)', display: 'block', marginBottom: 8 }}>
                Avg Confidence
              </span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{ flex: 1, height: 6, borderRadius: 3, background: 'var(--color-bg-inset)', overflow: 'hidden' }}>
                  <div
                    style={{
                      width: `${confidencePct}%`,
                      height: '100%',
                      borderRadius: 3,
                      background: confidenceColor,
                      transition: 'width 0.3s ease',
                    }}
                  />
                </div>
                <span className="font-display" style={{ fontSize: 12, fontWeight: 700, color: 'var(--color-text-primary)' }}>
                  {confidencePct}%
                </span>
              </div>
            </div>
          )}

          {/* Extraction Config */}
          <div style={{ marginBottom: 20 }}>
            <span className="font-body" style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--color-text-secondary)', display: 'block', marginBottom: 8 }}>
              Extraction Config
            </span>
            <div
              style={{
                background: 'var(--color-bg-inset)',
                border: '1px solid var(--border-subtle)',
                borderRadius: 8,
                padding: '12px 14px',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 0' }}>
                <span className="font-body" style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-secondary)' }}>Mode</span>
                <span className="font-body" style={{ fontSize: 11, fontWeight: 500, color: 'var(--color-text-body)', textTransform: 'capitalize' }}>
                  {item.mode}
                </span>
              </div>
              <div style={{ borderBottom: '1px solid var(--border-subtle)', margin: '4px 0' }} />
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 0' }}>
                <span className="font-body" style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-secondary)' }}>Emphasis</span>
                <span className="font-body" style={{ fontSize: 11, fontWeight: 500, color: 'var(--color-text-body)', textTransform: 'capitalize' }}>
                  {item.emphasis}
                </span>
              </div>
            </div>
          </div>

          {/* Entity Breakdown */}
          {entityEntries.length > 0 && (
            <div style={{ marginBottom: 20 }}>
              <span className="font-body" style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--color-text-secondary)', display: 'block', marginBottom: 8 }}>
                Entity Breakdown ({totalEntities})
              </span>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
                {entityEntries.map(([type, count]) => {
                  const pct = totalEntities > 0 ? (count / totalEntities) * 100 : 0
                  return (
                    <div key={type} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0' }}>
                      <div style={{ width: 7, height: 7, borderRadius: 4, background: getEntityColor(type), flexShrink: 0 }} />
                      <span className="font-body" style={{ fontSize: 11, fontWeight: 500, color: 'var(--color-text-body)', flex: 1 }}>
                        {type}
                      </span>
                      <div style={{ width: 60, height: 4, borderRadius: 2, background: 'var(--color-bg-inset)', overflow: 'hidden' }}>
                        <div style={{ width: `${pct}%`, height: '100%', borderRadius: 2, background: getEntityColor(type) }} />
                      </div>
                      <span className="font-body" style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-secondary)', width: 16, textAlign: 'right' }}>
                        {count}
                      </span>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* Cross-Connections */}
          <div style={{ marginBottom: 20 }}>
            <span className="font-body" style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--color-text-secondary)', display: 'block', marginBottom: 8 }}>
              Cross-Connections
            </span>
            <div
              style={{
                padding: '10px 14px',
                borderRadius: 8,
                background: crossConnections > 0 ? 'var(--color-accent-50)' : 'var(--color-bg-inset)',
                border: `1px solid ${crossConnections > 0 ? 'rgba(214,58,0,0.1)' : 'var(--border-subtle)'}`,
              }}
            >
              {!enrichment ? (
                <span className="font-body" style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>
                  Loading...
                </span>
              ) : crossConnections > 0 ? (
                <span className="font-body" style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-accent-600, #c2410c)' }}>
                  {crossConnections} discovered
                </span>
              ) : (
                <span className="font-body" style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>
                  No cross-connections discovered
                </span>
              )}
            </div>
          </div>
        </>
      )}

      {/* Actions */}
      <div style={{ marginTop: 16 }}>
        {item.sourceId && (
          <button
            type="button"
            onClick={() => {
              const ctx = buildExtractionDetailContext({
                sourceId: item.sourceId!,
                title: item.title,
                sourceType: item.sourceType,
                entityCount: item.entityCount,
              })
              navigate('/ask', { state: { chatContext: ctx } })
            }}
            className="font-body font-semibold flex items-center justify-center gap-1.5"
            style={{
              width: '100%',
              padding: '10px 16px',
              borderRadius: 8,
              border: '1px solid var(--border-subtle)',
              background: 'var(--color-bg-card)',
              color: 'var(--color-text-body)',
              fontSize: 12,
              cursor: 'pointer',
              marginBottom: 8,
              transition: 'background 0.12s ease',
            }}
            onMouseEnter={e => { e.currentTarget.style.background = 'var(--color-bg-inset)' }}
            onMouseLeave={e => { e.currentTarget.style.background = 'var(--color-bg-card)' }}
          >
            <MessageSquare size={13} />
            Ask about this extraction
          </button>
        )}
        <button
          type="button"
          onClick={() => console.log('Re-extract:', item.sourceId)}
          className="font-body font-semibold"
          style={{
            width: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 6,
            padding: '10px 16px',
            borderRadius: 8,
            border: '1px solid rgba(214,58,0,0.15)',
            background: 'var(--color-accent-50)',
            color: 'var(--color-accent-600, #c2410c)',
            fontSize: 12,
            cursor: 'pointer',
            marginBottom: 8,
          }}
        >
          <RefreshCw size={13} />
          Re-extract
        </button>

        <div style={{ display: 'flex', gap: 6 }}>
          <button
            type="button"
            onClick={() => console.log('View in graph:', item.extractedNodeIds)}
            className="font-body font-semibold"
            style={{
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 5,
              padding: '8px 12px',
              borderRadius: 8,
              border: '1px solid var(--border-subtle)',
              background: 'var(--color-bg-card)',
              color: 'var(--color-text-body)',
              fontSize: 11,
              cursor: 'pointer',
            }}
          >
            <Eye size={12} />
            Graph
          </button>

          {!showDeleteConfirm ? (
            <button
              type="button"
              onClick={() => setShowDeleteConfirm(true)}
              className="font-body font-semibold"
              style={{
                flex: 1,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 5,
                padding: '8px 12px',
                borderRadius: 8,
                border: '1px solid var(--border-subtle)',
                background: 'var(--color-bg-card)',
                color: 'var(--semantic-red-500, #ef4444)',
                fontSize: 11,
                cursor: 'pointer',
              }}
            >
              <Trash2 size={12} />
              Delete
            </button>
          ) : (
            <div style={{ flex: 1, display: 'flex', gap: 4 }}>
              <button
                type="button"
                onClick={() => setShowDeleteConfirm(false)}
                className="font-body"
                style={{
                  flex: 1,
                  padding: '8px 8px',
                  borderRadius: 6,
                  border: '1px solid var(--border-subtle)',
                  background: 'var(--color-bg-card)',
                  color: 'var(--color-text-secondary)',
                  fontSize: 10,
                  cursor: 'pointer',
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleDelete}
                className="font-body font-semibold"
                style={{
                  flex: 1,
                  padding: '8px 8px',
                  borderRadius: 6,
                  border: 'none',
                  background: 'var(--semantic-red-500, #ef4444)',
                  color: 'white',
                  fontSize: 10,
                  cursor: 'pointer',
                }}
              >
                Delete
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
