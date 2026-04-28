import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

// Creates domain agents from integrations (Circleback, Microsoft 365, future providers).
// Supports three modes:
//   1. Auto-create: one agent per integration that doesn't have one yet
//   2. Combine: merge multiple integrations under one agent
//   3. Backfill: link existing sources to their agent
export const maxDuration = 120;

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const CRON_SECRET = process.env.CRON_SECRET;

const getSupabase = () => createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

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

// ─── CONSTANTS ────────────────────────────────────────────────────────────────

// Default names and descriptions per integration type
const INTEGRATION_PROFILES: Record<string, { name: string; description: string; sourceTypes: string[]; reasoning: string }> = {
  circleback: {
    name: 'Work & Meetings',
    description: 'This advisor has deep contextual knowledge about your professional work, drawn from meeting transcripts. It tracks projects, decisions, commitments, feedback, and team dynamics. It functions as a career coach, project memory, and professional mentor.',
    sourceTypes: ['meeting'],
    reasoning: 'Contextual and interpersonal — draws on professional relationships, project histories, and organisational dynamics.',
  },
  microsoft: {
    name: 'Work & Communications',
    description: 'This advisor understands your professional communications and schedule, drawn from emails, calendar events, and meeting transcripts via Microsoft 365. It tracks commitments, correspondence patterns, and organisational context.',
    sourceTypes: ['meeting', 'research'],
    reasoning: 'Structured and communication-focused — understands email threads, meeting outcomes, and professional correspondence patterns.',
  },
  granola: {
    name: 'Meeting Notes',
    description: 'This advisor specialises in meeting intelligence from Granola, capturing structured notes, key decisions, and action items from your meetings.',
    sourceTypes: ['meeting'],
    reasoning: 'Structured note-taking perspective — focuses on decisions, action items, and meeting outcomes.',
  },
  read_ai: {
    name: 'Meeting Intelligence',
    description: 'This advisor provides deep meeting analysis from Read AI, including sentiment, engagement, and conversation dynamics alongside content.',
    sourceTypes: ['meeting'],
    reasoning: 'Analytical — combines content understanding with engagement and communication pattern analysis.',
  },
};

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
  action: 'created' | 'existing' | 'combined' | 'backfilled';
  sourcesLinked: number;
  entityCount: number;
}

