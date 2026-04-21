# Design Elevation Phase 3A: Spotlight Cards + Spring Motion

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every card in Synapse glow under the cursor with a spotlight border effect, and replace all static fadeUp animations with spring-physics staggered entry using framer-motion.

**Architecture:** A reusable `useSpotlight` hook tracks mouse position relative to any card and renders a radial gradient glow on the border via a CSS pseudo-element overlay. Framer-motion provides spring-based `motion.div` wrappers with `staggerChildren` for list entry animations. Both are opt-in via wrapper components so existing cards don't need structural rewrites.

**Tech Stack:** framer-motion (new dependency), CSS custom properties, React hooks

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `src/hooks/useSpotlight.ts` | Create | Mouse-tracking hook returning event handlers + spotlight style |
| `src/components/ui/SpotlightCard.tsx` | Create | Reusable card wrapper that applies spotlight border effect |
| `src/components/ui/StaggerList.tsx` | Create | Reusable motion container for staggered spring entry |
| `src/components/anchors/AnchorCard.tsx` | Modify | Wrap in SpotlightCard |
| `src/components/skills/SkillCard.tsx` | Modify | Wrap in SpotlightCard |
| `src/components/home/FeedCard.tsx` | Modify | Wrap in SpotlightCard |
| `src/views/CouncilView.tsx` | Modify | Wrap AdvisorCard in SpotlightCard, wrap list in StaggerList |
| `src/views/SignalsView.tsx` | Modify | Wrap card lists in StaggerList |
| `src/components/home/HomeView.tsx` | Modify | Wrap council + recent sources lists in StaggerList |

---

### Task 1: Install framer-motion

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install framer-motion**

```bash
npm install framer-motion
```

- [ ] **Step 2: Verify build still works**

Run: `npm run build`
Expected: Build succeeds. framer-motion is a standard npm package, no config needed.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "feat: install framer-motion for spring-physics animations"
```

---

### Task 2: Create useSpotlight Hook

**Files:**
- Create: `src/hooks/useSpotlight.ts`

**What this does:** Tracks the mouse position relative to an element and returns:
- `onMouseMove` handler to update position
- `onMouseEnter` / `onMouseLeave` handlers to show/hide the effect
- A CSS style object for the spotlight overlay

The spotlight is a radial gradient positioned at the cursor that creates a glow on the card border. It uses a `::before` pseudo-element approach via inline styles on an overlay div.

- [ ] **Step 1: Create the hook file**

Create `src/hooks/useSpotlight.ts`:

```typescript
import { useState, useCallback, useRef } from 'react'

interface SpotlightStyle {
  position: 'absolute' as const
  inset: number
  borderRadius: 'inherit' as const
  pointerEvents: 'none' as const
  opacity: number
  transition: string
  background: string
  mask: string
  WebkitMask: string
}

interface UseSpotlightReturn {
  spotlightRef: React.RefObject<HTMLDivElement | null>
  spotlightStyle: SpotlightStyle
  handlers: {
    onMouseMove: (e: React.MouseEvent) => void
    onMouseEnter: () => void
    onMouseLeave: () => void
  }
}

