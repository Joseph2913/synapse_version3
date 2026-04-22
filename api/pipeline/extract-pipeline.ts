// ============================================================================
//  api/_shared/extract-pipeline.ts
//
//  Shared knowledge-extraction pipeline used by every source-type ingestion
//  route (YouTube, Circleback meetings, Microsoft/Teams, GitHub, manual
//  capture). Before this module existed, each route had its own copy of the
//  same ~400 lines of extraction logic — a fix in one place (e.g. the Gemini
//  rate-limit problem) had to be propagated to five files, and in practice
//  wasn't. This module fixes that by centralising:
//
//    - The Gemini calls themselves (single entity-extract + BATCHED
//      embedding call — the batched call is the core rate-limit fix).
//    - Exact + fuzzy/semantic deduplication against the knowledge graph.
//    - Node + edge persistence.
//    - Transcript chunking and chunk-embedding persistence.
//    - Cross-source connection discovery.
//
//  Each per-route file now only owns the parts that genuinely differ between
//  pipelines: how it finds work (queue vs webhook), how it records status
//  (column vs metadata JSON), and any source-type-specific post-processing
//  (domain agent linking, participant parsing, extraction_sessions logging).
//
//  Vercel note: the leading underscore on the folder name is intentional —
//  Vercel skips underscore-prefixed files/folders when discovering serverless
//  routes, so this module is only ever imported, never exposed as an HTTP
//  endpoint.
// ============================================================================

import type { SupabaseClient } from '@supabase/supabase-js';

// ─── CONFIG ────────────────────────────────────────────────────────────────

const GEMINI_API_KEY = process.env.GEMINI_API_KEY!;
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

export const MAX_TRANSCRIPT_CHARS = 100_000;
export const EMBEDDING_BATCH_SIZE = 100;
export const DEFAULT_TIME_BUDGET_MS = 50_000;

// ─── ENTITY ONTOLOGY ───────────────────────────────────────────────────────

export const ENTITY_TYPES = [
  'Person', 'Organization', 'Team', 'Topic', 'Project', 'Goal', 'Action',
  'Risk', 'Blocker', 'Decision', 'Insight', 'Question', 'Idea', 'Concept',
  'Takeaway', 'Lesson', 'Document', 'Event', 'Location', 'Technology',
  'Product', 'Metric', 'Hypothesis', 'Anchor',
];

export const RELATIONSHIP_TYPES = [
  'leads_to', 'supports', 'enables', 'created', 'achieved', 'produced',
  'blocks', 'contradicts', 'risks', 'prevents', 'challenges', 'inhibits',
  'part_of', 'relates_to', 'mentions', 'connected_to', 'owns', 'associated_with',
];

const MODE_INSTRUCTIONS: Record<string, string> = {
  comprehensive: 'Extract the maximum number of meaningful entities and all significant relationships. Capture every person, organization, concept, decision, and insight mentioned.',
  strategic: 'Focus on high-level concepts, strategic decisions, goals, and their interdependencies. Prioritize organizational and directional information.',
  actionable: 'Emphasize actions, goals, blockers, deadlines, and decisions. Capture what needs to be done, by whom, and any impediments.',
  relational: 'Prioritize connections and relationships between entities. Emphasize how concepts, people, and organizations relate to each other.',
};

const EMPHASIS_INSTRUCTIONS: Record<string, string> = {
  passive: 'Treat anchors as low-priority context. Extract them if naturally occurring but do not force anchor-related entities.',
  standard: 'Give moderate weight to anchor-related content. When content relates to anchors, prioritize extracting those entities and relationships.',
  aggressive: 'Heavily weight extraction toward anchor-related content. Actively connect extracted entities back to anchors where plausible.',
};

// ─── TYPES ─────────────────────────────────────────────────────────────────

export interface UserProfile {
  professional_context?: {
    role?: string;
    current_projects?: string;
  };
  personal_interests?: {
    topics?: string;
  };
  processing_preferences?: {
    insight_depth?: string;
  };
}

export interface Anchor {
  label: string;
  entity_type: string;
  description: string;
}

export interface ExtractedEntity {
  label: string;
  entity_type: string;
  description: string;
  confidence: number;
  tags: string[];
}

export interface ExtractedRelationship {
  source: string;
  target: string;
  relation_type: string;
  evidence: string;
}

