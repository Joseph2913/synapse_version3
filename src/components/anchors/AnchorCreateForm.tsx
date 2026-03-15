import { useState, useEffect, useRef } from 'react'
import { X, Search } from 'lucide-react'
import { searchNodesByLabel } from '../../services/supabase'
import { getEntityColor } from '../../config/entityTypes'
import type { KnowledgeNode } from '../../types/database'

interface AnchorCreateFormProps {
  onSave: (nodeId: string) => Promise<void>
  onClose: () => void
}

export function AnchorCreateForm({ onSave, onClose }: AnchorCreateFormProps) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<KnowledgeNode[]>([])
  const [selectedNode, setSelectedNode] = useState<KnowledgeNode | null>(null)
  const [showDropdown, setShowDropdown] = useState(false)
  const [saving, setSaving] = useState(false)
  const searchRef = useRef<HTMLDivElement>(null)

  // Search as user types
  useEffect(() => {
    if (query.length < 2) { setResults([]); setShowDropdown(false); return }
    const timer = setTimeout(async () => {
      const data = await searchNodesByLabel(query, 15)
      // Filter out nodes that are already anchors
      setResults(data.filter(n => !n.is_anchor))
      setShowDropdown(true)
    }, 300)
    return () => clearTimeout(timer)
  }, [query])

  // Click outside to close dropdown
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) {
        setShowDropdown(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const handleSelect = (node: KnowledgeNode) => {
    setSelectedNode(node)
    setQuery(node.label)
    setShowDropdown(false)
  }

  const handleSave = async () => {
    if (!selectedNode) return
    setSaving(true)
    try {
      await onSave(selectedNode.id)
    } finally {
      setSaving(false)
    }
  }

  const isDirty = query.length > 0 || selectedNode !== null

  return (
    <div style={{ height: '100%', overflowY: 'auto', padding: '24px 20px' }}>
      {/* Header */}
      <div className="flex items-center justify-between" style={{ marginBottom: 20 }}>
        <h3 className="font-display" style={{ fontSize: 15, fontWeight: 700, color: 'var(--color-text-primary)', margin: 0 }}>
          New Anchor
        </h3>
        <button type="button" onClick={() => {
          if (isDirty) {
            if (window.confirm('Discard changes?')) onClose()
          } else {
            onClose()
          }
        }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-text-secondary)', padding: 4 }}>
          <X size={16} />
        </button>
      </div>

      {/* Node search */}
      <div ref={searchRef} style={{ position: 'relative', marginBottom: 16 }}>
        <div style={{ position: 'relative' }}>
          <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--color-text-secondary)' }} />
          <input
            type="text"
            value={query}
            onChange={e => { setQuery(e.target.value); setSelectedNode(null) }}
            placeholder="Search for a node to anchor..."
            className="font-body w-full"
            style={{
              background: 'var(--color-bg-inset)', border: '1px solid var(--border-subtle)',
              borderRadius: 8, padding: '8px 12px 8px 32px', fontSize: 13,
              color: 'var(--color-text-body)', outline: 'none',
            }}
            onFocus={() => { if (results.length > 0) setShowDropdown(true) }}
          />
        </div>

        {showDropdown && results.length > 0 && (
          <div style={{
            position: 'absolute', top: '100%', left: 0, right: 0, marginTop: 4,
            background: 'var(--color-bg-card)', border: '1px solid var(--border-strong, var(--border-subtle))',
            borderRadius: 10, boxShadow: '0 4px 16px rgba(0,0,0,0.08)', padding: 4, zIndex: 50,
            maxHeight: 240, overflowY: 'auto',
          }}>
            {results.map(node => (
              <button
                key={node.id}
                type="button"
                onClick={() => handleSelect(node)}
                className="flex items-center gap-2 w-full text-left font-body"
                style={{
                  padding: '8px 10px', borderRadius: 6, background: 'transparent',
                  border: 'none', cursor: 'pointer', fontSize: 12, color: 'var(--color-text-body)',
                  transition: 'background 0.1s ease',
                }}
                onMouseEnter={e => { e.currentTarget.style.background = 'var(--color-bg-inset)' }}
                onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
              >
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: getEntityColor(node.entity_type), flexShrink: 0 }} />
                <span className="truncate flex-1">{node.label}</span>
                <span className="font-body shrink-0" style={{ fontSize: 10, color: getEntityColor(node.entity_type), fontWeight: 600 }}>
                  {node.entity_type}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Selected node preview */}
      {selectedNode && (
        <div style={{
          background: 'var(--color-accent-50)', border: '1px solid rgba(214,58,0,0.15)',
          borderRadius: 8, padding: '10px 12px', marginBottom: 16,
        }}>
          <div className="flex items-center gap-2">
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: getEntityColor(selectedNode.entity_type) }} />
            <span className="font-display" style={{ fontSize: 13, fontWeight: 700, color: 'var(--color-text-primary)' }}>
              {selectedNode.label}
            </span>
            <span className="font-body" style={{ fontSize: 10, color: getEntityColor(selectedNode.entity_type), fontWeight: 600 }}>
              {selectedNode.entity_type}
            </span>
          </div>
          {selectedNode.description && (
            <p className="font-body" style={{ fontSize: 11, color: 'var(--color-text-secondary)', margin: '4px 0 0 0' }}>
              {selectedNode.description}
            </p>
          )}
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center gap-2" style={{ marginTop: 20 }}>
        <button
          type="button"
          onClick={handleSave}
          disabled={!selectedNode || saving}
          className="font-body"
          style={{
            background: selectedNode ? 'var(--color-accent-500)' : 'var(--color-bg-inset)',
            color: selectedNode ? 'white' : 'var(--color-text-secondary)',
            fontSize: 12, fontWeight: 600, padding: '8px 16px', borderRadius: 8,
            border: 'none', cursor: selectedNode ? 'pointer' : 'not-allowed',
            opacity: saving ? 0.7 : 1,
          }}
        >
          {saving ? 'Saving...' : 'Save Anchor'}
        </button>
        <button
          type="button"
          onClick={onClose}
          className="font-body"
          style={{
            background: 'transparent', color: 'var(--color-text-secondary)',
            fontSize: 12, fontWeight: 600, padding: '8px 16px', borderRadius: 8,
            border: 'none', cursor: 'pointer',
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  )
}
