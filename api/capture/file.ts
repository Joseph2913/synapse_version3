import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import formidable, { type File as FormidableFile } from 'formidable'
import { readFile } from 'node:fs/promises'

// ─── Disable Vercel's default body parser (we stream multipart) ───────────────

export const config = {
  api: { bodyParser: false },
}

// ─── Supabase env + factories ────────────────────────────────────────────────

const SUPABASE_URL = process.env.SUPABASE_URL!
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY!

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  throw new Error('[capture/file] Missing env vars: SUPABASE_URL, SUPABASE_ANON_KEY')
}

function getAnonSupabase(): SupabaseClient {
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
}

async function getUserIdFromRequest(req: VercelRequest): Promise<string | null> {
  const auth = req.headers.authorization
  if (!auth?.startsWith('Bearer ')) return null
  const token = auth.slice(7)
  try {
    const { data: { user } } = await getAnonSupabase().auth.getUser(token)
    return user?.id ?? null
  } catch {
    return null
  }
}

// ─── Gemini env + helpers ────────────────────────────────────────────────────

const GEMINI_API_KEY = process.env.GEMINI_API_KEY!
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models'
const GEMINI_FILES_BASE = 'https://generativelanguage.googleapis.com/v1beta'
const GEMINI_MODEL = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash'

if (!GEMINI_API_KEY) {
  throw new Error('[capture/file] Missing env var: GEMINI_API_KEY')
}

// ─── Gemini fetch + helpers (retry on 429/5xx, token-usage logging) ─────────

interface GeminiUsage {
  promptTokenCount?: number
  candidatesTokenCount?: number
  totalTokenCount?: number
}

async function geminiFetch(
  endpoint: string,
  body: unknown,
  timeoutMs: number,
  stage: string
): Promise<{ json: unknown; usage: GeminiUsage | undefined }> {
  const url = `${GEMINI_BASE}/${endpoint}?key=${GEMINI_API_KEY}`
  const maxAttempts = 3
  let lastErr: Error | null = null
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify(body),
      })
      if (resp.ok) {
        const json = await resp.json() as { usageMetadata?: GeminiUsage }
        const usage = json.usageMetadata
        if (usage) {
          console.log(JSON.stringify({
            stage, model: endpoint.split(':')[0],
            prompt_tokens: usage.promptTokenCount,
            output_tokens: usage.candidatesTokenCount,
            total_tokens: usage.totalTokenCount,
          }))
        }
        return { json, usage }
      }
      const txt = await resp.text().catch(() => '')
      lastErr = new Error(`Gemini ${resp.status}: ${txt.slice(0, 200)}`)
      if ((resp.status === 429 || resp.status >= 500) && attempt < maxAttempts - 1) {
        await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 1000))
        continue
      }
      throw lastErr
    } catch (err) {
      lastErr = err as Error
      if (attempt < maxAttempts - 1) {
        await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 1000))
        continue
      }
      throw lastErr
    } finally {
      clearTimeout(timer)
    }
  }
  throw lastErr ?? new Error('[gemini] request failed')
}

interface GeminiFileUploadResult {
  file: { name: string; uri: string; mimeType: string; state: string }
}

