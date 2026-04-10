import { useEffect, useRef, useState, useCallback } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { X } from 'lucide-react'
import { useAuth } from '../hooks/useAuth'
import { useRAGQuery } from '../hooks/useRAGQuery'
import { useCouncilQuery } from '../hooks/useCouncilQuery'
import { useChatScroll } from '../hooks/useChatScroll'
import { useQueryComposer } from '../hooks/useQueryComposer'
import { useGraphContext } from '../hooks/useGraphContext'
import { getGraphStats, fetchSourceById, fetchNodeById } from '../services/supabase'
import { fetchRecentSessions } from '../services/chatHistory'
import type { ChatSession } from '../services/chatHistory'
import { DEFAULT_QUERY_CONFIG } from '../types/rag'
import type { EnrichedChunk, InlineCitation } from '../types/rag'
import { normalizeEntryContext } from '../types/chatRouting'
import { buildSourceChatContext, buildMultiSourceCompareContext } from '../config/chatEntryContexts'
import { StatusBar } from '../components/ask/StatusBar'
import { ChatMessageList } from '../components/ask/ChatMessageList'
import { ChatInput } from '../components/ask/ChatInput'
import type { AskMode } from '../components/ask/ChatInput'
import { EmptyAskState } from '../components/ask/EmptyAskState'
import { AskRightPanel } from '../components/ask/AskRightPanel'
import { CouncilResponse } from '../components/ask/CouncilResponse'
import { CouncilRightPanel } from '../components/ask/CouncilRightPanel'
import { SourceDetailCard } from '../components/explore/SourceDetailCard'
import { NodeDetail } from '../components/panels/NodeDetail'
import { SourceDetail } from '../components/panels/SourceDetail'
import type { KnowledgeNode, KnowledgeSource } from '../types/database'

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
  const { councilState, sendCouncilQuery, resetCouncil } = useCouncilQuery()
  const [askMode, setAskMode] = useState<AskMode>('standard')
  const [councilQuery, setCouncilQuery] = useState<string>('')
  const [graphIsEmpty, setGraphIsEmpty] = useState(false)
  const [recentSessions, setRecentSessions] = useState<ChatSession[]>([])
  const [highlightedCitationIndex, setHighlightedCitationIndex] = useState<number | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [exploringSourceId, setExploringSourceId] = useState<string | null>(null)

  // Read chatContext or legacy autoQuery from navigation state via normalizeEntryContext
  const pendingContext = useRef(normalizeEntryContext(location.state))

  useEffect(() => {
    if (!user) return
    getGraphStats(user.id)
      .then(s => setGraphIsEmpty(s.nodeCount === 0))
      .catch(() => {})
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

  // ─── Handlers ──────────────────────────────────────────────────────────
  const handleSend = (text: string) => {
    if (askMode === 'council') {
      setCouncilQuery(text)
      void sendCouncilQuery(text)
    } else {
      void sendMessage(text, config)
    }
  }

  const handleSuggestion = (text: string) => {
    void sendMessage(text, config)
  }

  const handleFollowUp = (question: string) => {
    if (askMode === 'council') {
      setCouncilQuery(question)
      void sendCouncilQuery(question)
    } else {
      void sendMessage(question, config)
    }
  }

  const handleCouncilFollowUp = (question: string) => {
    setCouncilQuery(question)
    void sendCouncilQuery(question)
  }

  // Resolve a citation index to a real source_id from source chunks
  // Chunks are numbered starting at 1 in the prompt, so citation [N] = sourceChunks[N-1]
  const resolveSourceId = useCallback((citationIndex: number): string | null => {
    // Primary: chunk-based lookup (always correct — real source_id from DB)
    const chunk = askContext?.sourceChunks?.[citationIndex - 1]
    if (chunk?.source_id) return chunk.source_id

    // Fallback: citation object's source_id (may be AI-hallucinated)
    const citation = askContext?.citations.find(c => c.index === citationIndex)
      ?? messages.flatMap(m => m.citations ?? []).find(c => c.index === citationIndex)
    return citation?.source_id ?? null
  }, [askContext, messages])

  // Citation click → open sidebar with source detail card
  const handleCitationClick = useCallback(async (citationIndex: number) => {
    const sourceId = resolveSourceId(citationIndex)
    if (sourceId) {
      setExploringSourceId(sourceId)
      setSidebarOpen(true)
      return
    }

    // If no source, check for node_id in citation
    const citation = askContext?.citations.find(c => c.index === citationIndex)
      ?? messages.flatMap(m => m.citations ?? []).find(c => c.index === citationIndex)
    if (citation?.node_id) {
      const node = await fetchNodeById(citation.node_id)
      if (node) {
        setRightPanelContent({ type: 'node', data: node })
        setSidebarOpen(true)
      }
    }
  }, [askContext, messages, resolveSourceId, setRightPanelContent])

  const handleEntityClick = useCallback((node: KnowledgeNode) => {
    setRightPanelContent({ type: 'node', data: node })
    setSidebarOpen(true)
  }, [setRightPanelContent])

  const handleSourceCardClick = useCallback(async (chunk: EnrichedChunk) => {
    const source = await fetchSourceById(chunk.source_id)
    if (source) {
      setRightPanelContent({ type: 'source', data: source })
      setSidebarOpen(true)
    }
  }, [setRightPanelContent])

  const handleConnectionNodeClick = useCallback((label: string) => {
    const node = askContext?.relatedNodes.find(n => n.label === label)
    if (node) {
      setRightPanelContent({ type: 'node', data: node })
      setSidebarOpen(true)
    }
  }, [askContext, setRightPanelContent])

  const handleLoadSession = useCallback(async (sessionId: string) => {
    await loadSession(sessionId)
  }, [loadSession])

  const closeSidebar = useCallback(() => {
    setSidebarOpen(false)
    setExploringSourceId(null)
    clearRightPanel()
  }, [clearRightPanel])

  const handleBackToAskContext = () => {
    if (askContext) {
      setRightPanelContent({ type: 'ask_context', data: askContext })
    } else {
      closeSidebar()
    }
  }

  const handleAskAboutNode = useCallback((node: KnowledgeNode) => {
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

  // "Explore more" from citation tooltip → open SourceDetailCard in sidebar
  const handleExploreMore = useCallback((citation: InlineCitation) => {
    // Prefer chunk-based source_id (real), fall back to citation's (may be hallucinated)
    const sourceId = resolveSourceId(citation.index) ?? citation.source_id
    if (sourceId) {
      setExploringSourceId(sourceId)
      setSidebarOpen(true)
    }
  }, [resolveSourceId])

  // Source bibliography click → open SourceDetailCard in sidebar
  const handleSourceClick = useCallback((sourceId: string) => {
    setExploringSourceId(sourceId)
    setSidebarOpen(true)
  }, [])

  // SourceDetailCard "Chat with this source" → send message inline
  const handleSourceCardChat = useCallback((source: { id: string; title: string; summary: string | null }) => {
    const ctx = buildSourceChatContext(source)
    setSidebarOpen(false)
    setExploringSourceId(null)
    void sendMessage(ctx.autoQuery, config, ctx)
  }, [sendMessage, config])

  // SourceDetailCard "Compare with related sources" → send message inline (multi-source)
  const handleSourceCardCompare = useCallback((primarySource: { id: string; title: string }, relatedSources: { id: string; title: string }[]) => {
    const ctx = buildMultiSourceCompareContext(primarySource, relatedSources)
    setSidebarOpen(false)
    setExploringSourceId(null)
    void sendMessage(ctx.autoQuery, config, ctx)
  }, [sendMessage, config])

  const hasMessages = messages.length > 0
  const councilActive = councilState.status !== 'idle'
  const hasContent = hasMessages || councilActive

  const helperText =
    config.scopeAnchors.length > 0
      ? `Scoped to ${config.scopeAnchors.length} anchor${config.scopeAnchors.length > 1 ? 's' : ''}`
      : undefined

  // ─── Sidebar panel content ────────────────────────────────────────────
  const renderSidebarContent = () => {
    // Council mode panel
    if (councilActive && councilQuery && !exploringSourceId && !rightPanelContent) {
      return (
        <CouncilRightPanel
          query={councilQuery}
          state={councilState}
        />
      )
    }
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
    return null
  }

  const panelTitle = () => {
    if (rightPanelContent?.type === 'ask_context') return 'Context'
    if (rightPanelContent?.type === 'node') return 'Entity Detail'
    if (rightPanelContent?.type === 'source') return 'Source Detail'
    return 'Context'
  }

  return (
    <div className="flex flex-col h-full relative overflow-hidden">
      {/* Status bar */}
      <StatusBar
        hasError={!!error && !hasMessages}
        hasMessages={hasContent}
        onClearChat={() => { clearChat(); resetCouncil(); setCouncilQuery('') }}
        contextLabel={councilActive ? 'Council mode' : activeEntryContext?.displayLabel}
      />

      {/* Full-width chat area */}
      <div className="flex-1 flex flex-col overflow-hidden" style={{ paddingBottom: 8 }}>
        {!hasContent ? (
          /* ── Centered empty state ──────────────────────────────────── */
          <div
            className="flex flex-1 flex-col items-center justify-center overflow-y-auto"
            style={{ padding: '0 24px 20px' }}
          >
            <div style={{ width: '100%', maxWidth: 680 }}>
              <EmptyAskState
                onSendSuggestion={handleSuggestion}
                isEmpty={graphIsEmpty}
                sessions={recentSessions}
                onLoadSession={handleLoadSession}
              />
            </div>
          </div>
        ) : councilActive ? (
          /* ── Council mode response ────────────────────────────────── */
          <div
            ref={scroll.scrollRef}
            className="flex-1 overflow-y-auto"
            onScroll={scroll.onScroll}
            style={{ scrollBehavior: 'smooth' }}
          >
            {/* Show any previous standard messages above council */}
            {hasMessages && (
              <ChatMessageList
                messages={messages}
                isLoading={false}
                pipelineEvents={[]}
                scroll={scroll}
                onFollowUpClick={handleFollowUp}
                onCitationClick={handleCitationClick}
                onCitationHoverChange={setHighlightedCitationIndex}
                onExploreMore={handleExploreMore}
                onSourceClick={handleSourceClick}
              />
            )}

            {/* Council query (rendered as user message style) */}
            {councilQuery && (
              <div style={{ maxWidth: 1020, margin: '0 auto', padding: '0 24px' }}>
                <div className="flex justify-end" style={{ marginBottom: 12 }}>
                  <div
                    className="font-body"
                    style={{
                      fontSize: 13,
                      color: 'var(--color-text-primary)',
                      background: 'var(--color-accent-50)',
                      border: '1px solid rgba(214,58,0,0.08)',
                      borderRadius: '16px 16px 4px 16px',
                      padding: '10px 16px',
                      maxWidth: '75%',
                    }}
                  >
                    {councilQuery}
                  </div>
                </div>
              </div>
            )}

            {/* Council response cards */}
            <CouncilResponse
              state={councilState}
              onFollowUpClick={handleCouncilFollowUp}
            />

            <div ref={scroll.bottomRef} style={{ height: 1 }} />
          </div>
        ) : (
          /* ── Standard chat messages ───────────────────────────────── */
          <ChatMessageList
            messages={messages}
            isLoading={isLoading}
            pipelineEvents={pipelineEvents}
            scroll={scroll}
            onFollowUpClick={handleFollowUp}
            onCitationClick={handleCitationClick}
            onCitationHoverChange={setHighlightedCitationIndex}
            onExploreMore={handleExploreMore}
            onSourceClick={handleSourceClick}
          />
        )}

        {/* Chat input — always at bottom */}
        <ChatInput
          onSend={handleSend}
          disabled={isLoading || (askMode === 'council' && councilState.status !== 'idle' && councilState.status !== 'complete' && councilState.status !== 'error')}
          helperText={helperText}
          embedded={!hasContent}
          config={config}
          onSetMindset={setMindset}
          onToggleScopeAnchor={toggleScopeAnchor}
          onClearScope={clearScope}
          onSetToolMode={setToolMode}
          onSetModelTier={setModelTier}
          askMode={askMode}
          onAskModeChange={setAskMode}
        />
      </div>

      {/* ── Slide-in sidebar overlay ─────────────────────────────────── */}
      {sidebarOpen && (exploringSourceId || rightPanelContent) && (
        <>
          {/* Backdrop */}
          <div
            onClick={closeSidebar}
            style={{
              position: 'absolute',
              inset: 0,
              background: 'rgba(0,0,0,0.08)',
              zIndex: 40,
            }}
          />

          {/* Panel */}
          <div
            className="flex flex-col"
            style={{
              position: 'absolute',
              top: 0,
              right: 0,
              bottom: 0,
              width: 400,
              maxWidth: '90%',
              background: 'var(--color-bg-card)',
              borderLeft: '1px solid var(--border-subtle)',
              boxShadow: '-4px 0 24px rgba(0,0,0,0.1)',
              zIndex: 50,
              animation: 'slideInRight 0.2s ease',
            }}
          >
            {exploringSourceId ? (
              /* ── SourceDetailCard (Explore-style card) ─────────────── */
              <SourceDetailCard
                sourceId={exploringSourceId}
                bare
                onClose={closeSidebar}
                onNavigateToSource={(id) => {
                  setExploringSourceId(id)
                }}
                onChatWithSourceOverride={handleSourceCardChat}
                onCompareWithSourcesOverride={handleSourceCardCompare}
              />
            ) : (
              /* ── Standard citation/entity/source panel ──────────────── */
              <>
                {/* Panel header */}
                <div
                  className="shrink-0 px-4 flex items-center justify-between"
                  style={{ height: 50, borderBottom: '1px solid var(--border-subtle)' }}
                >
                  <span className="font-display text-[12px] font-bold text-text-secondary uppercase tracking-[0.06em]">
                    {panelTitle()}
                  </span>
                  <button
                    type="button"
                    onClick={closeSidebar}
                    className="flex items-center justify-center cursor-pointer"
                    style={{
                      width: 28,
                      height: 28,
                      borderRadius: 6,
                      background: 'transparent',
                      border: '1px solid var(--border-subtle)',
                      color: 'var(--color-text-secondary)',
                      transition: 'all 0.15s ease',
                    }}
                    onMouseEnter={e => {
                      e.currentTarget.style.borderColor = 'var(--border-default)'
                      e.currentTarget.style.color = 'var(--color-text-primary)'
                    }}
                    onMouseLeave={e => {
                      e.currentTarget.style.borderColor = 'var(--border-subtle)'
                      e.currentTarget.style.color = 'var(--color-text-secondary)'
                    }}
                  >
                    <X size={14} />
                  </button>
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
                  {renderSidebarContent()}
                </div>
              </>
            )}
          </div>

          <style>{`
            @keyframes slideInRight {
              from { transform: translateX(100%); }
              to { transform: translateX(0); }
            }
          `}</style>
        </>
      )}
    </div>
  )
}
