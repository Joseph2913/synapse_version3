import { useContext, useEffect } from 'react'
import { ExploreDataContext } from '../app/providers/ExploreDataProvider'
import type { ExploreDataContextValue } from '../app/providers/ExploreDataProvider'

export type { ExploreData } from '../app/providers/ExploreDataProvider'

/**
 * Hook to access cached explore data from ExploreDataProvider.
 *
 * Data persists across route navigations (provider lives above the router).
 * On first access, triggers a fetch. On subsequent accesses, returns cached data
 * and triggers a background refresh if the cache is stale (>5 min).
 */
export function useExploreData(): ExploreDataContextValue {
  const ctx = useContext(ExploreDataContext)
  if (!ctx) {
    throw new Error('useExploreData must be used within ExploreDataProvider')
  }

  // Tell the provider to ensure data is available/fresh when this hook mounts
  // (i.e. when the Explore view is visited)
  const { ensureFresh } = ctx as ExploreDataContextValue & { ensureFresh: () => void }
  useEffect(() => {
    ensureFresh()
  }, [ensureFresh])

  return {
    data: ctx.data,
    loading: ctx.loading,
    error: ctx.error,
    refetch: ctx.refetch,
  }
}
