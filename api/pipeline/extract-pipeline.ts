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
import {
  buildExtractionPrompt as buildExtractionPromptCanonical,
  composeExtractionPrompt as composeExtractionPromptCanonical,
  PROMPT_VERSION,
  type PromptConfig as CanonicalPromptConfig,
  type PromptUserProfile as CanonicalPromptUserProfile,
  type PromptAnchor as CanonicalPromptAnchor,
  type PromptSkillHint,
} from './extract-prompt.js';

// ─── CONFIG ────────────────────────────────────────────────────────────────

const GEMINI_API_KEY = process.env.GEMINI_API_KEY!;
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

if (!GEMINI_API_KEY) {
  throw new Error('[gemini] Missing env var: GEMINI_API_KEY')
}

const GEMINI_MODEL = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash'
const GEMINI_EMBEDDING_MODEL = 'gemini-embedding-001'
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

// Map-reduce thresholds for long transcripts.
// Window shrunk 10k → 7k so each Gemini call fits comfortably inside the
// per-call timeout even with the longer v2 prompt.
const MAP_REDUCE_THRESHOLD = 15_000;
const MAP_REDUCE_WINDOW    =  7_000;
const MAP_REDUCE_OVERLAP   =  1_000;

// Per-call timeout (applies to extraction + cross-conn). Bumped 60s → 120s
// because v2 prompts are ~3× longer and 2.5-flash cold starts occasionally
// push single calls past the old 60-second ceiling.
const GEMINI_CALL_TIMEOUT_MS = 120_000;

// Post-extraction health flags
const HEALTH_MIN_CONTENT_FOR_CHECK = 20_000;
const HEALTH_MIN_ENTITIES          = 15;

// Deduplication thresholds (Stage 6 — locked values with documented rationale).
//
// DEDUP_EXACT_THRESHOLD (0.85): RPC filter — only nodes within Levenshtein or
//   embedding distance ≥0.85 of the new entity are returned as candidates.
//   Lowered from 0.92 to catch transcript typos ("Versel" → "Vercel") and
//   auto-caption errors ("Superbase" → "Supabase").
//
// DEDUP_SEMANTIC_THRESHOLD (0.80): second tier of the RPC filter — semantic
//   embedding similarity floor. Anything below 0.80 is too dissimilar to
//   be a duplicate; it goes to the graph as a new node.
//
// DEDUP_AUTO_MERGE_THRESHOLD (0.88): entities above this threshold are
//   auto-merged without human review. Entities in the 0.80–0.88 band are
//   queued to `potential_duplicates` for human decision.
//   Raised from 0.80 to reduce false positives in the review queue while
//   still catching high-confidence near-matches automatically.
export const DEDUP_EXACT_THRESHOLD    = 0.85;
export const DEDUP_SEMANTIC_THRESHOLD = 0.80;
export const DEDUP_AUTO_MERGE_THRESHOLD = 0.88;

// Merge enrichment rules (Stage 6 — applied in saveNodes for fuzzy-merged nodes).
// When entity A is fuzzy-merged into existing node B:
//   1. Description: longer description wins (preserves richer semantics).
//   2. Confidence: max(A.confidence, B.confidence).
//   3. Tags: union, capped at 8 (prevents unbounded growth).
//   4. Aliases: union; non-canonical label added to aliases list.
// These rules are applied in saveNodes() when entity.description is present.

// Post-extraction quality filters
const MIN_SALIENCE         = 0.4;
const DROP_ORPHAN_ENTITIES = true;

// ─── TYPES ─────────────────────────────────────────────────────────────────

// Re-exported from the canonical Stage 4 prompt module so existing callers
// (`UserProfile`, `Anchor`) keep working.
export type UserProfile = CanonicalPromptUserProfile;
export type Anchor = CanonicalPromptAnchor;
export type { PromptSkillHint };
export { PROMPT_VERSION, composeExtractionPromptCanonical as composeExtractionPrompt };

