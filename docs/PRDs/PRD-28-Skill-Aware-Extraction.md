# PRD-28 — Skill-Aware Extraction

**Phase:** Phase 6 — Skills Layer
**Dependencies:** PRD-7 (extraction pipeline), PRD-26 (persistent skill pipeline), PRD-27 (skills UI)
**Complexity:** Medium
**Type:** Backend prompt engineering + frontend extraction review UI addition. No schema changes.

---

## Objective

Close the feedback loop between the skill layer and the ingestion pipeline. Right now extraction and skills operate in parallel — a source is ingested, entities are extracted without any awareness of existing skills, and then the skill pipeline evaluates the source separately afterward. This PRD wires them together in both directions.

Going in: confirmed skills are injected into the extraction prompt so Gemini extracts entities with calibrated awareness of what the user already knows — producing richer, more precisely framed nodes rather than generic extractions.

Coming out: the entity review UI shows which confirmed skills this new source relates to before the user commits, giving a preview of how the ingestion will compound existing capabilities. Newly saved nodes are cross-referenced against skills and tagged with skill associations in the graph.

---

## What Gets Built

### New Files

| File | Purpose |
|---|---|
| `src/utils/skillContext.ts` | Builds the skill context layer injected into the extraction prompt |

### Modified Files

| File | Change |
|---|---|
| `src/utils/promptBuilder.ts` | Add skill context as a fifth composable layer in `buildExtractionPrompt` |
| `src/hooks/useExtraction.ts` | Fetch confirmed skills before composing prompt; pass to prompt builder; after save, cross-reference new nodes against skills |
| `src/components/shared/EntityReview.tsx` | Add skill match preview section above the entity list |
| `src/services/supabase.ts` | Add `getConfirmedSkills()` and `tagNodeSkillAssociations()` helper functions |

No new API endpoints. No database migrations. All changes are within the existing frontend extraction flow.

---

## The Prompt Composition Extension

The existing prompt builder follows this layer pattern from `LEGACY-PATTERNS.md`:

```
Final System Prompt =
  Base Extraction Instructions
  + Extraction Mode Template
  + User Profile Context
  + Anchor Context (with emphasis level)
  + Custom User Guidance
```

PRD-28 adds a fifth layer between Anchor Context and Custom Guidance:

```
Final System Prompt =
  Base Extraction Instructions
  + Extraction Mode Template
  + User Profile Context
  + Anchor Context (with emphasis level)
  + Skill Context              ← NEW
  + Custom User Guidance
```

The `ExtractionConfig` interface in `src/utils/promptBuilder.ts` gains one new optional field:

```typescript
interface ExtractionConfig {
  mode: 'comprehensive' | 'strategic' | 'actionable' | 'relational';
  anchorEmphasis: 'passive' | 'standard' | 'aggressive';
  anchors: Array<{ label: string; entity_type: string; description: string }>;
  userProfile: UserProfile | null;
  customGuidance?: string;
  skills?: SkillContextItem[];   // NEW — optional, gracefully absent if empty
}

interface SkillContextItem {
  label: string;
  domain: string;
  exposure_level: string;
  when_to_apply: string | null;
}
```

The `buildExtractionPrompt` function in `promptBuilder.ts` is updated to call `buildSkillContext(config.skills)` when `config.skills` is present and non-empty, inserting it between the anchor context block and the custom guidance block.

---

## `src/utils/skillContext.ts`

Pure utility function — no side effects, no API calls, no Supabase access. Takes the user's confirmed skill list and returns a formatted string for injection into the system prompt.

