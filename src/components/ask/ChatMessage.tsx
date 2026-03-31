import { useState, useRef } from 'react'
import { Sparkles } from 'lucide-react'
import { CitationTooltip } from './CitationTooltip'
import type { ChatMessage as ChatMessageType, InlineCitation } from '../../types/rag'

interface ChatMessageProps {
  message: ChatMessageType
  onCitationClick?: (index: number) => void
  onFollowUpClick?: (question: string) => void
  onCitationHoverChange?: (index: number | null) => void
  onExploreMore?: (citation: InlineCitation) => void
  isLatest?: boolean
}

interface HoveredCitation {
  citation: InlineCitation
  rect: DOMRect
}

/** Render a single citation badge */
function CitationBadge({
  citIndex,
  citation,
  onCitationClick,
  onCitationHover,
  onCitationLeave,
}: {
  citIndex: number
  citation: InlineCitation
  onCitationClick?: (index: number) => void
  onCitationHover?: (citation: InlineCitation, rect: DOMRect) => void
  onCitationLeave?: () => void
}) {
  return (
    <span
      onClick={() => onCitationClick?.(citIndex)}
      onMouseEnter={e => onCitationHover?.(citation, e.currentTarget.getBoundingClientRect())}
      onMouseLeave={onCitationLeave}
      className="font-body font-bold cursor-pointer"
      style={{
        background: 'rgba(214,58,0,0.08)',
        border: '1px solid rgba(214,58,0,0.15)',
        borderRadius: 4,
        padding: '1px 5px',
        fontSize: 10,
        fontWeight: 700,
        color: 'var(--color-accent-500)',
        verticalAlign: 'super',
        lineHeight: 1,
        transition: 'background 0.15s ease, border-color 0.15s ease',
      }}
    >
      {citIndex}
    </span>
  )
}

