import { useState } from 'react'
import { Copy, Check, KeyRound, Zap, Loader2, ExternalLink, ChevronDown, ChevronUp } from 'lucide-react'
import { useApiKeys } from '../../hooks/useApiKeys'
import { ApiKeyRow } from './ApiKeyRow'
import { KeyRevealModal } from './KeyRevealModal'

// ─── External link helper ────────────────────────────────────────────────────

function ExtLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="font-body"
      style={{
        fontSize: 12,
        color: '#d63a00',
        textDecoration: 'none',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
      }}
      onMouseEnter={e => { (e.currentTarget as HTMLAnchorElement).style.textDecoration = 'underline' }}
      onMouseLeave={e => { (e.currentTarget as HTMLAnchorElement).style.textDecoration = 'none' }}
    >
      {children}
      <ExternalLink size={11} />
    </a>
  )
}

// ─── Code block helper ───────────────────────────────────────────────────────

function CodeBlock({ children, copyable }: { children: string; copyable?: boolean }) {
  const [copied, setCopied] = useState(false)
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(children)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch { /* ignore */ }
  }
  return (
    <div style={{ position: 'relative' }}>
      <pre
        className="font-body"
        style={{
          background: 'var(--color-bg-inset)',
          borderRadius: 8,
          padding: 10,
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
        {children}
      </pre>
      {copyable && (
        <button
          type="button"
          onClick={() => void handleCopy()}
          style={{
            position: 'absolute',
            top: 6,
            right: 6,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 24,
            height: 24,
            borderRadius: 5,
            border: 'none',
            background: 'transparent',
            cursor: 'pointer',
            color: copied ? '#10b981' : 'var(--color-text-secondary)',
            transition: 'color 0.15s',
          }}
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
        </button>
      )}
    </div>
  )
}

// ─── Step card helper ────────────────────────────────────────────────────────

function StepCard({ step, title, children }: { step: number; title: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        background: 'var(--color-bg-card)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 12,
        padding: '14px 16px',
      }}
    >
      <div
        className="font-display font-bold uppercase"
        style={{ fontSize: 11, color: 'var(--color-text-secondary)', marginBottom: 4 }}
      >
        Step {step}
      </div>
      <div
        className="font-display"
        style={{ fontSize: 13, fontWeight: 700, color: 'var(--color-text-primary)', marginBottom: 8 }}
      >
        {title}
      </div>
      <div className="font-body" style={{ fontSize: 12, color: 'var(--color-text-body)', lineHeight: 1.6 }}>
        {children}
      </div>
    </div>
  )
}

// ─── Connection Guide ────────────────────────────────────────────────────────

