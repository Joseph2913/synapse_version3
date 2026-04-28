# Stage 4 — Prompt Composition

**Owner:** Joseph Thomas
**Shipped:** 2026-04-28
**Status:** Done

This doc is the contract for Stage 4 of the 13-stage source-ingestion pipeline. It explains how the extraction system prompt is composed, where the code lives, how active skills are injected, and how every extraction is stamped with a prompt version.

---

## What Stage 4 does

Stage 4 takes the per-extraction inputs (mode, anchors, user profile, custom guidance, active skills) and composes the **single system prompt** that Gemini receives for entity extraction. Stage 4 is upstream of Stage 5 (entity extraction). Per `docs/FAILURE-POLICY.md`, Stage 4 is **fatal** — a bad prompt means extraction will be garbage, so we stop and log.

---

## The canonical contract

```ts
import {
  buildExtractionPrompt,
  composeExtractionPrompt,
  PROMPT_VERSION,
  type PromptConfig,
} from 'api/pipeline/extract-prompt'

// Returns just the prompt string (legacy callers).
const prompt = buildExtractionPrompt(config)

// Returns the prompt AND the canonical version — preferred for new code.
const { prompt, version } = composeExtractionPrompt(config)
```

`PromptConfig` shape:

```ts
interface PromptConfig {
  mode: 'comprehensive' | 'strategic' | 'actionable' | 'relational' | string
  anchorEmphasis: 'passive' | 'standard' | 'aggressive' | string
  anchors: PromptAnchor[]              // manual + auto-detected; isAuto flag separates them
  userProfile: PromptUserProfile | null
  customInstructions?: string | null
  activeSkills?: PromptSkillHint[]      // confirmed knowledge_skills, capped at 12
}
```

**Pure function.** No I/O, no env reads, no random or time-dependent behaviour. Same inputs always produce identical output. That property is asserted by the test suite.

**Single canonical location.** `api/pipeline/extract-prompt.ts`. Both the serverless pipeline (`api/pipeline/extract-pipeline.ts` → every `api/*/extract-knowledge.ts`) and the browser path (`src/utils/promptBuilder.ts`) import from it. There are no duplicate prompt strings anywhere.

---

## The four extraction modes

Each mode swaps the `<extraction_mode>` block in the prompt. Mode-specific text lives in `MODE_INSTRUCTIONS` in `api/pipeline/extract-prompt.ts`.

| Mode | When |
|---|---|
| `comprehensive` | Default. Cast a wide net; aim for ~1 entity per 600–900 chars. |
| `strategic` | Senior-level signal only — decisions, goals, concepts, key people. |
| `actionable` | Meeting-style content — actions, blockers, deadlines, decisions. |
| `relational` | Maximise edge density; prefer fewer, more-connected entities. |

A snapshot test locks the exact rendered prompt for each mode. Any change to the wording is a deliberate edit reviewed via `vitest -u`.

---

## Anchor emphasis

Three settings that swap the `<anchor_context>` framing sentence:

| Emphasis | Behaviour |
|---|---|
| `passive` | Anchors are low-priority context; don't force connections. |
| `standard` | Default. Connect when content relates to an anchor. |
| `aggressive` | Heavily weight anchor-related content; actively bridge. |

Auto-detected anchors (`isAuto: true`) are emitted in a separate `<emerging_themes>` block and always treated passively, regardless of the configured emphasis.

---

## Active skills wiring

