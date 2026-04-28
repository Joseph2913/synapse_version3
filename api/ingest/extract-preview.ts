// api/ingest/extract-preview.ts
// Gemini extraction only. Returns entities + relationships for browser review.
// No knowledge_nodes/knowledge_edges writes happen here.

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';
import {
  buildExtractionPrompt,
  extractEntities,
  extractEntitiesMapReduce,
  consolidateDuplicateLabels,
  applyQualityFilters,
  isValidExtractionResult,
  type PromptConfig,
  type ExtractedEntity,
  type ExtractedRelationship,
  MAP_REDUCE_THRESHOLD,
} from '../pipeline/extract-pipeline.js';

export const maxDuration = 300;

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!process.env.GEMINI_API_KEY) {
  throw new Error('[gemini] Missing env var: GEMINI_API_KEY');
}

const getSupabase = () => createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

type LogStatus = 'ok' | 'failed' | 'partial' | 'skipped';
interface LogFields { stage: string; user_id?: string; source_id?: string; duration_ms?: number; status?: LogStatus; error?: string; [k: string]: unknown; }
function log(f: LogFields) { console.log(JSON.stringify({ ts: new Date().toISOString(), ...f })); }
function logError(f: LogFields & { error: string }) { console.error(JSON.stringify({ ts: new Date().toISOString(), level: 'error', ...f })); }

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing auth token' });

  const supabase = getSupabase();

  // Verify token
  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) return res.status(401).json({ error: 'Invalid auth token' });
  const userId = user.id;

  const body = req.body as {
    content?: string;
    sourceId?: string;
    config?: {
      mode?: string;
      anchorEmphasis?: string;
      anchors?: Array<{ label: string; entity_type: string; description: string }>;
      userProfile?: unknown;
      customGuidance?: string | null;
    };
  };

  const { content, sourceId, config } = body;
  if (!content || typeof content !== 'string' || content.trim().length === 0) {
    return res.status(400).json({ error: 'content is required and must be non-empty' });
  }

  const t0 = Date.now();

  // Set source status to extracting if sourceId provided
  if (sourceId) {
    await supabase
      .from('knowledge_sources')
      .update({ status: 'extracting' })
      .eq('id', sourceId)
      .eq('user_id', userId);
  }

  const promptConfig: PromptConfig = {
    mode: config?.mode ?? 'comprehensive',
    anchorEmphasis: config?.anchorEmphasis ?? 'standard',
    anchors: (config?.anchors ?? []) as Array<{ label: string; entity_type: string; description: string }>,
    userProfile: config?.userProfile as PromptConfig['userProfile'] ?? null,
    customInstructions: config?.customGuidance ?? null,
  };

  try {
    const systemPrompt = buildExtractionPrompt(promptConfig);

    let raw = content.length > MAP_REDUCE_THRESHOLD
      ? await extractEntitiesMapReduce(content, systemPrompt)
      : await extractEntities(content, systemPrompt);

    if (!isValidExtractionResult(raw)) {
      // Retry once — transient JSON parse failures are common on first attempt
      const retry = content.length > MAP_REDUCE_THRESHOLD
        ? await extractEntitiesMapReduce(content, systemPrompt)
        : await extractEntities(content, systemPrompt);
      if (!isValidExtractionResult(retry)) {
        if (sourceId) {
          await supabase.from('knowledge_sources').update({ status: 'degraded' }).eq('id', sourceId).eq('user_id', userId);
        }
        return res.status(422).json({ error: 'Gemini returned unexpected shape after retry' });
      }
      raw = retry;
    }

    const consolidated = consolidateDuplicateLabels(raw.entities, raw.relationships);
    const filtered = applyQualityFilters(consolidated.entities, consolidated.relationships);

    log({ stage: 'extract:preview', user_id: userId, source_id: sourceId, duration_ms: Date.now() - t0, status: 'ok', entities: filtered.entities.length, relationships: filtered.relationships.length });

    return res.status(200).json({
      entities: filtered.entities as ExtractedEntity[],
      relationships: filtered.relationships as ExtractedRelationship[],
      stats: filtered.stats,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logError({ stage: 'extract:preview', user_id: userId, source_id: sourceId, duration_ms: Date.now() - t0, status: 'failed', error: message });
    if (sourceId) {
      const status = message.startsWith('RATE_LIMITED') ? 'degraded' : 'failed';
      await supabase.from('knowledge_sources').update({ status }).eq('id', sourceId).eq('user_id', userId);
    }
    return res.status(500).json({ error: message });
  }
}
