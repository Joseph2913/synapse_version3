import { useEffect, useState } from 'react'
import { Check } from 'lucide-react'
import type { RAGStepEvent, RAGPipelineStep } from '../../types/rag'

const STEP_ORDER: RAGPipelineStep[] = [
  'embedding',
  'semantic_search',
  'keyword_search',
  'graph_traversal',
  'context_assembly',
  'generating',
]

const STEP_LABELS: Record<RAGPipelineStep, string> = {
  embedding: 'Analysing question',
  semantic_search: 'Searching knowledge graph',
  keyword_search: 'Ranking results',
  graph_traversal: 'Traversing graph',
  context_assembly: 'Assembling context',
  generating: 'Generating answer',
}

const BRAILLE_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

function buildSummary(event: RAGStepEvent): string {
  const parts: string[] = []

  switch (event.step) {
    case 'embedding':
      if (event.subQueries && event.subQueries.length > 0) {
        const first = `"${(event.subQueries[0] ?? '').slice(0, 28)}"`
        const rest = event.subQueries.length > 1 ? ` +${event.subQueries.length - 1}` : ''
        parts.push(first + rest)
      }
      parts.push(event.hasEmbedding ? 'vector search on' : 'keyword only')
      break

    case 'semantic_search':
      if (event.sources) parts.push(`${event.sources} source${event.sources !== 1 ? 's' : ''}`)
      if (event.keywordNodes) parts.push(`${event.keywordNodes} nodes`)
      if (event.semanticChunks) parts.push(`${event.semanticChunks} semantic chunks`)
      break

    case 'keyword_search':
      if (event.rawChunks != null) parts.push(`${event.rawChunks} found`)
      if (event.rankedChunks != null) parts.push(`top ${event.rankedChunks} selected`)
      break

    case 'graph_traversal':
      if (event.seedNodes != null) parts.push(`${event.seedNodes} seeds`)
      if (event.graphNodes != null) parts.push(`${event.graphNodes} nodes`)
      if (event.graphEdges != null) parts.push(`${event.graphEdges} edges`)
      break

    case 'context_assembly':
      if (event.contextChunks != null) parts.push(`${event.contextChunks} chunks`)
      if (event.contextNodes != null) parts.push(`${event.contextNodes} nodes`)
      if (event.relationshipPaths != null) parts.push(`${event.relationshipPaths} paths`)
      break

    case 'generating':
      break
  }

  return parts.join(' · ')
}

interface RAGProgressIndicatorProps {
  events: RAGStepEvent[]
}

export function RAGProgressIndicator({ events }: RAGProgressIndicatorProps) {
  const [frameIndex, setFrameIndex] = useState(0)

  useEffect(() => {
    const interval = setInterval(() => {
      setFrameIndex(i => (i + 1) % BRAILLE_FRAMES.length)
    }, 80)
    return () => clearInterval(interval)
  }, [])

  const frame = BRAILLE_FRAMES[frameIndex] ?? '⠋'
  const eventMap = new Map(events.map(e => [e.step, e]))
  const stepsToShow = STEP_ORDER.filter(step => eventMap.has(step))

  // Initial state — no events yet
  if (stepsToShow.length === 0) {
    return (
      <div
        className="flex items-center font-body"
        style={{
          gap: 8,
          fontSize: 12,
          fontWeight: 500,
          color: 'var(--color-text-secondary)',
          maxWidth: '85%',
          padding: '10px 16px',
          background: 'var(--color-bg-card)',
          border: '1px solid var(--border-subtle)',
          borderRadius: '14px 14px 14px 4px',
        }}
      >
        <span style={{ fontFamily: 'monospace', fontSize: 14 }}>{frame}</span>
        <span>Analyzing query...</span>
      </div>
    )
  }

  return (
    <div
      className="font-body"
      style={{
        maxWidth: '85%',
        padding: '12px 16px',
        background: 'var(--color-bg-card)',
        border: '1px solid var(--border-subtle)',
        borderRadius: '14px 14px 14px 4px',
        display: 'flex',
        flexDirection: 'column',
        gap: 7,
      }}
    >
      {stepsToShow.map(step => {
        const event = eventMap.get(step)!
        const isRunning = event.status === 'running'
        const summary = event.status === 'done' ? buildSummary(event) : null

        return (
          <div
            key={step}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              fontSize: 12,
              fontWeight: 500,
            }}
          >
            {/* Status icon */}
            <span
              style={{
                width: 16,
                height: 16,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
              }}
            >
              {isRunning ? (
                <span
                  style={{
                    fontFamily: 'monospace',
                    fontSize: 14,
                    color: 'var(--color-text-secondary)',
                    lineHeight: 1,
                  }}
                >
                  {frame}
                </span>
              ) : (
                <Check
                  size={12}
                  style={{ color: 'var(--color-accent-500)', strokeWidth: 2.5 }}
                />
              )}
            </span>

            {/* Step label */}
            <span
              style={{
                color: isRunning
                  ? 'var(--color-text-secondary)'
                  : 'var(--color-text-primary)',
                minWidth: 140,
                fontWeight: isRunning ? 500 : 600,
              }}
            >
              {STEP_LABELS[step]}
            </span>

            {/* Data summary */}
            {summary && (
              <span
                style={{
                  color: 'var(--color-text-secondary)',
                  fontWeight: 400,
                  fontSize: 11,
                  opacity: 0.75,
                }}
              >
                {summary}
              </span>
            )}
          </div>
        )
      })}
    </div>
  )
}
