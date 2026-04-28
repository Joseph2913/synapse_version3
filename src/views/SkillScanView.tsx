import { useState, useMemo } from 'react'
import { supabase } from '../services/supabase'
import {
  ChevronDown, ChevronUp, Check, X, ArrowUp,
  Search, Loader2, AlertCircle, BarChart3,
} from 'lucide-react'

// ─── Types (mirrors api/skills/scan.ts response) ──────────────────────────────

interface CriterionResult {
  pass: boolean
  rationale: string
}

interface SignalBreakdown {
  anchorAlignment:  { score: number; matchedAnchor: string | null }
  nodeDensity:      { score: number; relatedNodeCount: number }
  sourceHistory:    { score: number; relatedSourceCount: number }
  graphProximity:   { score: number; hopsToNearestAnchor: number | null }
  profileContext:   { score: number; multiplierApplied: number }
  velocity:         { score: number; recentSourceCount: number }
}

interface SkillCandidate {
  id: string
  suggestedSkillLabel: string
  domain: string
  status: 'confirmed_candidate' | 'pending_reinforcement' | 'weak_signal'
  exposureLevel: 'novice' | 'developing' | 'proficient' | 'advanced'
  criteriaPassedCount: number
  criteria: {
    C1: CriterionResult
    C2: CriterionResult
    C3: CriterionResult
    C4: CriterionResult
    C5: CriterionResult
  }
  relevanceScore: number
  signalBreakdown: SignalBreakdown
  primarySource: {
    id: string
    title: string
    source_type: string
    created_at: string
  }
  contributingSources: Array<{
    id: string
    title: string
    source_type: string
  }>
  relatedAnchors: Array<{
    label: string
    entity_type: string
    similarityScore: number
  }>
  whatWouldUpgradeIt: string
  primaryNodeLabel: string
  clusterNodeLabels: string[]
}

interface FailedCandidate {
  clusterLabel: string
  sourceTitle: string
  source_type: string
  failReason: string
  criteriaPassedCount?: number
  failedCriteria?: string[]
}

interface ScanResponse {
  meta: {
    scannedAt: string
    sourcesScanned: number
    clustersEvaluated: number
    confirmedCandidates: number
    pendingCandidates: number
    weakSignalCandidates: number
    failedUniversal: number
    evaluationErrors: number
    durationMs: number
  }
  candidates: SkillCandidate[]
  failedCandidates: FailedCandidate[]
  diagnosticNotes: string[]
}

interface ScanConfig {
  source_types: string[]
  min_criteria_pass: number
  min_relevance: number
  limit: number
  include_failed: boolean
}

const DEFAULT_CONFIG: ScanConfig = {
  source_types: ['youtube', 'meeting', 'file', 'research'],
  min_criteria_pass: 3,
  min_relevance: 0.20,
  limit: 60,
  include_failed: true,
}

type ScanState = 'idle' | 'loading' | 'complete' | 'error'

const SOURCE_TYPE_OPTIONS = ['youtube', 'meeting', 'file', 'research']

const LOADING_MESSAGES = [
  'Assembling your knowledge graph data...',
  'Forming concept clusters across sources...',
  'Evaluating candidates against universal criteria...',
  'Scoring personalised relevance signals...',
  'Finalising results...',
]

const SOURCE_EMOJI: Record<string, string> = {
  YouTube: '▶',
  Meeting: '🎙',
  Document: '📄',
  Research: '🔬',
}

const DOMAIN_COLORS: Record<string, string> = {
  technical: 'bg-blue-50 text-blue-700 border-blue-200',
  consulting: 'bg-purple-50 text-purple-700 border-purple-200',
  strategic: 'bg-amber-50 text-amber-700 border-amber-200',
  interpersonal: 'bg-green-50 text-green-700 border-green-200',
  domain_specific: 'bg-gray-50 text-gray-700 border-gray-200',
}

const EXPOSURE_COLORS: Record<string, string> = {
  novice: 'bg-gray-50 text-gray-600 border-gray-200',
  developing: 'bg-sky-50 text-sky-700 border-sky-200',
  proficient: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  advanced: 'bg-violet-50 text-violet-700 border-violet-200',
}

