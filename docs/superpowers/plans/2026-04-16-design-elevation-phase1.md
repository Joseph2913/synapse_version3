# Design Elevation Phase 1: Ambient Environment + Motion + Card Surfaces

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade the Synapse UI from functional-flat to premium by adding ambient texture, tinted shadows, varied motion, button press feedback, and replacing generic left-border card stripes with tinted surface backgrounds.

**Architecture:** All changes are CSS-first. Design tokens added to `src/index.css`, then applied to components. No new dependencies. Custom cubic-bezier curves replace uniform `0.15s ease`. Card identity shifts from painted left-border stripe to tinted background surface using entity/domain color at very low opacity.

**Tech Stack:** Tailwind CSS v4, CSS custom properties, CSS keyframes/transitions

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `src/index.css` | Modify | Add shadow scale tokens, ambient gradient, noise overlay, animation curves, active state utility |
| `src/components/anchors/AnchorCard.tsx` | Modify | Replace left-border stripe with tinted background |
| `src/components/skills/SkillCard.tsx` | Modify | Replace left-border stripe with tinted background |
| `src/components/home/FeedCard.tsx` | Modify | Replace left-border stripe with tinted background on selected state |
| `src/components/layout/TopBar.tsx` | Modify | Add warm gradient background and hover states |
| `src/components/layout/NavRail.tsx` | Modify | Upgrade hover/active states, improve active indicator |
| `src/app/App.tsx` | Modify | Add noise overlay div to app shell |

---

### Task 1: Add Design Tokens to index.css

**Files:**
- Modify: `src/index.css`

**What changes:** Add a tinted shadow scale (4 levels using warm-tinted rgba instead of pure black), custom animation easing curves, a noise overlay utility, and a global button active-press style.

- [ ] **Step 1: Add shadow scale tokens to @theme block**

Add these after the `--radius-lg` line (line 87) inside the `@theme { }` block:

```css
  /* Shadows — warm-tinted (accent-hue at low opacity, not pure black) */
  --shadow-sm: 0 1px 3px rgba(180, 89, 0, 0.03), 0 1px 2px rgba(0, 0, 0, 0.02);
  --shadow-md: 0 4px 12px rgba(180, 89, 0, 0.04), 0 2px 4px rgba(0, 0, 0, 0.02);
  --shadow-lg: 0 8px 24px rgba(180, 89, 0, 0.05), 0 4px 8px rgba(0, 0, 0, 0.03);
  --shadow-xl: 0 16px 48px rgba(180, 89, 0, 0.06), 0 8px 16px rgba(0, 0, 0, 0.03);

  /* Animation Curves */
  --ease-out-expo: cubic-bezier(0.16, 1, 0.3, 1);
  --ease-spring: cubic-bezier(0.32, 0.72, 0, 1);
  --ease-bounce: cubic-bezier(0.34, 1.56, 0.64, 1);
```

- [ ] **Step 2: Add noise overlay, ambient gradient, and active-press styles**

Add after the scrollbar styles (after line 150) and before the `@keyframes spin` block:

```css
/* Noise overlay — fixed, pointer-events-none, covers entire viewport */
.noise-overlay {
  position: fixed;
  inset: 0;
  z-index: 9999;
  pointer-events: none;
  opacity: 0.025;
  background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)'/%3E%3C/svg%3E");
  background-repeat: repeat;
  background-size: 256px 256px;
}

/* Ambient warm gradient on content background */
.ambient-gradient {
  position: fixed;
  inset: 0;
  z-index: 0;
  pointer-events: none;
  background: radial-gradient(ellipse 80% 60% at 70% 20%, rgba(214, 58, 0, 0.018) 0%, transparent 70%),
              radial-gradient(ellipse 60% 50% at 20% 80%, rgba(180, 89, 0, 0.012) 0%, transparent 60%);
}

/* Button press feedback — apply to all interactive elements */
button:active:not(:disabled),
[role="button"]:active:not(:disabled) {
  transform: scale(0.98) !important;
  transition-duration: 0.08s !important;
}
```

- [ ] **Step 3: Add improved fadeUp keyframe with more travel distance**

Replace the existing `fadeUp` keyframe (lines 194-203) with a version that has slightly more travel and uses the expo curve:

```css
/* Fade-up animation — staggered section/card entry */
@keyframes fadeUp {
  from {
    opacity: 0;
    transform: translateY(12px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
```

