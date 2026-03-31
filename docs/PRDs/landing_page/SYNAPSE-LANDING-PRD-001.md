# PRD-LANDING-001: Synapse Landing Page — Hero + Problem Section

**Type:** Landing Page (separate from app shell)
**Route:** `/` (public, no auth required)
**Dependencies:** None (standalone page, not inside app routing)
**Complexity:** High
**Reference codebase:** https://github.com/Joseph2913/ALTICS2 (structural and animation patterns)

---

## 1. Objective

Build the first two sections of the Synapse public landing page: a full-viewport **Hero** section and a scroll-driven sticky **Problem Section** ("The Hidden Cost"). The page must feel like a premium, precisely engineered product — warm but precise, authoritative without being cold. The design takes direct structural inspiration from the ALTICS2 landing page but is fully re-skinned in Synapse's visual identity.

This file covers only the Hero and Problem sections. Navigation and footer are out of scope for this PRD.

---

## 2. File Structure

Create the following files. Do not modify any existing app files.

```
src/
  pages/
    Landing/
      index.jsx                        ← page entry, assembles sections
      Landing.css                      ← page-level layout tokens
  components/
    LandingHero/
      LandingHero.jsx
      LandingHero.css
      ParticleGraph.jsx                ← canvas background animation
    LandingProblem/
      LandingProblem.jsx
      LandingProblem.css
      StepRail.jsx
      TextPanel.jsx
      CardStack.jsx
      ProblemCard.jsx
      CounterBadge.jsx
      useProblemCycle.js
      cards/
        Card01WorkingMemory.jsx        ← SVG card illustration
        Card02SiloMap.jsx
        Card03ConversionPipeline.jsx
        Card04AgentContext.jsx
  hooks/
    useScrollProgress.js              ← scroll fraction within a ref element
    useIntersectionObserver.js        ← existing pattern, create if not present
```

---

## 3. Design Tokens (Landing Page Only)

These tokens apply only to the landing page. They do not override the app's existing design system.

```css
/* src/pages/Landing/Landing.css */
.landing-page {
  /* Colour — warm cream system */
  --lp-bg:               #F7F3EC;
  --lp-surface:          #FFFFFF;
  --lp-surface-tint:     #FDFBF7;
  --lp-text-primary:     #1A1612;
  --lp-text-secondary:   #7A7067;
  --lp-text-tertiary:    #B5AFA8;
  --lp-accent:           #E8622A;
  --lp-accent-light:     #FDF0EA;
  --lp-amber:            #D4A843;
  --lp-border:           rgba(26, 22, 18, 0.08);
  --lp-border-strong:    rgba(26, 22, 18, 0.16);
  --lp-orange-glow:      rgba(232, 98, 42, 0.15);

  /* Dark inversion — Problem section background */
  --lp-inv-bg:           #111008;
  --lp-inv-surface:      #1C1B14;
  --lp-inv-text:         #F0EDE6;

  /* Typography */
  --lp-font-display:     'Cabinet Grotesk', system-ui, sans-serif;
  --lp-font-body:        'DM Sans', system-ui, sans-serif;
  --lp-font-mono:        'JetBrains Mono', 'Courier New', monospace;

  /* Animation */
  --lp-ease-out:         cubic-bezier(0.16, 1, 0.3, 1);
  --lp-ease-spring:      cubic-bezier(0.34, 1.56, 0.64, 1);
  --lp-duration-normal:  400ms;
  --lp-duration-slow:    600ms;
  --lp-stagger:          80ms;

  /* Layout */
  --lp-max-width:        1280px;
  --lp-page-pad:         40px;
  --lp-page-pad-mobile:  20px;
  --lp-radius-card:      20px;
  --lp-radius-btn:       8px;
}
```

**Font loading** — add to `index.html` `<head>`:
```html
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link href="https://fonts.googleapis.com/css2?family=Cabinet+Grotesk:wght@500;700;800;900&family=DM+Sans:ital,wght@0,400;0,500;1,400&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet" />
```

---

## 4. Section A — Hero

### 4.1 Layout

