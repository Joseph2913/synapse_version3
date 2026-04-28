import { useState, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { AlertCircle, Youtube, Sparkles } from 'lucide-react'
import { useAuth } from '../../hooks/useAuth'
import { useSettings } from '../../hooks/useSettings'
import { useExtraction } from '../../hooks/useExtraction'
import { useYouTubePlaylists } from '../../hooks/useYouTubePlaylists'
import { parseVideoUrl, fetchVideoTitle, fetchYouTubeTranscript, hasYouTubeApiKey } from '../../services/youtube'
import { ConnectPlaylistForm } from './ConnectPlaylistForm'
import { QueueStatusBanner } from './QueueStatusBanner'
import { PlaylistCard } from './PlaylistCard'
import { ExtractionProgress } from './ExtractionProgress'
import { ExtractionSummary } from './ExtractionSummary'
import { EntityReview } from '../shared/EntityReview'
import { AdvancedOptions } from './AdvancedOptions'
import type { ExtractionConfig, ReviewEntity } from '../../types/extraction'

export function YouTubeTab() {
  const navigate = useNavigate()
  const { session } = useAuth()
  const { profile, extractionSettings, anchors } = useSettings()
  const { state, start, approveAndSave, reExtract, reset } = useExtraction()

  const {
    playlists,
    isLoading: playlistsLoading,
    error: playlistsError,
    queueStats,
    connectPlaylist,
    disconnectPlaylist,
    toggleStatus,
    refreshVideos,
    queueVideos,
    updateSettings,
  } = useYouTubePlaylists()

  const apiKeyAvailable = hasYouTubeApiKey()

  // ── Manual ingestion state ──────────────────────────────────────────────────
  const [videoUrl, setVideoUrl] = useState('')
  const [videoTitle, setVideoTitle] = useState('')
  const [isFetchingTranscript, setIsFetchingTranscript] = useState(false)
  const [transcriptError, setTranscriptError] = useState<string | null>(null)

  // Advanced extraction options
  const [mode, setMode] = useState<ExtractionConfig['mode']>(
    extractionSettings?.default_mode ?? 'comprehensive'
  )
  const [emphasis, setEmphasis] = useState<ExtractionConfig['anchorEmphasis']>(
    extractionSettings?.default_anchor_emphasis ?? 'standard'
  )
  const [selectedAnchorIds, setSelectedAnchorIds] = useState<string[]>([])
  const [customGuidance, setCustomGuidance] = useState('')

  const latestEntitiesRef = useRef<ReviewEntity[] | null>(null)

  // ── Extraction flow callbacks ───────────────────────────────────────────────
  const handleEntitiesChange = useCallback((entities: ReviewEntity[]) => {
    latestEntitiesRef.current = entities
  }, [])

  const handleSave = useCallback(async () => {
    const entities = latestEntitiesRef.current ?? state.entities
    if (entities) await approveAndSave(entities)
  }, [state.entities, approveAndSave])

  const handleReExtract = useCallback(async () => {
    await reExtract()
  }, [reExtract])

  const handleIngestAnother = useCallback(() => {
    reset()
    latestEntitiesRef.current = null
    setVideoUrl('')
    setVideoTitle('')
    setTranscriptError(null)
  }, [reset])

  // ── Manual video submit ─────────────────────────────────────────────────────
  const handleExtract = useCallback(async () => {
    if (!videoUrl.trim() || isFetchingTranscript) return
    setTranscriptError(null)

    const videoId = parseVideoUrl(videoUrl.trim())
    if (!videoId) {
      setTranscriptError('Invalid YouTube URL. Paste a video link or video ID.')
      return
    }

    const authToken = session?.access_token
    if (!authToken) {
      setTranscriptError('Not authenticated. Please sign in and try again.')
      return
    }

    setIsFetchingTranscript(true)

    try {
      // Auto-fetch title if API key is available and title not set
      let title = videoTitle.trim()
      if (!title) {
        const fetched = await fetchVideoTitle(videoId)
        title = fetched ?? `YouTube: ${videoId}`
        setVideoTitle(title)
      }

      const { transcript } = await fetchYouTubeTranscript(videoUrl.trim(), authToken)

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

      await start(transcript, config, {
        title,
        sourceType: 'youtube',
        sourceUrl: videoUrl.trim(),
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to fetch transcript'
      setTranscriptError(msg)
    } finally {
      setIsFetchingTranscript(false)
    }
  }, [
    videoUrl, videoTitle, isFetchingTranscript, session,
    mode, emphasis, anchors, selectedAnchorIds, profile, customGuidance,
    start,
  ])

  // ── Derived state ───────────────────────────────────────────────────────────
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
  const canSubmit = !!videoUrl.trim() && !isFetchingTranscript

  // ── Complete state ──────────────────────────────────────────────────────────
  if (isComplete) {
    return (
      <ExtractionSummary
        entityCount={state.savedNodes?.length ?? 0}
        relationshipCount={state.savedEdgeIds?.length ?? 0}
        crossConnectionCount={state.crossConnectionCount}
        durationMs={state.elapsedMs}
        duplicatesSkipped={state.duplicatesSkipped}
        onViewInBrowse={() => navigate('/explore')}
        onIngestAnother={handleIngestAnother}
      />
    )
  }

  // ── Extraction in progress / reviewing / error ──────────────────────────────
  if (showProgress) {
    return (
      <div>
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
      </div>
    )
  }

  // ── Idle: manual form + playlist management ─────────────────────────────────
  return (
    <div>
      {/* ── Manual Video Ingestion ─────────────────────────────────────────── */}
      <div
        style={{
          background: 'var(--color-bg-card)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 12,
          padding: '16px 22px',
          marginBottom: 24,
        }}
      >
        <div
          className="font-display font-bold"
          style={{
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: '0.08em',
            textTransform: 'uppercase' as const,
            color: 'var(--color-text-secondary)',
            marginBottom: 10,
          }}
        >
          Add Single Video
        </div>

        {/* URL input */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
          <div
            className="flex items-center"
            style={{
              flex: 1,
              gap: 8,
              padding: '10px 14px',
              borderRadius: 8,
              background: 'var(--color-bg-inset)',
              border: `1px solid ${transcriptError ? 'var(--color-semantic-red-300)' : 'var(--border-subtle)'}`,
            }}
          >
            <Youtube size={14} style={{ color: 'var(--color-text-secondary)', flexShrink: 0 }} />
            <input
              type="text"
              value={videoUrl}
              onChange={e => {
                setVideoUrl(e.target.value)
                setTranscriptError(null)
              }}
              onKeyDown={e => { if (e.key === 'Enter') void handleExtract() }}
              placeholder="Paste YouTube URL or video ID..."
              className="font-body w-full"
              style={{
                fontSize: 13,
                background: 'transparent',
                border: 'none',
                outline: 'none',
                color: 'var(--color-text-primary)',
              }}
            />
          </div>
        </div>

        {/* Optional title override */}
        <div style={{ marginBottom: 12 }}>
          <input
            type="text"
            value={videoTitle}
            onChange={e => setVideoTitle(e.target.value)}
            placeholder={apiKeyAvailable ? 'Video title (auto-fetched if blank)' : 'Video title (optional)'}
            className="font-body w-full"
            style={{
              fontSize: 12,
              padding: '9px 14px',
              borderRadius: 8,
              background: 'var(--color-bg-inset)',
              border: '1px solid var(--border-subtle)',
              color: 'var(--color-text-primary)',
              outline: 'none',
            }}
          />
        </div>

        {/* Error */}
        {transcriptError && (
          <div
            className="flex items-center gap-2"
            style={{
              padding: '8px 12px',
              borderRadius: 8,
              background: 'var(--color-semantic-red-50)',
              border: '1px solid var(--color-semantic-red-100)',
              marginBottom: 12,
            }}
          >
            <AlertCircle size={13} style={{ color: 'var(--color-semantic-red-500)', flexShrink: 0 }} />
            <span className="font-body" style={{ fontSize: 12, color: 'var(--color-semantic-red-700)' }}>
              {transcriptError}
            </span>
          </div>
        )}

        {/* Extract button */}
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button
            type="button"
            onClick={() => void handleExtract()}
            disabled={!canSubmit}
            className="font-body font-semibold flex items-center gap-2"
            style={{
              fontSize: 13,
              padding: '10px 20px',
              borderRadius: 8,
              background: 'var(--color-accent-500)',
              border: 'none',
              color: 'white',
              opacity: canSubmit ? 1 : 0.4,
              cursor: canSubmit ? 'pointer' : 'not-allowed',
              boxShadow: canSubmit ? '0 2px 8px rgba(214,58,0,0.2)' : 'none',
              transition: 'opacity 0.15s ease',
            }}
          >
            {isFetchingTranscript ? (
              <>
                <span style={{ fontFamily: 'monospace' }}>⠙</span>
                Fetching transcript...
              </>
            ) : (
              <>
                <Sparkles size={13} />
                Extract Video
              </>
            )}
          </button>
        </div>
      </div>

      {/* Advanced options for manual ingestion */}
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

      {/* ── Playlist Management ────────────────────────────────────────────── */}
      <div style={{ marginTop: 28 }}>
        <div
          className="font-display font-bold"
          style={{
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: '0.08em',
            textTransform: 'uppercase' as const,
            color: 'var(--color-text-secondary)',
            marginBottom: 12,
          }}
        >
          Automated Playlists
        </div>

        {/* No API key banner */}
        {!apiKeyAvailable && (
          <div
            className="flex items-center gap-2"
            style={{
              padding: '10px 16px',
              borderRadius: 8,
              background: 'var(--color-semantic-amber-50)',
              border: '1px solid var(--color-semantic-amber-100)',
              marginBottom: 16,
            }}
          >
            <AlertCircle size={14} style={{ color: 'var(--color-semantic-amber-500)', flexShrink: 0 }} />
            <span className="font-body" style={{ fontSize: 11, color: 'var(--color-text-body)' }}>
              YouTube API key not configured — playlist names and video lists require API access. Add your key in Settings.
            </span>
          </div>
        )}

        <ConnectPlaylistForm
          onConnect={connectPlaylist}
          disabled={!apiKeyAvailable}
        />

        {playlistsError && (
          <p className="font-body" style={{ fontSize: 11, color: 'var(--color-semantic-red-500)', marginBottom: 12 }}>
            {playlistsError}
          </p>
        )}

        <QueueStatusBanner stats={queueStats} />

        {playlistsLoading && (
          <div style={{ textAlign: 'center', padding: '32px 0' }}>
            <p className="font-body" style={{ fontSize: 13, color: 'var(--color-text-secondary)' }}>
              Loading playlists...
            </p>
          </div>
        )}

        {!playlistsLoading && playlists.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {playlists.map(playlist => (
              <PlaylistCard
                key={playlist.id}
                playlist={playlist}
                onDisconnect={disconnectPlaylist}
                onRefreshVideos={refreshVideos}
                onQueueVideos={queueVideos}
                onUpdateSettings={updateSettings}
                onToggleStatus={toggleStatus}
              />
            ))}
          </div>
        )}

        {!playlistsLoading && playlists.length === 0 && (
          <div style={{ textAlign: 'center', padding: '32px 0' }}>
            <div style={{ fontSize: 40, marginBottom: 12, color: 'var(--color-text-placeholder)' }}>▶</div>
            <p
              className="font-display font-bold"
              style={{ fontSize: 15, color: 'var(--color-text-primary)', marginBottom: 4 }}
            >
              No playlists connected
            </p>
            <p
              className="font-body"
              style={{ fontSize: 12, color: 'var(--color-text-secondary)', lineHeight: 1.5 }}
            >
              Connect a playlist above for automatic background ingestion.
            </p>
          </div>
        )}
      </div>

    </div>
  )
}
