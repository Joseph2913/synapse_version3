```markdown
# PRD 11-B — YouTube Pipeline Decoupling & Parallel Processing

**Phase:** 4 — Automation (patch to PRD 11)
**Dependencies:** PRD 11 (YouTube Serverless Pipeline — provides `api/youtube/process.ts`, queue schema, transcript tiers)
**Estimated Complexity:** Medium (1–2 sessions)

---

## 1. Problem Statement

The current `api/youtube/process.ts` serverless function processes videos **sequentially within a single invocation**: for each queue item, it fetches the transcript (up to ~120s if it falls to the Apify tier), then runs the full Gemini extraction pipeline (entity extraction → relationship inference → source saving → embedding generation → cross-connection discovery). With 2 items per batch, a single function call can easily exceed 5–10 minutes. When "Process Now" triggers up to 20 items, timeout is guaranteed.

**The error the user sees:** `Processing timed out (stuck for >10 minutes). Click retry to try again.`

**Root cause:** Transcript fetching and knowledge extraction are coupled in a single synchronous loop within one serverless function invocation. The Vercel function timeout (60s on Pro, 10s on Hobby) is exceeded because the function tries to do everything for every video before returning.

---

## 2. Solution Architecture

**Decouple the pipeline into three independent serverless functions**, each doing one focused job within Vercel's timeout window. The database queue is the coordination layer — no function calls another function directly.

### New Pipeline Flow

```
BEFORE (current — single function does everything):
┌─────────────────────────────────────────────────────┐
│ process.ts                                          │
│ FOR EACH video (up to 20):                          │
│   1. Fetch transcript (15s–120s)                    │
│   2. Save source to knowledge_sources               │
│   3. Extract entities via Gemini (30s–60s)           │
│   4. Save nodes + edges                             │
│   5. Generate embeddings (20s–40s)                  │
│   6. Chunk source content                           │
│   7. Discover cross-connections (15s–30s)            │
│ TIMEOUT ☠                                           │
└─────────────────────────────────────────────────────┘

AFTER (decoupled — three focused functions):
┌──────────────────────┐     ┌──────────────────────┐     ┌──────────────────────┐
│ fetch-transcripts.ts │     │ extract-knowledge.ts │     │ process.ts (updated) │
│                      │     │                      │     │   (orchestrator)     │
│ Pick N items where   │     │ Pick N items where   │     │ Runs on cron.        │
│ status = 'pending'   │     │ status =             │     │ Calls fetch-         │
│                      │     │ 'transcript_ready'   │     │ transcripts, then    │
│ Fetch transcript     │     │                      │     │ extract-knowledge    │
│ via 3-tier fallback  │     │ Run Gemini pipeline: │     │ via internal fetch() │
│                      │     │  - save source       │     │                      │
│ On success:          │     │  - extract entities  │     │ OR: both run as      │
│  status →            │     │  - save nodes/edges  │     │ independent crons    │
│  'transcript_ready'  │     │  - embeddings        │     │                      │
│  transcript column   │     │  - chunks            │     │                      │
│  filled              │     │  - cross-connections  │     │                      │
│                      │     │                      │     │                      │
│ On failure:          │     │ On success:          │     │                      │
│  status → 'failed'   │     │  status → 'completed'│     │                      │
│  error_message set   │     │                      │     │                      │
│                      │     │ On failure:          │     │                      │
│ Parallelism: up to 3 │     │  status → 'failed'   │     │                      │
│ concurrent via       │     │                      │     │                      │
│ Promise.allSettled   │     │ Parallelism: 2       │     │                      │
│                      │     │ concurrent via       │     │                      │
│ Target: <30s total   │     │ Promise.allSettled   │     │                      │
│                      │     │                      │     │                      │
│                      │     │ Target: <50s total   │     │                      │
└──────────────────────┘     └──────────────────────┘     └──────────────────────┘
         ▲                            ▲
         │                            │
         └── cron every 2 min ────────┘  (or called by process.ts orchestrator)
```

---

## 3. Database Schema Change

### New status value: `transcript_ready`

Add `'transcript_ready'` to the `status` enum on `youtube_ingestion_queue`. This is the handoff state between transcript fetching and knowledge extraction.

**Migration SQL:**

```sql
-- No formal enum to alter — status is VARCHAR(50), so the new value is just a convention.
-- However, update the CHECK constraint if one exists:

-- Verify current constraint:
-- SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
-- WHERE conrelid = 'youtube_ingestion_queue'::regclass;

