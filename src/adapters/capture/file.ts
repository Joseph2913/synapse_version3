import {
  CaptureError,
  FILE_MAX_BYTES,
  FILE_SUPPORTED_MIME,
  type CapturedSource,
  type SupportedFileMime,
} from '../../types/capture'

export interface CaptureFileInput {
  file: File
  authToken: string
}

function isSupportedMime(mime: string): mime is SupportedFileMime {
  return mime in FILE_SUPPORTED_MIME
}

/**
 * File adapter — Stage 1.
 * Streams the file to the Gemini-backed serverless endpoint, which uploads it
 * to the Gemini File API and returns a clean CapturedSource. No browser-side
 * PDF/DOCX/audio parsing.
 *
 * Inline cap: 25 MB. Reaching the Gemini File API ceiling (2 GB) requires a
 * Supabase Storage staging path and is tracked as Stage 1 follow-up work.
 */
export async function captureFile({ file, authToken }: CaptureFileInput): Promise<CapturedSource> {
  const mime = (file.type || '').toLowerCase()
  if (!mime || !isSupportedMime(mime)) {
    throw new CaptureError(
      'FILE_UNSUPPORTED_TYPE',
      `Unsupported file type${mime ? `: ${mime}` : ''}. Supported: PDF, DOCX, TXT, MD, MP3, M4A, WAV, MP4, MOV, JPG, PNG.`,
    )
  }
  if (file.size > FILE_MAX_BYTES) {
    throw new CaptureError(
      'FILE_OVERSIZE',
      `File is too large. Maximum is ${(FILE_MAX_BYTES / (1024 * 1024)).toFixed(0)} MB.`,
    )
  }

  const formData = new FormData()
  formData.append('file', file, file.name)

  const resp = await fetch('/api/capture/file', {
    method: 'POST',
    headers: { Authorization: `Bearer ${authToken}` },
    body: formData,
  })

  if (!resp.ok) {
    const body = await resp.json().catch(() => ({})) as { error?: string }
    const code = resp.status === 413 ? 'FILE_OVERSIZE'
      : resp.status === 415 ? 'FILE_UNSUPPORTED_TYPE'
      : resp.status === 422 ? 'FILE_UNREADABLE'
      : resp.status === 401 ? 'FILE_UNAUTHORIZED'
      : 'FILE_CAPTURE_FAILED'
    throw new CaptureError(code, body.error ?? 'Could not capture file.')
  }

  const captured = await resp.json() as CapturedSource
  return captured
}
