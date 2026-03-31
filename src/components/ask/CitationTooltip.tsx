import { ArrowRight } from 'lucide-react'
import type { InlineCitation } from '../../types/rag'

interface CitationTooltipProps {
  citation: InlineCitation
  rect: DOMRect
  onExploreMore?: (citation: InlineCitation) => void
}

export function CitationTooltip({ citation, rect, onExploreMore }: CitationTooltipProps) {
  return (
    <div
      className="font-body"
      data-citation-tooltip
      style={{
        position: 'fixed',
        top: rect.top - 8,
        left: rect.left + rect.width / 2,
        transform: 'translate(-50%, -100%)',
        zIndex: 1000,
        background: 'var(--color-bg-card)',
        border: '1px solid var(--border-default)',
        borderRadius: 8,
        padding: '10px 14px',
        maxWidth: 300,
        boxShadow: '0 4px 12px rgba(0,0,0,0.08)',
        pointerEvents: 'auto',
      }}
    >
      <div
        style={{
          fontSize: 12,
          fontWeight: 600,
          color: 'var(--color-text-primary)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          marginBottom: 4,
        }}
      >
        {citation.label}
      </div>
      <div
        style={{
          display: 'inline-block',
          fontSize: 10,
          fontWeight: 600,
          color: 'var(--color-text-secondary)',
          background: 'var(--color-bg-inset)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 4,
          padding: '1px 5px',
          marginBottom: citation.snippet ? 6 : 0,
        }}
      >
        {citation.entity_type}
      </div>
      {citation.snippet && (
        <div
          style={{
            fontSize: 11,
            fontWeight: 400,
            color: 'var(--color-text-secondary)',
            lineHeight: 1.5,
            marginTop: 4,
          }}
        >
          {citation.snippet}…
        </div>
      )}
      {onExploreMore && citation.source_id && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onExploreMore(citation)
          }}
          className="flex items-center gap-1 font-body font-semibold cursor-pointer w-full"
          style={{
            marginTop: 8,
            paddingTop: 8,
            borderTop: '1px solid var(--border-subtle)',
            fontSize: 11,
            color: 'var(--color-accent-500)',
            background: 'none',
            border: 'none',
            borderTopWidth: 1,
            borderTopStyle: 'solid',
            borderTopColor: 'var(--border-subtle)',
            padding: '8px 0 0',
            transition: 'opacity 0.15s ease',
          }}
          onMouseEnter={e => { e.currentTarget.style.opacity = '0.8' }}
          onMouseLeave={e => { e.currentTarget.style.opacity = '1' }}
        >
          Explore more <ArrowRight size={11} />
        </button>
      )}
    </div>
  )
}