export interface ExtractionResult {
  entities: ExtractedEntity[];
  relationships: ExtractedRelationship[];
}

/**
 * Runtime type guard for Gemini extraction output. Returns true only when
 * the parsed value has both `entities` and `relationships` as arrays.
 * No external libraries — keeps this function zero-cost and serverless-safe.
 */
export function isValidExtractionResult(result: unknown): result is ExtractionResult {
  return (
    result !== null &&
    typeof result === 'object' &&
    Array.isArray((result as Record<string, unknown>).entities) &&
    Array.isArray((result as Record<string, unknown>).relationships)
  );
}

export interface PromptConfig {
  mode: string;
  anchorEmphasis: string;
  anchors: Anchor[];
  userProfile: UserProfile | null;
  customInstructions?: string | null;
}

export interface SourceContext {
  sourceId: string;
  sourceType: string;      // 'YouTube' | 'Meeting' | 'Document' | 'Research' | 'GitHub'
  sourceUrl?: string | null;
  sourceLabel?: string | null; // e.g. video_title or meeting title — stored on nodes
}

export interface NearMatch {
  entityLabel: string;
  existingNodeId: string;
  similarity: number;
  matchType: string;
}

export interface DedupResult {
  exactMatchMap: Map<string, string>;       // label.toLowerCase() → existing node id
  fuzzyMergeMap: Map<string, string>;       // label.toLowerCase() → existing node id
  nearMatchQueue: NearMatch[];              // needs human review, queued to potential_duplicates
  prefetchedEmbeddings: Map<string, number[]>; // entity.label → embedding vector
  mergedEntitiesLog: Array<{
    original_label: string;
    merged_into_id: string;
    similarity: number;
    match_type: string;
  }>;
}

export interface CoreExtractionOptions {
  enableFuzzyDedup?: boolean;          // default true
  enableChunking?: boolean;             // default true
  enableCrossConnections?: boolean;     // default true
  queueNearMatches?: boolean;           // insert into potential_duplicates table (default true)
  extractedEdgeWeight?: number;         // default 1.0
  crossEdgeWeight?: number;             // default 0.8
  timeBudgetMs?: number;                // default 50s — skips cross-conn past this
  itemStartTime?: number;               // Date.now() when processing started, for time budget
}

export interface CoreExtractionResult {
  savedNodeMap: Map<string, string>;         // entity.label → node id (includes reused nodes)
  nodesCreated: number;                      // newly inserted only
  edgesCreated: number;                      // direct + cross combined
  crossConnectionCount: number;
  chunksCreated: number;
  mergedEntitiesLog: DedupResult['mergedEntitiesLog'];
  nearMatchQueue: NearMatch[];
}

// ─── UTILITIES ─────────────────────────────────────────────────────────────

