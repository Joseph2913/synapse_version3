import { supabase } from './supabase'
import { fetchPlaylistMetadata } from './youtube'
import { getMicrosoftIntegration, getMicrosoftQueueStats } from './microsoft'
import { fetchGitHubRepos, fetchGitHubQueueStats } from './githubIntegration'

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SourceSettings {
  mode: string
  emphasis: string
  linkedAnchorIds: string[]
  customInstructions?: string
}

export const DEFAULT_SOURCE_SETTINGS: SourceSettings = {
  mode: 'comprehensive',
  emphasis: 'standard',
  linkedAnchorIds: [],
  customInstructions: '',
}

export interface AutomationSource {
  id: string
  category: 'youtube-playlist' | 'meeting' | 'microsoft' | 'github'
  name: string
  handle?: string
  channel?: string
  description?: string
  status: 'active' | 'paused' | 'connected' | 'disconnected' | 'error'
  videosIngested?: number
  meetingsIngested?: number
  digestsIngested?: number
  lastScan?: string
  lastSync?: string
  mode: string
  emphasis: string
  linkedAnchors: string[]
  customInstructions?: string
  iconUrl?: string
  provider?: string
  queue: {
    pending: number
    processing: number
    complete: number
    failed: number
  }
}

export interface IngestedItem {
  id: string
  title: string
  ingestedAt: string
  nodes?: number
  edges?: number
}

export interface QueueItemDisplay {
  id: string
  title: string
  sourceId: string
  status: 'pending' | 'processing' | 'complete' | 'failed'
  step: 'queued' | 'fetching' | 'extracting' | 'connecting' | 'complete'
  time: string
  error?: string
  nodes?: number
  edges?: number
}

export interface QueueSummary {
  pending: number
  processing: number
  failed: number
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function toRelativeTime(isoString: string | null | undefined): string {
  if (!isoString) return 'Never'
  const timestamp = new Date(isoString).getTime()
  if (isNaN(timestamp)) return 'Never'
  const diff = Date.now() - timestamp
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return 'Just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  const weeks = Math.floor(days / 7)
  return `${weeks}w ago`
}

type RawQueueRow = { playlist_id: string | null; status: string }

function buildQueueCounts(rows: RawQueueRow[], id: string) {
  const relevant = rows.filter(r => r.playlist_id === id)
  return {
    pending: relevant.filter(r => r.status === 'pending').length,
    processing: relevant.filter(r => r.status === 'fetching_transcript' || r.status === 'extracting').length,
    complete: relevant.filter(r => r.status === 'completed').length,
    failed: relevant.filter(r => r.status === 'failed').length,
  }
}

// ─── Fetch All Sources ────────────────────────────────────────────────────────

export async function fetchAutomationSources(): Promise<AutomationSource[]> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return []

