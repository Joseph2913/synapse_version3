import { CouncilRoutingCard } from './CouncilRoutingCard'
import { CouncilAgentCard } from './CouncilAgentCard'
import { CouncilSynthesisCard } from './CouncilSynthesisCard'
import type { CouncilQueryState } from '../../types/rag'

interface CouncilResponseProps {
  state: CouncilQueryState
  onFollowUpClick?: (question: string) => void
  onAgentClick?: (agentId: string) => void
  onToggleAgent: (agentId: string) => void
  onApprove: () => void
  onSkip: () => void
}

export function CouncilResponse({
  state,
  onFollowUpClick,
  onAgentClick,
  onToggleAgent,
  onApprove,
  onSkip,
}: CouncilResponseProps) {
  const hasRouting = !!state.routing
  const hasAgents = state.agentPerspectives.length > 0
  const hasSynthesis = !!state.synthesis

  // Routing in progress
  if (state.status === 'routing') {
    return (
      <div style={{ maxWidth: 1020, margin: '0 auto', padding: '24px', width: '100%' }}>
        <div
          className="flex items-center font-body"
          style={{
            gap: 8, fontSize: 12, color: 'var(--color-text-secondary)',
            padding: '12px 16px',
            background: 'var(--color-bg-card)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 12,
          }}
        >
          <span style={{ color: 'var(--color-accent-500)', fontSize: 12 }}>✦</span>
          <span>Analysing your question...</span>
          <span
            style={{
              display: 'inline-block', width: 4, height: 4, borderRadius: '50%',
              background: 'var(--color-accent-500)',
              animation: 'councilDot 1s ease-in-out infinite',
            }}
          />
          <style>{`
            @keyframes councilDot {
              0%, 100% { opacity: 0.3; }
              50% { opacity: 1; }
            }
          `}</style>
        </div>
      </div>
    )
  }

  // Error with no routing
  if (state.status === 'error' && !hasRouting) {
    return (
      <div style={{ maxWidth: 1020, margin: '0 auto', padding: '24px', width: '100%' }}>
        <div
          className="font-body"
          style={{
            fontSize: 12, color: '#dc2626', padding: '12px 16px',
            background: 'rgba(220,38,38,0.04)',
            border: '1px solid rgba(220,38,38,0.1)',
            borderRadius: 12,
          }}
        >
          {state.error ?? 'The advisory council encountered an error. Please try again.'}
        </div>
      </div>
    )
  }

  return (
    <div style={{ maxWidth: 1020, margin: '0 auto', padding: '0 24px', width: '100%' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

        {/* Phase 1: Routing card with approval */}
        {hasRouting && (
          <CouncilRoutingCard
            routing={state.routing!}
            availableAgents={state.availableAgents}
            selectedAgentIds={state.selectedAgentIds}
            awaitingApproval={state.status === 'awaiting_approval'}
            metaAnswer={state.metaAnswer}
            onToggleAgent={onToggleAgent}
            onApprove={onApprove}
            onSkip={onSkip}
          />
        )}

        {/* Phase 2: Agent perspective cards */}
        {hasAgents && (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: state.agentPerspectives.length > 1
                ? 'repeat(auto-fit, minmax(320px, 1fr))'
                : '1fr',
              gap: 12,
            }}
          >
            {state.agentPerspectives.map((perspective) => (
              <CouncilAgentCard
                key={perspective.agent_id}
                perspective={perspective}
                visible
                onAgentClick={onAgentClick}
              />
            ))}
          </div>
        )}

        {/* Synthesising indicator */}
        {state.status === 'synthesising' && (
          <div
            className="flex items-center font-body"
            style={{
              gap: 6, fontSize: 11, color: 'var(--color-text-secondary)',
              padding: '8px 16px',
            }}
          >
            <span style={{ color: 'var(--color-accent-500)' }}>✦</span>
            Synthesising perspectives...
            <span
              style={{
                display: 'inline-block', width: 4, height: 4, borderRadius: '50%',
                background: 'var(--color-accent-500)',
                animation: 'councilDot 1s ease-in-out infinite',
              }}
            />
          </div>
        )}

        {/* Phase 3: Synthesis card */}
        {hasSynthesis && (
          <CouncilSynthesisCard
            synthesis={state.synthesis!}
            visible
            onFollowUpClick={onFollowUpClick}
          />
        )}
      </div>
    </div>
  )
}
