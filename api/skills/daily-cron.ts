/**
 * api/skills/daily-cron.ts
 *
 * Daily cron — backfills missed sources, aggregates usage stats, re-scores skills,
 * manages lifecycle, generates/evolves content, computes related skills.
 * CRITICAL: Fully self-contained. No local imports.
 *
 * PRD-Skills-D — Daily Skill Cron & Usage Tracking
 * Cron: 0 3 * * * (daily at 03:00 UTC)
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export const maxDuration = 60;

// ─── ENVIRONMENT ──────────────────────────────────────────────────────────────

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY!;

if (!GEMINI_API_KEY) {
  throw new Error('[gemini] Missing env var: GEMINI_API_KEY')
}
const CRON_SECRET = process.env.CRON_SECRET;
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

const GEMINI_MODEL = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash'
const GEMINI_EMBEDDING_MODEL = 'gemini-embedding-001'
// ─── HELPERS ──────────────────────────────────────────────────────────────────


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

function getSupabase(): SupabaseClient {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
}

function verifyCronAuth(req: VercelRequest): boolean {
  if (req.headers['x-vercel-signature']) return true;
  if (!CRON_SECRET) return true;
  const auth = req.headers['authorization'];
  return !!(auth && auth === `Bearer ${CRON_SECRET}`);
}

function parseJSON<T>(text: string): T {
  // Strip markdown code fences if present
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  return JSON.parse(cleaned) as T;
}

function parseEmbedding(raw: unknown): number[] {
  if (Array.isArray(raw)) return raw as number[];
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed as number[];
    } catch { /* ignore */ }
  }
  return [];
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0;
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    magA += a[i]! * a[i]!;
    magB += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

// ─── Gemini fetch + helpers (retry on 429/5xx, token-usage logging) ─────────

interface GeminiUsage {
  promptTokenCount?: number
  candidatesTokenCount?: number
  totalTokenCount?: number
}

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

async function callGemini<T>(
  systemPrompt: string,
  userContent: string,
  temperature = 0.1,
  model = GEMINI_MODEL
): Promise<T> {
  const { json } = await geminiFetch(
    `${model}:generateContent`,
    {
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents: [{ parts: [{ text: userContent }] }],
      generationConfig: { temperature, responseMimeType: 'application/json' },
    },
    30000,
    'skills:daily-cron'
  );
  const data = json as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Gemini returned empty response');
  return parseJSON<T>(text);
}