function parseContent(
  content: string,
  citations: InlineCitation[],
  onCitationClick?: (index: number) => void,
  onCitationHover?: (citation: InlineCitation, rect: DOMRect) => void,
  onCitationLeave?: () => void
): React.ReactNode[] {
  // Match both single [5] and grouped [5, 15, 19] citation patterns
  const parts = content.split(/(\[\d+(?:\s*,\s*\d+)*\])/g)
  return parts.map((part, i) => {
    // Check for citation bracket (single or comma-separated)
    const match = part.match(/^\[(\d+(?:\s*,\s*\d+)*)\]$/)
    if (match) {
      const indices = match[1]!.split(/\s*,\s*/).map(s => parseInt(s, 10))

      // Render each number as its own clickable badge
      const badges: React.ReactNode[] = []
      indices.forEach((citIndex, idx) => {
        const citation = citations.find(c => c.index === citIndex)
        if (citation) {
          badges.push(
            <CitationBadge
              key={`${i}-cit-${citIndex}`}
              citIndex={citIndex}
              citation={citation}
              onCitationClick={onCitationClick}
              onCitationHover={onCitationHover}
              onCitationLeave={onCitationLeave}
            />
          )
        } else {
          // No matching citation object — still render as clickable orange badge
          badges.push(
            <span
              key={`${i}-cit-${citIndex}`}
              onClick={() => onCitationClick?.(citIndex)}
              className="font-body font-bold cursor-pointer"
              style={{
                background: 'rgba(214,58,0,0.08)',
                border: '1px solid rgba(214,58,0,0.15)',
                borderRadius: 4,
                padding: '1px 5px',
                fontSize: 10,
                fontWeight: 700,
                color: 'var(--color-accent-500)',
                verticalAlign: 'super',
                lineHeight: 1,
                transition: 'background 0.15s ease, border-color 0.15s ease',
              }}
            >
              {citIndex}
            </span>
          )
        }
        // Add a thin space between badges in a group
        if (idx < indices.length - 1) {
          badges.push(<span key={`${i}-sep-${idx}`} style={{ width: 2, display: 'inline-block' }} />)
        }
      })

      return <span key={i}>{badges}</span>
    }

    // Parse markdown within non-citation parts
    const subParts = part.split(/(\*\*[^*]+\*\*|\n\n|\n|`[^`]+`)/)
    return subParts.map((sub, j) => {
      if (sub.startsWith('**') && sub.endsWith('**')) {
        return (
          <strong key={`${i}-${j}`} style={{ color: 'var(--color-text-primary)', fontWeight: 600 }}>
            {sub.slice(2, -2)}
          </strong>
        )
      }
      if (sub.startsWith('`') && sub.endsWith('`')) {
        return (
          <code
            key={`${i}-${j}`}
            className="font-body"
            style={{
              fontSize: 12,
              background: 'var(--color-bg-inset)',
              padding: '2px 6px',
              borderRadius: 4,
            }}
          >
            {sub.slice(1, -1)}
          </code>
        )
      }
      if (sub === '\n\n') return <br key={`${i}-${j}`} />
      if (sub === '\n') return <br key={`${i}-${j}`} />
      return sub
    })
  })
}

export function ChatMessage({ message, onCitationClick, onFollowUpClick, onCitationHoverChange, onExploreMore, isLatest }: ChatMessageProps) {
  const [expanded, setExpanded] = useState(false)
  const [hoveredCitation, setHoveredCitation] = useState<HoveredCitation | null>(null)
  const tooltipTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isOverTooltipRef = useRef(false)

  const isUser = message.role === 'user'
  const isSystem = message.role === 'system'
  const citations = message.citations ?? []

  const TRUNCATE_LENGTH = 500
  const shouldTruncate = isUser && message.content.length > TRUNCATE_LENGTH
  const displayContent = shouldTruncate && !expanded
    ? message.content.slice(0, TRUNCATE_LENGTH) + '...'
    : message.content

  const handleCitationHover = (citation: InlineCitation, rect: DOMRect) => {
    if (tooltipTimerRef.current) clearTimeout(tooltipTimerRef.current)
    tooltipTimerRef.current = setTimeout(() => {
      setHoveredCitation({ citation, rect })
    }, 200)
    onCitationHoverChange?.(citation.index)
  }

  const handleCitationLeave = () => {
    if (tooltipTimerRef.current) clearTimeout(tooltipTimerRef.current)
    // Delay dismiss so user can move mouse to the tooltip
    tooltipTimerRef.current = setTimeout(() => {
      if (!isOverTooltipRef.current) {
        setHoveredCitation(null)
        onCitationHoverChange?.(null)
      }
    }, 250)
  }

  const handleTooltipMouseEnter = () => {
    isOverTooltipRef.current = true
    if (tooltipTimerRef.current) clearTimeout(tooltipTimerRef.current)
  }

  const handleTooltipMouseLeave = () => {
    isOverTooltipRef.current = false
    tooltipTimerRef.current = setTimeout(() => {
      setHoveredCitation(null)
      onCitationHoverChange?.(null)
    }, 200)
  }

  if (isSystem) {
    return (
      <div
        className="flex justify-center font-body"
        style={{ animation: 'msg-enter 0.3s ease' }}
      >
        <style>{`
          @keyframes msg-enter {
            from { opacity: 0; transform: translateY(8px); }
            to { opacity: 1; transform: translateY(0); }
          }
        `}</style>
        <div
          style={{
            fontSize: 12,
            color: 'var(--color-text-secondary)',
            padding: '6px 12px',
            background: 'var(--color-bg-inset)',
            borderRadius: 8,
            border: '1px solid var(--border-subtle)',
            maxWidth: '70%',
            textAlign: 'center',
          }}
        >
          {message.content}
        </div>
      </div>
    )
  }

  return (
    <div
      className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}
      style={{ animation: 'msg-enter 0.3s ease' }}
    >
      <div
        style={{
          maxWidth: isUser ? '75%' : '90%',
          padding: '12px 16px',
          borderRadius: isUser ? '14px 14px 4px 14px' : '14px 14px 14px 4px',
          background: isUser ? 'var(--color-accent-50)' : 'var(--color-bg-card)',
          border: isUser
            ? '1px solid rgba(214,58,0,0.15)'
            : '1px solid var(--border-subtle)',
        }}
      >
        {/* Role label */}
        <div
          className="flex items-center font-body"
          style={{
            gap: 6,
            paddingBottom: 5,
            borderBottom: '1px solid var(--border-subtle)',
            marginBottom: 6,
          }}
        >
          {!isUser && (
            <Sparkles size={11} style={{ color: 'var(--color-accent-500)' }} />
          )}
          <span
            style={{
              fontSize: 10,
              fontWeight: 700,
              color: 'var(--color-text-secondary)',
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
            }}
          >
            {isUser ? 'You' : 'Synapse'}
          </span>
          {!isUser && message.pipelineDurationMs && (
            <span
              className="font-body"
              style={{ fontSize: 10, color: 'var(--color-text-placeholder)', marginLeft: 'auto' }}
            >
              {(message.pipelineDurationMs / 1000).toFixed(1)}s
            </span>
          )}
        </div>

        {/* Content with inline citations */}
        <div
          className="font-body"
          style={{
            fontSize: 13,
            fontWeight: 400,
            lineHeight: 1.6,
            color: 'var(--color-text-body)',
            whiteSpace: 'pre-wrap',
          }}
        >
          {isUser
            ? parseContent(displayContent, [])
            : parseContent(displayContent, citations, onCitationClick, handleCitationHover, handleCitationLeave)
          }
          {shouldTruncate && (
            <button
              type="button"
              onClick={() => setExpanded(e => !e)}
              className="font-body cursor-pointer"
              style={{
                display: 'block',
                marginTop: 4,
                fontSize: 11,
                color: 'var(--color-accent-500)',
                background: 'none',
                border: 'none',
                padding: 0,
              }}
            >
              {expanded ? 'Show less' : 'Show more'}
            </button>
          )}
        </div>

        {/* PRD-C: Follow-up suggestion pill — only on latest assistant message */}
        {!isUser && isLatest && message.followUp && (
          <button
            type="button"
            onClick={() => onFollowUpClick?.(message.followUp!.question)}
            className="font-body font-semibold cursor-pointer"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              marginTop: 10,
              padding: '7px 14px',
              borderRadius: 20,
              fontSize: 12,
              fontWeight: 600,
              color: 'var(--color-accent-500)',
              background: 'var(--color-accent-50)',
              border: '1px solid rgba(214,58,0,0.15)',
              transition: 'background 0.15s ease, border-color 0.15s ease',
            }}
            onMouseEnter={e => {
              e.currentTarget.style.background = 'rgba(214,58,0,0.1)'
              e.currentTarget.style.borderColor = 'rgba(214,58,0,0.25)'
            }}
            onMouseLeave={e => {
              e.currentTarget.style.background = 'var(--color-accent-50)'
              e.currentTarget.style.borderColor = 'rgba(214,58,0,0.15)'
            }}
          >
            {message.followUp.label} →
          </button>
        )}
      </div>

      {/* Citation tooltip portal-like overlay */}
      {hoveredCitation && (
        <div
          onMouseEnter={handleTooltipMouseEnter}
          onMouseLeave={handleTooltipMouseLeave}
        >
          <CitationTooltip
            citation={hoveredCitation.citation}
            rect={hoveredCitation.rect}
            onExploreMore={onExploreMore}
          />
        </div>
      )}
    </div>
  )
}
