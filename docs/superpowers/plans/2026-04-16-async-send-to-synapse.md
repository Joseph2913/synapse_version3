# Async Send-to-Synapse Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the `send_to_synapse` MCP tool return immediately with a source ID, running the extraction pipeline in the background so it never times out.

**Architecture:** Install `@vercel/functions` and use `waitUntil()` in `api/ingest/session.ts` to split the handler into a fast response path (save source, return ID) and a background pipeline path (extraction, embeddings, chunking, cross-connections). Update the MCP handler in `api/mcp.ts` to reflect the new async response.

**Tech Stack:** Vercel Functions (`waitUntil`), Supabase, Gemini API (unchanged)

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `api/ingest/session.ts` | Modify | Split handler into fast-return + background pipeline |
| `api/mcp.ts` | Modify | Update `handleSendToSynapse` response handling |
| `package.json` | Modify | Add `@vercel/functions` dependency |

---

### Task 1: Install @vercel/functions

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install the package**

Run:
```bash
npm install @vercel/functions
```

- [ ] **Step 2: Verify installation**

Run:
```bash
node -e "require('@vercel/functions')"
```
Expected: No error output.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add @vercel/functions for waitUntil support"
```

---

### Task 2: Split session handler into fast-return + background pipeline

**Files:**
- Modify: `api/ingest/session.ts:1-6` (imports)
- Modify: `api/ingest/session.ts:228-671` (handler function)

The handler currently runs all 10 steps synchronously before returning. We need to:
1. Keep Step 1 (save source) in the fast path
2. Return the response immediately after Step 1
3. Move Steps 2-10 into a `waitUntil()` background promise

- [ ] **Step 1: Add waitUntil import**

At the top of `api/ingest/session.ts`, add the import after the existing imports (line 2):

```typescript
import { waitUntil } from '@vercel/functions';
```

The top of the file should read:

```typescript
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';
import { waitUntil } from '@vercel/functions';
```

- [ ] **Step 2: Extract the pipeline into a standalone function**

After the `verifyIngestSecret` function (line 25) and before the Gemini helpers (line 27), add a type and forward-declare the pipeline function signature. The actual function will be placed after the helpers.

After line 225 (just above `// ─── HANDLER ───`), add the pipeline function. It contains Steps 2-10 from the current handler, extracted as-is:

