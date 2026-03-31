# PRD-25b — Skill Detection Infrastructure

**Phase:** Pre-Phase 6 (must land before PRD-26 — Persistent Skill Pipeline)
**Dependencies:** PRD-7 (ingestion pipeline), PRD-25 (diagnostic tool)
**Complexity:** Medium
**Type:** Infrastructure — no new views, no UI changes except Settings profile field addition

---

## Objective

Lay the three infrastructure pieces required before the full skill pipeline (PRD-26) can be built reliably. These pieces ensure that: (1) sources are tagged as skill candidates at ingestion time so the scanner never has to sweep the whole database, (2) the user's professional domain is stored in a structured, machine-readable way so personalised scoring works correctly, and (3) anchor embeddings are guaranteed to exist at promotion time so the highest-weighted scoring signal never silently zeros out.

This PRD also includes a one-time retroactive backfill that applies the candidacy gate to all 201 existing sources in the database, tagging each one correctly so the next skill scan starts from a clean, pre-filtered surface.

---

## What Gets Built

### New Files

| File | Purpose |
|---|---|
| `api/skills/tag-sources.ts` | Vercel serverless function — retroactive backfill endpoint that evaluates and tags all existing sources |
| `api/skills/tag-source.ts` | Single-source tagging function called inline during ingestion pipeline |
| `supabase/migrations/20240002_skill_scan_state.sql` | New `skill_scan_state` table for tracking scan history |

### Modified Files

| File | Change |
|---|---|
| `src/hooks/useExtraction.ts` | Add candidacy gate call after entity extraction completes |
| `src/services/supabase.ts` | Add `updateSourceSkillCandidate()` and `getSkillScanState()` helper functions |
| `src/views/SettingsView.tsx` (or Settings modal) | Add domain classification field to Profile tab |
| `src/app/providers/SettingsContext.tsx` | Expose `userDomain` as a typed field from profile context |

**No changes to existing database tables.** The `skill_candidate` flag is written to the existing `knowledge_sources.metadata` JSONB column — no migration needed for this. The only new table is `skill_scan_state`.

---

## Infrastructure Piece 1 — Source Candidacy Gate

### What it does

Immediately after a source is ingested and entity extraction completes, a lightweight three-check gate runs and writes `skill_candidate: true` or `skill_candidate: false` into `knowledge_sources.metadata`. This is a fast, cheap operation — no Gemini calls, no embeddings. Pure heuristic logic based on data already available from the extraction output.

The skill scanner (PRD-26) then queries exclusively:
```sql
WHERE metadata->>'skill_candidate' = 'true'
```
reducing the scan surface from the full source table to a pre-filtered subset.

### The Three-Check Gate

All three checks are evaluated. A source needs to pass **2 out of 3** to be tagged `true`.

**Check 1 — Source type heuristic**

| Source type | Score |
|---|---|
| YouTube | 1.0 (always pass) |
| Document | 0.7 (pass) |
| Research | 0.7 (pass) |
| Meeting | 0.4 (marginal — depends on other checks) |
| Note | 0.2 (fail unless other checks compensate) |
| Web | 0.5 (marginal) |

**Check 2 — Entity type composition**

From the extraction output, compute the ratio of instructional entity types to total entities extracted.

Instructional types: `Topic`, `Technology`, `Concept`, `Insight`, `Idea`, `Hypothesis`, `Lesson`, `Takeaway`

Non-instructional types: `Person`, `Organization`, `Team`, `Location`, `Event`, `Action`, `Blocker`, `Risk`, `Decision`, `Goal`, `Question`, `Metric`, `Document`

```typescript
const instructionalRatio = instructionalCount / totalEntityCount;
// Pass threshold: instructionalRatio >= 0.35
// Fail: instructionalRatio < 0.35
```

If no entities were extracted (extraction failed or empty), this check fails.

**Check 3 — Chunk depth**

Count of `source_chunks` rows for this source.

```typescript
// Pass: chunkCount >= 3
// Fail: chunkCount < 3
```

### Gate Logic

