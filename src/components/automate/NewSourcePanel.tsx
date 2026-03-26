import { useState } from 'react'
import { ArrowLeft, Copy, Check, Plug2 } from 'lucide-react'
import type { AutomationSource, SourceSettings } from '../../services/automationSources'
import { addYouTubePlaylist, DEFAULT_SOURCE_SETTINGS } from '../../services/automationSources'
import { connectMicrosoft } from '../../services/microsoft'
import { useSettings } from '../../hooks/useSettings'
import { useAuth } from '../../hooks/useAuth'
import { EXTRACTION_MODES, ANCHOR_EMPHASIS_LEVELS } from '../../config/extractionModes'
import { getEntityColor } from '../../config/entityTypes'

interface NewSourcePanelProps {
  onSourceAdded: (source: AutomationSource) => void
  onSelectMcp?: () => void
}

type SourceTypeId = 'youtube-playlist' | 'circleback' | 'firefly' | 'microsoft'

const SOURCE_TYPES: { id: SourceTypeId; logo: string; label: string; description: string }[] = [
  { id: 'microsoft', logo: '/logos/microsoft.svg', label: 'Microsoft 365', description: 'Outlook calendar, email & Teams transcripts' },
  { id: 'youtube-playlist', logo: '/logos/youtube.svg', label: 'YouTube Playlist', description: 'Sync all videos in a specific playlist' },
  { id: 'circleback', logo: '/logos/circleback.jpeg', label: 'Circleback', description: 'Auto-ingest meeting transcripts via webhook' },
  { id: 'firefly', logo: '/logos/fireflies.jpeg', label: 'Firefly', description: 'Auto-ingest Firefly.ai meeting notes' },
]

const COMING_SOON = [
  { logo: '/logos/google-drive.svg', label: 'Google Drive', description: 'Sync documents automatically' },
  { logo: '/logos/notion.svg', label: 'Notion', description: 'Import pages and databases' },
  { logo: '/logos/slack.svg', label: 'Slack', description: 'Capture messages from channels' },
]

function SL({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div
      className="font-display font-bold uppercase"
      style={{ fontSize: 10, letterSpacing: '0.08em', color: 'var(--color-text-secondary)', marginBottom: 8, ...style }}
    >
      {children}
    </div>
  )
}

function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `rgba(${r},${g},${b},${alpha})`
}

const INPUT_STYLE: React.CSSProperties = {
  width: '100%',
  background: 'var(--color-bg-inset)',
  border: '1px solid var(--border-subtle)',
  borderRadius: 8,
  padding: '8px 12px',
  fontSize: 12,
  fontFamily: 'var(--font-body)',
  color: 'var(--color-text-primary)',
  outline: 'none',
  boxSizing: 'border-box',
  transition: 'border-color 0.15s, box-shadow 0.15s',
}

const FOCUS_HANDLERS = {
  onFocus: (e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    e.currentTarget.style.borderColor = 'rgba(214,58,0,0.3)'
    e.currentTarget.style.boxShadow = '0 0 0 3px var(--color-accent-50)'
  },
  onBlur: (e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    e.currentTarget.style.borderColor = 'var(--border-subtle)'
    e.currentTarget.style.boxShadow = 'none'
  },
}

// ─── Extraction settings sub-form (shared between all source types) ──────────

interface ExtractionSettingsFormProps {
  settings: SourceSettings
  onChange: (s: SourceSettings) => void
}

