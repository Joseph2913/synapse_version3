import { z } from "zod";
import {
  DarkBackground,
  Heading,
  BodyText,
  GrowBar,
  FadeIn,
  SynapseLogo,
} from "../lib";

export const LinkedInUpdateSchema = z.object({
  title: z.string(),
  subtitle: z.string(),
  accentColor: z.string(),
});

type Props = z.infer<typeof LinkedInUpdateSchema>;

export const LinkedInUpdate: React.FC<Props> = ({
  title,
  subtitle,
  accentColor,
}) => {
  return (
    <DarkBackground accentGlow glowPosition="top-right">
      {/* Content */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          padding: "0 120px",
          height: "100%",
          gap: 24,
        }}
      >
        <FadeIn delay={0.3} duration={0.8}>
          <GrowBar delay={0} width={120} height={4} color={accentColor} />
        </FadeIn>

        <FadeIn delay={0.3} duration={0.7} slideY={-20}>
          <Heading size={72} dark>
            {title}
          </Heading>
        </FadeIn>

        <FadeIn delay={0.8} duration={0.6}>
          <BodyText size={32} dark secondary>
            {subtitle}
          </BodyText>
        </FadeIn>
      </div>

      {/* Bottom right — flame logo */}
      <div style={{ position: "absolute", bottom: 48, right: 120 }}>
        <FadeIn delay={1.0} duration={0.6}>
          <SynapseLogo size={40} dark />
        </FadeIn>
      </div>
    </DarkBackground>
  );
};
