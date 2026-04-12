import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

// Creates domain agents for meeting transcript integrations.
// One agent per user_integration record (e.g., one Circleback connection = one agent).
// Each agent acts as a professional context advisor scoped to that integration's meetings.
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

// ─── TYPES ────────────────────────────────────────────────────────────────────

interface Integration {
  id: string;
  user_id: string;
  integration_slug: string;
  status: string;
  domain_agent_id: string | null;
  config: Record<string, unknown> | null;
  total_items_ingested: number;
}

interface AgentResult {
  integrationId: string;
  integrationSlug: string;
  agentId: string;
  agentName: string;
  created: boolean;
  sourcesLinked: number;
  entityCount: number;
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
    integrationId?: string;  // Create for a specific integration
    dryRun?: boolean;
  };
  const dryRun = body.dryRun === true;

  // ── Step 1: Find meeting integrations ─────────────────────────────────────

  let intQuery = supabase
    .from('user_integrations')
    .select('id, user_id, integration_slug, status, domain_agent_id, config, total_items_ingested')
    .eq('status', 'active');

  if (body.integrationId) {
    intQuery = intQuery.eq('id', body.integrationId);
  }
  if (userId) {
    intQuery = intQuery.eq('user_id', userId);
  }

  const { data: integrations, error: intErr } = await intQuery;
  if (intErr) {
    return res.status(500).json({ error: 'Failed to fetch integrations', detail: intErr.message });
  }

  if (!integrations || integrations.length === 0) {
    return res.status(200).json({ success: true, message: 'No active meeting integrations found', agents: [] });
  }

  const results: AgentResult[] = [];

  // ── Step 2: Create an agent per integration ───────────────────────────────

  for (const integration of integrations as Integration[]) {
    // Skip if agent already exists
    if (integration.domain_agent_id) {
      results.push({
        integrationId: integration.id,
        integrationSlug: integration.integration_slug,
        agentId: integration.domain_agent_id,
        agentName: '(existing)',
        created: false,
        sourcesLinked: 0,
        entityCount: 0,
      });
      continue;
    }

    // Build agent name from integration slug
    const slugNames: Record<string, string> = {
      circleback: 'Work & Meetings (Circleback)',
      microsoft: 'Work & Meetings (Microsoft 365)',
      granola: 'Work & Meetings (Granola)',
      read_ai: 'Work & Meetings (Read AI)',
    };
    const agentName = slugNames[integration.integration_slug] || `Work & Meetings (${integration.integration_slug})`;

    const agentDescription =
      `This advisor has deep contextual knowledge about your professional work, drawn from meeting transcripts ` +
      `ingested via ${integration.integration_slug}. It tracks projects, decisions, commitments, feedback, and team dynamics. ` +
      `It functions as a career coach, project memory, and professional mentor — understanding the patterns ` +
      `in how you work, what you prioritise, and how your professional landscape is evolving.`;

    if (dryRun) {
      // Count meeting sources for this integration
      const { count } = await supabase
        .from('knowledge_sources')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', integration.user_id)
        .eq('source_type', 'Meeting');

      results.push({
        integrationId: integration.id,
        integrationSlug: integration.integration_slug,
        agentId: '(would create)',
        agentName,
        created: false,
        sourcesLinked: count ?? 0,
        entityCount: 0,
      });
      continue;
    }

    // Create the agent
    const { data: newAgent, error: createErr } = await supabase
      .from('domain_agents')
      .insert({
        user_id: integration.user_id,
        playlist_id: null,
        integration_id: integration.id,
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
      console.error(`[create-meeting-agent] Failed to create agent for integration ${integration.id}:`, createErr.message);
      continue;
    }

    const agentId = newAgent.id;

    // Link integration back to agent
    await supabase
      .from('user_integrations')
      .update({ domain_agent_id: agentId })
      .eq('id', integration.id);

    // ── Step 3: Backfill meeting sources for this integration's user ────────
    // Link all Meeting sources for this user that either:
    // - Have this integration_id in metadata, OR
    // - Have no integration_id (from the new webhook path) and belong to this user

    const { data: meetingSources } = await supabase
      .from('knowledge_sources')
      .select('id')
      .eq('user_id', integration.user_id)
      .eq('source_type', 'Meeting');

    const sourceIds = (meetingSources ?? []).map(s => (s as { id: string }).id);

    // Get existing associations
    const { data: existingAssocs } = await supabase
      .from('domain_agent_sources')
      .select('source_id')
      .eq('agent_id', agentId);

    const existingSet = new Set((existingAssocs ?? []).map(a => (a as { source_id: string }).source_id));

    const newRows = sourceIds
      .filter(id => !existingSet.has(id))
      .map(sourceId => ({
        user_id: integration.user_id,
        agent_id: agentId,
        source_id: sourceId,
        association_type: 'primary',
      }));

    let linked = 0;
    for (let i = 0; i < newRows.length; i += 100) {
      const chunk = newRows.slice(i, i + 100);
      const { data: inserted } = await supabase
        .from('domain_agent_sources')
        .upsert(chunk, { onConflict: 'agent_id,source_id', ignoreDuplicates: true })
        .select('id');
      linked += (inserted?.length ?? 0);
    }

    // Count entities
    let entityCount = 0;
    for (let i = 0; i < sourceIds.length; i += 200) {
      const chunk = sourceIds.slice(i, i + 200);
      const { count } = await supabase
        .from('knowledge_nodes')
        .select('id', { count: 'exact', head: true })
        .in('source_id', chunk);
      entityCount += (count ?? 0);
    }

    // Update agent counts
    await supabase
      .from('domain_agents')
      .update({
        source_count: sourceIds.length,
        entity_count: entityCount,
        index_stale: true,
        last_ingestion_at: new Date().toISOString(),
      })
      .eq('id', agentId);

    results.push({
      integrationId: integration.id,
      integrationSlug: integration.integration_slug,
      agentId,
      agentName,
      created: true,
      sourcesLinked: linked,
      entityCount,
    });
  }

  return res.status(200).json({
    success: true,
    dryRun,
    agents: results,
    durationMs: Date.now() - startTime,
  });
}
