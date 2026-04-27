import { useState, useRef, useCallback } from 'react'
import { ArrowLeft, Loader } from 'lucide-react'
import { useExtraction } from '../../hooks/useExtraction'
import { useSettings } from '../../hooks/useSettings'
import { useAuth } from '../../hooks/useAuth'
import { useFileUpload } from '../../hooks/useFileUpload'
import { capturePaste, PASTE_MAX_CHARS } from '../../adapters/capture/paste'
import { captureUrl } from '../../adapters/capture/url'
import { captureFile } from '../../adapters/capture/file'
import { captureYoutube } from '../../adapters/capture/youtube'
import { CaptureError, FILE_MAX_BYTES, FILE_SUPPORTED_MIME } from '../../types/capture'
import { AdvancedOptions } from '../ingest/AdvancedOptions'
import { ExtractionProgress } from '../ingest/ExtractionProgress'
import { ExtractionSummary } from '../ingest/ExtractionSummary'
import { EntityReview } from '../shared/EntityReview'
import { FileDropZone } from '../ingest/FileDropZone'
import type { ExtractionConfig, ReviewEntity } from '../../types/extraction'
import type { ManualUploadType } from '../../views/IngestView'

interface ManualUploadPanelProps {
  type: ManualUploadType
  onBack: () => void
}

const PANEL_TITLES: Record<ManualUploadType, string> = {
  document: 'Upload Document',
  text: 'Add Text',
  url: 'Add URL',
  transcript: 'Add Transcript',
  youtube: 'Add YouTube Video',
}

// Stage 2 — lowercase canonical strings only.
const SOURCE_TYPE_MAP: Record<ManualUploadType, string> = {
  document: 'file',
  text: 'paste',
  url: 'url',
  transcript: 'meeting',
  youtube: 'youtube',
}

