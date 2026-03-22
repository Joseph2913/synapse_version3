import { useState, useEffect } from 'react'
import { X, Pause, RefreshCw, PlayCircle, Link, Check, Save, ChevronDown, ChevronUp, Zap, Pencil, Trash2, Unlink, Copy } from 'lucide-react'
import type { AutomationSource, IngestedItem, SourceSettings } from '../../services/automationSources'
import {
  updateSourceStatus, disconnectSource, deleteSource, triggerManualScan,
  updateSourceSettings, updateSourceName, fetchIngestedContent,
  callScanNowAPI, callProcessNowAPI,
} from '../../services/automationSources'
import { StatusLabel, StatusDot } from '../shared/StatusIndicator'
import { useSourceQueue } from '../../hooks/useSourceQueue'
import { useSettings } from '../../hooks/useSettings'
import { useAuth } from '../../hooks/useAuth'
import { EXTRACTION_MODES, ANCHOR_EMPHASIS_LEVELS } from '../../config/extractionModes'
import { getEntityColor } from '../../config/entityTypes'

interface SourceDetailPanelProps {
  source: AutomationSource
  onClose: () => void
  onRefetch: () => Promise<void>
}

function getCategoryColor(category: AutomationSource['category']): string {
  if (category === 'youtube-playlist') return '#ef4444'
  if (category === 'microsoft') return '#0078d4'
  return '#3b82f6'
}

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

function getModeColor(mode: string): string {
  switch (mode) {
    case 'comprehensive': return '#0891b2'
    case 'strategic': return '#e11d48'
    case 'actionable': return '#2563eb'
    case 'relational': return '#7c3aed'
    default: return '#6b7280'
  }
}

function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `rgba(${r},${g},${b},${alpha})`
}

const QUEUE_STEPS = ['queued', 'fetching', 'extracting', 'connecting', 'complete'] as const
type QueueStep = typeof QUEUE_STEPS[number]

function stepIndex(step: QueueStep): number {
  return QUEUE_STEPS.indexOf(step)
}

