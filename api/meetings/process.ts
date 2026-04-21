import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';
import {
  runExtractionCore,
  type Anchor,
  type UserProfile,
} from '../pipeline/extract-pipeline';

// Allow up to 120s on Vercel Pro (heavy Gemini extraction + embeddings)
export const maxDuration = 120;

// ─── ENVIRONMENT ───────────────────────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const CRON_SECRET = process.env.CRON_SECRET;

const getSupabase = () => createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const MAX_ITEMS_PER_BATCH = 2;

// ─── TYPES ─────────────────────────────────────────────────────────────────────

interface MeetingSource {
  id: string;
  user_id: string;
  title: string | null;
  content: string | null;
  metadata: Record<string, unknown> | null;
}

// ─── AUTH ──────────────────────────────────────────────────────────────────────

function verifyCronAuth(req: VercelRequest): boolean {
  if (req.headers['x-vercel-signature']) return true;
  if (!CRON_SECRET) return true;
  const auth = req.headers['authorization'];
  return !!(auth && auth === `Bearer ${CRON_SECRET}`);
}

async function verifyUserAuth(
  req: VercelRequest
): Promise<{ userId: string | null; isCron: boolean }> {
  if (verifyCronAuth(req)) return { userId: null, isCron: true };

  const auth = req.headers['authorization'];
  if (auth?.startsWith('Bearer ')) {
    const token = auth.slice(7);
    const supabase = getSupabase();
    try {
      const { data: { user } } = await supabase.auth.getUser(token);
      if (user) return { userId: user.id, isCron: false };
    } catch { /* fall through */ }
  }

  return { userId: null, isCron: false };
}

// ─── PROCESS A SINGLE MEETING ─────────────────────────────────────────────────