export interface ExtractedEntity {
  label: string;
  entity_type: string;
  description: string;
  confidence: number;
  tags: string[];
  aliases?: string[];
  salience?: number;
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

export function isValidExtractionResult(result: unknown): result is ExtractionResult {
  return (
    result !== null &&
    typeof result === 'object' &&
    Array.isArray((result as Record<string, unknown>).entities) &&
    Array.isArray((result as Record<string, unknown>).relationships)
  );
}

// PromptConfig is the canonical Stage 4 type. Keep an alias for backward
// compatibility with the many existing callers in api/.
export type PromptConfig = CanonicalPromptConfig;

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

// ─── TYPE + QUALITY VALIDATION ─────────────────────────────────────────────

const ENTITY_TYPE_SET = new Set(ENTITY_TYPES);
const RELATIONSHIP_TYPE_SET = new Set(RELATIONSHIP_TYPES);

/**
 * Remap table for entity types the model occasionally invents. Anything not
 * in this table and not in ENTITY_TYPE_SET will be dropped at insert time.
 * `Anchor` is reserved in the graph, so if the model tags something as
 * Anchor we downgrade it to Concept — the anchor-promotion flow is a
 * separate, user-driven process.
 */
const ENTITY_TYPE_REMAP: Record<string, string> = {
  Feature:       'Concept',
  Limitation:    'Risk',
  Website:       'Product',
  Framework:     'Concept',
  Methodology:   'Concept',
  Method:        'Concept',
  Theory:        'Concept',
  Principle:     'Concept',
  Rule:          'Concept',
  Doctrine:      'Concept',
  Model:         'Concept',
  Tool:          'Product',
  Service:       'Product',
  Library:       'Technology',
  Protocol:      'Technology',
  Algorithm:     'Technology',
  Company:       'Organization',
  Institution:   'Organization',
  Author:        'Person',
  Speaker:       'Person',
  Book:          'Document',
  Paper:         'Document',
  Report:        'Document',
  Statute:       'Document',
  Case:          'Document',
  Regulation:    'Document',
  Contract:      'Document',
  KPI:           'Metric',
  Benchmark:     'Metric',
  Ratio:         'Metric',
  Anchor:        'Concept', // reserved — demote
};

const RELATION_TYPE_REMAP: Record<string, string> = {
  causes:       'leads_to',
  caused:       'leads_to',
  causing:      'leads_to',
  results_in:   'leads_to',
  implements:   'enables',
  uses:         'enables',
  depends_on:   'enables',
  requires:     'enables',
  authored:     'created',
  wrote:        'created',
  built:        'created',
  author_of:    'created',
  parent_of:    'part_of',
  child_of:     'part_of',
  contains:     'part_of',
  has:          'part_of',
  includes:     'part_of',
  opposes:      'contradicts',
  refutes:      'contradicts',
  disagrees:    'contradicts',
  negates:      'contradicts',
  stops:        'prevents',
  prevented:    'prevents',
  hinders:      'inhibits',
  slows:        'inhibits',
  threatens:    'risks',
  endangers:    'risks',
  reinforces:   'supports',
  strengthens:  'supports',
  backs:        'supports',
  relates:      'relates_to',
  related_to:   'relates_to',
  about:        'relates_to',
  references:   'mentions',
  cites:        'mentions',
};

/**
 * Coerce entity_type to one of the allowed ENTITY_TYPES. Returns null if
 * the type cannot be mapped — caller should drop the entity.
 */
export function coerceEntityType(raw: string | undefined): string | null {
  if (!raw) return null;
  if (ENTITY_TYPE_SET.has(raw)) return raw;
  // Case-insensitive exact match against allowed set
  for (const allowed of ENTITY_TYPE_SET) {
    if (allowed.toLowerCase() === raw.toLowerCase()) return allowed;
  }
  // Remap table lookup (case-sensitive then case-insensitive)
  if (ENTITY_TYPE_REMAP[raw]) return ENTITY_TYPE_REMAP[raw]!;
  for (const [key, val] of Object.entries(ENTITY_TYPE_REMAP)) {
    if (key.toLowerCase() === raw.toLowerCase()) return val;
  }
  return null;
}

/**
 * Coerce relation_type to one of the allowed RELATIONSHIP_TYPES. Falls
 * back to `relates_to` rather than dropping — a weak edge is more useful
 * than no edge.
 */
export function coerceRelationType(raw: string | undefined): string {
  if (!raw) return 'relates_to';
  if (RELATIONSHIP_TYPE_SET.has(raw)) return raw;
  for (const allowed of RELATIONSHIP_TYPE_SET) {
    if (allowed.toLowerCase() === raw.toLowerCase()) return allowed;
  }
  if (RELATION_TYPE_REMAP[raw]) return RELATION_TYPE_REMAP[raw]!;
  for (const [key, val] of Object.entries(RELATION_TYPE_REMAP)) {
    if (key.toLowerCase() === raw.toLowerCase()) return val;
  }
  return 'relates_to';
}

/**
 * Strip trailing parenthetical qualifiers from an entity label so that
 * "New Tokenizer (Opus 4.7)" and "New Tokenizer (Claude Opus 4.7)" collapse
 * to the same normalised form. Trailing whitespace is also trimmed.
 */
export function normaliseLabelForMerge(label: string): string {
  if (!label) return '';
  // Strip one or more trailing parenthetical groups, then trim.
  return label.replace(/\s*\([^)]*\)\s*$/g, '').trim().toLowerCase();
}

/**
 * Rank entity types by "strength" for same-label cross-type merging. When
 * the AI extracts "Claude 4.7" as both Technology and Product, we pick the
 * more informative / specific type. Higher score = preferred canonical.
 */
const ENTITY_TYPE_PRIORITY: Record<string, number> = {
  Person: 10, Organization: 10, Team: 9,
  Project: 8, Event: 8, Location: 8,
  Product: 7, Document: 7, Metric: 7,
  Technology: 6,
  Concept: 5, Framework: 5, Takeaway: 5, Lesson: 5, Hypothesis: 5,
  Insight: 4, Idea: 4, Question: 4,
  Decision: 6, Goal: 6, Action: 6, Risk: 6, Blocker: 6,
  Topic: 2, Anchor: 1,
};

/**
 * Consolidate entities that refer to the same thing under different labels
 * or types. Specifically:
 *   1. Normalise labels by stripping trailing parentheticals and lowercasing
 *   2. Group by normalised label
 *   3. For each group with > 1 entity: pick the canonical (highest type
 *      priority, then highest confidence). Merge descriptions (longest wins),
 *      union tags + aliases, add non-canonical labels to aliases, take max
 *      confidence + salience.
 *   4. Rewrite relationships so they point at the canonical labels.
 *
 * This runs BEFORE applyQualityFilters so orphan / salience checks operate
 * on the consolidated set.
 */