/** Strip markdown formatting from summaries stored into knowledge_sources. */
export function stripMarkdown(text: string): string {
  if (!text) return '';
  let out = text;
  out = out.replace(/#{1,6}\s+/g, '');                // ATX headings
  out = out.replace(/\*\*(.+?)\*\*/g, '$1');          // **bold**
  out = out.replace(/\*(.+?)\*/g, '$1');              // *italic*
  out = out.replace(/__(.+?)__/g, '$1');              // __bold__
  out = out.replace(/_(.+?)_/g, '$1');                // _italic_
  out = out.replace(/`(.+?)`/g, '$1');                // `code`
  out = out.replace(/\[(.+?)\]\(.+?\)/g, '$1');       // [text](url)
  out = out.replace(/^\s*[-*+]\s+/gm, '');            // bullet markers
  out = out.replace(/^\s*\d+\.\s+/gm, '');            // ordered list markers
  out = out.replace(/\n{2,}/g, ' ');                  // collapse blank lines
  out = out.replace(/\s+/g, ' ');                     // collapse runs of whitespace
  return out.trim();
}

/**
 * fetch() wrapper with exponential backoff on 429. Used for non-batch Gemini
 * calls where a single retry is cheaper than giving up.
 *
 * NOTE: the primary rate-limit defence is batchEmbed(), which reduces call
 * count by ~20×. This is a secondary safety net.
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  retries = 3
): Promise<Response> {
  let lastErr: unknown;
  let delay = 2000;
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, init);
      if (res.status !== 429) return res;
      if (i === retries) return res;
    } catch (err) {
      lastErr = err;
      if (i === retries) throw err;
    }
    await new Promise(r => setTimeout(r, delay));
    delay = Math.min(delay * 2, 15_000);
  }
  throw lastErr ?? new Error('fetchWithRetry exhausted');
}

// ─── PROMPT BUILDERS ───────────────────────────────────────────────────────

export function buildExtractionPrompt(config: PromptConfig): string {
  const modeInstruction = MODE_INSTRUCTIONS[config.mode] ?? MODE_INSTRUCTIONS['comprehensive']!;
  const emphasisInstruction = EMPHASIS_INSTRUCTIONS[config.anchorEmphasis] ?? EMPHASIS_INSTRUCTIONS['standard']!;

  let prompt = `You are a knowledge extraction system. Extract structured knowledge from the provided content.

## Extraction Mode: ${config.mode}
${modeInstruction}

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
    prompt += `\n\n## Anchor Context (${emphasisInstruction}):\n`;
    for (const anchor of config.anchors.slice(0, 10)) {
      prompt += `- ${anchor.label} (${anchor.entity_type}): ${anchor.description}\n`;
    }
  }

  if (config.customInstructions) {
    prompt += `\n\n## Additional Instructions:\n${config.customInstructions}`;
  }

  prompt += '\n\nExtract knowledge from the following content. Return ONLY valid JSON matching the schema above.';
  return prompt;
}

// ─── GEMINI CALLS ──────────────────────────────────────────────────────────

/**
 * Single-call entity extraction. Throws `RATE_LIMITED: ...` on 429 so callers
 * can distinguish rate limiting from permanent failures.
 */
export async function extractEntities(
  content: string,
  systemPrompt: string
): Promise<ExtractionResult> {
  // Defensive guard: upstream routes should validate content, but if a null
  // or empty string reaches us we want a clear error instead of a TypeError
  // deep inside the fetch body builder.
  if (!content || content.trim().length === 0) {
    throw new Error('extractEntities called with empty content');
  }

  const response = await fetchWithRetry(
    `${GEMINI_BASE}/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents: [{ parts: [{ text: content.slice(0, MAX_TRANSCRIPT_CHARS) }] }],
        generationConfig: {
          temperature: 0.1,
          responseMimeType: 'application/json',
        },
      }),
      signal: AbortSignal.timeout(60_000),
    }
  );

  if (!response.ok) {
    const errText = await response.text();
    if (response.status === 429) {
      console.error(`[extract-pipeline] Gemini 429 on extractEntities — raw body: ${errText.slice(0, 800)}`);
      throw new Error(`RATE_LIMITED: Gemini rate limit hit — ${errText.slice(0, 300)}`);
    }
    throw new Error(`Gemini extraction failed: ${response.status} ${errText.slice(0, 200)}`);
  }

  const data = await response.json() as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('No extraction response from Gemini');

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Invalid JSON from Gemini: ${text.slice(0, 200)}`);
  }
  if (!isValidExtractionResult(parsed)) {
    console.error('[extract-pipeline] Unexpected Gemini extraction shape:', JSON.stringify(parsed).slice(0, 500));
    throw new Error('Gemini returned unexpected shape: missing entities or relationships arrays');
  }
  return parsed;
}

/**
 * Batch up to 100 embeddings in a single HTTP call.
 *
 * This is the central rate-limit fix. The old per-entity-one-call approach
 * generated ~80 embedding requests per video, which on Gemini's free tier
 * (~15 req/min) guaranteed 429s on every extraction. Batching drops that to
 * 1-2 calls per video. Quality is identical — the embedding API is a
 * deterministic per-item mapping, not a reasoning step.
 */
