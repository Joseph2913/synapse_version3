# Stage 0 Foundations

Living document for the seven foundation items. Updated as each item is completed.

---

## Item 1 — Single Supabase client (the canonical recipe)

### The rule

- **Browser code:** import the shared client from `src/services/supabase.ts`. Never call `createClient` anywhere else in `src/`.
- **Serverless code (`api/*.ts`):** Vercel bundles each function independently, so we cannot share a local helper module. Every file that needs Supabase must declare the canonical recipe below at the top of the file. No `createClient` calls inside handlers.

### The recipe

Paste this block at the top of every `api/*.ts` file that touches Supabase. Include only the factories the file actually uses.

```ts
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { VercelRequest } from '@vercel/node'

// ─── Supabase env + factories ────────────────────────────────────────────────

const SUPABASE_URL = process.env.SUPABASE_URL!
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY!

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !SUPABASE_ANON_KEY) {
  throw new Error(
    '[supabase] Missing env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY'
  )
}

/** Service-role client. Full DB access. ALWAYS filter by user_id explicitly. */
function getServiceSupabase(): SupabaseClient {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
}

/** Anon client. Used to verify a Supabase JWT and resolve the user id. */
function getAnonSupabase(): SupabaseClient {
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
}

/** Resolve the authenticated user id from the request bearer token. */
async function getUserIdFromRequest(req: VercelRequest): Promise<string | null> {
  const auth = req.headers.authorization
  if (!auth?.startsWith('Bearer ')) return null
  const token = auth.slice(7)
  try {
    const { data: { user } } = await getAnonSupabase().auth.getUser(token)
    return user?.id ?? null
  } catch {
    return null
  }
}
```

### What every backend file MUST do

1. Declare env vars at module scope (top of file).
2. Run the env-var presence check at module scope.
3. Define `getServiceSupabase()` (and `getAnonSupabase()` if it needs JWT verification).
4. Use the factories everywhere. **No bare `createClient(...)` inside handlers, helpers, or callbacks.**

### What every backend file MUST NOT do

- Call `createClient` outside the recipe block.
- Read `process.env.SUPABASE_*` outside the recipe block.
- Use `SUPABASE_SERVICE_ROLE_KEY` without an explicit `.eq('user_id', userId)` filter on the query.

### Note on legacy naming

About 40 backend files use the older arrow-style factory name `getSupabase`:

```ts
const getSupabase = () => createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
```

This is functionally compliant with the recipe (single factory, no inline calls). Going forward, **new files use `getServiceSupabase` / `getAnonSupabase`.** Existing `getSupabase` files can be renamed lazily when touched for unrelated work; we are not doing a mass rename now to avoid churn.

### Browser side

`src/services/supabase.ts:22` is the only place `createClient` may appear in browser code. All hooks, services, and components import the singleton `supabase` from there.

### How to verify

```bash
# Browser: should return ONE line (src/services/supabase.ts).
grep -rn "createClient" src/

# Backend: every result should be inside a recipe block at the top of a file,
# or inside the factory functions themselves. Never inside a handler body.
grep -rn "createClient" api/
```

---

## Item 1 — refactor log (2026-04-26)

Files updated to follow the recipe:

- `api/mcp.ts` — removed stray inline `createClient` in `logMcpQuery`; renamed factory to canonical `getServiceSupabase`.
- `api/council/route.ts` — added recipe block, replaced two inline calls.
- `api/council/consult.ts` — added `getAnonSupabase`, replaced two inline anon calls; existing `getServiceSupabase` retained.
- `api/council/analyse.ts` — added recipe block, replaced two inline calls.
- `api/council/synthesise.ts` — added `getAnonSupabase`, replaced one inline call.
- `api/council/backfill-question-embeddings.ts` — added recipe block, replaced two inline calls.
- `api/agent/run.ts` — added recipe block, replaced two inline calls.
- `api/keys/create.ts`, `api/keys/revoke.ts`, `api/keys/list.ts` — normalised JWT verification to `getAnonSupabase().auth.getUser(token)`.

Env-var safety check added to every touched file.

---

## Item 2 — Single Gemini wrapper (the canonical recipe)

### The rule

- **Browser code:** model names live in two exported constants in `src/services/gemini.ts` — `GEMINI_CHAT_MODEL` and `GEMINI_EMBEDDING_MODEL`. Override the chat model with `VITE_GEMINI_MODEL` env var. Never hard-code a model literal anywhere else in `src/`.
- **Serverless code (`api/*.ts`):** Vercel forces each function to bundle independently, so we paste the canonical recipe block at the top of every file that calls Gemini. No bare model literals inside handlers or helpers.

### The recipe

Paste this block at the top of every `api/*.ts` file that calls Gemini.

