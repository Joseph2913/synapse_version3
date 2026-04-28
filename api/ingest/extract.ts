// api/ingest/extract.ts
// Single-call auto-approve extraction. Used by headless paths (manualSignals,
// background pipelines) where there is no review step. Calls runExtractionCore.

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';
import {
  runExtractionCore,
  type PromptConfig,
  type SourceContext,
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

  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) return res.status(401).json({ error: 'Invalid auth token' });
  const userId = user.id;

  const body = req.body as {
    sourceId?: string;
    content?: string;
    sourceContext?: {
      sourceType?: string;
      sourceUrl?: string | null;
      sourceLabel?: string | null;
    };
    config?: {
      mode?: string;
      anchorEmphasis?: string;
      anchors?: Array<{ label: string; entity_type: string; description: string }>;
      userProfile?: unknown;
      customGuidance?: string | null;
    };
    enableFuzzyDedup?: boolean;
    enableCrossConnections?: boolean;
  };

  const { sourceId, sourceContext } = body;
  if (!sourceId || typeof sourceId !== 'string') {
    return res.status(400).json({ error: 'sourceId is required' });
  }

  let content = body.content;

  // If content not provided, read from knowledge_sources
  if (!content || content.trim().length === 0) {
    const { data: sourceRow, error: sourceReadErr } = await supabase
      .from('knowledge_sources')
      .select('content, title, source_type, source_url')
      .eq('id', sourceId)
      .eq('user_id', userId)
      .maybeSingle();
    if (sourceReadErr || !sourceRow) {
      return res.status(404).json({ error: 'Source not found or content unavailable' });
    }
    content = (sourceRow.content as string | null) ?? '';
    if (!content || content.trim().length === 0) {
      return res.status(400).json({ error: 'Source content is empty' });
    }
  }

  const t0 = Date.now();

  // Mark source as extracting
  await supabase
    .from('knowledge_sources')
    .update({ status: 'extracting' })
    .eq('id', sourceId)
    .eq('user_id', userId);

  const source: SourceContext = {
    sourceId,
    sourceType: sourceContext?.sourceType ?? 'paste',
    sourceUrl: sourceContext?.sourceUrl ?? null,
    sourceLabel: sourceContext?.sourceLabel ?? null,
  };

  const promptConfig: PromptConfig = {
    mode: body.config?.mode ?? 'comprehensive',
    anchorEmphasis: body.config?.anchorEmphasis ?? 'standard',
    anchors: (body.config?.anchors ?? []) as Array<{ label: string; entity_type: string; description: string }>,
    userProfile: body.config?.userProfile as PromptConfig['userProfile'] ?? null,
    customInstructions: body.config?.customGuidance ?? null,
  };

  try {
    const result = await runExtractionCore({
      content,
      promptConfig,
      source,
      userId,
      supabase,
      options: {
        enableFuzzyDedup: body.enableFuzzyDedup !== false,
        enableCrossConnections: body.enableCrossConnections !== false,
        enableChunking: true,
      },
    });

    await supabase
      .from('knowledge_sources')
      .update({ status: 'complete' })
      .eq('id', sourceId)
      .eq('user_id', userId);

    log({ stage: 'extract:headless', user_id: userId, source_id: sourceId, duration_ms: Date.now() - t0, status: 'ok', nodes_created: result.nodesCreated, edges_created: result.edgesCreated, chunks: result.chunksCreated, cross_connections: result.crossConnectionCount });

    return res.status(200).json({
      sourceId,
      nodesCreated: result.nodesCreated,
      edgesCreated: result.edgesCreated,
      chunksCreated: result.chunksCreated,
      crossConnectionCount: result.crossConnectionCount,
      durationMs: Date.now() - t0,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logError({ stage: 'extract:headless', user_id: userId, source_id: sourceId, duration_ms: Date.now() - t0, status: 'failed', error: message });
    const status = message.startsWith('RATE_LIMITED') ? 'degraded' : 'failed';
    await supabase.from('knowledge_sources').update({ status }).eq('id', sourceId).eq('user_id', userId);
    return res.status(500).json({ error: message });
  }
}
