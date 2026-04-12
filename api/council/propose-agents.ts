import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

// Detects clusters of unassigned skills and proposes new domain experts.
// Skills are clustered by domain label first, then by embedding similarity
// for skills in the "general" domain. Clusters with 3+ skills become proposals.
export const maxDuration = 120;

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY!;
const CRON_SECRET = process.env.CRON_SECRET;

const getSupabase = () => createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const MIN_CLUSTER_SIZE = 3;

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

// ─── GEMINI HELPER ────────────────────────────────────────────────────────────

async function callGemini<T>(systemPrompt: string, userContent: string): Promise<T> {
  const response = await fetch(
    `${GEMINI_BASE}/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents: [{ parts: [{ text: userContent }] }],
        generationConfig: { temperature: 0.1, responseMimeType: 'application/json' },
      }),
      signal: AbortSignal.timeout(60000),
    }
  );

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Gemini call failed: ${response.status} ${errText.slice(0, 300)}`);
  }

  const data = await response.json() as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('No response from Gemini');
  return JSON.parse(text) as T;
}

// ─── TYPES ────────────────────────────────────────────────────────────────────

interface SkillRow {
  id: string;
  user_id: string;
  name: string;
  title: string;
  description: string;
  domain: string | null;
  tags: string[];
  source_ids: string[];
  status: string;
}

interface Cluster {
  domain: string;
  skills: SkillRow[];
  proposedName: string;
  proposedDescription: string;
}

interface GeminiNamingResult {
  clusters: Array<{
    domain: string;
    proposed_name: string;
    proposed_description: string;
  }>;
}

// ─── MAIN LOGIC ─────────────────────────────────────────────────────────────

async function findUnassignedSkills(supabase: SupabaseClient, userId: string | null): Promise<SkillRow[]> {
  // Fetch all active/draft skills
  let skillQuery = supabase
    .from('knowledge_skills')
    .select('id, user_id, name, title, description, domain, tags, source_ids, status')
    .in('status', ['draft', 'active']);

  if (userId) skillQuery = skillQuery.eq('user_id', userId);

  const { data: skills, error } = await skillQuery;
  if (error) throw error;

  // Fetch all assigned skill IDs
  let assignedQuery = supabase
    .from('domain_agent_skills')
    .select('skill_id');

  if (userId) assignedQuery = assignedQuery.eq('user_id', userId);

  const { data: assigned } = await assignedQuery;
  const assignedIds = new Set((assigned ?? []).map(a => (a as { skill_id: string }).skill_id));

  return ((skills ?? []) as SkillRow[]).filter(s => !assignedIds.has(s.id));
}

function clusterByDomain(skills: SkillRow[]): Map<string, SkillRow[]> {
  const clusters = new Map<string, SkillRow[]>();
  for (const s of skills) {
    const domain = s.domain || 'general';
    const arr = clusters.get(domain) || [];
    arr.push(s);
    clusters.set(domain, arr);
  }
  return clusters;
}

