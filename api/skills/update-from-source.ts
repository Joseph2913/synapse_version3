/**
 * api/skills/update-from-source.ts
 *
 * Manual skill update endpoint. Takes an existing skill and a source,
 * assesses the source content, then merges new methodology into the skill.
 *
 * POST body: { skillId: string, sourceId: string }
 * Auth: Bearer token (user must own both the skill and the source)
 *
 * CRITICAL: Fully self-contained. No local imports (Vercel serverless rule).
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

export const maxDuration = 120;

// ─── ENVIRONMENT ──────────────────────────────────────────────────────────────

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY!;

if (!GEMINI_API_KEY) {
  throw new Error('[gemini] Missing env var: GEMINI_API_KEY')
}

const getSupabase = () => createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

const GEMINI_MODEL = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash'
const GEMINI_EMBEDDING_MODEL = 'gemini-embedding-001'
const MAX_CONTENT_CHARS = 30_000;

// ─── AUTH ─────────────────────────────────────────────────────────────────────


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

async function verifyUserAuth(
  req: VercelRequest
): Promise<string | null> {
  const auth = req.headers['authorization'];
  if (auth?.startsWith('Bearer ')) {
    const token = auth.slice(7);
    const supabase = getSupabase();
    try {
      const { data: { user } } = await supabase.auth.getUser(token);
      if (user) return user.id;
    } catch { /* fall through */ }
  }
  return null;
}

// ─── TYPES ────────────────────────────────────────────────────────────────────

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

interface ExistingSkill {
  id: string;
  name: string;
  title: string;
  description: string;
  domain: string | null;
  source_ids: string[];
  source_count: number;
  content: string;
}

interface SourceRow {
  id: string;
  user_id: string;
  title: string | null;
  content: string | null;
  source_type: string | null;
  source_url: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
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

async function callGeminiJSON<T>(
  systemPrompt: string,
  userContent: string,
  temperature: number = 0.1,
  model: string = GEMINI_MODEL
): Promise<T> {
  const { json } = await geminiFetch(
    `${model}:generateContent`,
    {
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents: [{ parts: [{ text: userContent }] }],
      generationConfig: {
        temperature,
        responseMimeType: 'application/json',
      },
    },
    60000,
    'skills:update-from-source'
  );
  const data = json as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Gemini returned empty response');
  return JSON.parse(text) as T;
}

async function embedText(text: string, timeoutMs = 30000, stage = 'skills:update-from-source:embed'): Promise<number[]> {
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
    console.warn('[skills/update-from-source] embedding failed:', err instanceof Error ? err.message : err);
    return [];
  }
}

// ─── ASSESSMENT (simplified for manual update — we already know we want to update) ──

async function assessSourceForUpdate(
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

  const systemPrompt = `You are a skill assessment engine for a personal knowledge graph system. Your job is to evaluate whether a source contains extractable, reusable methodology that could be encoded as a structured Claude skill — specifically for THIS user, based on their declared interests and expertise (anchors).

Evaluate this source on four dimensions:

1. GENERALIZABILITY (0.0–1.0): Could someone with no knowledge of this specific project use the methodology described here?
2. STRUCTURAL DENSITY (0.0–1.0): Does the content contain enumerable, structured knowledge (steps, frameworks, decision trees)?
3. INSTRUCTIONAL RATIO (0.0–1.0): What proportion of the content is actively teaching methodology vs. narrative or conversation?
4. ANCHOR RELEVANCE (0.0–1.0): How relevant is this source's methodology to the user's declared interests (anchors)?

THE USER'S ANCHORS:
${anchorSummary || '(no anchors defined — score anchorRelevance based on general utility)'}

Also provide:
- anchorMatches: Array of anchor labels this source is relevant to
- proposedSkillTitle: kebab-case name for the skill
- proposedSkillTitleHuman: Human-readable title
- proposedDomain: One of: ai-tooling, ai-prompting, consulting-methodology, change-management, financial-analysis, risk-management, sales-methodology, project-management, product-design, general
- extractableMethodology: 1-2 sentence summary of methodology
- transferableMethods: Array of specific techniques/steps that are portable
- contextDependencies: Array of things needing generalisation

Return JSON with keys: generalizability, structuralDensity, instructionalRatio, anchorRelevance, anchorMatches, proposedSkillTitle, proposedSkillTitleHuman, proposedDomain, extractableMethodology, transferableMethods, contextDependencies.`;

  const userContent = `SOURCE CONTENT (may be truncated):\n${content.slice(0, MAX_CONTENT_CHARS)}\n\nEXTRACTED ENTITIES:\n${entitySummary || '(no entities extracted)'}`;

  return callGeminiJSON<AssessmentResult>(systemPrompt, userContent, 0.1);
}