-- If no CHECK constraint exists (likely — it's VARCHAR), no migration needed.
-- The new value 'transcript_ready' is simply used by the updated functions.

-- Update any existing items that have transcripts but are stuck in 'pending':
UPDATE youtube_ingestion_queue
SET status = 'transcript_ready'
WHERE status = 'pending'
  AND transcript IS NOT NULL
  AND transcript != '';
```

### Updated Status Flow

```
pending → fetching_transcript → transcript_ready → extracting → completed
                    ↓                                    ↓
                  failed                              failed
                    ↓                                    ↓
             (retry → pending)                  (retry → transcript_ready)
```

**Key change:** When retry is triggered on an item that already has a transcript, it should go to `transcript_ready` (not back to `pending`) to skip re-fetching. Only items without transcripts retry from `pending`.

### Updated TypeScript Type

```typescript
// Update in src/types/automate.ts
export interface QueueItem {
  // ... existing fields ...
  status: 'pending' | 'fetching_transcript' | 'transcript_ready' | 'extracting' | 'completed' | 'failed' | 'skipped';
}
```

---

## 4. Serverless Function: `api/youtube/fetch-transcripts.ts`

**Purpose:** Fetch transcripts for pending queue items. Does NOT run extraction.

**Trigger:** Vercel cron every 2 minutes, OR called by the orchestrator.

**Batch size:** Up to 5 items selected, 3 processed in parallel via `Promise.allSettled`.

**Target execution time:** <30 seconds (Tier 1+2 are ~15s each; Tier 3 Apify is ~120s but runs async — see note below).

### Implementation

```typescript
// api/youtube/fetch-transcripts.ts
// CRITICAL: All helpers inline. No shared local imports.

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // ── Auth: Accept cron secret OR user bearer token ──
  const cronSecret = req.headers['authorization']?.replace('Bearer ', '');
  const isCron = cronSecret === process.env.CRON_SECRET;

  const supabase = createClient(
    process.env.VITE_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!  // Service role for cron; use anon key + auth for user-triggered
  );

  let userId: string | null = null;

  if (!isCron) {
    // User-triggered (from "Process Now" button)
    const token = req.headers['authorization']?.replace('Bearer ', '');
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) return res.status(401).json({ error: 'Unauthorized' });
    userId = user.id;
  }

  // ── Pick pending items that need transcripts ──
  let query = supabase
    .from('youtube_ingestion_queue')
    .select('*')
    .eq('status', 'pending')
    .is('transcript', null)
    .order('priority', { ascending: true })
    .order('created_at', { ascending: true })
    .limit(5);

  if (userId) {
    query = query.eq('user_id', userId);
  }

  const { data: items, error: fetchError } = await query;
  if (fetchError || !items?.length) {
    return res.status(200).json({ processed: 0, message: 'No items to fetch' });
  }

  // ── Mark all selected items as 'fetching_transcript' ──
  const itemIds = items.map(i => i.id);
  await supabase
    .from('youtube_ingestion_queue')
    .update({ status: 'fetching_transcript', started_at: new Date().toISOString() })
    .in('id', itemIds);

  // ── Process in parallel batches of 3 ──
  const PARALLEL_LIMIT = 3;
  const results: Array<{ id: string; success: boolean; error?: string }> = [];

  for (let i = 0; i < items.length; i += PARALLEL_LIMIT) {
    const batch = items.slice(i, i + PARALLEL_LIMIT);
    const batchResults = await Promise.allSettled(
      batch.map(item => fetchTranscriptForItem(item, supabase))
    );

    batchResults.forEach((result, idx) => {
      const item = batch[idx];
      if (result.status === 'fulfilled') {
        results.push({ id: item.id, success: result.value.success, error: result.value.error });
      } else {
        results.push({ id: item.id, success: false, error: result.reason?.message || 'Unknown error' });
      }
    });
  }

  return res.status(200).json({
    processed: results.length,
    succeeded: results.filter(r => r.success).length,
    failed: results.filter(r => !r.success).length,
    details: results,
  });
}

// ── Inline helper: Fetch transcript for a single item ──

async function fetchTranscriptForItem(
  item: any,
  supabase: any
): Promise<{ success: boolean; error?: string }> {
  const videoId = item.video_id;

  try {
    // Tier 1: youtube-caption-extractor
    let transcript = await tryTier1(videoId);

    // Tier 2: Innertube API
    if (!transcript) {
      transcript = await tryTier2(videoId);
    }

    // Tier 3: Apify (only if API key exists)
    if (!transcript && item.apify_api_key) {
      transcript = await tryTier3(videoId, item.apify_api_key);
    }

    if (!transcript) {
      // All tiers failed
      const newRetryCount = (item.retry_count || 0) + 1;
      const maxRetries = item.max_retries || 3;

      await supabase
        .from('youtube_ingestion_queue')
        .update({
          status: newRetryCount >= maxRetries ? 'failed' : 'pending',
          error_message: 'Transcript fetch failed on all tiers',
          retry_count: newRetryCount,
        })
        .eq('id', item.id);

      return { success: false, error: 'All transcript tiers failed' };
    }

    // Success — store transcript and advance status
    await supabase
      .from('youtube_ingestion_queue')
      .update({
        status: 'transcript_ready',
        transcript: transcript,
        transcript_fetched_at: new Date().toISOString(),
        error_message: null,
      })
      .eq('id', item.id);

    return { success: true };

  } catch (err: any) {
    await supabase
      .from('youtube_ingestion_queue')
      .update({
        status: 'failed',
        error_message: `Transcript fetch error: ${err.message}`,
      })
      .eq('id', item.id);

    return { success: false, error: err.message };
  }
}

