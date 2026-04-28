/**
 * api/skills/rescore.ts
 *
 * Weekly deep content refresh — regenerates when_to_apply and how_to_apply
 * for ALL confirmed/active skills unconditionally.
 * Scoring, lifecycle, and related-skills logic moved to daily-cron.ts (PRD-Skills-D).
 *
 * CRITICAL: Fully self-contained. No local imports.
 * Cron: 0 2 * * 0 (Sunday 02:00 UTC)
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export const maxDuration = 120;

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
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  return JSON.parse(cleaned) as T;
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
  temperature = 0.3
): Promise<T> {
  const { json } = await geminiFetch(
    `${GEMINI_MODEL}:generateContent`,
    {
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents: [{ parts: [{ text: userContent }] }],
      generationConfig: { temperature, responseMimeType: 'application/json' },
    },
    30000,
    'skills:rescore'
  );
  const data = json as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Gemini returned empty response');
  return parseJSON<T>(text);
}

// ─── CONTENT GENERATION ───────────────────────────────────────────────────────

const CONTENT_GEN_SYSTEM_PROMPT = `You are generating structured descriptions for skills in a personal knowledge graph. Each skill has been detected from real content the user has ingested. Be concise, specific, and practical. Write for an AI assistant that needs to know when and how to apply each skill on behalf of the user.

Respond ONLY with a JSON array. No preamble or markdown.`;

interface SkillPayload {
  label: string;
  description: string;
  domain: string;
  tags: string[];
  current_when_to_apply: string | null;
  current_how_to_apply: string | null;
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

  // Fetch all confirmed/active skills across all users
  const { data: allSkills, error } = await supabase
    .from('knowledge_skills')
    .select('id, user_id, title, description, domain, tags, when_to_apply, how_to_apply, status')
    .in('status', ['confirmed', 'active'])
    .order('user_id');

  if (error) {
    return res.status(500).json({ error: 'Failed to fetch skills', detail: error.message });
  }

  const skills = (allSkills ?? []) as Array<{
    id: string; user_id: string; title: string; description: string;
    domain: string | null; tags: string[]; when_to_apply: string | null;
    how_to_apply: string | null; status: string;
  }>;

  let refreshed = 0;
  let errors = 0;

  // Process in batches of 10
  for (let i = 0; i < skills.length; i += 10) {
    // Time budget — leave 15s buffer
    if (Date.now() - startTime > 105_000) break;

    const batch = skills.slice(i, i + 10);
    const payload: SkillPayload[] = batch.map(s => ({
      label: s.title,
      description: s.description,
      domain: s.domain ?? 'general',
      tags: s.tags ?? [],
      current_when_to_apply: s.when_to_apply,
      current_how_to_apply: s.how_to_apply,
    }));

    try {
      const generated = await callGemini<Array<{ label: string; when_to_apply: string; how_to_apply: string }>>(
        CONTENT_GEN_SYSTEM_PROMPT,
        `Generate when_to_apply and how_to_apply descriptions for these skills. If current content exists, improve and refine it.\n\n${JSON.stringify(payload, null, 2)}\n\nReturn:\n[{"label":"string","when_to_apply":"2-3 sentences describing specific situations where this skill is relevant","how_to_apply":"2-3 sentences describing concrete steps or approaches to apply this skill"}]`
      );

      for (const gen of (generated ?? [])) {
        const skill = batch.find(s => s.title === gen.label);
        if (skill && gen.when_to_apply && gen.how_to_apply) {
          const { error: updateError } = await supabase
            .from('knowledge_skills')
            .update({
              when_to_apply: gen.when_to_apply,
              how_to_apply: gen.how_to_apply,
            })
            .eq('id', skill.id);

          if (!updateError) refreshed++;
          else errors++;
        }
      }
    } catch (err) {
      console.warn('[rescore] batch content gen error:', err instanceof Error ? err.message : err);
      errors += batch.length;
    }

    // Rate limit between batches
    await new Promise(r => setTimeout(r, 500));
  }

  return res.status(200).json({
    success: true,
    total_skills: skills.length,
    refreshed,
    errors,
    duration_ms: Date.now() - startTime,
  });
}