```typescript
function evaluateCandidacy(
  sourceType: string,
  extractedNodes: KnowledgeNode[],
  chunkCount: number
): { isCandidate: boolean; checks: CandidacyChecks } {

  const check1 = SOURCE_TYPE_SCORES[sourceType] ?? 0.3;
  const check1Pass = check1 >= 0.5;

  const instructionalTypes = new Set([
    'Topic','Technology','Concept','Insight',
    'Idea','Hypothesis','Lesson','Takeaway'
  ]);
  const instructionalCount = extractedNodes.filter(
    n => instructionalTypes.has(n.entity_type)
  ).length;
  const instructionalRatio = extractedNodes.length > 0
    ? instructionalCount / extractedNodes.length
    : 0;
  const check2Pass = instructionalRatio >= 0.35;

  const check3Pass = chunkCount >= 3;

  const passCount = [check1Pass, check2Pass, check3Pass].filter(Boolean).length;
  const isCandidate = passCount >= 2;

  return {
    isCandidate,
    checks: {
      sourceTypeScore: check1,
      instructionalRatio: Math.round(instructionalRatio * 100) / 100,
      chunkCount,
      check1Pass,
      check2Pass,
      check3Pass,
      passCount,
    }
  };
}
```

### Writing the Tag

After the gate runs, write to `knowledge_sources.metadata`:

```typescript
await supabase
  .from('knowledge_sources')
  .update({
    metadata: {
      ...existingMetadata,
      skill_candidate: isCandidate,
      skill_candidate_evaluated_at: new Date().toISOString(),
      skill_candidate_checks: checks,  // store the breakdown for diagnostics
    }
  })
  .eq('id', sourceId)
  .eq('user_id', userId);
```

Storing `skill_candidate_checks` in metadata preserves the reasoning for each tag — useful when reviewing why a source was or wasn't included in the scan surface.

### Integration into Ingestion Pipeline

In `src/hooks/useExtraction.ts`, after the existing chunk-saving step completes (the step that saves `source_chunks`), add:

```typescript
// After chunks are saved — candidacy gate
const chunkCount = savedChunks.length;
const candidacy = evaluateCandidacy(sourceType, savedNodes, chunkCount);
await updateSourceSkillCandidate(sourceId, userId, candidacy);
```

This runs synchronously within the pipeline — it's fast enough (no API calls) that it does not meaningfully add to ingestion time.

### New helper in `src/services/supabase.ts`

```typescript
export async function updateSourceSkillCandidate(
  sourceId: string,
  userId: string,
  candidacy: { isCandidate: boolean; checks: CandidacyChecks }
): Promise<void>
```

---

## Retroactive Backfill — `api/skills/tag-sources.ts`

This endpoint evaluates and tags all existing sources that do not yet have a `skill_candidate` entry in their metadata. It is a one-time operation but is designed to be safely re-runnable (idempotent — sources already tagged are skipped unless `force: true` is passed).

### Request

```
POST /api/skills/tag-sources
Authorization: Bearer <supabase_jwt>
Content-Type: application/json

{
  force?: boolean        // Re-evaluate already-tagged sources. Default: false
  dry_run?: boolean      // Compute tags but don't write them. Default: false
  batch_size?: number    // Sources processed per batch. Default: 20
}
```

### Processing Logic

**Step 1 — Fetch sources needing tagging**

```sql
-- Without force flag: only untagged sources
SELECT id, title, source_type, metadata, created_at
FROM knowledge_sources
WHERE user_id = $1
  AND (
    metadata->>'skill_candidate' IS NULL
    OR metadata->>'skill_candidate_evaluated_at' IS NULL
  )
ORDER BY created_at DESC

-- With force: all sources
SELECT id, title, source_type, metadata, created_at
FROM knowledge_sources
WHERE user_id = $1
ORDER BY created_at DESC
```

**Step 2 — For each source, fetch its extraction data**

```sql
-- Node composition for Check 2
SELECT entity_type, COUNT(*) as count
FROM knowledge_nodes
WHERE source_id = $1 AND user_id = $2
GROUP BY entity_type

-- Chunk count for Check 3
SELECT COUNT(*) as chunk_count
FROM source_chunks
WHERE source_id = $1 AND user_id = $2
```

**Step 3 — Run gate and write tag**

Process in batches of `batch_size` with parallel processing within each batch using `Promise.all`. Add a 200ms delay between batches to avoid Supabase rate limiting.

For `dry_run: true` — compute everything but return results without writing. Useful for previewing what the backfill would tag before committing.

**Step 4 — Return summary**

