import { useState, useRef, useCallback } from 'react'
import { useAuth } from './useAuth'
import { useGraphContext } from './useGraphContext'
import { queryGraph, buildRAGResponseContext } from '../services/rag'
import { routedQuery } from '../services/ragRouter'
import type { ChatMessage, RAGPipelineStep, RAGResponseContext, RAGStepEvent, QueryConfig } from '../types/rag'
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
  sendMessage: (text: string, queryConfig?: QueryConfig, entryContext?: ChatEntryContext) => Promise<void>
  clearChat: () => void
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

      const assistantMessage: ChatMessage = {
        id: generateId(),
        role: 'assistant',
        content: response.answer,
        citations: response.citations,
        timestamp: new Date(),
        pipelineDurationMs,
      }

      setMessages(prev => [...prev, assistantMessage])
      setLastResponseContext(ctx)
      setAskContext(ctx)
      setRightPanelContent({ type: 'ask_context', data: ctx })
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
  }, [setRightPanelContent, setAskContext])

  return {
    messages,
    isLoading,
    currentStep,
    pipelineEvents,
    error,
    lastResponseContext,
    sendMessage,
    clearChat,
  }
}
