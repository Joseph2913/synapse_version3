import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';
import { waitUntil } from '@vercel/functions';
import {
  runExtractionCore,
  stripMarkdown,
  type Anchor,
  type UserProfile,
  type PromptSkillHint,
} from '../pipeline/extract-pipeline.js';

export const maxDuration = 300;

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY!;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY!;
const INGEST_SECRET = process.env.INGEST_SECRET;

if (!GEMINI_API_KEY) throw new Error('[retry-source] Missing GEMINI_API_KEY');

const getSupabase = () => createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const GEMINI_MODEL = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash';

// Returns userId from JWT auth, or null if ingest secret auth is used (userId resolved later from source row)
async function resolveAuth(req: VercelRequest): Promise<{ userId: string | null; isIngestSecret: boolean }> {
  const secret = req.headers['x-ingest-secret'] as string | undefined;
  if (INGEST_SECRET && secret === INGEST_SECRET) return { userId: null, isIngestSecret: true };
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return { userId: null, isIngestSecret: false };
  const token = auth.slice(7);
  try {
    const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    const { data: { user } } = await anon.auth.getUser(token);
    return { userId: user?.id ?? null, isIngestSecret: false };
  } catch {
    return { userId: null, isIngestSecret: false };
  }
}

async function generateSummary(content: string): Promise<string> {
  try {
    const url = `${GEMINI_BASE}/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: 'You are a concise summarizer. Produce a 2-3 sentence summary of the following content. Focus on what was accomplished, decided, or discovered.' }] },
        contents: [{ parts: [{ text: content.slice(0, 30000) }] }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 256 },
      }),
    });
    if (!resp.ok) return '';
    const data = await resp.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    return data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  } catch {
    return '';
  }
}

async function runRetryPipeline(
  sourceId: string,
  userId: string,
  title: string,
  content: string,
  sourceType: string,
  sourceUrl: string | null,
  guidance: string | null,
  originalMetadata: Record<string, unknown>,
): Promise<void> {
  const supabase = getSupabase();
  const startTime = Date.now();

  const setStatus = async (extractionStatus: string, topLevel?: string) => {
    const meta = { ...originalMetadata, extraction_status: extractionStatus, retry_started_at: new Date().toISOString() };
    const update: Record<string, unknown> = { metadata: meta };
    if (topLevel) update.status = topLevel;
    await supabase.from('knowledge_sources').update(update).eq('id', sourceId);
  };

  try {
    await setStatus('processing', 'pending');

    const rawSummary = await generateSummary(content);
    const summary = rawSummary ? stripMarkdown(rawSummary) : '';
    if (summary) {
      await supabase.from('knowledge_sources')
        .update({ summary, summary_source: 'generated' })
        .eq('id', sourceId);
    }

    const [profileResult, anchorsResult, skillsResult] = await Promise.all([
      supabase.from('user_profiles').select('*').eq('user_id', userId).maybeSingle(),
      supabase.from('knowledge_nodes')
        .select('label, entity_type, description')
        .eq('user_id', userId)
        .eq('is_anchor', true)
        .limit(10),
      supabase.from('knowledge_skills')
        .select('label, domain, exposure_level')
        .eq('user_id', userId)
        .eq('status', 'confirmed')
        .order('confidence', { ascending: false })
        .limit(12),
    ]);

    const userProfile = profileResult.data as UserProfile | null;
    const anchors = (anchorsResult.data ?? []) as Anchor[];
    const activeSkills = (skillsResult.data ?? []) as PromptSkillHint[];

    const coreResult = await runExtractionCore({
      content,
      promptConfig: {
        mode: 'comprehensive',
        anchorEmphasis: 'aggressive',
        anchors,
        userProfile,
        customInstructions: guidance ?? null,
        activeSkills,
      },
      source: {
        sourceId,
        sourceType,
        sourceUrl,
        sourceLabel: title,
      },
      userId,
      supabase,
    });

    const savedNodeIds = Array.from(coreResult.savedNodeMap.values());
    if (savedNodeIds.length > 0) {
      const appUrl = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000';
      const CRON_SECRET = process.env.CRON_SECRET;
      fetch(`${appUrl}/api/anchors/score-post-extraction`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${CRON_SECRET ?? ''}` },
        body: JSON.stringify({ userId, sourceId, nodeIds: savedNodeIds }),
      }).catch(() => {});
    }

    // ── TRIGGER SKILLS DETECTION (fire-and-forget) ───────────────────────────
    {
      const appUrl = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000';
      fetch(`${appUrl}/api/skills/process-source`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.INGEST_SECRET ?? ''}` },
        body: JSON.stringify({ user_id: userId, source_id: sourceId }),
      }).catch(() => {});
    }

    await setStatus('completed', 'complete');
    console.log(`[ingest/retry-source] Done: ${coreResult.nodesCreated} nodes, ${coreResult.edgesCreated} edges, ${coreResult.chunksCreated} chunks in ${Date.now() - startTime}ms`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[ingest/retry-source] Failed:', msg);
    await setStatus('error', 'failed');
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  const { userId: jwtUserId, isIngestSecret } = await resolveAuth(req);
  if (!jwtUserId && !isIngestSecret) return res.status(401).json({ error: 'unauthenticated' });

  const { sourceId } = req.body ?? {};
  if (!sourceId || typeof sourceId !== 'string') {
    return res.status(400).json({ error: 'invalid_request', detail: 'Expected { sourceId: string }' });
  }

  const supabase = getSupabase();
  const query = supabase
    .from('knowledge_sources')
    .select('id, user_id, title, content, source_type, source_url, metadata')
    .eq('id', sourceId);

  // JWT auth: enforce ownership. Ingest secret: trust the source row's user_id.
  if (jwtUserId) query.eq('user_id', jwtUserId);

  const { data: source, error } = await query.maybeSingle();
  const userId = jwtUserId ?? (source?.user_id as string | null);

  if (error || !source || !userId) {
    return res.status(404).json({ error: 'not_found' });
  }

  if (!source.content || source.content.trim().length === 0) {
    return res.status(422).json({ error: 'no_content', detail: 'Source has no content to extract from' });
  }

  const meta = (source.metadata ?? {}) as Record<string, unknown>;
  const guidance = (meta.guidance as string | null) ?? null;

  waitUntil(runRetryPipeline(
    source.id as string,
    userId,
    source.title as string,
    source.content as string,
    source.source_type as string,
    source.source_url as string | null,
    guidance,
    meta,
  ));

  return res.status(202).json({ status: 'queued', sourceId });
}
