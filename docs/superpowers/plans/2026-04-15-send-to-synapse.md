# Send to Synapse Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable users to send structured Claude Code session summaries into their Synapse knowledge graph via MCP, with full entity extraction.

**Architecture:** A Claude Code skill generates structured markdown from conversation context, then calls a new `send_to_synapse` MCP tool in `api/mcp.ts`, which forwards to a new `api/ingest/session.ts` Vercel endpoint. The endpoint saves the source as type `GitHub` and runs the full extraction pipeline (Gemini entity extraction, embeddings, chunking, cross-connections) inline, following the exact pattern from `api/meetings/process.ts`.

**Tech Stack:** TypeScript, Vercel serverless functions, Supabase, Gemini 2.0 Flash, Gemini Embedding 001

**Spec:** `docs/superpowers/specs/2026-04-15-send-to-synapse-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/types/database.ts` | Modify | Add `'GitHub'` to `SourceType` union |
| `src/config/sourceTypes.ts` | Modify | Add `GitHub` source type config (color, icon, label) |
| `api/ingest/session.ts` | **Create** | Vercel endpoint: save source + full extraction pipeline |
| `api/mcp.ts` | Modify | Add `send_to_synapse` tool descriptor + handler |
| `.env.local` | Modify | Add `INGEST_SECRET` variable |

**Note:** The Claude Code skill file is a separate markdown document installed outside this repo. Task 5 provides the full skill content to be installed via the user's Claude Code skill configuration.

---

### Task 1: Add GitHub Source Type to Frontend

**Files:**
- Modify: `src/types/database.ts:8`
- Modify: `src/config/sourceTypes.ts:7-13`

- [ ] **Step 1: Update SourceType union**

In `src/types/database.ts`, change line 8 from:

```typescript
export type SourceType = 'Meeting' | 'YouTube' | 'Research' | 'Note' | 'Document'
```

to:

```typescript
export type SourceType = 'Meeting' | 'YouTube' | 'Research' | 'Note' | 'Document' | 'GitHub'
```

- [ ] **Step 2: Add GitHub to source type config**

In `src/config/sourceTypes.ts`, add a new entry to the `SOURCE_TYPE_CONFIG` object after the `Document` line:

```typescript
export const SOURCE_TYPE_CONFIG: Record<string, SourceTypeConfig> = {
  Meeting:  { color: '#3b82f6', icon: '🎙', label: 'Meeting' },
  YouTube:  { color: '#ef4444', icon: '▶',  label: 'YouTube' },
  Research: { color: '#8b5cf6', icon: '🔬', label: 'Research' },
  Note:     { color: '#10b981', icon: '✏️', label: 'Note' },
  Document: { color: '#f59e0b', icon: '📋', label: 'Document' },
  GitHub:   { color: '#24292e', icon: '🔀', label: 'GitHub' },
}
```

- [ ] **Step 3: Verify build passes**

Run: `npx tsc --noEmit`
Expected: No errors. The new source type should be accepted everywhere `SourceType` is referenced.

- [ ] **Step 4: Commit**

```bash
git add src/types/database.ts src/config/sourceTypes.ts
git commit -m "feat: add GitHub source type for Claude Code session ingestion"
```

---

### Task 2: Create the Session Ingest Endpoint

**Files:**
- Create: `api/ingest/session.ts`

This is the heaviest task. The endpoint follows the exact same pipeline pattern as `api/meetings/process.ts` — all helpers are defined inline (Vercel serverless constraint: no local imports).

- [ ] **Step 1: Create `api/ingest/session.ts`**

