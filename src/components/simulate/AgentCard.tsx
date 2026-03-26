import { useState } from 'react'
import { ChevronDown, ChevronRight, EyeOff, Eye } from 'lucide-react'
import { getEntityColor } from '../../config/entityTypes'
import type { SimulationPersona } from '../../types/simulate'

interface AgentCardProps {
  persona: SimulationPersona
  isExcluded: boolean
  onToggleExclude: (agentId: string) => void
  animationDelay?: number
}

function groundingIndicator(persona: SimulationPersona): { color: string; label: string } {
  if (persona.is_synthetic) {
    return { color: 'var(--color-text-placeholder)', label: 'Synthetic' }
  }
  switch (persona.grounding_quality) {
    case 'strong':
      return { color: '#22c55e', label: `${persona.source_count} sources` }
    case 'moderate':
      return { color: '#22c55e', label: `${persona.source_count} source${persona.source_count !== 1 ? 's' : ''}` }
    case 'weak':
      return { color: '#d97706', label: 'Weakly grounded' }
    case 'inferred':
      return { color: 'var(--color-text-placeholder)', label: 'Inferred' }
  }
}

function influencePillColor(tier: string): { bg: string; text: string } {
  switch (tier) {
    case 'high': return { bg: 'rgba(214,58,0,0.08)', text: 'var(--color-accent-500)' }
    case 'medium': return { bg: 'rgba(217,119,6,0.08)', text: '#b45309' }
    case 'low': return { bg: 'rgba(34,197,94,0.08)', text: '#15803d' }
    default: return { bg: 'rgba(0,0,0,0.04)', text: 'var(--color-text-secondary)' }
  }
}

const EPISTEMIC_LABELS: Record<string, string> = {
  empirical: 'Empirical',
  ideological: 'Ideological',
  opportunistic: 'Opportunistic',
  contrarian: 'Contrarian',
  cautious: 'Cautious',
  structural: 'Structural',
}

export function AgentCard({ persona, isExcluded, onToggleExclude, animationDelay = 0 }: AgentCardProps) {
  const [expanded, setExpanded] = useState(false)
  const [hovered, setHovered] = useState(false)

  const entityColor = getEntityColor(persona.entity_type)
  const grounding = groundingIndicator(persona)
  const influenceColors = influencePillColor(persona.influence_tier)

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        padding: '14px 16px',
        borderRadius: 12,
        background: isExcluded ? 'var(--color-bg-inset)' : 'white',
        border: '1px solid rgba(0,0,0,0.06)',
        opacity: isExcluded ? 0.5 : 1,
        transition: 'all 0.15s ease',
        animation: `fadeIn 0.4s ease ${animationDelay}s both`,
      }}
    >
      {/* Header row */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          {/* Entity type badge + name */}
          <div className="flex items-center gap-2 flex-wrap">
            <span
              className="font-body font-semibold"
              style={{
                fontSize: 10,
                color: entityColor,
                background: `${entityColor}15`,
                padding: '1px 8px',
                borderRadius: 10,
              }}
            >
              {persona.entity_type}
            </span>
            <span
              className="font-display"
              style={{
                fontSize: 15,
                fontWeight: 700,
                color: 'var(--color-text-primary)',
                textDecoration: isExcluded ? 'line-through' : 'none',
              }}
            >
              {persona.label}
            </span>
          </div>

          {/* Influence + grounding + epistemic style badges */}
          <div className="flex items-center gap-2 flex-wrap" style={{ marginTop: 6 }}>
            <span
              className="font-body font-semibold"
              style={{
                fontSize: 10,
                padding: '1px 8px',
                borderRadius: 10,
                background: influenceColors.bg,
                color: influenceColors.text,
              }}
            >
              {persona.influence_tier}
            </span>

            <div className="flex items-center gap-1">
              <div style={{ width: 6, height: 6, borderRadius: 3, background: grounding.color }} />
              <span className="font-body" style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>
                {grounding.label}
              </span>
            </div>

            <span
              className="font-body"
              style={{
                fontSize: 10,
                padding: '1px 7px',
                borderRadius: 10,
                background: 'rgba(0,0,0,0.04)',
                color: 'var(--color-text-secondary)',
              }}
            >
              {EPISTEMIC_LABELS[persona.epistemic_style] ?? persona.epistemic_style}
            </span>
          </div>
        </div>

        {/* Exclude toggle — always visible on hover */}
        <button
          type="button"
          onClick={() => onToggleExclude(persona.agent_id)}
          className="flex items-center gap-1 cursor-pointer shrink-0"
          style={{
            background: 'none',
            border: 'none',
            padding: '2px 4px',
            fontSize: 11,
            color: 'var(--color-text-secondary)',
            opacity: hovered ? 1 : 0,
            transition: 'opacity 0.15s ease',
          }}
        >
          {isExcluded ? <Eye size={13} /> : <EyeOff size={13} />}
          <span>{isExcluded ? 'Include' : 'Exclude'}</span>
        </button>
      </div>

      {/* Question-specific stance */}
      <div style={{ marginTop: 10 }}>
        <span className="font-body" style={{ fontSize: 11, color: 'var(--color-text-placeholder)' }}>
          On this question:
        </span>
        <p className="font-body" style={{ fontSize: 13, color: 'var(--color-text-primary)', margin: '2px 0 0 0' }}>
          {persona.question_specific_stance}
        </p>
      </div>

      {/* Documented position */}
      <p className="font-body" style={{ fontSize: 13, color: 'var(--color-text-secondary)', margin: '6px 0 0 0' }}>
        {persona.documented_position}
      </p>

      {/* Expandable section */}
      <button
        type="button"
        onClick={() => setExpanded(e => !e)}
        className="flex items-center gap-1 cursor-pointer"
        style={{
          background: 'none',
          border: 'none',
          padding: '6px 0 0 0',
          fontSize: 11,
          color: 'var(--color-text-secondary)',
        }}
      >
        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <span>Details</span>
      </button>

      {expanded && (
        <div
          style={{
            marginTop: 8,
            padding: '10px 12px',
            background: 'var(--color-bg-inset)',
            borderRadius: 8,
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          }}
        >
          <DetailRow label="Update conditions" value={persona.update_conditions} />
          <DetailRow label="Blind spots" value={persona.blind_spots} />
          <DetailRow label="Incentive structure" value={persona.incentive_structure} />
          {persona.inter_agent_relationships.length > 0 && (
            <DetailRow
              label="Relationships"
              value={persona.inter_agent_relationships.join(' · ')}
            />
          )}
        </div>
      )}
    </div>
  )
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span className="font-body font-semibold" style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>
        {label}
      </span>
      <p className="font-body" style={{ fontSize: 12, color: 'var(--color-text-primary)', margin: '1px 0 0 0' }}>
        {value}
      </p>
    </div>
  )
}
