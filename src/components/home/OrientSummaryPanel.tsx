import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { Navigation, ExternalLink, Calendar, Sparkles, Plus } from 'lucide-react'
import { useDigestProfiles } from '../../hooks/useDigestProfiles'
import { fetchDigestHistory } from '../../services/supabase'
import type { DigestHistoryEntry } from '../../types/digest'
import type { DigestProfile } from '../../types/feed'

const FREQ_COLORS: Record<string, { bg: string; text: string; border: string }> = {
  daily:   { bg: '#f0fdf4', text: '#15803d', border: '#bbf7d040' },
  weekly:  { bg: '#eff6ff', text: '#1d4ed8', border: '#bfdbfe40' },
  monthly: { bg: '#faf5ff', text: '#7c3aed', border: '#e9d5ff40' },
}

function formatRelativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime()
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

function formatScheduleTime(time: string): string {
  const [h, m] = time.split(':')
  const hour = parseInt(h ?? '9', 10)
  const ampm = hour >= 12 ? 'PM' : 'AM'
  const h12 = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour
  return `${h12}:${m} ${ampm}`
}

interface LatestDigest {
  profile: DigestProfile
  entry: DigestHistoryEntry | null
}

function useLatestDigests(profiles: DigestProfile[]): { digests: LatestDigest[]; loading: boolean } {
  const [digests, setDigests] = useState<LatestDigest[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const active = profiles.filter(p => p.isActive)
    if (active.length === 0) {
      setDigests([])
      setLoading(false)
      return
    }

    Promise.all(
      active.map(async (profile) => {
        const entries = await fetchDigestHistory(profile.id, 1)
        return { profile, entry: entries[0] ?? null }
      })
    ).then(setDigests).finally(() => setLoading(false))
  }, [profiles])

  return { digests, loading }
}

