import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { fonts } from "./fonts";
import { accent, bg, text, border, entity, spacing } from "./tokens";
import type { EntityType } from "./tokens";

// ── Backgrounds ──────────────────────────────────────────────

type DarkBackgroundProps = {
  children: React.ReactNode;
  /** Optional radial accent glow */
  accentGlow?: boolean;
  /** Glow position: "center" | "top-right" | "bottom-left" */
  glowPosition?: "center" | "top-right" | "bottom-left";
};

/** Dark background with optional accent glow — for social video content */
export const DarkBackground: React.FC<DarkBackgroundProps> = ({
  children,
  accentGlow = false,
  glowPosition = "top-right",
}) => {
  const glowPositionMap = {
    center: "50% 50%",
    "top-right": "80% 20%",
    "bottom-left": "20% 80%",
  };

  return (
    <AbsoluteFill
      style={{
        background: bg.dark,
        fontFamily: fonts.body,
      }}
    >
      {accentGlow && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            background: `radial-gradient(ellipse at ${glowPositionMap[glowPosition]}, ${accent[500]}12 0%, transparent 70%)`,
          }}
        />
      )}
      {children}
    </AbsoluteFill>
  );
};

type LightBackgroundProps = {
  children: React.ReactNode;
};

/** Light background matching the Synapse app aesthetic */
export const LightBackground: React.FC<LightBackgroundProps> = ({
  children,
}) => {
  return (
    <AbsoluteFill
      style={{
        background: bg.content,
        fontFamily: fonts.body,
      }}
    >
      {children}
    </AbsoluteFill>
  );
};

type LinkedInBackgroundProps = {
  children: React.ReactNode;
};

/** LinkedIn feed-native background — blends into the feed seamlessly */
export const LinkedInBackground: React.FC<LinkedInBackgroundProps> = ({
  children,
}) => {
  return (
    <AbsoluteFill
      style={{
        background: bg.linkedIn,
        fontFamily: fonts.body,
      }}
    >
      {children}
    </AbsoluteFill>
  );
};

// ── Typography ───────────────────────────────────────────────

type HeadingProps = {
  children: React.ReactNode;
  /** Font size in px (default: 72) */
  size?: number;
  /** Font weight (default: 800) */
  weight?: 500 | 700 | 800;
  dark?: boolean;
  color?: string;
  style?: React.CSSProperties;
};

/** Display heading using Cabinet Grotesk */
export const Heading: React.FC<HeadingProps> = ({
  children,
  size = 72,
  weight = 800,
  dark = false,
  color,
  style,
}) => (
  <div
    style={{
      fontFamily: fonts.display,
      fontSize: size,
      fontWeight: weight,
      color: color ?? (dark ? text.onDark : text.primary),
      letterSpacing: size >= 48 ? "-0.03em" : size >= 24 ? "-0.02em" : "-0.01em",
      lineHeight: 1.1,
      ...style,
    }}
  >
    {children}
  </div>
);

type BodyTextProps = {
  children: React.ReactNode;
  size?: number;
  weight?: 400 | 500 | 600 | 700;
  dark?: boolean;
  secondary?: boolean;
  color?: string;
  style?: React.CSSProperties;
};

/** Body text using DM Sans */
export const BodyText: React.FC<BodyTextProps> = ({
  children,
  size = 28,
  weight = 400,
  dark = false,
  secondary = false,
  color,
  style,
}) => {
  const resolvedColor =
    color ??
    (dark
      ? secondary
        ? text.onDarkSecondary
        : text.onDark
      : secondary
        ? text.secondary
        : text.body);

  return (
    <div
      style={{
        fontFamily: fonts.body,
        fontSize: size,
        fontWeight: weight,
        color: resolvedColor,
        lineHeight: 1.5,
        ...style,
      }}
    >
      {children}
    </div>
  );
};

type EditorialTextProps = {
  children: React.ReactNode;
  size?: number;
  dark?: boolean;
  color?: string;
  style?: React.CSSProperties;
};

/** Editorial text using Instrument Serif — for taglines, quotes */
export const EditorialText: React.FC<EditorialTextProps> = ({
  children,
  size = 48,
  dark = false,
  color,
  style,
}) => (
  <div
    style={{
      fontFamily: fonts.editorial,
      fontSize: size,
      fontWeight: 400,
      fontStyle: "italic",
      color: color ?? (dark ? text.onDark : text.primary),
      lineHeight: 1.3,
      ...style,
    }}
  >
    {children}
  </div>
);