function ExtractionSettingsForm({ settings, onChange }: ExtractionSettingsFormProps) {
  const { anchors } = useSettings()

  const toggleAnchor = (id: string) => {
    const ids = settings.linkedAnchorIds.includes(id)
      ? settings.linkedAnchorIds.filter(a => a !== id)
      : [...settings.linkedAnchorIds, id]
    onChange({ ...settings, linkedAnchorIds: ids })
  }

  return (
    <div>
      {/* Mode */}
      <SL>Extraction Mode</SL>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginBottom: 16 }}>
        {EXTRACTION_MODES.map(m => {
          const active = settings.mode === m.id
          return (
            <button
              key={m.id}
              type="button"
              onClick={() => onChange({ ...settings, mode: m.id })}
              className="font-body"
              style={{
                padding: '8px 10px',
                borderRadius: 8,
                border: active ? `1.5px solid ${m.colorHex}` : '1px solid var(--border-subtle)',
                background: active ? hexToRgba(m.colorHex, 0.06) : 'var(--color-bg-inset)',
                cursor: 'pointer',
                textAlign: 'left',
                transition: 'all 0.15s',
              }}
            >
              <div style={{ fontSize: 11, fontWeight: 700, color: active ? m.colorHex : 'var(--color-text-body)', marginBottom: 2 }}>
                {m.label}
              </div>
              <div style={{ fontSize: 10, color: 'var(--color-text-secondary)', lineHeight: 1.3 }}>
                {m.description}
              </div>
            </button>
          )
        })}
      </div>

      {/* Emphasis */}
      <SL>Anchor Emphasis</SL>
      <div style={{ display: 'flex', gap: 5, marginBottom: 16 }}>
        {ANCHOR_EMPHASIS_LEVELS.map(lvl => {
          const active = settings.emphasis === lvl.id
          return (
            <button
              key={lvl.id}
              type="button"
              onClick={() => onChange({ ...settings, emphasis: lvl.id })}
              className="font-body font-semibold"
              style={{
                flex: 1,
                padding: '7px 8px',
                borderRadius: 7,
                border: active ? '1.5px solid rgba(214,58,0,0.3)' : '1px solid var(--border-subtle)',
                background: active ? 'var(--color-accent-50)' : 'transparent',
                color: active ? 'var(--color-accent-500)' : 'var(--color-text-secondary)',
                fontSize: 11,
                cursor: 'pointer',
                transition: 'all 0.15s',
                textAlign: 'center',
              }}
            >
              {lvl.label}
            </button>
          )
        })}
      </div>

      {/* Focus Anchors */}
      {anchors.length > 0 && (
        <>
          <SL>Focus Anchors</SL>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginBottom: 16 }}>
            {anchors.map(anchor => {
              const active = settings.linkedAnchorIds.includes(anchor.id)
              const color = getEntityColor(anchor.entity_type)
              return (
                <button
                  key={anchor.id}
                  type="button"
                  onClick={() => toggleAnchor(anchor.id)}
                  className="font-body font-semibold"
                  style={{
                    padding: '4px 10px',
                    borderRadius: 6,
                    fontSize: 11,
                    border: `1px solid ${active ? hexToRgba(color, 0.2) : 'var(--border-subtle)'}`,
                    background: active ? hexToRgba(color, 0.07) : 'transparent',
                    color: active ? color : 'var(--color-text-secondary)',
                    transition: 'all 0.15s',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 5,
                    cursor: 'pointer',
                  }}
                >
                  <span style={{ width: 5, height: 5, borderRadius: '50%', background: color, display: 'inline-block', flexShrink: 0 }} />
                  {anchor.label}
                </button>
              )
            })}
          </div>
        </>
      )}

      {/* Custom Instructions */}
      <SL>Custom Instructions</SL>
      <textarea
        value={settings.customInstructions ?? ''}
        onChange={e => onChange({ ...settings, customInstructions: e.target.value })}
        placeholder="e.g. Focus on strategic insights and key decisions. Ignore ads and sponsored segments…"
        rows={3}
        className="font-body"
        style={{
          ...INPUT_STYLE,
          resize: 'vertical',
          fontFamily: 'var(--font-body)',
        } as React.CSSProperties}
        {...FOCUS_HANDLERS}
      />
    </div>
  )
}

// ─── Step 1: Source type picker ───────────────────────────────────────────────

interface StepPickProps {
  onPick: (type: SourceTypeId) => void
  onSelectMcp?: () => void
}

