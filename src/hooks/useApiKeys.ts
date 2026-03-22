import { useState, useEffect, useCallback } from 'react'
import { useAuth } from './useAuth'

export interface ApiKey {
  id: string
  label: string
  key_prefix: string
  created_at: string
  last_used_at: string | null
}

export interface UseApiKeysReturn {
  keys: ApiKey[]
  loading: boolean
  error: string | null
  createKey: (label: string) => Promise<{ rawKey: string; key: ApiKey } | null>
  revokeKey: (id: string) => Promise<boolean>
  refresh: () => Promise<void>
}

export function useApiKeys(): UseApiKeysReturn {
  const { session } = useAuth()
  const [keys, setKeys] = useState<ApiKey[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const getAuthHeaders = useCallback((): HeadersInit => {
    if (!session?.access_token) return {}
    return { Authorization: `Bearer ${session.access_token}` }
  }, [session?.access_token])

  const refresh = useCallback(async () => {
    if (!session?.access_token) return
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/keys/list', {
        headers: getAuthHeaders(),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as Record<string, string>
        throw new Error(body.error ?? 'Failed to fetch keys')
      }
      const data = (await res.json()) as ApiKey[]
      setKeys(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch keys')
    } finally {
      setLoading(false)
    }
  }, [session?.access_token, getAuthHeaders])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const createKey = useCallback(
    async (label: string): Promise<{ rawKey: string; key: ApiKey } | null> => {
      if (!session?.access_token) return null
      setError(null)
      try {
        const res = await fetch('/api/keys/create', {
          method: 'POST',
          headers: {
            ...getAuthHeaders(),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ label }),
        })
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as Record<string, string>
          setError(body.error ?? 'Failed to create key')
          return null
        }
        const data = (await res.json()) as {
          id: string
          label: string
          key_prefix: string
          raw_key: string
          created_at: string
        }
        const newKey: ApiKey = {
          id: data.id,
          label: data.label,
          key_prefix: data.key_prefix,
          created_at: data.created_at,
          last_used_at: null,
        }
        setKeys(prev => [newKey, ...prev])
        return { rawKey: data.raw_key, key: newKey }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to create key')
        return null
      }
    },
    [session?.access_token, getAuthHeaders]
  )

  const revokeKey = useCallback(
    async (id: string): Promise<boolean> => {
      if (!session?.access_token) return false

      // Optimistic remove
      const previousKeys = [...keys]
      setKeys(prev => prev.filter(k => k.id !== id))
      setError(null)

      try {
        const res = await fetch('/api/keys/revoke', {
          method: 'DELETE',
          headers: {
            ...getAuthHeaders(),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ id }),
        })
        if (!res.ok) {
          // Rollback
          setKeys(previousKeys)
          setError('Failed to revoke key. Please try again.')
          return false
        }
        return true
      } catch {
        setKeys(previousKeys)
        setError('Failed to revoke key. Please try again.')
        return false
      }
    },
    [session?.access_token, keys, getAuthHeaders]
  )

  return { keys, loading, error, createKey, revokeKey, refresh }
}
