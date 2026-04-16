import { useState } from 'react'
import { X } from 'lucide-react'
import { useSettings } from '../../hooks/useSettings'
import { OnboardingStepLayout } from './OnboardingStepLayout'

interface AnchorItem {
  label: string
  mentionCount: number
  enabled: boolean
}

interface Step2ReviewProfileProps {
  onNext: () => void
  onSkipAll: () => void
}

export function Step2ReviewProfile({ onNext, onSkipAll }: Step2ReviewProfileProps) {
  const { profile, updateProfile } = useSettings()

  const initialRole = profile?.professional_context?.role ?? ''
  const initialInterests: string[] = profile?.personal_interests?.topics
    ? profile.personal_interests.topics
        .split(',')
        .map(t => t.trim())
        .filter(t => t.length > 0)
    : []

  const [role, setRole] = useState(initialRole)
  const [interests, setInterests] = useState<string[]>(initialInterests)
  const [newInterest, setNewInterest] = useState('')
  const [anchors] = useState<AnchorItem[]>([])
  const [saving, setSaving] = useState(false)

  function removeInterest(index: number) {
    setInterests(prev => prev.filter((_, i) => i !== index))
  }

  function addInterest() {
    const trimmed = newInterest.trim()
    if (trimmed && !interests.includes(trimmed)) {
      setInterests(prev => [...prev, trimmed])
    }
    setNewInterest('')
  }

  function handleInterestKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault()
      addInterest()
    }
  }

  async function handleSave() {
    setSaving(true)
    await updateProfile({
      professional_context: {
        ...profile?.professional_context,
        role,
      },
      personal_interests: {
        ...profile?.personal_interests,
        topics: interests.join(', '),
      },
    })
    setSaving(false)
    onNext()
  }

  return (
    <OnboardingStepLayout
      stepNumber={2}
      totalSteps={4}
      title="Here's what we learned about you"
      subtitle="Based on your conversation history, we've built a profile and identified your key focus areas. Adjust anything that doesn't look right."
      maxWidth={700}
      onSkipAll={onSkipAll}
      onSkip={onNext}
      onNext={handleSave}
      nextLabel={saving ? 'Saving...' : 'Looks Good'}
      nextDisabled={saving}
      skipLabel="Skip for now"
    >
      <div className="grid grid-cols-2 gap-5">
        {/* Left Column */}
        <div className="flex flex-col gap-4">
          {/* Professional Context */}
          <div className="flex flex-col gap-1.5">
            <label
              className="font-body font-semibold"
              style={{ fontSize: 12, color: 'var(--color-text-primary)' }}
            >
              Professional Context
            </label>
            <textarea
              rows={4}
              value={role}
              onChange={e => setRole(e.target.value)}
              className="font-body rounded-lg resize-none outline-none transition-colors duration-150"
              style={{
                fontSize: 12,
                padding: '8px 10px',
                background: 'var(--color-bg-inset)',
                border: '1px solid var(--border-subtle)',
                color: 'var(--color-text-primary)',
              }}
              placeholder="Describe your role and current focus..."
            />
          </div>

          {/* Interests */}
          <div className="flex flex-col gap-1.5">
            <label
              className="font-body font-semibold"
              style={{ fontSize: 12, color: 'var(--color-text-primary)' }}
            >
              Interests
            </label>

            {/* Pills */}
            <div className="flex flex-wrap gap-1.5">
              {interests.length === 0 && (
                <span
                  className="font-body"
                  style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}
                >
                  No interests added yet.
                </span>
              )}
              {interests.map((interest, i) => (
                <span
                  key={i}
                  className="inline-flex items-center gap-1 rounded-full font-body font-semibold"
                  style={{
                    fontSize: 10,
                    padding: '3px 8px',
                    background: 'var(--color-accent-50)',
                    color: 'var(--color-accent-500)',
                  }}
                >
                  {interest}
                  <button
                    onClick={() => removeInterest(i)}
                    className="flex items-center justify-center transition-opacity duration-150 hover:opacity-60"
                    style={{ lineHeight: 1 }}
                    aria-label={`Remove ${interest}`}
                  >
                    <X size={10} />
                  </button>
                </span>
              ))}
            </div>

            {/* Add row */}
            <div className="flex items-center gap-2 mt-1">
              <input
                type="text"
                value={newInterest}
                onChange={e => setNewInterest(e.target.value)}
                onKeyDown={handleInterestKeyDown}
                placeholder="Add an interest..."
                className="font-body flex-1 rounded-full outline-none transition-colors duration-150"
                style={{
                  fontSize: 12,
                  padding: '5px 12px',
                  background: 'var(--color-bg-inset)',
                  border: '1px solid var(--border-subtle)',
                  color: 'var(--color-text-primary)',
                }}
              />
              <button
                onClick={addInterest}
                className="font-body font-semibold rounded-full transition-all duration-150 hover:opacity-90"
                style={{
                  fontSize: 12,
                  padding: '5px 13px',
                  background: 'var(--color-accent-500)',
                  color: '#ffffff',
                  border: 'none',
                  cursor: 'pointer',
                  flexShrink: 0,
                }}
              >
                Add
              </button>
            </div>
          </div>
        </div>

        {/* Right Column */}
        <div className="flex flex-col gap-4">
          {/* Anchors */}
          <div className="flex flex-col gap-1.5">
            <label
              className="font-body font-semibold"
              style={{ fontSize: 12, color: 'var(--color-text-primary)' }}
            >
              Detected Anchors (Focus Areas)
            </label>

            <div className="flex flex-col gap-1.5">
              {anchors.length === 0 ? (
                <p
                  className="font-body"
                  style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}
                >
                  No anchors detected yet. You can add them in Settings after onboarding.
                </p>
              ) : (
                anchors.map((anchor, i) => (
                  <label
                    key={i}
                    className="flex items-center gap-2 rounded-lg cursor-pointer"
                    style={{
                      padding: '7px 10px',
                      border: '1px solid var(--border-subtle)',
                      background: anchor.enabled ? 'var(--color-accent-50)' : 'var(--color-bg-inset)',
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={anchor.enabled}
                      readOnly
                      className="accent-[var(--color-accent-500)]"
                      style={{ flexShrink: 0 }}
                    />
                    <span
                      className="font-body font-semibold flex-1"
                      style={{ fontSize: 12, color: 'var(--color-text-primary)' }}
                    >
                      {anchor.label}
                    </span>
                    <span
                      className="font-body"
                      style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}
                    >
                      {anchor.mentionCount} mentions
                    </span>
                  </label>
                ))
              )}
            </div>
          </div>

          {/* Note box */}
          <div
            className="rounded-lg font-body"
            style={{
              padding: '10px 12px',
              background: 'var(--color-accent-50)',
              borderLeft: '3px solid var(--color-accent-500)',
              fontSize: 12,
              color: 'var(--color-text-secondary)',
              lineHeight: '1.5',
            }}
          >
            Anchors are your key focus areas. They organize your knowledge graph. You can always change these later in Settings.
          </div>
        </div>
      </div>
    </OnboardingStepLayout>
  )
}
