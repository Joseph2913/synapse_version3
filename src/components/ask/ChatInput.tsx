import { useRef, useState, useCallback, useEffect } from 'react'
import { ArrowUp, Plus, X } from 'lucide-react'
import { InlineQueryToolbar } from './InlineQueryToolbar'
import type { InlineQueryToolbarProps } from './InlineQueryToolbar'
import { QUERY_MINDSETS, MODEL_TIERS } from '../../config/queryMindsets'
import { TOOL_MODES } from '../../config/toolModes'

interface ChatInputProps extends InlineQueryToolbarProps {
  onSend: (text: string) => void
  disabled?: boolean
  helperText?: string
  embedded?: boolean
}

export function ChatInput({
  onSend,
  disabled = false,
  helperText,
  embedded = false,
  config,
  onSetMindset,
  onToggleScopeAnchor,
  onClearScope,
  onSetToolMode,
  onSetModelTier,
}: ChatInputProps) {
  const [value, setValue] = useState('')
  const [focused, setFocused] = useState(false)
  const [showToolbar, setShowToolbar] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const toolbarRef = useRef<HTMLDivElement>(null)

  const handleSend = useCallback(() => {
    const text = value.trim()
    if (!text || disabled) return
    onSend(text)
    setValue('')
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }
  }, [value, disabled, onSend])

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
    if (e.key === 'Escape') {
      setValue('')
      if (textareaRef.current) textareaRef.current.style.height = 'auto'
    }
  }

  const handleInput = (e: React.FormEvent<HTMLTextAreaElement>) => {
    const target = e.currentTarget
    target.style.height = 'auto'
    target.style.height = Math.min(target.scrollHeight, 120) + 'px'
    setValue(target.value)
  }

  // Close toolbar on outside click
  useEffect(() => {
    if (!showToolbar) return
    const handler = (e: MouseEvent) => {
      if (
        toolbarRef.current &&
        !toolbarRef.current.contains(e.target as Node) &&
        !(e.target as HTMLElement).closest('[data-ask-dd]')
      ) {
        setShowToolbar(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showToolbar])

  const canSend = value.trim().length > 0 && !disabled

  // Compact config summary for bottom row
  const activeMindset = QUERY_MINDSETS.find(m => m.id === config.mindset)
  const activeMode = TOOL_MODES.find(m => m.id === config.toolMode)
  const activeModel = MODEL_TIERS.find(t => t.id === config.modelTier)
  const configSummary = [activeMindset?.label, activeMode?.label, activeModel?.label]
    .filter(Boolean)
    .join(' · ')

  return (
    <div
      className="shrink-0"
      style={{
        width: '100%',
        background: embedded ? 'transparent' : 'var(--color-bg-content)',
        padding: embedded ? '0 24px' : '12px 24px 0',
      }}
    >
      <div style={{ maxWidth: 680, margin: '0 auto', width: '100%' }}>
        {/* Toolbar popover — appears above the input */}
        {showToolbar && (
          <div
            ref={toolbarRef}
            style={{
              marginBottom: 8,
              padding: '8px 12px',
              background: 'var(--color-bg-card)',
              border: '1px solid var(--border-default)',
              borderRadius: 12,
              boxShadow: '0 4px 20px rgba(0,0,0,0.1)',
            }}
          >
            <div className="flex items-center justify-between" style={{ marginBottom: 6 }}>
              <span
                className="font-display font-bold uppercase"
                style={{ fontSize: 9, letterSpacing: '0.08em', color: 'var(--color-text-secondary)' }}
              >
                Query Settings
              </span>
              <button
                type="button"
                onClick={() => setShowToolbar(false)}
                className="cursor-pointer flex items-center justify-center"
                style={{
                  background: 'none',
                  border: 'none',
                  color: 'var(--color-text-secondary)',
                  padding: 2,
                }}
              >
                <X size={12} />
              </button>
            </div>
            <InlineQueryToolbar
              config={config}
              onSetMindset={onSetMindset}
              onToggleScopeAnchor={onToggleScopeAnchor}
              onClearScope={onClearScope}
              onSetToolMode={onSetToolMode}
              onSetModelTier={onSetModelTier}
            />
          </div>
        )}

        {/* Main input container */}
        <div
          style={{
            background: 'var(--color-bg-card)',
            border: `1px solid ${focused ? 'rgba(214,58,0,0.3)' : 'var(--border-default)'}`,
            borderRadius: 16,
            boxShadow: focused
              ? '0 0 0 3px var(--color-accent-50), 0 2px 12px rgba(0,0,0,0.06)'
              : '0 2px 12px rgba(0,0,0,0.04)',
            transition: 'border-color 0.15s ease, box-shadow 0.15s ease',
            overflow: 'hidden',
          }}
        >
          {/* Textarea area */}
          <div style={{ padding: '12px 16px 0' }}>
            <textarea
              ref={textareaRef}
              rows={1}
              placeholder="Ask your knowledge graph anything..."
              value={value}
              onInput={handleInput}
              onKeyDown={handleKeyDown}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              className="font-body w-full resize-none outline-none"
              style={{
                background: 'transparent',
                border: 'none',
                fontSize: 13,
                fontWeight: 400,
                color: 'var(--color-text-primary)',
                lineHeight: 1.5,
                maxHeight: 120,
                overflowY: 'auto',
              }}
            />
          </div>

          {/* Bottom controls row */}
          <div
            className="flex items-center justify-between"
            style={{ padding: '8px 12px' }}
          >
            {/* Left: + button */}
            <div className="flex items-center" style={{ gap: 4 }}>
              <button
                type="button"
                onClick={() => setShowToolbar(prev => !prev)}
                className="flex items-center justify-center cursor-pointer"
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: 8,
                  background: showToolbar ? 'var(--color-accent-50)' : 'transparent',
                  border: `1px solid ${showToolbar ? 'rgba(214,58,0,0.2)' : 'var(--border-subtle)'}`,
                  color: showToolbar ? 'var(--color-accent-500)' : 'var(--color-text-secondary)',
                  transition: 'all 0.15s ease',
                }}
              >
                <Plus size={14} />
              </button>
            </div>

            {/* Right: config summary + send */}
            <div className="flex items-center" style={{ gap: 10 }}>
              <span
                className="font-body"
                style={{
                  fontSize: 11,
                  color: 'var(--color-text-secondary)',
                  fontWeight: 500,
                }}
              >
                {helperText ?? configSummary}
              </span>
              <button
                type="button"
                onClick={handleSend}
                disabled={!canSend}
                className="shrink-0 flex items-center justify-center cursor-pointer"
                style={{
                  width: 30,
                  height: 30,
                  borderRadius: 10,
                  background: canSend ? 'var(--color-accent-500)' : 'var(--color-bg-inset)',
                  border: canSend ? 'none' : '1px solid var(--border-subtle)',
                  cursor: canSend ? 'pointer' : 'default',
                  pointerEvents: canSend ? 'auto' : 'none',
                  transition: 'background 0.15s ease',
                }}
                onMouseEnter={e => {
                  if (canSend) (e.currentTarget as HTMLButtonElement).style.background = '#b83300'
                }}
                onMouseLeave={e => {
                  if (canSend) (e.currentTarget as HTMLButtonElement).style.background = 'var(--color-accent-500)'
                }}
              >
                <ArrowUp size={13} color={canSend ? '#ffffff' : 'var(--color-text-placeholder)'} />
              </button>
            </div>
          </div>
        </div>

        {/* Disclaimer */}
        <p
          className="font-body text-center"
          style={{
            fontSize: 10,
            color: 'var(--color-text-placeholder)',
            marginTop: 8,
            marginBottom: 4,
            lineHeight: 1.4,
          }}
        >
          Synapse is an AI tool and can make mistakes. Please double-check responses.
        </p>
      </div>
    </div>
  )
}