async function generateClusterNames(clusters: Cluster[]): Promise<Cluster[]> {
  if (clusters.length === 0) return [];

  const clusterSummaries = clusters.map(c => ({
    domain: c.domain,
    skill_titles: c.skills.map(s => s.title),
    skill_descriptions: c.skills.map(s => s.description.slice(0, 100)),
    tags: [...new Set(c.skills.flatMap(s => s.tags))].slice(0, 20),
  }));

  const result = await callGemini<GeminiNamingResult>(
    `You are naming new domain experts for a personal knowledge graph system.

For each cluster of skills, generate:
- proposed_name: A short, clear name for the domain expert (2-4 words, like "Financial Analysis", "Product Design", "AI Engineering"). Should feel like a job title or area of expertise.
- proposed_description: 2-3 sentences describing what this expert would know about and when to consult them.

Return JSON: { "clusters": [{ "domain": "...", "proposed_name": "...", "proposed_description": "..." }] }`,
    JSON.stringify(clusterSummaries)
  );

  for (const named of (result.clusters || [])) {
    const cluster = clusters.find(c => c.domain === named.domain);
    if (cluster) {
      cluster.proposedName = named.proposed_name;
      cluster.proposedDescription = named.proposed_description;
    }
  }

  return clusters;
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
    dryRun?: boolean;
    minClusterSize?: number;
    approveAll?: boolean;  // Auto-approve and create agents
  };
  const dryRun = body.dryRun === true;
  const minSize = body.minClusterSize ?? MIN_CLUSTER_SIZE;
  const approveAll = body.approveAll === true;

  // ── Step 1: Find unassigned skills ────────────────────────────────────────

  const unassigned = await findUnassignedSkills(supabase, userId);

  if (unassigned.length === 0) {
    return res.status(200).json({
      success: true,
      message: 'All skills are assigned to domain experts',
      proposals: [],
    });
  }

  // ── Step 2: Cluster by domain ─────────────────────────────────────────────

  const domainClusters = clusterByDomain(unassigned);

  // Filter to clusters meeting minimum size
  const viableClusters: Cluster[] = [];
  const tooSmall: Array<{ domain: string; count: number }> = [];

  for (const [domain, skills] of domainClusters) {
    if (skills.length >= minSize) {
      viableClusters.push({
        domain,
        skills,
        proposedName: domain.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
        proposedDescription: '',
      });
    } else {
      tooSmall.push({ domain, count: skills.length });
    }
  }

  if (viableClusters.length === 0) {
    return res.status(200).json({
      success: true,
      message: `${unassigned.length} unassigned skills found but no cluster meets the minimum size of ${minSize}`,
      unassignedCount: unassigned.length,
      smallClusters: tooSmall,
      proposals: [],
    });
  }

  // ── Step 3: Generate names via Gemini ─────────────────────────────────────

  const namedClusters = await generateClusterNames(viableClusters);

  // ── Step 4: Check for existing proposals (avoid duplicates) ───────────────

  const { data: existingProposals } = await supabase
    .from('agent_proposals')
    .select('domain_cluster, status')
    .eq('status', 'pending');

  const existingDomains = new Set(
    (existingProposals ?? []).map(p => (p as { domain_cluster: string }).domain_cluster)
  );

  // ── Step 5: Create proposals (or auto-approve) ───────────────────────────

  const proposals: Array<{
    domain: string;
    proposedName: string;
    proposedDescription: string;
    skillCount: number;
    skillTitles: string[];
    status: string;
    agentId?: string;
  }> = [];

  for (const cluster of namedClusters) {
    // Skip if already proposed
    if (existingDomains.has(cluster.domain)) {
      proposals.push({
        domain: cluster.domain,
        proposedName: cluster.proposedName,
        proposedDescription: cluster.proposedDescription,
        skillCount: cluster.skills.length,
        skillTitles: cluster.skills.map(s => s.title),
        status: 'already_proposed',
      });
      continue;
    }

    const skillIds = cluster.skills.map(s => s.id);
    const sourceIds = [...new Set(cluster.skills.flatMap(s => s.source_ids || []))];
    const targetUserId = userId || cluster.skills[0]?.user_id;

    if (dryRun) {
      proposals.push({
        domain: cluster.domain,
        proposedName: cluster.proposedName,
        proposedDescription: cluster.proposedDescription,
        skillCount: cluster.skills.length,
        skillTitles: cluster.skills.map(s => s.title),
        status: 'would_propose',
      });
      continue;
    }

    if (approveAll && targetUserId) {
      // Auto-create the agent
      const { data: newAgent, error: agentErr } = await supabase
        .from('domain_agents')
        .insert({
          user_id: targetUserId,
          playlist_id: null,
          name: cluster.proposedName,
          description: cluster.proposedDescription,
          reasoning_style: null,
          expertise_index: {},
          awareness_register: {},
          health_status: 'initialising',
          linked_anchor_ids: [],
          source_count: sourceIds.length,
          entity_count: 0,
          index_stale: true,
          is_active: true,
        })
        .select('id')
        .single();

      if (agentErr) {
        console.error(`[propose-agents] Failed to create agent for ${cluster.domain}:`, agentErr.message);
        continue;
      }

      const agentId = newAgent.id;

      // Link skills to agent
      const skillRows = skillIds.map(sid => ({
        agent_id: agentId,
        skill_id: sid,
        user_id: targetUserId,
        match_method: 'manual',
        relevance: 1.0,
        ingested: false,
      }));

      await supabase
        .from('domain_agent_skills')
        .upsert(skillRows, { onConflict: 'agent_id,skill_id', ignoreDuplicates: true });

      // Link sources to agent
      if (sourceIds.length > 0) {
        const sourceRows = sourceIds.map(sid => ({
          user_id: targetUserId,
          agent_id: agentId,
          source_id: sid,
          association_type: 'associated',
        }));

        for (let i = 0; i < sourceRows.length; i += 100) {
          await supabase
            .from('domain_agent_sources')
            .upsert(sourceRows.slice(i, i + 100), { onConflict: 'agent_id,source_id', ignoreDuplicates: true });
        }
      }

      // Save as approved proposal
      await supabase.from('agent_proposals').insert({
        user_id: targetUserId,
        proposed_name: cluster.proposedName,
        proposed_description: cluster.proposedDescription,
        domain_cluster: cluster.domain,
        skill_ids: skillIds,
        source_ids: sourceIds,
        skill_count: skillIds.length,
        status: 'approved',
        approved_agent_id: agentId,
        resolved_at: new Date().toISOString(),
      });

      proposals.push({
        domain: cluster.domain,
        proposedName: cluster.proposedName,
        proposedDescription: cluster.proposedDescription,
        skillCount: cluster.skills.length,
        skillTitles: cluster.skills.map(s => s.title),
        status: 'auto_approved',
        agentId,
      });

    } else if (targetUserId) {
      // Save as pending proposal for user approval
      await supabase.from('agent_proposals').insert({
        user_id: targetUserId,
        proposed_name: cluster.proposedName,
        proposed_description: cluster.proposedDescription,
        domain_cluster: cluster.domain,
        skill_ids: skillIds,
        source_ids: sourceIds,
        skill_count: skillIds.length,
        status: 'pending',
      });

      proposals.push({
        domain: cluster.domain,
        proposedName: cluster.proposedName,
        proposedDescription: cluster.proposedDescription,
        skillCount: cluster.skills.length,
        skillTitles: cluster.skills.map(s => s.title),
        status: 'proposed',
      });
    }
  }

  return res.status(200).json({
    success: true,
    unassignedSkillsFound: unassigned.length,
    clustersDetected: viableClusters.length,
    clustersBelowThreshold: tooSmall,
    proposals,
    durationMs: Date.now() - startTime,
  });
}