```typescript
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

// Allow up to 120s on Vercel Pro (Gemini extraction + embeddings)
export const maxDuration = 120;

// ─── ENVIRONMENT ───────────────────────────────────────────────────────────────

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY!;
const INGEST_SECRET = process.env.INGEST_SECRET;

const getSupabase = () => createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const MAX_CONTENT_CHARS = 100_000;
const GEMINI_MAX_RETRIES = 3;

// ─── AUTH ──────────────────────────────────────────────────────────────────────

function verifyIngestSecret(req: VercelRequest): boolean {
  if (!INGEST_SECRET) return false;
  const secret = req.headers['x-ingest-secret'] as string | undefined;
  return secret === INGEST_SECRET;
}

// ─── GEMINI HELPERS (inlined — serverless cannot import local files) ──────────

async function fetchWithRetry(url: string, options: RequestInit, retries = GEMINI_MAX_RETRIES): Promise<Response> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const response = await fetch(url, options);
    if (response.status === 429 && attempt < retries) {
      const waitMs = Math.min(2000 * Math.pow(2, attempt), 15000);
      console.log(`[ingest/session] Gemini 429 rate limit, retrying in ${waitMs}ms (attempt ${attempt + 1}/${retries})`);
      await new Promise(r => setTimeout(r, waitMs));
      continue;
    }
    return response;
  }
  throw new Error('Gemini request failed after retries');
}

async function generateEmbedding(text: string): Promise<number[]> {
  const response = await fetch(
    `${GEMINI_BASE}/gemini-embedding-001:embedContent?key=${GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'models/gemini-embedding-001',
        content: { parts: [{ text }] },
      }),
      signal: AbortSignal.timeout(15000),
    }
  );
  if (!response.ok) return [];
  const data = await response.json() as { embedding?: { values?: number[] } };
  return data.embedding?.values ?? [];
}

async function generateSummary(content: string): Promise<string> {
  const response = await fetchWithRetry(
    `${GEMINI_BASE}/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: 'You are a concise summarizer. Produce a 2-3 sentence summary of the following content. Focus on what was accomplished, decided, or discovered.' }] },
        contents: [{ parts: [{ text: content.slice(0, 30000) }] }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 256 },
      }),
      signal: AbortSignal.timeout(15000),
    }
  );
  if (!response.ok) return '';
  const data = await response.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  return data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
}

// ─── EXTRACTION ────────────────────────────────────────────────────────────────

interface ExtractionResult {
  entities: Array<{
    label: string;
    entity_type: string;
    description: string;
    confidence: number;
    tags: string[];
  }>;
  relationships: Array<{
    source: string;
    target: string;
    relation_type: string;
    evidence: string;
  }>;
}

const ENTITY_TYPES = [
  'Person', 'Organization', 'Team', 'Topic', 'Project', 'Goal', 'Action',
  'Risk', 'Blocker', 'Decision', 'Insight', 'Question', 'Idea', 'Concept',
  'Takeaway', 'Lesson', 'Document', 'Event', 'Location', 'Technology',
  'Product', 'Metric', 'Hypothesis', 'Anchor',
];

const RELATIONSHIP_TYPES = [
  'leads_to', 'supports', 'enables', 'created', 'achieved', 'produced',
  'blocks', 'contradicts', 'risks', 'prevents', 'challenges', 'inhibits',
  'part_of', 'relates_to', 'mentions', 'connected_to', 'owns', 'associated_with',
];

function buildExtractionPrompt(config: {
  anchors: Array<{ label: string; entity_type: string; description: string }>;
  userProfile: { professional_context?: { role?: string; current_projects?: string }; personal_interests?: { topics?: string } } | null;
  customGuidance?: string | null;
}): string {
  let prompt = `You are a knowledge extraction system. Extract structured knowledge from a Claude Code session summary.

## Extraction Mode: comprehensive
Extract the maximum number of meaningful entities and all significant relationships. Capture every person, organization, concept, decision, and insight mentioned.

## Entity Types (use exactly these):
${ENTITY_TYPES.join(', ')}

## Relationship Types (use exactly these):
${RELATIONSHIP_TYPES.join(', ')}

## Output Format (JSON only):
{
  "entities": [
    {
      "label": "Entity name (concise, specific)",
      "entity_type": "One of the entity types above",
      "description": "1-3 sentence description",
      "confidence": 0.0-1.0,
      "tags": ["relevant", "tags"]
    }
  ],
  "relationships": [
    {
      "source": "Entity label (must match an entity above)",
      "target": "Entity label (must match an entity above)",
      "relation_type": "One of the relationship types above",
      "evidence": "Brief quote or paraphrase from content"
    }
  ]
}`;

  if (config.userProfile) {
    const role = config.userProfile.professional_context?.role;
    const projects = config.userProfile.professional_context?.current_projects;
    const interests = config.userProfile.personal_interests?.topics;
    if (role || projects || interests) {
      prompt += '\n\n## User Context (bias extraction toward relevance to this person):\n';
      if (role) prompt += `- Role: ${role}\n`;
      if (projects) prompt += `- Current projects: ${projects}\n`;
      if (interests) prompt += `- Interests: ${interests}\n`;
    }
  }

  if (config.anchors.length > 0) {
    prompt += `\n\n## Anchor Context (Heavily weight extraction toward anchor-related content. Actively connect extracted entities back to anchors where plausible.):\n`;
    for (const anchor of config.anchors.slice(0, 10)) {
      prompt += `- ${anchor.label} (${anchor.entity_type}): ${anchor.description}\n`;
    }
  }

  if (config.customGuidance) {
    prompt += `\n\n## Additional Instructions:\n${config.customGuidance}`;
  }

  prompt += '\n\nExtract knowledge from the following session summary. Return ONLY valid JSON matching the schema above.';
  return prompt;
}

