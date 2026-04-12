import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

// Retroactive and on-demand skill → agent assignment.
// Pass 1: source overlap (deterministic). Pass 2: Gemini semantic matching.
// After assignment, marks agents index_stale so the nightly cron recalibrates.
export const maxDuration = 300;

// ─── ENVIRONMENT ───────────────────────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY!;
const CRON_SECRET = process.env.CRON_SECRET;

const getSupabase = () => createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

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

interface AgentRow {
  id: string;
  user_id: string;
  name: string;
  description: string | null;
  expertise_index: ExpertiseIndex | Record<string, never>;
  source_count: number;
}

interface ExpertiseIndex {
  summary?: string;
  core_themes?: string[];
  strongest_areas?: Array<{ topic: string; source_count: number; key_entities: string[] }>;
}

interface AgentSourceRow {
  agent_id: string;
  source_id: string;
}

interface GeminiMatchResult {
  assignments: Array<{
    skill_name: string;
    agent_name: string;
    relevance: number;
    rationale: string;
  }>;
}

interface AssignmentRecord {
  agent_id: string;
  skill_id: string;
  user_id: string;
  match_method: 'source_overlap' | 'gemini_match';
  relevance: number;
}

interface SkillAssignmentDetail {
  skill_id: string;
  skill_name: string;
  agent_id: string;
  agent_name: string;
  match_method: string;
  relevance: number;
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

// ─── GEMINI HELPER ────────────────────────────────────────────────────────────

async function callGemini<T>(systemPrompt: string, userContent: string, timeoutMs = 120000): Promise<T> {
  const response = await fetch(
    `${GEMINI_BASE}/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents: [{ parts: [{ text: userContent }] }],
        generationConfig: {
          temperature: 0.1,
          responseMimeType: 'application/json',
        },
      }),
      signal: AbortSignal.timeout(timeoutMs),
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

  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Invalid JSON from Gemini: ${text.slice(0, 300)}`);
  }
}

// ─── PASS 1: SOURCE OVERLAP ──────────────────────────────────────────────────

function computeSourceOverlapMatches(
  skills: SkillRow[],
  agents: AgentRow[],
  agentSources: AgentSourceRow[]
): AssignmentRecord[] {
  // Build a map: source_id → set of agent_ids
  const sourceToAgents = new Map<string, Set<string>>();
  for (const row of agentSources) {
    let agents = sourceToAgents.get(row.source_id);
    if (!agents) {
      agents = new Set();
      sourceToAgents.set(row.source_id, agents);
    }
    agents.add(row.agent_id);
  }

  const assignments: AssignmentRecord[] = [];

  for (const skill of skills) {
    if (!skill.source_ids || skill.source_ids.length === 0) continue;

    // Find all agents that share at least one source with this skill
    const matchedAgentIds = new Set<string>();
    for (const sourceId of skill.source_ids) {
      const agentIds = sourceToAgents.get(sourceId);
      if (agentIds) {
        for (const agentId of agentIds) {
          matchedAgentIds.add(agentId);
        }
      }
    }

    for (const agentId of matchedAgentIds) {
      // Only match if user_id aligns
      const agent = agents.find(a => a.id === agentId);
      if (agent && agent.user_id === skill.user_id) {
        assignments.push({
          agent_id: agentId,
          skill_id: skill.id,
          user_id: skill.user_id,
          match_method: 'source_overlap',
          relevance: 1.0,
        });
      }
    }
  }

  return assignments;
}

// ─── PASS 2: GEMINI SEMANTIC MATCHING ────────────────────────────────────────

