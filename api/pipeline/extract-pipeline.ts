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

const MODE_INSTRUCTIONS: Record<string, string> = {
  comprehensive: 'Extract every entity and relationship that will still be useful to the user six months from now. Target roughly 1 entity per 900 chars of instructional/analytical content and 1 per 600 chars of conversation. Prioritise depth over breadth — a smaller number of high-value entities beats a long list of generic ones. Drop generic single-word nouns (e.g. "Buttons", "Cards", "Text") unless they are the explicit subject of a named framework.',
  strategic:     'Focus on high-level concepts, strategic decisions, goals, and their interdependencies. Prioritise organisational and directional information.',
  actionable:    'Emphasise actions, goals, blockers, deadlines, and decisions. Capture what needs to be done, by whom, and any impediments.',
  relational:    'Prioritise connections and relationships between entities. Emphasise how concepts, people, and organisations relate to each other.',
};

const EMPHASIS_INSTRUCTIONS: Record<string, string> = {
  passive:    'Treat anchors as low-priority context. Extract them if naturally occurring but do not force anchor-related entities.',
  standard:   'Give moderate weight to anchor-related content. When content relates to an anchor, extract that connection.',
  aggressive: 'Heavily weight extraction toward anchor-related content. Actively connect extracted entities back to anchors where plausible.',
};

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

// Post-extraction quality filters
const MIN_SALIENCE         = 0.4;
const DROP_ORPHAN_ENTITIES = true;

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
 * Build the v2 extraction prompt. XML-tagged, domain-agnostic, with
 * cross-domain worked examples. See docs/EXTRACTION-PROMPT-V2.md for the
 * design rationale.
 */
