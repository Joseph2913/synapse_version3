import { useState, useEffect, useCallback, type ReactNode } from 'react'
import {
  User, Anchor, Zap, Calendar, Link, X, Plus, Check, Loader2, LogOut,
  type LucideIcon,
} from 'lucide-react'
import { useAuth } from '../../hooks/useAuth'
import { useSettings } from '../../hooks/useSettings'
import { useAutoResize } from '../../hooks/useAutoResize'
import { EXTRACTION_MODES, ANCHOR_EMPHASIS_LEVELS } from '../../config/extractionModes'
import { AnchorPicker } from '../shared/AnchorPicker'
import { Dot } from '../ui/Dot'
import { SectionLabel } from '../ui/SectionLabel'
import { getNodeConnectionCount, supabase } from '../../services/supabase'
import { DigestsTab } from '../settings/DigestsTab'
import type { KnowledgeNode } from '../../types/database'

// ─── Tab config ───────────────────────────────────────────────────────────────

const SETTINGS_TABS: Array<{ id: string; label: string; icon: LucideIcon }> = [
  { id: 'profile', label: 'Profile', icon: User },
  { id: 'anchors', label: 'Anchors', icon: Anchor },
  { id: 'extraction', label: 'Extraction', icon: Zap },
  { id: 'digests', label: 'Digests', icon: Calendar },
  { id: 'integrations', label: 'Integrations', icon: Link },
]

// ─── Shared helpers ───────────────────────────────────────────────────────────

const inputStyle: React.CSSProperties = {
  padding: '8px 12px',
  background: 'var(--color-bg-inset)',
  border: '1px solid var(--border-subtle)',
  borderRadius: 8,
  fontSize: 13,
  fontFamily: 'var(--font-body)',
  color: 'var(--color-text-primary)',
  width: '100%',
  outline: 'none',
  boxSizing: 'border-box',
}

function FocusInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      style={inputStyle}
      onFocus={e => {
        e.currentTarget.style.borderColor = 'rgba(214,58,0,0.3)'
        e.currentTarget.style.boxShadow = '0 0 0 3px var(--color-accent-50)'
      }}
      onBlur={e => {
        e.currentTarget.style.borderColor = ''
        e.currentTarget.style.boxShadow = ''
      }}
    />
  )
}

function FocusTextarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement> & { autoResize?: boolean }) {
  const { autoResize, value, ...rest } = props
  const autoRef = useAutoResize(String(value ?? ''))

  return (
    <textarea
      {...rest}
      value={value}
      ref={autoResize ? autoRef : undefined}
      style={{
        ...inputStyle,
        resize: autoResize ? 'none' : 'vertical',
        overflow: autoResize ? 'hidden' : undefined,
        lineHeight: 1.5,
      } as React.CSSProperties}
      onFocus={e => {
        e.currentTarget.style.borderColor = 'rgba(214,58,0,0.3)'
        e.currentTarget.style.boxShadow = '0 0 0 3px var(--color-accent-50)'
      }}
      onBlur={e => {
        e.currentTarget.style.borderColor = ''
        e.currentTarget.style.boxShadow = ''
      }}
    />
  )
}

function FieldLabel({ children }: { children: ReactNode }) {
  return (
    <label
      className="block font-body font-semibold"
      style={{ fontSize: 12, color: 'var(--color-text-body)', marginBottom: 5 }}
    >
      {children}
    </label>
  )
}

// ─── Profile Tab ──────────────────────────────────────────────────────────────

