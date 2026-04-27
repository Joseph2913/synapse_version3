import { CaptureError, logCapture, type CapturedSource } from '../../types/capture'

/** Maximum characters accepted by the paste adapter. ~200 pages of prose. */
export const PASTE_MAX_CHARS = 500_000

const TITLE_MAX_CHARS = 80
const FALLBACK_TITLE = 'Untitled paste'

export interface PasteInput {
  content: string
}

/**
 * Paste adapter — Stage 1.
 * Title rule: first non-empty line, trimmed to 80 characters. Fallback "Untitled paste".
 * Size rule: reject inputs over PASTE_MAX_CHARS.
 */
export function capturePaste(input: PasteInput): CapturedSource {
  const start = Date.now()
  const content = input.content ?? ''

  if (content.length > PASTE_MAX_CHARS) {
    logCapture({
      adapter: 'paste',
      source_type: 'paste',
      content_size: content.length,
      duration_ms: Date.now() - start,
      status: 'rejected',
      reason: 'oversize',
    })
    throw new CaptureError(
      'PASTE_OVERSIZE',
      `Paste is too large. Maximum is ${PASTE_MAX_CHARS.toLocaleString()} characters; received ${content.length.toLocaleString()}.`,
    )
  }

  const result: CapturedSource = {
    content,
    title: derivePasteTitle(content),
    source_type: 'paste',
    source_url: null,
    metadata: {
      char_count: content.length,
    },
  }

  logCapture({
    adapter: 'paste',
    source_type: 'paste',
    content_size: content.length,
    duration_ms: Date.now() - start,
    status: 'ok',
  })

  return result
}

function derivePasteTitle(content: string): string {
  const lines = content.split(/\r?\n/)
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    return trimmed.length > TITLE_MAX_CHARS
      ? trimmed.slice(0, TITLE_MAX_CHARS)
      : trimmed
  }
  return FALLBACK_TITLE
}
