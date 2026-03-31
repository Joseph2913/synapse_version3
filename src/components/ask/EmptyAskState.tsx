import { MessageSquareText } from 'lucide-react'

interface EmptyAskStateProps {
  onSendSuggestion: (text: string) => void
  isEmpty?: boolean
  sessions?: unknown[]
  onLoadSession?: (sessionId: string) => void
}

export function EmptyAskState({ isEmpty = false }: EmptyAskStateProps) {
  return (
    <div className="flex flex-col items-center text-center" style={{ marginBottom: 32 }}>
      <MessageSquareText size={40} style={{ color: 'var(--color-text-placeholder)', marginBottom: 14 }} />
      <h2
        className="font-display font-bold"
        style={{ fontSize: 20, color: 'var(--color-text-primary)', marginBottom: 6 }}
      >
        Ask your knowledge graph
      </h2>
      <p
        className="font-body"
        style={{ fontSize: 13, color: 'var(--color-text-secondary)', maxWidth: 380, lineHeight: 1.6 }}
      >
        {isEmpty
          ? 'Start by ingesting content. Once you have entities and source chunks, you can query them here.'
          : 'Questions answered from your ingested content, with source citations and graph context.'}
      </p>
    </div>
  )
}