```typescript
interface BackfillResponse {
  processed: number;
  tagged_true: number;
  tagged_false: number;
  skipped_already_tagged: number;
  dry_run: boolean;
  duration_ms: number;
  breakdown: {
    by_source_type: Record<string, { true: number; false: number }>;
    check_failure_reasons: {
      failed_check1_only: number;
      failed_check2_only: number;
      failed_check3_only: number;
      failed_multiple: number;
    };
  };
  sources: Array<{
    id: string;
    title: string;
    source_type: string;
    is_candidate: boolean;
    checks: CandidacyChecks;
  }>;
}
```

The `sources` array is the full per-source breakdown — useful for reviewing the tagging decisions, especially for borderline cases where one check was marginal.

### Running the Backfill

Once deployed, the backfill is triggered once via a direct POST call or from the Claude Code terminal:

```bash
curl -X POST https://your-deployment.vercel.app/api/skills/tag-sources \
  -H "Authorization: Bearer <supabase_jwt>" \
  -H "Content-Type: application/json" \
  -d '{"dry_run": true}'
```

Run with `dry_run: true` first to review what would be tagged. Then run without it to commit. The response tells you exactly how many of your 201 sources will be included in future skill scans.

---

## Infrastructure Piece 2 — Structured Domain Classification in User Profile

### Problem

`user_profiles.professional_context` is a free-text JSONB field. The skill scanner's S5 signal does keyword matching against `professional_context.role` — but if the role field doesn't contain one of the expected keywords (`engineer`, `consultant`, `founder` etc.), S5 defaults to neutral (0.5) for all candidates. This is what happened in the PRD-25 diagnostic run.

### Solution

Add a `domain` field to `professional_context` with a fixed set of values. This field is set explicitly by the user and read directly by the skill scanner — no keyword matching required.

### Schema Change (JSONB field addition — no migration needed)

The `professional_context` JSONB object gains a new `domain` key:

```typescript
interface ProfessionalContext {
  role?: string;           // existing free-text field — unchanged
  industry?: string;       // existing — unchanged
  current_projects?: string; // existing — unchanged
  domain?: 'technical' | 'consulting' | 'strategic' | 'domain_specific' | 'interpersonal';  // NEW
}
```

No SQL migration needed — JSONB fields in Postgres accommodate new keys without schema changes.

### Settings UI Addition

In the Profile tab of the Settings modal/view, add a domain classification selector immediately below the existing role field.

**Label (section label style):** `PROFESSIONAL DOMAIN`

**Control:** Toggle group — same pattern as the Passive / Standard / Aggressive anchor emphasis selector. Five options in a single row:

| Value | Display label |
|---|---|
| `technical` | Technical |
| `consulting` | Consulting |
| `strategic` | Strategic |
| `domain_specific` | Domain Expert |
| `interpersonal` | People & Org |

**Design:** Same toggle group pattern as anchor emphasis — `--bg-inset` container, white active item, `--border-subtle` borders, DM Sans 12px weight-600 labels. Selected state uses accent tint.

**Helper text below:** DM Sans 11px `--text-secondary` — "Used to personalise skill detection and knowledge scoring"

**Persistence:** Saved to `user_profiles.professional_context.domain` on change, same pattern as other profile fields. Immediate save (no submit button required — matches the existing settings save pattern).

### SettingsContext Update

In `src/app/providers/SettingsContext.tsx`, expose the domain value as a typed field:

```typescript
interface SettingsContextValue {
  // ... existing fields
  userDomain: 'technical' | 'consulting' | 'strategic' | 'domain_specific' | 'interpersonal' | null;
}
```

`userDomain` is derived from `profile.professional_context?.domain ?? null`. The skill scanner reads `userDomain` from context (frontend) or from the `user_profiles` table directly (serverless function).

### Updated S5 Scoring Logic in `api/skills/scan.ts`

Replace the current keyword-matching approach with a direct domain field read:

```typescript
// OLD — fragile keyword matching
const roleText = profile?.professional_context?.role?.toLowerCase() ?? '';
const domainMultiplier = DOMAIN_ROLE_MAP[candidateDomain]
  .some(kw => roleText.includes(kw)) ? 1.3 : 1.0;

// NEW — direct structured field read
const userDomain = profile?.professional_context?.domain ?? null;
const domainMultiplier = userDomain === null
  ? 1.0   // neutral if not set
  : userDomain === candidateDomain
    ? 1.4  // strong match
    : ADJACENT_DOMAINS[userDomain]?.includes(candidateDomain)
      ? 1.1  // adjacent domain match (e.g. consulting + strategic)
      : 0.8; // domain mismatch
```

