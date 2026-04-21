import React from "react";
import { Img, staticFile } from "remotion";
import { fonts } from "./fonts";
import { accent, text } from "./tokens";

/**
 * Synapse brand mark — flame icon + optional wordmark.
 *
 * Usage:
 *   <SynapseLogo size={40} />                    — flame only
 *   <SynapseLogo size={40} showWordmark />        — flame + "SYNAPSE"
 *   <SynapseLogo size={40} showWordmark dark />   — light text for dark bg
 */

type SynapseLogoProps = {
  /** Height of the flame icon in px */
  size?: number;
  /** Show "SYNAPSE" wordmark next to the flame */
  showWordmark?: boolean;
  /** Use light colors for dark backgrounds */
  dark?: boolean;
  /** Override the wordmark color */
  wordmarkColor?: string;
  /** Opacity (0-1) for fade-in animations */
  opacity?: number;
};

export const SynapseLogo: React.FC<SynapseLogoProps> = ({
  size = 32,
  showWordmark = false,
  dark = false,
  wordmarkColor,
  opacity = 1,
}) => {
  const resolvedWordmarkColor =
    wordmarkColor ?? (dark ? text.onDarkMuted : text.secondary);

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: size * 0.35,
        opacity,
      }}
    >
      {/* Flame mark */}
      <Img
        src={staticFile("logos/synapse-flame.svg")}
        style={{ height: size, width: "auto" }}
      />

      {showWordmark && (
        <span
          style={{
            fontFamily: fonts.display,
            fontSize: size * 0.45,
            fontWeight: 700,
            color: resolvedWordmarkColor,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
          }}
        >
          Synapse
        </span>
      )}
    </div>
  );
};

/**
 * Minimal brand dot + wordmark (no flame icon).
 * Use for subtle brand presence in corners.
 */
type BrandDotProps = {
  /** Font size of the wordmark in px */
  fontSize?: number;
  dark?: boolean;
  opacity?: number;
};

export const BrandDot: React.FC<BrandDotProps> = ({
  fontSize = 18,
  dark = false,
  opacity = 1,
}) => {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: fontSize * 0.65,
        opacity,
      }}
    >
      <div
        style={{
          width: fontSize * 0.55,
          height: fontSize * 0.55,
          borderRadius: "50%",
          background: accent[500],
        }}
      />
      <span
        style={{
          fontFamily: fonts.display,
          fontSize,
          fontWeight: 600,
          color: dark ? text.onDarkMuted : text.secondary,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
        }}
      >
        Synapse
      </span>
    </div>
  );
};
