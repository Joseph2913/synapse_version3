import React from "react";
import { AbsoluteFill } from "remotion";
import { bg } from "../lib/tokens";
import { fonts } from "../lib/fonts";

type LinkedInTemplateProps = {
  children: React.ReactNode;
  backgroundColor?: string;
};

/** Reusable 1080x1350 LinkedIn wrapper with feed-native background */
export const LinkedInTemplate: React.FC<LinkedInTemplateProps> = ({
  children,
  backgroundColor = bg.linkedIn,
}) => {
  return (
    <AbsoluteFill
      style={{
        background: backgroundColor,
        fontFamily: fonts.body,
        padding: 60,
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
      }}
    >
      {children}
    </AbsoluteFill>
  );
};