  const [playlistsRes, queueRes, meetingsRes] = await Promise.all([
    supabase
      .from('youtube_playlists')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false }),
    supabase
      .from('youtube_ingestion_queue')
      .select('playlist_id, status')
      .eq('user_id', user.id),
    supabase
      .from('knowledge_sources')
      .select('id, title, created_at, metadata')
      .eq('source_type', 'Meeting')
      .limit(100),
  ])

  const queueRows: RawQueueRow[] = (queueRes.data ?? []) as RawQueueRow[]
  const sources: AutomationSource[] = []

  // YouTube playlists
  for (const pl of (playlistsRes.data ?? []) as Record<string, unknown>[]) {
    const plStatus = (pl.status as string) === 'active' || (pl.is_active as boolean) ? 'active' : 'paused'
    const plQueue = buildQueueCounts(queueRows, pl.id as string)
    sources.push({
      id: pl.id as string,
      category: 'youtube-playlist',
      name: (pl.playlist_name as string) || 'Unnamed Playlist',
      channel: (pl.channel_name as string) || undefined,
      description: (pl.description as string) || undefined,
      status: plStatus as AutomationSource['status'],
      videosIngested: plQueue.complete,
      lastScan: toRelativeTime(pl.updated_at as string | null),
      mode: (pl.extraction_mode as string) || 'comprehensive',
      emphasis: (pl.anchor_emphasis as string) || 'standard',
      linkedAnchors: (pl.linked_anchor_ids as string[]) || [],
      customInstructions: (pl.custom_instructions as string) || undefined,
      queue: plQueue,
    })
  }

  // Meeting integration (synthetic) — detect provider from metadata
  const meetingRows = (meetingsRes.data ?? []) as Record<string, unknown>[]
  const meetingCount = meetingRows.length
  if (meetingCount > 0) {
    // Detect provider from meeting metadata (e.g. { provider: 'circleback' })
    const providerCounts = new Map<string, number>()
    // Count queue states from metadata.extraction_status
    let meetingPending = 0
    let meetingProcessing = 0
    let meetingFailed = 0
    let meetingComplete = 0
    for (const m of meetingRows) {
      const meta = m.metadata as Record<string, unknown> | null
      const provider = (meta?.provider as string) || 'unknown'
      providerCounts.set(provider, (providerCounts.get(provider) ?? 0) + 1)
      const extractionStatus = meta?.extraction_status as string | undefined
      if (extractionStatus === 'pending') meetingPending++
      else if (extractionStatus === 'processing') meetingProcessing++
      else if (extractionStatus === 'failed') meetingFailed++
      else meetingComplete++
    }
    // Use the most common provider; default to Circleback since it's the only active integration
    const topProvider = [...providerCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'unknown'
    const resolvedProvider = topProvider === 'unknown' ? 'circleback' : topProvider

    const PROVIDER_CONFIG: Record<string, { name: string; iconUrl?: string; description: string }> = {
      circleback: { name: 'Circleback', iconUrl: '/logos/circleback.jpeg', description: 'Meeting transcripts via Circleback' },
      fireflies: { name: 'Fireflies', iconUrl: '/logos/fireflies.jpeg', description: 'Meeting transcripts via Fireflies' },
      otter: { name: 'Otter.ai', description: 'Meeting transcripts via Otter.ai' },
    }
    const fallback: { name: string; iconUrl?: string; description: string } = { name: 'Meeting Transcripts', description: 'Auto-captured meeting transcripts via connected services' }
    const providerInfo = PROVIDER_CONFIG[resolvedProvider] ?? fallback

    // Check for user-customized name (stored in localStorage for synthetic source)
    const customMeetingName = typeof window !== 'undefined'
      ? localStorage.getItem('synapse:meeting-integration-name')
      : null

    sources.push({
      id: 'meeting-integration',
      category: 'meeting',
      name: customMeetingName || providerInfo.name,
      handle: 'Meeting Integration',
      description: providerInfo.description,
      status: 'connected',
      meetingsIngested: meetingComplete,
      lastSync: toRelativeTime(meetingRows[0]?.created_at as string | null),
      mode: 'comprehensive',
      emphasis: 'standard',
      linkedAnchors: [],
      iconUrl: providerInfo.iconUrl,
      provider: resolvedProvider,
      queue: { pending: meetingPending, processing: meetingProcessing, complete: meetingComplete, failed: meetingFailed },
    })
  }

  // Microsoft 365 integration
  try {
    const msIntegration = await getMicrosoftIntegration()
    if (msIntegration) {
      const msQueue = await getMicrosoftQueueStats()
      sources.push({
        id: 'microsoft-integration',
        category: 'microsoft',
        name: msIntegration.display_name
          ? `Microsoft 365 (${msIntegration.display_name})`
          : 'Microsoft 365',
        handle: msIntegration.microsoft_email ?? 'Outlook & Teams',
        description: [
          msIntegration.sync_calendar ? 'Calendar' : '',
          msIntegration.sync_mail ? 'Email' : '',
          msIntegration.sync_transcripts ? 'Teams Transcripts' : '',
        ].filter(Boolean).join(' + ') || 'Outlook & Teams Integration',
        status: msIntegration.status === 'connected' ? 'connected'
          : msIntegration.status === 'paused' ? 'paused'
          : msIntegration.status === 'expired' ? 'error'
          : 'error',
        meetingsIngested: msQueue.completed,
        lastSync: toRelativeTime(msIntegration.last_calendar_sync ?? msIntegration.last_mail_sync),
        mode: msIntegration.extraction_mode,
        emphasis: msIntegration.anchor_emphasis,
        linkedAnchors: msIntegration.linked_anchor_ids ?? [],
        customInstructions: msIntegration.custom_instructions ?? undefined,
        iconUrl: '/logos/microsoft.svg',
        provider: 'microsoft',
        queue: {
          pending: msQueue.pending,
          processing: msQueue.processing,
          complete: msQueue.completed,
          failed: msQueue.failed,
        },
      })
    }
  } catch {
    // microsoft_integrations table may not exist yet
  }

  // GitHub tracked repos
  try {
    const ghRepos = await fetchGitHubRepos()
    const ghQueueStats = await fetchGitHubQueueStats()

    for (const repo of ghRepos) {
      sources.push({
        id: repo.id,
        category: 'github',
        name: repo.display_name,
        handle: `${repo.repo_owner}/${repo.repo_name}`,
        description: `Tracking ${repo.default_branch} branch`,
        status: repo.is_active
          ? (repo.status === 'active' ? 'active' : repo.status === 'error' ? 'error' : 'paused')
          : 'paused',
        videosIngested: ghQueueStats.completed,
        lastScan: toRelativeTime(repo.last_scanned_at),
        mode: repo.extraction_mode,
        emphasis: repo.anchor_emphasis,
        linkedAnchors: repo.linked_anchor_ids ?? [],
        customInstructions: repo.custom_instructions ?? undefined,
        iconUrl: '/logos/github.svg',
        provider: 'github',
        queue: {
          pending: ghQueueStats.pending,
          processing: ghQueueStats.processing,
          complete: ghQueueStats.completed,
          failed: ghQueueStats.failed,
        },
      })
    }
  } catch {}

  return sources
}