```typescript
export function buildSkillContext(skills: SkillContextItem[]): string {
  if (!skills || skills.length === 0) return '';

  // Group by domain for readability in the prompt
  const grouped = skills.reduce((acc, skill) => {
    if (!acc[skill.domain]) acc[skill.domain] = [];
    acc[skill.domain].push(skill);
    return acc;
  }, {} as Record<string, SkillContextItem[]>);

  const lines: string[] = [
    '## User Skill Profile',
    '',
    'The following confirmed skills represent capabilities this user has already accumulated.',
    'Use this context to:',
    '1. Extract entities at the appropriate depth — do not over-explain concepts the user already knows well',
    '2. Frame new entities in relation to existing skills where natural connections exist',
    '3. Prioritise extraction of concepts that extend or complement existing skills over redundant basics',
    '4. Note when content introduces a significantly more advanced treatment of an existing skill',
    '',
  ];

  for (const [domain, domainSkills] of Object.entries(grouped)) {
    lines.push(`**${domain.charAt(0).toUpperCase() + domain.slice(1)} Skills (${domainSkills.length}):**`);
    for (const skill of domainSkills) {
      const levelNote = skill.exposure_level === 'advanced' || skill.exposure_level === 'proficient'
        ? ` [${skill.exposure_level}]`
        : '';
      lines.push(`- ${skill.label}${levelNote}`);
    }
    lines.push('');
  }

  lines.push(
    'Do not avoid extracting entities related to existing skills — extract them, but frame them',
    'relative to what the user already knows. Use the exposure level annotations to calibrate depth.',
    'A [proficient] or [advanced] skill means the user has substantial prior exposure — extract',
    'nuances, edge cases, and advanced applications rather than foundational explanations.'
  );

  return lines.join('\n');
}
```

**Why skills are grouped by domain and annotated with exposure level:**
The extraction prompt needs to know both *what* the user knows and *how well* they know it. Grouping by domain helps Gemini understand the user's capability landscape at a glance. The `[proficient]` / `[advanced]` annotation is the calibration signal — it tells Gemini to extract at a more sophisticated level for those topics rather than restating basics the user already has.

**Skill count cap:** Pass a maximum of 40 skills to the prompt. If the user has more than 40 confirmed skills, select by: all `advanced` skills first, then `proficient`, then `developing`, sorted by confidence descending within each tier. This prevents the skill context block from becoming so long it dilutes the rest of the prompt.

```typescript
export function selectSkillsForContext(skills: SkillContextItem[]): SkillContextItem[] {
  const LEVEL_PRIORITY = { advanced: 0, proficient: 1, developing: 2, novice: 3 };
  const sorted = [...skills].sort((a, b) =>
    (LEVEL_PRIORITY[a.exposure_level] ?? 3) - (LEVEL_PRIORITY[b.exposure_level] ?? 3)
  );
  return sorted.slice(0, 40);
}
```

---

## `src/hooks/useExtraction.ts` Changes

### Change 1 — Fetch confirmed skills before prompt composition

At the start of the extraction flow, immediately after fetching anchors and user profile (which already happens), add a parallel fetch for confirmed skills:

```typescript
// Existing parallel fetches (do not change these)
const [anchors, profile] = await Promise.all([
  getAnchors(userId),
  getUserProfile(userId),
]);

// New — fetch confirmed skills in parallel with existing fetches
// Add to the same Promise.all to avoid adding latency
const [anchors, profile, confirmedSkills] = await Promise.all([
  getAnchors(userId),
  getUserProfile(userId),
  getConfirmedSkills(userId),   // NEW
]);
```

`getConfirmedSkills` returns a maximum of 60 confirmed skills ordered by confidence descending. The `selectSkillsForContext` utility then trims to 40 for the prompt.

### Change 2 — Pass skills to prompt builder

Update the `ExtractionConfig` object assembled before calling `buildExtractionPrompt`:

```typescript
const config: ExtractionConfig = {
  mode: extractionMode,
  anchorEmphasis: anchorEmphasis,
  anchors: anchors,
  userProfile: profile,
  customGuidance: customGuidance,
  skills: selectSkillsForContext(confirmedSkills),   // NEW
};

const systemPrompt = buildExtractionPrompt(config);
```

### Change 3 — Skill matching after entity save

After nodes are saved to `knowledge_nodes` and edges to `knowledge_edges` (Step 5 and 7 of the existing pipeline), add a skill association step:

```typescript
// After nodes are saved — cross-reference against confirmed skills
// Fire-and-forget — never block the extraction completion UI
if (savedNodeIds.length > 0 && confirmedSkills.length > 0) {
  tagNodeSkillAssociations(savedNodeIds, confirmedSkills, userId)
    .catch(err => console.warn('Skill association tagging failed silently:', err));
}
```

