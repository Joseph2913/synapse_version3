import { supabase } from './supabase'

// ─── Types ───────────────────────────────────────────────────────────────────

export interface MicrosoftIntegration {
  id: string
  user_id: string
  microsoft_email: string | null
  display_name: string | null
  status: 'connected' | 'paused' | 'error' | 'expired'
  error_message: string | null
  sync_calendar: boolean
  sync_mail: boolean
  sync_transcripts: boolean
  extraction_mode: string
  anchor_emphasis: string
  linked_anchor_ids: string[]
  custom_instructions: string | null
  last_calendar_sync: string | null
  last_mail_sync: string | null
  calendar_subscription_expires: string | null
  mail_subscription_expires: string | null
  created_at: string
  updated_at: string
}

export interface MicrosoftQueueStats {
  pending: number
  processing: number
  completed: number
  failed: number
}

// ─── Fetch Integration Status ────────────────────────────────────────────────

export async function getMicrosoftIntegration(): Promise<MicrosoftIntegration | null> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null

  const { data, error } = await supabase
    .from('microsoft_integrations')
    .select('id, user_id, microsoft_email, display_name, status, error_message, sync_calendar, sync_mail, sync_transcripts, extraction_mode, anchor_emphasis, linked_anchor_ids, custom_instructions, last_calendar_sync, last_mail_sync, calendar_subscription_expires, mail_subscription_expires, created_at, updated_at')
    .eq('user_id', user.id)
    .maybeSingle()

  if (error) {
    console.warn('[microsoft] Failed to fetch integration:', error.message)
    return null
  }

  return data as MicrosoftIntegration | null
}

// ─── Connect (initiate OAuth) ────────────────────────────────────────────────

export async function connectMicrosoft(): Promise<string> {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session?.access_token) throw new Error('Not authenticated')

  const res = await fetch('/api/auth/microsoft-connect', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.access_token}`,
    },
  })

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Connection failed' })) as { error?: string }
    throw new Error(err.error ?? `Connection failed: ${res.status}`)
  }

  const { authUrl } = await res.json() as { authUrl: string }
  return authUrl
}

// ─── Disconnect ──────────────────────────────────────────────────────────────

export async function disconnectMicrosoft(): Promise<void> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')

  const { error } = await supabase
    .from('microsoft_integrations')
    .delete()
    .eq('user_id', user.id)

  if (error) throw new Error(`Failed to disconnect: ${error.message}`)
}

// ─── Update Settings ─────────────────────────────────────────────────────────

export async function updateMicrosoftSettings(updates: Partial<{
  sync_calendar: boolean
  sync_mail: boolean
  sync_transcripts: boolean
  extraction_mode: string
  anchor_emphasis: string
  linked_anchor_ids: string[]
  custom_instructions: string | null
  status: 'connected' | 'paused'
}>): Promise<void> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')

  const { error } = await supabase
    .from('microsoft_integrations')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('user_id', user.id)

  if (error) throw new Error(`Failed to update settings: ${error.message}`)
}

// ─── Queue Stats ─────────────────────────────────────────────────────────────

export async function getMicrosoftQueueStats(): Promise<MicrosoftQueueStats> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { pending: 0, processing: 0, completed: 0, failed: 0 }

  const { data } = await supabase
    .from('microsoft_ingestion_queue')
    .select('status')
    .eq('user_id', user.id)

  if (!data) return { pending: 0, processing: 0, completed: 0, failed: 0 }

  const rows = data as { status: string }[]
  return {
    pending: rows.filter(r => r.status === 'pending').length,
    processing: rows.filter(r => ['fetching_content', 'content_ready', 'extracting'].includes(r.status)).length,
    completed: rows.filter(r => r.status === 'completed').length,
    failed: rows.filter(r => r.status === 'failed').length,
  }
}

// ─── Trigger Sync ────────────────────────────────────────────────────────────

export async function triggerMicrosoftSync(): Promise<{ eventsQueued: number; messagesQueued: number }> {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session?.access_token) throw new Error('Not authenticated')

  const res = await fetch('/api/microsoft/sync', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.access_token}`,
    },
  })

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Sync failed' })) as { error?: string }
    throw new Error(err.error ?? `Sync failed: ${res.status}`)
  }

  const data = await res.json() as { results?: Array<{ eventsQueued?: number; messagesQueued?: number }> }
  const result = data.results?.[0]
  return {
    eventsQueued: result?.eventsQueued ?? 0,
    messagesQueued: result?.messagesQueued ?? 0,
  }
}

// ─── Trigger Processing ──────────────────────────────────────────────────────

export async function triggerMicrosoftProcess(): Promise<{ processed: number }> {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session?.access_token) throw new Error('Not authenticated')

  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` }

  // Step 1: Fetch content for pending items
  await fetch('/api/microsoft/fetch-transcripts', { method: 'POST', headers })

  // Step 2: Extract knowledge from items with content
  const extractRes = await fetch('/api/microsoft/extract-knowledge', { method: 'POST', headers })
  if (!extractRes.ok) {
    const err = await extractRes.json().catch(() => ({ error: 'Processing failed' })) as { error?: string }
    throw new Error(err.error ?? `Processing failed: ${extractRes.status}`)
  }

  return extractRes.json() as Promise<{ processed: number }>
}
