# PRD 030 — Stage S Phase 2: Move Vendor Calls Server-Side

**Status:** Scoped, awaiting approval to execute.
**Owner:** Joseph Thomas
**Stage:** S (Secret hygiene + client-server boundary), Phase 2.
**Created:** 2026-04-28
**Parent:** `docs/PIPELINE-IMPLEMENTATION-LOG.md` Stage S, Decision D-010.

---

## 1. Why this exists

On 2026-04-28, `VITE_GEMINI_API_KEY` was scraped from the production browser bundle, used to spin up unauthorised Google Cloud resources, and resulted in approximately £100 of charges plus a project suspension. Phase 1 of the incident response rotated keys, restricted the new Gemini key, and removed `VITE_GEMINI_API_KEY` from Vercel and `.env.local`.

That fix stopped the leak but broke every browser-side feature that depended on a vendor key being present in the bundle: Ask chat, RAG, source summaries, cross-connections, query classifier, reranker, persona simulation, and YouTube paste preview.

Phase 2 is the architectural fix. Move every browser-side third-party API call to a server-side `api/` endpoint so no vendor credential is ever shipped to the browser again.

## 2. Scope

### In scope
- Create ten new `api/` endpoints (nine Gemini, one YouTube).
- Migrate ten `src/` files (nine vendor-key consumers + one cosmetic display) to call those endpoints.
- Remove every `import.meta.env.VITE_GEMINI_API_KEY` and `import.meta.env.VITE_YOUTUBE_API_KEY` reference from `src/`.
- Update Stage S in `docs/PIPELINE-IMPLEMENTATION-LOG.md` after each meaningful step.

### Out of scope
- Phase 1 defensive hardening (referrer restrictions, budget alerts) — already in progress in vendor consoles.
- Phase 3 process work (CI scan, bundle scan, quarterly rotation, disabling Supabase legacy JWT keys).
- Any pipeline stage hardening other than the Stage S concern.

## 3. Endpoint surface

Ten purpose-built endpoints. One per task, not one fat proxy. Each endpoint validates its own request shape so quota cannot be drained by an attacker who finds a logged-in cookie.

| Method | Path | Replaces |
|---|---|---|
| POST | `/api/gemini/embed` | `gemini.ts` `generateEmbedding` / `generateEmbeddings` / `embedQuery` |
| POST | `/api/gemini/generate-text` | `gemini.ts` `generateText` |
| POST | `/api/gemini/decompose-query` | `gemini.ts` `decomposeQuery` |
| POST | `/api/gemini/rag` | `gemini.ts` `generateRAGResponse` |
| POST | `/api/gemini/extract` | `gemini.ts` `extractEntities` |
| POST | `/api/gemini/classify-query` | `services/queryClassifier.ts` |
| POST | `/api/gemini/rerank` | `services/reranker.ts` |
| POST | `/api/gemini/summarize` | `utils/summarize.ts` |
| POST | `/api/gemini/cross-connect` | `services/crossConnections.ts` |
| POST | `/api/gemini/simulate` | `services/simulate.ts` |
| POST | `/api/youtube/lookup` | `services/youtube.ts` + `services/automationSources.ts` tier-1 |

## 4. Shared endpoint contract

Every new endpoint follows this exact shape. Helpers are inlined per file (Vercel serverless rule — no shared local imports).

### 4.1 Auth

```ts
// At the top of every endpoint
const SUPABASE_URL = process.env.SUPABASE_URL!
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY!
const GEMINI_API_KEY = process.env.GEMINI_API_KEY!  // or YOUTUBE_API_KEY

if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !GEMINI_API_KEY) {
  throw new Error('[gemini/<name>] Missing required env vars')
}

async function getUserIdFromRequest(req: VercelRequest): Promise<string | null> {
  const auth = req.headers.authorization
  if (!auth?.startsWith('Bearer ')) return null
  const token = auth.slice(7)
  try {
    const { data: { user } } = await createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
      .auth.getUser(token)
    return user?.id ?? null
  } catch { return null }
}
```

This pattern is lifted from the working `api/capture/url.ts`.

### 4.2 Method gate
- Reject anything that is not `POST` with `405`.

### 4.3 Auth gate
- Call `getUserIdFromRequest`. If null, return `401 { error: 'unauthenticated' }`. **No vendor call is made before this check passes.** This is the difference between a server-side migration and a public quota drain.

### 4.4 Request validation
- Each endpoint defines a strict input shape and rejects any unexpected field with `400`.
- No raw "send arbitrary prompt" parameter on any endpoint. Each endpoint constructs its own prompt from validated structured inputs.

### 4.5 Vendor call
- All Gemini calls reuse the `geminiFetch` retry helper from `api/capture/url.ts` (copied inline per file).

### 4.6 Response shape
- Success: `200 { ...endpoint-specific-fields }`.
- Vendor failure: `502 { error: 'vendor', detail: <string> }`.
- Validation failure: `400 { error: 'invalid_request', detail: <string> }`.
- Auth failure: `401 { error: 'unauthenticated' }`.

