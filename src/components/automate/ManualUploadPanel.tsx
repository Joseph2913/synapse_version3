import { useState, useRef, useCallback } from 'react'
import { ArrowLeft, Loader } from 'lucide-react'
import { useExtraction } from '../../hooks/useExtraction'
import { useSettings } from '../../hooks/useSettings'
import { useFileUpload } from '../../hooks/useFileUpload'
import { extractTextFromFile } from '../../utils/fileParser'
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

const SOURCE_TYPE_MAP: Record<ManualUploadType, string> = {
  document: 'Document',
  text: 'Note',
  url: 'Web',
  transcript: 'Meeting',
  youtube: 'YouTube',
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
  const [fileContent, setFileContent] = useState<string | null>(null)
  const [fileName, setFileName] = useState<string | null>(null)
  const [fileSize, setFileSize] = useState<number | null>(null)
  const [fileError, setFileError] = useState<string | null>(null)
  const [isParsingFile, setIsParsingFile] = useState(false)

  const latestEntitiesRef = useRef<ReviewEntity[] | null>(null)

  // Derive current content for the type
  const getContent = (): string => {
    switch (type) {
      case 'document': return fileContent ?? ''
      case 'text': return textContent
      case 'url': return urlValue.trim()
      case 'transcript': return transcriptContent
      case 'youtube': return youtubeUrl.trim()
    }
  }

  const getSourceTitle = (): string => {
    switch (type) {
      case 'document': return fileName ?? 'Document'
      case 'text': return 'Note'
      case 'url': return urlValue.trim()
      case 'transcript': return transcriptTitle.trim() || 'Transcript'
      case 'youtube': return youtubeUrl.trim()
    }
  }

  const isContentReady = (): boolean => {
    switch (type) {
      case 'document': return fileContent !== null && fileContent.trim().length > 0
      case 'text': return textContent.trim().length > 0
      case 'url': return urlValue.trim().length > 0
      case 'transcript': return transcriptContent.trim().length > 0
      case 'youtube': return YOUTUBE_PATTERN.test(youtubeUrl)
    }
  }

  const handleFilesAdded = useCallback(async (files: File[]) => {
    const file = files[0]
    if (!file) return
    setFileError(null)
    setIsParsingFile(true)
    try {
      const text = await extractTextFromFile(file)
      if (!text.trim()) {
        setFileError('Could not read this file. Supported formats: PDF, DOCX, MD, TXT')
        return
      }
      setFileContent(text)
      setFileName(file.name)
      setFileSize(file.size)
    } catch {
      setFileError('Could not read this file. Supported formats: PDF, DOCX, MD, TXT')
    } finally {
      setIsParsingFile(false)
    }
  }, [])

  const handleExtract = useCallback(async () => {
    const content = getContent()
    if (!content.trim()) return

    const config: ExtractionConfig = {
      mode,
      anchorEmphasis: emphasis,
      anchors: anchors
        .filter(a => selectedAnchorIds.includes(a.id))
        .map(a => ({ label: a.label, entity_type: a.entity_type, description: a.description ?? '' })),
      userProfile: profile,
      customGuidance: customGuidance || undefined,
    }

    await start(content, config, {
      title: getSourceTitle(),
      sourceType: SOURCE_TYPE_MAP[type],
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type, mode, emphasis, anchors, selectedAnchorIds, profile, customGuidance, start,
      fileContent, textContent, urlValue, transcriptContent, transcriptTitle, youtubeUrl])

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
                {fileContent === null ? (
                  <>
                    <FileDropZone
                      onFilesAdded={handleFilesAdded}
                      isDragging={isDragging}
                      dragHandlers={dragHandlers}
                      error={fileError}
                    />
                    {isParsingFile && (
                      <div className="font-body" style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
                        <Loader size={12} style={{ animation: 'spin 1s linear infinite' }} />
                        Reading file…
                      </div>
                    )}
                    {fileError && !isParsingFile && (
                      <p className="font-body" style={{ fontSize: 12, color: '#ef4444', marginTop: 8 }}>
                        {fileError}
                      </p>
                    )}
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
                        {fileName}
                      </div>
                      {fileSize !== null && (
                        <div className="font-body" style={{ fontSize: 11, color: 'var(--color-text-secondary)', marginTop: 2 }}>
                          {formatFileSize(fileSize)}
                        </div>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => { setFileContent(null); setFileName(null); setFileSize(null); setFileError(null) }}
                      className="font-body"
                      style={{ fontSize: 11, color: 'var(--color-text-secondary)', background: 'transparent', border: 'none', cursor: 'pointer', flexShrink: 0 }}
                    >
                      Remove
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* ── Text ── */}
            {type === 'text' && (
              <div style={{ marginBottom: 16 }}>
                <textarea
                  value={textContent}
                  onChange={e => setTextContent(e.target.value)}
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
                <div className="font-body" style={{ fontSize: 11, color: 'var(--color-text-placeholder)', textAlign: 'right', marginTop: 4 }}>
                  {textContent.length.toLocaleString()} chars
                </div>
              </div>
            )}

            {/* ── URL ── */}
            {type === 'url' && (
              <div style={{ marginBottom: 16 }}>
                <input
                  type="url"
                  value={urlValue}
                  onChange={e => setUrlValue(e.target.value)}
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
                  onChange={e => setYoutubeUrl(e.target.value)}
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
            disabled={!isContentReady()}
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
            {isRunning ? (
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

