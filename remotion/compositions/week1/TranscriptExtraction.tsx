import React from "react";
import { LinkedInTemplate } from "../../templates/LinkedInTemplate";
import { Headline } from "./components/Headline";
import { TranscriptCard } from "./components/TranscriptCard";
import { SummaryLine } from "./components/SummaryLine";
import { SignOff } from "./components/SignOff";
import { headline, transcriptLines, signOff } from "./data";

/**
 * Week 1 — "Transcript Extraction"
 *
 * 1080x1350 at 30fps, 300 frames (10 seconds).
 *
 * Animation choreography:
 *   Phase 1 (0-60):    Headline entrance
 *   Phase 2 (50-180):  Transcript card builds, lines stagger in
 *   Phase 3 (180-220): Highlights activate by type
 *   Phase 4 (225-260): Summary line
 *   Phase 5 (260-285): Sign-off
 *   Hold (285-300):    Static hold before loop
 */
export const TranscriptExtraction: React.FC = () => {
  // Phase 2: line entrance frames (staggered every 20 frames)
  const lineEnterFrames = [65, 90, 110, 130, 150];

  // Phase 3: highlight activation frames by type
  const highlightFrames: Record<string, number> = {
    entity: 180,
    insight: 190,
    decision: 200,
    action: 210,
  };

  return (
    <LinkedInTemplate>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          height: "100%",
          gap: 24,
        }}
      >
        {/* Phase 1: Headline */}
        <Headline
          line1={headline.line1}
          line2={headline.line2}
          line1Color={headline.line1Color}
          line2Color={headline.line2Color}
        />

        {/* Phase 2-3: Transcript card with highlights */}
        <TranscriptCard
          lines={transcriptLines}
          cardEnterFrame={50}
          lineEnterFrames={lineEnterFrames}
          highlightFrames={highlightFrames}
        />

        {/* Phase 4: Summary line */}
        <SummaryLine enterFrame={225} />

        {/* Phase 5: Sign-off */}
        <SignOff text={signOff} enterFrame={260} />
      </div>
    </LinkedInTemplate>
  );
};