This is fire-and-forget for the same reason skill processing is fire-and-forget in PRD-26 — it must never block or error the extraction flow from the user's perspective.

### Change 4 — Pass skill matches to Entity Review

Before opening the EntityReview component, compute which confirmed skills this source appears to relate to. This is a lightweight client-side computation — no additional API call:

```typescript
// After Gemini extraction returns, before EntityReview renders
const skillMatches = computeSkillMatches(
  extractedEntities,
  confirmedSkills
);

// Pass to EntityReview
<EntityReview
  entities={extractedEntities}
  relationships={extractedRelationships}
  skillMatches={skillMatches}   // NEW prop
  onSave={handleSave}
  onReextract={handleReextract}
/>
```

**`computeSkillMatches` — client-side, no API call:**

```typescript
function computeSkillMatches(
  entities: ExtractedEntity[],
  skills: SkillContextItem[]
): SkillMatch[] {
  const matches: SkillMatch[] = [];
  const entityLabels = entities.map(e => e.label.toLowerCase());

  for (const skill of skills) {
    const skillKeywords = skill.label.toLowerCase().split(/\s+/);
    const matchingEntities = entities.filter(entity => {
      const label = entity.label.toLowerCase();
      const description = (entity.description ?? '').toLowerCase();
      return skillKeywords.some(kw =>
        kw.length > 3 && (label.includes(kw) || description.includes(kw))
      );
    });

    if (matchingEntities.length > 0) {
      matches.push({
        skill,
        matchingEntityLabels: matchingEntities.map(e => e.label),
        matchType: matchingEntities.length >= 2 ? 'strong' : 'partial',
      });
    }
  }

  return matches.slice(0, 8); // Cap at 8 matches to prevent UI noise
}

interface SkillMatch {
  skill: SkillContextItem;
  matchingEntityLabels: string[];
  matchType: 'strong' | 'partial';
}
```

---

## `src/components/shared/EntityReview.tsx` Changes

Add a skill match preview section at the top of the EntityReview component, rendered above the entity list. Only rendered when `skillMatches.length > 0`.

### New prop

```typescript
interface EntityReviewProps {
  // ... existing props unchanged
  skillMatches?: SkillMatch[];   // NEW — optional, component renders normally if absent
}
```

### Skill Match Preview Section

Positioned between the EntityReview header and the entity list. Collapsible — default state **expanded** if `skillMatches.length > 0`.

```
SKILLS THIS SOURCE RELATES TO                              ▲ collapse

  [Supabase Database Management]  ·  proficient  ·  strong match
  [GitHub Repository Management]  ·  proficient  ·  strong match
  [Vercel Deployment]             ·  developing  ·  partial match

  Ingesting this source will reinforce 3 of your confirmed skills.
```

**Section label:** Cabinet Grotesk 10px weight-700 uppercase `--text-secondary` letter-spacing `0.08em`

**Collapse toggle:** Lucide `ChevronUp` / `ChevronDown` 12px `--text-secondary`, right-aligned on the section label row. Smooth height collapse `0.18s ease`.

**Match rows:** One row per skill match. Each row:
- Skill label pill: `--bg-inset` background, `--border-subtle` border, 6px radius, DM Sans 11px weight-600 `--text-primary`, `4px 8px` padding
- Exposure level: DM Sans 10px `--text-secondary` — the level word only (proficient, developing etc.)
- Match strength: DM Sans 10px, colour-coded — `strong match` in `#10b981` (green), `partial match` in `--text-secondary`
- `8px` gap between elements, `6px` vertical padding per row

**Summary line below rows:**
DM Sans 12px `--text-secondary` — "Ingesting this source will reinforce {n} of your confirmed skills." If all matches are partial: "This source may relate to {n} of your confirmed skills."

**Container styling:**
`--bg-inset` background, 8px radius, `12px 16px` padding, `--border-subtle` 1px border, `16px` bottom margin before entity list.

**Empty state (no matches):** Section not rendered at all — do not show "no matching skills" message. Absence is cleaner than an empty state here.