const CRITERIA_NAMES: Record<string, string> = {
  C1: 'Instructional Intent',
  C2: 'Specificity Threshold',
  C3: 'Reusability Signal',
  C4: 'Method Presence',
  C5: 'Minimum Depth',
}

const SIGNAL_NAMES: Record<string, string> = {
  anchorAlignment: 'Anchor Alignment',
  nodeDensity: 'Node Density',
  sourceHistory: 'Source History',
  graphProximity: 'Graph Proximity',
  profileContext: 'Profile Context',
  velocity: 'Velocity',
}

// ─── FILTER OPTIONS ───────────────────────────────────────────────────────────

type FilterKey = 'all' | 'technical' | 'consulting' | 'strategic' | 'domain_specific' | 'confirmed' | 'advanced_proficient'

const FILTER_OPTIONS: { key: FilterKey; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'technical', label: 'Technical' },
  { key: 'consulting', label: 'Consulting' },
  { key: 'strategic', label: 'Strategic' },
  { key: 'domain_specific', label: 'Domain Specific' },
  { key: 'confirmed', label: 'Confirmed only' },
  { key: 'advanced_proficient', label: 'Advanced / Proficient' },
]

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function relevanceColor(score: number): string {
  if (score >= 0.7) return 'text-emerald-600'
  if (score >= 0.5) return 'text-amber-600'
  return 'var(--color-text-secondary)'
}

function signalExplanation(key: string, breakdown: SignalBreakdown): string {
  const s = breakdown[key as keyof SignalBreakdown]
  if (!s) return ''
  switch (key) {
    case 'anchorAlignment': {
      const d = s as SignalBreakdown['anchorAlignment']
      return d.matchedAnchor ? `Closely matches your "${d.matchedAnchor}" anchor` : 'No anchor alignment detected'
    }
    case 'nodeDensity': {
      const d = s as SignalBreakdown['nodeDensity']
      return `${d.relatedNodeCount} related nodes found`
    }
    case 'sourceHistory': {
      const d = s as SignalBreakdown['sourceHistory']
      return `${d.relatedSourceCount} related source${d.relatedSourceCount !== 1 ? 's' : ''}`
    }
    case 'graphProximity': {
      const d = s as SignalBreakdown['graphProximity']
      return d.hopsToNearestAnchor !== null
        ? `${d.hopsToNearestAnchor} hop${d.hopsToNearestAnchor !== 1 ? 's' : ''} to nearest anchor`
        : 'Not connected to any anchor'
    }
    case 'profileContext': {
      const d = s as SignalBreakdown['profileContext']
      return `${d.multiplierApplied}x domain multiplier applied`
    }
    case 'velocity': {
      const d = s as SignalBreakdown['velocity']
      return d.recentSourceCount > 0
        ? `${d.recentSourceCount} source${d.recentSourceCount !== 1 ? 's' : ''} in last 14 days`
        : 'No recent activity'
    }
    default: return ''
  }
}

// ─── PROGRESS BAR ─────────────────────────────────────────────────────────────

function SignalBar({ score }: { score: number }) {
  const pct = Math.round(score * 100)
  return (
    <div className="flex items-center gap-2 flex-1">
      <div className="w-24 h-2 rounded-full overflow-hidden" style={{ background: 'var(--color-bg-inset)' }}>
        <div
          className="h-full rounded-full transition-all"
          style={{ width: `${pct}%`, background: 'var(--color-accent-500)' }}
        />
      </div>
      <span className="text-xs font-semibold w-8 text-right" style={{ fontFamily: 'var(--font-display)', color: 'var(--color-text-primary)' }}>
        {score.toFixed(2)}
      </span>
    </div>
  )
}

// ─── CANDIDATE CARD ───────────────────────────────────────────────────────────

