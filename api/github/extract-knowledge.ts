import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';
import {
  runExtractionCore,
  type Anchor,
  type UserProfile,
} from '../pipeline/extract-pipeline.js';

// 300s ceiling to cover map-reduce + dedup + chunk persistence on long sources.
export const maxDuration = 300;

// ─── ENVIRONMENT ───────────────────────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const CRON_SECRET = process.env.CRON_SECRET;

const getSupabase = () => createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const MAX_ITEMS_PER_BATCH = 2;
const MAX_CONTENT_CHARS = 100_000;

// ─── TYPES ─────────────────────────────────────────────────────────────────────

interface QueueItem {
  id: string;
  user_id: string;
  repo_id: string;
  digest_date: string;
  commit_count: number;
  commit_range: string;
  authors: string[];
  digest_content: string;
  status: string;
  retry_count: number;
  max_retries: number;
  error_message: string | null;
  // From github_tracked_repos
  display_name: string | null;
  repo_url: string;
  repo_name: string;
  extraction_mode?: string;
  anchor_emphasis?: string;
  linked_anchor_ids?: string[];
  custom_instructions?: string | null;
}

// ─── AUTH ──────────────────────────────────────────────────────────────────────


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

// ─── MAIN EXTRACTION LOGIC ─────────────────────────────────────────────────────