export async function batchEmbed(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const results: number[][] = new Array(texts.length).fill(null).map(() => [] as number[]);

  for (let start = 0; start < texts.length; start += EMBEDDING_BATCH_SIZE) {
    const slice = texts.slice(start, start + EMBEDDING_BATCH_SIZE);
    const response = await fetchWithRetry(
      `${GEMINI_BASE}/gemini-embedding-001:batchEmbedContents?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requests: slice.map(text => ({
            model: 'models/gemini-embedding-001',
            content: { parts: [{ text }] },
          })),
        }),
        signal: AbortSignal.timeout(30_000),
      }
    );

    if (!response.ok) {
      const errText = await response.text();
      if (response.status === 429) {
        console.error(`[extract-pipeline] Gemini 429 on batchEmbed — raw body: ${errText.slice(0, 800)}`);
        throw new Error(`RATE_LIMITED: Gemini embedding rate limit hit — ${errText.slice(0, 300)}`);
      }
      console.warn(`[extract-pipeline] batchEmbed HTTP ${response.status}: ${errText.slice(0, 200)}`);
      continue;
    }

    const data = await response.json() as { embeddings?: Array<{ values?: number[] }> };
    const embeddings = data.embeddings ?? [];
    for (let i = 0; i < slice.length; i++) {
      results[start + i] = embeddings[i]?.values ?? [];
    }
  }
  return results;
}

/** Single embedding — use batchEmbed() wherever possible instead. */
export async function generateEmbedding(text: string): Promise<number[]> {
  const response = await fetchWithRetry(
    `${GEMINI_BASE}/gemini-embedding-001:embedContent?key=${GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'models/gemini-embedding-001',
        content: { parts: [{ text }] },
      }),
      signal: AbortSignal.timeout(15_000),
    }
  );
  if (!response.ok) return [];
  const data = await response.json() as { embedding?: { values?: number[] } };
  return data.embedding?.values ?? [];
}

// ─── CHUNKING ──────────────────────────────────────────────────────────────