function CandidateCard({
  candidate,
  isExpanded,
  onToggle,
}: {
  candidate: SkillCandidate
  isExpanded: boolean
  onToggle: () => void
}) {
  const criteria = candidate.criteria
  const passCount = candidate.criteriaPassedCount
  const dots = ['C1', 'C2', 'C3', 'C4', 'C5'] as const

  return (
    <div
      className="rounded-xl border"
      style={{
        background: 'var(--color-bg-card)',
        borderColor: 'var(--border-subtle)',
        padding: '16px 20px',
      }}
    >
      {/* Header */}
      <div className="flex items-start justify-between cursor-pointer" onClick={onToggle}>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span
              className="font-bold truncate"
              style={{ fontFamily: 'var(--font-display)', fontSize: 14, color: 'var(--color-text-primary)' }}
            >
              {candidate.suggestedSkillLabel}
            </span>
          </div>
          <div className="flex items-center gap-2 mt-1 flex-wrap">
            <span className={`text-xs font-semibold px-2 py-0.5 rounded-full border ${DOMAIN_COLORS[candidate.domain] ?? DOMAIN_COLORS.domain_specific}`}>
              {candidate.domain}
            </span>
            <span className={`text-xs font-semibold px-2 py-0.5 rounded-full border ${EXPOSURE_COLORS[candidate.exposureLevel] ?? EXPOSURE_COLORS.novice}`}>
              {candidate.exposureLevel}
            </span>
          </div>
          <div className="flex items-center gap-3 mt-2">
            <span className="text-xs" style={{ fontFamily: 'var(--font-body)', color: 'var(--color-text-secondary)' }}>
              {SOURCE_EMOJI[candidate.primarySource.source_type] ?? '📎'} {candidate.primarySource.title}
            </span>
          </div>
          <div className="flex items-center gap-1.5 mt-1.5">
            <span className="text-xs" style={{ fontFamily: 'var(--font-body)', color: 'var(--color-text-secondary)' }}>
              {passCount}/5 criteria
            </span>
            <div className="flex gap-0.5 ml-1">
              {dots.map(key => (
                <div
                  key={key}
                  className="w-2 h-2 rounded-full"
                  style={{
                    background: criteria[key].pass ? 'var(--color-accent-500)' : 'var(--color-bg-inset)',
                  }}
                />
              ))}
            </div>
            {candidate.relatedAnchors.slice(0, 2).map((a, i) => (
              <span
                key={i}
                className="text-xs px-1.5 py-0.5 rounded-full border ml-1"
                style={{
                  borderColor: 'var(--border-subtle)',
                  color: 'var(--color-text-secondary)',
                  fontSize: 10,
                }}
              >
                {a.label}
              </span>
            ))}
          </div>
        </div>
        <div className="flex flex-col items-end ml-4 flex-shrink-0">
          <span
            className={`font-extrabold ${relevanceColor(candidate.relevanceScore)}`}
            style={{ fontFamily: 'var(--font-display)', fontSize: 20 }}
          >
            {candidate.relevanceScore.toFixed(2)}
          </span>
          <span className="text-xs font-semibold" style={{ fontFamily: 'var(--font-body)', color: 'var(--color-text-secondary)' }}>
            {candidate.status.replace(/_/g, ' ')}
          </span>
          {isExpanded ? <ChevronUp size={16} className="mt-1 text-gray-400" /> : <ChevronDown size={16} className="mt-1 text-gray-400" />}
        </div>
      </div>

      {/* Expanded detail */}
      {isExpanded && (
        <div className="mt-4 pt-4 space-y-5" style={{ borderTop: '1px solid var(--border-subtle)' }}>
          {/* WHY IT WAS CHOSEN */}
          <Section title="WHY IT WAS CHOSEN">
            <p className="text-xs leading-relaxed" style={{ fontFamily: 'var(--font-body)', color: 'var(--color-text-body)' }}>
              {dots.filter(k => criteria[k].pass).map(k => `${CRITERIA_NAMES[k]}: ${criteria[k].rationale}`).join('. ')}
            </p>
          </Section>

          {/* UNIVERSAL CRITERIA BREAKDOWN */}
          <Section title="UNIVERSAL CRITERIA BREAKDOWN">
            <div className="space-y-1">
              {dots.map(key => (
                <div key={key} className="flex items-start gap-2">
                  <div className="flex-shrink-0 mt-0.5">
                    {criteria[key].pass
                      ? <Check size={14} className="text-emerald-500" />
                      : <X size={14} style={{ color: 'var(--color-text-secondary)' }} />
                    }
                  </div>
                  <span className="text-xs font-semibold w-36 flex-shrink-0" style={{ color: 'var(--color-text-primary)' }}>
                    {CRITERIA_NAMES[key]}
                  </span>
                  <span className="text-xs" style={{ fontFamily: 'var(--font-body)', color: 'var(--color-text-body)' }}>
                    {criteria[key].rationale}
                  </span>
                </div>
              ))}
            </div>
          </Section>

          {/* RELEVANCE SIGNAL BREAKDOWN */}
          <Section title="RELEVANCE SIGNAL BREAKDOWN">
            <div className="space-y-2">
              {(Object.keys(SIGNAL_NAMES) as Array<keyof typeof SIGNAL_NAMES>).map(key => (
                <div key={key} className="flex items-center gap-3">
                  <span className="text-xs font-semibold w-32 flex-shrink-0" style={{ color: 'var(--color-text-primary)' }}>
                    {SIGNAL_NAMES[key]}
                  </span>
                  <SignalBar score={(candidate.signalBreakdown[key as keyof SignalBreakdown] as { score: number }).score} />
                  <span className="text-xs flex-shrink-0 w-48 truncate" style={{ fontFamily: 'var(--font-body)', color: 'var(--color-text-secondary)' }}>
                    {signalExplanation(key, candidate.signalBreakdown)}
                  </span>
                </div>
              ))}
            </div>
          </Section>

          {/* CONTRIBUTING SOURCES */}
          {candidate.contributingSources.length > 0 && (
            <Section title="CONTRIBUTING SOURCES">
              <div className="space-y-1">
                {candidate.contributingSources.map((s, i) => (
                  <div key={i} className="text-xs" style={{ fontFamily: 'var(--font-body)', color: 'var(--color-text-body)' }}>
                    {SOURCE_EMOJI[s.source_type] ?? '📎'} {s.title}
                  </div>
                ))}
              </div>
            </Section>
          )}

          {/* RELATED ANCHORS */}
          <Section title="RELATED ANCHORS">
            {candidate.relatedAnchors.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {candidate.relatedAnchors.map((a, i) => (
                  <span
                    key={i}
                    className="text-xs px-2 py-1 rounded-full border"
                    style={{ borderColor: 'var(--border-subtle)', color: 'var(--color-text-secondary)' }}
                  >
                    {a.label} ({Math.round(a.similarityScore * 100)}%)
                  </span>
                ))}
              </div>
            ) : (
              <span className="text-xs" style={{ color: 'var(--color-text-secondary)' }}>No anchor alignment</span>
            )}
          </Section>

          {/* WHAT WOULD UPGRADE THIS */}
          <Section title="WHAT WOULD UPGRADE THIS">
            <div
              className="rounded-lg flex items-start gap-2"
              style={{ background: 'var(--color-bg-inset)', padding: 8 }}
            >
              <ArrowUp size={14} className="flex-shrink-0 mt-0.5" style={{ color: 'var(--color-accent-500)' }} />
              <span className="text-xs" style={{ fontFamily: 'var(--font-body)', color: 'var(--color-text-body)' }}>
                {candidate.whatWouldUpgradeIt}
              </span>
            </div>
          </Section>

          {/* CLUSTER NODES */}
          <Section title="CLUSTER NODES">
            <div className="flex flex-wrap gap-1.5">
              {candidate.clusterNodeLabels.map((label, i) => (
                <span
                  key={i}
                  className="text-xs px-2 py-0.5 rounded-full"
                  style={{ background: 'var(--color-bg-inset)', color: 'var(--color-text-secondary)' }}
                >
                  {label}
                </span>
              ))}
            </div>
          </Section>
        </div>
      )}
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h4
        className="text-xs font-bold tracking-wide mb-2"
        style={{ fontFamily: 'var(--font-display)', color: 'var(--color-text-secondary)', letterSpacing: '0.05em' }}
      >
        {title}
      </h4>
      {children}
    </div>
  )
}

