import { supabase } from './supabase'
import type { FeedItem, DailyStats } from '../types/feed'

export async function fetchDailyStats(): Promise<DailyStats> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()

  const [sourcesRes, entitiesRes, relationsRes] = await Promise.all([
    supabase
      .from('knowledge_sources')
      .select('*', { count: 'exact', head: true })
      .gte('created_at', since),
    supabase
      .from('knowledge_nodes')
      .select('*', { count: 'exact', head: true })
      .gte('created_at', since),
    supabase
      .from('knowledge_edges')
      .select('*', { count: 'exact', head: true })
      .gte('created_at', since),
  ])

  return {
    sourcesProcessed: sourcesRes.count ?? 0,
    newEntities: entitiesRes.count ?? 0,
    relationshipsDiscovered: relationsRes.count ?? 0,
  }
}

/**
 * Fetches a paginated activity feed via a single Supabase RPC call.
 * Previously this made 6-10 sequential requests (sources → nodes → batched edges →
 * other nodes → other source metadata) and did heavy Map-building client-side.
 * Now the Postgres function does all the joining, edge classification, and JSON assembly.
 */
export async function fetchActivityFeed(
  limit = 20,
  offset = 0
): Promise<{ items: FeedItem[]; hasMore: boolean }> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { items: [], hasMore: false }

  const { data, error } = await supabase.rpc('get_activity_feed', {
    p_user_id: user.id,
    p_limit: limit,
    p_offset: offset,
  })

  if (error) {
    console.error('[feedQueries] get_activity_feed RPC failed:', error.message)
    return { items: [], hasMore: false }
  }

  const result = data as { items: FeedItem[]; hasMore: boolean }
  return {
    items: result.items ?? [],
    hasMore: result.hasMore ?? false,
  }
}
