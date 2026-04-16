import { useState } from 'react'
import { AlertCircle, CheckCircle2, Loader2 } from 'lucide-react'
import { OnboardingStepLayout } from './OnboardingStepLayout'
import { useAuth } from '../../hooks/useAuth'

interface Step4ConnectYouTubeProps {
  onFinish: () => void
  onSkipAll: () => void
}

interface PlaylistPreview {
  name: string
  videoCount: number
  playlistId: string
}

type FetchStatus = 'idle' | 'fetching' | 'done' | 'error'
type ConnectStatus = 'idle' | 'connecting'

export function Step4ConnectYouTube({ onFinish, onSkipAll }: Step4ConnectYouTubeProps) {
  const { user } = useAuth()
  const [url, setUrl] = useState('')
  const [preview, setPreview] = useState<PlaylistPreview | null>(null)
  const [fetchStatus, setFetchStatus] = useState<FetchStatus>('idle')
  const [connectStatus, setConnectStatus] = useState<ConnectStatus>('idle')
  const [errorMessage, setErrorMessage] = useState('')

  const isFetching = fetchStatus === 'fetching'
  const isConnecting = connectStatus === 'connecting'
  const hasPreview = preview !== null

  const extractPlaylistId = (input: string): string | null => {
    const trimmed = input.trim()
    // Accept raw playlist IDs starting with PL
    if (/^PL[a-zA-Z0-9_-]+$/.test(trimmed)) return trimmed
    // Extract from URL
    const match = trimmed.match(/[?&]list=([a-zA-Z0-9_-]+)/)
    return match?.[1] ?? null
  }

  const handleFetch = async () => {
    const playlistId = extractPlaylistId(url)
    if (!playlistId) {
      setErrorMessage('Could not find a playlist ID in that URL. Make sure it contains ?list=...')
      setFetchStatus('error')
      return
    }

    setFetchStatus('fetching')
    setErrorMessage('')

    try {
      const res = await fetch(`/api/youtube/playlist-metadata?playlistId=${playlistId}`)
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string }
        throw new Error((body.error as string) || `Request failed (${res.status})`)
      }
      const data = await res.json() as { name: string; videoCount: number }
      setPreview({ name: data.name, videoCount: data.videoCount, playlistId })
      setFetchStatus('done')
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Failed to fetch playlist info.')
      setFetchStatus('error')
    }
  }

  const handleConnect = async () => {
    if (!preview || !user) return
    setConnectStatus('connecting')

    try {
      const res = await fetch('/api/youtube/connect-playlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: user.id,
          playlistId: preview.playlistId,
          playlistUrl: url,
          name: preview.name,
          videoCount: preview.videoCount,
          maxVideos: 25,
        }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string }
        throw new Error((body.error as string) || `Request failed (${res.status})`)
      }
      onFinish()
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Failed to connect playlist.')
      setConnectStatus('idle')
    }
  }

  const handleClear = () => {
    setPreview(null)
    setFetchStatus('idle')
    setErrorMessage('')
    setUrl('')
  }

  const handleNext = () => {
    if (hasPreview) {
      void handleConnect()
    } else {
      void handleFetch()
    }
  }

  const getNextLabel = () => {
    if (isConnecting) return 'Connecting...'
    if (isFetching) return 'Fetching...'
    if (hasPreview) return 'Start Processing & Finish Setup →'
    return 'Fetch Playlist'
  }

  const getVideoCountMessage = (count: number): React.ReactNode => {
    if (count === 0) {
      return (
        <>
          This playlist is empty. That's fine! Any videos you add will be automatically ingested.
        </>
      )
    }
    if (count > 25) {
      return (
        <>
          The first <strong>25 videos</strong> will be processed. New videos you add will be
          ingested automatically going forward.
        </>
      )
    }
    return (
      <>
        All <strong>{count} videos</strong> will be processed. New videos you add will be
        ingested automatically.
      </>
    )
  }

  return (
    <OnboardingStepLayout
      stepNumber={4}
      totalSteps={4}
      title="Connect a YouTube Playlist"
      subtitle="Paste a YouTube playlist URL and Synapse will extract transcripts, identify entities, and connect concepts across videos."
      maxWidth={550}
      onSkipAll={onSkipAll}
      onSkip={onFinish}
      onNext={handleNext}
      skipLabel="Skip"
      nextLabel={getNextLabel()}
      nextDisabled={isFetching || isConnecting}
    >
      <div className="flex flex-col gap-3 pb-4">
        {/* Public playlist note */}
        <div
          className="rounded-lg font-body"
          style={{
            background: '#fffbf5',
            borderLeft: '3px solid var(--color-accent-500)',
            padding: '10px 14px',
            fontSize: 13,
            color: 'var(--color-text-secondary)',
            lineHeight: '1.5',
          }}
        >
          The playlist must be <strong style={{ color: 'var(--color-text-primary)' }}>public</strong> so
          Synapse can access it.
        </div>

        {/* URL input row */}
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={url}
            onChange={e => setUrl(e.target.value)}
            disabled={hasPreview}
            placeholder="https://www.youtube.com/playlist?list=..."
            className="flex-1 font-body rounded-xl outline-none transition-colors duration-150"
            style={{
              fontSize: 13,
              padding: '8px 14px',
              background: 'var(--color-bg-content)',
              border: '1px solid var(--border-subtle)',
              color: 'var(--color-text-primary)',
              opacity: hasPreview ? 0.5 : 1,
              cursor: hasPreview ? 'not-allowed' : 'text',
            }}
            onKeyDown={e => { if (e.key === 'Enter' && !hasPreview && url.trim()) void handleFetch() }}
          />
          {hasPreview && (
            <button
              onClick={handleClear}
              className="font-body font-semibold rounded-full flex-shrink-0 transition-opacity duration-150 hover:opacity-80"
              style={{
                fontSize: 12,
                padding: '7px 14px',
                background: 'transparent',
                border: '1px solid var(--border-subtle)',
                color: 'var(--color-text-secondary)',
                cursor: 'pointer',
                whiteSpace: 'nowrap',
              }}
            >
              Clear
            </button>
          )}
        </div>

        {/* Fetching state */}
        {isFetching && (
          <div
            className="flex items-center gap-2 font-body rounded-xl"
            style={{
              padding: '12px 14px',
              background: 'var(--color-bg-content)',
              border: '1px solid var(--border-subtle)',
              fontSize: 13,
              color: 'var(--color-text-secondary)',
            }}
          >
            <Loader2 size={15} className="animate-spin flex-shrink-0" />
            Fetching playlist info...
          </div>
        )}

        {/* Error display */}
        {fetchStatus === 'error' && errorMessage && (
          <div
            className="flex items-start gap-2 font-body rounded-xl"
            style={{
              padding: '12px 14px',
              background: 'rgba(220,38,38,0.06)',
              border: '1px solid rgba(220,38,38,0.2)',
              fontSize: 13,
              color: '#b91c1c',
              lineHeight: '1.5',
            }}
          >
            <AlertCircle size={15} className="flex-shrink-0 mt-0.5" />
            {errorMessage}
          </div>
        )}

        {/* Connect error (from connecting phase) */}
        {connectStatus === 'idle' && errorMessage && fetchStatus !== 'error' && (
          <div
            className="flex items-start gap-2 font-body rounded-xl"
            style={{
              padding: '12px 14px',
              background: 'rgba(220,38,38,0.06)',
              border: '1px solid rgba(220,38,38,0.2)',
              fontSize: 13,
              color: '#b91c1c',
              lineHeight: '1.5',
            }}
          >
            <AlertCircle size={15} className="flex-shrink-0 mt-0.5" />
            {errorMessage}
          </div>
        )}

        {/* Playlist preview */}
        {hasPreview && (
          <div
            className="rounded-xl"
            style={{
              background: 'var(--color-bg-content)',
              border: '1px solid var(--border-subtle)',
              padding: '14px 16px',
            }}
          >
            <div className="flex items-center gap-2 mb-1">
              <CheckCircle2 size={15} className="flex-shrink-0" style={{ color: '#16a34a' }} />
              <p
                className="font-body font-semibold"
                style={{ fontSize: 13, color: 'var(--color-text-primary)' }}
              >
                {preview.name}
              </p>
            </div>
            <p
              className="font-body"
              style={{
                fontSize: 12,
                color: 'var(--color-text-secondary)',
                marginBottom: 10,
                paddingLeft: 23,
              }}
            >
              {preview.videoCount === 0
                ? 'No videos'
                : `${preview.videoCount} video${preview.videoCount !== 1 ? 's' : ''}`}
            </p>
            <div
              className="font-body rounded-lg"
              style={{
                padding: '9px 12px',
                background: 'var(--color-accent-50)',
                fontSize: 12,
                color: 'var(--color-text-secondary)',
                lineHeight: '1.5',
              }}
            >
              {getVideoCountMessage(preview.videoCount)}
            </div>
          </div>
        )}

        {/* Processing note */}
        {hasPreview && preview.videoCount > 0 && (
          <p
            className="font-body"
            style={{
              fontSize: 12,
              color: 'var(--color-text-secondary)',
              lineHeight: '1.5',
            }}
          >
            Processing takes about 30-60 seconds per video. This runs in the background - you can
            start using Synapse while it works.
          </p>
        )}
      </div>
    </OnboardingStepLayout>
  )
}