async function embedText(text: string, timeoutMs = 30000, stage = 'skills:daily-cron:embed'): Promise<number[]> {
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

async function generateEmbedding(text: string): Promise<number[]> {
  try {
    return await embedText(text, 15000);
  } catch (err) {
    console.warn('[daily-cron] embedding failed:', err instanceof Error ? err.message : err);
    return [];
  }
}

// ─── BFS helper ───────────────────────────────────────────────────────────────

async function bfsToAnchor(
  supabase: SupabaseClient,
  startNodeId: string,
  userId: string,
  maxHops = 4
): Promise<number> {
  const visited = new Set<string>([startNodeId]);
  let frontier = [startNodeId];

  for (let hop = 1; hop <= maxHops; hop++) {
    if (frontier.length === 0) break;

    const { data: edges } = await supabase
      .from('knowledge_edges')
      .select('source_node_id, target_node_id')
      .eq('user_id', userId)
      .or(
        frontier.map(id => `source_node_id.eq.${id},target_node_id.eq.${id}`).join(',')
      )
      .limit(200);

    const nextIds = new Set<string>();
    for (const edge of (edges ?? []) as Array<{ source_node_id: string; target_node_id: string }>) {
      const neighbor = frontier.includes(edge.source_node_id) ? edge.target_node_id : edge.source_node_id;
      if (!visited.has(neighbor)) {
        nextIds.add(neighbor);
        visited.add(neighbor);
      }
    }

    if (nextIds.size === 0) break;

    // Check if any of these neighbors are anchors
    const { data: anchorCheck } = await supabase
      .from('knowledge_nodes')
      .select('id')
      .eq('user_id', userId)
      .eq('is_anchor', true)
      .in('id', Array.from(nextIds))
      .limit(1);

    if (anchorCheck && anchorCheck.length > 0) return hop;

    frontier = Array.from(nextIds);
  }

  return maxHops + 1; // Not reachable
}

// ─── CONSTANTS ────────────────────────────────────────────────────────────────

const MAX_CONTENT_CHARS = 30_000;
const MIN_CONTENT_LENGTH = 500;
const MAX_BACKFILL_PER_USER = 10;

const SKILL_ELIGIBLE_TYPES = new Set([
  'Topic', 'Concept', 'Technology', 'Project', 'Product',
  'Insight', 'Lesson', 'Takeaway', 'Decision', 'Idea',
  'Goal', 'Action', 'Hypothesis', 'Question',
]);

// Signal weights with usage (7 signals)
const SIGNAL_WEIGHTS_WITH_USAGE = {
  anchorAlignment: 0.22, nodeDensity: 0.18, sourceHistory: 0.17,
  graphProximity: 0.13, profileContext: 0.10, velocity: 0.08, usage: 0.12,
};

// Signal weights without usage (6 signals — original)
const SIGNAL_WEIGHTS_WITHOUT_USAGE = {
  anchorAlignment: 0.25, nodeDensity: 0.20, sourceHistory: 0.20,
  graphProximity: 0.15, profileContext: 0.10, velocity: 0.10,
};

// ─── TYPES ────────────────────────────────────────────────────────────────────

interface SkillRow {
  id: string;
  user_id: string;
  name: string;
  title: string;
  description: string;
  domain: string | null;
  tags: string[];
  content: string;
  source_ids: string[];
  source_count: number;
  confidence: number;
  status: string;
  embedding: unknown;
  evidence_count: number;
  last_reinforced_at: string | null;
  exposure_level: string;
  signal_breakdown: Record<string, unknown>;
  last_scored_at: string | null;
  when_to_apply: string | null;
  how_to_apply: string | null;
  related_skill_ids: string[];
  related_anchor_ids: string[];
  created_at: string;
  updated_at: string;
}

interface UsageStats {
  total_retrievals: number;
  retrievals_7d: number;
  retrievals_30d: number;
  unique_sessions: number;
  avg_rank: number | null;
  citation_rate: number;
  top_queries: string[];
  last_used_at: string | null;
}

interface PhaseResult {
  sources_backfilled: number;
  skills_created: number;
  skills_reinforced: number;
  usage_stats_refreshed: number;
  skills_rescored: number;
  lifecycle: {
    promoted_to_confirmed: number;
    transitioned_dormant: number;
    resurrected_from_dormant: number;
    archived: number;
    candidates_dismissed: number;
  };
  content: {
    initial_generated: number;
    evolved_from_usage: number;
  };
  related_computed: number;
}

// ─── PHASE 1: Backfill Unprocessed Sources ────────────────────────────────────

async function phase1Backfill(
  supabase: SupabaseClient,
  userId: string,
  result: PhaseResult,
  startTime: number
): Promise<void> {
  // Find sources from last 48h that have nodes but no skill evaluation
  const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

  const { data: sources } = await supabase
    .from('knowledge_sources')
    .select('id, user_id, title, content, source_type, source_url, metadata, created_at')
    .eq('user_id', userId)
    .gte('created_at', cutoff)
    .not('content', 'is', null)
    .order('created_at', { ascending: false })
    .limit(MAX_BACKFILL_PER_USER * 3); // Fetch extra for filtering

  if (!sources || sources.length === 0) return;

  // Filter to sources not yet evaluated, or marked for retry (chunks weren't ready)
  const candidateSources = sources.filter(s => {
    const meta = (s.metadata ?? {}) as Record<string, unknown>;
    return !meta.skill_backfill_status || meta.skill_backfill_status === 'pending_retry';
  });

  // Check which sources already appear in any skill's source_ids
  const { data: skills } = await supabase
    .from('knowledge_skills')
    .select('source_ids')
    .eq('user_id', userId);

  const evaluatedSourceIds = new Set<string>();
  for (const skill of (skills ?? []) as Array<{ source_ids: string[] }>) {
    for (const sid of (skill.source_ids ?? [])) {
      evaluatedSourceIds.add(sid);
    }
  }

  const unprocessed = candidateSources
    .filter(s => !evaluatedSourceIds.has(s.id))
    .slice(0, MAX_BACKFILL_PER_USER);

  if (unprocessed.length === 0) return;

  // Fetch anchors for assessment
  const { data: anchorNodes } = await supabase
    .from('knowledge_nodes')
    .select('label, entity_type, description')
    .eq('user_id', userId)
    .eq('is_anchor', true);

  const anchors = (anchorNodes ?? []) as Array<{ label: string; entity_type: string; description: string | null }>;

  // Fetch existing skills for dedup
  const { data: existingSkillsData } = await supabase
    .from('knowledge_skills')
    .select('id, name, title, description, domain, source_ids, source_count, content')
    .eq('user_id', userId)
    .in('status', ['draft', 'active']);

  const existingSkills = (existingSkillsData ?? []) as Array<{
    id: string; name: string; title: string; description: string;
    domain: string | null; source_ids: string[]; source_count: number; content: string;
  }>;

  for (const source of unprocessed) {
    // Time check — leave 15s buffer
    if (Date.now() - startTime > 45_000) break;

    try {
      if (!source.content || (source.content as string).length < MIN_CONTENT_LENGTH) {
        // Mark as skipped
        await markSourceEvaluated(supabase, source.id, source.metadata as Record<string, unknown> | null, 'skipped_no_content');
        continue;
      }

      // Check source has extracted nodes
      const { count: nodeCount } = await supabase
        .from('knowledge_nodes')
        .select('id', { count: 'exact', head: true })
        .eq('source_id', source.id);

      if (!nodeCount || nodeCount === 0) {
        await markSourceEvaluated(supabase, source.id, source.metadata as Record<string, unknown> | null, 'skipped_no_nodes');
        continue;
      }

      // Fetch entities
      const { data: entities } = await supabase
        .from('knowledge_nodes')
        .select('label, entity_type, description')
        .eq('source_id', source.id)
        .order('entity_type')
        .limit(50);

      const entityList = (entities ?? []) as Array<{ label: string; entity_type: string; description: string | null }>;

      // Assess source
      const assessment = await assessSourceForSkills(
        source.content as string, entityList, anchors
      );

      const skillReadiness = computeSkillReadiness(assessment);
      const threshold = assessment.anchorRelevance < 0.5 ? 0.65 : 0.55;

      if (skillReadiness < threshold) {
        await markSourceEvaluated(supabase, source.id, source.metadata as Record<string, unknown> | null, 'below_threshold');
        continue;
      }

      // Dedup check
      const dedup = await checkDedup(assessment, existingSkills);

      if (dedup.action === 'SKIP') {
        // Link source to existing skill
        if (dedup.targetSkillName) {
          const target = existingSkills.find(s => s.name === dedup.targetSkillName);
          if (target && !target.source_ids.includes(source.id)) {
            await supabase
              .from('knowledge_skills')
              .update({
                source_ids: [...target.source_ids, source.id],
                source_count: target.source_count + 1,
                evidence_count: (target as unknown as SkillRow).evidence_count
                  ? ((target as unknown as SkillRow).evidence_count + 1)
                  : 2,
              })
              .eq('id', target.id);
            target.source_ids = [...target.source_ids, source.id];
            target.source_count++;
            result.skills_reinforced++;
          }
        }
        await markSourceEvaluated(supabase, source.id, source.metadata as Record<string, unknown> | null, 'duplicate');
        continue;
      }

      if (dedup.action === 'CREATE') {
        // Generate skill content via Gemini
        const gen = await generateSkillContent(
          source.content as string, entityList, assessment, skillReadiness,
          source.title as string, source.id
        );

        const { error: insertError } = await supabase
          .from('knowledge_skills')
          .insert({
            user_id: userId,
            name: assessment.proposedSkillTitle,
            title: assessment.proposedSkillTitleHuman,
            description: gen.description,
            domain: assessment.proposedDomain,
            tags: gen.tags,
            content: gen.content,
            source_ids: [source.id],
            source_count: 1,
            confidence: skillReadiness,
            instructional_ratio: assessment.instructionalRatio,
            generalizability: assessment.generalizability,
            structural_density: assessment.structuralDensity,
            status: 'draft',
            evidence_count: 1,
          });

        if (insertError) {
          if (insertError.code === '23505') {
            // Unique constraint — try with suffix
            const suffixed = `${assessment.proposedSkillTitle}-${Date.now().toString(36).slice(-4)}`;
            await supabase.from('knowledge_skills').insert({
              user_id: userId,
              name: suffixed,
              title: assessment.proposedSkillTitleHuman,
              description: gen.description,
              domain: assessment.proposedDomain,
              tags: gen.tags,
              content: gen.content,
              source_ids: [source.id],
              source_count: 1,
              confidence: skillReadiness,
              instructional_ratio: assessment.instructionalRatio,
              generalizability: assessment.generalizability,
              structural_density: assessment.structuralDensity,
              status: 'draft',
              evidence_count: 1,
            });
          } else {
            throw insertError;
          }
        }

        // Generate embedding
        const embedding = await generateEmbedding(gen.description);
        if (embedding.length > 0) {
          await supabase
            .from('knowledge_skills')
            .update({ embedding })
            .eq('name', assessment.proposedSkillTitle)
            .eq('user_id', userId);
        }

        result.skills_created++;
      } else if (dedup.action === 'UPDATE') {
        const target = existingSkills.find(s => s.name === dedup.targetSkillName);
        if (target) {
          await supabase
            .from('knowledge_skills')
            .update({
              source_ids: [...target.source_ids, source.id],
              source_count: target.source_count + 1,
              evidence_count: ((target as unknown as SkillRow).evidence_count ?? 1) + 1,
              last_reinforced_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            })
            .eq('id', target.id);
          target.source_ids = [...target.source_ids, source.id];
          target.source_count++;
          result.skills_reinforced++;
        }
      }

      await markSourceEvaluated(supabase, source.id, source.metadata as Record<string, unknown> | null, 'processed');
      result.sources_backfilled++;

      // Rate limit
      await new Promise(r => setTimeout(r, 500));
    } catch (err) {
      console.warn('[daily-cron] backfill error for source', source.id, err instanceof Error ? err.message : err);
      await markSourceEvaluated(supabase, source.id, source.metadata as Record<string, unknown> | null, 'error').catch(() => {});
    }
  }
}

async function markSourceEvaluated(
  supabase: SupabaseClient,
  sourceId: string,
  existingMetadata: Record<string, unknown> | null,
  status: string
): Promise<void> {
  const updated = {
    ...(existingMetadata ?? {}),
    skill_backfill_status: status,
    skill_backfill_at: new Date().toISOString(),
  };
  await supabase.from('knowledge_sources').update({ metadata: updated }).eq('id', sourceId);
}

// ─── Assessment helpers (duplicated from backfill.ts) ─────────────────────────

interface AssessmentResult {
  generalizability: number;
  structuralDensity: number;
  instructionalRatio: number;
  anchorRelevance: number;
  anchorMatches: string[];
  proposedSkillTitle: string;
  proposedSkillTitleHuman: string;
  proposedDomain: string;
  extractableMethodology: string;
  transferableMethods: string[];
  contextDependencies: string[];
}

function computeSkillReadiness(assessment: AssessmentResult): number {
  if (assessment.instructionalRatio < 0.5 || assessment.structuralDensity < 0.5) return 0;
  return (
    assessment.instructionalRatio * 0.25 +
    assessment.generalizability * 0.25 +
    assessment.structuralDensity * 0.20 +
    assessment.anchorRelevance * 0.30
  );
}

async function assessSourceForSkills(
  content: string,
  entities: Array<{ label: string; entity_type: string; description: string | null }>,
  anchors: Array<{ label: string; entity_type: string; description: string | null }>
): Promise<AssessmentResult> {
  const entitySummary = entities
    .map(e => `${e.entity_type}: ${e.label}${e.description ? ` — ${e.description}` : ''}`)
    .join('\n');

  const anchorSummary = anchors
    .map(a => `- ${a.label} (${a.entity_type})${a.description ? `: ${a.description}` : ''}`)
    .join('\n');

  const systemPrompt = `You are a skill assessment engine. Evaluate whether this source contains extractable methodology relevant to the user's interests (anchors). Score on four dimensions (0.0-1.0): generalizability, structuralDensity, instructionalRatio, anchorRelevance. Also provide: anchorMatches, proposedSkillTitle (kebab-case), proposedSkillTitleHuman, proposedDomain, extractableMethodology, transferableMethods, contextDependencies. Return JSON.`;

  const userContent = `ANCHORS:\n${anchorSummary || '(none)'}\n\nCONTENT:\n${content.slice(0, MAX_CONTENT_CHARS)}\n\nENTITIES:\n${entitySummary || '(none)'}`;

  return callGemini<AssessmentResult>(systemPrompt, userContent, 0.1);
}

async function checkDedup(
  assessment: AssessmentResult,
  existingSkills: Array<{ name: string; title: string; description: string; domain: string | null; source_count: number; content: string }>
): Promise<{ action: 'CREATE' | 'UPDATE' | 'SKIP'; targetSkillName: string | null }> {
  if (existingSkills.length === 0) return { action: 'CREATE', targetSkillName: null };

  const existingList = existingSkills.slice(0, 30)
    .map(s => `- ${s.name}: "${s.title}" (domain: ${s.domain ?? 'general'}, sources: ${s.source_count}) — ${s.description.slice(0, 200)}`)
    .join('\n');

  const systemPrompt = `Compare a skill candidate against existing skills. Return JSON: { action: "CREATE"|"UPDATE"|"SKIP", targetSkillName: string|null, rationale: string }`;

  const userContent = `CANDIDATE: ${assessment.proposedSkillTitle} — ${assessment.extractableMethodology}\n\nEXISTING:\n${existingList}`;

  return callGemini<{ action: 'CREATE' | 'UPDATE' | 'SKIP'; targetSkillName: string | null }>(
    systemPrompt, userContent, 0.1
  );
}

async function generateSkillContent(
  content: string,
  entities: Array<{ label: string; entity_type: string; description: string | null }>,
  assessment: AssessmentResult,
  confidence: number,
  sourceTitle: string,
  sourceId: string
): Promise<{ description: string; content: string; tags: string[] }> {
  const entitySummary = entities
    .map(e => `${e.entity_type}: ${e.label}${e.description ? ` — ${e.description}` : ''}`)
    .join('\n');

  const systemPrompt = `Generate a Claude skill from a knowledge source. Return JSON with: description (2-3 sentences), content (structured SKILL.md with sections: Prerequisites, Methodology, Output Format, Limitations, Examples), tags (4-6 keywords array).`;

  const userContent = `SOURCE: ${sourceTitle}\nDomain: ${assessment.proposedDomain}\nMethodology: ${assessment.extractableMethodology}\nMethods: ${assessment.transferableMethods.join(', ')}\n\nCONTENT:\n${content.slice(0, MAX_CONTENT_CHARS)}\n\nENTITIES:\n${entitySummary || '(none)'}`;

  return callGemini<{ description: string; content: string; tags: string[] }>(
    systemPrompt, userContent, 0.2, GEMINI_MODEL
  );
}

// ─── PHASE 2: Aggregate Usage Stats ───────────────────────────────────────────

async function phase2AggregateUsage(
  supabase: SupabaseClient,
  userId: string,
  result: PhaseResult
): Promise<Map<string, UsageStats>> {
  const usageMap = new Map<string, UsageStats>();

  // Fetch all usage logs for this user
  const { data: logs } = await supabase
    .from('skill_usage_log')
    .select('skill_id, session_id, retrieval_rank, was_cited, query_text, created_at')
    .eq('user_id', userId);

  if (!logs || logs.length === 0) return usageMap;

  const now = Date.now();
  const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;
  const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;

  // Group by skill_id
  const grouped = new Map<string, Array<{
    session_id: string | null; retrieval_rank: number | null;
    was_cited: boolean; query_text: string | null; created_at: string;
  }>>();

  for (const log of logs as Array<{
    skill_id: string; session_id: string | null; retrieval_rank: number | null;
    was_cited: boolean; query_text: string | null; created_at: string;
  }>) {
    const existing = grouped.get(log.skill_id) ?? [];
    existing.push(log);
    grouped.set(log.skill_id, existing);
  }

  for (const [skillId, entries] of grouped) {
    const total = entries.length;
    const r7d = entries.filter(e => new Date(e.created_at).getTime() > sevenDaysAgo).length;
    const r30d = entries.filter(e => new Date(e.created_at).getTime() > thirtyDaysAgo).length;
    const sessions = new Set(entries.filter(e => e.session_id).map(e => e.session_id));
    const ranks = entries.filter(e => e.retrieval_rank != null).map(e => e.retrieval_rank!);
    const avgRank = ranks.length > 0 ? ranks.reduce((a, b) => a + b, 0) / ranks.length : null;
    const cited = entries.filter(e => e.was_cited).length;
    const citationRate = total > 0 ? cited / total : 0;

    // Top queries
    const queryCounts = new Map<string, number>();
    for (const e of entries) {
      if (e.query_text) {
        queryCounts.set(e.query_text, (queryCounts.get(e.query_text) ?? 0) + 1);
      }
    }
    const topQueries = Array.from(queryCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([q]) => q);

    const lastUsed = entries.length > 0
      ? entries.reduce((max, e) => e.created_at > max ? e.created_at : max, entries[0]!.created_at)
      : null;

    const stats: UsageStats = {
      total_retrievals: total,
      retrievals_7d: r7d,
      retrievals_30d: r30d,
      unique_sessions: sessions.size,
      avg_rank: avgRank,
      citation_rate: +citationRate.toFixed(3),
      top_queries: topQueries,
      last_used_at: lastUsed,
    };

    usageMap.set(skillId, stats);

    // Upsert into skill_usage_stats
    await supabase
      .from('skill_usage_stats')
      .upsert({
        user_id: userId,
        skill_id: skillId,
        total_retrievals: total,
        retrievals_7d: r7d,
        retrievals_30d: r30d,
        unique_sessions: sessions.size,
        avg_rank: avgRank,
        citation_rate: +citationRate.toFixed(3),
        top_queries: topQueries,
        last_used_at: lastUsed,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id,skill_id' });

    result.usage_stats_refreshed++;
  }

  // Clean up old logs (>90 days)
  const ninetyDaysAgo = new Date(now - 90 * 24 * 60 * 60 * 1000).toISOString();
  await supabase
    .from('skill_usage_log')
    .delete()
    .eq('user_id', userId)
    .lt('created_at', ninetyDaysAgo);

  return usageMap;
}

// ─── PHASE 3: Re-Score Skills ─────────────────────────────────────────────────

function computeUsageSignal(stats: UsageStats | undefined): number {
  if (!stats || stats.total_retrievals === 0) return 0;

  const frequency = Math.min(stats.retrievals_30d / 20, 1);
  const recency = stats.retrievals_7d > 0 ? 0.8 : (stats.retrievals_30d > 0 ? 0.4 : 0);
  const diversity = Math.min(stats.unique_sessions / 10, 1);
  const citation = stats.citation_rate;
  const rankQuality = stats.avg_rank ? Math.max(0, 1 - (stats.avg_rank - 1) / 10) : 0.5;

  return +(
    frequency * 0.30 +
    recency * 0.25 +
    diversity * 0.20 +
    citation * 0.15 +
    rankQuality * 0.10
  ).toFixed(3);
}

async function phase3Rescore(
  supabase: SupabaseClient,
  userId: string,
  skills: SkillRow[],
  usageMap: Map<string, UsageStats>,
  result: PhaseResult
): Promise<void> {
  // Fetch anchors with embeddings
  const { data: anchorNodes } = await supabase
    .from('knowledge_nodes')
    .select('id, label, entity_type, description, embedding')
    .eq('user_id', userId)
    .eq('is_anchor', true);

  const anchors = (anchorNodes ?? []) as Array<{
    id: string; label: string; entity_type: string; description: string | null; embedding: unknown;
  }>;

  // Fetch user profile for S5
  const { data: profile } = await supabase
    .from('user_profiles')
    .select('professional_context, personal_interests')
    .eq('user_id', userId)
    .maybeSingle();

  const profileKeywords: string[] = [];
  if (profile) {
    const prof = profile as { professional_context?: Record<string, unknown>; personal_interests?: Record<string, unknown> };
    if (prof.professional_context?.role) profileKeywords.push(String(prof.professional_context.role));
    if (prof.professional_context?.current_projects) profileKeywords.push(String(prof.professional_context.current_projects));
    if (prof.personal_interests?.topics) profileKeywords.push(String(prof.personal_interests.topics));
  }
  const profileText = profileKeywords.join(' ').toLowerCase();

  const now = Date.now();
  const fourteenDaysAgo = now - 14 * 24 * 60 * 60 * 1000;

  for (const skill of skills) {
    if (skill.status === 'archived') continue;

    try {
      const skillEmb = parseEmbedding(skill.embedding);

      // S1: Anchor Alignment
      let s1 = 0;
      if (skillEmb.length > 0 && anchors.length > 0) {
        for (const anchor of anchors) {
          const anchorEmb = parseEmbedding(anchor.embedding);
          if (anchorEmb.length > 0) {
            const sim = cosineSimilarity(skillEmb, anchorEmb);
            if (sim > s1) s1 = sim;
          }
        }
      }

      // S2: Node Density — count nodes matching skill keywords
      const skillKeywords = skill.title.toLowerCase().split(/\s+/).filter(w => w.length > 3);
      let s2 = 0;
      if (skillKeywords.length > 0) {
        const pattern = `%(${skillKeywords.slice(0, 3).join('|')})%`;
        const { count } = await supabase
          .from('knowledge_nodes')
          .select('id', { count: 'exact', head: true })
          .eq('user_id', userId)
          .ilike('label', pattern)
          .limit(100);
        s2 = Math.min((count ?? 0) / 20, 1);
      }

      // S3: Source History — distinct sources mentioning this skill
      const s3 = Math.min(skill.source_count / 5, 1);

      // S4: Graph Proximity — BFS to nearest anchor
      let s4 = 0.5;
      if (skill.source_ids.length > 0) {
        // Find a node from this skill's first source
        const { data: nodeFromSource } = await supabase
          .from('knowledge_nodes')
          .select('id')
          .eq('source_id', skill.source_ids[0])
          .eq('user_id', userId)
          .limit(1);

        if (nodeFromSource && nodeFromSource.length > 0) {
          const hops = await bfsToAnchor(supabase, (nodeFromSource[0] as { id: string }).id, userId);
          s4 = Math.max(0, 1 - (hops - 1) / 4); // 1 hop = 1.0, 4+ hops = 0
        }
      }

      // S5: Profile Context
      const skillText = `${skill.title} ${skill.description} ${(skill.tags ?? []).join(' ')}`.toLowerCase();
      const profileWords = profileText.split(/\s+/).filter(w => w.length > 3);
      const matchCount = profileWords.filter(w => skillText.includes(w)).length;
      const s5 = profileWords.length > 0 ? Math.min(matchCount / Math.min(profileWords.length, 5), 1) : 0.5;

      // S6: Velocity — recent source activity (14-day window)
      let s6 = 0;
      for (const sid of skill.source_ids) {
        const { data: src } = await supabase
          .from('knowledge_sources')
          .select('created_at')
          .eq('id', sid)
          .maybeSingle();
        if (src && new Date((src as { created_at: string }).created_at).getTime() > fourteenDaysAgo) {
          s6 += 0.25;
        }
      }
      s6 = Math.min(s6, 1);

      // S7: Usage
      const usageStats = usageMap.get(skill.id);
      const s7 = computeUsageSignal(usageStats);
      const hasUsage = usageStats != null && usageStats.total_retrievals > 0;

      // Compute weighted score
      let score: number;
      const breakdown: Record<string, unknown> = {
        anchorAlignment: +s1.toFixed(3),
        nodeDensity: +s2.toFixed(3),
        sourceHistory: +s3.toFixed(3),
        graphProximity: +s4.toFixed(3),
        profileContext: +s5.toFixed(3),
        velocity: +s6.toFixed(3),
      };

      if (hasUsage) {
        const w = SIGNAL_WEIGHTS_WITH_USAGE;
        score = s1 * w.anchorAlignment + s2 * w.nodeDensity + s3 * w.sourceHistory +
                s4 * w.graphProximity + s5 * w.profileContext + s6 * w.velocity + s7 * w.usage;
        breakdown.usage = +s7.toFixed(3);
        breakdown.usage_detail = {
          frequency: +Math.min(usageStats!.retrievals_30d / 20, 1).toFixed(3),
          recency: +(usageStats!.retrievals_7d > 0 ? 0.8 : (usageStats!.retrievals_30d > 0 ? 0.4 : 0)).toFixed(3),
          diversity: +Math.min(usageStats!.unique_sessions / 10, 1).toFixed(3),
          citation: +usageStats!.citation_rate.toFixed(3),
          rankQuality: +(usageStats!.avg_rank ? Math.max(0, 1 - (usageStats!.avg_rank - 1) / 10) : 0.5).toFixed(3),
        };
      } else {
        const w = SIGNAL_WEIGHTS_WITHOUT_USAGE;
        score = s1 * w.anchorAlignment + s2 * w.nodeDensity + s3 * w.sourceHistory +
                s4 * w.graphProximity + s5 * w.profileContext + s6 * w.velocity;
      }

      score = +score.toFixed(3);

      // Skip if delta < 0.05
      if (Math.abs(score - skill.confidence) < 0.05) continue;

      // Update skill
      const updateFields: Record<string, unknown> = {
        confidence: score,
        signal_breakdown: breakdown,
        last_scored_at: new Date().toISOString(),
      };

      // Score drops below 0.40 → demote confirmed to candidate
      if (score < 0.40 && skill.status === 'confirmed') {
        updateFields.status = 'candidate';
      }

      await supabase.from('knowledge_skills').update(updateFields).eq('id', skill.id);
      // Update local state
      skill.confidence = score;
      skill.signal_breakdown = breakdown;
      result.skills_rescored++;
    } catch (err) {
      console.warn('[daily-cron] rescore error for skill', skill.id, err instanceof Error ? err.message : err);
    }
  }
}

// ─── PHASE 4: Lifecycle Management ────────────────────────────────────────────

async function phase4Lifecycle(
  supabase: SupabaseClient,
  _userId: string,
  skills: SkillRow[],
  usageMap: Map<string, UsageStats>,
  result: PhaseResult
): Promise<void> {
  const now = new Date();
  const nowMs = now.getTime();

  for (const skill of skills) {
    const usage = usageMap.get(skill.id);
    const totalRetrievals = usage?.total_retrievals ?? 0;
    const retrievals7d = usage?.retrievals_7d ?? 0;
    const retrievals30d = usage?.retrievals_30d ?? 0;
    const citationRate = usage?.citation_rate ?? 0;
    const lastReinforced = skill.last_reinforced_at ? new Date(skill.last_reinforced_at).getTime() : 0;
    const createdAt = new Date(skill.created_at).getTime();
    const daysSinceReinforced = lastReinforced > 0 ? (nowMs - lastReinforced) / (24 * 60 * 60 * 1000) : 999;
    const daysSinceCreated = (nowMs - createdAt) / (24 * 60 * 60 * 1000);

    const updateFields: Record<string, unknown> = {};
    let transition: string | null = null;

    // Usage-based confidence boost (confirmed skills only)
    if (retrievals7d > 0 && skill.status === 'confirmed') {
      const usageBoost = Math.min(retrievals7d * 0.005, 0.03);
      const citationBoost = citationRate > 0.5 ? 0.01 : 0;
      const newConfidence = Math.min(skill.confidence + usageBoost + citationBoost, 0.95);
      if (newConfidence > skill.confidence) {
        updateFields.confidence = +newConfidence.toFixed(3);
        skill.confidence = +newConfidence.toFixed(3);
      }
      if (retrievals7d >= 3) {
        updateFields.last_reinforced_at = now.toISOString();
      }
    }

    // Exposure level upgrades from usage
    if (usage) {
      let newExposure = skill.exposure_level;
      if (skill.exposure_level === 'novice' && totalRetrievals >= 5 && citationRate > 0.2) {
        newExposure = 'developing';
      } else if (skill.exposure_level === 'developing' && totalRetrievals >= 15 && usage.unique_sessions >= 5 && citationRate > 0.3) {
        newExposure = 'proficient';
      } else if (skill.exposure_level === 'proficient' && totalRetrievals >= 40 && usage.unique_sessions >= 15 && citationRate > 0.4) {
        newExposure = 'advanced';
      }
      if (newExposure !== skill.exposure_level) {
        updateFields.exposure_level = newExposure;
        skill.exposure_level = newExposure;
      }
    }

    // Lifecycle transitions
    if (skill.status === 'candidate') {
      // candidate → confirmed
      if (
        skill.confidence >= 0.55 &&
        (skill.evidence_count ?? 1) >= 2 &&
        (daysSinceReinforced < 30 || retrievals7d > 0)
      ) {
        updateFields.status = 'confirmed';
        skill.status = 'confirmed';
        transition = 'promoted_to_confirmed';
      }
      // candidate auto-dismiss
      else if (
        daysSinceCreated > 45 &&
        (skill.evidence_count ?? 1) === 1 &&
        skill.confidence < 0.40 &&
        totalRetrievals === 0
      ) {
        updateFields.status = 'archived';
        skill.status = 'archived';
        transition = 'candidates_dismissed';
      }
    } else if (skill.status === 'confirmed') {
      // confirmed → dormant
      if (
        daysSinceReinforced > 60 &&
        retrievals30d === 0 &&
        skill.confidence < 0.70
      ) {
        updateFields.status = 'dormant';
        skill.status = 'dormant';
        transition = 'transitioned_dormant';
      }
    } else if (skill.status === 'dormant') {
      // dormant → confirmed (resurrection via usage)
      if (
        retrievals7d >= 3 ||
        (retrievals30d >= 5 && citationRate > 0.3)
      ) {
        updateFields.status = 'confirmed';
        skill.status = 'confirmed';
        transition = 'resurrected_from_dormant';
      }
      // dormant → archived
      else if (daysSinceReinforced > 90 && retrievals30d === 0) {
        updateFields.status = 'archived';
        skill.status = 'archived';
        transition = 'archived';
      }
    }

    // Apply updates
    if (Object.keys(updateFields).length > 0) {
      await supabase.from('knowledge_skills').update(updateFields).eq('id', skill.id);

      if (transition) {
        (result.lifecycle as Record<string, number>)[transition] =
          ((result.lifecycle as Record<string, number>)[transition] ?? 0) + 1;
      }
    }
  }
}

// ─── PHASE 5: Content Generation & Evolution ──────────────────────────────────

async function phase5Content(
  supabase: SupabaseClient,
  userId: string,
  skills: SkillRow[],
  usageMap: Map<string, UsageStats>,
  result: PhaseResult,
  startTime: number
): Promise<void> {
  // 5a: Initial generation for confirmed skills missing when_to_apply
  const needsInitial = skills.filter(
    s => s.status === 'confirmed' && (!s.when_to_apply || s.when_to_apply.trim() === '')
  );

  // Batch 10 at a time
  for (let i = 0; i < needsInitial.length; i += 10) {
    if (Date.now() - startTime > 50_000) break; // Time budget

    const batch = needsInitial.slice(i, i + 10);
    const payload = batch.map(s => ({
      label: s.title,
      description: s.description,
      domain: s.domain ?? 'general',
      tags: s.tags,
    }));

    try {
      const generated = await callGemini<Array<{ label: string; when_to_apply: string; how_to_apply: string }>>(
        CONTENT_GEN_SYSTEM_PROMPT,
        `Generate when_to_apply and how_to_apply descriptions for these skills:\n\n${JSON.stringify(payload, null, 2)}\n\nReturn:\n[{"label":"string","when_to_apply":"2-3 sentences","how_to_apply":"2-3 sentences"}]`,
        0.3
      );

      for (const gen of (generated ?? [])) {
        const skill = batch.find(s => s.title === gen.label);
        if (skill && gen.when_to_apply && gen.how_to_apply) {
          await supabase
            .from('knowledge_skills')
            .update({
              when_to_apply: gen.when_to_apply,
              how_to_apply: gen.how_to_apply,
            })
            .eq('id', skill.id);
          skill.when_to_apply = gen.when_to_apply;
          skill.how_to_apply = gen.how_to_apply;
          result.content.initial_generated++;
        }
      }
    } catch (err) {
      console.warn('[daily-cron] content gen error:', err instanceof Error ? err.message : err);
    }

    await new Promise(r => setTimeout(r, 500));
  }

  // 5b: Usage-driven content evolution
  const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();

  const needsEvolution = skills.filter(s => {
    if (s.status !== 'confirmed') return false;
    const usage = usageMap.get(s.id);
    if (!usage || usage.retrievals_30d < 5) return false;
    // Content is stale or has poor citation rate
    const lastScored = s.last_scored_at ? s.last_scored_at : s.created_at;
    const isStale = lastScored < fourteenDaysAgo;
    const poorCitation = usage.citation_rate < 0.2;
    return isStale || poorCitation;
  });

  for (let i = 0; i < needsEvolution.length; i += 10) {
    if (Date.now() - startTime > 52_000) break;

    const batch = needsEvolution.slice(i, i + 10);

    // Fetch contributing source titles
    const sourceIds = batch.flatMap(s => s.source_ids).slice(0, 30);
    const { data: sourcesData } = await supabase
      .from('knowledge_sources')
      .select('id, title')
      .in('id', sourceIds);
    const sourceMap = new Map((sourcesData ?? []).map(s => [(s as { id: string; title: string }).id, (s as { id: string; title: string }).title]));

    const payload = batch.map(s => {
      const usage = usageMap.get(s.id)!;
      return {
        label: s.title,
        current_when_to_apply: s.when_to_apply,
        current_how_to_apply: s.how_to_apply,
        top_queries: usage.top_queries,
        usage_count_30d: usage.retrievals_30d,
        citation_rate: usage.citation_rate,
        contributing_sources: s.source_ids.map(sid => sourceMap.get(sid) ?? 'Unknown').slice(0, 5),
      };
    });

    try {
      const evolved = await callGemini<Array<{ label: string; when_to_apply: string; how_to_apply: string }>>(
        CONTENT_EVOLUTION_SYSTEM_PROMPT,
        `Refine these skill descriptions based on their actual usage:\n\n${JSON.stringify(payload, null, 2)}\n\nReturn:\n[{"label":"string","when_to_apply":"refined 2-3 sentences","how_to_apply":"refined 2-3 sentences"}]`,
        0.3
      );

      for (const gen of (evolved ?? [])) {
        const skill = batch.find(s => s.title === gen.label);
        if (skill && gen.when_to_apply && gen.how_to_apply) {
          await supabase
            .from('knowledge_skills')
            .update({
              when_to_apply: gen.when_to_apply,
              how_to_apply: gen.how_to_apply,
            })
            .eq('id', skill.id);
          result.content.evolved_from_usage++;
        }
      }
    } catch (err) {
      console.warn('[daily-cron] content evolution error:', err instanceof Error ? err.message : err);
    }

    await new Promise(r => setTimeout(r, 500));
  }
}

const CONTENT_GEN_SYSTEM_PROMPT = `You are generating structured descriptions for skills in a personal knowledge graph. Each skill has been detected from real content the user has ingested. Be concise, specific, and practical. Write for an AI assistant that needs to know when and how to apply each skill on behalf of the user.

Respond ONLY with a JSON array. No preamble or markdown.`;

const CONTENT_EVOLUTION_SYSTEM_PROMPT = `You are refining skill descriptions based on actual usage patterns. The user's AI assistant has been retrieving these skills in specific contexts. Use the usage data to make the when_to_apply and how_to_apply descriptions more accurate and practical.

Keep existing content that is still accurate. Add new context from usage patterns. Remove generic advice that usage data contradicts.

Respond ONLY with a JSON array. No preamble or markdown.`;

// ─── PHASE 6: Related Skills ──────────────────────────────────────────────────

async function phase6RelatedSkills(
  supabase: SupabaseClient,
  _userId: string,
  skills: SkillRow[],
  result: PhaseResult
): Promise<void> {
  const activeSkills = skills.filter(s => s.status === 'confirmed' || s.status === 'active');
  if (activeSkills.length < 2) return;

  for (const skill of activeSkills) {
    const related: string[] = [];

    for (const other of activeSkills) {
      if (other.id === skill.id) continue;

      // Same domain
      if (skill.domain && other.domain && skill.domain === other.domain) {
        related.push(other.id);
        continue;
      }

      // Overlapping anchor IDs
      const skillAnchors = skill.related_anchor_ids ?? [];
      const otherAnchors = other.related_anchor_ids ?? [];
      const overlap = skillAnchors.filter(a => otherAnchors.includes(a));
      if (overlap.length > 0) {
        related.push(other.id);
        continue;
      }

      // Embedding similarity as fallback
      const aEmb = parseEmbedding(skill.embedding);
      const bEmb = parseEmbedding(other.embedding);
      if (aEmb.length > 0 && bEmb.length > 0) {
        const sim = cosineSimilarity(aEmb, bEmb);
        if (sim > 0.6) {
          related.push(other.id);
        }
      }
    }

    const capped = related.slice(0, 10);
    const existing = skill.related_skill_ids ?? [];
    const changed = capped.length !== existing.length || capped.some((id, i) => id !== existing[i]);

    if (changed) {
      await supabase
        .from('knowledge_skills')
        .update({ related_skill_ids: capped })
        .eq('id', skill.id);
      result.related_computed++;
    }
  }
}

// ─── MAIN HANDLER ─────────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!verifyCronAuth(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const startTime = Date.now();
  const supabase = getSupabase();

  // Get all users who have skills
  const { data: userRows } = await supabase
    .from('knowledge_skills')
    .select('user_id')
    .limit(500);

  const uniqueUserIds = [...new Set((userRows ?? []).map(r => (r as { user_id: string }).user_id))];

  const perUser: Array<Record<string, unknown>> = [];

  for (const userId of uniqueUserIds) {
    // Time budget per user
    if (Date.now() - startTime > 50_000) break;

    const userResult: PhaseResult = {
      sources_backfilled: 0,
      skills_created: 0,
      skills_reinforced: 0,
      usage_stats_refreshed: 0,
      skills_rescored: 0,
      lifecycle: {
        promoted_to_confirmed: 0,
        transitioned_dormant: 0,
        resurrected_from_dormant: 0,
        archived: 0,
        candidates_dismissed: 0,
      },
      content: {
        initial_generated: 0,
        evolved_from_usage: 0,
      },
      related_computed: 0,
    };

    try {
      // Fetch all non-archived skills for this user
      const { data: skillData } = await supabase
        .from('knowledge_skills')
        .select('*')
        .eq('user_id', userId)
        .neq('status', 'archived');

      const skills = (skillData ?? []) as SkillRow[];

      // Phase 1: Backfill
      await phase1Backfill(supabase, userId, userResult, startTime);

      // Phase 2: Aggregate usage
      const usageMap = await phase2AggregateUsage(supabase, userId, userResult);

      // Phase 3: Re-score
      await phase3Rescore(supabase, userId, skills, usageMap, userResult);

      // Phase 4: Lifecycle
      await phase4Lifecycle(supabase, userId, skills, usageMap, userResult);

      // Phase 5: Content
      await phase5Content(supabase, userId, skills, usageMap, userResult, startTime);

      // Phase 6: Related skills
      await phase6RelatedSkills(supabase, userId, skills, userResult);

      // Update scan state
      await supabase
        .from('knowledge_skills')
        .update({ last_scored_at: new Date().toISOString() })
        .eq('user_id', userId)
        .neq('status', 'archived');

    } catch (err) {
      console.error('[daily-cron] error for user', userId, err instanceof Error ? err.message : err);
    }

    perUser.push({ user_id: userId, ...userResult });
  }

  return res.status(200).json({
    users_processed: perUser.length,
    per_user: perUser,
    duration_ms: Date.now() - startTime,
  });
}
