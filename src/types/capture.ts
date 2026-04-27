// Stage 1 — Capture contract.
// Every adapter (paste, URL, file, YouTube, meeting) returns this shape.
// Downstream code must not branch on source_type to decide how to read content.

export type CaptureSourceType = 'paste' | 'url' | 'file' | 'youtube' | 'meeting'

export interface CapturedSource {
  /** Canonical text content for downstream stages. */
  content: string
  /** Derived per adapter rule. Never empty. */
  title: string
  source_type: CaptureSourceType
  /** Canonical URL where applicable, null otherwise. */
  source_url: string | null
  /** Adapter-specific extras (duration, mime, char_count, author, etc). */
  metadata: Record<string, unknown>
}

/** Thrown by adapters when input is rejected (oversized, wrong format, malformed). */
export class CaptureError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'CaptureError'
    this.code = code
  }
}

/** Shared content cap for Gemini-extracted URL pages. */
export const URL_MAX_CHARS = 400_000

/** Inline file upload cap for the file adapter (Stage 1 v1).
 *  Reaching the Gemini File API ceiling (2 GB) requires Supabase Storage staging. */
export const FILE_MAX_BYTES = 25 * 1024 * 1024

/** Allowed MIME types at the file adapter boundary. */
export const FILE_SUPPORTED_MIME = {
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'text/plain': 'txt',
  'text/markdown': 'md',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'image/jpeg': 'jpg',
  'image/png': 'png',
} as const

export type SupportedFileMime = keyof typeof FILE_SUPPORTED_MIME

/** Structured log line for Stage 1 adapters. Placeholder until Stage 0 log helper lands. */
export interface CaptureLogFields {
  adapter: CaptureSourceType
  source_type: CaptureSourceType
  content_size: number
  duration_ms: number
  status: 'ok' | 'rejected' | 'error'
  reason?: string
}

export function logCapture(fields: CaptureLogFields): void {
  // eslint-disable-next-line no-console
  console.info('[capture]', fields)
}