// ─── UPDATE CONTENT GENERATION (inlined from backfill.ts) ────────────────────

async function generateUpdateContent(
  existingSkill: ExistingSkill,
  source: SourceRow,
  content: string,
  assessment: AssessmentResult
): Promise<{ content: string; description: string }> {
  const systemPrompt = `You are updating an existing Claude skill with new content from an additional source.

Merge the new content into the existing skill following these rules:
1. Add genuinely new techniques/steps to the Methodology section. Keep all existing steps — only add, never remove.
2. Update Prerequisites if the new source reveals additional requirements.
3. Update Output Format if the new source shows a different/better output structure.
4. Add to Limitations if the new source reveals new failure modes or edge cases.
5. Add new examples to the Examples section if the new source provides concrete ones — prefer real scenarios over hypothetical.
6. Update the footer source attribution line: append \`| [${source.title || 'Untitled'}](synapse:source:${source.id})\` to the existing Sources entry and increment the count.
7. Do NOT rewrite existing content — only add and refine.
8. If the new source corrects something in the existing skill, apply the correction with a brief inline note.

Return a JSON object with: content (the updated full body), description (updated 2-3 sentence description if the scope has broadened, otherwise return unchanged).`;

  const userContent = `EXISTING SKILL:
- Name: ${existingSkill.name}
- Title: ${existingSkill.title}
- Current content:
${existingSkill.content}
- Current source count: ${existingSkill.source_count}

NEW SOURCE:
- Title: ${source.title || 'Untitled'}
- Type: ${source.source_type || 'unknown'}
- New methods identified: ${assessment.transferableMethods.join(', ')}

NEW SOURCE CONTENT (may be truncated):
${content.slice(0, MAX_CONTENT_CHARS)}`;

  return callGeminiJSON<{ content: string; description: string }>(systemPrompt, userContent, 0.2, GEMINI_MODEL);
}