export function useSpotlight(
  color: string = 'rgba(214, 58, 0, 0.35)',
  radius: number = 180
): UseSpotlightReturn {
  const spotlightRef = useRef<HTMLDivElement | null>(null)
  const [active, setActive] = useState(false)
  const [position, setPosition] = useState({ x: 0, y: 0 })

  const onMouseMove = useCallback((e: React.MouseEvent) => {
    const el = e.currentTarget as HTMLElement
    const rect = el.getBoundingClientRect()
    setPosition({
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    })
  }, [])

  const onMouseEnter = useCallback(() => setActive(true), [])
  const onMouseLeave = useCallback(() => setActive(false), [])

  const spotlightStyle: SpotlightStyle = {
    position: 'absolute',
    inset: -1,
    borderRadius: 'inherit',
    pointerEvents: 'none',
    opacity: active ? 1 : 0,
    transition: 'opacity 0.3s var(--ease-out-expo)',
    background: `radial-gradient(${radius}px circle at ${position.x}px ${position.y}px, ${color}, transparent 70%)`,
    mask: 'linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0)',
    WebkitMask: 'linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0)',
  }

  return {
    spotlightRef,
    spotlightStyle,
    handlers: { onMouseMove, onMouseEnter, onMouseLeave },
  }
}
```

**How the mask trick works:** The spotlight gradient covers the full card area, but the CSS mask with `content-box` + a second layer creates a "border-only" mask. The gradient is only visible in the border/padding area, not the content. This creates the effect of a glowing border that follows the cursor.

However, for this to work properly, the mask needs `mask-composite: exclude` and padding on the overlay. A simpler and more reliable approach is to use the overlay div with a `border-image` or just show the gradient as a subtle full-card wash with higher opacity at the edges. Let me use the simpler approach:

Actually, the cleanest approach for a border glow: render the gradient on the overlay div, and use a CSS mask that excludes the inner area. This is the standard spotlight border technique:

```
mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
-webkit-mask-composite: xor;
mask-composite: exclude;
padding: 1px;  /* This defines the "border" width that shows through */
```

Update the style to include these mask-composite properties and a padding value.

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: Build succeeds (the hook is just created, not imported anywhere yet).

- [ ] **Step 3: Commit**

```bash
git add src/hooks/useSpotlight.ts
git commit -m "feat: create useSpotlight hook for cursor-tracking border glow"
```

---

### Task 3: Create SpotlightCard Component

**Files:**
- Create: `src/components/ui/SpotlightCard.tsx`

**What this does:** A wrapper component that adds the spotlight border effect to any card. It wraps children in a `position: relative` container and renders the spotlight overlay div on top. Cards opt in by replacing their outer `<div>` with `<SpotlightCard>`.

- [ ] **Step 1: Create the component**

Create `src/components/ui/SpotlightCard.tsx`:

```tsx
import { useRef, useState, useCallback } from 'react'

interface SpotlightCardProps {
  children: React.ReactNode
  color?: string
  radius?: number
  borderWidth?: number
  className?: string
  style?: React.CSSProperties
  onClick?: (e: React.MouseEvent) => void
  onMouseEnter?: (e: React.MouseEvent) => void
  onMouseLeave?: (e: React.MouseEvent) => void
}

export function SpotlightCard({
  children,
  color = 'rgba(214, 58, 0, 0.4)',
  radius = 200,
  borderWidth = 1,
  className,
  style,
  onClick,
  onMouseEnter: externalMouseEnter,
  onMouseLeave: externalMouseLeave,
}: SpotlightCardProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [active, setActive] = useState(false)
  const [pos, setPos] = useState({ x: 0, y: 0 })

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    const el = containerRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    setPos({ x: e.clientX - rect.left, y: e.clientY - rect.top })
  }, [])

  const handleMouseEnter = useCallback((e: React.MouseEvent) => {
    setActive(true)
    externalMouseEnter?.(e)
  }, [externalMouseEnter])

  const handleMouseLeave = useCallback((e: React.MouseEvent) => {
    setActive(false)
    externalMouseLeave?.(e)
  }, [externalMouseLeave])

  return (
    <div
      ref={containerRef}
      className={className}
      style={{ ...style, position: 'relative', overflow: 'hidden' }}
      onClick={onClick}
      onMouseMove={handleMouseMove}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {children}
      {/* Spotlight overlay — border-only glow that follows cursor */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          borderRadius: 'inherit',
          pointerEvents: 'none',
          opacity: active ? 1 : 0,
          transition: 'opacity 0.3s var(--ease-out-expo)',
          background: `radial-gradient(${radius}px circle at ${pos.x}px ${pos.y}px, ${color}, transparent 65%)`,
          WebkitMaskImage: `radial-gradient(${radius}px circle at ${pos.x}px ${pos.y}px, black 0%, transparent 70%)`,
          maskImage: `radial-gradient(${radius}px circle at ${pos.x}px ${pos.y}px, black 0%, transparent 70%)`,
          padding: borderWidth,
          WebkitMask: 'linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0)',
          mask: 'linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0)',
          WebkitMaskComposite: 'xor',
          maskComposite: 'exclude',
        }}
      />
    </div>
  )
}
```

**Key design decisions:**
- `position: relative` + `overflow: hidden` on the container ensures the overlay stays within card bounds
- The mask-composite `exclude` trick makes the gradient only visible in the "border" area (defined by `padding: borderWidth`)
- External `onMouseEnter`/`onMouseLeave` are forwarded so cards can keep their existing hover logic
- `color` prop allows each card type to use its own accent color (entity color, domain color, or default accent)

- [ ] **Step 2: Verify build**

Run: `npm run build`

- [ ] **Step 3: Commit**

```bash
git add src/components/ui/SpotlightCard.tsx
git commit -m "feat: create SpotlightCard component with cursor-tracking border glow"
```

---

### Task 4: Create StaggerList Component

**Files:**
- Create: `src/components/ui/StaggerList.tsx`

**What this does:** A wrapper that uses framer-motion's `motion.div` with `staggerChildren` to animate list items entering with spring physics. Each child gets a fade-up + slight scale animation with a staggered delay.

- [ ] **Step 1: Create the component**

Create `src/components/ui/StaggerList.tsx`:

```tsx
import { motion } from 'framer-motion'

