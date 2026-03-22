import { useState, useCallback } from 'react'
import { Copy, Check, KeyRound, Zap, Loader2 } from 'lucide-react'
import { useApiKeys } from '../../hooks/useApiKeys'
import { ApiKeyRow } from './ApiKeyRow'
import { KeyRevealModal } from './KeyRevealModal'

// ─── Tool list ───────────────────────────────────────────────────────────────

const MCP_TOOLS: Array<{ name: string; description: string }> = [
  { name: 'ask_synapse', description: 'Full RAG query — answer questions from your knowledge graph' },
  { name: 'search_entities', description: 'Find entities (people, projects, concepts) by name or description' },
  { name: 'get_entity', description: 'Get full detail and connections for a specific entity' },
  { name: 'get_connections', description: 'Traverse relationship network N hops from an entity' },
  { name: 'list_anchors', description: 'Return your high-signal anchor entities' },
  { name: 'get_recent_sources', description: 'List recently ingested content' },
]

// ─── Section label component ─────────────────────────────────────────────────

function SL({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="font-display font-bold uppercase"
      style={{
        fontSize: 10,
        letterSpacing: '0.08em',
        color: 'var(--color-text-secondary)',
        marginBottom: 10,
      }}
    >
      {children}
    </div>
  )
}

// ─── Panel ───────────────────────────────────────────────────────────────────

interface McpAccessPanelProps {
  onClose: () => void
}