// ─── Fetch Queue for Source ───────────────────────────────────────────────────

export async function fetchSourceQueue(
  sourceId: string,
  _category: AutomationSource['category'] = 'youtube-playlist'
): Promise<QueueItemDisplay[]> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return []

  const baseQuery = supabase
    .from('youtube_ingestion_queue')
    .select('*')
    .eq('user_id', user.id)
    .eq('playlist_id', sourceId)
    .order('created_at', { ascending: false })
    .limit(20)

  const { data, error } = await baseQuery

  if (error) {
    console.warn('[automationSources] fetchSourceQueue error:', error)
    return []
  }

  return ((data ?? []) as Record<string, unknown>[]).map(item => {
    const rawStatus = item.status as string
    let displayStatus: QueueItemDisplay['status'] = 'pending'
    let step: QueueItemDisplay['step'] = 'queued'

    if (rawStatus === 'completed') {
      displayStatus = 'complete'
      step = 'complete'
    } else if (rawStatus === 'failed') {
      displayStatus = 'failed'
      step = 'fetching'
    } else if (rawStatus === 'extracting') {
      displayStatus = 'processing'
      const startedAt = item.started_at ? new Date(item.started_at as string).getTime() : 0
      step = startedAt && Date.now() - startedAt > 30000 ? 'connecting' : 'extracting'
    } else if (rawStatus === 'fetching_transcript') {
      displayStatus = 'processing'
      step = 'fetching'
    } else {
      displayStatus = 'pending'
      step = 'queued'
    }

    return {
      id: item.id as string,
      title: (item.video_title as string) || 'Untitled Video',
      sourceId,
      status: displayStatus,
      step,
      time: toRelativeTime(item.created_at as string),
      error: (item.error_message as string) || undefined,
      nodes: (item.nodes_created as number) || undefined,
      edges: (item.edges_created as number) || undefined,
    }
  })
}

// ─── Queue Summary ────────────────────────────────────────────────────────────