function ConnectionGuide({ keysExist, keyPrefixHint, origin }: { keysExist: boolean; keyPrefixHint: string; origin: string }) {
  const [expanded, setExpanded] = useState(!keysExist)

  const configBlock = JSON.stringify(
    {
      mcpServers: {
        synapse: {
          command: 'npx',
          args: [
            'mcp-remote',
            `${origin}/api/mcp`,
            '--header',
            `Authorization:Bearer ${keyPrefixHint}`,
          ],
        },
      },
    },
    null,
    2
  )

  return (
    <div>
      {/* Section header with collapse toggle */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: expanded ? 10 : 0 }}>
        <div
          className="font-display font-bold uppercase"
          style={{ fontSize: 10, letterSpacing: '0.08em', color: 'var(--color-text-secondary)' }}
        >
          Connection Guide
        </div>
        <button
          type="button"
          onClick={() => setExpanded(prev => !prev)}
          className="font-body"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            fontSize: 12,
            color: 'var(--color-text-secondary)',
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            padding: 0,
          }}
        >
          {expanded ? 'Hide guide' : 'Show setup guide'}
          {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </button>
      </div>

      {expanded && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {/* Step 1 */}
          <StepCard step={1} title="Check you have Claude Desktop installed">
            <p style={{ margin: '0 0 8px' }}>
              You need the Claude Desktop app installed on your Mac or Windows machine. This is separate from the Claude web app.
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <ExtLink href="https://claude.ai/download">Download Claude Desktop</ExtLink>
            </div>
          </StepCard>

          {/* Step 2 */}
          <StepCard step={2} title="Check Node.js is installed">
            <p style={{ margin: '0 0 8px' }}>
              Claude Desktop uses a package called <strong>mcp-remote</strong> to connect to hosted MCP servers. This requires Node.js to be installed on your machine. Open Terminal (Mac) or Command Prompt (Windows) and run:
            </p>
            <CodeBlock>node --version</CodeBlock>
            <p style={{ margin: '8px 0' }}>
              If you see a version number, you&apos;re ready. If not, install the LTS version.
            </p>
            <ExtLink href="https://nodejs.org">Download Node.js (LTS)</ExtLink>
          </StepCard>

          {/* Step 3 */}
          <StepCard step={3} title="Generate your Synapse API key">
            <p style={{ margin: '0 0 6px' }}>
              Click &ldquo;Generate API Key&rdquo; below, give it a label like &ldquo;Claude Desktop&rdquo;, and copy the key when it appears. It will only be shown once.
            </p>
            <p style={{ margin: 0, fontSize: 11, color: 'var(--color-text-secondary)' }}>
              Already have a key? Skip to Step 4.
            </p>
          </StepCard>

          {/* Step 4 */}
          <StepCard step={4} title="Open your Claude Desktop config file">
            <p style={{ margin: '0 0 8px' }}>
              Open the configuration file in a text editor. The file is located at:
            </p>
            <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
              <div style={{ flex: 1 }}>
                <div className="font-body font-semibold" style={{ fontSize: 10, color: 'var(--color-text-secondary)', marginBottom: 4, textTransform: 'uppercase' }}>Mac</div>
                <CodeBlock>{'~/Library/Application Support/Claude/claude_desktop_config.json'}</CodeBlock>
              </div>
              <div style={{ flex: 1 }}>
                <div className="font-body font-semibold" style={{ fontSize: 10, color: 'var(--color-text-secondary)', marginBottom: 4, textTransform: 'uppercase' }}>Windows</div>
                <CodeBlock>{'%APPDATA%\\Claude\\claude_desktop_config.json'}</CodeBlock>
              </div>
            </div>
            <p style={{ margin: '0 0 8px' }}>
              If the file doesn&apos;t exist yet, create it. If it already exists, you&apos;ll be adding to it — don&apos;t replace the whole file.
            </p>
            <ExtLink href="https://modelcontextprotocol.io/docs/develop/connect-local-servers">Claude Desktop MCP setup docs</ExtLink>
          </StepCard>

          {/* Step 5 */}
          <StepCard step={5} title="Add the Synapse server config">
            <p style={{ margin: '0 0 8px' }}>
              Add the following block to your config file. If there&apos;s already a <code style={{ fontSize: 10 }}>mcpServers</code> object, add the <code style={{ fontSize: 10 }}>synapse</code> entry inside it rather than creating a second one.
            </p>
            <CodeBlock copyable>{configBlock}</CodeBlock>
          </StepCard>

          {/* Step 6 */}
          <StepCard step={6} title="Restart Claude Desktop">
            <p style={{ margin: 0 }}>
              Save the file, then fully quit Claude Desktop — on Mac press <strong>Cmd+Q</strong> or go to Claude → Quit Claude in the menu bar. Closing the window is not enough. Then reopen it.
            </p>
          </StepCard>

          {/* Step 7 */}
          <StepCard step={7} title="Verify the connection">
            <p style={{ margin: '0 0 8px' }}>
              Go to Claude Desktop → Settings → Developer. You should see &ldquo;synapse&rdquo; listed with a blue &ldquo;running&rdquo; badge. You can also click the hammer icon at the bottom of the chat input to see all available Synapse tools.
            </p>
            <div
              style={{
                background: 'rgba(16, 185, 129, 0.06)',
                border: '1px solid rgba(16, 185, 129, 0.2)',
                borderRadius: 8,
                padding: '10px 12px',
                marginBottom: 8,
              }}
            >
              <p className="font-body" style={{ fontSize: 12, color: '#059669', margin: 0, lineHeight: 1.5 }}>
                Once connected, you can query your knowledge graph from any Claude Desktop conversation. Try: &ldquo;Using my Synapse knowledge graph, what have I been working on this week?&rdquo;
              </p>
            </div>
            <ExtLink href="https://support.anthropic.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop">Troubleshooting MCP connections</ExtLink>
          </StepCard>
        </div>
      )}
    </div>
  )
}

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

  const [showCreateForm, setShowCreateForm] = useState(false)
  const [newLabel, setNewLabel] = useState('')
  const [labelError, setLabelError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [revealData, setRevealData] = useState<{ rawKey: string; label: string } | null>(null)

  const origin = typeof window !== 'undefined' ? window.location.origin : 'https://your-app.vercel.app'

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

      {/* Connection guide */}
      <ConnectionGuide
        keysExist={keys.length > 0}
        keyPrefixHint={keys.length > 0 ? `${keys[0]!.key_prefix}...your-full-key-here` : 'sk-syn-your-full-key-here'}
        origin={origin}
      />

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
