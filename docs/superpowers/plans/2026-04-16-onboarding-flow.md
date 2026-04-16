# Onboarding Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a 5-step onboarding wizard that appears on first sign-in, walks the user through the platform, bootstraps their profile from AI conversation exports, and connects meeting/YouTube integrations.

**Architecture:** Full-screen takeover rendered by `AuthGate` when `onboarding_complete` is false on the user profile. The wizard is a single `OnboardingWizard` component that manages step transitions via local state. Step 0 renders static mockup components (not production views) with curated demo data. Steps 1-4 are centered wizard panels. A Vercel serverless function handles AI export processing.

**Tech Stack:** React 18, TypeScript strict, Tailwind CSS 4, Supabase (Postgres + Auth), Gemini 2.0 Flash, Vercel Functions, Lucide React icons

**Spec:** `docs/superpowers/specs/2026-04-16-onboarding-flow-design.md`

---

## File Structure

### New Files

| File | Responsibility |
|------|---------------|
| `src/components/onboarding/OnboardingWizard.tsx` | Top-level wizard: step state machine, skip logic, completion handler |
| `src/components/onboarding/OnboardingStepLayout.tsx` | Shared layout for Steps 1-4: centered card, header, skip/next buttons |
| `src/components/onboarding/Step0Walkthrough.tsx` | Full-screen scrollable page preview tour with dot nav |
| `src/components/onboarding/Step0PagePreview.tsx` | Single page preview: fake app shell + mock content + floating description card |
| `src/components/onboarding/Step0MockPages.tsx` | Static mock content for all 6 page previews (Home, Explore, Ask, Sources, Signals, Council) |
| `src/components/onboarding/Step0WelcomeHero.tsx` | Welcome hero section with logo, tagline, page pills |
| `src/components/onboarding/Step1ImportHistory.tsx` | File upload with ChatGPT/Claude tabs, drop zone, processing state |
| `src/components/onboarding/Step2ReviewProfile.tsx` | Profile review with editable fields and anchor toggles |
| `src/components/onboarding/Step3ConnectMeetings.tsx` | Meeting integration cards (Microsoft 365, Circleback) |
| `src/components/onboarding/Step4ConnectYouTube.tsx` | YouTube playlist URL input, preview, connection |
| `src/components/onboarding/onboardingMockData.ts` | All mock data constants for Step 0 previews |
| `api/onboarding/process-export.ts` | Vercel serverless function: parse AI exports, call Gemini, write profile + nodes |

### Modified Files

| File | Change |
|------|--------|
| `src/app/App.tsx` | AuthGate renders `<OnboardingWizard>` when `onboarding_complete` is false |
| `src/types/database.ts` | Add `onboarding_complete` field to `UserProfile` interface |
| `src/services/supabase.ts` | Add `completeOnboarding()` and `resetOnboarding()` functions |
| `src/app/providers/SettingsProvider.tsx` | Expose `completeOnboarding` and `resetOnboarding` via context |
| Settings view (wherever "Replay onboarding" button goes) | Add replay button |

---

## Task 1: Database and Type Foundation

**Files:**
- Modify: `src/types/database.ts`
- Modify: `src/services/supabase.ts`

- [ ] **Step 1: Add `onboarding_complete` to the Supabase database**

Run in the Supabase SQL editor (or migration):

```sql
ALTER TABLE user_profiles
ADD COLUMN IF NOT EXISTS onboarding_complete boolean DEFAULT false;
```

- [ ] **Step 2: Update the `UserProfile` type**

In `src/types/database.ts`, add the field to the `UserProfile` interface:

```typescript
export interface UserProfile {
  id: string
  user_id: string
  professional_context: { role?: string; industry?: string; current_projects?: string }
  personal_interests: { topics?: string; learning_goals?: string }
  processing_preferences: { insight_depth?: string; relationship_focus?: string }
  onboarding_complete: boolean
  created_at: string
  updated_at: string
}
```

- [ ] **Step 3: Add onboarding helper functions to supabase.ts**

In `src/services/supabase.ts`, add:

```typescript
export async function completeOnboarding(): Promise<{ error: Error | null }> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: new Error('Not authenticated') }

  const { error } = await supabase
    .from('user_profiles')
    .update({ onboarding_complete: true, updated_at: new Date().toISOString() })
    .eq('user_id', user.id)

  return { error: error ? new Error(error.message) : null }
}

export async function resetOnboarding(): Promise<{ error: Error | null }> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: new Error('Not authenticated') }

  const { error } = await supabase
    .from('user_profiles')
    .update({ onboarding_complete: false, updated_at: new Date().toISOString() })
    .eq('user_id', user.id)

  return { error: error ? new Error(error.message) : null }
}
```

- [ ] **Step 4: Update `fetchOrCreateProfile` default**

In `src/services/supabase.ts`, update the `fetchOrCreateProfile` function's insert call to include the new column:

```typescript
const { data: newProfile, error: insertError } = await supabase
  .from('user_profiles')
  .insert({
    user_id: user.id,
    professional_context: {},
    personal_interests: {},
    processing_preferences: {},
    onboarding_complete: false,
  })
  .select()
  .single()
```

- [ ] **Step 5: Verify the column exists and types compile**

Run: `npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 6: Commit**

```bash
git add src/types/database.ts src/services/supabase.ts
git commit -m "feat(onboarding): add onboarding_complete column and helper functions"
```

---

## Task 2: SettingsProvider Integration

**Files:**
- Modify: `src/app/providers/SettingsProvider.tsx`

- [ ] **Step 1: Import the new functions**

In `src/app/providers/SettingsProvider.tsx`, add to the imports from `../../services/supabase`:

```typescript
import {
  fetchOrCreateProfile,
  fetchOrCreateExtractionSettings,
  updateProfile as updateProfileService,
  updateExtractionSettings as updateExtractionSettingsService,
  promoteToAnchor as promoteToAnchorService,
  demoteAnchor as demoteAnchorService,
  completeOnboarding as completeOnboardingService,
  resetOnboarding as resetOnboardingService,
  supabase,
} from '../../services/supabase'
```

- [ ] **Step 2: Add to the context type**

Add to `SettingsContextValue`:

```typescript
export interface SettingsContextValue {
  // ... existing fields ...

  // Onboarding
  completeOnboarding: () => Promise<{ error: Error | null }>
  resetOnboarding: () => Promise<{ error: Error | null }>
}
```

- [ ] **Step 3: Create the callback functions**

Inside the `SettingsProvider` component, add:

```typescript
const completeOnboardingFn = useCallback(async () => {
  const result = await completeOnboardingService()
  if (!result.error) {
    setProfile(prev => prev ? { ...prev, onboarding_complete: true } as UserProfile : null)
  }
  return result
}, [])

const resetOnboardingFn = useCallback(async () => {
  const result = await resetOnboardingService()
  if (!result.error) {
    setProfile(prev => prev ? { ...prev, onboarding_complete: false } as UserProfile : null)
  }
  return result
}, [])
```

- [ ] **Step 4: Add to the provider value**

In the `<SettingsContext.Provider value={...}>`, add:

```typescript
completeOnboarding: completeOnboardingFn,
resetOnboarding: resetOnboardingFn,
```

- [ ] **Step 5: Verify types compile**

Run: `npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 6: Commit**

```bash
git add src/app/providers/SettingsProvider.tsx
git commit -m "feat(onboarding): expose completeOnboarding and resetOnboarding in SettingsProvider"
```

---

## Task 3: OnboardingWizard Shell and AuthGate Integration

**Files:**
- Create: `src/components/onboarding/OnboardingWizard.tsx`
- Modify: `src/app/App.tsx`

- [ ] **Step 1: Create the OnboardingWizard component**

Create `src/components/onboarding/OnboardingWizard.tsx`:

```tsx
import { useState, useCallback } from 'react'
import { useSettings } from '../../hooks/useSettings'

type OnboardingStep = 0 | 1 | 2 | 3 | 4

interface StepResult {
  step1Completed?: boolean
}

export function OnboardingWizard() {
  const { completeOnboarding, refreshProfile } = useSettings()
  const [currentStep, setCurrentStep] = useState<OnboardingStep>(0)
  const [stepResults, setStepResults] = useState<StepResult>({})

  const handleSkipAll = useCallback(async () => {
    await completeOnboarding()
    await refreshProfile()
  }, [completeOnboarding, refreshProfile])

  const handleFinish = useCallback(async () => {
    await completeOnboarding()
    await refreshProfile()
  }, [completeOnboarding, refreshProfile])

  const handleNext = useCallback((fromStep: OnboardingStep, result?: Partial<StepResult>) => {
    if (result) {
      setStepResults(prev => ({ ...prev, ...result }))
    }

    switch (fromStep) {
      case 0:
        setCurrentStep(1)
        break
      case 1:
        // If step 1 was completed (not skipped), go to step 2 for profile review
        // If skipped, jump to step 3
        if (result?.step1Completed) {
          setCurrentStep(2)
        } else {
          setCurrentStep(3)
        }
        break
      case 2:
        setCurrentStep(3)
        break
      case 3:
        setCurrentStep(4)
        break
      case 4:
        handleFinish()
        break
    }
  }, [handleFinish])

  return (
    <div className="fixed inset-0 bg-[var(--color-bg-content)] z-50 overflow-hidden">
      {/* Step components will be rendered here in later tasks */}
      {/* Placeholder for now */}
      <div className="flex items-center justify-center h-full">
        <div className="text-center">
          <p className="text-[var(--color-text-primary)] font-display font-bold text-xl mb-4">
            Onboarding Step {currentStep}
          </p>
          <button
            onClick={() => handleNext(currentStep, currentStep === 1 ? { step1Completed: false } : undefined)}
            className="px-6 py-2 rounded-full bg-[var(--color-accent-500)] text-white font-semibold text-sm mr-3"
          >
            Next
          </button>
          <button
            onClick={handleSkipAll}
            className="px-6 py-2 rounded-full border border-[var(--border-default)] text-[var(--color-text-secondary)] font-semibold text-sm"
          >
            Skip Onboarding
          </button>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Update AuthGate in App.tsx**

In `src/app/App.tsx`, modify the `AuthGate` component. The onboarding check needs to happen inside `SettingsProvider` since it reads the profile. Restructure `AuthGate` to have two gates:

```tsx
import { AuthProvider } from './providers/AuthProvider'
import { SettingsProvider } from './providers/SettingsProvider'
import { GraphProvider } from './providers/GraphProvider'
import { ProcessingProvider } from './providers/ProcessingProvider'
import { ExploreDataProvider } from './providers/ExploreDataProvider'
import { HomeDashboardProvider } from './providers/HomeDashboardProvider'
import { Router } from './Router'
import { LoginPage } from '../components/auth/LoginPage'
import { OnboardingWizard } from '../components/onboarding/OnboardingWizard'
import { useAuth } from '../hooks/useAuth'
import { useSettings } from '../hooks/useSettings'