const YOUTUBE_PATTERN = /(youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/

const INPUT_STYLE: React.CSSProperties = {
  width: '100%',
  background: 'var(--color-bg-inset)',
  border: '1px solid var(--border-subtle)',
  borderRadius: 8,
  padding: '8px 12px',
  fontSize: 13,
  fontFamily: 'var(--font-body)',
  color: 'var(--color-text-primary)',
  outline: 'none',
  boxSizing: 'border-box',
  transition: 'border-color 0.15s, box-shadow 0.15s',
}

const FOCUS_STYLE = {
  borderColor: 'rgba(214,58,0,0.3)',
  boxShadow: '0 0 0 3px var(--color-accent-50)',
}
const BLUR_STYLE = {
  borderColor: 'var(--border-subtle)',
  boxShadow: 'none',
}

function applyFocus(e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) {
  Object.assign(e.currentTarget.style, FOCUS_STYLE)
}
function applyBlur(e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) {
  Object.assign(e.currentTarget.style, BLUR_STYLE)
}

export function ManualUploadPanel({ type, onBack }: ManualUploadPanelProps) {
  const { profile, extractionSettings, anchors } = useSettings()
  const { session } = useAuth()
  const { state, start, approveAndSave, reExtract, reset } = useExtraction()
  const { isDragging, dragHandlers } = useFileUpload()

  // Extraction config state
  const [mode, setMode] = useState<ExtractionConfig['mode']>(
    extractionSettings?.default_mode ?? 'comprehensive'
  )
  const [emphasis, setEmphasis] = useState<ExtractionConfig['anchorEmphasis']>(
    extractionSettings?.default_anchor_emphasis ?? 'standard'
  )
  const [selectedAnchorIds, setSelectedAnchorIds] = useState<string[]>([])
  const [customGuidance, setCustomGuidance] = useState('')

  // Per-type input state
  const [textContent, setTextContent] = useState('')
  const [urlValue, setUrlValue] = useState('')
  const [transcriptContent, setTranscriptContent] = useState('')
  const [transcriptTitle, setTranscriptTitle] = useState('')
  const [transcriptDate, setTranscriptDate] = useState('')
  const [youtubeUrl, setYoutubeUrl] = useState('')
  const [stagedFile, setStagedFile] = useState<File | null>(null)
  const [fileError, setFileError] = useState<string | null>(null)
  const [pasteError, setPasteError] = useState<string | null>(null)
  const [urlError, setUrlError] = useState<string | null>(null)
  const [youtubeError, setYoutubeError] = useState<string | null>(null)
  const [isCapturing, setIsCapturing] = useState(false)

  const latestEntitiesRef = useRef<ReviewEntity[] | null>(null)

  const isContentReady = (): boolean => {
    switch (type) {
      case 'document': return stagedFile !== null
      case 'text': return textContent.trim().length > 0
      case 'url': return urlValue.trim().length > 0
      case 'transcript': return transcriptContent.trim().length > 0
      case 'youtube': return YOUTUBE_PATTERN.test(youtubeUrl)
    }
  }

  const handleFilesAdded = useCallback((files: File[]) => {
    const file = files[0]
    if (!file) return
    setFileError(null)
    const mime = (file.type || '').toLowerCase()
    if (!mime || !(mime in FILE_SUPPORTED_MIME)) {
      setFileError('Unsupported file type. Supported: PDF, DOCX, TXT, MD, MP3, M4A, WAV, MP4, MOV, JPG, PNG.')
      return
    }
    if (file.size > FILE_MAX_BYTES) {
      setFileError(`File is too large. Maximum is ${(FILE_MAX_BYTES / (1024 * 1024)).toFixed(0)} MB.`)
      return
    }
    setStagedFile(file)
  }, [])

  const handleExtract = useCallback(async () => {
    const sourceTypeForDb = SOURCE_TYPE_MAP[type]
    let resolvedContent = ''
    let resolvedTitle = ''
    let resolvedSourceUrl: string | null = null

    // Stage 1 capture adapters. Paste/URL/file run through canonical adapters.
    // Transcript and YouTube continue on the legacy inline path until their
    // adapters land. DB-facing source_type strings stay unchanged here — the
    // lowercase->DB translation moves to Stage 2.
    try {
      if (type === 'text') {
        setPasteError(null)
        const captured = capturePaste({ content: textContent })
        resolvedContent = captured.content
        resolvedTitle = captured.title
      } else if (type === 'url') {
        setUrlError(null)
        if (!session?.access_token) {
          setUrlError('Not signed in.')
          return
        }
        setIsCapturing(true)
        const captured = await captureUrl({ url: urlValue, authToken: session.access_token })
        resolvedContent = captured.content
        resolvedTitle = captured.title
        resolvedSourceUrl = captured.source_url
      } else if (type === 'document') {
        setFileError(null)
        if (!stagedFile) return
        if (!session?.access_token) {
          setFileError('Not signed in.')
          return
        }
        setIsCapturing(true)
        const captured = await captureFile({ file: stagedFile, authToken: session.access_token })
        resolvedContent = captured.content
        resolvedTitle = captured.title
      } else if (type === 'transcript') {
        if (!transcriptContent.trim()) return
        resolvedContent = transcriptContent
        resolvedTitle = transcriptTitle.trim() || 'Transcript'
      } else if (type === 'youtube') {
        setYoutubeError(null)
        if (!youtubeUrl.trim()) return
        if (!session?.access_token) {
          setYoutubeError('Not signed in.')
          return
        }
        setIsCapturing(true)
        const captured = await captureYoutube({ url: youtubeUrl, authToken: session.access_token })
        resolvedContent = captured.content
        resolvedTitle = captured.title
        resolvedSourceUrl = captured.source_url
      }
    } catch (err) {
      if (err instanceof CaptureError) {
        if (type === 'url') setUrlError(err.message)
        else if (type === 'document') setFileError(err.message)
        else if (type === 'text') setPasteError(err.message)
        else if (type === 'youtube') setYoutubeError(err.message)
        return
      }
      throw err
    } finally {
      setIsCapturing(false)
    }

    if (!resolvedContent.trim()) return

    const config: ExtractionConfig = {
      mode,
      anchorEmphasis: emphasis,
      anchors: anchors
        .filter(a => selectedAnchorIds.includes(a.id))
        .map(a => ({ label: a.label, entity_type: a.entity_type, description: a.description ?? '' })),
      userProfile: profile,
      customGuidance: customGuidance || undefined,
    }

    await start(resolvedContent, config, {
      title: resolvedTitle,
      sourceType: sourceTypeForDb,
      sourceUrl: resolvedSourceUrl ?? undefined,
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type, mode, emphasis, anchors, selectedAnchorIds, profile, customGuidance, start,
      stagedFile, textContent, urlValue, transcriptContent, transcriptTitle, youtubeUrl, session])

  const handleEntitiesChange = useCallback((entities: ReviewEntity[]) => {
    latestEntitiesRef.current = entities
  }, [])

  const handleSave = useCallback(async () => {
    const entities = latestEntitiesRef.current ?? state.entities
    if (entities) {
      await approveAndSave(entities)
    }
  }, [state.entities, approveAndSave])

  const handleBack = useCallback(() => {
    if (state.step !== 'idle' && state.step !== 'complete' && state.step !== 'error') {
      if (!window.confirm('Extraction in progress. Are you sure you want to go back?')) return
      reset()
    }
    onBack()
  }, [state.step, reset, onBack])

  const handleIngestAnother = useCallback(() => {
    reset()
    onBack()
  }, [reset, onBack])

  const isIdle = state.step === 'idle'
  const isRunning =
    state.step === 'saving_source' ||
    state.step === 'composing_prompt' ||
    state.step === 'extracting' ||
    state.step === 'saving_nodes' ||
    state.step === 'generating_embeddings' ||
    state.step === 'chunking_source' ||
    state.step === 'summarizing' ||
    state.step === 'discovering_connections'
  const isReviewing = state.step === 'reviewing'
  const isError = state.step === 'error'
  const isComplete = state.step === 'complete'
  const showProgress = isRunning || isReviewing || isError

  // After save completes, call onBack
  const prevCompleteRef = useRef(false)
  if (isComplete && !prevCompleteRef.current) {
    prevCompleteRef.current = true
  }

  const youtubeMatch = YOUTUBE_PATTERN.exec(youtubeUrl)
  const youtubeVideoId = youtubeMatch ? youtubeMatch[2] : null

  const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: 'var(--color-bg-card)', borderLeft: '1px solid var(--border-subtle)' }}>

      {/* ── Panel Header ── */}
      <div style={{
        height: 48,
        borderBottom: '1px solid var(--border-subtle)',
        padding: '0 16px',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        flexShrink: 0,
      }}>
        <button
          type="button"
          onClick={handleBack}
          style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: 4, display: 'flex', alignItems: 'center', color: 'var(--color-text-secondary)' }}
        >
          <ArrowLeft size={16} />
        </button>
        <span className="font-display" style={{ fontSize: 14, fontWeight: 700, color: 'var(--color-text-primary)' }}>
          {PANEL_TITLES[type]}
        </span>
      </div>

      {/* ── Scrollable Body ── */}
      <div style={{ flex: 1, overflowY: 'auto', padding: 16 }}>

        {/* Idle: input area + extraction options */}
        {isIdle && (
          <>
            {/* ── Document ── */}
            {type === 'document' && (
              <div style={{ marginBottom: 16 }}>
                {stagedFile === null ? (
                  <>
                    <FileDropZone
                      onFilesAdded={handleFilesAdded}
                      isDragging={isDragging}
                      dragHandlers={dragHandlers}
                      error={fileError}
                    />
                    {fileError && (
                      <p className="font-body" style={{ fontSize: 12, color: '#ef4444', marginTop: 8 }}>
                        {fileError}
                      </p>
                    )}
                    <p className="font-body" style={{ fontSize: 11, color: 'var(--color-text-placeholder)', marginTop: 8 }}>
                      PDF, DOCX, TXT, MD, MP3, M4A, WAV, MP4, MOV, JPG, PNG. Up to {(FILE_MAX_BYTES / (1024 * 1024)).toFixed(0)} MB.
                    </p>
                  </>
                ) : (
                  <div style={{
                    padding: '10px 12px',
                    borderRadius: 8,
                    border: '1px solid var(--border-subtle)',
                    background: 'var(--color-bg-inset)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 8,
                  }}>
                    <div style={{ minWidth: 0 }}>
                      <div className="font-body" style={{ fontSize: 13, fontWeight: 500, color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {stagedFile.name}
                      </div>
                      <div className="font-body" style={{ fontSize: 11, color: 'var(--color-text-secondary)', marginTop: 2 }}>
                        {formatFileSize(stagedFile.size)}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => { setStagedFile(null); setFileError(null) }}
                      className="font-body"
                      style={{ fontSize: 11, color: 'var(--color-text-secondary)', background: 'transparent', border: 'none', cursor: 'pointer', flexShrink: 0 }}
                    >
                      Remove
                    </button>
                  </div>
                )}
                {fileError && stagedFile !== null && (
                  <p className="font-body" style={{ fontSize: 12, color: '#ef4444', marginTop: 8 }}>
                    {fileError}
                  </p>
                )}
              </div>
            )}

            {/* ── Text ── */}
            {type === 'text' && (
              <div style={{ marginBottom: 16 }}>
                <textarea
                  value={textContent}
                  onChange={e => { setTextContent(e.target.value); if (pasteError) setPasteError(null) }}
                  placeholder="Paste or type your content here..."
                  style={{
                    ...INPUT_STYLE,
                    minHeight: 120,
                    maxHeight: 280,
                    resize: 'vertical',
                  }}
                  onFocus={applyFocus}
                  onBlur={applyBlur}
                />
                <div
                  className="font-body"
                  style={{
                    fontSize: 11,
                    color: textContent.length > PASTE_MAX_CHARS
                      ? '#ef4444'
                      : 'var(--color-text-placeholder)',
                    textAlign: 'right',
                    marginTop: 4,
                  }}
                >
                  {textContent.length.toLocaleString()} / {PASTE_MAX_CHARS.toLocaleString()} chars
                </div>
                {pasteError && (
                  <p className="font-body" style={{ fontSize: 12, color: '#ef4444', marginTop: 6 }}>
                    {pasteError}
                  </p>
                )}
              </div>
            )}

            {/* ── URL ── */}
            {type === 'url' && (
              <div style={{ marginBottom: 16 }}>
                <input
                  type="url"
                  value={urlValue}
                  onChange={e => { setUrlValue(e.target.value); if (urlError) setUrlError(null) }}
                  placeholder="https://..."
                  style={INPUT_STYLE}
                  onFocus={applyFocus}
                  onBlur={applyBlur}
                />
                {urlValue.trim().length > 0 && (
                  <div style={{ marginTop: 8, padding: '8px 10px', borderRadius: 6, background: 'var(--color-bg-inset)', border: '1px solid var(--border-subtle)', display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 14 }}>🌐</span>
                    <span className="font-body" style={{ fontSize: 11, color: 'var(--color-text-secondary)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {urlValue.trim()}
                    </span>
                    <button
                      type="button"
                      onClick={() => setUrlValue('')}
                      style={{ background: 'transparent', border: 'none', cursor: 'pointer', fontSize: 12, color: 'var(--color-text-placeholder)', flexShrink: 0 }}
                    >
                      ×
                    </button>
                  </div>
                )}
                {urlError && (
                  <p className="font-body" style={{ fontSize: 12, color: '#ef4444', marginTop: 6 }}>
                    {urlError}
                  </p>
                )}
              </div>
            )}

            {/* ── Transcript ── */}
            {type === 'transcript' && (
              <div style={{ marginBottom: 16 }}>
                <textarea
                  value={transcriptContent}
                  onChange={e => setTranscriptContent(e.target.value)}
                  placeholder="Paste your meeting or video transcript here..."
                  style={{
                    ...INPUT_STYLE,
                    minHeight: 140,
                    maxHeight: 320,
                    resize: 'vertical',
                  }}
                  onFocus={applyFocus}
                  onBlur={applyBlur}
                />
                <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                  <input
                    type="text"
                    value={transcriptTitle}
                    onChange={e => setTranscriptTitle(e.target.value)}
                    placeholder="Title (optional)"
                    style={{ ...INPUT_STYLE, flex: 1 }}
                    onFocus={applyFocus}
                    onBlur={applyBlur}
                  />
                  <input
                    type="text"
                    value={transcriptDate}
                    onChange={e => setTranscriptDate(e.target.value)}
                    placeholder="Date (optional)"
                    style={{ ...INPUT_STYLE, flex: 1 }}
                    onFocus={applyFocus}
                    onBlur={applyBlur}
                  />
                </div>
              </div>
            )}

            {/* ── YouTube ── */}
            {type === 'youtube' && (
              <div style={{ marginBottom: 16 }}>
                <input
                  type="url"
                  value={youtubeUrl}
                  onChange={e => { setYoutubeUrl(e.target.value); if (youtubeError) setYoutubeError(null) }}
                  placeholder="Paste a YouTube video URL..."
                  style={INPUT_STYLE}
                  onFocus={applyFocus}
                  onBlur={applyBlur}
                />
                {youtubeVideoId && (
                  <div style={{ marginTop: 8, padding: '10px 12px', borderRadius: 8, border: '1px solid var(--border-subtle)', background: 'var(--color-bg-inset)', display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                    <img src="/logos/youtube.svg" alt="YouTube" style={{ width: 20, height: 14, objectFit: 'contain', marginTop: 2, flexShrink: 0 }} />
                    <div>
                      <div className="font-body" style={{ fontSize: 12, fontWeight: 500, color: 'var(--color-text-primary)' }}>
                        Video: {youtubeVideoId}
                      </div>
                      <div className="font-body" style={{ fontSize: 11, color: 'var(--color-text-secondary)', marginTop: 2 }}>
                        Transcript will be extracted automatically
                      </div>
                    </div>
                  </div>
                )}
                {youtubeError && (
                  <p className="font-body" style={{ fontSize: 12, color: '#ef4444', marginTop: 6 }}>
                    {youtubeError}
                  </p>
                )}
              </div>
            )}

            {/* Extraction Options */}
            <AdvancedOptions
              mode={mode}
              onModeChange={setMode}
              emphasis={emphasis}
              onEmphasisChange={setEmphasis}
              selectedAnchorIds={selectedAnchorIds}
              onAnchorIdsChange={setSelectedAnchorIds}
              customGuidance={customGuidance}
              onGuidanceChange={setCustomGuidance}
            />
          </>
        )}

        {/* Progress / Review / Error */}
        {showProgress && (
          <>
            <ExtractionProgress
              step={state.step}
              statusText={state.statusText}
              elapsedMs={state.elapsedMs}
              embeddingProgress={state.embeddingProgress}
              error={state.error}
              onRetry={isError ? () => void reExtract() : undefined}
              onCancel={isError ? handleIngestAnother : undefined}
            />

            {isReviewing && state.entities && state.relationships && (
              <EntityReview
                entities={latestEntitiesRef.current ?? state.entities}
                relationships={state.relationships}
                onEntitiesChange={handleEntitiesChange}
                onSave={handleSave}
                onReExtract={() => void reExtract()}
                saving={false}
              />
            )}
          </>
        )}

        {/* Complete */}
        {isComplete && (
          <ExtractionSummary
            entityCount={state.savedNodes?.length ?? 0}
            relationshipCount={state.savedEdgeIds?.length ?? 0}
            crossConnectionCount={state.crossConnectionCount}
            durationMs={state.elapsedMs}
            duplicatesSkipped={state.duplicatesSkipped}
            onViewInBrowse={onBack}
            onIngestAnother={handleIngestAnother}
          />
        )}
      </div>

      {/* ── Footer ── */}
      {isIdle && (
        <div style={{
          borderTop: '1px solid var(--border-subtle)',
          padding: '12px 16px',
          flexShrink: 0,
        }}>
          <button
            type="button"
            onClick={() => void handleExtract()}
            disabled={!isContentReady() || isCapturing}
            className="font-body font-semibold"
            style={{
              width: '100%',
              padding: '10px 0',
              borderRadius: 8,
              border: 'none',
              background: 'var(--color-accent-500)',
              color: '#fff',
              fontSize: 13,
              cursor: isContentReady() ? 'pointer' : 'not-allowed',
              opacity: isContentReady() ? 1 : 0.4,
              transition: 'opacity 0.15s',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
            }}
          >
            {isCapturing ? (
              <>
                <Loader size={14} style={{ animation: 'spin 1s linear infinite' }} />
                {type === 'url' ? 'Reading URL…' : type === 'document' ? 'Reading file…' : type === 'youtube' ? 'Fetching transcript…' : 'Capturing…'}
              </>
            ) : isRunning ? (
              <>
                <Loader size={14} style={{ animation: 'spin 1s linear infinite' }} />
                Extracting…
              </>
            ) : (
              'Extract Knowledge'
            )}
          </button>
        </div>
      )}
    </div>
  )
}

