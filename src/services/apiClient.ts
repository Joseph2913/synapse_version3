import { supabase } from './supabase'

export class ApiError extends Error {
  status: number
  detail: string
  constructor(status: number, detail: string) {
    super(`API ${status}: ${detail.slice(0, 200)}`)
    this.status = status
    this.detail = detail
  }
}

export async function callApi<T>(path: string, body: unknown): Promise<T> {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) {
    throw new ApiError(401, 'Not signed in')
  }
  const resp = await fetch(path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.access_token}`,
    },
    body: JSON.stringify(body),
  })
  if (!resp.ok) {
    const detail = await resp.text().catch(() => '')
    throw new ApiError(resp.status, detail)
  }
  return resp.json() as Promise<T>
}