export function consolidateDuplicateLabels(
  entities: ExtractedEntity[],
  relationships: ExtractedRelationship[]
): { entities: ExtractedEntity[]; relationships: ExtractedRelationship[]; mergedCount: number } {
  const groups = new Map<string, ExtractedEntity[]>();
  for (const e of entities) {
    if (!e.label) continue;
    const key = normaliseLabelForMerge(e.label);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(e);
  }

  const labelRemap = new Map<string, string>(); // original label.toLowerCase() → canonical label
  const consolidated: ExtractedEntity[] = [];
  let mergedCount = 0;

  for (const [, group] of groups) {
    if (group.length === 1) {
      consolidated.push(group[0]!);
      labelRemap.set(group[0]!.label.toLowerCase(), group[0]!.label);
      continue;
    }
    // Pick canonical: highest type priority, then highest confidence, then shortest label (prefer base over qualified)
    const sorted = [...group].sort((a, b) => {
      const pa = ENTITY_TYPE_PRIORITY[a.entity_type] ?? 3;
      const pb = ENTITY_TYPE_PRIORITY[b.entity_type] ?? 3;
      if (pa !== pb) return pb - pa;
      const ca = a.confidence ?? 0;
      const cb = b.confidence ?? 0;
      if (ca !== cb) return cb - ca;
      return a.label.length - b.label.length;
    });
    const canonical = { ...sorted[0]! };
    canonical.tags = [...(canonical.tags ?? [])];
    canonical.aliases = [...(canonical.aliases ?? [])];

    for (const e of sorted.slice(1)) {
      mergedCount++;
      labelRemap.set(e.label.toLowerCase(), canonical.label);
      if ((e.description?.length ?? 0) > (canonical.description?.length ?? 0)) {
        canonical.description = e.description;
      }
      canonical.confidence = Math.max(canonical.confidence ?? 0, e.confidence ?? 0);
      const cSal = (canonical as ExtractedEntity & { salience?: number }).salience ?? 0;
      const eSal = (e as ExtractedEntity & { salience?: number }).salience ?? 0;
      if (eSal > cSal) (canonical as ExtractedEntity & { salience?: number }).salience = eSal;
      const tagSet = new Set([...(canonical.tags ?? []), ...(e.tags ?? [])]);
      canonical.tags = Array.from(tagSet).slice(0, 8);
      const aliasSet: Set<string> = new Set<string>([
        ...(canonical.aliases ?? []),
        ...(e.aliases ?? []),
        e.label,
      ]);
      aliasSet.delete(canonical.label);
      canonical.aliases = Array.from(aliasSet).slice(0, 10);
    }
    labelRemap.set(canonical.label.toLowerCase(), canonical.label);
    consolidated.push(canonical);
  }

  // Rewrite relationships to point at canonical labels
  const rewrittenRels: ExtractedRelationship[] = [];
  for (const r of relationships) {
    if (!r.source || !r.target) continue;
    const src = labelRemap.get(r.source.toLowerCase()) ?? r.source;
    const tgt = labelRemap.get(r.target.toLowerCase()) ?? r.target;
    rewrittenRels.push({ ...r, source: src, target: tgt });
  }

  return { entities: consolidated, relationships: rewrittenRels, mergedCount };
}

/**
 * Apply all post-extraction quality filters in one pass:
 *   1. Coerce entity_type / relation_type to the allowed enums
 *   2. Drop entities with salience below MIN_SALIENCE (when provided)
 *   3. Drop orphan entities (no relationships) — AI is instructed to ensure
 *      every entity has ≥1 relationship; an orphan means the instruction
 *      was violated, so we enforce it at the boundary
 *   4. Drop relationships whose endpoints no longer exist after filtering
 */
