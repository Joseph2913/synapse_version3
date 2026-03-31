import { useState, useRef, useCallback } from 'react'
import { useAuth } from './useAuth'
import { useGraphContext } from './useGraphContext'
import { queryGraph, buildRAGResponseContext } from '../services/rag'
import { routedQuery } from '../services/ragRouter'
import { createChatSession, appendMessages, fetchSession } from '../services/chatHistory'
import type { ChatMessage, RAGPipelineStep, RAGResponseContext, RAGStepEvent, QueryConfig, SourceReference } from '../types/rag'
import { DEFAULT_QUERY_CONFIG } from '../types/rag'
import type { ChatEntryContext } from '../types/chatRouting'

function generateId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36)
}

export interface UseRAGQueryReturn {
  messages: ChatMessage[]
  isLoading: boolean
  currentStep: RAGPipelineStep | null
  pipelineEvents: RAGStepEvent[]
  error: string | null
  lastResponseContext: RAGResponseContext | null
  activeEntryContext: ChatEntryContext | null
  activeSessionId: string | null
  sendMessage: (text: string, queryConfig?: QueryConfig, entryContext?: ChatEntryContext) => Promise<void>
  clearChat: () => void
  loadSession: (sessionId: string) => Promise<void>
}

export function useRAGQuery(): UseRAGQueryReturn {
  const { user } = useAuth()
  const { setRightPanelContent, setAskContext } = useGraphContext()
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [currentStep, setCurrentStep] = useState<RAGPipelineStep | null>(null)
  const [pipelineEvents, setPipelineEvents] = useState<RAGStepEvent[]>([])
  const [error, setError] = useState<string | null>(null)
  const [lastResponseContext, setLastResponseContext] = useState<RAGResponseContext | null>(null)
  const abortControllerRef = useRef<AbortController | null>(null)

  // Persist active entry context for follow-up messages
  const activeContextRef = useRef<ChatEntryContext | null>(null)
  const [activeEntryContext, setActiveEntryContext] = useState<ChatEntryContext | null>(null)

  // Session persistence (PRD-D §2.7)
  const sessionIdRef = useRef<string | null>(null)
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)

  const sendMessage = useCallback(async (text: string, queryConfig: QueryConfig = DEFAULT_QUERY_CONFIG, entryContext?: ChatEntryContext) => {
    if (!user) return
    if (!text.trim()) return

    // Handle /clear command
    if (text.trim() === '/clear') {
      setMessages([])
      setLastResponseContext(null)
      setAskContext(null)
      setRightPanelContent(null)
      return
    }

    // Cancel any in-flight request
    abortControllerRef.current?.abort()
    const controller = new AbortController()
    abortControllerRef.current = controller

    const userMessage: ChatMessage = {
      id: generateId(),
      role: 'user',
      content: text,
      timestamp: new Date(),
    }

    setMessages(prev => [...prev, userMessage])
    setIsLoading(true)
    setCurrentStep(null)
    setPipelineEvents([])
    setError(null)

    const startTime = Date.now()

    try {
      // Build conversation history from prior messages (last 3 exchanges = 6 messages)
      const conversationHistory = messages
        .slice(-6)
        .filter(m => m.role !== 'system')
        .map(m => ({ role: m.role, content: m.content }))

      // If a new entry context is provided, store it for follow-ups
      if (entryContext) {
        activeContextRef.current = entryContext
        setActiveEntryContext(entryContext)
      }

      const currentContext = entryContext ?? activeContextRef.current

      const stepHandler = (event: RAGStepEvent) => {
        if (!controller.signal.aborted) {
          if (event.status === 'running') setCurrentStep(event.step)
          setPipelineEvents(prev => {
            const idx = prev.findIndex(e => e.step === event.step)
            if (idx >= 0) {
              const updated = [...prev]
              updated[idx] = event
              return updated
            }
            return [...prev, event]
          })
        }
      }

      // Route through entry-point-specific pipeline when context is available
      const response = currentContext
        ? await routedQuery(text, user.id, conversationHistory, currentContext, stepHandler, controller.signal)
        : await queryGraph(text, user.id, conversationHistory, queryConfig, stepHandler, controller.signal)

      if (controller.signal.aborted) return

      const pipelineDurationMs = Date.now() - startTime
      const ctx = buildRAGResponseContext(response)

      // Build source bibliography: deduplicate chunks by source_id, assign indices
      const sourceOrderMap = new Map<string, number>() // source_id → 1-based index
      const sourcesUsed: SourceReference[] = []
      const chunkToSourceIndex: Record<number, number> = {}

      for (let i = 0; i < response.sourceChunks.length; i++) {
        const chunk = response.sourceChunks[i]!
        if (!sourceOrderMap.has(chunk.source_id)) {
          const idx = sourcesUsed.length + 1
          sourceOrderMap.set(chunk.source_id, idx)
          sourcesUsed.push({
            index: idx,
            sourceId: chunk.source_id,
            title: chunk.sourceTitle,
            sourceType: chunk.sourceType,
          })
        }
        chunkToSourceIndex[i + 1] = sourceOrderMap.get(chunk.source_id)!
      }

      const assistantMessage: ChatMessage = {
        id: generateId(),
        role: 'assistant',
        content: response.answer,
        citations: response.citations,
        timestamp: new Date(),
        pipelineDurationMs,
        followUp: response.followUp,
        sourcesUsed: sourcesUsed.length > 0 ? sourcesUsed : undefined,
        chunkToSourceIndex: Object.keys(chunkToSourceIndex).length > 0 ? chunkToSourceIndex : undefined,
      }

      setMessages(prev => [...prev, assistantMessage])
      setLastResponseContext(ctx)
      setAskContext(ctx)

      // Persist to chat_sessions (PRD-D §2.7)
      if (user) {
        if (!sessionIdRef.current) {
          const sid = await createChatSession(
            user.id,
            [userMessage, assistantMessage],
            currentContext ?? undefined,
            queryConfig
          )
          if (sid) {
            sessionIdRef.current = sid
            setActiveSessionId(sid)
          }
        } else {
          void appendMessages(sessionIdRef.current, [userMessage, assistantMessage])
        }
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return

      const errorText = err instanceof Error ? err.message : 'Unknown error'
      setError(errorText)

      let userFacingMessage = "I couldn't process that query. Please try again."

      if (errorText.includes('429')) {
        userFacingMessage = "The AI service is rate-limited. Please wait a moment before your next query."
      } else if (errorText.includes('embedding') || errorText.includes('VITE_GEMINI_API_KEY')) {
        userFacingMessage = "Failed to process your query — the embedding service is temporarily unavailable. Please try again in a moment."
      } else if (errorText.includes('connect') || errorText.includes('network') || errorText.includes('fetch')) {
        userFacingMessage = "Can't connect to the database. Check your internet connection."
      }

      const errorMessage: ChatMessage = {
        id: generateId(),
        role: 'system',
        content: userFacingMessage,
        timestamp: new Date(),
      }

      setMessages(prev => [...prev, errorMessage])
    } finally {
      setIsLoading(false)
      setCurrentStep(null)
    }
  }, [user, messages, setRightPanelContent, setAskContext])

  const clearChat = useCallback(() => {
    setMessages([])
    setLastResponseContext(null)
    setAskContext(null)
    setRightPanelContent(null)
    setError(null)
    activeContextRef.current = null
    setActiveEntryContext(null)
    sessionIdRef.current = null
    setActiveSessionId(null)
  }, [setRightPanelContent, setAskContext])

  const loadSession = useCallback(async (sessionId: string) => {
    const session = await fetchSession(sessionId)
    if (!session) return

    // Restore messages with Date objects for timestamps
    const restoredMessages = session.messages.map(m => ({
      ...m,
      timestamp: new Date(m.timestamp),
    }))
    setMessages(restoredMessages)

    // Restore entry context
    if (session.entry_context) {
      activeContextRef.current = session.entry_context
      setActiveEntryContext(session.entry_context)
    }

    sessionIdRef.current = sessionId
    setActiveSessionId(sessionId)
    setError(null)
  }, [])

  return {
    messages,
    isLoading,
    currentStep,
    pipelineEvents,
    error,
    lastResponseContext,
    activeEntryContext,
    activeSessionId,
    sendMessage,
    clearChat,
    loadSession,
  }
}
