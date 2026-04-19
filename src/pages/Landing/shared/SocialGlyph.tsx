interface SocialGlyphProps {
  kind: string
}

export function SocialGlyph({ kind }: SocialGlyphProps) {
  const s = 14
  if (kind === 'x') return (
    <svg width={s} height={s} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M 11.5 1.5 L 14 1.5 L 9.3 7 L 14.8 14.5 L 10.4 14.5 L 7 9.8 L 3 14.5 L 1 14.5 L 6 8.6 L 1 1.5 L 5.6 1.5 L 8.6 5.7 Z M 10.9 13.3 L 12.3 13.3 L 4.7 2.7 L 3.2 2.7 Z"/>
    </svg>
  )
  if (kind === 'github') return (
    <svg width={s} height={s} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 1a7 7 0 0 0-2.2 13.6c.35.06.48-.15.48-.34v-1.2c-1.94.42-2.35-.94-2.35-.94-.32-.8-.78-1.02-.78-1.02-.63-.43.05-.42.05-.42.7.05 1.07.72 1.07.72.62 1.06 1.62.76 2.02.58.06-.45.24-.76.44-.94-1.55-.17-3.18-.77-3.18-3.45 0-.76.27-1.38.72-1.87-.07-.18-.31-.89.07-1.86 0 0 .59-.19 1.93.72a6.7 6.7 0 0 1 3.51 0c1.34-.91 1.93-.72 1.93-.72.38.97.14 1.68.07 1.86.45.49.72 1.11.72 1.87 0 2.69-1.64 3.28-3.2 3.45.25.22.47.64.47 1.3v1.92c0 .19.13.41.48.34A7 7 0 0 0 8 1z"/>
    </svg>
  )
  if (kind === 'linkedin') return (
    <svg width={s} height={s} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <rect x="1" y="6" width="2.8" height="8.5"/>
      <circle cx="2.4" cy="3" r="1.6"/>
      <path d="M6 6 h2.7 v1.2 c.5-.9 1.6-1.4 2.7-1.4 2.1 0 3 1.4 3 3.6 v5.1 h-2.8 v-4.5 c0-1.1-.4-1.9-1.4-1.9s-1.5.7-1.5 1.9 v4.5 H6 z"/>
    </svg>
  )
  if (kind === 'rss') return (
    <svg width={s} height={s} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <circle cx="3.5" cy="12.5" r="1.5"/>
      <path d="M2 3 v3 a7 7 0 0 1 7 7 h3 A10 10 0 0 0 2 3 z"/>
      <path d="M2 7.5 v2.6 a3.4 3.4 0 0 1 3.4 3.4 H8 A5.6 5.6 0 0 0 2 7.5 z"/>
    </svg>
  )
  return null
}