---

## `src/services/supabase.ts` New Functions

### `getConfirmedSkills`

```typescript
export async function getConfirmedSkills(userId: string): Promise<SkillContextItem[]> {
  const { data, error } = await supabase
    .from('knowledge_skills')
    .select('label, domain, exposure_level, confidence, when_to_apply')
    .eq('user_id', userId)
    .eq('status', 'confirmed')
    .order('confidence', { ascending: false })
    .limit(60);

  if (error) {
    console.warn('Failed to fetch confirmed skills for extraction context:', error);
    return []; // Graceful degradation — extraction proceeds without skill context
  }

  return data ?? [];
}
```

**Critical:** This function must never throw. If it fails, extraction proceeds without skill context — not a blocking error. The `console.warn` preserves the signal for debugging.

### `tagNodeSkillAssociations`

```typescript
export async function tagNodeSkillAssociations(
  nodeIds: string[],
  skills: SkillContextItem[],
  userId: string
): Promise<void> {
  if (nodeIds.length === 0 || skills.length === 0) return;

  // Fetch the newly saved nodes to get their labels
  const { data: nodes } = await supabase
    .from('knowledge_nodes')
    .select('id, label, description, entity_type')
    .in('id', nodeIds)
    .eq('user_id', userId);

  if (!nodes || nodes.length === 0) return;

  // For each node, find matching skills by keyword overlap
  const updates: Array<{ nodeId: string; skillLabels: string[] }> = [];

  for (const node of nodes) {
    const matchingSkillLabels = skills
      .filter(skill => {
        const skillKeywords = skill.label.toLowerCase().split(/\s+/);
        const nodeText = `${node.label} ${node.description ?? ''}`.toLowerCase();
        return skillKeywords.some(kw => kw.length > 3 && nodeText.includes(kw));
      })
      .map(s => s.label);

    if (matchingSkillLabels.length > 0) {
      updates.push({ nodeId: node.id, skillLabels: matchingSkillLabels });
    }
  }

  if (updates.length === 0) return;

  // Write skill associations to node tags
  // Uses the existing user_tags[] array on knowledge_nodes
  // Prefixes skill associations with 'skill:' to distinguish from regular user tags
  for (const update of updates) {
    const skillTags = update.skillLabels.map(label => `skill:${label}`);

    await supabase.rpc('append_user_tags', {
      p_node_id: update.nodeId,
      p_user_id: userId,
      p_tags: skillTags,
    }).catch(() => {
      // Fire-and-forget — if RPC doesn't exist yet, fall back to a direct update
      // This is non-critical enrichment
    });
  }
}
```

**Note on `append_user_tags` RPC:** If this RPC doesn't exist in Supabase, fall back to a direct array append update. The skill tagging is enrichment — it should never cause extraction to fail. If neither the RPC nor the fallback succeeds, log a warning and continue silently.

**The `skill:` prefix convention** on `user_tags` — e.g. `skill:Vercel Deployment and Configuration` — allows future queries to filter nodes by skill association without a separate junction table. PRD-27's Browse tab and future skill graph view can use `user_tags ILIKE 'skill:%'` to find all skill-associated nodes.

---

## Graceful Degradation Behaviour

Skill-aware extraction is an **enhancement layer**, not a critical path. Every failure mode degrades gracefully to the pre-PRD-28 extraction behaviour:

| Failure | Behaviour |
|---|---|
| `getConfirmedSkills` returns empty (no skills yet) | Extraction prompt omits skill context layer. `buildSkillContext([])` returns `''`. No visible change to user. |
| `getConfirmedSkills` throws or times out | Caught, returns `[]`. Extraction proceeds without skill context. Warning logged. |
| `computeSkillMatches` finds no matches | Skill preview section not rendered in EntityReview. No empty state. |
| `tagNodeSkillAssociations` fails silently | Nodes saved without skill tags. No user-facing error. Warning logged. |
| Skill context makes prompt too long | Gemini handles long prompts gracefully. `selectSkillsForContext` caps at 40 skills to prevent runaway prompt length. |
| User has 0 confirmed skills (new user, pipeline not yet run) | `getConfirmedSkills` returns `[]`. All downstream skill-aware behaviour skipped. Extraction identical to pre-PRD-28. |