function ProfileTab() {
  const { profile, updateProfile } = useSettings()
  const [name, setName] = useState('')
  const [professionalContext, setProfessionalContext] = useState('')
  const [personalInterests, setPersonalInterests] = useState('')
  const [processingPreferences, setProcessingPreferences] = useState('')
  const [savedState, setSavedState] = useState({ name: '', professionalContext: '', personalInterests: '', processingPreferences: '' })
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved'>('idle')

  useEffect(() => {
    if (!profile) return
    const ctx = profile.professional_context
    const interests = profile.personal_interests
    const prefs = profile.processing_preferences

    // Gracefully handle unexpected shapes from v1
    const loaded = {
      name: typeof ctx?.role === 'string' ? ctx.role : '',
      professionalContext: typeof ctx?.current_projects === 'string' ? ctx.current_projects : '',
      personalInterests: typeof interests?.topics === 'string' ? interests.topics : '',
      processingPreferences: typeof prefs?.insight_depth === 'string' ? prefs.insight_depth : '',
    }
    setName(loaded.name)
    setProfessionalContext(loaded.professionalContext)
    setPersonalInterests(loaded.personalInterests)
    setProcessingPreferences(loaded.processingPreferences)
    setSavedState(loaded)
  }, [profile])

  const isDirty =
    name !== savedState.name ||
    professionalContext !== savedState.professionalContext ||
    personalInterests !== savedState.personalInterests ||
    processingPreferences !== savedState.processingPreferences

  const handleSave = async () => {
    setSaveStatus('saving')
    const result = await updateProfile({
      professional_context: {
        ...(profile?.professional_context as Record<string, string> ?? {}),
        role: name,
        current_projects: professionalContext,
      },
      personal_interests: {
        ...(profile?.personal_interests as Record<string, string> ?? {}),
        topics: personalInterests,
      },
      processing_preferences: {
        ...(profile?.processing_preferences as Record<string, string> ?? {}),
        insight_depth: processingPreferences,
      },
    })
    if (!result.error) {
      setSavedState({ name, professionalContext, personalInterests, processingPreferences })
      setSaveStatus('saved')
      setTimeout(() => setSaveStatus('idle'), 2000)
    } else {
      setSaveStatus('idle')
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 480 }}>
      <div>
        <FieldLabel>Name</FieldLabel>
        <FocusInput
          type="text"
          placeholder="Your name"
          value={name}
          onChange={e => setName(e.target.value)}
        />
      </div>

      <div>
        <FieldLabel>Professional Context</FieldLabel>
        <FocusTextarea
          placeholder="Your role, industry, and current focus areas"
          rows={3}
          autoResize
          value={professionalContext}
          onChange={e => setProfessionalContext(e.target.value)}
        />
      </div>

      <div>
        <FieldLabel>Personal Interests</FieldLabel>
        <FocusTextarea
          placeholder="Topics you care about, learning goals"
          rows={3}
          autoResize
          value={personalInterests}
          onChange={e => setPersonalInterests(e.target.value)}
        />
      </div>

      <div>
        <FieldLabel>Processing Preferences</FieldLabel>
        <FocusTextarea
          placeholder="How you want knowledge extracted (e.g., prioritize actionable insights)"
          rows={2}
          autoResize
          value={processingPreferences}
          onChange={e => setProcessingPreferences(e.target.value)}
        />
      </div>

      <div style={{ paddingTop: 8, display: 'flex', flexDirection: 'column', gap: 16 }}>
        <button
          type="button"
          onClick={handleSave}
          disabled={!isDirty || saveStatus === 'saving'}
          className="flex items-center gap-2 cursor-pointer border-none"
          style={{
            padding: '8px 20px',
            background: 'var(--color-accent-500)',
            color: '#ffffff',
            borderRadius: 8,
            fontFamily: 'var(--font-body)',
            fontSize: 12,
            fontWeight: 600,
            opacity: !isDirty || saveStatus === 'saving' ? 0.4 : 1,
            cursor: !isDirty || saveStatus === 'saving' ? 'default' : 'pointer',
            transition: 'opacity 0.15s ease, background 0.15s ease',
            alignSelf: 'flex-start',
          }}
          onMouseEnter={e => {
            if (isDirty && saveStatus !== 'saving') e.currentTarget.style.background = 'var(--color-accent-600)'
          }}
          onMouseLeave={e => e.currentTarget.style.background = 'var(--color-accent-500)'}
        >
          {saveStatus === 'saving' && <Loader2 size={13} className="animate-spin" />}
          {saveStatus === 'saved' && <Check size={13} style={{ color: '#4ade80' }} />}
          {saveStatus === 'saved' ? 'Saved' : 'Save'}
        </button>

      </div>
    </div>
  )
}

// ─── Anchors Tab ──────────────────────────────────────────────────────────────

