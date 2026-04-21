import { interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { z } from "zod";
import {
  DarkBackground,
  Heading,
  BodyText,
  AccentBar,
  FadeIn,
} from "../lib";

export const InstagramPostSchema = z.object({
  title: z.string(),
  subtitle: z.string(),
  accentColor: z.string(),
});

type Props = z.infer<typeof InstagramPostSchema>;

export const InstagramPost: React.FC<Props> = ({
  title,
  subtitle,
  accentColor,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Glow ring scales up
  const ringScale = interpolate(frame, [0, 1.2 * fps], [0.5, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <DarkBackground accentGlow glowPosition="center">
      {/* Background ring */}
      <div
        style={{
          position: "absolute",
          top: "50%",
          left: "50%",
          width: 600,
          height: 600,
          marginTop: -300,
          marginLeft: -300,
          borderRadius: "50%",
          background: `radial-gradient(circle, ${accentColor}20 0%, transparent 70%)`,
          transform: `scale(${ringScale})`,
        }}
      />

      {/* Content */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          textAlign: "center",
          height: "100%",
          padding: "0 80px",
          gap: 20,
          zIndex: 1,
        }}
      >
        <FadeIn delay={0.2} duration={0.6}>
          <Heading size={64} dark>
            {title}
          </Heading>
        </FadeIn>

        <FadeIn delay={0.6} duration={0.5}>
          <AccentBar width={60} height={3} color={accentColor} />
        </FadeIn>

        <FadeIn delay={0.8} duration={0.5}>
          <BodyText size={26} dark secondary>
            {subtitle}
          </BodyText>
        </FadeIn>
      </div>

    </DarkBackground>
  );
};