```ts
// ─── Gemini env + helpers ────────────────────────────────────────────────────

const GEMINI_API_KEY = process.env.GEMINI_API_KEY!
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models'
const GEMINI_MODEL = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash'
const GEMINI_EMBEDDING_MODEL = 'gemini-embedding-001'

if (!GEMINI_API_KEY) {
  throw new Error('[gemini] Missing env var: GEMINI_API_KEY')
}

interface GeminiUsage {
  promptTokenCount?: number
  candidatesTokenCount?: number
  totalTokenCount?: number
}

/** POST to a Gemini endpoint with retry on 429/5xx (1s, 2s, 4s backoff) and a hard timeout. */
async function geminiFetch(
  endpoint: string,
  body: unknown,
  timeoutMs: number,
  stage: string
): Promise<{ json: unknown; usage: GeminiUsage | undefined }> {
  const url = `${GEMINI_BASE}/${endpoint}?key=${GEMINI_API_KEY}`
  const maxAttempts = 3
  let lastErr: Error | null = null
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify(body),
      })
      if (resp.ok) {
        const json = await resp.json() as { usageMetadata?: GeminiUsage }
        const usage = json.usageMetadata
        if (usage) {
          console.log(JSON.stringify({
            stage, model: endpoint.split(':')[0],
            prompt_tokens: usage.promptTokenCount,
            output_tokens: usage.candidatesTokenCount,
            total_tokens: usage.totalTokenCount,
          }))
        }
        return { json, usage }
      }
      const txt = await resp.text().catch(() => '')
      lastErr = new Error(`Gemini ${resp.status}: ${txt.slice(0, 200)}`)
      if ((resp.status === 429 || resp.status >= 500) && attempt < maxAttempts - 1) {
        await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 1000))
        continue
      }
      throw lastErr
    } catch (err) {
      lastErr = err as Error
      if (attempt < maxAttempts - 1) {
        await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 1000))
        continue
      }
      throw lastErr
    } finally {
      clearTimeout(timer)
    }
  }
  throw lastErr ?? new Error('[gemini] request failed')
}

/** Generate JSON from a system + user prompt. */
async function geminiJson<T>(
  systemPrompt: string,
  userContent: string,
  temperature = 0.2,
  timeoutMs = 30000,
  stage = 'gemini'
): Promise<T> {
  const { json } = await geminiFetch(
    `${GEMINI_MODEL}:generateContent`,
    {
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents: [{ parts: [{ text: userContent }] }],
      generationConfig: { temperature, responseMimeType: 'application/json' },
    },
    timeoutMs,
    stage
  )
  const data = json as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> }
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text
  if (!text) throw new Error('No response from Gemini')
  return JSON.parse(text) as T
}

/** Generate a 3072-dim embedding. */
async function embedText(text: string, timeoutMs = 30000, stage = 'embedding'): Promise<number[]> {
  const { json } = await geminiFetch(
    `${GEMINI_EMBEDDING_MODEL}:embedContent`,
    { model: `models/${GEMINI_EMBEDDING_MODEL}`, content: { parts: [{ text }] } },
    timeoutMs,
    stage
  )
  const data = json as { embedding?: { values?: number[] } }
  if (!data.embedding?.values) throw new Error('No embedding in Gemini response')
  return data.embedding.values
}
```

### What every backend file MUST do

1. Declare the four env/model constants at module scope.
2. Run the `GEMINI_API_KEY` presence check at module scope.
3. Use `geminiJson()` and `embedText()` from this recipe — never call `fetch` to Gemini directly.

### What every backend file MUST NOT do

- Hard-code `'gemini-2.5-flash'` or `'gemini-embedding-001'` anywhere.
- Build a bespoke retry loop or timeout per file — the recipe owns it.
- Skip token-usage logging — the recipe handles it for free.

### How to change the chat model everywhere

Set `GEMINI_MODEL` env var in Vercel and redeploy. Backend uses it on next cold start. Browser uses `VITE_GEMINI_MODEL` (must rebuild). One change, full coverage.

### How to verify

```bash
# Should return ZERO matches anywhere in src/ or api/.
grep -rn "'gemini-2\.5-flash'\|gemini-2\.5-flash:generateContent" src/ api/ \
  | grep -v "GEMINI_MODEL\|GEMINI_CHAT_MODEL"

# Should also return ZERO.
grep -rn "'gemini-embedding-001'\|gemini-embedding-001:embedContent" src/ api/ \
  | grep -v "GEMINI_EMBEDDING_MODEL"
```

---

## Item 2 — implementation log (2026-04-26)

**Phase 2A — model-name normalization (DONE):**