```typescript
// ─── BACKGROUND PIPELINE ──────────────────────────────────────────────────────

async function runExtractionPipeline(params: {
  supabase: ReturnType<typeof getSupabase>;
  sourceId: string;
  userId: string;
  title: string;
  content: string;
  guidance?: string;
  metadata: Record<string, unknown>;
}): Promise<void> {
  const { supabase, sourceId, userId, title, content, guidance, metadata } = params;
  const startTime = Date.now();

  const updateStatus = async (status: string, extra?: Record<string, unknown>) => {
    const meta = { ...metadata, extraction_status: status, ...extra };
    await supabase.from('knowledge_sources').update({ metadata: meta }).eq('id', sourceId);
  };

  try {
    await updateStatus('processing', { processing_started_at: new Date().toISOString() });

    // ── STEP 2: GENERATE SUMMARY ────────────────────────────────────────────
    // (paste existing Step 2 code from current handler, lines 301-308)
    const summary = await generateSummary(content);
    if (summary) {
      await supabase.from('knowledge_sources').update({ summary }).eq('id', sourceId);
    }

    // ── STEPS 3-10: EXTRACTION PIPELINE ─────────────────────────────────────
    // (paste existing Steps 3-10 code from current handler, lines 310-643)
    // ... ALL existing pipeline code goes here UNCHANGED ...
    // The only difference: remove the final res.status(200).json() call
    // and replace it with a log + updateStatus('completed')

    // ── COMPLETE ────────────────────────────────────────────────────────────
    await updateStatus('completed', {
      processing_completed_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
    });

    console.log(`[ingest/session] Pipeline complete for "${title}" (${sourceId}) in ${Date.now() - startTime}ms`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[ingest/session] Pipeline error for ${sourceId}:`, msg);
    await updateStatus('error', { error: msg, failed_at: new Date().toISOString() });
  }
}
```

**Critical:** The try/catch inside the pipeline function means failures are caught and logged, and the source status is set to `'error'`. The MCP caller already got its response, so this error is silent to the user but visible in Vercel logs and in the source's metadata.

- [ ] **Step 3: Rewrite the handler to fast-return + background dispatch**

Replace the existing handler function (lines 228-671) with:

```typescript
export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-ingest-secret');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!verifyIngestSecret(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const {
    userId,
    title,
    content,
    repo,
    branch,
    guidance,
  } = req.body as {
    userId: string;
    title: string;
    content: string;
    repo?: string;
    branch?: string;
    guidance?: string;
  };

  if (!userId || !title || !content) {
    return res.status(400).json({ error: 'Missing required fields: userId, title, content' });
  }

  const supabase = getSupabase();

  try {
    // ── FAST PATH: Save source and return immediately ───────────────────────
    const metadata: Record<string, unknown> = {
      ingested_via: 'mcp_session',
      extraction_status: 'accepted',
      repo: repo ?? null,
      branch: branch ?? null,
      guidance: guidance ?? null,
      session_date: new Date().toISOString(),
    };

    const { data: sourceData, error: sourceError } = await supabase
      .from('knowledge_sources')
      .insert({
        user_id: userId,
        title,
        source_type: 'GitHub',
        content: content.slice(0, MAX_CONTENT_CHARS),
        metadata,
      })
      .select('id')
      .single();

    if (sourceError) {
      throw new Error(`Failed to save source: ${sourceError.message}`);
    }

    const sourceId = (sourceData as { id: string }).id;
    console.log(`[ingest/session] Accepted source "${title}" (${sourceId}) for user ${userId}`);

    // ── BACKGROUND: Run extraction pipeline after response is sent ─────────
    waitUntil(
      runExtractionPipeline({
        supabase,
        sourceId,
        userId,
        title,
        content: content.slice(0, MAX_CONTENT_CHARS),
        guidance: guidance ?? undefined,
        metadata,
      })
    );

    // ── RETURN IMMEDIATELY ──────────────────────────────────────────────────
    return res.status(202).json({
      source_id: sourceId,
      title,
      status: 'processing',
      message: 'Source accepted. Extraction pipeline running in background.',
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[ingest/session] Error:', err);
    return res.status(500).json({ success: false, error: msg });
  }
}
```

Key changes from the original handler:
- Returns HTTP `202 Accepted` (not 200) after saving the source
- Response body has `status: 'processing'` instead of `'complete'`
- Response no longer includes `entity_count`, `edge_count`, etc. (not yet known)
- `waitUntil()` dispatches the full pipeline to run after the response

- [ ] **Step 4: Verify the file compiles**

Run:
```bash
npx tsc --noEmit api/ingest/session.ts 2>&1 || echo "Check for type errors"
```

If there are type errors related to variables from the old handler being referenced in the pipeline function (e.g., `entities`, `savedNodeMap`, `nodesCreated`, `edgesCreated`, `crossConnectionCount`, `chunks`), those are all locally scoped within the pipeline function and should be fine. The key is that the pipeline function is self-contained.

- [ ] **Step 5: Commit**

```bash
git add api/ingest/session.ts
git commit -m "feat: make session ingest async with waitUntil background pipeline"
```

---

### Task 3: Update MCP handler for async response

**Files:**
- Modify: `api/mcp.ts:314-362`

The MCP handler currently expects the ingest response to contain `entity_count` and `edge_count`. It needs to handle the new `202` response with `status: 'processing'`.

- [ ] **Step 1: Update handleSendToSynapse function**

Replace `api/mcp.ts` lines 314-362 with:

```typescript
async function handleSendToSynapse(
  args: { title: string; content: string; repo?: string; branch?: string; guidance?: string },
  userId: string
): Promise<ToolContent> {
  const INGEST_SECRET = process.env.INGEST_SECRET;
  if (!INGEST_SECRET) {
    return { content: [{ type: 'text', text: 'Error: INGEST_SECRET not configured on server.' }] };
  }

  const appUrl = process.env.APP_DOMAIN
    ?? (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000');

  const response = await fetch(`${appUrl}/api/ingest/session`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-ingest-secret': INGEST_SECRET,
    },
    body: JSON.stringify({
      userId,
      title: args.title,
      content: args.content,
      repo: args.repo ?? null,
      branch: args.branch ?? null,
      guidance: args.guidance ?? null,
    }),
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    const errBody = await response.text();
    return { content: [{ type: 'text', text: `Failed to ingest session: ${response.status} ${errBody.slice(0, 300)}` }] };
  }

  const result = await response.json() as {
    source_id: string;
    title: string;
    status: string;
    message: string;
  };

  return {
    content: [{
      type: 'text',
      text: `Session sent to Synapse.\n\nSource ID: ${result.source_id}\nTitle: ${result.title}\nStatus: ${result.status}\n\nThe extraction pipeline is running in the background. Entities, relationships, and embeddings will be available in your knowledge graph shortly. You can check the source status via search_sources.`,
    }],
  };
}
```

Key changes:
- Timeout reduced from 90s to 15s (source save is fast, should take <2s)
- Response type updated to match new `202` shape (no entity/edge counts)
- User-facing message explains that extraction is running in background
- Tells user they can check status via `search_sources`

- [ ] **Step 2: Commit**

```bash
git add api/mcp.ts
git commit -m "feat: update MCP handler for async session ingest response"
```

---

### Task 4: Manual verification

- [ ] **Step 1: Deploy and test**

Push to trigger Vercel deployment, then test the MCP tool:

1. From Claude Code, run the `send_to_synapse` tool with a short test session
2. Verify it returns within 2-5 seconds with a `source_id` and `status: 'processing'`
3. Wait 30-60 seconds, then use `search_sources` to find the source
4. Verify the source has `extraction_status: 'completed'` in its metadata
5. Use `search_entities` to confirm entities were extracted

- [ ] **Step 2: Check Vercel logs**

In the Vercel dashboard, check the function logs for `api/ingest/session`:
- Should see `[ingest/session] Accepted source "..." (...)` immediately
- Should see `[ingest/session] Pipeline complete for "..." (...)` after 30-90s
- No timeout errors

- [ ] **Step 3: Test error handling**

Send a session with deliberately malformed content to verify:
- The fast response still returns 202
- The pipeline catches the error and sets `extraction_status: 'error'` in metadata
- The error is visible in Vercel logs