export function applyQualityFilters(
  entities: ExtractedEntity[],
  relationships: ExtractedRelationship[]
): { entities: ExtractedEntity[]; relationships: ExtractedRelationship[]; stats: Record<string, number> } {
  const stats = { raw_entities: entities.length, raw_relationships: relationships.length,
                  dropped_invalid_type: 0, dropped_low_salience: 0, dropped_orphan: 0,
                  dropped_dangling_edges: 0, remapped_rel_type: 0 };

  // Step 1: coerce entity types, drop un-mappable
  const typedEntities: ExtractedEntity[] = [];
  for (const e of entities) {
    const coerced = coerceEntityType(e.entity_type);
    if (!coerced) { stats.dropped_invalid_type++; continue; }
    typedEntities.push({ ...e, entity_type: coerced });
  }

  // Step 2: salience filter (only when the AI actually returned a salience)
  const salienceFiltered: ExtractedEntity[] = [];
  for (const e of typedEntities) {
    const s = (e as ExtractedEntity & { salience?: number }).salience;
    if (typeof s === 'number' && s < MIN_SALIENCE) { stats.dropped_low_salience++; continue; }
    salienceFiltered.push(e);
  }

  const keptLabels = new Set(salienceFiltered.map(e => e.label.toLowerCase()));

  // Step 3: coerce relation types, drop dangling
  const coercedRels: ExtractedRelationship[] = [];
  for (const r of relationships) {
    if (!r.source || !r.target) continue;
    if (!keptLabels.has(r.source.toLowerCase()) || !keptLabels.has(r.target.toLowerCase())) {
      stats.dropped_dangling_edges++; continue;
    }
    const coerced = coerceRelationType(r.relation_type);
    if (coerced !== r.relation_type) stats.remapped_rel_type++;
    coercedRels.push({ ...r, relation_type: coerced });
  }

  // Step 4: orphan drop — entities with zero relationships after the above
  let finalEntities = salienceFiltered;
  let finalRels = coercedRels;
  if (DROP_ORPHAN_ENTITIES) {
    const labelsInRels = new Set<string>();
    for (const r of coercedRels) {
      labelsInRels.add(r.source.toLowerCase());
      labelsInRels.add(r.target.toLowerCase());
    }
    const beforeCount = salienceFiltered.length;
    finalEntities = salienceFiltered.filter(e => labelsInRels.has(e.label.toLowerCase()));
    stats.dropped_orphan = beforeCount - finalEntities.length;
    // Recompute kept labels and prune any relationships that lost an endpoint
    const keepSet = new Set(finalEntities.map(e => e.label.toLowerCase()));
    finalRels = coercedRels.filter(r =>
      keepSet.has(r.source.toLowerCase()) && keepSet.has(r.target.toLowerCase())
    );
  }

  return { entities: finalEntities, relationships: finalRels, stats };
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

// ─── Gemini fetch + helpers (retry on 429/5xx, token-usage logging) ─────────

interface GeminiUsage {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
}

async function geminiFetch(
  endpoint: string,
  body: unknown,
  timeoutMs: number,
  stage: string,
): Promise<{ json: unknown; usage: GeminiUsage | undefined }> {
  const url = `${GEMINI_BASE}/${endpoint}?key=${GEMINI_API_KEY}`;
  const maxAttempts = 3;
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify(body),
      });
      if (resp.ok) {
        const json = await resp.json() as { usageMetadata?: GeminiUsage };
        const usage = json.usageMetadata;
        if (usage) {
          console.log(JSON.stringify({
            stage, model: endpoint.split(':')[0],
            prompt_tokens: usage.promptTokenCount,
            output_tokens: usage.candidatesTokenCount,
            total_tokens: usage.totalTokenCount,
          }));
        }
        return { json, usage };
      }
      const txt = await resp.text().catch(() => '');
      lastErr = new Error(`Gemini ${resp.status}: ${txt.slice(0, 200)}`);
      if (resp.status === 429) {
        // Mark for callers that need to distinguish rate-limit errors.
        lastErr = new Error(`RATE_LIMITED: Gemini rate limit hit — ${txt.slice(0, 300)}`);
      }
      if ((resp.status === 429 || resp.status >= 500) && attempt < maxAttempts - 1) {
        await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 1000));
        continue;
      }
      throw lastErr;
    } catch (err) {
      lastErr = err as Error;
      if (attempt < maxAttempts - 1) {
        await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 1000));
        continue;
      }
      throw lastErr;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr ?? new Error('[gemini] request failed');
}

// ─── PROMPT BUILDERS ───────────────────────────────────────────────────────

/**
 * Canonical Stage 4 prompt builder. Re-exported so existing callers can
 * continue to import from this module unchanged. The implementation lives in
 * ./extract-prompt.ts (pure, no env reads, browser-safe).
 */