function QueueItemRow({ item }: { item: { id: string; title: string; status: string; step: QueueStep; error?: string; nodes?: number; edges?: number } }) {
  const currentIdx = stepIndex(item.step)
  const isProcessing = item.status === 'processing'
  const isFailed = item.status === 'failed'
  const isComplete = item.status === 'complete'

  return (
    <div style={{ padding: '10px 12px', borderRadius: 8, background: 'var(--color-bg-inset)', border: '1px solid var(--border-subtle)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
        <span className="font-body" style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-primary)', flex: 1, marginRight: 8, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {item.title}
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
          <StatusDot
            status={item.status === 'complete' ? 'active' : item.status === 'failed' ? 'error' : item.status === 'processing' ? 'connected' : 'paused'}
            size={5}
            pulse={isProcessing}
          />
          <span className="font-body" style={{ fontSize: 9, fontWeight: 600, color: item.status === 'complete' ? '#22c55e' : item.status === 'failed' ? '#ef4444' : item.status === 'processing' ? '#3b82f6' : 'var(--color-text-secondary)', textTransform: 'capitalize' }}>
            {item.status}
          </span>
        </span>
      </div>
      {!isComplete && (
        <div style={{ display: 'flex', gap: 2 }}>
          {QUEUE_STEPS.map((step, idx) => {
            const isDone = idx < currentIdx
            const isCurrent = idx === currentIdx
            return (
              <div key={step} style={{ flex: 1, height: 2, borderRadius: 1, background: isDone ? '#22c55e' : isCurrent && isFailed ? '#ef4444' : isCurrent ? '#3b82f6' : 'var(--color-bg-active, #e5e7eb)' }} />
            )
          })}
        </div>
      )}
      {isFailed && item.error && (
        <div style={{ marginTop: 6 }}>
          <span className="font-body" style={{ fontSize: 10, color: '#ef4444' }}>{item.error}</span>
        </div>
      )}
      {isComplete && (item.nodes !== undefined || item.edges !== undefined) && (
        <div className="font-body" style={{ fontSize: 10, color: 'var(--color-text-secondary)', marginTop: 4 }}>
          {item.nodes ?? 0} entities · {item.edges ?? 0} edges
        </div>
      )}
    </div>
  )
}

function IngestedItemRow({ item, isLast }: { item: IngestedItem; isLast: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 0', borderBottom: isLast ? 'none' : '1px solid var(--border-subtle)' }}>
      <span className="font-body" style={{ fontSize: 12, color: 'var(--color-text-body)', flex: 1, marginRight: 10, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {item.title}
      </span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
        {item.nodes !== undefined && (
          <span className="font-body" style={{ fontSize: 10, color: 'var(--color-text-secondary)' }}>
            {item.nodes} nodes
          </span>
        )}
        <span className="font-body" style={{ fontSize: 10, color: 'var(--color-text-placeholder)' }}>
          {item.ingestedAt}
        </span>
      </div>
    </div>
  )
}

// ─── Edit panel (full profile + extraction settings) ──────────────────────────

interface EditPanelProps {
  source: AutomationSource
  onCancel: () => void
  onSaved: () => Promise<void>
}

function EditPanel({ source, onCancel, onSaved }: EditPanelProps) {
  const { anchors } = useSettings()
  const { user } = useAuth()
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [webhookCopied, setWebhookCopied] = useState(false)

  const [editName, setEditName] = useState(source.name)
  const [editMode, setEditMode] = useState(source.mode)
  const [editEmphasis, setEditEmphasis] = useState(source.emphasis)
  const [editAnchorIds, setEditAnchorIds] = useState<string[]>(source.linkedAnchors)
  const [editInstructions, setEditInstructions] = useState(source.customInstructions ?? '')

  const isMeetingSource = source.category === 'meeting'
  const webhookUrl = isMeetingSource && user
    ? `${window.location.origin}/api/meetings/webhook?uid=${user.id}`
    : ''

  const handleSave = async () => {
    setSaving(true)
    setSaveError(null)
    try {
      if (editName.trim() && editName.trim() !== source.name) {
        await updateSourceName(source.id, source.category, editName.trim())
      }
      const settings: SourceSettings = {
        mode: editMode,
        emphasis: editEmphasis,
        linkedAnchorIds: editAnchorIds,
        customInstructions: editInstructions || undefined,
      }
      await updateSourceSettings(source.id, source.category, settings)
      await onSaved()
      onCancel()
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  const toggleAnchor = (id: string) => {
    setEditAnchorIds(prev => prev.includes(id) ? prev.filter(a => a !== id) : [...prev, id])
  }

  const editModeColor = getModeColor(editMode)

  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <SL style={{ marginBottom: 0 }}>Edit Source</SL>
        <div style={{ display: 'flex', gap: 6 }}>
          <button type="button" onClick={onCancel} className="font-body" style={{ fontSize: 11, color: 'var(--color-text-secondary)', background: 'transparent', border: 'none', cursor: 'pointer' }}>
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={saving}
            className="font-body font-semibold"
            style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '4px 12px', borderRadius: 6, border: 'none', background: 'var(--color-accent-500)', color: 'white', fontSize: 11, cursor: saving ? 'not-allowed' : 'pointer', opacity: saving ? 0.6 : 1 }}
          >
            <Save size={11} /> {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>

      {saveError && (
        <p className="font-body" style={{ fontSize: 11, color: '#ef4444', marginBottom: 10 }}>{saveError}</p>
      )}

      {/* Name */}
      <SL style={{ marginBottom: 6 }}>Name</SL>
      <input
        type="text"
        value={editName}
        onChange={e => setEditName(e.target.value)}
        placeholder="Source name"
        className="font-body"
        style={{
          width: '100%', fontSize: 12, color: 'var(--color-text-body)',
          background: 'var(--color-bg-inset)', border: '1px solid var(--border-subtle)',
          borderRadius: 8, padding: '8px 12px', outline: 'none', boxSizing: 'border-box',
          transition: 'border-color 0.15s, box-shadow 0.15s', fontFamily: 'var(--font-body)', marginBottom: 14,
        }}
        onFocus={e => { e.currentTarget.style.borderColor = 'rgba(214,58,0,0.3)'; e.currentTarget.style.boxShadow = '0 0 0 3px var(--color-accent-50)' }}
        onBlur={e => { e.currentTarget.style.borderColor = 'var(--border-subtle)'; e.currentTarget.style.boxShadow = 'none' }}
      />

      {/* Webhook URL (meeting sources only) */}
      {isMeetingSource && webhookUrl && (
        <>
          <SL style={{ marginBottom: 6 }}>Webhook URL</SL>
          <p className="font-body" style={{ fontSize: 11, color: 'var(--color-text-secondary)', margin: '0 0 8px', lineHeight: 1.4 }}>
            Paste this into your Circleback Automation webhook action.
          </p>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 14 }}>
            <div
              className="font-body"
              style={{
                flex: 1,
                padding: '7px 10px',
                borderRadius: 8,
                background: 'var(--color-bg-inset)',
                border: '1px solid var(--border-subtle)',
                fontSize: 10,
                color: 'var(--color-text-secondary)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                fontFamily: 'monospace',
              }}
            >
              {webhookUrl}
            </div>
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard.writeText(webhookUrl).then(() => {
                  setWebhookCopied(true)
                  setTimeout(() => setWebhookCopied(false), 2000)
                })
              }}
              className="font-body font-semibold"
              style={{
                display: 'flex', alignItems: 'center', gap: 4,
                padding: '7px 10px', borderRadius: 8,
                border: '1px solid var(--border-subtle)',
                background: 'var(--color-bg-card)',
                fontSize: 10, cursor: 'pointer',
                color: webhookCopied ? '#22c55e' : 'var(--color-text-body)',
                flexShrink: 0, transition: 'color 0.15s',
              }}
            >
              {webhookCopied ? <Check size={11} /> : <Copy size={11} />}
              {webhookCopied ? 'Copied!' : 'Copy'}
            </button>
          </div>
        </>
      )}

      {/* Extraction Mode */}
      <SL style={{ marginBottom: 6 }}>Extraction Mode</SL>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginBottom: 14 }}>
        {EXTRACTION_MODES.map(m => {
          const active = editMode === m.id
          return (
            <button
              key={m.id} type="button" onClick={() => setEditMode(m.id)} className="font-body"
              style={{ padding: '8px 10px', borderRadius: 8, border: active ? `1.5px solid ${m.colorHex}` : '1px solid var(--border-subtle)', background: active ? hexToRgba(m.colorHex, 0.06) : 'var(--color-bg-inset)', cursor: 'pointer', textAlign: 'left', transition: 'all 0.15s' }}
            >
              <div style={{ fontSize: 11, fontWeight: 700, color: active ? m.colorHex : 'var(--color-text-body)', marginBottom: 2 }}>{m.label}</div>
              <div style={{ fontSize: 10, color: 'var(--color-text-secondary)', lineHeight: 1.3 }}>{m.description}</div>
            </button>
          )
        })}
      </div>

      {/* Anchor Emphasis */}
      <SL style={{ marginBottom: 6 }}>Anchor Emphasis</SL>
      <div style={{ display: 'flex', gap: 5, marginBottom: 14 }}>
        {ANCHOR_EMPHASIS_LEVELS.map(lvl => {
          const active = editEmphasis === lvl.id
          return (
            <button
              key={lvl.id} type="button" onClick={() => setEditEmphasis(lvl.id)} className="font-body font-semibold"
              style={{ flex: 1, padding: '6px 8px', borderRadius: 7, border: active ? '1.5px solid rgba(214,58,0,0.3)' : '1px solid var(--border-subtle)', background: active ? 'var(--color-accent-50)' : 'transparent', color: active ? 'var(--color-accent-500)' : 'var(--color-text-secondary)', fontSize: 11, cursor: 'pointer', transition: 'all 0.15s', textAlign: 'center' }}
            >
              {lvl.label}
            </button>
          )
        })}
      </div>

      {/* Focus Anchors */}
      {anchors.length > 0 && (
        <>
          <SL style={{ marginBottom: 6 }}>Focus Anchors</SL>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginBottom: 14 }}>
            {anchors.map(anchor => {
              const active = editAnchorIds.includes(anchor.id)
              const color = getEntityColor(anchor.entity_type)
              return (
                <button
                  key={anchor.id} type="button" onClick={() => toggleAnchor(anchor.id)} className="font-body font-semibold cursor-pointer"
                  style={{ padding: '4px 10px', borderRadius: 6, fontSize: 11, border: `1px solid ${active ? hexToRgba(color, 0.2) : 'var(--border-subtle)'}`, background: active ? hexToRgba(color, 0.07) : 'transparent', color: active ? color : 'var(--color-text-secondary)', transition: 'all 0.15s', display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}
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
      <SL style={{ marginBottom: 6 }}>Custom Instructions</SL>
      <textarea
        value={editInstructions}
        onChange={e => setEditInstructions(e.target.value)}
        placeholder="e.g. Focus on strategic insights and key decisions…"
        rows={3}
        className="font-body"
        style={{
          width: '100%', fontSize: 12, color: 'var(--color-text-body)',
          background: 'var(--color-bg-inset)', border: '1px solid var(--border-subtle)',
          borderRadius: 8, padding: '8px 12px', outline: 'none', resize: 'vertical',
          boxSizing: 'border-box', transition: 'border-color 0.15s, box-shadow 0.15s', fontFamily: 'var(--font-body)',
        }}
        onFocus={e => { e.currentTarget.style.borderColor = 'rgba(214,58,0,0.3)'; e.currentTarget.style.boxShadow = '0 0 0 3px var(--color-accent-50)' }}
        onBlur={e => { e.currentTarget.style.borderColor = 'var(--border-subtle)'; e.currentTarget.style.boxShadow = 'none' }}
      />

      {/* Hidden for TS reference */}
      <div style={{ display: 'none' }}>{editModeColor}</div>
    </div>
  )
}

// ─── Read-only settings display ──────────────────────────────────────────────

function SettingsReadView({ source }: { source: AutomationSource }) {
  const { anchors } = useSettings()
  const modeColor = getModeColor(source.mode)
  const resolvedAnchors = anchors.filter(a => source.linkedAnchors.includes(a.id))

  return (
    <div style={{ padding: '14px 16px', borderRadius: 10, background: 'var(--color-bg-inset)', border: '1px solid var(--border-subtle)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <span className="font-body" style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-secondary)' }}>Mode</span>
        <span className="font-body" style={{ padding: '1px 7px', borderRadius: 4, fontSize: 10, fontWeight: 700, background: modeColor + '14', color: modeColor, textTransform: 'capitalize' }}>
          {source.mode}
        </span>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <span className="font-body" style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-secondary)' }}>Emphasis</span>
        <span className="font-body" style={{ fontSize: 11, fontWeight: 500, color: 'var(--color-text-body)', textTransform: 'capitalize' }}>{source.emphasis}</span>
      </div>
      <div style={{ marginBottom: 10 }}>
        <div className="font-body" style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-secondary)', marginBottom: 6 }}>Linked Anchors</div>
        {resolvedAnchors.length > 0 ? (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {resolvedAnchors.map(a => {
              const color = getEntityColor(a.entity_type)
              return (
                <span key={a.id} className="font-body" style={{ padding: '2px 7px', borderRadius: 4, fontSize: 10, fontWeight: 600, background: hexToRgba(color, 0.08), color, border: `1px solid ${hexToRgba(color, 0.2)}` }}>
                  {a.label}
                </span>
              )
            })}
          </div>
        ) : (
          <span className="font-body" style={{ fontSize: 11, color: 'var(--color-text-placeholder)' }}>No anchors linked</span>
        )}
      </div>
      <div>
        <div className="font-body" style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-secondary)', marginBottom: 4 }}>Custom Instructions</div>
        {source.customInstructions ? (
          <p className="font-body" style={{ fontSize: 11, color: 'var(--color-text-body)', lineHeight: 1.5, margin: 0 }}>{source.customInstructions}</p>
        ) : (
          <span className="font-body" style={{ fontSize: 11, color: 'var(--color-text-placeholder)' }}>None set</span>
        )}
      </div>
    </div>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

export function SourceDetailPanel({ source, onClose, onRefetch }: SourceDetailPanelProps) {
  const { items, loading: queueLoading, refetch: refetchQueue } = useSourceQueue(
    source.category === 'meeting' ? null : source.id,
    source.category
  )
  const { session } = useAuth()
  const [actionLoading, setActionLoading] = useState(false)
  const [scanLoading, setScanLoading] = useState(false)
  const [processLoading, setProcessLoading] = useState(false)
  const [scanResult, setScanResult] = useState<string | null>(null)
  const [processResult, setProcessResult] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [ingestedItems, setIngestedItems] = useState<IngestedItem[]>([])
  const [ingestedLoading, setIngestedLoading] = useState(true)
  const [showAllIngested, setShowAllIngested] = useState(false)
  const [isEditing, setIsEditing] = useState(false)
  const [urlCopied, setUrlCopied] = useState(false)

  const catColor = getCategoryColor(source.category)
  const itemsIngested = source.videosIngested ?? source.meetingsIngested ?? 0
  const itemsInQueue = source.queue.pending
  const itemsProcessing = source.queue.processing

  useEffect(() => {
    setIngestedLoading(true)
    setIngestedItems([])
    fetchIngestedContent(source.id, source.category)
      .then(setIngestedItems)
      .catch(err => console.warn('[SourceDetailPanel] fetchIngestedContent:', err))
      .finally(() => setIngestedLoading(false))
  }, [source.id, source.category])

  // Reset edit state when source changes
  useEffect(() => { setIsEditing(false) }, [source.id])

  const handlePause = async () => {
    setActionLoading(true)
    try { await updateSourceStatus(source.id, source.category, 'paused'); await onRefetch() }
    catch (err) { console.warn('[SourceDetailPanel] pause error:', err) }
    finally { setActionLoading(false) }
  }

  const handleResume = async () => {
    setActionLoading(true)
    try { await updateSourceStatus(source.id, source.category, 'active'); await onRefetch() }
    catch (err) { console.warn('[SourceDetailPanel] resume error:', err) }
    finally { setActionLoading(false) }
  }

  const handleScanNow = async () => {
    setScanLoading(true)
    setScanResult(null)
    setActionError(null)
    try {
      if (source.category === 'microsoft' && session?.access_token) {
        // Microsoft: trigger a delta sync instead of YouTube scan
        const syncRes = await fetch('/api/microsoft/sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        })
        if (!syncRes.ok) throw new Error('Sync failed')
        const data = await syncRes.json() as { results?: Array<{ eventsQueued?: number; messagesQueued?: number }> }
        const r = data.results?.[0]
        const total = (r?.eventsQueued ?? 0) + (r?.messagesQueued ?? 0)
        setScanResult(`${total} item${total !== 1 ? 's' : ''} synced`)
      } else if (session?.access_token) {
        const result = await callScanNowAPI(session.access_token)
        setScanResult(`${result.newVideosQueued} new video${result.newVideosQueued !== 1 ? 's' : ''} queued`)
      } else {
        await triggerManualScan(source.id, source.category)
        setScanResult('Scan triggered')
      }
      await onRefetch()
      refetchQueue()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Scan failed')
    } finally {
      setScanLoading(false)
    }
  }

  const handleProcessNow = async () => {
    setProcessLoading(true)
    setProcessResult(null)
    setActionError(null)
    try {
      if (!session?.access_token) throw new Error('Not authenticated')
      const sourceType = source.category === 'microsoft' ? 'microsoft' as const
        : source.category === 'meeting' ? 'meeting' as const : 'youtube' as const
      const result = await callProcessNowAPI(session.access_token, sourceType)
      setProcessResult(`${result.processed} item${result.processed !== 1 ? 's' : ''} processed`)
      await onRefetch()
      refetchQueue()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Processing failed')
    } finally {
      setProcessLoading(false)
    }
  }

  const handleDisconnect = async () => {
    if (!confirm(`Disconnect "${source.name}"? The source will be deactivated but historical data will be preserved.`)) return
    setActionLoading(true)
    try { await disconnectSource(source.id, source.category); await onRefetch(); onClose() }
    catch (err) { console.warn('[SourceDetailPanel] disconnect error:', err) }
    finally { setActionLoading(false) }
  }

  const handleDelete = async () => {
    if (!confirm(`Delete "${source.name}"? This will permanently remove the source and all its queue items. Extracted knowledge (nodes/edges) will be preserved.`)) return
    setActionLoading(true)
    try { await deleteSource(source.id, source.category); await onRefetch(); onClose() }
    catch (err) { console.warn('[SourceDetailPanel] delete error:', err) }
    finally { setActionLoading(false) }
  }

  const visibleIngested = showAllIngested ? ingestedItems : ingestedItems.slice(0, 10)
  const isMeeting = source.category === 'meeting'
  const contentLabel = isMeeting ? 'Meetings' : 'Videos'

  // ── Edit mode ────────────────────────────────────────────────────────────
  if (isEditing) {
    return (
      <div style={{ height: '100%', overflowY: 'auto', background: 'var(--color-bg-card)', borderLeft: '1px solid var(--border-subtle)', animation: 'slideInRight 0.2s ease' }}>
        <div style={{ padding: '24px 28px' }}>
          {/* Header */}
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 20 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ width: 36, height: 36, borderRadius: 9, background: catColor + '1f', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                {source.iconUrl
                ? <img src={source.iconUrl} alt="" width={18} height={18} style={{ borderRadius: 4, objectFit: 'cover' }} />
                : <span style={{ fontSize: 18 }}>{isMeeting ? '🎙' : '▶'}</span>}
              </div>
              <div>
                <div className="font-display" style={{ fontSize: 16, fontWeight: 700, color: 'var(--color-text-primary)', lineHeight: 1.2 }}>Edit Source</div>
                <div className="font-body" style={{ fontSize: 11, color: 'var(--color-text-secondary)', marginTop: 2 }}>{source.name}</div>
              </div>
            </div>
            <button type="button" onClick={() => setIsEditing(false)} style={{ background: 'transparent', border: 'none', padding: '4px 6px', borderRadius: 6, cursor: 'pointer', color: 'var(--color-text-secondary)', flexShrink: 0 }}>
              <X size={14} />
            </button>
          </div>

          <EditPanel source={source} onCancel={() => setIsEditing(false)} onSaved={onRefetch} />
        </div>
      </div>
    )
  }

  // ── Normal view ──────────────────────────────────────────────────────────
  return (
    <div style={{ height: '100%', overflowY: 'auto', background: 'var(--color-bg-card)', borderLeft: '1px solid var(--border-subtle)', animation: 'slideInRight 0.2s ease' }}>
      <div style={{ padding: '24px 28px' }}>

        {/* ── Header ─────────────────────────────────────────────────── */}
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 20 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ width: 36, height: 36, borderRadius: 9, background: catColor + '1f', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              {source.iconUrl
                ? <img src={source.iconUrl} alt="" width={18} height={18} style={{ borderRadius: 4, objectFit: 'cover' }} />
                : <span style={{ fontSize: 18 }}>{isMeeting ? '🎙' : '▶'}</span>}
            </div>
            <div>
              <div className="font-display" style={{ fontSize: 16, fontWeight: 700, color: 'var(--color-text-primary)', lineHeight: 1.2 }}>{source.name}</div>
              <div className="font-body" style={{ fontSize: 11, color: 'var(--color-text-secondary)', marginTop: 2 }}>
                {source.handle ?? source.channel ?? (isMeeting ? 'Meeting Integration' : 'YouTube Playlist')}
              </div>
            </div>
          </div>
          <button type="button" onClick={onClose} style={{ background: 'transparent', border: 'none', padding: '4px 6px', borderRadius: 6, cursor: 'pointer', color: 'var(--color-text-secondary)', flexShrink: 0 }}>
            <X size={14} />
          </button>
        </div>

        {/* Status */}
        <div style={{ marginBottom: 16 }}>
          <StatusLabel status={source.status} />
        </div>

        {/* ── Quick actions ──────────────────────────────────────────── */}
        <div style={{ marginBottom: 24 }}>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {(source.status === 'active' || source.status === 'connected') && (
              <>
                <button
                  type="button" onClick={() => void handlePause()} disabled={actionLoading || isMeeting}
                  className="font-body font-semibold"
                  style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '7px 14px', borderRadius: 8, border: '1px solid var(--border-subtle)', background: 'var(--color-bg-card)', color: 'var(--color-text-body)', fontSize: 11, cursor: actionLoading || isMeeting ? 'not-allowed' : 'pointer', opacity: isMeeting ? 0.4 : 1 }}
                >
                  <Pause size={12} /> Pause
                </button>
                <button
                  type="button" onClick={() => setIsEditing(true)}
                  className="font-body font-semibold"
                  style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '7px 14px', borderRadius: 8, border: '1px solid var(--border-subtle)', background: 'var(--color-bg-card)', color: 'var(--color-text-body)', fontSize: 11, cursor: 'pointer' }}
                >
                  <Pencil size={12} /> Edit
                </button>
                {isMeeting && session?.user?.id && (
                  <button
                    type="button"
                    onClick={() => {
                      const url = `${window.location.origin}/api/meetings/webhook?uid=${session.user.id}`
                      void navigator.clipboard.writeText(url).then(() => {
                        setUrlCopied(true)
                        setTimeout(() => setUrlCopied(false), 2000)
                      })
                    }}
                    className="font-body font-semibold"
                    style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '7px 14px', borderRadius: 8, border: '1px solid var(--border-subtle)', background: 'var(--color-bg-card)', color: urlCopied ? '#22c55e' : 'var(--color-text-body)', fontSize: 11, cursor: 'pointer', transition: 'color 0.15s' }}
                  >
                    {urlCopied ? <Check size={12} /> : <Copy size={12} />}
                    {urlCopied ? 'Copied!' : 'Copy URL'}
                  </button>
                )}
                {!isMeeting && (
                  <button
                    type="button" onClick={() => void handleScanNow()} disabled={scanLoading}
                    className="font-body font-semibold"
                    style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '7px 14px', borderRadius: 8, border: '1px solid var(--border-subtle)', background: 'var(--color-bg-card)', color: 'var(--color-text-body)', fontSize: 11, cursor: scanLoading ? 'not-allowed' : 'pointer', opacity: scanLoading ? 0.6 : 1 }}
                  >
                    <RefreshCw size={12} style={{ animation: scanLoading ? 'spin 1s linear infinite' : 'none' }} />
                    {scanLoading ? 'Scanning…' : source.category === 'microsoft' ? 'Sync Now' : 'Scan Now'}
                  </button>
                )}
                {source.queue.pending > 0 && (
                  <button
                    type="button" onClick={() => void handleProcessNow()} disabled={processLoading}
                    className="font-body font-semibold"
                    style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '7px 14px', borderRadius: 8, border: '1px solid rgba(214,58,0,0.25)', background: 'var(--color-accent-50)', color: 'var(--color-accent-500)', fontSize: 11, cursor: processLoading ? 'not-allowed' : 'pointer', opacity: processLoading ? 0.6 : 1 }}
                  >
                    <Zap size={12} />
                    {processLoading ? 'Processing…' : 'Process Now'}
                  </button>
                )}
              </>
            )}
            {source.status === 'paused' && (
              <>
                <button
                  type="button" onClick={() => void handleResume()} disabled={actionLoading}
                  className="font-body font-semibold"
                  style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '7px 14px', borderRadius: 8, border: '1px solid rgba(34,197,94,0.3)', background: 'rgba(34,197,94,0.06)', color: '#15803d', fontSize: 11, cursor: actionLoading ? 'not-allowed' : 'pointer' }}
                >
                  <PlayCircle size={12} /> Resume
                </button>
                <button
                  type="button" onClick={() => setIsEditing(true)}
                  className="font-body font-semibold"
                  style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '7px 14px', borderRadius: 8, border: '1px solid var(--border-subtle)', background: 'var(--color-bg-card)', color: 'var(--color-text-body)', fontSize: 11, cursor: 'pointer' }}
                >
                  <Pencil size={12} /> Edit
                </button>
              </>
            )}
            {source.status === 'disconnected' && (
              <button type="button" className="font-body font-semibold" style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '7px 14px', borderRadius: 8, border: 'none', background: 'var(--color-accent-500)', color: 'white', fontSize: 11, cursor: 'pointer' }}>
                <Link size={12} /> Connect
              </button>
            )}
          </div>

          {/* Inline feedback */}
          {(scanResult ?? processResult ?? actionError) && (
            <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
              {actionError ? (
                <span className="font-body" style={{ fontSize: 11, color: '#ef4444' }}>{actionError}</span>
              ) : (
                <>
                  <Check size={11} style={{ color: '#22c55e', flexShrink: 0 }} />
                  <span className="font-body" style={{ fontSize: 11, color: '#15803d' }}>{scanResult ?? processResult}</span>
                </>
              )}
            </div>
          )}
        </div>

        {/* ── Stats grid (3 columns) ─────────────────────────────────── */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: 28 }}>
          {[
            { label: `${contentLabel} Ingested`, value: itemsIngested, color: '#22c55e' },
            { label: 'In Queue', value: itemsInQueue, color: '#f59e0b' },
            { label: 'Processing', value: itemsProcessing, color: '#3b82f6' },
          ].map(stat => (
            <div key={stat.label} style={{ padding: '12px 8px', borderRadius: 8, background: 'var(--color-bg-inset)', textAlign: 'center' }}>
              <div className="font-display" style={{ fontSize: 20, fontWeight: 800, color: stat.value > 0 ? stat.color : 'var(--color-text-primary)' }}>{stat.value}</div>
              <div className="font-body" style={{ fontSize: 9, fontWeight: 600, color: 'var(--color-text-secondary)' }}>{stat.label}</div>
            </div>
          ))}
        </div>

        {/* ── Ingested Content ──────────────────────────────────────── */}
        <div style={{ marginBottom: 28 }}>
          <SL>{contentLabel} Ingested ({ingestedItems.length})</SL>

          {ingestedLoading ? (
            <p className="font-body" style={{ fontSize: 11, color: 'var(--color-text-secondary)', padding: '8px 0' }}>Loading…</p>
          ) : ingestedItems.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '20px 0' }}>
              <Check size={18} style={{ color: 'var(--color-text-placeholder)', margin: '0 auto 6px' }} />
              <p className="font-body" style={{ fontSize: 11, color: 'var(--color-text-placeholder)' }}>
                No {contentLabel.toLowerCase()} ingested yet
              </p>
            </div>
          ) : (
            <div style={{ background: 'var(--color-bg-inset)', border: '1px solid var(--border-subtle)', borderRadius: 10, padding: '0 14px' }}>
              {visibleIngested.map((item, i) => (
                <IngestedItemRow key={item.id} item={item} isLast={i === visibleIngested.length - 1} />
              ))}
              {ingestedItems.length > 10 && (
                <button
                  type="button" onClick={() => setShowAllIngested(p => !p)} className="font-body"
                  style={{ display: 'flex', alignItems: 'center', gap: 4, width: '100%', padding: '10px 0', background: 'transparent', border: 'none', borderTop: '1px solid var(--border-subtle)', cursor: 'pointer', fontSize: 11, color: 'var(--color-text-secondary)', justifyContent: 'center' }}
                >
                  {showAllIngested ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                  {showAllIngested ? 'Show less' : `Show all ${ingestedItems.length}`}
                </button>
              )}
            </div>
          )}
        </div>

        {/* ── Extraction Settings (read-only) ────────────────────────── */}
        <div style={{ marginBottom: 28 }}>
          <SL>Extraction Settings</SL>
          <SettingsReadView source={source} />
        </div>

        {/* ── Queue ─────────────────────────────────────────────────── */}
        {!isMeeting && (
          <div style={{ marginBottom: 28 }}>
            <SL>Processing Queue ({items.length})</SL>
            {queueLoading ? (
              <p className="font-body" style={{ fontSize: 11, color: 'var(--color-text-secondary)', padding: '8px 0' }}>Loading queue…</p>
            ) : items.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '16px 0' }}>
                <Check size={18} style={{ color: 'var(--color-text-placeholder)', margin: '0 auto 6px' }} />
                <p className="font-body" style={{ fontSize: 11, color: 'var(--color-text-placeholder)' }}>Queue is empty</p>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {items.map(item => <QueueItemRow key={item.id} item={item} />)}
              </div>
            )}
          </div>
        )}

        {/* ── Danger zone ───────────────────────────────────────────── */}
        <div style={{ paddingTop: 16, borderTop: '1px solid var(--border-subtle)', display: 'flex', flexDirection: 'column', gap: 10 }}>
          <button
            type="button" onClick={() => void handleDisconnect()} disabled={actionLoading}
            className="font-body"
            style={{ display: 'flex', alignItems: 'center', gap: 5, padding: 0, background: 'transparent', border: 'none', cursor: actionLoading ? 'not-allowed' : 'pointer', fontSize: 11, fontWeight: 500, color: '#f59e0b', opacity: actionLoading ? 0.5 : 0.7, transition: 'opacity 0.15s' }}
            onMouseEnter={e => { e.currentTarget.style.opacity = '1' }}
            onMouseLeave={e => { e.currentTarget.style.opacity = actionLoading ? '0.5' : '0.7' }}
          >
            <Unlink size={12} />
            Disconnect Source
          </button>
          <button
            type="button" onClick={() => void handleDelete()} disabled={actionLoading}
            className="font-body"
            style={{ display: 'flex', alignItems: 'center', gap: 5, padding: 0, background: 'transparent', border: 'none', cursor: actionLoading ? 'not-allowed' : 'pointer', fontSize: 11, fontWeight: 500, color: '#ef4444', opacity: actionLoading ? 0.5 : 0.7, transition: 'opacity 0.15s' }}
            onMouseEnter={e => { e.currentTarget.style.opacity = '1' }}
            onMouseLeave={e => { e.currentTarget.style.opacity = actionLoading ? '0.5' : '0.7' }}
          >
            <Trash2 size={12} />
            Delete Source
          </button>
        </div>
      </div>
    </div>
  )
}