export function chunkText(text: string, targetTokens = 500): string[] {
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

// ─── DEDUPLICATION ─────────────────────────────────────────────────────────

/**
 * Dedup a set of newly-extracted entities against the existing knowledge
 * graph. Two-stage: (1) case-insensitive exact-match on label + entity_type,
 * (2) for the remainder, batch-embed and call the `check_node_duplicate`
 * RPC to find fuzzy/semantic matches.
 *
 * The RPC returns three tiers per entity:
 *   - "exact" — same canonical label → auto-merge
 *   - "fuzzy" (>=0.95) — near-identical surface form → auto-merge
 *   - "fuzzy" (<0.95) / "semantic" — candidate for human review → queue
 */
export async function deduplicateEntities(
  entities: ExtractedEntity[],
  userId: string,
  supabase: SupabaseClient,
  enableFuzzy = true
): Promise<DedupResult> {
  const exactMatchMap = new Map<string, string>();
  const fuzzyMergeMap = new Map<string, string>();
  const nearMatchQueue: NearMatch[] = [];
  const prefetchedEmbeddings = new Map<string, number[]>();
  const mergedEntitiesLog: DedupResult['mergedEntitiesLog'] = [];

  // ── Stage 1: exact match ─────────────────────────────────────────────────
  const entityLabels = entities.filter(e => e.label && e.entity_type).map(e => e.label);
  if (entityLabels.length === 0) {
    return { exactMatchMap, fuzzyMergeMap, nearMatchQueue, prefetchedEmbeddings, mergedEntitiesLog };
  }

  const { data: existingNodes } = await supabase
    .from('knowledge_nodes')
    .select('id, label, entity_type')
    .eq('user_id', userId)
    .eq('is_merged', false)
    .in('label', entityLabels);

  for (const existing of (existingNodes ?? []) as Array<{ id: string; label: string; entity_type: string }>) {
    const matchingEntity = entities.find(
      e => e.label.toLowerCase() === existing.label.toLowerCase()
        && e.entity_type === existing.entity_type
    );
    if (matchingEntity) {
      exactMatchMap.set(matchingEntity.label.toLowerCase(), existing.id);
    }
  }

  if (!enableFuzzy) {
    return { exactMatchMap, fuzzyMergeMap, nearMatchQueue, prefetchedEmbeddings, mergedEntitiesLog };
  }

  // ── Stage 2: fuzzy/semantic match ────────────────────────────────────────
  const entitiesToDedupCheck = entities.filter(
    e => e.label && e.entity_type && !exactMatchMap.has(e.label.toLowerCase())
  );
  if (entitiesToDedupCheck.length === 0) {
    return { exactMatchMap, fuzzyMergeMap, nearMatchQueue, prefetchedEmbeddings, mergedEntitiesLog };
  }

  // Pre-batch all embeddings in a single call.
  const embeddingTexts = entitiesToDedupCheck.map(
    e => `${e.entity_type}: ${e.label} — ${e.description ?? ''}`
  );
  const embeddings = await batchEmbed(embeddingTexts);
  for (let i = 0; i < entitiesToDedupCheck.length; i++) {
    const embedding = embeddings[i] ?? [];
    if (embedding.length > 0) {
      prefetchedEmbeddings.set(entitiesToDedupCheck[i]!.label, embedding);
    }
  }

  // RPC calls can run concurrently — they're DB-bound, not Gemini-bound.
  const DEDUP_CONCURRENCY = 5;
  for (let i = 0; i < entitiesToDedupCheck.length; i += DEDUP_CONCURRENCY) {
    const batch = entitiesToDedupCheck.slice(i, i + DEDUP_CONCURRENCY);
    await Promise.allSettled(
      batch.map(async (entity) => {
        const embedding = prefetchedEmbeddings.get(entity.label);
        if (!embedding || embedding.length === 0) return;
        try {
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
          if (!best) return;

          if (best.match_type === 'exact' ||
              (best.match_type === 'fuzzy' && best.similarity >= 0.95)) {
            fuzzyMergeMap.set(entity.label.toLowerCase(), best.match_id);
            mergedEntitiesLog.push({
              original_label: entity.label,
              merged_into_id: best.match_id,
              similarity: best.similarity,
              match_type: best.match_type,
            });
          } else if (best.match_type === 'fuzzy' || best.match_type === 'semantic') {
            nearMatchQueue.push({
              entityLabel: entity.label,
              existingNodeId: best.match_id,
              similarity: best.similarity,
              matchType: best.match_type,
            });
          }
        } catch (err) {
          console.warn(`[extract-pipeline] Dedup check failed for "${entity.label}":`, err);
        }
      })
    );
  }

  return { exactMatchMap, fuzzyMergeMap, nearMatchQueue, prefetchedEmbeddings, mergedEntitiesLog };
}

// ─── NODE + EDGE PERSISTENCE ───────────────────────────────────────────────

/**
 * Insert brand-new nodes (skipping exactly-matched and fuzzy-merged ones),
 * then persist node embeddings. Returns savedNodeMap covering every entity —
 * reused node ids for dedup matches, new ids for inserts.
 */
export async function saveNodes(
  entities: ExtractedEntity[],
  dedup: DedupResult,
  source: SourceContext,
  userId: string,
  supabase: SupabaseClient
): Promise<{ savedNodeMap: Map<string, string>; nodesCreated: number; nodeEmbeddings: Map<string, number[]> }> {
  const savedNodeMap = new Map<string, string>();

  // Populate savedNodeMap with reused node ids first.
  for (const [labelLower, existingId] of dedup.exactMatchMap) {
    const entity = entities.find(e => e.label.toLowerCase() === labelLower);
    if (entity) savedNodeMap.set(entity.label, existingId);
  }
  for (const [labelLower, existingId] of dedup.fuzzyMergeMap) {
    const entity = entities.find(e => e.label.toLowerCase() === labelLower);
    if (entity) {
      savedNodeMap.set(entity.label, existingId);
      // If the merged entity has a longer/richer description than the
      // existing one, upgrade it.
      if (entity.description) {
        const { data: existNode } = await supabase
          .from('knowledge_nodes')
          .select('description')
          .eq('id', existingId)
          .maybeSingle();
        const existingDesc = (existNode as { description?: string } | null)?.description ?? '';
        if (!existingDesc || entity.description.length > existingDesc.length) {
          await supabase.from('knowledge_nodes').update({ description: entity.description }).eq('id', existingId);
        }
      }
    }
  }

  // Insert new nodes.
  let nodesCreated = 0;
  for (const entity of entities) {
    if (!entity.label || !entity.entity_type) continue;
    if (dedup.exactMatchMap.has(entity.label.toLowerCase())) continue;
    if (dedup.fuzzyMergeMap.has(entity.label.toLowerCase())) continue;

    const payload: Record<string, unknown> = {
      user_id: userId,
      label: entity.label,
      entity_type: entity.entity_type,
      description: entity.description ?? null,
      confidence: entity.confidence ?? 0.8,
      source: source.sourceLabel ?? source.sourceType,
      source_type: source.sourceType,
      source_url: source.sourceUrl ?? null,
      source_id: source.sourceId,
      tags: entity.tags ?? [],
    };

    const { data: nodeData, error: nodeError } = await supabase
      .from('knowledge_nodes')
      .insert(payload)
      .select('id')
      .single();

    if (nodeError) {
      // Fallback: another concurrent extraction may have just inserted this
      // same label for this user — find and reuse.
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

  // Persist embeddings. Anything that wasn't prefetched during dedup (e.g. a
  // new entity that skipped the dedup stage because `enableFuzzy=false`) is
  // batch-embedded here.
  const nodeEmbeddings = new Map<string, number[]>();
  const missingEmbedLabels: string[] = [];
  const missingEmbedTexts: string[] = [];
  for (const entity of entities) {
    if (!savedNodeMap.has(entity.label)) continue;
    const isReused = dedup.exactMatchMap.has(entity.label.toLowerCase())
      || dedup.fuzzyMergeMap.has(entity.label.toLowerCase());
    if (isReused) continue;
    if (dedup.prefetchedEmbeddings.has(entity.label)) continue;
    missingEmbedLabels.push(entity.label);
    missingEmbedTexts.push(`${entity.entity_type}: ${entity.label} — ${entity.description ?? ''}`);
  }
  if (missingEmbedTexts.length > 0) {
    const embeddings = await batchEmbed(missingEmbedTexts);
    for (let i = 0; i < missingEmbedLabels.length; i++) {
      const emb = embeddings[i] ?? [];
      if (emb.length > 0) dedup.prefetchedEmbeddings.set(missingEmbedLabels[i]!, emb);
    }
  }

  await Promise.allSettled(
    [...savedNodeMap.entries()].map(async ([label, nodeId]) => {
      const isReused = dedup.exactMatchMap.has(label.toLowerCase())
        || dedup.fuzzyMergeMap.has(label.toLowerCase());
      if (isReused) return;
      const embedding = dedup.prefetchedEmbeddings.get(label);
      if (!embedding || embedding.length === 0) return;
      nodeEmbeddings.set(nodeId, embedding);
      try {
        await supabase.from('knowledge_nodes').update({ embedding }).eq('id', nodeId);
      } catch (err) {
        console.warn(`[extract-pipeline] Embedding save failed for "${label}":`, err);
      }
    })
  );

  return { savedNodeMap, nodesCreated, nodeEmbeddings };
}

/**
 * Persist extracted relationships as edges. Silently drops edges where
 * either endpoint couldn't be resolved (entity wasn't saved) or where
 * source === target.
 */
export async function saveEdges(
  relationships: ExtractedRelationship[],
  savedNodeMap: Map<string, string>,
  userId: string,
  supabase: SupabaseClient,
  weight = 1.0
): Promise<number> {
  let edgesCreated = 0;
  for (const rel of relationships) {
    const sourceNodeId = savedNodeMap.get(rel.source);
    const targetNodeId = savedNodeMap.get(rel.target);
    if (!sourceNodeId || !targetNodeId) continue;
    if (sourceNodeId === targetNodeId) continue;

    const { error: edgeError } = await supabase.from('knowledge_edges').insert({
      user_id: userId,
      source_node_id: sourceNodeId,
      target_node_id: targetNodeId,
      relation_type: rel.relation_type ?? 'relates_to',
      evidence: rel.evidence ?? null,
      weight,
    });
    if (!edgeError) edgesCreated++;
  }
  return edgesCreated;
}

/** Queue near-matches (below auto-merge threshold) for human review. */
export async function queueNearMatches(
  nearMatchQueue: NearMatch[],
  savedNodeMap: Map<string, string>,
  userId: string,
  supabase: SupabaseClient
): Promise<void> {
  for (const nm of nearMatchQueue) {
    const newNodeId = savedNodeMap.get(nm.entityLabel);
    if (!newNodeId) continue;
    try {
      await supabase.from('potential_duplicates').insert({
        user_id: userId,
        node_a_id: nm.existingNodeId,
        node_b_id: newNodeId,
        similarity: nm.similarity,
        match_type: nm.matchType,
        status: 'pending',
        metadata: {
          new_label: nm.entityLabel,
          detected_at: new Date().toISOString(),
          detection_source: 'extraction_pipeline',
        },
      });
    } catch { /* ignore duplicate constraint violations */ }
  }
}

// ─── TRANSCRIPT CHUNKS ─────────────────────────────────────────────────────

/**
 * Split content into ~500-token chunks, batch-embed them all in one call,
 * then bulk-insert into source_chunks. Returns the count of chunks saved.
 */
export async function saveTranscriptChunks(
  content: string,
  sourceId: string,
  userId: string,
  supabase: SupabaseClient
): Promise<number> {
  const chunks = chunkText(content);
  if (chunks.length === 0) return 0;

  const embeddings = await batchEmbed(chunks);
  const rows = chunks.map((chunk, i) => ({
    user_id: userId,
    source_id: sourceId,
    chunk_index: i,
    content: chunk,
    embedding: (embeddings[i]?.length ?? 0) > 0 ? embeddings[i] : null,
  }));

  const { error } = await supabase.from('source_chunks').insert(rows);
  if (error) {
    console.warn(`[extract-pipeline] Bulk chunk insert failed:`, error.message);
    return 0;
  }
  return chunks.length;
}

// ─── CROSS-CONNECTION DISCOVERY ────────────────────────────────────────────

/**
 * For each newly-saved node, find semantically-similar existing nodes via
 * `match_knowledge_nodes` RPC, then ask Gemini to identify genuinely
 * meaningful relationships across the two sets. Writes the resulting edges
 * with a slightly lower default weight (0.8) than direct edges (1.0) to
 * reflect that they were inferred rather than directly extracted.
 *
 * Gated by timeBudget — a long extraction can skip this step so the whole
 * pipeline completes within Vercel's function timeout.
 */
export async function discoverCrossConnections(
  entities: ExtractedEntity[],
  savedNodeMap: Map<string, string>,
  nodeEmbeddings: Map<string, number[]>,
  userId: string,
  supabase: SupabaseClient,
  opts: { weight?: number; itemStartTime?: number; timeBudgetMs?: number } = {}
): Promise<number> {
  const { weight = 0.8, itemStartTime = Date.now(), timeBudgetMs = DEFAULT_TIME_BUDGET_MS } = opts;
  if (savedNodeMap.size === 0) return 0;
  if (Date.now() - itemStartTime >= timeBudgetMs) {
    console.log(`[extract-pipeline] Skipping cross-connections — time budget exceeded`);
    return 0;
  }

  try {
    const newNodeIds = new Set(savedNodeMap.values());
    type SemanticCandidate = { id: string; label: string; entity_type: string; description: string | null };
    const candidateMap = new Map<string, SemanticCandidate>();

    for (const [, embedding] of nodeEmbeddings) {
      const { data: similar } = await supabase.rpc('match_knowledge_nodes', {
        query_embedding: embedding,
        match_threshold: 0.55,
        match_count: 30,
        p_user_id: userId,
      });
      for (const s of (similar ?? []) as SemanticCandidate[]) {
        if (!newNodeIds.has(s.id)) candidateMap.set(s.id, s);
      }
    }

    const existingNodes = [...candidateMap.values()].slice(0, 40);
    if (existingNodes.length === 0) return 0;

    const newEntityLines = entities.slice(0, 20)
      .map(e => `- [${e.entity_type}] ${e.label}: ${e.description ?? ''}`)
      .join('\n');
    const existingEntityLines = existingNodes
      .map((e) => `- [${e.entity_type}] ${e.label}: ${e.description ?? ''}`)
      .join('\n');

    const crossPrompt = `You are building a knowledge graph. Identify meaningful cross-source relationships between new and existing entities.

NEW entities (just ingested):
${newEntityLines}

EXISTING entities (already in the user's knowledge graph):
${existingEntityLines}

Rules:
- Only return connections where a meaningful, non-trivial relationship exists.
- Do NOT connect entities simply because they share a label or topic — the relationship must add knowledge.
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
      `${GEMINI_BASE}/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: crossPrompt }] }],
          generationConfig: { temperature: 0.1, responseMimeType: 'application/json' },
        }),
        signal: AbortSignal.timeout(30_000),
      }
    );

    if (!crossResponse.ok) return 0;

    const crossData = await crossResponse.json() as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const crossText = crossData.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!crossText) return 0;

    let crossResult: { relationships?: ExtractedRelationship[] };
    try {
      crossResult = JSON.parse(crossText);
    } catch (parseErr) {
      console.error('[extract-pipeline] Malformed cross-connection JSON from Gemini:', crossText.slice(0, 500));
      throw parseErr;
    }

    const existingNodeMap = new Map(existingNodes.map(n => [n.label.toLowerCase(), n.id]));
    let crossConnectionCount = 0;
    for (const rel of crossResult.relationships ?? []) {
      const sourceId = savedNodeMap.get(rel.source) ?? existingNodeMap.get(rel.source?.toLowerCase());
      const targetId = savedNodeMap.get(rel.target) ?? existingNodeMap.get(rel.target?.toLowerCase());
      if (sourceId && targetId && sourceId !== targetId) {
        const { error } = await supabase.from('knowledge_edges').insert({
          user_id: userId,
          source_node_id: sourceId,
          target_node_id: targetId,
          relation_type: rel.relation_type ?? 'relates_to',
          evidence: rel.evidence ?? null,
          weight,
        });
        if (!error) crossConnectionCount++;
      }
    }
    return crossConnectionCount;
  } catch (err) {
    console.warn('[extract-pipeline] Cross-connection discovery failed:', err);
    return 0;
  }
}