### 4.7 Logging
- One `console.log` per call with `{ stage: 'gemini:<endpoint>', user_id, duration_ms, status, prompt_tokens, output_tokens }` (where `usageMetadata` is available — embeddings do not return it).

## 5. Browser-side change pattern

Each migrated `src/` file replaces its `import.meta.env.VITE_GEMINI_API_KEY` reads and direct `fetch('https://generativelanguage.googleapis.com/...')` calls with:

```ts
import { supabase } from '@/services/supabase'

async function callApi<T>(path: string, body: unknown): Promise<T> {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) throw new Error('Not signed in')
  const resp = await fetch(path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.access_token}`,
    },
    body: JSON.stringify(body),
  })
  if (!resp.ok) {
    const detail = await resp.text().catch(() => '')
    throw new Error(`API ${resp.status}: ${detail.slice(0, 200)}`)
  }
  return resp.json() as Promise<T>
}
```

This helper can live in `src/services/apiClient.ts` (browser code, not subject to the Vercel "no shared imports" rule). Every migrated file imports it.

## 6. Migration order

One file per commit, smoke-test between, lowest blast-radius first.

| Step | File | Why this order |
|---|---|---|
| 1 | `src/utils/summarize.ts` | Smallest, isolated, no chat coupling. De-risks the auth pattern. |
| 2 | `src/services/queryClassifier.ts` | Small, deterministic input/output. |
| 3 | `src/services/reranker.ts` | Small. |
| 4 | `src/services/crossConnections.ts` | Medium, used in graph RAG. |
| 5 | `src/services/simulate.ts` | Large but contained (persona sim). |
| 6 | `src/services/gemini.ts` | Largest. Rewrite each export to call its endpoint. |
| 7 | `src/services/youtube.ts` | Small, replaces tier-1 YouTube path. |
| 8 | `src/services/automationSources.ts` | Collapse tier-1 branch to call `/api/youtube/lookup`. |
| 9 | `src/components/modals/SettingsModal.tsx` | Cosmetic. Replace key-fingerprint display with a "Server-managed" pill. |

## 7. Per-endpoint test approach

For each endpoint, the smoke test pattern is:

1. **Unauthenticated request** → expect `401`. Confirms the auth gate works.
2. **Authenticated valid request** → expect `200` with the expected response shape.
3. **Authenticated malformed request** → expect `400`.
4. **Affected feature in browser** → exercise the user-facing flow (e.g. open Ask, send a message; open a source, view summary). Confirm no `import.meta.env.VITE_GEMINI_API_KEY` errors in DevTools console and the feature works.
5. `tsc` clean before commit.

After all nine `src/` migrations:

6. `grep -rn "import.meta.env.VITE_GEMINI_API_KEY\|import.meta.env.VITE_YOUTUBE_API_KEY" src/` → expect zero results.
7. Build the production bundle. `grep -rn "AIza" dist/` → expect zero results. (This is Stage S validation gate 3, partial.)

## 8. Rollback

Each step is a single commit. If a feature regresses post-deploy:

1. `git revert <commit-sha>` of the failing migration. Push.
2. The previous commit's browser code expected `VITE_GEMINI_API_KEY` to exist. To restore the old behaviour we would need to put the env var back, which we will not do. Therefore: rollback re-breaks that one feature but does not re-expose the credential.
3. Diagnose the new endpoint, fix forward, re-deploy.

This is asymmetric on purpose. The cost of "feature broken until I fix the endpoint" is small. The cost of "credential back in the bundle" is another suspension.

## 9. Validation gates closed by this PRD

From Stage S §308 in the implementation log, this PRD closes:

- **Gate 1.** No `import.meta.env.VITE_*_API_KEY` in `src/` (excluding documented allowlist).
- **Gate 2.** `grep` on `import.meta.env.VITE_` in `src/` returns only Supabase keys, model names, and non-credential URLs.
- **Gate 5.** Every browser-side feature that previously called Gemini directly works via its new `api/` endpoint, with auth gating verified.

Gates 3, 4, 6 stay open and belong to Phase 1 / Phase 3.

## 10. Update protocol during execution

Per `docs/PIPELINE-IMPLEMENTATION-LOG.md` "Update protocol":

- After each `src/` file migrates and is verified, update Stage S "Open (Phase 2)" — strike through the migrated item.
- After Gates 1/2/5 close, mark Phase 2 done and close out with a short retrospective.
- Do not write the close-out summary until all three gates pass.

## 11. Anti-patterns to actively avoid

- No new `VITE_*` env var carrying any vendor credential, ever.
- No endpoint without an auth gate. Even an "internal" endpoint is public on Vercel.
- No shared local imports inside `api/` files. Every helper inlined per file.
- No "tidy up" of adjacent code while migrating. One concern per commit.
- No bundling multiple feature migrations into one commit.
- No close-out summary in the implementation log until every gate this PRD owns has actually passed.
