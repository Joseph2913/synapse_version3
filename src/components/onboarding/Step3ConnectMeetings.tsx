import { useState } from 'react'
import { CheckCircle2 } from 'lucide-react'
import { OnboardingStepLayout } from './OnboardingStepLayout'
import { connectMicrosoft } from '../../services/microsoft'

interface Step3ConnectMeetingsProps {
  onNext: () => void
  onSkipAll: () => void
}

interface IntegrationState {
  microsoft: 'idle' | 'connecting' | 'connected' | 'error'
  circleback: 'idle' | 'connected'
}

export function Step3ConnectMeetings({ onNext, onSkipAll }: Step3ConnectMeetingsProps) {
  const [state, setState] = useState<IntegrationState>({
    microsoft: 'idle',
    circleback: 'idle',
  })

  const handleConnectMicrosoft = async () => {
    setState(prev => ({ ...prev, microsoft: 'connecting' }))
    try {
      const authUrl = await connectMicrosoft()
      window.location.href = authUrl
    } catch {
      setState(prev => ({ ...prev, microsoft: 'error' }))
    }
  }

  const handleConnectCircleback = () => {
    // Webhook setup is manual — no-op for now
  }

  return (
    <OnboardingStepLayout
      stepNumber={3}
      totalSteps={4}
      title="Connect Meeting Services"
      subtitle="Connect your meeting tools and Synapse will automatically ingest transcripts, extract entities, and add them to your knowledge graph."
      maxWidth={550}
      onSkipAll={onSkipAll}
      onSkip={onNext}
      onNext={onNext}
      skipLabel="Skip"
      nextLabel="Continue"
    >
      <div className="flex flex-col gap-3 pb-4">
        {/* Microsoft 365 */}
        <div
          className="flex items-center gap-4 rounded-xl"
          style={{
            padding: '14px 16px',
            background: '#ffffff',
            border: `1px solid ${state.microsoft === 'connected' ? 'rgba(34,197,94,0.3)' : 'var(--border-subtle)'}`,
          }}
        >
          <div
            className="flex items-center justify-center rounded-lg flex-shrink-0"
            style={{
              width: 40,
              height: 40,
              background: '#e3f2fd',
              fontSize: 20,
            }}
          >
            📅
          </div>
          <div className="flex-1 min-w-0">
            <p
              className="font-body font-semibold"
              style={{ fontSize: 14, color: 'var(--color-text-primary)' }}
            >
              Microsoft 365
            </p>
            <p
              className="font-body"
              style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}
            >
              Calendar events and Teams meeting transcripts
            </p>
          </div>
          <ConnectButton
            status={state.microsoft}
            onConnect={handleConnectMicrosoft}
          />
        </div>

        {/* Circleback */}
        <div
          className="flex items-center gap-4 rounded-xl"
          style={{
            padding: '14px 16px',
            background: '#ffffff',
            border: `1px solid ${state.circleback === 'connected' ? 'rgba(34,197,94,0.3)' : 'var(--border-subtle)'}`,
          }}
        >
          <div
            className="flex items-center justify-center rounded-lg flex-shrink-0"
            style={{
              width: 40,
              height: 40,
              background: '#f3e8ff',
              fontSize: 20,
            }}
          >
            🎙
          </div>
          <div className="flex-1 min-w-0">
            <p
              className="font-body font-semibold"
              style={{ fontSize: 14, color: 'var(--color-text-primary)' }}
            >
              Circleback
            </p>
            <p
              className="font-body"
              style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}
            >
              Meeting transcripts via webhook
            </p>
          </div>
          <CirclebackButton
            status={state.circleback}
            onConnect={handleConnectCircleback}
          />
        </div>
      </div>
    </OnboardingStepLayout>
  )
}

// ─── Sub-components ───────────────────────────────────────────────────────────

interface ConnectButtonProps {
  status: 'idle' | 'connecting' | 'connected' | 'error'
  onConnect: () => void
}

function ConnectButton({ status, onConnect }: ConnectButtonProps) {
  if (status === 'connected') {
    return (
      <div
        className="flex items-center gap-1.5 rounded-full font-body font-semibold flex-shrink-0"
        style={{
          padding: '5px 13px',
          fontSize: 12,
          background: '#e8f5e9',
          color: '#2e7d32',
          border: '1px solid rgba(46,125,50,0.2)',
        }}
      >
        <CheckCircle2 size={13} />
        Connected
      </div>
    )
  }

  if (status === 'connecting') {
    return (
      <button
        disabled
        className="rounded-full font-body font-semibold flex-shrink-0"
        style={{
          padding: '5px 13px',
          fontSize: 12,
          background: 'var(--color-accent-500)',
          color: '#ffffff',
          border: 'none',
          opacity: 0.6,
          cursor: 'not-allowed',
        }}
      >
        Connecting...
      </button>
    )
  }

  return (
    <button
      onClick={onConnect}
      className="rounded-full font-body font-semibold flex-shrink-0 transition-opacity duration-150 hover:opacity-80"
      style={{
        padding: '5px 13px',
        fontSize: 12,
        background: 'var(--color-accent-500)',
        color: '#ffffff',
        border: 'none',
        cursor: 'pointer',
      }}
    >
      Connect
    </button>
  )
}

interface CirclebackButtonProps {
  status: 'idle' | 'connected'
  onConnect: () => void
}

function CirclebackButton({ status, onConnect }: CirclebackButtonProps) {
  if (status === 'connected') {
    return (
      <div
        className="flex items-center gap-1.5 rounded-full font-body font-semibold flex-shrink-0"
        style={{
          padding: '5px 13px',
          fontSize: 12,
          background: '#e8f5e9',
          color: '#2e7d32',
          border: '1px solid rgba(46,125,50,0.2)',
        }}
      >
        <CheckCircle2 size={13} />
        Connected
      </div>
    )
  }

  return (
    <button
      onClick={onConnect}
      className="rounded-full font-body font-semibold flex-shrink-0 transition-opacity duration-150 hover:opacity-80"
      style={{
        padding: '5px 13px',
        fontSize: 12,
        background: 'var(--color-accent-500)',
        color: '#ffffff',
        border: 'none',
        cursor: 'pointer',
      }}
    >
      Connect
    </button>
  )
}
