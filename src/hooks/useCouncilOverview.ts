import { useCallback, useEffect, useRef, useState } from 'react'
import { useAuth } from './useAuth'
import { fetchCouncilOverviewSummary, fetchCouncilOverviewAgents } from '../services/supabase'
import type { CouncilOverviewSummary, CouncilOverviewAgent } from '../types/council'

const STALE_MS = 60_000

type CacheEntry = {
  userId: string
  summary: CouncilOverviewSummary
  agents: CouncilOverviewAgent[]
  fetchedAt: number
}

let cache: CacheEntry | null = null

interface UseCouncilOverviewResult {
  summary: CouncilOverviewSummary | null
  agents: CouncilOverviewAgent[]
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
}

export function useCouncilOverview(): UseCouncilOverviewResult {
  const { user } = useAuth()
  const [summary, setSummary] = useState<CouncilOverviewSummary | null>(
    cache && user && cache.userId === user.id ? cache.summary : null,
  )
  const [agents, setAgents] = useState<CouncilOverviewAgent[]>(
    cache && user && cache.userId === user.id ? cache.agents : [],
  )
  const [loading, setLoading] = useState<boolean>(!cache || !user || cache.userId !== user.id)
  const [error, setError] = useState<string | null>(null)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  const load = useCallback(async (userId: string, showSpinner: boolean) => {
    if (showSpinner) setLoading(true)
    setError(null)
    try {
      const [s, a] = await Promise.all([
        fetchCouncilOverviewSummary(userId),
        fetchCouncilOverviewAgents(userId),
      ])
      cache = { userId, summary: s, agents: a, fetchedAt: Date.now() }
      if (!mountedRef.current) return
      setSummary(s)
      setAgents(a)
    } catch (err) {
      if (!mountedRef.current) return
      setError(err instanceof Error ? err.message : 'Failed to load council overview')
    } finally {
      if (mountedRef.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!user) return
    const fresh = cache && cache.userId === user.id && (Date.now() - cache.fetchedAt) < STALE_MS
    if (fresh && cache) {
      setSummary(cache.summary)
      setAgents(cache.agents)
      setLoading(false)
      return
    }
    const hasCache = cache && cache.userId === user.id
    load(user.id, !hasCache)
  }, [user, load])

  const refresh = useCallback(async () => {
    if (!user) return
    cache = null
    await load(user.id, true)
  }, [user, load])

  return { summary, agents, loading, error, refresh }
}