type SectionLabelProps = {
  children: React.ReactNode;
  dark?: boolean;
  size?: number;
  style?: React.CSSProperties;
};

/** Uppercase section label — "CROSS-CONNECTIONS", "FEATURES", etc. */
export const SectionLabel: React.FC<SectionLabelProps> = ({
  children,
  dark = false,
  size = 16,
  style,
}) => (
  <div
    style={{
      fontFamily: fonts.display,
      fontSize: size,
      fontWeight: 700,
      color: dark ? text.onDarkMuted : text.secondary,
      letterSpacing: "0.08em",
      textTransform: "uppercase",
      ...style,
    }}
  >
    {children}
  </div>
);

// ── Decorative Elements ──────────────────────────────────────

type AccentBarProps = {
  /** Width in px */
  width?: number;
  /** Height in px */
  height?: number;
  color?: string;
};

/** Horizontal accent bar — blood orange by default */
export const AccentBar: React.FC<AccentBarProps> = ({
  width = 120,
  height = 4,
  color = accent[500],
}) => (
  <div
    style={{
      width,
      height,
      background: color,
      borderRadius: height / 2,
    }}
  />
);

type EntityBadgeProps = {
  type: EntityType;
  label: string;
  size?: "sm" | "md" | "lg";
};

/** Entity badge matching Synapse app styling */
export const EntityBadge: React.FC<EntityBadgeProps> = ({
  type,
  label,
  size = "md",
}) => {
  const color = entity[type];
  const sizeMap = {
    sm: { fontSize: 14, padding: "4px 10px", dotSize: 5 },
    md: { fontSize: 18, padding: "6px 14px", dotSize: 6 },
    lg: { fontSize: 22, padding: "8px 18px", dotSize: 8 },
  };
  const s = sizeMap[size];

  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: s.dotSize + 2,
        background: `${color}10`,
        border: `1px solid ${color}28`,
        borderRadius: 6,
        padding: s.padding,
      }}
    >
      <div
        style={{
          width: s.dotSize,
          height: s.dotSize,
          borderRadius: "50%",
          background: color,
          flexShrink: 0,
        }}
      />
      <span
        style={{
          fontFamily: fonts.body,
          fontSize: s.fontSize,
          fontWeight: 600,
          color,
        }}
      >
        {label}
      </span>
    </div>
  );
};

// ── Animated Primitives ──────────────────────────────────────

type FadeInProps = {
  children: React.ReactNode;
  /** Delay in seconds before fade starts */
  delay?: number;
  /** Duration of fade in seconds */
  duration?: number;
  /** Optional vertical slide distance in px */
  slideY?: number;
  style?: React.CSSProperties;
};

/** Fade-in wrapper with optional vertical slide */
export const FadeIn: React.FC<FadeInProps> = ({
  children,
  delay = 0,
  duration = 0.6,
  slideY = 0,
  style,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const startFrame = delay * fps;
  const endFrame = (delay + duration) * fps;

  const opacity = interpolate(frame, [startFrame, endFrame], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const translateY =
    slideY !== 0
      ? interpolate(frame, [startFrame, endFrame], [slideY, 0], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        })
      : 0;

  return (
    <div
      style={{
        opacity,
        transform: translateY !== 0 ? `translateY(${translateY}px)` : undefined,
        ...style,
      }}
    >
      {children}
    </div>
  );
};

type GrowBarProps = {
  /** Delay in seconds */
  delay?: number;
  /** Duration in seconds */
  duration?: number;
  /** Target width in px */
  width?: number;
  /** Height in px */
  height?: number;
  color?: string;
};

/** Animated accent bar that grows from 0 to target width */
export const GrowBar: React.FC<GrowBarProps> = ({
  delay = 0,
  duration = 0.8,
  width = 120,
  height = 4,
  color = accent[500],
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const startFrame = delay * fps;
  const endFrame = (delay + duration) * fps;

  const currentWidth = interpolate(frame, [startFrame, endFrame], [0, width], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <div
      style={{
        width: currentWidth,
        height,
        background: color,
        borderRadius: height / 2,
      }}
    />
  );
};
