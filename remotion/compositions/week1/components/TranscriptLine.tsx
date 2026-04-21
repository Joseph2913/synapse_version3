import React from "react";
import { interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { fonts } from "../../../lib/fonts";
import type { Highlight } from "../data";

type TranscriptLineProps = {
  timestamp: string;
  speaker: string;
  speakerColor: string;
  text: string;
  highlights: Highlight[];
  /** Frame at which this line starts entering */
  enterFrame: number;
  /** Map of highlight type to the frame at which that type activates */
  highlightFrames: Record<string, number>;
};

/** Parse text with {curly brace} markers into segments */
function parseText(
  text: string,
  highlights: Highlight[]
): Array<{ text: string; highlight: Highlight | null }> {
  const segments: Array<{ text: string; highlight: Highlight | null }> = [];
  let remaining = text;
  let highlightIndex = 0;

  while (remaining.length > 0) {
    const openBrace = remaining.indexOf("{");
    if (openBrace === -1) {
      segments.push({ text: remaining, highlight: null });
      break;
    }

    if (openBrace > 0) {
      segments.push({ text: remaining.slice(0, openBrace), highlight: null });
    }

    const closeBrace = remaining.indexOf("}", openBrace);
    if (closeBrace === -1) {
      segments.push({ text: remaining.slice(openBrace), highlight: null });
      break;
    }

    const phrase = remaining.slice(openBrace + 1, closeBrace);
    const matchingHighlight = highlights[highlightIndex] ?? null;
    segments.push({ text: phrase, highlight: matchingHighlight });
    highlightIndex++;

    remaining = remaining.slice(closeBrace + 1);
  }

  return segments;
}

export const TranscriptLine: React.FC<TranscriptLineProps> = ({
  timestamp,
  speaker,
  speakerColor,
  text,
  highlights,
  enterFrame,
  highlightFrames,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Entrance animation
  const enterSpring = spring({
    frame: Math.max(0, frame - enterFrame),
    fps,
    config: { damping: 12 },
  });
  const opacity = enterSpring;
  const translateY = interpolate(enterSpring, [0, 1], [16, 0]);

  const segments = parseText(text, highlights);

  return (
    <div
      style={{
        opacity,
        transform: `translateY(${translateY}px)`,
        display: "flex",
        gap: 12,
        alignItems: "flex-start",
        marginBottom: 14,
      }}
    >
      {/* Timestamp */}
      <div
        style={{
          fontFamily: fonts.mono,
          fontSize: 24,
          fontWeight: 400,
          color: "#808080",
          flexShrink: 0,
          minWidth: 80,
          paddingTop: 2,
        }}
      >
        {timestamp}
      </div>

      {/* Speaker + text */}
      <div style={{ flex: 1 }}>
        <span
          style={{
            fontFamily: fonts.mono,
            fontSize: 26,
            fontWeight: 600,
            color: speakerColor,
          }}
        >
          {speaker}
        </span>
        <span
          style={{
            fontFamily: fonts.mono,
            fontSize: 26,
            fontWeight: 400,
            color: "#3d3d3d",
            marginLeft: 8,
          }}
        >
          {segments.map((seg, i) => {
            if (!seg.highlight) {
              return <span key={i}>{seg.text}</span>;
            }

            const activateFrame = highlightFrames[seg.highlight.type] ?? 999;
            const highlightProgress = interpolate(
              frame,
              [activateFrame, activateFrame + 10],
              [0, 1],
              { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
            );

            const bgOpacity = highlightProgress * 0.12;
            const textColor = interpolate(
              highlightProgress,
              [0, 1],
              [0, 1]
            );

            // Blend from body color (#3d3d3d) to highlight color
            const color =
              highlightProgress > 0.5 ? seg.highlight.color : "#3d3d3d";

            return (
              <span
                key={i}
                style={{
                  backgroundColor: `rgba(${hexToRgb(seg.highlight.color)}, ${bgOpacity})`,
                  color,
                  borderRadius: 4,
                  padding: highlightProgress > 0 ? "2px 4px" : "0px",
                  transition: "none",
                }}
              >
                {seg.text}
              </span>
            );
          })}
        </span>
      </div>
    </div>
  );
};

/** Convert hex color to r,g,b string */
function hexToRgb(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `${r},${g},${b}`;
}