function AuthGate({ children }: { children: React.ReactNode }) {
  const { session, loading } = useAuth()

  if (loading) {
    return (
      <div
        style={{
          width: '100vw',
          height: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'var(--color-bg-content)',
        }}
      >
        <div
          style={{
            width: 28,
            height: 28,
            border: '3px solid var(--border-subtle)',
            borderTopColor: 'var(--color-accent-500)',
            borderRadius: '50%',
            animation: 'spin 0.8s linear infinite',
          }}
        />
      </div>
    )
  }

  if (!session) {
    return <LoginPage />
  }

  return <>{children}</>
}

function OnboardingGate({ children }: { children: React.ReactNode }) {
  const { profile, loading } = useSettings()

  if (loading) {
    return (
      <div
        style={{
          width: '100vw',
          height: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'var(--color-bg-content)',
        }}
      >
        <div
          style={{
            width: 28,
            height: 28,
            border: '3px solid var(--border-subtle)',
            borderTopColor: 'var(--color-accent-500)',
            borderRadius: '50%',
            animation: 'spin 0.8s linear infinite',
          }}
        />
      </div>
    )
  }

  if (profile && !profile.onboarding_complete) {
    return <OnboardingWizard />
  }

  return <>{children}</>
}

export default function App() {
  return (
    <AuthProvider>
      <AuthGate>
        <div className="ambient-gradient" />
        <div className="noise-overlay" />
        <SettingsProvider>
          <OnboardingGate>
            <GraphProvider>
              <ProcessingProvider>
                <ExploreDataProvider>
                  <HomeDashboardProvider>
                    <Router />
                  </HomeDashboardProvider>
                </ExploreDataProvider>
              </ProcessingProvider>
            </GraphProvider>
          </OnboardingGate>
        </SettingsProvider>
      </AuthGate>
    </AuthProvider>
  )
}
```

- [ ] **Step 3: Verify the app builds and the wizard shows**

Run: `npm run dev`

Test: Sign in with a user. If `onboarding_complete` is false (which it will be for existing users until the column is added, or for new users), the wizard placeholder should appear instead of the main app.

- [ ] **Step 4: Commit**

```bash
git add src/components/onboarding/OnboardingWizard.tsx src/app/App.tsx
git commit -m "feat(onboarding): add OnboardingWizard shell and AuthGate/OnboardingGate integration"
```

---

## Task 4: Shared Step Layout Component

**Files:**
- Create: `src/components/onboarding/OnboardingStepLayout.tsx`

- [ ] **Step 1: Create the shared layout**

This is the centered card layout used by Steps 1-4. Create `src/components/onboarding/OnboardingStepLayout.tsx`:

```tsx
import { SynapseLogo } from '../shared/SynapseLogo'

interface OnboardingStepLayoutProps {
  stepNumber: number
  totalSteps: number
  title: string
  subtitle: string
  maxWidth?: number
  children: React.ReactNode
  onSkipAll: () => void
  onSkip: () => void
  onNext: () => void
  nextLabel?: string
  skipLabel?: string
  nextDisabled?: boolean
}