const containerVariants = {
  hidden: {},
  visible: {
    transition: {
      staggerChildren: 0.06,
      delayChildren: 0.04,
    },
  },
}

const itemVariants = {
  hidden: {
    opacity: 0,
    y: 16,
    scale: 0.98,
  },
  visible: {
    opacity: 1,
    y: 0,
    scale: 1,
    transition: {
      type: 'spring',
      stiffness: 260,
      damping: 24,
      mass: 0.8,
    },
  },
}

interface StaggerListProps {
  children: React.ReactNode
  className?: string
  style?: React.CSSProperties
}

export function StaggerList({ children, className, style }: StaggerListProps) {
  return (
    <motion.div
      className={className}
      style={style}
      variants={containerVariants}
      initial="hidden"
      animate="visible"
    >
      {children}
    </motion.div>
  )
}

interface StaggerItemProps {
  children: React.ReactNode
  className?: string
  style?: React.CSSProperties
}

export function StaggerItem({ children, className, style }: StaggerItemProps) {
  return (
    <motion.div className={className} style={style} variants={itemVariants}>
      {children}
    </motion.div>
  )
}
```

**Spring values explained:**
- `stiffness: 260` — snappy but not jarring
- `damping: 24` — minimal overshoot, settles quickly
- `mass: 0.8` — slightly light, so items feel responsive
- `staggerChildren: 0.06` — 60ms between each item (fast cascade)
- `y: 16` — items travel 16px upward as they enter
- `scale: 0.98` — items grow slightly as they appear (subtle)

- [ ] **Step 2: Verify build**

Run: `npm run build`

- [ ] **Step 3: Commit**

```bash
git add src/components/ui/StaggerList.tsx
git commit -m "feat: create StaggerList component with spring-physics staggered entry"
```

---

### Task 5: Apply SpotlightCard to AnchorCard and SkillCard

**Files:**
- Modify: `src/components/anchors/AnchorCard.tsx`
- Modify: `src/components/skills/SkillCard.tsx`

**What changes:** Replace the outer `<div>` of each card with `<SpotlightCard>`, passing the entity/domain color as the spotlight color. Remove the existing `onMouseEnter`/`onMouseLeave` hover state management since SpotlightCard handles mouse tracking. Keep the existing hover lift + shadow logic by passing it through SpotlightCard's forwarded handlers.

- [ ] **Step 1: Update AnchorCard**

In `src/components/anchors/AnchorCard.tsx`:

1. Add import: `import { SpotlightCard } from '../ui/SpotlightCard'`
2. Remove the `const [hovered, setHovered] = useState(false)` state
3. Replace the outer `<div onClick={onClick} onMouseEnter={...} onMouseLeave={...} className="cursor-pointer" style={{...}}>` with `<SpotlightCard onClick={onClick} color={entityColor + '50'} className="cursor-pointer" style={{...}}>` 
4. Remove `onMouseEnter={() => setHovered(true)}` and `onMouseLeave={() => setHovered(false)}` (SpotlightCard handles this)
5. Replace `hovered` references in the style with simpler static values:
   - Border: use `'var(--border-subtle)'` always (the spotlight glow replaces the hover border tint)
   - Transform: remove the `hovered && !isSelected ? 'translateY(-1px)' : undefined` (SpotlightCard doesn't lift, but you can keep it by using CSS `:hover` pseudo-class instead)
6. Remove the CSS `animation` property from the style (StaggerList will handle entry animation in Task 7)
7. Close with `</SpotlightCard>` instead of `</div>`

Keep the style properties: position, overflow, background (tinted gradient), borderRadius, padding, boxShadow, transition.

The spotlight `color` prop should be `${entityColor}50` — the entity color at ~31% opacity for a visible but not overwhelming glow.

- [ ] **Step 2: Update SkillCard**

In `src/components/skills/SkillCard.tsx`:

Same approach:
1. Add import: `import { SpotlightCard } from '../ui/SpotlightCard'`
2. Replace outer `<div>` with `<SpotlightCard color={domainColor + '50'}>`
3. Remove manual `onMouseEnter`/`onMouseLeave` handlers that set transform and boxShadow via `e.currentTarget.style`
4. Instead, use CSS transition for hover lift: add `:hover` logic via the style's `transition` property (the card already has `transition: 'all 0.2s var(--ease-out-expo)'`), and add a CSS class or use the existing transform approach
5. Remove the `animation` property (StaggerList handles entry)
6. Close with `</SpotlightCard>`

The spotlight `color` prop should be `${domainColor}50`.

- [ ] **Step 3: Verify build**

Run: `npm run build`

- [ ] **Step 4: Commit**

```bash
git add src/components/anchors/AnchorCard.tsx src/components/skills/SkillCard.tsx
git commit -m "feat: apply spotlight border effect to AnchorCard and SkillCard"
```

---

### Task 6: Apply SpotlightCard to FeedCard and AdvisorCard

**Files:**
- Modify: `src/components/home/FeedCard.tsx`
- Modify: `src/views/CouncilView.tsx` (AdvisorCard component within)

**What changes:** Same treatment — wrap outer div in SpotlightCard, pass accent color.

- [ ] **Step 1: Update FeedCard**

In `src/components/home/FeedCard.tsx`:

1. Add import: `import { SpotlightCard } from '../ui/SpotlightCard'`
2. Replace outer `<div className="rounded-[12px]" style={{...}}>` with `<SpotlightCard className="rounded-[12px]" color="rgba(214, 58, 0, 0.4)" style={{...}}>`
3. Remove the `animation` and `animationDelay` properties from the style (StaggerList handles entry)
4. Close with `</SpotlightCard>`

FeedCard doesn't have hover state management, so this is a clean wrap.

- [ ] **Step 2: Update AdvisorCard in CouncilView**

In `src/views/CouncilView.tsx`, find the `AdvisorCard` component (around line 382):

1. Add import at top of file: `import { SpotlightCard } from '../components/ui/SpotlightCard'`
2. In AdvisorCard, replace the outer `<div onClick={onClick} onMouseEnter={...} onMouseLeave={...} className="cursor-pointer" style={{...}}>` with `<SpotlightCard onClick={onClick} className="cursor-pointer" color="rgba(214, 58, 0, 0.4)" style={{...}}>`
3. Keep the `hovered` state since it's used for the HoverActionOverlay slide-in, but wire it through SpotlightCard's forwarded onMouseEnter/onMouseLeave
4. Remove the `animation` property from the style
5. Close with `</SpotlightCard>`

- [ ] **Step 3: Verify build**

Run: `npm run build`

- [ ] **Step 4: Commit**

```bash
git add src/components/home/FeedCard.tsx src/views/CouncilView.tsx
git commit -m "feat: apply spotlight border effect to FeedCard and AdvisorCard"
```

---

### Task 7: Apply StaggerList to Signals View Card Lists

**Files:**
- Modify: `src/views/SignalsView.tsx`

**What changes:** Wrap the anchor card list and skill card list in `StaggerList`/`StaggerItem` to replace the CSS `fadeUp` stagger animation with spring-physics stagger. Remove the per-card `animation` and `animationDelay` CSS properties since framer-motion handles timing.

- [ ] **Step 1: Read SignalsView to find card list rendering**

Read `src/views/SignalsView.tsx` and find where AnchorCard and SkillCard lists are mapped/rendered. There will be `.map()` calls that render cards with an `index` prop used for stagger delay.

- [ ] **Step 2: Wrap card lists in StaggerList**

1. Add imports: `import { StaggerList, StaggerItem } from '../components/ui/StaggerList'`
2. Find the container div that holds the mapped AnchorCard list. Wrap it in `<StaggerList>` and wrap each AnchorCard in `<StaggerItem key={...}>`.
3. Do the same for the SkillCard list.
4. The `index` prop is still passed to AnchorCard/SkillCard for other purposes, but the `animation` CSS property should already be removed from those cards in Task 5.

Example pattern:
```tsx
// Before:
<div className="flex flex-col gap-2">
  {anchors.map((a, i) => (
    <AnchorCard key={a.id} candidate={a} index={i} ... />
  ))}
