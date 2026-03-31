import type { CrossConnectionEdge } from '../../services/supabase'

interface CrossConnectionItemProps {
  edge: CrossConnectionEdge
  onClick: () => void
}

function formatRelationType(rt: string): string {
  return rt.replace(/_/g, ' ')
}

export function CrossConnectionItem({ edge, onClick }: CrossConnectionItemProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex flex-col w-full text-left bg-transparent cursor-pointer hover:bg-bg-hover transition-all duration-150 border-none"
      style={{ padding: '16px 22px', borderBottom: '1px solid var(--border-subtle)' }}
    >
      <div className="flex items-center flex-wrap" style={{ gap: 8, marginBottom: 6 }}>
        <span
          className="font-display text-text-primary"
          style={{ fontSize: 14, fontWeight: 700, letterSpacing: '-0.01em' }}
        >
          {edge.sourceNode.label}
        </span>
        <span
          style={{
            fontSize: 11,
            fontWeight: 600,
            color: 'var(--color-accent-500)',
            background: 'var(--color-accent-50)',
            padding: '3px 10px',
            borderRadius: 4,
          }}
        >
          {formatRelationType(edge.relation_type)}
        </span>
        <span
          className="font-display text-text-primary"
          style={{ fontSize: 14, fontWeight: 700, letterSpacing: '-0.01em' }}
        >
          {edge.targetNode.label}
        </span>
      </div>
      <div className="font-body text-text-secondary" style={{ fontSize: 12 }}>
        {edge.sourceTitles[0]} &middot; {edge.sourceTitles[1]}
      </div>
    </button>
  )
}