export function McpAccessPanel({ onClose: _onClose }: McpAccessPanelProps) {
  const { keys, loading, error, createKey, revokeKey } = useApiKeys()

  const [configCopied, setConfigCopied] = useState(false)
  const [showCreateForm, setShowCreateForm] = useState(false)
  const [newLabel, setNewLabel] = useState('')
  const [labelError, setLabelError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [revealData, setRevealData] = useState<{ rawKey: string; label: string } | null>(null)

  // Build config JSON
  const origin = typeof window !== 'undefined' ? window.location.origin : 'https://your-app.vercel.app'
  const bearerHint = keys.length === 1
    ? `${keys[0]!.key_prefix}...`
    : '<your-api-key>'

  const configJson = JSON.stringify(
    {
      mcpServers: {
        synapse: {
          type: 'http',
          url: `${origin}/api/mcp`,
          headers: {
            Authorization: `Bearer ${bearerHint}`,
          },
        },
      },
    },
    null,
    2
  )

  const handleCopyConfig = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(configJson)
      setConfigCopied(true)
      setTimeout(() => setConfigCopied(false), 1500)
    } catch {
      // ignore
    }
  }, [configJson])

  const validateLabel = (value: string): boolean => {
    const trimmed = value.trim()
    if (trimmed.length === 0) {
      setLabelError('Label is required')
      return false
    }
    if (trimmed.length > 50) {
      setLabelError('Label must be 50 characters or fewer')
      return false
    }
    setLabelError(null)
    return true
  }

  const handleCreate = async () => {
    if (!validateLabel(newLabel)) return
    setCreating(true)
    const result = await createKey(newLabel.trim())
    setCreating(false)
    if (result) {
      setRevealData({ rawKey: result.rawKey, label: result.key.label })
      setShowCreateForm(false)
      setNewLabel('')
    }
  }

  const handleRevealConfirm = () => {
    setRevealData(null)
  }

  return (
    <div
      style={{
        height: '100%',
        overflowY: 'auto',
        overflowX: 'hidden',
        padding: '20px 22px',
        position: 'relative',
      }}
    >
      {/* Key reveal modal */}
      {revealData && (
        <KeyRevealModal
          rawKey={revealData.rawKey}
          label={revealData.label}
          onConfirm={handleRevealConfirm}
        />
      )}

      {/* Panel header */}
      <div style={{ marginBottom: 16 }}>
        <h2
          className="font-display"
          style={{ fontSize: 14, fontWeight: 700, color: 'var(--color-text-primary)', margin: 0 }}
        >
          API &amp; MCP Access
        </h2>
        <p
          className="font-body"
          style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 4, lineHeight: 1.5 }}
        >
          Connect Claude Code and other MCP-compatible tools to query your knowledge graph
        </p>
      </div>

      <div style={{ height: 1, background: 'var(--border-subtle)', margin: '16px 0' }} />

      {/* Setup instructions */}
      <SL>Setup</SL>
      <div style={{ position: 'relative', marginBottom: 8 }}>
        <pre
          className="font-body"
          style={{
            background: 'var(--color-bg-inset)',
            borderRadius: 10,
            padding: 12,
            fontSize: 11,
            fontFamily: 'monospace',
            color: 'var(--color-text-primary)',
            margin: 0,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all',
            lineHeight: 1.5,
            overflowX: 'auto',
          }}
        >
          {configJson}
        </pre>
        <button
          type="button"
          onClick={() => void handleCopyConfig()}
          style={{
            position: 'absolute',
            top: 8,
            right: 8,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 26,
            height: 26,
            borderRadius: 6,
            border: 'none',
            background: 'transparent',
            cursor: 'pointer',
            color: configCopied ? '#10b981' : 'var(--color-text-secondary)',
            transition: 'color 0.15s',
          }}
        >
          {configCopied ? <Check size={14} /> : <Copy size={14} />}
        </button>
      </div>
      <p
        className="font-body"
        style={{ fontSize: 11, color: 'var(--color-text-secondary)', lineHeight: 1.5 }}
      >
        Add to <code style={{ fontSize: 10 }}>~/.claude.json</code> (global) or{' '}
        <code style={{ fontSize: 10 }}>.claude/claude.json</code> (per project)
      </p>

      <div style={{ height: 1, background: 'var(--border-subtle)', margin: '16px 0' }} />

      {/* API Keys section */}
      <SL>Your API Keys</SL>

      {error && (
        <p className="font-body" style={{ fontSize: 12, color: '#ef4444', marginBottom: 8 }}>
          {error}
        </p>
      )}

      {loading ? (
        <div style={{ textAlign: 'center', padding: '20px 0' }}>
          <Loader2
            size={20}
            style={{
              color: 'var(--color-text-secondary)',
              animation: 'spin 1s linear infinite',
            }}
          />
        </div>
      ) : keys.length === 0 && !showCreateForm ? (
        /* Empty state */
        <div style={{ textAlign: 'center', paddingTop: 40 }}>
          <KeyRound size={24} style={{ color: 'var(--color-text-secondary)', margin: '0 auto' }} />
          <p
            className="font-body font-semibold"
            style={{ fontSize: 13, color: 'var(--color-text-primary)', marginTop: 6 }}
          >
            No API keys yet
          </p>
          <p
            className="font-body"
            style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 2 }}
          >
            Create a key to connect external tools
          </p>
          <button
            type="button"
            onClick={() => setShowCreateForm(true)}
            className="font-body font-semibold"
            style={{
              marginTop: 16,
              width: '100%',
              height: 36,
              borderRadius: 8,
              border: 'none',
              background: 'var(--color-accent-500)',
              color: 'white',
              fontSize: 13,
              cursor: 'pointer',
            }}
          >
            Generate API Key
          </button>
        </div>
      ) : (
        /* Keys list */
        <div>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {keys.map(k => (
              <ApiKeyRow key={k.id} apiKey={k} onRevoke={revokeKey} />
            ))}
          </div>

          {/* Create form or generate button */}
          {showCreateForm ? (
            <div style={{ marginTop: 12 }}>
              <input
                type="text"
                value={newLabel}
                onChange={e => {
                  setNewLabel(e.target.value)
                  if (labelError) validateLabel(e.target.value)
                }}
                onBlur={() => { if (newLabel) validateLabel(newLabel) }}
                placeholder="Key label — e.g. Claude Code Work"
                className="font-body"
                style={{
                  width: '100%',
                  padding: '8px 12px',
                  borderRadius: 8,
                  border: labelError ? '1px solid #ef4444' : '1px solid var(--border-subtle)',
                  background: 'var(--color-bg-inset)',
                  fontSize: 12,
                  color: 'var(--color-text-primary)',
                  outline: 'none',
                  boxSizing: 'border-box',
                }}
              />
              {labelError && (
                <p className="font-body" style={{ fontSize: 11, color: '#ef4444', marginTop: 4 }}>
                  {labelError}
                </p>
              )}
              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <button
                  type="button"
                  onClick={() => void handleCreate()}
                  disabled={creating}
                  className="font-body font-semibold"
                  style={{
                    flex: 1,
                    height: 32,
                    borderRadius: 6,
                    border: 'none',
                    background: 'var(--color-accent-500)',
                    color: 'white',
                    fontSize: 12,
                    cursor: creating ? 'not-allowed' : 'pointer',
                    opacity: creating ? 0.6 : 1,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 6,
                  }}
                >
                  {creating && (
                    <Loader2
                      size={12}
                      style={{ animation: 'spin 1s linear infinite' }}
                    />
                  )}
                  Create
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowCreateForm(false)
                    setNewLabel('')
                    setLabelError(null)
                  }}
                  className="font-body"
                  style={{
                    height: 32,
                    padding: '0 12px',
                    borderRadius: 6,
                    border: 'none',
                    background: 'transparent',
                    color: 'var(--color-text-secondary)',
                    fontSize: 12,
                    cursor: 'pointer',
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setShowCreateForm(true)}
              className="font-body font-semibold"
              style={{
                marginTop: 12,
                width: '100%',
                height: 36,
                borderRadius: 8,
                border: 'none',
                background: 'var(--color-text-primary)',
                color: 'white',
                fontSize: 13,
                cursor: 'pointer',
              }}
            >
              Generate API Key
            </button>
          )}
        </div>
      )}

      <div style={{ height: 1, background: 'var(--border-subtle)', margin: '16px 0' }} />

      {/* Available Tools section */}
      <SL>Available Tools</SL>
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {MCP_TOOLS.map((tool, i) => (
          <div
            key={tool.name}
            style={{
              padding: '10px 0',
              borderBottom: i < MCP_TOOLS.length - 1 ? '1px solid var(--border-subtle)' : 'none',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
              <Zap size={12} style={{ color: 'var(--color-text-secondary)', flexShrink: 0 }} />
              <span
                className="font-body font-semibold"
                style={{ fontSize: 12, color: 'var(--color-text-primary)' }}
              >
                {tool.name}
              </span>
            </div>
            <p
              className="font-body"
              style={{
                fontSize: 11,
                color: 'var(--color-text-secondary)',
                margin: 0,
                paddingLeft: 18,
                lineHeight: 1.4,
              }}
            >
              {tool.description}
            </p>
          </div>
        ))}
      </div>

      {/* Vercel timeout note */}
      <p
        className="font-body"
        style={{ fontSize: 10, color: 'var(--color-text-placeholder)', marginTop: 16, lineHeight: 1.5 }}
      >
        Note: complex queries may time out on Vercel&apos;s free tier. Upgrade to Vercel Pro for 60s
        function timeout.
      </p>
    </div>
  )
}
