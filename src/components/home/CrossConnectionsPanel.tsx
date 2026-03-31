import { useNavigate } from 'react-router-dom'
import { CrossConnectionItem } from './CrossConnectionItem'
import type { CrossConnectionEdge } from '../../services/supabase'

interface CrossConnectionsPanelProps {
  connections: CrossConnectionEdge[]
  loading: boolean
  error?: string
  onConnectionClick: (edge: CrossConnectionEdge) => void
}

export function CrossConnectionsPanel({
  connections,
  loading,
  error,
  onConnectionClick,
}: CrossConnectionsPanelProps) {
  const navigate = useNavigate()

  return (
    <div className="bg-bg-card border border-border-subtle overflow-hidden" style={{ borderRadius: 12 }}>
      {/* Header */}
      <div
        className="flex items-center justify-between"
        style={{ padding: '16px 22px', borderBottom: '1px solid var(--border-subtle)' }}
      >
        <span
          className="font-display text-text-secondary uppercase"
          style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.08em' }}
        >
          Cross-Connection Discoveries
        </span>
        <button
          type="button"
          onClick={() => navigate('/explore')}
          className="font-body cursor-pointer bg-transparent border-none"
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: 'var(--color-accent-500)',
            padding: '4px 12px',
            borderRadius: 6,
            border: '1px solid rgba(214,58,0,0.15)',
            background: 'var(--color-accent-50)',
            transition: 'all 0.15s ease',
          }}
        >
          View all →
        </button>
      </div>

      {/* Content */}
      {loading ? (
        <div style={{ padding: '18px 22px' }} className="flex flex-col gap-[14px]">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i}>
              <div className="bg-bg-inset animate-pulse" style={{ height: 14, borderRadius: 4, width: '80%', marginBottom: 6 }} />
              <div className="bg-bg-inset animate-pulse" style={{ height: 12, borderRadius: 4, width: '50%' }} />
            </div>
          ))}
        </div>
      ) : error ? (
        <div style={{ padding: '20px 22px' }}>
          <p className="font-body text-text-secondary" style={{ fontSize: 13, fontStyle: 'italic' }}>{error}</p>
        </div>
      ) : connections.length === 0 ? (
        <div style={{ padding: '20px 22px' }}>
          <p className="font-body text-text-secondary" style={{ fontSize: 13 }}>
            No cross-connections discovered yet. They appear when entities from different sources share relationships.
          </p>
        </div>
      ) : (
        <div>
          {connections.map((edge) => (
            <CrossConnectionItem
              key={edge.id}
              edge={edge}
              onClick={() => onConnectionClick(edge)}
            />
          ))}
        </div>
      )}
    </div>
  )
}
