# Design Elevation Phase 2: Signature Components

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Elevate the signature visual components of Synapse from functional to premium. Graph nodes get ambient glow and richer fills. The Right Panel gets a glass effect with depth. The Home hero area gains visual presence. Typography gets refined with tabular numbers and weight variety.

**Architecture:** Canvas drawing upgrades for the graph renderer (raw 2D context calls). CSS-only for Right Panel, Home hero, and typography. No new dependencies. All changes use the warm-tinted design tokens added in Phase 1 (`--shadow-*`, `--ease-out-expo`).

**Tech Stack:** Canvas 2D API, CSS custom properties, Tailwind CSS v4

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `src/hooks/useGraphRenderer.ts` | Modify | Upgrade node glow, fills, edge rendering |
| `src/components/layout/RightPanel.tsx` | Modify | Add glass effect, depth layering, elevated header |
| `src/components/home/HomeView.tsx` | Modify | Elevate hero area with richer stats and visual presence |
| `src/index.css` | Modify | Add typography utilities, glass panel class, tabular nums |

---

### Task 1: Add Typography and Glass Utilities to index.css

**Files:**
- Modify: `src/index.css`

**What changes:** Add `font-variant-numeric: tabular-nums` utility for data displays, a `.glass-panel` utility class for frosted glass surfaces, and a `.text-display-tight` utility for headline tightening.

- [ ] **Step 1: Add utility classes after the button active-press rule**

In `src/index.css`, add these after the `button:active` / `[role="button"]:active` block (after line 190) and before `@keyframes spin`:

