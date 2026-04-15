export interface SourceTypeConfig {
  color: string
  icon: string
  label: string
}

export const SOURCE_TYPE_CONFIG: Record<string, SourceTypeConfig> = {
  Meeting:  { color: '#3b82f6', icon: '🎙', label: 'Meeting' },
  YouTube:  { color: '#ef4444', icon: '▶',  label: 'YouTube' },
  Research: { color: '#8b5cf6', icon: '🔬', label: 'Research' },
  Note:     { color: '#10b981', icon: '✏️', label: 'Note' },
  Document: { color: '#f59e0b', icon: '📋', label: 'Document' },
  GitHub:   { color: '#24292e', icon: '🔀', label: 'GitHub' },
}

export const DEFAULT_SOURCE_CONFIG: SourceTypeConfig = {
  color: '#6b7280',
  icon: '📄',
  label: 'Source',
}

export function getSourceConfig(sourceType: string | null | undefined): SourceTypeConfig {
  if (!sourceType) return DEFAULT_SOURCE_CONFIG
  return SOURCE_TYPE_CONFIG[sourceType] ?? DEFAULT_SOURCE_CONFIG
}

// ─── Provider Config (for provider-specific logos) ──────────────────────────

export interface ProviderConfig {
  logo: string | null
  label: string
  color: string
}

export const PROVIDER_CONFIG: Record<string, ProviderConfig> = {
  youtube:    { logo: '/logos/youtube.svg',     label: 'YouTube',    color: '#ef4444' },
  circleback: { logo: '/logos/circleback.jpeg', label: 'Circleback', color: '#3b82f6' },
  fireflies:  { logo: '/logos/fireflies.svg',   label: 'Fireflies',  color: '#6366f1' },
  otter:      { logo: null,                     label: 'Otter.ai',   color: '#0ea5e9' },
  meetgeek:   { logo: '/logos/meetgeek.jpeg',   label: 'MeetGeek',   color: '#8b5cf6' },
  tldv:       { logo: '/logos/tldv.svg',        label: 'tl;dv',      color: '#ec4899' },
  microsoft:  { logo: '/logos/microsoft.svg',   label: 'Microsoft 365', color: '#0078d4' },
  github:     { logo: '/logos/github.svg',     label: 'GitHub',       color: '#24292f' },
}

export function getProviderConfig(provider: string | null | undefined): ProviderConfig | null {
  if (!provider) return null
  return PROVIDER_CONFIG[provider.toLowerCase()] ?? null
}