- [ ] **Step 4: Verify the CSS parses correctly**

Run: `npm run build`
Expected: Build succeeds with no CSS errors.

- [ ] **Step 5: Commit**

```bash
git add src/index.css
git commit -m "feat: add tinted shadow scale, animation curves, noise overlay, ambient gradient, and active-press tokens"
```

---

### Task 2: Add Noise Overlay and Ambient Gradient to App Shell

**Files:**
- Modify: `src/app/App.tsx`

**What changes:** Add the noise overlay and ambient gradient divs inside the app shell so they render behind all content. These are `position: fixed`, `pointer-events: none`, so they have zero impact on layout or interaction.

- [ ] **Step 1: Add overlay divs to the App component**

In `src/app/App.tsx`, add the two overlay divs inside the `<AuthGate>` wrapper, before `<SettingsProvider>`:

Change lines 49-64 from:

```tsx
    <AuthProvider>
      <AuthGate>
        <SettingsProvider>
          <GraphProvider>
            <ProcessingProvider>
              <ExploreDataProvider>
                <HomeDashboardProvider>
                  <Router />
                </HomeDashboardProvider>
              </ExploreDataProvider>
            </ProcessingProvider>
          </GraphProvider>
        </SettingsProvider>
      </AuthGate>
    </AuthProvider>
```

To:

```tsx
    <AuthProvider>
      <AuthGate>
        <div className="ambient-gradient" />
        <div className="noise-overlay" />
        <SettingsProvider>
          <GraphProvider>
            <ProcessingProvider>
              <ExploreDataProvider>
                <HomeDashboardProvider>
                  <Router />
                </HomeDashboardProvider>
              </ExploreDataProvider>
            </ProcessingProvider>
          </GraphProvider>
        </SettingsProvider>
      </AuthGate>
    </AuthProvider>
```

- [ ] **Step 2: Verify overlays render without affecting layout**

Run: `npm run dev`
Open the app in browser. Verify:
- Subtle warm glow visible in top-right area of the screen
- Very faint grain/noise texture across the entire viewport
- All existing interactions still work (clicking, scrolling, typing)
- No layout shift or z-index conflicts

- [ ] **Step 3: Commit**

```bash
git add src/app/App.tsx
git commit -m "feat: add ambient gradient and noise overlay to app shell"
```

---

### Task 3: Replace Left-Border Stripes on AnchorCard

**Files:**
- Modify: `src/components/anchors/AnchorCard.tsx`

**What changes:** Remove the 3px left-border stripe (both the absolute-positioned div for confirmed/dormant and the `borderLeft` for suggested). Replace with a subtle tinted background using the entity color at very low opacity. The 8px colored dot in the header row becomes the primary color indicator.

- [ ] **Step 1: Remove the left-border stripe and add tinted background**

In `src/components/anchors/AnchorCard.tsx`, make these changes to the main card div (starting at line 70):

Replace lines 76-96 (the style object and the absolute-positioned left bar div):

```tsx
      style={{
        position: 'relative',
        overflow: 'hidden',
        background: isSelected ? 'var(--color-accent-50)' : 'var(--color-bg-card)',
        border: `1px solid ${isSelected ? 'rgba(214,58,0,0.3)' : hovered ? 'var(--border-default, var(--border-subtle))' : 'var(--border-subtle)'}`,
        borderRadius: 12,
        padding: '16px 18px',
        borderLeft: isSuggested ? `3px dashed ${entityColor}` : undefined,
        transform: hovered && !isSelected ? 'translateY(-1px)' : undefined,
        boxShadow: hovered && !isSelected ? '0 2px 8px rgba(0,0,0,0.04)' : undefined,
        transition: 'all 0.15s ease',
        animation: `fadeUp 0.4s ease ${index * 0.05}s both`,
      }}
    >
      {/* Solid left bar for confirmed/dormant */}
      {!isSuggested && (
        <div style={{
          position: 'absolute', left: 0, top: 0, bottom: 0, width: 3,
          background: entityColor, borderRadius: '12px 0 0 12px',
        }} />
      )}
```

With:

