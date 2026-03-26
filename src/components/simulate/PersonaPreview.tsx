import { useState, useMemo } from 'react'
import { AlertTriangle, EyeOff, Eye, Search, ChevronDown, ChevronRight, Plus } from 'lucide-react'
import { getEntityColor } from '../../config/entityTypes'
import { derivePersonasFromGraph } from '../../services/simulate'
import type { SimulationSeedGraph, SimulationNode } from '../../types/simulate'

interface PersonaPreviewProps {
  seedGraph: SimulationSeedGraph | null
  excludedNodeIds: string[]
  onExcludeToggle: (nodeId: string) => void
  loading: boolean
}

const PERSONA_ENTITY_TYPES = ['Person', 'Organization', 'Team']

function influenceColor(influence: 'low' | 'medium' | 'high'): string {
  switch (influence) {
    case 'high': return 'var(--color-accent-500)'
    case 'medium': return '#d97706'
    case 'low': return '#22c55e'
  }
}

function getInfluence(centrality: number, isAnchor: boolean): 'low' | 'medium' | 'high' {
  if (isAnchor) return 'high'
  if (centrality >= 8) return 'high'
  if (centrality >= 4) return 'medium'
  return 'low'
}

export function PersonaPreview({ seedGraph, excludedNodeIds, onExcludeToggle, loading }: PersonaPreviewProps) {
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [browseOpen, setBrowseOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [typeFilter, setTypeFilter] = useState<string | null>(null)

  // Derive auto-selected personas (top by centrality, anchors first)
  const autoPersonas = useMemo(() => {
    if (!seedGraph) return []
    return derivePersonasFromGraph(seedGraph)
  }, [seedGraph])

  // All eligible nodes (Person/Org/Team) in the seed graph — for the browse panel
  const allEligible = useMemo(() => {
    if (!seedGraph) return []
    return seedGraph.nodes
      .filter(n => PERSONA_ENTITY_TYPES.includes(n.entityType))
      .sort((a, b) => {
        if (a.isAnchor !== b.isAnchor) return a.isAnchor ? -1 : 1
        return b.centrality - a.centrality
      })
  }, [seedGraph])

  // Active (included) personas = auto-selected minus excluded
  const activePersonas = useMemo(
    () => autoPersonas.filter(p => !excludedNodeIds.includes(p.id)),
    [autoPersonas, excludedNodeIds]
  )

  // Excluded from auto-selected
  const excludedPersonas = useMemo(
    () => autoPersonas.filter(p => excludedNodeIds.includes(p.id)),
    [autoPersonas, excludedNodeIds]
  )

  // Nodes not in auto-selection but available to add (in the browse panel)
  const autoPersonaIds = useMemo(() => new Set(autoPersonas.map(p => p.id)), [autoPersonas])

  // For the browse panel: all eligible not auto-selected, filtered by search + type
  const browseResults = useMemo(() => {
    let pool = allEligible.filter(n => !autoPersonaIds.has(n.id))
    if (typeFilter) {
      pool = pool.filter(n => n.entityType === typeFilter)
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase()
      pool = pool.filter(n =>
        n.label.toLowerCase().includes(q) ||
        (n.description && n.description.toLowerCase().includes(q))
      )
    }
    return pool
  }, [allEligible, autoPersonaIds, typeFilter, searchQuery])

  // Available entity types for filter
  const availableTypes = useMemo(() => {
    const types = new Set(allEligible.filter(n => !autoPersonaIds.has(n.id)).map(n => n.entityType))
    return Array.from(types).sort()
  }, [allEligible, autoPersonaIds])

  if (loading) {
    return (
      <div>
        <div
          className="font-display"
          style={{ fontSize: 10, fontWeight: 700, color: 'var(--color-text-secondary)', letterSpacing: '0.08em', marginBottom: 8 }}
        >
          SIMULATION AGENTS
        </div>
        <div className="flex flex-col gap-2">
          {[1, 2, 3].map(i => (
            <div
              key={i}
              style={{
                height: 52, borderRadius: 10,
                background: 'var(--color-bg-inset)',
                animation: 'pulse 1.5s ease-in-out infinite',
              }}
            />
          ))}
        </div>
      </div>
    )
  }

  if (!seedGraph) return null

  return (
    <div>
      {/* Header */}
      <div className="flex items-center gap-2" style={{ marginBottom: 4 }}>
        <span
          className="font-display"
          style={{ fontSize: 10, fontWeight: 700, color: 'var(--color-text-secondary)', letterSpacing: '0.08em' }}
        >
          SIMULATION AGENTS
        </span>
        <span
          className="font-body font-semibold"
          style={{
            fontSize: 10, color: 'var(--color-accent-500)',
            background: 'var(--color-accent-50)',
            padding: '1px 7px', borderRadius: 10,
          }}
        >
          {activePersonas.length}
        </span>
        {allEligible.length > autoPersonas.length && (
          <span className="font-body" style={{ fontSize: 11, color: 'var(--color-text-placeholder)' }}>
            of {allEligible.length} eligible
          </span>
        )}
      </div>
      <p className="font-body" style={{ fontSize: 12, color: 'var(--color-text-secondary)', margin: '0 0 10px 0' }}>
        Auto-selected by graph centrality. Exclude agents or browse to add more.
      </p>

      {/* Warning if < 3 personas */}
      {autoPersonas.length < 3 && (
        <div
          className="flex items-start gap-2"
          style={{
            padding: '10px 12px', borderRadius: 10,
            background: '#fffbeb', border: '1px solid #fde68a',
            marginBottom: 10,
          }}
        >
          <AlertTriangle size={14} style={{ color: '#d97706', flexShrink: 0, marginTop: 1 }} />
          <span className="font-body" style={{ fontSize: 12, color: '#92400e' }}>
            Limited agents available. Simulations work best with 5+ Person or Organization nodes in scope.
          </span>
        </div>
      )}

      {/* Active agent list */}
      <div
        style={{
          maxHeight: 280, overflowY: 'auto',
          display: 'flex', flexDirection: 'column', gap: 6,
        }}
      >
        {activePersonas.map(persona => (
          <AgentRow
            key={persona.id}
            persona={persona}
            isExcluded={false}
            isHovered={hoveredId === persona.id}
            onMouseEnter={() => setHoveredId(persona.id)}
            onMouseLeave={() => setHoveredId(null)}
            onToggle={() => onExcludeToggle(persona.id)}
            toggleLabel="Exclude"
            toggleIcon="exclude"
          />
        ))}
      </div>

      {/* Excluded agents (collapsed) */}
      {excludedPersonas.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <span className="font-body" style={{ fontSize: 11, color: 'var(--color-text-placeholder)' }}>
            {excludedPersonas.length} excluded
          </span>
          <div
            style={{
              maxHeight: 140, overflowY: 'auto',
              display: 'flex', flexDirection: 'column', gap: 4,
              marginTop: 4,
            }}
          >
            {excludedPersonas.map(persona => (
              <AgentRow
                key={persona.id}
                persona={persona}
                isExcluded
                isHovered={hoveredId === persona.id}
                onMouseEnter={() => setHoveredId(persona.id)}
                onMouseLeave={() => setHoveredId(null)}
                onToggle={() => onExcludeToggle(persona.id)}
                toggleLabel="Include"
                toggleIcon="include"
              />
            ))}
          </div>
        </div>
      )}

      {/* Browse / add more agents button */}
      {allEligible.length > autoPersonas.length && (
        <div style={{ marginTop: 12 }}>
          <button
            type="button"
            onClick={() => setBrowseOpen(prev => !prev)}
            className="flex items-center gap-2 cursor-pointer font-body font-semibold"
            style={{
              fontSize: 12,
              padding: '6px 14px',
              borderRadius: 20,
              border: '1px solid var(--border-subtle)',
              background: browseOpen ? 'var(--color-accent-50)' : 'transparent',
              color: browseOpen ? 'var(--color-accent-500)' : 'var(--color-text-secondary)',
              transition: 'all 0.15s ease',
            }}
          >
            {browseOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            <Plus size={12} />
            Browse {allEligible.length - autoPersonas.length} more agents
          </button>

          {browseOpen && (
            <div
              style={{
                marginTop: 8,
                padding: '12px',
                borderRadius: 12,
                background: 'var(--color-bg-inset)',
                border: '1px solid rgba(0,0,0,0.06)',
              }}
            >
              {/* Search + type filter */}
              <div className="flex items-center gap-2" style={{ marginBottom: 10 }}>
                <div className="relative flex-1">
                  <Search
                    size={13}
                    style={{
                      position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)',
                      color: 'var(--color-text-placeholder)',
                    }}
                  />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={e => setSearchQuery(e.target.value)}
                    placeholder="Search agents…"
                    className="font-body w-full"
                    style={{
                      fontSize: 12,
                      color: 'var(--color-text-primary)',
                      background: 'white',
                      border: '1px solid rgba(0,0,0,0.10)',
                      borderRadius: 20,
                      padding: '5px 12px 5px 28px',
                      outline: 'none',
                    }}
                  />
                </div>
                {/* Type filter pills */}
                <div className="flex gap-1">
                  <button
                    type="button"
                    onClick={() => setTypeFilter(null)}
                    className="font-body font-semibold cursor-pointer"
                    style={{
                      fontSize: 11, padding: '3px 10px', borderRadius: 20,
                      border: !typeFilter ? '1px solid rgba(214,58,0,0.15)' : '1px solid var(--border-subtle)',
                      background: !typeFilter ? 'var(--color-accent-50)' : 'white',
                      color: !typeFilter ? 'var(--color-accent-500)' : 'var(--color-text-secondary)',
                    }}
                  >
                    All
                  </button>
                  {availableTypes.map(t => (
                    <button
                      key={t}
                      type="button"
                      onClick={() => setTypeFilter(typeFilter === t ? null : t)}
                      className="font-body font-semibold cursor-pointer"
                      style={{
                        fontSize: 11, padding: '3px 10px', borderRadius: 20,
                        border: typeFilter === t ? '1px solid rgba(214,58,0,0.15)' : '1px solid var(--border-subtle)',
                        background: typeFilter === t ? 'var(--color-accent-50)' : 'white',
                        color: typeFilter === t ? 'var(--color-accent-500)' : 'var(--color-text-secondary)',
                      }}
                    >
                      {t}
                    </button>
                  ))}
                </div>
              </div>

              {/* Browse results */}
              <div
                style={{
                  maxHeight: 240, overflowY: 'auto',
                  display: 'flex', flexDirection: 'column', gap: 4,
                }}
              >
                {browseResults.length === 0 && (
                  <p className="font-body" style={{ fontSize: 12, color: 'var(--color-text-placeholder)', margin: 0, padding: '8px 0', textAlign: 'center' }}>
                    {searchQuery ? 'No matching agents found.' : 'All eligible agents are already selected.'}
                  </p>
                )}
                {browseResults.map(node => {
                  const color = getEntityColor(node.entityType)
                  const influence = getInfluence(node.centrality, node.isAnchor)
                  return (
                    <div
                      key={node.id}
                      className="flex items-center justify-between"
                      style={{
                        padding: '8px 10px',
                        borderRadius: 8,
                        background: 'white',
                        border: '1px solid rgba(0,0,0,0.06)',
                      }}
                    >
                      <div className="flex items-center gap-2 flex-1 min-w-0">
                        <div style={{ width: 6, height: 6, borderRadius: 3, background: color, flexShrink: 0 }} />
                        <span className="font-body" style={{ fontSize: 10, color: 'var(--color-text-secondary)', flexShrink: 0 }}>
                          {node.entityType}
                        </span>
                        <span className="font-body truncate" style={{ fontSize: 13, fontWeight: 500, color: 'var(--color-text-primary)' }}>
                          {node.label}
                        </span>
                        <div
                          style={{ width: 5, height: 5, borderRadius: 3, background: influenceColor(influence), flexShrink: 0 }}
                          title={`${influence} influence (${node.centrality} connections)`}
                        />
                      </div>
                      <button
                        type="button"
                        onClick={() => onExcludeToggle(node.id)}
                        className="flex items-center gap-1 cursor-pointer font-body font-semibold"
                        style={{
                          fontSize: 11, padding: '3px 10px', borderRadius: 20,
                          background: 'var(--color-accent-50)',
                          border: '1px solid rgba(214,58,0,0.15)',
                          color: 'var(--color-accent-500)',
                          flexShrink: 0,
                        }}
                      >
                        <Plus size={10} />
                        Add
                      </button>
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </div>
      )}

      <p className="font-body" style={{ fontSize: 11, color: 'var(--color-text-placeholder)', marginTop: 8 }}>
        Agents ranked by graph centrality (connection count). Anchors are prioritised.
      </p>
    </div>
  )
}

// ─── Agent row sub-component ─────────────────────────────────────────────────
function AgentRow({
  persona,
  isExcluded,
  isHovered,
  onMouseEnter,
  onMouseLeave,
  onToggle,
  toggleLabel,
  toggleIcon,
}: {
  persona: SimulationNode
  isExcluded: boolean
  isHovered: boolean
  onMouseEnter: () => void
  onMouseLeave: () => void
  onToggle: () => void
  toggleLabel: string
  toggleIcon: 'exclude' | 'include'
}) {
  const influence = getInfluence(persona.centrality, persona.isAnchor)
  const color = getEntityColor(persona.entityType)

  return (
    <div
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      className="relative"
      style={{
        padding: '10px 12px',
        borderRadius: 10,
        background: isExcluded ? 'var(--color-bg-inset)' : 'white',
        border: '1px solid rgba(0,0,0,0.06)',
        borderLeft: persona.isAnchor ? '3px solid var(--color-accent-50)' : '1px solid rgba(0,0,0,0.06)',
        opacity: isExcluded ? 0.5 : 1,
        transition: 'all 0.15s ease',
      }}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <div className="flex items-center gap-1 shrink-0">
            <div style={{ width: 6, height: 6, borderRadius: 3, background: color }} />
            <span className="font-body" style={{ fontSize: 10, color: 'var(--color-text-secondary)' }}>
              {persona.entityType}
            </span>
          </div>
          <span
            className="font-body truncate"
            style={{
              fontSize: 14, fontWeight: 500,
              color: 'var(--color-text-primary)',
              textDecoration: isExcluded ? 'line-through' : 'none',
            }}
          >
            {persona.label}
          </span>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <div
            style={{ width: 6, height: 6, borderRadius: 3, background: influenceColor(influence) }}
            title={`${influence} influence (${persona.centrality} connections)`}
          />
          {isHovered && (
            <button
              type="button"
              onClick={onToggle}
              className="cursor-pointer flex items-center gap-1"
              style={{
                background: 'none', border: 'none',
                fontSize: 11, color: 'var(--color-text-secondary)',
                padding: 0,
              }}
            >
              {toggleIcon === 'exclude'
                ? <><EyeOff size={12} /><span>{toggleLabel}</span></>
                : <><Eye size={12} /><span>{toggleLabel}</span></>
              }
            </button>
          )}
        </div>
      </div>

      {persona.description && !isExcluded && (
        <p
          className="font-body"
          style={{
            fontSize: 12, color: 'var(--color-text-secondary)',
            margin: '4px 0 0 0',
            display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
          }}
        >
          {persona.description}
        </p>
      )}
    </div>
  )
}