export async function fetchQueueSummary(): Promise<QueueSummary> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { pending: 0, processing: 0, failed: 0 }

  const { data } = await supabase
    .from('youtube_ingestion_queue')
    .select('status')
    .eq('user_id', user.id)
    .in('status', ['pending', 'fetching_transcript', 'extracting', 'failed'])

  const rows = (data ?? []) as { status: string }[]
  return {
    pending: rows.filter(r => r.status === 'pending').length,
    processing: rows.filter(r => r.status === 'fetching_transcript' || r.status === 'extracting').length,
    failed: rows.filter(r => r.status === 'failed').length,
  }
}

// ─── Fetch Ingested Content ───────────────────────────────────────────────────

// Calls YouTube Data API v3 from the browser with the user's own API key.
async function fetchYTPlaylistVideoIds(ytPlaylistId: string, apiKey: string): Promise<string[]> {
  const videoIds: string[] = []
  let pageToken: string | undefined

  for (let page = 0; page < 4; page++) {
    const params = new URLSearchParams({
      part: 'contentDetails',
      playlistId: ytPlaylistId,
      maxResults: '50',
      key: apiKey,
    })
    if (pageToken) params.set('pageToken', pageToken)

    try {
      const res = await fetch(
        `https://www.googleapis.com/youtube/v3/playlistItems?${params}`,
        { signal: AbortSignal.timeout(10000) }
      )
      if (!res.ok) break

      const data = await res.json() as {
        items?: Array<{ contentDetails?: { videoId?: string } }>
        nextPageToken?: string
      }

      for (const item of data.items ?? []) {
        const videoId = item.contentDetails?.videoId
        if (videoId) videoIds.push(videoId)
      }

      pageToken = data.nextPageToken
      if (!pageToken) break
    } catch {
      break
    }
  }

  return videoIds
}

function mapQueueRows(rows: Record<string, unknown>[]): IngestedItem[] {
  return rows.map(item => ({
    id: item.id as string,
    title: (item.video_title as string) || 'Untitled Video',
    ingestedAt: toRelativeTime(item.created_at as string),
    nodes: (item.nodes_created as number) || undefined,
    edges: (item.edges_created as number) || undefined,
  }))
}

