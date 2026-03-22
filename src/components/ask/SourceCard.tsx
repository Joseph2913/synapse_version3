import type { EnrichedChunk } from '../../types/rag'

function timeAgoShort(dateStr: string): string {
  try {
    const diff = Date.now() - new Date(dateStr).getTime()
    const mins = Math.floor(diff / 60000)
    if (mins < 60) return `${mins}m ago`
    const hrs = Math.floor(mins / 60)
    if (hrs < 24) return `${hrs}h ago`
    const days = Math.floor(hrs / 24)
    if (days < 30) return `${days}d ago`
    const months = Math.floor(days / 30)
    if (months < 12) return `${months}mo ago`
    return `${Math.floor(months / 12)}y ago`
  } catch {
    return dateStr
  }
}

interface SourceCardProps {
  chunk: EnrichedChunk
  citationIndex?: number
  isHighlighted?: boolean
  /** When true, show "Same source" label instead of full summary (dedup) */
  isSameSourceAsPrevious?: boolean
  onClick?: () => void
}

export function SourceCard({ chunk, citationIndex, isHighlighted, isSameSourceAsPrevious, onClick }: SourceCardProps) {
  const timeAgo = timeAgoShort(chunk.sourceCreatedAt)

  return (
    <div
      style={{
        background: isHighlighted ? 'var(--color-accent-50)' : 'var(--color-bg-card)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 8,
        padding: '10px 12px',
        transition: 'background 0.5s ease, border-color 0.15s ease, box-shadow 0.15s ease',
        cursor: onClick ? 'pointer' : 'default',
      }}
      onClick={onClick}
      onMouseEnter={e => {
        const el = e.currentTarget as HTMLDivElement
        el.style.borderColor = 'var(--border-default)'
        el.style.boxShadow = '0 1px 3px rgba(0,0,0,0.04)'
      }}
      onMouseLeave={e => {
        const el = e.currentTarget as HTMLDivElement
        el.style.borderColor = 'var(--border-subtle)'
        el.style.boxShadow = 'none'
      }}
    >
      {/* Top row */}
      <div className="flex items-start" style={{ gap: 6, marginBottom: isSameSourceAsPrevious ? 6 : (chunk.sourceSummary ? 4 : 6) }}>
        {citationIndex !== undefined && (
          <span
            className="font-body font-bold shrink-0"
            style={{
              fontSize: 9,
              background: 'rgba(214,58,0,0.08)',
              border: '1px solid rgba(214,58,0,0.15)',
              borderRadius: 4,
              padding: '1px 4px',
              color: 'var(--color-accent-500)',
            }}
          >
            [{citationIndex}]
          </span>
        )}
        <span
          className="font-body font-semibold flex-1"
          style={{
            fontSize: 12,
            color: 'var(--color-text-primary)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {chunk.sourceTitle}
        </span>
        <span
          className="font-body shrink-0"
          style={{ fontSize: 10, color: 'var(--color-text-secondary)' }}
        >
          {timeAgo}
        </span>
      </div>

      {/* Source summary — show on first card from this source, "Same source" on subsequent */}
      {isSameSourceAsPrevious ? (
        <p
          className="font-body"
          style={{
            fontSize: 10,
            color: 'var(--color-text-secondary)',
            marginBottom: 6,
          }}
        >
          Same source
        </p>
      ) : chunk.sourceSummary ? (
        <p
          className="font-body"
          style={{
            fontSize: 12,
            fontWeight: 400,
            fontStyle: 'italic',
            color: 'var(--color-text-body)',
            opacity: 0.8,
            lineHeight: 1.45,
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
            marginBottom: 8,
          }}
        >
          {chunk.sourceSummary}
        </p>
      ) : null}

      {/* Snippet */}
      <p
        className="font-body"
        style={{
          fontSize: 11,
          fontWeight: 400,
          color: 'var(--color-text-body)',
          lineHeight: 1.5,
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
          marginBottom: 8,
        }}
      >
        {chunk.content.slice(0, 150)}…
      </p>

      {/* Similarity bar */}
      <div
        style={{
          height: 3,
          background: 'var(--color-bg-inset)',
          borderRadius: 2,
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            height: '100%',
            width: `${Math.min(100, Math.max(0, chunk.similarity * 100))}%`,
            background: 'var(--color-accent-300, #f4a584)',
            borderRadius: 2,
            transition: 'width 0.3s ease',
          }}
        />
      </div>
    </div>
  )
}
