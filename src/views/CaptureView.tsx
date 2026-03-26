import { useState, useRef, useCallback, useEffect } from 'react'
import {
  Type, Globe, FileText, Mic, Link, Upload, Sparkles, Loader,
  GripVertical, Zap, type LucideIcon,
} from 'lucide-react'
import { useNavigate, useLocation } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'
import { useSettings } from '../hooks/useSettings'
import { useExtraction } from '../hooks/useExtraction'
import { extractTextFromFile } from '../utils/fileParser'
import { ExtractionPipeline } from '../components/ingest/ExtractionPipeline'
import { buildPostExtractionContext } from '../config/chatEntryContexts'
import { EXTRACTION_MODES, ANCHOR_EMPHASIS_LEVELS } from '../config/extractionModes'
import { getEntityColor } from '../config/entityTypes'
import type { ExtractionConfig, ReviewEntity } from '../types/extraction'

// ─── Layout constants (mirrors HomeView) ────────────────────────────────────
const DEFAULT_LEFT_PCT = 64
const MIN_LEFT_PCT = 30
const MAX_LEFT_PCT = 82

// ─── Types ───────────────────────────────────────────────────────────────────
type CaptureMode = 'text' | 'url' | 'document' | 'transcript'

const MODES: { key: CaptureMode; label: string; Icon: LucideIcon }[] = [
  { key: 'text',       label: 'Text',       Icon: Type },
  { key: 'url',        label: 'URL',        Icon: Globe },
  { key: 'document',   label: 'Document',   Icon: FileText },
  { key: 'transcript', label: 'Transcript', Icon: Mic },
]

// ─── Helpers ──────────────────────────────────────────────────────────────────
function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `rgba(${r},${g},${b},${alpha})`
}

// ─── Small shared components ─────────────────────────────────────────────────

function SL({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div className="font-display font-bold uppercase" style={{
      fontSize: 10, letterSpacing: '0.08em',
      color: 'var(--color-text-secondary)', marginBottom: 8,
      ...style,
    }}>
      {children}
    </div>
  )
}

const CARD: React.CSSProperties = {
  background: 'var(--color-bg-card)',
  border: '1px solid var(--border-subtle)',
  borderRadius: 12,
  padding: '16px 20px',
}

const FOCUS = {
  onFocus: (e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    e.currentTarget.style.borderColor = 'rgba(214,58,0,0.3)'
    e.currentTarget.style.boxShadow = '0 0 0 3px var(--color-accent-50)'
  },
  onBlur: (e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    e.currentTarget.style.borderColor = 'var(--border-subtle)'
    e.currentTarget.style.boxShadow = 'none'
  },
}

function ExtractBtn({
  label, disabled, loading, onClick, charCount,
}: {
  label: string; disabled: boolean; loading?: boolean
  onClick: () => void; charCount?: number
}) {
  return (
    <div style={{
      borderTop: '1px solid var(--border-subtle)', paddingTop: 14,
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    }}>
      {charCount !== undefined
        ? <span className="font-body" style={{ fontSize: 11, color: 'var(--color-text-placeholder)' }}>{charCount.toLocaleString()} chars</span>
        : <span />}
      <button
        type="button" onClick={onClick} disabled={disabled}
        className="font-body font-semibold"
        style={{
          display: 'flex', alignItems: 'center', gap: 6,
          padding: '9px 22px', borderRadius: 8,
          background: 'var(--color-accent-500)', border: 'none', color: 'white',
          fontSize: 13, cursor: disabled ? 'not-allowed' : 'pointer',
          opacity: disabled ? 0.4 : 1, transition: 'opacity 0.15s',
          boxShadow: disabled ? 'none' : '0 2px 8px rgba(214,58,0,0.18)',
        }}
      >
        {loading
          ? <Loader size={14} style={{ animation: 'spin 1s linear infinite' }} />
          : <Sparkles size={14} />}
        {loading ? 'Extracting…' : label}
      </button>
    </div>
  )
}

// ─── Right-panel: idle preview ────────────────────────────────────────────────

