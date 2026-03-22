import { useState } from 'react'
import { Plus, X, FlaskConical } from 'lucide-react'
import { ENTITY_TYPE_COLORS } from '../../config/entityTypes'
import type { ExternalAgent } from '../../types/simulate'

interface ExternalAgentsProps {
  agents: ExternalAgent[]
  onChange: (agents: ExternalAgent[]) => void
}

const ENTITY_TYPE_OPTIONS = Object.keys(ENTITY_TYPE_COLORS)

const EMPTY_AGENT: ExternalAgent = {
  label: '',
  entity_type: 'Person',
  known_position: '',
}

export function ExternalAgents({ agents, onChange }: ExternalAgentsProps) {
  const [draft, setDraft] = useState<ExternalAgent>({ ...EMPTY_AGENT })

  const canAdd = agents.length < 3 && draft.label.trim() && draft.known_position.trim()

  const handleAdd = () => {
    if (!canAdd) return
    onChange([...agents, {
      label: draft.label.trim(),
      entity_type: draft.entity_type,
      known_position: draft.known_position.trim(),
    }])
    setDraft({ ...EMPTY_AGENT })
  }

  const handleRemove = (index: number) => {
    onChange(agents.filter((_, i) => i !== index))
  }

  return (
    <div>
      <p className="font-body" style={{ fontSize: 12, color: 'var(--color-text-secondary)', margin: '0 0 10px 0' }}>
        Inject entities not in your graph as simulation participants (max 3).
      </p>

      {/* Existing agent cards */}
      {agents.length > 0 && (
        <div className="flex flex-col gap-2" style={{ marginBottom: 12 }}>
          {agents.map((agent, i) => (
            <div
              key={i}
              className="flex items-start gap-3"
              style={{
                padding: '10px 14px',
                borderRadius: 12,
                background: 'white',
                border: '1px solid rgba(0,0,0,0.10)',
              }}
            >
              <div className="flex-1">
                <div className="flex items-center gap-2" style={{ marginBottom: 4 }}>
                  <span className="font-body" style={{ fontSize: 13, fontWeight: 500, color: 'var(--color-text-primary)' }}>
                    {agent.label}
                  </span>
                  <span
                    className="font-body font-semibold"
                    style={{
                      fontSize: 10, color: 'var(--color-text-secondary)',
                      background: 'var(--color-bg-inset)',
                      padding: '1px 8px', borderRadius: 10,
                    }}
                  >
                    {agent.entity_type}
                  </span>
                  <span
                    className="font-body font-semibold flex items-center gap-1"
                    style={{
                      fontSize: 10, color: '#7c3aed',
                      background: '#f5f3ff',
                      padding: '1px 8px', borderRadius: 10,
                    }}
                  >
                    <FlaskConical size={9} />
                    Synthetic
                  </span>
                </div>
                <p className="font-body" style={{ fontSize: 12, color: 'var(--color-text-secondary)', margin: 0 }}>
                  {agent.known_position}
                </p>
              </div>
              <button
                type="button"
                onClick={() => handleRemove(i)}
                className="flex items-center justify-center cursor-pointer"
                style={{
                  width: 24, height: 24, borderRadius: 12,
                  background: 'none', border: 'none',
                  color: 'var(--color-text-secondary)',
                  flexShrink: 0,
                }}
              >
                <X size={14} />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Add new agent form */}
      {agents.length < 3 && (
        <div
          style={{
            padding: '12px 14px',
            borderRadius: 12,
            background: 'var(--color-bg-inset)',
            border: '1px dashed rgba(0,0,0,0.10)',
          }}
        >
          <div className="flex items-center gap-2" style={{ marginBottom: 8 }}>
            <input
              type="text"
              value={draft.label}
              onChange={e => setDraft(prev => ({ ...prev, label: e.target.value }))}
              placeholder="Name"
              className="font-body flex-1"
              style={{
                fontSize: 13,
                color: 'var(--color-text-primary)',
                background: 'white',
                border: '1px solid rgba(0,0,0,0.10)',
                borderRadius: 20,
                padding: '5px 12px',
                outline: 'none',
              }}
            />
            <select
              value={draft.entity_type}
              onChange={e => setDraft(prev => ({ ...prev, entity_type: e.target.value }))}
              className="font-body"
              style={{
                fontSize: 12,
                color: 'var(--color-text-primary)',
                background: 'white',
                border: '1px solid rgba(0,0,0,0.10)',
                borderRadius: 20,
                padding: '5px 12px',
                outline: 'none',
                cursor: 'pointer',
              }}
            >
              {ENTITY_TYPE_OPTIONS.map(t => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={draft.known_position}
              onChange={e => setDraft(prev => ({ ...prev, known_position: e.target.value }))}
              onKeyDown={e => { if (e.key === 'Enter') handleAdd() }}
              placeholder="Known position on the question (1–2 sentences)"
              className="font-body flex-1"
              style={{
                fontSize: 13,
                color: 'var(--color-text-primary)',
                background: 'white',
                border: '1px solid rgba(0,0,0,0.10)',
                borderRadius: 20,
                padding: '5px 12px',
                outline: 'none',
              }}
            />
            <button
              type="button"
              onClick={handleAdd}
              disabled={!canAdd}
              className="flex items-center gap-1 cursor-pointer font-body font-semibold"
              style={{
                fontSize: 12,
                padding: '5px 13px',
                borderRadius: 20,
                background: canAdd ? 'var(--color-accent-500)' : 'var(--color-bg-inset)',
                border: 'none',
                color: canAdd ? 'white' : 'var(--color-text-placeholder)',
                transition: 'all 0.15s ease',
                flexShrink: 0,
              }}
            >
              <Plus size={12} />
              Add
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
