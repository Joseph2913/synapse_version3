import { useCallback, useContext, useEffect, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { Anchor, Clock } from 'lucide-react'
import { useGraphContext } from '../../hooks/useGraphContext'
import { useSettings } from '../../hooks/useSettings'
import { supabase } from '../../services/supabase'
import { Dot } from '../ui/Dot'
import { SectionLabel } from '../ui/SectionLabel'
import { NodeDetail } from '../panels/NodeDetail'
import { SourceDetail } from '../panels/SourceDetail'
import { AskRightPanel } from '../ask/AskRightPanel'
import { McpAccessPanel } from '../automate/McpAccessPanel'
import { KnowledgeSnapshotPanel } from '../home/KnowledgeSnapshotPanel'
import { HomeDashboardContext } from '../../app/providers/HomeDashboardProvider'
import type { KnowledgeNode } from '../../types/database'

const MIN_WIDTH = 240
const MAX_WIDTH = 560
const DEFAULT_WIDTH = 310

function loadWidth(): number {
  try {
    const v = localStorage.getItem('rightPanelWidth')
    if (v) {
      const n = parseInt(v, 10)
      if (n >= MIN_WIDTH && n <= MAX_WIDTH) return n
    }
  } catch { /* ignore */ }
  return DEFAULT_WIDTH
}

function formatRelativeTime(dateStr: string): string {
  const now = Date.now()
  const then = new Date(dateStr).getTime()
  const diff = now - then
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  const months = Math.floor(days / 30)
  return `${months}mo ago`
}

function QuickAccess() {
  const { anchors } = useSettings()
  const { setRightPanelContent } = useGraphContext()
  const [recentNodes, setRecentNodes] = useState<KnowledgeNode[]>([])

  useEffect(() => {
    async function fetchRecent() {
      const { data } = await supabase
        .from('knowledge_nodes')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(10)
      if (data) setRecentNodes(data as KnowledgeNode[])
    }
    fetchRecent()
  }, [])

  return (
    <div className="flex flex-col gap-6">
      {/* Anchors */}
      <div>
        <div className="flex items-center gap-2 mb-3">
          <Anchor size={12} style={{ color: 'var(--color-text-secondary)' }} />
          <SectionLabel>Anchors</SectionLabel>
        </div>

        {anchors.length === 0 ? (
          <p className="text-[11px] text-text-placeholder px-1">
            No anchors set. Promote nodes from the Explore view.
          </p>
        ) : (
          <div className="flex flex-col gap-0.5">
            {anchors.map((anchor) => (
              <button
                key={anchor.id}
                type="button"
                onClick={() => setRightPanelContent({ type: 'node', data: anchor })}
                className="flex items-center gap-2 w-full border-none cursor-pointer px-2 py-1.5 rounded-[7px] hover:bg-bg-hover"
                style={{ background: 'transparent', transition: 'background 0.15s ease' }}
              >
                <Dot type={anchor.entity_type} size={7} />
                <span className="font-body text-[12px] font-medium text-text-primary truncate flex-1 text-left">
                  {anchor.label}
                </span>
                <span className="font-body text-[10px] text-text-secondary shrink-0">
                  {anchor.entity_type}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Recent */}
      <div>
        <div className="flex items-center gap-2 mb-3">
          <Clock size={12} style={{ color: 'var(--color-text-secondary)' }} />
          <SectionLabel>Recent</SectionLabel>
        </div>

        {recentNodes.length === 0 ? (
          <p className="text-[11px] text-text-placeholder px-1">
            No entities yet. Ingest your first source to get started.
          </p>
        ) : (
          <div className="flex flex-col gap-0.5">
            {recentNodes.map((node) => (
              <button
                key={node.id}
                type="button"
                onClick={() => setRightPanelContent({ type: 'node', data: node })}
                className="flex items-center gap-2 w-full border-none cursor-pointer px-2 py-1.5 rounded-[7px] hover:bg-bg-hover"
                style={{ background: 'transparent', transition: 'background 0.15s ease' }}
              >
                <Dot type={node.entity_type} size={5} />
                <span className="font-body text-[11px] text-text-secondary truncate flex-1 text-left">
                  {node.label}
                </span>
                <span className="font-body text-[10px] text-text-placeholder shrink-0">
                  {formatRelativeTime(node.created_at)}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

export function RightPanel() {
  const location = useLocation()
  const { rightPanelContent, clearRightPanel, askContext, setRightPanelContent } = useGraphContext()
  const isAskView = location.pathname === '/ask'
  const isHomeView = location.pathname === '/'

  // Home view: snapshot + pipeline from cached dashboard provider
  const dashboardCtx = useContext(HomeDashboardContext)
  const homeSnapshot = dashboardCtx?.snapshot ?? null
  const homePipeline = dashboardCtx?.pipelineStatus ?? null

  // ── Resizable width ────────────────────────────────────────────────────
  const [panelWidth, setPanelWidth] = useState(loadWidth)
  const isDragging = useRef(false)
  const dragStartX = useRef(0)
  const dragStartW = useRef(0)
  const handleRef = useRef<HTMLDivElement>(null)

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      isDragging.current = true
      dragStartX.current = e.clientX
      dragStartW.current = panelWidth
      document.body.style.cursor = 'ew-resize'
      document.body.style.userSelect = 'none'

      const onMove = (ev: MouseEvent) => {
        if (!isDragging.current) return
        // Left edge drag: moving left (smaller clientX) → increase width
        const delta = dragStartX.current - ev.clientX
        const next = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, dragStartW.current + delta))
        setPanelWidth(next)
        try { localStorage.setItem('rightPanelWidth', String(next)) } catch { /* ignore */ }
      }

      const onUp = () => {
        isDragging.current = false
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
        if (handleRef.current) handleRef.current.style.background = 'transparent'
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
      }

      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
    },
    [panelWidth],
  )

  // ── Content ────────────────────────────────────────────────────────────

  const handleBackToAskContext = () => {
    if (askContext) {
      setRightPanelContent({ type: 'ask_context', data: askContext })
    } else {
      clearRightPanel()
    }
  }

  const renderContent = () => {
    if (rightPanelContent?.type === 'mcp-access') {
      return <McpAccessPanel onClose={clearRightPanel} />
    }
    if (rightPanelContent?.type === 'ask_context') {
      return <AskRightPanel context={rightPanelContent.data} />
    }
    if (rightPanelContent?.type === 'node') {
      return (
        <div className="flex flex-col gap-0">
          {isAskView && askContext && (
            <button
              type="button"
              onClick={handleBackToAskContext}
              className="font-body font-semibold cursor-pointer mb-3 text-left"
              style={{
                fontSize: 11,
                color: 'var(--color-text-secondary)',
                background: 'none',
                border: 'none',
                padding: '0 0 8px 0',
                borderBottom: '1px solid var(--border-subtle)',
              }}
            >
              ← Back to Context
            </button>
          )}
          <NodeDetail node={rightPanelContent.data} onClose={isAskView ? handleBackToAskContext : clearRightPanel} />
        </div>
      )
    }
    if (rightPanelContent?.type === 'source') {
      return (
        <div className="flex flex-col gap-0">
          {isAskView && askContext && (
            <button
              type="button"
              onClick={handleBackToAskContext}
              className="font-body font-semibold cursor-pointer mb-3 text-left"
              style={{
                fontSize: 11,
                color: 'var(--color-text-secondary)',
                background: 'none',
                border: 'none',
                padding: '0 0 8px 0',
                borderBottom: '1px solid var(--border-subtle)',
              }}
            >
              ← Back to Context
            </button>
          )}
          <SourceDetail source={rightPanelContent.data} onClose={isAskView ? handleBackToAskContext : clearRightPanel} />
        </div>
      )
    }
    if (rightPanelContent?.type === 'crossConnection') {
      const { sourceNode, targetNode, relation_type, sourceTitles } = rightPanelContent.data
      return (
        <div className="flex flex-col gap-4">
          <button
            type="button"
            onClick={clearRightPanel}
            className="font-body font-semibold cursor-pointer text-left"
            style={{
              fontSize: 11,
              color: 'var(--color-text-secondary)',
              background: 'none',
              border: 'none',
              padding: '0 0 8px 0',
              borderBottom: '1px solid var(--border-subtle)',
            }}
          >
            ← Back
          </button>

          {/* Node A */}
          <div className="bg-bg-content border border-border-subtle rounded-[10px] p-3">
            <div className="flex items-center gap-2 mb-1">
              <Dot type={sourceNode.entity_type} size={7} />
              <span className="text-[12px] font-[600] text-text-primary">{sourceNode.label}</span>
            </div>
            <span className="text-[10px] text-text-secondary">{sourceNode.entity_type}</span>
          </div>

          {/* Relation */}
          <div className="flex justify-center">
            <span className="text-[10px] font-[600] text-accent-500 bg-accent-50 px-[8px] py-[3px] rounded">
              {relation_type.replace(/_/g, ' ')}
            </span>
          </div>

          {/* Node B */}
          <div className="bg-bg-content border border-border-subtle rounded-[10px] p-3">
            <div className="flex items-center gap-2 mb-1">
              <Dot type={targetNode.entity_type} size={7} />
              <span className="text-[12px] font-[600] text-text-primary">{targetNode.label}</span>
            </div>
            <span className="text-[10px] text-text-secondary">{targetNode.entity_type}</span>
          </div>

          {/* Source Attribution */}
          <div className="border-t border-border-subtle pt-3 mt-1">
            <div className="text-[10px] uppercase tracking-[0.06em] font-[700] text-text-secondary font-display mb-2">
              Sources
            </div>
            {sourceTitles.map((title, i) => (
              <p key={i} className="text-[11px] text-text-body mb-1">{title}</p>
            ))}
          </div>
        </div>
      )
    }
    if (isAskView) {
      return (
        <div className="flex flex-col gap-3">
          <p
            className="font-body"
            style={{ fontSize: 12, color: 'var(--color-text-placeholder)', lineHeight: 1.6 }}
          >
            Ask a question to see the context subgraph and source chunks used for the response.
          </p>
        </div>
      )
    }
    if (isHomeView) {
      return (
        <KnowledgeSnapshotPanel
          snapshot={homeSnapshot}
          pipeline={homePipeline}
          onAnchorClick={(anchorId) => {
            // Fetch node and show in panel — for now, use a lightweight approach
            supabase
              .from('knowledge_nodes')
              .select('*')
              .eq('id', anchorId)
              .maybeSingle()
              .then(({ data }) => {
                if (data) setRightPanelContent({ type: 'node', data: data as KnowledgeNode })
              })
          }}
        />
      )
    }
    return <QuickAccess />
  }

  const panelTitle = () => {
    if (rightPanelContent?.type === 'mcp-access') return 'API & MCP Access'
    if (rightPanelContent?.type === 'ask_context') return 'Context'
    if (rightPanelContent?.type === 'crossConnection') return 'Cross-Connection'
    if (!rightPanelContent) {
      if (isAskView) return 'Context'
      if (isHomeView) return 'Knowledge Snapshot'
      return 'Quick Access'
    }
    if (rightPanelContent.type === 'node') return 'Entity Detail'
    if (rightPanelContent.type === 'source') return 'Source Detail'
    return 'Detail'
  }

  return (
    <aside
      className="flex flex-col h-screen shrink-0 overflow-hidden"
      style={{
        width: panelWidth,
        background: 'rgba(255, 255, 255, 0.82)',
        backdropFilter: 'blur(16px)',
        WebkitBackdropFilter: 'blur(16px)',
        borderLeft: '1px solid rgba(255, 255, 255, 0.6)',
        boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.4), -4px 0 20px rgba(180,89,0,0.04)',
        position: 'relative',
      }}
    >
      {/* Drag handle — 4px strip on left edge */}
      <div
        ref={handleRef}
        onMouseDown={handleMouseDown}
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: 4,
          height: '100%',
          cursor: 'ew-resize',
          zIndex: 10,
          background: 'rgba(0,0,0,0.03)',
          transition: 'background 0.2s var(--ease-out-expo)',
        }}
        onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.background = 'rgba(214,58,0,0.18)' }}
        onMouseLeave={e => {
          if (!isDragging.current) (e.currentTarget as HTMLDivElement).style.background = 'rgba(0,0,0,0.03)'
        }}
      />

      {/* Panel header */}
      <div
        className="shrink-0 px-4 flex items-center"
        style={{
          height: 50,
          background: 'rgba(255, 255, 255, 0.92)',
          backdropFilter: 'blur(20px)',
          WebkitBackdropFilter: 'blur(20px)',
          borderBottom: '1px solid rgba(255,255,255,0.5)',
          boxShadow: '0 1px 3px rgba(180,89,0,0.02)',
        }}
      >
        <span className="font-display text-[12px] font-bold text-text-secondary uppercase tracking-[0.06em]">
          {panelTitle()}
        </span>
      </div>

      {/* Scrollable content */}
      <div
        className="flex-1 overflow-y-auto"
        style={{
          padding: 24,
          overflowX: 'hidden',
          minWidth: 0,
          overflowWrap: 'break-word',
          wordBreak: 'break-word',
        }}
      >
        {renderContent()}
      </div>
    </aside>
  )
}