// ─── MAIN HANDLER ─────────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const userId = await verifyUserAuth(req);
  if (!userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { skillId, sourceId } = req.body ?? {};
  if (!skillId || !sourceId) {
    return res.status(400).json({ error: 'skillId and sourceId are required' });
  }

  const supabase = getSupabase();
  const startTime = Date.now();

  try {
    // ── Fetch skill (must belong to this user) ─────────────────────────────
    const { data: skillRow, error: skillError } = await supabase
      .from('knowledge_skills')
      .select('id, name, title, description, domain, source_ids, source_count, content')
      .eq('id', skillId)
      .eq('user_id', userId)
      .maybeSingle();

    if (skillError) throw new Error(`Failed to fetch skill: ${skillError.message}`);
    if (!skillRow) return res.status(404).json({ error: 'Skill not found' });

    const skill = skillRow as ExistingSkill;

    // ── Check source isn't already linked ──────────────────────────────────
    if (skill.source_ids.includes(sourceId)) {
      return res.status(400).json({ error: 'Source is already linked to this skill' });
    }

    // ── Fetch source (must belong to this user) ────────────────────────────
    const { data: sourceRow, error: sourceError } = await supabase
      .from('knowledge_sources')
      .select('id, user_id, title, content, source_type, source_url, metadata, created_at')
      .eq('id', sourceId)
      .eq('user_id', userId)
      .maybeSingle();

    if (sourceError) throw new Error(`Failed to fetch source: ${sourceError.message}`);
    if (!sourceRow) return res.status(404).json({ error: 'Source not found' });

    const source = sourceRow as SourceRow;

    if (!source.content || source.content.length < 200) {
      return res.status(400).json({ error: 'Source has insufficient content for skill update' });
    }

    // ── Fetch entities for assessment context ──────────────────────────────
    const { data: entities } = await supabase
      .from('knowledge_nodes')
      .select('label, entity_type, description')
      .eq('source_id', sourceId)
      .order('entity_type')
      .order('label');

    const entityList = (entities ?? []) as Array<{ label: string; entity_type: string; description: string | null }>;

    // ── Fetch user anchors for relevance scoring ───────────────────────────
    const { data: anchorNodes } = await supabase
      .from('knowledge_nodes')
      .select('label, entity_type, description')
      .eq('user_id', userId)
      .eq('is_anchor', true);

    const anchors = (anchorNodes ?? []) as Array<{ label: string; entity_type: string; description: string | null }>;

    // ── Step 1: Assess the source ──────────────────────────────────────────
    console.log(`[update-from-source] Assessing source "${source.title}" for skill "${skill.name}"`);
    const assessment = await assessSourceForUpdate(source.content, entityList, anchors);

    // ── Step 2: Generate updated skill content ─────────────────────────────
    console.log(`[update-from-source] Generating update content for skill "${skill.name}"`);
    const updateResult = await generateUpdateContent(skill, source, source.content, assessment);

    // ── Step 3: Update the skill in database ───────────────────────────────
    const newSourceIds = [...skill.source_ids, sourceId];
    const newSourceCount = skill.source_count + 1;

    const { error: updateError } = await supabase
      .from('knowledge_skills')
      .update({
        content: updateResult.content,
        description: updateResult.description,
        source_ids: newSourceIds,
        source_count: newSourceCount,
        updated_at: new Date().toISOString(),
      })
      .eq('id', skillId)
      .eq('user_id', userId);

    if (updateError) {
      throw new Error(`Skill update failed: ${updateError.message}`);
    }

    // ── Step 4: Re-embed with updated description ──────────────────────────
    const embedding = await generateEmbedding(updateResult.description);
    if (embedding.length > 0) {
      await supabase
        .from('knowledge_skills')
        .update({ embedding })
        .eq('id', skillId)
        .eq('user_id', userId);
    }

    // ── Step 5: Mark source with backfill result ───────────────────────────
    const sourceMetadata = (source.metadata ?? {}) as Record<string, unknown>;
    await supabase
      .from('knowledge_sources')
      .update({
        metadata: {
          ...sourceMetadata,
          skill_backfill_status: 'processed',
          skill_backfill_at: new Date().toISOString(),
          skill_backfill_result: 'updated',
          skill_backfill_skill_name: skill.name,
        },
      })
      .eq('id', sourceId);

    console.log(`[update-from-source] Successfully updated skill "${skill.name}" from source "${source.title}" (${Date.now() - startTime}ms)`);

    return res.status(200).json({
      success: true,
      skillName: skill.name,
      sourceTitle: source.title,
      newSourceCount,
      assessment: {
        instructionalRatio: assessment.instructionalRatio,
        generalizability: assessment.generalizability,
        structuralDensity: assessment.structuralDensity,
        anchorRelevance: assessment.anchorRelevance,
        transferableMethods: assessment.transferableMethods,
      },
      duration_ms: Date.now() - startTime,
    });

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[update-from-source] Error:', msg);
    return res.status(500).json({ error: msg, duration_ms: Date.now() - startTime });
  }
}