async function computeGeminiMatches(
  unmatchedSkills: SkillRow[],
  agents: AgentRow[],
  minRelevance: number
): Promise<AssignmentRecord[]> {
  if (unmatchedSkills.length === 0 || agents.length === 0) return [];

  const assignments: AssignmentRecord[] = [];

  // Build agent summaries for the prompt
  const agentSummaries = agents.map(a => {
    const ei = a.expertise_index as ExpertiseIndex;
    return {
      name: a.name,
      id: a.id,
      description: a.description || 'No description',
      core_themes: ei.core_themes || [],
      strongest_areas: (ei.strongest_areas || []).map(sa => sa.topic),
    };
  });

  // Process in batches of 10 skills per Gemini call
  const BATCH_SIZE = 10;
  for (let i = 0; i < unmatchedSkills.length; i += BATCH_SIZE) {
    const batch = unmatchedSkills.slice(i, i + BATCH_SIZE);

    const skillSummaries = batch.map(s => ({
      name: s.name,
      id: s.id,
      title: s.title,
      description: s.description,
      domain: s.domain,
      tags: s.tags,
    }));

    const systemPrompt = `You are a knowledge management system that matches skills to domain expert agents.

For each skill, determine which agents (if any) would benefit from having this skill in their knowledge base. Consider:
1. Topic overlap between the skill's domain/tags and the agent's core themes and strongest areas.
2. Whether the skill's methodology would enhance the agent's reasoning capabilities.
3. Cross-domain relevance — a skill might be useful to an agent even if domains differ (e.g., a "structured thinking" skill for a "data analysis" agent).

Rules:
- A skill can match 0, 1, or multiple agents.
- Only assign if relevance ≥ ${minRelevance}. Be selective — not every skill needs an agent.
- relevance is a float 0.0–1.0: 1.0 = core to the agent's domain, 0.7 = clearly useful, 0.5 = tangentially relevant.
- Return an "assignments" array. Each entry has: skill_name (string), agent_name (string), relevance (float), rationale (one sentence).
- If a skill matches no agents, omit it from the array entirely.`;

    const userContent = `AGENTS:
${JSON.stringify(agentSummaries, null, 2)}

SKILLS TO MATCH:
${JSON.stringify(skillSummaries, null, 2)}`;

    try {
      const result = await callGemini<GeminiMatchResult>(systemPrompt, userContent);

      if (result.assignments && Array.isArray(result.assignments)) {
        for (const match of result.assignments) {
          if (match.relevance < minRelevance) continue;

          const skill = batch.find(s => s.name === match.skill_name);
          const agent = agents.find(a => a.name === match.agent_name);

          if (skill && agent && agent.user_id === skill.user_id) {
            assignments.push({
              agent_id: agent.id,
              skill_id: skill.id,
              user_id: skill.user_id,
              match_method: 'gemini_match',
              relevance: Math.min(match.relevance, 1.0),
            });
          }
        }
      }
    } catch (err) {
      console.error(`[assign-skills] Gemini batch ${i / BATCH_SIZE} failed:`, String(err));
      // Continue with remaining batches rather than failing the whole run
    }

    // Rate limit pause between batches
    if (i + BATCH_SIZE < unmatchedSkills.length) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  return assignments;
}

// ─── WRITE ASSIGNMENTS & MARK STALE ─────────────────────────────────────────

async function writeAssignments(
  supabase: SupabaseClient,
  assignments: AssignmentRecord[]
): Promise<{ written: number; skippedDuplicate: number }> {
  if (assignments.length === 0) return { written: 0, skippedDuplicate: 0 };

  let written = 0;
  let skippedDuplicate = 0;

  // Bulk upsert in chunks of 100
  const CHUNK_SIZE = 100;
  for (let i = 0; i < assignments.length; i += CHUNK_SIZE) {
    const chunk = assignments.slice(i, i + CHUNK_SIZE);

    const rows = chunk.map(a => ({
      agent_id: a.agent_id,
      skill_id: a.skill_id,
      user_id: a.user_id,
      match_method: a.match_method,
      relevance: a.relevance,
      ingested: false,
    }));

    const { data, error } = await supabase
      .from('domain_agent_skills')
      .upsert(rows, { onConflict: 'agent_id,skill_id', ignoreDuplicates: true })
      .select('id');

    if (error) {
      console.error(`[assign-skills] Upsert chunk ${i / CHUNK_SIZE} failed:`, error.message);
    } else {
      written += (data?.length ?? 0);
      skippedDuplicate += chunk.length - (data?.length ?? 0);
    }
  }

  return { written, skippedDuplicate };
}

async function addSkillSourcesToAgents(
  supabase: SupabaseClient,
  assignments: AssignmentRecord[],
  skills: SkillRow[]
): Promise<number> {
  // Build skill_id → source_ids lookup
  const skillSourceMap = new Map<string, string[]>();
  for (const skill of skills) {
    if (skill.source_ids && skill.source_ids.length > 0) {
      skillSourceMap.set(skill.id, skill.source_ids);
    }
  }

  const rows: Array<{ agent_id: string; source_id: string; user_id: string; association_type: string }> = [];

  for (const assignment of assignments) {
    const sourceIds = skillSourceMap.get(assignment.skill_id);
    if (!sourceIds) continue;

    for (const sourceId of sourceIds) {
      rows.push({
        agent_id: assignment.agent_id,
        source_id: sourceId,
        user_id: assignment.user_id,
        association_type: 'associated',
      });
    }
  }

  if (rows.length === 0) return 0;

  let added = 0;
  const CHUNK_SIZE = 100;
  for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
    const chunk = rows.slice(i, i + CHUNK_SIZE);
    const { data, error } = await supabase
      .from('domain_agent_sources')
      .upsert(chunk, { onConflict: 'agent_id,source_id', ignoreDuplicates: true })
      .select('id');

    if (error) {
      console.error(`[assign-skills] domain_agent_sources upsert chunk failed:`, error.message);
    } else {
      added += (data?.length ?? 0);
    }
  }

  return added;
}