- Full viewport: `min-height: 100vh`
- Background: `var(--lp-bg)` (#F7F3EC)
- Content centred horizontally, vertically centred with slight upward offset (`margin-bottom: 8vh`)
- `max-width: 820px` for text content
- `overflow: hidden` (contains canvas animation)
- On mobile (`< 768px`): `height: 200vh` with inner `position: sticky; top: 0; height: 100vh` — matches ALTICS2 pattern exactly

### 4.2 Layers (back to front)

**Layer 1 — Grain texture** (`z-index: 0`, `opacity: 0.03`)
SVG fractal noise overlay, same pattern as ALTICS2:
```css
background: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='300' height='300'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.65' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
background-size: 128px;
```

**Layer 2 — Radial glow** (`z-index: 1`, `pointer-events: none`)
Orange glow emanating from bottom-centre, breathing animation (6s ease-in-out infinite):
```css
background:
  radial-gradient(ellipse 65% 75% at 50% 100%,
    rgba(232,98,42,0.38) 0%, rgba(232,98,42,0.48) 15%,
    rgba(212,168,67,0.32) 30%, rgba(232,98,42,0.20) 48%,
    rgba(212,168,67,0.10) 62%, transparent 78%),
  radial-gradient(ellipse 35% 45% at 50% 100%,
    rgba(232,98,42,0.30) 0%, rgba(212,168,67,0.20) 35%, transparent 65%);
```

**Layer 3 — ParticleGraph canvas** (`z-index: 1`, `pointer-events: none`)
Canvas animation — see Section 4.3.

**Layer 4 — Content** (`z-index: 2`)

### 4.3 ParticleGraph Canvas Animation

Replace ALTICS2's `BinaryWave` (binary digit rain) with a force-directed particle graph that communicates Synapse's core metaphor (knowledge nodes connecting).

**Implementation — `ParticleGraph.jsx`:**

```
- Full-width, full-height canvas covering the hero section
- DPR-aware: canvas.width = window.innerWidth * devicePixelRatio
- ~60 nodes, each a small circle (radius 2–4px)
- Each node has: x, y, vx, vy (slow drift velocities, ~0.3–0.8px/frame)
- Colour: rgba(26,22,18,0.12) for nodes, rgba(26,22,18,0.06) for edges
- Edges drawn between nodes within 120px of each other
- Edge opacity scales inversely with distance: 0.06 at 120px, 0.14 at 30px
- Nodes bounce off edges with slight damping
- On requestAnimationFrame loop
- Mask: same elliptical radial gradient mask as ALTICS2 BinaryWave —
  mask-image: radial-gradient(ellipse 48% 32% at 50% 50%,
    transparent 65%, rgba(0,0,0,0.4) 78%,
    rgba(0,0,0,0.85) 92%, rgba(0,0,0,1) 100%)
  This makes the centre of the hero empty (no particles behind the headline)
  and particles fade to solid at the edges
- respects prefers-reduced-motion: return null if reduced motion
- Resize listener: recalculate canvas size and reinitialise nodes on resize
```

### 4.4 Hero Content

**Eyebrow label** — rendered before the headline:
```
— YOUR SECOND BRAIN
```
Style: `font-family: var(--lp-font-mono)`, `font-size: 11px`, `font-weight: 500`,
`letter-spacing: 0.08em`, `text-transform: uppercase`, `color: var(--lp-text-tertiary)`,
`margin-bottom: 20px`.
Entry animation: `fade-up 0.7s var(--lp-ease-out) 0.15s both`

**Headline** — two lines:
```
Line 1: "Your knowledge,
Line 2: finally connected."
```
The word `"connected"` is wrapped in `<em class="hero-accent">` — renders in `var(--lp-accent)` (#E8622A). No italic.

After `"connected."` — a small pulsing orange dot (same as ALTICS2 `signal-pulse` animation):
```jsx
<span className="hero-pulse-dot" />
```

Style: `font-family: var(--lp-font-display)`, `font-weight: 900`,
`font-size: clamp(40px, 4.8vw, 72px)`, `line-height: 1.06`, `letter-spacing: -0.03em`,
`color: var(--lp-text-primary)`.
Entry animation: `fade-up 0.7s var(--lp-ease-out) 0.25s both`

**Typewriter line** — sits on its own line below the headline:
```
Typewriter text: "Automatically. Permanently."
```
- `START_DELAY`: 1200ms (after page load)
- `CHAR_DELAY`: 55ms per character
- `CURSOR_LINGER`: 1800ms (cursor blinks then fades)
- Same cursor implementation as ALTICS2: inline 3px wide block, blink-cursor keyframe, cursor-fade keyframe
- Style: same as headline but `color: var(--lp-text-secondary)`, `font-weight: 700`,
  `font-size: clamp(28px, 3vw, 48px)`

**Subheading paragraph:**
```
"Synapse ingests your meetings, videos, documents, and notes —
extracts every entity and relationship — and builds a living knowledge
graph you can explore, query, and connect to any AI agent."
```
Style: `font-family: var(--lp-font-body)`, `font-size: 17px`, `line-height: 1.72`,
`color: var(--lp-text-secondary)`, `max-width: 580px`, `margin: 20px auto 0`.
Entry animation: `fade-up 0.7s var(--lp-ease-out) 0.35s both`

**CTA row** — two buttons, `margin-top: 44px`, `display: flex`, `gap: 12px`, centred:

Button 1 — Primary:
```
Label: "Join the waitlist →"
Style: background var(--lp-accent), color #fff, padding 14px 28px,
border-radius var(--lp-radius-btn), font-weight 500, font-size 14px,
box-shadow: 0 4px 16px rgba(232,98,42,0.30)
Hover: background #D45520, translateY(-2px), shadow intensifies
Arrow: separate <span> that translateX(3px) on hover
```

Button 2 — Secondary:
```
Label: "See how it works"
Style: background rgba(26,22,18,0.06), border 1px solid rgba(26,22,18,0.10),
color var(--lp-text-primary), same padding and radius
Hover: border-color rgba(26,22,18,0.20), background rgba(26,22,18,0.10)
```

Entry animation: `fade-up 0.7s var(--lp-ease-out) 0.45s both`

**Scroll hint** — `position: absolute; bottom: 48px; left: 50%; transform: translateX(-50%)`:
```
- Mouse icon: 24×38px rounded rectangle, 2px border rgba(26,22,18,0.20)
- Scroll wheel inside: 3px wide, 8px tall, orange, scroll-wheel animation
- Label below: "scroll to explore", 11px, letter-spacing 0.06em, tertiary colour
```
Entry animation: `fade-up 0.7s var(--lp-ease-out) 0.70s both`

### 4.5 Hero Keyframes

All keyframes identical to ALTICS2 animations.css. Define in `LandingHero.css`:

```css
@keyframes fade-up {
  from { opacity: 0; transform: translateY(24px); }
  to   { opacity: 1; transform: translateY(0); }
}
@keyframes blink-cursor {
  0%, 100% { opacity: 1; } 50% { opacity: 0; }
}
@keyframes cursor-fade {
  to { opacity: 0; }
}
@keyframes signal-pulse {
  0%, 100% { opacity: 1; transform: scale(1); box-shadow: 0 0 0 0 rgba(232,98,42,0.4); }
  50%       { opacity: 0.8; transform: scale(1.2); box-shadow: 0 0 0 8px rgba(232,98,42,0); }
}
@keyframes glow-breathe {
  0%, 100% { opacity: 1; } 50% { opacity: 0.7; }
}
@keyframes scroll-wheel {
  0%  { opacity: 1; transform: translateY(0); }
  40% { opacity: 1; transform: translateY(10px); }
  60% { opacity: 0; transform: translateY(10px); }
  61% { opacity: 0; transform: translateY(0); }
  80% { opacity: 1; transform: translateY(0); }
}
```

---

## 5. Section B — Problem Section ("The Hidden Cost")

### 5.1 Architecture Overview

This section is a **scroll-driven sticky experience**, identical in mechanism to the ALTICS2 ProblemSection. The outer wrapper is tall (`height: 300vh`) and the inner sticky container holds at `100vh`. As the user scrolls through the 300vh of scroll distance, a progress fraction (0→1) drives the active card index and per-step progress.

### 5.2 Scroll Mechanic — `useScrollProgress.js`

```js
// src/hooks/useScrollProgress.js
import { useState, useEffect, useCallback, useRef } from 'react';

export function useScrollProgress(ref) {
  const [progress, setProgress] = useState(0);

  const calculate = useCallback(() => {
    if (!ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    const totalScroll = ref.current.offsetHeight - window.innerHeight;
    const scrolled = -rect.top;
    setProgress(Math.max(0, Math.min(1, scrolled / totalScroll)));
  }, [ref]);

  useEffect(() => {
    window.addEventListener('scroll', calculate, { passive: true });
    calculate();
    return () => window.removeEventListener('scroll', calculate);
  }, [calculate]);

  return progress;
}
```

### 5.3 useProblemCycle.js

Derives `activeIndex` (0–3) and per-step `stepProgress` (0→1) from the raw scroll fraction.

```js
// src/components/LandingProblem/useProblemCycle.js
export default function useProblemCycle(scrollFraction, totalSteps = 4) {
  // Each step occupies 1/totalSteps of total scroll distance
  const stepSize = 1 / totalSteps;
  const raw = scrollFraction / stepSize;
  const activeIndex = Math.min(Math.floor(raw), totalSteps - 1);
  const stepProgress = raw - Math.floor(raw); // 0→1 within current step
  return { activeIndex, stepProgress };
}
```

### 5.4 LandingProblem.jsx — Outer Shell

```jsx
export default function LandingProblem() {
  const sectionRef = useRef(null);
  const scrollFraction = useScrollProgress(sectionRef);
  const { activeIndex, stepProgress } = useProblemCycle(scrollFraction);
  const [hasEntered, setHasEntered] = useState(false);

  // Mark entered once scrollFraction > 0
  useEffect(() => {
    if (scrollFraction > 0 && !hasEntered) setHasEntered(true);
  }, [scrollFraction, hasEntered]);

  return (
    <section ref={sectionRef} className="lp-problem-section">
      {/* Noise overlay */}
      <div className="lp-problem-noise" aria-hidden />

      <div className="lp-problem-sticky">
        <div className="lp-problem-container">

          {/* Column 1: StepRail (desktop only, 56px wide) */}
          <StepRail
            activeIndex={activeIndex}
            stepProgress={stepProgress}
            hasEntered={hasEntered}
          />

          {/* Column 2: Header + TextPanel */}
          <div className="lp-problem-left">
            {/* Section header — always visible */}
            <div className="lp-problem-header">
              <span className="lp-problem-eyebrow">— THE HIDDEN COST</span>
              <h2 className="lp-problem-headline">
                Silent losses. <em className="lp-accent">Real consequences.</em>
              </h2>
            </div>

            {/* Animated text panel */}
            <TextPanel activeIndex={activeIndex} hasEntered={hasEntered} />
          </div>

          {/* Column 3: Card stack (desktop only) */}
          <div className="lp-problem-cards-column">
            <CardStack activeIndex={activeIndex} hasEntered={hasEntered} />
          </div>

          {/* Mobile only: bottom counter badge */}
          <div className="lp-problem-bottom-counter">
            <CounterBadge
              activeIndex={activeIndex}
              progress={stepProgress}
            />
          </div>

        </div>
      </div>
    </section>
  );
}
```

### 5.5 LandingProblem.css

```css
.lp-problem-section {
  background-color: var(--lp-inv-bg);   /* #111008 */
  position: relative;
  height: 300vh;                         /* scroll travel distance */
}

.lp-problem-sticky {
  position: sticky;
  top: 0;
  height: 100vh;
  display: flex;
  align-items: stretch;
  overflow: hidden;
}

.lp-problem-noise {
  position: absolute; inset: 0;
  pointer-events: none;
  opacity: 0.025;
  background-image: url("data:image/svg+xml,..."); /* same SVG noise as Hero */
  z-index: 0;
}

.lp-problem-container {
  width: 100%;
  max-width: var(--lp-max-width);
  margin: 0 auto;
  padding: 110px var(--lp-page-pad) 48px;
  display: grid;
  grid-template-columns: 56px 1fr 1fr; /* rail | text | card */
  gap: 12px;
  position: relative;
  z-index: 10;
  height: 100%;
}

/* Section header */
.lp-problem-eyebrow {
  font-family: var(--lp-font-mono);
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--lp-text-secondary);
  display: block;
  margin-bottom: 12px;
}

.lp-problem-headline {
  font-family: var(--lp-font-display);
  font-weight: 900;
  font-size: clamp(28px, 3.5vw, 48px);
  line-height: 1.08;
  letter-spacing: -0.025em;
  color: var(--lp-inv-text);
  margin-bottom: 0;
}

.lp-problem-headline em {
  font-style: normal;
  color: var(--lp-accent);
}

.lp-problem-left {
  display: flex;
  flex-direction: column;
  gap: 32px;
  padding-top: 4px;
}

.lp-problem-cards-column {
  position: relative;
}

.lp-problem-bottom-counter {
  display: none; /* shown on mobile */
}

/* Responsive */
@media (max-width: 1279px) {
  .lp-problem-container {
    grid-template-columns: 56px 1fr;
  }
  .lp-problem-cards-column {
    display: none;
  }
  .lp-problem-section {
    height: 350vh;
  }
}

@media (max-width: 767px) {
  .lp-problem-container {
    grid-template-columns: 1fr;
    grid-template-rows: auto auto 1fr;
    padding: 90px var(--lp-page-pad-mobile) 32px;
  }
  .lp-problem-bottom-counter {
    display: flex;
    justify-content: center;
    margin-top: 24px;
  }
  .lp-problem-section {
    height: 400vh;
  }
}
```

### 5.6 StepRail.jsx

Left-side vertical navigation rail. Dots indicate position, fill animation shows per-step progress. Identical mechanism to ALTICS2 StepRail.

```
Props: { activeIndex: number, stepProgress: number, hasEntered: boolean }

Render:
- Vertical flex column, gap between dots is 44px
- A 1px vertical line runs behind all dots (rgba(240,237,230,0.12))
- 4 dots numbered 01–04
- Each dot: 15px × 15px circle
  - Inactive: border 1.5px solid rgba(240,237,230,0.15), fill transparent
  - Active: border 1.5px solid var(--lp-accent), fill var(--lp-accent)
  - Past: border 1.5px solid rgba(232,98,42,0.35), fill rgba(232,98,42,0.20)
- Number label below each dot:
  - Font: var(--lp-font-mono), 10px, letter-spacing 0.06em
  - Inactive: rgba(240,237,230,0.20)
  - Active: var(--lp-inv-text)
- Entry: dots stagger-fade-in when hasEntered becomes true
  (opacity 0 → 1, translateX(-8px) → 0, 400ms, stagger 60ms per dot)

No click navigation. The rail is display-only — scroll is the only driver.
```

### 5.7 CounterBadge.jsx

Used on mobile (and top-right of desktop view at `position: absolute; top: 24px; right: 0`).

```
Props: { activeIndex: number, progress: number }

Render:
- Container: flex row, gap 12px, backdrop rgba(28,27,20,0.60), blur 8px,
  border 1px solid rgba(240,237,230,0.08), border-radius 100px, padding 8px 16px

- SVG circle progress:
  radius = 14, circumference = 2π × 14 ≈ 87.96
  strokeDasharray = circumference
  strokeDashoffset = circumference × (1 - progress)
  Outer track circle: stroke rgba(240,237,230,0.12), stroke-width 2
  Progress arc: stroke var(--lp-accent), stroke-width 2, stroke-linecap round,
  transform-origin center, rotate(-90deg) so arc starts at top

- Pip dots row: 4 dots, 5px each
  Past/active: var(--lp-accent), inactive: rgba(240,237,230,0.15)

- Counter text: "02 / 04" format
  Font: var(--lp-font-mono), 12px, font-weight 500, letter-spacing 0.04em,
  color rgba(240,237,230,0.60)

- On desktop: position absolute top-right of lp-problem-cards-column,
  visible at all breakpoints ≥ 1280px
```

### 5.8 TextPanel.jsx

Left column below the section header. Cycles through problem data based on `activeIndex`.

**Problem data array:**

```js
const PROBLEMS = [
  {
    num: '/01',
    category: 'COGNITIVE LOAD',
    headline: 'The Thinking Tax',
    body: 'Your brain was built to think, not to remember. Every open loop you carry — the insight from that meeting, the pattern you noticed last month — is occupying compute that should be generating new thought. The cost isn\'t forgetting. It\'s the thinking that never happened.',
    cta: 'See how Synapse thinks →',
  },
  {
    num: '/02',
    category: 'KNOWLEDGE FRAGMENTATION',
    headline: 'The Missing Link',
    body: 'The raw material for your best thinking already exists — scattered across transcripts, documents, highlights, and recordings. A concept from six months ago that directly challenges your current strategy. Those links never form automatically. You\'re not missing information. You\'re missing infrastructure.',
    cta: 'See how Synapse connects →',
  },
  {
    num: '/03',
    category: 'KNOWLEDGE CONVERSION',
    headline: 'Input ≠ Understanding',
    body: 'You\'ve read it, watched it, highlighted it, noted it. But consuming knowledge and building knowledge are not the same thing. Information only becomes knowledge when it\'s connected, tested, and integrated into a structure that can be built upon. Storage isn\'t thinking.',
    cta: 'See how Synapse extracts →',
  },
  {
    num: '/04',
    category: 'AGENT INFRASTRUCTURE',
    headline: 'Every Session. Zero Memory.',
    body: 'Every AI conversation you have begins with amnesia. The context from last week, the pattern you noticed across three client calls, the framework you built over months — none of it is visible to the model. Every time a more capable model ships, a well-structured knowledge graph gets smarter automatically. The infrastructure compounds. The gap widens.',
    cta: 'See how Synapse feeds agents →',
  },
];
```

**Transition behaviour:**
- On `activeIndex` change: outgoing text fades down (`opacity 0 → 0, translateY(0 → -16px)`, 200ms)
  then incoming text fades up (`opacity 0 → 1, translateY(16px → 0)`, 400ms var(--lp-ease-out))
- Use a `displayIndex` state that updates after the exit transition completes
- Manage with `useEffect` watching `activeIndex`, a `isTransitioning` boolean, and a 220ms timeout

**Typography:**
- Category label: `var(--lp-font-mono)`, 11px, weight 500, letter-spacing 0.07em, uppercase,
  `color: var(--lp-accent)`, margin-bottom 10px
- Num prefix (`/01`): same as category label, shown inline before a `—` separator
- Headline: `var(--lp-font-display)`, weight 800, `clamp(22px, 2.2vw, 30px)`,
  letter-spacing -0.01em, `color: var(--lp-inv-text)`, margin-bottom 14px
- Body: `var(--lp-font-body)`, 15px, line-height 1.72, `color: rgba(240,237,230,0.65)`,
  max-width 52ch
- CTA link: `var(--lp-font-body)`, 13px, weight 600, `color: var(--lp-accent)`,
  letter-spacing 0.01em, cursor pointer, hover: text-decoration underline

### 5.9 CardStack.jsx + ProblemCard.jsx

Right column. Displays four cards in a stacked deck. The front card is the `activeIndex` card. Cards behind it are visible as offset layers.

**Card positioning states** — applied as `data-pos` attribute:

| State | Transform | Opacity | Filter |
|---|---|---|---|
| `front` | `translateY(0) scale(1)` | 1 | none |
| `behind-1` | `translateY(28px) scale(0.96)` | 0.55 | blur(0.5px) |
| `behind-2` | `translateY(52px) scale(0.93)` | 0.28 | blur(1px) |
| `exiting` | `translateY(-48px) scale(0.97)` | 0 | none |
| `hidden` | `translateY(52px) scale(0.93)` | 0 | none |

**Transition on change:** `transform 1.2s cubic-bezier(0.2, 0.8, 0.2, 1), opacity 1.2s ease-out, filter 1.2s ease-out`

**CardStack logic:**
- Render all 4 cards simultaneously using `position: absolute`
- Compute each card's `position` state based on its index relative to `activeIndex`:
  - `index === activeIndex` → `front`
  - `index === activeIndex + 1` → `behind-1`
  - `index === activeIndex + 2` → `behind-2`
  - `index === activeIndex - 1` on transition-out → `exiting`
  - All others → `hidden`
- Cards do not respond to click on mobile (scroll-only)
- Container: `position: relative; width: 100%; height: calc(100vh - 200px)`

**ProblemCard.jsx wrapper:**
Each card is `position: absolute; top: 0; right: 0; width: 100%; height: calc(100% - 60px)`.

Card base style:
```css
background: var(--lp-inv-surface);      /* #1C1B14 */
border: 1px solid rgba(232,98,42,0.08);
border-radius: var(--lp-radius-card);   /* 20px */
display: flex;
flex-direction: column;
padding: 24px;
overflow: hidden;
```

Card inner structure:
```
┌──────────────────────────────────────┐
│ [icon 32×32]  /01                    │
│               Card Title             │
│               Card subtitle          │
├──────────────────────────────────────┤
│                                      │
│   SVG Illustration                   │
│   (fills remaining height)           │
│                                      │
└──────────────────────────────────────┘
```

Header: `display: flex; gap: 14px; margin-bottom: 20px; flex-shrink: 0`
Icon box: `32×32, border-radius 8px, background rgba(232,98,42,0.18)`
Num: `var(--lp-font-mono), 10px, color var(--lp-accent), letter-spacing 0.06em`
Title: `var(--lp-font-display), 14px, weight 700, color var(--lp-inv-text)`
Subtitle: `var(--lp-font-mono), 9px, color rgba(240,237,230,0.40), margin-top 2px`

SVG area: `flex: 1; position: relative; overflow: hidden`

### 5.10 SVG Card Illustrations

Each card in `cards/` renders an inline SVG illustration matching the designs established in the mockup session. No footer bar. Pure dark-surface data visualisation.

---

#### Card01WorkingMemory.jsx

**Title:** Working Memory Drain
**Subtitle:** Active cognitive load — current session

```
SVG structure (viewBox="0 0 460 300"):

Background: rect fill="#1C1B14" rounded 12px

WORKING_MEMORY label (top-left, mono 10px, #6B6560)
⚠ NEAR LIMIT badge (top-right): orange pill, mono 9px

Progress bar:
  Track: rect fill rgba(255,255,255,0.06), height 10px, rx 5, full width
  Fill:  rect fill #E8622A, width 94%, rx 5

"94% capacity used" text in orange, centred below bar

Divider line

OPEN_LOOPS label

4 loop rows, each row:
  - Left dot (circle r5):
    Row 01: fill #E8622A, opacity 1.0
    Row 02: fill #E8622A, opacity 0.55
    Row 03: fill #E8622A, opacity 0.35
    Row 04: fill #2A2820 (near-invisible)
  - Text label (mono 10.5px):
    Row 01: #B5AFA8  "Follow up with Sarah re: Q2 strategy"
    Row 02: #857D78  "Framework from Thursday's call"
    Row 03: #6B6560  "Insight: pricing model pattern"
    Row 04: #3A3830  "3 more items suppressed..." (italic)
  - Status badge (right):
    Row 01: orange pill  UNRESOLVED
    Row 02: muted pill   FADING
    Row 03: muted pill   AT RISK
    Row 04: dark pill    OVERFLOW
  - Divider line between rows: rgba(255,255,255,0.05)

Bottom stats row:
  Left:  "AVAILABLE_COMPUTE: 6%"   mono 10px orange
  Right: "LAST_OFFLOADED: NEVER"   mono 10px orange
```

---

#### Card02SiloMap.jsx

**Title:** Knowledge Silo Map
**Subtitle:** Cross-source relationship density — current state

Simplified from original mockup — no complex cluster groupings. Just scattered individual nodes with zero connections.

```
SVG structure (viewBox="0 0 460 300"):

Background: rect fill="#1C1B14" rounded 12px

Label "KNOWLEDGE_GRAPH" top-left, mono 10px muted
Badge "TOPOLOGY_VIEW" top-right, orange pill

8–10 labelled nodes scattered across the SVG:
  Each node: circle r8, fill #1C1B14, stroke rgba(122,112,103,0.3), stroke-width 1.5
  Label below each: mono 8px, fill #4A4540, text-anchor middle
  Node labels: Q2_STRATEGY, COMPETITOR_REPORT, BOARD_MEETING_NOV,
               MARKET_RESEARCH, PODCAST_TRANSCRIPT, CLIENT_CALL_FEB,
               FRAMEWORK_DOC, INVESTOR_UPDATE, WEEKLY_NOTES

No edges between any nodes.
Zero connecting lines.
The emptiness is the visual.

Single text line centred at bottom of SVG area:
  "CONNECTIONS: 0" — mono 12px, fill #E8622A
  "ISOLATED_NODES: 9" — mono 10px, fill #4A4540

Subtle: one dashed arc between Q2_STRATEGY node and CLIENT_CALL_FEB,
  stroke #E8622A, stroke-dasharray 4 4, opacity 0.3, no arrowhead
  Label midpoint: "?" text, 10px, fill #E8622A, opacity 0.5
  This hints at the connection that exists but was never made
```

---

#### Card03ConversionPipeline.jsx

**Title:** Knowledge Conversion Pipeline
**Subtitle:** Content ingested vs. structured knowledge extracted

Simplified — no funnel graphic. Pure number contrast.

```
SVG structure (viewBox="0 0 460 300"):

Background: rect fill="#1C1B14" rounded 12px

Left half (x: 0–220):
  Label: "CONSUMED" mono 10px muted, top-left
  Big number: "847"
    font-family Cabinet Grotesk (or via SVG text with font-weight 800)
    font-size 72, fill #F0EDE6, letter-spacing -0.03em
    positioned at y~120
  Sub-label: "items this month" mono 9px #4A4540

  Breakdown list below (mono 10px, left-aligned):
    VIDEOS       34
    DOCUMENTS    12
    MEETINGS     28
    ARTICLES     61
    HIGHLIGHTS  712
  Each row: left label in #4A4540, right value in #7A7067
  Thin divider line above the list

Right half (x: 240–460):
  Vertical divider at x=230: rgba(255,255,255,0.07)

  Label: "RETAINED" mono 10px, color #3A3428 (near invisible)
  Big number: "3"
    font-size 72, fill #2A2820 (near-invisible dark)
    Same position as left "847"
  Sub-label: "items structured" mono 9px #2A2820

  CONVERSION_RATE label: mono 10px #4A4540
  Value: "0.4%" — Syne/Cabinet Grotesk 36px, fill #E8622A, weight 800

The visual contrast between bright #F0EDE6 "847" and dark #2A2820 "3"
makes the argument without any annotation.
```

---

#### Card04AgentContext.jsx

**Title:** Agent Context Initialisation
**Subtitle:** Knowledge available to AI — session start

No solution side. Problem only: three repeating zero-state sessions.

```
SVG structure (viewBox="0 0 460 300"):

Background: rect fill="#1C1B14" rounded 12px

Label "SESSION_HISTORY" top-left, mono 10px muted

Three session blocks stacked vertically, equal height, separated by
thin dividers (rgba(255,255,255,0.05)):

Each session block (height ~72px):
  Left: session label "SESSION_01", "SESSION_02", "SESSION_03"
        mono 9px, fill #3A3428 (oldest = darkest/most invisible)
        Session 01: #4A4540, Session 02: #3A3428, Session 03: #2A2820

  Right side: data readout columns
    CONTEXT:    NULL
    ENTITIES:   0
    HISTORY:    NONE
    Each label in #3A3428 mono 9px, each value in matching or darker tone
    Session 01 values slightly more visible (#4A4540)
    Session 02 values near invisible (#2A2820)
    Session 03 values completely invisible (#1C1B14 — same as bg)
    → Communicates that the further back you go, the more it vanishes

Bottom:
  "MEMORY_PERSISTENCE: NONE" — mono 10px, fill #E8622A
  "SESSIONS_LOGGED: 0" — mono 10px, fill #4A4540

Visual intent: three rows of the exact same empty data.
The repetition communicates the Groundhog Day loop.
Each session is visually fainter than the last — they don't even accumulate.
```

---

## 6. Entry Animations (Intersection Observer)

### 6.1 useIntersectionObserver.js

```js
import { useEffect, useRef, useState } from 'react';

export function useIntersectionObserver(threshold = 0.15) {
  const ref = useRef(null);
  const [isIntersecting, setIsIntersecting] = useState(false);

  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setIsIntersecting(true);
          observer.disconnect(); // fire once only
        }
      },
      { threshold }
    );
    if (ref.current) observer.observe(ref.current);
    return () => observer.disconnect();
  }, [threshold]);

  return [ref, isIntersecting];
}
```

### 6.2 Reveal Pattern

Elements that should animate on scroll entry use the `.lp-reveal` / `.lp-reveal.is-visible` pattern:

```css
.lp-reveal {
  opacity: 0;
  transform: translateY(20px);
}
.lp-reveal.is-visible {
  opacity: 1;
  transform: translateY(0);
  transition: opacity 400ms var(--lp-ease-out), transform 400ms var(--lp-ease-out);
}
.lp-reveal-group .lp-reveal:nth-child(1) { transition-delay: 0ms; }
.lp-reveal-group .lp-reveal:nth-child(2) { transition-delay: 80ms; }
.lp-reveal-group .lp-reveal:nth-child(3) { transition-delay: 160ms; }
.lp-reveal-group .lp-reveal:nth-child(4) { transition-delay: 240ms; }
```

Apply to: section headers, StepRail dots (on `hasEntered`), TextPanel on first render.

---

## 7. Page Assembly — Landing/index.jsx

```jsx
import LandingHero from '../../components/LandingHero/LandingHero';
import LandingProblem from '../../components/LandingProblem/LandingProblem';
import './Landing.css';

export default function Landing() {
  return (
    <div className="landing-page">
      <LandingHero />
      <LandingProblem />
    </div>
  );
}
```

Register the route in App.jsx or router:
```jsx
<Route path="/landing" element={<Landing />} />
// or make it the root if this is a standalone marketing page:
<Route index element={<Landing />} />
```

---

## 8. Accessibility

- All animations: respect `@media (prefers-reduced-motion: reduce)` — disable all transitions and keyframes, set opacity 1, transform none
- Canvas animations (ParticleGraph): `return null` when reduced motion preference detected
- Typewriter: skip immediately to full text when reduced motion is on
- All interactive elements have appropriate ARIA labels
- Section headings use semantic `<h2>` tags
- Cards are not keyboard-focusable (decorative, scroll-driven only)

---

## 9. Performance

- `ParticleGraph` canvas: throttle to 60fps with `requestAnimationFrame`, cancel on unmount
- `useScrollProgress`: passive scroll listener only
- All images/SVGs inlined — no external image requests
- Fonts: `display=swap` on Google Fonts import
- Card SVGs: pure inline SVG, no external assets

---

## 10. Acceptance Criteria

After completing this PRD, the following must be true:

1. Navigating to the landing page route shows the hero section full-viewport on first load
2. The ParticleGraph canvas renders scattered nodes and edges that avoid the centre of the headline text (masked)
3. The hero headline typewriter animation fires automatically ~1.2s after page load
4. The hero CTA primary button renders in blood orange with hover lift and shadow intensification
5. Scrolling past the hero enters the Problem section which transitions from cream to dark (#111008) background
6. The Problem section is sticky — inner content does not scroll; the outer wrapper scrolls
7. Scrolling through the Problem section cycles through all 4 problem statements in TextPanel
8. The StepRail left-side dot corresponding to the active step is filled orange; completed dots are dim orange; future dots are outline only
9. The CounterBadge SVG circle arc fills from 0° to 360° as the user scrolls through each step
10. The active ProblemCard is at `data-pos="front"` with full opacity; the card behind it is visible at reduced opacity and translated down
11. Card transitions are smooth (1.2s cubic-bezier) — no jump cuts
12. On mobile (< 768px): card stack is hidden, TextPanel shows full content, CounterBadge shows at bottom
13. All entry animations respect `prefers-reduced-motion`
14. No console errors on mount or scroll
15. Page renders correctly at 375px, 768px, 1280px, and 1440px viewport widths

---

## 11. Out of Scope for This PRD

- Navigation bar
- Any section below the Problem section (features, how it works, CTA band, footer)
- Waitlist form functionality (button renders but `onClick` is a no-op for now)
- Mobile-specific card alternative view
- Analytics / event tracking