// ── Inline: Tier 1 — youtube-caption-extractor ──
async function tryTier1(videoId: string): Promise<string | null> {
  try {
    // Import dynamically to avoid cold start cost if not needed
    const { getSubtitles } = await import('youtube-caption-extractor');
    const captions = await Promise.race([
      getSubtitles({ videoID: videoId, lang: 'en' }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Tier 1 timeout')), 15000)),
    ]);
    if (!captions?.length) return null;
    return captions.map((c: any) => c.text).join(' ');
  } catch {
    return null;
  }
}

// ── Inline: Tier 2 — Innertube API ──
async function tryTier2(videoId: string): Promise<string | null> {
  try {
    const response = await Promise.race([
      fetch('https://www.youtube.com/youtubei/v1/get_transcript', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          context: {
            client: { clientName: 'WEB', clientVersion: '2.20240101.00.00' },
          },
          params: Buffer.from(`\n\x0b${videoId}`).toString('base64'),
        }),
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Tier 2 timeout')), 15000)),
    ]);

    if (!response.ok) return null;
    const data = await response.json();

    const segments = data?.actions?.[0]?.updateEngagementPanelAction
      ?.content?.transcriptRenderer?.body?.transcriptBodyRenderer
      ?.cueGroups;

    if (!segments?.length) return null;
    return segments
      .map((g: any) => g.transcriptCueGroupRenderer?.cues?.[0]
        ?.transcriptCueRenderer?.cue?.simpleText || '')
      .filter(Boolean)
      .join(' ');
  } catch {
    return null;
  }
}

// ── Inline: Tier 3 — Apify ──
async function tryTier3(videoId: string, apiKey: string): Promise<string | null> {
  try {
    const runResponse = await fetch(
      `https://api.apify.com/v2/acts/pintostudio~youtube-transcript-scraper/runs?token=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          urls: [`https://www.youtube.com/watch?v=${videoId}`],
          outputFormat: 'plainText',
        }),
      }
    );

    if (!runResponse.ok) return null;
    const run = await runResponse.json();
    const runId = run.data?.id;
    if (!runId) return null;

    // Poll for completion (max 120s)
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 5000));
      const statusRes = await fetch(
        `https://api.apify.com/v2/actor-runs/${runId}?token=${apiKey}`
      );
      const statusData = await statusRes.json();
      if (statusData.data?.status === 'SUCCEEDED') {
        const datasetRes = await fetch(
          `https://api.apify.com/v2/actor-runs/${runId}/dataset/items?token=${apiKey}`
        );
        const dataset = await datasetRes.json();
        return dataset?.[0]?.text || dataset?.[0]?.transcript || null;
      }
      if (statusData.data?.status === 'FAILED' || statusData.data?.status === 'ABORTED') {
        return null;
      }
    }
    return null;
  } catch {
    return null;
  }
}
```

### Apify Tier 3 & Timeout Concern

Tier 3 (Apify) polls for up to 120s — this **will** exceed Vercel's function timeout on Hobby (10s) and Pro (60s) plans. Two options:

**Option A (recommended for Pro plan):** Skip Tier 3 inside this function. Only run Tiers 1+2 (which complete in ~15s each, well within 60s). Mark items that fail Tiers 1+2 with a `transcript_tier3_pending` status. A separate `api/youtube/fetch-apify.ts` function with `maxDuration: 120` (requires Vercel Pro) handles just Apify tier.

**Option B (works on any plan):** Fire-and-forget the Apify run, store the `run_id` on the queue item, and check completion on the next cron invocation. This is the most timeout-safe approach:

```typescript
// On Tier 1+2 failure: start Apify run, store run_id, keep status as 'pending'
await supabase.from('youtube_ingestion_queue').update({
  status: 'pending',  // will be picked up again next cron
  error_message: null,
  metadata: { apify_run_id: runId, apify_started_at: new Date().toISOString() },
}).eq('id', item.id);

// Next cron invocation: check if apify_run_id exists, poll for result
```

**Recommendation:** Use Option B. It's plan-agnostic and naturally handles the async Apify lifecycle without blocking the function.

---

## 5. Serverless Function: `api/youtube/extract-knowledge.ts`

**Purpose:** Run Gemini extraction pipeline on items that have transcripts ready.

**Trigger:** Vercel cron every 2 minutes (offset from fetch-transcripts), OR called by orchestrator.

**Batch size:** 2 items in parallel via `Promise.allSettled`.

**Target execution time:** <50 seconds.

### Implementation

```typescript
// api/youtube/extract-knowledge.ts
// CRITICAL: All helpers inline. No shared local imports.

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // ── Auth (same pattern as fetch-transcripts.ts — inline, not imported) ──
  const cronSecret = req.headers['authorization']?.replace('Bearer ', '');
  const isCron = cronSecret === process.env.CRON_SECRET;

  const supabase = createClient(
    process.env.VITE_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  let userId: string | null = null;

  if (!isCron) {
    const token = req.headers['authorization']?.replace('Bearer ', '');
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) return res.status(401).json({ error: 'Unauthorized' });
    userId = user.id;
  }

  // ── Pick items with transcripts ready for extraction ──
  let query = supabase
    .from('youtube_ingestion_queue')
    .select('*')
    .eq('status', 'transcript_ready')
    .order('priority', { ascending: true })
    .order('created_at', { ascending: true })
    .limit(2);

  if (userId) {
    query = query.eq('user_id', userId);
  }

  const { data: items, error: fetchError } = await query;
  if (fetchError || !items?.length) {
    return res.status(200).json({ processed: 0, message: 'No items ready for extraction' });
  }

  // ── Mark as 'extracting' ──
  const itemIds = items.map(i => i.id);
  await supabase
    .from('youtube_ingestion_queue')
    .update({ status: 'extracting' })
    .in('id', itemIds);

  // ── Extract in parallel (2 concurrent) ──
  const results = await Promise.allSettled(
    items.map(item => extractKnowledgeForItem(item, supabase))
  );

  const output = results.map((result, idx) => {
    const item = items[idx];
    if (result.status === 'fulfilled') {
      return { id: item.id, video_id: item.video_id, ...result.value };
    }
    return { id: item.id, video_id: item.video_id, success: false, error: result.reason?.message };
  });

  return res.status(200).json({
    processed: output.length,
    succeeded: output.filter(r => r.success).length,
    failed: output.filter(r => !r.success).length,
    details: output,
  });
}