async function markAgentsStale(
  supabase: SupabaseClient,
  agentIds: string[]
): Promise<number> {
  if (agentIds.length === 0) return 0;

  const uniqueIds = [...new Set(agentIds)];
  const { error } = await supabase
    .from('domain_agents')
    .update({ index_stale: true, last_ingestion_at: new Date().toISOString() })
    .in('id', uniqueIds);

  if (error) {
    console.error(`[assign-skills] Failed to mark agents stale:`, error.message);
    return 0;
  }

  return uniqueIds.length;
}

// ─── MAIN HANDLER ─────────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS
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

  const body = (req.body ?? {}) as {
    mode?: 'backfill' | 'single';
    skillId?: string;
    dryRun?: boolean;
    minRelevance?: number;
  };

  const mode = body.mode || 'backfill';
  const dryRun = body.dryRun === true;
  const minRelevance = body.minRelevance ?? 0.5;
  const startTime = Date.now();

  const supabase = getSupabase();

  // ─── Fetch skills ──────────────────────────────────────────────────────────

  let skillsQuery = supabase
    .from('knowledge_skills')
    .select('id, user_id, name, title, description, domain, tags, source_ids, status')
    .in('status', ['draft', 'active']);

  if (userId) {
    skillsQuery = skillsQuery.eq('user_id', userId);
  }

  if (mode === 'single' && body.skillId) {
    skillsQuery = skillsQuery.eq('id', body.skillId);
  }

  const { data: rawSkills, error: skillsErr } = await skillsQuery;
  if (skillsErr) {
    return res.status(500).json({ error: 'Failed to fetch skills', detail: skillsErr.message });
  }

  const skills = (rawSkills ?? []) as SkillRow[];
  if (skills.length === 0) {
    return res.status(200).json({ success: true, message: 'No skills to assign', assignments: 0 });
  }

  // ─── Fetch agents ──────────────────────────────────────────────────────────

  const targetUserId = userId ?? skills[0]?.user_id;

  let agentsQuery = supabase
    .from('domain_agents')
    .select('id, user_id, name, description, expertise_index, source_count')
    .eq('is_active', true);

  if (targetUserId) {
    agentsQuery = agentsQuery.eq('user_id', targetUserId);
  }

  const { data: rawAgents, error: agentsErr } = await agentsQuery;
  if (agentsErr) {
    return res.status(500).json({ error: 'Failed to fetch agents', detail: agentsErr.message });
  }

  const agents = (rawAgents ?? []) as AgentRow[];
  if (agents.length === 0) {
    return res.status(200).json({ success: true, message: 'No agents found', assignments: 0 });
  }

  // ─── Fetch existing agent-source links ────────────────────────────────────

  let agentSourcesQuery = supabase
    .from('domain_agent_sources')
    .select('agent_id, source_id');

  if (targetUserId) {
    agentSourcesQuery = agentSourcesQuery.eq('user_id', targetUserId);
  }

  const { data: rawAgentSources } = await agentSourcesQuery;
  const agentSources = (rawAgentSources ?? []) as AgentSourceRow[];

  // ─── Fetch existing assignments to avoid re-processing ────────────────────

  let existingQuery = supabase
    .from('domain_agent_skills')
    .select('agent_id, skill_id');

  if (targetUserId) {
    existingQuery = existingQuery.eq('user_id', targetUserId);
  }

  const { data: rawExisting } = await existingQuery;
  const existingPairs = new Set(
    (rawExisting ?? []).map((r: { agent_id: string; skill_id: string }) => `${r.agent_id}:${r.skill_id}`)
  );

  // ─── PASS 1: Source overlap ───────────────────────────────────────────────

  const overlapMatches = computeSourceOverlapMatches(skills, agents, agentSources);

  // Filter out already-existing assignments
  const newOverlapMatches = overlapMatches.filter(
    a => !existingPairs.has(`${a.agent_id}:${a.skill_id}`)
  );

  // Track which skills were matched in pass 1
  const matchedSkillIds = new Set(overlapMatches.map(a => a.skill_id));
  const unmatchedSkills = skills.filter(s => !matchedSkillIds.has(s.id));

  // ─── PASS 2: Gemini semantic matching (unmatched only) ────────────────────

  let geminiMatches: AssignmentRecord[] = [];

  if (unmatchedSkills.length > 0 && !dryRun) {
    geminiMatches = await computeGeminiMatches(unmatchedSkills, agents, minRelevance);

    // Filter out already-existing
    geminiMatches = geminiMatches.filter(
      a => !existingPairs.has(`${a.agent_id}:${a.skill_id}`)
    );
  }

  const allNewAssignments = [...newOverlapMatches, ...geminiMatches];

  // ─── Build detail log ─────────────────────────────────────────────────────

  const agentNameMap = new Map(agents.map(a => [a.id, a.name]));
  const skillNameMap = new Map(skills.map(s => [s.id, s.name]));

  const details: SkillAssignmentDetail[] = allNewAssignments.map(a => ({
    skill_id: a.skill_id,
    skill_name: skillNameMap.get(a.skill_id) || 'unknown',
    agent_id: a.agent_id,
    agent_name: agentNameMap.get(a.agent_id) || 'unknown',
    match_method: a.match_method,
    relevance: a.relevance,
  }));

  if (dryRun) {
    return res.status(200).json({
      success: true,
      dryRun: true,
      summary: {
        totalSkills: skills.length,
        totalAgents: agents.length,
        pass1_sourceOverlap: newOverlapMatches.length,
        pass2_geminiMatch: '(skipped in dry run)',
        unmatchedSkillsForPass2: unmatchedSkills.length,
      },
      assignments: details,
      durationMs: Date.now() - startTime,
    });
  }

  // ─── Write assignments ────────────────────────────────────────────────────

  const { written, skippedDuplicate } = await writeAssignments(supabase, allNewAssignments);

  // ─── Add skill sources to agents ──────────────────────────────────────────

  const sourcesAdded = await addSkillSourcesToAgents(supabase, allNewAssignments, skills);

  // ─── Mark affected agents as stale ────────────────────────────────────────

  const affectedAgentIds = allNewAssignments.map(a => a.agent_id);
  const agentsMarkedStale = await markAgentsStale(supabase, affectedAgentIds);

  return res.status(200).json({
    success: true,
    summary: {
      totalSkills: skills.length,
      totalAgents: agents.length,
      pass1_sourceOverlap: newOverlapMatches.length,
      pass2_geminiMatch: geminiMatches.length,
      totalNewAssignments: allNewAssignments.length,
      written,
      skippedDuplicate,
      sourcesAddedToAgents: sourcesAdded,
      agentsMarkedStale,
    },
    assignments: details,
    durationMs: Date.now() - startTime,
  });
}
