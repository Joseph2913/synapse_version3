import { describe, it, expect, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { captureFile } from '../../src/adapters/capture/file'
import { CaptureError, FILE_MAX_BYTES } from '../../src/types/capture'

const fixturePath = resolve(__dirname, '../fixtures/capture/file-success.json')
const fixture = JSON.parse(readFileSync(fixturePath, 'utf-8')) as {
  title: string
  content: string
  language: string
  page_count: number
}

const baseCaptured = {
  content: fixture.content,
  title: fixture.title,
  source_type: 'file' as const,
  source_url: null,
  metadata: {
    filename: 'q3-board.pdf',
    mime_type: 'application/pdf',
    file_extension: 'pdf',
    file_size_bytes: 1024,
    char_count: fixture.content.length,
    language: fixture.language,
    page_count: fixture.page_count,
    duration_seconds: null,
    duration_ms: 9000,
  },
}

function mockFetch(impl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
  return vi.spyOn(global, 'fetch').mockImplementation(impl as typeof fetch)
}

function makeFile(name: string, type: string, size: number): File {
  const data = new Uint8Array(size)
  return new File([data], name, { type })
}

describe('captureFile — Stage 1 contract', () => {
  let fetchSpy: ReturnType<typeof mockFetch>

  afterEach(() => {
    fetchSpy?.mockRestore()
  })

  it('returns a CapturedSource with the expected shape on success', async () => {
    fetchSpy = mockFetch(async () => new Response(JSON.stringify(baseCaptured), { status: 200 }))
    const file = makeFile('q3-board.pdf', 'application/pdf', 1024)
    const result = await captureFile({ file, authToken: 'tok' })
    expect(result.source_type).toBe('file')
    expect(result.title).toBe('Q3 board update')
    expect(result.content).toBe(fixture.content)
    expect(result.source_url).toBeNull()
    expect(result.metadata).toMatchObject({ mime_type: 'application/pdf', page_count: 12 })
  })

  it('rejects unsupported file types client-side', async () => {
    const file = makeFile('script.exe', 'application/x-msdownload', 1024)
    try {
      await captureFile({ file, authToken: 'tok' })
      throw new Error('expected throw')
    } catch (err) {
      expect(err).toBeInstanceOf(CaptureError)
      if (err instanceof CaptureError) expect(err.code).toBe('FILE_UNSUPPORTED_TYPE')
    }
  })

  it('rejects files over the inline size cap client-side', async () => {
    const file = makeFile('huge.pdf', 'application/pdf', FILE_MAX_BYTES + 1)
    try {
      await captureFile({ file, authToken: 'tok' })
      throw new Error('expected throw')
    } catch (err) {
      expect(err).toBeInstanceOf(CaptureError)
      if (err instanceof CaptureError) expect(err.code).toBe('FILE_OVERSIZE')
    }
  })

  it('maps server 413 to FILE_OVERSIZE error code', async () => {
    fetchSpy = mockFetch(async () => new Response(JSON.stringify({ error: 'too big' }), { status: 413 }))
    const file = makeFile('q3-board.pdf', 'application/pdf', 1024)
    try {
      await captureFile({ file, authToken: 'tok' })
      throw new Error('expected throw')
    } catch (err) {
      expect(err).toBeInstanceOf(CaptureError)
      if (err instanceof CaptureError) expect(err.code).toBe('FILE_OVERSIZE')
    }
  })

  it('maps server 415 to FILE_UNSUPPORTED_TYPE error code', async () => {
    fetchSpy = mockFetch(async () => new Response(JSON.stringify({ error: 'bad mime' }), { status: 415 }))
    const file = makeFile('q3-board.pdf', 'application/pdf', 1024)
    try {
      await captureFile({ file, authToken: 'tok' })
      throw new Error('expected throw')
    } catch (err) {
      expect(err).toBeInstanceOf(CaptureError)
      if (err instanceof CaptureError) expect(err.code).toBe('FILE_UNSUPPORTED_TYPE')
    }
  })

  it('maps server 422 to FILE_UNREADABLE error code', async () => {
    fetchSpy = mockFetch(async () => new Response(JSON.stringify({ error: 'no content' }), { status: 422 }))
    const file = makeFile('q3-board.pdf', 'application/pdf', 1024)
    try {
      await captureFile({ file, authToken: 'tok' })
      throw new Error('expected throw')
    } catch (err) {
      expect(err).toBeInstanceOf(CaptureError)
      if (err instanceof CaptureError) expect(err.code).toBe('FILE_UNREADABLE')
    }
  })

  it('passes the bearer token in the Authorization header', async () => {
    let capturedHeaders: Record<string, string> | null = null
    fetchSpy = mockFetch(async (_url, init) => {
      capturedHeaders = init?.headers as Record<string, string>
      return new Response(JSON.stringify(baseCaptured), { status: 200 })
    })
    const file = makeFile('q3-board.pdf', 'application/pdf', 1024)
    await captureFile({ file, authToken: 'my-token' })
    expect(capturedHeaders?.Authorization).toBe('Bearer my-token')
  })
})