export function OnboardingStepLayout({
  stepNumber,
  totalSteps,
  title,
  subtitle,
  maxWidth = 600,
  children,
  onSkipAll,
  onSkip,
  onNext,
  nextLabel = 'Continue',
  skipLabel = 'Skip for now',
  nextDisabled = false,
}: OnboardingStepLayoutProps) {
  return (
    <div className="fixed inset-0 bg-[var(--color-bg-content)] z-50 overflow-y-auto">
      {/* Top bar with logo and skip */}
      <div className="flex items-center justify-between px-8 py-5">
        <div className="flex items-center gap-3">
          <SynapseLogo size={28} />
          <span className="font-display font-bold text-[15px] text-[var(--color-text-primary)]">
            Synapse
          </span>
        </div>
        <button
          onClick={onSkipAll}
          className="text-[12px] font-semibold text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] transition-colors"
        >
          Skip onboarding
        </button>
      </div>

      {/* Step indicator */}
      <div className="flex items-center justify-center gap-2 mb-8">
        {Array.from({ length: totalSteps }, (_, i) => (
          <div
            key={i}
            className="h-[3px] rounded-full transition-all"
            style={{
              width: i + 1 === stepNumber ? 32 : 16,
              background: i + 1 <= stepNumber
                ? 'var(--color-accent-500)'
                : 'var(--border-default)',
            }}
          />
        ))}
      </div>

      {/* Card */}
      <div
        className="mx-auto bg-[var(--color-bg-card)] border border-[var(--border-subtle)] rounded-2xl"
        style={{ maxWidth, padding: '36px 32px' }}
      >
        <h2 className="font-display font-bold text-[20px] text-[var(--color-text-primary)] mb-1">
          {title}
        </h2>
        <p className="text-[13px] text-[var(--color-text-secondary)] mb-6 leading-relaxed">
          {subtitle}
        </p>

        {children}

        {/* Buttons */}
        <div className="flex items-center justify-end gap-3 mt-8 pt-6 border-t border-[var(--border-subtle)]">
          <button
            onClick={onSkip}
            className="px-5 py-[9px] rounded-full text-[13px] font-semibold text-[var(--color-text-secondary)] border border-[var(--border-default)] hover:border-[var(--border-strong)] transition-colors"
          >
            {skipLabel}
          </button>
          <button
            onClick={onNext}
            disabled={nextDisabled}
            className="px-5 py-[9px] rounded-full text-[13px] font-semibold text-white transition-colors disabled:opacity-50"
            style={{ background: 'var(--color-accent-500)' }}
          >
            {nextLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Verify types compile**

Run: `npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 3: Commit**

```bash
git add src/components/onboarding/OnboardingStepLayout.tsx
git commit -m "feat(onboarding): add shared OnboardingStepLayout component"
```

---

## Task 5: Step 0 - Mock Data and Welcome Hero

**Files:**
- Create: `src/components/onboarding/onboardingMockData.ts`
- Create: `src/components/onboarding/Step0WelcomeHero.tsx`

- [ ] **Step 1: Create the mock data file**

Create `src/components/onboarding/onboardingMockData.ts`:

```typescript
import type { LucideIcon } from 'lucide-react'
import {
  Home, Compass, MessageSquare, Database, Radio, Users,
} from 'lucide-react'

// --- Source types ---

interface MockSource {
  title: string
  type: 'YouTube' | 'Meeting' | 'Document' | 'Research' | 'Note'
  age: string
  entityCount: number
  color: string
  bgColor: string
}

export const MOCK_SOURCES: MockSource[] = [
  { title: 'How AI Agents Actually Work - Full Breakdown', type: 'YouTube', age: '2h ago', entityCount: 24, color: '#dc2626', bgColor: '#fef2f2' },
  { title: 'Product Strategy Sync - Q2 Roadmap', type: 'Meeting', age: '5h ago', entityCount: 31, color: '#ea580c', bgColor: '#fff7ed' },
  { title: 'Market Analysis: Personal Knowledge Tools 2026', type: 'Document', age: '1d ago', entityCount: 56, color: '#2563eb', bgColor: '#eff6ff' },
  { title: 'Graph RAG vs Traditional RAG - Benchmark Study', type: 'Research', age: '1d ago', entityCount: 18, color: '#9333ea', bgColor: '#faf5ff' },
  { title: 'Notes: Competitive positioning for enterprise', type: 'Note', age: '2d ago', entityCount: 12, color: '#16a34a', bgColor: '#f0fdf4' },
  { title: 'Building Knowledge Graphs at Scale', type: 'YouTube', age: '3d ago', entityCount: 19, color: '#dc2626', bgColor: '#fef2f2' },
]

// --- Anchor types ---

interface MockAnchor {
  name: string
  entityCount: number
  score: number
  status: 'Active' | 'Growing' | 'Suggested'
  color: string
  connectionCount: number
}

export const MOCK_ANCHORS: MockAnchor[] = [
  { name: 'AI Agent Architecture', entityCount: 187, score: 0.92, status: 'Active', color: '#d63a00', connectionCount: 342 },
  { name: 'Product Strategy', entityCount: 124, score: 0.87, status: 'Active', color: '#2563eb', connectionCount: 201 },
  { name: 'Knowledge Graphs', entityCount: 98, score: 0.84, status: 'Growing', color: '#9333ea', connectionCount: 156 },
  { name: 'Graph RAG', entityCount: 67, score: 0.79, status: 'Active', color: '#16a34a', connectionCount: 112 },
  { name: 'Consulting Delivery', entityCount: 82, score: 0.71, status: 'Active', color: '#ea580c', connectionCount: 94 },
  { name: 'Market Analysis', entityCount: 143, score: 0.83, status: 'Active', color: '#dc2626', connectionCount: 178 },
]

// --- Council advisors ---

interface MockAdvisor {
  name: string
  health: 'Strong' | 'Growing' | 'Thin'
  healthColor: string
  healthBg: string
  description: string
  iconBg: string
  videoCount: number
  insightCount: number
  themes: Array<{ label: string; color: string; bgColor: string }>
}

export const MOCK_ADVISORS: MockAdvisor[] = [
  {
    name: 'AI Strategy',
    health: 'Strong',
    healthColor: '#2e7d32',
    healthBg: '#e8f5e9',
    description: 'Tracks patterns in agent architectures, LLM capabilities, and emerging AI infrastructure.',
    iconBg: '#fef2f2',
    videoCount: 34,
    insightCount: 12,
    themes: [
      { label: 'Multi-Agent', color: '#dc2626', bgColor: '#fef2f2' },
      { label: 'RAG', color: '#2563eb', bgColor: '#eff6ff' },
      { label: 'Tool Use', color: '#9333ea', bgColor: '#faf5ff' },
      { label: 'Embeddings', color: '#16a34a', bgColor: '#f0fdf4' },
    ],
  },
  {
    name: 'Product Growth',
    health: 'Growing',
    healthColor: '#e65100',
    healthBg: '#fff3e0',
    description: 'GTM strategy, retention patterns, and product-market fit signals.',
    iconBg: '#eff6ff',
    videoCount: 18,
    insightCount: 7,
    themes: [
      { label: 'GTM', color: '#2563eb', bgColor: '#eff6ff' },
      { label: 'Retention', color: '#ea580c', bgColor: '#fff7ed' },
      { label: 'PMF', color: '#9333ea', bgColor: '#faf5ff' },
    ],
  },
  {
    name: 'Knowledge Systems',
    health: 'Strong',
    healthColor: '#2e7d32',
    healthBg: '#e8f5e9',
    description: 'Graph theory, ontology design, and knowledge representation.',
    iconBg: '#faf5ff',
    videoCount: 22,
    insightCount: 9,
    themes: [
      { label: 'Ontology', color: '#9333ea', bgColor: '#faf5ff' },
      { label: 'Graphs', color: '#16a34a', bgColor: '#f0fdf4' },
      { label: 'Embedding', color: '#2563eb', bgColor: '#eff6ff' },
    ],
  },
  {
    name: 'Consulting Ops',
    health: 'Thin',
    healthColor: '#c62828',
    healthBg: '#fce4ec',
    description: 'Client delivery frameworks, engagement models, and consulting methodology.',
    iconBg: '#f0fdf4',
    videoCount: 8,
    insightCount: 3,
    themes: [
      { label: 'Delivery', color: '#ea580c', bgColor: '#fff7ed' },
      { label: 'Frameworks', color: '#2563eb', bgColor: '#eff6ff' },
    ],
  },
]

// --- Skills ---

interface MockSkill {
  title: string
  domain: string
  domainColor: string
  domainBg: string
  description: string
}

export const MOCK_SKILLS: MockSkill[] = [
  { title: 'Competitive Analysis Framework', domain: 'Strategy', domainColor: '#2563eb', domainBg: '#eff6ff', description: 'Structured approach to evaluating market competitors: positioning matrix, feature gap analysis, and strategic response playbook.' },
  { title: 'Meeting Debrief Protocol', domain: 'Operations', domainColor: '#ea580c', domainBg: '#fff7ed', description: 'Extract decisions, action items, open questions, and relationship dynamics from any meeting transcript.' },
]

// --- Mock entities for source detail ---

interface MockEntity {
  label: string
  color: string
  bgColor: string
}

export const MOCK_SOURCE_ENTITIES: MockEntity[] = [
  { label: 'Andrew Ng', color: '#dc2626', bgColor: '#fef2f2' },
  { label: 'Multi-Agent Systems', color: '#2563eb', bgColor: '#eff6ff' },
  { label: 'Tool Use', color: '#9333ea', bgColor: '#faf5ff' },
  { label: 'LangChain', color: '#16a34a', bgColor: '#f0fdf4' },
  { label: 'AutoGPT', color: '#ea580c', bgColor: '#fff7ed' },
  { label: 'ReAct Pattern', color: '#2563eb', bgColor: '#eff6ff' },
  { label: 'OpenAI', color: '#dc2626', bgColor: '#fef2f2' },
  { label: 'Chain of Thought', color: '#9333ea', bgColor: '#faf5ff' },
]

// --- Stats ---

export const MOCK_STATS = {
  totalSources: 247,
  totalNodes: 1842,
  activeAnchors: 12,
  activeSkills: 8,
  sourceBreakdown: {
    youtube: 34,
    documents: 89,
    notes: 52,
    research: 41,
    meetings: 31,
  },
}

// --- Page definitions for walkthrough nav ---

export interface PageDefinition {
  id: string
  name: string
  icon: LucideIcon
  description: string
  features: string[]
  accentFeatures: string[]
}

export const PAGES: PageDefinition[] = [
  {
    id: 'home',
    name: 'Home',
    icon: Home,
    description: 'Your dashboard. See what\'s been ingested, how your knowledge is growing, and which council advisors are active. Everything you\'ve added shows up here as your knowledge feed.',
    features: ['Knowledge Stats', 'Source Types', 'Council Overview'],
    accentFeatures: ['Activity Feed'],
  },
  {
    id: 'explore',
    name: 'Explore',
    icon: Compass,
    description: 'Visualize your knowledge as an interactive graph. Anchors are your key focus areas that cluster related entities into navigable bubbles. Click any cluster to dive into its neighborhood.',
    features: ['Entity Graph', 'Source View', 'Connection Types', 'Suggested Anchors'],
    accentFeatures: ['Anchor Clusters'],
  },
  {
    id: 'ask',
    name: 'Ask',
    icon: MessageSquare,
    description: 'Chat with your knowledge graph using Graph RAG. Get answers grounded in your actual sources with inline citations. Switch to Council mode for multi-perspective reasoning from your domain advisors.',
    features: ['Source Citations', 'Advisor Perspectives', 'Confidence Scores'],
    accentFeatures: ['Graph RAG', 'Council Mode'],
  },
  {
    id: 'sources',
    name: 'Sources',
    icon: Database,
    description: 'Everything you\'ve ingested into Synapse lives here. Browse your YouTube videos, meeting transcripts, documents, notes, and research. Click any source to see extracted entities, connected anchors, and key takeaways.',
    features: ['Entity Extraction', 'Anchor Connections', 'Key Takeaways', 'Connected Sources'],
    accentFeatures: ['All Source Types'],
  },
  {
    id: 'signals',
    name: 'Signals',
    icon: Radio,
    description: 'Your knowledge intelligence layer. Anchors are auto-detected focus areas that organize your graph. Skills are methodologies learned from your content. Together they make your knowledge graph smarter over time.',
    features: ['Health Scores', 'Auto-Detection', 'Velocity Tracking'],
    accentFeatures: ['Anchors', 'Skills'],
  },
  {
    id: 'council',
    name: 'Council',
    icon: Users,
    description: 'Your board of domain expert advisors, built from your own knowledge. Each advisor generates insights, sends cross-domain signals, and maintains standing questions. They reason independently and surface connections you might miss.',
    features: ['Emerging Insights', 'Health Tracking', 'Standing Questions', 'Knowledge Gaps'],
    accentFeatures: ['Domain Advisors', 'Cross-Domain Signals'],
  },
]
```

- [ ] **Step 2: Create the Welcome Hero component**

Create `src/components/onboarding/Step0WelcomeHero.tsx`:

```tsx
import { SynapseLogo } from '../shared/SynapseLogo'
import { PAGES } from './onboardingMockData'

interface Step0WelcomeHeroProps {
  onSkipAll: () => void
}

export function Step0WelcomeHero({ onSkipAll }: Step0WelcomeHeroProps) {
  return (
    <div
      className="min-h-screen flex flex-col items-center justify-center px-10 relative"
      style={{ background: 'linear-gradient(165deg, #1a1a1a 0%, #2a1a14 50%, #1a1a1a 100%)' }}
    >
      {/* Skip link */}
      <button
        onClick={onSkipAll}
        className="absolute top-6 right-8 text-[12px] font-semibold transition-colors"
        style={{ color: 'rgba(255,255,255,0.35)' }}
        onMouseEnter={e => { e.currentTarget.style.color = 'rgba(255,255,255,0.6)' }}
        onMouseLeave={e => { e.currentTarget.style.color = 'rgba(255,255,255,0.35)' }}
      >
        Skip onboarding
      </button>

      <div
        className="flex items-center justify-center rounded-2xl mb-5"
        style={{
          width: 64,
          height: 64,
          background: 'var(--color-accent-500)',
          boxShadow: '0 0 40px rgba(214,58,0,0.25)',
        }}
      >
        <SynapseLogo size={32} color="#ffffff" />
      </div>

      <h1
        className="font-display font-extrabold mb-2"
        style={{ fontSize: 36, color: '#ffffff', letterSpacing: -0.5 }}
      >
        Welcome to Synapse
      </h1>

      <p
        className="text-center mb-8 leading-relaxed"
        style={{ fontSize: 16, color: 'rgba(255,255,255,0.5)', maxWidth: 440 }}
      >
        Your knowledge, connected. Synapse transforms scattered knowledge from meetings,
        videos, documents, and research into an interconnected graph you can explore, query,
        and build on.
      </p>

      <div className="flex flex-wrap justify-center gap-4 mb-10" style={{ maxWidth: 700 }}>
        {PAGES.map(page => {
          const Icon = page.icon
          return (
            <div
              key={page.id}
              className="flex items-center gap-2 rounded-full"
              style={{
                padding: '8px 16px',
                background: 'rgba(255,255,255,0.06)',
                border: '1px solid rgba(255,255,255,0.08)',
                color: 'rgba(255,255,255,0.6)',
                fontSize: 12,
                fontWeight: 600,
              }}
            >
              <Icon size={14} style={{ opacity: 0.5 }} />
              {page.name}
            </div>
          )
        })}
      </div>

      <p
        className="animate-bounce"
        style={{ fontSize: 11, color: 'rgba(255,255,255,0.3)' }}
      >
        Scroll to preview each page ↓
      </p>
    </div>
  )
}
```

- [ ] **Step 3: Verify types compile**

Run: `npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 4: Commit**

```bash
git add src/components/onboarding/onboardingMockData.ts src/components/onboarding/Step0WelcomeHero.tsx
git commit -m "feat(onboarding): add mock data constants and welcome hero component"
```

---

## Task 6: Step 0 - Page Preview and Mock Page Components

**Files:**
- Create: `src/components/onboarding/Step0PagePreview.tsx`
- Create: `src/components/onboarding/Step0MockPages.tsx`

- [ ] **Step 1: Create the page preview wrapper**

This renders a fake app shell (nav rail + topbar) around mock content with a floating description card. Create `src/components/onboarding/Step0PagePreview.tsx`:

```tsx
import { forwardRef } from 'react'
import {
  Home, Compass, MessageSquare, Database, Radio, Users,
} from 'lucide-react'
import type { PageDefinition } from './onboardingMockData'

const NAV_ICONS = [Home, Compass, MessageSquare, Database, Radio, Users]
const NAV_IDS = ['home', 'explore', 'ask', 'sources', 'signals', 'council']

interface Step0PagePreviewProps {
  page: PageDefinition
  pageIndex: number
  isLast: boolean
  onNext: () => void
  onContinueToSetup: () => void
  children: React.ReactNode
}

export const Step0PagePreview = forwardRef<HTMLDivElement, Step0PagePreviewProps>(
  function Step0PagePreview({ page, pageIndex, isLast, onNext, onContinueToSetup, children }, ref) {
    const Icon = page.icon

    return (
      <div ref={ref} className="min-h-screen flex flex-col" style={{ background: '#111' }}>
        {/* Page counter */}
        <div className="px-8 pt-5 pb-3">
          <span
            className="font-bold"
            style={{ fontSize: 10, color: 'rgba(255,255,255,0.25)', letterSpacing: 1 }}
          >
            {pageIndex + 1} / 6
          </span>
        </div>

        {/* App frame */}
        <div
          className="flex-1 flex flex-col mx-6 overflow-hidden"
          style={{
            borderRadius: '16px 16px 0 0',
            border: '1px solid rgba(255,255,255,0.08)',
            borderBottom: 'none',
            background: 'var(--color-bg-content)',
          }}
        >
          {/* Fake topbar */}
          <div
            className="flex items-center px-4 gap-3 shrink-0"
            style={{
              height: 42,
              background: 'var(--color-accent-50)',
              borderBottom: '1px solid var(--border-subtle)',
            }}
          >
            <span className="font-display font-bold text-[13px] text-[var(--color-text-primary)]">
              {page.name}
            </span>
          </div>

          {/* Nav + content */}
          <div className="flex flex-1 min-h-0">
            {/* Fake nav rail */}
            <div
              className="flex flex-col items-center py-3 gap-1 shrink-0"
              style={{
                width: 48,
                background: '#f0f0f0',
                borderRight: '1px solid var(--border-subtle)',
              }}
            >
              {NAV_ICONS.map((NavIcon, i) => (
                <div
                  key={NAV_IDS[i]}
                  className="flex items-center justify-center relative"
                  style={{
                    width: 32,
                    height: 32,
                    borderRadius: 8,
                    background: NAV_IDS[i] === page.id ? 'var(--color-accent-50)' : 'transparent',
                    color: NAV_IDS[i] === page.id ? 'var(--color-accent-500)' : 'var(--color-text-secondary)',
                  }}
                >
                  {NAV_IDS[i] === page.id && (
                    <div
                      className="absolute rounded-r-sm"
                      style={{
                        left: -8,
                        top: 6,
                        bottom: 6,
                        width: 3,
                        background: 'var(--color-accent-500)',
                      }}
                    />
                  )}
                  <NavIcon size={16} strokeWidth={1.8} />
                </div>
              ))}
            </div>

            {/* Content area with mock page + floating card */}
            <div className="flex-1 relative overflow-hidden">
              {children}

              {/* Floating description card */}
              <div
                className="absolute bg-[var(--color-bg-card)] rounded-xl"
                style={{
                  bottom: 16,
                  right: 16,
                  width: 320,
                  padding: '16px 18px',
                  border: '1px solid var(--border-subtle)',
                  boxShadow: '0 8px 32px rgba(0,0,0,0.08)',
                  zIndex: 10,
                }}
              >
                <div className="flex items-center gap-2 mb-2">
                  <div
                    className="flex items-center justify-center rounded-lg"
                    style={{
                      width: 28,
                      height: 28,
                      background: 'rgba(214,58,0,0.08)',
                    }}
                  >
                    <Icon size={14} color="var(--color-accent-500)" strokeWidth={2} />
                  </div>
                  <span className="font-display font-bold text-[13px] text-[var(--color-text-primary)]">
                    {page.name}
                  </span>
                </div>
                <p className="text-[11px] text-[var(--color-text-secondary)] leading-relaxed mb-3">
                  {page.description}
                </p>
                <div className="flex flex-wrap gap-[5px] mb-3">
                  {page.accentFeatures.map(f => (
                    <span
                      key={f}
                      className="text-[9px] font-semibold rounded-full"
                      style={{
                        padding: '2px 8px',
                        background: 'rgba(214,58,0,0.08)',
                        color: 'var(--color-accent-500)',
                        border: '1px solid rgba(214,58,0,0.1)',
                      }}
                    >
                      {f}
                    </span>
                  ))}
                  {page.features.map(f => (
                    <span
                      key={f}
                      className="text-[9px] font-semibold rounded-full"
                      style={{
                        padding: '2px 8px',
                        background: 'rgba(0,0,0,0.03)',
                        color: 'var(--color-text-secondary)',
                        border: '1px solid var(--border-subtle)',
                      }}
                    >
                      {f}
                    </span>
                  ))}
                </div>
                <button
                  onClick={isLast ? onContinueToSetup : onNext}
                  className="w-full py-[7px] rounded-full text-[12px] font-semibold text-white"
                  style={{ background: 'var(--color-accent-500)' }}
                >
                  {isLast ? 'Continue to Setup →' : 'Next →'}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    )
  }
)
```

- [ ] **Step 2: Create the mock page content components**

Create `src/components/onboarding/Step0MockPages.tsx`. This file contains 6 static mock components - one for each page preview. They use Tailwind and inline styles matching the design system.

This is a large file. Build each mock page as a named export function. Each renders the layout of its real counterpart but with hardcoded mock data from `onboardingMockData.ts`.

The mock pages should follow the exact layouts documented in the research phase:

- `MockHomePage`: Hero card (greeting, stats pills, source type badges) + two columns (recent sources list, council cards)
- `MockExplorePage`: Toolbar (Anchors/Sources/Playlists pills) + absolute-positioned bubble clusters with labels + floating detail card
- `MockAskPage`: Mode bar (Standard/Council pills) + messages (user bubble, assistant response with citations, council response cards with 4 advisors) + input bar
- `MockSourcesPage`: Split layout. Left: source list with type icons. Right: detail panel with title, meta, extracted entities pills, connected anchors, key takeaways
- `MockSignalsPage`: Split layout. Left: Anchors section (cards with scores, health badges) + Skills section (cards with domains). Right: explainer text for anchors, skills, health scoring
- `MockCouncilPage`: Split layout. Left: Advisor cards (icon, name, health badge, description, theme pills). Right: Health grid (2x2), active signals (cross-domain quotes), recent insights (type badges)

Import all data from `./onboardingMockData` and render it. Each component should be a self-contained function that takes no props.

This file will be ~500-700 lines. The implementing agent should build it page by page, referencing the visual mockup at `.superpowers/brainstorm/58029-1776373592/content/step0-walkthrough.html` for layout details.

- [ ] **Step 3: Verify types compile**

Run: `npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 4: Commit**

```bash
git add src/components/onboarding/Step0PagePreview.tsx src/components/onboarding/Step0MockPages.tsx
git commit -m "feat(onboarding): add page preview wrapper and mock page components for Step 0"
```

---

## Task 7: Step 0 - Full Walkthrough Assembly

**Files:**
- Create: `src/components/onboarding/Step0Walkthrough.tsx`
- Modify: `src/components/onboarding/OnboardingWizard.tsx`

- [ ] **Step 1: Create the walkthrough component**

Create `src/components/onboarding/Step0Walkthrough.tsx`:

```tsx
import { useRef, useCallback } from 'react'
import { Step0WelcomeHero } from './Step0WelcomeHero'
import { Step0PagePreview } from './Step0PagePreview'
import { PAGES } from './onboardingMockData'
import {
  MockHomePage,
  MockExplorePage,
  MockAskPage,
  MockSourcesPage,
  MockSignalsPage,
  MockCouncilPage,
} from './Step0MockPages'

const MOCK_COMPONENTS = [
  MockHomePage,
  MockExplorePage,
  MockAskPage,
  MockSourcesPage,
  MockSignalsPage,
  MockCouncilPage,
]

interface Step0WalkthroughProps {
  onComplete: () => void
  onSkipAll: () => void
}

export function Step0Walkthrough({ onComplete, onSkipAll }: Step0WalkthroughProps) {
  const pageRefs = useRef<Array<HTMLDivElement | null>>([])

  const scrollToPage = useCallback((index: number) => {
    pageRefs.current[index]?.scrollIntoView({ behavior: 'smooth' })
  }, [])

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto" style={{ background: '#111' }}>
      {/* Dot nav */}
      <div
        className="fixed z-50 flex flex-col gap-2"
        style={{ right: 16, top: '50%', transform: 'translateY(-50%)' }}
      >
        {['welcome', ...PAGES.map(p => p.id)].map((id, i) => (
          <button
            key={id}
            onClick={() => {
              if (i === 0) {
                window.scrollTo({ top: 0, behavior: 'smooth' })
              } else {
                scrollToPage(i - 1)
              }
            }}
            className="rounded-full transition-all"
            style={{
              width: 10,
              height: 10,
              background: 'rgba(255,255,255,0.15)',
              border: '1px solid rgba(255,255,255,0.2)',
            }}
            title={id}
          />
        ))}
      </div>

      {/* Welcome hero */}
      <Step0WelcomeHero onSkipAll={onSkipAll} />

      {/* Page previews */}
      {PAGES.map((page, i) => {
        const MockContent = MOCK_COMPONENTS[i]
        return (
          <Step0PagePreview
            key={page.id}
            ref={el => { pageRefs.current[i] = el }}
            page={page}
            pageIndex={i}
            isLast={i === PAGES.length - 1}
            onNext={() => scrollToPage(i + 1)}
            onContinueToSetup={onComplete}
          >
            <MockContent />
          </Step0PagePreview>
        )
      })}
    </div>
  )
}
```

- [ ] **Step 2: Wire Step 0 into OnboardingWizard**

Update `src/components/onboarding/OnboardingWizard.tsx` to render the actual step components. Replace the placeholder content:

```tsx
import { useState, useCallback } from 'react'
import { useSettings } from '../../hooks/useSettings'
import { Step0Walkthrough } from './Step0Walkthrough'

type OnboardingStep = 0 | 1 | 2 | 3 | 4

interface StepResult {
  step1Completed?: boolean
}

export function OnboardingWizard() {
  const { completeOnboarding, refreshProfile } = useSettings()
  const [currentStep, setCurrentStep] = useState<OnboardingStep>(0)
  const [stepResults, setStepResults] = useState<StepResult>({})

  const handleSkipAll = useCallback(async () => {
    await completeOnboarding()
    await refreshProfile()
  }, [completeOnboarding, refreshProfile])

  const handleFinish = useCallback(async () => {
    await completeOnboarding()
    await refreshProfile()
  }, [completeOnboarding, refreshProfile])

  const handleNext = useCallback((fromStep: OnboardingStep, result?: Partial<StepResult>) => {
    if (result) {
      setStepResults(prev => ({ ...prev, ...result }))
    }

    switch (fromStep) {
      case 0:
        setCurrentStep(1)
        break
      case 1:
        if (result?.step1Completed) {
          setCurrentStep(2)
        } else {
          setCurrentStep(3)
        }
        break
      case 2:
        setCurrentStep(3)
        break
      case 3:
        setCurrentStep(4)
        break
      case 4:
        handleFinish()
        break
    }
  }, [handleFinish])

  switch (currentStep) {
    case 0:
      return (
        <Step0Walkthrough
          onComplete={() => handleNext(0)}
          onSkipAll={handleSkipAll}
        />
      )
    case 1:
      // Step 1 placeholder - will be replaced in Task 8
      return (
        <div className="fixed inset-0 bg-[var(--color-bg-content)] z-50 flex items-center justify-center">
          <p>Step 1: Import History (coming next)</p>
          <button onClick={() => handleNext(1, { step1Completed: false })}>Skip</button>
        </div>
      )
    case 2:
      // Step 2 placeholder - will be replaced in Task 9
      return (
        <div className="fixed inset-0 bg-[var(--color-bg-content)] z-50 flex items-center justify-center">
          <p>Step 2: Review Profile (coming next)</p>
          <button onClick={() => handleNext(2)}>Next</button>
        </div>
      )
    case 3:
      // Step 3 placeholder - will be replaced in Task 10
      return (
        <div className="fixed inset-0 bg-[var(--color-bg-content)] z-50 flex items-center justify-center">
          <p>Step 3: Connect Meetings (coming next)</p>
          <button onClick={() => handleNext(3)}>Next</button>
        </div>
      )
    case 4:
      // Step 4 placeholder - will be replaced in Task 11
      return (
        <div className="fixed inset-0 bg-[var(--color-bg-content)] z-50 flex items-center justify-center">
          <p>Step 4: YouTube (coming next)</p>
          <button onClick={handleFinish}>Finish</button>
        </div>
      )
    default:
      return null
  }
}
```

- [ ] **Step 3: Test Step 0 in the browser**

Run: `npm run dev`

Test: Sign in. The welcome hero should appear. Scroll down to see all 6 page previews in their fake app shells. Click "Next" on each floating card to scroll to the next page. Click "Continue to Setup" on the Council page to advance to Step 1 (placeholder). Click "Skip onboarding" to exit.

- [ ] **Step 4: Commit**

```bash
git add src/components/onboarding/Step0Walkthrough.tsx src/components/onboarding/OnboardingWizard.tsx
git commit -m "feat(onboarding): assemble Step 0 walkthrough with page previews and dot nav"
```

---

## Task 8: Step 1 - Import AI History (Client UI)

**Files:**
- Create: `src/components/onboarding/Step1ImportHistory.tsx`
- Modify: `src/components/onboarding/OnboardingWizard.tsx`

- [ ] **Step 1: Create the import history component**

Create `src/components/onboarding/Step1ImportHistory.tsx`:

```tsx
import { useState, useRef, useCallback } from 'react'
import { Upload, FileText, AlertCircle, Loader2, CheckCircle2 } from 'lucide-react'
import { OnboardingStepLayout } from './OnboardingStepLayout'

type Platform = 'chatgpt' | 'claude'
type ProcessingStatus = 'idle' | 'uploading' | 'processing' | 'complete' | 'error'

interface Step1ImportHistoryProps {
  onNext: (completed: boolean) => void
  onSkipAll: () => void
}

export function Step1ImportHistory({ onNext, onSkipAll }: Step1ImportHistoryProps) {
  const [platform, setPlatform] = useState<Platform>('chatgpt')
  const [file, setFile] = useState<File | null>(null)
  const [status, setStatus] = useState<ProcessingStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const expectedFileType = platform === 'chatgpt' ? '.json' : '.zip'
  const expectedFileName = platform === 'chatgpt' ? 'conversations.json' : 'ZIP archive'

  const handleFileSelect = useCallback((selectedFile: File) => {
    setError(null)

    if (platform === 'chatgpt' && !selectedFile.name.endsWith('.json')) {
      setError('Please upload a .json file. ChatGPT exports include a conversations.json file.')
      return
    }
    if (platform === 'claude' && !selectedFile.name.endsWith('.zip')) {
      setError('Please upload the .zip file from your Claude data export.')
      return
    }
    if (selectedFile.size > 100 * 1024 * 1024) {
      setError('File is too large. Maximum size is 100MB.')
      return
    }

    setFile(selectedFile)
  }, [platform])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    const droppedFile = e.dataTransfer.files[0]
    if (droppedFile) handleFileSelect(droppedFile)
  }, [handleFileSelect])

  const handleProcess = useCallback(async () => {
    if (!file) return
    setStatus('uploading')
    setError(null)

    try {
      const formData = new FormData()
      formData.append('file', file)
      formData.append('platform', platform)

      const response = await fetch('/api/onboarding/process-export', {
        method: 'POST',
        body: formData,
      })

      if (!response.ok) {
        const data = await response.json()
        throw new Error(data.error || 'Processing failed')
      }

      setStatus('processing')

      // Poll for completion
      const { jobId } = await response.json()
      let attempts = 0
      const maxAttempts = 120 // 2 minutes max

      const poll = async (): Promise<void> => {
        const statusRes = await fetch(`/api/onboarding/process-export?jobId=${jobId}`)
        const statusData = await statusRes.json()

        if (statusData.status === 'complete') {
          setStatus('complete')
          return
        }
        if (statusData.status === 'error') {
          throw new Error(statusData.error || 'Processing failed')
        }

        attempts++
        if (attempts >= maxAttempts) {
          throw new Error('Processing timed out. Please try again.')
        }

        await new Promise(resolve => setTimeout(resolve, 1000))
        return poll()
      }

      await poll()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
      setStatus('error')
    }
  }, [file, platform])

  const INSTRUCTIONS = {
    chatgpt: [
      { step: 1, text: 'Go to Settings → Data Controls → Export Data' },
      { step: 2, text: 'Click "Export" and wait for the email from OpenAI' },
      { step: 3, text: 'Download the ZIP file from the email link' },
      { step: 4, text: 'Upload the conversations.json file from inside the ZIP' },
    ],
    claude: [
      { step: 1, text: 'Go to Settings → Account → Export Data' },
      { step: 2, text: 'Click "Export" and wait for the download to be ready' },
      { step: 3, text: 'Download the ZIP file' },
      { step: 4, text: 'Upload the ZIP file directly (Synapse will extract the conversations)' },
    ],
  }

  return (
    <OnboardingStepLayout
      stepNumber={1}
      totalSteps={4}
      title="Import Your AI History"
      subtitle="Upload your ChatGPT or Claude conversation export. Synapse will analyze your conversations to build a profile of your interests and seed your knowledge graph."
      maxWidth={600}
      onSkipAll={onSkipAll}
      onSkip={() => onNext(false)}
      onNext={status === 'complete' ? () => onNext(true) : handleProcess}
      nextLabel={status === 'complete' ? 'Continue →' : status === 'processing' ? 'Processing...' : 'Process & Continue'}
      nextDisabled={(!file && status !== 'complete') || status === 'uploading' || status === 'processing'}
    >
      {/* Platform tabs */}
      <div className="flex gap-0 mb-5 border-b border-[var(--border-subtle)]">
        {(['chatgpt', 'claude'] as const).map(p => (
          <button
            key={p}
            onClick={() => { setPlatform(p); setFile(null); setError(null); setStatus('idle') }}
            className="pb-2 px-4 text-[12px] font-semibold transition-colors"
            style={{
              color: platform === p ? 'var(--color-accent-500)' : 'var(--color-text-secondary)',
              borderBottom: platform === p ? '2px solid var(--color-accent-500)' : '2px solid transparent',
            }}
          >
            {p === 'chatgpt' ? 'ChatGPT' : 'Claude'}
          </button>
        ))}
      </div>

      {/* Instructions */}
      <div className="mb-5">
        <p className="text-[12px] font-semibold text-[var(--color-text-primary)] mb-2">
          How to export from {platform === 'chatgpt' ? 'ChatGPT' : 'Claude'}:
        </p>
        <div className="flex flex-col gap-0">
          {INSTRUCTIONS[platform].map(({ step, text }) => (
            <div
              key={step}
              className="flex items-start gap-2.5 py-2 border-b border-[var(--border-subtle)]"
            >
              <div
                className="flex items-center justify-center rounded-full shrink-0 mt-0.5"
                style={{
                  width: 20,
                  height: 20,
                  background: 'var(--color-accent-50)',
                  color: 'var(--color-accent-500)',
                  fontSize: 10,
                  fontWeight: 700,
                }}
              >
                {step}
              </div>
              <span className="text-[12px] text-[var(--color-text-body)] leading-relaxed">
                {text}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Drop zone */}
      {status === 'complete' ? (
        <div
          className="flex items-center gap-3 rounded-xl p-4"
          style={{ background: '#f0fdf4', border: '1px solid rgba(22,163,106,0.15)' }}
        >
          <CheckCircle2 size={20} color="#16a34a" />
          <div>
            <p className="text-[12px] font-semibold text-[#16a34a]">Processing complete</p>
            <p className="text-[11px] text-[var(--color-text-secondary)]">
              Your profile and initial knowledge graph have been created.
            </p>
          </div>
        </div>
      ) : status === 'processing' || status === 'uploading' ? (
        <div
          className="flex items-center gap-3 rounded-xl p-4"
          style={{ background: 'var(--color-accent-50)', border: '1px solid rgba(214,58,0,0.1)' }}
        >
          <Loader2 size={20} color="var(--color-accent-500)" className="animate-spin" />
          <div>
            <p className="text-[12px] font-semibold text-[var(--color-accent-500)]">
              {status === 'uploading' ? 'Uploading...' : 'Analyzing your conversations...'}
            </p>
            <p className="text-[11px] text-[var(--color-text-secondary)]">
              This may take a minute or two depending on your export size.
            </p>
          </div>
        </div>
      ) : (
        <div
          className="rounded-xl p-6 text-center cursor-pointer"
          style={{
            border: '2px dashed var(--border-default)',
            background: file ? 'var(--color-accent-50)' : 'transparent',
          }}
          onClick={() => fileInputRef.current?.click()}
          onDragOver={e => e.preventDefault()}
          onDrop={handleDrop}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept={expectedFileType}
            className="hidden"
            onChange={e => {
              const f = e.target.files?.[0]
              if (f) handleFileSelect(f)
            }}
          />
          {file ? (
            <div className="flex items-center justify-center gap-2">
              <FileText size={18} color="var(--color-accent-500)" />
              <span className="text-[13px] font-semibold text-[var(--color-text-primary)]">
                {file.name}
              </span>
              <span className="text-[11px] text-[var(--color-text-secondary)]">
                ({(file.size / (1024 * 1024)).toFixed(1)} MB)
              </span>
            </div>
          ) : (
            <>
              <Upload size={24} color="var(--color-text-secondary)" className="mx-auto mb-2 opacity-50" />
              <p className="text-[13px] font-semibold text-[var(--color-text-primary)]">
                Drop {expectedFileName} here
              </p>
              <p className="text-[11px] text-[var(--color-text-secondary)] mt-1">
                or click to browse files
              </p>
            </>
          )}
        </div>
      )}

      {/* Error */}
      {error && (
        <div
          className="flex items-start gap-2 mt-3 rounded-lg p-3"
          style={{ background: '#fef2f2', border: '1px solid rgba(220,38,38,0.1)' }}
        >
          <AlertCircle size={14} color="#dc2626" className="mt-0.5 shrink-0" />
          <p className="text-[11px] text-[#dc2626] leading-relaxed">{error}</p>
        </div>
      )}

      {/* Privacy note */}
      <div
        className="mt-4 rounded-lg p-3"
        style={{ background: '#fffbf5', borderLeft: '3px solid var(--color-accent-500)' }}
      >
        <p className="text-[11px] text-[var(--color-text-body)] leading-relaxed">
          <strong>Privacy:</strong> Your raw conversations are never stored. Synapse only extracts
          topics, patterns, and entities to build your profile and seed your knowledge graph.
        </p>
      </div>
    </OnboardingStepLayout>
  )
}
```

- [ ] **Step 2: Wire Step 1 into OnboardingWizard**

In `src/components/onboarding/OnboardingWizard.tsx`, add the import and replace the Step 1 placeholder:

```tsx
import { Step1ImportHistory } from './Step1ImportHistory'

// In the switch statement, replace case 1:
case 1:
  return (
    <Step1ImportHistory
      onNext={(completed) => handleNext(1, { step1Completed: completed })}
      onSkipAll={handleSkipAll}
    />
  )
```

- [ ] **Step 3: Verify types compile and test in browser**

Run: `npx tsc --noEmit && npm run dev`

Test: Navigate through Step 0 to Step 1. Verify the tab switching between ChatGPT/Claude works, file drop zone is interactive, skip advances past Step 2.

- [ ] **Step 4: Commit**

```bash
git add src/components/onboarding/Step1ImportHistory.tsx src/components/onboarding/OnboardingWizard.tsx
git commit -m "feat(onboarding): add Step 1 import AI history UI with file upload and platform tabs"
```

---

## Task 9: Step 2 - Review Profile

**Files:**
- Create: `src/components/onboarding/Step2ReviewProfile.tsx`
- Modify: `src/components/onboarding/OnboardingWizard.tsx`

- [ ] **Step 1: Create the review profile component**

Create `src/components/onboarding/Step2ReviewProfile.tsx`:

```tsx
import { useState, useCallback } from 'react'
import { X } from 'lucide-react'
import { OnboardingStepLayout } from './OnboardingStepLayout'
import { useSettings } from '../../hooks/useSettings'

interface DetectedAnchor {
  label: string
  mentionCount: number
  enabled: boolean
}

interface Step2ReviewProfileProps {
  onNext: () => void
  onSkipAll: () => void
}

export function Step2ReviewProfile({ onNext, onSkipAll }: Step2ReviewProfileProps) {
  const { profile, updateProfile } = useSettings()

  const [professionalContext, setProfessionalContext] = useState(
    profile?.professional_context?.role || ''
  )
  const [interests, setInterests] = useState<string[]>(
    profile?.personal_interests?.topics
      ? profile.personal_interests.topics.split(',').map(s => s.trim()).filter(Boolean)
      : []
  )
  const [newInterest, setNewInterest] = useState('')
  const [anchors, setAnchors] = useState<DetectedAnchor[]>([])
  const [saving, setSaving] = useState(false)

  // TODO: Load detected anchors from the processing result
  // For now, anchors will be populated by the process-export API response

  const addInterest = useCallback(() => {
    const trimmed = newInterest.trim()
    if (trimmed && !interests.includes(trimmed)) {
      setInterests(prev => [...prev, trimmed])
      setNewInterest('')
    }
  }, [newInterest, interests])

  const removeInterest = useCallback((interest: string) => {
    setInterests(prev => prev.filter(i => i !== interest))
  }, [])

  const toggleAnchor = useCallback((index: number) => {
    setAnchors(prev => prev.map((a, i) =>
      i === index ? { ...a, enabled: !a.enabled } : a
    ))
  }, [])

  const handleSave = useCallback(async () => {
    setSaving(true)
    await updateProfile({
      professional_context: { ...profile?.professional_context, role: professionalContext },
      personal_interests: { ...profile?.personal_interests, topics: interests.join(', ') },
    })
    setSaving(false)
    onNext()
  }, [professionalContext, interests, profile, updateProfile, onNext])

  return (
    <OnboardingStepLayout
      stepNumber={2}
      totalSteps={4}
      title="Here's what we learned about you"
      subtitle="Based on your conversation history, we've built a profile and identified your key focus areas. Adjust anything that doesn't look right."
      maxWidth={700}
      onSkipAll={onSkipAll}
      onSkip={onNext}
      onNext={handleSave}
      nextLabel={saving ? 'Saving...' : 'Looks Good →'}
      skipLabel="Skip"
      nextDisabled={saving}
    >
      <div className="grid grid-cols-2 gap-5">
        {/* Left: Profile */}
        <div>
          <label className="block text-[12px] font-semibold text-[var(--color-text-primary)] mb-2">
            Professional Context
          </label>
          <textarea
            value={professionalContext}
            onChange={e => setProfessionalContext(e.target.value)}
            rows={4}
            className="w-full rounded-lg p-3 text-[12px] text-[var(--color-text-body)] leading-relaxed resize-none font-body"
            style={{
              background: 'var(--color-bg-inset)',
              border: '1px solid var(--border-subtle)',
            }}
          />

          <label className="block text-[12px] font-semibold text-[var(--color-text-primary)] mb-2 mt-4">
            Interests
          </label>
          <div className="flex flex-wrap gap-1.5 mb-2">
            {interests.map(interest => (
              <span
                key={interest}
                className="flex items-center gap-1 rounded-full text-[10px] font-semibold"
                style={{
                  padding: '3px 8px 3px 10px',
                  background: 'var(--color-accent-50)',
                  color: 'var(--color-accent-500)',
                  border: '1px solid rgba(214,58,0,0.1)',
                }}
              >
                {interest}
                <button onClick={() => removeInterest(interest)} className="opacity-60 hover:opacity-100">
                  <X size={10} />
                </button>
              </span>
            ))}
          </div>
          <div className="flex gap-2">
            <input
              value={newInterest}
              onChange={e => setNewInterest(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') addInterest() }}
              placeholder="Add interest..."
              className="flex-1 rounded-lg px-3 py-1.5 text-[11px] font-body"
              style={{
                background: 'var(--color-bg-inset)',
                border: '1px solid var(--border-subtle)',
                color: 'var(--color-text-body)',
              }}
            />
            <button
              onClick={addInterest}
              className="px-3 py-1.5 rounded-lg text-[11px] font-semibold"
              style={{
                background: 'var(--color-accent-50)',
                color: 'var(--color-accent-500)',
                border: '1px solid rgba(214,58,0,0.1)',
              }}
            >
              Add
            </button>
          </div>
        </div>

        {/* Right: Anchors */}
        <div>
          <label className="block text-[12px] font-semibold text-[var(--color-text-primary)] mb-2">
            Detected Anchors (Focus Areas)
          </label>
          <div className="flex flex-col gap-1.5">
            {anchors.length > 0 ? anchors.map((anchor, i) => (
              <label
                key={anchor.label}
                className="flex items-center gap-2 rounded-lg p-2 cursor-pointer"
                style={{
                  background: anchor.enabled ? 'var(--color-bg-card)' : 'transparent',
                  border: `1px solid ${anchor.enabled ? 'var(--border-default)' : 'var(--border-subtle)'}`,
                  opacity: anchor.enabled ? 1 : 0.5,
                }}
              >
                <input
                  type="checkbox"
                  checked={anchor.enabled}
                  onChange={() => toggleAnchor(i)}
                  className="accent-[var(--color-accent-500)]"
                />
                <span className="text-[11px] font-semibold text-[var(--color-text-primary)] flex-1">
                  {anchor.label}
                </span>
                <span className="text-[10px] text-[var(--color-text-secondary)]">
                  {anchor.mentionCount} mentions
                </span>
              </label>
            )) : (
              <p className="text-[11px] text-[var(--color-text-secondary)] italic py-4">
                Anchors will appear here after your conversations are processed.
              </p>
            )}
          </div>

          <div
            className="mt-3 rounded-lg p-3"
            style={{
              background: '#fffbf5',
              borderLeft: '3px solid var(--color-accent-500)',
            }}
          >
            <p className="text-[11px] text-[var(--color-text-body)] leading-relaxed">
              Anchors are your key focus areas. They organize your knowledge graph.
              You can always change these later in Settings.
            </p>
          </div>
        </div>
      </div>
    </OnboardingStepLayout>
  )
}
```

- [ ] **Step 2: Wire Step 2 into OnboardingWizard**

In `src/components/onboarding/OnboardingWizard.tsx`, add the import and replace the Step 2 placeholder:

```tsx
import { Step2ReviewProfile } from './Step2ReviewProfile'

// In the switch statement, replace case 2:
case 2:
  return (
    <Step2ReviewProfile
      onNext={() => handleNext(2)}
      onSkipAll={handleSkipAll}
    />
  )
```

- [ ] **Step 3: Verify types compile**

Run: `npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 4: Commit**

```bash
git add src/components/onboarding/Step2ReviewProfile.tsx src/components/onboarding/OnboardingWizard.tsx
git commit -m "feat(onboarding): add Step 2 review profile with editable fields and anchor toggles"
```

---

## Task 10: Step 3 - Connect Meeting Services

**Files:**
- Create: `src/components/onboarding/Step3ConnectMeetings.tsx`
- Modify: `src/components/onboarding/OnboardingWizard.tsx`

- [ ] **Step 1: Create the connect meetings component**

Create `src/components/onboarding/Step3ConnectMeetings.tsx`:

```tsx
import { useState, useCallback } from 'react'
import { CheckCircle2 } from 'lucide-react'
import { OnboardingStepLayout } from './OnboardingStepLayout'
import { connectMicrosoft } from '../../services/microsoft'

interface IntegrationState {
  microsoft: 'idle' | 'connecting' | 'connected' | 'error'
  circleback: 'idle' | 'connected'
}

interface Step3ConnectMeetingsProps {
  onNext: () => void
  onSkipAll: () => void
}

export function Step3ConnectMeetings({ onNext, onSkipAll }: Step3ConnectMeetingsProps) {
  const [state, setState] = useState<IntegrationState>({
    microsoft: 'idle',
    circleback: 'idle',
  })

  const handleConnectMicrosoft = useCallback(async () => {
    setState(prev => ({ ...prev, microsoft: 'connecting' }))
    try {
      const authUrl = await connectMicrosoft()
      // OAuth redirect - user will come back after auth
      window.location.href = authUrl
    } catch {
      setState(prev => ({ ...prev, microsoft: 'error' }))
    }
  }, [])

  const INTEGRATIONS = [
    {
      id: 'microsoft' as const,
      name: 'Microsoft 365',
      description: 'Calendar events and Teams meeting transcripts',
      iconBg: '#e3f2fd',
      icon: '📅',
      connectedNote: 'Calendar events and Teams transcripts will be ingested automatically.',
    },
    {
      id: 'circleback' as const,
      name: 'Circleback',
      description: 'Meeting transcripts via webhook',
      iconBg: '#f3e8ff',
      icon: '🎙',
      connectedNote: 'Meeting transcripts will be ingested automatically via webhook.',
    },
  ]

  return (
    <OnboardingStepLayout
      stepNumber={3}
      totalSteps={4}
      title="Connect Meeting Services"
      subtitle="Connect your meeting tools and Synapse will automatically ingest transcripts, extract entities, and add them to your knowledge graph."
      maxWidth={550}
      onSkipAll={onSkipAll}
      onSkip={onNext}
      onNext={onNext}
      nextLabel="Continue →"
    >
      <div className="flex flex-col gap-2">
        {INTEGRATIONS.map(integration => {
          const integrationState = state[integration.id]
          const isConnected = integrationState === 'connected'

          return (
            <div
              key={integration.id}
              className="flex items-center gap-3 rounded-xl"
              style={{
                padding: '14px 16px',
                background: 'var(--color-bg-card)',
                border: `1px solid ${isConnected ? 'rgba(22,163,106,0.15)' : 'var(--border-subtle)'}`,
              }}
            >
              <div
                className="flex items-center justify-center rounded-lg shrink-0"
                style={{
                  width: 36,
                  height: 36,
                  background: integration.iconBg,
                  fontSize: 18,
                }}
              >
                {integration.icon}
              </div>
              <div className="flex-1">
                <p className="text-[13px] font-semibold text-[var(--color-text-primary)]">
                  {integration.name}
                </p>
                <p className="text-[11px] text-[var(--color-text-secondary)]">
                  {isConnected ? integration.connectedNote : integration.description}
                </p>
              </div>
              {isConnected ? (
                <div
                  className="flex items-center gap-1.5 rounded-full px-3 py-1.5"
                  style={{ background: '#e8f5e9' }}
                >
                  <CheckCircle2 size={12} color="#2e7d32" />
                  <span className="text-[11px] font-semibold" style={{ color: '#2e7d32' }}>
                    Connected
                  </span>
                </div>
              ) : (
                <button
                  onClick={integration.id === 'microsoft' ? handleConnectMicrosoft : undefined}
                  disabled={integrationState === 'connecting'}
                  className="rounded-full px-4 py-1.5 text-[11px] font-semibold text-white"
                  style={{ background: 'var(--color-accent-500)' }}
                >
                  {integrationState === 'connecting' ? 'Connecting...' : 'Connect'}
                </button>
              )}
            </div>
          )
        })}
      </div>
    </OnboardingStepLayout>
  )
}
```

- [ ] **Step 2: Wire Step 3 into OnboardingWizard**

In `src/components/onboarding/OnboardingWizard.tsx`, add the import and replace the Step 3 placeholder:

```tsx
import { Step3ConnectMeetings } from './Step3ConnectMeetings'

// In the switch statement, replace case 3:
case 3:
  return (
    <Step3ConnectMeetings
      onNext={() => handleNext(3)}
      onSkipAll={handleSkipAll}
    />
  )
```

- [ ] **Step 3: Verify types compile**

Run: `npx tsc --noEmit`
Expected: No type errors (if `connectMicrosoft` import path is wrong, check `src/services/microsoft.ts` for the actual export name and adjust)

- [ ] **Step 4: Commit**

```bash
git add src/components/onboarding/Step3ConnectMeetings.tsx src/components/onboarding/OnboardingWizard.tsx
git commit -m "feat(onboarding): add Step 3 connect meeting services with Microsoft 365 and Circleback"
```

---

## Task 11: Step 4 - Connect YouTube Playlist

**Files:**
- Create: `src/components/onboarding/Step4ConnectYouTube.tsx`
- Modify: `src/components/onboarding/OnboardingWizard.tsx`

- [ ] **Step 1: Create the YouTube playlist component**

Create `src/components/onboarding/Step4ConnectYouTube.tsx`:

```tsx
import { useState, useCallback } from 'react'
import { AlertCircle, CheckCircle2, Loader2 } from 'lucide-react'
import { OnboardingStepLayout } from './OnboardingStepLayout'
import { useAuth } from '../../hooks/useAuth'

interface PlaylistPreview {
  name: string
  videoCount: number
  playlistId: string
}

interface Step4ConnectYouTubeProps {
  onFinish: () => void
  onSkipAll: () => void
}

export function Step4ConnectYouTube({ onFinish, onSkipAll }: Step4ConnectYouTubeProps) {
  const { user } = useAuth()
  const [url, setUrl] = useState('')
  const [preview, setPreview] = useState<PlaylistPreview | null>(null)
  const [fetching, setFetching] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleFetch = useCallback(async () => {
    if (!url.trim()) return
    setFetching(true)
    setError(null)
    setPreview(null)

    try {
      // Extract playlist ID from URL
      const match = url.match(/[?&]list=([a-zA-Z0-9_-]+)/)
      const playlistId = match?.[1] || (url.startsWith('PL') ? url : null)

      if (!playlistId) {
        throw new Error('Could not find a playlist ID in that URL. Make sure it contains a ?list= parameter.')
      }

      // Fetch playlist metadata
      const res = await fetch(`/api/youtube/playlist-metadata?playlistId=${playlistId}`)
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || 'Could not fetch playlist. Make sure it is public.')
      }

      const data = await res.json()
      setPreview({
        name: data.title || 'Untitled Playlist',
        videoCount: data.videoCount || 0,
        playlistId,
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch playlist')
    } finally {
      setFetching(false)
    }
  }, [url])

  const handleConnect = useCallback(async () => {
    if (!preview || !user) return
    setConnecting(true)
    setError(null)

    try {
      const res = await fetch('/api/youtube/connect-playlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: user.id,
          playlistId: preview.playlistId,
          playlistUrl: url,
          name: preview.name,
          videoCount: preview.videoCount,
          maxVideos: 25,
        }),
      })

      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || 'Failed to connect playlist')
      }

      onFinish()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
      setConnecting(false)
    }
  }, [preview, user, url, onFinish])

  return (
    <OnboardingStepLayout
      stepNumber={4}
      totalSteps={4}
      title="Connect a YouTube Playlist"
      subtitle="Paste a YouTube playlist URL and Synapse will extract transcripts, identify entities, and connect concepts across videos."
      maxWidth={550}
      onSkipAll={onSkipAll}
      onSkip={onFinish}
      onNext={preview ? handleConnect : handleFetch}
      nextLabel={
        connecting ? 'Connecting...' :
        preview ? 'Start Processing & Finish Setup →' :
        fetching ? 'Fetching...' :
        'Fetch Playlist'
      }
      nextDisabled={(!url.trim() && !preview) || fetching || connecting}
      skipLabel="Skip for now"
    >
      {/* Public playlist note */}
      <div
        className="rounded-lg p-3 mb-4"
        style={{
          background: '#fffbf5',
          borderLeft: '3px solid var(--color-accent-500)',
        }}
      >
        <p className="text-[11px] text-[var(--color-text-body)] leading-relaxed">
          The playlist must be <strong>public</strong> so Synapse can access it.
        </p>
      </div>

      {/* URL input */}
      <div className="flex gap-2 mb-4">
        <input
          value={url}
          onChange={e => { setUrl(e.target.value); setPreview(null); setError(null) }}
          onKeyDown={e => { if (e.key === 'Enter') handleFetch() }}
          placeholder="https://youtube.com/playlist?list=..."
          className="flex-1 rounded-xl px-3.5 py-2.5 text-[12px] font-body"
          style={{
            background: 'var(--color-bg-inset)',
            border: '1px solid var(--border-default)',
            color: 'var(--color-text-body)',
          }}
          disabled={!!preview}
        />
        {preview && (
          <button
            onClick={() => { setPreview(null); setUrl('') }}
            className="rounded-xl px-3 py-2 text-[11px] font-semibold"
            style={{
              border: '1px solid var(--border-default)',
              color: 'var(--color-text-secondary)',
            }}
          >
            Clear
          </button>
        )}
      </div>

      {/* Playlist preview */}
      {preview && (
        <div
          className="rounded-xl p-4 mb-4"
          style={{
            background: 'var(--color-bg-inset)',
            border: '1px solid var(--border-subtle)',
          }}
        >
          <div className="flex items-center gap-2 mb-1">
            <CheckCircle2 size={14} color="#16a34a" />
            <p className="text-[13px] font-semibold text-[var(--color-text-primary)]">
              {preview.name}
            </p>
          </div>
          <p className="text-[11px] text-[var(--color-text-secondary)] mb-3">
            {preview.videoCount} videos
          </p>

          {preview.videoCount > 25 ? (
            <div
              className="rounded-lg p-2.5"
              style={{ background: 'var(--color-accent-50)' }}
            >
              <p className="text-[11px] text-[var(--color-text-body)]">
                The first <strong>25 videos</strong> will be processed. New videos you add to this
                playlist will be ingested automatically going forward.
              </p>
            </div>
          ) : preview.videoCount === 0 ? (
            <div
              className="rounded-lg p-2.5"
              style={{ background: 'var(--color-accent-50)' }}
            >
              <p className="text-[11px] text-[var(--color-text-body)]">
                This playlist is empty. That's fine! Any videos you add to it will be automatically
                ingested into Synapse.
              </p>
            </div>
          ) : (
            <div
              className="rounded-lg p-2.5"
              style={{ background: 'var(--color-accent-50)' }}
            >
              <p className="text-[11px] text-[var(--color-text-body)]">
                All <strong>{preview.videoCount} videos</strong> will be processed. New videos you
                add will be ingested automatically.
              </p>
            </div>
          )}
        </div>
      )}

      {/* Fetching state */}
      {fetching && (
        <div className="flex items-center gap-2 mb-4">
          <Loader2 size={14} className="animate-spin" color="var(--color-accent-500)" />
          <span className="text-[11px] text-[var(--color-text-secondary)]">Fetching playlist info...</span>
        </div>
      )}

      {/* Error */}
      {error && (
        <div
          className="flex items-start gap-2 rounded-lg p-3 mb-4"
          style={{ background: '#fef2f2', border: '1px solid rgba(220,38,38,0.1)' }}
        >
          <AlertCircle size={14} color="#dc2626" className="mt-0.5 shrink-0" />
          <p className="text-[11px] text-[#dc2626] leading-relaxed">{error}</p>
        </div>
      )}

      {/* Processing note */}
      {preview && preview.videoCount > 0 && (
        <p className="text-[11px] text-[var(--color-text-secondary)] leading-relaxed">
          Processing takes about 30-60 seconds per video. This runs in the background -
          you can start using Synapse while it works.
        </p>
      )}
    </OnboardingStepLayout>
  )
}
```

- [ ] **Step 2: Wire Step 4 into OnboardingWizard**

In `src/components/onboarding/OnboardingWizard.tsx`, add the import and replace the Step 4 placeholder:

```tsx
import { Step4ConnectYouTube } from './Step4ConnectYouTube'

// In the switch statement, replace case 4:
case 4:
  return (
    <Step4ConnectYouTube
      onFinish={() => handleNext(4)}
      onSkipAll={handleSkipAll}
    />
  )
```

- [ ] **Step 3: Verify types compile**

Run: `npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 4: Commit**

```bash
git add src/components/onboarding/Step4ConnectYouTube.tsx src/components/onboarding/OnboardingWizard.tsx
git commit -m "feat(onboarding): add Step 4 YouTube playlist connection with preview and 25-video cap"
```

---

## Task 12: Serverless Function - Process AI Export

**Files:**
- Create: `api/onboarding/process-export.ts`

- [ ] **Step 1: Create the serverless function**

Create `api/onboarding/process-export.ts`. This function handles file upload, parses ChatGPT/Claude exports, sends batches to Gemini, and writes profile + entities to Supabase.

**CRITICAL:** This is a Vercel serverless function. No shared local imports. All helpers inline. npm packages are fine.

```typescript
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createClient } from '@supabase/supabase-js'
import { IncomingForm } from 'formidable'
import fs from 'fs'

const supabase = createClient(
  process.env.VITE_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const GEMINI_API_KEY = process.env.VITE_GEMINI_API_KEY!
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`

export const config = {
  api: { bodyParser: false },
}

// --- Inline helpers (no shared imports in Vercel functions) ---

interface ParsedConversation {
  title: string
  messages: string[]
}

function parseChatGPTExport(jsonStr: string): ParsedConversation[] {
  const data = JSON.parse(jsonStr)
  if (!Array.isArray(data)) throw new Error('Invalid ChatGPT export: expected an array')

  return data.slice(0, 200).map((conv: Record<string, unknown>) => {
    const messages: string[] = []
    const mapping = conv.mapping as Record<string, { message?: { content?: { parts?: string[] }; author?: { role?: string } } }> | undefined
    if (mapping) {
      for (const node of Object.values(mapping)) {
        if (node.message?.author?.role === 'user' || node.message?.author?.role === 'assistant') {
          const parts = node.message.content?.parts
          if (parts) messages.push(parts.join(' '))
        }
      }
    }
    return { title: (conv.title as string) || 'Untitled', messages }
  })
}

function parseClaudeExport(zipBuffer: Buffer): ParsedConversation[] {
  // Claude exports are ZIP files with individual JSON conversation files
  // Use a lightweight ZIP parser
  const JSZip = require('jszip')
  // This will be async but we handle it in the main function
  throw new Error('Claude export parsing requires async JSZip - handled in main flow')
}

async function parseClaudeExportAsync(zipBuffer: Buffer): Promise<ParsedConversation[]> {
  const JSZip = require('jszip')
  const zip = await JSZip.loadAsync(zipBuffer)
  const conversations: ParsedConversation[] = []

  const files = Object.keys(zip.files).filter(f => f.endsWith('.json')).slice(0, 200)
  for (const filename of files) {
    try {
      const content = await zip.files[filename].async('string')
      const data = JSON.parse(content)
      const messages: string[] = []

      if (Array.isArray(data.chat_messages)) {
        for (const msg of data.chat_messages) {
          if (msg.text && (msg.sender === 'human' || msg.sender === 'assistant')) {
            messages.push(msg.text)
          }
        }
      }

      conversations.push({ title: data.name || filename, messages })
    } catch {
      // Skip malformed files
    }
  }

  return conversations
}

async function analyzeWithGemini(conversationTexts: string[]): Promise<{
  professionalContext: string
  interests: string[]
  entities: Array<{ label: string; type: string; mentionCount: number }>
  candidateAnchors: Array<{ label: string; mentionCount: number }>
}> {
  // Combine conversation texts, truncating to stay within token limits (~100k chars)
  const combined = conversationTexts.join('\n\n---\n\n').slice(0, 100000)

  const response = await fetch(GEMINI_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: `Analyze the following conversation history from an AI assistant. Extract:

1. **Professional Context**: A 2-3 sentence summary of who this person is professionally - their role, industry, key responsibilities, and expertise areas.
2. **Interests**: A list of 5-15 recurring topics/interests (just the topic names, no descriptions).
3. **Key Entities**: People, organizations, technologies, projects, and concepts that appear frequently. For each, provide: label, type (Person/Organization/Technology/Project/Topic/Concept), and approximate mention count.
4. **Candidate Anchors**: The 5-10 most prominent focus areas that would serve as organizing clusters for a knowledge graph.

Respond in JSON format:
{
  "professionalContext": "string",
  "interests": ["string"],
  "entities": [{"label": "string", "type": "string", "mentionCount": number}],
  "candidateAnchors": [{"label": "string", "mentionCount": number}]
}

Conversation history:
${combined}` }] }],
      generationConfig: {
        temperature: 0.2,
        responseMimeType: 'application/json',
      },
    }),
  })

  if (!response.ok) {
    throw new Error(`Gemini API error: ${response.status}`)
  }

  const result = await response.json()
  const text = result.candidates?.[0]?.content?.parts?.[0]?.text
  if (!text) throw new Error('Empty Gemini response')

  return JSON.parse(text)
}

// --- Main handler ---

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'GET') {
    // Poll for job status (simplified: processing is synchronous for now)
    const { jobId } = req.query
    return res.json({ status: 'complete', jobId })
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  try {
    // Parse multipart form
    const form = new IncomingForm({ maxFileSize: 100 * 1024 * 1024 })
    const { fields, files } = await new Promise<{ fields: Record<string, unknown>; files: Record<string, unknown> }>((resolve, reject) => {
      form.parse(req, (err, fields, files) => {
        if (err) reject(err)
        else resolve({ fields, files })
      })
    })

    const platform = (Array.isArray(fields.platform) ? fields.platform[0] : fields.platform) as string
    const uploadedFile = Array.isArray(files.file) ? files.file[0] : files.file
    if (!uploadedFile || !('filepath' in uploadedFile)) {
      return res.status(400).json({ error: 'No file uploaded' })
    }

    const fileBuffer = fs.readFileSync((uploadedFile as { filepath: string }).filepath)

    // Parse based on platform
    let conversations: ParsedConversation[]
    if (platform === 'chatgpt') {
      conversations = parseChatGPTExport(fileBuffer.toString('utf-8'))
    } else if (platform === 'claude') {
      conversations = await parseClaudeExportAsync(fileBuffer)
    } else {
      return res.status(400).json({ error: 'Invalid platform. Use "chatgpt" or "claude".' })
    }

    if (conversations.length === 0) {
      return res.status(400).json({ error: 'No conversations found in the export file.' })
    }

    // Flatten messages for analysis
    const allTexts = conversations.flatMap(c =>
      c.messages.length > 0 ? [`[${c.title}]\n${c.messages.join('\n')}`] : []
    )

    // Analyze with Gemini
    const analysis = await analyzeWithGemini(allTexts)

    // Get user from auth header
    const authHeader = req.headers.authorization
    if (!authHeader) {
      return res.status(401).json({ error: 'Not authenticated' })
    }

    const { data: { user }, error: authError } = await supabase.auth.getUser(
      authHeader.replace('Bearer ', '')
    )
    if (authError || !user) {
      return res.status(401).json({ error: 'Invalid auth token' })
    }

    // Update user profile
    await supabase
      .from('user_profiles')
      .update({
        professional_context: { role: analysis.professionalContext },
        personal_interests: { topics: analysis.interests.join(', ') },
        updated_at: new Date().toISOString(),
      })
      .eq('user_id', user.id)

    // Create entity nodes (batch insert)
    const entityRows = analysis.entities.slice(0, 100).map(entity => ({
      user_id: user.id,
      label: entity.label,
      entity_type: entity.type,
      is_anchor: false,
      mention_count: entity.mentionCount,
    }))

    if (entityRows.length > 0) {
      await supabase.from('knowledge_nodes').insert(entityRows)
    }

    // Create anchor nodes
    const anchorRows = analysis.candidateAnchors.map(anchor => ({
      user_id: user.id,
      label: anchor.label,
      entity_type: 'Anchor',
      is_anchor: true,
      mention_count: anchor.mentionCount,
    }))

    if (anchorRows.length > 0) {
      await supabase.from('knowledge_nodes').insert(anchorRows)
    }

    return res.json({
      status: 'complete',
      jobId: 'sync-' + Date.now(),
      summary: {
        professionalContext: analysis.professionalContext,
        interests: analysis.interests,
        entityCount: analysis.entities.length,
        anchorCount: analysis.candidateAnchors.length,
      },
    })
  } catch (err) {
    console.error('Process export error:', err)
    return res.status(500).json({
      error: err instanceof Error ? err.message : 'Processing failed',
    })
  }
}
```

- [ ] **Step 2: Install formidable if not already present**

Run: `npm ls formidable 2>/dev/null || npm install formidable && npm install -D @types/formidable`

Check if `jszip` is installed: `npm ls jszip 2>/dev/null || npm install jszip`

- [ ] **Step 3: Verify the function builds**

Run: `npx tsc --noEmit`

If there are type errors from the serverless function (common with Vercel functions), they may need `// @ts-nocheck` at the top or targeted type assertions. Fix as needed.

- [ ] **Step 4: Commit**

```bash
git add api/onboarding/process-export.ts package.json package-lock.json
git commit -m "feat(onboarding): add serverless function for processing AI conversation exports"
```

---

## Task 13: Settings - Replay Onboarding Button

**Files:**
- Modify: Settings view component (find the correct file)

- [ ] **Step 1: Find the Settings view**

Search for the settings component that renders the profile/account section. It's likely in `src/components/settings/` or referenced from a settings modal.

- [ ] **Step 2: Add the replay button**

Add a section or button to the settings UI:

```tsx
const { resetOnboarding } = useSettings()

const handleReplayOnboarding = useCallback(async () => {
  await resetOnboarding()
  // The OnboardingGate in App.tsx will automatically show the wizard
  // when profile.onboarding_complete becomes false
}, [resetOnboarding])

// In the render, add a button in an appropriate section:
<button
  onClick={handleReplayOnboarding}
  className="px-4 py-2 rounded-full text-[12px] font-semibold border border-[var(--border-default)] text-[var(--color-text-secondary)] hover:border-[var(--border-strong)] transition-colors"
>
  Replay onboarding
</button>
```

The exact placement depends on the existing settings layout. Place it in the General or Account section.

- [ ] **Step 3: Test the replay flow**

Run: `npm run dev`

Test: Complete onboarding. Go to Settings. Click "Replay onboarding". Verify the wizard appears again.

- [ ] **Step 4: Commit**

```bash
git add <settings-file>
git commit -m "feat(onboarding): add replay onboarding button to Settings"
```

---

## Task 14: Mark Existing Users as Onboarding Complete

**Files:** Database only (SQL)

- [ ] **Step 1: Set existing users as onboarding complete**

Existing users should NOT see the onboarding wizard. Run in Supabase SQL editor:

```sql
UPDATE user_profiles
SET onboarding_complete = true
WHERE onboarding_complete IS NULL OR onboarding_complete = false;
```

This is a one-time migration. Only new users created after this point will see the onboarding flow.

- [ ] **Step 2: Verify**

Check that existing users can still sign in and see the main app without being redirected to onboarding.

- [ ] **Step 3: Commit a note**

No code to commit, but document this step was completed.

---

## Task 15: End-to-End Testing

- [ ] **Step 1: Test new user flow**

Create a new Supabase user (or delete the `onboarding_complete` flag for a test user). Sign in. Verify:
- Step 0 walkthrough appears with all 6 page previews
- Floating description cards have "Next" buttons that scroll
- "Continue to Setup" advances to Step 1
- Step 1 shows ChatGPT/Claude tabs with instructions
- "Skip for now" on Step 1 jumps to Step 3 (skips profile review)
- Step 3 shows Microsoft 365 and Circleback cards
- Step 4 shows YouTube playlist input
- "Skip for now" on Step 4 completes onboarding
- Main app loads

- [ ] **Step 2: Test skip all**

Click "Skip onboarding" from Step 0. Verify the main app loads immediately.

- [ ] **Step 3: Test replay**

Go to Settings. Click "Replay onboarding". Verify the wizard appears again.

- [ ] **Step 4: Test with import (if possible)**

Upload a real or sample ChatGPT conversations.json. Verify:
- File validation works (rejects wrong file types)
- Processing indicator shows
- Step 2 appears with profile data pre-filled
- Anchors are detected and toggleable

---
