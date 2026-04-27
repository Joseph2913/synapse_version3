import { CaptureError, type CapturedSource } from '../../types/capture'

export interface CaptureUrlInput {
  url: string
  authToken: string
}

/**
 * URL adapter — Stage 1.
 * Calls the Gemini-backed serverless endpoint that fetches the page on Google's
 * infrastructure and returns a clean CapturedSource. No browser-side HTML parsing.
 */
export async function captureUrl({ url, authToken }: CaptureUrlInput): Promise<CapturedSource> {
  const trimmed = url.trim()
  if (!trimmed) throw new CaptureError('URL_EMPTY', 'Enter a URL.')

  try {
    new URL(trimmed.startsWith('http') ? trimmed : `https://${trimmed}`)
  } catch {
    throw new CaptureError('URL_INVALID', 'That does not look like a valid URL.')
  }

  const resp = await fetch('/api/capture/url', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${authToken}`,
    },
    body: JSON.stringify({ url: trimmed }),
  })

  if (!resp.ok) {
    const body = await resp.json().catch(() => ({})) as { error?: string }
    const code = resp.status === 413 ? 'URL_OVERSIZE'
      : resp.status === 422 ? 'URL_UNREADABLE'
      : resp.status === 415 ? 'URL_UNSUPPORTED_TYPE'
      : resp.status === 401 ? 'URL_UNAUTHORIZED'
      : 'URL_FETCH_FAILED'
    throw new CaptureError(code, body.error ?? 'Could not capture URL.')
  }

  const captured = await resp.json() as CapturedSource
  return captured
}
