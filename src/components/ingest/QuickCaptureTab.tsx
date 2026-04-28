import { useState, useRef, useCallback, useEffect } from 'react'
import { Paperclip, Link, Sparkles, Loader, X } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../../hooks/useAuth'
import { useSettings } from '../../hooks/useSettings'
import { useExtraction } from '../../hooks/useExtraction'
import { extractTextFromFile } from '../../utils/fileParser'
import { AdvancedOptions } from './AdvancedOptions'
import { ExtractionProgress } from './ExtractionProgress'
import { ExtractionSummary } from './ExtractionSummary'
import { EntityReview } from '../shared/EntityReview'
import type { ExtractionConfig, ReviewEntity } from '../../types/extraction'

const ACCEPTED_FILE_TYPES = '.pdf,.docx,.md,.txt,.csv'

export function QuickCaptureTab() {
  const navigate = useNavigate()
  const { session } = useAuth()
  const { profile, extractionSettings, anchors } = useSettings()
  const { state, start, approveAndSave, reExtract, reset } = useExtraction()

  // Local form state
  const [content, setContent] = useState('')
  const [mode, setMode] = useState<ExtractionConfig['mode']>(
    extractionSettings?.default_mode ?? 'comprehensive'
  )
  const [emphasis, setEmphasis] = useState<ExtractionConfig['anchorEmphasis']>(
    extractionSettings?.default_anchor_emphasis ?? 'standard'
  )
  const [selectedAnchorIds, setSelectedAnchorIds] = useState<string[]>([])
  const [customGuidance, setCustomGuidance] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // File attach state
  const [isParsingFile, setIsParsingFile] = useState(false)
  const [fileError, setFileError] = useState<string | null>(null)

  // URL fetch state
  const [showUrlInput, setShowUrlInput] = useState(false)
  const [urlValue, setUrlValue] = useState('')
  const [isFetchingUrl, setIsFetchingUrl] = useState(false)
  const [urlError, setUrlError] = useState<string | null>(null)

  // Sync with extraction settings when they load
  useEffect(() => {
    if (extractionSettings) {
      setMode(extractionSettings.default_mode ?? 'comprehensive')
      setEmphasis(extractionSettings.default_anchor_emphasis ?? 'standard')
    }
  }, [extractionSettings])

  // Auto-resize textarea
  const handleTextareaChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setContent(e.target.value)
    const el = e.target
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 400) + 'px'
  }, [])

  // Resize textarea to fit content programmatically
  const autoResizeTextarea = useCallback(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 400) + 'px'
  }, [])

  // ── File attach handler ───────────────────────────────────────────────────
  const handleFileAttach = useCallback(() => {
    fileInputRef.current?.click()
  }, [])

  const handleFileSelected = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    // Reset input so same file can be selected again
    e.target.value = ''

    setFileError(null)
    setIsParsingFile(true)

    try {
      const text = await extractTextFromFile(file)
      if (!text.trim()) {
        setFileError('No extractable text found in the file.')
        return
      }
      // Append to existing content with a separator, or set if empty
      setContent(prev => {
        if (prev.trim()) return prev + '\n\n---\n\n' + text
        return text
      })
      // Auto-resize after content update
      setTimeout(autoResizeTextarea, 0)
    } catch (err) {
      setFileError(err instanceof Error ? err.message : 'Failed to extract text from file')
    } finally {
      setIsParsingFile(false)
    }
  }, [autoResizeTextarea])

  // ── URL fetch handler ─────────────────────────────────────────────────────
  const handleFetchUrl = useCallback(async () => {
    const url = urlValue.trim()
    if (!url) return

    // Basic URL validation
    try {
      new URL(url.startsWith('http') ? url : `https://${url}`)
    } catch {
      setUrlError('Please enter a valid URL.')
      return
    }

    const authToken = session?.access_token
    if (!authToken) {
      setUrlError('Not authenticated. Please sign in and try again.')
      return
    }

    setUrlError(null)
    setIsFetchingUrl(true)

    try {
      const fullUrl = url.startsWith('http') ? url : `https://${url}`
      const res = await fetch('/api/content/fetch', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({ url: fullUrl }),
      })

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Failed to fetch URL' })) as { error?: string }
        throw new Error(err.error ?? `Fetch failed: ${res.status}`)
      }

      const data = await res.json() as { title?: string; content: string; url: string }

      if (!data.content?.trim()) {
        setUrlError('No readable content found at this URL.')
        return
      }

      // Prepend title if available
      const fetched = data.title
        ? `# ${data.title}\nSource: ${data.url}\n\n${data.content}`
        : `Source: ${data.url}\n\n${data.content}`

      setContent(prev => {
        if (prev.trim()) return prev + '\n\n---\n\n' + fetched
        return fetched
      })
      setShowUrlInput(false)
      setUrlValue('')
      setTimeout(autoResizeTextarea, 0)
    } catch (err) {
      setUrlError(err instanceof Error ? err.message : 'Failed to fetch URL content')
    } finally {
      setIsFetchingUrl(false)
    }
  }, [urlValue, session, autoResizeTextarea])

  // Start extraction
  const handleExtract = useCallback(async () => {
    if (!content.trim()) return

    const config: ExtractionConfig = {
      mode,
      anchorEmphasis: emphasis,
      anchors: anchors
        .filter(a => selectedAnchorIds.includes(a.id))
        .map(a => ({
          label: a.label,
          entity_type: a.entity_type,
          description: a.description ?? '',
        })),
      userProfile: profile,
      customGuidance: customGuidance || undefined,
    }

    await start(content, config, { sourceType: 'paste' })
  }, [content, mode, emphasis, anchors, selectedAnchorIds, profile, customGuidance, start])

  // Update entities during review
  const handleEntitiesChange = useCallback((entities: ReviewEntity[]) => {
    latestEntitiesRef.current = entities
  }, [])

  const latestEntitiesRef = useRef<ReviewEntity[] | null>(null)

  // Wrap handleSave to use latest entities
  const handleSaveLatest = useCallback(async () => {
    const entities = latestEntitiesRef.current ?? state.entities
    if (entities) {
      await approveAndSave(entities)
    }
  }, [state.entities, approveAndSave])

  // Handle re-extract
  const handleReExtract = useCallback(async () => {
    await reExtract()
  }, [reExtract])

  // Handle ingest another
  const handleIngestAnother = useCallback(() => {
    reset()
    setContent('')
    setCustomGuidance('')
    setSelectedAnchorIds([])
    setShowUrlInput(false)
    setUrlValue('')
    setFileError(null)
    setUrlError(null)
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }
  }, [reset])

  const isIdle = state.step === 'idle'
  const isReviewing = state.step === 'reviewing'
  const isComplete = state.step === 'complete'
  const isRunning =
    state.step === 'saving_source' ||
    state.step === 'composing_prompt' ||
    state.step === 'extracting' ||
    state.step === 'saving_nodes' ||
    state.step === 'generating_embeddings' ||
    state.step === 'chunking_source' ||
    state.step === 'discovering_connections'
  const isError = state.step === 'error'
  const showProgress = isRunning || isReviewing || isError

  const isEmpty = !content.trim()

  return (
    <div>
      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        accept={ACCEPTED_FILE_TYPES}
        onChange={handleFileSelected}
        style={{ display: 'none' }}
      />

      {/* Idle State: Textarea + Extract Button */}
      {isIdle && (
        <>
          {/* URL Input Bar */}
          {showUrlInput && (
            <div
              style={{
                background: 'var(--color-bg-card)',
                border: '1px solid var(--border-subtle)',
                borderRadius: 10,
                padding: '10px 14px',
                marginBottom: 8,
                display: 'flex',
                alignItems: 'center',
                gap: 8,
              }}
            >
              <Link size={14} style={{ color: 'var(--color-text-secondary)', flexShrink: 0 }} />
              <input
                type="text"
                value={urlValue}
                onChange={e => { setUrlValue(e.target.value); setUrlError(null) }}
                onKeyDown={e => { if (e.key === 'Enter') void handleFetchUrl() }}
                placeholder="Paste a URL to fetch content..."
                autoFocus
                className="font-body w-full"
                style={{
                  fontSize: 13,
                  background: 'transparent',
                  border: 'none',
                  outline: 'none',
                  color: 'var(--color-text-primary)',
                }}
              />
              {isFetchingUrl ? (
                <Loader size={14} style={{ color: 'var(--color-accent-500)', animation: 'spin 1s linear infinite', flexShrink: 0 }} />
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => void handleFetchUrl()}
                    disabled={!urlValue.trim()}
                    className="font-body font-semibold cursor-pointer"
                    style={{
                      fontSize: 11,
                      padding: '4px 12px',
                      borderRadius: 6,
                      background: 'var(--color-accent-500)',
                      border: 'none',
                      color: 'white',
                      flexShrink: 0,
                      opacity: urlValue.trim() ? 1 : 0.4,
                    }}
                  >
                    Fetch
                  </button>
                  <button
                    type="button"
                    onClick={() => { setShowUrlInput(false); setUrlValue(''); setUrlError(null) }}
                    className="cursor-pointer"
                    style={{
                      background: 'transparent',
                      border: 'none',
                      padding: 2,
                      color: 'var(--color-text-secondary)',
                      flexShrink: 0,
                    }}
                  >
                    <X size={14} />
                  </button>
                </>
              )}
            </div>
          )}

          {/* URL fetch error */}
          {urlError && (
            <p className="font-body" style={{ fontSize: 11, color: 'var(--color-semantic-red-500)', marginBottom: 6, paddingLeft: 2 }}>
              {urlError}
            </p>
          )}

          {/* Textarea Card */}
          <div
            style={{
              background: 'var(--color-bg-card)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 12,
              padding: '20px 22px',
              transition: 'border-color 0.15s ease',
            }}
          >
            <textarea
              ref={textareaRef}
              value={content}
              onChange={handleTextareaChange}
              placeholder="Paste a URL, write a note, or drop content here..."
              className="font-body w-full resize-none"
              style={{
                fontSize: 14,
                fontWeight: 400,
                lineHeight: 1.6,
                color: 'var(--color-text-primary)',
                background: 'var(--color-bg-card)',
                border: 'none',
                outline: 'none',
                minHeight: 120,
                maxHeight: 400,
              }}
            />

            {/* File parse error */}
            {fileError && (
              <p className="font-body" style={{ fontSize: 11, color: 'var(--color-semantic-red-500)', marginBottom: 8 }}>
                {fileError}
              </p>
            )}

            {/* Action Bar */}
            <div
              style={{
                borderTop: '1px solid var(--border-subtle)',
                paddingTop: 12,
                marginTop: 12,
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}
            >
              <div style={{ display: 'flex', gap: 4 }}>
                <button
                  type="button"
                  className="cursor-pointer"
                  onClick={handleFileAttach}
                  disabled={isParsingFile}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    padding: 6,
                    borderRadius: 6,
                    color: 'var(--color-text-secondary)',
                  }}
                  title="Attach a file (PDF, DOCX, MD, TXT, CSV)"
                >
                  {isParsingFile ? (
                    <Loader size={16} style={{ animation: 'spin 1s linear infinite' }} />
                  ) : (
                    <Paperclip size={16} />
                  )}
                </button>
                <button
                  type="button"
                  className="cursor-pointer"
                  onClick={() => setShowUrlInput(prev => !prev)}
                  disabled={isFetchingUrl}
                  style={{
                    background: showUrlInput ? 'var(--color-bg-inset)' : 'transparent',
                    border: 'none',
                    padding: 6,
                    borderRadius: 6,
                    color: showUrlInput ? 'var(--color-accent-500)' : 'var(--color-text-secondary)',
                  }}
                  title="Fetch content from a URL"
                >
                  <Link size={16} />
                </button>
              </div>

              <button
                type="button"
                onClick={handleExtract}
                disabled={isEmpty}
                className="font-body font-semibold cursor-pointer flex items-center gap-2"
                style={{
                  fontSize: 13,
                  padding: '12px 24px',
                  borderRadius: 8,
                  background: 'var(--color-accent-500)',
                  border: 'none',
                  color: 'white',
                  opacity: isEmpty ? 0.4 : 1,
                  cursor: isEmpty ? 'not-allowed' : 'pointer',
                  boxShadow: isEmpty ? 'none' : '0 2px 8px rgba(214,58,0,0.2)',
                  transition: 'opacity 0.15s ease, box-shadow 0.15s ease',
                }}
              >
                <Sparkles size={14} />
                Extract Knowledge
              </button>
            </div>
          </div>

          {/* Short content warning */}
          {!isEmpty && content.trim().length < 100 && (
            <p
              className="font-body"
              style={{
                fontSize: 11,
                color: 'var(--color-text-secondary)',
                marginTop: 6,
                paddingLeft: 2,
              }}
            >
              Short content may produce fewer entities.
            </p>
          )}

          {/* Advanced Options */}
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
            onRetry={isError ? handleReExtract : undefined}
            onCancel={isError ? handleIngestAnother : undefined}
          />

          {isReviewing && state.entities && state.relationships && (
            <EntityReview
              entities={latestEntitiesRef.current ?? state.entities}
              relationships={state.relationships}
              onEntitiesChange={handleEntitiesChange}
              onSave={handleSaveLatest}
              onReExtract={handleReExtract}
              saving={false}
            />
          )}
        </>
      )}

      {/* Extraction Summary */}
      {isComplete && (
        <ExtractionSummary
          entityCount={state.savedNodes?.length ?? 0}
          relationshipCount={(state.savedEdgeIds?.length ?? 0)}
          crossConnectionCount={state.crossConnectionCount}
          durationMs={state.elapsedMs}
          duplicatesSkipped={state.duplicatesSkipped}
          onViewInBrowse={() => navigate('/explore')}
          onIngestAnother={handleIngestAnother}
        />
      )}
    </div>
  )
}
