import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  circlebackToCapturedSource,
  MeetingCaptureError,
  MEETING_MAX_CHARS,
  type CirclebackPayload,
} from '../../api/meetings/webhook'

const fixturePath = resolve(__dirname, '../fixtures/capture/circleback-success.json')
const fixture = JSON.parse(readFileSync(fixturePath, 'utf-8')) as CirclebackPayload

describe('circlebackToCapturedSource — Stage 1 contract', () => {
  it('returns a CapturedSource with the expected shape on success', () => {
    const result = circlebackToCapturedSource(fixture)
    expect(result.source_type).toBe('meeting')
    expect(result.source_url).toBe('https://app.circleback.ai/meetings/472518')
    expect(typeof result.content).toBe('string')
    expect(result.content.length).toBeGreaterThan(0)
    expect(typeof result.metadata).toBe('object')
  })

  it('uses payload.name as the title when present', () => {
    const result = circlebackToCapturedSource(fixture)
    expect(result.title).toBe('Q3 strategy sync')
  })

  it('falls back to "Meeting on YYYY-MM-DD" when name is empty', () => {
    const result = circlebackToCapturedSource({ ...fixture, name: '' })
    expect(result.title).toBe('Meeting on 2026-04-25')
  })

  it('falls back to "Untitled meeting" when name and createdAt are both missing', () => {
    const result = circlebackToCapturedSource({ ...fixture, name: undefined, createdAt: undefined })
    expect(result.title).toBe('Untitled meeting')
  })

  it('rejects payloads with no content', () => {
    expect(() => circlebackToCapturedSource({})).toThrow(MeetingCaptureError)
    try {
      circlebackToCapturedSource({})
    } catch (err) {
      if (err instanceof MeetingCaptureError) expect(err.code).toBe('MEETING_NO_CONTENT')
    }
  })

  it('rejects payloads with content over the size cap', () => {
    const oversize = 'A'.repeat(MEETING_MAX_CHARS + 100)
    expect(() => circlebackToCapturedSource({ notes: oversize })).toThrow(MeetingCaptureError)
    try {
      circlebackToCapturedSource({ notes: oversize })
    } catch (err) {
      if (err instanceof MeetingCaptureError) expect(err.code).toBe('MEETING_OVERSIZE')
    }
  })

  it('captures meeting metadata: id, duration, attendees, action items', () => {
    const result = circlebackToCapturedSource(fixture)
    expect(result.metadata).toMatchObject({
      provider: 'circleback',
      circleback_meeting_id: 472518,
      duration_seconds: 2640,
      action_item_count: 2,
      transcript_segment_count: 3,
    })
    const attendees = result.metadata.attendees as string[]
    expect(attendees).toContain('Joseph Thomas')
    expect(attendees).toContain('Sam Carter')
    expect(attendees).toContain('alex@example.com')
  })

  it('parses participants from the notes header when present', () => {
    const result = circlebackToCapturedSource(fixture)
    expect(result.metadata.participants).toEqual(
      expect.arrayContaining(['Joseph Thomas', 'Sam Carter', 'Alex Lee']),
    )
  })

  it('falls back to attendees list when notes have no participant header', () => {
    const result = circlebackToCapturedSource({ ...fixture, notes: 'No participants header here.' })
    expect(result.metadata.participants).toEqual(
      expect.arrayContaining(['Joseph Thomas', 'Sam Carter']),
    )
  })

  it('includes transcript and action items in the canonical content', () => {
    const result = circlebackToCapturedSource(fixture)
    expect(result.content).toContain('Joseph')
    expect(result.content).toContain('--- TRANSCRIPT ---')
    expect(result.content).toContain('--- ACTION ITEMS ---')
    expect(result.content).toContain('Confirm Apify default')
  })

  it('rejects non-object payloads with MEETING_INVALID_PAYLOAD', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => circlebackToCapturedSource(null as any)).toThrow(MeetingCaptureError)
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      circlebackToCapturedSource('not an object' as any)
    } catch (err) {
      if (err instanceof MeetingCaptureError) expect(err.code).toBe('MEETING_INVALID_PAYLOAD')
    }
  })
})