export function buildExtractionPrompt(config: PromptConfig): string {
  const modeInstruction = MODE_INSTRUCTIONS[config.mode] ?? MODE_INSTRUCTIONS['comprehensive']!;
  const emphasisInstruction = EMPHASIS_INSTRUCTIONS[config.anchorEmphasis] ?? EMPHASIS_INSTRUCTIONS['standard']!;

  const sections: string[] = [];

  sections.push(`<role>
You are the extraction engine for a personal knowledge graph called Synapse.
You serve users across every domain — technology, finance, marketing, sales,
law, medicine, psychology, education, consulting, science, the arts,
operations, policy. Treat every source as domain-agnostic: you do not know in
advance whether you are reading a legal deposition, an earnings call, a
therapy transcript, a marketing strategy meeting, a physics lecture, or a
software tutorial. Your extraction quality must hold equally across all.

Return every entity and relationship that will still be useful to the user
six months from now, regardless of their field.

This is a PERSONAL knowledge graph, not an encyclopedia:
  - Well-known entities MUST be extracted when mentioned (Fortune 500
    companies, famous academics, landmark legal cases, standard
    methodologies, canonical products). Never skip on grounds of "common
    knowledge."
  - Frameworks, methods, doctrines, models, playbooks, and principles
    INSIDE instructional or analytical content are usually the highest-
    value extraction — more than the people or brands cited as examples.
    A source teaching a named method is incomplete without that method
    AND its sub-components as first-class Concept nodes.
  - Normalise transcript mishearings, OCR artefacts, and auto-caption
    errors to canonical forms. If you cannot confidently infer the
    canonical form, preserve the best phonetic guess AND tag it
    \`needs_review\`.
  - Domain jargon is high-value, not noise: medical codes, legal
    citations, drug names, chemical compounds, financial instruments,
    academic works — all in-scope.
</role>`);

  sections.push(`<extraction_mode>
Mode: ${config.mode}
${modeInstruction}
</extraction_mode>`);

  sections.push(`<content_types>
Detect the content shape first, then adapt priorities. Shapes are
domain-agnostic.
  - Conversation / meeting transcript — prioritise: Person, Organization,
    Decision, Action, Blocker, Risk, Goal, Question. Secondary: Topic,
    Project, Insight, Metric.
  - Instructional / tutorial / lecture — prioritise: Concept (the
    framework or method being taught), Takeaway, Lesson, Person
    (authors/authorities), Organization, Technology, Product, Metric.
    Secondary: Document, Event.
  - Essay / article / analysis / opinion piece — prioritise: Concept,
    Insight, Hypothesis, Takeaway, Person, Organization. Secondary:
    Metric, Document, Technology, Product.
  - Reference / technical / procedural document — prioritise: Concept,
    Technology, Product, Decision, Project, Document. Secondary: Person,
    Metric, Organization.
  - Research / report / data analysis — prioritise: Hypothesis, Insight,
    Metric, Concept, Organization, Document. Secondary: Person, Event,
    Location.
  - Narrative / interview / case study — prioritise: Person, Event,
    Location, Organization, Insight, Lesson, Decision. Secondary:
    Concept, Takeaway.

On any content type, ALWAYS also extract Location (when specific places
are named), Event (when specific events are named), Document (when named
reports/papers/books/specs/statutes/case-law/standards/contracts/URLs are
cited), and Metric (when named numbers/benchmarks/KPIs/ratios are cited).
</content_types>`);

  sections.push(`<entity_guide>
Use exactly these 24 entity types. When two types could apply, use the
disambiguation rule.
  - Person — a named individual human. Never a company or product.
  - Organization — a company, non-profit, government body, or brand.
  - Team — a named subgroup inside an organisation. If unsure, use Organization.
  - Topic — a broad domain or subject area. Use sparingly; prefer Concept
    for anything more specific than a subject heading.
  - Project — a named, time-bounded piece of work with a goal. Works
    across domains: product launch, legal case, clinical trial, campaign,
    investigation, dissertation, audit.
  - Goal — a stated outcome someone is trying to achieve. Distinct from
    Project: a goal is the outcome, a project is the effort.
  - Action — a specific to-do, next step, or commitment, usually with an
    owner. Most common in meeting content.
  - Risk — a named downside possibility.
  - Blocker — a named impediment blocking progress.
  - Decision — an explicit choice between alternatives (ruling, diagnosis,
    hire, strategy pick, go/no-go).
  - Insight — a non-obvious observation drawn from evidence; usually the
    speaker's own realisation.
  - Question — an explicit open question raised in the content.
  - Idea — a proposed, not-yet-decided direction.
  - Concept — a named framework, mental model, theory, principle, rule,
    doctrine, methodology, technique, or playbook. If the source teaches
    or analyses a named thing, it belongs here.
  - Takeaway — a prescriptive lesson the content argues for. Phrase as
    imperative.
  - Lesson — retrospective learning from a specific past experience.
  - Document — a named report, paper, book, statute, case citation,
    regulation, contract, spec, URL, or artefact. Never for websites-as-
    products (those are Product) or the content itself.
  - Event — a named, time-bounded happening.
  - Location — a specific named place.
  - Technology — a technical approach, method, language, protocol,
    library, algorithm, instrument, or apparatus referenced by name but
    not sold as a branded product.
  - Product — a branded piece of software/hardware/good/service offered
    by an identifiable vendor. Websites-as-services are Product.
  - Metric — a named measurement, benchmark, KPI, ratio, index, rating.
  - Hypothesis — a testable claim stated as a belief, not yet validated.
  - Anchor — RESERVED. Only use when explicitly listed in the anchor
    section below.
</entity_guide>`);

  sections.push(`<relationship_guide>
Use exactly these 18 types. PREFER DIRECTIONAL, SPECIFIC types.
Downrank \`relates_to\`, \`mentions\`, \`connected_to\` — only use when
nothing more precise fits.
Directional: leads_to, supports, enables, created, achieved, produced,
blocks, contradicts, risks, prevents, challenges, inhibits.
Structural: part_of, owns, associated_with.
Weak fallback: relates_to, mentions, connected_to.
</relationship_guide>`);

  sections.push(`<defensive_rules>
  1. NORMALISE NAMES. Fix mishearings, auto-caption errors, OCR
     artefacts, and common mis-spellings to canonical form (for people,
     organisations, products, technologies, legal citations, drug names,
     chemical compounds, academic institutions, domain terms-of-art). If
     you cannot confidently infer the canonical form, preserve the best
     phonetic guess and add tag \`needs_review\`.
  2. EXTRACT WELL-KNOWN ENTITIES. Never skip on grounds of being famous,
     obvious, or common knowledge. This applies across every domain.
  3. EXTRACT FRAMEWORKS AS CONCEPTS. In instructional or analytical
     content, the named framework / method / doctrine IS the highest-
     value extraction. Name it precisely, describe it self-containedly,
     extract each sub-component as its own Concept with \`part_of\`.
  4. EXTRACT TAKEAWAYS AS IMPERATIVES. Most instructional/advisory
     content has 3-10 prescriptive lessons. Phrase each as an imperative
     the user could follow.
  5. COLLAPSE DUPLICATES WITHIN A SINGLE EXTRACTION. Surface variants
     must collapse to a canonical entity; list alternates in \`aliases\`.
  6. DENSITY FLOOR. ~1 entity per 600 chars (instructional/analytical) or
     1 per 400 chars (meetings). Under-extraction is worse than over-
     extraction.
  7. RELATIONSHIP FLOOR. Every entity should have ≥1 relationship. If
     not, drop the entity or find a relationship.
  8. DESCRIPTIONS ARE 1-3 SENTENCES, SELF-CONTAINED, 40-400 chars. A
     future reader should understand the entity without the source.
</defensive_rules>`);

  sections.push(`<examples>
These examples span domains deliberately. Study the shape, not the domain.

EXAMPLE 1 — instructional (finance/investing):
INPUT: "Most retail investors misuse the Sharpe ratio. Sharpe assumes
returns are normally distributed, which fails after 2008. A better
starting point is the Sortino ratio, which only penalises downside
volatility. Ray Dalio's All Weather portfolio uses risk parity, not
Sharpe optimisation, which is why it held up through the GFC when a
60/40 did not."
OUTPUT:
{"entities":[
  {"label":"Sharpe Ratio","entity_type":"Metric","description":"Risk-adjusted return metric dividing excess return by total standard deviation. Criticised here for assuming normally-distributed returns.","confidence":0.98,"tags":["finance","risk-metric"]},
  {"label":"Sortino Ratio","entity_type":"Metric","description":"Risk-adjusted return metric penalising only downside volatility; proposed as a better starting point than Sharpe.","confidence":0.95,"tags":["finance","risk-metric"]},
  {"label":"Risk Parity","entity_type":"Concept","description":"Portfolio construction method allocating by equal risk contribution rather than dollar weight or Sharpe optimisation.","confidence":0.95,"tags":["finance","portfolio-construction"]},
  {"label":"All Weather Portfolio","entity_type":"Concept","description":"Ray Dalio's risk-parity-based portfolio designed to perform across economic regimes; held up through the 2008 GFC.","confidence":0.95,"tags":["finance","portfolio"]},
  {"label":"60/40 Portfolio","entity_type":"Concept","description":"Standard 60% equities / 40% bonds allocation, cited as underperforming through the GFC relative to risk-parity.","confidence":0.95,"tags":["finance","portfolio"]},
  {"label":"Ray Dalio","entity_type":"Person","description":"Founder of Bridgewater Associates; cited as originator of the All Weather portfolio.","confidence":0.95,"tags":["investor"]},
  {"label":"2008 Global Financial Crisis","entity_type":"Event","description":"The 2008 financial crisis; stress test that exposed Sharpe-based and 60/40 strategies.","confidence":0.9,"tags":["macro","crisis"],"aliases":["GFC"]},
  {"label":"Prefer downside-volatility measures over total-volatility measures","entity_type":"Takeaway","description":"Retail investors should move from Sharpe toward downside-aware metrics like Sortino.","confidence":0.9,"tags":["finance","advisory"]}
],"relationships":[
  {"source":"Sortino Ratio","target":"Sharpe Ratio","relation_type":"challenges","evidence":"Proposed as better because it penalises only downside volatility."},
  {"source":"All Weather Portfolio","target":"Risk Parity","relation_type":"part_of","evidence":"Uses risk parity rather than Sharpe optimisation."},
  {"source":"Ray Dalio","target":"All Weather Portfolio","relation_type":"created","evidence":"Cited as author."},
  {"source":"All Weather Portfolio","target":"60/40 Portfolio","relation_type":"challenges","evidence":"Held up through GFC when 60/40 did not."},
  {"source":"2008 Global Financial Crisis","target":"Sharpe Ratio","relation_type":"contradicts","evidence":"Exposed Sharpe's assumption of normally-distributed returns."}
]}

EXAMPLE 2 — conversation (legal/professional services):
INPUT: "Priya: We need to decide on the Chen motion by Friday. If we file
under Rule 12(b)(6), we get a cleaner record but lose the counterclaim.
Marcus: The blocker is Discovery hasn't confirmed whether the 2019 email
chain is privileged. Ana is chasing it. Priya: Risk is if we don't have
privilege confirmed by Wednesday we miss the filing window."
OUTPUT:
{"entities":[
  {"label":"Priya Shah","entity_type":"Person","description":"Speaker driving the filing decision on the Chen motion.","confidence":0.85,"tags":["speaker","needs_review"]},
  {"label":"Marcus Lee","entity_type":"Person","description":"Speaker raising the privilege-review blocker.","confidence":0.85,"tags":["speaker","needs_review"]},
  {"label":"Ana Ortiz","entity_type":"Person","description":"Associate chasing Discovery on privilege for the 2019 email chain.","confidence":0.8,"tags":["needs_review"]},
  {"label":"Chen Motion","entity_type":"Project","description":"The motion under decision; trade-off between cleaner record and preserving the counterclaim.","confidence":0.95,"tags":["litigation"]},
  {"label":"Decide filing strategy on Chen motion by Friday","entity_type":"Decision","description":"Go/no-go decision required by Friday on whether to file under Rule 12(b)(6).","confidence":0.95,"tags":["litigation"]},
  {"label":"Rule 12(b)(6)","entity_type":"Concept","description":"Federal Rule of Civil Procedure 12(b)(6) — motion to dismiss for failure to state a claim.","confidence":0.95,"tags":["fed-civ-pro"]},
  {"label":"Unconfirmed privilege on 2019 email chain","entity_type":"Blocker","description":"Discovery has not confirmed whether a 2019 email chain is privileged, holding up the filing decision.","confidence":0.95,"tags":["discovery","privilege"]},
  {"label":"Miss filing window if privilege unresolved by Wednesday","entity_type":"Risk","description":"If privilege is not confirmed by Wednesday, the filing window is missed.","confidence":0.9,"tags":["deadline"]}
],"relationships":[
  {"source":"Unconfirmed privilege on 2019 email chain","target":"Chen Motion","relation_type":"blocks","evidence":"Filing decision held up by the privilege question."},
  {"source":"Ana Ortiz","target":"Unconfirmed privilege on 2019 email chain","relation_type":"associated_with","evidence":"Chasing Discovery."},
  {"source":"Miss filing window if privilege unresolved by Wednesday","target":"Unconfirmed privilege on 2019 email chain","relation_type":"risks","evidence":"Risk conditional on the blocker."},
  {"source":"Chen Motion","target":"Rule 12(b)(6)","relation_type":"part_of","evidence":"The proposed filing is under Rule 12(b)(6)."},
  {"source":"Priya Shah","target":"Decide filing strategy on Chen motion by Friday","relation_type":"owns","evidence":"Driving the decision."}
]}

EXAMPLE 3 — analytical (marketing/GTM):
INPUT: "HubSpot's latest report shows B2B SaaS companies under $10M ARR
get the worst ROI from paid search — roughly 0.4x payback at 12 months.
The fix isn't to bid smarter; it's to abandon paid search until you have
a repeatable organic motion. April Dunford makes the same point in
Obviously Awesome: positioning comes first, channels come second."
OUTPUT:
{"entities":[
  {"label":"HubSpot","entity_type":"Organization","description":"Marketing/CRM software company; source of the B2B SaaS paid-search ROI figure.","confidence":0.98,"tags":["saas","source"]},
  {"label":"B2B SaaS Paid Search ROI (sub-$10M ARR)","entity_type":"Metric","description":"Per HubSpot, sub-$10M ARR B2B SaaS companies see ~0.4x payback on paid search at 12 months.","confidence":0.9,"tags":["benchmark","paid-search"]},
  {"label":"April Dunford","entity_type":"Person","description":"Author of Obviously Awesome; argues positioning precedes channel selection.","confidence":0.95,"tags":["author","positioning"]},
  {"label":"Obviously Awesome","entity_type":"Document","description":"April Dunford's book on product positioning; cited as authority for positioning-before-channels.","confidence":0.95,"tags":["book","positioning"]},
  {"label":"Positioning Before Channels","entity_type":"Concept","description":"Principle that positioning must be solved before investing in channel acquisition.","confidence":0.9,"tags":["gtm","positioning"]},
  {"label":"Abandon paid search until organic motion is repeatable","entity_type":"Takeaway","description":"Prescriptive advice for sub-$10M ARR B2B SaaS: stop paid search until a repeatable organic acquisition motion exists.","confidence":0.9,"tags":["gtm","advisory"]}
],"relationships":[
  {"source":"B2B SaaS Paid Search ROI (sub-$10M ARR)","target":"Abandon paid search until organic motion is repeatable","relation_type":"supports","evidence":"0.4x payback is the empirical basis for the prescription."},
  {"source":"April Dunford","target":"Obviously Awesome","relation_type":"created","evidence":"Dunford authored the book."},
  {"source":"Obviously Awesome","target":"Positioning Before Channels","relation_type":"supports","evidence":"The book is cited as the source of the principle."},
  {"source":"Positioning Before Channels","target":"Abandon paid search until organic motion is repeatable","relation_type":"supports","evidence":"Tactical takeaway follows from the broader principle."},
  {"source":"HubSpot","target":"B2B SaaS Paid Search ROI (sub-$10M ARR)","relation_type":"produced","evidence":"HubSpot's report is the source of the metric."}
]}
</examples>`);

  // User context (optional)
  if (config.userProfile) {
    const role      = config.userProfile.professional_context?.role;
    const projects  = config.userProfile.professional_context?.current_projects;
    const interests = config.userProfile.personal_interests?.topics;
    if (role || projects || interests) {
      let ctx = '<user_context>\nBias extraction toward entities and relationships this user is most likely to want to retrieve later. This is a hint, not a filter — do not skip entities that are not directly relevant.\n';
      if (role)      ctx += `- Role: ${role}\n`;
      if (projects)  ctx += `- Current projects: ${projects}\n`;
      if (interests) ctx += `- Interests: ${interests}\n`;
      ctx += '</user_context>';
      sections.push(ctx);
    }
  }

  // Anchor context (optional)
  if (config.anchors.length > 0) {
    let anchorCtx = `<anchor_context>\n${emphasisInstruction}\nWhen extracted entities plausibly relate to an anchor, add a relationship edge to the anchor by its exact label.\n`;
    for (const a of config.anchors.slice(0, 10)) {
      anchorCtx += `- ${a.label} (${a.entity_type}): ${a.description}\n`;
    }
    anchorCtx += '</anchor_context>';
    sections.push(anchorCtx);
  }

  // Custom instructions (optional)
  if (config.customInstructions) {
    sections.push(`<custom_instructions>\n${config.customInstructions}\n</custom_instructions>`);
  }

  sections.push(`<output_schema>
Return ONLY valid JSON. No preamble, no markdown fences, no commentary.
{
  "content_type_detected": "meeting" | "tutorial" | "essay" | "code" | "research" | "other",
  "language": "ISO-639-1 code, e.g. 'en'",
  "primary_topic": "one-line summary of what this content is about",
  "entities": [
    {
      "label": "string, canonical name, 1-80 chars",
      "entity_type": "exactly one of the 24 entity types",
      "description": "1-3 self-contained sentences, 40-400 chars",
      "confidence": 0.0-1.0,
      "tags": ["lowercase", "hyphenated", "max-6"],
      "aliases": ["optional alternate surface forms seen in content"],
      "salience": 0.0-1.0
    }
  ],
  "relationships": [
    {
      "source": "exact label of an entity above",
      "target": "exact label of an entity above",
      "relation_type": "exactly one of the 18 relationship types",
      "evidence": "quoted or paraphrased sentence, 20-300 chars",
      "confidence": 0.0-1.0
    }
  ]
}
</output_schema>`);

  sections.push(`<final_instructions>
1. Read the full content before extracting.
2. Identify content_type_detected first — it determines priorities.
3. If instructional, extract the named framework/method FIRST and its
   sub-components as Concepts linked via \`part_of\`.
4. Then extract supporting people, organisations, products, metrics,
   documents, events, locations.
5. Then extract takeaways (as imperatives) and insights.
6. Build relationships — directional first, structural second, weak
   fallbacks last. Every entity needs ≥1 relationship.
7. Normalise names. Collapse duplicates.
8. Return ONLY the JSON. Any text outside the JSON is a failure.
</final_instructions>`);

  return sections.join('\n\n');
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
            // Lowered from 0.92/0.88 → 0.85/0.80 so transcript typos like
            // "Versel" vs "Vercel" or "Superbase" vs "Supabase" are caught
            // as dedup candidates instead of being skipped by the RPC filter.
            p_exact_threshold: 0.85,
            p_semantic_threshold: 0.80,
          });
          const best = (matches as Array<{
            match_id: string; match_label: string; match_type: string; similarity: number;
          }> | null)?.[0];
          if (!best) return;

          // Auto-merge threshold lowered from 0.95 → 0.88 so high-confidence
          // fuzzy matches (typos, case variants, hyphenation differences)
          // merge automatically instead of waiting for human review.
          if (best.match_type === 'exact' ||
              (best.match_type === 'fuzzy' && best.similarity >= 0.88)) {
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

    let crossData: { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    try {
      const { json } = await geminiFetch(
        `${GEMINI_MODEL}:generateContent`,
        {
          contents: [{ parts: [{ text: crossPrompt }] }],
          generationConfig: { temperature: 0.1, responseMimeType: 'application/json' },
        },
        30_000,
        'pipeline:cross-connections'
      );
      crossData = json as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    } catch {
      return 0;
    }
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