function ExtractionPreview({
  mode, emphasis, selectedAnchorIds, customGuidance, anchors,
}: {
  mode: ExtractionConfig['mode']
  emphasis: ExtractionConfig['anchorEmphasis']
  selectedAnchorIds: string[]
  customGuidance: string
  anchors: { id: string; label: string; entity_type: string }[]
}) {
  const modeInfo = EXTRACTION_MODES.find(m => m.id === mode)
  const emphasisInfo = ANCHOR_EMPHASIS_LEVELS.find(e => e.id === emphasis)
  const selectedAnchors = anchors.filter(a => selectedAnchorIds.includes(a.id))

  return (
    <div style={{ padding: '28px 24px', height: '100%', overflowY: 'auto' }}>
      {/* Header */}
      <div style={{ marginBottom: 24 }}>
        <div className="font-display" style={{ fontSize: 14, fontWeight: 700, color: 'var(--color-text-primary)', marginBottom: 2 }}>
          Extraction Preview
        </div>
        <p className="font-body" style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
          Results will populate here as the pipeline runs.
        </p>
      </div>

      {/* Active mode card */}
      {modeInfo && (
        <div style={{
          padding: '14px 16px', borderRadius: 10, marginBottom: 12,
          border: `1px solid ${hexToRgba(modeInfo.colorHex, 0.22)}`,
          background: hexToRgba(modeInfo.colorHex, 0.05),
        }}>
          <div className="font-body font-semibold" style={{ fontSize: 12, color: modeInfo.colorHex, marginBottom: 3 }}>
            {modeInfo.label}
          </div>
          <div className="font-body" style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>
            {modeInfo.description}
          </div>
        </div>
      )}

      {/* Emphasis */}
      <div style={{
        padding: '12px 14px', borderRadius: 10, marginBottom: 12,
        background: 'var(--color-bg-card)', border: '1px solid var(--border-subtle)',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span className="font-body" style={{ fontSize: 11, color: 'var(--color-text-secondary)', fontWeight: 600 }}>
            Anchor Emphasis
          </span>
          <span className="font-body" style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-body)', textTransform: 'capitalize' }}>
            {emphasisInfo?.label ?? emphasis}
          </span>
        </div>
        {emphasisInfo && (
          <div className="font-body" style={{ fontSize: 10, color: 'var(--color-text-secondary)', marginTop: 3 }}>
            {emphasisInfo.description}
          </div>
        )}
      </div>

      {/* Focus anchors */}
      <div style={{
        padding: '12px 14px', borderRadius: 10, marginBottom: 12,
        background: 'var(--color-bg-card)', border: '1px solid var(--border-subtle)',
      }}>
        <div className="font-body" style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-secondary)', marginBottom: selectedAnchors.length ? 8 : 0 }}>
          Focus Anchors
        </div>
        {selectedAnchors.length > 0 ? (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {selectedAnchors.map(a => {
              const color = getEntityColor(a.entity_type)
              return (
                <span key={a.id} className="font-body" style={{
                  padding: '2px 8px', borderRadius: 5, fontSize: 10, fontWeight: 600,
                  background: hexToRgba(color, 0.08), color,
                  border: `1px solid ${hexToRgba(color, 0.18)}`,
                }}>
                  {a.label}
                </span>
              )
            })}
          </div>
        ) : (
          <span className="font-body" style={{ fontSize: 11, color: 'var(--color-text-placeholder)' }}>
            None — all entities weighted equally
          </span>
        )}
      </div>

      {/* Custom guidance */}
      {customGuidance.trim() && (
        <div style={{
          padding: '12px 14px', borderRadius: 10, marginBottom: 12,
          background: 'var(--color-bg-card)', border: '1px solid var(--border-subtle)',
        }}>
          <div className="font-body" style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-secondary)', marginBottom: 4 }}>
            Custom Guidance
          </div>
          <div className="font-body" style={{ fontSize: 11, color: 'var(--color-text-body)', lineHeight: 1.5, fontStyle: 'italic' }}>
            "{customGuidance}"
          </div>
        </div>
      )}

      {/* Idle prompt */}
      <div style={{
        marginTop: 8, padding: '18px 16px', borderRadius: 10,
        background: 'var(--color-bg-inset)', border: '1px dashed var(--border-subtle)',
        textAlign: 'center',
      }}>
        <Zap size={20} style={{ color: 'var(--color-text-placeholder)', margin: '0 auto 8px', display: 'block' }} />
        <p className="font-body" style={{ fontSize: 12, color: 'var(--color-text-secondary)', lineHeight: 1.5 }}>
          Add content on the left and click <strong>Extract Knowledge</strong> to start.
        </p>
      </div>
    </div>
  )
}

// ─── Inline Extraction Settings ───────────────────────────────────────────────

