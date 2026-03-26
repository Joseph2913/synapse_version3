import { useState, useEffect, useRef } from 'react'
import { supabase } from '../services/supabase'
import { fetchSimulationJobs, fetchSimulationJob } from '../services/simulate'
import type { SimulationJob } from '../types/simulate'

export function useSimulationJobs() {
  const [jobs, setJobs] = useState<SimulationJob[]>([])
  const [loading, setLoading] = useState(true)
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null)

  useEffect(() => {
    let mounted = true

    async function load() {
      try {
        const data = await fetchSimulationJobs()
        if (mounted) { setJobs(data); setLoading(false) }
      } catch {
        if (mounted) setLoading(false)
      }
    }
    load()

    // Real-time subscription for status/progress updates
    channelRef.current = supabase
      .channel('simulation_jobs_changes')
      .on('postgres_changes', {
        event: 'UPDATE',
        schema: 'public',
        table: 'simulation_jobs',
      }, async (payload) => {
        const updated = await fetchSimulationJob(payload.new.id as string)
        if (updated && mounted) {
          setJobs(prev => prev.map(j => j.id === updated.id ? updated : j))
        }
      })
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'simulation_jobs',
      }, async (payload) => {
        const inserted = await fetchSimulationJob(payload.new.id as string)
        if (inserted && mounted) {
          setJobs(prev => [inserted, ...prev])
        }
      })
      .subscribe()

    return () => {
      mounted = false
      channelRef.current?.unsubscribe()
    }
  }, [])

  const hasRunningJob = jobs.some(j => j.status === 'running' || j.status === 'preparing')

  return { jobs, loading, hasRunningJob }
}