```tsx
      style={{
        position: 'relative',
        overflow: 'hidden',
        background: isSelected
          ? 'var(--color-accent-50)'
          : `linear-gradient(135deg, ${entityColor}08 0%, ${entityColor}03 100%)`,
        border: `1px solid ${isSelected ? 'rgba(214,58,0,0.3)' : hovered ? `${entityColor}25` : 'var(--border-subtle)'}`,
        borderRadius: 12,
        padding: '16px 18px',
        transform: hovered && !isSelected ? 'translateY(-1px)' : undefined,
        boxShadow: hovered && !isSelected ? 'var(--shadow-md)' : 'var(--shadow-sm)',
        transition: 'all 0.2s var(--ease-out-expo)',
        animation: `fadeUp 0.4s var(--ease-out-expo) ${index * 0.05}s both`,
      }}
    >
```

Note: The `08` and `03` are hex alpha values (8/255 = ~3% opacity, 3/255 = ~1% opacity). The `25` on hover border is ~15% opacity.

- [ ] **Step 2: Enhance the colored dot to be slightly larger for suggested state**

In the header row (line 101), update the dot div to be slightly more prominent for suggested anchors:

Replace:

```tsx
          <div className="shrink-0" style={{ width: 8, height: 8, borderRadius: '50%', background: entityColor }} />
```

With:

```tsx
          <div className="shrink-0" style={{
            width: isSuggested ? 10 : 8,
            height: isSuggested ? 10 : 8,
            borderRadius: '50%',
            background: entityColor,
            boxShadow: `0 0 0 3px ${entityColor}15`,
            transition: 'all 0.2s var(--ease-out-expo)',
          }} />
```

- [ ] **Step 3: Verify visually**

Run: `npm run dev`
Navigate to Signals view. Verify:
- Anchor cards have a subtle warm tint matching their entity color (not a left stripe)
- The colored dot in the header has a soft glow ring
- Hover lifts the card slightly with a tinted shadow
- Suggested anchors show a slightly larger dot
- Selected state still uses accent-50 background

- [ ] **Step 4: Commit**

```bash
git add src/components/anchors/AnchorCard.tsx
git commit -m "feat: replace AnchorCard left-border stripe with tinted background surface"
```

---

### Task 4: Replace Left-Border Stripes on SkillCard

**Files:**
- Modify: `src/components/skills/SkillCard.tsx`

**What changes:** Same treatment as AnchorCard. Remove the absolute-positioned 3px left bar and the `borderLeft` for drafts. Replace with a tinted background using the domain color.

- [ ] **Step 1: Remove left-border stripe and add tinted background**

