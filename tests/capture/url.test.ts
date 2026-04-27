import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { captureUrl } from '../../src/adapters/capture/url'
import { CaptureError } from '../../src/types/capture'

const fixturePath = resolve(__dirname, '../fixtures/capture/url-success.json')
const fixture = JSON.parse(readFileSync(fixturePath, 'utf-8')) as {
  title: string
  content: string
  language: string
}

const baseCaptured = {
  content: fixture.content,
  title: fixture.title,
  source_type: 'url' as const,
  source_url: 'https://example.com/transformers',
  metadata: {
    hostname: 'example.com',
    char_count: fixture.content.length,
    language: fixture.language,
    duration_ms: 1234,
  },
}

function mockFetch(impl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
  return vi.spyOn(global, 'fetch').mockImplementation(impl as typeof fetch)
}

describe('captureUrl — Stage 1 contract', () => {
  let fetchSpy: ReturnType<typeof mockFetch>

  afterEach(() => {
    fetchSpy?.mockRestore()
  })

  it('returns a CapturedSource with the expected shape on success', async () => {
    fetchSpy = mockFetch(async () => new Response(JSON.stringify(baseCaptured), { status: 200 }))
    const result = await captureUrl({ url: 'https://example.com/transformers', authToken: 'tok' })
    expect(result).toEqual(baseCaptured)
    expect(result.source_type).toBe('url')
    expect(result.source_url).toBe('https://example.com/transformers')
    expect(typeof result.metadata).toBe('object')
  })

  it('rejects empty URL with CaptureError', async () => {
    await expect(captureUrl({ url: '   ', authToken: 'tok' })).rejects.toBeInstanceOf(CaptureError)
  })

  it('rejects malformed URL with CaptureError', async () => {
    await expect(captureUrl({ url: 'not a url at all', authToken: 'tok' })).rejects.toThrow(CaptureError)
  })

  it('maps server 413 to URL_OVERSIZE error code', async () => {
    fetchSpy = mockFetch(async () => new Response(JSON.stringify({ error: 'too big' }), { status: 413 }))
    try {
      await captureUrl({ url: 'https://example.com', authToken: 'tok' })
      throw new Error('expected throw')
    } catch (err) {
      expect(err).toBeInstanceOf(CaptureError)
      if (err instanceof CaptureError) expect(err.code).toBe('URL_OVERSIZE')
    }
  })

  it('maps server 422 to URL_UNREADABLE error code', async () => {
    fetchSpy = mockFetch(async () => new Response(JSON.stringify({ error: 'unreadable' }), { status: 422 }))
    try {
      await captureUrl({ url: 'https://example.com', authToken: 'tok' })
      throw new Error('expected throw')
    } catch (err) {
      expect(err).toBeInstanceOf(CaptureError)
      if (err instanceof CaptureError) expect(err.code).toBe('URL_UNREADABLE')
    }
  })

  it('passes the bearer token in the Authorization header', async () => {
    let capturedHeaders: Record<string, string> | null = null
    fetchSpy = mockFetch(async (_url, init) => {
      capturedHeaders = init?.headers as Record<string, string>
      return new Response(JSON.stringify(baseCaptured), { status: 200 })
    })
    await captureUrl({ url: 'https://example.com', authToken: 'my-token' })
    expect(capturedHeaders?.Authorization).toBe('Bearer my-token')
  })
})