export const buildExtractionPrompt = buildExtractionPromptCanonical;


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

  let json: unknown;
  try {
    const result = await geminiFetch(
      `${GEMINI_MODEL}:generateContent`,
      {
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents: [{ parts: [{ text: content.slice(0, MAX_TRANSCRIPT_CHARS) }] }],
        generationConfig: { temperature: 0.3, responseMimeType: 'application/json' },
      },
      GEMINI_CALL_TIMEOUT_MS,
      'pipeline:extract'
    );
    json = result.json;
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.startsWith('RATE_LIMITED')) {
      console.error(`[extract-pipeline] Gemini 429 on extractEntities — ${msg.slice(0, 800)}`);
      throw err;
    }
    throw new Error(`Gemini extraction failed: ${msg.slice(0, 200)}`);
  }

  const data = json as {
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
 * Map-reduce extraction for long content. Splits content into overlapping
 * windows (~MAP_REDUCE_WINDOW chars with MAP_REDUCE_OVERLAP carry-over),
 * runs extractEntities on all windows IN PARALLEL, then merges the results.
 *
 * Parallelisation is safe because (a) Gemini 2.5-flash Tier 1 is 1000 RPM
 * and a single source maxes out at ~10 windows, and (b) batchEmbed is the
 * real rate-limit risk, not extraction calls. All windows fire
 * simultaneously, so total wall time ≈ slowest single window (~30-45s)
 * instead of sum of all windows (~5-6 min sequentially).
 *
 * Merge rules:
 *   - Entities dedupe by (label.toLowerCase() + entity_type). The richer
 *     description wins; tags and aliases are unioned; confidence is max.
 *   - Relationships dedupe by (source.toLowerCase(), target.toLowerCase(),
 *     relation_type).
 */
export async function extractEntitiesMapReduce(
  content: string,
  systemPrompt: string
): Promise<ExtractionResult> {
  const windows: string[] = [];
  const step = MAP_REDUCE_WINDOW - MAP_REDUCE_OVERLAP;
  for (let start = 0; start < content.length; start += step) {
    const slice = content.slice(start, start + MAP_REDUCE_WINDOW);
    if (slice.length < 500 && windows.length > 0) break;
    windows.push(slice);
    if (start + MAP_REDUCE_WINDOW >= content.length) break;
  }

  console.log(`[extract-pipeline] Map-reduce extraction over ${windows.length} windows in parallel (content_len=${content.length})`);
  const t0 = Date.now();

  const windowResults = await Promise.allSettled(
    windows.map(async (w, i) => {
      const out = await extractEntities(w, systemPrompt);
      console.log(`[extract-pipeline] map-reduce window ${i + 1}/${windows.length}: ${out.entities.length} entities, ${out.relationships.length} relationships`);
      return out;
    })
  );

  // Surface any rate-limit failure so the caller can retry the whole source.
  for (const r of windowResults) {
    if (r.status === 'rejected') {
      const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
      if (msg.startsWith('RATE_LIMITED')) throw r.reason;
    }
  }

  const entityMap = new Map<string, ExtractedEntity>();
  const relKey = (r: ExtractedRelationship) =>
    `${r.source?.toLowerCase()}|${r.target?.toLowerCase()}|${r.relation_type}`;
  const relMap = new Map<string, ExtractedRelationship>();
  let failedWindows = 0;

  windowResults.forEach((res, i) => {
    if (res.status === 'rejected') {
      failedWindows++;
      const msg = res.reason instanceof Error ? res.reason.message : String(res.reason);
      console.warn(`[extract-pipeline] map-reduce window ${i + 1} failed (non-fatal):`, msg);
      return;
    }
    const { entities = [], relationships = [] } = res.value;
    for (const e of entities) {
      if (!e.label || !e.entity_type) continue;
      const key = `${e.label.toLowerCase()}|${e.entity_type}`;
      const existing = entityMap.get(key);
      if (!existing) {
        entityMap.set(key, { ...e, tags: [...(e.tags ?? [])] });
        continue;
      }
      if ((e.description?.length ?? 0) > (existing.description?.length ?? 0)) {
        existing.description = e.description;
      }
      existing.confidence = Math.max(existing.confidence ?? 0, e.confidence ?? 0);
      const tagSet = new Set([...(existing.tags ?? []), ...(e.tags ?? [])]);
      existing.tags = Array.from(tagSet).slice(0, 8);
    }
    for (const r of relationships) {
      if (!r.source || !r.target || !r.relation_type) continue;
      const key = relKey(r);
      if (!relMap.has(key)) relMap.set(key, r);
    }
  });

  console.log(`[extract-pipeline] Map-reduce complete in ${((Date.now() - t0) / 1000).toFixed(1)}s, ${failedWindows}/${windows.length} windows failed`);

  return {
    entities: Array.from(entityMap.values()),
    relationships: Array.from(relMap.values()),
  };
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
    let json: unknown;
    try {
      const result = await geminiFetch(
        `${GEMINI_EMBEDDING_MODEL}:batchEmbedContents`,
        {
          requests: slice.map(text => ({
            model: `models/${GEMINI_EMBEDDING_MODEL}`,
            content: { parts: [{ text }] },
          })),
        },
        30_000,
        'pipeline:batch-embed'
      );
      json = result.json;
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.startsWith('RATE_LIMITED')) {
        console.error(`[extract-pipeline] Gemini 429 on batchEmbed — ${msg.slice(0, 800)}`);
        throw new Error(`RATE_LIMITED: Gemini embedding rate limit hit — ${msg.slice(0, 300)}`);
      }
      console.warn(`[extract-pipeline] batchEmbed failed: ${msg.slice(0, 200)}`);
      continue;
    }

    const data = json as { embeddings?: Array<{ values?: number[] }> };
    const embeddings = data.embeddings ?? [];
    for (let i = 0; i < slice.length; i++) {
      results[start + i] = embeddings[i]?.values ?? [];
    }
  }
  return results;
}

/** Single embedding — use batchEmbed() wherever possible instead. */
export async function generateEmbedding(text: string): Promise<number[]> {
  try {
    const { json } = await geminiFetch(
      `${GEMINI_EMBEDDING_MODEL}:embedContent`,
      { model: `models/${GEMINI_EMBEDDING_MODEL}`, content: { parts: [{ text }] } },
      15_000,
      'pipeline:embedding'
    );
    const data = json as { embedding?: { values?: number[] } };
    return data.embedding?.values ?? [];
  } catch {
    return [];
  }
}

// ─── CHUNKING ──────────────────────────────────────────────────────────────
// Byte-equivalent paste-in copy of src/utils/chunking.ts. Vercel forbids
// shared local imports, so this lives inline. If you change anything here,
// update src/utils/chunking.ts and api/content/backfill-chunks.ts to match.

const CHUNK_TARGET_CHARS = 2000;
const CHUNK_OVERLAP_CHARS = 100;
const CHUNK_MAX_CHARS = 3000;

const ABBREVIATIONS = [
  'Dr', 'Mr', 'Mrs', 'Ms', 'Prof', 'Sr', 'Jr', 'St',
  'vs', 'etc', 'e.g', 'i.e', 'U.S', 'U.K', 'U.N',
  'No', 'Inc', 'Ltd', 'Co', 'Corp', 'Fig', 'cf', 'al',
];
const DOT_SENTINEL = String.fromCharCode(0xE000);
const ABBREV_RE = new RegExp(
  '\\b(' + ABBREVIATIONS.map(a => a.replace(/\./g, '\\.')).join('|') + ')\\.',
  'g',
);