// ── Inline: Full extraction pipeline for one item ──

async function extractKnowledgeForItem(
  item: any,
  supabase: any
): Promise<{ success: boolean; nodesCreated?: number; edgesCreated?: number; error?: string }> {
  const GEMINI_API_KEY = process.env.VITE_GEMINI_API_KEY!;
  const transcript = item.transcript;
  const userId = item.user_id;

  if (!transcript) {
    await markFailed(supabase, item.id, 'No transcript available');
    return { success: false, error: 'No transcript' };
  }

  try {
    // ── Step 1: Save source to knowledge_sources ──
    const { data: source, error: sourceError } = await supabase
      .from('knowledge_sources')
      .insert({
        user_id: userId,
        title: item.video_title || `YouTube: ${item.video_id}`,
        content: transcript,
        source_type: 'YouTube',
        source_url: item.video_url,
        metadata: {
          video_id: item.video_id,
          channel_id: item.channel_id,
          thumbnail_url: item.thumbnail_url,
          published_at: item.published_at,
          duration_seconds: item.duration_seconds,
        },
      })
      .select('id')
      .single();

    if (sourceError) throw new Error(`Source save failed: ${sourceError.message}`);
    const sourceId = source.id;

    // Link queue item to source
    await supabase
      .from('youtube_ingestion_queue')
      .update({ source_id: sourceId })
      .eq('id', item.id);

    // ── Step 2: Build extraction prompt ──
    // Fetch user's anchors for context
    const { data: anchors } = await supabase
      .from('knowledge_nodes')
      .select('label, entity_type, description')
      .eq('user_id', userId)
      .eq('is_anchor', true);

    // Fetch user profile for context
    const { data: profile } = await supabase
      .from('user_profiles')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();

    const systemPrompt = buildExtractionPromptInline({
      mode: item.extraction_mode || 'comprehensive',
      anchorEmphasis: item.anchor_emphasis || 'standard',
      anchors: anchors || [],
      userProfile: profile,
      customInstructions: item.custom_instructions,
    });

    // ── Step 3: Extract entities via Gemini ──
    const extractionResponse = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: systemPrompt }] },
          contents: [{ parts: [{ text: transcript }] }],
          generationConfig: {
            temperature: 0.1,
            responseMimeType: 'application/json',
          },
        }),
      }
    );

    if (!extractionResponse.ok) {
      throw new Error(`Gemini extraction failed: ${extractionResponse.status}`);
    }

    const extractionData = await extractionResponse.json();
    const extractedText = extractionData.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!extractedText) throw new Error('Empty Gemini response');

    const extracted = JSON.parse(extractedText);
    const entities = extracted.entities || [];
    const relationships = extracted.relationships || [];

    // ── Step 4: Deduplicate and save nodes ──
    const { data: existingNodes } = await supabase
      .from('knowledge_nodes')
      .select('id, label, entity_type')
      .eq('user_id', userId);

    const existingLabels = new Map(
      (existingNodes || []).map((n: any) => [n.label.toLowerCase(), n.id])
    );

    const nodesToInsert: any[] = [];
    const labelToIdMap = new Map<string, string>(); // maps extracted label → saved node ID

    for (const entity of entities) {
      const existingId = existingLabels.get(entity.label.toLowerCase());
      if (existingId) {
        // Duplicate — map to existing node
        labelToIdMap.set(entity.label, existingId);
      } else {
        nodesToInsert.push({
          user_id: userId,
          label: entity.label,
          entity_type: entity.entity_type,
          description: entity.description,
          confidence: entity.confidence,
          source: item.video_title || 'YouTube Video',
          source_type: 'YouTube',
          source_url: item.video_url,
          source_id: sourceId,
          tags: entity.tags?.length ? entity.tags : undefined,
        });
      }
    }

    let savedNodes: any[] = [];
    if (nodesToInsert.length > 0) {
      const { data: inserted, error: insertError } = await supabase
        .from('knowledge_nodes')
        .insert(nodesToInsert)
        .select('id, label');

      if (insertError) throw new Error(`Node insert failed: ${insertError.message}`);
      savedNodes = inserted || [];
      for (const node of savedNodes) {
        labelToIdMap.set(node.label, node.id);
      }
    }

    // ── Step 5: Save edges ──
    const edgesToInsert = relationships
      .map((rel: any) => {
        const sourceNodeId = labelToIdMap.get(rel.source);
        const targetNodeId = labelToIdMap.get(rel.target);
        if (!sourceNodeId || !targetNodeId) return null;
        if (sourceNodeId === targetNodeId) return null;
        return {
          user_id: userId,
          source_node_id: sourceNodeId,
          target_node_id: targetNodeId,
          relation_type: rel.relation_type,
          evidence: rel.evidence,
        };
      })
      .filter(Boolean);

    let edgesCreated = 0;
    if (edgesToInsert.length > 0) {
      const { data: insertedEdges, error: edgeError } = await supabase
        .from('knowledge_edges')
        .insert(edgesToInsert)
        .select('id');

      if (edgeError) {
        console.warn(`Edge insert warning: ${edgeError.message}`);
      }
      edgesCreated = insertedEdges?.length || 0;
    }

    // ── Step 6: Generate embeddings for new nodes ──
    // Process embeddings in small batches to stay within time budget
    const EMBEDDING_BATCH_SIZE = 5;
    for (let i = 0; i < savedNodes.length; i += EMBEDDING_BATCH_SIZE) {
      const batch = savedNodes.slice(i, i + EMBEDDING_BATCH_SIZE);
      await Promise.allSettled(
        batch.map(async (node: any) => {
          try {
            const embeddingText = `${node.label}: ${
              nodesToInsert.find((n: any) => n.label === node.label)?.description || node.label
            }`;
            const embResponse = await fetch(
              `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent?key=${GEMINI_API_KEY}`,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  model: 'models/gemini-embedding-001',
                  content: { parts: [{ text: embeddingText }] },
                }),
              }
            );
            const embData = await embResponse.json();
            const embedding = embData?.embedding?.values;
            if (embedding) {
              await supabase
                .from('knowledge_nodes')
                .update({ embedding: JSON.stringify(embedding) })
                .eq('id', node.id);
            }
          } catch (embErr) {
            console.warn(`Embedding failed for node ${node.id}:`, embErr);
            // Non-fatal — continue pipeline
          }
        })
      );
    }

    // ── Step 7: Chunk source content and embed chunks ──
    const chunks = chunkContentInline(transcript, 500);
    if (chunks.length > 0) {
      const chunkInserts = chunks.map((chunk: string, idx: number) => ({
        user_id: userId,
        source_id: sourceId,
        content: chunk,
        chunk_index: idx,
      }));

      const { data: savedChunks } = await supabase
        .from('source_chunks')
        .insert(chunkInserts)
        .select('id, content');

      // Embed chunks (best-effort, non-blocking on individual failures)
      if (savedChunks?.length) {
        for (let i = 0; i < savedChunks.length; i += EMBEDDING_BATCH_SIZE) {
          const chunkBatch = savedChunks.slice(i, i + EMBEDDING_BATCH_SIZE);
          await Promise.allSettled(
            chunkBatch.map(async (chunk: any) => {
              try {
                const embResponse = await fetch(
                  `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent?key=${GEMINI_API_KEY}`,
                  {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      model: 'models/gemini-embedding-001',
                      content: { parts: [{ text: chunk.content }] },
                    }),
                  }
                );
                const embData = await embResponse.json();
                const embedding = embData?.embedding?.values;
                if (embedding) {
                  await supabase
                    .from('source_chunks')
                    .update({ embedding: JSON.stringify(embedding) })
                    .eq('id', chunk.id);
                }
              } catch {
                // Non-fatal
              }
            })
          );
        }
      }
    }

    // ── Step 8: Mark complete ──
    await supabase
      .from('youtube_ingestion_queue')
      .update({
        status: 'completed',
        nodes_created: savedNodes.length,
        edges_created: edgesCreated,
        completed_at: new Date().toISOString(),
        error_message: null,
      })
      .eq('id', item.id);

    return { success: true, nodesCreated: savedNodes.length, edgesCreated };

  } catch (err: any) {
    await markFailed(supabase, item.id, err.message);
    return { success: false, error: err.message };
  }
}