---

## Forward-Compatible Decisions

- **`skill:` prefix on `user_tags`** — establishes a namespacing convention for system-generated tags vs user-defined tags. Future PRDs can add other system tag prefixes (`anchor:`, `digest:`) following the same pattern without schema changes.
- **`selectSkillsForContext` as a separate exported function** — the 40-skill selection logic is independently testable and can be tuned (e.g. different cap for different extraction modes — comprehensive mode might benefit from more skill context than actionable mode).
- **`SkillMatch` type exported from `useExtraction.ts`** — PRD-27's `SkillDetailPanel` could in future show "Recent extractions that reinforced this skill" by reading back the `skill:` tags from `user_tags`. The data structure is already in place.
- **`skillMatches` as an optional prop on `EntityReview`** — the component remains fully functional without it. This means the History tab re-extraction flow (which reuses `EntityReview`) does not need to be updated for PRD-28 — it simply doesn't pass `skillMatches` and the section is absent.
- **Skill context as a prompt layer** — the `buildSkillContext` function produces a string, not a structured object. This means it can evolve independently — future versions might include `how_to_apply` guidance or skill gap signals — without touching the prompt builder interface.

---

## Edge Cases & Error Handling

| Scenario | Behaviour |
|---|---|
| User has 60+ confirmed skills | `selectSkillsForContext` caps at 40, prioritising higher exposure levels. Lower-confidence `developing` skills are excluded first. |
| All confirmed skills have `null` when_to_apply | `buildSkillContext` still runs — it uses `label`, `domain`, and `exposure_level` only. `when_to_apply` is not included in the prompt context. |
| Extracted entities have very short labels (1–2 words) | `computeSkillMatches` keyword filter requires `kw.length > 3` — prevents false matches on common short words. |
| Re-extraction from History tab | `EntityReview` receives no `skillMatches` prop (History tab doesn't pass it). Section simply absent. No error. |
| Skills fetched but all are `novice` exposure | All included in prompt context without `[proficient]`/`[advanced]` annotations. Calibration instructions still apply. |
| `tagNodeSkillAssociations` called with 0 nodes (extraction produced no entities) | Early return — no Supabase calls made. |
| Skill context injection causes Gemini to over-index on existing skills and miss genuinely new concepts | This is a prompt quality risk. The skill context prompt explicitly states "do not avoid extracting entities related to existing skills — extract them." Monitor extraction quality on first few runs and adjust the calibration language in `buildSkillContext` if needed. |

---

## Acceptance Criteria

- `src/utils/skillContext.ts` exports `buildSkillContext` and `selectSkillsForContext`. Both functions are pure — no side effects, no API calls, fully unit-testable.
- `buildExtractionPrompt` in `promptBuilder.ts` accepts an optional `skills` field on `ExtractionConfig` and calls `buildSkillContext` when skills are present.
- When `skills` is empty or absent, `buildExtractionPrompt` produces output identical to its pre-PRD-28 behaviour.
- `useExtraction.ts` fetches confirmed skills in parallel with anchors and profile before composing the extraction prompt — no additional serial latency added to extraction start time.
- The skill context layer appears in the composed system prompt when confirmed skills exist — verifiable by logging the prompt before the Gemini call during a test extraction.
- The EntityReview component renders the skill match preview section when `skillMatches` is non-empty, showing correct labels, exposure levels, and match strength indicators.
- The skill match preview section collapses and expands correctly with chevron animation.
- When `skillMatches` is empty or the prop is absent, the EntityReview component renders identically to its pre-PRD-28 state.
- After saving extracted entities, `tagNodeSkillAssociations` runs in the background and adds `skill:` prefixed entries to `user_tags` on matching nodes — verifiable in Supabase.
- `getConfirmedSkills` returning an error does not surface any error state to the user — extraction proceeds normally.
- TypeScript compiles with zero errors in strict mode across all modified files.
- No existing extraction functionality is broken — all pre-PRD-28 extraction flows work identically.
