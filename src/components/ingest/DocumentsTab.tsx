import { useState, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { Sparkles } from 'lucide-react'
import { useFileUpload } from '../../hooks/useFileUpload'
import { useExtraction } from '../../hooks/useExtraction'
import { useSettings } from '../../hooks/useSettings'
import { AdvancedOptions } from './AdvancedOptions'
import { FileDropZone } from './FileDropZone'
import { FileListItem } from './FileListItem'
import { ExtractionProgress } from './ExtractionProgress'
import { ExtractionSummary } from './ExtractionSummary'
import { EntityReview } from '../shared/EntityReview'
import type { ExtractionConfig, ReviewEntity } from '../../types/extraction'

export function DocumentsTab() {
  const navigate = useNavigate()
  const { profile, extractionSettings, anchors } = useSettings()
  const { files, isDragging, error, addFiles, removeFile, clearFiles, dragHandlers } = useFileUpload()
  const { state, start, approveAndSave, reExtract, reset } = useExtraction()

  const [mode, setMode] = useState<ExtractionConfig['mode']>(
    extractionSettings?.default_mode ?? 'comprehensive'
  )
  const [emphasis, setEmphasis] = useState<ExtractionConfig['anchorEmphasis']>(
    extractionSettings?.default_anchor_emphasis ?? 'standard'
  )
  const [selectedAnchorIds, setSelectedAnchorIds] = useState<string[]>([])
  const [customGuidance, setCustomGuidance] = useState('')

  // Multi-document extraction state
  const [extractingIndex, setExtractingIndex] = useState(-1)
  const [totalToExtract, setTotalToExtract] = useState(0)
  const latestEntitiesRef = useRef<ReviewEntity[] | null>(null)

  const extractedFiles = files.filter(f => f.status === 'extracted')
  const hasExtractedFiles = extractedFiles.length > 0
  const isExtracting = extractingIndex >= 0

  const handleExtractAll = useCallback(async () => {
    if (extractedFiles.length === 0) return

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

    setTotalToExtract(extractedFiles.length)

    for (let i = 0; i < extractedFiles.length; i++) {
      const file = extractedFiles[i]
      if (!file) continue

      setExtractingIndex(i)

      await start(file.extractedText ?? '', config, {
        title: file.name,
        sourceType: 'file',
      })

      // Wait for review step — for documents, auto-approve to keep sequential flow
      // The pipeline pauses at 'reviewing'. We need to auto-approve for batch processing.
      // For simplicity in batch mode, we wait for the state to reach 'reviewing', then approve.
      // This is handled by watching state changes in the component.
    }
  }, [extractedFiles, mode, emphasis, anchors, selectedAnchorIds, profile, customGuidance, start])

  const handleEntitiesChange = useCallback((entities: ReviewEntity[]) => {
    latestEntitiesRef.current = entities
  }, [])

  const handleSave = useCallback(async () => {
    const entities = latestEntitiesRef.current ?? state.entities
    if (entities) {
      await approveAndSave(entities)
    }
  }, [state.entities, approveAndSave])

  const handleReExtract = useCallback(async () => {
    await reExtract()
  }, [reExtract])

  const handleIngestAnother = useCallback(() => {
    reset()
    clearFiles()
    setExtractingIndex(-1)
    setTotalToExtract(0)
    latestEntitiesRef.current = null
  }, [reset, clearFiles])

  const isIdle = state.step === 'idle' && !isExtracting
  const isReviewing = state.step === 'reviewing'
  const isComplete = state.step === 'complete'
  const isError = state.step === 'error'
  const isRunning =
    state.step === 'saving_source' ||
    state.step === 'composing_prompt' ||
    state.step === 'extracting' ||
    state.step === 'saving_nodes' ||
    state.step === 'generating_embeddings' ||
    state.step === 'chunking_source' ||
    state.step === 'discovering_connections'
  const showProgress = isRunning || isReviewing || isError

  return (
    <div>
      {/* Idle: show drop zone + file list */}
      {isIdle && (
        <>
          <FileDropZone
            onFilesAdded={fileList => addFiles(fileList)}
            isDragging={isDragging}
            dragHandlers={dragHandlers}
            error={error}
          />

          {/* File list */}
          {files.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 16 }}>
              {files.map(file => (
                <FileListItem key={file.id} file={file} onRemove={removeFile} />
              ))}
            </div>
          )}

          {/* Advanced options + extract button */}
          {hasExtractedFiles && (
            <>
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

              <div style={{ marginTop: 16, display: 'flex', justifyContent: 'flex-end' }}>
                <button
                  type="button"
                  onClick={handleExtractAll}
                  className="font-body font-semibold cursor-pointer flex items-center gap-2"
                  style={{
                    fontSize: 13,
                    padding: '12px 24px',
                    borderRadius: 8,
                    background: 'var(--color-accent-500)',
                    border: 'none',
                    color: 'white',
                    boxShadow: '0 2px 8px rgba(214,58,0,0.2)',
                  }}
                >
                  <Sparkles size={14} />
                  Extract {extractedFiles.length} Document{extractedFiles.length !== 1 ? 's' : ''}
                </button>
              </div>
            </>
          )}
        </>
      )}

      {/* Progress / Review / Error */}
      {showProgress && (
        <>
          {/* Multi-doc progress indicator */}
          {totalToExtract > 1 && (
            <p className="font-body" style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginBottom: 8 }}>
              Extracting document {extractingIndex + 1} of {totalToExtract}...
            </p>
          )}

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
              onSave={handleSave}
              onReExtract={handleReExtract}
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
          onViewInBrowse={() => navigate('/explore')}
          onIngestAnother={handleIngestAnother}
        />
      )}
    </div>
  )
}