- `src/services/gemini.ts` — exported `GEMINI_CHAT_MODEL` (env-overridable via `VITE_GEMINI_MODEL`) and `GEMINI_EMBEDDING_MODEL`. Replaced 6 hard-coded literals with constants.
- 5 browser files now import the model constants from `services/gemini.ts`: `src/utils/summarize.ts`, `src/services/queryClassifier.ts`, `src/services/simulate.ts`, `src/services/crossConnections.ts`, `src/services/reranker.ts`.
- `src/config/queryMindsets.ts` config rows now reference `GEMINI_CHAT_MODEL` instead of literal strings.
- 28 backend `api/*.ts` files now have the canonical `GEMINI_MODEL` / `GEMINI_EMBEDDING_MODEL` constants and use them in template literals and helper signatures. Constants pulled from `process.env.GEMINI_MODEL` (fallback to `gemini-2.5-flash`).
- Env-var safety check (`if (!GEMINI_API_KEY) throw ...`) added at module scope on all 23 backend files that previously lacked it.
- `api/skills/scan.ts` and `api/skills/process-source.ts` document via comment that they intentionally use `text-embedding-004` (older embedding model) for legacy reasons.
- TypeScript compiles clean (`npx tsc --noEmit`).

**Phase 2B — retry + token telemetry across backend helpers (deferred):**

Each of the ~30 backend files has its own bespoke `geminiJson` / `callGemini` helper with a unique signature. Adding retry-on-429/5xx and token-usage logging requires per-file surgery. The recipe block in this doc defines the canonical `geminiFetch` / `geminiJson` / `embedText` helpers; rolling them out replaces every existing helper, which is invasive enough to do as a separate validated pass against one or two pilot files first. Tracked as Phase 2B follow-up.

---

## Item 3 — Single embedding service

### The rule

- **One embedding model across the whole codebase: `gemini-embedding-001`** (3072-dim vectors). Any file using a different model is a bug.
- **One input-construction rule for node embeddings:** `${entity_type}: ${label} — ${description}`. Same in browser and serverless.
- **One canonical batch helper** for paths that embed many texts at once: `embedTexts(texts: string[])`, which uses Gemini's `:batchEmbedContents` endpoint (up to 100 texts per call) instead of looping `:embedContent` one at a time.
- **Single helper signature per backend file** (Vercel constraint forbids shared imports): `embedText(text)` for one text, `embedTexts(texts)` for many. Both call into a single underlying `geminiFetch`-style POST.

### The recipe (paste at the top of every backend file that embeds)

```ts
const GEMINI_EMBEDDING_MODEL = 'gemini-embedding-001'
const EMBEDDING_BATCH_SIZE = 100

/** Embed a single text. Use embedTexts() if you have more than one. */
async function embedText(text: string, timeoutMs = 30000): Promise<number[]> {
  const url = `${GEMINI_BASE}/${GEMINI_EMBEDDING_MODEL}:embedContent?key=${GEMINI_API_KEY}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model: `models/${GEMINI_EMBEDDING_MODEL}`,
        content: { parts: [{ text }] },
      }),
    })
    if (!resp.ok) throw new Error(`Embedding ${resp.status}: ${await resp.text().catch(() => '')}`)
    const data = await resp.json() as { embedding?: { values?: number[] } }
    if (!data.embedding?.values) throw new Error('No embedding in response')
    return data.embedding.values
  } finally {
    clearTimeout(timer)
  }
}