</div>

// After:
<StaggerList className="flex flex-col gap-2">
  {anchors.map((a, i) => (
    <StaggerItem key={a.id}>
      <AnchorCard candidate={a} index={i} ... />
    </StaggerItem>
  ))}
</StaggerList>
```

- [ ] **Step 3: Verify build**

Run: `npm run build`

- [ ] **Step 4: Commit**

```bash
git add src/views/SignalsView.tsx
git commit -m "feat: apply spring-stagger entry animation to Signals view card lists"
```

---

### Task 8: Apply StaggerList to Home View Lists

**Files:**
- Modify: `src/components/home/HomeView.tsx`

**What changes:** Wrap the Council advisor list and any other card lists in StaggerList/StaggerItem.

- [ ] **Step 1: Read HomeView to find list rendering**

Read `src/components/home/HomeView.tsx` and find:
1. The council advisor rows (the `agents.map()` rendering AgentRow components)
2. Any other card lists that use fadeUp stagger

- [ ] **Step 2: Wrap lists in StaggerList**

1. Add imports: `import { StaggerList, StaggerItem } from './../../components/ui/StaggerList'` (adjust path as needed)
2. Wrap the advisor list container in `<StaggerList>` and each AgentRow in `<StaggerItem>`
3. Remove any CSS `animation: fadeUp` properties from the wrapped items

- [ ] **Step 3: Verify build**

Run: `npm run build`

- [ ] **Step 4: Commit**

```bash
git add src/components/home/HomeView.tsx
git commit -m "feat: apply spring-stagger entry animation to Home view council list"
```

---

## Post-Implementation Verification

After all tasks complete, verify in the browser:

1. **Spotlight effect** — Hover over any AnchorCard, SkillCard, FeedCard, or AdvisorCard. A warm glow should follow your cursor along the card border.
2. **Spring entry** — Navigate to Signals view. Cards should cascade in one by one with spring physics (slight bounce, not linear).
3. **Spring entry on Home** — Navigate to Home. Council advisor rows should stagger in.
4. **No double animation** — Cards should NOT have both the old CSS `fadeUp` AND the new framer-motion entry. Only the spring entry should be visible.
5. **Performance** — Navigate quickly between views. No jank, no layout shift, no re-animation on back navigation.
6. **Build** — Run `npm run build` to confirm no errors.

## Out of Scope

- Spotlight effect on other card types (SourceCard, DigestCard, etc.) — can be added later as a sweep
- Exit animations when leaving a view
- Shared element transitions between views
- StaggerList on Explore browse tab, Pipeline, Orient views
