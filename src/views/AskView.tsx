import { useEffect, useRef, useState, useCallback } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { GripVertical } from 'lucide-react'
import { useAuth } from '../hooks/useAuth'
import { useRAGQuery } from '../hooks/useRAGQuery'
import { useChatScroll } from '../hooks/useChatScroll'
import { useQueryComposer } from '../hooks/useQueryComposer'
import { useGraphContext } from '../hooks/useGraphContext'
import { getGraphStats, fetchSourceById, fetchNodeById } from '../services/supabase'
import { fetchRecentSessions } from '../services/chatHistory'
import type { ChatSession } from '../services/chatHistory'
import { DEFAULT_QUERY_CONFIG } from '../types/rag'
import type { EnrichedChunk } from '../types/rag'
import { normalizeEntryContext } from '../types/chatRouting'
import { StatusBar } from '../components/ask/StatusBar'
import { ChatMessageList } from '../components/ask/ChatMessageList'
import { ChatInput } from '../components/ask/ChatInput'
import { EmptyAskState } from '../components/ask/EmptyAskState'
import { AskRightPanel } from '../components/ask/AskRightPanel'
import { NodeDetail } from '../components/panels/NodeDetail'
import { SourceDetail } from '../components/panels/SourceDetail'
import type { KnowledgeNode, KnowledgeSource } from '../types/database'

// ─── Layout constants ────────────────────────────────────────────────────────
const DEFAULT_LEFT_PCT = 64
const MIN_LEFT_PCT = 30
const MAX_LEFT_PCT = 80

