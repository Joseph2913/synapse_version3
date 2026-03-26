import { useState, useCallback } from 'react'
import { ChevronDown } from 'lucide-react'
import { getEntityColor } from '../../config/entityTypes'
import { ENTITY_TYPE_COLORS } from '../../config/entityTypes'
import type { ReviewEntity, ExtractedRelationship } from '../../types/extraction'

interface EntityReviewProps {
  entities: ReviewEntity[]
  relationships: ExtractedRelationship[]
  onEntitiesChange: (entities: ReviewEntity[]) => void
  onSave: () => void
  onReExtract: () => void
  saving: boolean
  exactMatches?: Set<string>
}

export function EntityReview({
  entities,
  relationships,
  onEntitiesChange,
  onSave,
  onReExtract,
  saving,
  exactMatches,
}: EntityReviewProps) {
  const [relationshipsOpen, setRelationshipsOpen] = useState(relationships.length <= 10)

  const includedCount = entities.filter(e => !e.removed).length
  const totalCount = entities.length
  const removedLabels = new Set(entities.filter(e => e.removed).map(e => e.label.toLowerCase()))

  const updateEntity = useCallback(
    (index: number, patch: Partial<ReviewEntity>) => {
      const updated = [...entities]
      updated[index] = { ...updated[index], ...patch } as ReviewEntity
      onEntitiesChange(updated)
    },
    [entities, onEntitiesChange]
  )

  return (
    <div style={{ marginTop: 16 }}>
      {/* Header */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 16,
        }}
      >
        <h3
          className="font-display font-bold"
          style={{ fontSize: 16, color: 'var(--color-text-primary)' }}
        >
          Review Extracted Entities
        </h3>
        <span className="font-body" style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
          {totalCount} entities · {relationships.length} relationships
        </span>
      </div>

      {/* Entity List */}
      {entities.length === 0 ? (
        <div
          className="font-body"
          style={{
            textAlign: 'center',
            padding: '24px 0',
            fontSize: 13,
            color: 'var(--color-text-secondary)',
          }}
        >
          No entities were extracted from this content. Try a different extraction mode or add custom guidance.
        </div>
      ) : (
        <div
          style={{
            maxHeight: 400,
            overflowY: 'auto',
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
          }}
        >
          {entities.map((entity, i) => (
            <EntityRow
              key={`${entity.label}-${i}`}
              entity={entity}
              onToggle={() => updateEntity(i, { removed: !entity.removed })}
              onLabelChange={label => updateEntity(i, { label, edited: true })}
              onTypeChange={entity_type => updateEntity(i, { entity_type, edited: true })}
              onConfidenceChange={confidence => updateEntity(i, { confidence, edited: true })}
              onDescriptionChange={description => updateEntity(i, { description, edited: true })}
              isExactMatch={exactMatches?.has(entity.label.toLowerCase())}
            />
          ))}
        </div>
      )}

      {/* Relationships Section */}
      {relationships.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <button
            type="button"
            onClick={() => setRelationshipsOpen(!relationshipsOpen)}
            className="flex items-center gap-2 cursor-pointer font-display font-bold uppercase w-full"
            style={{
              fontSize: 10,
              letterSpacing: '0.08em',
              color: 'var(--color-text-secondary)',
              background: 'none',
              border: 'none',
              padding: '8px 0',
            }}
          >
            RELATIONSHIPS ({relationships.length})
            <ChevronDown
              size={12}
              style={{
                transform: relationshipsOpen ? 'rotate(180deg)' : 'rotate(0)',
                transition: 'transform 0.2s ease',
              }}
            />
          </button>

          {relationshipsOpen && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 200, overflowY: 'auto' }}>
              {relationships.map((rel, i) => {
                const isFaded =
                  removedLabels.has(rel.source.toLowerCase()) ||
                  removedLabels.has(rel.target.toLowerCase())

                return (
                  <div
                    key={i}
                    className="font-body flex items-center gap-1.5 flex-wrap"
                    style={{
                      fontSize: 12,
                      padding: '4px 0',
                      opacity: isFaded ? 0.3 : 1,
                      textDecoration: isFaded ? 'line-through' : 'none',
                    }}
                  >
                    <span style={{ color: getEntityColor(getTypeForLabel(rel.source, entities)) }}>
                      {rel.source}
                    </span>
                    <span style={{ padding: '1px 6px', borderRadius: 4, background: 'var(--color-bg-inset)', color: 'var(--color-text-secondary)', fontSize: 9, fontWeight: 600 }}>
                      {rel.relation_type}
                    </span>
                    <span style={{ color: getEntityColor(getTypeForLabel(rel.target, entities)) }}>
                      {rel.target}
                    </span>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      {/* Action Bar */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          borderTop: '1px solid var(--border-subtle)',
          paddingTop: 12,
          marginTop: 12,
        }}
      >
        <span className="font-body" style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
          {includedCount} of {totalCount} entities selected
        </span>

        <div style={{ display: 'flex', gap: 8 }}>
          <button
            type="button"
            onClick={onReExtract}
            disabled={saving}
            className="font-body font-semibold cursor-pointer"
            style={{
              fontSize: 12,
              padding: '8px 18px',
              borderRadius: 8,
              background: 'var(--color-bg-inset)',
              border: '1px solid var(--border-default)',
              color: 'var(--color-text-body)',
              opacity: saving ? 0.5 : 1,
            }}
          >
            Re-extract
          </button>
          <button
            type="button"
            onClick={onSave}
            disabled={includedCount === 0 || saving}
            className="font-body font-semibold cursor-pointer"
            style={{
              fontSize: 12,
              padding: '8px 18px',
              borderRadius: 8,
              background: includedCount === 0 || saving ? 'rgba(26,26,26,0.4)' : '#1a1a1a',
              border: 'none',
              color: 'white',
            }}
          >
            {saving ? 'Saving...' : 'Save to Graph'}
          </button>
        </div>
      </div>

      {includedCount === 0 && entities.length > 0 && (
        <p className="font-body" style={{ fontSize: 11, color: 'var(--color-text-secondary)', marginTop: 8, textAlign: 'right' }}>
          Select at least one entity to save to your graph.
        </p>
      )}
    </div>
  )
}

// --- Entity Row Component ---

interface EntityRowProps {
  entity: ReviewEntity
  onToggle: () => void
  onLabelChange: (label: string) => void
  onTypeChange: (type: string) => void
  onConfidenceChange: (confidence: number) => void
  onDescriptionChange: (description: string) => void
  isExactMatch?: boolean
}

function EntityRow({
  entity,
  onToggle,
  onLabelChange,
  onTypeChange,
  onConfidenceChange,
  onDescriptionChange,
  isExactMatch,
}: EntityRowProps) {
  const [editingLabel, setEditingLabel] = useState(false)
  const [editingConfidence, setEditingConfidence] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [labelDraft, setLabelDraft] = useState(entity.label)
  const [confidenceDraft, setConfidenceDraft] = useState(String(Math.round(entity.confidence * 100)))
  const [showTypeDropdown, setShowTypeDropdown] = useState(false)

  const color = getEntityColor(entity.entity_type)

  const handleLabelConfirm = () => {
    const trimmed = labelDraft.trim()
    if (trimmed && trimmed !== entity.label) {
      onLabelChange(trimmed)
    }
    setEditingLabel(false)
  }

  const handleConfidenceConfirm = () => {
    const num = parseInt(confidenceDraft, 10)
    if (!isNaN(num)) {
      onConfidenceChange(Math.min(100, Math.max(0, num)) / 100)
    }
    setEditingConfidence(false)
  }

  return (
    <div
      style={{
        opacity: entity.removed ? 0.4 : 1,
        borderBottom: '1px solid var(--border-subtle)',
        borderRadius: 8,
        padding: '10px 14px',
        transition: 'all 0.15s ease',
      }}
      onMouseEnter={e => { if (!entity.removed) (e.currentTarget as HTMLDivElement).style.background = 'var(--color-bg-hover)' }}
      onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.background = 'transparent' }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        {/* Checkbox */}
        <input
          type="checkbox"
          checked={!entity.removed}
          onChange={onToggle}
          style={{
            width: 18,
            height: 18,
            accentColor: 'var(--color-accent-500)',
            cursor: 'pointer',
            flexShrink: 0,
          }}
        />

        {/* Entity Dot */}
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: color,
            flexShrink: 0,
          }}
        />

        {/* Label */}
        {editingLabel ? (
          <input
            type="text"
            value={labelDraft}
            onChange={e => setLabelDraft(e.target.value)}
            onBlur={handleLabelConfirm}
            onKeyDown={e => {
              if (e.key === 'Enter') handleLabelConfirm()
              if (e.key === 'Escape') { setLabelDraft(entity.label); setEditingLabel(false) }
            }}
            autoFocus
            className="font-body font-semibold"
            style={{
              fontSize: 13,
              color: 'var(--color-text-primary)',
              background: 'var(--color-bg-inset)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 6,
              padding: '2px 6px',
              outline: 'none',
              flex: 1,
              textDecoration: entity.removed ? 'line-through' : 'none',
            }}
          />
        ) : (
          <span
            className="font-body font-semibold cursor-pointer"
            style={{
              fontSize: 13,
              color: 'var(--color-text-primary)',
              flex: 1,
              textDecoration: entity.removed ? 'line-through' : 'none',
            }}
            onClick={() => { if (!entity.removed) { setLabelDraft(entity.label); setEditingLabel(true) } }}
          >
            {entity.label}
          </span>
        )}

        {/* Type Selector */}
        <div style={{ position: 'relative' }}>
          <button
            type="button"
            onClick={() => setShowTypeDropdown(!showTypeDropdown)}
            className="font-body font-semibold cursor-pointer"
            style={{
              fontSize: 11,
              padding: '3px 9px',
              borderRadius: 5,
              background: hexToRgba(color, 0.06),
              border: `1px solid ${hexToRgba(color, 0.16)}`,
              color,
            }}
          >
            {entity.entity_type}
          </button>

          {showTypeDropdown && (
            <div
              style={{
                position: 'absolute',
                right: 0,
                top: '100%',
                marginTop: 4,
                background: 'var(--color-bg-card)',
                border: '1px solid var(--border-strong)',
                borderRadius: 8,
                padding: 4,
                zIndex: 50,
                maxHeight: 200,
                overflowY: 'auto',
                width: 160,
                boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
              }}
            >
              {Object.keys(ENTITY_TYPE_COLORS).map(type => (
                <button
                  key={type}
                  type="button"
                  onClick={() => { onTypeChange(type); setShowTypeDropdown(false) }}
                  className="w-full flex items-center gap-2 cursor-pointer font-body"
                  style={{
                    fontSize: 11,
                    padding: '4px 8px',
                    borderRadius: 4,
                    background: type === entity.entity_type ? 'var(--color-bg-inset)' : 'transparent',
                    border: 'none',
                    color: 'var(--color-text-primary)',
                    textAlign: 'left',
                  }}
                  onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = 'var(--color-bg-hover)' }}
                  onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = type === entity.entity_type ? 'var(--color-bg-inset)' : 'transparent' }}
                >
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: ENTITY_TYPE_COLORS[type], flexShrink: 0 }} />
                  {type}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Confidence */}
        {editingConfidence ? (
          <input
            type="number"
            min={0}
            max={100}
            value={confidenceDraft}
            onChange={e => setConfidenceDraft(e.target.value)}
            onBlur={handleConfidenceConfirm}
            onKeyDown={e => {
              if (e.key === 'Enter') handleConfidenceConfirm()
              if (e.key === 'Escape') setEditingConfidence(false)
            }}
            autoFocus
            className="font-body"
            style={{
              fontSize: 11,
              width: 42,
              padding: '2px 4px',
              borderRadius: 4,
              border: '1px solid var(--border-subtle)',
              background: 'var(--color-bg-inset)',
              color: 'var(--color-text-secondary)',
              textAlign: 'right',
              outline: 'none',
            }}
          />
        ) : (
          <span
            className="font-body cursor-pointer"
            style={{ fontSize: 11, color: 'var(--color-text-secondary)', minWidth: 30, textAlign: 'right' }}
            onClick={() => { setConfidenceDraft(String(Math.round(entity.confidence * 100))); setEditingConfidence(true) }}
          >
            {Math.round(entity.confidence * 100)}%
          </span>
        )}

        {/* Merging with existing badge */}
        {isExactMatch && (
          <span style={{
            fontSize: 10, fontWeight: 600,
            color: '#d97706',
            background: 'rgba(245,158,11,0.08)',
            border: '1px solid rgba(245,158,11,0.2)',
            borderRadius: 4, padding: '1px 6px',
            flexShrink: 0,
          }}>
            ↗ Merging with existing
          </span>
        )}

        {/* Expand Chevron */}
        {entity.description && (
          <button
            type="button"
            onClick={() => setExpanded(!expanded)}
            style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 2 }}
          >
            <ChevronDown
              size={12}
              style={{
                color: 'var(--color-text-secondary)',
                transform: expanded ? 'rotate(180deg)' : 'rotate(0)',
                transition: 'transform 0.2s ease',
              }}
            />
          </button>
        )}
      </div>

      {/* Expanded Description */}
      {expanded && entity.description && (
        <div style={{ marginTop: 8, paddingLeft: 38 }}>
          <textarea
            value={entity.description}
            onChange={e => onDescriptionChange(e.target.value)}
            className="font-body w-full resize-y"
            rows={2}
            style={{
              fontSize: 12,
              lineHeight: 1.4,
              color: 'var(--color-text-body)',
              background: 'var(--color-bg-inset)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 6,
              padding: '6px 8px',
              outline: 'none',
            }}
          />
          {entity.tags && entity.tags.length > 0 && (
            <div style={{ display: 'flex', gap: 4, marginTop: 4, flexWrap: 'wrap' }}>
              {entity.tags.map((tag, i) => (
                <span
                  key={i}
                  className="font-body"
                  style={{
                    fontSize: 9,
                    fontWeight: 600,
                    padding: '2px 6px',
                    borderRadius: 4,
                    background: 'var(--color-bg-inset)',
                    color: 'var(--color-text-secondary)',
                  }}
                >
                  {tag}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// --- Helpers ---

function getTypeForLabel(label: string, entities: ReviewEntity[]): string {
  const entity = entities.find(e => e.label.toLowerCase() === label.toLowerCase())
  return entity?.entity_type ?? 'Topic'
}

function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `rgba(${r},${g},${b},${alpha})`
}
