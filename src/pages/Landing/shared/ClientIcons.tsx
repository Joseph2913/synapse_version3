type IconRenderer = (size: number, color: string) => React.ReactNode

export const CLIENT_ICON: Record<string, IconRenderer> = {
  anthropic: (size, c) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={c}>
      <path d="M12 2 L13.5 9.5 L21 8 L15 12 L21 16 L13.5 14.5 L12 22 L10.5 14.5 L3 16 L9 12 L3 8 L10.5 9.5 Z"/>
    </svg>
  ),
  openai: (size, c) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="1.6" strokeLinejoin="round">
      <path d="M12 3 L19 7 L19 17 L12 21 L5 17 L5 7 Z"/>
      <path d="M12 3 L12 12 L19 17"/>
      <path d="M5 7 L12 12"/>
      <path d="M12 21 L12 12"/>
    </svg>
  ),
  cursor: (size, c) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={c}>
      <path d="M5 2 L20 11 L13 12.5 L11.5 20 L5 2 Z"/>
    </svg>
  ),
  windsurf: (size, c) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="1.8" strokeLinecap="round">
      <path d="M3 9 Q 7 5 12 9 T 21 9"/>
      <path d="M3 14 Q 7 10 12 14 T 21 14"/>
      <path d="M3 19 Q 7 15 12 19 T 21 19"/>
    </svg>
  ),
  zed: (size, c) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={c}>
      <path d="M4 4 L20 4 L20 7.5 L10 19.5 L20 19.5 L20 20 L4 20 L4 16.5 L14 4.5 L4 4.5 Z"/>
    </svg>
  ),
  custom: (size, c) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="8" width="10" height="8" rx="2"/>
      <path d="M14 12 L19 12"/>
      <path d="M7 4 L7 8"/>
      <path d="M11 4 L11 8"/>
      <circle cx="19" cy="12" r="1.2" fill={c} stroke="none"/>
    </svg>
  ),
}
