import { useState, useCallback, useRef, useEffect, type KeyboardEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { Send, ExternalLink, MessageSquare } from 'lucide-react'

interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  citations?: Array<{ label: string; entity_type: string }>
}

export function ChatPanel() {
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [isAvailable, setIsAvailable] = useState(true)
  const messagesEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const handleSubmit = useCallback(async () => {
    const trimmed = query.trim()
    if (!trimmed || isLoading) return

    const userMsg: ChatMessage = { id: `u-${Date.now()}`, role: 'user', content: trimmed }
    setMessages(prev => [...prev, userMsg])
    setQuery('')
    setIsLoading(true)

    try {
      const res = await fetch('/api/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: trimmed }),
      })

      if (res.status === 404) {
        setIsAvailable(false)
        setMessages(prev => [...prev, {
          id: `a-${Date.now()}`,
          role: 'assistant',
          content: 'Ask is setting up — available after first ingestion.',
        }])
        return
      }

      if (!res.ok) {
        setMessages(prev => [...prev, {
          id: `a-${Date.now()}`,
          role: 'assistant',
          content: "Couldn't reach the knowledge base. Try again or open Ask for the full interface.",
        }])
        return
      }

      const data = await res.json() as { answer?: string; citations?: Array<{ label: string; entity_type: string }> }
      setMessages(prev => [...prev, {
        id: `a-${Date.now()}`,
        role: 'assistant',
        content: data.answer ?? '',
        citations: data.citations,
      }])
    } catch {
      setIsAvailable(false)
      setMessages(prev => [...prev, {
        id: `a-${Date.now()}`,
        role: 'assistant',
        content: 'Connection failed. The knowledge base may still be setting up.',
      }])
    } finally {
      setIsLoading(false)
    }
  }, [query, isLoading])

  const handleKeyDown = useCallback((e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSubmit()
    }
  }, [handleSubmit])

  return (
    <div className="flex flex-col h-full bg-bg-card border border-border-subtle" style={{ borderRadius: 12, overflow: 'hidden' }}>
      {/* Header */}
      <div className="flex items-center justify-between shrink-0" style={{ padding: '14px 20px', borderBottom: '1px solid var(--border-subtle)' }}>
        <div className="flex items-center" style={{ gap: 8 }}>
          <MessageSquare size={14} style={{ color: 'var(--color-accent-500)' }} />
          <span className="font-display text-text-primary" style={{ fontSize: 13, fontWeight: 700 }}>
            Quick Ask
          </span>
        </div>
        <button
          type="button"
          onClick={() => navigate('/ask')}
          className="flex items-center font-body cursor-pointer bg-transparent border-none"
          style={{
            gap: 4,
            fontSize: 11,
            fontWeight: 600,
            color: 'var(--color-accent-500)',
            padding: '4px 10px',
            borderRadius: 6,
            border: '1px solid rgba(214,58,0,0.15)',
            background: 'var(--color-accent-50)',
          }}
        >
          Full chat <ExternalLink size={10} />
        </button>
      </div>

      {/* Messages area */}
      <div className="flex-1 overflow-y-auto" style={{ padding: '16px 20px' }}>
        {messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center" style={{ padding: '32px 16px' }}>
            <MessageSquare size={28} style={{ color: 'var(--color-text-placeholder)', marginBottom: 12 }} />
            <p className="font-body text-text-secondary" style={{ fontSize: 13, lineHeight: 1.5 }}>
              Ask your knowledge base anything.
            </p>
            <p className="font-body text-text-placeholder" style={{ fontSize: 12, marginTop: 4 }}>
              Press Enter to send
            </p>
          </div>
        ) : (
          <div className="flex flex-col" style={{ gap: 16 }}>
            {messages.map((msg) => (
              <div key={msg.id} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div
                  style={{
                    maxWidth: '85%',
                    padding: '10px 14px',
                    borderRadius: msg.role === 'user' ? '12px 12px 4px 12px' : '12px 12px 12px 4px',
                    background: msg.role === 'user' ? 'var(--color-accent-500)' : 'var(--color-bg-inset)',
                    color: msg.role === 'user' ? 'white' : 'var(--color-text-body)',
                    fontSize: 13,
                    lineHeight: 1.5,
                  }}
                  className="font-body"
                >
                  {msg.content}
                  {msg.citations && msg.citations.length > 0 && (
                    <div className="flex flex-wrap" style={{ gap: 4, marginTop: 8 }}>
                      {msg.citations.map((c, i) => (
                        <span
                          key={i}
                          style={{
                            fontSize: 10,
                            fontWeight: 600,
                            padding: '2px 7px',
                            borderRadius: 4,
                            background: 'rgba(0,0,0,0.06)',
                            color: 'var(--color-text-secondary)',
                          }}
                        >
                          {c.label}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ))}
            {isLoading && (
              <div className="flex justify-start">
                <div
                  className="font-body"
                  style={{
                    padding: '10px 14px',
                    borderRadius: '12px 12px 12px 4px',
                    background: 'var(--color-bg-inset)',
                    color: 'var(--color-text-secondary)',
                    fontSize: 13,
                  }}
                >
                  <span className="animate-pulse">Thinking...</span>
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>
        )}
      </div>

      {/* Input area */}
      <div className="shrink-0" style={{ padding: '12px 16px', borderTop: '1px solid var(--border-subtle)' }}>
        <div className="flex items-end" style={{ gap: 8 }}>
          <textarea
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={isAvailable ? 'Ask your knowledge base...' : 'Setting up — available after first ingestion'}
            disabled={!isAvailable}
            rows={1}
            className="flex-1 font-body text-text-primary placeholder:text-text-placeholder outline-none resize-none"
            style={{
              background: 'var(--color-bg-inset)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 10,
              padding: '10px 14px',
              fontSize: 13,
              lineHeight: 1.4,
              maxHeight: 120,
            }}
          />
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!isAvailable || isLoading || !query.trim()}
            className="shrink-0 flex items-center justify-center border-none transition-colors duration-150"
            style={{
              width: 36,
              height: 36,
              borderRadius: 10,
              background: (!isAvailable || isLoading || !query.trim()) ? 'var(--color-bg-inset)' : 'var(--color-accent-500)',
              color: (!isAvailable || isLoading || !query.trim()) ? 'var(--color-text-placeholder)' : 'white',
              cursor: (!isAvailable || isLoading || !query.trim()) ? 'not-allowed' : 'pointer',
            }}
          >
            <Send size={14} />
          </button>
        </div>
      </div>
    </div>
  )
}
