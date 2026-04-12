import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

// Creates a domain agent for meeting transcripts and backfills existing meeting sources.
// This agent acts as a professional context advisor — career coach, project memory, work mentor.
export const maxDuration = 120;

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const CRON_SECRET = process.env.CRON_SECRET;

const getSupabase = () => createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

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

// ─── HANDLER ──────────────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { userId, isCron } = await verifyUserAuth(req);
  if (!userId && !isCron) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const supabase = getSupabase();
  const startTime = Date.now();

  const body = (req.body ?? {}) as {
    agentName?: string;
    agentDescription?: string;
    dryRun?: boolean;
  };

  const agentName = body.agentName || 'Work & Meetings';
  const agentDescription = body.agentDescription ||
    'This advisor has deep contextual knowledge about your professional work, drawn from meeting transcripts. ' +
    'It tracks projects, decisions, commitments, feedback, and team dynamics across all your meetings. ' +
    'It functions as a career coach, project memory, and professional mentor — understanding not just what was discussed, ' +
    'but the patterns in how you work, what you prioritise, and how your professional landscape is evolving.';
  const dryRun = body.dryRun === true;

  // ── Step 1: Find or create the meeting agent ──────────────────────────────

  // Resolve user_id — if cron, find from existing meeting sources
  let targetUserId = userId;
  if (!targetUserId) {
    const { data: anySrc } = await supabase
      .from('knowledge_sources')
      .select('user_id')
      .eq('source_type', 'Meeting')
      .limit(1);
    targetUserId = (anySrc?.[0] as { user_id: string } | undefined)?.user_id ?? null;
  }

  if (!targetUserId) {
    return res.status(200).json({ success: true, message: 'No meeting sources found — nothing to do' });
  }

  // Check if a meeting agent already exists for this user
  const { data: existingAgents } = await supabase
    .from('domain_agents')
    .select('id, name')
    .eq('user_id', targetUserId)
    .is('playlist_id', null) // Meeting agents have no playlist
    .ilike('name', '%meeting%');

  let agentId: string;

  if (existingAgents && existingAgents.length > 0) {
    agentId = existingAgents[0]!.id;
    console.log(`[create-meeting-agent] Found existing meeting agent: ${agentId}`);
  } else {
    if (dryRun) {
      // Count what we'd do
      const { count: meetingCount } = await supabase
        .from('knowledge_sources')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', targetUserId)
        .eq('source_type', 'Meeting');

      return res.status(200).json({
        success: true,
        dryRun: true,
        wouldCreate: {
          agentName,
          agentDescription: agentDescription.slice(0, 100) + '...',
          meetingSources: meetingCount ?? 0,
        },
      });
    }

    // Create the agent
    const { data: newAgent, error: createErr } = await supabase
      .from('domain_agents')
      .insert({
        user_id: targetUserId,
        playlist_id: null,
        name: agentName,
        description: agentDescription,
        reasoning_style: 'Contextual and interpersonal — draws on professional relationships, project histories, and organisational dynamics to provide advice grounded in your actual work experience.',
        expertise_index: {},
        awareness_register: {},
        health_status: 'initialising',
        linked_anchor_ids: [],
        source_count: 0,
        entity_count: 0,
        index_stale: true,
        is_active: true,
      })
      .select('id')
      .single();

    if (createErr) {
      return res.status(500).json({ error: 'Failed to create agent', detail: createErr.message });
    }

    agentId = newAgent.id;
    console.log(`[create-meeting-agent] Created new meeting agent: ${agentId}`);
  }

  // ── Step 2: Backfill all existing meeting sources ─────────────────────────

  // Fetch all meeting source IDs for this user
  const { data: meetingSources, error: srcErr } = await supabase
    .from('knowledge_sources')
    .select('id')
    .eq('user_id', targetUserId)
    .eq('source_type', 'Meeting');

  if (srcErr) {
    return res.status(500).json({ error: 'Failed to fetch meeting sources', detail: srcErr.message });
  }

  const sourceIds = (meetingSources ?? []).map(s => (s as { id: string }).id);

  if (sourceIds.length === 0) {
    return res.status(200).json({
      success: true,
      agentId,
      agentName,
      sourcesLinked: 0,
      message: 'Agent created but no meeting sources found to link',
    });
  }

  // Get existing associations to avoid duplicates
  const { data: existingAssocs } = await supabase
    .from('domain_agent_sources')
    .select('source_id')
    .eq('agent_id', agentId);

  const existingSourceIds = new Set(
    (existingAssocs ?? []).map(a => (a as { source_id: string }).source_id)
  );

  // Build new association rows
  const newAssocRows = sourceIds
    .filter(id => !existingSourceIds.has(id))
    .map(sourceId => ({
      user_id: targetUserId!,
      agent_id: agentId,
      source_id: sourceId,
      association_type: 'primary',
    }));

  let linked = 0;

  if (newAssocRows.length > 0) {
    // Bulk upsert in chunks
    for (let i = 0; i < newAssocRows.length; i += 100) {
      const chunk = newAssocRows.slice(i, i + 100);
      const { data: inserted, error: linkErr } = await supabase
        .from('domain_agent_sources')
        .upsert(chunk, { onConflict: 'agent_id,source_id', ignoreDuplicates: true })
        .select('id');

      if (linkErr) {
        console.error(`[create-meeting-agent] Link chunk ${i} failed:`, linkErr.message);
      } else {
        linked += (inserted?.length ?? 0);
      }
    }
  }

  // ── Step 3: Update agent counts and mark stale ────────────────────────────

  // Count entities across all meeting sources
  let entityCount = 0;
  // Process in batches of 200 source IDs
  for (let i = 0; i < sourceIds.length; i += 200) {
    const chunk = sourceIds.slice(i, i + 200);
    const { count } = await supabase
      .from('knowledge_nodes')
      .select('id', { count: 'exact', head: true })
      .in('source_id', chunk);
    entityCount += (count ?? 0);
  }

  await supabase
    .from('domain_agents')
    .update({
      source_count: sourceIds.length,
      entity_count: entityCount,
      index_stale: true,
      last_ingestion_at: new Date().toISOString(),
    })
    .eq('id', agentId);

  return res.status(200).json({
    success: true,
    agentId,
    agentName,
    totalMeetingSources: sourceIds.length,
    newSourcesLinked: linked,
    alreadyLinked: existingSourceIds.size,
    entityCount,
    indexStale: true,
    message: `Meeting agent "${agentName}" is ready with ${sourceIds.length} sources and ${entityCount} entities. Run council cron to build expertise index.`,
    durationMs: Date.now() - startTime,
  });
}
