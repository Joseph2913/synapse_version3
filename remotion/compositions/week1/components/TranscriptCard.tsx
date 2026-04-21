import React from "react";
import { interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { TranscriptLine } from "./TranscriptLine";
import type { TranscriptLineData } from "../data";

type TranscriptCardProps = {
  lines: TranscriptLineData[];
  /** Frame at which the card starts appearing */
  cardEnterFrame: number;
  /** Frames at which each transcript line enters (one per line) */
  lineEnterFrames: number[];
  /** Map of highlight type to activation frame */
  highlightFrames: Record<string, number>;
};

export const TranscriptCard: React.FC<TranscriptCardProps> = ({
  lines,
  cardEnterFrame,
  lineEnterFrames,
  highlightFrames,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Card entrance
  const cardSpring = spring({
    frame: Math.max(0, frame - cardEnterFrame),
    fps,
    config: { damping: 15 },
  });
  const cardOpacity = cardSpring;

  return (
    <div
      style={{
        opacity: cardOpacity,
        background: "#ffffff",
        borderRadius: 16,
        padding: 32,
        border: "1px solid rgba(0,0,0,0.06)",
        boxShadow: "0 1px 4px rgba(0,0,0,0.04)",
        flex: 1,
        overflow: "hidden",
      }}
    >
      {lines.map((line, i) => (
        <TranscriptLine
          key={i}
          timestamp={line.timestamp}
          speaker={line.speaker}
          speakerColor={line.speakerColor}
          text={line.text}
          highlights={line.highlights}
          enterFrame={lineEnterFrames[i]}
          highlightFrames={highlightFrames}
        />
      ))}
    </div>
  );
};