export function AskView() {
  const { user } = useAuth()
  const location = useLocation()
  const navigate = useNavigate()
  const { messages, isLoading, pipelineEvents, error, activeEntryContext, sendMessage, clearChat, loadSession } = useRAGQuery()
  const scroll = useChatScroll(messages.length)
  const { rightPanelContent, askContext, setRightPanelContent, clearRightPanel } = useGraphContext()
  const {
    config,
    setMindset,
    toggleScopeAnchor,
    clearScope,
    setToolMode,
    setModelTier,
  } = useQueryComposer()
  const [graphIsEmpty, setGraphIsEmpty] = useState(false)
  const [recentSessions, setRecentSessions] = useState<ChatSession[]>([])
  const [highlightedCitationIndex, setHighlightedCitationIndex] = useState<number | null>(null)

  // Read chatContext or legacy autoQuery from navigation state via normalizeEntryContext
  const pendingContext = useRef(normalizeEntryContext(location.state))

  useEffect(() => {
    if (!user) return
    getGraphStats(user.id)
      .then(s => setGraphIsEmpty(s.nodeCount === 0))
      .catch(() => {})
    // Fetch recent sessions for empty state (PRD-D §2.8)
    fetchRecentSessions(user.id, 5)
      .then(setRecentSessions)
      .catch(() => setRecentSessions([]))
  }, [user])

  // Fire the auto-query once using the appropriate context
  useEffect(() => {
    const ctx = pendingContext.current
    if (!ctx || !user) return
    pendingContext.current = null
    navigate('/ask', { state: {}, replace: true })
    void sendMessage(ctx.autoQuery, DEFAULT_QUERY_CONFIG, ctx)
  }, [user, sendMessage, navigate])

  // ─── Drag resize ───────────────────────────────────────────────────────
  const containerRef = useRef<HTMLDivElement>(null)
  const [leftWidthPct, setLeftWidthPct] = useState(DEFAULT_LEFT_PCT)
  const [isDragging, setIsDragging] = useState(false)
  const dragStartX = useRef(0)
  const dragStartPct = useRef(DEFAULT_LEFT_PCT)

  const handleDividerMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    dragStartX.current = e.clientX
    dragStartPct.current = leftWidthPct
    setIsDragging(true)

    const onMove = (ev: MouseEvent) => {
      if (!containerRef.current) return
      const containerW = containerRef.current.getBoundingClientRect().width
      const delta = ev.clientX - dragStartX.current
      const deltaPct = (delta / containerW) * 100
      setLeftWidthPct(Math.min(MAX_LEFT_PCT, Math.max(MIN_LEFT_PCT, dragStartPct.current + deltaPct)))
    }
    const onUp = () => {
      setIsDragging(false)
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [leftWidthPct])

  // ─── Handlers ──────────────────────────────────────────────────────────
  const handleSend = (text: string) => {
    void sendMessage(text, config)
  }

  const handleSuggestion = (text: string) => {
    void sendMessage(text, config)
  }

  // PRD-C: Follow-up pill sends the question through the same pipeline, inheriting entry context
  const handleFollowUp = (question: string) => {
    void sendMessage(question, config)
  }

  // PRD-D §2.1: Citation click → right panel
  const handleCitationClick = useCallback(async (citationIndex: number) => {
    if (!askContext) return
    const citation = askContext.citations.find(c => c.index === citationIndex)
    if (!citation) return

    if (citation.source_id) {
      const source = await fetchSourceById(citation.source_id)
      if (source) {
        setRightPanelContent({ type: 'source', data: source })
        return
      }
    }
    if (citation.node_id) {
      const node = await fetchNodeById(citation.node_id)
      if (node) {
        setRightPanelContent({ type: 'node', data: node })
      }
    }
  }, [askContext, setRightPanelContent])

  // PRD-D §2.2: Entity badge click → node detail
  const handleEntityClick = useCallback((node: KnowledgeNode) => {
    setRightPanelContent({ type: 'node', data: node })
  }, [setRightPanelContent])

  // PRD-D §2.3: Source card click → source detail
  const handleSourceCardClick = useCallback(async (chunk: EnrichedChunk) => {
    const source = await fetchSourceById(chunk.source_id)
    if (source) {
      setRightPanelContent({ type: 'source', data: source })
    }
  }, [setRightPanelContent])

  // PRD-D §2.4: Connection chain node click → node detail
  const handleConnectionNodeClick = useCallback((label: string) => {
    const node = askContext?.relatedNodes.find(n => n.label === label)
    if (node) {
      setRightPanelContent({ type: 'node', data: node })
    }
  }, [askContext, setRightPanelContent])

  // PRD-D §2.8: Load a previous session
  const handleLoadSession = useCallback(async (sessionId: string) => {
    await loadSession(sessionId)
  }, [loadSession])

  const handleBackToAskContext = () => {
    if (askContext) {
      setRightPanelContent({ type: 'ask_context', data: askContext })
    } else {
      clearRightPanel()
    }
  }

  // PRD-D §2.5: "Ask about this" from detail panels
  const handleAskAboutNode = useCallback((node: KnowledgeNode) => {
    // Return to context panel, then send a scoped question
    if (askContext) {
      setRightPanelContent({ type: 'ask_context', data: askContext })
    } else {
      clearRightPanel()
    }
    const question = `Tell me more about "${node.label}" (${node.entity_type}).`
    void sendMessage(question, config)
  }, [askContext, setRightPanelContent, clearRightPanel, sendMessage, config])

  const handleAskAboutSource = useCallback((source: KnowledgeSource) => {
    if (askContext) {
      setRightPanelContent({ type: 'ask_context', data: askContext })
    } else {
      clearRightPanel()
    }
    const question = `Tell me more about "${source.title ?? 'this source'}".`
    void sendMessage(question, config)
  }, [askContext, setRightPanelContent, clearRightPanel, sendMessage, config])

  const hasMessages = messages.length > 0

  const helperText =
    config.scopeAnchors.length > 0
      ? `Scoped to ${config.scopeAnchors.length} anchor${config.scopeAnchors.length > 1 ? 's' : ''}`
      : undefined

  // ─── Right panel content (mirrors RightPanel.tsx Ask logic) ────────────
  const renderRightPanel = () => {
    if (rightPanelContent?.type === 'ask_context') {
      return (
        <AskRightPanel
          context={rightPanelContent.data}
          highlightedCitationIndex={highlightedCitationIndex}
          onEntityClick={handleEntityClick}
          onSourceCardClick={handleSourceCardClick}
          onConnectionNodeClick={handleConnectionNodeClick}
        />
      )
    }
    if (rightPanelContent?.type === 'node') {
      return (
        <div className="flex flex-col gap-0">
          {askContext && (
            <button
              type="button"
              onClick={handleBackToAskContext}
              className="font-body font-semibold cursor-pointer mb-3 text-left"
              style={{
                fontSize: 11,
                color: 'var(--color-text-secondary)',
                background: 'none',
                border: 'none',
                padding: '0 0 8px 0',
                borderBottom: '1px solid var(--border-subtle)',
              }}
            >
              ← Back to Context
            </button>
          )}
          <NodeDetail node={rightPanelContent.data} onClose={handleBackToAskContext} isAskView onAskAbout={handleAskAboutNode} />
        </div>
      )
    }
    if (rightPanelContent?.type === 'source') {
      return (
        <div className="flex flex-col gap-0">
          {askContext && (
            <button
              type="button"
              onClick={handleBackToAskContext}
              className="font-body font-semibold cursor-pointer mb-3 text-left"
              style={{
                fontSize: 11,
                color: 'var(--color-text-secondary)',
                background: 'none',
                border: 'none',
                padding: '0 0 8px 0',
                borderBottom: '1px solid var(--border-subtle)',
              }}
            >
              ← Back to Context
            </button>
          )}
          <SourceDetail source={rightPanelContent.data} onClose={handleBackToAskContext} isAskView onAskAbout={handleAskAboutSource} />
        </div>
      )
    }
    // Default placeholder
    return (
      <div className="flex flex-col gap-3">
        <p
          className="font-body"
          style={{ fontSize: 12, color: 'var(--color-text-placeholder)', lineHeight: 1.6 }}
        >
          Ask a question to see the context subgraph and source chunks used for the response.
        </p>
      </div>
    )
  }

  const panelTitle = () => {
    if (rightPanelContent?.type === 'ask_context') return 'Context'
    if (rightPanelContent?.type === 'node') return 'Entity Detail'
    if (rightPanelContent?.type === 'source') return 'Source Detail'
    return 'Context'
  }

  return (
    <div className="flex flex-col h-full">
      {/* Status bar — full width above the 2:1 split */}
      <StatusBar
        hasError={!!error && !hasMessages}
        hasMessages={hasMessages}
        onClearChat={clearChat}
        contextLabel={activeEntryContext?.displayLabel}
      />

      {/* 2:1 split */}
      <div
        ref={containerRef}
        className="flex flex-1 overflow-hidden"
        style={{
          userSelect: isDragging ? 'none' : undefined,
          cursor: isDragging ? 'col-resize' : undefined,
        }}
      >
        {/* ── Left column: chat area ──────────────────────────────────── */}
        <div
          className="flex flex-col"
          style={{
            width: `${leftWidthPct}%`,
            transition: isDragging ? 'none' : 'width 0.2s ease',
            height: '100%',
            flexShrink: 0,
          }}
        >
          {!hasMessages ? (
            <div className="flex-1 overflow-y-auto">
              <EmptyAskState
                onSendSuggestion={handleSuggestion}
                isEmpty={graphIsEmpty}
                sessions={recentSessions}
                onLoadSession={handleLoadSession}
              />
            </div>
          ) : (
            <ChatMessageList
              messages={messages}
              isLoading={isLoading}
              pipelineEvents={pipelineEvents}
              scroll={scroll}
              onFollowUpClick={handleFollowUp}
              onCitationClick={handleCitationClick}
              onCitationHoverChange={setHighlightedCitationIndex}
            />
          )}

          <ChatInput
            onSend={handleSend}
            disabled={isLoading}
            helperText={helperText}
            config={config}
            onSetMindset={setMindset}
            onToggleScopeAnchor={toggleScopeAnchor}
            onClearScope={clearScope}
            onSetToolMode={setToolMode}
            onSetModelTier={setModelTier}
          />
        </div>

        {/* ── Drag handle ─────────────────────────────────────────────── */}
        <div
          onMouseDown={handleDividerMouseDown}
          style={{
            width: 12,
            height: '100%',
            cursor: 'col-resize',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'var(--color-bg-content)',
            borderLeft: '1px solid var(--border-subtle)',
            flexShrink: 0,
            zIndex: 10,
          }}
        >
          <GripVertical size={14} style={{ color: 'var(--color-text-placeholder)', pointerEvents: 'none' }} />
        </div>

        {/* ── Right column: context panel ──────────────────────────────── */}
        <div
          className="flex flex-col"
          style={{
            flex: 1,
            height: '100%',
            overflow: 'hidden',
            minWidth: 0,
            background: 'var(--color-bg-card)',
          }}
        >
          {/* Panel header */}
          <div
            className="shrink-0 px-4 flex items-center"
            style={{ height: 50, borderBottom: '1px solid var(--border-subtle)' }}
          >
            <span className="font-display text-[12px] font-bold text-text-secondary uppercase tracking-[0.06em]">
              {panelTitle()}
            </span>
          </div>

          {/* Scrollable content */}
          <div
            className="flex-1 overflow-y-auto"
            style={{
              padding: 24,
              overflowX: 'hidden',
              minWidth: 0,
              overflowWrap: 'break-word',
              wordBreak: 'break-word',
            }}
          >
            {renderRightPanel()}
          </div>
        </div>
      </div>
    </div>
  )
}