In `src/components/skills/SkillCard.tsx`, replace lines 103-139 (the outer div's style and the left bar):

```tsx
    <div
      onClick={onClick}
      style={{
        background: isSelected ? 'var(--color-accent-50)' : 'var(--color-bg-card)',
        border: isSelected
          ? '1px solid rgba(214,58,0,0.3)'
          : isDraft
            ? '1px dashed var(--border-subtle)'
            : '1px solid var(--border-subtle)',
        borderRadius: 12,
        padding: '16px 18px',
        cursor: 'pointer',
        opacity: isArchived ? 0.72 : isDraft ? 0.92 : 1,
        transition: 'all 0.15s ease',
        animation: `fadeUp 0.4s ease ${index * 0.05}s both`,
        position: 'relative',
        overflow: 'hidden',
        borderLeft: isDraft ? `3px dashed ${domainColor}` : undefined,
      }}
      onMouseEnter={e => {
        if (!isSelected) {
          e.currentTarget.style.transform = 'translateY(-1px)'
          e.currentTarget.style.boxShadow = '0 2px 8px rgba(0,0,0,0.04)'
        }
      }}
      onMouseLeave={e => {
        e.currentTarget.style.transform = 'translateY(0)'
        e.currentTarget.style.boxShadow = 'none'
      }}
    >
      {!isDraft && (
        <div style={{
          position: 'absolute', left: 0, top: 0, bottom: 0, width: 3,
          background: domainColor, borderRadius: '12px 0 0 12px',
        }} />
      )}
```

With:

```tsx
    <div
      onClick={onClick}
      style={{
        background: isSelected
          ? 'var(--color-accent-50)'
          : `linear-gradient(135deg, ${domainColor}08 0%, ${domainColor}03 100%)`,
        border: isSelected
          ? '1px solid rgba(214,58,0,0.3)'
          : isDraft
            ? `1px dashed ${domainColor}30`
            : '1px solid var(--border-subtle)',
        borderRadius: 12,
        padding: '16px 18px',
        cursor: 'pointer',
        opacity: isArchived ? 0.72 : isDraft ? 0.92 : 1,
        transition: 'all 0.2s var(--ease-out-expo)',
        animation: `fadeUp 0.4s var(--ease-out-expo) ${index * 0.05}s both`,
        position: 'relative',
        overflow: 'hidden',
        boxShadow: 'var(--shadow-sm)',
      }}
      onMouseEnter={e => {
        if (!isSelected) {
          e.currentTarget.style.transform = 'translateY(-1px)'
          e.currentTarget.style.boxShadow = 'var(--shadow-md)'
          e.currentTarget.style.borderColor = `${domainColor}25`
        }
      }}
      onMouseLeave={e => {
        e.currentTarget.style.transform = 'translateY(0)'
        e.currentTarget.style.boxShadow = 'var(--shadow-sm)'
        e.currentTarget.style.borderColor = isDraft ? `${domainColor}30` : 'var(--border-subtle)'
      }}
    >
```

- [ ] **Step 2: Enhance the domain color dot**

Replace the dot span in the header row (line 143):

```tsx
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: domainColor, flexShrink: 0 }} />
```

With:

```tsx
          <span style={{
            width: 8, height: 8, borderRadius: '50%', background: domainColor, flexShrink: 0,
            boxShadow: `0 0 0 3px ${domainColor}15`,
          }} />
```

- [ ] **Step 3: Verify visually**

Run: `npm run dev`
Navigate to Signals view, Skills tab. Verify:
- Skill cards have domain-color-tinted backgrounds (no left stripe)
- Draft cards use a dashed border tinted with domain color
- Hover lifts the card with tinted shadow
- The domain dot has a soft glow ring

- [ ] **Step 4: Commit**

```bash
git add src/components/skills/SkillCard.tsx
git commit -m "feat: replace SkillCard left-border stripe with tinted background surface"
```

---

### Task 5: Replace Left-Border Stripe on FeedCard (Selected State)

**Files:**
- Modify: `src/components/home/FeedCard.tsx`

**What changes:** The FeedCard uses `borderLeft: 3px solid accent-500` when selected. Replace with a tinted background (already uses `rgba(214,58,0,0.03)` but with the left stripe on top). Remove the stripe, enhance the selected background, and add tinted shadows.

- [ ] **Step 1: Update card container styles**

In `src/components/home/FeedCard.tsx`, replace lines 98-109:

```tsx
    <div
      className="rounded-[12px]"
      style={{
        background: isSelected ? 'rgba(214,58,0,0.03)' : 'var(--color-bg-card)',
        border: isSelected ? '1px solid rgba(214,58,0,0.25)' : '1px solid var(--border-subtle)',
        borderLeft: isSelected ? '3px solid var(--color-accent-500)' : undefined,
        padding: '14px 16px',
        marginBottom: 8,
        animation: 'fadeUp 0.4s ease both',
        animationDelay: `${animDelay}s`,
        transition: 'background 0.15s ease, border-color 0.15s ease',
      }}
    >
```

With:

```tsx
    <div
      className="rounded-[12px]"
      style={{
        background: isSelected
          ? 'linear-gradient(135deg, rgba(214,58,0,0.04) 0%, rgba(214,58,0,0.015) 100%)'
          : 'var(--color-bg-card)',
        border: isSelected ? '1px solid rgba(214,58,0,0.2)' : '1px solid var(--border-subtle)',
        padding: '14px 16px',
        marginBottom: 8,
        boxShadow: isSelected ? 'var(--shadow-md)' : 'var(--shadow-sm)',
        animation: 'fadeUp 0.4s var(--ease-out-expo) both',
        animationDelay: `${animDelay}s`,
        transition: 'all 0.2s var(--ease-out-expo)',
      }}
    >
```

- [ ] **Step 2: Update the "Explore More" button to use tinted shadow on selected**

Replace lines 252-258 (the Explore More button style):

```tsx
              border: isSelected ? '1px solid rgba(214,58,0,0.2)' : '1px solid var(--border-subtle)',
              background: isSelected ? 'rgba(214,58,0,0.07)' : 'var(--color-bg-inset)',
              color: isSelected ? 'var(--color-accent-500)' : 'var(--color-text-secondary)',
              transition: 'all 0.15s ease',
```

With:

```tsx
              border: isSelected ? '1px solid rgba(214,58,0,0.2)' : '1px solid var(--border-subtle)',
              background: isSelected ? 'rgba(214,58,0,0.07)' : 'var(--color-bg-inset)',
              color: isSelected ? 'var(--color-accent-500)' : 'var(--color-text-secondary)',
              transition: 'all 0.2s var(--ease-out-expo)',
```

- [ ] **Step 3: Verify visually**

Run: `npm run dev`
Navigate to Home view. Verify:
- Selected feed card has a warm tinted gradient background (no left stripe)
- Unselected cards have a subtle warm shadow
- Selected card has a slightly stronger shadow

- [ ] **Step 4: Commit**

```bash
git add src/components/home/FeedCard.tsx
git commit -m "feat: replace FeedCard selected left-border stripe with tinted background surface"
```

---

### Task 6: Elevate TopBar

**Files:**
- Modify: `src/components/layout/TopBar.tsx`

**What changes:** Replace the flat `accent-50` background with a subtle warm gradient. Add hover states to the node/edge count text and the avatar button. Use tinted shadow instead of flat border-bottom.

- [ ] **Step 1: Update header background and border**

In `src/components/layout/TopBar.tsx`, replace lines 53-61:

```tsx
      className="flex items-center justify-between shrink-0"
      style={{
        height: 52,
        background: 'var(--color-accent-50)',
        borderBottom: '1px solid var(--border-subtle)',
        paddingLeft: 24,
        paddingRight: 24,
      }}
```

With:

```tsx
      className="flex items-center justify-between shrink-0"
      style={{
        height: 52,
        background: 'linear-gradient(90deg, var(--color-accent-50) 0%, rgba(255,245,240,0.6) 50%, var(--color-accent-50) 100%)',
        borderBottom: '1px solid rgba(214,58,0,0.06)',
        boxShadow: '0 1px 4px rgba(180,89,0,0.03)',
        paddingLeft: 24,
        paddingRight: 24,
      }}
```

- [ ] **Step 2: Add hover state to the avatar button**

Replace lines 76-95 (the avatar button):

```tsx
        <button
          type="button"
          onClick={onOpenSettings}
          title="Settings"
          className="flex items-center justify-center border-none cursor-pointer"
          style={{
            width: 28,
            height: 28,
            borderRadius: '50%',
            background: 'linear-gradient(135deg, var(--color-accent-500), var(--color-accent-300))',
            color: '#ffffff',
            fontFamily: 'var(--font-display)',
            fontSize: 11,
            fontWeight: 700,
            lineHeight: 1,
            marginRight: 4,
          }}
        >
          {initial}
        </button>
```

With:

```tsx
        <button
          type="button"
          onClick={onOpenSettings}
          title="Settings"
          className="flex items-center justify-center border-none cursor-pointer"
          style={{
            width: 28,
            height: 28,
            borderRadius: '50%',
            background: 'linear-gradient(135deg, var(--color-accent-500), var(--color-accent-300))',
            color: '#ffffff',
            fontFamily: 'var(--font-display)',
            fontSize: 11,
            fontWeight: 700,
            lineHeight: 1,
            marginRight: 4,
            boxShadow: '0 0 0 2px rgba(214,58,0,0.08)',
            transition: 'box-shadow 0.2s var(--ease-out-expo), transform 0.2s var(--ease-out-expo)',
          }}
          onMouseEnter={e => {
            e.currentTarget.style.boxShadow = '0 0 0 3px rgba(214,58,0,0.15)'
            e.currentTarget.style.transform = 'scale(1.05)'
          }}
          onMouseLeave={e => {
            e.currentTarget.style.boxShadow = '0 0 0 2px rgba(214,58,0,0.08)'
            e.currentTarget.style.transform = 'scale(1)'
          }}
        >
          {initial}
        </button>
```

- [ ] **Step 3: Verify visually**

Run: `npm run dev`
Verify:
- TopBar has a subtle horizontal gradient (slightly lighter in the center)
- A faint warm shadow beneath the TopBar instead of a flat border
- Avatar button has a glow ring that expands on hover
- Avatar scales up slightly on hover

- [ ] **Step 4: Commit**

```bash
git add src/components/layout/TopBar.tsx
git commit -m "feat: elevate TopBar with warm gradient, tinted shadow, and hover states"
```

---

### Task 7: Upgrade NavRail Hover and Active States

**Files:**
- Modify: `src/components/layout/NavRail.tsx`

**What changes:** Make hover states more visible. Upgrade the active indicator from a plain 3px bar to a softer pill with a glow. Use the expo easing curve on transitions.

- [ ] **Step 1: Upgrade NavItemButton hover background and transition**

In `src/components/layout/NavRail.tsx`, in the `NavItemButton` component, replace lines 65-71 (the style object):

```tsx
        background: isActive
          ? 'var(--color-accent-50)'
          : hovered
            ? 'rgba(0,0,0,0.04)'
            : 'transparent',
        transition: 'background 0.15s ease, width 0.2s ease, padding 0.2s ease',
```

With:

```tsx
        background: isActive
          ? 'var(--color-accent-50)'
          : hovered
            ? 'rgba(214,58,0,0.04)'
            : 'transparent',
        boxShadow: isActive ? 'inset 0 0 0 1px rgba(214,58,0,0.08)' : 'none',
        transition: 'all 0.2s var(--ease-out-expo)',
```

- [ ] **Step 2: Upgrade the active indicator bar to a glowing pill**

Replace lines 74-86 (the active indicator div):

```tsx
      {isActive && (
        <div
          className="absolute"
          style={{
            left: expanded ? -8 : -8,
            top: '50%',
            transform: 'translateY(-50%)',
            width: 3,
            height: 16,
            background: 'var(--color-accent-500)',
            borderRadius: '0 2px 2px 0',
          }}
        />
      )}
```

With:

```tsx
      {isActive && (
        <div
          className="absolute"
          style={{
            left: expanded ? -8 : -8,
            top: '50%',
            transform: 'translateY(-50%)',
            width: 3,
            height: 20,
            background: 'var(--color-accent-500)',
            borderRadius: '0 3px 3px 0',
            boxShadow: '2px 0 8px rgba(214,58,0,0.15)',
          }}
        />
      )}
```

- [ ] **Step 3: Upgrade icon transition**

Replace line 99 (icon transition):

```tsx
          transition: 'color 0.15s ease',
```

With:

```tsx
          transition: 'color 0.2s var(--ease-out-expo)',
```

- [ ] **Step 4: Upgrade UtilButton hover**

Replace line 169 (UtilButton background):

```tsx
        background: hovered ? 'rgba(0,0,0,0.04)' : 'transparent',
        transition: 'background 0.15s ease, width 0.2s ease, padding 0.2s ease',
```

With:

```tsx
        background: hovered ? 'rgba(214,58,0,0.04)' : 'transparent',
        transition: 'all 0.2s var(--ease-out-expo)',
```

- [ ] **Step 5: Upgrade nav container expand shadow**

Replace line 204 (the boxShadow on the nav element):

```tsx
          boxShadow: expanded ? '4px 0 16px rgba(0,0,0,0.06)' : 'none',
```

With:

```tsx
          boxShadow: expanded ? '4px 0 20px rgba(180,89,0,0.06)' : 'none',
```

- [ ] **Step 6: Verify visually**

Run: `npm run dev`
Verify:
- NavRail hover states show a warm tint (not cold gray)
- Active indicator bar is slightly taller with a warm glow
- Active nav item has a subtle inset border
- Expanded nav shadow is warm-tinted
- All transitions feel smoother with the expo curve

- [ ] **Step 7: Commit**

```bash
git add src/components/layout/NavRail.tsx
git commit -m "feat: upgrade NavRail with warm hover states, glowing active indicator, and expo easing"
```

---

## Post-Implementation Verification

After all tasks are complete, do a full visual sweep:

1. **Home view** - FeedCards should show tinted backgrounds when selected, no left stripes
2. **Signals > Anchors tab** - AnchorCards show entity-color-tinted backgrounds, no left stripes
3. **Signals > Skills tab** - SkillCards show domain-color-tinted backgrounds, no left stripes
4. **TopBar** - Warm gradient, avatar hover glow, tinted bottom shadow
5. **NavRail** - Warm hover tints, glowing active indicator, warm expand shadow
6. **Global** - Subtle noise texture visible, warm ambient gradient in background
7. **All buttons** - Press any button and confirm the `scale(0.98)` active feedback fires
8. **Build** - Run `npm run build` to confirm no errors

## Out of Scope (Phase 2)

- Graph node rendering upgrades
- Right Panel glass effect
- Edge rendering improvements
- Staggered scroll-driven reveals (requires framer-motion)
- Card hierarchy differentiation (different card styles for different importance levels)
