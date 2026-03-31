import { useContext, useEffect } from 'react'
import { HomeDashboardContext, type HomeDashboardData } from '../app/providers/HomeDashboardProvider'

export type { HomeDashboardData }

/**
 * Hook to access Home dashboard data from the HomeDashboardProvider cache.
 * On mount, triggers a stale-while-revalidate check — returns cached data
 * instantly and refreshes in the background if stale.
 */
export function useHomeDashboard(): HomeDashboardData {
  const ctx = useContext(HomeDashboardContext)
  if (!ctx) {
    throw new Error('useHomeDashboard must be used within a HomeDashboardProvider')
  }

  // Trigger stale-while-revalidate check on mount
  useEffect(() => {
    ctx.ensureFresh()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return ctx
}
