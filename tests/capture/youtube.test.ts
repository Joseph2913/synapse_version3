import { describe, it, expect, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { captureYoutube } from '../../src/adapters/capture/youtube'
import { CaptureError, type CapturedSource } from '../../src/types/capture'

const fixturePath = resolve(__dirname, '../fixtures/capture/youtube-success.json')
const fixture = JSON.parse(readFileSync(fixturePath, 'utf-8')) as CapturedSource

function mockFetch(impl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
  return vi.spyOn(global, 'fetch').mockImplementation(impl as typeof fetch)
}

describe('captureYoutube — Stage 1 contract', () => {
  let fetchSpy: ReturnType<typeof mockFetch>

  afterEach(() => {
    fetchSpy?.mockRestore()
  })

  it('returns a CapturedSource with the expected shape on success', async () => {
    fetchSpy = mockFetch(async () => new Response(JSON.stringify(fixture), { status: 200 }))
    const result = await captureYoutube({ url: 'https://www.youtube.com/watch?v=abc12345678', authToken: 'tok' })
    expect(result.source_type).toBe('youtube')
    expect(result.source_url).toBe('https://www.youtube.com/watch?v=abc12345678')
    expect(result.title).toBe('How transformers work — the intuition first')
    expect(result.metadata).toMatchObject({ video_id: 'abc12345678', tier_used: 1, channel: 'Knowledge Graph Weekly' })
  })

  it('rejects empty URL with CaptureError', async () => {
    await expect(captureYoutube({ url: '   ', authToken: 'tok' })).rejects.toBeInstanceOf(CaptureError)
  })

  it('rejects non-YouTube URLs', async () => {
    try {
      await captureYoutube({ url: 'https://vimeo.com/123', authToken: 'tok' })
      throw new Error('expected throw')
    } catch (err) {
      expect(err).toBeInstanceOf(CaptureError)
      if (err instanceof CaptureError) expect(err.code).toBe('YOUTUBE_INVALID')
    }
  })

  it('accepts a bare 11-character video ID', async () => {
    fetchSpy = mockFetch(async () => new Response(JSON.stringify(fixture), { status: 200 }))
    const result = await captureYoutube({ url: 'abc12345678', authToken: 'tok' })
    expect(result.source_type).toBe('youtube')
  })

  it('accepts youtu.be short URLs', async () => {
    fetchSpy = mockFetch(async () => new Response(JSON.stringify(fixture), { status: 200 }))
    const result = await captureYoutube({ url: 'https://youtu.be/abc12345678', authToken: 'tok' })
    expect(result.source_type).toBe('youtube')
  })

  it('accepts youtube.com/shorts URLs', async () => {
    fetchSpy = mockFetch(async () => new Response(JSON.stringify(fixture), { status: 200 }))
    const result = await captureYoutube({ url: 'https://www.youtube.com/shorts/abc12345678', authToken: 'tok' })
    expect(result.source_type).toBe('youtube')
  })

  it('maps server 422 to YOUTUBE_NO_TRANSCRIPT', async () => {
    fetchSpy = mockFetch(async () => new Response(JSON.stringify({ error: 'no captions' }), { status: 422 }))
    try {
      await captureYoutube({ url: 'https://www.youtube.com/watch?v=abc12345678', authToken: 'tok' })
      throw new Error('expected throw')
    } catch (err) {
      expect(err).toBeInstanceOf(CaptureError)
      if (err instanceof CaptureError) expect(err.code).toBe('YOUTUBE_NO_TRANSCRIPT')
    }
  })

  it('maps server 413 to YOUTUBE_OVERSIZE', async () => {
    fetchSpy = mockFetch(async () => new Response(JSON.stringify({ error: 'too long' }), { status: 413 }))
    try {
      await captureYoutube({ url: 'https://www.youtube.com/watch?v=abc12345678', authToken: 'tok' })
      throw new Error('expected throw')
    } catch (err) {
      expect(err).toBeInstanceOf(CaptureError)
      if (err instanceof CaptureError) expect(err.code).toBe('YOUTUBE_OVERSIZE')
    }
  })

  it('passes the bearer token in the Authorization header', async () => {
    let headers: Record<string, string> | null = null
    fetchSpy = mockFetch(async (_url, init) => {
      headers = init?.headers as Record<string, string>
      return new Response(JSON.stringify(fixture), { status: 200 })
    })
    await captureYoutube({ url: 'https://www.youtube.com/watch?v=abc12345678', authToken: 'my-token' })
    expect(headers?.Authorization).toBe('Bearer my-token')
  })
})
