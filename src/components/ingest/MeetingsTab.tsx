import { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { useExtraction } from '../../hooks/useExtraction'
import { supabase } from '../../services/supabase'
import { MeetingTranscriptForm } from './MeetingTranscriptForm'
import { IntegrationCard } from './IntegrationCard'
import { IntegrationSetupModal } from './IntegrationSetupModal'
import { ExtractionProgress } from './ExtractionProgress'
import { ExtractionSummary } from './ExtractionSummary'
import { EntityReview } from '../shared/EntityReview'
import type { ExtractionConfig, ReviewEntity } from '../../types/extraction'
import type { IntegrationConfig, MeetingSource } from '../../types/ingest'

const BASE_INTEGRATIONS: Omit<IntegrationConfig, 'status'>[] = [
  {
    id: 'circleback',
    name: 'Circleback',
    icon: '/logos/circleback.jpeg',
    description: 'Auto-capture meeting transcripts',
    comingSoon: false,
    setupInstructions: [
      'Open Circleback and go to Automations.',
      'Click "Create Automation" and set your meeting conditions.',
      'Select "Send webhook request" as the action.',
      'Paste your Synapse webhook URL (found in Automate → Connect Source → Circleback).',
      'Save the automation. Meeting transcripts will auto-import after each meeting.',
    ],
  },
  {
    id: 'fireflies',
    name: 'Fireflies',
    icon: '/logos/fireflies.jpeg',
    description: 'AI meeting notes and transcripts',
    comingSoon: true,
    setupInstructions: [],
  },
  {
    id: 'tldv',
    name: 'tl;dv',
    icon: '/logos/tldv.svg',
    description: 'Record and transcribe meetings',
    comingSoon: true,
    setupInstructions: [],
  },
  {
    id: 'meetgeek',
    name: 'MeetGeek',
    icon: '/logos/meetgeek.jpeg',
    description: 'Meeting productivity assistant',
    comingSoon: true,
    setupInstructions: [],
  },
]

export function MeetingsTab() {
  const navigate = useNavigate()
  const { state, start, approveAndSave, reExtract, reset } = useExtraction()
  const [setupModal, setSetupModal] = useState<IntegrationConfig | null>(null)
  const latestEntitiesRef = useRef<ReviewEntity[] | null>(null)

  // Detect Circleback connection status from DB
  const [circlebackConnected, setCirclebackConnected] = useState(false)

  useEffect(() => {
    supabase
      .from('knowledge_sources')
      .select('id', { count: 'exact', head: true })
      .eq('source_type', 'meeting')
      .then(({ count }) => {
        setCirclebackConnected((count ?? 0) > 0)
      })
  }, [])

  // Build integrations with dynamic status
  const integrations: IntegrationConfig[] = useMemo(
    () =>
      BASE_INTEGRATIONS.map(config => ({
        ...config,
        status: config.id === 'circleback' && circlebackConnected
          ? 'connected' as const
          : 'not_connected' as const,
      })),
    [circlebackConnected]
  )

  const handleExtract = useCallback(
    async (meeting: MeetingSource, config: ExtractionConfig) => {
      await start(meeting.transcript, config, {
        title: meeting.title,
        sourceType: 'meeting',
      })
    },
    [start]
  )

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
    latestEntitiesRef.current = null
  }, [reset])

  const isIdle = state.step === 'idle'
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
      {/* Idle: show form + integrations */}
      {isIdle && (
        <>
          <MeetingTranscriptForm onExtract={handleExtract} />

          {/* Integrations section */}
          <div style={{ marginTop: 24 }}>
            <div
              className="font-display font-bold"
              style={{
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: '0.08em',
                textTransform: 'uppercase' as const,
                color: 'var(--color-text-secondary)',
                marginBottom: 4,
              }}
            >
              Integrations
            </div>
            <p
              className="font-body"
              style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginBottom: 12 }}
            >
              Connect meeting transcript services for automatic ingestion.
            </p>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              {integrations.map(config => (
                <IntegrationCard
                  key={config.id}
                  config={config}
                  onConnect={() => setSetupModal(config)}
                />
              ))}
            </div>
          </div>
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

      {/* Integration Setup Modal */}
      <IntegrationSetupModal
        integration={setupModal}
        onClose={() => setSetupModal(null)}
      />
    </div>
  )
}