function ExtractionSettings({
  mode, onModeChange,
  emphasis, onEmphasisChange,
  selectedAnchorIds, onAnchorIdsChange,
  customGuidance, onGuidanceChange,
  anchors,
}: {
  mode: ExtractionConfig['mode']
  onModeChange: (m: ExtractionConfig['mode']) => void
  emphasis: ExtractionConfig['anchorEmphasis']
  onEmphasisChange: (e: ExtractionConfig['anchorEmphasis']) => void
  selectedAnchorIds: string[]
  onAnchorIdsChange: (ids: string[]) => void
  customGuidance: string
  onGuidanceChange: (g: string) => void
  anchors: { id: string; label: string; entity_type: string }[]
}) {
  const toggleAnchor = (id: string) =>
    onAnchorIdsChange(selectedAnchorIds.includes(id)
      ? selectedAnchorIds.filter(a => a !== id)
      : [...selectedAnchorIds, id])

  return (
    <div style={{ ...CARD, marginTop: 12 }}>
      {/* Extraction Mode */}
      <SL>Extraction Mode</SL>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginBottom: 16 }}>
        {EXTRACTION_MODES.map(m => {
          const sel = mode === m.id
          return (
            <button key={m.id} type="button" onClick={() => onModeChange(m.id)}
              className="text-left cursor-pointer"
              style={{
                padding: '10px 12px', borderRadius: 8,
                border: `1px solid ${sel ? hexToRgba(m.colorHex, 0.25) : 'var(--border-subtle)'}`,
                background: sel ? hexToRgba(m.colorHex, 0.06) : 'transparent',
                transition: 'all 0.15s',
              }}
            >
              <div className="font-body font-semibold" style={{ fontSize: 12, color: sel ? m.colorHex : 'var(--color-text-primary)' }}>
                {m.label}
              </div>
              <div className="font-body" style={{ fontSize: 10, color: 'var(--color-text-secondary)', marginTop: 2, lineHeight: 1.4 }}>
                {m.description}
              </div>
            </button>
          )
        })}
      </div>

      {/* Anchor Emphasis */}
      <SL>Anchor Emphasis</SL>
      <div style={{ display: 'flex', gap: 6, marginBottom: anchors.length > 0 ? 16 : 0 }}>
        {ANCHOR_EMPHASIS_LEVELS.map(level => {
          const sel = emphasis === level.id
          const color = '#b45309'
          return (
            <button key={level.id} type="button" onClick={() => onEmphasisChange(level.id)}
              className="font-body font-semibold cursor-pointer"
              style={{
                flex: 1, padding: '9px 8px', borderRadius: 8,
                textAlign: 'center', fontSize: 11,
                border: `1px solid ${sel ? hexToRgba(color, 0.25) : 'var(--border-subtle)'}`,
                background: sel ? hexToRgba(color, 0.06) : 'transparent',
                color: sel ? color : 'var(--color-text-secondary)',
                transition: 'all 0.15s',
              }}
            >
              <div>{level.label}</div>
              <div style={{ fontSize: 9, fontWeight: 400, marginTop: 2, color: sel ? hexToRgba(color, 0.7) : 'var(--color-text-placeholder)' }}>
                {level.description}
              </div>
            </button>
          )
        })}
      </div>

      {/* Focus Anchors */}
      {anchors.length > 0 && (
        <>
          <SL style={{ marginTop: 16 }}>Focus Anchors</SL>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginBottom: 16 }}>
            {anchors.map(anchor => {
              const active = selectedAnchorIds.includes(anchor.id)
              const color = getEntityColor(anchor.entity_type)
              return (
                <button key={anchor.id} type="button" onClick={() => toggleAnchor(anchor.id)}
                  className="font-body font-semibold cursor-pointer flex items-center gap-1"
                  style={{
                    padding: '4px 10px', borderRadius: 6, fontSize: 11,
                    border: `1px solid ${active ? hexToRgba(color, 0.2) : 'var(--border-subtle)'}`,
                    background: active ? hexToRgba(color, 0.07) : 'transparent',
                    color: active ? color : 'var(--color-text-secondary)',
                    transition: 'all 0.15s',
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

      {/* Custom Guidance */}
      <SL style={{ marginTop: anchors.length > 0 ? 0 : 16 }}>Custom Guidance</SL>
      <textarea
        value={customGuidance}
        onChange={e => onGuidanceChange(e.target.value)}
        placeholder="e.g. Focus on action items and decisions…"
        rows={2}
        className="font-body w-full resize-y"
        style={{
          fontSize: 12, color: 'var(--color-text-body)',
          background: 'var(--color-bg-inset)', border: '1px solid var(--border-subtle)',
          borderRadius: 8, padding: '8px 12px', outline: 'none',
          width: '100%', boxSizing: 'border-box',
          transition: 'border-color 0.15s, box-shadow 0.15s',
        }}
        {...FOCUS}
      />
    </div>
  )
}

// ─── Main CaptureView ─────────────────────────────────────────────────────────

interface ReExtractSource {
  id: string
  title?: string
  content: string
  sourceType?: string
  sourceUrl?: string
  customInstructions?: string
}

export function CaptureView() {
  const navigate = useNavigate()
  const location = useLocation()
  const { session } = useAuth()
  const { profile, extractionSettings, anchors } = useSettings()
  const { state, start, approveAndSave, reExtract, reset } = useExtraction()

  // ── Input mode ──
  const [captureMode, setCaptureMode] = useState<CaptureMode>('text')

  // ── Text ──
  const [textTitle, setTextTitle] = useState('')
  const [textContent, setTextContent] = useState('')

  // ── URL ──
  const [urlValue, setUrlValue] = useState('')
  const [urlFetching, setUrlFetching] = useState(false)
  const [urlError, setUrlError] = useState<string | null>(null)

  // ── Document ──
  const [dragOver, setDragOver] = useState(false)
  const [docFile, setDocFile] = useState<File | null>(null)
  const [docContent, setDocContent] = useState('')
  const [docParsing, setDocParsing] = useState(false)
  const [docError, setDocError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // ── Transcript ──
  const [meetingTitle, setMeetingTitle] = useState('')
  const [meetingDate, setMeetingDate] = useState('')
  const [transcriptContent, setTranscriptContent] = useState('')

  // ── Extraction settings ──
  const [extractionMode, setExtractionMode] = useState<ExtractionConfig['mode']>(
    extractionSettings?.default_mode as ExtractionConfig['mode'] ?? 'comprehensive'
  )
  const [anchorEmphasis, setAnchorEmphasis] = useState<ExtractionConfig['anchorEmphasis']>(
    extractionSettings?.default_anchor_emphasis as ExtractionConfig['anchorEmphasis'] ?? 'standard'
  )
  const [selectedAnchorIds, setSelectedAnchorIds] = useState<string[]>([])
  const [customGuidance, setCustomGuidance] = useState('')

  // ── Resize ──
  const [leftWidthPct, setLeftWidthPct] = useState(DEFAULT_LEFT_PCT)
  const [isDragging, setIsDragging] = useState(false)
  const [isHandleHovered, setIsHandleHovered] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const dragStartX = useRef(0)
  const dragStartPct = useRef(DEFAULT_LEFT_PCT)

  // Sync extraction settings defaults
  useEffect(() => {
    if (extractionSettings) {
      setExtractionMode(extractionSettings.default_mode as ExtractionConfig['mode'] ?? 'comprehensive')
      setAnchorEmphasis(extractionSettings.default_anchor_emphasis as ExtractionConfig['anchorEmphasis'] ?? 'standard')
    }
  }, [extractionSettings])

  // ── Pre-fill from re-extract navigation state ───────────────────────────
  const reExtractHandled = useRef(false)
  useEffect(() => {
    if (reExtractHandled.current) return
    const navState = location.state as { reExtractSource?: ReExtractSource } | null
    if (!navState?.reExtractSource) return
    reExtractHandled.current = true
    const src = navState.reExtractSource
    // Pre-fill transcript mode with source content
    setCaptureMode('transcript')
    setMeetingTitle(src.title ?? '')
    setTranscriptContent(src.content)
    if (src.customInstructions) setCustomGuidance(src.customInstructions)
    // Clear navigation state so it doesn't persist on refresh
    window.history.replaceState({}, '')
  }, [location.state])

  // ── Drag-to-resize (mirrors HomeView) ────────────────────────────────────
  const handleDividerMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    dragStartX.current = e.clientX
    dragStartPct.current = leftWidthPct
    setIsDragging(true)

    const onMouseMove = (ev: MouseEvent) => {
      if (!containerRef.current) return
      const delta = ev.clientX - dragStartX.current
      const deltaPct = (delta / containerRef.current.offsetWidth) * 100
      setLeftWidthPct(Math.max(MIN_LEFT_PCT, Math.min(MAX_LEFT_PCT, dragStartPct.current + deltaPct)))
    }
    const onMouseUp = () => {
      setIsDragging(false)
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
    }
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }, [leftWidthPct])

  // ── Config builder ────────────────────────────────────────────────────────
  const buildConfig = useCallback((): ExtractionConfig => ({
    mode: extractionMode,
    anchorEmphasis,
    anchors: anchors
      .filter(a => selectedAnchorIds.includes(a.id))
      .map(a => ({ label: a.label, entity_type: a.entity_type, description: a.description ?? '' })),
    userProfile: profile,
    customGuidance: customGuidance || undefined,
  }), [extractionMode, anchorEmphasis, anchors, selectedAnchorIds, profile, customGuidance])

  // ── Extract triggers ──────────────────────────────────────────────────────
  const handleTextExtract = useCallback(async () => {
    if (!textContent.trim()) return
    await start(textContent.trim(), buildConfig(), { title: textTitle.trim() || undefined, sourceType: 'Note' })
  }, [textContent, textTitle, buildConfig, start])

  const handleUrlExtract = useCallback(async () => {
    const url = urlValue.trim()
    if (!url) return
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      setUrlError('URL must start with http:// or https://')
      return
    }
    const authToken = session?.access_token
    if (!authToken) { setUrlError('Not authenticated.'); return }
    setUrlError(null); setUrlFetching(true)
    try {
      const res = await fetch('/api/content/fetch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ url }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Failed to fetch URL' })) as { error?: string }
        throw new Error(err.error ?? `Fetch failed: ${res.status}`)
      }
      const data = await res.json() as { title?: string; content: string; url: string }
      if (!data.content?.trim()) { setUrlError('No readable content found at this URL.'); setUrlFetching(false); return }
      const isYT = url.includes('youtube.com/watch') || url.includes('youtu.be/')
      const content = data.title ? `# ${data.title}\nSource: ${data.url}\n\n${data.content}` : `Source: ${data.url}\n\n${data.content}`
      await start(content, buildConfig(), { title: data.title, sourceType: isYT ? 'YouTube' : 'Article', sourceUrl: data.url })
    } catch (err) {
      setUrlError(err instanceof Error ? err.message : 'Failed to fetch URL content')
    } finally {
      setUrlFetching(false)
    }
  }, [urlValue, session, buildConfig, start])

  const handleFileSelected = useCallback(async (file: File) => {
    setDocError(null); setDocParsing(true); setDocFile(file)
    try {
      const text = await extractTextFromFile(file)
      if (!text.trim()) { setDocError('No extractable text found in the file.'); setDocContent('') }
      else setDocContent(text)
    } catch (err) {
      setDocError(err instanceof Error ? err.message : 'Failed to parse file'); setDocContent('')
    } finally { setDocParsing(false) }
  }, [])

  const handleDocExtract = useCallback(async () => {
    if (!docContent.trim()) return
    await start(docContent.trim(), buildConfig(), { title: docFile?.name, sourceType: 'Document' })
  }, [docContent, docFile, buildConfig, start])

  const handleTranscriptExtract = useCallback(async () => {
    if (!transcriptContent.trim()) return
    await start(transcriptContent.trim(), buildConfig(), { title: meetingTitle.trim() || undefined, sourceType: 'Meeting' })
  }, [transcriptContent, meetingTitle, buildConfig, start])

  // ── Review ────────────────────────────────────────────────────────────────
  const handleSave = useCallback(async (entities: ReviewEntity[]) => {
    await approveAndSave(entities)
  }, [approveAndSave])

  const handleCaptureAnother = useCallback(() => {
    reset()
    setTextContent(''); setTextTitle(''); setUrlValue(''); setUrlError(null)
    setDocFile(null); setDocContent(''); setDocError(null)
    setTranscriptContent(''); setMeetingTitle(''); setMeetingDate('')
  }, [reset])

  // ── Pipeline state ────────────────────────────────────────────────────────
  const isIdle      = state.step === 'idle'
  const isError     = state.step === 'error'
  const isRunning   = !isIdle && state.step !== 'reviewing' && state.step !== 'complete' && !isError
  const isExtracting = urlFetching || isRunning

  const isContentEmpty = (() => {
    if (captureMode === 'text')       return !textContent.trim()
    if (captureMode === 'url')        return !urlValue.trim()
    if (captureMode === 'document')   return !docContent.trim()
    if (captureMode === 'transcript') return !transcriptContent.trim()
    return true
  })()

  // ── Right-column content ──────────────────────────────────────────────────
  const rightContent = isIdle
    ? (
      <ExtractionPreview
        mode={extractionMode}
        emphasis={anchorEmphasis}
        selectedAnchorIds={selectedAnchorIds}
        customGuidance={customGuidance}
        anchors={anchors}
      />
    )
    : (
      <div style={{ height: '100%', overflowY: 'auto' }}>
        <ExtractionPipeline
          step={state.step}
          statusText={state.statusText}
          elapsedMs={state.elapsedMs}
          embeddingProgress={state.embeddingProgress}
          error={state.error}
          entities={state.entities}
          relationships={state.relationships}
          onSave={(entities) => void handleSave(entities)}
          onReExtract={() => void reExtract()}
          savedNodeCount={state.savedNodes?.length ?? 0}
          savedEdgeCount={state.savedEdgeIds?.length ?? 0}
          crossConnectionCount={state.crossConnectionCount}
          duplicatesSkipped={state.duplicatesSkipped}
          onRetry={isError ? () => void reExtract() : undefined}
          onCancel={isError ? handleCaptureAnother : undefined}
          onViewInBrowse={() => navigate('/explore')}
          onIngestAnother={handleCaptureAnother}
          onChatWithCapture={state.sourceId ? () => {
            const title = captureMode === 'text' ? textTitle
              : captureMode === 'transcript' ? meetingTitle
              : captureMode === 'document' ? (docFile?.name ?? '')
              : ''
            const sourceType = captureMode === 'text' ? 'Note'
              : captureMode === 'url' ? 'Article'
              : captureMode === 'document' ? 'Document'
              : 'Meeting'
            const ctx = buildPostExtractionContext({
              sourceId: state.sourceId!,
              sourceTitle: title || 'Untitled',
              sourceType,
              entityCount: state.savedNodes?.length ?? 0,
              relationshipCount: state.savedEdgeIds?.length ?? 0,
            })
            navigate('/ask', { state: { chatContext: ctx } })
          } : undefined}
        />
      </div>
    )

  return (
    <div className="flex flex-col h-full">
      <style>{`
        @keyframes fadeUp { from { opacity:0; transform:translateY(8px); } to { opacity:1; transform:translateY(0); } }
      `}</style>

      {/* ── Control bar — full width above split ── */}
      <div
        className="flex items-center shrink-0"
        style={{
          background: 'var(--color-bg-card)',
          borderBottom: '1px solid var(--border-subtle)',
          padding: '8px 24px',
          minHeight: 44,
          gap: 8,
        }}
      >
        {MODES.map(({ key, label, Icon }) => {
          const active = captureMode === key
          return (
            <button key={key} type="button" onClick={() => setCaptureMode(key)}
              className="font-body font-semibold"
              style={{
                display: 'flex', alignItems: 'center', gap: 6,
                padding: '5px 13px', borderRadius: 20, fontSize: 12,
                border: active ? '1px solid rgba(214,58,0,0.15)' : '1px solid var(--border-subtle)',
                background: active ? 'var(--color-accent-50)' : 'transparent',
                color: active ? 'var(--color-accent-500)' : 'var(--color-text-secondary)',
                cursor: 'pointer', transition: 'all 0.15s',
              }}
            >
              <Icon size={13} />
              {label}
            </button>
          )
        })}
      </div>

      <div
        ref={containerRef}
        className="flex flex-1 overflow-hidden"
        style={{
          background: 'var(--color-bg-content)',
          userSelect: isDragging ? 'none' : undefined,
          cursor: isDragging ? 'col-resize' : undefined,
        }}
      >
        {/* ── Left: input + extraction settings ── */}
        <div
          className="h-full overflow-y-auto flex-shrink-0"
          style={{
            width: `${leftWidthPct}%`,
            padding: '20px 36px',
            transition: isDragging ? 'none' : 'width 0.2s ease',
          }}
        >

          {/* ── Text ── */}
          {captureMode === 'text' && (
            <div style={CARD}>
              <input
                type="text" value={textTitle} onChange={e => setTextTitle(e.target.value)}
                placeholder="Title (optional)"
                className="font-body w-full"
                style={{
                  fontSize: 14, background: 'transparent', border: 'none', outline: 'none',
                  color: 'var(--color-text-primary)', paddingBottom: 10,
                  borderBottom: '1px solid var(--border-subtle)', width: '100%', marginBottom: 12,
                }}
              />
              <textarea
                value={textContent} onChange={e => setTextContent(e.target.value)}
                onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') void handleTextExtract() }}
                placeholder="Paste meeting notes, article text, brainstorm, observations, or any content worth extracting…"
                className="font-body w-full resize-y"
                style={{
                  fontSize: 14, color: 'var(--color-text-primary)', background: 'transparent',
                  border: 'none', outline: 'none', minHeight: 180, lineHeight: 1.7,
                  width: '100%', marginBottom: 14,
                }}
              />
              <ExtractBtn charCount={textContent.length} label="Extract Knowledge"
                disabled={isContentEmpty || isExtracting} loading={isExtracting}
                onClick={() => void handleTextExtract()} />
            </div>
          )}

          {/* ── URL ── */}
          {captureMode === 'url' && (
            <div style={CARD}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: urlError ? 6 : 14 }}>
                <Link size={16} style={{ color: 'var(--color-text-secondary)', flexShrink: 0 }} />
                <input
                  type="text" value={urlValue}
                  onChange={e => { setUrlValue(e.target.value); setUrlError(null) }}
                  onKeyDown={e => { if (e.key === 'Enter') void handleUrlExtract() }}
                  placeholder="Paste a YouTube URL, article link, or any web page…"
                  className="font-body w-full"
                  style={{ fontSize: 14, background: 'transparent', border: 'none', outline: 'none', color: 'var(--color-text-primary)', flex: 1 }}
                />
              </div>
              {urlError && <p className="font-body" style={{ fontSize: 11, color: '#ef4444', marginBottom: 10 }}>{urlError}</p>}
              <div style={{ borderRadius: 8, background: 'var(--color-bg-inset)', border: '1px solid var(--border-subtle)', padding: '12px 14px', marginBottom: 14 }}>
                <p className="font-body" style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginBottom: 2 }}>
                  Paste a URL to fetch and extract content
                </p>
                <p className="font-body" style={{ fontSize: 11, color: 'var(--color-text-placeholder)' }}>
                  Supports: YouTube videos, web articles, blog posts, documentation
                </p>
              </div>
              <ExtractBtn label="Fetch & Extract"
                disabled={isContentEmpty || isExtracting} loading={isExtracting}
                onClick={() => void handleUrlExtract()} />
            </div>
          )}

          {/* ── Document ── */}
          {captureMode === 'document' && (
            <div>
              <div
                role="button" tabIndex={0}
                onClick={() => fileInputRef.current?.click()}
                onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') fileInputRef.current?.click() }}
                onDragOver={e => { e.preventDefault(); setDragOver(true) }}
                onDragEnter={e => { e.preventDefault(); setDragOver(true) }}
                onDragLeave={() => setDragOver(false)}
                onDrop={e => { e.preventDefault(); setDragOver(false); const f = e.dataTransfer.files[0]; if (f) void handleFileSelected(f) }}
                style={{
                  borderRadius: 12,
                  border: dragOver ? '2px solid rgba(214,58,0,0.6)' : '2px dashed var(--border-default)',
                  background: dragOver ? 'var(--color-accent-50)' : 'var(--color-bg-card)',
                  padding: '44px 24px', textAlign: 'center', cursor: 'pointer', outline: 'none',
                  transition: 'border-color 0.15s, background 0.15s',
                }}
              >
                <Upload size={30} style={{ color: dragOver ? 'var(--color-accent-500)' : 'var(--color-text-placeholder)', margin: '0 auto 12px', display: 'block' }} />
                <p className="font-body" style={{ fontSize: 14, fontWeight: 600, color: 'var(--color-text-body)', marginBottom: 4 }}>
                  {docParsing ? 'Parsing file…' : dragOver ? 'Drop to upload' : 'Drop files here or click to browse'}
                </p>
                <p className="font-body" style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
                  PDF · DOCX · Markdown · Plain text
                </p>
              </div>
              <input ref={fileInputRef} type="file" accept=".pdf,.docx,.md,.txt,.markdown"
                onChange={e => { const f = e.target.files?.[0]; if (f) void handleFileSelected(f); e.target.value = '' }}
                style={{ display: 'none' }} />
              {docError && <p className="font-body" style={{ fontSize: 11, color: '#ef4444', marginTop: 8 }}>{docError}</p>}
              {docFile && docContent && !docParsing && (
                <div style={{ ...CARD, marginTop: 10 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
                    <FileText size={15} style={{ color: 'var(--color-text-secondary)' }} />
                    <span className="font-body" style={{ fontSize: 13, fontWeight: 500, color: 'var(--color-text-primary)' }}>{docFile.name}</span>
                    <span className="font-body" style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>({Math.round(docContent.length / 1000)}k chars)</span>
                  </div>
                  <ExtractBtn charCount={docContent.length} label="Extract Knowledge"
                    disabled={isExtracting} loading={isExtracting}
                    onClick={() => void handleDocExtract()} />
                </div>
              )}
            </div>
          )}

          {/* ── Transcript ── */}
          {captureMode === 'transcript' && (
            <>
              <div style={{ ...CARD, marginBottom: 10 }}>
                <div style={{ display: 'flex', gap: 12 }}>
                  <div style={{ flex: 1 }}>
                    <label className="font-body" style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-secondary)', display: 'block', marginBottom: 4 }}>Meeting Title</label>
                    <input type="text" value={meetingTitle} onChange={e => setMeetingTitle(e.target.value)}
                      placeholder="e.g. Q4 Planning with Marco" className="font-body w-full"
                      style={{ background: 'var(--color-bg-inset)', border: '1px solid var(--border-subtle)', borderRadius: 8, padding: '8px 12px', fontSize: 13, color: 'var(--color-text-primary)', outline: 'none', width: '100%', boxSizing: 'border-box', transition: 'border-color 0.15s, box-shadow 0.15s' }}
                      {...FOCUS} />
                  </div>
                  <div style={{ flex: 1 }}>
                    <label className="font-body" style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-secondary)', display: 'block', marginBottom: 4 }}>Date</label>
                    <input type="date" value={meetingDate} onChange={e => setMeetingDate(e.target.value)}
                      className="font-body w-full"
                      style={{ background: 'var(--color-bg-inset)', border: '1px solid var(--border-subtle)', borderRadius: 8, padding: '8px 12px', fontSize: 13, color: 'var(--color-text-primary)', outline: 'none', width: '100%', boxSizing: 'border-box', transition: 'border-color 0.15s, box-shadow 0.15s' }}
                      {...FOCUS} />
                  </div>
                </div>
              </div>
              <div style={CARD}>
                <textarea
                  value={transcriptContent} onChange={e => setTranscriptContent(e.target.value)}
                  onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') void handleTranscriptExtract() }}
                  placeholder="Paste the full meeting transcript here…"
                  className="font-body w-full resize-y"
                  style={{ fontSize: 13, color: 'var(--color-text-primary)', background: 'var(--color-bg-inset)', border: '1px solid var(--border-subtle)', borderRadius: 8, padding: '12px 14px', minHeight: 240, lineHeight: 1.6, width: '100%', outline: 'none', boxSizing: 'border-box', marginBottom: 14, transition: 'border-color 0.15s, box-shadow 0.15s' }}
                  onFocus={e => { e.currentTarget.style.borderColor = 'rgba(214,58,0,0.3)'; e.currentTarget.style.boxShadow = '0 0 0 3px var(--color-accent-50)' }}
                  onBlur={e => { e.currentTarget.style.borderColor = 'var(--border-subtle)'; e.currentTarget.style.boxShadow = 'none' }}
                />
                <ExtractBtn charCount={transcriptContent.length} label="Extract Knowledge"
                  disabled={isContentEmpty || isExtracting} loading={isExtracting}
                  onClick={() => void handleTranscriptExtract()} />
              </div>
            </>
          )}

          {/* Extraction Settings — always visible */}
          {isIdle && (
            <ExtractionSettings
              mode={extractionMode} onModeChange={setExtractionMode}
              emphasis={anchorEmphasis} onEmphasisChange={setAnchorEmphasis}
              selectedAnchorIds={selectedAnchorIds} onAnchorIdsChange={setSelectedAnchorIds}
              customGuidance={customGuidance} onGuidanceChange={setCustomGuidance}
              anchors={anchors}
            />
          )}
        </div>

        {/* ── Resize handle (identical to HomeView) ── */}
        <div
          className="resize-handle flex-shrink-0 flex items-center justify-center"
          onMouseDown={handleDividerMouseDown}
          onMouseEnter={() => setIsHandleHovered(true)}
          onMouseLeave={() => setIsHandleHovered(false)}
          style={{ width: 16, cursor: 'col-resize', position: 'relative', flexShrink: 0, zIndex: 1 }}
        >
          <div style={{
            position: 'absolute', left: '50%', transform: 'translateX(-50%)',
            top: 0, bottom: 0, width: 2, borderRadius: 1,
            background: (isDragging || isHandleHovered) ? 'var(--color-accent-500)' : 'var(--border-subtle)',
            transition: 'background 0.15s ease',
          }} />
          <GripVertical size={14} style={{
            position: 'relative', zIndex: 1,
            color: (isDragging || isHandleHovered) ? 'var(--color-accent-500)' : 'var(--color-text-placeholder)',
            transition: 'color 0.15s ease',
            background: 'var(--color-bg-content)', borderRadius: 2,
          }} />
        </div>

        {/* ── Right: pipeline / preview ── */}
        <div className="flex-1 h-full overflow-hidden" style={{ background: 'var(--color-bg-content)', minWidth: 0 }}>
          {rightContent}
        </div>
      </div>
    </div>
  )
}
