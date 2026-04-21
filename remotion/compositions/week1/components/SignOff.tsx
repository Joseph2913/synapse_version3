import React from "react";
import { interpolate, useCurrentFrame } from "remotion";
import { fonts } from "../../../lib/fonts";

type SignOffProps = {
  text: string;
  enterFrame: number;
};

export const SignOff: React.FC<SignOffProps> = ({ text, enterFrame }) => {
  const frame = useCurrentFrame();

  const opacity = interpolate(frame, [enterFrame, enterFrame + 20], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <div
      style={{
        opacity,
        fontFamily: fonts.body,
        fontSize: 26,
        fontWeight: 500,
        color: "#808080",
        textAlign: "right",
        marginTop: 16,
      }}
    >
      {text}
    </div>
  );
};