/** Upload a file to Gemini File API (returns the file URI we then reference in generateContent). */
async function uploadToGeminiFiles(buf: Buffer, mimeType: string, displayName: string): Promise<GeminiFileUploadResult['file']> {
  const startUrl = `${GEMINI_FILES_BASE}/files?key=${GEMINI_API_KEY}&uploadType=multipart`
  const boundary = `----capture-boundary-${Date.now().toString(16)}`
  const metadata = JSON.stringify({ file: { display_name: displayName } })

  const head = Buffer.from(
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${metadata}\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: ${mimeType}\r\n\r\n`,
    'utf-8',
  )
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf-8')
  const body = Buffer.concat([head, buf, tail])

  const resp = await fetch(startUrl, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
  })

  if (!resp.ok) {
    const txt = await resp.text().catch(() => '')
    throw new Error(`Gemini Files upload failed ${resp.status}: ${txt.slice(0, 200)}`)
  }
  const json = await resp.json() as GeminiFileUploadResult
  if (!json.file?.uri) throw new Error('Gemini Files upload returned no URI')
  return json.file
}

// ─── Capture contract (inline, no local imports per Vercel rules) ─────────────

const FILE_MAX_BYTES = 25 * 1024 * 1024
const URL_MAX_CHARS = 400_000

const FILE_SUPPORTED_MIME: Record<string, string> = {
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
}

interface CapturedSource {
  content: string
  title: string
  source_type: 'file'
  source_url: string | null
  metadata: Record<string, unknown>
}

const FILE_EXTRACTION_PROMPT = `You are a content extraction assistant. The user has uploaded a file. Read it and return ONE JSON object:
- "title": the most natural human title from the document's content (PDF metadata title, document heading, slide title, or key visible label). Use null if no clear title.
- "content": the full readable text content. For audio and video, return a complete transcript with paragraph breaks. For images, return all visible text via OCR plus a short scene description. Plain text only, no HTML, no markdown headers. Preserve paragraph and section breaks.
- "language": ISO-639-1 code (e.g. "en") or null if uncertain.
- "page_count": integer page count for documents, otherwise null.
- "duration_seconds": number for audio/video, otherwise null.
Return ONLY the JSON object. No commentary.`

interface FileExtractionResult {
  title?: string | null
  content?: string
  language?: string | null
  page_count?: number | null
  duration_seconds?: number | null
}

// ─── Multipart parsing ────────────────────────────────────────────────────────

async function parseUpload(req: VercelRequest): Promise<FormidableFile | null> {
  const form = formidable({
    multiples: false,
    maxFileSize: FILE_MAX_BYTES,
    keepExtensions: true,
  })
  return new Promise((resolve, reject) => {
    form.parse(req, (err, _fields, files) => {
      if (err) return reject(err)
      const fileEntry = (files.file ?? Object.values(files)[0]) as FormidableFile | FormidableFile[] | undefined
      if (!fileEntry) return resolve(null)
      resolve(Array.isArray(fileEntry) ? fileEntry[0] : fileEntry)
    })
  })
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<VercelResponse> {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')

  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const userId = await getUserIdFromRequest(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })

  let upload: FormidableFile | null
  try {
    upload = await parseUpload(req)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('maxFileSize')) {
      return res.status(413).json({ error: `File is too large. Maximum is ${(FILE_MAX_BYTES / (1024 * 1024)).toFixed(0)} MB.` })
    }
    return res.status(400).json({ error: 'Could not read upload.' })
  }
  if (!upload) return res.status(400).json({ error: 'No file in upload.' })

  const mimeType = (upload.mimetype ?? '').toLowerCase()
  if (!mimeType || !FILE_SUPPORTED_MIME[mimeType]) {
    return res.status(415).json({
      error: `Unsupported file type${mimeType ? `: ${mimeType}` : ''}. Supported: PDF, DOCX, TXT, MD, MP3, M4A, WAV, MP4, MOV, JPG, PNG.`,
    })
  }
  if (upload.size > FILE_MAX_BYTES) {
    return res.status(413).json({ error: `File is too large. Maximum is ${(FILE_MAX_BYTES / (1024 * 1024)).toFixed(0)} MB.` })
  }

  const startedAt = Date.now()
  const displayName = upload.originalFilename ?? 'upload'

  let buf: Buffer
  try {
    buf = await readFile(upload.filepath)
  } catch {
    return res.status(500).json({ error: 'Could not read uploaded file from disk.' })
  }

  let geminiFile: GeminiFileUploadResult['file']
  try {
    geminiFile = await uploadToGeminiFiles(buf, mimeType, displayName)
  } catch (err) {
    console.error('[capture/file] Gemini Files upload failed', err instanceof Error ? err.message : err)
    return res.status(502).json({ error: 'Could not stage file for extraction.' })
  }

  let extracted: FileExtractionResult
  try {
    const { json } = await geminiFetch(
      `${GEMINI_MODEL}:generateContent`,
      {
        system_instruction: { parts: [{ text: FILE_EXTRACTION_PROMPT }] },
        contents: [{
          parts: [
            { fileData: { mimeType: geminiFile.mimeType, fileUri: geminiFile.uri } },
            { text: 'Extract the file as instructed.' },
          ],
        }],
        generationConfig: { temperature: 0.1, responseMimeType: 'application/json' },
      },
      120_000,
      'capture:file',
    )
    const data = json as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> }
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text
    if (!text) {
      return res.status(502).json({ error: 'Could not extract content from this file.' })
    }
    extracted = JSON.parse(text) as FileExtractionResult
  } catch (err) {
    console.error('[capture/file] Gemini generate failed', err instanceof Error ? err.message : err)
    return res.status(502).json({ error: 'Could not extract content from this file.' })
  }

  if (!extracted.content || !extracted.content.trim()) {
    return res.status(422).json({ error: 'No readable content found in this file.' })
  }

  let content = extracted.content
  if (content.length > URL_MAX_CHARS) {
    return res.status(413).json({
      error: `Extracted text is too large (${content.length.toLocaleString()} characters; maximum ${URL_MAX_CHARS.toLocaleString()}).`,
    })
  }

  const filenameTitle = displayName.replace(/\.[^.]+$/, '').trim()
  const title = (extracted.title?.trim() || filenameTitle || 'Untitled file').slice(0, 200)

  const captured: CapturedSource = {
    content,
    title,
    source_type: 'file',
    source_url: null,
    metadata: {
      filename: displayName,
      mime_type: mimeType,
      file_extension: FILE_SUPPORTED_MIME[mimeType],
      file_size_bytes: upload.size,
      char_count: content.length,
      language: extracted.language ?? null,
      page_count: extracted.page_count ?? null,
      duration_seconds: extracted.duration_seconds ?? null,
      duration_ms: Date.now() - startedAt,
    },
  }

  console.info(JSON.stringify({
    log: 'capture',
    adapter: 'file',
    source_type: 'file',
    content_size: content.length,
    duration_ms: Date.now() - startedAt,
    status: 'ok',
  }))

  return res.status(200).json(captured)
}