async function processMeeting(
  meeting: MeetingSource,
  supabase: ReturnType<typeof getSupabase>
): Promise<{ success: boolean; nodesCreated: number; edgesCreated: number; error?: string }> {
  const updateStatus = async (status: string, extra?: Record<string, unknown>) => {
    const meta = { ...(meeting.metadata ?? {}), extraction_status: status, ...extra };
    await supabase
      .from('knowledge_sources')
      .update({ metadata: meta })
      .eq('id', meeting.id);
  };

  try {
    await updateStatus('processing', { processing_started_at: new Date().toISOString() });

    const content = meeting.content;
    if (!content || content.trim().length < 50) {
      throw new Error('Meeting content too short for extraction');
    }

    // ── STEPS 1-7: SHARED EXTRACTION PIPELINE ──────────────────────────────────
    // Entity extraction, dedup, node+edge persistence, chunking, and cross-
    // connection discovery all live in api/_shared/extract-pipeline.ts.
    const [profileResult, anchorsResult, settingsResult] = await Promise.all([
      supabase.from('user_profiles').select('*').eq('user_id', meeting.user_id).maybeSingle(),
      supabase
        .from('knowledge_nodes')
        .select('label, entity_type, description')
        .eq('user_id', meeting.user_id)
        .eq('is_anchor', true)
        .limit(10),
      supabase.from('extraction_settings').select('default_mode, default_anchor_emphasis').eq('user_id', meeting.user_id).maybeSingle(),
    ]);

    const userProfile = profileResult.data as UserProfile | null;
    const anchors = (anchorsResult.data ?? []) as Anchor[];
    const defaultSettings = settingsResult.data as { default_mode: string; default_anchor_emphasis: string } | null;

    const extractionMode = defaultSettings?.default_mode ?? 'comprehensive';
    const anchorEmphasis = defaultSettings?.default_anchor_emphasis ?? 'standard';

    const coreResult = await runExtractionCore({
      content,
      promptConfig: { mode: extractionMode, anchorEmphasis, anchors, userProfile },
      source: {
        sourceId: meeting.id,
        sourceType: 'Meeting',
        sourceUrl: null,
        sourceLabel: meeting.title ?? 'Meeting',
      },
      userId: meeting.user_id,
      supabase,
    });

    const { savedNodeMap, nodesCreated, edgesCreated, crossConnectionCount, chunksCreated, mergedEntitiesLog } = coreResult;

    // ── COMPLETE ────────────────────────────────────────────────────────────────
    await updateStatus('completed', mergedEntitiesLog.length > 0 ? { merged_entities: mergedEntitiesLog } : undefined);

    // ── TRIGGER ANCHOR SCORING (fire-and-forget) ────────────────────────────────
    const savedNodeIds = Array.from(savedNodeMap.values());
    if (savedNodeIds.length > 0) {
      const appUrl = process.env.VERCEL_URL
        ? `https://${process.env.VERCEL_URL}`
        : 'http://localhost:3000';

      fetch(`${appUrl}/api/anchors/score-post-extraction`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${CRON_SECRET ?? ''}`,
        },
        body: JSON.stringify({
          userId:   meeting.user_id,
          sourceId: meeting.id,
          nodeIds:  savedNodeIds,
        }),
      }).catch(err => {
        console.warn('[meetings/process] Anchor scoring trigger failed (non-fatal):', err);
      });
    }

    // ── LINK TO MEETING DOMAIN AGENT (fire-and-forget) ───────────────────────
    // Resolve meeting agent(s) via:
    // 1. Integration ID → agent_integration_links (supports multi-integration agents)
    // 2. Integration ID → user_integrations.domain_agent_id (direct link)
    // 3. Fallback: any integration-linked agent for this user
    try {
      const meetingMeta = meeting.metadata as Record<string, unknown> | null;
      const integrationId = meetingMeta?.integration_id as string | undefined;

      const agentIds = new Set<string>();

      if (integrationId) {
        // Check junction table first (supports multiple agents per integration)
        const { data: links } = await supabase
          .from('agent_integration_links')
          .select('agent_id')
          .eq('integration_id', integrationId);
        for (const link of (links ?? []) as Array<{ agent_id: string }>) {
          agentIds.add(link.agent_id);
        }

        // Also check direct link on user_integrations
        if (agentIds.size === 0) {
          const { data: integration } = await supabase
            .from('user_integrations')
            .select('domain_agent_id')
            .eq('id', integrationId)
            .maybeSingle();
          const directId = (integration as { domain_agent_id: string | null } | null)?.domain_agent_id;
          if (directId) agentIds.add(directId);
        }
      }

      // Fallback: find any integration-linked agent for this user
      if (agentIds.size === 0) {
        const { data: agents } = await supabase
          .from('domain_agents')
          .select('id')
          .eq('user_id', meeting.user_id)
          .not('integration_id', 'is', null)
          .eq('is_active', true)
          .limit(1);
        const fallbackId = (agents?.[0] as { id: string } | undefined)?.id;
        if (fallbackId) agentIds.add(fallbackId);
      }

      for (const agentId of agentIds) {
        await supabase
          .from('domain_agent_sources')
          .upsert({
            user_id: meeting.user_id,
            agent_id: agentId,
            source_id: meeting.id,
            association_type: 'primary',
          }, { onConflict: 'agent_id,source_id', ignoreDuplicates: true });

        await supabase
          .from('domain_agents')
          .update({ index_stale: true, last_ingestion_at: new Date().toISOString() })
          .eq('id', agentId);

        console.log(`[meetings/process] Linked source ${meeting.id} to agent ${agentId}`);
      }
    } catch (agentErr) {
      console.warn('[meetings/process] Meeting agent link failed (non-fatal):', agentErr);
    }

    // Save extraction session record
    await supabase.from('extraction_sessions').insert({
      user_id: meeting.user_id,
      source_name: meeting.title ?? 'Meeting',
      source_type: 'Meeting',
      source_content_preview: content.slice(0, 300),
      extraction_mode: extractionMode,
      anchor_emphasis: anchorEmphasis,
      entity_count: nodesCreated,
      relationship_count: edgesCreated,
      chunk_count: chunksCreated,
      cross_connection_count: crossConnectionCount,
      extraction_duration_ms: null,
    });

    return { success: true, nodesCreated, edgesCreated };

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[meetings/process] Meeting ${meeting.id} failed:`, err);

    // Distinguish transient rate-limit failures (requeue) from permanent
    // ones (give up). Previously ALL failures were marked 'failed' with no
    // retry, which permanently buried Circleback meetings that happened to
    // hit Gemini's rate limit on their first extraction attempt.
    const isRateLimited = msg.startsWith('RATE_LIMITED');
    const prevMeta = (meeting.metadata ?? {}) as Record<string, unknown>;
    const prevRetries = typeof prevMeta['retry_count'] === 'number' ? prevMeta['retry_count'] as number : 0;
    const nextRetries = prevRetries + 1;
    const MAX_RATE_LIMIT_RETRIES = 10;
    const MAX_HARD_RETRIES = 3;

    const shouldRequeue = isRateLimited
      ? nextRetries < MAX_RATE_LIMIT_RETRIES
      : nextRetries < MAX_HARD_RETRIES;

    if (shouldRequeue) {
      await updateStatus('pending', {
        retry_count: nextRetries,
        extraction_error: msg,
        last_failed_at: new Date().toISOString(),
      });
    } else {
      await updateStatus('failed', {
        retry_count: nextRetries,
        extraction_error: msg,
        last_failed_at: new Date().toISOString(),
      });
    }

    return { success: false, nodesCreated: 0, edgesCreated: 0, error: msg };
  }
}

// ─── HANDLER ───────────────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const startTime = Date.now();
  const { userId, isCron } = await verifyUserAuth(req);

  if (!isCron && !userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const supabase = getSupabase();

  try {
    // ── STUCK ITEM RECOVERY ────────────────────────────────────────────────────
    // Reset meetings stuck in 'processing' for >30 minutes back to 'pending'.
    // The timeout was bumped from 5 min because a legitimate extraction of a
    // long meeting with many chunks + cross-connection discovery can run
    // longer than 5 min, and falsely resetting mid-run causes duplicate work.
    {
      const { data: stuckCandidates } = await supabase
        .from('knowledge_sources')
        .select('id, metadata')
        .eq('source_type', 'Meeting')
        .contains('metadata', { extraction_status: 'processing' })
        .limit(20);

      const thirtyMinAgo = Date.now() - 30 * 60 * 1000;
      const stuckItems = (stuckCandidates ?? []).filter(item => {
        const meta = (item as { metadata: Record<string, unknown> | null }).metadata;
        const startedAt = meta?.processing_started_at as string | undefined;
        // If no timestamp, treat as stuck (legacy item)
        if (!startedAt) return true;
        return new Date(startedAt).getTime() < thirtyMinAgo;
      });

      if (stuckItems.length > 0) {
        console.log(`[meetings/process] Resetting ${stuckItems.length} stuck meetings back to pending`);
        for (const stuck of stuckItems) {
          const meta = {
            ...((stuck as { metadata: Record<string, unknown> }).metadata ?? {}),
            extraction_status: 'pending',
            last_stuck_reset: new Date().toISOString(),
          };
          await supabase
            .from('knowledge_sources')
            .update({ metadata: meta })
            .eq('id', stuck.id);
        }
      }
    }

    // Find meeting sources with extraction_status = 'pending'
    let query = supabase
      .from('knowledge_sources')
      .select('id, user_id, title, content, metadata')
      .eq('source_type', 'Meeting')
      .contains('metadata', { extraction_status: 'pending' })
      .order('created_at', { ascending: true })
      .limit(MAX_ITEMS_PER_BATCH);

    if (!isCron && userId) {
      query = query.eq('user_id', userId);
    }

    const { data: meetings, error: fetchError } = await query;

    if (fetchError) {
      return res.status(500).json({ error: fetchError.message });
    }

    if (!meetings || meetings.length === 0) {
      return res.status(200).json({
        success: true,
        processed: 0,
        results: [],
        duration_ms: Date.now() - startTime,
      });
    }

    const results: Array<{
      id: string;
      title: string;
      status: string;
      error?: string;
      nodes_created?: number;
      edges_created?: number;
    }> = [];

    for (const raw of meetings) {
      const meeting = raw as MeetingSource;
      console.log(`[meetings/process] Processing meeting "${meeting.title}" (${meeting.id})`);

      const result = await processMeeting(meeting, supabase);

      results.push({
        id: meeting.id,
        title: meeting.title ?? 'Meeting',
        status: result.success ? 'completed' : 'failed',
        error: result.error,
        nodes_created: result.nodesCreated,
        edges_created: result.edgesCreated,
      });
    }

    return res.status(200).json({
      success: true,
      processed: results.length,
      results,
      duration_ms: Date.now() - startTime,
    });

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[meetings/process] Fatal error:', err);
    return res.status(500).json({ success: false, error: msg, duration_ms: Date.now() - startTime });
  }
}