function splitSentences(text: string): string[] {
  const masked = text.replace(ABBREV_RE, (_, a) => `${a}${DOT_SENTINEL}`);
  const parts = masked.split(/(?<=[.!?])\s+(?=["'(\[]?[A-Z0-9])/g);
  return parts.map(p => p.split(DOT_SENTINEL).join('.').trim()).filter(Boolean);
}

function splitSections(text: string): string[] {
  const lines = text.split('\n');
  const sections: string[] = [];
  let buf: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    const isHeading = /^#{1,6}\s/.test(line);
    const isRule = /^[-_*]{3,}$/.test(trimmed);
    if (isHeading || isRule) {
      if (buf.length) sections.push(buf.join('\n').trim());
      buf = [line];
    } else {
      buf.push(line);
    }
  }
  if (buf.length) sections.push(buf.join('\n').trim());
  return sections.filter(s => s.length > 0);
}

function splitParagraphs(text: string): string[] {
  return text.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
}

export function chunkText(
  content: string,
  targetChars: number = CHUNK_TARGET_CHARS,
  overlapChars: number = CHUNK_OVERLAP_CHARS,
  maxChars: number = CHUNK_MAX_CHARS,
): string[] {
  if (!content || !content.trim()) return [];
  const units: string[] = [];
  for (const section of splitSections(content)) {
    for (const para of splitParagraphs(section)) {
      if (para.length <= targetChars) {
        units.push(para);
        continue;
      }
      for (const sent of splitSentences(para)) {
        if (sent.length <= maxChars) {
          units.push(sent);
        } else {
          for (let i = 0; i < sent.length; i += targetChars) {
            units.push(sent.slice(i, i + targetChars));
          }
        }
      }
    }
  }
  const chunks: string[] = [];
  let current = '';
  for (const unit of units) {
    const sep = current ? '\n\n' : '';
    if (current.length + sep.length + unit.length > targetChars && current.length > 0) {
      chunks.push(current.trim());
      const overlapStart = Math.max(0, current.length - overlapChars);
      current = current.substring(overlapStart).trim() + '\n\n' + unit;
    } else {
      current += sep + unit;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  const merged: string[] = [];
  for (const c of chunks) {
    if (merged.length > 0 && c.length < 200) {
      merged[merged.length - 1] += '\n\n' + c;
    } else {
      merged.push(c);
    }
  }
  return merged.filter(c => c.length > 0);
}

function buildChunkEmbeddingInput(title: string | null | undefined, chunkContent: string): string {
  const t = (title ?? '').trim();
  return t ? `${t}\n\n${chunkContent}` : chunkContent;
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
            p_exact_threshold: DEDUP_EXACT_THRESHOLD,
            p_semantic_threshold: DEDUP_SEMANTIC_THRESHOLD,
          });
          const best = (matches as Array<{
            match_id: string; match_label: string; match_type: string; similarity: number;
          }> | null)?.[0];
          if (!best) return;

          if (best.match_type === 'exact' ||
              (best.match_type === 'fuzzy' && best.similarity >= DEDUP_AUTO_MERGE_THRESHOLD)) {
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

    const { error: edgeError } = await supabase.from('knowledge_edges').upsert({
      user_id: userId,
      source_node_id: sourceNodeId,
      target_node_id: targetNodeId,
      relation_type: rel.relation_type ?? 'relates_to',
      evidence: rel.evidence ?? null,
      weight,
    }, { onConflict: 'user_id,source_node_id,target_node_id,relation_type', ignoreDuplicates: true });
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
 * Split content into ~500-token chunks, batch-embed them with the source
 * title prepended for retrieval context, then bulk-upsert into source_chunks.
 *
 * Failure semantics (Stage 3):
 *   - Chunking failure -> throws (caller sets source.status='failed').
 *   - Embedding failure for any chunk -> throws (caller sets status='degraded').
 *   - All-or-nothing: if any chunk lacks an embedding, no rows are inserted.
 *   - Idempotent: insert uses ON CONFLICT (source_id, chunk_index) DO NOTHING.
 */
export async function saveTranscriptChunks(
  content: string,
  sourceId: string,
  userId: string,
  supabase: SupabaseClient,
  title: string | null = null
): Promise<number> {
  const chunks = chunkText(content);
  if (chunks.length === 0) return 0;

  const embeddingInputs = chunks.map(c => buildChunkEmbeddingInput(title, c));
  const embeddings = await batchEmbed(embeddingInputs);

  const missing = embeddings.findIndex(e => !e || e.length === 0);
  if (missing >= 0) {
    throw new Error(`Embedding missing for chunk ${missing} of source ${sourceId}`);
  }

  const rows = chunks.map((chunk, i) => ({
    user_id: userId,
    source_id: sourceId,
    chunk_index: i,
    content: chunk,
    embedding: embeddings[i],
  }));

  const { error } = await supabase
    .from('source_chunks')
    .upsert(rows, { onConflict: 'source_id,chunk_index', ignoreDuplicates: true });
  if (error) {
    throw new Error(`source_chunks upsert failed: ${error.message}`);
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
  // Time-budget gate: skip if the extraction has already taken too long.
  // DEFAULT_TIME_BUDGET_MS = 50 s. Cross-connections get whatever remains up
  // to that cap. If we are past it, log and return so the caller can finish.
  if (Date.now() - itemStartTime >= timeBudgetMs) {
    log({ stage: 'cross-connect', status: 'skipped', user_id: userId, reason: 'time_budget_exceeded' });
    return 0;
  }

  const stageStart = Date.now();
  try {
    const newNodeIds = new Set(savedNodeMap.values());
    type SemanticCandidate = { id: string; label: string; entity_type: string; description: string | null; similarity?: number };
    const candidateMap = new Map<string, SemanticCandidate>();

    // One RPC call per new node. Stop early if the budget runs out mid-loop.
    for (const [, embedding] of nodeEmbeddings) {
      if (Date.now() - itemStartTime >= timeBudgetMs) {
        log({ stage: 'cross-connect', status: 'partial', user_id: userId, reason: 'time_budget_during_rpc' });
        break;
      }
      const { data: similar, error: rpcErr } = await supabase.rpc('match_knowledge_nodes', {
        query_embedding: embedding,
        match_threshold: 0.55,
        match_count: 30,
        p_user_id: userId,
      });
      if (rpcErr) {
        logError({ stage: 'cross-connect', user_id: userId, status: 'skipped', error: `RPC error: ${rpcErr.message}` });
        continue;
      }
      for (const s of (similar ?? []) as SemanticCandidate[]) {
        if (!newNodeIds.has(s.id)) {
          const existing = candidateMap.get(s.id);
          if (!existing || (s.similarity ?? 0) > (existing.similarity ?? 0)) candidateMap.set(s.id, s);
        }
      }
    }

    // Cap at 20 top candidates — consistent with api/cross-connect/run.ts
    const existingNodes = [...candidateMap.values()]
      .sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0))
      .slice(0, 20);
    if (existingNodes.length === 0) {
      log({ stage: 'cross-connect', status: 'ok', user_id: userId, duration_ms: Date.now() - stageStart, edges_created: 0, reason: 'no_candidates' });
      return 0;
    }

    const newEntityLines = entities.slice(0, 20)
      .map(e => `- [${e.entity_type}] ${e.label}: ${e.description ?? ''}`)
      .join('\n');
    const existingEntityLines = existingNodes
      .map(e => `- [${e.entity_type}] ${e.label}: ${e.description ?? ''}`)
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
    { "source": "entity label", "target": "entity label", "relation_type": "one of: leads_to|supports|enables|blocks|contradicts|part_of|relates_to|associated_with", "evidence": "one sentence justification" }
  ]
}

Return an empty array if no genuine cross-source connections exist.`;

    let crossData: { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    try {
      const { json } = await geminiFetch(
        `${GEMINI_MODEL}:generateContent`,
        {
          system_instruction: { parts: [{ text: 'You are a knowledge graph relationship expert. Find non-obvious cross-source connections. Prioritise directional, specific types over generic ones.' }] },
          contents: [{ parts: [{ text: crossPrompt }] }],
          generationConfig: { temperature: 0.1, responseMimeType: 'application/json' },
        },
        30_000,
        'cross-connect'
      );
      crossData = json as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    } catch (geminiErr) {
      logError({ stage: 'cross-connect', user_id: userId, status: 'skipped', error: `Gemini error: ${(geminiErr as Error).message}`, duration_ms: Date.now() - stageStart });
      return 0;
    }
    const crossText = crossData.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!crossText) {
      log({ stage: 'cross-connect', status: 'skipped', user_id: userId, duration_ms: Date.now() - stageStart, reason: 'empty_gemini_response' });
      return 0;
    }

    let crossResult: { relationships?: ExtractedRelationship[] };
    try {
      crossResult = JSON.parse(crossText);
    } catch (parseErr) {
      logError({ stage: 'cross-connect', user_id: userId, status: 'skipped', error: `malformed JSON: ${crossText.slice(0, 200)}`, duration_ms: Date.now() - stageStart });
      return 0;
    }

    const existingNodeMap = new Map(existingNodes.map(n => [n.label.toLowerCase(), n.id]));
    const savedLabelMap = new Map<string, string>();
    for (const [label, id] of savedNodeMap) {
      savedLabelMap.set(label.toLowerCase(), id);
    }

    // Build bulk insert list — never loop individual inserts (CLAUDE.md bulk-write rule)
    type EdgeInsert = { user_id: string; source_node_id: string; target_node_id: string; relation_type: string; evidence: string | null; weight: number };
    const toInsert: EdgeInsert[] = [];
    for (const rel of crossResult.relationships ?? []) {
      const srcId = savedLabelMap.get(rel.source?.toLowerCase()) ?? existingNodeMap.get(rel.source?.toLowerCase());
      const tgtId = savedLabelMap.get(rel.target?.toLowerCase()) ?? existingNodeMap.get(rel.target?.toLowerCase());
      if (srcId && tgtId && srcId !== tgtId) {
        toInsert.push({
          user_id: userId,
          source_node_id: srcId,
          target_node_id: tgtId,
          relation_type: rel.relation_type ?? 'relates_to',
          evidence: rel.evidence ?? null,
          weight,
        });
      }
    }

    if (toInsert.length === 0) {
      log({ stage: 'cross-connect', status: 'ok', user_id: userId, duration_ms: Date.now() - stageStart, edges_created: 0 });
      return 0;
    }

    const { data: inserted, error: insertErr } = await supabase
      .from('knowledge_edges')
      .insert(toInsert)
      .select('id');

    if (insertErr) {
      logError({ stage: 'cross-connect', user_id: userId, status: 'skipped', error: `bulk insert failed: ${insertErr.message}`, edge_count: toInsert.length, duration_ms: Date.now() - stageStart });
      return 0;
    }

    const crossConnectionCount = inserted?.length ?? 0;
    log({ stage: 'cross-connect', status: 'ok', user_id: userId, duration_ms: Date.now() - stageStart, edges_created: crossConnectionCount, candidates_evaluated: existingNodes.length });
    return crossConnectionCount;
  } catch (err) {
    logError({ stage: 'cross-connect', user_id: userId, status: 'skipped', error: (err as Error).message, duration_ms: Date.now() - stageStart });
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

  // 1. Gemini entity extraction — single call under threshold, map-reduce above
  const systemPrompt = buildExtractionPrompt(promptConfig);
  const rawResult =
    content.length > MAP_REDUCE_THRESHOLD
      ? await extractEntitiesMapReduce(content, systemPrompt)
      : await extractEntities(content, systemPrompt);
  console.log(`[extract-pipeline] Raw: ${rawResult.entities.length} entities, ${rawResult.relationships.length} relationships for ${source.sourceId} (content_len=${content.length})`);

  // 1a. Consolidate same-label-different-type duplicates and strip trailing
  // parenthetical qualifiers. Runs BEFORE quality filters so orphan checks
  // see the post-merge set.
  const consolidated = consolidateDuplicateLabels(rawResult.entities, rawResult.relationships);
  console.log(`[extract-pipeline] Consolidated: ${consolidated.entities.length} entities (merged ${consolidated.mergedCount} duplicates), ${consolidated.relationships.length} relationships`);

  // 1b. Quality filters: coerce invalid types, drop low-salience, drop orphans
  const filtered = applyQualityFilters(consolidated.entities, consolidated.relationships);
  const entities = filtered.entities;
  const relationships = filtered.relationships;
  console.log(`[extract-pipeline] Filtered: ${entities.length} entities, ${relationships.length} relationships (stats=${JSON.stringify(filtered.stats)})`);

  // Post-extraction health check — flag low-yield extractions on long content
  if (content.length >= HEALTH_MIN_CONTENT_FOR_CHECK && entities.length < HEALTH_MIN_ENTITIES) {
    console.warn(`[PIPELINE_HEALTH_LOW_YIELD] source=${source.sourceId} type=${source.sourceType} content_len=${content.length} entities=${entities.length} relationships=${relationships.length} — below ${HEALTH_MIN_ENTITIES}-entity floor for ${HEALTH_MIN_CONTENT_FOR_CHECK}+ char content`);
  }

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

  // 5a. Embed edges inline (Stage 7 requirement: edge embeddings during persistence)
  if (edgesCreated > 0) {
    try {
      // Build label→id map from saved nodes
      const nodeLabelMap = new Map<string, { id: string; label: string; entity_type: string }>();
      for (const [label, id] of savedNodeMap) {
        // savedNodeMap is label→id; we need a reverse for embedding text
        nodeLabelMap.set(id, { id, label, entity_type: '' });
      }
      // Fetch node labels for edge embedding text
      const nodeIds = [...new Set([
        ...relationships.map(r => savedNodeMap.get(r.source)).filter(Boolean) as string[],
        ...relationships.map(r => savedNodeMap.get(r.target)).filter(Boolean) as string[],
      ])];
      if (nodeIds.length > 0) {
        const { data: nodeRows } = await supabase
          .from('knowledge_nodes')
          .select('id, label, entity_type')
          .in('id', nodeIds);
        for (const n of nodeRows ?? []) {
          const nr = n as { id: string; label: string; entity_type: string };
          nodeLabelMap.set(nr.id, nr);
        }
      }
      // Build edge embedding texts and map to edge info
      const edgeTexts: string[] = [];
      const edgeInfos: Array<{ sourceId: string; targetId: string; relationType: string }> = [];
      for (const rel of relationships) {
        const sId = savedNodeMap.get(rel.source);
        const tId = savedNodeMap.get(rel.target);
        if (!sId || !tId || sId === tId) continue;
        const sNode = nodeLabelMap.get(sId);
        const tNode = nodeLabelMap.get(tId);
        if (!sNode || !tNode) continue;
        edgeTexts.push(`${sNode.label} ${rel.relation_type} ${tNode.label}${rel.evidence ? `: ${rel.evidence}` : ''}`);
        edgeInfos.push({ sourceId: sId, targetId: tId, relationType: rel.relation_type });
      }
      if (edgeTexts.length > 0) {
        const edgeEmbeddings = await batchEmbed(edgeTexts);
        const updates: Array<{ user_id: string; source_node_id: string; target_node_id: string; relation_type: string; embedding: number[] }> = [];
        for (let i = 0; i < edgeInfos.length; i++) {
          const emb = edgeEmbeddings[i];
          const info = edgeInfos[i];
          if (emb && emb.length > 0 && info) {
            updates.push({
              user_id: userId,
              source_node_id: info.sourceId,
              target_node_id: info.targetId,
              relation_type: info.relationType,
              embedding: emb,
            });
          }
        }
        // Bulk update edges with embeddings
        await Promise.allSettled(
          updates.map(u =>
            supabase
              .from('knowledge_edges')
              .update({ embedding: u.embedding })
              .eq('user_id', u.user_id)
              .eq('source_node_id', u.source_node_id)
              .eq('target_node_id', u.target_node_id)
              .eq('relation_type', u.relation_type)
          )
        );
        log({ stage: 'extract:edge-embed', source_id: source.sourceId, user_id: userId, status: 'ok', count: updates.length });
      }
    } catch (err) {
      logError({ stage: 'extract:edge-embed', source_id: source.sourceId, user_id: userId, status: 'failed', error: String(err) });
      // Non-blocking — edges without embeddings are still valuable
    }
  }

  // 6. Chunks. Stage 3 policy: chunking failure -> 'failed', embedding failure -> 'degraded'.
  let chunksCreated = 0;
  if (enableChunking) {
    try {
      chunksCreated = await saveTranscriptChunks(content, source.sourceId, userId, supabase, source.sourceLabel ?? null);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const isEmbeddingFailure = message.startsWith('Embedding missing') || message.includes('RATE_LIMITED');
      const newStatus = isEmbeddingFailure ? 'degraded' : 'failed';
      await supabase
        .from('knowledge_sources')
        .update({ status: newStatus })
        .eq('id', source.sourceId)
        .eq('user_id', userId);
      console.error(JSON.stringify({
        ts: new Date().toISOString(),
        level: 'error',
        stage: 'chunk',
        source_id: source.sourceId,
        user_id: userId,
        status: newStatus,
        error: message,
      }));
      throw err;
    }
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
