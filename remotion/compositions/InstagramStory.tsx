import { interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { z } from "zod";
import {
  DarkBackground,
  Heading,
  BodyText,
  FadeIn,
} from "../lib";

export const InstagramStorySchema = z.object({
  title: z.string(),
  subtitle: z.string(),
  accentColor: z.string(),
});

type Props = z.infer<typeof InstagramStorySchema>;

export const InstagramStory: React.FC<Props> = ({
  title,
  subtitle,
  accentColor,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Accent line descends from top
  const lineHeight = interpolate(frame, [0, 1.5 * fps], [0, 400], {
    extrapolateRight: "clamp",
  });

  return (
    <DarkBackground>
      {/* Top gradient wash */}
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: "100%",
          height: "60%",
          background: `linear-gradient(180deg, ${accentColor}12 0%, transparent 100%)`,
        }}
      />

      {/* Accent line from top */}
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 80,
          width: 3,
          height: lineHeight,
          background: `linear-gradient(180deg, ${accentColor} 0%, transparent 100%)`,
        }}
      />

      {/* Content — vertically centered */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          height: "100%",
          padding: "0 80px",
          gap: 24,
        }}
      >
        <FadeIn delay={0.5} duration={0.6} slideY={30}>
          <Heading size={56} dark>
            {title}
          </Heading>
        </FadeIn>

        <FadeIn delay={1.0} duration={0.6}>
          <BodyText size={24} dark secondary>
            {subtitle}
          </BodyText>
        </FadeIn>
      </div>

    </DarkBackground>
  );
};