export async function fetchIngestedContent(
  sourceId: string,
  category: AutomationSource['category']
): Promise<IngestedItem[]> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return []

  // ── Microsoft 365 ────────────────────────────────────────────────────────────
  if (category === 'microsoft') {
    try {
      const { data } = await supabase
        .from('microsoft_ingestion_queue')
        .select('id, title, created_at, nodes_created, edges_created')
        .eq('user_id', user.id)
        .eq('status', 'completed')
        .order('created_at', { ascending: false })
        .limit(50)
      return ((data ?? []) as Record<string, unknown>[]).map(s => ({
        id: s.id as string,
        title: (s.title as string) || 'Untitled Item',
        ingestedAt: toRelativeTime(s.created_at as string),
        nodes: (s.nodes_created as number) || undefined,
        edges: (s.edges_created as number) || undefined,
      }))
    } catch {
      return []
    }
  }

  // ── Meetings ────────────────────────────────────────────────────────────────
  if (category === 'meeting') {
    const { data } = await supabase
      .from('knowledge_sources')
      .select('id, title, created_at')
      .eq('user_id', user.id)
      .eq('source_type', 'Meeting')
      .order('created_at', { ascending: false })
      .limit(50)
    return ((data ?? []) as Record<string, unknown>[]).map(s => ({
      id: s.id as string,
      title: (s.title as string) || 'Untitled Meeting',
      ingestedAt: toRelativeTime(s.created_at as string),
    }))
  }

  // ── YouTube playlists ────────────────────────────────────────────────────
  // Strategy:
  //   Tier 1 – Client-side YouTube API via VITE_YOUTUBE_API_KEY env var.
  //            Works in all environments (local Vite dev, production).
  //            Also backfills playlist_id on historical queue rows.
  //   Tier 2 – Server-side Vercel endpoint (YOUTUBE_API_KEY server env var).
  //            Fallback for when no client-side key is configured.
  //   Tier 3 – playlist_id column only (post-migration rows, no API needed).

  // Get the YouTube playlist ID from DB
  const plRes = await supabase
    .from('youtube_playlists')
    .select('playlist_id')
    .eq('id', sourceId)
    .eq('user_id', user.id)
    .maybeSingle()

  const ytPlaylistId = (plRes.data as { playlist_id: string } | null)?.playlist_id

  // Helper: backfill playlist_id on existing rows then return ingested list
  const backfillAndFetch = async (videoIds: string[]): Promise<IngestedItem[]> => {
    if (videoIds.length === 0) return []
    await supabase
      .from('youtube_ingestion_queue')
      .update({ playlist_id: sourceId })
      .eq('user_id', user.id)
      .in('video_id', videoIds)
      .is('playlist_id', null)
    const { data } = await supabase
      .from('youtube_ingestion_queue')
      .select('id, video_title, created_at, nodes_created, edges_created')
      .eq('user_id', user.id)
      .in('video_id', videoIds)
      .eq('status', 'completed')
      .order('created_at', { ascending: false })
      .limit(50)
    return mapQueueRows((data ?? []) as Record<string, unknown>[])
  }

  // Tier 1: client-side YouTube API using VITE_YOUTUBE_API_KEY
  const viteApiKey = (import.meta.env.VITE_YOUTUBE_API_KEY as string | undefined) ?? null
  if (ytPlaylistId && viteApiKey) {
    const videoIds = await fetchYTPlaylistVideoIds(ytPlaylistId, viteApiKey)
    if (videoIds.length > 0) {
      return backfillAndFetch(videoIds)
    }
  }

  // Tier 2: server-side endpoint (Vercel deployment / vercel dev)
  try {
    const { data: { session } } = await supabase.auth.getSession()
    const authToken = session?.access_token
    if (authToken) {
      const res = await fetch('/api/youtube/playlist-ingested', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${authToken}`,
        },
        body: JSON.stringify({ playlist_uuid: sourceId }),
      })
      if (res.ok) {
        const json = await res.json() as { items?: Array<{ id: string; title: string; ingestedAt: string; nodes?: number; edges?: number }> }
        return (json.items ?? []).map(item => ({
          id: item.id,
          title: item.title,
          ingestedAt: toRelativeTime(item.ingestedAt),
          nodes: item.nodes,
          edges: item.edges,
        }))
      }
    }
  } catch { /* not available in local Vite dev — fall through */ }

  // Tier 3: playlist_id column only (catches post-migration rows, no API needed)
  const { data: newRows } = await supabase
    .from('youtube_ingestion_queue')
    .select('id, video_title, created_at, nodes_created, edges_created')
    .eq('user_id', user.id)
    .eq('playlist_id', sourceId)
    .eq('status', 'completed')
    .order('created_at', { ascending: false })
    .limit(50)
  return mapQueueRows((newRows ?? []) as Record<string, unknown>[])
}

// ─── Update Source Settings ───────────────────────────────────────────────────

export async function updateSourceSettings(
  sourceId: string,
  category: AutomationSource['category'],
  settings: SourceSettings
): Promise<void> {
  const baseUpdate: Record<string, unknown> = {
    extraction_mode: settings.mode,
    anchor_emphasis: settings.emphasis,
    linked_anchor_ids: settings.linkedAnchorIds,
    custom_instructions: settings.customInstructions ?? null,
    updated_at: new Date().toISOString(),
  }

  if (category === 'youtube-playlist') {
    const { error } = await supabase
      .from('youtube_playlists')
      .update(baseUpdate)
      .eq('id', sourceId)
    if (error) throw new Error(error.message)
  } else if (category === 'microsoft') {
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) throw new Error('Not authenticated')
    const { error } = await supabase
      .from('microsoft_integrations')
      .update(baseUpdate)
      .eq('user_id', user.id)
    if (error) throw new Error(error.message)
  }
  // meeting integration: no persistent record to update
}

// ─── Add YouTube Playlist ─────────────────────────────────────────────────────

export async function addYouTubePlaylist(
  playlistUrl: string,
  settings: SourceSettings = DEFAULT_SOURCE_SETTINGS
): Promise<AutomationSource> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')

  const listMatch = playlistUrl.match(/[?&]list=([\w-]+)/)
  const playlistId = listMatch?.[1]
  if (!playlistId) throw new Error('Invalid YouTube playlist URL. Expected format: youtube.com/playlist?list=...')
  const synapseCode = 'SYN-' + Math.random().toString(36).substring(2, 6).toUpperCase()

  // Try to fetch real playlist name from YouTube API
  const metadata = await fetchPlaylistMetadata(playlistId).catch(() => null)
  const playlistName = metadata?.name || `Playlist ${playlistId.substring(0, 8)}`

  const { data, error } = await supabase
    .from('youtube_playlists')
    .insert({
      user_id: user.id,
      playlist_id: playlistId,
      playlist_name: playlistName,
      playlist_url: playlistUrl,
      synapse_code: synapseCode,
      status: 'active',
      is_active: true,
      extraction_mode: settings.mode,
      anchor_emphasis: settings.emphasis,
      linked_anchor_ids: settings.linkedAnchorIds,
      custom_instructions: settings.customInstructions ?? null,
      known_video_count: metadata?.videoCount ?? 0,
    })
    .select()
    .single()

  if (error) {
    if (error.code === '23505') throw new Error('This playlist is already connected.')
    throw new Error(error.message)
  }

  const pl = data as Record<string, unknown>
  const playlistRowId = pl.id as string

  // Auto-create a Council domain expert for this playlist so ingested videos
  // immediately populate the expert's sources/entities/insights pipeline.
  // Mirrors api/council/backfill.ts step1_createAgents so the two paths stay in sync.
  const { data: agentRow, error: agentErr } = await supabase
    .from('domain_agents')
    .insert({
      user_id: user.id,
      playlist_id: playlistRowId,
      name: playlistName,
      linked_anchor_ids: settings.linkedAnchorIds ?? [],
      health_status: 'initialising',
    })
    .select('id')
    .single()

  if (agentErr) {
    console.error('[addYouTubePlaylist] Failed to create domain agent:', agentErr)
  } else if (agentRow?.id) {
    const { error: linkErr } = await supabase
      .from('youtube_playlists')
      .update({ domain_agent_id: agentRow.id })
      .eq('id', playlistRowId)
    if (linkErr) console.error('[addYouTubePlaylist] Failed to link playlist → agent:', linkErr)
  }

  return {
    id: playlistRowId,
    category: 'youtube-playlist',
    name: pl.playlist_name as string,
    status: 'active',
    videosIngested: 0,
    lastScan: 'Never',
    mode: settings.mode,
    emphasis: settings.emphasis,
    linkedAnchors: settings.linkedAnchorIds,
    customInstructions: settings.customInstructions,
    queue: { pending: 0, processing: 0, complete: 0, failed: 0 },
  }
}

// ─── Update Source Status ─────────────────────────────────────────────────────

export async function updateSourceStatus(
  sourceId: string,
  category: AutomationSource['category'],
  status: 'active' | 'paused'
): Promise<void> {
  const isActive = status === 'active'

  if (category === 'youtube-playlist') {
    const { error } = await supabase
      .from('youtube_playlists')
      .update({ is_active: isActive, status: isActive ? 'active' : 'paused', updated_at: new Date().toISOString() })
      .eq('id', sourceId)
    if (error) throw new Error(error.message)
  }
}

// ─── Disconnect Source ────────────────────────────────────────────────────────

export async function disconnectSource(
  sourceId: string,
  category: AutomationSource['category']
): Promise<void> {
  if (category === 'youtube-playlist') {
    const { error } = await supabase
      .from('youtube_playlists')
      .update({ is_active: false, status: 'paused', updated_at: new Date().toISOString() })
      .eq('id', sourceId)
    if (error) throw new Error(error.message)
  }
}

// ─── Delete Source ──────────────────────────────────────────────────────────

export async function deleteSource(
  sourceId: string,
  category: AutomationSource['category']
): Promise<void> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')

  if (category === 'youtube-playlist') {
    // Delete queue items first
    await supabase
      .from('youtube_ingestion_queue')
      .delete()
      .eq('user_id', user.id)
      .eq('playlist_id', sourceId)
    // Delete the playlist record
    const { error } = await supabase
      .from('youtube_playlists')
      .delete()
      .eq('id', sourceId)
      .eq('user_id', user.id)
    if (error) throw new Error(error.message)
  }
}

// ─── Trigger Manual Scan ──────────────────────────────────────────────────────

export async function triggerManualScan(
  sourceId: string,
  category: AutomationSource['category']
): Promise<void> {
  if (category === 'youtube-playlist') {
    const { error } = await supabase
      .from('youtube_playlists')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', sourceId)
    if (error) throw new Error(error.message)
  }
}

// ─── Immediate Scan (calls poll-playlist API directly) ────────────────────────

export async function callScanNowAPI(
  authToken: string
): Promise<{ newVideosQueued: number; playlistsPolled: number }> {
  const res = await fetch('/api/youtube/poll-playlist', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Scan failed' })) as { error?: string }
    throw new Error(err.error ?? `Scan failed: ${res.status}`)
  }
  return res.json() as Promise<{ newVideosQueued: number; playlistsPolled: number }>
}

// ─── Immediate Process (calls process API directly) ───────────────────────────

export async function callProcessNowAPI(
  authToken: string,
  sourceType?: 'youtube' | 'meeting' | 'microsoft'
): Promise<{ processed: number }> {
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` }

  if (sourceType === 'microsoft') {
    // Fetch content then extract for Microsoft items
    await fetch('/api/microsoft/fetch-transcripts', { method: 'POST', headers })
    const extractRes = await fetch('/api/microsoft/extract-knowledge', { method: 'POST', headers })
    if (!extractRes.ok) {
      const err = await extractRes.json().catch(() => ({ error: 'Processing failed' })) as { error?: string }
      throw new Error(err.error ?? `Processing failed: ${extractRes.status}`)
    }
    return extractRes.json() as Promise<{ processed: number }>
  }

  if (sourceType === 'meeting') {
    // Process meeting items directly
    const meetingRes = await fetch('/api/meetings/process', { method: 'POST', headers })
    if (!meetingRes.ok) {
      const err = await meetingRes.json().catch(() => ({ error: 'Processing failed' })) as { error?: string }
      throw new Error(err.error ?? `Processing failed: ${meetingRes.status}`)
    }
    return meetingRes.json() as Promise<{ processed: number }>
  }

  // YouTube: call decoupled endpoints sequentially
  // Step 1: Fetch transcripts for pending items
  await fetch('/api/youtube/fetch-transcripts', { method: 'POST', headers })

  // Step 2: Extract knowledge for items with transcripts ready
  const extractRes = await fetch('/api/youtube/extract-knowledge', { method: 'POST', headers })
  if (!extractRes.ok) {
    const err = await extractRes.json().catch(() => ({ error: 'Processing failed' })) as { error?: string }
    throw new Error(err.error ?? `Processing failed: ${extractRes.status}`)
  }
  return extractRes.json() as Promise<{ processed: number }>
}

// ─── Update Source Name ─────────────────────────────────────────────────────

export async function updateSourceName(
  sourceId: string,
  category: AutomationSource['category'],
  name: string
): Promise<void> {
  if (category === 'youtube-playlist') {
    const { error } = await supabase
      .from('youtube_playlists')
      .update({ playlist_name: name, updated_at: new Date().toISOString() })
      .eq('id', sourceId)
    if (error) throw new Error(error.message)
  } else if (category === 'meeting') {
    // Meeting source is synthetic — store custom name in localStorage
    localStorage.setItem('synapse:meeting-integration-name', name)
  }
}
