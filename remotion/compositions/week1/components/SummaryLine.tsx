import React from "react";
import { interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { fonts } from "../../../lib/fonts";
import { summaryLine } from "../data";

type SummaryLineProps = {
  enterFrame: number;
};

export const SummaryLine: React.FC<SummaryLineProps> = ({ enterFrame }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const enterSpring = spring({
    frame: Math.max(0, frame - enterFrame),
    fps,
    config: { damping: 12 },
  });
  const opacity = enterSpring;
  const translateY = interpolate(enterSpring, [0, 1], [16, 0]);

  return (
    <div
      style={{
        opacity,
        transform: `translateY(${translateY}px)`,
        fontFamily: fonts.mono,
        fontSize: 24,
        display: "flex",
        alignItems: "center",
        gap: 8,
        flexWrap: "wrap",
        marginTop: 20,
      }}
    >
      <span style={{ color: "#808080" }}>{summaryLine.prefix}</span>
      <span style={{ color: "#808080" }}>{summaryLine.separator}</span>
      {summaryLine.counts.map((count, i) => (
        <React.Fragment key={i}>
          {i > 0 && (
            <span style={{ color: "#808080", margin: "0 2px" }}>&middot;</span>
          )}
          <span style={{ color: count.color, fontWeight: 600 }}>
            {count.number}
          </span>
          <span style={{ color: count.color }}>{count.label}</span>
        </React.Fragment>
      ))}
    </div>
  );
};