// ─── HANDLER ──────────────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { userId, isCron } = await verifyUserAuth(req);
  if (!userId && !isCron) return res.status(401).json({ error: 'Unauthorized' });

  const supabase = getSupabase();
  const startTime = Date.now();

  const body = (req.body ?? {}) as {
    mode?: 'auto' | 'combine';
    integrationId?: string;         // For single integration
    integrationIds?: string[];      // For combining multiple into one agent
    targetAgentId?: string;         // Combine into existing agent
    agentName?: string;             // Custom name override
    agentDescription?: string;      // Custom description override
    dryRun?: boolean;
  };

  const mode = body.mode || 'auto';
  const dryRun = body.dryRun === true;
  const results: AgentResult[] = [];

  // ── AUTO MODE: create one agent per integration that doesn't have one ─────

  if (mode === 'auto') {
    let intQuery = supabase
      .from('user_integrations')
      .select('id, user_id, integration_slug, status, domain_agent_id, config, total_items_ingested')
      .eq('status', 'active');

    if (body.integrationId) intQuery = intQuery.eq('id', body.integrationId);
    if (userId) intQuery = intQuery.eq('user_id', userId);

    const { data: integrations, error: intErr } = await intQuery;
    if (intErr) return res.status(500).json({ error: 'Failed to fetch integrations', detail: intErr.message });
    if (!integrations || integrations.length === 0) {
      return res.status(200).json({ success: true, message: 'No active integrations found', agents: [] });
    }

    for (const integration of integrations as Integration[]) {
      if (integration.domain_agent_id) {
        results.push({ integrationId: integration.id, integrationSlug: integration.integration_slug, agentId: integration.domain_agent_id, agentName: '(existing)', action: 'existing', sourcesLinked: 0, entityCount: 0 });
        continue;
      }

      const profile = INTEGRATION_PROFILES[integration.integration_slug] || {
        name: `${integration.integration_slug} Agent`,
        description: `Domain expert built from ${integration.integration_slug} integration content.`,
        sourceTypes: ['meeting', 'research', 'file'],
        reasoning: null,
      };

      const agentName = body.agentName || `${profile.name} (${integration.integration_slug})`;
      const agentDescription = body.agentDescription || profile.description;

      if (dryRun) {
        const { count } = await supabase
          .from('knowledge_sources')
          .select('id', { count: 'exact', head: true })
          .eq('user_id', integration.user_id)
          .in('source_type', profile.sourceTypes);

        results.push({ integrationId: integration.id, integrationSlug: integration.integration_slug, agentId: '(would create)', agentName, action: 'created', sourcesLinked: count ?? 0, entityCount: 0 });
        continue;
      }

      // Create agent
      const { data: newAgent, error: createErr } = await supabase
        .from('domain_agents')
        .insert({
          user_id: integration.user_id,
          playlist_id: null,
          integration_id: integration.id,
          name: agentName,
          description: agentDescription,
          reasoning_style: profile.reasoning,
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
        console.error(`[create-integration-agent] Failed for ${integration.id}:`, createErr.message);
        continue;
      }

      const agentId = newAgent.id;

      // Link integration back to agent
      await supabase.from('user_integrations').update({ domain_agent_id: agentId }).eq('id', integration.id);

      // Create junction link
      await supabase.from('agent_integration_links').upsert({
        agent_id: agentId,
        integration_id: integration.id,
        user_id: integration.user_id,
        source_types: profile.sourceTypes,
      }, { onConflict: 'agent_id,integration_id', ignoreDuplicates: true });

      // Backfill sources
      const linked = await backfillSources(supabase, agentId, integration.user_id, profile.sourceTypes);

      results.push({ integrationId: integration.id, integrationSlug: integration.integration_slug, agentId, agentName, action: 'created', sourcesLinked: linked.sourcesLinked, entityCount: linked.entityCount });
    }
  }

  // ── COMBINE MODE: link multiple integrations to one agent ─────────────────

  if (mode === 'combine') {
    const integrationIds = body.integrationIds || (body.integrationId ? [body.integrationId] : []);
    if (integrationIds.length === 0) {
      return res.status(400).json({ error: 'No integration IDs provided for combine mode' });
    }

    // Fetch integrations
    const { data: integrations } = await supabase
      .from('user_integrations')
      .select('id, user_id, integration_slug, status, domain_agent_id, config, total_items_ingested')
      .in('id', integrationIds);

    if (!integrations || integrations.length === 0) {
      return res.status(404).json({ error: 'No integrations found with provided IDs' });
    }

    const targetUserId = userId || (integrations[0] as Integration).user_id;

    // Determine target agent — use existing or create new
    let agentId = body.targetAgentId || null;

    if (!agentId) {
      // Combine all source types from all integrations
      const allSourceTypes = new Set<string>();
      for (const int of integrations as Integration[]) {
        const profile = INTEGRATION_PROFILES[int.integration_slug];
        if (profile) profile.sourceTypes.forEach(t => allSourceTypes.add(t));
        else ['meeting', 'research', 'file'].forEach(t => allSourceTypes.add(t));
      }

      const slugs = (integrations as Integration[]).map(i => i.integration_slug);
      const agentName = body.agentName || 'Work & Professional Context';
      const agentDescription = body.agentDescription ||
        `This advisor combines knowledge from multiple professional sources (${slugs.join(', ')}). ` +
        'It has a comprehensive view of your work context — meetings, communications, documents — and can draw connections across all of them.';

      if (dryRun) {
        const { count } = await supabase
          .from('knowledge_sources')
          .select('id', { count: 'exact', head: true })
          .eq('user_id', targetUserId)
          .in('source_type', [...allSourceTypes]);

        return res.status(200).json({
          success: true, dryRun: true,
          wouldCreate: { agentName, integrations: slugs, sourceTypes: [...allSourceTypes], sourceCount: count ?? 0 },
        });
      }

      const { data: newAgent, error: createErr } = await supabase
        .from('domain_agents')
        .insert({
          user_id: targetUserId,
          playlist_id: null,
          name: agentName,
          description: agentDescription,
          reasoning_style: 'Holistic professional context — combines meeting notes, communications, and documents to provide comprehensive work intelligence.',
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

      if (createErr) return res.status(500).json({ error: 'Failed to create agent', detail: createErr.message });
      agentId = newAgent.id;
    }

    // Link all integrations to this agent
    for (const int of integrations as Integration[]) {
      const profile = INTEGRATION_PROFILES[int.integration_slug];
      const sourceTypes = profile?.sourceTypes || ['meeting', 'research', 'file'];

      await supabase.from('user_integrations').update({ domain_agent_id: agentId }).eq('id', int.id);

      await supabase.from('agent_integration_links').upsert({
        agent_id: agentId,
        integration_id: int.id,
        user_id: int.user_id,
        source_types: sourceTypes,
      }, { onConflict: 'agent_id,integration_id', ignoreDuplicates: true });
    }

    // Backfill all source types from all linked integrations
    const allTypes = new Set<string>();
    for (const int of integrations as Integration[]) {
      const profile = INTEGRATION_PROFILES[int.integration_slug];
      (profile?.sourceTypes || ['meeting', 'research', 'file']).forEach(t => allTypes.add(t));
    }

    const linked = await backfillSources(supabase, agentId, targetUserId, [...allTypes]);

    for (const int of integrations as Integration[]) {
      results.push({
        integrationId: int.id,
        integrationSlug: int.integration_slug,
        agentId: agentId!,
        agentName: body.agentName || 'Work & Professional Context',
        action: 'combined',
        sourcesLinked: linked.sourcesLinked,
        entityCount: linked.entityCount,
      });
    }
  }

  return res.status(200).json({
    success: true,
    dryRun,
    agents: results,
    durationMs: Date.now() - startTime,
  });
}

// ─── BACKFILL HELPER ────────────────────────────────────────────────────────

async function backfillSources(
  supabase: ReturnType<typeof getSupabase>,
  agentId: string,
  userId: string,
  sourceTypes: string[]
): Promise<{ sourcesLinked: number; entityCount: number }> {
  // Fetch all sources of matching types for this user
  const { data: sources } = await supabase
    .from('knowledge_sources')
    .select('id')
    .eq('user_id', userId)
    .in('source_type', sourceTypes);

  const sourceIds = (sources ?? []).map(s => (s as { id: string }).id);
  if (sourceIds.length === 0) return { sourcesLinked: 0, entityCount: 0 };

  // Get existing to avoid duplicates
  const { data: existing } = await supabase
    .from('domain_agent_sources')
    .select('source_id')
    .eq('agent_id', agentId);

  const existingSet = new Set((existing ?? []).map(a => (a as { source_id: string }).source_id));

  const newRows = sourceIds
    .filter(id => !existingSet.has(id))
    .map(sourceId => ({
      user_id: userId,
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

  // Update agent
  await supabase
    .from('domain_agents')
    .update({
      source_count: sourceIds.length,
      entity_count: entityCount,
      index_stale: true,
      last_ingestion_at: new Date().toISOString(),
    })
    .eq('id', agentId);

  return { sourcesLinked: linked, entityCount };
}
