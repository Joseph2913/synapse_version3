# Remotion Video Rules

Rules and specifications for all Synapse video compositions. Consult this file before creating or modifying any composition.

---

## Branding

### Logo Usage
- **Only use the Synapse flame mark** (`<SynapseLogo>`) for brand presence in videos. Never display a standalone text wordmark with a dot next to it.
- The `BrandDot` component must NEVER be used in any composition. It exists in the codebase but is deprecated for video use.
- When brand presence is needed, use the flame SVG logo only — no accompanying text unless it's part of a deliberate title/headline design.

### What NOT to do
- No generic "SYNAPSE" uppercase text with a colored dot beside it
- No small-font brand labels tucked into corners
- No watermark-style branding that looks like a template stamp

---

## Backgrounds — "Blend Into Feed" Approach

- **LinkedIn videos use `#f4f2ee`** (`bg.linkedIn`) — the exact LinkedIn feed background color. The video should feel like it's part of the feed, not sitting on top of it.
- **YouTube videos use `#ffffff`** — pure white to blend into YouTube's background.
- The background does nothing; all visual identity comes from content elements (typography, accent color, entity colors, logo).
- Do NOT use dark backgrounds for LinkedIn content unless specifically requested.
- Use the `<LinkedInBackground>` component for LinkedIn compositions.

---

## Typography

- **Cabinet Grotesk** (`fonts.display`) — all headlines, titles, large metrics, counters
- **DM Sans** (`fonts.body`) — body text, supporting text, labels, metadata
- **Instrument Serif** (`fonts.editorial`) — hook text, editorial moments, quotes, taglines
- Never use system fonts or fallback fonts in visible text
- Text on LinkedIn background uses dark colors (`text.primary`, `text.body`, `text.secondary`) — never white

---

## Colors

- Follow the Synapse design system tokens in `lib/tokens.ts`
- Blood orange (`#d63a00`) is the primary accent — use surgically, not everywhere
- Entity type colors are the primary chromatic elements — they provide visual variety against neutral backgrounds
- Accent color appears only on: key connection highlights, accent bars, the flame logo, important metrics
- Videos are predominantly neutral with color used functionally

---

## Audio

- Every visual event should have a corresponding sound cue
- **Node/entity appearances** → `node-pop.wav` (short digital pop)
- **Connections forming** → `connection.wav` (resonant chime)
- **Timeline/transitions** → `whoosh.wav` (gentle forward swoosh)
- **Connection bursts** → `burst.wav` (layered chime cluster)
- **Background** → `ambient-pad.wav` (subtle warm drone, looped, very quiet)
- Audio should enhance, not dominate — keep volumes subtle
- Videos must still tell their story on mute (LinkedIn autoplays without sound)

---

## Animations

- All animations driven by `useCurrentFrame()` — never CSS transitions or Tailwind animate classes
- Use the `<FadeIn>` primitive for consistent fade/slide timing
- Keep animations subtle and confident — no bouncy or playful motion
- Nodes and elements should feel like they're being placed deliberately, not thrown in
- Edge connections should draw themselves (dashoffset animation)

---

## Composition Structure (LinkedIn concept videos)

Standard scene flow for 30s concept videos:
1. **Hook** (0-4s) — Instrument Serif editorial text, centered, makes the viewer stop scrolling
2. **Setup** (4-8s) — Introduce the core visual concept
3. **Build** (8-16s) — Escalation, compounding, visual density increases
4. **Climax** (16-22s) — The peak moment, burst of activity, key insight revealed
5. **Payoff** (22-27s) — The "so what" — concrete takeaway text
6. **Logo** (27-30s) — Flame logo hold, clean exit
