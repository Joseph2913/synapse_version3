import { ChevronDown } from 'lucide-react'
import { ChatMessage } from './ChatMessage'
import { RAGProgressIndicator } from './RAGProgressIndicator'
import type { ChatMessage as ChatMessageType, RAGStepEvent, InlineCitation } from '../../types/rag'
import type { UseChatScrollReturn } from '../../hooks/useChatScroll'

interface ChatMessageListProps {
  messages: ChatMessageType[]
  isLoading: boolean
  pipelineEvents: RAGStepEvent[]
  scroll: UseChatScrollReturn
  onCitationClick?: (index: number) => void
  onFollowUpClick?: (question: string) => void
  onCitationHoverChange?: (index: number | null) => void
  onExploreMore?: (citation: InlineCitation) => void
}

export function ChatMessageList({
  messages,
  isLoading,
  pipelineEvents,
  scroll,
  onCitationClick,
  onFollowUpClick,
  onCitationHoverChange,
  onExploreMore,
}: ChatMessageListProps) {
  return (
    <div
      ref={scroll.scrollRef}
      className="flex-1 overflow-y-auto relative"
      onScroll={scroll.onScroll}
      style={{ scrollBehavior: 'smooth' }}
    >
      <div
        className="flex flex-col"
        style={{ maxWidth: 1020, margin: '0 auto', padding: '24px 24px', gap: 16, width: '100%' }}
      >
        {messages.map((message, i) => {
          // PRD-C: Only show follow-up pill on the latest assistant message
          const isLatestAssistant = message.role === 'assistant'
            && i === messages.length - 1
            || (message.role === 'assistant' && messages.slice(i + 1).every(m => m.role !== 'assistant'))
          return (
            <ChatMessage
              key={message.id}
              message={message}
              onCitationClick={onCitationClick}
              onFollowUpClick={onFollowUpClick}
              onCitationHoverChange={onCitationHoverChange}
              onExploreMore={onExploreMore}
              isLatest={isLatestAssistant}
            />
          )
        })}

        {isLoading && (
          <div className="flex justify-start">
            <RAGProgressIndicator events={pipelineEvents} />
          </div>
        )}

        <div ref={scroll.bottomRef} style={{ height: 1 }} />
      </div>

      {/* Scroll pill */}
      {scroll.showScrollPill && (
        <div
          className="absolute bottom-4 left-1/2 -translate-x-1/2"
          style={{ zIndex: 10 }}
        >
          <button
            type="button"
            onClick={() => scroll.scrollToBottom()}
            className="flex items-center font-body font-semibold cursor-pointer"
            style={{
              gap: 4,
              fontSize: 11,
              color: 'var(--color-accent-500)',
              background: 'var(--color-bg-card)',
              border: '1px solid var(--border-default)',
              borderRadius: 8,
              padding: '6px 12px',
              animation: 'fade-in 0.2s ease',
            }}
          >
            <ChevronDown size={12} />
            New message
          </button>
          <style>{`
            @keyframes fade-in {
              from { opacity: 0 }
              to { opacity: 1 }
            }
          `}</style>
        </div>
      )}
    </div>
  )
}