// ─── MAIN VIEW ────────────────────────────────────────────────────────────────

export function SkillScanView() {
  const [scanState, setScanState] = useState<ScanState>('idle')
  const [config, setConfig] = useState<ScanConfig>({ ...DEFAULT_CONFIG })
  const [results, setResults] = useState<ScanResponse | null>(null)
  const [expandedCardId, setExpandedCardId] = useState<string | null>(null)
  const [activeFilter, setActiveFilter] = useState<FilterKey>('all')
  const [searchQuery, setSearchQuery] = useState('')
  const [showFailed, setShowFailed] = useState(false)
  const [loadingMsg, setLoadingMsg] = useState('')
  const [errorMsg, setErrorMsg] = useState('')

  const runScan = async () => {
    setScanState('loading')
    setErrorMsg('')
    setExpandedCardId(null)

    // Rotate loading messages
    let msgIdx = 0
    setLoadingMsg(LOADING_MESSAGES[0] ?? '')
    const interval = setInterval(() => {
      msgIdx = Math.min(msgIdx + 1, LOADING_MESSAGES.length - 1)
      setLoadingMsg(LOADING_MESSAGES[msgIdx] ?? '')
    }, 3000)

    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) {
        throw new Error('Not authenticated')
      }

      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 300000) // 5 minutes

      const response = await fetch('/api/skills/scan', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify(config),
        signal: controller.signal,
      })

      clearTimeout(timeoutId)

      if (!response.ok) {
        const err = await response.json().catch(() => ({ error: 'Unknown error' }))
        throw new Error(err.error ?? `HTTP ${response.status}`)
      }

      const data: ScanResponse = await response.json()
      setResults(data)
      setScanState('complete')
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Scan failed'
      if (msg.includes('abort')) {
        setErrorMsg('Scan timed out after 120 seconds. Try reducing the source limit or selecting fewer source types.')
      } else {
        setErrorMsg(msg)
      }
      setScanState('error')
    } finally {
      clearInterval(interval)
    }
  }

  // Client-side filtering
  const filteredCandidates = useMemo(() => {
    if (!results) return []
    let list = results.candidates

    // Domain / status filter
    switch (activeFilter) {
      case 'technical':
      case 'consulting':
      case 'strategic':
      case 'domain_specific':
        list = list.filter(c => c.domain === activeFilter)
        break
      case 'confirmed':
        list = list.filter(c => c.status === 'confirmed_candidate')
        break
      case 'advanced_proficient':
        list = list.filter(c => c.exposureLevel === 'advanced' || c.exposureLevel === 'proficient')
        break
    }

    // Search
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase()
      list = list.filter(c =>
        c.suggestedSkillLabel.toLowerCase().includes(q) ||
        c.primaryNodeLabel.toLowerCase().includes(q)
      )
    }

    return list
  }, [results, activeFilter, searchQuery])

  const toggleSourceType = (type: string) => {
    setConfig(prev => {
      const types = prev.source_types.includes(type)
        ? prev.source_types.filter(t => t !== type)
        : [...prev.source_types, type]
      return { ...prev, source_types: types.length > 0 ? types : [type] }
    })
  }

  return (
    <div className="flex flex-col h-full overflow-auto" style={{ background: 'var(--color-bg-content)' }}>
      <div className="mx-auto w-full" style={{ maxWidth: 900, padding: '32px 24px' }}>
        {/* Header */}
        <div className="mb-6">
          <h1
            className="font-bold"
            style={{ fontFamily: 'var(--font-display)', fontSize: 20, color: 'var(--color-text-primary)' }}
          >
            SYNAPSE SKILL DIAGNOSTIC
          </h1>
          <p className="text-xs mt-1" style={{ fontFamily: 'var(--font-body)', color: 'var(--color-text-secondary)' }}>
            Read-only · No data written
          </p>
        </div>

        {/* Configuration Panel */}
        {(scanState === 'idle' || scanState === 'error') && (
          <div
            className="rounded-xl border mb-6"
            style={{ background: 'var(--color-bg-card)', borderColor: 'var(--border-subtle)', padding: '16px 22px' }}
          >
            <h3
              className="text-sm font-bold mb-4"
              style={{ fontFamily: 'var(--font-display)', color: 'var(--color-text-primary)' }}
            >
              Scan Configuration
            </h3>

            {/* Source types */}
            <div className="mb-4">
              <label className="text-xs font-semibold block mb-2" style={{ color: 'var(--color-text-secondary)' }}>
                Source types to include
              </label>
              <div className="flex gap-3 flex-wrap">
                {SOURCE_TYPE_OPTIONS.map(type => (
                  <label key={type} className="flex items-center gap-1.5 text-xs cursor-pointer" style={{ color: 'var(--color-text-body)' }}>
                    <input
                      type="checkbox"
                      checked={config.source_types.includes(type)}
                      onChange={() => toggleSourceType(type)}
                      className="rounded"
                    />
                    {type}
                  </label>
                ))}
              </div>
            </div>

            {/* Number inputs row */}
            <div className="flex gap-6 mb-4 flex-wrap">
              <div>
                <label className="text-xs font-semibold block mb-1" style={{ color: 'var(--color-text-secondary)' }}>
                  Min criteria pass (1-5)
                </label>
                <input
                  type="number"
                  min={1}
                  max={5}
                  value={config.min_criteria_pass}
                  onChange={e => setConfig(prev => ({ ...prev, min_criteria_pass: Number(e.target.value) }))}
                  className="w-20 rounded-lg border px-2 py-1 text-xs"
                  style={{ borderColor: 'var(--border-subtle)', background: 'var(--color-bg-inset)' }}
                />
              </div>
              <div>
                <label className="text-xs font-semibold block mb-1" style={{ color: 'var(--color-text-secondary)' }}>
                  Max candidates (10-100)
                </label>
                <input
                  type="number"
                  min={10}
                  max={100}
                  value={config.limit}
                  onChange={e => setConfig(prev => ({ ...prev, limit: Number(e.target.value) }))}
                  className="w-20 rounded-lg border px-2 py-1 text-xs"
                  style={{ borderColor: 'var(--border-subtle)', background: 'var(--color-bg-inset)' }}
                />
              </div>
            </div>

            {/* Relevance slider */}
            <div className="mb-4">
              <label className="text-xs font-semibold block mb-1" style={{ color: 'var(--color-text-secondary)' }}>
                Min relevance score: {config.min_relevance.toFixed(2)}
              </label>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={config.min_relevance}
                onChange={e => setConfig(prev => ({ ...prev, min_relevance: Number(e.target.value) }))}
                className="w-full max-w-xs"
              />
            </div>

            {/* Show failed toggle */}
            <div className="mb-5">
              <label className="flex items-center gap-2 text-xs cursor-pointer" style={{ color: 'var(--color-text-body)' }}>
                <input
                  type="checkbox"
                  checked={config.include_failed}
                  onChange={e => setConfig(prev => ({ ...prev, include_failed: e.target.checked }))}
                  className="rounded"
                />
                Show failed universal candidates
              </label>
            </div>

            {/* Error message */}
            {errorMsg && (
              <div className="flex items-start gap-2 mb-4 p-3 rounded-lg bg-red-50 text-red-700 text-xs">
                <AlertCircle size={14} className="flex-shrink-0 mt-0.5" />
                {errorMsg}
              </div>
            )}

            {/* Run button */}
            <button
              onClick={runScan}
              className="w-full rounded-lg font-bold text-sm text-white transition-colors"
              style={{
                height: 40,
                fontFamily: 'var(--font-display)',
                fontSize: 14,
                fontWeight: 700,
                background: 'var(--color-accent-500)',
              }}
            >
              Run Scan
            </button>
          </div>
        )}

        {/* Loading state */}
        {scanState === 'loading' && (
          <div
            className="rounded-xl border mb-6 flex flex-col items-center justify-center"
            style={{ background: 'var(--color-bg-card)', borderColor: 'var(--border-subtle)', padding: '40px 22px' }}
          >
            <Loader2 size={32} className="animate-spin mb-4" style={{ color: 'var(--color-accent-500)' }} />
            <p className="text-sm font-semibold" style={{ fontFamily: 'var(--font-display)', color: 'var(--color-text-primary)' }}>
              {loadingMsg}
            </p>
            <p className="text-xs mt-2" style={{ color: 'var(--color-text-secondary)' }}>
              This may take 15-45 seconds depending on database size
            </p>
          </div>
        )}

        {/* Results */}
        {scanState === 'complete' && results && (
          <>
            {/* Summary bar */}
            <div
              className="rounded-xl border mb-4 flex items-center flex-wrap gap-x-3 gap-y-1"
              style={{ background: 'var(--color-bg-card)', borderColor: 'var(--border-subtle)', padding: '10px 20px' }}
            >
              <StatPill label={`${results.meta.sourcesScanned} sources scanned`} />
              <Dot />
              <StatPill label={`${results.meta.clustersEvaluated} clusters evaluated`} />
              <Dot />
              <StatPill label={`${results.meta.confirmedCandidates} confirmed`} />
              <Dot />
              <StatPill label={`${results.meta.pendingCandidates} pending`} />
              <Dot />
              <StatPill label={`${results.meta.weakSignalCandidates} weak signal`} />
              <Dot />
              <StatPill label={`${results.meta.failedUniversal} failed`} />
              <Dot />
              <StatPill label={`Completed in ${(results.meta.durationMs / 1000).toFixed(1)}s`} />
              <div className="ml-auto">
                <button
                  onClick={() => { setScanState('idle'); }}
                  className="text-xs font-semibold"
                  style={{ color: 'var(--color-accent-500)' }}
                >
                  Re-run Scan
                </button>
              </div>
            </div>

            {/* Filter bar */}
            <div className="flex items-center gap-2 mb-4 flex-wrap">
              {FILTER_OPTIONS.map(opt => (
                <button
                  key={opt.key}
                  onClick={() => setActiveFilter(opt.key)}
                  className="text-xs font-semibold rounded-full border transition-colors"
                  style={{
                    padding: '5px 13px',
                    fontFamily: 'var(--font-body)',
                    background: activeFilter === opt.key ? 'var(--color-accent-50)' : 'transparent',
                    borderColor: activeFilter === opt.key ? 'var(--color-accent-500)' : 'var(--border-subtle)',
                    color: activeFilter === opt.key ? 'var(--color-accent-500)' : 'var(--color-text-secondary)',
                  }}
                >
                  {opt.label}
                </button>
              ))}

              {/* Search */}
              <div className="relative ml-auto">
                <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2" style={{ color: 'var(--color-text-secondary)' }} />
                <input
                  type="text"
                  placeholder="Search skill candidates..."
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  className="text-xs rounded-full border"
                  style={{
                    padding: '5px 13px 5px 28px',
                    borderColor: 'var(--border-subtle)',
                    background: 'var(--color-bg-inset)',
                    fontFamily: 'var(--font-body)',
                    color: 'var(--color-text-primary)',
                    width: 220,
                  }}
                />
              </div>
            </div>

            {/* Candidate cards */}
            {filteredCandidates.length > 0 ? (
              <div className="space-y-2">
                {filteredCandidates.map(candidate => (
                  <CandidateCard
                    key={candidate.id}
                    candidate={candidate}
                    isExpanded={expandedCardId === candidate.id}
                    onToggle={() => setExpandedCardId(prev => prev === candidate.id ? null : candidate.id)}
                  />
                ))}
              </div>
            ) : (
              <div
                className="rounded-xl border flex flex-col items-center py-12"
                style={{ background: 'var(--color-bg-card)', borderColor: 'var(--border-subtle)' }}
              >
                <BarChart3 size={32} style={{ color: 'var(--color-text-secondary)' }} />
                <p className="text-sm mt-3" style={{ color: 'var(--color-text-secondary)' }}>
                  No candidates match the current filters
                </p>
              </div>
            )}

            {/* Failed Universal section */}
            {results.failedCandidates.length > 0 && (
              <div className="mt-6">
                <button
                  onClick={() => setShowFailed(prev => !prev)}
                  className="flex items-center gap-2 text-xs font-semibold mb-2"
                  style={{ color: 'var(--color-text-secondary)' }}
                >
                  {showFailed ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                  Failed Universal ({results.failedCandidates.length})
                </button>
                {showFailed && (
                  <div
                    className="rounded-xl border overflow-hidden"
                    style={{ background: 'var(--color-bg-card)', borderColor: 'var(--border-subtle)' }}
                  >
                    <table className="w-full text-xs" style={{ fontFamily: 'var(--font-body)' }}>
                      <thead>
                        <tr style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                          <th className="text-left px-4 py-2 font-semibold" style={{ color: 'var(--color-text-secondary)' }}>Cluster Label</th>
                          <th className="text-left px-4 py-2 font-semibold" style={{ color: 'var(--color-text-secondary)' }}>Source</th>
                          <th className="text-left px-4 py-2 font-semibold" style={{ color: 'var(--color-text-secondary)' }}>Type</th>
                          <th className="text-left px-4 py-2 font-semibold" style={{ color: 'var(--color-text-secondary)' }}>Passed</th>
                          <th className="text-left px-4 py-2 font-semibold" style={{ color: 'var(--color-text-secondary)' }}>Failed Criteria</th>
                        </tr>
                      </thead>
                      <tbody>
                        {results.failedCandidates.map((fc, i) => (
                          <tr key={i} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                            <td className="px-4 py-2" style={{ color: 'var(--color-text-primary)' }}>{fc.clusterLabel}</td>
                            <td className="px-4 py-2" style={{ color: 'var(--color-text-body)' }}>{fc.sourceTitle}</td>
                            <td className="px-4 py-2" style={{ color: 'var(--color-text-secondary)' }}>{fc.source_type}</td>
                            <td className="px-4 py-2" style={{ color: 'var(--color-text-body)' }}>
                              {fc.criteriaPassedCount !== undefined ? `${fc.criteriaPassedCount}/5` : '—'}
                            </td>
                            <td className="px-4 py-2" style={{ color: 'var(--color-text-secondary)' }}>
                              {fc.failedCriteria?.join(', ') ?? fc.failReason}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}

            {/* Diagnostic Notes */}
            {results.diagnosticNotes.length > 0 && (
              <div className="mt-6">
                <h3
                  className="text-xs font-bold tracking-wide mb-2"
                  style={{ fontFamily: 'var(--font-display)', color: 'var(--color-text-secondary)', letterSpacing: '0.05em' }}
                >
                  DIAGNOSTIC NOTES
                </h3>
                <div
                  className="rounded-xl border"
                  style={{ background: 'var(--color-bg-card)', borderColor: 'var(--border-subtle)', padding: '12px 20px' }}
                >
                  <ul className="space-y-1.5">
                    {results.diagnosticNotes.map((note, i) => (
                      <li key={i} className="text-xs flex items-start gap-2" style={{ fontFamily: 'var(--font-body)', color: 'var(--color-text-body)' }}>
                        <span style={{ color: 'var(--color-text-secondary)' }}>•</span>
                        {note}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

// ─── Small sub-components ─────────────────────────────────────────────────────

function StatPill({ label }: { label: string }) {
  return (
    <span
      className="text-xs font-bold"
      style={{ fontFamily: 'var(--font-display)', fontSize: 13, color: 'var(--color-text-primary)' }}
    >
      {label}
    </span>
  )
}

function Dot() {
  return <span style={{ color: 'var(--color-text-secondary)' }}>·</span>
}
