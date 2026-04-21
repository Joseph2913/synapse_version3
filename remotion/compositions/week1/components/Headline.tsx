import React from "react";
import { interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { fonts } from "../../../lib/fonts";

type HeadlineProps = {
  line1: string;
  line2: string;
  line1Color: string;
  line2Color: string;
};

export const Headline: React.FC<HeadlineProps> = ({
  line1,
  line2,
  line1Color,
  line2Color,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Line 1: frames 0-30
  const line1Spring = spring({ frame, fps, config: { damping: 15 } });
  const line1Opacity = line1Spring;
  const line1Y = interpolate(line1Spring, [0, 1], [20, 0]);

  // Line 2: frames 15-45 (15 frame delay)
  const line2Spring = spring({
    frame: Math.max(0, frame - 15),
    fps,
    config: { damping: 15 },
  });
  const line2Opacity = line2Spring;
  const line2Y = interpolate(line2Spring, [0, 1], [20, 0]);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        textAlign: "center",
        gap: 8,
      }}
    >
      <div
        style={{
          fontFamily: fonts.display,
          fontSize: 96,
          fontWeight: 800,
          color: line1Color,
          letterSpacing: "-0.03em",
          lineHeight: 1.1,
          opacity: line1Opacity,
          transform: `translateY(${line1Y}px)`,
        }}
      >
        {line1}
      </div>
      <div
        style={{
          fontFamily: fonts.display,
          fontSize: 96,
          fontWeight: 800,
          color: line2Color,
          letterSpacing: "-0.03em",
          lineHeight: 1.1,
          opacity: line2Opacity,
          transform: `translateY(${line2Y}px)`,
        }}
      >
        {line2}
      </div>
    </div>
  );
};