// ─── ORCHESTRATOR ──────────────────────────────────────────────────────────

/**
 * Run the full extract-graph pipeline from a system prompt + content string.
 * This is the single entry point every route should use — they pass in the
 * content, the config that shapes the prompt, and which optional steps to
 * run (e.g. Microsoft skips dedup and chunking; GitHub skips fuzzy dedup).
 *
 * Does NOT: save the knowledge_sources row (the route does that first so it
 * can set source-type-specific metadata), manage queue state, trigger anchor
 * scoring, log to extraction_sessions, or do domain-agent linking. Those are
 * the parts that genuinely vary per pipeline and live in the routes.
 */
export async function runExtractionCore(params: {
  content: string;
  promptConfig: PromptConfig;
  source: SourceContext;
  userId: string;
  supabase: SupabaseClient;
  options?: CoreExtractionOptions;
}): Promise<CoreExtractionResult> {
  const { content, promptConfig, source, userId, supabase } = params;
  const opts = params.options ?? {};
  const {
    enableFuzzyDedup = true,
    enableChunking = true,
    enableCrossConnections = true,
    queueNearMatches: doQueueNearMatches = true,
    extractedEdgeWeight = 1.0,
    crossEdgeWeight = 0.8,
    timeBudgetMs = DEFAULT_TIME_BUDGET_MS,
    itemStartTime = Date.now(),
  } = opts;

  // 1. Gemini entity extraction
  const systemPrompt = buildExtractionPrompt(promptConfig);
  const { entities = [], relationships = [] } = await extractEntities(content, systemPrompt);
  console.log(`[extract-pipeline] Extracted ${entities.length} entities, ${relationships.length} relationships for ${source.sourceId}`);

  // 2. Dedup
  const dedup = await deduplicateEntities(entities, userId, supabase, enableFuzzyDedup);

  // 3. Nodes + embeddings
  const { savedNodeMap, nodesCreated, nodeEmbeddings } = await saveNodes(
    entities, dedup, source, userId, supabase
  );

  // 4. Queue near-matches for review (pipelines with potential_duplicates enabled)
  if (doQueueNearMatches && enableFuzzyDedup && dedup.nearMatchQueue.length > 0) {
    await queueNearMatches(dedup.nearMatchQueue, savedNodeMap, userId, supabase);
  }

  console.log(`[extract-pipeline] Dedup: ${dedup.exactMatchMap.size} exact + ${dedup.fuzzyMergeMap.size} fuzzy reused, ${nodesCreated} new, ${dedup.nearMatchQueue.length} near-matches queued`);

  // 5. Edges
  let edgesCreated = await saveEdges(relationships, savedNodeMap, userId, supabase, extractedEdgeWeight);

  // 6. Chunks
  let chunksCreated = 0;
  if (enableChunking) {
    chunksCreated = await saveTranscriptChunks(content, source.sourceId, userId, supabase);
  }

  // 7. Cross-connections
  let crossConnectionCount = 0;
  if (enableCrossConnections) {
    crossConnectionCount = await discoverCrossConnections(
      entities, savedNodeMap, nodeEmbeddings, userId, supabase,
      { weight: crossEdgeWeight, itemStartTime, timeBudgetMs }
    );
    edgesCreated += crossConnectionCount;
  }

  return {
    savedNodeMap,
    nodesCreated,
    edgesCreated,
    crossConnectionCount,
    chunksCreated,
    mergedEntitiesLog: dedup.mergedEntitiesLog,
    nearMatchQueue: dedup.nearMatchQueue,
  };
}
