export interface SourceTypeConfig {
  color: string
  icon: string
  label: string
}

// Canonical lowercase keys (Stage 2 rename, 2026-04-27). The set covers every
// source_type value that can appear in `knowledge_sources`:
//   - 'paste'    — text adapter (was 'Note')
//   - 'url'      — URL adapter
//   - 'file'     — file adapter (was 'Document')
//   - 'youtube'  — YouTube adapter
//   - 'meeting'  — Circleback / meeting adapters
//   - 'research' — Microsoft non-meeting resources (Outlook, SharePoint)
//   - 'github'   — MCP / Claude Code session ingestion
export const SOURCE_TYPE_CONFIG: Record<string, SourceTypeConfig> = {
  meeting:  { color: '#3b82f6', icon: '🎙', label: 'Meeting' },
  youtube:  { color: '#ef4444', icon: '▶',  label: 'YouTube' },
  research: { color: '#8b5cf6', icon: '🔬', label: 'Research' },
  paste:    { color: '#10b981', icon: '✏️', label: 'Note' },
  file:     { color: '#f59e0b', icon: '📋', label: 'Document' },
  url:      { color: '#0ea5e9', icon: '🔗', label: 'Web' },
  github:   { color: '#24292e', icon: '🔀', label: 'GitHub' },
}

export const DEFAULT_SOURCE_CONFIG: SourceTypeConfig = {
  color: '#6b7280',
  icon: '📄',
  label: 'Source',
}

// Legacy mixed-case → canonical lowercase translator. Defensive only — every
// row in the database is lowercase post-migration. Kept for external callers
// (e.g. embedded URLs from older shares, MCP traffic) that may still send
// the old strings.
const LEGACY_MAP: Record<string, string> = {
  Note: 'paste',
  Web: 'url',
  Document: 'file',
  YouTube: 'youtube',
  Meeting: 'meeting',
  Research: 'research',
  GitHub: 'github',
}

export function normaliseSourceType(input: string | null | undefined): string | null {
  if (!input) return null
  if (SOURCE_TYPE_CONFIG[input]) return input
  return LEGACY_MAP[input] ?? input
}

export function getSourceConfig(sourceType: string | null | undefined): SourceTypeConfig {
  const key = normaliseSourceType(sourceType)
  if (!key) return DEFAULT_SOURCE_CONFIG
  return SOURCE_TYPE_CONFIG[key] ?? DEFAULT_SOURCE_CONFIG
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