/** Embed many texts in one network call (up to 100 per batch). */
async function embedTexts(texts: string[], timeoutMs = 60000): Promise<number[][]> {
  if (texts.length === 0) return []
  const out: number[][] = []
  for (let start = 0; start < texts.length; start += EMBEDDING_BATCH_SIZE) {
    const slice = texts.slice(start, start + EMBEDDING_BATCH_SIZE)
    const url = `${GEMINI_BASE}/${GEMINI_EMBEDDING_MODEL}:batchEmbedContents?key=${GEMINI_API_KEY}`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          requests: slice.map(text => ({
            model: `models/${GEMINI_EMBEDDING_MODEL}`,
            content: { parts: [{ text }] },
          })),
        }),
      })
      if (!resp.ok) throw new Error(`Batch embedding ${resp.status}: ${await resp.text().catch(() => '')}`)
      const data = await resp.json() as { embeddings?: Array<{ values?: number[] }> }
      const vectors = (data.embeddings ?? []).map(e => e.values ?? [])
      if (vectors.length !== slice.length) throw new Error(`Batch embedding length mismatch: ${vectors.length} vs ${slice.length}`)
      out.push(...vectors)
    } finally {
      clearTimeout(timer)
    }
  }
  return out
}
```

### Browser side

`src/services/gemini.ts` exports `generateEmbedding()` (single) and `generateEmbeddings()` (concurrent). Both already use `GEMINI_EMBEDDING_MODEL`. The browser does not currently call `:batchEmbedContents`; concurrency-5 sequential calls are acceptable for browser-scale workloads.

### What every backend file MUST do

1. Use `GEMINI_EMBEDDING_MODEL` constant — never the string literal.
2. Use `embedText()` for one text and `embedTexts()` for many. **No sequential `for (const t of texts) await embedText(t)` loops** when the array length can exceed ~10.
3. Use the canonical input rule for node embeddings: `${entity_type}: ${label} — ${description}`.

### Item 3 — implementation log (2026-04-26)

**Shipped:**
- **Model unified to `gemini-embedding-001` everywhere.** Two files (`api/skills/scan.ts`, `api/skills/process-source.ts`) were silently using `text-embedding-004` for in-memory candidate-vs-anchor similarity. Anchor vectors stored in the DB are `gemini-embedding-001`; the cross-model comparison was producing partly-meaningless similarity scores that drove skill-candidate relevance (`s1` anchor-alignment signal) and the "related anchors" attachment list. Now both files match the rest of the system.
- **CLAUDE.md updated** to reflect `gemini-embedding-001` as the canonical embedding model (was incorrectly documented as `text-embedding-004` in the tech-stack table and Gemini AI section).
- **Canonical recipe documented above.** `embedText` + `embedTexts` with the batch endpoint (`:batchEmbedContents`, 100 per call).
- **Sequential embedding loops upgraded to true batch in three high-volume files** (see implementation log below).

**Deferred to Phase 3B (same time as Phase 2B):**
- Retry-on-429/5xx for embedding calls (same pattern as chat retries).
- Token-usage telemetry for embedding calls (Gemini returns no `usageMetadata` for embedding endpoints; document this as an upstream limitation if telemetry is required).

---

## Item 4 — Structured logging

### The rule

Every meaningful event in a backend (`api/*.ts`) file emits **one JSON line** to the Vercel logs. The line follows this shape:

```json
{"ts":"2026-04-26T12:34:56.789Z","stage":"extract","status":"ok","user_id":"...","source_id":"...","duration_ms":4231}
```

Required field: `stage`. Recommended whenever available: `user_id`, `source_id`, `duration_ms`, `status`. Errors include `level:"error"` and an `error` string.

### The recipe (paste at the top of every backend file)

```ts
// ─── Structured logging ─────────────────────────────────────────────────────

type LogStatus = 'ok' | 'failed' | 'partial' | 'skipped'

interface LogFields {
  stage: string
  user_id?: string
  source_id?: string
  duration_ms?: number
  status?: LogStatus
  error?: string
  [k: string]: unknown
}

function log(fields: LogFields): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...fields }))
}

function logError(fields: LogFields & { error: string }): void {
  console.error(JSON.stringify({ ts: new Date().toISOString(), level: 'error', ...fields }))
}
```

### What every backend file MUST do

1. **Use `log()` and `logError()` for every pipeline-meaningful event** — stage start, stage end, stage failure. Always include `stage`. Always include `user_id` and `source_id` when they are in scope. Always include `duration_ms` for completion events.
2. **Pick stage names from the 13-stage taxonomy** where applicable: `capture`, `persist`, `chunk`, `prompt`, `extract`, `dedup`, `knowledge`, `cross-connect`, `anchor`, `skills`, `council`, `audit`, `surface`. Sub-stages are colon-separated, e.g. `extract:map-reduce` or `council:phase0`.
3. **Errors always go through `logError()`** so they're filterable by `level:"error"`.

### What every backend file MUST NOT do

- Bare `console.log("text")` or `console.error("text", err)` for events that mean "this stage just succeeded/failed/started". Those are the events Vercel logs need to be filterable on.
- Throwaway diagnostic `console.log` during local debugging is fine — but should be removed before commit, not left in.

### How to query Vercel logs after this lands

```
# All errors from a specific user in the last hour
filter level=error AND user_id="..."

# All extraction stages that took longer than 30 seconds
filter stage=extract AND duration_ms>30000

# Trace one source through every stage
filter source_id="..."
```

### Migration policy

- **New code must use the helpers.** Any new file added under `api/` ships with the helper block at the top.
- **Existing logs migrate incrementally.** Stage 0 inserts the helper into every backend file, but does not rewrite the hundreds of existing `console.log`/`console.error` call sites. Each stage's hardening pass (Stages 1–13 in the pipeline log) migrates that stage's logs as it is touched. This avoids a massive correctness-risky rewrite.

### Item 4 — implementation log (2026-04-26)

**Shipped:**
- Canonical recipe documented above.
- Structured `log()` / `logError()` helpers added to every Gemini- or Supabase-using backend file (~45 files in `api/`).
- Recipe specifies the 13-stage taxonomy for the `stage` field so stages are filterable consistently.
- Per migration policy, existing free-text `console.log` lines remain in place; they will be migrated stage-by-stage as each pipeline stage is hardened. This avoids a high-risk mass rewrite.