async function extractKnowledgeForItem(
  item: QueueItem,
  supabase: ReturnType<typeof getSupabase>,
  itemStartTime: number
): Promise<{ success: boolean; nodesCreated: number; edgesCreated: number; error?: string }> {
  const digestContent = item.digest_content;

  try {
    // ── Mark as extracting ──────────────────────────────────────────────────────
    await supabase
      .from('github_ingestion_queue')
      .update({ status: 'extracting', started_at: new Date().toISOString() })
      .eq('id', item.id);

    // ── STEP 1: SAVE SOURCE ─────────────────────────────────────────────────────
    const sourceTitle = `${item.display_name ?? item.repo_name} - Dev Digest ${item.digest_date}`;
    const { data: sourceData, error: sourceError } = await supabase
      .from('knowledge_sources')
      .insert({
        user_id: item.user_id,
        title: sourceTitle,
        source_type: 'file',
        source_url: item.repo_url,
        content: digestContent.slice(0, MAX_CONTENT_CHARS),
        metadata: {
          source: 'github_integration',
          repo_url: item.repo_url,
          repo_name: item.repo_name,
          digest_date: item.digest_date,
          commit_count: item.commit_count,
          commit_range: item.commit_range,
          authors: item.authors,
          extraction_status: 'extracting',
        },
      })
      .select('id')
      .single();

    if (sourceError || !sourceData) {
      throw new Error(`Failed to save source: ${sourceError?.message}`);
    }
    const sourceId = sourceData.id as string;

    await supabase
      .from('github_ingestion_queue')
      .update({ source_id: sourceId })
      .eq('id', item.id);

    // ── STEPS 2-7: SHARED EXTRACTION PIPELINE ──────────────────────────────────
    // Entity extraction, dedup, node+edge persistence, chunking, and cross-
    // connection discovery all live in api/_shared/extract-pipeline.ts.
    // Note: previously GitHub did only exact-match dedup (no fuzzy/semantic).
    // The shared core now runs fuzzy dedup for GitHub too, which means dev-
    // digest entities are properly merged with their counterparts from other
    // sources (e.g. the same technology referenced in a meeting).
    const [profileResult, anchorsResult, settingsResult] = await Promise.all([
      supabase.from('user_profiles').select('*').eq('user_id', item.user_id).maybeSingle(),
      supabase
        .from('knowledge_nodes')
        .select('label, entity_type, description')
        .eq('user_id', item.user_id)
        .eq('is_anchor', true)
        .limit(10),
      supabase.from('extraction_settings').select('default_mode, default_anchor_emphasis').eq('user_id', item.user_id).maybeSingle(),
    ]);

    const userProfile = profileResult.data as UserProfile | null;
    const anchors = (anchorsResult.data ?? []) as Anchor[];
    const defaultSettings = settingsResult.data as { default_mode: string; default_anchor_emphasis: string } | null;

    const extractionMode = item.extraction_mode ?? defaultSettings?.default_mode ?? 'comprehensive';
    const anchorEmphasis = item.anchor_emphasis ?? defaultSettings?.default_anchor_emphasis ?? 'standard';

    const coreResult = await runExtractionCore({
      content: digestContent,
      promptConfig: {
        mode: extractionMode,
        anchorEmphasis,
        anchors,
        userProfile,
        customInstructions: item.custom_instructions,
      },
      source: {
        sourceId,
        sourceType: 'file',
        sourceUrl: item.repo_url,
        sourceLabel: sourceTitle,
      },
      userId: item.user_id,
      supabase,
      options: { itemStartTime },
    });

    const { savedNodeMap, nodesCreated, edgesCreated, crossConnectionCount, chunksCreated } = coreResult;


    // ── UPDATE SOURCE METADATA ──────────────────────────────────────────────────
    await supabase
      .from('knowledge_sources')
      .update({
        metadata: {
          source: 'github_integration',
          repo_url: item.repo_url,
          repo_name: item.repo_name,
          digest_date: item.digest_date,
          commit_count: item.commit_count,
          commit_range: item.commit_range,
          authors: item.authors,
          extraction_status: 'completed',
        },
      })
      .eq('id', sourceId);

    // ── COMPLETE ────────────────────────────────────────────────────────────────
    await supabase
      .from('github_ingestion_queue')
      .update({
        status: 'completed',
        nodes_created: nodesCreated,
        edges_created: edgesCreated,
        completed_at: new Date().toISOString(),
      })
      .eq('id', item.id);

    // Save extraction session record
    await supabase.from('extraction_sessions').insert({
      user_id: item.user_id,
      source_name: sourceTitle,
      source_type: 'file',
      source_content_preview: digestContent.slice(0, 300),
      extraction_mode: extractionMode,
      anchor_emphasis: anchorEmphasis,
      user_guidance: item.custom_instructions ?? null,
      selected_anchor_ids: item.linked_anchor_ids ?? [],
      entity_count: nodesCreated,
      relationship_count: edgesCreated,
      chunk_count: chunksCreated,
      cross_connection_count: crossConnectionCount,
      extraction_duration_ms: Date.now() - itemStartTime,
    });

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
          userId:   item.user_id,
          sourceId: sourceId,
          nodeIds:  savedNodeIds,
        }),
      }).catch(err => {
        console.warn('[github/extract-knowledge] Anchor scoring trigger failed (non-fatal):', err);
      });
    }

    return { success: true, nodesCreated, edgesCreated };

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[github/extract-knowledge] Item ${item.id} failed:`, err);

    const isRateLimited = msg.startsWith('RATE_LIMITED');
    const newRetryCount = (item.retry_count ?? 0) + 1;
    const maxRetries = item.max_retries ?? 3;

    if (isRateLimited || newRetryCount < maxRetries) {
      // Re-queue to digest_ready for retry (digest is preserved)
      await supabase
        .from('github_ingestion_queue')
        .update({
          status: 'digest_ready',
          retry_count: newRetryCount,
          error_message: msg,
          started_at: null,
        })
        .eq('id', item.id);
    } else {
      await supabase
        .from('github_ingestion_queue')
        .update({
          status: 'failed',
          retry_count: newRetryCount,
          error_message: msg,
          completed_at: new Date().toISOString(),
        })
        .eq('id', item.id);
    }

    return { success: false, nodesCreated: 0, edgesCreated: 0, error: msg };
  }
}

// ─── HANDLER ───────────────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');

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
    // ── Stuck item cleanup ─────────────────────────────────────────────────────
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    await supabase
      .from('github_ingestion_queue')
      .update({ status: 'digest_ready', error_message: 'Reset: stuck in extracting', started_at: null })
      .eq('status', 'extracting')
      .lt('started_at', fiveMinAgo);

    // ── Pick items with digests ready for extraction ───────────────────────────
    let query = supabase
      .from('github_ingestion_queue')
      .select('id, user_id, repo_id, digest_date, commit_count, commit_range, authors, digest_content, status, retry_count, max_retries, error_message')
      .eq('status', 'digest_ready')
      .order('created_at', { ascending: true })
      .limit(MAX_ITEMS_PER_BATCH);

    if (!isCron && userId) {
      query = query.eq('user_id', userId);
    }

    const { data: pendingItems, error: fetchError } = await query;

    if (fetchError) {
      console.error('[github/extract-knowledge] Queue query failed:', fetchError.message);
      return res.status(500).json({ error: fetchError.message });
    }

    if (!pendingItems || pendingItems.length === 0) {
      return res.status(200).json({
        success: true,
        processed: 0,
        results: [],
        message: 'No items ready for extraction',
        duration_ms: Date.now() - startTime,
      });
    }

    // ── Fetch repo settings from github_tracked_repos ─────────────────────────
    const repoIds = [...new Set(
      (pendingItems as Array<Record<string, unknown>>)
        .map(r => r['repo_id'] as string)
        .filter(Boolean)
    )];

    const repoMap = new Map<string, Record<string, unknown>>();
    if (repoIds.length > 0) {
      try {
        const { data: repos } = await supabase
          .from('github_tracked_repos')
          .select('id, display_name, repo_url, owner, repo, extraction_mode, anchor_emphasis, linked_anchor_ids, custom_instructions')
          .in('id', repoIds);
        for (const r of (repos ?? []) as Array<Record<string, unknown>>) {
          repoMap.set(r['id'] as string, r);
        }
      } catch (err) {
        console.warn('[github/extract-knowledge] Repo settings lookup failed, using defaults:', err);
      }
    }

    // ── Map queue items with repo settings ────────────────────────────────────
    const items: QueueItem[] = (pendingItems as Array<Record<string, unknown>>).map(row => {
      const repo = repoMap.get(row['repo_id'] as string) ?? null;
      const owner = (repo?.['owner'] as string) ?? '';
      const repoName = (repo?.['repo'] as string) ?? '';
      const repoUrl = (repo?.['repo_url'] as string) ?? `https://github.com/${owner}/${repoName}`;
      return {
        id: row['id'] as string,
        user_id: row['user_id'] as string,
        repo_id: row['repo_id'] as string,
        digest_date: row['digest_date'] as string,
        commit_count: (row['commit_count'] as number) ?? 0,
        commit_range: (row['commit_range'] as string) ?? '',
        authors: (row['authors'] as string[]) ?? [],
        digest_content: row['digest_content'] as string,
        status: row['status'] as string,
        retry_count: (row['retry_count'] as number) ?? 0,
        max_retries: (row['max_retries'] as number) ?? 3,
        error_message: row['error_message'] as string | null,
        display_name: (repo?.['display_name'] as string | null) ?? null,
        repo_url: repoUrl,
        repo_name: repoName || owner,
        extraction_mode: (repo?.['extraction_mode'] as string) ?? undefined,
        anchor_emphasis: (repo?.['anchor_emphasis'] as string) ?? undefined,
        linked_anchor_ids: (repo?.['linked_anchor_ids'] as string[]) ?? [],
        custom_instructions: (repo?.['custom_instructions'] as string | null) ?? null,
      };
    });

    // Filter out items with no digest content
    const validItems = items.filter(item => item.digest_content && item.digest_content.trim().length > 0);
    const skippedItems = items.filter(item => !item.digest_content || item.digest_content.trim().length === 0);

    const results: Array<{
      id: string;
      status: string;
      error?: string;
      nodes_created?: number;
      edges_created?: number;
    }> = [];

    for (const item of skippedItems) {
      results.push({ id: item.id, status: 'skipped', error: 'No digest content' });
      await supabase
        .from('github_ingestion_queue')
        .update({ status: 'failed', error_message: 'No digest content to extract from' })
        .eq('id', item.id);
    }

    // ── Process items ─────────────────────────────────────────────────────────
    const extractionResults = await Promise.allSettled(
      validItems.map(item => extractKnowledgeForItem(item, supabase, Date.now()))
    );

    extractionResults.forEach((result, idx) => {
      const item = validItems[idx];
      if (!item) return;
      if (result.status === 'fulfilled') {
        results.push({
          id: item.id,
          status: result.value.success ? 'completed' : 'failed',
          error: result.value.error,
          nodes_created: result.value.nodesCreated,
          edges_created: result.value.edgesCreated,
        });
      } else {
        results.push({
          id: item.id,
          status: 'failed',
          error: result.reason?.message || 'Unknown error',
        });
      }
    });

    const processed = results.filter(r => r.status === 'completed').length;

    return res.status(200).json({
      success: true,
      processed: results.length,
      completed: processed,
      results,
      duration_ms: Date.now() - startTime,
    });

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[github/extract-knowledge] Fatal error:', err);
    return res.status(500).json({ success: false, error: msg, duration_ms: Date.now() - startTime });
  }
}
