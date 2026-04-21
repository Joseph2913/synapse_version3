/**
 * Synapse Font Loading for Remotion
 *
 * Loads all three Synapse fonts so they're available in every composition.
 * Import this module at the top of any composition that renders text.
 *
 * - Cabinet Grotesk: loaded locally from public/fonts/ (Fontshare)
 * - DM Sans: loaded via @remotion/google-fonts
 * - Instrument Serif: loaded via @remotion/google-fonts
 */

import { loadFont as loadLocalFont } from "@remotion/fonts";
import { loadFont as loadDMSans } from "@remotion/google-fonts/DMSans";
import { loadFont as loadJetBrainsMono } from "@remotion/google-fonts/JetBrainsMono";
import { loadFont as loadInstrumentSerif } from "@remotion/google-fonts/InstrumentSerif";
import { staticFile } from "remotion";

// ── Cabinet Grotesk (local, from Fontshare) ──────────────────
// Display font — headings, titles, large metrics, logo wordmark

const cabinetGrotesk = Promise.all([
  loadLocalFont({
    family: "Cabinet Grotesk",
    url: staticFile("fonts/CabinetGrotesk-Regular.woff2"),
    weight: "400",
    style: "normal",
  }),
  loadLocalFont({
    family: "Cabinet Grotesk",
    url: staticFile("fonts/CabinetGrotesk-Medium.woff2"),
    weight: "500",
    style: "normal",
  }),
  loadLocalFont({
    family: "Cabinet Grotesk",
    url: staticFile("fonts/CabinetGrotesk-Bold.woff2"),
    weight: "700",
    style: "normal",
  }),
  loadLocalFont({
    family: "Cabinet Grotesk",
    url: staticFile("fonts/CabinetGrotesk-ExtraBold.woff2"),
    weight: "800",
    style: "normal",
  }),
]);

// ── DM Sans (Google Fonts) ───────────────────────────────────
// Body / UI font — body text, labels, metadata, supporting text

const { fontFamily: dmSansFamily } = loadDMSans("normal", {
  weights: ["400", "500", "600", "700"],
  subsets: ["latin"],
});

// ── JetBrains Mono (Google Fonts) ────────────────────────────
// Monospace font — transcript text, code-comment summaries

const { fontFamily: jetBrainsMonoFamily } = loadJetBrainsMono("normal", {
  weights: ["400", "500", "600"],
  subsets: ["latin"],
});

// ── Instrument Serif (Google Fonts) ──────────────────────────
// Editorial font — taglines, quotes, special display moments

const { fontFamily: instrumentSerifFamily } = loadInstrumentSerif("normal", {
  weights: ["400"],
  subsets: ["latin"],
});

// ── Exported font family strings ─────────────────────────────
// Use these in style={{ fontFamily }} on your components

export const fonts = {
  /** Cabinet Grotesk — display/headlines. Weights: 400, 500, 700, 800 */
  display: "'Cabinet Grotesk', -apple-system, sans-serif",
  /** DM Sans — body/UI text. Weights: 400, 500, 600, 700 */
  body: dmSansFamily,
  /** JetBrains Mono — transcript text, code comments. Weights: 400, 500, 600 */
  mono: jetBrainsMonoFamily,
  /** Instrument Serif — editorial/quotes. Weight: 400 */
  editorial: instrumentSerifFamily,
} as const;

// Re-export the loading promise so compositions can await if needed
export const fontsReady = cabinetGrotesk;