```css
/* Tabular numbers — prevents layout shift in data displays */
.tabular-nums {
  font-variant-numeric: tabular-nums;
}

/* Display text tightening — for large headings */
.text-display-tight {
  letter-spacing: -0.03em;
  line-height: 1.1;
}

/* Glass panel — frosted glass with inner refraction border */
.glass-panel {
  background: rgba(255, 255, 255, 0.82);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  border: 1px solid rgba(255, 255, 255, 0.6);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.4),
    inset 0 -1px 0 rgba(0, 0, 0, 0.02),
    0 4px 16px rgba(180, 89, 0, 0.03);
}

/* Glass panel header — slightly more opaque for readability */
.glass-panel-header {
  background: rgba(255, 255, 255, 0.92);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  border-bottom: 1px solid rgba(255, 255, 255, 0.5);
  box-shadow: 0 1px 3px rgba(180, 89, 0, 0.02);
}
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: Build succeeds.

- [ ] **Step 3: Commit**

```bash
git add src/index.css
git commit -m "feat: add tabular-nums, display-tight, and glass-panel utility classes"
```

---

### Task 2: Upgrade Graph Node Rendering

**Files:**
- Modify: `src/hooks/useGraphRenderer.ts`

**What changes:** Add ambient glow rings behind anchor nodes, richer fill gradients on hover, and improve edge rendering with varied opacity. The graph should feel like a living, breathing knowledge map rather than a flat network diagram.

This task modifies canvas drawing code. All drawing uses the 2D canvas context (`ctx`). The file is large (~1400 lines), so the edits target specific drawing functions.

- [ ] **Step 1: Add ambient glow to anchor node drawing**

Find the section that draws anchor nodes (search for the comment or the section where anchor circles are drawn with fill at 18% opacity). The current pattern for drawing an anchor node's main circle looks approximately like:

```typescript
// Fill circle
ctx.beginPath()
ctx.arc(x, y, r, 0, Math.PI * 2)
ctx.fillStyle = `${color}2E`  // ~18% opacity
ctx.fill()
```

Add a soft glow ring BEFORE the main circle fill. Insert this just before the main circle `beginPath()`:

```typescript
// Ambient glow ring
ctx.beginPath()
ctx.arc(x, y, r + 6, 0, Math.PI * 2)
ctx.fillStyle = `${color}0A`  // ~4% opacity outer glow
ctx.fill()
ctx.beginPath()
ctx.arc(x, y, r + 3, 0, Math.PI * 2)
ctx.fillStyle = `${color}0F`  // ~6% opacity inner glow
ctx.fill()
```

Note: The exact variable names for `x`, `y`, `r`, and `color` depend on how the renderer destructures node data. Read the file first to get the exact names. The glow should ONLY apply to anchor-type nodes and gravity anchor nodes, not to small entity/source nodes.

- [ ] **Step 2: Enhance hover fill intensity**

Find where the node fill opacity changes on hover. The current pattern is approximately:
- Default fill: `${color}2E` (~18%)
- Hover fill: `${color}47` (~28%)

Change hover fill to be slightly richer:
- Hover fill: `${color}3A` (~23%) — a bit more opaque but not as aggressive as 28%

Also add a subtle outer ring on hover. After the hover fill, add:
```typescript
if (isHovered) {
  ctx.beginPath()
  ctx.arc(x, y, r + 4, 0, Math.PI * 2)
  ctx.strokeStyle = `${color}15`  // ~8% opacity
  ctx.lineWidth = 1.5
  ctx.stroke()
}
```

- [ ] **Step 3: Improve edge opacity differentiation**

Find the `EDGE_COLORS` constant or the section where edge colors are defined. Current values:
```typescript
anchor:  { default: 'rgba(0,0,0,0.04)', hover: 'rgba(214,58,0,0.2)' }
source:  { default: 'rgba(0,0,0,0.12)', hover: 'rgba(0,0,0,0.35)' }
intra:   { default: 'rgba(0,0,0,0.06)', hover: 'rgba(0,0,0,0.18)' }
cross:   { default: 'rgba(214,58,0,0.08)', hover: 'rgba(214,58,0,0.3)' }
ghost:   { default: 'rgba(214,58,0,0.06)', hover: 'rgba(214,58,0,0.3)' }
```

Update to create more contrast between edge types:
```typescript
anchor:  { default: 'rgba(180,89,0,0.05)',  hover: 'rgba(214,58,0,0.25)' }
source:  { default: 'rgba(0,0,0,0.10)',     hover: 'rgba(0,0,0,0.30)' }
intra:   { default: 'rgba(0,0,0,0.05)',     hover: 'rgba(0,0,0,0.16)' }
cross:   { default: 'rgba(214,58,0,0.06)',  hover: 'rgba(214,58,0,0.25)' }
ghost:   { default: 'rgba(214,58,0,0.04)',  hover: 'rgba(214,58,0,0.20)' }
```

Key changes:
- Anchor edges warm-tinted (not pure black) at rest
- Source edges slightly less intense at rest (0.10 vs 0.12) for a cleaner look
- Cross edges slightly less intense at rest but brighter on hover
- Ghost edges more subtle at rest

- [ ] **Step 4: Verify build and visual result**

Run: `npm run build`
Run: `npm run dev` and navigate to Explore > Graph tab. Verify:
- Anchor nodes have soft dual-ring glow behind them
- Hover shows a subtle outer ring
- Edges have slightly different visual weight by type
- No performance regression (should still render smoothly at 500+ nodes)

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useGraphRenderer.ts
git commit -m "feat: add ambient glow to graph nodes and refine edge rendering"
```

---

### Task 3: Elevate Right Panel with Glass Effect

**Files:**
- Modify: `src/components/layout/RightPanel.tsx`

**What changes:** Apply the glass-panel utility to the Right Panel container. The panel should feel like a frosted glass surface floating over the content, not a flat white sidebar. Upgrade the header with the glass-panel-header class. Improve the resize handle visibility.

- [ ] **Step 1: Read the current RightPanel.tsx**

Read `src/components/layout/RightPanel.tsx` to understand the current structure. The panel is an `<aside>` element with:
- `background: var(--color-bg-card)`
- `border-left: 1px solid var(--border-subtle)`
- A header section with 50px height
- A scrollable content area

- [ ] **Step 2: Apply glass effect to the panel container**

Find the `<aside>` element's style. Replace:
```tsx
background: 'var(--color-bg-card)',
borderLeft: '1px solid var(--border-subtle)',
```

With (add the className and update style):
```tsx
// Add className="glass-panel" to the aside element
// Update style to:
background: undefined,  // handled by glass-panel class
borderLeft: undefined,  // handled by glass-panel class
```

