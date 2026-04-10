import { useState } from 'react'
import { ChevronDown, Plus, X } from 'lucide-react'
import type { CouncilRouting, AvailableAgent } from '../../types/rag'

interface CouncilRoutingCardProps {
  routing: CouncilRouting
  availableAgents: AvailableAgent[]
  selectedAgentIds: string[]
  awaitingApproval: boolean
  metaAnswer: string | null
  onToggleAgent: (agentId: string) => void
  onApprove: () => void
  onSkip: () => void
}

export function CouncilRoutingCard({
  routing,
  availableAgents,
  selectedAgentIds,
  awaitingApproval,
  metaAnswer,
  onToggleAgent,
  onApprove,
  onSkip,
}: CouncilRoutingCardProps) {
  const [showAddDropdown, setShowAddDropdown] = useState(false)

  const classificationLabel = {
    single_domain: 'Single-domain',
    cross_domain: 'Cross-domain',
    meta: 'Meta',
  }[routing.classification] ?? routing.classification

  // Agents not currently selected
  const unselectedAgents = availableAgents.filter(a => !selectedAgentIds.includes(a.id))

  return (
    <div
      style={{
        opacity: 1,
        background: 'var(--color-bg-card)',
        border: '1px solid var(--border-subtle)',
        borderLeft: '2px solid rgba(214,58,0,0.1)',
        borderRadius: 12,
        padding: '16px 22px',
      }}
    >
      {/* Header */}
      <div className="flex items-center justify-between" style={{ marginBottom: 12 }}>
        <div className="flex items-center" style={{ gap: 6 }}>
          <span style={{ color: 'var(--color-accent-500)', fontSize: 12 }}>✦</span>
          <span
            className="font-body font-semibold"
            style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}
          >
            Routing
          </span>
          <span
            className="font-body font-semibold"
            style={{
              fontSize: 10,
              padding: '2px 8px',
              borderRadius: 10,
              background: 'var(--color-bg-inset)',
              color: 'var(--color-text-secondary)',
            }}
          >
            {classificationLabel}
          </span>
        </div>
      </div>

      {/* Meta answer */}
      {routing.classification === 'meta' && metaAnswer && (
        <div
          className="font-body"
          style={{
            fontSize: 13,
            color: 'var(--color-text-body)',
            lineHeight: 1.6,
            whiteSpace: 'pre-wrap',
          }}
        >
          {metaAnswer}
        </div>
      )}

      {/* Agent selection area */}
      {routing.classification !== 'meta' && (
        <>
          {/* Routing rationale */}
          <p
            className="font-body"
            style={{
              fontSize: 12,
              color: 'var(--color-text-body)',
              lineHeight: 1.5,
              fontStyle: 'italic',
              margin: '0 0 14px',
            }}
          >
            &ldquo;{routing.routing_rationale}&rdquo;
          </p>

          {/* Selected agents */}
          <div className="flex flex-wrap items-center" style={{ gap: 8, marginBottom: awaitingApproval ? 14 : 0 }}>
            {routing.agents_consulted
              .filter(a => selectedAgentIds.includes(a.agent_id))
              .map(agent => (
                <div
                  key={agent.agent_id}
                  className="flex items-center"
                  style={{
                    background: 'var(--color-accent-50)',
                    border: '1px solid rgba(214,58,0,0.12)',
                    borderRadius: 20,
                    padding: '5px 12px',
                    gap: 6,
                  }}
                >
                  <span
                    className="font-body font-semibold"
                    style={{ fontSize: 12, color: 'var(--color-accent-500)' }}
                  >
                    {agent.agent_name}
                  </span>
                  <span
                    className="font-body"
                    style={{ fontSize: 10, color: 'var(--color-text-secondary)' }}
                  >
                    {agent.relevance}
                  </span>
                  {awaitingApproval && (
                    <button
                      type="button"
                      onClick={() => onToggleAgent(agent.agent_id)}
                      className="flex items-center justify-center cursor-pointer"
                      style={{
                        width: 16, height: 16, borderRadius: '50%',
                        background: 'rgba(214,58,0,0.08)',
                        border: 'none', color: 'var(--color-accent-500)',
                      }}
                    >
                      <X size={9} />
                    </button>
                  )}
                </div>
              ))}

            {/* Agents added by user (not in original routing) */}
            {selectedAgentIds
              .filter(id => !routing.agents_consulted.some(a => a.agent_id === id))
              .map(id => {
                const agent = availableAgents.find(a => a.id === id)
                if (!agent) return null
                return (
                  <div
                    key={id}
                    className="flex items-center"
                    style={{
                      background: 'var(--color-bg-inset)',
                      border: '1px solid var(--border-subtle)',
                      borderRadius: 20,
                      padding: '5px 12px',
                      gap: 6,
                    }}
                  >
                    <span
                      className="font-body font-semibold"
                      style={{ fontSize: 12, color: 'var(--color-text-primary)' }}
                    >
                      {agent.name}
                    </span>
                    <span
                      className="font-body"
                      style={{ fontSize: 10, color: 'var(--color-text-secondary)' }}
                    >
                      added
                    </span>
                    {awaitingApproval && (
                      <button
                        type="button"
                        onClick={() => onToggleAgent(id)}
                        className="flex items-center justify-center cursor-pointer"
                        style={{
                          width: 16, height: 16, borderRadius: '50%',
                          background: 'var(--color-bg-inset)',
                          border: '1px solid var(--border-subtle)',
                          color: 'var(--color-text-secondary)',
                        }}
                      >
                        <X size={9} />
                      </button>
                    )}
                  </div>
                )
              })}

            {/* Add advisor button + dropdown */}
            {awaitingApproval && unselectedAgents.length > 0 && (
              <div style={{ position: 'relative' }}>
                <button
                  type="button"
                  onClick={() => setShowAddDropdown(prev => !prev)}
                  className="flex items-center font-body font-semibold cursor-pointer"
                  style={{
                    fontSize: 11,
                    gap: 4,
                    padding: '5px 12px',
                    borderRadius: 20,
                    border: '1px dashed var(--border-default)',
                    background: 'transparent',
                    color: 'var(--color-text-secondary)',
                    transition: 'all 0.15s ease',
                  }}
                  onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--color-accent-500)'; e.currentTarget.style.color = 'var(--color-accent-500)' }}
                  onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border-default)'; e.currentTarget.style.color = 'var(--color-text-secondary)' }}
                >
                  <Plus size={11} />
                  Add advisor
                  <ChevronDown size={10} />
                </button>

                {showAddDropdown && (
                  <div
                    style={{
                      position: 'absolute',
                      top: '100%',
                      left: 0,
                      marginTop: 4,
                      background: 'var(--color-bg-card)',
                      border: '1px solid var(--border-default)',
                      borderRadius: 10,
                      boxShadow: '0 4px 16px rgba(0,0,0,0.1)',
                      zIndex: 20,
                      minWidth: 220,
                      maxHeight: 240,
                      overflowY: 'auto',
                      padding: 4,
                    }}
                  >
                    {unselectedAgents.map(agent => (
                      <button
                        key={agent.id}
                        type="button"
                        onClick={() => { onToggleAgent(agent.id); setShowAddDropdown(false) }}
                        className="flex flex-col w-full text-left font-body cursor-pointer"
                        style={{
                          padding: '8px 12px',
                          borderRadius: 8,
                          border: 'none',
                          background: 'transparent',
                          transition: 'background 0.12s ease',
                        }}
                        onMouseEnter={e => { e.currentTarget.style.background = 'var(--color-bg-inset)' }}
                        onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
                      >
                        <span className="font-semibold" style={{ fontSize: 12, color: 'var(--color-text-primary)' }}>
                          {agent.name}
                        </span>
                        <span style={{ fontSize: 10, color: 'var(--color-text-secondary)', marginTop: 2 }}>
                          {agent.source_count} sources
                          {agent.description ? ` · ${agent.description.slice(0, 60)}...` : ''}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Approval actions */}
          {awaitingApproval && (
            <div className="flex items-center" style={{ gap: 8, marginTop: 4 }}>
              <button
                type="button"
                onClick={onApprove}
                disabled={selectedAgentIds.length === 0}
                className="font-body font-semibold cursor-pointer"
                style={{
                  fontSize: 12,
                  padding: '7px 18px',
                  borderRadius: 20,
                  border: 'none',
                  background: selectedAgentIds.length > 0 ? 'var(--color-accent-500)' : 'var(--color-bg-inset)',
                  color: selectedAgentIds.length > 0 ? '#ffffff' : 'var(--color-text-placeholder)',
                  cursor: selectedAgentIds.length > 0 ? 'pointer' : 'default',
                  transition: 'background 0.15s ease',
                }}
                onMouseEnter={e => { if (selectedAgentIds.length > 0) e.currentTarget.style.background = '#b83300' }}
                onMouseLeave={e => { if (selectedAgentIds.length > 0) e.currentTarget.style.background = 'var(--color-accent-500)' }}
              >
                Consult {selectedAgentIds.length} advisor{selectedAgentIds.length !== 1 ? 's' : ''}
              </button>
              <button
                type="button"
                onClick={onSkip}
                className="font-body font-semibold cursor-pointer"
                style={{
                  fontSize: 11,
                  padding: '7px 14px',
                  borderRadius: 20,
                  border: '1px solid var(--border-subtle)',
                  background: 'transparent',
                  color: 'var(--color-text-secondary)',
                  transition: 'all 0.15s ease',
                }}
                onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--border-default)' }}
                onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border-subtle)' }}
              >
                Skip — proceed
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