Adjacent domain map (some domains are naturally complementary):

```typescript
const ADJACENT_DOMAINS: Record<string, string[]> = {
  technical:       ['domain_specific'],
  consulting:      ['strategic', 'interpersonal'],
  strategic:       ['consulting'],
  domain_specific: ['technical', 'consulting'],
  interpersonal:   ['consulting', 'strategic'],
};
```

---

## Infrastructure Piece 3 — Anchor Embedding Enforcement

### Problem

The PRD-25 run confirmed that 0 of 32 anchors had missing embeddings — so this is not a current data problem. The risk is a future one: if the anchor promotion flow ever runs without successfully generating an embedding (Gemini API timeout, rate limit, transient error), the node is saved as an anchor without an embedding, and S1 silently scores 0 for all candidates in future scans.

### Solution

Make embedding generation a **hard requirement** in the anchor promotion flow, not a best-effort step. If embedding generation fails, the promotion fails with a clear error rather than silently succeeding with a null embedding.

### Changes to Anchor Promotion Flow

In the existing code path where `is_anchor` is set to `true` on a node (wherever `UPDATE knowledge_nodes SET is_anchor = true` is called — locate the exact file and function before implementing):

**Step 1 — Check if embedding already exists**
```typescript
const { data: node } = await supabase
  .from('knowledge_nodes')
  .select('id, label, embedding')
  .eq('id', nodeId)
  .single();

const needsEmbedding = !node.embedding;
```

**Step 2 — Generate embedding if missing**
```typescript
if (needsEmbedding) {
  const embedding = await generateEmbedding(node.label);
  // generateEmbedding throws on failure — do not catch here,
  // let the error propagate to prevent silent promotion without embedding
  
  await supabase
    .from('knowledge_nodes')
    .update({ embedding })
    .eq('id', nodeId);
}
```

**Step 3 — Then promote to anchor**
Only after the embedding is confirmed present or successfully generated:
```typescript
await supabase
  .from('knowledge_nodes')
  .update({ is_anchor: true })
  .eq('id', nodeId);
```

**Error handling:** If `generateEmbedding` throws, the anchor promotion fails and returns an error to the UI. The node remains a non-anchor. The error message surfaced to the user: "Could not promote to anchor — embedding generation failed. Please try again."

This is a deliberate hard failure rather than a silent success with missing data — consistent with the project's principle of decoupling failure domains rather than swallowing errors.

### One-Time Backfill Verification Query

After deploying, run this in Supabase to confirm the current state is clean:

```sql
SELECT 
  COUNT(*) FILTER (WHERE embedding IS NOT NULL) as with_embedding,
  COUNT(*) FILTER (WHERE embedding IS NULL) as without_embedding
FROM knowledge_nodes
WHERE user_id = 'b9264b41-bee4-49a7-a141-c37764f60216'
AND is_anchor = true;
```

Expected result: `without_embedding = 0`. If non-zero after deployment, a backfill is needed — generate and write embeddings for the affected nodes using the same `generateEmbedding` function.

---

## New Table: `skill_scan_state`

Required by PRD-26 (full skill pipeline) but created here so the infrastructure is in place. Tracks scan history to enable incremental scanning — the scanner reads this table to know what's already been processed and only evaluates new sources on subsequent runs.

### Migration: `supabase/migrations/20240002_skill_scan_state.sql`

```sql
CREATE TABLE skill_scan_state (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  last_full_scan_at     TIMESTAMPTZ,          -- When the last full re-score ran
  last_incremental_at   TIMESTAMPTZ,          -- When the last new-sources-only scan ran
  sources_evaluated     INTEGER DEFAULT 0,    -- Cumulative count
  candidates_confirmed  INTEGER DEFAULT 0,    -- Current confirmed skill count
  scan_version          TEXT DEFAULT '1.0',   -- Detection logic version — bump when weights change
  metadata              JSONB DEFAULT '{}',   -- Extensible: store last scan summary, error counts etc.
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW()
);

-- One row per user
CREATE UNIQUE INDEX skill_scan_state_user_idx ON skill_scan_state(user_id);

-- RLS
ALTER TABLE skill_scan_state ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own scan state"
  ON skill_scan_state FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
```