Actually, since the panel uses inline styles heavily, the cleanest approach is to replace the background and border in the inline style:

Replace the aside's background and border-left with:
```tsx
background: 'rgba(255, 255, 255, 0.82)',
backdropFilter: 'blur(16px)',
WebkitBackdropFilter: 'blur(16px)',
borderLeft: '1px solid rgba(255, 255, 255, 0.6)',
boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.4), -4px 0 20px rgba(180,89,0,0.04)',
```

Note: The box-shadow includes the warm tinted shadow on the LEFT side (negative x-offset) since the panel is on the right edge.

- [ ] **Step 3: Upgrade the panel header**

Find the header div (the one with height: 50px and the title text). Update its style to add a slightly more opaque glass background:

Add to its existing style:
```tsx
background: 'rgba(255, 255, 255, 0.92)',
backdropFilter: 'blur(20px)',
WebkitBackdropFilter: 'blur(20px)',
borderBottom: '1px solid rgba(255,255,255,0.5)',
boxShadow: '0 1px 3px rgba(180,89,0,0.02)',
```

Replace its existing `borderBottom: '1px solid var(--border-subtle)'` with the new value above.

- [ ] **Step 4: Improve resize handle feedback**

Find the resize handle div (4px wide, absolute positioned on left edge). The current hover color is `rgba(214,58,0,0.18)`. Make it more discoverable:

Update the handle's style to include a default subtle indicator:
```tsx
background: dragging ? 'rgba(214,58,0,0.25)' : hovered ? 'rgba(214,58,0,0.18)' : 'rgba(0,0,0,0.03)',
```

(Currently it's `transparent` when not hovered. Change it to `rgba(0,0,0,0.03)` so there's always a faint line visible.)

Also update the handle's transition:
```tsx
transition: 'background 0.2s var(--ease-out-expo)',
```

- [ ] **Step 5: Verify build and visual result**

Run: `npm run build`
Run: `npm run dev`. Verify:
- Right Panel has a frosted glass appearance (content behind it blurs slightly)
- The header is slightly more opaque than the body
- A warm shadow is cast to the left of the panel
- The resize handle has a faint default indicator line
- Content inside the panel is fully readable
- The animation when opening/closing still works

- [ ] **Step 6: Commit**

```bash
git add src/components/layout/RightPanel.tsx
git commit -m "feat: apply glass effect to Right Panel with frosted backdrop and warm shadow"
```

---

### Task 4: Elevate Home Hero Area

**Files:**
- Modify: `src/components/home/HomeView.tsx`

**What changes:** Give the hero card more visual presence. The stats get tabular numbers. The greeting text gets tighter display tracking. Add a subtle inner glow to the hero card and warmer shadows. The stat icons get a warm tint instead of flat gray backgrounds.

- [ ] **Step 1: Read the hero section**

Read `src/components/home/HomeView.tsx` and find the hero card container — the outer div with `borderRadius: 14` and the `fadeUp` animation. It contains the greeting row and the source badges row.

- [ ] **Step 2: Upgrade hero card container**

Find the hero card's outer div style. Currently:
```tsx
style={{
  ...
  border: '1px solid var(--border-subtle)',
  borderRadius: 14,
  animation: 'fadeUp 0.4s ease both',
  ...
}}
```

Update to:
```tsx
style={{
  ...
  border: '1px solid var(--border-subtle)',
  borderRadius: 14,
  boxShadow: 'var(--shadow-md)',
  animation: 'fadeUp 0.4s var(--ease-out-expo) both',
  ...
}}
```

- [ ] **Step 3: Add tabular-nums to stat values**

Find the stat value spans (the large numbers showing source count, node count, anchor count, skill count). They currently use:
```tsx
style={{ fontSize: 16, fontWeight: 800, letterSpacing: '-0.02em', lineHeight: 1 }}
```

Add `fontVariantNumeric: 'tabular-nums'` to each stat value style:
```tsx
style={{ fontSize: 16, fontWeight: 800, letterSpacing: '-0.02em', lineHeight: 1, fontVariantNumeric: 'tabular-nums' }}
```

There are 4 stat values (sources, nodes, anchors, skills). Update all 4.

