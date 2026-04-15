import { supabase } from './supabase'

// ─── Types ───────────────────────────────────────────────────────────────────

export interface GitHubTrackedRepo {
  id: string
  user_id: string
  repo_url: string
  repo_owner: string
  repo_name: string
  display_name: string
  default_branch: string
  scan_interval: string
  last_scanned_at: string | null
  last_commit_sha: string | null
  extraction_mode: string
  anchor_emphasis: string
  linked_anchor_ids: string[]
  custom_instructions: string | null
  is_active: boolean
  status: string
  error_message: string | null
  created_at: string
  updated_at: string
}

export interface GitHubQueueItem {
  id: string
  repo_id: string
  digest_date: string
  commit_count: number
  commit_range: string | null
  authors: string[]
  status: string
  error_message: string | null
  source_id: string | null
  nodes_created: number
  edges_created: number
  created_at: string
  completed_at: string | null
}

export interface GitHubQueueStats {
  pending: number
  processing: number
  completed: number
  failed: number
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function parseRepoUrl(input: string): { owner: string; name: string } | null {
  // Normalise input: strip protocol and trailing slashes
  const cleaned = input
    .trim()
    .replace(/^https?:\/\//, '')
    .replace(/^github\.com\//, '')
    .replace(/\.git$/, '')
    .replace(/\/$/, '')

  // Expect "owner/repo"
  const parts = cleaned.split('/')
  if (parts.length < 2) return null

  const owner = parts[0]
  const name = parts[1]
  if (!owner || !name) return null

  return { owner, name }
}

// ─── Fetch Repos ─────────────────────────────────────────────────────────────

export async function fetchGitHubRepos(): Promise<GitHubTrackedRepo[]> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return []

  const { data, error } = await supabase
    .from('github_tracked_repos')
    .select('*')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })

  if (error) {
    console.warn('[github] fetchGitHubRepos error:', error.message)
    return []
  }

  return (data ?? []) as GitHubTrackedRepo[]
}

// ─── Add Repo ─────────────────────────────────────────────────────────────────

export async function addGitHubRepo(
  repoUrl: string,
  displayName: string,
  branch: string,
  scanInterval: string,
  settings: {
    extraction_mode?: string
    anchor_emphasis?: string
    linked_anchor_ids?: string[]
    custom_instructions?: string | null
  } = {}
): Promise<GitHubTrackedRepo> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')

  const parsed = parseRepoUrl(repoUrl)
  if (!parsed) throw new Error('Invalid GitHub repo URL. Expected format: https://github.com/owner/repo')

  const { owner, name } = parsed
  const canonicalUrl = `https://github.com/${owner}/${name}`

  // Validate repo exists and is public via GitHub API
  const ghRes = await fetch(`https://api.github.com/repos/${owner}/${name}`, {
    headers: { Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(8000),
  })

  if (ghRes.status === 404) throw new Error(`Repository ${owner}/${name} not found or is private.`)
  if (!ghRes.ok) throw new Error(`GitHub API error: ${ghRes.status}`)

  const insert: Record<string, unknown> = {
    user_id: user.id,
    repo_url: canonicalUrl,
    repo_owner: owner,
    repo_name: name,
    display_name: displayName || `${owner}/${name}`,
    default_branch: branch || 'main',
    scan_interval: scanInterval || 'daily',
    extraction_mode: settings.extraction_mode ?? 'comprehensive',
    anchor_emphasis: settings.anchor_emphasis ?? 'standard',
    is_active: true,
    status: 'active',
    custom_instructions: settings.custom_instructions ?? null,
  }

  // Only include linked_anchor_ids if non-empty (avoid empty UUID[] issues)
  if (settings.linked_anchor_ids && settings.linked_anchor_ids.length > 0) {
    insert.linked_anchor_ids = settings.linked_anchor_ids
  }

  const { data, error } = await supabase
    .from('github_tracked_repos')
    .insert(insert)
    .select()
    .single()

  if (error) {
    if (error.code === '23505') throw new Error('This repository is already tracked.')
    throw new Error(error.message)
  }

  return data as GitHubTrackedRepo
}

// ─── Update Repo ──────────────────────────────────────────────────────────────

export async function updateGitHubRepo(
  repoId: string,
  updates: Partial<Omit<GitHubTrackedRepo, 'id' | 'user_id' | 'created_at'>>
): Promise<void> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')

  const { error } = await supabase
    .from('github_tracked_repos')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', repoId)
    .eq('user_id', user.id)

  if (error) throw new Error(`Failed to update repo: ${error.message}`)
}

// ─── Toggle Active ────────────────────────────────────────────────────────────

export async function setGitHubRepoActive(repoId: string, active: boolean): Promise<void> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')

  const { error } = await supabase
    .from('github_tracked_repos')
    .update({
      is_active: active,
      status: active ? 'active' : 'paused',
      updated_at: new Date().toISOString(),
    })
    .eq('id', repoId)
    .eq('user_id', user.id)

  if (error) throw new Error(`Failed to update repo status: ${error.message}`)
}

// ─── Delete Repo ──────────────────────────────────────────────────────────────

export async function deleteGitHubRepo(repoId: string): Promise<void> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')

  // Queue items cascade via FK — single delete is sufficient
  const { error } = await supabase
    .from('github_tracked_repos')
    .delete()
    .eq('id', repoId)
    .eq('user_id', user.id)

  if (error) throw new Error(`Failed to delete repo: ${error.message}`)
}

// ─── Fetch Queue for Repo ─────────────────────────────────────────────────────

export async function fetchGitHubQueue(repoId: string): Promise<GitHubQueueItem[]> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return []

  const { data, error } = await supabase
    .from('github_ingestion_queue')
    .select('*')
    .eq('repo_id', repoId)
    .order('digest_date', { ascending: false })
    .limit(30)

  if (error) {
    console.warn('[github] fetchGitHubQueue error:', error.message)
    return []
  }

  return (data ?? []) as GitHubQueueItem[]
}

// ─── Queue Stats (all user repos) ────────────────────────────────────────────

export async function fetchGitHubQueueStats(): Promise<GitHubQueueStats> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { pending: 0, processing: 0, completed: 0, failed: 0 }

  // Get all repo IDs for this user first
  const { data: repos } = await supabase
    .from('github_tracked_repos')
    .select('id')
    .eq('user_id', user.id)

  const repoIds = ((repos ?? []) as { id: string }[]).map(r => r.id)
  if (repoIds.length === 0) return { pending: 0, processing: 0, completed: 0, failed: 0 }

  const { data, error } = await supabase
    .from('github_ingestion_queue')
    .select('status')
    .in('repo_id', repoIds)

  if (error) {
    console.warn('[github] fetchGitHubQueueStats error:', error.message)
    return { pending: 0, processing: 0, completed: 0, failed: 0 }
  }

  const rows = (data ?? []) as { status: string }[]
  return {
    pending: rows.filter(r => r.status === 'pending').length,
    processing: rows.filter(r => r.status === 'composing_digest' || r.status === 'extracting').length,
    completed: rows.filter(r => r.status === 'completed').length,
    failed: rows.filter(r => r.status === 'failed').length,
  }
}

// ─── Trigger Scan ─────────────────────────────────────────────────────────────

export async function triggerGitHubScan(): Promise<void> {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session?.access_token) throw new Error('Not authenticated')

  const res = await fetch('/api/github/scan-repos', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.access_token}`,
    },
  })

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Scan failed' })) as { error?: string }
    throw new Error(err.error ?? `Scan failed: ${res.status}`)
  }
}
