import { useRef, useState } from 'react'
import {
  AlertCircle,
  FileText,
  Globe,
  Loader2,
  Mic,
  Type,
  Upload,
  X,
  Youtube,
  type LucideIcon,
} from 'lucide-react'
import { useAuth } from '../../hooks/useAuth'
import {
  extractTextFromFile,
  validateFile,
} from '../../utils/fileParser'
import {
  fetchVideoTitle,
  fetchYouTubeTranscript,
  parseVideoUrl,
} from '../../services/youtube'
import type { ProcessSkillSourceResult } from '../../services/manualSignals'

type SkillInputMode = 'text' | 'url' | 'document' | 'transcript' | 'youtube'

interface SkillCreateRequest {
  title?: string
  content: string
  sourceType: 'paste' | 'file' | 'meeting' | 'youtube' | 'url'
  sourceUrl?: string
  inputType: SkillInputMode
}

interface SkillCreatePanelProps {
  onClose: () => void
  onProcess: (input: SkillCreateRequest) => Promise<ProcessSkillSourceResult>
}

const MODES: Array<{ key: SkillInputMode; label: string; icon: LucideIcon }> = [
  { key: 'text', label: 'Text', icon: Type },
  { key: 'url', label: 'URL', icon: Globe },
  { key: 'document', label: 'Document', icon: FileText },
  { key: 'transcript', label: 'Transcript', icon: Mic },
  { key: 'youtube', label: 'YouTube', icon: Youtube },
]

const PANEL_STYLE: React.CSSProperties = {
  background: 'var(--color-bg-card)',
  border: '1px solid var(--border-subtle)',
  borderRadius: 12,
  padding: '16px 18px',
  marginBottom: 14,
}

const INPUT_STYLE: React.CSSProperties = {
  width: '100%',
  borderRadius: 10,
  border: '1px solid var(--border-subtle)',
  background: 'var(--color-bg-inset)',
  color: 'var(--color-text-body)',
  fontSize: 13,
  outline: 'none',
  padding: '10px 12px',
  boxSizing: 'border-box',
}

function SectionHeader({ title, hint }: { title: string; hint: string }) {
  return (
    <div style={{ marginBottom: 8 }}>
      <div className="font-body" style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text-primary)', marginBottom: 4 }}>
        {title}
      </div>
      <p className="font-body" style={{ fontSize: 11, color: 'var(--color-text-secondary)', margin: 0, lineHeight: 1.5 }}>
        {hint}
      </p>
    </div>
  )
}

