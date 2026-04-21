/**
 * "Knowledge Compounds" — LinkedIn concept video
 *
 * 30s at 30fps (900 frames) on #f4f2ee LinkedIn background.
 *
 * Scenes:
 *   0-8s     Full transcript + notes + "real value = connections" text
 *   8-11s    Synapse brand introduction
 *   11-18s   Step 1 — extract entities & connections from a transcript
 *   18-23s   Step 2 — connect across meetings automatically
 *   23-29s   Step 3 — query knowledge via chat / MCPs
 *   29-30s   Logo hold
 */

import React from "react";
import {
  AbsoluteFill,
  Img,
  Sequence,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
  staticFile,
} from "remotion";
import { Audio } from "@remotion/media";
import { z } from "zod";
import {
  LinkedInBackground,
  Heading,
  BodyText,
  SectionLabel,
  EntityBadge,
  FadeIn,
  GrowBar,
  SynapseLogo,
  AccentBar,
  accent,
  text,
  entity,
  bg,
  fonts,
  border,
} from "../lib";
import type { EntityType } from "../lib";

export const KnowledgeCompoundsSchema = z.object({});
type Props = z.infer<typeof KnowledgeCompoundsSchema>;

// ── Shared Data ──────────────────────────────────────────

const SPEAKER_COLORS: Record<string, string> = {
  Sarah: "#b45309",  // warm amber
  Marc: "#64748b",   // blue-gray
  Priya: "#0d9488",  // teal
  James: "#7c3aed",  // muted purple
};

const TRANSCRIPT_LINES = [
  { speaker: "Sarah", text: "I think we need to revisit the EU timeline. The compliance review is taking longer than expected and we can't keep pushing deadlines." },
  { speaker: "Marc", text: "Agreed. Legal flagged two issues last week that could push us back a full quarter. We need to get ahead of this." },
  { speaker: "Priya", text: "I've been tracking the regulatory changes from the Brussels office. There's a new amendment that could actually simplify our filing process." },
  { speaker: "James", text: "That's interesting. Do we have a timeline on when that amendment takes effect? Because our current plan assumes the old framework." },
  { speaker: "Sarah", text: "What if we hire external counsel to accelerate? That was on the table before. I think it's worth revisiting given the stakes." },
  { speaker: "Marc", text: "We'd need budget approval from leadership. But I think the cost of delay is higher than the cost of external help at this point." },
  { speaker: "Priya", text: "I can put together a comparison — internal timeline vs. external counsel timeline. Should have it by Thursday." },
  { speaker: "James", text: "Perfect. I'll also check if there's a regulatory fast-track option we haven't explored. I've heard Denmark used one recently." },
  { speaker: "Sarah", text: "Good. Let's also loop in the finance team for a cost estimate. Marc, can you draft the proposal and circulate it before Friday?" },
  { speaker: "Marc", text: "Will do. I'll model three scenarios — conservative, moderate, and aggressive — so leadership can pick their comfort level." },
  { speaker: "Priya", text: "One more thing — we should align with the product team on feature parity for the EU launch. There are GDPR-specific features still in backlog." },
  { speaker: "James", text: "Right, I'll flag that with the engineering leads. We don't want to launch and then scramble to patch compliance gaps." },
  { speaker: "Sarah", text: "Okay, so to summarise — Marc is drafting the proposal with three scenarios, Priya is doing the timeline comparison, and James is researching fast-track options." },
  { speaker: "Marc", text: "And we should probably set a follow-up for next Tuesday to review everything before escalating to the leadership team." },
  { speaker: "Priya", text: "Agreed. I'll also pull the latest regulatory filings from the Brussels portal so we have the most current data." },
  { speaker: "James", text: "One more thought — should we also loop in our compliance officer? She might have insights on the new amendment's implications for our data processing agreements." },
  { speaker: "Sarah", text: "Great point. I'll reach out to her today and see if she can join the Tuesday call. Anything else before we wrap?" },
  { speaker: "Marc", text: "I think we're good. Let's make sure all the action items are tracked and assigned. I'll send a recap to the wider team this afternoon." },
];

const ACTION_ITEMS = [
  "Draft budget proposal for external legal counsel (Marc, by Friday)",
  "Model three cost scenarios — conservative, moderate, aggressive (Marc)",
  "Prepare internal vs. external counsel timeline comparison (Priya, by Thursday)",
  "Research regulatory fast-track options in EU member states (James)",
  "Loop in finance team for cost estimates (Sarah)",
  "Align with product team on GDPR feature parity (Priya)",
  "Flag EU compliance backlog items with engineering leads (James)",
  "Reach out to compliance officer re: new amendment implications (Sarah)",
  "Schedule follow-up review meeting for Tuesday (Marc)",
  "Pull latest regulatory filings from Brussels portal (Priya)",
  "Send meeting recap to wider team (Marc, today)",
];

const KEY_TOPICS = [
  "EU Expansion", "Compliance", "Budget", "Legal Counsel",
  "GDPR", "Regulatory", "Timeline", "Data Processing",
  "External Counsel", "Brussels Amendment",
];

const SUMMARY_BULLETS = [
  "EU expansion timeline is at risk due to extended compliance review",
  "New Brussels amendment may simplify the filing process",
  "Team agreed to explore external legal counsel to accelerate",
  "Three cost scenarios will be modelled for leadership review",
  "GDPR-specific features still in backlog need prioritisation",
  "Follow-up review scheduled for Tuesday before leadership escalation",
  "Compliance officer to be looped in for amendment implications",
];

// Entity data for extraction scene
type EntityData = { type: EntityType; label: string };
const EXTRACTED_ENTITIES: EntityData[] = [
  { type: "person", label: "Sarah Chen" },
  { type: "person", label: "Marc Davis" },
  { type: "person", label: "Priya Sharma" },
  { type: "topic", label: "EU Expansion" },
  { type: "decision", label: "Hire external counsel" },
  { type: "risk", label: "Compliance delay" },
  { type: "action", label: "Draft budget proposal" },
];

