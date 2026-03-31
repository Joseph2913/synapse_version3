import { Dot } from '../ui/Dot'
import { getEntityColor } from '../../config/entityTypes'
import type { KnowledgeSnapshot, PipelineStatus } from '../../services/supabase'

interface KnowledgeSnapshotPanelProps {
  snapshot: KnowledgeSnapshot | null
  pipeline: PipelineStatus | null
  onAnchorClick?: (anchorId: string) => void
}

const SOURCE_BADGE_CONFIG: Record<string, { bg: string; border: string; text: string; letter: string }> = {
  Meeting: { bg: '#eff6ff', border: '#bfdbfe', text: '#2563eb', letter: 'M' },
  YouTube: { bg: '#fef2f2', border: '#fecaca', text: '#ef4444', letter: 'Y' },
  Document: { bg: '#fffbeb', border: '#fde68a', text: '#d97706', letter: 'D' },
  Note: { bg: '#f0fdf4', border: '#bbf7d0', text: '#16a34a', letter: 'N' },
  Research: { bg: '#faf5ff', border: '#e9d5ff', text: '#7c3aed', letter: 'R' },
}

export function KnowledgeSnapshotPanel({ snapshot, pipeline, onAnchorClick }: KnowledgeSnapshotPanelProps) {
  const maxEntityCount = snapshot?.entityTypeCounts[0]?.count ?? 1

  return (
    <div className="flex flex-col" style={{ gap: 0 }}>
      {/* Entity Types */}
      <div>
        <div
          className="font-display text-text-secondary uppercase"
          style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', marginBottom: 14 }}
        >
          Entity Types
        </div>
        {!snapshot || snapshot.entityTypeCounts.length === 0 ? (
          <p className="font-body text-text-placeholder" style={{ fontSize: 13 }}>No entities yet.</p>
        ) : (
          <div className="flex flex-col" style={{ gap: 8 }}>
            {snapshot.entityTypeCounts.map(({ entity_type, count }) => (
              <div key={entity_type} className="flex items-center" style={{ gap: 10, padding: '4px 0' }}>
                <Dot type={entity_type} size={9} />
                <span className="font-body text-text-body flex-1" style={{ fontSize: 13 }}>{entity_type}</span>
                <div className="flex-1 overflow-hidden" style={{ height: 5, background: 'rgba(0,0,0,0.06)', borderRadius: 3 }}>
                  <div
                    style={{
                      height: '100%',
                      borderRadius: 3,
                      width: `${(count / maxEntityCount) * 100}%`,
                      backgroundColor: getEntityColor(entity_type),
                    }}
                  />
                </div>
                <span className="font-body text-text-secondary text-right" style={{ fontSize: 13, fontWeight: 600, minWidth: 36 }}>
                  {count}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Top Anchors */}
      <div style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: 18, marginTop: 22 }}>
        <div
          className="font-display text-text-secondary uppercase"
          style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', marginBottom: 14 }}
        >
          Top Anchors
        </div>
        {!snapshot || snapshot.topAnchors.length === 0 ? (
          <p className="font-body text-text-placeholder" style={{ fontSize: 13 }}>No anchors yet.</p>
        ) : (
          <div className="flex flex-col" style={{ gap: 4 }}>
            {snapshot.topAnchors.map((anchor) => (
              <button
                key={anchor.id}
                type="button"
                onClick={() => onAnchorClick?.(anchor.id)}
                className="flex items-center w-full text-left bg-transparent border-none cursor-pointer hover:bg-bg-hover transition-colors duration-150"
                style={{ gap: 10, padding: '8px 6px', borderRadius: 8 }}
              >
                <Dot type={anchor.entity_type} size={9} />
                <span className="font-body text-text-primary flex-1 truncate" style={{ fontSize: 13, fontWeight: 600 }}>
                  {anchor.label}
                </span>
                <span className="font-body text-text-secondary" style={{ fontSize: 12 }}>
                  {anchor.connectionCount}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Sources by Type */}
      <div style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: 18, marginTop: 22 }}>
        <div
          className="font-display text-text-secondary uppercase"
          style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', marginBottom: 14 }}
        >
          Sources by Type
        </div>
        {!snapshot || snapshot.sourceTypeCounts.length === 0 ? (
          <p className="font-body text-text-placeholder" style={{ fontSize: 13 }}>No sources yet.</p>
        ) : (
          <div className="flex flex-col" style={{ gap: 8 }}>
            {snapshot.sourceTypeCounts.map(({ source_type, count }) => {
              const config = SOURCE_BADGE_CONFIG[source_type] ?? {
                bg: '#f3f4f6',
                border: '#e5e7eb',
                text: '#6b7280',
                letter: source_type.charAt(0).toUpperCase(),
              }
              return (
                <div key={source_type} className="flex items-center" style={{ gap: 12, padding: '4px 0' }}>
                  <div
                    className="shrink-0 flex items-center justify-center"
                    style={{
                      width: 28,
                      height: 28,
                      borderRadius: 7,
                      fontSize: 11,
                      fontWeight: 700,
                      background: config.bg,
                      border: `1px solid ${config.border}`,
                      color: config.text,
                    }}
                  >
                    {config.letter}
                  </div>
                  <span className="font-body text-text-body flex-1" style={{ fontSize: 13 }}>{source_type}</span>
                  <span className="font-body text-text-secondary" style={{ fontSize: 13, fontWeight: 600 }}>{count}</span>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* System Health */}
      <div style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: 18, marginTop: 22 }}>
        <div
          className="font-display text-text-secondary uppercase"
          style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', marginBottom: 14 }}
        >
          System Health
        </div>
        <div className="flex flex-col" style={{ gap: 10 }}>
          <div className="flex items-center font-body text-text-secondary" style={{ gap: 10, fontSize: 13 }}>
            <span
              className="shrink-0"
              style={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: pipeline?.lastScanAt ? 'var(--color-semantic-green-500)' : '#d1d5db',
              }}
            />
            <span>YouTube: {pipeline?.lastScanAt ? 'running' : 'not configured'}</span>
          </div>
          <div className="flex items-center font-body text-text-secondary" style={{ gap: 10, fontSize: 13 }}>
            <span
              className="shrink-0"
              style={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: pipeline
                  ? pipeline.failedQueueCount > 0
                    ? 'var(--color-semantic-red-500)'
                    : pipeline.pendingQueueCount > 0
                      ? 'var(--color-semantic-amber-500)'
                      : 'var(--color-semantic-green-500)'
                  : '#d1d5db',
              }}
            />
            <span>
              Queue: {pipeline
                ? pipeline.failedQueueCount > 0
                  ? `${pipeline.failedQueueCount} failed`
                  : `${pipeline.pendingQueueCount} pending`
                : 'unknown'}
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}