export function SkillCreatePanel({
  onClose,
  onProcess,
}: SkillCreatePanelProps) {
  const { session } = useAuth()

  const [mode, setMode] = useState<SkillInputMode>('text')
  const [textTitle, setTextTitle] = useState('')
  const [textContent, setTextContent] = useState('')
  const [urlValue, setUrlValue] = useState('')
  const [urlTitle, setUrlTitle] = useState('')
  const [documentTitle, setDocumentTitle] = useState('')
  const [documentFile, setDocumentFile] = useState<File | null>(null)
  const [documentContent, setDocumentContent] = useState('')
  const [transcriptTitle, setTranscriptTitle] = useState('')
  const [transcriptContent, setTranscriptContent] = useState('')
  const [youtubeUrl, setYoutubeUrl] = useState('')
  const [youtubeTitle, setYoutubeTitle] = useState('')
  const [statusText, setStatusText] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [warning, setWarning] = useState<string | null>(null)
  const [processing, setProcessing] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const clearMessages = () => {
    setError(null)
    setWarning(null)
    setStatusText(null)
  }

  const handleModeChange = (nextMode: SkillInputMode) => {
    setMode(nextMode)
    clearMessages()
  }

  const handleDocumentSelected = async (file: File) => {
    const validation = validateFile(file)
    if (!validation.valid) {
      setDocumentFile(null)
      setDocumentContent('')
      setError(validation.error ?? 'Unsupported file.')
      setWarning(null)
      return
    }

    clearMessages()
    setWarning(validation.warning ?? null)
    setDocumentFile(file)
    setDocumentTitle(file.name.replace(/\.[^.]+$/, ''))
    setStatusText('Reading document…')

    try {
      const text = await extractTextFromFile(file)
      setDocumentContent(text.trim())
      setStatusText(null)
    } catch (err) {
      setDocumentContent('')
      setError(err instanceof Error ? err.message : 'Failed to read document.')
      setStatusText(null)
    }
  }

  const resolveInput = async (): Promise<SkillCreateRequest> => {
    if (mode === 'text') {
      return {
        title: textTitle.trim() || undefined,
        content: textContent.trim(),
        sourceType: 'paste',
        inputType: 'text',
      }
    }

    if (mode === 'url') {
      const url = urlValue.trim()
      if (!url.startsWith('http://') && !url.startsWith('https://')) {
        throw new Error('URL must start with http:// or https://')
      }
      if (!session?.access_token) throw new Error('Not authenticated.')

      setStatusText('Fetching source content…')

      const response = await fetch('/api/content/fetch', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ url }),
      })

      if (!response.ok) {
        const body = await response.json().catch(() => ({ error: 'Failed to fetch URL content.' })) as { error?: string }
        throw new Error(body.error ?? 'Failed to fetch URL content.')
      }

      const body = await response.json() as { title?: string; content?: string; url: string }
      return {
        title: urlTitle.trim() || body.title || undefined,
        content: body.content?.trim() ?? '',
        sourceType: 'url',
        sourceUrl: body.url,
        inputType: 'url',
      }
    }

    if (mode === 'document') {
      return {
        title: documentTitle.trim() || documentFile?.name || undefined,
        content: documentContent.trim(),
        sourceType: 'file',
        inputType: 'document',
      }
    }

    if (mode === 'transcript') {
      return {
        title: transcriptTitle.trim() || undefined,
        content: transcriptContent.trim(),
        sourceType: 'meeting',
        inputType: 'transcript',
      }
    }

    const videoUrl = youtubeUrl.trim()
    if (!session?.access_token) throw new Error('Not authenticated.')
    if (!parseVideoUrl(videoUrl)) throw new Error('Enter a valid YouTube URL or video ID.')

    setStatusText('Fetching YouTube transcript…')

    let resolvedTitle = youtubeTitle.trim()
    if (!resolvedTitle) {
      const videoId = parseVideoUrl(videoUrl)
      if (videoId) {
        resolvedTitle = (await fetchVideoTitle(videoId)) ?? ''
      }
    }

    const transcript = await fetchYouTubeTranscript(videoUrl, session.access_token)

    return {
      title: resolvedTitle || undefined,
      content: transcript.transcript.trim(),
      sourceType: 'youtube',
      sourceUrl: videoUrl,
      inputType: 'youtube',
    }
  }

  const handleSubmit = async () => {
    clearMessages()
    setProcessing(true)

    try {
      const resolved = await resolveInput()
      if (!resolved.content.trim()) {
        throw new Error('Add some source content before extracting a skill.')
      }
      if (resolved.content.trim().length < 500) {
        throw new Error('Provide at least 500 characters so the extraction model has enough material to build a reusable skill.')
      }

      setStatusText('Handing off to extraction pipeline…')

      // onProcess will close this panel and run the pipeline in the background.
      // State updates after this point are no-ops since the panel will be unmounted.
      await onProcess(resolved)
    } catch (err) {
      // Only reaches here if resolveInput() or the initial validation failed
      // (before the panel is closed), or if onProcess rejects synchronously.
      setError(err instanceof Error ? err.message : 'Failed to process skill source.')
      setStatusText(null)
      setProcessing(false)
    }
  }

  const activeCharCount = (() => {
    if (mode === 'text') return textContent.trim().length
    if (mode === 'document') return documentContent.trim().length
    if (mode === 'transcript') return transcriptContent.trim().length
    return 0
  })()

  const canSubmit = (() => {
    if (processing) return false
    if (mode === 'text') return textContent.trim().length > 0
    if (mode === 'url') return urlValue.trim().length > 0
    if (mode === 'document') return documentContent.trim().length > 0
    if (mode === 'transcript') return transcriptContent.trim().length > 0
    return youtubeUrl.trim().length > 0
  })()

  return (
    <div style={{ height: '100%', overflowY: 'auto', padding: '24px 20px' }}>
      <div className="flex items-start justify-between gap-4" style={{ marginBottom: 18 }}>
        <div>
          <h2 className="font-display" style={{ fontSize: 18, fontWeight: 700, color: 'var(--color-text-primary)', margin: 0 }}>
            Add Manual Skill
          </h2>
          <p className="font-body" style={{ fontSize: 12, color: 'var(--color-text-secondary)', margin: '6px 0 0 0', lineHeight: 1.55 }}>
            Submit source material and Synapse will extract reusable methodology into your skill library.
          </p>
        </div>

        <button
          type="button"
          onClick={onClose}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-text-secondary)', padding: 4 }}
        >
          <X size={16} />
        </button>
      </div>

      <div style={PANEL_STYLE}>
        <SectionHeader
          title="Source Type"
          hint="Choose the input format you want to turn into a reusable skill."
        />
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, minmax(0, 1fr))', gap: 8 }}>
          {MODES.map(option => {
            const Icon = option.icon
            const isActive = option.key === mode
            return (
              <button
                key={option.key}
                type="button"
                onClick={() => handleModeChange(option.key)}
                className="font-body"
                style={{
                  borderRadius: 10,
                  border: `1px solid ${isActive ? 'rgba(214,58,0,0.18)' : 'var(--border-subtle)'}`,
                  background: isActive ? 'var(--color-accent-50)' : 'var(--color-bg-card)',
                  color: isActive ? 'var(--color-accent-500)' : 'var(--color-text-secondary)',
                  padding: '10px 8px',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 6,
                  fontSize: 12,
                  fontWeight: 600,
                }}
              >
                <Icon size={13} />
                {option.label}
              </button>
            )
          })}
        </div>
      </div>

      {mode === 'text' && (
        <div style={PANEL_STYLE}>
          <SectionHeader
            title="Text Input"
            hint="Paste raw notes, frameworks, or reference material directly."
          />
          <input
            type="text"
            value={textTitle}
            onChange={event => { setTextTitle(event.target.value); clearMessages() }}
            placeholder="Optional source title"
            className="font-body"
            style={{ ...INPUT_STYLE, marginBottom: 10 }}
          />
          <textarea
            value={textContent}
            onChange={event => { setTextContent(event.target.value); clearMessages() }}
            rows={12}
            placeholder="Paste the content you want converted into a skill."
            className="font-body"
            style={{ ...INPUT_STYLE, resize: 'vertical', lineHeight: 1.6 }}
          />
        </div>
      )}

      {mode === 'url' && (
        <div style={PANEL_STYLE}>
          <SectionHeader
            title="URL Input"
            hint="Fetch a readable web page, article, or reference note and pass it into the skill extractor."
          />
          <input
            type="url"
            value={urlValue}
            onChange={event => { setUrlValue(event.target.value); clearMessages() }}
            placeholder="https://example.com/framework"
            className="font-body"
            style={{ ...INPUT_STYLE, marginBottom: 10 }}
          />
          <input
            type="text"
            value={urlTitle}
            onChange={event => { setUrlTitle(event.target.value); clearMessages() }}
            placeholder="Optional title override"
            className="font-body"
            style={INPUT_STYLE}
          />
        </div>
      )}

      {mode === 'document' && (
        <div style={PANEL_STYLE}>
          <SectionHeader
            title="Document Input"
            hint="Upload a PDF, DOCX, Markdown, text, or CSV file. Synapse will read the contents before extraction."
          />
          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf,.docx,.md,.txt,.csv"
            onChange={event => {
              const file = event.target.files?.[0]
              if (file) void handleDocumentSelected(file)
            }}
            style={{ display: 'none' }}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="font-body"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '9px 14px',
              borderRadius: 8,
              border: '1px solid var(--border-subtle)',
              background: 'var(--color-bg-card)',
              color: 'var(--color-text-body)',
              cursor: 'pointer',
              fontSize: 12,
              fontWeight: 600,
              marginBottom: 10,
            }}
          >
            <Upload size={13} />
            {documentFile ? 'Replace Document' : 'Choose Document'}
          </button>

          {documentFile && (
            <div
              style={{
                background: 'var(--color-bg-inset)',
                border: '1px solid var(--border-subtle)',
                borderRadius: 10,
                padding: '10px 12px',
                marginBottom: 10,
              }}
            >
              <div className="font-body" style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text-primary)', marginBottom: 2 }}>
                {documentFile.name}
              </div>
              <div className="font-body" style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>
                {documentContent.length.toLocaleString()} extracted characters
              </div>
            </div>
          )}

          <input
            type="text"
            value={documentTitle}
            onChange={event => { setDocumentTitle(event.target.value); clearMessages() }}
            placeholder="Optional title override"
            className="font-body"
            style={INPUT_STYLE}
          />
        </div>
      )}

      {mode === 'transcript' && (
        <div style={PANEL_STYLE}>
          <SectionHeader
            title="Transcript Input"
            hint="Paste a meeting, interview, or conversation transcript that contains reusable methodology."
          />
          <input
            type="text"
            value={transcriptTitle}
            onChange={event => { setTranscriptTitle(event.target.value); clearMessages() }}
            placeholder="Transcript title"
            className="font-body"
            style={{ ...INPUT_STYLE, marginBottom: 10 }}
          />
          <textarea
            value={transcriptContent}
            onChange={event => { setTranscriptContent(event.target.value); clearMessages() }}
            rows={12}
            placeholder="Paste the transcript content."
            className="font-body"
            style={{ ...INPUT_STYLE, resize: 'vertical', lineHeight: 1.6 }}
          />
        </div>
      )}

      {mode === 'youtube' && (
        <div style={PANEL_STYLE}>
          <SectionHeader
            title="YouTube Input"
            hint="Paste a YouTube link. Synapse will fetch the transcript first, then generate a skill from it."
          />
          <input
            type="text"
            value={youtubeUrl}
            onChange={event => { setYoutubeUrl(event.target.value); clearMessages() }}
            placeholder="https://www.youtube.com/watch?v=..."
            className="font-body"
            style={{ ...INPUT_STYLE, marginBottom: 10 }}
          />
          <input
            type="text"
            value={youtubeTitle}
            onChange={event => { setYoutubeTitle(event.target.value); clearMessages() }}
            placeholder="Optional title override"
            className="font-body"
            style={INPUT_STYLE}
          />
        </div>
      )}

      {(statusText || error || warning) && (
        <div
          style={{
            background: error
              ? 'rgba(239,68,68,0.06)'
              : warning
                ? 'rgba(245,158,11,0.08)'
                : 'var(--color-bg-inset)',
            border: error
              ? '1px solid rgba(239,68,68,0.18)'
              : warning
                ? '1px solid rgba(245,158,11,0.18)'
                : '1px solid var(--border-subtle)',
            borderRadius: 10,
            padding: '10px 12px',
            marginBottom: 14,
          }}
        >
          <div className="flex items-start gap-2">
            {(error || warning) && (
              <AlertCircle
                size={14}
                style={{
                  color: error ? 'var(--semantic-red-500, #ef4444)' : '#d97706',
                  flexShrink: 0,
                  marginTop: 1,
                }}
              />
            )}
            <p
              className="font-body"
              style={{
                margin: 0,
                fontSize: 12,
                lineHeight: 1.55,
                color: error
                  ? 'var(--semantic-red-500, #ef4444)'
                  : warning
                    ? '#b45309'
                    : 'var(--color-text-body)',
              }}
            >
              {error ?? warning ?? statusText}
            </p>
          </div>
        </div>
      )}

      <div
        style={{
          borderTop: '1px solid var(--border-subtle)',
          paddingTop: 14,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
        }}
      >
        <span className="font-body" style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>
          {activeCharCount > 0 ? `${activeCharCount.toLocaleString()} chars ready` : 'Aim for at least 500 characters of substantive methodology.'}
        </span>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onClose}
            className="font-body"
            style={{
              background: 'transparent',
              color: 'var(--color-text-secondary)',
              fontSize: 12,
              fontWeight: 600,
              padding: '9px 14px',
              borderRadius: 8,
              border: 'none',
              cursor: 'pointer',
            }}
          >
            Cancel
          </button>

          <button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={!canSubmit}
            className="font-body"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              background: canSubmit ? 'var(--color-accent-500)' : 'var(--color-bg-inset)',
              color: canSubmit ? '#fff' : 'var(--color-text-secondary)',
              fontSize: 12,
              fontWeight: 600,
              padding: '9px 16px',
              borderRadius: 8,
              border: 'none',
              cursor: canSubmit ? 'pointer' : 'not-allowed',
            }}
          >
            {processing ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> : null}
            {processing ? 'Processing…' : 'Extract Skill'}
          </button>
        </div>
      </div>
    </div>
  )
}