The `scan_version` field is important for future calibration: when signal weights or detection criteria change in PRD-26, bumping the version allows the scanner to identify candidates evaluated under old logic and re-score them. This prevents stale candidates from persisting after the detection model is tuned.

---

## Forward-Compatible Decisions

- **`skill_candidate_checks` stored in metadata** — the full breakdown of which checks passed and failed per source is persisted in `knowledge_sources.metadata`. PRD-26's incremental scanner reads this to understand the existing tagging without re-evaluating.
- **`evaluateCandidacy` as a shared utility** — the gate function is defined inline in `api/skills/tag-sources.ts` but should also be extracted as a pure function importable by `api/skills/tag-source.ts` and the ingestion hook. Since Vercel functions can't import from local paths, the function should be copy-pasted (not imported) across the two serverless files — but defined once in a shared utility for the frontend hook: `src/utils/skillCandidacy.ts`.
- **`skill_scan_state.scan_version`** — changing detection logic in PRD-26 bumps this version, enabling targeted re-evaluation of only the affected candidates without a full database re-scan.
- **The `domain` field in `user_profiles.professional_context`** becomes an input to multiple future features beyond skill scoring — digest personalisation, extraction prompt tuning, and any future user-adaptive behaviour.
- **The retroactive backfill endpoint** (`api/skills/tag-sources.ts`) remains deployed and callable after the initial run. If detection logic is updated in PRD-26, it can be re-run with `force: true` to re-evaluate all sources under the new criteria.

---

## Edge Cases & Error Handling

| Scenario | Behaviour |
|---|---|
| Source has 0 extracted nodes (extraction failed) | Check 2 fails (instructionalRatio = 0). Gate likely returns false unless source type and chunk count compensate. Tag is still written — the source is not left untagged. |
| Source has 0 chunks (chunking failed) | Check 3 fails. Source tagged false. Diagnostic note stored in metadata: `skill_candidate_checks.check3Pass: false, chunkCount: 0`. |
| Metadata column is null (older sources) | Handle with `existingMetadata ?? {}` before spreading — never overwrite other metadata fields. |
| Backfill endpoint times out on free Vercel tier (>10s) | The `batch_size` parameter defaults to 20. Lower to 10 if timeouts occur. The endpoint is idempotent — re-run from where it left off (untagged sources are skipped once tagged). |
| Anchor promotion embedding generation fails | Promotion fails hard with error surfaced to UI. Node remains non-anchor. No silent null embedding. |
| User has no profile row | `userDomain` = null. S5 scores neutral (1.0 multiplier). Diagnostic note in scan output: "No profile domain set — visit Settings to improve personalisation." |
| `skill_scan_state` row doesn't exist for user | PRD-26 creates it on first scan run using upsert. This PRD only creates the table — no row is created here. |
| Backfill run with `dry_run: true` | All computation runs, nothing written. Full results returned including per-source tagging decisions. Safe to run repeatedly for preview. |

---

## Acceptance Criteria

- New sources ingested after deployment have `skill_candidate` and `skill_candidate_evaluated_at` populated in their metadata immediately after extraction completes.
- The retroactive backfill endpoint, called with `dry_run: true`, returns a full breakdown of all 201 existing sources without writing anything.
- The backfill endpoint, called without `dry_run`, writes `skill_candidate` to all 201 sources and returns a summary showing how many were tagged true vs false.
- No existing metadata fields on any source are overwritten or removed by the backfill.
- The Settings profile tab shows the domain classification toggle group. Selecting a value saves it immediately to `user_profiles.professional_context.domain`.
- `SettingsContext` exposes `userDomain` as a typed value that updates when the profile is saved.
- Promoting a node to anchor status with no existing embedding triggers embedding generation before the promotion is written. If generation fails, the node is not promoted and an error is shown.
- Promoting a node that already has an embedding skips generation and promotes immediately.
- The `skill_scan_state` table exists in Supabase with RLS enabled and the correct schema.
- Running the PRD-25 diagnostic scan after this PRD is deployed shows a reduced scan surface (only `skill_candidate: true` sources evaluated) and non-zero S5 scores for candidates matching the user's domain.
- TypeScript compiles with zero errors in strict mode across all modified and created files.
- All new serverless functions (`api/skills/tag-sources.ts`, `api/skills/tag-source.ts`) are fully self-contained with zero local imports.
