import type { AnchorHealthSummary } from '../../types/anchors'

interface AnchorHealthPanelProps {
  health: AnchorHealthSummary | null
  loading: boolean
  suggestedCount: number
  onSelectCandidate: (candidateId: string) => void
}

function StatCard({ value, label, amber }: { value: string | number; label: string; amber?: boolean }) {
  return (
    <div style={{ background: 'var(--color-bg-inset)', borderRadius: 8, padding: '12px 14px' }}>
      <div className="font-display" style={{ fontSize: 22, fontWeight: 700, color: amber ? '#d97706' : 'var(--color-text-primary)' }}>
        {value}
      </div>
      <div className="font-body" style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>{label}</div>
    </div>
  )
}

function SkeletonBlock() {
  return <div style={{ height: 60, background: 'var(--color-bg-inset)', borderRadius: 8, animation: 'pulse 1.5s ease infinite' }} />
}

const ISSUE_ICONS: Record<string, { icon: string; color: string }> = {
  isolated: { icon: '⚠', color: '#d97706' },
  low_nodes: { icon: '⚠', color: '#d97706' },
  dormant: { icon: '◑', color: '#6b7280' },
  single_source: { icon: 'ⓘ', color: '#3b82f6' },
}

export function AnchorHealthPanel({ health, loading, suggestedCount, onSelectCandidate }: AnchorHealthPanelProps) {
  if (loading) {
    return (
      <div style={{ padding: '24px 20px' }}>
        <h3 className="font-display" style={{ fontSize: 15, fontWeight: 700, marginBottom: 16, color: 'var(--color-text-primary)' }}>Anchor Health</h3>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <SkeletonBlock />
          <SkeletonBlock />
          <SkeletonBlock />
          <SkeletonBlock />
        </div>
      </div>
    )
  }

  const h = health ?? {
    totalConfirmed: 0, totalSuggested: 0, totalDormant: 0, avgNodesPerAnchor: 0,
    mostConnectedAnchor: null, isolatedAnchors: 0, staleAnchors: [],
  }

  return (
    <div style={{ padding: '24px 20px', height: '100%', overflowY: 'auto' }}>
      <h3 className="font-display" style={{ fontSize: 15, fontWeight: 700, marginBottom: 16, color: 'var(--color-text-primary)' }}>
        Anchor Health
      </h3>

      {/* Stats grid */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 20 }}>
        <StatCard value={h.totalConfirmed} label="Total Anchors" />
        <StatCard value={h.avgNodesPerAnchor} label="Avg. Nodes/Anchor" />
        <StatCard
          value={h.mostConnectedAnchor?.label ? (h.mostConnectedAnchor.label.length > 16 ? h.mostConnectedAnchor.label.slice(0, 16) + '…' : h.mostConnectedAnchor.label) : '—'}
          label={h.mostConnectedAnchor ? `${h.mostConnectedAnchor.nodeCount} connections` : 'Most Connected'}
        />
        <StatCard value={h.isolatedAnchors} label="no cross-connections" amber={h.isolatedAnchors > 0} />
      </div>

      {/* Needs Attention */}
      {h.staleAnchors.length > 0 && (
        <div style={{ marginBottom: 20 }}>
          <div className="font-display font-bold uppercase" style={{ fontSize: 10, letterSpacing: '0.08em', color: 'var(--color-text-secondary)', marginBottom: 8 }}>
            Needs Attention
          </div>
          <div className="flex flex-col gap-1">
            {h.staleAnchors.map(item => {
              const issue = ISSUE_ICONS[item.issue] ?? { icon: '⚠', color: '#d97706' }
              return (
                <button
                  key={item.candidateId}
                  type="button"
                  onClick={() => onSelectCandidate(item.candidateId)}
                  className="flex items-center gap-2 w-full text-left font-body"
                  style={{
                    padding: '6px 8px', borderRadius: 6, background: 'transparent',
                    border: 'none', cursor: 'pointer', fontSize: 12, transition: 'background 0.1s ease',
                  }}
                  onMouseEnter={e => { e.currentTarget.style.background = 'var(--color-bg-inset)' }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
                >
                  <span style={{ color: issue.color }}>{issue.icon}</span>
                  <span className="truncate" style={{ fontWeight: 600, color: 'var(--color-text-body)', flex: 1, minWidth: 0 }}>{item.label}</span>
                  <span className="truncate shrink-0" style={{ color: 'var(--color-text-secondary)', maxWidth: 160 }}>{item.detail}</span>
                </button>
              )
            })}
          </div>
        </div>
      )}

      {/* No suggestions note */}
      {suggestedCount === 0 && (
        <p className="font-body" style={{ fontSize: 12, color: 'var(--color-text-secondary)', lineHeight: 1.5 }}>
          No new suggestions right now. The system scores your graph after each extraction and daily at 3am UTC.
        </p>
      )}
    </div>
  )
}