type EntityEdge = { from: number; to: number; label: string };
const ENTITY_EDGES: EntityEdge[] = [
  { from: 0, to: 3, label: "discusses" },
  { from: 5, to: 4, label: "motivates" },
  { from: 5, to: 3, label: "blocks" },
  { from: 1, to: 6, label: "assigned" },
  { from: 2, to: 5, label: "tracks" },
];

// Meeting graph data
type MeetingNode = { id: number; x: number; y: number };
const MEETING_NODES: MeetingNode[] = [
  { id: 1, x: 960, y: 380 },
  { id: 2, x: 640, y: 280 },
  { id: 3, x: 1280, y: 300 },
  { id: 4, x: 520, y: 460 },
  { id: 5, x: 1160, y: 510 },
  { id: 6, x: 760, y: 560 },
  { id: 7, x: 1060, y: 240 },
  { id: 8, x: 440, y: 360 },
  { id: 9, x: 1360, y: 440 },
];

type GraphEdge = { from: number; to: number; cross?: boolean };
const GRAPH_EDGES: GraphEdge[] = [
  { from: 1, to: 2, cross: true },
  { from: 1, to: 3, cross: true },
  { from: 1, to: 4, cross: true },
  { from: 2, to: 5, cross: true },
  { from: 2, to: 8, cross: true },
  { from: 3, to: 7, cross: true },
  { from: 3, to: 9, cross: true },
  { from: 4, to: 6 },
  { from: 5, to: 7, cross: true },
  { from: 6, to: 8 },
  { from: 5, to: 9, cross: true },
];

function getNode(id: number): MeetingNode {
  return MEETING_NODES.find((m) => m.id === id)!;
}

// ── Shared Sub-Components ────────────────────────────────

const MeetingDot: React.FC<{
  id: number; x: number; y: number; opacity: number; scale: number; highlight?: boolean;
}> = ({ id, x, y, opacity, scale, highlight }) => {
  const color = highlight ? accent[500] : text.secondary;
  const size = 40;
  return (
    <div style={{
      position: "absolute", left: x - size / 2, top: y - size / 2,
      width: size, height: size, borderRadius: "50%",
      background: highlight ? `${accent[500]}18` : `${text.secondary}10`,
      border: `2px solid ${color}45`,
      display: "flex", alignItems: "center", justifyContent: "center",
      opacity, transform: `scale(${scale})`,
    }}>
      <span style={{ fontFamily: fonts.display, fontSize: 14, fontWeight: 700, color }}>{id}</span>
    </div>
  );
};

const StepHeader: React.FC<{
  step: number; description: string; opacity: number;
}> = ({ step, description, opacity }) => (
  <div style={{
    position: "absolute", top: 40, left: "50%", transform: "translateX(-50%)",
    textAlign: "center", opacity,
  }}>
    <div style={{
      fontFamily: fonts.display, fontSize: 12, fontWeight: 700,
      color: accent[500], letterSpacing: "0.1em",
      textTransform: "uppercase" as const, marginBottom: 8,
    }}>
      Step {step}
    </div>
    <div style={{ fontFamily: fonts.body, fontSize: 20, fontWeight: 500, color: text.body }}>
      {description}
    </div>
  </div>
);

const cardStyle: React.CSSProperties = {
  background: bg.card, borderRadius: 12,
  border: `1px solid ${border.subtle}`, overflow: "hidden",
};

// ═══════════════════════════════════════════════════════════
// SCENE 1: Familiar → Limitation → Iceberg (0–8s)
// ═══════════════════════════════════════════════════════════

// Iceberg constellation nodes (the hidden knowledge network)
const ICEBERG_NODES: Array<{ x: number; y: number; color: string; size: number }> = [
  { x: 340, y: 140, color: entity.person, size: 10 },
  { x: 520, y: 100, color: entity.topic, size: 8 },
  { x: 700, y: 160, color: entity.decision, size: 9 },
  { x: 880, y: 110, color: entity.risk, size: 11 },
  { x: 1060, y: 150, color: entity.action, size: 8 },
  { x: 1240, y: 90, color: entity.project, size: 10 },
  { x: 1420, y: 170, color: entity.insight, size: 9 },
  { x: 1560, y: 120, color: entity.person, size: 8 },
  { x: 430, y: 240, color: entity.goal, size: 9 },
  { x: 620, y: 270, color: entity.tech, size: 8 },
  { x: 800, y: 220, color: entity.concept, size: 10 },
  { x: 980, y: 260, color: entity.person, size: 9 },
  { x: 1160, y: 230, color: entity.risk, size: 8 },
  { x: 1340, y: 280, color: entity.decision, size: 10 },
  { x: 1500, y: 240, color: entity.topic, size: 7 },
  { x: 380, y: 340, color: entity.action, size: 8 },
  { x: 560, y: 360, color: entity.person, size: 9 },
  { x: 740, y: 320, color: entity.project, size: 10 },
  { x: 920, y: 350, color: entity.insight, size: 8 },
  { x: 1100, y: 330, color: entity.goal, size: 9 },
  { x: 1280, y: 370, color: entity.tech, size: 8 },
  { x: 1460, y: 340, color: entity.concept, size: 9 },
];

