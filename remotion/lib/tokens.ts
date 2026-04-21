/**
 * Synapse Design Tokens for Remotion
 *
 * Synced with src/index.css @theme tokens.
 * Single source of truth for all video compositions.
 */

// ── Backgrounds ──────────────────────────────────────────────
export const bg = {
  frame: "#f0f0f0",
  content: "#f7f7f7",
  card: "#ffffff",
  inset: "#f0f0f0",
  hover: "#fafafa",
  // Dark variants for social video backgrounds
  dark: "#0a0a0a",
  darkCard: "#141414",
  darkSubtle: "#1a1a1a",
  // Platform-native feed backgrounds (blend-into-feed approach)
  linkedIn: "#f4f2ee",
} as const;

// ── Text ─────────────────────────────────────────────────────
export const text = {
  primary: "#1a1a1a",
  body: "#3d3d3d",
  secondary: "#808080",
  placeholder: "#aaaaaa",
  // On dark backgrounds
  onDark: "#ffffff",
  onDarkSecondary: "#999999",
  onDarkMuted: "#666666",
} as const;

// ── Accent — Blood Orange ────────────────────────────────────
export const accent = {
  50: "#fff5f0",
  100: "#ffe0cc",
  200: "#ffb899",
  300: "#ff9466",
  400: "#e8703d",
  500: "#d63a00", // Primary brand color
  600: "#b83300",
  700: "#9a2c00",
  800: "#6e2000",
  900: "#441400",
} as const;

// ── Semantic Colors ──────────────────────────────────────────
export const semantic = {
  red: { light: "#fef2f2", base: "#ef4444", dark: "#b91c1c" },
  green: { light: "#f0fdf4", base: "#22c55e", dark: "#15803d" },
  amber: { light: "#fffbeb", base: "#f59e0b", dark: "#b45309" },
  blue: { light: "#eff6ff", base: "#3b82f6", dark: "#1d4ed8" },
} as const;

// ── Entity Type Colors ───────────────────────────────────────
export const entity = {
  person: "#d97706",
  org: "#7c3aed",
  topic: "#0891b2",
  project: "#059669",
  goal: "#e11d48",
  decision: "#db2777",
  action: "#2563eb",
  risk: "#dc2626",
  insight: "#7c3aed",
  idea: "#ca8a04",
  blocker: "#dc2626",
  tech: "#0d9488",
  concept: "#4f46e5",
  question: "#ea580c",
  anchor: "#b45309",
  lesson: "#65a30d",
} as const;

export type EntityType = keyof typeof entity;

// ── Borders ──────────────────────────────────────────────────
export const border = {
  subtle: "rgba(0,0,0,0.06)",
  default: "rgba(0,0,0,0.10)",
  strong: "rgba(0,0,0,0.16)",
  // On dark backgrounds
  darkSubtle: "rgba(255,255,255,0.06)",
  darkDefault: "rgba(255,255,255,0.10)",
  darkStrong: "rgba(255,255,255,0.16)",
} as const;

// ── Typography Scale ─────────────────────────────────────────
// Matches DESIGN-SYSTEM.md type scale
export const typeScale = {
  pageHeading: { size: 72, weight: 800, tracking: "-0.03em" },
  sectionHeading: { size: 48, weight: 700, tracking: "-0.02em" },
  cardTitle: { size: 32, weight: 700, tracking: "-0.01em" },
  bodyLarge: { size: 28, weight: 400, tracking: "normal" },
  body: { size: 24, weight: 400, tracking: "normal" },
  uiLabel: { size: 20, weight: 600, tracking: "normal" },
  sectionLabel: { size: 16, weight: 700, tracking: "0.08em" },
  small: { size: 14, weight: 600, tracking: "normal" },
} as const;

// ── Spacing ──────────────────────────────────────────────────
export const spacing = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 36,
  xxl: 48,
} as const;