function StepPick({ onPick, onSelectMcp }: StepPickProps) {
  return (
    <div style={{ height: '100%', overflowY: 'auto', background: 'var(--color-bg-card)', borderLeft: '1px solid var(--border-subtle)' }}>
      <div style={{ padding: '24px 28px' }}>
        {/* Header */}
        <div style={{ marginBottom: 24 }}>
          <div className="font-display" style={{ fontSize: 16, fontWeight: 700, color: 'var(--color-text-primary)' }}>
            Connect a Source
          </div>
          <div className="font-body" style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 2 }}>
            Choose what kind of source to add
          </div>
        </div>

        {/* Active source types */}
        <SL>Available</SL>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 24 }}>
          {/* API & MCP Access — first in the list */}
          {onSelectMcp && (
            <button
              type="button"
              onClick={onSelectMcp}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 14,
                padding: '14px 16px',
                borderRadius: 10,
                border: '1px solid var(--border-subtle)',
                background: 'var(--color-bg-card)',
                cursor: 'pointer',
                textAlign: 'left',
                transition: 'all 0.15s',
                width: '100%',
              }}
              onMouseEnter={e => {
                e.currentTarget.style.borderColor = 'rgba(214,58,0,0.3)'
                e.currentTarget.style.background = 'var(--color-accent-50)'
              }}
              onMouseLeave={e => {
                e.currentTarget.style.borderColor = 'var(--border-subtle)'
                e.currentTarget.style.background = 'var(--color-bg-card)'
              }}
            >
              <div style={{ width: 36, height: 36, borderRadius: 9, background: 'var(--color-bg-inset)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                <Plug2 size={20} style={{ color: '#d63a00' }} />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="font-body" style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text-primary)' }}>API &amp; MCP Access</div>
                <div className="font-body" style={{ fontSize: 11, color: 'var(--color-text-secondary)', marginTop: 1 }}>Connect Claude Code &amp; other AI tools</div>
              </div>
              <div style={{ fontSize: 12, color: 'var(--color-text-placeholder)', flexShrink: 0 }}>→</div>
            </button>
          )}
          {SOURCE_TYPES.map(st => (
            <button
              key={st.id}
              type="button"
              onClick={() => onPick(st.id)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 14,
                padding: '14px 16px',
                borderRadius: 10,
                border: '1px solid var(--border-subtle)',
                background: 'var(--color-bg-card)',
                cursor: 'pointer',
                textAlign: 'left',
                transition: 'all 0.15s',
                width: '100%',
              }}
              onMouseEnter={e => {
                e.currentTarget.style.borderColor = 'rgba(214,58,0,0.3)'
                e.currentTarget.style.background = 'var(--color-accent-50)'
              }}
              onMouseLeave={e => {
                e.currentTarget.style.borderColor = 'var(--border-subtle)'
                e.currentTarget.style.background = 'var(--color-bg-card)'
              }}
            >
              <div style={{ width: 36, height: 36, borderRadius: 9, background: 'var(--color-bg-inset)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, overflow: 'hidden' }}>
                <img src={st.logo} alt={st.label} style={{ width: 24, height: 24, objectFit: 'contain', borderRadius: 3 }} />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="font-body" style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text-primary)' }}>{st.label}</div>
                <div className="font-body" style={{ fontSize: 11, color: 'var(--color-text-secondary)', marginTop: 1 }}>{st.description}</div>
              </div>
              <div style={{ fontSize: 12, color: 'var(--color-text-placeholder)', flexShrink: 0 }}>→</div>
            </button>
          ))}
        </div>

        {/* Coming soon */}
        <SL>Coming Soon</SL>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {COMING_SOON.map(svc => (
            <div
              key={svc.label}
              style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', borderRadius: 10, background: 'var(--color-bg-inset)', border: '1px solid var(--border-subtle)', opacity: 0.6 }}
            >
              <div style={{ width: 32, height: 32, borderRadius: 8, background: 'var(--color-bg-card)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, overflow: 'hidden' }}>
                <img src={svc.logo} alt={svc.label} style={{ width: 20, height: 20, objectFit: 'contain', borderRadius: 3 }} />
              </div>
              <div style={{ flex: 1 }}>
                <div className="font-body" style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text-body)' }}>{svc.label}</div>
                <div className="font-body" style={{ fontSize: 10, color: 'var(--color-text-secondary)' }}>{svc.description}</div>
              </div>
              <span className="font-body" style={{ fontSize: 10, fontWeight: 600, color: 'var(--color-text-placeholder)', padding: '3px 8px', border: '1px solid var(--border-subtle)', borderRadius: 6 }}>
                Soon
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ─── Step 2: Configure source ─────────────────────────────────────────────────

interface StepConfigureProps {
  sourceType: SourceTypeId
  onBack: () => void
  onSourceAdded: (source: AutomationSource) => void
}

function StepConfigure({ sourceType, onBack, onSourceAdded }: StepConfigureProps) {
  const [url, setUrl] = useState('')
  const [settings, setSettings] = useState<SourceSettings>({ ...DEFAULT_SOURCE_SETTINGS })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const { user } = useAuth()

  const isMeeting = sourceType === 'circleback' || sourceType === 'firefly'
  const isMicrosoft = sourceType === 'microsoft'
  const webhookUrl = isMeeting && user
    ? `${window.location.origin}/api/meetings/webhook?uid=${user.id}`
    : ''

  const sourceInfo = SOURCE_TYPES.find(s => s.id === sourceType)!

  const handleCopyWebhook = () => {
    void navigator.clipboard.writeText(webhookUrl).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  const handleConnect = async () => {
    setError(null)

    if (isMicrosoft) {
      setLoading(true)
      try {
        const authUrl = await connectMicrosoft()
        // Redirect to Microsoft OAuth consent screen
        window.location.href = authUrl
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to connect Microsoft 365')
        setLoading(false)
      }
      return
    }

    if (sourceType === 'youtube-playlist') {
      const trimmed = url.trim()
      if (!trimmed) { setError('Please enter a YouTube playlist URL.'); return }
      if (!trimmed.includes('youtube.com/playlist') && !trimmed.includes('list=')) {
        setError('Please enter a valid YouTube playlist URL (youtube.com/playlist?list=…).')
        return
      }
      setLoading(true)
      try {
        const source = await addYouTubePlaylist(trimmed, settings)
        onSourceAdded(source)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to add playlist')
      } finally {
        setLoading(false)
      }
    } else {
      // Meeting services — webhook is all that's needed, navigate back to pick
      onBack()
    }
  }

  const connectLabel = isMicrosoft
    ? loading ? 'Redirecting to Microsoft…' : 'Connect with Microsoft'
    : isMeeting
      ? 'Done — Webhook Configured'
      : loading
        ? 'Connecting…'
        : `Connect ${sourceInfo.label}`

  return (
    <div style={{ height: '100%', overflowY: 'auto', background: 'var(--color-bg-card)', borderLeft: '1px solid var(--border-subtle)', animation: 'slideInRight 0.2s ease' }}>
      <div style={{ padding: '24px 28px' }}>

        {/* Header */}
        <div style={{ marginBottom: 20 }}>
          <button
            type="button"
            onClick={onBack}
            className="font-body"
            style={{ display: 'flex', alignItems: 'center', gap: 5, background: 'transparent', border: 'none', cursor: 'pointer', fontSize: 12, color: 'var(--color-text-secondary)', padding: 0, marginBottom: 16 }}
          >
            <ArrowLeft size={13} /> Back
          </button>
        </div>

        {/* Source identity */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24 }}>
          <div style={{ width: 40, height: 40, borderRadius: 10, background: 'var(--color-bg-inset)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, overflow: 'hidden' }}>
            <img src={sourceInfo.logo} alt={sourceInfo.label} style={{ width: 26, height: 26, objectFit: 'contain', borderRadius: 3 }} />
          </div>
          <div>
            <div className="font-display" style={{ fontSize: 16, fontWeight: 700, color: 'var(--color-text-primary)' }}>
              {sourceInfo.label}
            </div>
            <div className="font-body" style={{ fontSize: 11, color: 'var(--color-text-secondary)', marginTop: 2 }}>
              {sourceInfo.description}
            </div>
          </div>
        </div>

        {/* ── YouTube URL input ── */}
        {!isMeeting && !isMicrosoft && (
          <div style={{ marginBottom: 24 }}>
            <SL>Playlist URL</SL>
            <input
              type="text"
              value={url}
              onChange={e => { setUrl(e.target.value); setError(null) }}
              onKeyDown={e => { if (e.key === 'Enter') void handleConnect() }}
              placeholder="https://youtube.com/playlist?list=…"
              style={{ ...INPUT_STYLE, marginBottom: error ? 6 : 0 }}
              {...FOCUS_HANDLERS}
            />
            {error && (
              <p className="font-body" style={{ fontSize: 11, color: '#ef4444', marginBottom: 0 }}>{error}</p>
            )}
          </div>
        )}

        {/* ── Meeting webhook setup ── */}
        {isMeeting && (
          <div style={{ marginBottom: 24 }}>
            <SL>Webhook URL</SL>
            <p className="font-body" style={{ fontSize: 12, color: 'var(--color-text-body)', marginBottom: 12, lineHeight: 1.5 }}>
              In <strong>{sourceInfo.label}</strong>, go to <em>Automations → Create Automation</em>, add your
              conditions, then select <em>Send webhook request</em> and paste this URL. Meeting transcripts will
              be automatically sent to Synapse after each meeting.
            </p>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <div
                className="font-body"
                style={{
                  flex: 1,
                  padding: '8px 12px',
                  borderRadius: 8,
                  background: 'var(--color-bg-inset)',
                  border: '1px solid var(--border-subtle)',
                  fontSize: 11,
                  color: 'var(--color-text-secondary)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  fontFamily: 'monospace',
                }}
              >
                {webhookUrl || 'Configure VITE_SUPABASE_URL in your environment'}
              </div>
              <button
                type="button"
                onClick={handleCopyWebhook}
                className="font-body font-semibold"
                style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '8px 12px', borderRadius: 8, border: '1px solid var(--border-subtle)', background: 'var(--color-bg-card)', fontSize: 11, cursor: 'pointer', color: copied ? '#22c55e' : 'var(--color-text-body)', flexShrink: 0, transition: 'color 0.15s' }}
              >
                {copied ? <Check size={12} /> : <Copy size={12} />}
                {copied ? 'Copied!' : 'Copy'}
              </button>
            </div>
          </div>
        )}

        {/* ── Microsoft OAuth info ── */}
        {isMicrosoft && (
          <div style={{ marginBottom: 24 }}>
            <SL>How It Works</SL>
            <div className="font-body" style={{ fontSize: 12, color: 'var(--color-text-body)', lineHeight: 1.6 }}>
              <p style={{ margin: '0 0 10px' }}>
                Clicking <strong>Connect with Microsoft</strong> will redirect you to Microsoft's sign-in page where you can authorize Synapse to access your:
              </p>
              <ul style={{ margin: '0 0 10px', paddingLeft: 18 }}>
                <li><strong>Outlook Calendar</strong> — meetings, events, and attendees</li>
                <li><strong>Outlook Email</strong> — inbox messages (optional)</li>
                <li><strong>Teams Transcripts</strong> — meeting recordings with transcription enabled</li>
              </ul>
              <p style={{ margin: 0, fontSize: 11, color: 'var(--color-text-secondary)' }}>
                Teams transcript access may require admin consent from your IT department.
                You can configure which data sources to sync after connecting.
              </p>
            </div>
            {error && (
              <p className="font-body" style={{ fontSize: 12, color: '#ef4444', marginTop: 12, padding: '8px 12px', borderRadius: 8, background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.15)' }}>{error}</p>
            )}
          </div>
        )}

        {/* ── Extraction settings ── */}
        {!isMicrosoft && (
        <div style={{ paddingTop: 4, borderTop: '1px solid var(--border-subtle)', marginBottom: 24 }}>
          <SL style={{ marginTop: 20 }}>Extraction Settings</SL>
          <ExtractionSettingsForm settings={settings} onChange={setSettings} />
        </div>
        )}

        {/* ── Submit ── */}
        <button
          type="button"
          onClick={() => void handleConnect()}
          disabled={loading}
          className="font-body font-semibold"
          style={{
            width: '100%',
            padding: '11px 18px',
            borderRadius: 10,
            border: 'none',
            background: loading ? 'var(--color-bg-inset)' : 'var(--color-accent-500)',
            color: loading ? 'var(--color-text-secondary)' : 'white',
            fontSize: 13,
            cursor: loading ? 'not-allowed' : 'pointer',
            transition: 'all 0.15s',
          }}
        >
          {connectLabel}
        </button>
      </div>
    </div>
  )
}

// ─── Root component ───────────────────────────────────────────────────────────

export function NewSourcePanel({ onSourceAdded, onSelectMcp }: NewSourcePanelProps) {
  const [step, setStep] = useState<'pick' | 'configure'>('pick')
  const [selectedType, setSelectedType] = useState<SourceTypeId | null>(null)

  const handlePick = (type: SourceTypeId) => {
    setSelectedType(type)
    setStep('configure')
  }

  if (step === 'configure' && selectedType) {
    return (
      <StepConfigure
        sourceType={selectedType}
        onBack={() => setStep('pick')}
        onSourceAdded={onSourceAdded}
      />
    )
  }

  return <StepPick onPick={handlePick} onSelectMcp={onSelectMcp} />
}