- [ ] **Step 4: Warm up stat icon backgrounds**

Find the stat icon containers (26x26px squares with `background: var(--color-bg-inset)`). Update each one:

Replace:
```tsx
background: 'var(--color-bg-inset)'
```

With:
```tsx
background: 'var(--color-accent-50)'
```

This gives the icon backgrounds a warm orange tint instead of flat gray, connecting them visually to the accent system.

Also update the icon color from `var(--color-text-secondary)` to `var(--color-accent-500)` for the stat icons.

- [ ] **Step 5: Tighten greeting typography**

Find the user name heading (the "Joseph." text). Currently:
```tsx
style={{ fontSize: 22, fontWeight: 800, letterSpacing: '-0.03em', lineHeight: 1.15 }}
```

Update to:
```tsx
style={{ fontSize: 24, fontWeight: 800, letterSpacing: '-0.035em', lineHeight: 1.1 }}
```

Slightly larger (22->24px), tighter tracking, tighter line-height.

- [ ] **Step 6: Verify build and visual result**

Run: `npm run build`
Run: `npm run dev`. Navigate to Home view. Verify:
- Hero card has a warm shadow (not flat)
- Stat numbers use tabular figures (digits are same width, no layout shift)
- Stat icons have warm orange backgrounds instead of gray
- The name text is slightly larger and tighter
- Animation uses the expo curve

- [ ] **Step 7: Commit**

```bash
git add src/components/home/HomeView.tsx
git commit -m "feat: elevate Home hero with warm shadows, tabular nums, and tighter typography"
```

---

### Task 5: Apply Tabular Numbers to Data-Heavy Components

**Files:**
- Modify: `src/components/layout/TopBar.tsx`
- Modify: `src/components/anchors/AnchorCard.tsx`
- Modify: `src/components/skills/SkillCard.tsx`

**What changes:** Add `fontVariantNumeric: 'tabular-nums'` to all number displays across the app. This prevents layout shift when numbers change and looks more polished in data-dense interfaces.

- [ ] **Step 1: TopBar node/edge counts**

In `src/components/layout/TopBar.tsx`, find the span that displays `{nodeCount.toLocaleString()} nodes · {edgeCount.toLocaleString()} edges`. Add `fontVariantNumeric: 'tabular-nums'` to its style.

- [ ] **Step 2: AnchorCard stat numbers**

In `src/components/anchors/AnchorCard.tsx`, find the stats row (the div with connection count, source count, edge count). Each stat value span has `fontWeight: 600`. Add `fontVariantNumeric: 'tabular-nums'` to each stat value span's style.

- [ ] **Step 3: SkillCard stat numbers**

In `src/components/skills/SkillCard.tsx`, find the stats row (source count, usage count, confidence percentage). Each stat value span has `fontWeight: 600`. Add `fontVariantNumeric: 'tabular-nums'` to each stat value span's style.

- [ ] **Step 4: Verify build**

Run: `npm run build`

- [ ] **Step 5: Commit**

```bash
git add src/components/layout/TopBar.tsx src/components/anchors/AnchorCard.tsx src/components/skills/SkillCard.tsx
git commit -m "feat: add tabular-nums to data displays across TopBar, AnchorCard, and SkillCard"
```

---

## Post-Implementation Verification

After all tasks are complete, do a full visual sweep:

1. **Explore > Graph** - Anchor nodes have ambient glow, edges have clearer differentiation, hover shows outer ring
2. **Right Panel** (open on any view) - Frosted glass effect, content behind blurs, warm shadow to the left, resize handle faintly visible
3. **Home view** - Hero card has depth, stats use tabular nums, icons have warm backgrounds, name text is tighter
4. **TopBar** - Node/edge counts use tabular nums (no width shifts when numbers change)
5. **Signals > Anchors/Skills** - Stat numbers use tabular nums
6. **Build** - Run `npm run build` to confirm no errors

## Out of Scope (Phase 3)

- Per-view motion choreography (staggered scroll reveals, entrance sequences)
- Framer-motion integration for spring physics
- Micro-interactions (magnetic buttons, cursor-aware card highlights)
- View-specific polish (Ask view, Automate view, Orient view)
- Dark mode preparation