const ICEBERG_EDGES: Array<{ from: number; to: number; highlight?: boolean }> = [
  { from: 0, to: 1 }, { from: 1, to: 2 }, { from: 2, to: 3, highlight: true },
  { from: 3, to: 4 }, { from: 4, to: 5 }, { from: 5, to: 6 },
  { from: 6, to: 7 }, { from: 0, to: 8 }, { from: 8, to: 9 },
  { from: 9, to: 10, highlight: true }, { from: 10, to: 11 }, { from: 11, to: 12 },
  { from: 12, to: 13 }, { from: 13, to: 14 }, { from: 8, to: 16 },
  { from: 15, to: 16 }, { from: 16, to: 17 }, { from: 17, to: 18, highlight: true },
  { from: 18, to: 19 }, { from: 19, to: 20 }, { from: 20, to: 21 },
  { from: 1, to: 9 }, { from: 3, to: 12 }, { from: 5, to: 13 },
  { from: 10, to: 18 }, { from: 2, to: 10 }, { from: 11, to: 19 },
];

const SceneTranscript: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // ── Beat 1 (0-2s): Cards visible, fully populated ──
  // Cards shrink and sink starting at 2s
  const cardScale = interpolate(frame, [2 * fps, 3.5 * fps], [1, 0.42], {
    extrapolateLeft: "clamp", extrapolateRight: "clamp",
  });
  const cardY = interpolate(frame, [2 * fps, 4 * fps], [0, 420], {
    extrapolateLeft: "clamp", extrapolateRight: "clamp",
  });
  const cardOp = interpolate(frame, [3.5 * fps, 4.5 * fps], [1, 0.25], {
    extrapolateLeft: "clamp", extrapolateRight: "clamp",
  });

  // Logo carousel always visible in beat 1-2, fades in beat 3
  const logoOp = interpolate(frame, [3 * fps, 4 * fps], [1, 0], {
    extrapolateLeft: "clamp", extrapolateRight: "clamp",
  });

  // ── Beat 2 (2-4s): "Great for one meeting." ──
  const limitTextOp = interpolate(
    frame,
    [2 * fps, 2.6 * fps, 3.8 * fps, 4.3 * fps],
    [0, 1, 1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  // ── Beat 3 (4-7s): Iceberg reveal ──
  const waterlineOp = interpolate(frame, [3.8 * fps, 4.5 * fps], [0, 1], {
    extrapolateLeft: "clamp", extrapolateRight: "clamp",
  });

  // Constellation nodes fade in staggered
  const constellationOp = interpolate(frame, [4.2 * fps, 5.2 * fps], [0, 1], {
    extrapolateLeft: "clamp", extrapolateRight: "clamp",
  });

  // Edges draw in
  const edgeProgress = interpolate(frame, [4.5 * fps, 6 * fps], [0, 1], {
    extrapolateLeft: "clamp", extrapolateRight: "clamp",
  });

  // "90% of the value" text
  const icebergTextOp = interpolate(frame, [5 * fps, 5.8 * fps], [0, 1], {
    extrapolateLeft: "clamp", extrapolateRight: "clamp",
  });

  // ── Beat 4 (7-8s): Fade out ──
  const exitOp = interpolate(frame, [7 * fps, 7.8 * fps], [1, 0], {
    extrapolateLeft: "clamp", extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill style={{ opacity: exitOp }}>
      {/* ── Cards layer (shrinks and sinks) ── */}
      <div style={{
        position: "absolute", inset: 0,
        display: "flex", flexDirection: "column",
        padding: "32px 64px",
        gap: 16,
        transform: `translateY(${cardY}px) scale(${cardScale})`,
        transformOrigin: "center top",
        opacity: cardOp,
      }}>
        <div style={{ display: "flex", gap: 20, flex: 1, minHeight: 0 }}>
          {/* Left: Transcript */}
          <div style={{ flex: "0 0 47%", ...cardStyle, padding: "20px 24px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 14 }}>
              <span style={{ fontFamily: fonts.display, fontSize: 13, fontWeight: 700, color: text.secondary, letterSpacing: "0.06em", textTransform: "uppercase" as const }}>
                Meeting Transcript
              </span>
              <span style={{ fontFamily: fonts.body, fontSize: 10, color: text.placeholder }}>
                Apr 3, 2026 · 47 min
              </span>
            </div>
            <div style={{ overflow: "hidden", height: "calc(100% - 40px)" }}>
              {TRANSCRIPT_LINES.map((line, i) => (
                <div key={i} style={{ marginBottom: 10 }}>
                  <span style={{
                    fontFamily: fonts.body, fontSize: 12, fontWeight: 600,
                    color: SPEAKER_COLORS[line.speaker],
                  }}>
                    {line.speaker}:
                  </span>
                  <span style={{ fontFamily: fonts.body, fontSize: 12, fontWeight: 400, color: text.body, marginLeft: 5, lineHeight: 1.45 }}>
                    {line.text}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* Right: Meeting Notes */}
          <div style={{ flex: 1, ...cardStyle, padding: "20px 24px" }}>
            <div style={{ fontFamily: fonts.display, fontSize: 13, fontWeight: 700, color: text.secondary, letterSpacing: "0.06em", textTransform: "uppercase" as const, marginBottom: 14 }}>
              Meeting Notes
            </div>
            <div style={{ overflow: "hidden" }}>
              <div style={{ marginBottom: 12 }}>
                <div style={{ fontFamily: fonts.body, fontSize: 11, fontWeight: 600, color: text.primary, marginBottom: 5 }}>Action Items</div>
                {ACTION_ITEMS.map((item, i) => (
                  <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 5, marginBottom: 3 }}>
                    <div style={{ width: 11, height: 11, borderRadius: 3, border: `1.5px solid ${text.placeholder}`, flexShrink: 0, marginTop: 2 }} />
                    <span style={{ fontFamily: fonts.body, fontSize: 11, color: text.body, lineHeight: 1.35 }}>{item}</span>
                  </div>
                ))}
              </div>
              <div style={{ marginBottom: 12 }}>
                <div style={{ fontFamily: fonts.body, fontSize: 11, fontWeight: 600, color: text.primary, marginBottom: 5 }}>Key Topics</div>
                <div style={{ display: "flex", flexWrap: "wrap" as const, gap: 4 }}>
                  {KEY_TOPICS.map((topic, i) => (
                    <div key={i} style={{
                      fontFamily: fonts.body, fontSize: 10, fontWeight: 500, color: text.body,
                      padding: "2px 8px", borderRadius: 20, background: bg.inset, border: `1px solid ${border.subtle}`,
                    }}>{topic}</div>
                  ))}
                </div>
              </div>
              <div>
                <div style={{ fontFamily: fonts.body, fontSize: 11, fontWeight: 600, color: text.primary, marginBottom: 5 }}>Summary</div>
                <div style={{ fontFamily: fonts.body, fontSize: 11, color: text.body, lineHeight: 1.45, marginBottom: 6 }}>
                  The team discussed delays in the EU expansion timeline due to ongoing compliance challenges and explored several paths to accelerate.
                </div>
                {SUMMARY_BULLETS.map((b, i) => (
                  <div key={i} style={{ display: "flex", gap: 5, marginBottom: 2 }}>
                    <span style={{ color: text.placeholder, fontSize: 11 }}>•</span>
                    <span style={{ fontFamily: fonts.body, fontSize: 11, color: text.body, lineHeight: 1.4 }}>{b}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Logo strip */}
        <div style={{
          ...cardStyle, padding: "10px 40px",
          flexShrink: 0, opacity: logoOp,
        }}>
          <div style={{ overflow: "hidden", height: 36 }}>
            {(() => {
              const logos = [
                "logos/otter.jpeg", "logos/fireflies.jpeg", "logos/tldv.svg",
                "logos/copilot.svg", "logos/granola.svg", "logos/meetgeek.jpeg",
                "logos/readai.png", "logos/circleback.jpeg",
              ];
              const allLogos = [...logos, ...logos, ...logos];
              const logoBoxWidth = 140;
              const gapWidth = 48;
              const setWidth = logos.length * (logoBoxWidth + gapWidth);
              const slideX = interpolate(frame, [0, 8 * fps], [0, -setWidth], {
                extrapolateRight: "extend",
              });
              return (
                <div style={{
                  display: "flex", alignItems: "center", gap: gapWidth,
                  transform: `translateX(${slideX % setWidth}px)`,
                }}>
                  {allLogos.map((logo, i) => (
                    <div key={i} style={{
                      width: logoBoxWidth, height: 34,
                      display: "flex", alignItems: "center", justifyContent: "center",
                      flexShrink: 0,
                    }}>
                      <Img
                        src={staticFile(logo)}
                        style={{
                          maxHeight: 32, maxWidth: logoBoxWidth,
                          objectFit: "contain" as const, borderRadius: 4,
                        }}
                      />
                    </div>
                  ))}
                </div>
              );
            })()}
          </div>
        </div>
      </div>

      {/* ── Beat 2: "Great for one meeting." text ── */}
      <div style={{
        position: "absolute", top: 80, left: 0, right: 0,
        display: "flex", justifyContent: "center",
        opacity: limitTextOp,
      }}>
        <span style={{
          fontFamily: fonts.display, fontSize: 48, fontWeight: 800,
          color: text.primary, letterSpacing: "-0.02em",
        }}>
          Great for one meeting.
        </span>
      </div>

      {/* ── Beat 3: Iceberg — waterline + constellation ── */}

      {/* Waterline */}
      <div style={{
        position: "absolute", top: 520, left: 120, right: 120,
        height: 1, background: `${text.secondary}30`,
        opacity: waterlineOp,
      }} />

      {/* "Tip" label above waterline */}
      <div style={{
        position: "absolute", top: 496, right: 140,
        opacity: waterlineOp * icebergTextOp,
      }}>
        <span style={{ fontFamily: fonts.body, fontSize: 11, color: text.placeholder, fontStyle: "italic" }}>
          what you see ↑
        </span>
      </div>
      <div style={{
        position: "absolute", top: 528, right: 140,
        opacity: waterlineOp * icebergTextOp,
      }}>
        <span style={{ fontFamily: fonts.body, fontSize: 11, color: text.placeholder, fontStyle: "italic" }}>
          what you're missing ↓
        </span>
      </div>

      {/* Constellation (above waterline area — represents hidden knowledge) */}
      <div style={{
        position: "absolute", top: 120, left: 0, right: 0, height: 400,
        opacity: constellationOp,
      }}>
        {/* Edges */}
        <svg style={{ position: "absolute", inset: 0 }} viewBox="0 0 1920 400">
          {ICEBERG_EDGES.map((edge, i) => {
            const from = ICEBERG_NODES[edge.from];
            const to = ICEBERG_NODES[edge.to];
            const lineLen = Math.sqrt((to.x - from.x) ** 2 + (to.y - from.y) ** 2);
            const thisEdgeProgress = interpolate(
              edgeProgress,
              [Math.max(0, (i / ICEBERG_EDGES.length) - 0.1), Math.min(1, (i / ICEBERG_EDGES.length) + 0.3)],
              [lineLen, 0],
              { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
            );
            return (
              <line
                key={i}
                x1={from.x} y1={from.y} x2={to.x} y2={to.y}
                stroke={edge.highlight ? accent[500] : `${text.secondary}40`}
                strokeWidth={edge.highlight ? 1.5 : 0.8}
                strokeDasharray={lineLen}
                strokeDashoffset={thisEdgeProgress}
              />
            );
          })}
        </svg>

        {/* Nodes */}
        {ICEBERG_NODES.map((node, i) => {
          const nodeDelay = 4.2 + (i * 0.04);
          const nodeOp = interpolate(frame, [nodeDelay * fps, (nodeDelay + 0.3) * fps], [0, 0.85], {
            extrapolateLeft: "clamp", extrapolateRight: "clamp",
          });
          return (
            <div
              key={i}
              style={{
                position: "absolute",
                left: node.x - node.size,
                top: node.y - node.size,
                width: node.size * 2,
                height: node.size * 2,
                borderRadius: "50%",
                background: `${node.color}30`,
                border: `1.5px solid ${node.color}60`,
                opacity: nodeOp,
              }}
            />
          );
        })}
      </div>

      {/* "90% of the value" text */}
      <div style={{
        position: "absolute", bottom: 160, left: 0, right: 0,
        display: "flex", flexDirection: "column", alignItems: "center", gap: 12,
        opacity: icebergTextOp,
      }}>
        <span style={{
          fontFamily: fonts.display, fontSize: 38, fontWeight: 800,
          color: text.primary, letterSpacing: "-0.02em", textAlign: "center",
        }}>
          90% of the value is in the{" "}
          <span style={{ color: accent[500] }}>connections between them</span>.
        </span>
      </div>
    </AbsoluteFill>
  );
};

// ═══════════════════════════════════════════════════════════
// SCENE 2: Synapse Brand Intro (8–11s)
// ═══════════════════════════════════════════════════════════

const SceneBrand: React.FC = () => {
  return (
    <AbsoluteFill style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 20 }}>
      <Sequence from={0} layout="none">
        <Audio src={staticFile("audio/connection.wav")} volume={0.3} />
      </Sequence>
      <FadeIn delay={0.2} duration={0.6}>
        <SynapseLogo size={80} />
      </FadeIn>
      <FadeIn delay={0.5} duration={0.5}>
        <div style={{ fontFamily: fonts.display, fontSize: 36, fontWeight: 800, color: text.primary, letterSpacing: "-0.02em" }}>
          Synapse
        </div>
      </FadeIn>
      <FadeIn delay={0.8} duration={0.5}>
        <div style={{ fontFamily: fonts.body, fontSize: 20, color: text.secondary }}>
          Your personal knowledge system.
        </div>
      </FadeIn>
    </AbsoluteFill>
  );
};

// ═══════════════════════════════════════════════════════════
// SCENE 3: Step 1 — Extract Entities (11–18s)
// ═══════════════════════════════════════════════════════════

const ENTITY_POSITIONS = [
  { x: 1060, y: 200 },  // Sarah Chen
  { x: 1280, y: 240 },  // Marc Davis
  { x: 1180, y: 340 },  // Priya Sharma
  { x: 1060, y: 440 },  // EU Expansion
  { x: 1300, y: 420 },  // Hire external counsel
  { x: 1160, y: 540 },  // Compliance delay
  { x: 1340, y: 540 },  // Draft budget proposal
];

const SceneStep1: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const headerOp = interpolate(frame, [0, 0.5 * fps], [0, 1], { extrapolateRight: "clamp" });
  const transcriptOp = interpolate(frame, [0.3 * fps, 0.8 * fps], [0, 0.8], { extrapolateRight: "clamp" });

  const entityDelays = [0.8, 1.1, 1.4, 1.7, 2.0, 2.3, 2.6];
  const edgeStartTime = 3.5;

  const relationshipLabelOp = interpolate(frame, [4.5 * fps, 5 * fps], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });

  return (
    <AbsoluteFill>
      {/* Entity pops */}
      {entityDelays.map((d, i) => (
        <Sequence key={`pop-${i}`} from={Math.round(d * fps)} layout="none">
          <Audio src={staticFile("audio/node-pop.wav")} volume={0.45} />
        </Sequence>
      ))}
      {/* Connection sounds */}
      {ENTITY_EDGES.map((_, i) => (
        <Sequence key={`conn-${i}`} from={Math.round((edgeStartTime + i * 0.3) * fps)} layout="none">
          <Audio src={staticFile("audio/connection.wav")} volume={0.18} />
        </Sequence>
      ))}

      {/* Step Header */}
      <StepHeader step={1} description="Extract entities & connections from each transcript" opacity={headerOp} />

      {/* Left: Mini transcript */}
      <div style={{ position: "absolute", left: 80, top: 120, width: 520, opacity: transcriptOp }}>
        <div style={{ ...cardStyle, padding: "18px 22px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 12 }}>
            <span style={{ fontFamily: fonts.display, fontSize: 11, fontWeight: 700, color: text.secondary, letterSpacing: "0.06em", textTransform: "uppercase" as const }}>
              Meeting 1 — Transcript
            </span>
            <span style={{ fontFamily: fonts.body, fontSize: 10, color: text.placeholder }}>Apr 3, 2026</span>
          </div>
          {TRANSCRIPT_LINES.slice(0, 6).map((line, i) => (
            <div key={i} style={{ marginBottom: 8 }}>
              <span style={{ fontFamily: fonts.body, fontSize: 11, fontWeight: 600, color: SPEAKER_COLORS[line.speaker] }}>
                {line.speaker}:
              </span>
              <span style={{ fontFamily: fonts.body, fontSize: 11, color: text.body, marginLeft: 5, lineHeight: 1.5 }}>
                {line.text.length > 70 ? line.text.slice(0, 70) + "..." : line.text}
              </span>
            </div>
          ))}
        </div>

        {/* Arrow */}
        <div style={{ position: "absolute", right: -55, top: "50%", transform: "translateY(-50%)", display: "flex", alignItems: "center" }}>
          <div style={{ width: 35, height: 2, background: `${accent[500]}60` }} />
          <div style={{ width: 0, height: 0, borderTop: "5px solid transparent", borderBottom: "5px solid transparent", borderLeft: `7px solid ${accent[500]}60` }} />
        </div>
      </div>

      {/* Right: Entities */}
      {EXTRACTED_ENTITIES.map((e, i) => {
        const delay = entityDelays[i];
        const pos = ENTITY_POSITIONS[i];
        const eOp = interpolate(frame, [delay * fps, (delay + 0.25) * fps], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
        const eScale = interpolate(frame, [delay * fps, (delay + 0.2) * fps], [0.5, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
        return (
          <div key={i} style={{ position: "absolute", left: pos.x, top: pos.y, opacity: eOp, transform: `scale(${eScale})` }}>
            <EntityBadge type={e.type} label={e.label} size="md" />
          </div>
        );
      })}

      {/* Edges between entities */}
      <svg style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
        {ENTITY_EDGES.map((edge, i) => {
          const fp = ENTITY_POSITIONS[edge.from];
          const tp = ENTITY_POSITIONS[edge.to];
          const fx = fp.x + 55; const fy = fp.y + 14;
          const tx = tp.x + 55; const ty = tp.y + 14;
          const lineLen = Math.sqrt((tx - fx) ** 2 + (ty - fy) ** 2);
          const edgeDelay = edgeStartTime + i * 0.3;
          const drawProg = interpolate(frame, [edgeDelay * fps, (edgeDelay + 0.4) * fps], [lineLen, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
          const edgeOp = interpolate(frame, [edgeDelay * fps, (edgeDelay + 0.3) * fps], [0, 0.35], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
          return (
            <line key={i} x1={fx} y1={fy} x2={tx} y2={ty}
              stroke={text.secondary} strokeWidth={1.5}
              opacity={edgeOp} strokeDasharray={lineLen} strokeDashoffset={drawProg}
            />
          );
        })}
      </svg>

      {/* Relationship label callout on the "blocks" edge (index 2: risk → EU expansion) */}
      {(() => {
        const fp = ENTITY_POSITIONS[5]; const tp = ENTITY_POSITIONS[3];
        const mx = (fp.x + 55 + tp.x + 55) / 2;
        const my = (fp.y + 14 + tp.y + 14) / 2;
        return (
          <div style={{
            position: "absolute", left: mx - 30, top: my - 20, opacity: relationshipLabelOp,
            fontFamily: fonts.body, fontSize: 10, fontWeight: 600, fontStyle: "italic",
            color: accent[500], background: `${accent[50]}`, padding: "2px 8px",
            borderRadius: 4, border: `1px solid ${accent[500]}20`,
          }}>
            blocks
          </div>
        );
      })()}
    </AbsoluteFill>
  );
};

// ═══════════════════════════════════════════════════════════
// SCENE 4: Step 2 — Connect Across Meetings (18–23s)
// ═══════════════════════════════════════════════════════════

const SceneStep2: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const headerOp = interpolate(frame, [0, 0.5 * fps], [0, 1], { extrapolateRight: "clamp" });
  const spawnInterval = 0.45;

  const entityCount = interpolate(frame, [1 * fps, 4 * fps], [7, 47], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const connCount = interpolate(frame, [2 * fps, 4.5 * fps], [5, 23], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const counterOp = interpolate(frame, [1.5 * fps, 2 * fps], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });

  const descOp = interpolate(frame, [3 * fps, 3.8 * fps], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });

  // Brief entity badge flashes for meetings 2-4
  const flashMeetings = [
    { id: 2, delay: 1.0, entities: [{ type: "person" as EntityType, label: "Sarah Chen" }, { type: "project" as EntityType, label: "EU Launch" }] },
    { id: 3, delay: 1.5, entities: [{ type: "risk" as EntityType, label: "Compliance delay" }, { type: "person" as EntityType, label: "Marc Davis" }] },
    { id: 4, delay: 2.0, entities: [{ type: "topic" as EntityType, label: "Budget review" }, { type: "action" as EntityType, label: "Cost analysis" }] },
  ];

  return (
    <AbsoluteFill>
      {/* Whoosh */}
      <Sequence from={0} layout="none">
        <Audio src={staticFile("audio/whoosh.wav")} volume={0.35} />
      </Sequence>
      {/* Pops */}
      {MEETING_NODES.slice(1).map((_, i) => (
        <Sequence key={`pop-${i}`} from={Math.round((0.6 + i * spawnInterval) * fps)} layout="none">
          <Audio src={staticFile("audio/node-pop.wav")} volume={0.25} />
        </Sequence>
      ))}
      {/* Chimes */}
      {GRAPH_EDGES.filter(e => e.cross).slice(0, 5).map((_, i) => (
        <Sequence key={`ch-${i}`} from={Math.round((2.5 + i * 0.35) * fps)} layout="none">
          <Audio src={staticFile("audio/connection.wav")} volume={0.15} />
        </Sequence>
      ))}

      <StepHeader step={2} description="Every new meeting connects to all previous meetings" opacity={headerOp} />

      {/* Edges */}
      <svg style={{ position: "absolute", inset: 0 }} viewBox="0 0 1920 1080">
        {GRAPH_EDGES.map((edge, i) => {
          const fn = getNode(edge.from); const tn = getNode(edge.to);
          const lineLen = Math.sqrt((tn.x - fn.x) ** 2 + (tn.y - fn.y) ** 2);
          const edgeDelay = 2.2 + i * 0.22;
          const drawProg = interpolate(frame, [edgeDelay * fps, (edgeDelay + 0.4) * fps], [lineLen, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
          const edgeOp = interpolate(frame, [edgeDelay * fps, (edgeDelay + 0.3) * fps], [0, edge.cross ? 0.4 : 0.18], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
          return (
            <line key={i} x1={fn.x} y1={fn.y} x2={tn.x} y2={tn.y}
              stroke={edge.cross ? accent[500] : text.secondary}
              strokeWidth={edge.cross ? 2 : 1}
              opacity={edgeOp} strokeDasharray={lineLen} strokeDashoffset={drawProg}
            />
          );
        })}
      </svg>

      {/* Meeting dots */}
      {MEETING_NODES.map((m, i) => {
        const isFirst = i === 0;
        const spawnTime = isFirst ? 0 : 0.6 + (i - 1) * spawnInterval;
        const op = interpolate(frame, [spawnTime * fps, (spawnTime + 0.3) * fps], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
        const sc = interpolate(frame, [spawnTime * fps, (spawnTime + 0.25) * fps], [isFirst ? 1 : 0.3, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
        return <MeetingDot key={m.id} id={m.id} x={m.x} y={m.y} opacity={op} scale={sc} highlight={isFirst} />;
      })}

      {/* Brief entity badge flashes near spawning meetings */}
      {flashMeetings.map((fm) => {
        const node = getNode(fm.id);
        const flashOp = interpolate(
          frame,
          [fm.delay * fps, (fm.delay + 0.3) * fps, (fm.delay + 0.8) * fps, (fm.delay + 1.2) * fps],
          [0, 0.9, 0.9, 0],
          { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
        );
        return (
          <div key={fm.id} style={{
            position: "absolute", left: node.x + 28, top: node.y - 15,
            display: "flex", flexDirection: "column", gap: 4, opacity: flashOp,
          }}>
            {fm.entities.map((e, i) => (
              <EntityBadge key={i} type={e.type} label={e.label} size="sm" />
            ))}
          </div>
        );
      })}

      {/* Bottom description */}
      <div style={{
        position: "absolute", bottom: 110, left: "50%", transform: "translateX(-50%)",
        maxWidth: 700, textAlign: "center", opacity: descOp,
      }}>
        <span style={{ fontFamily: fonts.body, fontSize: 14, color: text.secondary, lineHeight: 1.6 }}>
          Synapse connects to your AI note-taking tool. Every new meeting is automatically ingested — entities extracted, connections discovered across all your previous meetings.
        </span>
      </div>

      {/* Counter */}
      <div style={{
        position: "absolute", bottom: 60, left: "50%", transform: "translateX(-50%)",
        display: "flex", gap: 16, alignItems: "baseline", opacity: counterOp,
      }}>
        <span style={{ fontFamily: fonts.display, fontSize: 30, fontWeight: 800, color: text.primary, letterSpacing: "-0.02em" }}>
          {Math.round(entityCount)}
        </span>
        <span style={{ fontFamily: fonts.body, fontSize: 13, color: text.secondary }}>entities</span>
        <span style={{ color: text.placeholder }}>·</span>
        <span style={{ fontFamily: fonts.display, fontSize: 30, fontWeight: 800, color: accent[500], letterSpacing: "-0.02em" }}>
          {Math.round(connCount)}
        </span>
        <span style={{ fontFamily: fonts.body, fontSize: 13, color: text.secondary }}>
          connections across{" "}
          <span style={{ color: accent[500], fontWeight: 600 }}>9 meetings</span>
        </span>
      </div>
    </AbsoluteFill>
  );
};

// ═══════════════════════════════════════════════════════════
// SCENE 5: Step 3 — Query Knowledge (23–29s)
// ═══════════════════════════════════════════════════════════

const QUERY_TEXT = "What has Sarah Chen said about EU expansion risk?";
const ANSWER_TEXT = 'Sarah raised EU compliance concerns in 3 meetings. In Meeting 3, she flagged a regulatory delay that could push the timeline back a full quarter. By Meeting 7, she recommended hiring external counsel to accelerate, and in Meeting 10 she proposed delaying the launch to Q4 to ensure full compliance.';

const SceneStep3: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const headerOp = interpolate(frame, [0, 0.5 * fps], [0, 1], { extrapolateRight: "clamp" });

  // Graph presence
  const graphOp = interpolate(frame, [0, 0.5 * fps], [0, 0.45], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });

  // Typing
  const typingStart = 0.6 * fps;
  const charsTyped = Math.min(QUERY_TEXT.length, Math.max(0, Math.floor((frame - typingStart) * 0.9)));
  const queryVisible = QUERY_TEXT.slice(0, charsTyped);
  const isTyping = charsTyped > 0 && charsTyped < QUERY_TEXT.length;
  const queryDone = charsTyped >= QUERY_TEXT.length;

  // Graph highlights when query is submitted
  const highlightOp = interpolate(frame, [2.5 * fps, 3 * fps], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const highlightedMeetings = [1, 3, 5, 7];

  // Answer streams
  const answerStart = 3 * fps;
  const answerChars = Math.min(ANSWER_TEXT.length, Math.max(0, Math.floor((frame - answerStart) * 2)));
  const answerVisible = ANSWER_TEXT.slice(0, answerChars);

  // Platform labels
  const platformOp = interpolate(frame, [4.8 * fps, 5.3 * fps], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });

  // Closing line
  const closingOp = interpolate(frame, [5.2 * fps, 5.7 * fps], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });

  return (
    <AbsoluteFill>
      {/* Typing sounds */}
      {Array.from({ length: 10 }).map((_, i) => (
        <Sequence key={`t-${i}`} from={Math.round(typingStart + i * 3.5)} layout="none">
          <Audio src={staticFile("audio/typing-click.wav")} volume={0.12} />
        </Sequence>
      ))}
      {/* Burst on highlight */}
      <Sequence from={Math.round(2.5 * fps)} layout="none">
        <Audio src={staticFile("audio/burst.wav")} volume={0.25} />
      </Sequence>

      <StepHeader step={3} description="Access your knowledge through chat, MCPs, or your own tools" opacity={headerOp} />

      {/* Top: Mini graph */}
      <div style={{
        position: "absolute", top: 85, left: "50%",
        transform: "translateX(-50%) scale(0.6)",
        width: 1920, height: 500, opacity: graphOp,
      }}>
        <svg style={{ position: "absolute", inset: 0 }} viewBox="0 0 1920 500">
          {GRAPH_EDGES.map((edge, i) => {
            const fn = getNode(edge.from); const tn = getNode(edge.to);
            const fy = fn.y * 0.48; const ty = tn.y * 0.48;
            const isHL = highlightedMeetings.includes(edge.from) && highlightedMeetings.includes(edge.to);
            return (
              <line key={i} x1={fn.x} y1={fy} x2={tn.x} y2={ty}
                stroke={isHL ? accent[500] : text.secondary}
                strokeWidth={isHL ? 2 : 1}
                opacity={isHL ? highlightOp * 0.55 : 0.12}
              />
            );
          })}
        </svg>
        {MEETING_NODES.map((m) => {
          const isHL = highlightedMeetings.includes(m.id);
          return (
            <MeetingDot key={m.id} id={m.id} x={m.x} y={m.y * 0.48}
              opacity={isHL ? 0.4 + highlightOp * 0.6 : 0.25}
              scale={0.85}
              highlight={isHL && highlightOp > 0.5}
            />
          );
        })}
      </div>

      {/* Bottom: Chat */}
      <div style={{
        position: "absolute", bottom: 55, left: "50%", transform: "translateX(-50%)",
        width: 780,
      }}>
        {/* Input */}
        <div style={{
          background: bg.card, borderRadius: 12,
          border: `1px solid ${queryDone ? accent[500] + "40" : border.default}`,
          padding: "12px 18px", marginBottom: 14,
        }}>
          <span style={{
            fontFamily: fonts.body, fontSize: 14,
            color: charsTyped > 0 ? text.primary : text.placeholder,
          }}>
            {charsTyped > 0 ? queryVisible : "Ask your knowledge graph..."}
            {isTyping && (
              <span style={{
                display: "inline-block", width: 2, height: 16,
                background: accent[500], marginLeft: 2, verticalAlign: "text-bottom",
              }} />
            )}
          </span>
        </div>

        {/* Answer */}
        {answerChars > 0 && (
          <div style={{ background: bg.card, borderRadius: 12, border: `1px solid ${border.subtle}`, padding: "16px 20px" }}>
            <div style={{ fontFamily: fonts.body, fontSize: 13, color: text.body, lineHeight: 1.6 }}>
              {answerVisible}
              {answerChars < ANSWER_TEXT.length && (
                <span style={{
                  display: "inline-block", width: 5, height: 5, borderRadius: "50%",
                  background: accent[500], marginLeft: 3, verticalAlign: "middle",
                  opacity: Math.sin(frame * 0.3) > 0 ? 1 : 0.3,
                }} />
              )}
            </div>
            {answerChars > 200 && (
              <div style={{ display: "flex", gap: 6, marginTop: 10 }}>
                {["Meeting 3", "Meeting 7", "Meeting 10"].map((c, i) => (
                  <div key={i} style={{
                    fontFamily: fonts.body, fontSize: 10, fontWeight: 600, color: accent[500],
                    padding: "2px 9px", borderRadius: 5,
                    background: `${accent[500]}0D`, border: `1px solid ${accent[500]}20`,
                  }}>{c}</div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Platform labels */}
        <div style={{
          display: "flex", justifyContent: "center", gap: 20, marginTop: 14, opacity: platformOp,
        }}>
          {["Claude", "ChatGPT", "Slack", "API"].map((p, i) => (
            <span key={i} style={{
              fontFamily: fonts.body, fontSize: 11, fontWeight: 500, color: text.placeholder,
              padding: "3px 10px", borderRadius: 20,
              border: `1px solid ${border.subtle}`,
            }}>{p}</span>
          ))}
        </div>

        {/* Closing */}
        <div style={{ textAlign: "center", marginTop: 12, opacity: closingOp }}>
          <span style={{ fontFamily: fonts.body, fontSize: 15, fontStyle: "italic", color: text.secondary }}>
            One question. All your knowledge. Contextualised.
          </span>
        </div>
      </div>
    </AbsoluteFill>
  );
};

// ═══════════════════════════════════════════════════════════
// SCENE 6: Logo Hold (29–30s)
// ═══════════════════════════════════════════════════════════

const SceneLogo: React.FC = () => (
  <AbsoluteFill style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
    <FadeIn delay={0.1} duration={0.3}>
      <SynapseLogo size={64} />
    </FadeIn>
  </AbsoluteFill>
);

// ═══════════════════════════════════════════════════════════
// MAIN COMPOSITION
// ═══════════════════════════════════════════════════════════

export const KnowledgeCompounds: React.FC<Props> = () => {
  const { fps } = useVideoConfig();

  return (
    <LinkedInBackground>
      <Audio src={staticFile("audio/ambient-pad.wav")} volume={0.05} loop />

      {/* Scene 1: Transcript + Notes (0-8s) */}
      <Sequence from={0} durationInFrames={8 * fps} premountFor={fps}>
        <SceneTranscript />
      </Sequence>

      {/* Scene 2: Synapse brand intro (8-11s) */}
      <Sequence from={8 * fps} durationInFrames={3 * fps} premountFor={fps}>
        <SceneBrand />
      </Sequence>

      {/* Scene 3: Step 1 — entity extraction (11-18s) */}
      <Sequence from={11 * fps} durationInFrames={7 * fps} premountFor={fps}>
        <SceneStep1 />
      </Sequence>

      {/* Scene 4: Step 2 — cross-meeting connections (18-23s) */}
      <Sequence from={18 * fps} durationInFrames={5 * fps} premountFor={fps}>
        <SceneStep2 />
      </Sequence>

      {/* Scene 5: Step 3 — chat query (23-29s) */}
      <Sequence from={23 * fps} durationInFrames={6 * fps} premountFor={fps}>
        <SceneStep3 />
      </Sequence>

      {/* Scene 6: Logo hold (29-30s) */}
      <Sequence from={29 * fps} durationInFrames={1 * fps} premountFor={fps}>
        <SceneLogo />
      </Sequence>
    </LinkedInBackground>
  );
};
