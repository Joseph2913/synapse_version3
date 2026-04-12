import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Radio } from 'lucide-react'
import { EntityIcon } from './EntityIcon'
import { SkillIcon } from './SkillIcon'
import type { KnowledgeNode, KnowledgeSkill } from '../../types/database'

interface SignalsToggleCardProps {
  anchors: KnowledgeNode[]
  anchorConnectionCounts: Record<string, number>
  skills: KnowledgeSkill[]
  loading: boolean
  error?: string
  onAnchorClick: (node: KnowledgeNode) => void
  onSkillClick: (skill: KnowledgeSkill) => void
}

type Tab = 'anchors' | 'skills'

export function SignalsToggleCard({
  anchors,
  anchorConnectionCounts,
  skills,
  loading,
  error,
  onAnchorClick,
  onSkillClick,
}: SignalsToggleCardProps) {
  const navigate = useNavigate()
  const [activeTab, setActiveTab] = useState<Tab>('anchors')

  return (
    <div className="bg-bg-card border border-border-subtle overflow-hidden flex flex-col flex-1" style={{ borderRadius: 12, minHeight: 0 }}>
      {/* Header — compact, no border */}
      <div
        className="flex items-center justify-between"
        style={{ padding: '12px 20px' }}
      >
        <div className="flex items-center" style={{ gap: 10 }}>
          <div
            className="shrink-0 flex items-center justify-center"
            style={{ width: 28, height: 28, borderRadius: 8, background: 'var(--color-accent-50)' }}
          >
            <Radio size={14} style={{ color: 'var(--color-accent-500)' }} />
          </div>
          <span className="font-display text-text-primary" style={{ fontSize: 13, fontWeight: 700, letterSpacing: '-0.01em' }}>
            Signals
          </span>

          {/* Segmented toggle */}
          <div
            style={{
              display: 'flex',
              background: 'var(--color-bg-inset)',
              borderRadius: 8,
              padding: 2,
              marginLeft: 6,
            }}
          >
            {(['anchors', 'skills'] as const).map((tab) => (
              <button
                key={tab}
                type="button"
                onClick={() => setActiveTab(tab)}
                className="font-body border-none cursor-pointer"
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  padding: '4px 14px',
                  borderRadius: 6,
                  background: activeTab === tab ? 'var(--color-bg-card)' : 'transparent',
                  color: activeTab === tab ? 'var(--color-accent-500)' : 'var(--color-text-secondary)',
                  boxShadow: activeTab === tab ? '0 1px 3px rgba(0,0,0,0.08)' : 'none',
                  transition: 'all 0.15s ease',
                  textTransform: 'capitalize',
                }}
              >
                {tab}
              </button>
            ))}
          </div>
        </div>

        <button
          type="button"
          onClick={() => navigate(activeTab === 'anchors' ? '/anchors' : '/skills')}
          className="font-body cursor-pointer bg-transparent border-none"
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: 'var(--color-accent-500)',
            padding: '4px 12px',
            borderRadius: 6,
            border: '1px solid rgba(214,58,0,0.15)',
            background: 'var(--color-accent-50)',
          }}
        >
          View all →
        </button>
      </div>

      {/* Content */}
      {loading ? (
        <div style={{ padding: '8px 20px 14px' }} className="flex flex-col">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="flex items-center" style={{ gap: 10, padding: '10px 0', borderBottom: i < 4 ? '1px solid var(--border-subtle)' : 'none' }}>
              <div className="bg-bg-inset animate-pulse" style={{ width: 28, height: 28, borderRadius: 8 }} />
              <div className="bg-bg-inset animate-pulse flex-1" style={{ height: 13, borderRadius: 4 }} />
              <div className="bg-bg-inset animate-pulse" style={{ width: 60, height: 11, borderRadius: 4 }} />
            </div>
          ))}
        </div>
      ) : error ? (
        <div style={{ padding: '16px 20px' }}>
          <p className="font-body text-text-secondary" style={{ fontSize: 13, fontStyle: 'italic' }}>{error}</p>
        </div>
      ) : activeTab === 'anchors' ? (
        anchors.length === 0 ? (
          <div style={{ padding: '16px 20px' }}>
            <p className="font-body text-text-secondary" style={{ fontSize: 13 }}>
              No anchors yet. Anchors are promoted from your most important entities after ingestion.
            </p>
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto">
            {anchors.map((anchor, i) => (
              <button
                key={anchor.id}
                type="button"
                onClick={() => onAnchorClick(anchor)}
                className="flex items-center w-full text-left bg-transparent cursor-pointer hover:bg-bg-hover transition-all duration-150 border-none"
                style={{ gap: 10, padding: '10px 20px', borderBottom: i < anchors.length - 1 ? '1px solid var(--border-subtle)' : 'none' }}
              >
                <EntityIcon entityType={anchor.entity_type} size={28} />
                <span className="font-body text-text-primary flex-1 truncate" style={{ fontSize: 13, fontWeight: 600 }}>
                  {anchor.label}
                </span>
                <span className="font-body text-text-secondary" style={{ fontSize: 11 }}>
                  {anchorConnectionCounts[anchor.id] ?? 0} connections
                </span>
              </button>
            ))}
          </div>
        )
      ) : (
        skills.length === 0 ? (
          <div style={{ padding: '16px 20px' }}>
            <p className="font-body text-text-secondary" style={{ fontSize: 13 }}>
              Skills emerge after multiple ingestions. Check back after processing more sources.
            </p>
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto">
            {skills.map((skill, i) => (
              <button
                key={skill.id}
                type="button"
                onClick={() => onSkillClick(skill)}
                className="flex items-center w-full text-left bg-transparent cursor-pointer hover:bg-bg-hover transition-all duration-150 border-none"
                style={{ gap: 10, padding: '10px 20px', borderBottom: i < skills.length - 1 ? '1px solid var(--border-subtle)' : 'none' }}
              >
                <SkillIcon domain={skill.domain} size={28} />
                <span className="font-body text-text-primary flex-1 truncate" style={{ fontSize: 13, fontWeight: 600 }}>
                  {skill.title || skill.name}
                </span>
                <span className="font-body text-text-secondary" style={{ fontSize: 11 }}>
                  {skill.usage_count > 0 ? `${skill.usage_count} uses` : `${skill.source_count} sources`}
                </span>
              </button>
            ))}
          </div>
        )
      )}
    </div>
  )
}
