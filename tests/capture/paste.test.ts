import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { capturePaste, PASTE_MAX_CHARS } from '../../src/adapters/capture/paste'
import { CaptureError } from '../../src/types/capture'

const fixturePath = resolve(__dirname, '../fixtures/capture/paste.txt')
const fixture = readFileSync(fixturePath, 'utf-8')

describe('capturePaste — Stage 1 contract', () => {
  it('returns the CapturedSource shape', () => {
    const result = capturePaste({ content: fixture })

    expect(result).toEqual(expect.objectContaining({
      content: fixture,
      source_type: 'paste',
      source_url: null,
    }))
    expect(typeof result.title).toBe('string')
    expect(typeof result.metadata).toBe('object')
    expect(result.metadata).not.toBeNull()
  })

  it('derives title from first non-empty line', () => {
    const result = capturePaste({ content: fixture })
    expect(result.title).toBe('Q3 strategy review notes')
  })

  it('skips leading blank lines when deriving title', () => {
    const result = capturePaste({ content: '\n\n\n   First real line  \nSecond line' })
    expect(result.title).toBe('First real line')
  })

  it('truncates titles over 80 characters', () => {
    const longLine = 'A'.repeat(200)
    const result = capturePaste({ content: longLine })
    expect(result.title).toHaveLength(80)
    expect(result.title).toBe('A'.repeat(80))
  })

  it('falls back to "Untitled paste" when content is empty', () => {
    const result = capturePaste({ content: '' })
    expect(result.title).toBe('Untitled paste')
  })

  it('falls back to "Untitled paste" when content is only whitespace', () => {
    const result = capturePaste({ content: '   \n\n\t\n   ' })
    expect(result.title).toBe('Untitled paste')
  })

  it('records char_count in metadata', () => {
    const result = capturePaste({ content: fixture })
    expect(result.metadata).toMatchObject({ char_count: fixture.length })
  })

  it('rejects content over the size limit', () => {
    const oversized = 'A'.repeat(PASTE_MAX_CHARS + 1)
    expect(() => capturePaste({ content: oversized })).toThrow(CaptureError)
    try {
      capturePaste({ content: oversized })
    } catch (err) {
      expect(err).toBeInstanceOf(CaptureError)
      if (err instanceof CaptureError) {
        expect(err.code).toBe('PASTE_OVERSIZE')
      }
    }
  })

  it('accepts content exactly at the size limit', () => {
    const atLimit = 'A'.repeat(PASTE_MAX_CHARS)
    expect(() => capturePaste({ content: atLimit })).not.toThrow()
  })
})
