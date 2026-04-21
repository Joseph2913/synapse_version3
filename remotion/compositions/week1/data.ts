export const headline = {
  line1: "What does your AI see when it reads",
  line2: "your meeting transcript?",
  line1Color: "#1a1a1a",
  line2Color: "#d63a00",
};

export type Highlight = {
  phrase: string;
  type: "entity" | "insight" | "decision" | "action";
  color: string;
};

export type TranscriptLineData = {
  timestamp: string;
  speaker: string;
  speakerColor: string;
  text: string;
  highlights: Highlight[];
};

export const transcriptLines: TranscriptLineData[] = [
  {
    timestamp: "10:02",
    speaker: "Sarah K.",
    speakerColor: "#0891b2",
    text: "Before we go further on {Project Atlas}, I want to flag something. The {onboarding conversion rate dropped 12%} after the last release.",
    highlights: [
      { phrase: "Project Atlas", type: "entity", color: "#0891b2" },
      {
        phrase: "onboarding conversion rate dropped 12%",
        type: "insight",
        color: "#7c3aed",
      },
    ],
  },
  {
    timestamp: "10:03",
    speaker: "Mark D.",
    speakerColor: "#d97706",
    text: "That tracks with what James's team found in the UX audit. The new flow has three extra steps. I think {we should revert to the v2 onboarding until we fix it}.",
    highlights: [
      {
        phrase: "we should revert to the v2 onboarding until we fix it",
        type: "decision",
        color: "#db2777",
      },
    ],
  },
  {
    timestamp: "10:04",
    speaker: "Sarah K.",
    speakerColor: "#0891b2",
    text: "Agreed. Mark, can you {coordinate the rollback with engineering by Friday}?",
    highlights: [
      {
        phrase: "coordinate the rollback with engineering by Friday",
        type: "action",
        color: "#2563eb",
      },
    ],
  },
  {
    timestamp: "10:04",
    speaker: "Priya R.",
    speakerColor: "#059669",
    text: "Just to add \u2014 {this is the third time onboarding changes have caused a dip}. We might need a dedicated onboarding squad rather than patching each time.",
    highlights: [
      {
        phrase: "this is the third time onboarding changes have caused a dip",
        type: "insight",
        color: "#7c3aed",
      },
    ],
  },
  {
    timestamp: "10:05",
    speaker: "Mark D.",
    speakerColor: "#d97706",
    text: "That's a good point. {Let's add that to the Q3 planning agenda}. I'll draft a proposal.",
    highlights: [
      {
        phrase: "Let's add that to the Q3 planning agenda",
        type: "decision",
        color: "#db2777",
      },
    ],
  },
];

export const summaryLine = {
  prefix: "// In just 47 seconds",
  separator: "\u2014",
  counts: [
    { number: "3", label: "entities", color: "#0891b2" },
    { number: "2", label: "decisions", color: "#db2777" },
    { number: "2", label: "insights", color: "#7c3aed" },
    { number: "1", label: "action", color: "#2563eb" },
  ],
};

export const signOff = "Stay tuned for more.";