// ── Inline helpers ──

async function markFailed(supabase: any, itemId: string, message: string) {
  await supabase
    .from('youtube_ingestion_queue')
    .update({
      status: 'failed',
      error_message: message,
      completed_at: new Date().toISOString(),
    })
    .eq('id', itemId);
}

function buildExtractionPromptInline(config: {
  mode: string;
  anchorEmphasis: string;
  anchors: any[];
  userProfile: any;
  customInstructions?: string | null;
}): string {
  // NOTE: This is a simplified inline version. Copy the full prompt composition
  // logic from src/utils/promptBuilder.ts, src/config/extractionModes.ts,
  // src/utils/anchorContext.ts, and src/utils/profileContext.ts.
  //
  // The AI coding agent should:
  // 1. Read the current promptBuilder.ts implementation
  // 2. Inline the complete prompt composition logic here
  // 3. Include the full entity ontology, extraction mode templates, and all context layers
  //
  // Placeholder structure:
  const parts: string[] = [
    getBaseInstructionsInline(),
    getModeTemplateInline(config.mode),
  ];

  if (config.userProfile) {
    parts.push(`\n## User Context\nRole: ${config.userProfile.role || 'Not specified'}\nInterests: ${config.userProfile.interests || 'Not specified'}`);
  }

  if (config.anchors.length > 0) {
    const anchorList = config.anchors.map(a => `- ${a.label} (${a.entity_type}): ${a.description || 'No description'}`).join('\n');
    const emphasisInstruction = config.anchorEmphasis === 'aggressive'
      ? 'Prioritize finding connections to these anchors.'
      : config.anchorEmphasis === 'passive'
        ? 'These are areas of interest for optional reference.'
        : 'Find connections to these anchors where they naturally exist.';
    parts.push(`\n## Anchor Context\n${emphasisInstruction}\n\nAnchors:\n${anchorList}`);
  }

  if (config.customInstructions) {
    parts.push(`\n## Additional Guidance\n${config.customInstructions}`);
  }

  return parts.join('\n\n');
}