export function OrientSummaryPanel() {
  const navigate = useNavigate()
  const { profiles, loading: profilesLoading, tableExists } = useDigestProfiles()
  const activeProfiles = profiles.filter(p => p.isActive)
  const { digests, loading: digestsLoading } = useLatestDigests(profiles)

  const loading = profilesLoading || digestsLoading

  // Find the most recent executive summary across all digests
  const latestWithSummary = digests
    .filter(d => d.entry?.executive_summary)
    .sort((a, b) => new Date(b.entry!.generated_at).getTime() - new Date(a.entry!.generated_at).getTime())[0]

  return (
    <div className="flex flex-col h-full" style={{ gap: 16 }}>

      {/* Orient card */}
      <div className="bg-bg-card border border-border-subtle" style={{ borderRadius: 12, overflow: 'hidden' }}>
        {/* Header */}
        <div className="flex items-center justify-between" style={{ padding: '12px 20px' }}>
          <div className="flex items-center" style={{ gap: 10 }}>
            <div
              className="shrink-0 flex items-center justify-center"
              style={{ width: 28, height: 28, borderRadius: 8, background: 'var(--color-accent-50)' }}
            >
              <Navigation size={14} style={{ color: 'var(--color-accent-500)' }} />
            </div>
            <span className="font-display text-text-primary" style={{ fontSize: 13, fontWeight: 700, letterSpacing: '-0.01em' }}>
              Orient
            </span>
          </div>
          <button
            type="button"
            onClick={() => navigate('/orient')}
            className="flex items-center font-body cursor-pointer bg-transparent border-none"
            style={{
              gap: 4,
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

        {loading ? (
          <div style={{ padding: '18px 20px' }} className="flex flex-col" >
            {Array.from({ length: 2 }).map((_, i) => (
              <div key={i} className="flex items-center" style={{ gap: 12, padding: '12px 0', borderBottom: i < 1 ? '1px solid var(--border-subtle)' : 'none' }}>
                <div className="bg-bg-inset animate-pulse" style={{ width: 36, height: 36, borderRadius: 8 }} />
                <div className="flex-1">
                  <div className="bg-bg-inset animate-pulse" style={{ height: 14, borderRadius: 4, width: '60%', marginBottom: 4 }} />
                  <div className="bg-bg-inset animate-pulse" style={{ height: 11, borderRadius: 3, width: '40%' }} />
                </div>
              </div>
            ))}
          </div>
        ) : !tableExists || activeProfiles.length === 0 ? (
          /* Empty state — encourage setup */
          <div className="flex flex-col items-center text-center" style={{ padding: '32px 20px' }}>
            <div
              className="flex items-center justify-center"
              style={{ width: 48, height: 48, borderRadius: 12, background: 'var(--color-accent-50)', marginBottom: 14 }}
            >
              <Sparkles size={22} style={{ color: 'var(--color-accent-500)' }} />
            </div>
            <p className="font-display text-text-primary" style={{ fontSize: 15, fontWeight: 700, marginBottom: 4 }}>
              Set up intelligence digests
            </p>
            <p className="font-body text-text-secondary" style={{ fontSize: 12, lineHeight: 1.5, marginBottom: 16, maxWidth: 240 }}>
              Get daily, weekly, or monthly briefings with insights from your knowledge base — delivered automatically.
            </p>
            <button
              type="button"
              onClick={() => navigate('/orient')}
              className="flex items-center font-body cursor-pointer text-white border-none"
              style={{
                gap: 6,
                fontSize: 13,
                fontWeight: 600,
                padding: '9px 18px',
                borderRadius: 8,
                background: 'var(--color-accent-500)',
              }}
            >
              <Plus size={14} />
              Create a digest
            </button>
          </div>
        ) : (
          /* Active digest profiles */
          <div>
            {digests.map(({ profile, entry }) => {
              const freq = FREQ_COLORS[profile.frequency] ?? { bg: '#eff6ff', text: '#1d4ed8', border: '#bfdbfe40' }
              return (
                <button
                  key={profile.id}
                  type="button"
                  onClick={() => navigate('/orient')}
                  className="flex items-center w-full text-left bg-transparent cursor-pointer hover:bg-bg-hover transition-all duration-150 border-none"
                  style={{ gap: 12, padding: '10px 20px', borderBottom: '1px solid var(--border-subtle)' }}
                >
                  {/* Frequency badge icon */}
                  <div
                    className="shrink-0 flex items-center justify-center"
                    style={{ width: 32, height: 32, borderRadius: 8, background: freq.bg, border: `1px solid ${freq.border}` }}
                  >
                    <Calendar size={14} style={{ color: freq.text }} />
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center" style={{ gap: 8, marginBottom: 2 }}>
                      <span className="font-display text-text-primary truncate" style={{ fontSize: 13, fontWeight: 700 }}>
                        {profile.title}
                      </span>
                      <span
                        style={{
                          fontSize: 10,
                          fontWeight: 600,
                          padding: '2px 7px',
                          borderRadius: 4,
                          background: freq.bg,
                          color: freq.text,
                          textTransform: 'capitalize',
                        }}
                      >
                        {profile.frequency}
                      </span>
                    </div>
                    <div className="font-body text-text-secondary" style={{ fontSize: 11, lineHeight: 1.5 }}>
                      {entry && (
                        <>
                          <span>Last generated {formatRelativeTime(entry.generated_at)}</span>
                          <span style={{ margin: '0 4px' }}>·</span>
                        </>
                      )}
                      <span>{profile.modules.filter(m => m.isActive).length} modules</span>
                      <span style={{ margin: '0 4px' }}>·</span>
                      <span>
                        {profile.frequency === 'daily' ? 'Every day' : profile.frequency === 'weekly' ? 'Every week' : 'Every month'} at {formatScheduleTime(profile.scheduleTime)}
                      </span>
                    </div>
                  </div>
                </button>
              )
            })}
          </div>
        )}
      </div>

      {/* Latest executive summary highlight */}
      {latestWithSummary?.entry?.executive_summary && (
        <div className="bg-bg-card border border-border-subtle" style={{ borderRadius: 12, overflow: 'hidden' }}>
          <div className="flex items-center" style={{ padding: '12px 20px', gap: 7, borderBottom: '1px solid var(--border-subtle)' }}>
            <Sparkles size={12} style={{ color: 'var(--color-accent-500)' }} />
            <span className="font-display text-text-secondary uppercase" style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.08em' }}>
              Latest Briefing
            </span>
            <span className="font-body text-text-placeholder" style={{ fontSize: 10, marginLeft: 'auto' }}>
              {formatRelativeTime(latestWithSummary.entry!.generated_at)}
            </span>
          </div>
          <div style={{ padding: '16px 20px' }}>
            <p
              className="font-body text-text-body"
              style={{
                fontSize: 13,
                lineHeight: 1.6,
                display: '-webkit-box',
                WebkitLineClamp: 5,
                WebkitBoxOrient: 'vertical',
                overflow: 'hidden',
              }}
            >
              {latestWithSummary.entry!.executive_summary}
            </p>
            <button
              type="button"
              onClick={() => navigate('/orient')}
              className="flex items-center font-body cursor-pointer bg-transparent border-none"
              style={{
                gap: 4,
                fontSize: 12,
                fontWeight: 600,
                color: 'var(--color-accent-500)',
                marginTop: 12,
                padding: 0,
              }}
            >
              Read full briefing <ExternalLink size={10} />
            </button>
          </div>
        </div>
      )}

    </div>
  )
}