function AnchorsTab() {
  const { anchors, promoteToAnchor, demoteAnchor } = useSettings()
  const [connectionCounts, setConnectionCounts] = useState<Record<string, number>>({})
  const [countsLoading, setCountsLoading] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [demoting, setDemoting] = useState<string | null>(null)
  const [promoting, setPromoting] = useState(false)

  useEffect(() => {
    if (anchors.length === 0) {
      setConnectionCounts({})
      return
    }
    setCountsLoading(true)
    Promise.all(anchors.map(a => getNodeConnectionCount(a.id))).then(counts => {
      const map: Record<string, number> = {}
      anchors.forEach((a, i) => { map[a.id] = counts[i] ?? 0 })
      setConnectionCounts(map)
      setCountsLoading(false)
    })
  }, [anchors])

  const handleDemote = useCallback(async (nodeId: string) => {
    setDemoting(nodeId)
    await demoteAnchor(nodeId)
    setDemoting(null)
  }, [demoteAnchor])

  const handleSelect = useCallback(async (node: KnowledgeNode) => {
    setPromoting(true)
    await promoteToAnchor(node.id)
    setPromoting(false)
    setPickerOpen(false)
  }, [promoteToAnchor])

  const anchorIds = anchors.map(a => a.id)

  if (anchors.length === 0) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, paddingTop: 48 }}>
        <p className="font-body" style={{ fontSize: 14, fontWeight: 600, color: 'var(--color-text-primary)' }}>
          No anchors configured yet
        </p>
        <p className="font-body text-center" style={{ fontSize: 13, color: 'var(--color-text-secondary)', maxWidth: 300, lineHeight: 1.5 }}>
          Anchors focus AI extraction toward your highest-priority topics and projects.
        </p>
        <button
          type="button"
          onClick={() => setPickerOpen(true)}
          className="flex items-center gap-2 border cursor-pointer"
          style={{
            marginTop: 8,
            padding: '8px 16px',
            background: 'transparent',
            border: '2px dashed var(--border-default)',
            borderRadius: 8,
            fontFamily: 'var(--font-body)',
            fontSize: 12,
            color: 'var(--color-text-secondary)',
          }}
        >
          <Plus size={14} />
          Add Anchor
        </button>
        <AnchorPicker
          isOpen={pickerOpen}
          onClose={() => setPickerOpen(false)}
          onSelect={handleSelect}
          excludeIds={anchorIds}
          mode="promote"
        />
      </div>
    )
  }

  return (
    <div>
      <p className="font-body" style={{ fontSize: 13, color: 'var(--color-text-secondary)', lineHeight: 1.5, marginBottom: 16 }}>
        Anchors are high-priority nodes that focus AI extraction and serve as gravitational centers.
      </p>

      <div>
        {anchors.map(anchor => (
          <div
            key={anchor.id}
            className="flex items-center gap-3"
            style={{
              background: 'var(--color-bg-frame)',
              border: '1px solid rgba(180, 83, 9, 0.12)',
              borderRadius: 10,
              padding: '12px 16px',
              marginBottom: 6,
            }}
          >
            <Dot type={anchor.entity_type} size={10} />
            <div className="flex-1 min-w-0">
              <p className="font-body font-semibold truncate" style={{ fontSize: 13, color: 'var(--color-text-primary)' }}>
                {anchor.label}
              </p>
              <p className="font-body" style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>
                {anchor.entity_type}
                {' · '}
                {countsLoading ? '...' : `${connectionCounts[anchor.id] ?? 0} connections`}
              </p>
            </div>
            <button
              type="button"
              onClick={() => handleDemote(anchor.id)}
              disabled={demoting === anchor.id}
              className="flex items-center border cursor-pointer"
              style={{
                padding: '4px 10px',
                background: 'transparent',
                border: '1px solid rgba(239,68,68,0.18)',
                borderRadius: 6,
                fontFamily: 'var(--font-body)',
                fontSize: 10,
                fontWeight: 600,
                color: 'var(--color-semantic-red-500, #ef4444)',
                opacity: demoting === anchor.id ? 0.5 : 1,
                cursor: demoting === anchor.id ? 'default' : 'pointer',
                transition: 'opacity 0.15s ease',
              }}
            >
              {demoting === anchor.id ? <Loader2 size={11} className="animate-spin" /> : 'Demote'}
            </button>
          </div>
        ))}
      </div>

      <button
        type="button"
        onClick={() => setPickerOpen(true)}
        disabled={promoting}
        className="flex items-center gap-2 cursor-pointer"
        style={{
          marginTop: 12,
          padding: '8px 16px',
          background: 'transparent',
          border: '2px dashed var(--border-default)',
          borderRadius: 8,
          fontFamily: 'var(--font-body)',
          fontSize: 12,
          color: 'var(--color-text-secondary)',
          cursor: promoting ? 'default' : 'pointer',
          opacity: promoting ? 0.5 : 1,
        }}
      >
        {promoting ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
        Add Anchor
      </button>

      <AnchorPicker
        isOpen={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onSelect={handleSelect}
        excludeIds={anchorIds}
        mode="promote"
      />
    </div>
  )
}

// ─── Extraction Tab ───────────────────────────────────────────────────────────

function ExtractionTab() {
  const { extractionSettings, updateExtractionSettings } = useSettings()
  const [localMode, setLocalMode] = useState('comprehensive')
  const [localEmphasis, setLocalEmphasis] = useState('standard')
  const [savingMode, setSavingMode] = useState<string | null>(null)
  const [savingEmphasis, setSavingEmphasis] = useState<string | null>(null)

  useEffect(() => {
    if (extractionSettings) {
      setLocalMode(extractionSettings.default_mode)
      setLocalEmphasis(extractionSettings.default_anchor_emphasis)
    }
  }, [extractionSettings])

  const handleModeSelect = async (modeId: string) => {
    if (modeId === localMode) return
    setLocalMode(modeId)
    setSavingMode(modeId)
    await updateExtractionSettings({ default_mode: modeId })
    setSavingMode(null)
  }

  const handleEmphasisSelect = async (emphasisId: string) => {
    if (emphasisId === localEmphasis) return
    setLocalEmphasis(emphasisId)
    setSavingEmphasis(emphasisId)
    await updateExtractionSettings({ default_anchor_emphasis: emphasisId })
    setSavingEmphasis(null)
  }

  return (
    <div>
      <p className="font-body" style={{ fontSize: 13, color: 'var(--color-text-secondary)', lineHeight: 1.5, marginBottom: 16 }}>
        Default extraction behavior. Override per-source during ingestion.
      </p>

      <SectionLabel>Default Mode</SectionLabel>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: 6,
          marginTop: 8,
          marginBottom: 20,
        }}
      >
        {EXTRACTION_MODES.map(mode => {
          const isSelected = localMode === mode.id
          const isSaving = savingMode === mode.id
          return (
            <button
              key={mode.id}
              type="button"
              onClick={() => handleModeSelect(mode.id)}
              className="flex flex-col items-start border cursor-pointer"
              style={{
                padding: '12px 14px',
                borderRadius: 8,
                background: isSelected ? `${mode.colorHex}0f` : 'var(--color-bg-frame)',
                border: isSelected ? `1px solid ${mode.colorHex}40` : '1px solid var(--border-subtle)',
                transition: 'background 0.15s ease, border-color 0.15s ease',
                cursor: 'pointer',
                position: 'relative',
              }}
            >
              <div className="flex items-center gap-2 w-full">
                <span
                  className="font-body font-semibold"
                  style={{
                    fontSize: 12,
                    color: isSelected ? mode.colorHex : 'var(--color-text-primary)',
                    marginBottom: 2,
                    flex: 1,
                  }}
                >
                  {mode.label}
                </span>
                {isSaving && <Loader2 size={11} className="animate-spin" style={{ color: mode.colorHex, flexShrink: 0 }} />}
                {isSelected && !isSaving && <Check size={11} style={{ color: mode.colorHex, flexShrink: 0 }} />}
              </div>
              <span className="font-body text-left" style={{ fontSize: 10, color: 'var(--color-text-secondary)', lineHeight: 1.4 }}>
                {mode.description}
              </span>
            </button>
          )
        })}
      </div>

      <SectionLabel>Default Anchor Emphasis</SectionLabel>
      <div
        style={{
          display: 'flex',
          gap: 6,
          marginTop: 8,
        }}
      >
        {ANCHOR_EMPHASIS_LEVELS.map(level => {
          const isSelected = localEmphasis === level.id
          const isSaving = savingEmphasis === level.id
          return (
            <button
              key={level.id}
              type="button"
              onClick={() => handleEmphasisSelect(level.id)}
              className="flex flex-col items-center border cursor-pointer"
              style={{
                flex: 1,
                padding: 10,
                borderRadius: 8,
                textAlign: 'center',
                background: isSelected ? 'rgba(180,83,9,0.06)' : 'var(--color-bg-frame)',
                border: isSelected ? '1px solid rgba(180,83,9,0.25)' : '1px solid var(--border-subtle)',
                transition: 'background 0.15s ease, border-color 0.15s ease',
                cursor: 'pointer',
              }}
            >
              <div className="flex items-center gap-1">
                <span
                  className="font-body font-semibold"
                  style={{
                    fontSize: 12,
                    color: isSelected ? '#b45309' : 'var(--color-text-primary)',
                  }}
                >
                  {level.label}
                </span>
                {isSaving && <Loader2 size={11} className="animate-spin" style={{ color: '#b45309', flexShrink: 0 }} />}
              </div>
              <span className="font-body" style={{ fontSize: 10, color: 'var(--color-text-secondary)', marginTop: 2 }}>
                {level.description}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

// ─── Integrations Tab ─────────────────────────────────────────────────────────

function IntegrationsTab() {
  const [circlebackConnected, setCirclebackConnected] = useState(false)

  useEffect(() => {
    supabase
      .from('knowledge_sources')
      .select('*', { count: 'exact', head: true })
      .eq('source_type', 'meeting')
      .then(({ count }) => {
        setCirclebackConnected((count ?? 0) > 0)
      })
  }, [])

  const geminiKey = import.meta.env.VITE_GEMINI_API_KEY as string | undefined
  const geminiConnected = Boolean(geminiKey)
  const geminiDisplay = geminiKey
    ? `${geminiKey.slice(0, 4)}...${geminiKey.slice(-4)}`
    : 'Not configured'

  const integrations = [
    {
      name: 'Google Gemini API',
      hint: geminiDisplay,
      connected: geminiConnected,
    },
    {
      name: 'Supabase',
      hint: 'eyJh...xxxx',
      connected: true,
    },
    {
      name: 'Circleback',
      hint: circlebackConnected ? 'Webhook active' : 'Not connected',
      connected: circlebackConnected,
    },
  ]

  return (
    <div>
      <p className="font-body" style={{ fontSize: 13, color: 'var(--color-text-secondary)', lineHeight: 1.5, marginBottom: 16 }}>
        Connection status for external services.
      </p>
      <div>
        {integrations.map(integration => (
          <div
            key={integration.name}
            className="flex items-center justify-between"
            style={{
              background: 'var(--color-bg-frame)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 8,
              padding: '12px 16px',
              marginBottom: 6,
            }}
          >
            <div>
              <p className="font-body font-semibold" style={{ fontSize: 13, color: 'var(--color-text-primary)' }}>
                {integration.name}
              </p>
              <p className="font-body" style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>
                {integration.hint}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <div
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  background: integration.connected
                    ? 'var(--color-semantic-green-500, #22c55e)'
                    : 'var(--color-text-secondary)',
                  flexShrink: 0,
                }}
              />
              <span
                className="font-body font-semibold"
                style={{
                  fontSize: 11,
                  color: integration.connected
                    ? 'var(--color-semantic-green-500, #22c55e)'
                    : 'var(--color-text-secondary)',
                }}
              >
                {integration.connected ? 'Connected' : 'Not connected'}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Settings Modal ───────────────────────────────────────────────────────────

interface SettingsModalProps {
  onClose: () => void
}

export function SettingsModal({ onClose }: SettingsModalProps) {
  const [activeTab, setActiveTab] = useState('profile')
  const { signOut } = useAuth()
  const [signingOut, setSigningOut] = useState(false)

  // Esc to close
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  const currentTab = SETTINGS_TABS.find(t => t.id === activeTab)!

  return (
    <div
      className="fixed inset-0 flex items-center justify-center z-50"
      style={{ background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(6px)' }}
      onClick={onClose}
    >
      <div
        className="flex overflow-hidden"
        style={{
          width: 720,
          height: 520,
          background: 'var(--color-bg-card)',
          border: '1px solid var(--border-strong)',
          borderRadius: 16,
          boxShadow: '0 25px 60px rgba(0,0,0,0.25)',
        }}
        onClick={e => e.stopPropagation()}
      >
        {/* Sidebar */}
        <div
          className="flex flex-col shrink-0"
          style={{
            width: 200,
            background: 'var(--color-bg-frame)',
            borderRight: '1px solid var(--border-subtle)',
            padding: '24px 10px',
          }}
        >
          <span
            className="font-display font-bold text-text-primary"
            style={{ fontSize: 14, padding: '0 12px', marginBottom: 20 }}
          >
            Settings
          </span>

          <div className="flex flex-col gap-0.5">
            {SETTINGS_TABS.map(tab => {
              const Icon = tab.icon
              const isActive = activeTab === tab.id
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setActiveTab(tab.id)}
                  className="flex items-center gap-2.5 w-full border-none cursor-pointer"
                  style={{
                    padding: '9px 12px',
                    borderRadius: 8,
                    background: isActive ? 'var(--color-bg-active)' : 'transparent',
                    fontFamily: 'var(--font-body)',
                    fontSize: 12,
                    fontWeight: 500,
                    color: isActive ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
                    transition: 'background 0.15s ease',
                  }}
                >
                  <Icon
                    size={15}
                    strokeWidth={1.8}
                    style={{ color: isActive ? 'var(--color-accent-500)' : 'var(--color-text-secondary)' }}
                  />
                  {tab.label}
                </button>
              )
            })}
          </div>

          <div style={{ marginTop: 'auto', padding: '0 2px' }}>
            <div style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: 12 }}>
              <button
                type="button"
                onClick={async () => {
                  setSigningOut(true)
                  await signOut()
                }}
                disabled={signingOut}
                className="flex items-center gap-2.5 w-full border-none cursor-pointer"
                style={{
                  padding: '9px 12px',
                  borderRadius: 8,
                  background: 'transparent',
                  fontFamily: 'var(--font-body)',
                  fontSize: 12,
                  fontWeight: 500,
                  color: '#dc2626',
                  transition: 'background 0.15s ease',
                  opacity: signingOut ? 0.5 : 1,
                }}
                onMouseEnter={e => { e.currentTarget.style.background = '#fef2f2' }}
                onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
              >
                {signingOut
                  ? <Loader2 size={15} strokeWidth={1.8} style={{ color: '#dc2626', animation: 'spin 1s linear infinite' }} />
                  : <LogOut size={15} strokeWidth={1.8} style={{ color: '#dc2626' }} />
                }
                {signingOut ? 'Signing out...' : 'Sign out'}
              </button>
            </div>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
          <div
            className="flex items-center justify-between shrink-0"
            style={{ padding: '24px 32px 16px' }}
          >
            <h2 className="font-display font-bold text-text-primary" style={{ fontSize: 18 }}>
              {currentTab.label}
            </h2>
            <button
              type="button"
              onClick={onClose}
              className="flex items-center justify-center w-7 h-7 border-none cursor-pointer rounded-lg"
              style={{ background: 'transparent', transition: 'background 0.15s ease' }}
              onMouseEnter={e => e.currentTarget.style.background = 'var(--color-bg-hover)'}
              onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
            >
              <X size={16} style={{ color: 'var(--color-text-secondary)' }} />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto" style={{ padding: '0 32px 28px' }}>
            {activeTab === 'profile' && <ProfileTab />}
            {activeTab === 'anchors' && <AnchorsTab />}
            {activeTab === 'extraction' && <ExtractionTab />}
            {activeTab === 'digests' && <DigestsTab />}
            {activeTab === 'integrations' && <IntegrationsTab />}
          </div>
        </div>
      </div>
    </div>
  )
}