function getBaseInstructionsInline(): string {
  // AGENT NOTE: Copy the full base instructions from src/utils/promptBuilder.ts
  // This should include the complete entity ontology (all 24 types), relationship types,
  // output JSON schema, and core extraction rules.
  return `You are a knowledge extraction engine. Extract entities and relationships from the following content.

Return JSON with this exact structure:
{
  "entities": [
    { "label": "string", "entity_type": "string", "description": "string", "confidence": 0.0-1.0, "tags": ["string"] }
  ],
  "relationships": [
    { "source": "entity label", "target": "entity label", "relation_type": "string", "evidence": "string" }
  ]
}

Entity types: Person, Organization, Team, Topic, Project, Goal, Action, Risk, Blocker, Decision, Insight, Question, Idea, Concept, Takeaway, Lesson, Document, Event, Location, Technology, Product, Metric, Hypothesis, Anchor

Relationship types (positive): leads_to, supports, enables, created, achieved, produced
Relationship types (negative): blocks, contradicts, risks, prevents, challenges, inhibits
Relationship types (neutral): part_of, relates_to, mentions, connected_to, owns, associated_with

Rules:
- One entity per distinct concept. No duplicate labels.
- Confidence reflects how clearly the entity is discussed in the source.
- Every relationship must reference entity labels that exist in the entities array.`;
}

function getModeTemplateInline(mode: string): string {
  // AGENT NOTE: Copy the full mode templates from src/config/extractionModes.ts
  const templates: Record<string, string> = {
    comprehensive: 'Extract ALL entities and relationships. Maximize coverage. Include minor details.',
    strategic: 'Focus on high-level concepts, decisions, and strategic insights. Skip minor details.',
    actionable: 'Prioritize actions, goals, blockers, decisions, ownership, and deadlines.',
    relational: 'Emphasize connections between concepts over individual entities.',
  };
  return `## Extraction Mode: ${mode}\n${templates[mode] || templates.comprehensive}`;
}

function chunkContentInline(content: string, targetTokens: number = 500): string[] {
  // Approximate: 1 token ≈ 4 characters
  const targetChars = targetTokens * 4;
  const sentences = content.match(/[^.!?]+[.!?]+/g) || [content];
  const chunks: string[] = [];
  let current = '';

  for (const sentence of sentences) {
    if (current.length + sentence.length > targetChars && current.length > 0) {
      chunks.push(current.trim());
      current = sentence;
    } else {
      current += sentence;
    }
  }
  if (current.trim()) chunks.push(current.trim());

  return chunks;
}
```

---

## 6. Updated `api/youtube/process.ts` (Orchestrator)

The existing `process.ts` becomes a lightweight orchestrator that delegates to the two new functions. This preserves the existing cron entry and "Process Now" button behavior.

```typescript
// api/youtube/process.ts
// Updated: Now delegates to fetch-transcripts and extract-knowledge