async function extractEntities(content: string, systemPrompt: string): Promise<ExtractionResult> {
  const response = await fetchWithRetry(
    `${GEMINI_BASE}/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents: [{ parts: [{ text: content.slice(0, MAX_CONTENT_CHARS) }] }],
        generationConfig: { temperature: 0.1, responseMimeType: 'application/json' },
      }),
      signal: AbortSignal.timeout(60000),
    }
  );

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Gemini extraction failed: ${response.status} ${errText.slice(0, 200)}`);
  }

  const data = await response.json() as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('No extraction response from Gemini');

  try {
    return JSON.parse(text) as ExtractionResult;
  } catch {
    throw new Error(`Invalid JSON from Gemini: ${text.slice(0, 200)}`);
  }
}

function chunkText(text: string, targetTokens: number = 500): string[] {
  const targetChars = targetTokens * 4;
  const sentences = text.match(/[^.!?]+[.!?]+/g) ?? [text];
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
  return chunks.filter(c => c.length > 50);
}

// ─── HANDLER ───────────────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-ingest-secret');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!verifyIngestSecret(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const startTime = Date.now();

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
    // ── STEP 1: SAVE SOURCE ──────────────────────────────────────────────────
    const metadata: Record<string, unknown> = {
      ingested_via: 'mcp_session',
      extraction_status: 'pending',
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
    console.log(`[ingest/session] Saved source "${title}" (${sourceId}) for user ${userId}`);

    const updateStatus = async (status: string, extra?: Record<string, unknown>) => {
      const meta = { ...metadata, extraction_status: status, ...extra };
      await supabase.from('knowledge_sources').update({ metadata: meta }).eq('id', sourceId);
    };

    await updateStatus('processing', { processing_started_at: new Date().toISOString() });

    // ── STEP 2: GENERATE SUMMARY ────────────────────────────────────────────
    const summary = await generateSummary(content);
    if (summary) {
      await supabase
        .from('knowledge_sources')
        .update({ summary, summary_source: 'generated' })
        .eq('id', sourceId);
    }

    // ── STEP 3: FETCH EXTRACTION CONFIG ─────────────────────────────────────
    const [profileResult, anchorsResult] = await Promise.all([
      supabase.from('user_profiles').select('*').eq('user_id', userId).maybeSingle(),
      supabase
        .from('knowledge_nodes')
        .select('label, entity_type, description')
        .eq('user_id', userId)
        .eq('is_anchor', true)
        .limit(10),
    ]);

    const userProfile = profileResult.data as { professional_context?: { role?: string; current_projects?: string }; personal_interests?: { topics?: string } } | null;
    const anchors = (anchorsResult.data ?? []) as Array<{ label: string; entity_type: string; description: string }>;

    // ── STEP 4: GEMINI EXTRACTION ───────────────────────────────────────────
    const systemPrompt = buildExtractionPrompt({
      anchors,
      userProfile,
      customGuidance: guidance,
    });

    const extraction = await extractEntities(content, systemPrompt);
    const { entities = [], relationships = [] } = extraction;
    console.log(`[ingest/session] Source ${sourceId}: extracted ${entities.length} entities, ${relationships.length} relationships`);

    // ── STEP 5: DEDUP + SAVE NODES ──────────────────────────────────────────
    const savedNodeMap = new Map<string, string>();
    let nodesCreated = 0;

    // 5A: Exact-match deduplication
    const entityLabels = entities.filter(e => e.label && e.entity_type).map(e => e.label);
    const { data: existingNodes } = await supabase
      .from('knowledge_nodes')
      .select('id, label, entity_type')
      .eq('user_id', userId)
      .eq('is_merged', false)
      .in('label', entityLabels);

    const exactMatchMap = new Map<string, string>();
    for (const existing of existingNodes ?? []) {
      const matchingEntity = entities.find(
        e => e.label.toLowerCase() === (existing.label as string).toLowerCase()
          && e.entity_type === existing.entity_type
      );
      if (matchingEntity) {
        exactMatchMap.set(matchingEntity.label.toLowerCase(), existing.id as string);
      }
    }

    for (const [labelLower, existingId] of exactMatchMap) {
      const entity = entities.find(e => e.label.toLowerCase() === labelLower);
      if (entity) savedNodeMap.set(entity.label, existingId);
    }

    // 5B: Fuzzy/semantic dedup for unmatched entities
    const fuzzyMergeMap = new Map<string, string>();
    const prefetchedEmbeddings = new Map<string, number[]>();

    const entitiesToDedupCheck = entities.filter(
      e => e.label && e.entity_type && !exactMatchMap.has(e.label.toLowerCase())
    );

    const DEDUP_CONCURRENCY = 3;
    for (let i = 0; i < entitiesToDedupCheck.length; i += DEDUP_CONCURRENCY) {
      const batch = entitiesToDedupCheck.slice(i, i + DEDUP_CONCURRENCY);
      await Promise.allSettled(
        batch.map(async (entity) => {
          const embeddingText = `${entity.entity_type}: ${entity.label} — ${entity.description ?? ''}`;
          try {
            const embedding = await generateEmbedding(embeddingText);
            if (embedding.length > 0) {
              prefetchedEmbeddings.set(entity.label, embedding);
              const { data: matches } = await supabase.rpc('check_node_duplicate', {
                p_user_id: userId,
                p_label: entity.label,
                p_entity_type: entity.entity_type,
                p_embedding: embedding,
                p_exact_threshold: 0.92,
                p_semantic_threshold: 0.88,
              });
              const best = (matches as Array<{
                match_id: string; match_label: string; match_type: string; similarity: number;
              }> | null)?.[0];
              if (best && (best.match_type === 'exact' || (best.match_type === 'fuzzy' && best.similarity >= 0.95))) {
                fuzzyMergeMap.set(entity.label.toLowerCase(), best.match_id);
              }
            }
          } catch (err) {
            console.warn(`[ingest/session] Dedup check failed for "${entity.label}":`, err);
          }
        })
      );
    }

    for (const [labelLower, existingId] of fuzzyMergeMap) {
      const entity = entities.find(e => e.label.toLowerCase() === labelLower);
      if (entity) savedNodeMap.set(entity.label, existingId);
    }

    // 5C: Insert new nodes
    for (const entity of entities) {
      if (!entity.label || !entity.entity_type) continue;
      if (exactMatchMap.has(entity.label.toLowerCase())) continue;
      if (fuzzyMergeMap.has(entity.label.toLowerCase())) continue;

      const { data: nodeData, error: nodeError } = await supabase
        .from('knowledge_nodes')
        .insert({
          user_id: userId,
          label: entity.label,
          entity_type: entity.entity_type,
          description: entity.description ?? null,
          confidence: entity.confidence ?? 0.8,
          source: title,
          source_type: 'GitHub',
          source_id: sourceId,
          tags: entity.tags ?? [],
        })
        .select('id')
        .single();

      if (nodeError) {
        const { data: existing } = await supabase
          .from('knowledge_nodes')
          .select('id')
          .eq('user_id', userId)
          .eq('label', entity.label)
          .maybeSingle();
        if (existing) savedNodeMap.set(entity.label, (existing as { id: string }).id);
        continue;
      }

      if (nodeData) {
        savedNodeMap.set(entity.label, (nodeData as { id: string }).id);
        nodesCreated++;
      }
    }

    // ── STEP 6: GENERATE EMBEDDINGS ─────────────────────────────────────────
    const nodeEmbeddings = new Map<string, number[]>();
    const embeddingTasks = [...savedNodeMap.entries()]
      .map(([label, nodeId]) => {
        const entity = entities.find(e => e.label === label);
        const isReused = exactMatchMap.has(label.toLowerCase()) || fuzzyMergeMap.has(label.toLowerCase());
        return entity && !isReused ? { label, nodeId, entity } : null;
      })
      .filter((t): t is { label: string; nodeId: string; entity: (typeof entities)[0] } => t !== null);

    const EMBEDDING_CONCURRENCY = 5;
    for (let i = 0; i < embeddingTasks.length; i += EMBEDDING_CONCURRENCY) {
      const batch = embeddingTasks.slice(i, i + EMBEDDING_CONCURRENCY);
      await Promise.allSettled(
        batch.map(async ({ label, nodeId, entity }) => {
          const prefetched = prefetchedEmbeddings.get(label);
          const embedding = prefetched && prefetched.length > 0
            ? prefetched
            : await generateEmbedding(`${entity.entity_type}: ${entity.label} — ${entity.description ?? ''}`);
          try {
            if (embedding.length > 0) {
              nodeEmbeddings.set(nodeId, embedding);
              await supabase.from('knowledge_nodes').update({ embedding }).eq('id', nodeId);
            }
          } catch (err) {
            console.warn(`[ingest/session] Embedding failed for node ${label}:`, err);
          }
        })
      );
    }

    // ── STEP 7: SAVE EDGES ──────────────────────────────────────────────────
    let edgesCreated = 0;

    for (const rel of relationships) {
      const sourceNodeId = savedNodeMap.get(rel.source);
      const targetNodeId = savedNodeMap.get(rel.target);
      if (!sourceNodeId || !targetNodeId || sourceNodeId === targetNodeId) continue;

      const { error: edgeError } = await supabase
        .from('knowledge_edges')
        .insert({
          user_id: userId,
          source_node_id: sourceNodeId,
          target_node_id: targetNodeId,
          relation_type: rel.relation_type ?? 'relates_to',
          evidence: rel.evidence ?? null,
          weight: 1.0,
        });
      if (!edgeError) edgesCreated++;
    }

    // ── STEP 8: CHUNK + EMBED SOURCE ────────────────────────────────────────
    const chunks = chunkText(content);
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      if (!chunk) continue;
      try {
        const embedding = await generateEmbedding(chunk);
        await supabase.from('source_chunks').insert({
          user_id: userId,
          source_id: sourceId,
          chunk_index: i,
          content: chunk,
          embedding: embedding.length > 0 ? embedding : null,
        });
      } catch (err) {
        console.warn(`[ingest/session] Chunk ${i} failed:`, err);
      }
    }

    // ── STEP 9: CROSS-CONNECTION DISCOVERY ──────────────────────────────────
    let crossConnectionCount = 0;
    if (savedNodeMap.size > 0 && nodeEmbeddings.size > 0) {
      try {
        const newNodeIds = new Set(savedNodeMap.values());
        type SemanticCandidate = { id: string; label: string; entity_type: string; description: string | null };
        const candidateMap = new Map<string, SemanticCandidate>();

        for (const [_nodeId, embedding] of nodeEmbeddings) {
          const { data: similar } = await supabase.rpc('match_knowledge_nodes', {
            query_embedding: embedding,
            match_threshold: 0.55,
            match_count: 30,
            p_user_id: userId,
          });
          for (const s of similar ?? []) {
            if (!newNodeIds.has(s.id)) {
              candidateMap.set(s.id, s as SemanticCandidate);
            }
          }
        }

        const existingCandidates = [...candidateMap.values()].slice(0, 40);

        if (existingCandidates.length > 0) {
          const newEntityLines = entities.slice(0, 20)
            .map(e => `- [${e.entity_type}] ${e.label}: ${e.description ?? ''}`)
            .join('\n');
          const existingEntityLines = existingCandidates
            .map(e => `- [${e.entity_type}] ${e.label}: ${e.description ?? ''}`)
            .join('\n');

          const crossPrompt = `You are building a knowledge graph. Identify meaningful cross-source relationships between new and existing entities.

NEW entities (just extracted from a Claude Code session):
${newEntityLines}

EXISTING entities (already in the user's knowledge graph):
${existingEntityLines}

Rules:
- Only return connections where a meaningful, non-trivial relationship exists.
- Do NOT connect entities simply because they share a label or topic.
- Prefer directional types (leads_to, enables, supports, blocks) over generic types (relates_to).
- Skip connections between entities that appear to be the same concept.

Return ONLY valid JSON:
{
  "relationships": [
    { "source": "new entity label", "target": "existing entity label", "relation_type": "one of: leads_to|supports|enables|blocks|contradicts|part_of|relates_to|associated_with", "evidence": "one sentence justification" }
  ]
}

Return an empty array if no genuine cross-source connections exist.`;

          const crossResponse = await fetchWithRetry(
            `${GEMINI_BASE}/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                contents: [{ parts: [{ text: crossPrompt }] }],
                generationConfig: { temperature: 0.1, responseMimeType: 'application/json' },
              }),
              signal: AbortSignal.timeout(30000),
            }
          );

          if (crossResponse.ok) {
            const crossData = await crossResponse.json() as {
              candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
            };
            const crossText = crossData.candidates?.[0]?.content?.parts?.[0]?.text;

            if (crossText) {
              try {
                const crossResult = JSON.parse(crossText) as {
                  relationships?: Array<{ source: string; target: string; relation_type: string; evidence: string }>;
                };
                const existingNodeMap = new Map(existingCandidates.map(n => [n.label.toLowerCase(), n.id]));

                for (const rel of crossResult.relationships ?? []) {
                  const srcId = savedNodeMap.get(rel.source) ?? existingNodeMap.get(rel.source?.toLowerCase());
                  const tgtId = savedNodeMap.get(rel.target) ?? existingNodeMap.get(rel.target?.toLowerCase());
                  if (srcId && tgtId && srcId !== tgtId) {
                    await supabase.from('knowledge_edges').insert({
                      user_id: userId,
                      source_node_id: srcId,
                      target_node_id: tgtId,
                      relation_type: rel.relation_type ?? 'relates_to',
                      evidence: rel.evidence ?? null,
                      weight: 0.8,
                    });
                    edgesCreated++;
                    crossConnectionCount++;
                  }
                }
              } catch { /* ignore cross-connection parse errors */ }
            }
          }
        }
      } catch (err) {
        console.warn('[ingest/session] Cross-connection discovery failed:', err);
      }
    }

    // ── STEP 10: TRIGGER ANCHOR SCORING (fire-and-forget) ───────────────────
    const savedNodeIds = Array.from(savedNodeMap.values());
    if (savedNodeIds.length > 0) {
      const appUrl = process.env.VERCEL_URL
        ? `https://${process.env.VERCEL_URL}`
        : 'http://localhost:3000';
      const CRON_SECRET = process.env.CRON_SECRET;

      fetch(`${appUrl}/api/anchors/score-post-extraction`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${CRON_SECRET ?? ''}`,
        },
        body: JSON.stringify({ userId, sourceId, nodeIds: savedNodeIds }),
      }).catch(err => {
        console.warn('[ingest/session] Anchor scoring trigger failed (non-fatal):', err);
      });
    }

    // ── COMPLETE ────────────────────────────────────────────────────────────
    await updateStatus('completed');

    console.log(`[ingest/session] Complete: ${nodesCreated} nodes, ${edgesCreated} edges (${crossConnectionCount} cross), ${chunks.length} chunks in ${Date.now() - startTime}ms`);

    return res.status(200).json({
      source_id: sourceId,
      title,
      entity_count: entities.length,
      nodes_created: nodesCreated,
      nodes_reused: savedNodeMap.size - nodesCreated,
      edge_count: edgesCreated,
      cross_connections: crossConnectionCount,
      chunk_count: chunks.length,
      status: 'complete',
      duration_ms: Date.now() - startTime,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[ingest/session] Error:', err);
    return res.status(500).json({
      success: false,
      error: msg,
      duration_ms: Date.now() - startTime,
    });
  }
}
```

- [ ] **Step 2: Add INGEST_SECRET to `.env.local`**

Add the following line to `.env.local`:

```
INGEST_SECRET=synapse-ingest-a7f3b9c2e1d04568
```

Also add this same value to Vercel environment variables in the dashboard.

- [ ] **Step 3: Verify the file compiles**

Run: `npx tsc --noEmit`
Expected: No errors. The serverless function should compile cleanly.

- [ ] **Step 4: Commit**

```bash
git add api/ingest/session.ts
git commit -m "feat: add session ingest endpoint with full extraction pipeline"
```

---

### Task 3: Add `send_to_synapse` Tool to MCP Server

**Files:**
- Modify: `api/mcp.ts:314` (TOOLS array) and `api/mcp.ts:3034` (tools/call switch)

- [ ] **Step 1: Add the tool descriptor to the TOOLS array**

In `api/mcp.ts`, add the following entry to the `TOOLS` array (after the last existing tool descriptor, before the closing `]`):

```typescript
  {
    name: 'send_to_synapse',
    description:
      'Send a structured session summary from Claude Code into the Synapse knowledge graph. Creates a GitHub source and triggers the full extraction pipeline (entity extraction, embeddings, chunking, cross-connections). Use after generating a session summary.',
    inputSchema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Concise descriptive title for the session.',
        },
        content: {
          type: 'string',
          description: 'Full structured markdown summary of the session.',
        },
        repo: {
          type: 'string',
          description: 'Repository name (auto-detected from working directory).',
        },
        branch: {
          type: 'string',
          description: 'Git branch name at time of session.',
        },
        guidance: {
          type: 'string',
          description: 'User-provided instructions that shaped the summary emphasis.',
        },
      },
      required: ['title', 'content'],
    },
  },
```

- [ ] **Step 2: Add the handler function**

Add this function before the `// ─── Tool descriptors` section (around line 312):

```typescript
// ─── Send to Synapse handler ────────────────────────────────────────────────

async function handleSendToSynapse(
  args: { title: string; content: string; repo?: string; branch?: string; guidance?: string },
  userId: string
): Promise<ToolContent> {
  const INGEST_SECRET = process.env.INGEST_SECRET;
  if (!INGEST_SECRET) {
    return { content: [{ type: 'text', text: 'Error: INGEST_SECRET not configured on server.' }] };
  }

  const appUrl = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : 'http://localhost:3000';

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
    signal: AbortSignal.timeout(90000),
  });

  if (!response.ok) {
    const errBody = await response.text();
    return { content: [{ type: 'text', text: `Failed to ingest session: ${response.status} ${errBody.slice(0, 300)}` }] };
  }

  const result = await response.json() as {
    source_id: string;
    title: string;
    entity_count: number;
    edge_count: number;
    status: string;
  };

  return {
    content: [{
      type: 'text',
      text: `Session saved to Synapse.\n\nSource ID: ${result.source_id}\nTitle: ${result.title}\nEntities extracted: ${result.entity_count}\nRelationships created: ${result.edge_count}\nStatus: ${result.status}\n\nThe session is now in your knowledge graph and searchable via ask_synapse.`,
    }],
  };
}
```

- [ ] **Step 3: Add the case to the tools/call switch**

In the `switch (toolName)` block (around line 3043), add this case before the `default:` case:

```typescript
          case 'send_to_synapse':
            return jsonRpcResult(
              reqId,
              await handleSendToSynapse(
                {
                  title: toolArgs.title as string,
                  content: toolArgs.content as string,
                  repo: toolArgs.repo as string | undefined,
                  branch: toolArgs.branch as string | undefined,
                  guidance: toolArgs.guidance as string | undefined,
                },
                userId
              )
            )
```

- [ ] **Step 4: Update the file header comment**

Change the header comment from:

```typescript
 * Exposes 15 tools: 12 knowledge graph tools + 3 skill library tools (PRD-Skills-C).
```

to:

```typescript
 * Exposes 16 tools: 12 knowledge graph tools + 3 skill library tools + 1 write tool (send_to_synapse).
```

- [ ] **Step 5: Verify build**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 6: Commit**

```bash
git add api/mcp.ts
git commit -m "feat: add send_to_synapse MCP tool for session ingestion"
```

---

### Task 4: Add INGEST_SECRET to Environment

**Files:**
- Modify: `.env.local`

- [ ] **Step 1: Add INGEST_SECRET to `.env.local`**

Add under the existing Third-party services section:

```
INGEST_SECRET=synapse-ingest-a7f3b9c2e1d04568
```

- [ ] **Step 2: Add to Vercel dashboard**

Go to Vercel project settings > Environment Variables and add:
- Key: `INGEST_SECRET`
- Value: `synapse-ingest-a7f3b9c2e1d04568`
- Environments: Production, Preview, Development

This step is manual (Vercel dashboard). Do not commit `.env.local`.

---

### Task 5: Create the Claude Code Skill

**Files:**
- Create: Claude Code skill file (installed via user's skill configuration, not in this repo)

- [ ] **Step 1: Create the skill file**

The skill content below should be saved as a Claude Code skill. The exact installation method depends on the user's setup (global skills directory or a plugin).

```markdown
---
name: synapse
description: Send a structured summary of this Claude Code session to your Synapse knowledge graph. Generates a comprehensive markdown summary covering insights, decisions, topics, advancements, and action items, then pushes it through the MCP for extraction.
---

# Send Session to Synapse

You are about to summarize this Claude Code session and send it to the user's Synapse knowledge graph via the `send_to_synapse` MCP tool.

## Instructions

1. **Check for user guidance.** If the user provided text after `/synapse` (e.g. `/synapse focus on the competitive analysis`), treat that as guidance. Emphasize those areas in the summary and pass the guidance string to the MCP tool. If no guidance was provided, summarize the entire session with equal weight.

2. **Auto-detect context:**
   - **Title:** Generate a concise, descriptive title (under 80 chars) that captures what this session was about. Think of it like a commit message for the conversation.
   - **Repo:** Detect from the current working directory (the git repo name).
   - **Branch:** Detect from the current git branch.

3. **Generate the structured markdown summary** using the template below. Review the FULL conversation from the beginning. Do not just summarize the last few messages.

4. **Template rules:**
   - Omit any section that has no relevant content (no empty headers).
   - Each bullet should be self-contained and meaningful for knowledge extraction.
   - Include file paths, function names, and technical specifics where relevant.
   - Reference people, organizations, projects, and concepts by name.
   - The Summary section should read as a standalone briefing.

5. **Call the `send_to_synapse` MCP tool** with:
   - `title`: the auto-generated title
   - `content`: the full markdown summary
   - `repo`: the detected repo name
   - `branch`: the detected branch name
   - `guidance`: the user's custom guidance (if any), or omit

6. **Confirm to the user** with the title, source ID, and entity/relationship counts from the response.

## Markdown Template

Use this structure. Omit sections with no content.

```
# Session: [title]
**Date:** [YYYY-MM-DD]
**Repo:** [repo name]
**Branch:** [branch name]

## Summary
[2-3 sentence overview of what this session covered and accomplished]

## Key Insights
- [Insight with enough context to be useful standalone]

## Topics Covered
- [Topic — what was discussed and why it matters]

## Decisions Made
- [Decision — what was decided and the reasoning]

## Technical Advancements
- [What was built, fixed, or changed — include file paths]

## Skills & Methodologies Referenced
- [Frameworks, patterns, or approaches that were applied]

## Updates & Status Changes
- [What moved forward, what's complete, what's blocked]

## Action Items
- [Outstanding follow-ups or next steps]

## User Guidance Notes
[Only if guidance was provided. What the user asked to emphasize and what was found.]
```
```

- [ ] **Step 2: Verify the skill loads**

Restart Claude Code and run `/synapse`. It should activate the skill and generate a summary.

---

### Task 5 (alternate): Conversational trigger

The MCP tool `send_to_synapse` is also directly callable by Claude without the skill. When a user says "send this to Synapse" or "save this session to my knowledge graph", Claude should:

1. Recognize the intent
2. Follow the same summary generation process as the skill
3. Call `send_to_synapse`

This works automatically because the MCP tool's description includes enough context for Claude to understand what to do. No additional implementation needed — this is handled by Claude's natural language understanding of the tool description.

---

## Verification Checklist

After all tasks are complete:

- [ ] `npx tsc --noEmit` passes with no errors
- [ ] `INGEST_SECRET` is set in both `.env.local` and Vercel dashboard
- [ ] Deploy to Vercel and verify `api/ingest/session` endpoint responds (POST with invalid secret should return 401)
- [ ] From Claude Code, call `send_to_synapse` MCP tool with a test payload and verify:
  - Source appears in Synapse with type `GitHub`
  - Entities are extracted and visible in the graph
  - Source chunks are created and searchable via `ask_synapse`
- [ ] `/synapse` skill generates a markdown summary and calls the tool successfully
