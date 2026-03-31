import { useState, useCallback, type KeyboardEvent } from 'react'
import { useNavigate } from 'react-router-dom'

interface QueryResponse {
  answer: string
  citations: Array<{ label: string; entity_type: string }>
}

export function QuickQueryWidget() {
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const [response, setResponse] = useState<QueryResponse | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [isAvailable, setIsAvailable] = useState(true)

  const handleSubmit = useCallback(async () => {
    const trimmed = query.trim()
    if (!trimmed || isLoading) return

    setIsLoading(true)
    setError(null)
    setResponse(null)

    try {
      const res = await fetch('/api/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: trimmed }),
      })

      if (res.status === 404) {
        setIsAvailable(false)
        return
      }

      if (!res.ok) {
        setError("Couldn't reach the knowledge base. Try again or open Ask for the full interface.")
        return
      }

      const data = await res.json() as { answer?: string; citations?: Array<{ label: string; entity_type: string }> }
      setResponse({
        answer: data.answer ?? '',
        citations: data.citations ?? [],
      })
    } catch {
      setIsAvailable(false)
    } finally {
      setIsLoading(false)
    }
  }, [query, isLoading])

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        handleSubmit()
      }
      if (e.key === 'Escape') {
        setResponse(null)
        setError(null)
      }
    },
    [handleSubmit],
  )

  const handleOpenInAsk = useCallback(() => {
    navigate('/ask', { state: { initialQuery: query, initialResponse: response } })
  }, [navigate, query, response])

  return (
    <div className="bg-bg-card border border-border-subtle" style={{ borderRadius: 12, padding: '20px 22px' }}>
      <div
        className="font-display text-text-secondary uppercase"
        style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', marginBottom: 14 }}
      >
        Quick Query
      </div>

      <div className="flex items-center" style={{ gap: 12 }}>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ask your knowledge base..."
          disabled={!isAvailable}
          className="flex-1 font-body text-text-primary placeholder:text-text-placeholder outline-none transition-all duration-150"
          style={{
            background: 'var(--color-bg-inset)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 8,
            padding: '12px 16px',
            fontSize: 14,
          }}
        />
        <button
          type="button"
          onClick={handleSubmit}
          disabled={!isAvailable || isLoading || !query.trim()}
          className="font-body text-white border-none transition-colors duration-150"
          style={{
            background: (!isAvailable || isLoading || !query.trim()) ? 'rgba(214,58,0,0.5)' : 'var(--color-accent-500)',
            borderRadius: 8,
            padding: '12px 22px',
            fontSize: 14,
            fontWeight: 600,
            cursor: (!isAvailable || isLoading || !query.trim()) ? 'not-allowed' : 'pointer',
            whiteSpace: 'nowrap',
          }}
        >
          {isLoading ? 'Asking...' : 'Ask'}
        </button>
      </div>

      {!isAvailable && (
        <p className="font-body text-text-secondary" style={{ fontSize: 12, marginTop: 10 }}>
          Ask is setting up — available after first ingestion.
        </p>
      )}

      {isLoading && (
        <div className="flex flex-col" style={{ marginTop: 16, gap: 8 }}>
          <div className="bg-bg-inset animate-pulse" style={{ height: 14, borderRadius: 4, width: '100%' }} />
          <div className="bg-bg-inset animate-pulse" style={{ height: 14, borderRadius: 4, width: '80%' }} />
          <div className="bg-bg-inset animate-pulse" style={{ height: 14, borderRadius: 4, width: '60%' }} />
        </div>
      )}

      {error && (
        <div style={{ marginTop: 16, background: 'var(--color-bg-content)', border: '1px solid var(--border-subtle)', borderRadius: 10, padding: '16px 18px' }}>
          <p className="font-body text-text-secondary" style={{ fontSize: 13, fontStyle: 'italic' }}>{error}</p>
        </div>
      )}

      {response && !isLoading && (
        <div style={{ marginTop: 16, background: 'var(--color-bg-content)', border: '1px solid var(--border-subtle)', borderRadius: 10, padding: '16px 18px' }}>
          <p className="font-body text-text-body" style={{ fontSize: 14, lineHeight: 1.6 }}>
            {response.answer}
          </p>
          <div className="flex items-center justify-between" style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--border-subtle)' }}>
            <div className="flex items-center flex-wrap" style={{ gap: 6 }}>
              {response.citations.map((c, i) => (
                <span
                  key={i}
                  style={{ fontSize: 10, fontWeight: 600, padding: '2px 8px', borderRadius: 4, background: 'rgba(0,0,0,0.05)', color: 'var(--color-text-secondary)' }}
                >
                  {c.label}
                </span>
              ))}
            </div>
            <button
              type="button"
              onClick={handleOpenInAsk}
              className="font-body cursor-pointer bg-transparent border-none"
              style={{
                fontSize: 12,
                fontWeight: 600,
                color: 'var(--color-accent-500)',
                padding: '4px 12px',
                borderRadius: 6,
                border: '1px solid rgba(214,58,0,0.15)',
                background: 'var(--color-accent-50)',
              }}
            >
              Open in Ask →
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
