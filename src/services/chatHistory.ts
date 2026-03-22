/**
 * PRD-D §2.7: Chat session persistence.
 * CRUD operations for the chat_sessions table.
 */

import { supabase } from './supabase'
import type { ChatMessage, QueryConfig } from '../types/rag'
import type { ChatEntryContext } from '../types/chatRouting'

export interface ChatSession {
  id: string
  user_id: string
  title: string | null
  messages: ChatMessage[]
  entry_context: ChatEntryContext | null
  last_query_config: QueryConfig | null
  message_count: number
  created_at: string
  updated_at: string
}

/** Create a new chat session. Returns the session ID. */
export async function createChatSession(
  userId: string,
  messages: ChatMessage[],
  entryContext?: ChatEntryContext,
  queryConfig?: QueryConfig
): Promise<string | null> {
  // Auto-generate title from first user message
  const firstUserMsg = messages.find(m => m.role === 'user')
  const title = firstUserMsg
    ? firstUserMsg.content.slice(0, 60) + (firstUserMsg.content.length > 60 ? '…' : '')
    : null

  const { data, error } = await supabase
    .from('chat_sessions')
    .insert({
      user_id: userId,
      title,
      messages: JSON.parse(JSON.stringify(messages)),
      entry_context: entryContext ? JSON.parse(JSON.stringify(entryContext)) : null,
      last_query_config: queryConfig ? JSON.parse(JSON.stringify(queryConfig)) : null,
      message_count: messages.length,
    })
    .select('id')
    .single()

  if (error) {
    console.error('[chatHistory] createChatSession error:', error)
    return null
  }
  return data.id as string
}

/** Append messages to an existing session. */
export async function appendMessages(
  sessionId: string,
  newMessages: ChatMessage[]
): Promise<void> {
  // Fetch current messages, append, update
  const { data: session, error: fetchError } = await supabase
    .from('chat_sessions')
    .select('messages, message_count')
    .eq('id', sessionId)
    .single()

  if (fetchError || !session) {
    console.error('[chatHistory] appendMessages fetch error:', fetchError)
    return
  }

  const existing = (session.messages as unknown as ChatMessage[]) ?? []
  // Cap at 50 most recent messages
  const combined = [...existing, ...newMessages].slice(-50)

  const { error: updateError } = await supabase
    .from('chat_sessions')
    .update({
      messages: JSON.parse(JSON.stringify(combined)),
      message_count: (session.message_count as number) + newMessages.length,
      updated_at: new Date().toISOString(),
    })
    .eq('id', sessionId)

  if (updateError) {
    console.error('[chatHistory] appendMessages update error:', updateError)
  }
}

/** Fetch recent sessions for the session list. */
export async function fetchRecentSessions(
  userId: string,
  limit = 5
): Promise<ChatSession[]> {
  const { data, error } = await supabase
    .from('chat_sessions')
    .select('id, user_id, title, message_count, created_at, updated_at, entry_context')
    .eq('user_id', userId)
    .order('updated_at', { ascending: false })
    .limit(limit)

  if (error) {
    console.error('[chatHistory] fetchRecentSessions error:', error)
    return []
  }

  return (data ?? []).map(row => ({
    id: row.id as string,
    user_id: row.user_id as string,
    title: row.title as string | null,
    messages: [], // Not loaded for list view
    entry_context: row.entry_context as ChatEntryContext | null,
    last_query_config: null,
    message_count: row.message_count as number,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  }))
}

/** Fetch a single session with full messages. */
export async function fetchSession(
  sessionId: string
): Promise<ChatSession | null> {
  const { data, error } = await supabase
    .from('chat_sessions')
    .select('*')
    .eq('id', sessionId)
    .single()

  if (error || !data) {
    console.error('[chatHistory] fetchSession error:', error)
    return null
  }

  return {
    id: data.id as string,
    user_id: data.user_id as string,
    title: data.title as string | null,
    messages: (data.messages as unknown as ChatMessage[]) ?? [],
    entry_context: data.entry_context as ChatEntryContext | null,
    last_query_config: data.last_query_config as QueryConfig | null,
    message_count: data.message_count as number,
    created_at: data.created_at as string,
    updated_at: data.updated_at as string,
  }
}

/** Delete a session. */
export async function deleteSession(sessionId: string): Promise<void> {
  const { error } = await supabase
    .from('chat_sessions')
    .delete()
    .eq('id', sessionId)

  if (error) {
    console.error('[chatHistory] deleteSession error:', error)
  }
}