import type { VercelRequest, VercelResponse } from '@vercel/node';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const baseUrl = `https://${req.headers.host}`;
  const authHeader = req.headers['authorization'] || '';

  try {
    // Phase 1: Fetch transcripts for pending items
    const fetchRes = await fetch(`${baseUrl}/api/youtube/fetch-transcripts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': authHeader,
      },
    });
    const fetchData = await fetchRes.json();

    // Phase 2: Extract knowledge for items with transcripts
    const extractRes = await fetch(`${baseUrl}/api/youtube/extract-knowledge`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': authHeader,
      },
    });
    const extractData = await extractRes.json();

    return res.status(200).json({
      fetch: fetchData,
      extract: extractData,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
}
```

**Important:** The orchestrator itself makes two HTTP calls, each of which runs as a separate serverless function with its own timeout budget. Even if `process.ts` times out, the functions it called continue running independently until they complete or hit their own timeout.

---

## 7. Frontend Changes

### 7.1 Update "Process Now" Button Behavior

The "Process Now" button in `QueueHub.tsx` / `ProcessingQueueSection.tsx` should call the new endpoints in sequence rather than a single monolithic `process.ts` call.

```typescript
// In the component handling "Process Now"

async function handleProcessNow() {
  setIsProcessing(true);
  try {
    // Step 1: Fetch transcripts for all pending items
    const fetchRes = await fetch('/api/youtube/fetch-transcripts', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${session.access_token}`,
      },
    });
    const fetchResult = await fetchRes.json();

    // Step 2: Extract knowledge for all ready items
    const extractRes = await fetch('/api/youtube/extract-knowledge', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${session.access_token}`,
      },
    });
    const extractResult = await extractRes.json();

    // Refresh queue data
    await refetchQueue();
  } catch (err) {
    console.error('Process Now failed:', err);
  } finally {
    setIsProcessing(false);
  }
}
```

**Key behavioral change:** Instead of waiting for all items to complete, the UI should poll the queue for status changes. The "Process Now" button fires the requests and the queue UI updates as items transition through statuses.

### 7.2 Update Queue Status Display

Add `'transcript_ready'` to the status display in queue UI components.

```typescript
// Update the status display mapping in QueueItemCard or ProcessingQueueSection

const STATUS_CONFIG: Record<string, { label: string; color: string; step: number }> = {
  pending: { label: 'Queued', color: 'var(--color-text-secondary)', step: 0 },
  fetching_transcript: { label: 'Fetching Transcript', color: 'var(--color-accent-500)', step: 1 },
  transcript_ready: { label: 'Transcript Ready', color: 'var(--color-semantic-green-500)', step: 2 },
  extracting: { label: 'Extracting Knowledge', color: 'var(--color-accent-500)', step: 3 },
  completed: { label: 'Complete', color: 'var(--color-semantic-green-500)', step: 4 },
  failed: { label: 'Failed', color: 'var(--color-semantic-red-500)', step: -1 },
  skipped: { label: 'Skipped', color: 'var(--color-text-secondary)', step: -1 },
};
```

### 7.3 Update Retry Logic

When retrying a failed item that already has a transcript, set status to `transcript_ready` instead of `pending`:

```typescript
// Update retryQueueItem in services/supabase.ts

export async function retryQueueItem(itemId: string): Promise<void> {
  // First, check if item already has a transcript
  const { data: item } = await supabase
    .from('youtube_ingestion_queue')
    .select('transcript')
    .eq('id', itemId)
    .eq('status', 'failed')
    .maybeSingle();

  if (!item) throw new Error('Item not found or not in failed state');

  const newStatus = item.transcript ? 'transcript_ready' : 'pending';

  const { error } = await supabase
    .from('youtube_ingestion_queue')
    .update({
      status: newStatus,
      error_message: null,
      started_at: null,
      completed_at: null,
    })
    .eq('id', itemId)
    .eq('status', 'failed');

  if (error) throw new Error(`Failed to retry item: ${error.message}`);
}
```

### 7.4 Update Queue Filter

The "Processing" filter should match both `fetching_transcript` and `extracting` (and optionally `transcript_ready`):

```typescript
// Update the filter logic in ProcessingQueueSection or QueueHub

function getFilterStatuses(filter: QueueStatusFilter): string[] {
  switch (filter) {
    case 'pending': return ['pending', 'transcript_ready'];
    case 'processing': return ['fetching_transcript', 'extracting'];
    case 'completed': return ['completed'];
    case 'failed': return ['failed'];
    case 'all':
    default: return [];
  }
}
```

---

## 8. Vercel Cron Configuration

Update `vercel.json` to run the two functions on offset schedules:

```json
{
  "crons": [
    {
      "path": "/api/youtube/fetch-transcripts",
      "schedule": "*/2 * * * *"
    },
    {
      "path": "/api/youtube/extract-knowledge",
      "schedule": "1-59/2 * * * *"
    },
    {
      "path": "/api/youtube/poll",
      "schedule": "*/15 * * * *"
    },
    {
      "path": "/api/youtube/poll-playlist",
      "schedule": "*/5 * * * *"
    }
  ]
}
```

The offset (`*/2` vs `1-59/2`) ensures fetch-transcripts runs on even minutes and extract-knowledge runs on odd minutes, giving each function a clean runway.

---

## 9. Files to Create/Modify

| File | Action | Description |
|---|---|---|
| `api/youtube/fetch-transcripts.ts` | **CREATE** | New function: transcript fetching with 3-tier fallback, parallel batches of 3 |
| `api/youtube/extract-knowledge.ts` | **CREATE** | New function: Gemini extraction pipeline, parallel batches of 2 |
| `api/youtube/process.ts` | **MODIFY** | Refactor to orchestrator that calls the two new functions |
| `src/types/automate.ts` | **MODIFY** | Add `'transcript_ready'` to QueueItem status union type |
| `src/services/supabase.ts` | **MODIFY** | Update `retryQueueItem()` to check for existing transcript |
| `src/components/automate/ProcessingQueueSection.tsx` | **MODIFY** | Add `transcript_ready` status display, update filter logic |
| `src/components/ingest/QueueStatusBanner.tsx` | **MODIFY** | Include `transcript_ready` in processing count |
| `vercel.json` | **MODIFY** | Add cron entries for new functions |

---

## 10. Edge Cases & Error Handling

### Concurrent Cron Invocations
Two cron runs could pick up the same items if one is slow. **Mitigation:** The `UPDATE ... SET status = 'fetching_transcript'` acts as a claim. Use `.eq('status', 'pending')` in both the SELECT and UPDATE so if another invocation already claimed the item, the update affects 0 rows. Verify the update count before proceeding.

### Partial Transcript Fetch Failure
If 3 items are fetched in parallel and 1 fails: the 2 successful items advance to `transcript_ready`, the failed item gets retry logic applied. The extract-knowledge function picks up whatever is ready.

### Extraction Failure After Transcript Success
If extraction fails but transcript was saved, the item stays in `failed` with its transcript intact. Retry sends it to `transcript_ready` (skipping re-fetch).

### Gemini Rate Limits
The 2-parallel extraction limit is intentionally conservative. If Gemini returns 429 (rate limit), catch it and set `error_message: 'Rate limited — will retry'`, increment retry count, set status back to `transcript_ready`.

### Empty Transcript
If a transcript is fetched but is empty/whitespace, treat it as a Tier failure and move to the next tier. Do not advance to `transcript_ready` with an empty string.

### Queue Item Stuck in `fetching_transcript` or `extracting`
Add a cleanup query at the start of each function: any item that's been in `fetching_transcript` for >5 minutes or `extracting` for >5 minutes gets reset to its previous state (with a note in `error_message`):

```typescript
// At the top of each function, before picking new items:
await supabase
  .from('youtube_ingestion_queue')
  .update({ status: 'pending', error_message: 'Reset: stuck in fetching_transcript' })
  .eq('status', 'fetching_transcript')
  .lt('started_at', new Date(Date.now() - 5 * 60 * 1000).toISOString());

await supabase
  .from('youtube_ingestion_queue')
  .update({ status: 'transcript_ready', error_message: 'Reset: stuck in extracting' })
  .eq('status', 'extracting')
  .lt('started_at', new Date(Date.now() - 5 * 60 * 1000).toISOString());
```

---

## 11. Testing Guidance

- [ ] **Single video flow:** Queue 1 video → verify it moves through `pending` → `fetching_transcript` → `transcript_ready` → `extracting` → `completed` with correct timestamp updates at each stage
- [ ] **Batch transcript fetch:** Queue 5 videos → trigger `fetch-transcripts` → verify 3 run in parallel, then remaining 2 → all reach `transcript_ready`
- [ ] **Parallel extraction:** Have 2+ items in `transcript_ready` → trigger `extract-knowledge` → verify both run simultaneously → both reach `completed`
- [ ] **Transcript fetch failure:** Use a video ID known to have no captions → verify it retries, then fails after max retries
- [ ] **Extraction failure with transcript preserved:** Temporarily break the Gemini API key → trigger extraction → verify item fails but transcript column is preserved → fix API key → retry → verify it goes to `transcript_ready` (not `pending`) and succeeds
- [ ] **"Process Now" button:** Queue 10 videos → click "Process Now" → verify function returns quickly, queue UI updates as items progress through statuses
- [ ] **Stuck item cleanup:** Manually set an item to `fetching_transcript` with `started_at` > 5 min ago → run `fetch-transcripts` → verify item is reset to `pending`
- [ ] **Vercel timeout:** Deploy and test with actual Vercel function — ensure each function completes within 60s (Pro) or 10s (Hobby, with reduced batch sizes)
- [ ] **Queue filter UI:** Verify that `transcript_ready` items appear correctly under both "Pending" and "All" filters

---

## 12. Success Metrics

- **Zero timeout errors** when processing batches of 5–20 videos
- **Each serverless function completes in <50s** on Vercel Pro
- **Transcript fetch success rate remains ≥90%** (no regression from decoupling)
- **"Process Now" returns to the user in <5s** (fire-and-observe, not fire-and-wait)
- **Stuck item recovery works automatically** — no items left in intermediate states for >5 minutes

---

## 13. Out of Scope

- **Cross-connection discovery in serverless:** The current implementation runs cross-connections inline. For V2 optimization, this could be split into yet another function, but that's a future enhancement. Keep it in `extract-knowledge.ts` for now — skip it if the function is running long (time budget check).
- **Apify webhook integration:** Instead of polling Apify for completion, Apify can send a webhook when done. This is a future optimization that eliminates the Tier 3 timeout concern entirely.
- **Queue priority system:** The `priority` column exists but isn't user-configurable. Playlist-linked items could get higher priority. Future enhancement.
- **Embedding model migration:** This PRD uses `gemini-embedding-001` (3072 dimensions) per the RAG migration work (PRDs 15A–C). If the migration hasn't been applied yet, fall back to `text-embedding-004` (768 dimensions). The agent should check which model is available.

---

## 14. Implementation Notes for AI Agent

### Critical Reminders

1. **EVERY `api/` file must be 100% self-contained.** No imports from `src/`. No imports from sibling files. All helpers inline. npm packages are fine.

2. **The prompt builder MUST be inlined.** Copy the full prompt composition logic from `src/utils/promptBuilder.ts`, `src/config/extractionModes.ts`, `src/utils/anchorContext.ts`, and `src/utils/profileContext.ts` into `extract-knowledge.ts`. Yes, this means duplicating ~200 lines of code. This is the correct approach for Vercel serverless.

3. **The chunking utility MUST be inlined.** Copy from `src/utils/chunking.ts`.

4. **Check the embedding model:** Read `src/services/gemini.ts` to see which embedding model is currently in use (`text-embedding-004` at 768 dims or `gemini-embedding-001` at 3072 dims). Use the same model in the serverless function.

5. **Test each function independently after deployment.** Hit `/api/youtube/fetch-transcripts` directly with a valid auth token. Then hit `/api/youtube/extract-knowledge`. Don't assume the orchestrator works — test the parts first.

6. **Check Vercel runtime logs** (not build logs) if a function fails silently.
```