Confirmed entries in `knowledge_skills` (the user's accumulated expertise) are injected as a `<user_expertise>` hint block. The block is **omitted entirely** when the user has no confirmed skills, so the prompt stays as small as possible.

- Selection: `status = 'confirmed'`, ordered by confidence descending then `last_reinforced_at` desc, capped at 12.
- Each entry renders as `- {label} ({domain}, {exposure_level})` (parenthetical drops if both are missing).
- Skills are a **hint**, not a filter — the prompt explicitly says "do not skip entities that fall outside these areas."

The browser path fetches skills via `src/services/promptSkillsContext.fetchActiveSkillsForPrompt(userId)`. The serverless paths (`youtube/extract-knowledge`, `github/extract-knowledge`, `meetings/process`, `microsoft/extract-knowledge`, `ingest/session`) fetch them in the same `Promise.all` block that already pulls profile and anchors — adds zero latency.

---

## Prompt versioning

Every composed prompt carries a semver `PROMPT_VERSION` constant. Bump on any structural change to the prompt text.

Current: **`2.1.0`** — adds the `<user_expertise>` skills-hints block (Stage 4 unification).

The version is stamped onto every `extraction_sessions` row via the `prompt_version` column (migration `20260428_extraction_sessions_prompt_version.sql`). Historical rows default to `'unknown'`. New rows are written by `composeExtractionPrompt()` and always carry a real version.

Useful queries:

```sql
-- Quality by prompt version
SELECT prompt_version,
       count(*) AS sessions,
       avg(entity_count) AS avg_entities,
       avg(relationship_count) AS avg_edges
FROM extraction_sessions
WHERE created_at > now() - interval '30 days'
GROUP BY prompt_version
ORDER BY prompt_version;

-- Rollback signal: did latest version drop yield?
SELECT prompt_version, avg(entity_count)
FROM extraction_sessions
WHERE created_at > now() - interval '7 days'
GROUP BY prompt_version;
```

---

## Where it's wired

Browser path:
- `src/utils/promptBuilder.ts` — re-exports `buildExtractionPrompt` and `composeExtractionPrompt` from the canonical module.
- `src/services/promptSkillsContext.ts` — fetches confirmed skills for prompt injection.
- `src/hooks/useExtraction.ts` — composes prompt + persists `prompt_version`.
- `src/services/extractionPipeline.ts` — composes prompt + persists `prompt_version`.
- `src/services/extractionPersistence.ts` — `saveExtractionSession()` accepts `promptVersion`.

Serverless path:
- `api/pipeline/extract-prompt.ts` — canonical module (this is the source of truth).
- `api/pipeline/extract-pipeline.ts` — re-exports `buildExtractionPrompt`, `composeExtractionPrompt`, `PROMPT_VERSION`, `PromptConfig`, `Anchor`, `UserProfile`, `PromptSkillHint`.
- `api/youtube/extract-knowledge.ts` — fetches skills, stamps `prompt_version`.
- `api/github/extract-knowledge.ts` — fetches skills, stamps `prompt_version`.
- `api/meetings/process.ts` — fetches skills, stamps `prompt_version`.
- `api/microsoft/extract-knowledge.ts` — fetches skills (no `extraction_sessions` insert in this path).
- `api/ingest/session.ts` — fetches skills (no `extraction_sessions` insert in this path).

Tests: `tests/prompts/extract-prompt.test.ts` — 25 cases covering invariants, all four modes (with snapshots), anchor emphasis, skills injection, profile fields, and custom-instruction handling.

---

## How to change the prompt

1. Edit `api/pipeline/extract-prompt.ts`.
2. Run `npx vitest run tests/prompts/`.
3. If snapshots fail intentionally, run `npx vitest run tests/prompts/ -u` and review the snapshot diff.
4. **Bump `PROMPT_VERSION`** if the change is meaningful (i.e. anything beyond a typo). Patch for tweaks, minor for new sections, major for incompatible reshapes.
5. Update this doc's version note. Commit.

---

## Decisions

- **D-S4-01.** Single canonical prompt module at `api/pipeline/extract-prompt.ts`, browser-safe (no env reads). Both browser and serverless import from it. We considered duplicating the builder per-bundle (per CLAUDE.md "no shared imports in api/") but `api/pipeline/extract-pipeline.ts` was already doing the shared-import pattern across five callers, so we extended it rather than diverge.
- **D-S4-02.** Skills hints rendered as `- {label} ({domain}, {exposure_level})` in a `<user_expertise>` block. Capped at 12 to keep prompt size bounded. Block omitted entirely when no skills exist, to avoid confusing the model with empty hints.
- **D-S4-03.** Version strategy: hand-curated semver in source (`PROMPT_VERSION = '2.1.0'`) rather than a content hash. Reasoning: a hand-curated version travels with intent ("2.1 added skills") in a way a hash doesn't, and the hash is auto-derivable from the source if we ever need it. Stamped onto `extraction_sessions.prompt_version`; default `'unknown'` for historical rows.
- **D-S4-04.** Skills fetched in the same `Promise.all` as profile/anchors in every serverless path, so wiring adds zero round-trip latency.
