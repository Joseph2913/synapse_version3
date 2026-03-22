import { useState, useEffect, useCallback } from 'react'
import { ChevronDown, Zap, Layers, Clock, Rabbit, Brain, Sparkles } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { QUERY_MINDSETS } from '../../config/queryMindsets'
import { MODEL_TIERS } from '../../config/queryMindsets'
import { TOOL_MODES } from '../../config/toolModes'
import { useSettings } from '../../hooks/useSettings'
import type { QueryConfig, QueryMindsetId, ToolModeId, ModelTierId } from '../../types/rag'

type DropdownId = 'mindset' | 'retrieval' | 'model' | 'scope'

interface PanelPos { bottom: number; left: number }

export interface InlineQueryToolbarProps {
  config: QueryConfig
  onSetMindset: (id: QueryMindsetId) => void
  onToggleScopeAnchor: (anchorId: string) => void
  onClearScope: () => void
  onSetToolMode: (id: ToolModeId) => void
  onSetModelTier: (id: ModelTierId) => void
}

const TOOL_ICONS: Record<string, LucideIcon> = { Zap, Layers, Clock }
const MODEL_ICONS: Record<string, LucideIcon> = { Rabbit, Brain }

function hexToRgb(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `${r},${g},${b}`
}

export function InlineQueryToolbar({
  config,
  onSetMindset,
  onToggleScopeAnchor,
  onClearScope,
  onSetToolMode,
  onSetModelTier,
}: InlineQueryToolbarProps) {
  const { anchors } = useSettings()
  const [openDropdown, setOpenDropdown] = useState<DropdownId | null>(null)
  const [panelPos, setPanelPos] = useState<PanelPos>({ bottom: 0, left: 0 })

  const activeMindset = QUERY_MINDSETS.find(m => m.id === config.mindset)
  const activeMode = TOOL_MODES.find(m => m.id === config.toolMode)
  const activeModel = MODEL_TIERS.find(t => t.id === config.modelTier)
  const scopeLabel =
    config.scopeAnchors.length === 0
      ? 'All sources'
      : `${config.scopeAnchors.length} anchor${config.scopeAnchors.length > 1 ? 's' : ''}`

  const openPanel = useCallback(
    (id: DropdownId, e: React.MouseEvent<HTMLButtonElement>) => {
      if (openDropdown === id) { setOpenDropdown(null); return }
      const rect = e.currentTarget.getBoundingClientRect()
      setPanelPos({ bottom: window.innerHeight - rect.top + 8, left: rect.left })
      setOpenDropdown(id)
    },
    [openDropdown],
  )

  // Outside-click dismissal
  useEffect(() => {
    if (!openDropdown) return
    const handler = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest('[data-ask-dd]')) setOpenDropdown(null)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [openDropdown])

  // ── shared style helpers ──────────────────────────────────────────────────

  const pill = (isActive: boolean, openId?: DropdownId): React.CSSProperties => ({
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    fontSize: 11,
    fontWeight: 600,
    padding: '4px 8px',
    borderRadius: 6,
    border: `1px solid ${isActive || openId === openDropdown ? 'rgba(214,58,0,0.2)' : 'var(--border-subtle)'}`,
    background: isActive || openId === openDropdown ? 'rgba(214,58,0,0.06)' : 'var(--color-bg-inset)',
    color: isActive || openId === openDropdown ? 'var(--color-accent-500)' : 'var(--color-text-secondary)',
    cursor: 'pointer',
    transition: 'all 0.15s ease',
    whiteSpace: 'nowrap' as const,
  })

  const panel: React.CSSProperties = {
    position: 'fixed',
    bottom: panelPos.bottom,
    left: panelPos.left,
    zIndex: 1200,
    background: 'var(--color-bg-card)',
    border: '1px solid var(--border-default)',
    borderRadius: 10,
    padding: 6,
    boxShadow: '0 4px 20px rgba(0,0,0,0.14)',
    minWidth: 200,
  }

  const row = (isSelected: boolean, accentColor?: string): React.CSSProperties => ({
    display: 'flex',
    alignItems: 'flex-start',
    gap: 8,
    width: '100%',
    padding: '7px 10px',
    borderRadius: 7,
    border: 'none',
    background: isSelected
      ? accentColor
        ? `rgba(${hexToRgb(accentColor)},0.08)`
        : 'rgba(214,58,0,0.06)'
      : 'transparent',
    color: isSelected
      ? accentColor ?? 'var(--color-accent-500)'
      : 'var(--color-text-body)',
    cursor: 'pointer',
    textAlign: 'left' as const,
    transition: 'background 0.1s ease',
  })

  return (
    <div className="flex items-center" style={{ gap: 4 }} data-ask-dd>
      {/* ── Mindset ─────────────────────────────────────── */}
      <button
        type="button"
        data-ask-dd
        className="font-body font-semibold cursor-pointer"
        style={pill(config.mindset !== 'auto', 'mindset')}
        onClick={e => openPanel('mindset', e)}
      >
        {activeMindset && (
          activeMindset.id === 'auto'
            ? <Sparkles size={11} style={{ flexShrink: 0 }} />
            : <span
                style={{
                  width: 6, height: 6, borderRadius: '50%',
                  background: activeMindset.color,
                  display: 'inline-block', flexShrink: 0,
                }}
              />
        )}
        {activeMindset?.label ?? 'Mindset'}
        <ChevronDown size={10} style={{ opacity: 0.5 }} />
      </button>

      {/* ── Retrieval ───────────────────────────────────── */}
      <button
        type="button"
        data-ask-dd
        className="font-body font-semibold cursor-pointer"
        style={pill(config.toolMode !== 'deep', 'retrieval')}
        onClick={e => openPanel('retrieval', e)}
      >
        {(() => { const Icon = activeMode ? TOOL_ICONS[activeMode.icon] : null; return Icon ? <Icon size={11} /> : null })()}
        {activeMode?.label ?? 'Retrieval'}
        <ChevronDown size={10} style={{ opacity: 0.5 }} />
      </button>

      {/* ── Model ───────────────────────────────────────── */}
      <button
        type="button"
        data-ask-dd
        className="font-body font-semibold cursor-pointer"
        style={pill(config.modelTier !== 'thorough', 'model')}
        onClick={e => openPanel('model', e)}
      >
        {(() => { const Icon = activeModel ? MODEL_ICONS[activeModel.icon] : null; return Icon ? <Icon size={11} /> : null })()}
        {activeModel?.label ?? 'Model'}
        <ChevronDown size={10} style={{ opacity: 0.5 }} />
      </button>

      {/* ── Scope ───────────────────────────────────────── */}
      <button
        type="button"
        data-ask-dd
        className="font-body font-semibold cursor-pointer"
        style={pill(config.scopeAnchors.length > 0, 'scope')}
        onClick={e => openPanel('scope', e)}
      >
        {scopeLabel}
        <ChevronDown size={10} style={{ opacity: 0.5 }} />
      </button>

      {/* ── Floating panels ─────────────────────────────── */}
      {openDropdown === 'mindset' && (
        <div style={panel} data-ask-dd>
          {QUERY_MINDSETS.map(m => (
            <button
              key={m.id}
              type="button"
              data-ask-dd
              className="font-body w-full cursor-pointer"
              style={row(config.mindset === m.id, m.color)}
              onClick={() => { onSetMindset(m.id as QueryMindsetId); setOpenDropdown(null) }}
            >
              {m.id === 'auto'
                ? <Sparkles size={13} style={{ flexShrink: 0, marginTop: 2 }} />
                : <span
                    style={{
                      width: 7, height: 7, borderRadius: '50%',
                      background: m.color,
                      display: 'inline-block', flexShrink: 0, marginTop: 3,
                    }}
                  />
              }
              <div>
                <div style={{ fontSize: 12, fontWeight: 600 }}>{m.label}</div>
                <div style={{ fontSize: 10, fontWeight: 400, color: 'var(--color-text-secondary)', marginTop: 1 }}>
                  {m.description.split('.')[0]}.
                </div>
              </div>
            </button>
          ))}
        </div>
      )}

      {openDropdown === 'retrieval' && (
        <div style={panel} data-ask-dd>
          {TOOL_MODES.map(mode => {
            const Icon = TOOL_ICONS[mode.icon]
            return (
              <button
                key={mode.id}
                type="button"
                data-ask-dd
                className="font-body w-full cursor-pointer"
                style={row(config.toolMode === mode.id)}
                onClick={() => { onSetToolMode(mode.id as ToolModeId); setOpenDropdown(null) }}
              >
                {Icon && <Icon size={13} style={{ flexShrink: 0, marginTop: 2 }} />}
                <div>
                  <div style={{ fontSize: 12, fontWeight: 600 }}>{mode.label}</div>
                  <div style={{ fontSize: 10, fontWeight: 400, color: 'var(--color-text-secondary)', marginTop: 1 }}>
                    {mode.description}
                  </div>
                </div>
              </button>
            )
          })}
        </div>
      )}

      {openDropdown === 'model' && (
        <div style={{ ...panel, minWidth: 170 }} data-ask-dd>
          {MODEL_TIERS.map(tier => {
            const Icon = MODEL_ICONS[tier.icon]
            return (
              <button
                key={tier.id}
                type="button"
                data-ask-dd
                className="font-body w-full cursor-pointer"
                style={row(config.modelTier === tier.id)}
                onClick={() => { onSetModelTier(tier.id as ModelTierId); setOpenDropdown(null) }}
              >
                {Icon && <Icon size={13} style={{ flexShrink: 0, marginTop: 2 }} />}
                <div>
                  <div style={{ fontSize: 12, fontWeight: 600 }}>{tier.label}</div>
                  <div style={{ fontSize: 10, fontWeight: 400, color: 'var(--color-text-secondary)', marginTop: 1 }}>
                    {tier.description}
                  </div>
                </div>
              </button>
            )
          })}
        </div>
      )}

      {openDropdown === 'scope' && (
        <div style={{ ...panel, minWidth: 220 }} data-ask-dd>
          <div style={{ padding: '2px 6px 6px', borderBottom: '1px solid var(--border-subtle)', marginBottom: 4 }}>
            <span
              className="font-display font-bold uppercase"
              style={{ fontSize: 9, letterSpacing: '0.08em', color: 'var(--color-text-secondary)' }}
            >
              SCOPE
            </span>
          </div>
          <button
            type="button"
            data-ask-dd
            className="font-body w-full cursor-pointer"
            style={row(config.scopeAnchors.length === 0)}
            onClick={onClearScope}
          >
            <div style={{ fontSize: 12, fontWeight: 600 }}>All sources</div>
          </button>
          {anchors.length === 0 ? (
            <p style={{ fontSize: 10, color: 'var(--color-text-placeholder)', padding: '4px 10px' }}>
              No anchors configured
            </p>
          ) : (
            anchors.map(anchor => {
              const isSelected = config.scopeAnchors.includes(anchor.id)
              return (
                <button
                  key={anchor.id}
                  type="button"
                  data-ask-dd
                  className="font-body w-full cursor-pointer"
                  style={row(isSelected, '#b45309')}
                  onClick={() => onToggleScopeAnchor(anchor.id)}
                >
                  <span
                    style={{
                      width: 6, height: 6, borderRadius: '50%',
                      background: isSelected ? '#b45309' : 'var(--color-text-placeholder)',
                      display: 'inline-block', flexShrink: 0, marginTop: 3,
                    }}
                  />
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 600 }}>{anchor.label}</div>
                    <div style={{ fontSize: 10, fontWeight: 400, color: 'var(--color-text-secondary)' }}>
                      {anchor.entity_type}
                    </div>
                  </div>
                </button>
              )
            })
          )}
        </div>
      )}
    </div>
  )
}
